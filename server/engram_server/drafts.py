"""Drafts — ordered collections of engrams for long-form writing.

Replaces Scrivener/Longform for dissertation chapter management.
A Draft is: title + description + target_words + deadline + ordered sections.
Each section is a child engram (Note) with a position.

You write in the editor as normal, but assemble chapters from those notes.
Reorder freely. Export to DOCX/PDF via pandoc. Word counts per section + total.
"""

import uuid
from datetime import datetime, timezone
from pathlib import Path

from loguru import logger

from engram_server.database import Database


def create_draft(
    db: Database,
    title: str,
    description: str = "",
    target_words: int = 0,
    deadline: str | None = None,
) -> dict:
    """Create a new draft (empty collection)."""
    draft_id = str(uuid.uuid4())
    db.conn.execute(
        """INSERT INTO drafts (id, title, description, target_words, deadline)
           VALUES (?, ?, ?, ?, ?)""",
        (draft_id, title, description, target_words, deadline),
    )
    db.conn.commit()
    logger.info("Created draft: {} ({})", title, draft_id[:8])
    return {"draft_id": draft_id, "title": title, "sections": 0}


def list_drafts(db: Database) -> list[dict]:
    """List all drafts with section counts and word progress."""
    rows = db.conn.execute(
        """SELECT d.id, d.title, d.description, d.target_words, d.deadline,
                  d.created_at, d.updated_at,
                  (SELECT COUNT(*) FROM draft_sections WHERE draft_id = d.id) as section_count
           FROM drafts d
           ORDER BY d.updated_at DESC"""
    ).fetchall()

    result = []
    for r in rows:
        draft_id = r[0]
        # Compute total word count
        words = db.conn.execute(
            """SELECT e.content FROM draft_sections ds
               JOIN engrams e ON e.id = ds.engram_id
               WHERE ds.draft_id = ? AND e.state != 'dormant'""",
            (draft_id,),
        ).fetchall()
        word_count = sum(len(w[0].split()) for w in words)

        result.append({
            "draft_id": r[0],
            "title": r[1],
            "description": r[2],
            "target_words": r[3],
            "deadline": r[4],
            "created_at": r[5],
            "updated_at": r[6],
            "section_count": r[7],
            "word_count": word_count,
            "progress": (
                round(word_count / r[3], 3) if r[3] else None
            ),
        })
    return result


def get_draft(db: Database, draft_id: str) -> dict | None:
    """Get a draft with its ordered sections."""
    draft = db.conn.execute(
        "SELECT id, title, description, target_words, deadline FROM drafts WHERE id = ?",
        (draft_id,),
    ).fetchone()
    if not draft:
        return None

    sections = db.conn.execute(
        """SELECT e.id, e.title, e.content, ds.position
           FROM draft_sections ds
           JOIN engrams e ON e.id = ds.engram_id
           WHERE ds.draft_id = ? AND e.state != 'dormant'
           ORDER BY ds.position ASC""",
        (draft_id,),
    ).fetchall()

    section_list = []
    total_words = 0
    for s in sections:
        words = len(s[2].split())
        total_words += words
        section_list.append({
            "engram_id": s[0],
            "title": s[1],
            "position": s[3],
            "word_count": words,
            "preview": s[2][:200],
        })

    return {
        "draft_id": draft[0],
        "title": draft[1],
        "description": draft[2],
        "target_words": draft[3],
        "deadline": draft[4],
        "word_count": total_words,
        "progress": round(total_words / draft[3], 3) if draft[3] else None,
        "sections": section_list,
    }


def add_section(db: Database, draft_id: str, engram_id: str, position: int | None = None) -> dict:
    """Add an engram to a draft at a specific position (or end if None)."""
    # Verify draft exists
    draft = db.conn.execute("SELECT id FROM drafts WHERE id = ?", (draft_id,)).fetchone()
    if not draft:
        return {"error": f"Draft not found: {draft_id}"}

    # Verify engram exists
    engram = db.get_engram(engram_id)
    if not engram:
        return {"error": f"Engram not found: {engram_id}"}

    # Check if already added
    existing = db.conn.execute(
        "SELECT 1 FROM draft_sections WHERE draft_id = ? AND engram_id = ?",
        (draft_id, engram_id),
    ).fetchone()
    if existing:
        return {"error": "Section already in this draft"}

    # Default: append at end
    if position is None:
        max_pos = db.conn.execute(
            "SELECT COALESCE(MAX(position), -1) FROM draft_sections WHERE draft_id = ?",
            (draft_id,),
        ).fetchone()[0]
        position = max_pos + 1
    else:
        # Shift existing sections at/after position
        db.conn.execute(
            "UPDATE draft_sections SET position = position + 1 WHERE draft_id = ? AND position >= ?",
            (draft_id, position),
        )

    db.conn.execute(
        """INSERT INTO draft_sections (draft_id, engram_id, position)
           VALUES (?, ?, ?)""",
        (draft_id, engram_id, position),
    )
    db.conn.execute(
        "UPDATE drafts SET updated_at = datetime('now') WHERE id = ?", (draft_id,)
    )
    db.conn.commit()

    return {"status": "added", "draft_id": draft_id, "engram_id": engram_id, "position": position}


def remove_section(db: Database, draft_id: str, engram_id: str) -> dict:
    """Remove an engram from a draft."""
    row = db.conn.execute(
        "SELECT position FROM draft_sections WHERE draft_id = ? AND engram_id = ?",
        (draft_id, engram_id),
    ).fetchone()
    if not row:
        return {"error": "Section not in draft"}

    position = row[0]
    db.conn.execute(
        "DELETE FROM draft_sections WHERE draft_id = ? AND engram_id = ?",
        (draft_id, engram_id),
    )
    # Shift down subsequent sections
    db.conn.execute(
        "UPDATE draft_sections SET position = position - 1 WHERE draft_id = ? AND position > ?",
        (draft_id, position),
    )
    db.conn.execute("UPDATE drafts SET updated_at = datetime('now') WHERE id = ?", (draft_id,))
    db.conn.commit()

    return {"status": "removed"}


def reorder_section(db: Database, draft_id: str, engram_id: str, new_position: int) -> dict:
    """Move a section to a new position (0-indexed)."""
    row = db.conn.execute(
        "SELECT position FROM draft_sections WHERE draft_id = ? AND engram_id = ?",
        (draft_id, engram_id),
    ).fetchone()
    if not row:
        return {"error": "Section not in draft"}

    old_position = row[0]
    if old_position == new_position:
        return {"status": "unchanged"}

    if new_position > old_position:
        db.conn.execute(
            """UPDATE draft_sections SET position = position - 1
               WHERE draft_id = ? AND position > ? AND position <= ?""",
            (draft_id, old_position, new_position),
        )
    else:
        db.conn.execute(
            """UPDATE draft_sections SET position = position + 1
               WHERE draft_id = ? AND position >= ? AND position < ?""",
            (draft_id, new_position, old_position),
        )

    db.conn.execute(
        "UPDATE draft_sections SET position = ? WHERE draft_id = ? AND engram_id = ?",
        (new_position, draft_id, engram_id),
    )
    db.conn.execute("UPDATE drafts SET updated_at = datetime('now') WHERE id = ?", (draft_id,))
    db.conn.commit()

    return {"status": "moved", "new_position": new_position}


def delete_draft(db: Database, draft_id: str) -> dict:
    """Delete a draft. Sections (engrams) are preserved."""
    cur = db.conn.execute("DELETE FROM drafts WHERE id = ?", (draft_id,))
    db.conn.commit()
    if cur.rowcount > 0:
        return {"status": "deleted"}
    return {"error": "Draft not found"}


def stitched_content(db: Database, draft_id: str) -> str:
    """Return the full stitched content of a draft as one markdown document."""
    draft = get_draft(db, draft_id)
    if not draft:
        return ""

    lines = [f"# {draft['title']}\n"]
    if draft["description"]:
        lines.append(draft["description"] + "\n")

    for section in draft["sections"]:
        engram = db.get_engram(section["engram_id"])
        if engram:
            lines.append(engram["content"])
            lines.append("")

    return "\n".join(lines)
