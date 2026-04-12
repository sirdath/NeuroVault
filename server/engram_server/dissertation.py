"""Dissertation-specific features.

- Quick capture: paste arbitrary text, auto-extract a clean note
- Tag management: organize notes by topic/category
- Citation export: BibTeX format from notes with metadata
- Reading list tracking: mark papers as read/unread/important
"""

import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from loguru import logger

from engram_server.database import Database
from engram_server.embeddings import Embedder


def quick_capture(
    text: str,
    title: str | None,
    vault_dir: Path,
    db: Database,
    embedder: Embedder,
    bm25,
) -> dict:
    """Quick-capture: paste any text and create a clean note.

    Auto-detects title from first line if not provided.
    Strips junk whitespace, removes empty lines.
    """
    from engram_server.ingest import ingest_file

    cleaned = _clean_text(text)

    if not title:
        # Extract title from first non-empty line
        first_line = next((line for line in cleaned.split('\n') if line.strip()), "Captured Note")
        title = first_line.strip().lstrip('#').strip()[:80]

    slug = re.sub(r'[^a-z0-9]+', '-', title.lower())[:50].strip('-')
    short_id = uuid.uuid4().hex[:6]
    filename = f"{slug}-{short_id}.md"

    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
    md = f"# {title}\n\n*Captured {now}*\n\n{cleaned}"

    filepath = vault_dir / filename
    filepath.write_text(md, encoding='utf-8')

    engram_id = ingest_file(filepath, db, embedder, bm25)
    logger.info("Quick-captured: {} ({})", title, filename)
    return {"engram_id": engram_id, "filename": filename, "title": title}


def _clean_text(text: str) -> str:
    """Clean pasted text: normalize whitespace, fix line breaks."""
    # Collapse multiple blank lines to one
    text = re.sub(r'\n{3,}', '\n\n', text)
    # Strip excessive whitespace
    lines = [line.rstrip() for line in text.split('\n')]
    return '\n'.join(lines).strip()


# ============================================================
# TAGS
# ============================================================

def add_tag(db: Database, engram_id: str, tag: str) -> bool:
    """Add a tag to an engram."""
    tag = tag.lower().strip().lstrip('#')
    if not tag:
        return False

    # Get current tags (stored as JSON in tags column)
    import json
    row = db.conn.execute("SELECT tags FROM engrams WHERE id = ?", (engram_id,)).fetchone()
    if not row:
        return False

    current = json.loads(row[0]) if row[0] else []
    if tag in current:
        return True
    current.append(tag)

    db.conn.execute("UPDATE engrams SET tags = ? WHERE id = ?",
                     (json.dumps(current), engram_id))
    db.conn.commit()
    return True


def remove_tag(db: Database, engram_id: str, tag: str) -> bool:
    """Remove a tag from an engram."""
    import json
    tag = tag.lower().strip().lstrip('#')
    row = db.conn.execute("SELECT tags FROM engrams WHERE id = ?", (engram_id,)).fetchone()
    if not row:
        return False

    current = json.loads(row[0]) if row[0] else []
    if tag not in current:
        return False
    current.remove(tag)

    db.conn.execute("UPDATE engrams SET tags = ? WHERE id = ?",
                     (json.dumps(current), engram_id))
    db.conn.commit()
    return True


def list_tags(db: Database) -> list[dict]:
    """List all tags with usage counts."""
    import json
    rows = db.conn.execute(
        "SELECT tags FROM engrams WHERE state != 'dormant' AND tags IS NOT NULL"
    ).fetchall()

    counts: dict[str, int] = {}
    for (tags_json,) in rows:
        if not tags_json:
            continue
        try:
            tags = json.loads(tags_json)
            for t in tags:
                counts[t] = counts.get(t, 0) + 1
        except (json.JSONDecodeError, TypeError):
            continue

    return [{"tag": t, "count": c} for t, c in sorted(counts.items(), key=lambda x: -x[1])]


def find_by_tag(db: Database, tag: str) -> list[dict]:
    """Find all engrams with a specific tag."""
    tag = tag.lower().strip().lstrip('#')
    rows = db.conn.execute(
        """SELECT id, title, content, strength, state, updated_at
           FROM engrams
           WHERE state != 'dormant' AND tags LIKE ?""",
        (f'%"{tag}"%',),
    ).fetchall()

    return [
        {
            "engram_id": r[0],
            "title": r[1],
            "preview": r[2][:200],
            "strength": r[3],
            "state": r[4],
            "updated_at": r[5],
        }
        for r in rows
    ]


# ============================================================
# CITATION EXPORT
# ============================================================

def export_bibtex(db: Database, tag: str | None = None) -> str:
    """Export notes as BibTeX entries.

    Looks for citation metadata in markdown:
    - **Author:** Smith et al.
    - **Year:** 2024
    - **Title:** ...
    - **Journal:** ...
    - **DOI:** ...
    """
    if tag:
        engrams = find_by_tag(db, tag)
        engram_ids = [e["engram_id"] for e in engrams]
    else:
        rows = db.conn.execute(
            "SELECT id FROM engrams WHERE state != 'dormant'"
        ).fetchall()
        engram_ids = [r[0] for r in rows]

    entries = []
    for eid in engram_ids:
        engram = db.get_engram(eid)
        if not engram:
            continue
        entry = _build_bibtex(engram)
        if entry:
            entries.append(entry)

    if not entries:
        return "% No citations found. Add **Author:** / **Year:** metadata to notes.\n"

    return "\n\n".join(entries)


def _build_bibtex(engram: dict) -> str | None:
    """Extract citation fields from a note and build a BibTeX entry."""
    content = engram["content"]
    title = engram["title"]

    # Extract metadata fields
    fields = {}
    for field_name in ["author", "year", "journal", "doi", "publisher", "url", "pages", "volume"]:
        # Match patterns like **Author:** Smith or - Author: Smith
        pattern = rf'(?:\*\*|\-\s*){field_name}\s*:?\*?\*?\s*(.+?)(?:\n|$)'
        match = re.search(pattern, content, re.IGNORECASE)
        if match:
            fields[field_name] = match.group(1).strip().strip('*').strip()

    # Need at least author + year to make a useful entry
    if "author" not in fields or "year" not in fields:
        return None

    # Generate citation key: firstauthor + year + first word of title
    author_last = fields["author"].split()[0].split(',')[0]
    title_first = re.sub(r'[^a-zA-Z]', '', title.split()[0]) if title else "note"
    key = f"{author_last}{fields['year']}{title_first}".lower()

    lines = [f"@article{{{key},"]
    lines.append(f'  title = {{{title}}},')
    for field, value in fields.items():
        lines.append(f'  {field} = {{{value}}},')
    lines.append("}")
    return '\n'.join(lines)


# ============================================================
# READING LIST
# ============================================================

def mark_read(db: Database, engram_id: str, status: str = "read") -> bool:
    """Mark a paper as read/unread/important via tags."""
    valid = {"read", "unread", "important", "to-read"}
    if status not in valid:
        return False

    # Remove other read-status tags
    for s in valid:
        if s != status:
            remove_tag(db, engram_id, s)

    return add_tag(db, engram_id, status)


def get_reading_list(db: Database, status: str = "to-read") -> list[dict]:
    """Get all papers with a given reading status."""
    return find_by_tag(db, status)
