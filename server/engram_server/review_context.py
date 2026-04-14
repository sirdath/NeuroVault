"""Token-efficient structural review context — NeuroVault's answer to
code-review-graph's "6.8x fewer tokens" trick.

Given one or more file paths, returns a tight structural summary instead
of the raw file content. Claude reviews a diff by reading the summary
plus the actual changed lines, not by loading the whole file. For each
tracked symbol in a file we include:

  - signature: name, kind, type_hint, line number
  - the first line of the docstring (if present)
  - up to N top callers (so Claude knows what would break on change)
  - up to N top callees (so Claude knows what this function depends on)
  - hot_score = how many callers it currently has
  - related_memories: top-K engrams whose title matches the symbol —
    this is the unique NeuroVault angle. code-review-graph has no
    cognitive layer, so their review context is purely structural.
    Ours also surfaces "there's a decision note from March about
    this function" which is often the most valuable context.

Token budgeting is per-file and additive. We rough-estimate at 4 chars
per token and stop adding symbols to a file once the budget is hit.
Symbols are sorted by kind priority (class > function > constant) so
the highest-signal symbols are surfaced first.
"""

from __future__ import annotations

from typing import Any

from loguru import logger

from engram_server.database import Database


# Rough char→token ratio. OpenAI's tiktoken is closer to 3.5–4 for
# English prose and 2.5–3 for code; we use 4 to stay conservative.
_CHARS_PER_TOKEN = 4

# Per-symbol baseline overhead (JSON keys, punctuation, brackets).
_SYMBOL_BASELINE_TOKENS = 25

# Default budgets. The total budget caps the whole response; each file
# gets a share proportional to the number of files requested.
DEFAULT_TOTAL_BUDGET = 3000
DEFAULT_CALLERS_PER_SYMBOL = 3
DEFAULT_CALLEES_PER_SYMBOL = 3
DEFAULT_MEMORIES_PER_SYMBOL = 2

# Sort order inside a file: classes first, then functions, then constants.
_KIND_PRIORITY = {
    "class": 1,
    "function": 2,
    "constant": 3,
    "type": 4,
    "variable": 5,
}


def _estimate_tokens(obj: Any) -> int:
    """Rough token estimate for a JSON-serialisable object."""
    import json
    try:
        serialised = json.dumps(obj, default=str)
    except Exception:
        serialised = str(obj)
    return max(1, len(serialised) // _CHARS_PER_TOKEN)


def _top_callers(db: Database, name: str, limit: int) -> list[dict]:
    rows = db.conn.execute(
        """SELECT caller_name, filepath, line_number
           FROM function_calls
           WHERE callee_name = ? COLLATE NOCASE
           ORDER BY line_number
           LIMIT ?""",
        (name, limit),
    ).fetchall()
    return [
        {
            "caller": r[0] or "(module)",
            "filepath": r[1] or "",
            "line": r[2] or 0,
        }
        for r in rows
    ]


def _top_callees(db: Database, name: str, limit: int) -> list[dict]:
    rows = db.conn.execute(
        """SELECT DISTINCT callee_name, filepath, line_number
           FROM function_calls
           WHERE caller_name = ? COLLATE NOCASE
           ORDER BY filepath, line_number
           LIMIT ?""",
        (name, limit),
    ).fetchall()
    return [
        {
            "callee": r[0] or "",
            "filepath": r[1] or "",
            "line": r[2] or 0,
        }
        for r in rows
    ]


def _caller_count(db: Database, name: str) -> int:
    row = db.conn.execute(
        "SELECT COUNT(*) FROM function_calls WHERE callee_name = ? COLLATE NOCASE",
        (name,),
    ).fetchone()
    return int(row[0]) if row else 0


def _related_memories(db: Database, name: str, limit: int) -> list[dict]:
    """Find engrams whose title or content mentions this symbol name.

    Cheap LIKE-based lookup — no embedding cost. Prioritises engrams
    where the name appears in the title (stronger signal) and filters
    out observation engrams so auto-captured tool calls don't flood
    the review context.
    """
    if not name or len(name) < 3:
        return []
    rows = db.conn.execute(
        """SELECT id, title, kind, created_at
           FROM engrams
           WHERE state != 'dormant'
             AND COALESCE(kind, 'note') != 'observation'
             AND (title LIKE ? OR content LIKE ?)
           ORDER BY
             CASE WHEN title LIKE ? THEN 0 ELSE 1 END,
             strength DESC
           LIMIT ?""",
        (f"%{name}%", f"%{name}%", f"%{name}%", limit),
    ).fetchall()
    return [
        {"engram_id": r[0], "title": r[1], "kind": r[2] or "note", "created_at": r[3]}
        for r in rows
    ]


def _resolve_filepath(db: Database, filepath: str) -> str:
    """Resolve a caller-supplied path (relative/absolute, any slash style)
    to the canonical path stored in variable_references. Falls back to the
    original string if nothing matches, so the caller still sees an
    empty-symbols response and the "ingest first" hint."""
    if not filepath:
        return filepath
    row = db.conn.execute(
        "SELECT 1 FROM variable_references WHERE filepath = ? LIMIT 1",
        (filepath,),
    ).fetchone()
    if row:
        return filepath

    norm_fwd = filepath.replace("\\", "/")
    norm_bwd = filepath.replace("/", "\\")
    best = db.conn.execute(
        """SELECT DISTINCT filepath
           FROM variable_references
           WHERE filepath LIKE ? OR filepath LIKE ?
           ORDER BY LENGTH(filepath)
           LIMIT 1""",
        (f"%{norm_fwd}", f"%{norm_bwd}"),
    ).fetchone()
    return best[0] if best else filepath


def _symbols_in_file(db: Database, filepath: str) -> list[dict]:
    """Return every tracked symbol defined in the given file."""
    canonical = _resolve_filepath(db, filepath)
    rows = db.conn.execute(
        """SELECT v.id, v.name, v.kind, v.type_hint, v.description,
                  v.first_seen, v.last_seen, MIN(r.line_number) AS line_number
           FROM variables v
           JOIN variable_references r ON r.variable_id = v.id
           WHERE r.filepath = ?
             AND v.removed_at IS NULL
           GROUP BY v.id
           ORDER BY line_number""",
        (canonical,),
    ).fetchall()
    symbols = []
    for r in rows:
        kind = r[2] or "variable"
        symbols.append({
            "id": r[0],
            "name": r[1],
            "kind": kind,
            "type_hint": r[3],
            "description": (r[4] or "").split("\n", 1)[0][:200],
            "first_seen": r[5],
            "last_seen": r[6],
            "line": r[7] or 0,
            "_priority": _KIND_PRIORITY.get(kind, 99),
        })
    # Sort: classes first, then functions, then constants, etc.
    symbols.sort(key=lambda s: (s["_priority"], s["line"]))
    return symbols


def _markers_in_file(db: Database, filepath: str, limit: int = 5) -> list[dict]:
    """Return TODO/FIXME/HACK markers found in this file during ingest."""
    # Our marker storage is in code_ingest as todo-* engrams whose content
    # references the source file. We check for that pattern.
    fname = filepath.split("/")[-1].split("\\")[-1]
    if not fname:
        return []
    rows = db.conn.execute(
        """SELECT id, title
           FROM engrams
           WHERE filename LIKE 'todo-%'
             AND state != 'dormant'
             AND content LIKE ?
           ORDER BY updated_at DESC
           LIMIT ?""",
        (f"%{fname}%", limit),
    ).fetchall()
    return [{"engram_id": r[0], "title": r[1]} for r in rows]


def _summarize_file(
    db: Database,
    filepath: str,
    per_file_budget: int,
    callers_per_symbol: int,
    callees_per_symbol: int,
    memories_per_symbol: int,
) -> dict:
    """Build a tight structural summary for a single file."""
    all_symbols = _symbols_in_file(db, filepath)

    if not all_symbols:
        return {
            "filepath": filepath,
            "summary": {
                "functions": 0,
                "classes": 0,
                "tracked_symbols": 0,
            },
            "symbols": [],
            "markers": [],
            "tokens_used": 0,
            "note": "No tracked symbols. Ingest via POST /api/ingest-code first.",
        }

    function_count = sum(1 for s in all_symbols if s["kind"] == "function")
    class_count = sum(1 for s in all_symbols if s["kind"] == "class")
    markers = _markers_in_file(db, filepath)

    tokens_used = _estimate_tokens({
        "filepath": filepath,
        "summary": {
            "functions": function_count,
            "classes": class_count,
            "tracked_symbols": len(all_symbols),
        },
        "markers": markers,
    })

    out_symbols: list[dict] = []
    truncated = False

    for s in all_symbols:
        if s["kind"] not in ("function", "class", "constant", "type"):
            continue

        callers = _top_callers(db, s["name"], callers_per_symbol)
        callees = _top_callees(db, s["name"], callees_per_symbol) if s["kind"] == "function" else []
        mem = _related_memories(db, s["name"], memories_per_symbol)
        total_callers = _caller_count(db, s["name"])

        entry = {
            "name": s["name"],
            "kind": s["kind"],
            "type_hint": s["type_hint"],
            "description": s["description"],
            "line": s["line"],
            "hot_score": total_callers,
            "callers": callers,
            "callees": callees,
            "related_memories": mem,
        }
        cost = _estimate_tokens(entry) + _SYMBOL_BASELINE_TOKENS

        if tokens_used + cost > per_file_budget and out_symbols:
            truncated = True
            break

        out_symbols.append(entry)
        tokens_used += cost

    return {
        "filepath": filepath,
        "summary": {
            "functions": function_count,
            "classes": class_count,
            "tracked_symbols": len(all_symbols),
        },
        "symbols": out_symbols,
        "markers": markers,
        "tokens_used": tokens_used,
        "truncated": truncated,
    }


def get_review_context(
    db: Database,
    filepaths: list[str],
    total_token_budget: int = DEFAULT_TOTAL_BUDGET,
    callers_per_symbol: int = DEFAULT_CALLERS_PER_SYMBOL,
    callees_per_symbol: int = DEFAULT_CALLEES_PER_SYMBOL,
    memories_per_symbol: int = DEFAULT_MEMORIES_PER_SYMBOL,
) -> dict:
    """Return a token-optimized review context for a list of files.

    Claude uses this before reading any source so it can decide which
    files it actually needs to expand. The output is deliberately tiny
    compared to the original files — typical 5-10× reduction vs raw
    concatenation, and includes information (callers, related decisions)
    that raw content doesn't have.

    Args:
        db: Active brain database.
        filepaths: List of source file paths to summarise.
        total_token_budget: Upper bound for the whole response. Split
            evenly across files.
        callers_per_symbol: Max callers to list per function/class.
        callees_per_symbol: Max callees to list per function.
        memories_per_symbol: Max related memories to surface per symbol.

    Returns:
        dict with keys: files (list of per-file summaries), total_tokens,
        token_budget, truncated (bool).
    """
    if not filepaths:
        return {
            "files": [],
            "total_tokens": 0,
            "token_budget": total_token_budget,
            "truncated": False,
            "note": "No files requested.",
        }

    per_file_budget = max(200, total_token_budget // len(filepaths))
    file_summaries: list[dict] = []
    total_tokens = 0
    any_truncated = False

    for fp in filepaths[:50]:  # hard cap at 50 files per call
        summary = _summarize_file(
            db,
            fp,
            per_file_budget=per_file_budget,
            callers_per_symbol=callers_per_symbol,
            callees_per_symbol=callees_per_symbol,
            memories_per_symbol=memories_per_symbol,
        )
        file_summaries.append(summary)
        total_tokens += summary.get("tokens_used", 0)
        if summary.get("truncated"):
            any_truncated = True

    logger.debug(
        "review_context: {} files, {} tokens used, truncated={}",
        len(file_summaries), total_tokens, any_truncated,
    )

    return {
        "files": file_summaries,
        "total_tokens": total_tokens,
        "token_budget": total_token_budget,
        "per_file_budget": per_file_budget,
        "truncated": any_truncated,
    }
