import uuid
from pathlib import Path

from mcp.server.fastmcp import FastMCP
from loguru import logger

from neurovault_server.brain import BrainManager, BrainContext
from neurovault_server.ingest import ingest_file
from neurovault_server.retriever import hybrid_retrieve
from neurovault_server.write_back import write_back as do_write_back, build_session_context
from neurovault_server.api import start_api_server
from neurovault_server.consolidation import (
    consolidate as run_consolidation,
    spread_activation,
    get_working_memory as get_wm,
    pin_to_working_memory as pin_wm,
)
from neurovault_server.conversation_log import log_exchange, search_conversations

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


# --- Tiered tool registration ----------------------------------------------
# FastMCP ships every @mcp.tool() to the client as schema at session start.
# With 39 tools that's ~7k tokens of overhead before a single message lands.
# Users opt into what they want via NEUROVAULT_MCP_TIER:
#
#   core      — 5 tools: remember, recall, list_brains, switch_brain, create_brain
#   power     — core + general memory ops (forget, list_memories, extract_insights, ...)
#   code      — power + code intelligence (find_variable, find_callers, impact, ...)
#   research  — power + pdf/zotero/pandoc/clip
#   full/all  — everything (default for backwards compat)
#
# Set via env var: NEUROVAULT_MCP_TIER=core (or a comma list: "power,code")
_TIER_INCLUDES = {
    "core": {"core"},
    "power": {"core", "power"},
    "code": {"core", "power", "code"},
    "research": {"core", "power", "research"},
    "full": {"core", "power", "code", "research"},
    "all": {"core", "power", "code", "research"},
}

from neurovault_server.config import env_with_legacy_fallback as _env
_raw_tier = (_env("NEUROVAULT_MCP_TIER", "ENGRAM_MCP_TIER", "core") or "core").lower().strip()
_ACTIVE_TIERS: set[str] = set()
for token in [t.strip() for t in _raw_tier.split(",") if t.strip()]:
    _ACTIVE_TIERS.update(_TIER_INCLUDES.get(token, {token}))
if not _ACTIVE_TIERS:
    _ACTIVE_TIERS = {"core", "power", "code", "research"}
# Core is never excluded — a usable brain always needs remember/recall.
_ACTIVE_TIERS.add("core")
logger.info("MCP tool tiers active: {} (from NEUROVAULT_MCP_TIER={!r})", sorted(_ACTIVE_TIERS), _raw_tier)


def tiered(*tiers: str):
    """Register a tool with FastMCP only if one of `tiers` is active.

    Replaces the bare `@mcp.tool()` decorator so the schema for unused tools
    never ships to the client. Functions stripped out of the active tier are
    still callable internally (they just lose their MCP registration), which
    keeps the HTTP API and tests intact regardless of tier.

    Every registered tool call is automatically logged to the query audit
    trail (``audit.jsonl``) via the audit module. The wrapper captures the
    function name, arguments, and a lightweight result summary (counts +
    IDs if the result is a list of dicts with ``engram_id`` keys).
    """
    import functools
    from neurovault_server.audit import log_tool_call

    def decorator(fn):
        @functools.wraps(fn)
        def audited(*args, **kwargs):
            result = fn(*args, **kwargs)
            # Best-effort audit — never crash the tool call
            try:
                _audit_result(fn.__name__, kwargs or _positional_to_kwargs(fn, args), result)
            except Exception as e:
                logger.debug("audit wrapper skipped for {}: {}", fn.__name__, e)
            return result

        if any(t in _ACTIVE_TIERS for t in tiers):
            return mcp.tool()(audited)
        return fn
    return decorator


def _positional_to_kwargs(fn, args: tuple) -> dict:
    """Best-effort conversion of positional args to a kwargs dict for logging."""
    import inspect
    params = list(inspect.signature(fn).parameters.keys())
    return {params[i]: v for i, v in enumerate(args) if i < len(params)}


def _audit_result(tool_name: str, arguments: dict, result) -> None:
    """Extract a lightweight summary from the tool result and log it."""
    from neurovault_server.audit import log_tool_call

    result_ids = None
    result_count = None
    modified_ids = None

    if isinstance(result, list):
        result_count = len(result)
        ids = [r.get("engram_id") for r in result if isinstance(r, dict) and "engram_id" in r]
        if ids:
            result_ids = ids
    elif isinstance(result, dict):
        eid = result.get("engram_id")
        if eid:
            modified_ids = [eid]

    # Strip large content from logged arguments
    logged_args = {k: v for k, v in arguments.items() if k not in ("content",)}
    if "content" in arguments:
        logged_args["content_length"] = len(str(arguments["content"]))

    log_tool_call(
        tool_name,
        logged_args,
        result_ids=result_ids,
        result_count=result_count,
        modified_ids=modified_ids,
    )


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


@tiered("core")
def remember(title: str, content: str, brain: str | None = None, agent_id: str | None = None) -> dict:
    """Create or update a memory. Saves as a markdown file and indexes it.

    Notes are automatically interconnected with related memories via semantic
    similarity and shared entities.

    Args:
        title: Short descriptive title for the memory
        content: The content to remember (supports markdown, [[wikilinks]])
        brain: Target brain ID (uses active brain if not specified)
        agent_id: Which agent is writing this memory (e.g. "claude-code",
            "cursor", "claude-desktop", "user"). Enables multi-agent scoping
            so recall can filter by agent source.
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

    # Tag with agent identity if provided
    if agent_id:
        ctx.db.conn.execute(
            "UPDATE engrams SET agent_id = ? WHERE filename = ?",
            (agent_id, filename),
        )
        ctx.db.conn.commit()

    logger.info("{} memory: {} ({}) in brain '{}' agent={}", status.capitalize(), title, engram_id[:8], ctx.name, agent_id or "unknown")

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


@tiered("core")
def recall(
    query: str,
    limit: int = 10,
    mode: str = "preview",
    max_tokens: int | None = None,
    as_of: str | None = None,
    include_observations: bool = False,
    agent_id: str | None = None,
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

    Time travel: pass `as_of` (ISO timestamp like "2026-03-30T00:00:00Z") to
    query the brain *as it was* at that moment. Engrams created after the
    timestamp are excluded, and temporal facts that became invalid before
    the timestamp are penalized correctly. Use this to answer:
      - "what did you know about X last week?"
      - "why did you give me a different answer two weeks ago?"

    Observations: by default this tool excludes auto-captured Claude Code
    tool-call observations so they don't drown out real memories. Pass
    `include_observations=True` when the user explicitly asks "what did
    you do yesterday", "show me that edit", or similar session-replay
    questions. For full session replay use `replay_session(session_id)`.

    Args:
        query: Natural language query (e.g. "what did I decide about testing?")
        limit: Max results (default 10)
        mode: "titles" | "preview" | "full" — trade precision for token cost
        max_tokens: Optional budget — stops adding results once this is hit
        as_of: Optional ISO timestamp for time-travel queries
        include_observations: Set True to include auto-captured tool-call
            observations in the result set (default False keeps them out).
        agent_id: Filter results to only memories written by this agent
            (e.g. "claude-code"). Pass None to search all agents.
        brain: Target brain ID (uses active brain if not specified)
    """
    ctx = _ctx(brain)
    exclude_kinds = [] if include_observations else ["observation"]
    raw_results = hybrid_retrieve(
        query, ctx.db, manager.embedder, ctx.bm25,
        top_k=limit * 2 if agent_id else limit,  # over-fetch when filtering
        as_of=as_of, exclude_kinds=exclude_kinds,
    )

    # Filter by agent_id if specified
    if agent_id and raw_results:
        agent_ids_map: dict[str, str | None] = {}
        eids = [r["engram_id"] for r in raw_results]
        placeholders = ",".join("?" * len(eids))
        rows = ctx.db.conn.execute(
            f"SELECT id, agent_id FROM engrams WHERE id IN ({placeholders})", eids
        ).fetchall()
        for r in rows:
            agent_ids_map[r[0]] = r[1]
        raw_results = [r for r in raw_results if agent_ids_map.get(r["engram_id"]) == agent_id]
        raw_results = raw_results[:limit]

    # Log retrieval for the self-improving feedback loop (stage 1).
    # Every returned engram gets a row; subsequent explicit fetches will
    # credit them. Skipped for time-travel queries to avoid polluting the
    # "now" statistics with historical lookups.
    if raw_results and not as_of:
        try:
            from neurovault_server.retrieval_feedback import log_retrieval
            log_retrieval(ctx.db, query, raw_results)
        except Exception as e:
            logger.debug("Retrieval feedback log skipped: {}", e)

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


@tiered("power")
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


@tiered("power")
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


# @mcp.tool()  # demoted: use recall(query=title) which already includes graph neighbors
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


@tiered("power")
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


@tiered("core")
def list_brains() -> list[dict]:
    """List all available brains with their active status."""
    return manager.list_brains()


@tiered("core")
def switch_brain(brain_id: str) -> dict:
    """Switch the active brain context.

    Args:
        brain_id: ID of the brain to activate
    """
    ctx = manager.switch_brain(brain_id)
    return {"status": "switched", "brain_id": ctx.brain_id, "name": ctx.name}


@tiered("core")
def create_brain(name: str, description: str = "") -> dict:
    """Create a new brain for a project or context.

    Args:
        name: Display name for the brain
        description: Optional description
    """
    ctx = manager.create_brain(name, description)
    return {"status": "created", "brain_id": ctx.brain_id, "name": ctx.name}


# --- Advanced Intelligence Tools (stolen from competitors) ---


# @mcp.tool()  # demoted: rare; recall + manual synthesis covers it
def synthesize(topic: str, brain: str | None = None) -> str:
    """Generate a wiki-style summary article from all memories about a topic.

    Finds related notes, extracts key facts, and synthesizes a coherent article.
    Inspired by Atomic's wiki synthesis feature.

    Args:
        topic: The topic to synthesize (e.g. "Python setup", "project architecture")
        brain: Target brain ID (uses active brain if not specified)
    """
    from neurovault_server.intelligence import synthesize_wiki
    ctx = _ctx(brain)
    return synthesize_wiki(ctx.db, topic, manager.embedder)


# @mcp.tool()  # demoted: surfaced via engram://contradictions resource
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


@tiered("research")
def clip_url(url: str, title: str, content: str, brain: str | None = None) -> dict:
    """Save web content as a memory note — like a browser extension save.

    Use this when the user shares a URL or web content worth remembering.

    Args:
        url: Source URL
        title: Page title
        content: Extracted text content from the page
        brain: Target brain ID (uses active brain if not specified)
    """
    from neurovault_server.intelligence import clip_to_vault
    ctx = _ctx(brain)
    return clip_to_vault(url, title, content, ctx.vault_dir, ctx.db, manager.embedder, ctx.bm25)


@tiered("power")
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


# --- Graphify-inspired Tools ---


@tiered("power")
def brain_report(brain: str | None = None) -> str:
    """Generate a brain GRAPH_REPORT.md — one-page summary of the knowledge graph.

    Highlights god nodes (most connected), surprising connections discovered
    by embeddings, orphan notes, top entities, and suggested questions.
    Inspired by Graphify's GRAPH_REPORT.md.

    Args:
        brain: Target brain ID
    """
    from neurovault_server.graph_report import generate_graph_report
    ctx = _ctx(brain)
    path = generate_graph_report(ctx.db, ctx.vault_dir)
    return path.read_text(encoding="utf-8")


# @mcp.tool()  # demoted: niche graph operation, callable internally
def path(
    start: str,
    end: str,
    max_depth: int = 6,
    brain: str | None = None,
) -> dict:
    """Find the shortest semantic path between two notes (BFS over knowledge graph).

    USE WHEN: the user asks "how does X relate to Y?" or wants to discover
    indirect connections between concepts in their brain.

    Args:
        start: Title of the starting note
        end: Title of the ending note
        max_depth: Max hops to search (default 6)
        brain: Target brain ID
    """
    from neurovault_server.graph_report import find_path
    ctx = _ctx(brain)
    return find_path(ctx.db, start, end, max_depth)


# --- Zotero Integration ---


@tiered("research")
def zotero_sync(query: str = "", brain: str | None = None) -> dict:
    """Sync Zotero library items as Source engrams via Better BibTeX RPC.

    USE WHEN: the user wants to import their Zotero library or refresh it.
    Requires Zotero running with the Better BibTeX extension installed.
    Creates one Source note per item with citekey, abstract, and metadata.

    Args:
        query: Optional search filter (empty = all items)
        brain: Target brain ID
    """
    from neurovault_server.zotero import sync_library
    ctx = _ctx(brain)
    return sync_library(ctx.vault_dir, ctx.db, manager.embedder, ctx.bm25, query)


# @mcp.tool()  # demoted: status check, not user-facing
def zotero_status() -> dict:
    """Check if Zotero + Better BibTeX are reachable."""
    from neurovault_server.zotero import check_zotero_running, BBT_RPC_URL
    return {"reachable": check_zotero_running(), "endpoint": BBT_RPC_URL}


# --- Pandoc Export ---


@tiered("research")
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
    from neurovault_server.pandoc_export import export_note_by_id
    ctx = _ctx(brain)
    return export_note_by_id(engram_id, output_format, ctx.db)


# @mcp.tool()  # demoted: subsumed by export_pandoc with draft_id param
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
    from neurovault_server.pandoc_export import export_draft
    ctx = _ctx(brain)
    return export_draft(draft_id, output_format, ctx.db)


# @mcp.tool()  # demoted: status check, not user-facing
def pandoc_status() -> dict:
    """Check if pandoc is installed and usable."""
    from neurovault_server.pandoc_export import check_pandoc_installed
    return check_pandoc_installed()


# --- Git Backup ---


# @mcp.tool()  # demoted: rare; available via /api/git/history
def git_history(limit: int = 20, brain: str | None = None) -> list[dict]:
    """Show recent commits in the brain's git backup.

    USE WHEN: user wants to see what changed or recover a deleted note.

    Args:
        limit: Max commits to return
        brain: Target brain ID
    """
    from neurovault_server.git_backup import get_history
    ctx = _ctx(brain)
    return get_history(ctx.vault_dir, limit=limit)


# @mcp.tool()  # demoted: destructive, should be UI-driven not Claude-driven
def git_restore(filename: str, commit_hash: str, brain: str | None = None) -> dict:
    """Restore a file to a previous commit.

    Args:
        filename: The note filename (e.g. "my-note-abc123.md")
        commit_hash: Short or full commit hash from git_history
        brain: Target brain ID
    """
    from neurovault_server.git_backup import restore_file
    ctx = _ctx(brain)
    return restore_file(ctx.vault_dir, filename, commit_hash)


# --- Drafts (Longform Replacement) ---


@tiered("research")
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
    from neurovault_server.drafts import create_draft as _create
    ctx = _ctx(brain)
    return _create(ctx.db, title, description, target_words, deadline)


# @mcp.tool()  # demoted: drafts UI is in the Tauri app, not via MCP
def list_drafts(brain: str | None = None) -> list[dict]:
    """List all drafts with progress (sections, word count, target %)."""
    from neurovault_server.drafts import list_drafts as _list
    ctx = _ctx(brain)
    return _list(ctx.db)


# @mcp.tool()  # demoted: drafts UI is in the Tauri app
def get_draft(draft_id: str, brain: str | None = None) -> dict:
    """Get a draft's full contents — ordered sections with previews and word counts."""
    from neurovault_server.drafts import get_draft as _get
    ctx = _ctx(brain)
    result = _get(ctx.db, draft_id)
    if not result:
        return {"error": f"Draft not found: {draft_id}"}
    return result


# @mcp.tool()  # demoted: drafts UI is in the Tauri app
def add_to_draft(
    draft_id: str,
    engram_id: str,
    position: int | None = None,
    brain: str | None = None,
) -> dict:
    """Add a note to a draft at a position (end if None)."""
    from neurovault_server.drafts import add_section
    ctx = _ctx(brain)
    return add_section(ctx.db, draft_id, engram_id, position)


# @mcp.tool()  # demoted: drafts UI is in the Tauri app
def remove_from_draft(draft_id: str, engram_id: str, brain: str | None = None) -> dict:
    """Remove a note from a draft (note itself is preserved)."""
    from neurovault_server.drafts import remove_section
    ctx = _ctx(brain)
    return remove_section(ctx.db, draft_id, engram_id)


# @mcp.tool()  # demoted: drafts UI is in the Tauri app
def reorder_draft_section(
    draft_id: str,
    engram_id: str,
    new_position: int,
    brain: str | None = None,
) -> dict:
    """Move a section to a new 0-indexed position in the draft."""
    from neurovault_server.drafts import reorder_section
    ctx = _ctx(brain)
    return reorder_section(ctx.db, draft_id, engram_id, new_position)


# --- Brain Export / Import ---


# @mcp.tool()  # demoted: rare admin op, UI-driven
def export_brain_archive(include_db: bool = False, brain: str | None = None) -> dict:
    """Bundle a brain into a tar.gz archive for backup, sharing, or migration.

    Args:
        include_db: If True, include brain.db (larger but instant re-import)
        brain: Target brain ID (uses active brain if not specified)
    """
    from neurovault_server.brain_export import export_brain
    ctx = _ctx(brain)
    brain_dir = ctx.vault_dir.parent
    return export_brain(ctx.brain_id, brain_dir, include_db=include_db)


# --- Karpathy LLM Wiki Tools ---


@tiered("power")
def read_index(brain: str | None = None) -> str:
    """Read the auto-maintained index.md — one-line summary of every note.

    USE WHEN: you want a compact overview of everything in the brain.
    Cheaper than recall() for exploration since it's one grep-friendly file.
    Inspired by Karpathy's LLM Wiki pattern.

    Args:
        brain: Target brain ID
    """
    from neurovault_server.karpathy import get_index
    ctx = _ctx(brain)
    return get_index(ctx.vault_dir)


# @mcp.tool()  # demoted: read_index covers wiki overview; log is verbose
def read_log(tail: int = 50, brain: str | None = None) -> str:
    """Read the activity log — chronological record of every event.

    USE WHEN: you want to see what's happened in this brain recently.
    Shows ingest/query/consolidate/contradiction events with timestamps.

    Args:
        tail: How many recent entries to return (default 50)
        brain: Target brain ID
    """
    from neurovault_server.karpathy import get_log
    ctx = _ctx(brain)
    return get_log(ctx.vault_dir, tail=tail)


@tiered("power")
def read_schema(brain: str | None = None) -> str:
    """Read the CLAUDE.md schema — per-brain conventions and rules.

    USE WHEN: starting work in a brain. Shows the tag taxonomy, naming
    conventions, workflows, and any user-specified rules Claude should follow.

    Args:
        brain: Target brain ID
    """
    from neurovault_server.karpathy import get_schema
    ctx = _ctx(brain)
    return get_schema(ctx.vault_dir)


# @mcp.tool()  # demoted: schema edits should be UI-driven, not Claude-driven
def update_schema(content: str, brain: str | None = None) -> dict:
    """Update the CLAUDE.md schema for a brain.

    USE WHEN: the user asks you to change conventions, add tags, or
    codify a new rule. Overwrites the current schema file.

    Args:
        content: New CLAUDE.md content
        brain: Target brain ID
    """
    from neurovault_server.karpathy import update_schema as update
    ctx = _ctx(brain)
    path = update(ctx.vault_dir, content)
    return {"status": "updated", "path": str(path)}


# --- Brain-Like Memory Tools ---


@tiered("power")
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


@tiered("power")
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


# @mcp.tool()  # demoted: background scheduler runs this every 4h
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


# @mcp.tool()  # demoted: save_conversation_insights covers the user-facing path
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


# @mcp.tool()  # demoted: subsumed by recall over conversation_log engrams
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


# @mcp.tool()  # demoted: subsumed by recall — graph traversal already in hybrid retriever
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


# @mcp.tool()  # demoted: invoked automatically by the server, not by Claude
def proactive_context(message: str, brain: str | None = None) -> dict:
    """Proactive context detection — NO LLM call, pure pattern + vector.

    USE WHEN: you want to check if a user message touches on topics NeuroVault has
    stored memories about, BEFORE you decide how to respond. Fast, free, silent.

    Example: user says "What do you think about my education?"
    → This detects "education" topic and returns relevant notes WITHOUT any
    Claude round-trip. You see the context in one call and can respond richly.

    Args:
        message: The user's message (any natural language)
        brain: Target brain ID
    """
    from neurovault_server.proactive import proactive_context as pc
    ctx = _ctx(brain)
    return pc(message, ctx.db, manager.embedder)


@tiered("power")
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


# @mcp.tool()  # demoted: niche; recall(query, max_tokens=N) is enough
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


@tiered("power")
def quick_capture(text: str, title: str | None = None, brain: str | None = None) -> dict:
    """Quick-capture text as a note. Auto-extracts title if not provided.

    Use this for fast note creation from pasted content (papers, articles, ideas).

    Args:
        text: The text to capture
        title: Optional title (auto-extracted from first line if not provided)
        brain: Target brain ID (uses active brain if not specified)
    """
    from neurovault_server.dissertation import quick_capture as qc
    ctx = _ctx(brain)
    return qc(text, title, ctx.vault_dir, ctx.db, manager.embedder, ctx.bm25)


@tiered("power")
def add_tag(engram_id: str, tag: str, brain: str | None = None) -> dict:
    """Add a tag to a memory for organization.

    Args:
        engram_id: The memory ID
        tag: Tag name (e.g. "important", "to-read", "methodology")
        brain: Target brain ID
    """
    from neurovault_server.dissertation import add_tag as add
    ctx = _ctx(brain)
    success = add(ctx.db, engram_id, tag)
    return {"status": "added" if success else "failed", "tag": tag}


# @mcp.tool()  # demoted: list_memories(tag=...) handles this
def find_by_tag(tag: str, brain: str | None = None) -> list[dict]:
    """Find all memories with a specific tag.

    Args:
        tag: The tag to search for
        brain: Target brain ID
    """
    from neurovault_server.dissertation import find_by_tag as find
    ctx = _ctx(brain)
    return find(ctx.db, tag)


# @mcp.tool()  # demoted: niche; available via /api/tags
def list_tags(brain: str | None = None) -> list[dict]:
    """List all tags with usage counts.

    Args:
        brain: Target brain ID
    """
    from neurovault_server.dissertation import list_tags as lt
    ctx = _ctx(brain)
    return lt(ctx.db)


@tiered("research")
def ingest_pdf(pdf_path: str, brain: str | None = None) -> dict:
    """Ingest a PDF paper — extracts text, highlights, and metadata.

    Creates a Source note for the paper and a Quote note for each highlight.
    Use this to import academic papers into your dissertation memory.

    Args:
        pdf_path: Absolute path to the PDF file
        brain: Target brain ID
    """
    from neurovault_server.pdf_ingest import ingest_pdf as ingest
    from pathlib import Path
    ctx = _ctx(brain)
    return ingest(
        Path(pdf_path), ctx.vault_dir, ctx.db, manager.embedder, ctx.bm25,
        raw_dir=ctx.raw_dir,
    )


# @mcp.tool()  # demoted: rare; available via /api/citations
def export_citations(tag: str | None = None, brain: str | None = None) -> str:
    """Export notes as BibTeX citations.

    Looks for **Author:** / **Year:** / **Journal:** metadata in note content.
    Optionally filter by tag (e.g. "methodology", "background").

    Args:
        tag: Optional tag filter
        brain: Target brain ID
    """
    from neurovault_server.dissertation import export_bibtex
    ctx = _ctx(brain)
    return export_bibtex(ctx.db, tag)


# --- Session Context Resource ---


# --- Progressive disclosure: tier 2 (timeline) + tier 3 (fetch) ---


@tiered("power")
def timeline(
    around: str,
    before: int = 3,
    after: int = 3,
    brain: str | None = None,
) -> list[dict]:
    """Show the chronological neighbors of an engram (tier 2 of progressive disclosure).

    USE WHEN: you have an engram_id from `recall(mode='titles')` and want to
    see what happened immediately before/after it — useful for reconstructing
    a session's flow without paying full content cost. Returns lightweight
    title+preview rows ordered by created_at.

    Args:
        around: An engram_id, OR a query string (uses the top recall hit as anchor).
        before: How many engrams before the anchor to include.
        after:  How many engrams after the anchor to include.
        brain: Target brain ID.
    """
    ctx = _ctx(brain)

    # Resolve the anchor engram
    anchor = ctx.db.get_engram(around)
    if not anchor:
        # Treat as a query, use top recall hit
        hits = hybrid_retrieve(around, ctx.db, manager.embedder, ctx.bm25, top_k=1)
        if not hits:
            return []
        anchor = ctx.db.get_engram(hits[0]["engram_id"])
        if not anchor:
            return []

    anchor_time = anchor.get("created_at")
    if not anchor_time:
        return []

    before_rows = ctx.db.conn.execute(
        """SELECT id, title, content, created_at, kind
           FROM engrams
           WHERE created_at < ? AND state != 'dormant'
           ORDER BY created_at DESC LIMIT ?""",
        (anchor_time, before),
    ).fetchall()
    after_rows = ctx.db.conn.execute(
        """SELECT id, title, content, created_at, kind
           FROM engrams
           WHERE created_at > ? AND state != 'dormant'
           ORDER BY created_at ASC LIMIT ?""",
        (anchor_time, after),
    ).fetchall()

    def fmt(r, position: str) -> dict:
        return {
            "engram_id": r[0],
            "title": r[1],
            "preview": (r[2] or "")[:160],
            "created_at": r[3],
            "kind": r[4] or "note",
            "position": position,
        }

    timeline_items: list[dict] = [fmt(r, "before") for r in reversed(before_rows)]
    timeline_items.append({
        "engram_id": anchor["id"],
        "title": anchor["title"],
        "preview": (anchor["content"] or "")[:160],
        "created_at": anchor_time,
        "kind": anchor.get("kind") or "note",
        "position": "anchor",
    })
    timeline_items.extend(fmt(r, "after") for r in after_rows)
    return timeline_items


@tiered("research")
def fetch(
    engram_ids: list[str],
    brain: str | None = None,
) -> list[dict]:
    """Get full content for a batch of engram IDs (tier 3 of progressive disclosure).

    USE WHEN: you've narrowed down via `recall(mode='titles')` and `timeline()`
    and now need the actual full text. Batched so a single call gets multiple
    engrams without round-trips.

    This is the "expensive" tier — only call after the cheap tiers have done
    their filtering work, otherwise you're burning tokens.

    Args:
        engram_ids: List of engram IDs to fetch in full.
        brain: Target brain ID.
    """
    ctx = _ctx(brain)
    results: list[dict] = []
    for eid in engram_ids[:20]:  # Cap to avoid runaway batches
        engram = ctx.db.get_engram(eid)
        if not engram:
            continue
        results.append({
            "engram_id": engram["id"],
            "title": engram["title"],
            "content": engram["content"],
            "kind": engram.get("kind") or "note",
            "tags": engram.get("tags"),
            "strength": engram.get("strength"),
            "created_at": engram.get("created_at"),
            "updated_at": engram.get("updated_at"),
        })
        try:
            ctx.db.bump_access(eid)
        except Exception:
            pass
        # Positive-usage signal for the feedback loop: an explicit fetch
        # after a recall is the strongest "this memory was actually useful"
        # signal we can capture without asking the user.
        try:
            from neurovault_server.retrieval_feedback import mark_accessed
            mark_accessed(ctx.db, eid)
        except Exception as e:
            logger.debug("Retrieval feedback mark_accessed skipped: {}", e)
    return results


# --- Code & Variable Tools ---


@tiered("code")
def ingest_code(filepath: str, brain: str | None = None) -> dict:
    """Ingest a single source code file into the brain.

    Extracts functions, imports, TODO/FIXME markers, and tracks every
    named variable/function/class for later lookup. Works on Python, JS,
    TS, Rust, Go, Java, C/C++, and 20+ other languages.
    """
    from neurovault_server.code_ingest import ingest_code_file
    ctx = _ctx(brain)
    path = Path(filepath).expanduser().resolve()
    if not path.exists():
        return {"error": f"File not found: {path}"}
    result = ingest_code_file(path, ctx.vault_dir, ctx.db, manager.embedder, ctx.bm25)
    if result is None:
        return {"error": f"Could not ingest (skipped or unsupported): {path}"}
    return result


@tiered("code")
def ingest_repo(repo_path: str, max_files: int = 500, brain: str | None = None) -> dict:
    """Walk a code repository and ingest every supported source file.

    Skips node_modules, .git, build/dist, lock files, and binaries. Each
    file becomes a Source engram; markers become TODO engrams; variables
    are tracked. Use after pointing NeuroVault at a new project.
    """
    from neurovault_server.code_ingest import ingest_repo as do_ingest_repo
    ctx = _ctx(brain)
    path = Path(repo_path).expanduser().resolve()
    return do_ingest_repo(path, ctx.vault_dir, ctx.db, manager.embedder, ctx.bm25, max_files=max_files)


@tiered("code")
def find_todos(marker_type: str | None = None, limit: int = 50, brain: str | None = None) -> list[dict]:
    """List open TODO/FIXME/HACK/WHY markers across the codebase.

    Filter by marker_type (TODO, FIXME, HACK, NOTE, BUG, etc.) or pass
    None to get them all. Useful for "what work is outstanding?" queries.
    """
    from neurovault_server.code_ingest import find_todos as do_find_todos
    ctx = _ctx(brain)
    return do_find_todos(ctx.db, marker_type=marker_type, limit=limit)


@tiered("code")
def find_variable(name: str, brain: str | None = None) -> dict:
    """Look up a tracked variable, function, class, or type by name.

    Returns the canonical definition (type hint, language, scope,
    docstring) plus every place it is referenced. Solves the
    "what was that variable called again?" problem for AI coding.
    """
    from neurovault_server.variable_tracker import find_variable as do_find_variable
    ctx = _ctx(brain)
    result = do_find_variable(ctx.db, name)
    return result or {"found": False, "name": name}


@tiered("code")
def list_variables(
    language: str | None = None,
    kind: str | None = None,
    status: str = "live",
    limit: int = 100,
    brain: str | None = None,
) -> list[dict]:
    """List tracked variables, optionally filtered by language, kind, or status.

    status ∈ {'live', 'removed', 'all'} — 'live' hides names that have
    disappeared from every file. kind ∈ {variable, constant, function,
    class, type}. Sorted by reference count.
    """
    from neurovault_server.variable_tracker import list_variables as do_list_variables
    ctx = _ctx(brain)
    return do_list_variables(ctx.db, language=language, kind=kind, status=status, limit=limit)


# @mcp.tool()  # demoted: niche; surfaced inside find_variable.rename_candidates
def find_renames(limit: int = 50, brain: str | None = None) -> list[dict]:
    """List detected rename candidates (old_name → new_name).

    A rename candidate is flagged when a name disappears from a file and
    a new name with the same kind + type_hint appears in the same engram
    during re-ingest. Use to audit refactors.
    """
    from neurovault_server.variable_tracker import find_renames as do_find_renames
    ctx = _ctx(brain)
    return do_find_renames(ctx.db, limit=limit)


# @mcp.tool()  # demoted: niche; available via /api/variables/stats
def variable_stats(brain: str | None = None) -> dict:
    """Summary counts: live vs removed vars, per language, pending renames."""
    from neurovault_server.variable_tracker import variable_stats as do_stats
    ctx = _ctx(brain)
    return do_stats(ctx.db)


# @mcp.tool()  # demoted: find_variable handles substring lookups internally
def search_variables(pattern: str, limit: int = 20, brain: str | None = None) -> list[dict]:
    """Fuzzy-search tracked variables by substring of the name.

    Use when you remember part of a name ("config", "auth_") but not
    the exact identifier. Case-insensitive LIKE match.
    """
    from neurovault_server.variable_tracker import search_variables as do_search_variables
    ctx = _ctx(brain)
    return do_search_variables(ctx.db, pattern, limit=limit)


# --- Call Graph Tools ---


@tiered("code")
def find_callers(name: str, limit: int = 50, brain: str | None = None) -> list[dict]:
    """List every place a function is called from.

    Returns callsites with the containing function (caller), filepath, and
    line number. Use this when refactoring to see who depends on a function.
    """
    from neurovault_server.call_graph import find_callers as do_find_callers
    ctx = _ctx(brain)
    return do_find_callers(ctx.db, name, limit=limit)


@tiered("code")
def find_callees(name: str, limit: int = 100, brain: str | None = None) -> list[dict]:
    """List every function that a given function calls.

    Returns the outgoing call edges. Use this to understand what a function
    depends on before changing its behavior.
    """
    from neurovault_server.call_graph import find_callees as do_find_callees
    ctx = _ctx(brain)
    return do_find_callees(ctx.db, name, limit=limit)


@tiered("code")
def get_impact_radius(
    filepaths: list[str],
    max_depth: int = 3,
    max_affected: int = 200,
    brain: str | None = None,
) -> dict:
    """Trace the blast radius of changes to a set of files.

    USE WHEN: the user is about to edit or has just edited one or more
    files and wants to know what's at risk. Returns every function that
    would be transitively affected (BFS upward through the call graph),
    risk-scored by caller count + memory strength + related decisions +
    depth penalty.

    NeuroVault-unique: the risk score uses the cognitive layer (decay,
    access count, related decision engrams) that pure structural tools
    can't build. So "hot function with a pinned decision note" scores
    higher than "cold helper nobody touches."

    Args:
        filepaths: Source files to trace impact from.
        max_depth: How many BFS hops upward to explore (default 3).
        max_affected: Hard cap on total symbols returned (default 200).
        brain: Target brain ID (uses active brain if not specified).
    """
    from neurovault_server.impact import get_impact_radius as do_impact
    ctx = _ctx(brain)
    return do_impact(ctx.db, filepaths, max_depth=max_depth, max_affected=max_affected)


@tiered("code")
def detect_changes(
    diff: str = "",
    filepaths: list[str] | None = None,
    max_depth: int = 3,
    brain: str | None = None,
) -> dict:
    """Parse a git diff (or accept explicit file paths) and return a
    risk-ranked view of what the change affects.

    USE WHEN: reviewing a PR, answering "is this change safe?", or
    grading how aggressive a refactor is. Accepts unified diff text
    (`git diff` output) and parses the `+++ b/path` lines, OR a list
    of filepaths for programmatic callers.

    Returns the full impact radius plus a diff-level risk score
    (0-10), a risk_level label ("low"/"medium"/"high"/"critical"),
    and the top-15 high-risk symbols so Claude can decide whether
    to flag the change for deeper review.

    Pair with `review_context(filepaths)` for a complete "PR review"
    workflow: impact radius tells you WHAT is at risk, review_context
    tells you WHAT THE CODE LOOKS LIKE, and both avoid reading raw files.

    Args:
        diff: Unified diff text (e.g. `git diff` output). Optional if
            filepaths is provided.
        filepaths: Alternative to diff — explicit list of changed files.
        max_depth: BFS depth for the impact graph (default 3).
        brain: Target brain ID.
    """
    from neurovault_server.impact import detect_changes as do_detect
    ctx = _ctx(brain)
    return do_detect(ctx.db, diff_text=diff, filepaths=filepaths, max_depth=max_depth)


@tiered("code")
def review_context(
    filepaths: list[str],
    total_token_budget: int = 3000,
    callers_per_symbol: int = 3,
    callees_per_symbol: int = 3,
    memories_per_symbol: int = 2,
    brain: str | None = None,
) -> dict:
    """Token-efficient structural review context for a list of files.

    USE WHEN: the user asks you to review a PR, explain what a file does,
    assess the impact of a change, or check related decisions before
    editing. Returns a tight structural summary (symbols + their top
    callers + top callees + related memory engrams) instead of the raw
    file content — typically 5-10x fewer tokens than concatenating the
    files, plus information (callers, related decisions) that raw
    content doesn't have.

    NeuroVault-unique: surfaces related decision/memory engrams per
    symbol. code-review-graph has no cognitive layer, so their review
    context is purely structural; ours also shows "there's a decision
    note from March about this function" which is often the most
    valuable context when reviewing a diff.
    """
    from neurovault_server.review_context import get_review_context
    ctx = _ctx(brain)
    return get_review_context(
        ctx.db,
        filepaths,
        total_token_budget=total_token_budget,
        callers_per_symbol=callers_per_symbol,
        callees_per_symbol=callees_per_symbol,
        memories_per_symbol=memories_per_symbol,
    )


# @mcp.tool()  # demoted: BFS niche; find_callers/find_callees cover most uses
def call_graph(
    name: str,
    depth: int = 2,
    direction: str = "callers",
    brain: str | None = None,
) -> dict:
    """BFS the call graph outward from a function.

    direction ∈ {'callers', 'callees', 'both'}. Returns levels of edges so
    you can trace impact ("if I change foo, what's affected?") or follow
    execution flow ("what does foo end up calling?").
    """
    from neurovault_server.call_graph import call_graph_for
    ctx = _ctx(brain)
    return call_graph_for(ctx.db, name, depth=depth, direction=direction)


# @mcp.tool()  # demoted: stats query, available via /api/calls/hot
def hot_functions(limit: int = 20, brain: str | None = None) -> list[dict]:
    """The most-called functions in the codebase.

    Surfaces the project's de-facto API surface — the names you must know
    to read the code. Sorted by inbound call count.
    """
    from neurovault_server.call_graph import hot_functions as do_hot
    ctx = _ctx(brain)
    return do_hot(ctx.db, limit=limit)


# --- Cognitive code intelligence (NeuroVault's unique angle) ---


@tiered("code")
def find_dead_code(
    stale_days: int = 60,
    max_callers: int = 0,
    limit: int = 50,
    brain: str | None = None,
) -> list[dict]:
    """Find functions/classes that look dead — uncalled and untouched.

    USE WHEN: the user asks "what code can I delete?", "is this still used?",
    or wants to clean up a project. Returns symbols that haven't been touched
    in `stale_days` days AND have at most `max_callers` inbound call edges,
    each with a confidence score 0..1.

    Combines decay (last_seen) + reference count + call graph. Only NeuroVault
    can answer this — pure structural tools have no concept of staleness.
    """
    from neurovault_server.call_graph import find_dead_code as do_find_dead
    ctx = _ctx(brain)
    return do_find_dead(ctx.db, stale_days=stale_days, max_callers=max_callers, limit=limit)


@tiered("code")
def find_renamed_callsites(limit: int = 50, brain: str | None = None) -> list[dict]:
    """Find places that still call the OLD name of a renamed symbol.

    USE WHEN: the user asks "did I finish that rename?", "are there leftover
    references to old_name?", or wants to verify a refactor propagated.
    For each detected rename in `variable_renames`, lists every callsite
    that still uses the old name in the live call graph.

    Demo answer: "You renamed `user_id` to `account_id` 2 weeks ago, but
    these 3 files still call the old name." Nobody else can ship this —
    GitNexus tracks current state, we track rename history.
    """
    from neurovault_server.call_graph import find_renamed_callsites as do_find_stale
    ctx = _ctx(brain)
    return do_find_stale(ctx.db, limit=limit)


@tiered("power")
def extract_insights(
    text: str,
    save: bool = False,
    brain: str | None = None,
) -> dict:
    """Silently harvest factual claims from a block of text.

    USE WHEN: the user types a casual message with facts buried in it
    ("I prefer Tauri 2.0", "the deadline is Friday", "Sarah runs the
    weekly check-ins", "remember that X lives at Y") and you want the
    brain to pick those up as first-class memories without asking.

    Runs fast regex patterns for: explicit saves ("remember that..."),
    preferences ("I prefer X"), decisions ("we chose Y"), stack
    ("we're using Z"), deadlines, locations, and identity claims.
    Questions, commands, and hypotheticals are skipped.

    With `save=True`, promotes each extracted insight into its own
    `kind='insight'` engram so it becomes searchable via `recall`.
    With `save=False` (default), just returns the extractions for
    review. The hooks pipeline already runs save=True automatically
    on every UserPromptSubmit, so manual calls are mostly useful
    for one-off text blobs (emails, meeting notes, docs).
    """
    from neurovault_server.insight_extractor import extract_insights as do_extract, promote_insights_from_text
    ctx = _ctx(brain)
    if save:
        created = promote_insights_from_text(ctx, text)
        return {"mode": "save", "insights": created, "count": len(created)}
    insights = do_extract(text)
    return {
        "mode": "preview",
        "insights": [
            {
                "title": i.title,
                "fact": i.fact,
                "pattern": i.pattern_name,
                "confidence": i.confidence,
            }
            for i in insights
        ],
        "count": len(insights),
    }


@tiered("power")
def rollup_session(
    session_id: str,
    brain: str | None = None,
) -> dict:
    """Compress a Claude Code session's raw observation engrams into ONE summary.

    USE WHEN: a session is clearly done and you want to free the brain
    from the individual tool-call noise, OR when the vault feels cluttered
    with `obs-*.md` files. Produces a single `session_summary` engram with
    event counts, tool-usage breakdown, user prompts, and a timeline —
    then soft-deletes the raw observations and archives their files to
    ~/.neurovault/brains/{brain}/archive/ so they stop slowing vault scans.

    Reversible: the raw markdown files are preserved in the archive dir,
    and the original engram rows stay in the DB with state='dormant'.

    For automatic bulk rollup of stale sessions, this also runs during
    the 4-hour consolidation cycle for sessions idle >24h with >=3 events.
    """
    from neurovault_server.observation_rollup import rollup_session as do_rollup
    ctx = _ctx(brain)
    # Accept either the 8-char short session or the full id
    short = session_id[:8] if len(session_id) > 8 else session_id
    return do_rollup(ctx, short)


@tiered("power")
def replay_session(session_id: str, max_events: int = 200, brain: str | None = None) -> dict:
    """Reconstruct what Claude did during a previous Claude Code session.

    USE WHEN: the user asks "what did you do yesterday?", "show me that
    debugging session", or wants to remember a sequence of actions. Returns
    a chronological list of every captured observation for the given
    session_id, plus event-type and tool-usage rollups.

    Powered by the auto-capture hook pipeline — observations land as engrams
    with `obs-{session}-*.md` filenames, and this tool replays them in order.
    """
    from neurovault_server.hooks import replay_session as do_replay
    ctx = _ctx(brain)
    return do_replay(ctx, session_id, max_events=max_events)


@tiered("power")
def compile_page(
    topic: str,
    model: str | None = None,
    brain: str | None = None,
) -> dict:
    """Rewrite the canonical wiki page for a topic by reading every raw source that mentions it.

    USE WHEN: the user asks you to "compile the X page", or after a burst
    of new notes lands on a topic and you want a single canonical view,
    or the user asks what's the current state of a topic and the answer
    lives across many raw sources.

    The compiler gathers every non-dormant raw engram mentioning the
    topic via the `entity_mentions` index, reads them, calls Claude with
    a strict prompt that requires footnote-style `[src:abc123]` citations
    on every factual claim, and writes the result to a `compilations`
    row with status='pending' plus a wiki file at vault/wiki/. Humans
    then approve or reject via the review panel — they never edit wiki
    pages directly, preserving the split between "humans write raw,
    system compiles, humans read-only review".

    Returns the compilation row summary (id, changelog count, source
    count, token usage). The full diff and changelog are fetchable via
    `list_compilations(status='pending')` and the HTTP detail endpoint.
    """
    from neurovault_server.compiler import compile_topic
    ctx = _ctx(brain)
    try:
        result = compile_topic(ctx, topic, model=model)
        return {
            "id": result.id,
            "topic": result.topic,
            "status": result.status,
            "change_count": len(result.changelog),
            "source_count": len(result.sources),
            "model": result.model,
            "input_tokens": result.input_tokens,
            "output_tokens": result.output_tokens,
        }
    except ValueError as e:
        return {"error": str(e), "topic": topic}
    except RuntimeError as e:
        return {"error": str(e), "topic": topic, "fatal": True}


@tiered("power")
def list_compilations(
    status: str = "pending",
    limit: int = 50,
    brain: str | None = None,
) -> list[dict]:
    """List compiled wiki pages, optionally filtered by review status.

    USE WHEN: the user asks "what wiki pages need review", "show me
    recent compilations", or you want to see what the compiler has
    written recently. Status values: pending | approved | rejected |
    auto_applied | all.

    Returns a list of row summaries (id, topic, status, timestamps,
    change count, source count). The full diff + changelog + content
    of one compilation are fetchable via the HTTP detail endpoint at
    /api/compilations/{id}.
    """
    from neurovault_server.compiler import list_compilations as do_list
    ctx = _ctx(brain)
    filter_status = None if status == "all" else status
    return do_list(ctx, status=filter_status, limit=limit)


@mcp.resource("engram://session-context")
def session_context() -> str:
    """Proactive wake-up bundle — everything Claude needs on session start.

    Loaded automatically the moment a session begins. Designed so Claude
    has to call almost zero extra tools to know what the user is working
    on, who the user is, what's unresolved, and what happened recently.

    Sections, in order of value:
      1. **Active brain** — which brain + cheap stats
      2. **Core identity (L0)** — who the user is, preferences, role
      3. **Recent sessions** — last 3 rolled-up session summaries so
         Claude knows what happened yesterday without asking
      4. **Working memory** — pinned engrams the user considers active
      5. **Unresolved contradictions** — things the brain spotted that
         need human review (shown proactively so Claude can flag them)
      6. **Top active memories (L1)** — the N most-referenced engrams
      7. **Brain health** — one-line status (how many memories, how
         many learned shortcuts, how fresh the feedback loop is)

    Total target: ~1500-2500 tokens. Fits comfortably in context, yet
    gives Claude 90% of what it would otherwise need to fetch via tools.
    """
    ctx = manager.get_active()
    db = ctx.db
    session = build_session_context(db)

    lines: list[str] = []
    lines.append(f"# NeuroVault — Active Brain: {ctx.name}")
    lines.append("")
    lines.append(
        f"*{session['stats']['total_memories']} memories · "
        f"{session['stats']['total_connections']} connections · "
        f"brain id `{ctx.brain_id}`*"
    )
    lines.append("")

    # Section 1 — core identity (preferences, role, long-lived facts)
    lines.append("## Core identity")
    lines.append(session["l0"] or "_(no identity memories yet — save some with `remember()`)_")
    lines.append("")

    # Section 2 — recent session summaries (from observation rollup)
    try:
        summary_rows = db.conn.execute(
            """SELECT title, SUBSTR(content, 1, 400)
               FROM engrams
               WHERE kind = 'session_summary' AND state != 'dormant'
               ORDER BY updated_at DESC
               LIMIT 3"""
        ).fetchall()
    except Exception:
        summary_rows = []
    if summary_rows:
        lines.append("## Recent sessions")
        for title, preview in summary_rows:
            # Compress the preview to one line per session
            first_line = (preview or "").split("\n", 1)[0].strip("# ")
            lines.append(f"- **{title}** — {first_line[:120]}")
        lines.append("")

    # Section 3 — working memory (pinned by user OR auto-refreshed)
    try:
        wm_rows = db.conn.execute(
            """SELECT e.title, w.pin_type, w.priority
               FROM working_memory w
               JOIN engrams e ON e.id = w.engram_id
               WHERE e.state != 'dormant'
               ORDER BY w.priority DESC, w.pinned_at DESC
               LIMIT 7"""
        ).fetchall()
    except Exception:
        wm_rows = []
    if wm_rows:
        lines.append("## Working memory (active context)")
        for title, pin_type, _prio in wm_rows:
            tag = "📌" if pin_type == "manual" else "•"
            lines.append(f"- {tag} {title}")
        lines.append("")

    # Section 4 — unresolved contradictions (proactive flag)
    try:
        contradiction_rows = db.conn.execute(
            """SELECT e1.title, e2.title, c.fact_a, c.fact_b
               FROM contradictions c
               JOIN engrams e1 ON e1.id = c.engram_a
               JOIN engrams e2 ON e2.id = c.engram_b
               WHERE c.resolved = 0
               ORDER BY c.detected_at DESC
               LIMIT 3"""
        ).fetchall()
    except Exception:
        contradiction_rows = []
    if contradiction_rows:
        lines.append("## ⚠️  Unresolved contradictions")
        for a_title, b_title, fact_a, fact_b in contradiction_rows:
            lines.append(f"- **{a_title}** vs **{b_title}**")
            lines.append(f"  - {(fact_a or '')[:100]}")
            lines.append(f"  - {(fact_b or '')[:100]}")
        lines.append("")

    # Section 5 — top active memories (the L1 slice)
    lines.append("## Top active memories")
    lines.append(session["l1"] or "_(no active memories yet)_")
    lines.append("")

    # Section 6 — brain health (one-line status of self-improving pipeline)
    health_parts: list[str] = []
    try:
        obs_count = db.conn.execute(
            "SELECT COUNT(*) FROM engrams WHERE kind='observation' AND state != 'dormant'"
        ).fetchone()[0]
        summary_count = db.conn.execute(
            "SELECT COUNT(*) FROM engrams WHERE kind='session_summary' AND state != 'dormant'"
        ).fetchone()[0]
        shortcut_count = db.conn.execute(
            "SELECT COUNT(*) FROM query_affinity"
        ).fetchone()[0]
        feedback_recent = db.conn.execute(
            "SELECT COUNT(*) FROM retrieval_feedback WHERE retrieved_at >= datetime('now', '-1 day')"
        ).fetchone()[0]
        health_parts.append(f"{obs_count} live observations")
        health_parts.append(f"{summary_count} session summaries")
        health_parts.append(f"{shortcut_count} learned query shortcuts")
        health_parts.append(f"{feedback_recent} retrievals in last 24h")
    except Exception:
        pass

    if health_parts:
        lines.append("## Brain health")
        lines.append(" · ".join(health_parts))
        lines.append("")

    lines.append(
        "_Use `recall(query)` for deeper lookups, `about(entity)` for entity-first, "
        "`review_context(files)` for PR review, `replay_session(id)` to replay a session._"
    )

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
    from neurovault_server.karpathy import get_index
    ctx = manager.get_active()
    return get_index(ctx.vault_dir)


@mcp.resource("engram://schema")
def schema_resource() -> str:
    """Karpathy-style CLAUDE.md — per-brain conventions and rules.

    Auto-loaded on session start so Claude follows the user's tag
    taxonomy, naming conventions, and codified rules for this brain.
    """
    from neurovault_server.karpathy import get_schema
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

def _warm_embedder() -> None:
    """Force the sentence-transformer to load and embed one dummy string.

    Without this the first `recall` call after boot pays a ~10s model-load
    tax while the user sits watching the spinner. Running it during server
    startup moves that cost off the critical path so the first real query
    feels fast. Safe to call multiple times — Embedder.get() is a singleton.
    """
    try:
        import time as _t
        t0 = _t.time()
        from neurovault_server.embeddings import Embedder
        embedder = Embedder.get()
        embedder.encode("warmup query")
        logger.info("Embedder warmed in {:.1f}s", _t.time() - t0)
    except Exception as e:
        logger.warning("Embedder warmup failed (non-fatal): {}", e)


def main() -> None:
    import sys

    active = manager.get_active()
    logger.info("Starting NeuroVault MCP server")
    logger.info("Active brain: {} ({})", active.name, active.brain_id)
    logger.info("Vault: {}", active.vault_dir)

    # Init query audit log for the active brain
    from neurovault_server.audit import init_audit_log
    init_audit_log(active.vault_dir.parent)

    _warm_embedder()

    if "--http-only" in sys.argv:
        import uvicorn
        from neurovault_server.api import create_api
        from neurovault_server.config import SERVER_PORT

        logger.info("Running in HTTP-only mode on port {}", SERVER_PORT)
        app = create_api(manager)
        uvicorn.run(app, host="127.0.0.1", port=SERVER_PORT, log_level="info")
    else:
        start_api_server(manager)
        mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
