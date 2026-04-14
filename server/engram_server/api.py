"""HTTP API for the Tauri frontend and external clients.

Exposes vault data, brain management, indexing status, and graph data.
"""

import threading

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
from loguru import logger

from engram_server.config import SERVER_PORT


class CreateBrainRequest(BaseModel):
    name: str
    description: str = ""


def create_api(manager) -> FastAPI:
    """Create the FastAPI app with BrainManager."""

    app = FastAPI(title="Engram API", version="0.4.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    def _db():
        return manager.get_active().db

    def _ctx():
        return manager.get_active()

    # --- Brain Management ---

    @app.get("/api/brains")
    def list_brains():
        return manager.list_brains()

    @app.get("/api/brains/active")
    def get_active_brain():
        ctx = _ctx()
        return {"brain_id": ctx.brain_id, "name": ctx.name, "description": ctx.description}

    @app.post("/api/brains")
    def create_brain(body: CreateBrainRequest):
        ctx = manager.create_brain(body.name, body.description)
        return {"brain_id": ctx.brain_id, "name": ctx.name, "status": "created"}

    @app.post("/api/brains/{brain_id}/activate")
    def activate_brain(brain_id: str):
        ctx = manager.switch_brain(brain_id)
        return {"status": "switched", "brain_id": ctx.brain_id, "name": ctx.name}

    @app.delete("/api/brains/{brain_id}")
    def delete_brain(brain_id: str):
        success = manager.delete_brain(brain_id)
        if success:
            return {"status": "deleted"}
        return {"status": "error", "message": "Cannot delete active brain"}

    # --- Status ---

    @app.get("/api/health")
    def health():
        return {"status": "ok", "service": "engram"}

    @app.get("/api/status")
    def status():
        db = _db()
        ctx = _ctx()
        total = db.conn.execute("SELECT COUNT(*) FROM engrams WHERE state != 'dormant'").fetchone()[0]
        chunks = db.conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
        entities = db.conn.execute("SELECT COUNT(*) FROM entities").fetchone()[0]
        links = db.conn.execute("SELECT COUNT(*) FROM engram_links").fetchone()[0]
        return {
            "brain": ctx.brain_id,
            "brain_name": ctx.name,
            "memories": total,
            "chunks": chunks,
            "entities": entities,
            "connections": links,
            "indexing": [],
        }

    # --- Notes ---

    @app.get("/api/notes")
    def list_notes():
        db = _db()
        rows = db.conn.execute(
            """SELECT id, filename, title, state, strength, access_count, updated_at
               FROM engrams WHERE state != 'dormant'
               ORDER BY updated_at DESC"""
        ).fetchall()
        return [dict(r) for r in rows]

    @app.post("/api/notes")
    def create_or_update_note(body: dict):
        """Create (or update by title) a memory via HTTP.

        Body: {"title": "...", "content": "...", "tags": ["..."]?}

        HTTP equivalent of the `remember` MCP tool. Lets non-Claude
        clients (web clippers, mobile apps, cron jobs, curl scripts)
        write to the brain without needing an MCP session.

        Upsert-by-title semantics: if a note with the same title
        already exists, its content is replaced (same filename reused)
        and the status is "updated"; otherwise a new engram is created.

        Important: the returned engram_id is the one `ingest_file`
        actually stored in the database, not the speculative uuid we
        use for the filename slug. This matters because ingest_file
        may mint its own uuid when it can't find a matching filename.
        """
        from engram_server.ingest import ingest_file
        import uuid as _uuid

        title = (body.get("title") or "").strip()
        content = body.get("content") or ""
        if not title:
            return {"error": "title is required"}

        ctx = _ctx()

        def _slug(text: str) -> str:
            s = ""
            for ch in text.lower():
                if ch.isalnum():
                    s += ch
                elif s and s[-1] != "-":
                    s += "-"
            return s.strip("-")[:60]

        existing = ctx.db.get_engram_by_title(title)
        if existing:
            filename = existing["filename"]
            status = "updated"
        else:
            # The uuid here is only used to pick a unique filename slug.
            # The actual stored engram_id comes from ingest_file's return.
            tmp_id = str(_uuid.uuid4())
            filename = f"{_slug(title)}-{tmp_id[:8]}.md"
            status = "created"

        tags = body.get("tags")
        header = f"# {title}\n"
        if tags and isinstance(tags, list):
            tag_line = " ".join(f"#{t.strip()}" for t in tags if isinstance(t, str) and t.strip())
            if tag_line:
                header += f"\n{tag_line}\n"

        filepath = ctx.vault_dir / filename
        filepath.write_text(f"{header}\n{content}", encoding="utf-8")

        try:
            stored_id = ingest_file(filepath, ctx.db, manager.embedder, ctx.bm25)
        except Exception as e:
            logger.warning("POST /api/notes ingest failed: {}", e)
            return {"error": f"ingest failed: {e}", "filename": filename}

        # ingest_file returns None when the file is unchanged — resolve
        # the real engram_id by filename in that case.
        if not stored_id:
            row = ctx.db.conn.execute(
                "SELECT id FROM engrams WHERE filename = ?", (filename,)
            ).fetchone()
            stored_id = row[0] if row else None
            status = "unchanged"

        return {
            "status": status,
            "engram_id": stored_id,
            "filename": filename,
            "title": title,
            "brain": ctx.brain_id,
        }

    @app.delete("/api/notes/{engram_id}")
    def delete_note(engram_id: str):
        """Mark a note as dormant (soft delete). Mirrors the `forget` MCP tool."""
        db = _db()
        ok = db.soft_delete(engram_id)
        return {"status": "forgotten" if ok else "not_found", "engram_id": engram_id}

    @app.get("/api/notes/{engram_id}")
    def get_note(engram_id: str):
        db = _db()
        engram = db.get_engram(engram_id)
        if not engram:
            return {"error": "not found"}

        links = db.conn.execute(
            """SELECT e.id, e.title, l.similarity, l.link_type
               FROM engram_links l
               JOIN engrams e ON e.id = l.to_engram
               WHERE l.from_engram = ? AND e.state != 'dormant'
               ORDER BY l.similarity DESC""",
            (engram_id,),
        ).fetchall()
        engram["connections"] = [
            {"engram_id": r[0], "title": r[1], "similarity": round(r[2], 3), "link_type": r[3]}
            for r in links
        ]

        entities = db.conn.execute(
            """SELECT ent.name, ent.entity_type
               FROM entity_mentions em
               JOIN entities ent ON ent.id = em.entity_id
               WHERE em.engram_id = ?""",
            (engram_id,),
        ).fetchall()
        engram["entities"] = [{"name": r[0], "type": r[1]} for r in entities]

        return engram

    # --- Graph ---

    @app.get("/api/graph")
    def get_graph(
        include_observations: bool = False,
        min_similarity: float = 0.75,
    ):
        """User-facing knowledge graph.

        By default excludes hook-captured observations (they form dense
        sub-clusters that make the graph unreadable) and prunes edges
        below `min_similarity=0.75`. Pass `include_observations=true`
        or lower `min_similarity` to see everything.
        """
        db = _db()

        kind_filter = "" if include_observations else (
            " AND COALESCE(kind, 'note') NOT IN ('observation', 'session_summary')"
        )

        nodes = db.conn.execute(
            f"""SELECT id, title, state, strength, access_count
                FROM engrams
                WHERE state != 'dormant'{kind_filter}"""
        ).fetchall()

        edges = db.conn.execute(
            f"""SELECT l.from_engram, l.to_engram, l.similarity, l.link_type
                FROM engram_links l
                JOIN engrams e1 ON e1.id = l.from_engram AND e1.state != 'dormant'{kind_filter.replace('kind', 'e1.kind')}
                JOIN engrams e2 ON e2.id = l.to_engram AND e2.state != 'dormant'{kind_filter.replace('kind', 'e2.kind')}
                WHERE l.from_engram < l.to_engram
                  AND l.similarity >= ?""",
            (min_similarity,),
        ).fetchall()

        return {
            "nodes": [{"id": r[0], "title": r[1], "state": r[2], "strength": r[3], "access_count": r[4]} for r in nodes],
            "edges": [{"from": r[0], "to": r[1], "similarity": round(r[2], 3), "link_type": r[3]} for r in edges],
        }

    # --- Entities & Strength ---

    @app.get("/api/entities")
    def list_entities():
        db = _db()
        rows = db.conn.execute(
            "SELECT id, name, entity_type, mention_count FROM entities ORDER BY mention_count DESC"
        ).fetchall()
        return [dict(r) for r in rows]

    @app.get("/api/strength")
    def strength_stats():
        db = _db()
        rows = db.conn.execute(
            "SELECT state, COUNT(*) as count FROM engrams WHERE state != 'dormant' GROUP BY state"
        ).fetchall()
        distribution = {r[0]: r[1] for r in rows}
        avg = db.conn.execute("SELECT AVG(strength) FROM engrams WHERE state != 'dormant'").fetchone()[0]
        return {"distribution": distribution, "average_strength": round(avg or 0, 3)}

    @app.get("/api/backlinks/{engram_id}")
    def get_backlinks(engram_id: str):
        """Backlinks with paragraph context (Obsidian-style).

        For each note that links to this one, find the exact paragraph
        containing the [[wikilink]] reference.
        """
        db = _db()

        # Get the target note's title for paragraph search
        target = db.conn.execute(
            "SELECT title FROM engrams WHERE id = ?", (engram_id,)
        ).fetchone()
        if not target:
            return []
        target_title = target[0]
        target_lower = target_title.lower()

        rows = db.conn.execute(
            """SELECT e.id, e.title, e.content, l.similarity, l.link_type
               FROM engram_links l
               JOIN engrams e ON e.id = l.from_engram
               WHERE l.to_engram = ? AND e.state != 'dormant'
               ORDER BY l.similarity DESC""",
            (engram_id,),
        ).fetchall()

        results = []
        for row in rows:
            source_id, source_title, source_content, similarity, link_type = row

            # Find the paragraph(s) that mention the target note title
            contexts = []
            paragraphs = source_content.split("\n\n")
            for para in paragraphs:
                para_lower = para.lower()
                # Check for wikilink syntax or plain mention
                if (
                    f"[[{target_lower}]]" in para_lower
                    or f"[[{target_lower}|" in para_lower
                    or target_lower in para_lower
                ):
                    cleaned = para.strip().replace("\n", " ")
                    if 10 < len(cleaned) < 500:
                        # Highlight the matched text by surrounding with **
                        contexts.append(cleaned)
                        if len(contexts) >= 2:
                            break

            results.append({
                "engram_id": source_id,
                "title": source_title,
                "similarity": round(similarity, 3),
                "link_type": link_type,
                "contexts": contexts,  # NEW: paragraph snippets
            })

        return results

    @app.get("/api/unlinked-mentions/{engram_id}")
    def unlinked_mentions(engram_id: str):
        """Find notes whose title appears in current note's content
        but isn't yet a [[wikilink]]. Obsidian-style suggestion.
        """
        db = _db()
        target = db.get_engram(engram_id)
        if not target:
            return []

        content_lower = target["content"].lower()

        # Get all other note titles
        all_notes = db.conn.execute(
            """SELECT id, title FROM engrams
               WHERE id != ? AND state != 'dormant'""",
            (engram_id,),
        ).fetchall()

        suggestions = []
        for other_id, other_title in all_notes:
            title_lower = other_title.lower()

            # Skip if already linked
            if f"[[{title_lower}]]" in content_lower:
                continue
            # Skip if title is too short (false positives)
            if len(title_lower) < 4:
                continue

            # Check if the title appears as a phrase
            if title_lower in content_lower:
                # Find the surrounding context
                idx = content_lower.find(title_lower)
                start = max(0, idx - 50)
                end = min(len(target["content"]), idx + len(title_lower) + 50)
                snippet = target["content"][start:end].strip()

                suggestions.append({
                    "engram_id": other_id,
                    "title": other_title,
                    "snippet": f"...{snippet}...",
                })
                if len(suggestions) >= 10:
                    break

        return suggestions

    @app.get("/api/working-memory")
    def working_memory_endpoint():
        """Get current working memory items."""
        from engram_server.consolidation import get_working_memory
        return get_working_memory(_db())

    @app.get("/api/brain-report")
    def brain_report_endpoint():
        """Generate or fetch the GRAPH_REPORT.md."""
        from engram_server.graph_report import generate_graph_report
        ctx = _ctx()
        path = generate_graph_report(ctx.db, ctx.vault_dir)
        return {"content": path.read_text(encoding="utf-8"), "path": str(path)}

    @app.get("/api/path")
    def path_endpoint(start: str, end: str, max_depth: int = 6):
        """Find shortest path between two notes."""
        from engram_server.graph_report import find_path
        return find_path(_db(), start, end, max_depth)

    @app.post("/api/working-memory/pin/{engram_id}")
    def pin_to_wm(engram_id: str):
        """Manually pin a memory to working memory."""
        from engram_server.consolidation import pin_to_working_memory
        ok = pin_to_working_memory(_db(), engram_id)
        return {"status": "pinned" if ok else "failed", "engram_id": engram_id}

    @app.delete("/api/working-memory/{engram_id}")
    def unpin_from_wm(engram_id: str):
        """Remove a memory from working memory."""
        from engram_server.consolidation import unpin_from_working_memory
        ok = unpin_from_working_memory(_db(), engram_id)
        return {"status": "unpinned" if ok else "not_found", "engram_id": engram_id}

    # --- Contradictions ---

    @app.post("/api/contradictions/{contradiction_id}/resolve")
    def resolve_contradiction(contradiction_id: str, body: dict | None = None):
        """Mark a contradiction as resolved."""
        db = _db()
        resolution = (body or {}).get("resolution", "manually_resolved")
        cur = db.conn.execute(
            "UPDATE contradictions SET resolved = 1, resolution = ? WHERE id = ?",
            (resolution, contradiction_id),
        )
        db.conn.commit()
        return {
            "status": "resolved" if cur.rowcount > 0 else "not_found",
            "id": contradiction_id,
        }

    # --- Drafts CRUD ---

    @app.get("/api/drafts")
    def list_drafts_endpoint():
        """List all drafts with progress."""
        from engram_server.drafts import list_drafts
        return list_drafts(_db())

    @app.get("/api/drafts/{draft_id}")
    def get_draft_endpoint(draft_id: str):
        """Get a draft with ordered sections."""
        from engram_server.drafts import get_draft
        result = get_draft(_db(), draft_id)
        return result or {"error": "not found"}

    @app.post("/api/drafts")
    def create_draft_endpoint(body: dict):
        """Create a new draft."""
        from engram_server.drafts import create_draft
        return create_draft(
            _db(),
            title=body.get("title", "Untitled Draft"),
            description=body.get("description", ""),
            target_words=body.get("target_words", 0),
            deadline=body.get("deadline"),
        )

    @app.delete("/api/drafts/{draft_id}")
    def delete_draft_endpoint(draft_id: str):
        """Delete a draft (sections preserved)."""
        from engram_server.drafts import delete_draft
        return delete_draft(_db(), draft_id)

    @app.post("/api/drafts/{draft_id}/sections")
    def add_to_draft_endpoint(draft_id: str, body: dict):
        """Add an engram to a draft at a position."""
        from engram_server.drafts import add_section
        return add_section(
            _db(), draft_id, body["engram_id"], body.get("position")
        )

    @app.delete("/api/drafts/{draft_id}/sections/{engram_id}")
    def remove_from_draft_endpoint(draft_id: str, engram_id: str):
        """Remove an engram from a draft."""
        from engram_server.drafts import remove_section
        return remove_section(_db(), draft_id, engram_id)

    @app.post("/api/drafts/{draft_id}/sections/{engram_id}/move")
    def reorder_section_endpoint(draft_id: str, engram_id: str, body: dict):
        """Move a section to a new position."""
        from engram_server.drafts import reorder_section
        return reorder_section(_db(), draft_id, engram_id, body["position"])

    @app.post("/api/drafts/{draft_id}/export")
    def export_draft_endpoint(draft_id: str, body: dict | None = None):
        """Export a draft via Pandoc."""
        from engram_server.pandoc_export import export_draft
        fmt = (body or {}).get("format", "docx")
        return export_draft(draft_id, fmt, _db())

    @app.get("/api/contradictions")
    def get_contradictions():
        """List unresolved contradictions between memories."""
        db = _db()
        rows = db.conn.execute(
            """SELECT c.id, e1.title, e2.title, c.fact_a, c.fact_b, c.detected_at
               FROM contradictions c
               JOIN engrams e1 ON e1.id = c.engram_a
               JOIN engrams e2 ON e2.id = c.engram_b
               WHERE c.resolved = 0
               ORDER BY c.detected_at DESC"""
        ).fetchall()
        return [
            {"id": r[0], "note_a": r[1], "note_b": r[2],
             "fact_a": r[3], "fact_b": r[4], "detected_at": r[5]}
            for r in rows
        ]

    @app.get("/api/timeline")
    def get_timeline():
        """Temporal fact timeline — what was true when."""
        db = _db()
        rows = db.conn.execute(
            """SELECT tf.fact, tf.valid_from, tf.valid_until, tf.is_current, e.title
               FROM temporal_facts tf
               JOIN engrams e ON e.id = tf.engram_id
               ORDER BY tf.valid_from DESC LIMIT 100"""
        ).fetchall()
        return [
            {"fact": r[0], "valid_from": r[1], "valid_until": r[2],
             "is_current": bool(r[3]), "source": r[4]}
            for r in rows
        ]

    @app.get("/api/memory-types")
    def get_memory_types():
        """Memory type distribution (fact/experience/opinion/procedure)."""
        db = _db()
        rows = db.conn.execute(
            """SELECT mt.memory_type, COUNT(*) as count
               FROM memory_types mt
               JOIN engrams e ON e.id = mt.engram_id
               WHERE e.state != 'dormant'
               GROUP BY mt.memory_type"""
        ).fetchall()
        return {r[0]: r[1] for r in rows}

    @app.post("/api/clip")
    def clip_web(body: dict):
        """Save web content as a vault note."""
        from engram_server.intelligence import clip_to_vault
        ctx = _ctx()
        return clip_to_vault(
            body["url"], body["title"], body["content"],
            ctx.vault_dir, ctx.db, manager.embedder, ctx.bm25,
        )

    @app.post("/api/pdf")
    def ingest_pdf_endpoint(body: dict):
        """Ingest a PDF — extracts text and highlights as Source + Quote notes."""
        from engram_server.pdf_ingest import ingest_pdf
        from pathlib import Path
        ctx = _ctx()
        return ingest_pdf(
            Path(body["pdf_path"]), ctx.vault_dir, ctx.db, manager.embedder, ctx.bm25,
            raw_dir=ctx.raw_dir,
        )

    @app.post("/api/proactive")
    def proactive_context_endpoint(body: dict):
        """Detect topics in a message and fetch relevant memories — no LLM call."""
        from engram_server.proactive import proactive_context
        ctx = _ctx()
        return proactive_context(body["message"], ctx.db, manager.embedder)

    @app.post("/api/capture")
    def quick_capture_endpoint(body: dict):
        """Quick-capture text as a note."""
        from engram_server.dissertation import quick_capture
        ctx = _ctx()
        return quick_capture(
            body["text"], body.get("title"),
            ctx.vault_dir, ctx.db, manager.embedder, ctx.bm25,
        )

    @app.get("/api/tags")
    def get_tags():
        """List all tags with counts."""
        from engram_server.dissertation import list_tags
        return list_tags(_db())

    @app.post("/api/tags/{engram_id}")
    def add_tag_endpoint(engram_id: str, body: dict):
        """Add a tag to a memory."""
        from engram_server.dissertation import add_tag
        success = add_tag(_db(), engram_id, body["tag"])
        return {"status": "added" if success else "failed"}

    @app.get("/api/tags/{tag}/notes")
    def notes_by_tag(tag: str):
        """Find notes with a tag."""
        from engram_server.dissertation import find_by_tag
        return find_by_tag(_db(), tag)

    @app.get("/api/citations")
    def export_citations_endpoint(tag: str | None = None):
        """Export BibTeX citations."""
        from engram_server.dissertation import export_bibtex
        return {"bibtex": export_bibtex(_db(), tag)}

    # --- Code & Variables ---

    @app.get("/api/variables")
    def list_variables_endpoint(
        language: str | None = None,
        kind: str | None = None,
        status: str = "live",
        limit: int = 100,
    ):
        from engram_server.variable_tracker import list_variables
        return list_variables(_db(), language=language, kind=kind, status=status, limit=limit)

    @app.get("/api/variables/renames")
    def renames_endpoint(limit: int = 50):
        from engram_server.variable_tracker import find_renames
        return find_renames(_db(), limit=limit)

    @app.get("/api/variables/stats")
    def variable_stats_endpoint():
        from engram_server.variable_tracker import variable_stats
        return variable_stats(_db())

    @app.get("/api/variables/search")
    def search_variables_endpoint(q: str, limit: int = 20):
        from engram_server.variable_tracker import search_variables
        return search_variables(_db(), q, limit=limit)

    @app.get("/api/variables/{name}")
    def find_variable_endpoint(name: str):
        from engram_server.variable_tracker import find_variable
        return find_variable(_db(), name) or {"found": False, "name": name}

    @app.get("/api/todos")
    def list_todos_endpoint(marker_type: str | None = None, limit: int = 50):
        from engram_server.code_ingest import find_todos
        return find_todos(_db(), marker_type=marker_type, limit=limit)

    @app.post("/api/ingest-repo")
    def ingest_repo_endpoint(body: dict):
        from pathlib import Path
        from engram_server.code_ingest import ingest_repo
        ctx = _ctx()
        repo_path = Path(body["path"]).expanduser().resolve()
        max_files = int(body.get("max_files", 500))
        return ingest_repo(repo_path, ctx.vault_dir, ctx.db, manager.embedder, ctx.bm25, max_files=max_files)

    @app.post("/api/ingest-code")
    def ingest_code_endpoint(body: dict):
        from pathlib import Path
        from engram_server.code_ingest import ingest_code_file
        ctx = _ctx()
        path = Path(body["path"]).expanduser().resolve()
        if not path.exists():
            return {"error": f"File not found: {path}"}
        result = ingest_code_file(path, ctx.vault_dir, ctx.db, manager.embedder, ctx.bm25)
        return result or {"error": "Could not ingest"}

    # --- Call graph ---

    @app.get("/api/calls/callers/{name}")
    def callers_endpoint(name: str, limit: int = 50):
        from engram_server.call_graph import find_callers
        return find_callers(_db(), name, limit=limit)

    @app.get("/api/calls/callees/{name}")
    def callees_endpoint(name: str, limit: int = 100):
        from engram_server.call_graph import find_callees
        return find_callees(_db(), name, limit=limit)

    @app.get("/api/calls/graph/{name}")
    def call_graph_endpoint(name: str, depth: int = 2, direction: str = "callers"):
        from engram_server.call_graph import call_graph_for
        return call_graph_for(_db(), name, depth=depth, direction=direction)

    @app.get("/api/calls/hot")
    def hot_functions_endpoint(limit: int = 20):
        from engram_server.call_graph import hot_functions
        return hot_functions(_db(), limit=limit)

    @app.post("/api/impact-radius")
    def impact_radius_endpoint(body: dict):
        """Blast radius of changes. Body: {"filepaths": [...], "max_depth": 3}"""
        from engram_server.impact import get_impact_radius
        filepaths = body.get("filepaths") or []
        max_depth = int(body.get("max_depth", 3))
        max_affected = int(body.get("max_affected", 200))
        return get_impact_radius(_db(), filepaths, max_depth=max_depth, max_affected=max_affected)

    @app.post("/api/detect-changes")
    def detect_changes_endpoint(body: dict):
        """Risk-scored PR review. Body: {"diff": "..."} or {"filepaths": [...]}"""
        from engram_server.impact import detect_changes
        diff_text = body.get("diff", "") or ""
        filepaths = body.get("filepaths")
        max_depth = int(body.get("max_depth", 3))
        return detect_changes(_db(), diff_text=diff_text, filepaths=filepaths, max_depth=max_depth)

    @app.post("/api/review-context")
    def review_context_endpoint(body: dict):
        """Token-efficient structural review context for a list of files.

        Body: {"filepaths": ["src/auth.py", ...], "total_token_budget": 3000}
        """
        from engram_server.review_context import get_review_context
        filepaths = body.get("filepaths") or []
        budget = int(body.get("total_token_budget", 3000))
        callers = int(body.get("callers_per_symbol", 3))
        callees = int(body.get("callees_per_symbol", 3))
        memories = int(body.get("memories_per_symbol", 2))
        return get_review_context(
            _db(),
            filepaths,
            total_token_budget=budget,
            callers_per_symbol=callers,
            callees_per_symbol=callees,
            memories_per_symbol=memories,
        )

    @app.get("/api/calls/dead")
    def find_dead_code_endpoint(stale_days: int = 60, max_callers: int = 0, limit: int = 50):
        from engram_server.call_graph import find_dead_code
        return find_dead_code(_db(), stale_days=stale_days, max_callers=max_callers, limit=limit)

    @app.get("/api/calls/stale-renames")
    def find_renamed_callsites_endpoint(limit: int = 50):
        from engram_server.call_graph import find_renamed_callsites
        return find_renamed_callsites(_db(), limit=limit)

    @app.get("/api/sessions/{session_id}/replay")
    def replay_session_endpoint(session_id: str, max_events: int = 200):
        from engram_server.hooks import replay_session
        return replay_session(_ctx(), session_id, max_events=max_events)

    # --- Hooks: auto-capture observations from Claude Code lifecycle ---

    @app.post("/api/observations")
    def capture_observation_endpoint(body: dict):
        """Receive a Claude Code hook payload and persist it as an observation.

        Body shape: {"event": "PostToolUse", "payload": {...}}
        """
        from engram_server.hooks import capture_observation
        ctx = _ctx()
        event = body.get("event") or body.get("hook_event_name") or "Unknown"
        payload = body.get("payload") or body
        result = capture_observation(ctx, manager.embedder, event, payload)
        return result or {"status": "skipped", "event": event}

    @app.post("/api/insights/extract")
    def extract_insights_endpoint(body: dict):
        """Extract factual claims from a block of text.

        Body: {"text": "...", "save": true|false}

        When save=true, promotes each extracted insight to a first-class
        memory engram. When save=false (default), just returns the
        extractions for preview. Useful for piping email/doc/meeting
        notes through the same extractor the hooks use on UserPromptSubmit.
        """
        from engram_server.insight_extractor import (
            extract_insights,
            promote_insights_from_text,
        )
        text = (body.get("text") or "").strip()
        if not text:
            return {"error": "text is required"}
        ctx = _ctx()
        if body.get("save"):
            created = promote_insights_from_text(ctx, text)
            return {"mode": "save", "insights": created, "count": len(created)}
        insights = extract_insights(text)
        return {
            "mode": "preview",
            "insights": [
                {
                    "title": i.title,
                    "fact": i.fact,
                    "pattern": i.pattern_name,
                    "confidence": i.confidence,
                    "negated": i.negated,
                }
                for i in insights
            ],
            "count": len(insights),
        }

    @app.post("/api/observations/rollup")
    def rollup_session_endpoint(body: dict):
        """Compress one session's observations into a summary engram.
        Body: {"session_id": "<short or full id>"}
        """
        from engram_server.observation_rollup import rollup_session
        ctx = _ctx()
        session = (body.get("session_id") or "").strip()
        if not session:
            return {"error": "session_id is required"}
        short = session[:8] if len(session) > 8 else session
        return rollup_session(ctx, short)

    @app.post("/api/observations/rollup-stale")
    def rollup_stale_endpoint(body: dict):
        """Run the bulk rollup-stale pass. Body: {"older_than_hours": 24, "min_events": 3}"""
        from engram_server.observation_rollup import rollup_stale_sessions
        ctx = _ctx()
        return rollup_stale_sessions(
            ctx,
            older_than_hours=int(body.get("older_than_hours", 24)),
            min_events=int(body.get("min_events", 3)),
            max_sessions=int(body.get("max_sessions", 10)),
        )

    @app.get("/api/observations/stats")
    def observation_stats_endpoint():
        """Observability for observation / session-summary / archive counts."""
        from engram_server.observation_rollup import get_rollup_stats
        return get_rollup_stats(_ctx())

    @app.get("/api/observations")
    def list_observation_sessions_endpoint(limit: int = 25):
        """List recent Claude Code sessions with per-session counts.

        Parses the `obs-{session}-*.md` filename convention to group
        observations by session. Frontend uses this to show a 'recent
        sessions' list with replay buttons.
        """
        db = _db()
        rows = db.conn.execute(
            """SELECT filename, title, created_at
               FROM engrams
               WHERE filename LIKE 'obs-%' AND state != 'dormant'
               ORDER BY created_at DESC
               LIMIT ?""",
            (limit * 20,),
        ).fetchall()
        sessions: dict[str, dict] = {}
        for filename, title, created_at in rows:
            # obs-{short_session}-{event}-{shortid}.md
            parts = filename.split("-", 3)
            if len(parts) < 3:
                continue
            sid = parts[1]
            s = sessions.setdefault(sid, {
                "session_id": sid,
                "event_count": 0,
                "first_seen": created_at,
                "last_seen": created_at,
                "latest_title": title,
            })
            s["event_count"] += 1
            if created_at < s["first_seen"]:
                s["first_seen"] = created_at
            if created_at > s["last_seen"]:
                s["last_seen"] = created_at
                s["latest_title"] = title
        ordered = sorted(sessions.values(), key=lambda s: s["last_seen"], reverse=True)
        return ordered[:limit]

    @app.get("/api/observations/{session_id}")
    def list_session_observations_endpoint(session_id: str, limit: int = 50):
        """Return all observation engrams for a given Claude Code session."""
        from engram_server.hooks import list_session_observations
        return list_session_observations(_ctx(), session_id, limit=limit)

    @app.get("/api/feedback/stats")
    def feedback_stats_endpoint():
        """Observability for the self-improving retrieval feedback loop."""
        from engram_server.retrieval_feedback import get_feedback_stats
        return get_feedback_stats(_db())

    @app.post("/api/feedback/update")
    def feedback_update_endpoint():
        """Manually trigger a feedback update pass (normally runs in consolidation)."""
        from engram_server.retrieval_feedback import apply_feedback_update
        return apply_feedback_update(_db())

    @app.get("/api/affinity/stats")
    def affinity_stats_endpoint():
        """Observability for learned query→engram shortcuts (Stage 4)."""
        from engram_server.query_affinity import get_affinity_stats
        return get_affinity_stats(_db())

    @app.post("/api/affinity/reconcile")
    def affinity_reconcile_endpoint():
        """Manually trigger the query-affinity reconcile pass."""
        from engram_server.query_affinity import reconcile_feedback
        ctx = _ctx()
        return reconcile_feedback(ctx.db, manager.embedder, ctx.bm25)

    @app.get("/api/recall")
    def recall_endpoint(
        q: str,
        limit: int = 10,
        mode: str = "preview",
        as_of: str | None = None,
    ):
        """Hybrid retrieval over the active brain. Pass as_of (ISO) for time travel."""
        from engram_server.retriever import hybrid_retrieve
        ctx = _ctx()
        results = hybrid_retrieve(
            q, ctx.db, manager.embedder, ctx.bm25, top_k=limit, as_of=as_of
        )
        if mode == "titles":
            return [
                {"engram_id": r["engram_id"], "title": r["title"], "score": r["score"]}
                for r in results
            ]
        if mode == "full":
            return results
        return [
            {
                "engram_id": r["engram_id"],
                "title": r["title"],
                "preview": (r["content"] or "")[:200],
                "score": r["score"],
            }
            for r in results
        ]

    @app.get("/api/session-context")
    def session_ctx():
        from engram_server.write_back import build_session_context
        return build_session_context(_db())

    return app


def start_api_server(manager, port: int = SERVER_PORT) -> threading.Thread:
    """Start the HTTP API server in a background thread."""
    app = create_api(manager)

    def run():
        uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")

    thread = threading.Thread(target=run, daemon=True, name="engram-api")
    thread.start()
    logger.info("HTTP API server started on http://127.0.0.1:{}", port)
    return thread
