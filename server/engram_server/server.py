import uuid
from pathlib import Path

from mcp.server.fastmcp import FastMCP
from loguru import logger

from engram_server.brain import BrainManager, BrainContext
from engram_server.ingest import ingest_file
from engram_server.retriever import hybrid_retrieve
from engram_server.write_back import write_back as do_write_back, build_session_context
from engram_server.api import start_api_server
from engram_server.consolidation import (
    consolidate as run_consolidation,
    spread_activation,
    get_working_memory as get_wm,
    pin_to_working_memory as pin_wm,
)
from engram_server.conversation_log import log_exchange, search_conversations

# --- Initialize ---

mcp = FastMCP(
    "NeuroVault",
    instructions=(
        "NeuroVault is a local-first AI memory system. Read `engram://usage-guide` "
        "on session start for the decision tree.\n\n"
        "CORE WORKFLOW:\n"
        "1. BEFORE answering questions: call `recall(query, mode='preview')` to check memory\n"
        "2. WHEN user mentions a named thing: call `about(entity)` for targeted lookup\n"
        "3. WHEN user shares a decision/learning: call `remember(title, content)` immediately\n"
        "4. AFTER meaningful exchanges: call `save_conversation_insights(...)` to grow the brain\n"
        "5. FOR broad topics: call `explore(topic, depth=2)` — one call, full context\n\n"
        "TOKEN EFFICIENCY:\n"
        "- `recall(q, mode='titles')` = ~20 tokens/result (quick scan)\n"
        "- `recall(q, mode='preview')` = ~100 tokens/result (default, most uses)\n"
        "- `recall(q, mode='full')` = ~400 tokens/result (only when deep content needed)\n"
        "- `context_for(topic, token_budget=2000)` = smart budget-fitted pack\n\n"
        "Every tool accepts optional `brain` param to target a specific memory space. "
        "Memories persist across all sessions. The brain grows automatically."
    ),
)

manager = BrainManager()


def _ctx(brain: str | None = None) -> BrainContext:
    """Resolve brain context — active brain if no brain specified."""
    if brain:
        return manager.get_context(brain)
    return manager.get_active()


def _slugify(text: str) -> str:
    slug = ""
    for ch in text.lower():
        if ch.isalnum():
            slug += ch
        elif slug and slug[-1] != "-":
            slug += "-"
    return slug.strip("-")[:60]


def _write_md_file(vault_dir: Path, filename: str, title: str, content: str) -> Path:
    path = vault_dir / filename
    md_content = f"# {title}\n\n{content}"
    path.write_text(md_content, encoding="utf-8")
    return path


# --- Memory Tools ---


@mcp.tool()
def remember(title: str, content: str, brain: str | None = None) -> dict:
    """Create or update a memory. Saves as a markdown file and indexes it.

    Notes are automatically interconnected with related memories via semantic
    similarity and shared entities.

    Args:
        title: Short descriptive title for the memory
        content: The content to remember (supports markdown, [[wikilinks]])
        brain: Target brain ID (uses active brain if not specified)
    """
    ctx = _ctx(brain)

    existing = ctx.db.get_engram_by_title(title)
    if existing:
        engram_id = existing["id"]
        filename = existing["filename"]
        status = "updated"
    else:
        engram_id = str(uuid.uuid4())
        slug = _slugify(title)
        filename = f"{slug}-{engram_id[:8]}.md"
        status = "created"

    filepath = _write_md_file(ctx.vault_dir, filename, title, content)
    ingest_file(filepath, ctx.db, manager.embedder, ctx.bm25)

    logger.info("{} memory: {} ({}) in brain '{}'", status.capitalize(), title, engram_id[:8], ctx.name)

    # Return connection info
    links = ctx.db.conn.execute(
        """SELECT e.title, l.similarity, l.link_type
           FROM engram_links l
           JOIN engrams e ON e.id = l.to_engram
           WHERE l.from_engram = (SELECT id FROM engrams WHERE filename = ?)
           ORDER BY l.similarity DESC LIMIT 5""",
        (filename,),
    ).fetchall()

    return {
        "engram_id": engram_id,
        "status": status,
        "title": title,
        "brain": ctx.brain_id,
        "connected_to": [
            {"title": r[0], "similarity": round(r[1], 3), "link_type": r[2]}
            for r in links
        ],
    }


@mcp.tool()
def recall(
    query: str,
    limit: int = 10,
    mode: str = "preview",
    max_tokens: int | None = None,
    brain: str | None = None,
) -> list[dict]:
    """Search memory with hybrid retrieval (semantic + BM25 + knowledge graph).

    USE WHEN: the user asks about past decisions, preferences, projects, learnings,
    or anything they might have told you before. Call this BEFORE answering any
    question that could benefit from context.

    Token-efficient modes:
      - "titles" (~20 tokens/result): just titles and strengths — for quick scans
      - "preview" (~100 tokens/result): title + 200-char snippet — for most uses (DEFAULT)
      - "full" (~400 tokens/result): full content — only when you need deep context

    Args:
        query: Natural language query (e.g. "what did I decide about testing?")
        limit: Max results (default 10)
        mode: "titles" | "preview" | "full" — trade precision for token cost
        max_tokens: Optional budget — stops adding results once this is hit
        brain: Target brain ID (uses active brain if not specified)
    """
    ctx = _ctx(brain)
    raw_results = hybrid_retrieve(query, ctx.db, manager.embedder, ctx.bm25, top_k=limit)

    # Spreading activation: boost neighbors of accessed memories
    # (mimics how recalling one concept makes related concepts easier to recall)
    if raw_results:
        try:
            spread_activation(ctx.db, [r["engram_id"] for r in raw_results])
        except Exception as e:
            logger.debug("Spreading activation skipped: {}", e)

    # Format results based on mode
    results: list[dict] = []
    tokens_used = 0
    for r in raw_results:
        if mode == "titles":
            item = {
                "engram_id": r["engram_id"],
                "title": r["title"],
                "score": r["score"],
                "strength": r["strength"],
            }
            tokens_est = 20
        elif mode == "full":
            item = r
            tokens_est = len(r["content"]) // 4
        else:  # preview (default)
            item = {
                "engram_id": r["engram_id"],
                "title": r["title"],
                "preview": r["content"][:200],
                "score": r["score"],
                "strength": r["strength"],
                "state": r["state"],
            }
            tokens_est = 100

        if max_tokens and tokens_used + tokens_est > max_tokens:
            break
        tokens_used += tokens_est
        results.append(item)

    return results


@mcp.tool()
def forget(engram_id: str, brain: str | None = None) -> dict:
    """Mark a memory as dormant. File is preserved but won't appear in searches.

    Args:
        engram_id: ID of the memory to forget
        brain: Target brain ID (uses active brain if not specified)
    """
    ctx = _ctx(brain)
    success = ctx.db.soft_delete(engram_id)
    if success:
        ctx.bm25.build(ctx.db)
        return {"status": "forgotten", "engram_id": engram_id}
    return {"status": "not_found", "engram_id": engram_id}


@mcp.tool()
def list_memories(tag: str | None = None, brain: str | None = None) -> list[dict]:
    """List all active memories with title, state, strength, and connections.

    Args:
        tag: Optional tag filter
        brain: Target brain ID (uses active brain if not specified)
    """
    ctx = _ctx(brain)
    engrams = ctx.db.list_engrams(tag=tag)
    results = []
    for e in engrams:
        link_count = ctx.db.conn.execute(
            "SELECT COUNT(*) FROM engram_links WHERE from_engram = ?", (e["id"],)
        ).fetchone()[0]
        results.append({
            "engram_id": e["id"],
            "title": e["title"],
            "state": e["state"],
            "strength": e["strength"],
            "access_count": e["access_count"],
            "connections": link_count,
            "updated_at": e["updated_at"],
        })
    return results


@mcp.tool()
def get_related(title: str, limit: int = 5, brain: str | None = None) -> list[dict]:
    """Find memories related by semantic similarity, shared entities, or wikilinks.

    Args:
        title: Title of the note to find relations for
        limit: Maximum results (default 5)
        brain: Target brain ID (uses active brain if not specified)
    """
    ctx = _ctx(brain)
    engram = ctx.db.get_engram_by_title(title)
    if not engram:
        return [{"error": f"No memory found with title: {title}"}]

    links = ctx.db.conn.execute(
        """SELECT e.id, e.title, e.strength, e.state, l.similarity, l.link_type
           FROM engram_links l
           JOIN engrams e ON e.id = l.to_engram
           WHERE l.from_engram = ? AND e.state != 'dormant'
           ORDER BY l.similarity DESC LIMIT ?""",
        (engram["id"], limit),
    ).fetchall()

    related = [
        {"engram_id": r[0], "title": r[1], "strength": r[2], "state": r[3],
         "similarity": round(r[4], 3), "link_type": r[5]}
        for r in links
    ]

    if len(related) < limit:
        embedding = manager.embedder.encode(engram["content"][:2000])
        knn_results = ctx.db.knn_search(embedding, limit=limit + 1)
        seen = {r["engram_id"] for r in related} | {engram["id"]}
        for r in knn_results:
            if r["engram_id"] in seen:
                continue
            similarity = max(0.0, 1.0 - r["distance"])
            related.append({
                "engram_id": r["engram_id"], "title": r["title"],
                "strength": r["strength"], "state": r["state"],
                "similarity": round(similarity, 3), "link_type": "semantic_knn",
            })
            if len(related) >= limit:
                break

    return related


@mcp.tool()
def save_conversation_insights(
    user_message: str,
    assistant_response: str,
    retrieved_engram_ids: list[str] | None = None,
    brain: str | None = None,
) -> dict:
    """Extract and save durable facts from a conversation exchange.

    Call this after meaningful exchanges to grow the brain automatically.

    Args:
        user_message: What the user said
        assistant_response: What Claude responded
        retrieved_engram_ids: IDs of memories used (optional)
        brain: Target brain ID (uses active brain if not specified)
    """
    ctx = _ctx(brain)
    result = do_write_back(
        user_message, assistant_response,
        retrieved_engram_ids or [],
        ctx.db, manager.embedder, ctx.bm25, ctx.vault_dir,
    )
    if result:
        return {"status": "created", "engram_id": result["engram_id"],
                "title": result["title"], "facts_count": result["facts_count"]}
    return {"status": "no_new_facts"}


# --- Brain Management Tools ---


@mcp.tool()
def list_brains() -> list[dict]:
    """List all available brains with their active status."""
    return manager.list_brains()


@mcp.tool()
def switch_brain(brain_id: str) -> dict:
    """Switch the active brain context.

    Args:
        brain_id: ID of the brain to activate
    """
    ctx = manager.switch_brain(brain_id)
    return {"status": "switched", "brain_id": ctx.brain_id, "name": ctx.name}


@mcp.tool()
def create_brain(name: str, description: str = "") -> dict:
    """Create a new brain for a project or context.

    Args:
        name: Display name for the brain
        description: Optional description
    """
    ctx = manager.create_brain(name, description)
    return {"status": "created", "brain_id": ctx.brain_id, "name": ctx.name}


# --- Advanced Intelligence Tools (stolen from competitors) ---


@mcp.tool()
def synthesize(topic: str, brain: str | None = None) -> str:
    """Generate a wiki-style summary article from all memories about a topic.

    Finds related notes, extracts key facts, and synthesizes a coherent article.
    Inspired by Atomic's wiki synthesis feature.

    Args:
        topic: The topic to synthesize (e.g. "Python setup", "project architecture")
        brain: Target brain ID (uses active brain if not specified)
    """
    from engram_server.intelligence import synthesize_wiki
    ctx = _ctx(brain)
    return synthesize_wiki(ctx.db, topic, manager.embedder)


@mcp.tool()
def check_contradictions(brain: str | None = None) -> list[dict]:
    """Find contradictions between memories in the active brain.

    Scans for facts that conflict with each other (e.g. "uses PostgreSQL"
    vs "chose SQLite"). Helps maintain knowledge consistency.

    Args:
        brain: Target brain ID (uses active brain if not specified)
    """
    ctx = _ctx(brain)
    rows = ctx.db.conn.execute(
        """SELECT c.id, e1.title as title_a, e2.title as title_b,
                  c.fact_a, c.fact_b, c.resolved
           FROM contradictions c
           JOIN engrams e1 ON e1.id = c.engram_a
           JOIN engrams e2 ON e2.id = c.engram_b
           WHERE c.resolved = 0
           ORDER BY c.detected_at DESC LIMIT 20"""
    ).fetchall()
    return [
        {"id": r[0], "note_a": r[1], "note_b": r[2],
         "fact_a": r[3], "fact_b": r[4]}
        for r in rows
    ]


@mcp.tool()
def clip_url(url: str, title: str, content: str, brain: str | None = None) -> dict:
    """Save web content as a memory note — like a browser extension save.

    Use this when the user shares a URL or web content worth remembering.

    Args:
        url: Source URL
        title: Page title
        content: Extracted text content from the page
        brain: Target brain ID (uses active brain if not specified)
    """
    from engram_server.intelligence import clip_to_vault
    ctx = _ctx(brain)
    return clip_to_vault(url, title, content, ctx.vault_dir, ctx.db, manager.embedder, ctx.bm25)


@mcp.tool()
def get_timeline(brain: str | None = None) -> list[dict]:
    """Get a timeline of facts — what was true when, and what superseded what.

    Tracks temporal evolution of knowledge. Inspired by Zep's Graphiti engine.

    Args:
        brain: Target brain ID (uses active brain if not specified)
    """
    ctx = _ctx(brain)
    rows = ctx.db.conn.execute(
        """SELECT tf.fact, tf.valid_from, tf.valid_until, tf.is_current,
                  e.title, tf.superseded_by
           FROM temporal_facts tf
           JOIN engrams e ON e.id = tf.engram_id
           ORDER BY tf.valid_from DESC LIMIT 50"""
    ).fetchall()
    return [
        {"fact": r[0], "valid_from": r[1], "valid_until": r[2],
         "is_current": bool(r[3]), "source": r[4]}
        for r in rows
    ]


# --- Zotero Integration ---


@mcp.tool()
def zotero_sync(query: str = "", brain: str | None = None) -> dict:
    """Sync Zotero library items as Source engrams via Better BibTeX RPC.

    USE WHEN: the user wants to import their Zotero library or refresh it.
    Requires Zotero running with the Better BibTeX extension installed.
    Creates one Source note per item with citekey, abstract, and metadata.

    Args:
        query: Optional search filter (empty = all items)
        brain: Target brain ID
    """
    from engram_server.zotero import sync_library
    ctx = _ctx(brain)
    return sync_library(ctx.vault_dir, ctx.db, manager.embedder, ctx.bm25, query)


@mcp.tool()
def zotero_status() -> dict:
    """Check if Zotero + Better BibTeX are reachable."""
    from engram_server.zotero import check_zotero_running, BBT_RPC_URL
    return {"reachable": check_zotero_running(), "endpoint": BBT_RPC_URL}


# --- Pandoc Export ---


@mcp.tool()
def export_pandoc(
    engram_id: str,
    output_format: str = "docx",
    brain: str | None = None,
) -> dict:
    """Export a single note to docx/pdf/html/latex/epub via Pandoc.

    Args:
        engram_id: Note ID to export
        output_format: docx|pdf|html|latex|epub|md|rst|odt
        brain: Target brain ID
    """
    from engram_server.pandoc_export import export_note_by_id
    ctx = _ctx(brain)
    return export_note_by_id(engram_id, output_format, ctx.db)


@mcp.tool()
def export_draft_pandoc(
    draft_id: str,
    output_format: str = "docx",
    brain: str | None = None,
) -> dict:
    """Export a Draft (ordered collection) as one formatted document.

    Stitches all draft sections in order. Perfect for chapter → Word/PDF.

    Args:
        draft_id: Draft ID
        output_format: docx|pdf|html|latex|epub
        brain: Target brain ID
    """
    from engram_server.pandoc_export import export_draft
    ctx = _ctx(brain)
    return export_draft(draft_id, output_format, ctx.db)


@mcp.tool()
def pandoc_status() -> dict:
    """Check if pandoc is installed and usable."""
    from engram_server.pandoc_export import check_pandoc_installed
    return check_pandoc_installed()


# --- Git Backup ---


@mcp.tool()
def git_history(limit: int = 20, brain: str | None = None) -> list[dict]:
    """Show recent commits in the brain's git backup.

    USE WHEN: user wants to see what changed or recover a deleted note.

    Args:
        limit: Max commits to return
        brain: Target brain ID
    """
    from engram_server.git_backup import get_history
    ctx = _ctx(brain)
    return get_history(ctx.vault_dir, limit=limit)


@mcp.tool()
def git_restore(filename: str, commit_hash: str, brain: str | None = None) -> dict:
    """Restore a file to a previous commit.

    Args:
        filename: The note filename (e.g. "my-note-abc123.md")
        commit_hash: Short or full commit hash from git_history
        brain: Target brain ID
    """
    from engram_server.git_backup import restore_file
    ctx = _ctx(brain)
    return restore_file(ctx.vault_dir, filename, commit_hash)


# --- Drafts (Longform Replacement) ---


@mcp.tool()
def create_draft(
    title: str,
    description: str = "",
    target_words: int = 0,
    deadline: str | None = None,
    brain: str | None = None,
) -> dict:
    """Create a new draft — an ordered collection of notes for long-form writing.

    USE WHEN: user starts a chapter, essay, or paper. Drafts stitch together
    existing notes into a single document you can export via Pandoc.

    Args:
        title: Draft title (e.g. "Chapter 3: Methodology")
        description: Optional overview
        target_words: Word count goal (0 = no target)
        deadline: ISO date string (optional)
        brain: Target brain ID
    """
    from engram_server.drafts import create_draft as _create
    ctx = _ctx(brain)
    return _create(ctx.db, title, description, target_words, deadline)


@mcp.tool()
def list_drafts(brain: str | None = None) -> list[dict]:
    """List all drafts with progress (sections, word count, target %)."""
    from engram_server.drafts import list_drafts as _list
    ctx = _ctx(brain)
    return _list(ctx.db)


@mcp.tool()
def get_draft(draft_id: str, brain: str | None = None) -> dict:
    """Get a draft's full contents — ordered sections with previews and word counts."""
    from engram_server.drafts import get_draft as _get
    ctx = _ctx(brain)
    result = _get(ctx.db, draft_id)
    if not result:
        return {"error": f"Draft not found: {draft_id}"}
    return result


@mcp.tool()
def add_to_draft(
    draft_id: str,
    engram_id: str,
    position: int | None = None,
    brain: str | None = None,
) -> dict:
    """Add a note to a draft at a position (end if None)."""
    from engram_server.drafts import add_section
    ctx = _ctx(brain)
    return add_section(ctx.db, draft_id, engram_id, position)


@mcp.tool()
def remove_from_draft(draft_id: str, engram_id: str, brain: str | None = None) -> dict:
    """Remove a note from a draft (note itself is preserved)."""
    from engram_server.drafts import remove_section
    ctx = _ctx(brain)
    return remove_section(ctx.db, draft_id, engram_id)


@mcp.tool()
def reorder_draft_section(
    draft_id: str,
    engram_id: str,
    new_position: int,
    brain: str | None = None,
) -> dict:
    """Move a section to a new 0-indexed position in the draft."""
    from engram_server.drafts import reorder_section
    ctx = _ctx(brain)
    return reorder_section(ctx.db, draft_id, engram_id, new_position)


# --- Brain Export / Import ---


@mcp.tool()
def export_brain_archive(include_db: bool = False, brain: str | None = None) -> dict:
    """Bundle a brain into a tar.gz archive for backup, sharing, or migration.

    Args:
        include_db: If True, include brain.db (larger but instant re-import)
        brain: Target brain ID (uses active brain if not specified)
    """
    from engram_server.brain_export import export_brain
    ctx = _ctx(brain)
    brain_dir = ctx.vault_dir.parent
    return export_brain(ctx.brain_id, brain_dir, include_db=include_db)


# --- Karpathy LLM Wiki Tools ---


@mcp.tool()
def read_index(brain: str | None = None) -> str:
    """Read the auto-maintained index.md — one-line summary of every note.

    USE WHEN: you want a compact overview of everything in the brain.
    Cheaper than recall() for exploration since it's one grep-friendly file.
    Inspired by Karpathy's LLM Wiki pattern.

    Args:
        brain: Target brain ID
    """
    from engram_server.karpathy import get_index
    ctx = _ctx(brain)
    return get_index(ctx.vault_dir)


@mcp.tool()
def read_log(tail: int = 50, brain: str | None = None) -> str:
    """Read the activity log — chronological record of every event.

    USE WHEN: you want to see what's happened in this brain recently.
    Shows ingest/query/consolidate/contradiction events with timestamps.

    Args:
        tail: How many recent entries to return (default 50)
        brain: Target brain ID
    """
    from engram_server.karpathy import get_log
    ctx = _ctx(brain)
    return get_log(ctx.vault_dir, tail=tail)


@mcp.tool()
def read_schema(brain: str | None = None) -> str:
    """Read the CLAUDE.md schema — per-brain conventions and rules.

    USE WHEN: starting work in a brain. Shows the tag taxonomy, naming
    conventions, workflows, and any user-specified rules Claude should follow.

    Args:
        brain: Target brain ID
    """
    from engram_server.karpathy import get_schema
    ctx = _ctx(brain)
    return get_schema(ctx.vault_dir)


@mcp.tool()
def update_schema(content: str, brain: str | None = None) -> dict:
    """Update the CLAUDE.md schema for a brain.

    USE WHEN: the user asks you to change conventions, add tags, or
    codify a new rule. Overwrites the current schema file.

    Args:
        content: New CLAUDE.md content
        brain: Target brain ID
    """
    from engram_server.karpathy import update_schema as update
    ctx = _ctx(brain)
    path = update(ctx.vault_dir, content)
    return {"status": "updated", "path": str(path)}


# --- Brain-Like Memory Tools ---


@mcp.tool()
def working_memory(brain: str | None = None) -> list[dict]:
    """Get the current working memory — always-in-context memories.

    Working memory is the brain's scratchpad: the 7-or-so most relevant
    memories right now (recent + high-strength + manually pinned).
    These should always be considered when answering questions.

    Args:
        brain: Target brain ID
    """
    ctx = _ctx(brain)
    return get_wm(ctx.db)


@mcp.tool()
def pin_memory(engram_id: str, brain: str | None = None) -> dict:
    """Pin a memory to working memory so it's always in context.

    Use this when the user emphasizes something important or when you
    detect a memory will be repeatedly relevant.

    Args:
        engram_id: ID of the memory to pin
        brain: Target brain ID
    """
    ctx = _ctx(brain)
    pin_wm(ctx.db, engram_id)
    return {"status": "pinned", "engram_id": engram_id}


@mcp.tool()
def consolidate_now(brain: str | None = None) -> dict:
    """Trigger a memory consolidation cycle (the brain's sleep cycle).

    Clusters similar memories into themes, refreshes working memory,
    strengthens co-activated links, and prunes stale unused edges.
    Normally runs automatically every 4 hours — use this for manual sync.

    Args:
        brain: Target brain ID
    """
    ctx = _ctx(brain)
    return run_consolidation(ctx.db, manager.embedder, ctx.consolidated_dir)


@mcp.tool()
def log_conversation(
    user_message: str,
    assistant_response: str,
    brain: str | None = None,
) -> dict:
    """Log a conversation exchange to the permanent record.

    Saves to raw/conversations/. Call this after meaningful exchanges
    so the user can later ask "what did Claude tell me about X?".

    Args:
        user_message: What the user said
        assistant_response: What you (Claude) responded
        brain: Target brain ID
    """
    ctx = _ctx(brain)
    filepath = log_exchange(user_message, assistant_response, ctx.raw_dir)
    return {"status": "logged", "file": str(filepath.name)}


@mcp.tool()
def search_history(query: str, limit: int = 10, brain: str | None = None) -> list[dict]:
    """Search conversation history for past exchanges with Claude.

    USE WHEN: the user asks about something Claude said before.
    Searches raw/conversations/ for matching turns.

    Args:
        query: What to search for
        limit: Max results
        brain: Target brain ID
    """
    ctx = _ctx(brain)
    return search_conversations(ctx.raw_dir, query, limit)


# --- AI-Efficient Compound Tools ---


@mcp.tool()
def explore(query: str, depth: int = 2, brain: str | None = None) -> dict:
    """Deep exploration in ONE call — replaces recall + get_related + backlinks.

    USE WHEN: you need broad context about a topic, not just matching snippets.
    Example: "explore('my authentication architecture')" returns matching notes,
    their related notes, their backlinks, and shared entities — in one response.

    Args:
        query: Topic to explore
        depth: 1=direct matches, 2=matches+related, 3=full graph neighborhood
        brain: Target brain ID
    """
    ctx = _ctx(brain)

    # Step 1: Find direct matches
    matches = hybrid_retrieve(query, ctx.db, manager.embedder, ctx.bm25, top_k=5)
    if not matches:
        return {"matches": [], "related": [], "entities": [], "message": "No memories found for this query"}

    match_ids = {m["engram_id"] for m in matches}
    result: dict = {
        "matches": [
            {"engram_id": m["engram_id"], "title": m["title"], "preview": m["content"][:200], "score": m["score"]}
            for m in matches
        ],
        "related": [],
        "entities": [],
    }

    if depth >= 2:
        # Step 2: For each match, get related notes via knowledge graph
        related_ids: set[str] = set()
        related_items: list[dict] = []
        for m in matches[:3]:
            rows = ctx.db.conn.execute(
                """SELECT e.id, e.title, l.similarity, l.link_type
                   FROM engram_links l
                   JOIN engrams e ON e.id = l.to_engram
                   WHERE l.from_engram = ? AND e.state != 'dormant'
                   ORDER BY l.similarity DESC LIMIT 3""",
                (m["engram_id"],),
            ).fetchall()
            for r in rows:
                if r[0] not in match_ids and r[0] not in related_ids:
                    related_ids.add(r[0])
                    related_items.append({
                        "engram_id": r[0], "title": r[1],
                        "similarity": round(r[2], 3), "link_type": r[3],
                        "via": m["title"],
                    })
        result["related"] = related_items[:10]

    if depth >= 3:
        # Step 3: Extract shared entities across all matches
        all_ids = list(match_ids) + [r["engram_id"] for r in result["related"]]
        if all_ids:
            placeholders = ",".join("?" * len(all_ids))
            entity_rows = ctx.db.conn.execute(
                f"""SELECT DISTINCT ent.name, ent.entity_type, COUNT(*) as freq
                   FROM entity_mentions em
                   JOIN entities ent ON ent.id = em.entity_id
                   WHERE em.engram_id IN ({placeholders})
                   GROUP BY ent.name
                   ORDER BY freq DESC LIMIT 10""",
                all_ids,
            ).fetchall()
            result["entities"] = [{"name": r[0], "type": r[1], "mentions": r[2]} for r in entity_rows]

    return result


@mcp.tool()
def proactive_context(message: str, brain: str | None = None) -> dict:
    """Proactive context detection — NO LLM call, pure pattern + vector.

    USE WHEN: you want to check if a user message touches on topics Engram has
    stored memories about, BEFORE you decide how to respond. Fast, free, silent.

    Example: user says "What do you think about my education?"
    → This detects "education" topic and returns relevant notes WITHOUT any
    Claude round-trip. You see the context in one call and can respond richly.

    Args:
        message: The user's message (any natural language)
        brain: Target brain ID
    """
    from engram_server.proactive import proactive_context as pc
    ctx = _ctx(brain)
    return pc(message, ctx.db, manager.embedder)


@mcp.tool()
def about(entity: str, brain: str | None = None) -> dict:
    """Entity-first lookup — everything NeuroVault knows about a person, concept, or project.

    USE WHEN: the user mentions a specific named thing (person, project, technology,
    concept) and you want ALL related context. More targeted than recall().

    Example: about("Sarah") returns every memory mentioning Sarah + entity metadata.

    Args:
        entity: The name to look up (case-insensitive)
        brain: Target brain ID
    """
    ctx = _ctx(brain)

    # Find the entity
    entity_row = ctx.db.conn.execute(
        "SELECT id, name, entity_type, mention_count FROM entities WHERE name = ? COLLATE NOCASE",
        (entity,),
    ).fetchone()

    if not entity_row:
        # Fuzzy: partial match
        entity_row = ctx.db.conn.execute(
            "SELECT id, name, entity_type, mention_count FROM entities WHERE name LIKE ? COLLATE NOCASE LIMIT 1",
            (f"%{entity}%",),
        ).fetchone()

    if not entity_row:
        return {"found": False, "entity": entity, "message": f"No memories mention '{entity}'"}

    eid, name, etype, mentions = entity_row

    # Get all engrams that mention this entity
    engrams = ctx.db.conn.execute(
        """SELECT e.id, e.title, e.content, e.strength, e.state
           FROM entity_mentions em
           JOIN engrams e ON e.id = em.engram_id
           WHERE em.entity_id = ? AND e.state != 'dormant'
           ORDER BY e.strength DESC""",
        (eid,),
    ).fetchall()

    return {
        "found": True,
        "entity": {"name": name, "type": etype, "mention_count": mentions},
        "memories": [
            {
                "engram_id": e[0],
                "title": e[1],
                "preview": e[2][:300],
                "strength": e[3],
                "state": e[4],
            }
            for e in engrams[:10]
        ],
        "total_memories": len(engrams),
    }


@mcp.tool()
def context_for(topic: str, token_budget: int = 2000, brain: str | None = None) -> dict:
    """Build a context pack fitted to a token budget — for maximum-efficiency recall.

    USE WHEN: you want the most relevant context for a topic in a specific token budget.
    This is the smartest way to load memories without wasting Claude's context window.

    Args:
        topic: What to build context about
        token_budget: Target token count (~200 chars per 50 tokens)
        brain: Target brain ID
    """
    ctx = _ctx(brain)
    results = hybrid_retrieve(topic, ctx.db, manager.embedder, ctx.bm25, top_k=20)

    # Pack results greedily by token count
    pack: list[dict] = []
    tokens_used = 0
    for r in results:
        content_tokens = len(r["content"]) // 4
        overhead = 30  # title + metadata
        if tokens_used + content_tokens + overhead > token_budget:
            # Try a truncated version
            remaining = token_budget - tokens_used - overhead
            if remaining > 50:
                pack.append({
                    "title": r["title"],
                    "content": r["content"][:remaining * 4],
                    "strength": r["strength"],
                    "truncated": True,
                })
                tokens_used += remaining + overhead
            break

        pack.append({
            "title": r["title"],
            "content": r["content"],
            "strength": r["strength"],
            "score": r["score"],
        })
        tokens_used += content_tokens + overhead

    return {
        "topic": topic,
        "memories": pack,
        "tokens_estimated": tokens_used,
        "tokens_budget": token_budget,
        "memories_available": len(results),
        "memories_included": len(pack),
    }


# --- Dissertation Tools ---


@mcp.tool()
def quick_capture(text: str, title: str | None = None, brain: str | None = None) -> dict:
    """Quick-capture text as a note. Auto-extracts title if not provided.

    Use this for fast note creation from pasted content (papers, articles, ideas).

    Args:
        text: The text to capture
        title: Optional title (auto-extracted from first line if not provided)
        brain: Target brain ID (uses active brain if not specified)
    """
    from engram_server.dissertation import quick_capture as qc
    ctx = _ctx(brain)
    return qc(text, title, ctx.vault_dir, ctx.db, manager.embedder, ctx.bm25)


@mcp.tool()
def add_tag(engram_id: str, tag: str, brain: str | None = None) -> dict:
    """Add a tag to a memory for organization.

    Args:
        engram_id: The memory ID
        tag: Tag name (e.g. "important", "to-read", "methodology")
        brain: Target brain ID
    """
    from engram_server.dissertation import add_tag as add
    ctx = _ctx(brain)
    success = add(ctx.db, engram_id, tag)
    return {"status": "added" if success else "failed", "tag": tag}


@mcp.tool()
def find_by_tag(tag: str, brain: str | None = None) -> list[dict]:
    """Find all memories with a specific tag.

    Args:
        tag: The tag to search for
        brain: Target brain ID
    """
    from engram_server.dissertation import find_by_tag as find
    ctx = _ctx(brain)
    return find(ctx.db, tag)


@mcp.tool()
def list_tags(brain: str | None = None) -> list[dict]:
    """List all tags with usage counts.

    Args:
        brain: Target brain ID
    """
    from engram_server.dissertation import list_tags as lt
    ctx = _ctx(brain)
    return lt(ctx.db)


@mcp.tool()
def ingest_pdf(pdf_path: str, brain: str | None = None) -> dict:
    """Ingest a PDF paper — extracts text, highlights, and metadata.

    Creates a Source note for the paper and a Quote note for each highlight.
    Use this to import academic papers into your dissertation memory.

    Args:
        pdf_path: Absolute path to the PDF file
        brain: Target brain ID
    """
    from engram_server.pdf_ingest import ingest_pdf as ingest
    from pathlib import Path
    ctx = _ctx(brain)
    return ingest(
        Path(pdf_path), ctx.vault_dir, ctx.db, manager.embedder, ctx.bm25,
        raw_dir=ctx.raw_dir,
    )


@mcp.tool()
def export_citations(tag: str | None = None, brain: str | None = None) -> str:
    """Export notes as BibTeX citations.

    Looks for **Author:** / **Year:** / **Journal:** metadata in note content.
    Optionally filter by tag (e.g. "methodology", "background").

    Args:
        tag: Optional tag filter
        brain: Target brain ID
    """
    from engram_server.dissertation import export_bibtex
    ctx = _ctx(brain)
    return export_bibtex(ctx.db, tag)


# --- Session Context Resource ---


@mcp.resource("engram://session-context")
def session_context() -> str:
    """Session wake-up context — what Engram knows right now.

    Loaded automatically on session start. Gives Claude an at-a-glance view
    of core identity facts (L0) and active memories (L1).
    """
    ctx = manager.get_active()
    session = build_session_context(ctx.db)
    lines = [
        f"## Active Brain: {ctx.name}",
        "",
        "### Core Identity (L0)",
        session["l0"],
        "",
        "### Top Active Memories (L1)",
        session["l1"],
        "",
        f"*{session['stats']['total_memories']} memories · "
        f"{session['stats']['total_connections']} connections · "
        f"use `recall(query)` to dig deeper*",
    ]
    return "\n".join(lines)


@mcp.resource("engram://active-brain")
def active_brain_resource() -> str:
    """Current active brain metadata — name, ID, stats, recent activity."""
    ctx = manager.get_active()
    total = ctx.db.conn.execute(
        "SELECT COUNT(*) FROM engrams WHERE state != 'dormant'"
    ).fetchone()[0]
    recent = ctx.db.conn.execute(
        """SELECT title, updated_at FROM engrams
           WHERE state != 'dormant' ORDER BY updated_at DESC LIMIT 5"""
    ).fetchall()
    lines = [
        f"# Active Brain: {ctx.name}",
        f"ID: `{ctx.brain_id}`",
        f"Memories: {total}",
        "",
        "## Recently Updated",
    ]
    for title, updated in recent:
        lines.append(f"- {title} *(last: {updated})*")
    return "\n".join(lines)


@mcp.resource("engram://usage-guide")
def usage_guide() -> str:
    """How to use NeuroVault efficiently — read this first in every session.

    Provides decision trees for tool selection, token budgets, and common patterns.
    """
    return """# NeuroVault: AI Usage Guide

## Decision tree — which tool should I use?

**User asks a question?** → `recall(query, mode="preview")` first (before answering)
**User mentions a specific name/thing?** → `about(entity)` — entity-first lookup
**User wants deep context on a topic?** → `explore(query, depth=2)` — one call, full context
**User wants to know across many topics?** → `context_for(topic, token_budget=2000)` — fit to budget
**User shares a decision/learning?** → `remember(title, content)` right away
**Meaningful exchange happened?** → `save_conversation_insights(...)` at end of turn
**User says "X is no longer true"?** → `forget(engram_id)` for the old one, then `remember()` the new

## Token efficiency

Use `recall(query, mode="titles")` for quick scans (~20 tokens/result)
Use `recall(query, mode="preview")` for most questions (~100 tokens/result) — DEFAULT
Use `recall(query, mode="full")` only when you need deep content (~400 tokens/result)
Use `recall(query, max_tokens=1500)` to cap total context spend

## Patterns

- "What did I decide about X?" → recall("decisions about X") then synthesize
- "Tell me about Sarah" → about("Sarah")
- "Find all my notes on authentication" → explore("authentication", depth=2)
- "What's the latest on the project?" → recall("project status", mode="titles")

## Multi-brain

- `list_brains()` to see available memory spaces
- `recall(query, brain="project-alpha")` to target a specific brain
- `switch_brain(brain_id)` to change the default for subsequent calls
"""


@mcp.resource("engram://wiki-index")
def wiki_index_resource() -> str:
    """Karpathy-style index.md — one-line summary of every note.

    Auto-loaded on session start so Claude knows what's in the brain
    without needing to run recall(). Grep-friendly compact catalog.
    """
    from engram_server.karpathy import get_index
    ctx = manager.get_active()
    return get_index(ctx.vault_dir)


@mcp.resource("engram://schema")
def schema_resource() -> str:
    """Karpathy-style CLAUDE.md — per-brain conventions and rules.

    Auto-loaded on session start so Claude follows the user's tag
    taxonomy, naming conventions, and codified rules for this brain.
    """
    from engram_server.karpathy import get_schema
    ctx = manager.get_active()
    return get_schema(ctx.vault_dir)


@mcp.resource("engram://contradictions")
def contradictions_resource() -> str:
    """Unresolved contradictions in the active brain.

    Loaded automatically so Claude can flag inconsistencies proactively.
    """
    ctx = manager.get_active()
    rows = ctx.db.conn.execute(
        """SELECT e1.title, e2.title, c.fact_a, c.fact_b
           FROM contradictions c
           JOIN engrams e1 ON e1.id = c.engram_a
           JOIN engrams e2 ON e2.id = c.engram_b
           WHERE c.resolved = 0
           ORDER BY c.detected_at DESC LIMIT 5"""
    ).fetchall()
    if not rows:
        return "# No unresolved contradictions\n\nYour memories are consistent."

    lines = ["# Unresolved Contradictions", ""]
    for a_title, b_title, fact_a, fact_b in rows:
        lines.append(f"**{a_title}** vs **{b_title}**")
        lines.append(f"- A: {fact_a[:150]}")
        lines.append(f"- B: {fact_b[:150]}")
        lines.append("")
    return "\n".join(lines)


# --- Entry point ---

def main() -> None:
    import sys

    active = manager.get_active()
    logger.info("Starting Engram MCP server")
    logger.info("Active brain: {} ({})", active.name, active.brain_id)
    logger.info("Vault: {}", active.vault_dir)

    if "--http-only" in sys.argv:
        import uvicorn
        from engram_server.api import create_api
        from engram_server.config import SERVER_PORT

        logger.info("Running in HTTP-only mode on port {}", SERVER_PORT)
        app = create_api(manager)
        uvicorn.run(app, host="127.0.0.1", port=SERVER_PORT, log_level="info")
    else:
        start_api_server(manager)
        mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
