import uuid
from pathlib import Path

from mcp.server.fastmcp import FastMCP
from loguru import logger

from engram_server.brain import BrainManager, BrainContext
from engram_server.ingest import ingest_file
from engram_server.retriever import hybrid_retrieve
from engram_server.write_back import write_back as do_write_back, build_session_context
from engram_server.api import start_api_server

# --- Initialize ---

mcp = FastMCP(
    "Engram Memory",
    instructions=(
        "Engram is a local AI memory system with multiple brains. "
        "Use `remember` to save durable facts. Use `recall` to search memory. "
        "Use `get_related` to explore connections. "
        "Use `list_brains` / `switch_brain` / `create_brain` to manage separate memory spaces. "
        "Memories persist across all sessions."
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
def recall(query: str, limit: int = 10, brain: str | None = None) -> list[dict]:
    """Search memory using hybrid retrieval: semantic + BM25 + knowledge graph.

    Results are reranked by a cross-encoder and boosted by memory strength.
    Use this BEFORE answering questions.

    Args:
        query: Natural language search query
        limit: Maximum results (default 10)
        brain: Target brain ID (uses active brain if not specified)
    """
    ctx = _ctx(brain)
    return hybrid_retrieve(query, ctx.db, manager.embedder, ctx.bm25, top_k=limit)


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


# --- Session Context Resource ---


@mcp.resource("engram://session-context")
def session_context() -> str:
    """Session wake-up context — what Engram knows right now."""
    ctx = manager.get_active()
    session = build_session_context(ctx.db)
    lines = [
        f"## Brain: {ctx.name}",
        "",
        "### Core Context (L0)",
        session["l0"],
        "",
        "### Active Memories (L1)",
        session["l1"],
        "",
        f"*{session['stats']['total_memories']} memories, "
        f"{session['stats']['total_connections']} connections*",
    ]
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
