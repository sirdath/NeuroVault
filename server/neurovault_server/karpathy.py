"""Karpathy LLM Wiki pattern — auto-maintained index.md, log.md, CLAUDE.md.

Inspired by Andrej Karpathy's LLM Wiki gist:
https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f

Adds three auto-maintained files to every brain's vault:
- index.md:  one-line summary of every note, grep-friendly
- log.md:    append-only activity stream (ingest/query/consolidate/etc)
- CLAUDE.md: per-brain schema config (conventions, rules, tags)

These are NOT ingested into the semantic index themselves — they're
metadata files Claude reads directly to understand the brain's state
and conventions.
"""

import json
from datetime import datetime, timezone
from pathlib import Path

from loguru import logger

from neurovault_server.database import Database


DEFAULT_CLAUDE_MD = """# Brain: {name}

*Schema config for this memory space. Co-evolve this over time.*

## Naming conventions

- Notes: `{{topic}}-{{short_id}}.md`
- Sources (papers): `source-{{citekey}}.md`
- Quotes (highlights): `quote-{{source}}-{{n}}.md`
- Themes (auto-generated): `theme-{{name}}-{{id}}.md`

## Tag taxonomy

Use consistent tags in frontmatter:
- `#important` — must-remember
- `#to-read` — queued reading
- `#methodology` — research methods
- `#background` — context material

## Rules for Claude

1. When ingesting a new source, update `index.md` with a one-line summary.
2. When detecting a contradiction, add it to the Contradictions section below.
3. Always check `index.md` before asking the user for context.
4. Prefer `recall(mode='preview')` unless you need deep content.
5. After meaningful exchanges, call `save_conversation_insights(...)`.

## Workflows

### Ingest a paper
1. Read raw PDF
2. Extract key facts, highlights, citations
3. Create Source + Quote notes
4. Update index.md and log.md

### Answer a question
1. Check working_memory() first
2. Call recall(query, mode='preview')
3. If multi-faceted, use explore(topic, depth=2)
4. Synthesize answer with citations

### Weekly lint
- Check for contradictions
- Identify orphan notes (no backlinks, no connections)
- Archive stale drafts
- Consolidate similar themes

## Contradictions to resolve

*Auto-populated by the contradiction detection system.*

## Notes

*Your per-brain preferences and observations go here.*
"""


def rebuild_index(db: Database, vault_dir: Path) -> Path:
    """Regenerate index.md — one-line summary of every note, grep-friendly.

    Organized by memory type/state. This is Karpathy's core insight:
    a single flat catalog the LLM can read in one pass.
    """
    index_path = vault_dir / "index.md"

    # Fetch all non-dormant engrams, grouped by state and sorted by strength
    rows = db.conn.execute(
        """SELECT e.id, e.title, e.content, e.state, e.strength, e.access_count,
                  COALESCE(mt.memory_type, 'fact') as memory_type
           FROM engrams e
           LEFT JOIN memory_types mt ON mt.engram_id = e.id
           WHERE e.state != 'dormant'
           ORDER BY
             CASE e.state
               WHEN 'active' THEN 1
               WHEN 'fresh' THEN 2
               WHEN 'connected' THEN 3
               ELSE 4
             END,
             e.strength DESC"""
    ).fetchall()

    if not rows:
        index_path.write_text(
            "# Wiki Index\n\n*No notes yet. Start capturing memories.*\n",
            encoding="utf-8",
        )
        return index_path

    # Group by memory type for the catalog
    by_type: dict[str, list[tuple]] = {}
    for row in rows:
        mt = row[6] or "fact"
        by_type.setdefault(mt, []).append(row)

    total = db.conn.execute("SELECT COUNT(*) FROM engrams WHERE state != 'dormant'").fetchone()[0]
    connections = db.conn.execute("SELECT COUNT(*) FROM engram_links").fetchone()[0]
    updated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    lines = [
        "# Wiki Index",
        "",
        f"*Auto-maintained catalog of this brain's memories.*",
        f"*{total} memories · {connections} connections · updated {updated}*",
        "",
    ]

    # Type order from most common
    type_order = ["fact", "procedure", "experience", "opinion"]
    type_titles = {
        "fact": "Facts",
        "procedure": "Procedures",
        "experience": "Experiences",
        "opinion": "Opinions",
    }

    for mtype in type_order:
        if mtype not in by_type:
            continue
        items = by_type[mtype]
        lines.append(f"## {type_titles[mtype]} ({len(items)})")
        lines.append("")

        for eid, title, content, state, strength, access_count, _ in items:
            # Extract first meaningful sentence as one-liner
            summary = _extract_summary(content)
            strength_pct = int(strength * 100)
            state_marker = {
                "active": "●",
                "fresh": "○",
                "connected": "◆",
                "dormant": "·",
            }.get(state, "·")

            lines.append(
                f"- {state_marker} [[{title}]] *{strength_pct}%* — {summary}"
            )

        lines.append("")

    # Any remaining types
    for mtype, items in by_type.items():
        if mtype in type_order:
            continue
        lines.append(f"## {mtype.title()} ({len(items)})")
        lines.append("")
        for eid, title, content, state, strength, _, _ in items:
            summary = _extract_summary(content)
            lines.append(f"- [[{title}]] — {summary}")
        lines.append("")

    index_path.write_text("\n".join(lines), encoding="utf-8")
    logger.info("Rebuilt index.md with {} entries", total)
    return index_path


def _extract_summary(content: str) -> str:
    """Extract a one-line summary from note content."""
    # Skip the title line and frontmatter
    lines = content.split("\n")
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("#"):
            continue
        if stripped.startswith("*") and stripped.endswith("*"):
            continue
        if stripped.startswith("**") and ":" in stripped:  # **Author:** metadata
            continue
        if stripped.startswith("---"):
            continue
        # First real content line — truncate to 120 chars
        return stripped[:120].rstrip()
    return "(no summary)"


def append_log(vault_dir: Path, event_type: str, description: str) -> None:
    """Append an event to log.md (Karpathy-style activity stream).

    Format: ## [YYYY-MM-DD HH:MM] event_type | description

    Event types: ingest, query, consolidate, contradiction, pin, delete, edit
    """
    log_path = vault_dir / "log.md"
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
    entry = f"## [{timestamp}] {event_type} | {description}\n\n"

    if not log_path.exists():
        header = (
            "# Activity Log\n\n"
            "*Append-only chronological record of this brain's events.*\n"
            "*Grep me for past activity: `grep -i 'ingest' log.md`*\n\n"
        )
        log_path.write_text(header + entry, encoding="utf-8")
    else:
        with log_path.open("a", encoding="utf-8") as f:
            f.write(entry)


def ensure_schema(vault_dir: Path, brain_name: str) -> Path:
    """Create CLAUDE.md if it doesn't exist. Never overwrite user edits."""
    schema_path = vault_dir / "CLAUDE.md"
    if not schema_path.exists():
        schema_path.write_text(
            DEFAULT_CLAUDE_MD.format(name=brain_name),
            encoding="utf-8",
        )
        logger.info("Created default CLAUDE.md for brain: {}", brain_name)
    return schema_path


def get_schema(vault_dir: Path) -> str:
    """Read the current CLAUDE.md schema."""
    schema_path = vault_dir / "CLAUDE.md"
    if not schema_path.exists():
        return "No schema defined yet. Use `update_schema` to create one."
    return schema_path.read_text(encoding="utf-8")


def update_schema(vault_dir: Path, content: str) -> Path:
    """Overwrite CLAUDE.md with new content. User controls this file."""
    schema_path = vault_dir / "CLAUDE.md"
    schema_path.write_text(content, encoding="utf-8")
    logger.info("Updated CLAUDE.md schema")
    return schema_path


def get_index(vault_dir: Path) -> str:
    """Read the current index.md."""
    index_path = vault_dir / "index.md"
    if not index_path.exists():
        return "# Wiki Index\n\n*Not yet generated. Run rebuild_index().*\n"
    return index_path.read_text(encoding="utf-8")


def get_log(vault_dir: Path, tail: int = 50) -> str:
    """Read the last N entries from log.md."""
    log_path = vault_dir / "log.md"
    if not log_path.exists():
        return "# Activity Log\n\n*No activity yet.*\n"

    content = log_path.read_text(encoding="utf-8")
    # Split on "## [" markers, keep last N
    parts = content.split("\n## [")
    if len(parts) <= tail + 1:
        return content

    header = parts[0]
    recent = parts[-tail:]
    return header + "\n## [" + "\n## [".join(recent)
