"""Agent-editable core memory blocks — Letta/MemGPT pattern.

Short, structured chunks that always load on session_start(). The agent
itself maintains them via core_memory_append / core_memory_replace /
core_memory_set. Distinct from engrams (long-form notes) and from
working_memory (pinned engrams): these are raw text blobs the agent
curates as its working identity.

Default labels seeded on first use:
  persona  — who the agent is operating as in this brain
  project  — the active project's context
  user     — stable facts about the human working with the agent

Char limit is enforced on every write so the context stays predictable
— blocks can't grow unbounded and balloon session_start payloads.
"""

from __future__ import annotations

from loguru import logger

from neurovault_server.database import Database


DEFAULT_BLOCKS = [
    ("persona", "Assistant for this brain. The agent edits this block to describe the role it's operating in.", 2000),
    ("project", "Active project context. The agent edits this block to track what we're currently working on.", 2000),
    ("user", "Stable facts about the human using this brain — preferences, tools, constraints that rarely change.", 1500),
]


def ensure_defaults(db: Database) -> None:
    """Seed the three default blocks if they don't exist. Idempotent —
    safe to call on every server boot.
    """
    for label, description, char_limit in DEFAULT_BLOCKS:
        db.conn.execute(
            """INSERT OR IGNORE INTO core_memory_blocks
                 (label, value, description, char_limit)
               VALUES (?, '', ?, ?)""",
            (label, description, char_limit),
        )
    db.conn.commit()


def list_blocks(db: Database) -> list[dict]:
    """Return every block sorted by label."""
    rows = db.conn.execute(
        """SELECT label, value, description, char_limit, updated_at
           FROM core_memory_blocks
           ORDER BY label"""
    ).fetchall()
    return [
        {
            "label": r[0],
            "value": r[1] or "",
            "description": r[2] or "",
            "char_limit": int(r[3]),
            "updated_at": r[4],
            "length": len(r[1] or ""),
        }
        for r in rows
    ]


def read_block(db: Database, label: str) -> dict | None:
    row = db.conn.execute(
        """SELECT label, value, description, char_limit, updated_at
           FROM core_memory_blocks WHERE label = ?""",
        (label,),
    ).fetchone()
    if not row:
        return None
    return {
        "label": row[0],
        "value": row[1] or "",
        "description": row[2] or "",
        "char_limit": int(row[3]),
        "updated_at": row[4],
        "length": len(row[1] or ""),
    }


def _ensure_block(db: Database, label: str) -> dict:
    """Fetch the block, creating it with a 2000-char default limit if
    missing. Agents can mint new labels on demand without a separate
    schema change.
    """
    block = read_block(db, label)
    if block:
        return block
    db.conn.execute(
        """INSERT INTO core_memory_blocks (label, value, description, char_limit)
           VALUES (?, '', '', 2000)""",
        (label,),
    )
    db.conn.commit()
    return read_block(db, label)  # type: ignore[return-value]


def set_block(db: Database, label: str, value: str) -> dict:
    """Overwrite a block's value entirely. Enforces char_limit by
    truncating to the last whole word under the cap. Returns the
    updated block.
    """
    block = _ensure_block(db, label)
    truncated, was_truncated = _fit(value, block["char_limit"])
    db.conn.execute(
        """UPDATE core_memory_blocks
           SET value = ?, updated_at = datetime('now')
           WHERE label = ?""",
        (truncated, label),
    )
    db.conn.commit()
    if was_truncated:
        logger.debug("core_memory set({}) truncated from {} to {} chars",
                     label, len(value), len(truncated))
    return read_block(db, label)  # type: ignore[return-value]


def append_block(db: Database, label: str, text: str, separator: str = "\n") -> dict:
    """Append `text` to the block's value (newline-separated by default).
    If adding would blow the char_limit, drops the oldest leading chunk
    one-separator at a time until it fits, so the append always lands.
    """
    block = _ensure_block(db, label)
    existing = block["value"]
    combined = f"{existing}{separator}{text}" if existing else text
    truncated, _ = _fit(combined, block["char_limit"], strategy="drop_head", sep=separator)
    db.conn.execute(
        """UPDATE core_memory_blocks
           SET value = ?, updated_at = datetime('now')
           WHERE label = ?""",
        (truncated, label),
    )
    db.conn.commit()
    return read_block(db, label)  # type: ignore[return-value]


def replace_block(db: Database, label: str, old: str, new: str) -> dict | None:
    """Find-and-replace within a block. Returns the updated block on a
    hit, None when `old` wasn't found — lets the caller decide whether
    to fall back to append/set.
    """
    block = read_block(db, label)
    if not block:
        return None
    if old not in block["value"]:
        return None
    new_value = block["value"].replace(old, new, 1)
    truncated, _ = _fit(new_value, block["char_limit"])
    db.conn.execute(
        """UPDATE core_memory_blocks
           SET value = ?, updated_at = datetime('now')
           WHERE label = ?""",
        (truncated, label),
    )
    db.conn.commit()
    return read_block(db, label)


def delete_block(db: Database, label: str) -> bool:
    """Remove a custom block. Default blocks (persona / project / user)
    are kept — delete clears their value instead so session_start still
    surfaces the schema."""
    reserved = {b[0] for b in DEFAULT_BLOCKS}
    if label in reserved:
        db.conn.execute(
            "UPDATE core_memory_blocks SET value = '', updated_at = datetime('now') WHERE label = ?",
            (label,),
        )
        db.conn.commit()
        return True
    cur = db.conn.execute("DELETE FROM core_memory_blocks WHERE label = ?", (label,))
    db.conn.commit()
    return cur.rowcount > 0


# ---------------------------------------------------------------------------

def _fit(text: str, limit: int, strategy: str = "tail_truncate", sep: str = "\n") -> tuple[str, bool]:
    """Trim `text` to `limit` characters.

    Strategies:
      - "tail_truncate" (default) — cut from the end at the last
        whitespace boundary under the cap. Good for set/replace where
        trailing data is usually less important.
      - "drop_head" — remove leading chunks up to the next `sep` until
        the remainder fits. Good for append, where newest content is
        most relevant.
    """
    if len(text) <= limit:
        return text, False

    if strategy == "drop_head":
        s = text
        while len(s) > limit:
            idx = s.find(sep)
            if idx == -1 or idx >= len(s) - 1:
                # No more separators — fall back to tail truncate.
                break
            s = s[idx + len(sep):]
        if len(s) <= limit:
            return s, True
        # Fell through — still too long. Tail-truncate the tail.
        strategy = "tail_truncate"
        text = s

    # tail_truncate
    cut = text[:limit]
    # Prefer a word boundary for readability.
    boundary = max(cut.rfind(" "), cut.rfind("\n"), cut.rfind("."))
    if boundary > limit * 0.8:
        cut = cut[:boundary]
    return cut.rstrip() + "…", True


__all__ = [
    "ensure_defaults",
    "list_blocks",
    "read_block",
    "set_block",
    "append_block",
    "replace_block",
    "delete_block",
    "DEFAULT_BLOCKS",
]
