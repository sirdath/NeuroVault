"""Impact radius + change detection — PR review workflow.

Given a set of changed files (or a git diff), trace the blast radius
through the call graph to find every transitively-affected function,
then score each affected symbol by risk. This is the NeuroVault take
on code-review-graph's `get_impact_radius_tool` + `detect_changes_tool`,
with one important twist: our risk score uses the cognitive layer that
code-review-graph literally cannot build because they have no decay
and no related-memory surfacing.

Risk score ingredients (0-10 scale, additive then capped):

  * base       = 1.0 + log(caller_count + 1) * 1.5
                  — more inbound calls = higher blast radius
  * hotness    = strength × 2 + min(access_count/10, 1)
                  — recently/frequently used = more fragile
  * decision   = +1.5 if a related engram mentions this symbol AND
                  has a "Decision:" marker in its title
                  — an explicit design decision exists about it
  * depth drop = base × (1 - 0.15 × depth)
                  — direct hits score higher than transitive ones

Then min(10.0, max(0.0, ...)).

`detect_changes` parses a unified diff, extracts the `+++ b/path` file
paths, and runs `get_impact_radius` on them. It adds an aggregate
diff-level risk score (weighted by per-symbol risk).
"""

from __future__ import annotations

import math
import re
from typing import Any

from loguru import logger

from engram_server.database import Database


DEFAULT_MAX_DEPTH = 3
DEFAULT_MAX_AFFECTED = 200  # hard cap to keep responses tight
DIFF_FILEPATH_CAP = 50       # diffs with more files get truncated


# --- Diff parsing ---------------------------------------------------------

_DIFF_B_LINE = re.compile(r"^\+\+\+ b/(.+?)(?:\t|$)", re.MULTILINE)
_DIFF_PLUS_LINE = re.compile(r"^\+\+\+ (.+?)(?:\t|$)", re.MULTILINE)


def parse_diff_filepaths(diff_text: str) -> list[str]:
    """Extract the destination paths from a unified diff.

    Handles standard git diff output (`+++ b/path/to/file.py`) plus a
    fallback for bare unified diffs that use `+++ path/to/file.py`.
    Skips `/dev/null` (file deletion). Deduped, deterministic order.
    """
    if not diff_text:
        return []

    paths: list[str] = []
    seen: set[str] = set()

    for match in _DIFF_B_LINE.finditer(diff_text):
        p = match.group(1).strip()
        if p and p != "/dev/null" and p not in seen:
            seen.add(p)
            paths.append(p)

    if not paths:
        # Fallback for non-git diffs
        for match in _DIFF_PLUS_LINE.finditer(diff_text):
            p = match.group(1).strip()
            if p.startswith("b/"):
                p = p[2:]
            if p and p != "/dev/null" and p not in seen:
                seen.add(p)
                paths.append(p)

    return paths[:DIFF_FILEPATH_CAP]


# --- Symbol discovery ----------------------------------------------------

def _resolve_filepaths(db: Database, filepaths: list[str]) -> list[str]:
    """Map caller-supplied paths (relative or absolute, any slash style)
    to the canonical paths stored in `variable_references`.

    Diffs from git use repo-relative forward-slash paths
    (`engram_server/retrieval_feedback.py`), but our ingest pipeline
    stores whatever absolute path the caller passed, often with
    backslashes on Windows. Without a suffix match, detect_changes
    would silently return zero results for any git diff on Windows.

    Strategy per requested path:
      1. If exact match → use it as-is.
      2. Else try LIKE '%<norm>' where `<norm>` is the path with forward
         slashes. SQLite LIKE is case-insensitive with NOCASE collation.
      3. Also try backslash-normalised variant for Windows.
      4. Prefer the shortest match (closest to the query).
    """
    if not filepaths:
        return []

    resolved: list[str] = []
    for fp in filepaths:
        if not fp:
            continue

        # Fast path: exact hit
        row = db.conn.execute(
            "SELECT 1 FROM variable_references WHERE filepath = ? LIMIT 1",
            (fp,),
        ).fetchone()
        if row:
            resolved.append(fp)
            continue

        # Slow path: suffix match against both slash styles
        norm_fwd = fp.replace("\\", "/")
        norm_bwd = fp.replace("/", "\\")
        rows = db.conn.execute(
            """SELECT DISTINCT filepath
               FROM variable_references
               WHERE filepath LIKE ? OR filepath LIKE ?
               ORDER BY LENGTH(filepath)
               LIMIT 1""",
            (f"%{norm_fwd}", f"%{norm_bwd}"),
        ).fetchall()
        if rows:
            resolved.append(rows[0][0])
        else:
            resolved.append(fp)  # keep the original so caller sees "no match"

    return resolved


def _direct_symbols_in_files(db: Database, filepaths: list[str]) -> list[dict]:
    """Return every function/class defined in any of the given files."""
    if not filepaths:
        return []

    canonical = _resolve_filepaths(db, filepaths)
    placeholders = ",".join("?" * len(canonical))
    rows = db.conn.execute(
        f"""SELECT DISTINCT v.name, v.kind, r.filepath, MIN(r.line_number) AS line
            FROM variables v
            JOIN variable_references r ON r.variable_id = v.id
            WHERE r.filepath IN ({placeholders})
              AND v.removed_at IS NULL
              AND v.kind IN ('function', 'class')
            GROUP BY v.id, r.filepath
            ORDER BY r.filepath, line""",
        canonical,
    ).fetchall()

    return [
        {"name": r[0], "kind": r[1], "filepath": r[2], "line": r[3] or 0}
        for r in rows
    ]


def _callers_of(db: Database, name: str) -> list[dict]:
    """All inbound call edges for `name`, distinct by caller+filepath+line."""
    rows = db.conn.execute(
        """SELECT DISTINCT caller_name, filepath, line_number
           FROM function_calls
           WHERE callee_name = ? COLLATE NOCASE
             AND caller_name IS NOT NULL""",
        (name,),
    ).fetchall()
    return [
        {"caller": r[0], "filepath": r[1] or "", "line": r[2] or 0}
        for r in rows
    ]


def _caller_count(db: Database, name: str) -> int:
    row = db.conn.execute(
        "SELECT COUNT(*) FROM function_calls WHERE callee_name = ? COLLATE NOCASE",
        (name,),
    ).fetchone()
    return int(row[0]) if row else 0


# --- Risk scoring --------------------------------------------------------

def _has_related_decision(db: Database, symbol_name: str) -> bool:
    """True if any live engram titled "Decision: ..." mentions this symbol."""
    if not symbol_name or len(symbol_name) < 3:
        return False
    row = db.conn.execute(
        """SELECT 1 FROM engrams
           WHERE state != 'dormant'
             AND COALESCE(kind, 'note') != 'observation'
             AND (title LIKE 'Decision:%' OR title LIKE 'decision-%' OR filename LIKE 'decision-%')
             AND (title LIKE ? OR content LIKE ?)
           LIMIT 1""",
        (f"%{symbol_name}%", f"%{symbol_name}%"),
    ).fetchone()
    return row is not None


def _symbol_strength(db: Database, symbol_name: str) -> tuple[float, int]:
    """Return (strength, access_count) for any engram matching this symbol.

    Looks for the strongest live engram whose title references the symbol.
    Used as a proxy for "how active is this code in the user's memory."
    """
    if not symbol_name or len(symbol_name) < 3:
        return (0.0, 0)
    row = db.conn.execute(
        """SELECT strength, access_count
           FROM engrams
           WHERE state != 'dormant'
             AND COALESCE(kind, 'note') != 'observation'
             AND title LIKE ?
           ORDER BY strength DESC
           LIMIT 1""",
        (f"%{symbol_name}%",),
    ).fetchone()
    if not row:
        return (0.0, 0)
    return (float(row[0] or 0.0), int(row[1] or 0))


def _compute_risk(
    db: Database,
    symbol_name: str,
    caller_count: int,
    depth: int,
) -> tuple[float, list[str]]:
    """Return (risk_score 0-10, list of human-readable reasons)."""
    reasons: list[str] = []

    # Base: log of caller count
    base = 1.0 + math.log(max(1, caller_count) + 1) * 1.5
    reasons.append(f"{caller_count} inbound caller{'s' if caller_count != 1 else ''}")

    # Hotness: recent activity in the memory layer
    strength, access_count = _symbol_strength(db, symbol_name)
    if strength > 0 or access_count > 0:
        bonus = (strength * 2.0) + min(access_count / 10.0, 1.0)
        base += bonus
        if strength > 0.7:
            reasons.append(f"hot in memory (strength {strength:.2f})")
        elif access_count > 0:
            reasons.append(f"{access_count} recent accesses")

    # Decision bump: explicit design decision mentions this symbol
    if _has_related_decision(db, symbol_name):
        base += 1.5
        reasons.append("related design decision exists")

    # Depth drop: transitive hits are less risky than direct
    if depth > 0:
        base *= max(0.3, 1.0 - 0.15 * depth)

    return (min(10.0, max(0.0, round(base, 2))), reasons)


# --- Impact radius BFS ---------------------------------------------------

def get_impact_radius(
    db: Database,
    filepaths: list[str],
    max_depth: int = DEFAULT_MAX_DEPTH,
    max_affected: int = DEFAULT_MAX_AFFECTED,
) -> dict:
    """Trace the blast radius of changes to the given files.

    Returns every function that would be transitively affected if the
    symbols defined in these files changed, scored by risk. BFS upward
    through the call graph, capped at `max_depth` hops and `max_affected`
    total symbols.

    The output is sorted by risk_score DESC so Claude can focus on the
    highest-impact items first. Direct hits (depth 0) are always included;
    transitive hits are truncated if the graph is too large.
    """
    if not filepaths:
        return {
            "changed_files": [],
            "directly_affected": [],
            "transitively_affected": [],
            "stats": {"total_affected": 0, "by_depth": {}},
            "note": "No filepaths supplied",
        }

    directly = _direct_symbols_in_files(db, filepaths)

    # all_affected: name -> {depth, filepath, line, path_via, risk, reasons}
    all_affected: dict[str, dict] = {}
    for s in directly:
        if s["name"] in all_affected:
            continue
        cc = _caller_count(db, s["name"])
        risk, reasons = _compute_risk(db, s["name"], cc, depth=0)
        all_affected[s["name"]] = {
            "name": s["name"],
            "kind": s["kind"],
            "filepath": s["filepath"],
            "line": s["line"],
            "depth": 0,
            "caller_count": cc,
            "path_via": [],
            "risk_score": risk,
            "reasons": reasons,
        }

    # BFS upward through the call graph
    frontier: set[str] = {s["name"] for s in directly}
    for depth in range(1, max_depth + 1):
        next_frontier: set[str] = set()
        for fn_name in frontier:
            if len(all_affected) >= max_affected:
                break
            for edge in _callers_of(db, fn_name):
                caller = edge["caller"]
                if not caller or caller in all_affected:
                    continue
                cc = _caller_count(db, caller)
                risk, reasons = _compute_risk(db, caller, cc, depth)
                all_affected[caller] = {
                    "name": caller,
                    "kind": "function",  # best guess; could look up variables table
                    "filepath": edge["filepath"],
                    "line": edge["line"],
                    "depth": depth,
                    "caller_count": cc,
                    "path_via": [fn_name],
                    "risk_score": risk,
                    "reasons": reasons,
                }
                next_frontier.add(caller)
                if len(all_affected) >= max_affected:
                    break
            if len(all_affected) >= max_affected:
                break
        if not next_frontier:
            break
        frontier = next_frontier

    # Split direct vs transitive, sort by risk within each bucket
    direct_list = sorted(
        (v for v in all_affected.values() if v["depth"] == 0),
        key=lambda v: (-v["risk_score"], v["name"]),
    )
    trans_list = sorted(
        (v for v in all_affected.values() if v["depth"] > 0),
        key=lambda v: (-v["risk_score"], v["depth"], v["name"]),
    )

    by_depth: dict[int, int] = {}
    for v in all_affected.values():
        by_depth[v["depth"]] = by_depth.get(v["depth"], 0) + 1

    logger.debug(
        "get_impact_radius: {} files, {} direct, {} transitive, max depth {}",
        len(filepaths), len(direct_list), len(trans_list), max(by_depth.keys(), default=0),
    )

    return {
        "changed_files": filepaths,
        "directly_affected": direct_list,
        "transitively_affected": trans_list,
        "stats": {
            "total_affected": len(all_affected),
            "by_depth": by_depth,
            "max_depth_reached": max(by_depth.keys(), default=0),
            "truncated": len(all_affected) >= max_affected,
        },
    }


# --- Change detection (diff + aggregate risk) ----------------------------

def detect_changes(
    db: Database,
    diff_text: str = "",
    filepaths: list[str] | None = None,
    max_depth: int = DEFAULT_MAX_DEPTH,
) -> dict:
    """PR-review entry point: parse a diff (or accept explicit filepaths)
    and return a risk-ranked view of what would be affected.

    Accepts either a unified diff (for PR/`git diff` output) or an
    explicit list of filepaths (for programmatic callers). Returns
    the full impact radius plus an aggregate diff-level risk score
    derived from the per-symbol risks of the most-affected items.
    """
    if filepaths is None:
        filepaths = parse_diff_filepaths(diff_text)

    if not filepaths:
        return {
            "changed_files": [],
            "risk_score": 0.0,
            "risk_level": "none",
            "high_risk_symbols": [],
            "directly_affected": [],
            "transitively_affected": [],
            "stats": {"total_affected": 0, "by_depth": {}},
            "note": "No files detected in diff",
        }

    radius = get_impact_radius(db, filepaths, max_depth=max_depth)

    # Aggregate risk: weighted average of the top 10 affected symbols,
    # with direct hits counted double.
    direct = radius["directly_affected"]
    trans = radius["transitively_affected"]
    candidates = [(v["risk_score"], 2.0) for v in direct] + [(v["risk_score"], 1.0) for v in trans]
    candidates.sort(key=lambda t: -t[0])
    top = candidates[:10]

    if top:
        weighted_sum = sum(r * w for r, w in top)
        weight_total = sum(w for _, w in top)
        agg = weighted_sum / weight_total if weight_total else 0.0
    else:
        agg = 0.0

    # Scale aggregate up a bit if the diff touches many files
    file_factor = min(1.5, 1.0 + 0.1 * max(0, len(filepaths) - 1))
    agg = min(10.0, round(agg * file_factor, 2))

    level = (
        "critical" if agg >= 8.0
        else "high" if agg >= 6.0
        else "medium" if agg >= 3.5
        else "low" if agg > 0
        else "none"
    )

    high_risk = [
        v for v in (direct + trans)
        if v["risk_score"] >= 5.0
    ][:15]

    return {
        "changed_files": filepaths,
        "risk_score": agg,
        "risk_level": level,
        "high_risk_symbols": high_risk,
        "directly_affected": direct,
        "transitively_affected": trans,
        "stats": radius["stats"],
    }
