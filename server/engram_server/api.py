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
    def get_graph():
        db = _db()
        nodes = db.conn.execute(
            "SELECT id, title, state, strength, access_count FROM engrams WHERE state != 'dormant'"
        ).fetchall()

        edges = db.conn.execute(
            """SELECT l.from_engram, l.to_engram, l.similarity, l.link_type
               FROM engram_links l
               JOIN engrams e1 ON e1.id = l.from_engram AND e1.state != 'dormant'
               JOIN engrams e2 ON e2.id = l.to_engram AND e2.state != 'dormant'
               WHERE l.from_engram < l.to_engram"""
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
