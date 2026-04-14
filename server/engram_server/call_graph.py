"""Call graph extractor — caller→callee edges across the codebase.

Sits next to variable_tracker. For each code file:
1. Walk the source tracking the "current function" via indent (Python)
   or brace depth (C-like).
2. For every `name(` we see, record an edge from the containing function
   (or NULL if module-level) to the callee.
3. Skip language keywords and common builtins so the graph isn't drowned
   in `print`/`len`/`if`.

Once populated, answers:
- Who calls foo?           → find_callers("foo")
- What does foo call?      → find_callees("foo")
- Show me foo's neighborhood → call_graph_for("foo", depth=2)
"""

import re
from typing import Iterator

from loguru import logger

from engram_server.database import Database


PYTHON_SKIP = {
    "print", "len", "range", "list", "dict", "set", "tuple", "str", "int", "float",
    "bool", "open", "isinstance", "type", "super", "getattr", "setattr", "hasattr",
    "map", "filter", "zip", "enumerate", "sorted", "reversed", "sum", "min", "max",
    "abs", "round", "any", "all", "iter", "next", "callable", "staticmethod",
    "classmethod", "property", "format", "repr", "vars", "dir", "id", "hash", "input",
    "if", "for", "while", "return", "yield", "raise", "assert", "import", "from",
    "del", "not", "and", "or", "in", "is", "lambda", "with", "as", "try", "except",
    "finally", "class", "def", "global", "nonlocal", "pass", "break", "continue",
    "else", "elif", "True", "False", "None", "self", "cls", "async", "await",
}

BRACE_SKIP = {
    "if", "for", "while", "return", "function", "var", "let", "const", "new",
    "typeof", "instanceof", "in", "of", "delete", "void", "throw", "try", "catch",
    "finally", "switch", "case", "break", "continue", "do", "else", "class",
    "extends", "super", "import", "export", "from", "default", "yield", "await",
    "async", "this", "arguments", "null", "undefined", "true", "false", "console",
    "Object", "Array", "String", "Number", "Boolean", "Math", "Date", "JSON",
    "Promise", "Map", "Set", "Symbol", "Error", "RegExp", "parseInt", "parseFloat",
    "isNaN", "isFinite", "require", "module", "exports", "fn", "func", "struct",
    "enum", "trait", "impl", "pub", "use", "mod", "let", "match", "loop", "where",
    "self", "Self", "Box", "Vec", "Option", "Result", "Some", "None", "Ok", "Err",
    "println", "print", "format", "panic", "vec", "make", "len", "cap", "append",
    "package", "type", "interface", "go", "defer", "chan", "select", "range",
    "public", "private", "protected", "static", "abstract", "final", "void",
    "int", "long", "double", "float", "boolean", "char", "byte", "short",
}

CALL_PATTERN = re.compile(r"\b([A-Za-z_]\w*)\s*\(")


def extract_python_calls(content: str) -> Iterator[dict]:
    """Track containing function via Python indentation."""
    lines = content.split("\n")
    stack: list[tuple[str, int]] = []  # (func_name, indent)

    for i, line in enumerate(lines, start=1):
        stripped = line.lstrip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(line) - len(stripped)

        # Pop functions whose body has ended (dedent past their indent)
        while stack and indent <= stack[-1][1]:
            stack.pop()

        # New def?
        m = re.match(r"(?:async\s+)?def\s+(\w+)\s*\(", stripped)
        if m:
            stack.append((m.group(1), indent))
            continue

        caller = stack[-1][0] if stack else None
        for cm in CALL_PATTERN.finditer(stripped):
            callee = cm.group(1)
            if callee in PYTHON_SKIP or callee == caller:
                continue
            yield {"caller": caller, "callee": callee, "line_number": i}


def extract_brace_calls(content: str) -> Iterator[dict]:
    """Track containing function via brace depth (JS/TS/Rust/Go/Java/C)."""
    stack: list[tuple[str, int]] = []  # (func_name, depth_at_open)
    depth = 0
    pending: str | None = None

    for i, line in enumerate(content.split("\n"), start=1):
        # Detect function definition on this line — covers many syntaxes
        fn_match = re.search(
            r"(?:function\s+(\w+)|"
            r"(?:fn|func|def)\s+(\w+)|"
            r"(?:const|let|var)\s+(\w+)\s*[:=]\s*(?:async\s*)?(?:\([^)]*\)\s*=>|function))",
            line,
        )
        if fn_match:
            pending = fn_match.group(1) or fn_match.group(2) or fn_match.group(3)

        caller = stack[-1][0] if stack else None
        for cm in CALL_PATTERN.finditer(line):
            callee = cm.group(1)
            if callee in BRACE_SKIP or callee == caller or callee == pending:
                continue
            yield {"caller": caller, "callee": callee, "line_number": i}

        for ch in line:
            if ch == "{":
                if pending is not None:
                    stack.append((pending, depth))
                    pending = None
                depth += 1
            elif ch == "}":
                depth -= 1
                if stack and depth == stack[-1][1]:
                    stack.pop()


CALL_EXTRACTORS = {
    "python": extract_python_calls,
    "javascript": extract_brace_calls,
    "typescript": extract_brace_calls,
    "rust": extract_brace_calls,
    "go": extract_brace_calls,
    "java": extract_brace_calls,
    "c": extract_brace_calls,
    "cpp": extract_brace_calls,
    "csharp": extract_brace_calls,
}


def track_calls(
    db: Database,
    engram_id: str,
    filepath: str,
    content: str,
    language: str,
) -> int:
    """Extract call edges from a code file and store them.

    Prefers tree-sitter when the optional `ast` extra is installed; falls
    back to the brace/indent regex extractors otherwise.
    """
    edges: Iterator[dict] | list[dict]
    try:
        from engram_server.ast_extractors import extract_calls_ast, AVAILABLE
        if AVAILABLE:
            edges = list(extract_calls_ast(content, language))
            if not edges:
                extractor = CALL_EXTRACTORS.get(language)
                edges = list(extractor(content)) if extractor else []
        else:
            extractor = CALL_EXTRACTORS.get(language)
            edges = list(extractor(content)) if extractor else []
    except ImportError:
        extractor = CALL_EXTRACTORS.get(language)
        edges = list(extractor(content)) if extractor else []

    if not edges:
        return 0

    count = 0
    for call in edges:
        try:
            db.conn.execute(
                """INSERT OR IGNORE INTO function_calls
                   (caller_name, callee_name, language, engram_id, filepath, line_number)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (call.get("caller"), call["callee"], language, engram_id, filepath, call["line_number"]),
            )
            count += 1
        except Exception as e:
            logger.debug("Call insert failed: {}", e)

    db.conn.commit()
    logger.debug("Tracked {} call edges from {}", count, filepath)
    return count


def find_callers(db: Database, name: str, limit: int = 50) -> list[dict]:
    """Who calls this function? Returns callsites with their containing function."""
    rows = db.conn.execute(
        """SELECT caller_name, filepath, line_number, language
           FROM function_calls
           WHERE callee_name = ? COLLATE NOCASE
           ORDER BY filepath, line_number LIMIT ?""",
        (name, limit),
    ).fetchall()
    return [
        {"caller": r[0], "filepath": r[1], "line": r[2], "language": r[3]}
        for r in rows
    ]


def find_callees(db: Database, name: str, limit: int = 100) -> list[dict]:
    """What does this function call? Returns its outgoing edges."""
    rows = db.conn.execute(
        """SELECT DISTINCT callee_name, filepath, line_number, language
           FROM function_calls
           WHERE caller_name = ? COLLATE NOCASE
           ORDER BY filepath, line_number LIMIT ?""",
        (name, limit),
    ).fetchall()
    return [
        {"callee": r[0], "filepath": r[1], "line": r[2], "language": r[3]}
        for r in rows
    ]


def call_graph_for(
    db: Database,
    name: str,
    depth: int = 2,
    direction: str = "callers",
    limit_per_level: int = 20,
) -> dict:
    """BFS outward from a function. direction ∈ {'callers', 'callees', 'both'}."""
    visited: set[str] = {name}
    levels: list[list[dict]] = []
    frontier: set[str] = {name}

    for _ in range(depth):
        next_frontier: set[str] = set()
        level_edges: list[dict] = []

        for fn in frontier:
            if direction in ("callers", "both"):
                for c in find_callers(db, fn, limit=limit_per_level):
                    if c["caller"] and c["caller"] not in visited:
                        next_frontier.add(c["caller"])
                        visited.add(c["caller"])
                    level_edges.append({
                        "from": c["caller"], "to": fn,
                        "filepath": c["filepath"], "line": c["line"],
                    })
            if direction in ("callees", "both"):
                for c in find_callees(db, fn, limit=limit_per_level):
                    if c["callee"] and c["callee"] not in visited:
                        next_frontier.add(c["callee"])
                        visited.add(c["callee"])
                    level_edges.append({
                        "from": fn, "to": c["callee"],
                        "filepath": c["filepath"], "line": c["line"],
                    })

        if level_edges:
            levels.append(level_edges)
        frontier = next_frontier
        if not frontier:
            break

    return {
        "root": name,
        "depth": depth,
        "direction": direction,
        "node_count": len(visited),
        "levels": levels,
    }


def find_dead_code(
    db: Database,
    stale_days: int = 60,
    max_callers: int = 0,
    limit: int = 50,
) -> list[dict]:
    """Find functions/classes that look dead.

    A symbol is "likely dead" when ALL of these hold:
    - It still exists in the codebase (variables.removed_at IS NULL)
    - It hasn't been touched in `stale_days` days (variables.last_seen)
    - It has at most `max_callers` inbound call edges
    - It is a function or class (not a module-level constant)

    Each result includes a confidence score 0..1 derived from how stale
    it is and how few references it has — the higher the better.
    """
    rows = db.conn.execute(
        f"""
        SELECT v.name, v.kind, v.language, v.last_seen, v.first_seen,
               (SELECT COUNT(*) FROM variable_references WHERE variable_id = v.id) AS ref_count,
               (SELECT COUNT(*) FROM function_calls WHERE callee_name = v.name COLLATE NOCASE) AS caller_count
        FROM variables v
        WHERE v.removed_at IS NULL
          AND v.kind IN ('function', 'class')
          AND v.last_seen <= datetime('now', '-{int(stale_days)} days')
        """
    ).fetchall()

    candidates: list[dict] = []
    for r in rows:
        name, kind, lang, last_seen, first_seen, ref_count, caller_count = r
        if caller_count > max_callers:
            continue
        # Confidence: more stale + fewer callers + fewer references = higher
        try:
            stale_score = 1.0 if not last_seen else min(
                1.0,
                (
                    (db.conn.execute(
                        "SELECT julianday('now') - julianday(?)", (last_seen,)
                    ).fetchone()[0] or 0) / 365.0
                ),
            )
        except Exception:
            stale_score = 0.5
        ref_score = 1.0 / (1 + ref_count)
        caller_score = 1.0 / (1 + caller_count)
        confidence = round((stale_score * 0.5 + ref_score * 0.25 + caller_score * 0.25), 3)

        candidates.append({
            "name": name,
            "kind": kind,
            "language": lang,
            "last_seen": last_seen,
            "first_seen": first_seen,
            "reference_count": ref_count,
            "caller_count": caller_count,
            "confidence": confidence,
        })

    candidates.sort(key=lambda c: c["confidence"], reverse=True)
    return candidates[:limit]


def find_renamed_callsites(db: Database, limit: int = 50) -> list[dict]:
    """Find places that still call the OLD name of a renamed symbol.

    Cross-references `variable_renames` with the live `function_calls` table.
    For each detected rename (old_name → new_name), looks for any callsite
    whose callee_name still matches old_name. Those are stale references that
    need updating.

    This is the demo NeuroVault is uniquely positioned to ship: GitNexus has
    a `rename` action but doesn't track rename history. We track history,
    so we can answer "did the rename actually propagate everywhere?"
    """
    renames = db.conn.execute(
        """SELECT old_name, new_name, language, kind, detected_at
           FROM variable_renames
           ORDER BY detected_at DESC LIMIT ?""",
        (limit,),
    ).fetchall()

    results: list[dict] = []
    for old_name, new_name, language, kind, detected_at in renames:
        callsite_rows = db.conn.execute(
            """SELECT caller_name, filepath, line_number
               FROM function_calls
               WHERE callee_name = ? COLLATE NOCASE
               ORDER BY filepath, line_number LIMIT 100""",
            (old_name,),
        ).fetchall()
        if not callsite_rows:
            continue
        results.append({
            "old_name": old_name,
            "new_name": new_name,
            "language": language,
            "kind": kind,
            "detected_at": detected_at,
            "stale_callsite_count": len(callsite_rows),
            "callsites": [
                {"caller": c[0], "filepath": c[1], "line": c[2]}
                for c in callsite_rows
            ],
        })

    return results


def hot_functions(db: Database, limit: int = 20) -> list[dict]:
    """Most-called functions in the codebase — the API surface that matters."""
    rows = db.conn.execute(
        """SELECT callee_name, COUNT(*) as call_count, language
           FROM function_calls
           GROUP BY callee_name COLLATE NOCASE
           ORDER BY call_count DESC LIMIT ?""",
        (limit,),
    ).fetchall()
    return [
        {"name": r[0], "call_count": r[1], "language": r[2]}
        for r in rows
    ]
