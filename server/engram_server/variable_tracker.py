"""Variable tracker — remember every named thing in your codebase.

Solves the #1 problem AI coding assistants have: forgetting variable names,
their types, and where they're defined. When you ask Claude "what was that
config variable called?", NeuroVault can tell you exactly.

Extracts:
- Variable declarations (name, scope, type hint)
- Function signatures (name, params, return type)
- Class definitions
- Constants (UPPER_CASE convention)
- Type aliases and interfaces

Tracks:
- First definition location
- All references across files
- Type hints (Python, TS) and inferred types
- Leading comment/docstring as description
"""

import re
import uuid
from pathlib import Path
from typing import Iterator

from loguru import logger

from engram_server.database import Database


# --- Language-specific extractors ---

def extract_python_variables(content: str) -> Iterator[dict]:
    """Extract Python variables, constants, functions, classes."""
    # Module-level assignments with optional type hints
    # name: type = value   or   name = value
    for match in re.finditer(
        r"^(\w+)(?:\s*:\s*([^=\n]+))?\s*=\s*(.+?)$",
        content,
        re.MULTILINE,
    ):
        name = match.group(1)
        type_hint = match.group(2).strip() if match.group(2) else None
        value = match.group(3).strip()[:100]
        line = content[: match.start()].count("\n") + 1

        if not name or name.startswith("_") and not name.startswith("__"):
            continue
        if name in {"from", "import", "if", "else", "for", "while", "return", "True", "False", "None"}:
            continue

        kind = "constant" if name.isupper() else "variable"
        yield {
            "name": name,
            "kind": kind,
            "type_hint": type_hint,
            "line_number": line,
            "context": match.group(0)[:150],
        }

    # Function definitions
    for match in re.finditer(
        r"^\s*(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^:]+))?:",
        content,
        re.MULTILINE,
    ):
        name = match.group(1)
        params = match.group(2).strip()
        return_type = match.group(3).strip() if match.group(3) else None
        line = content[: match.start()].count("\n") + 1

        # Grab docstring from next line if present
        rest = content[match.end():]
        docstring = None
        doc_match = re.search(r'^\s*"""(.+?)"""', rest, re.DOTALL)
        if doc_match:
            docstring = doc_match.group(1).strip().split("\n")[0][:200]

        yield {
            "name": name,
            "kind": "function",
            "type_hint": return_type,
            "description": docstring,
            "line_number": line,
            "context": f"def {name}({params}){f' -> {return_type}' if return_type else ''}",
        }

    # Class definitions
    for match in re.finditer(
        r"^class\s+(\w+)(?:\(([^)]*)\))?:",
        content,
        re.MULTILINE,
    ):
        name = match.group(1)
        bases = match.group(2)
        line = content[: match.start()].count("\n") + 1
        yield {
            "name": name,
            "kind": "class",
            "type_hint": bases,
            "line_number": line,
            "context": f"class {name}" + (f"({bases})" if bases else ""),
        }


def extract_typescript_variables(content: str) -> Iterator[dict]:
    """Extract TypeScript/JavaScript variables, functions, types, interfaces."""
    # const/let/var with optional type annotation
    for match in re.finditer(
        r"^(?:export\s+)?(?:const|let|var)\s+(\w+)(?:\s*:\s*([^=\n]+?))?\s*=\s*(.+?)$",
        content,
        re.MULTILINE,
    ):
        name = match.group(1)
        type_hint = match.group(2).strip() if match.group(2) else None
        value = match.group(3).strip()[:100]
        line = content[: match.start()].count("\n") + 1

        kind = "constant" if name.isupper() else "variable"
        yield {
            "name": name,
            "kind": kind,
            "type_hint": type_hint,
            "line_number": line,
            "context": match.group(0)[:150],
        }

    # function declarations
    for match in re.finditer(
        r"^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[\(<]([^)]*)\)(?:\s*:\s*([^{]+))?",
        content,
        re.MULTILINE,
    ):
        name = match.group(1)
        params = match.group(2).strip()
        return_type = match.group(3).strip() if match.group(3) else None
        line = content[: match.start()].count("\n") + 1
        yield {
            "name": name,
            "kind": "function",
            "type_hint": return_type,
            "line_number": line,
            "context": f"function {name}({params})",
        }

    # type aliases + interfaces
    for match in re.finditer(
        r"^(?:export\s+)?(?:type|interface)\s+(\w+)",
        content,
        re.MULTILINE,
    ):
        name = match.group(1)
        line = content[: match.start()].count("\n") + 1
        yield {
            "name": name,
            "kind": "type",
            "line_number": line,
            "context": match.group(0),
        }

    # class declarations
    for match in re.finditer(
        r"^(?:export\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?",
        content,
        re.MULTILINE,
    ):
        name = match.group(1)
        base = match.group(2)
        line = content[: match.start()].count("\n") + 1
        yield {
            "name": name,
            "kind": "class",
            "type_hint": base,
            "line_number": line,
            "context": match.group(0),
        }


def extract_rust_variables(content: str) -> Iterator[dict]:
    """Extract Rust let/const/static/fn/struct/enum/trait."""
    # let bindings
    for match in re.finditer(
        r"let\s+(?:mut\s+)?(\w+)(?:\s*:\s*([^=;\n]+))?\s*=",
        content,
    ):
        name = match.group(1)
        type_hint = match.group(2).strip() if match.group(2) else None
        line = content[: match.start()].count("\n") + 1
        yield {
            "name": name,
            "kind": "variable",
            "type_hint": type_hint,
            "line_number": line,
            "context": match.group(0),
        }

    # const / static
    for match in re.finditer(
        r"^(?:pub\s+)?(?:const|static)\s+(\w+)\s*:\s*([^=]+?)\s*=",
        content,
        re.MULTILINE,
    ):
        name = match.group(1)
        type_hint = match.group(2).strip()
        line = content[: match.start()].count("\n") + 1
        yield {
            "name": name,
            "kind": "constant",
            "type_hint": type_hint,
            "line_number": line,
            "context": match.group(0),
        }

    # fn / struct / enum / trait
    for match in re.finditer(
        r"^(?:pub\s+)?(fn|struct|enum|trait|impl)\s+(\w+)",
        content,
        re.MULTILINE,
    ):
        kind_raw = match.group(1)
        name = match.group(2)
        line = content[: match.start()].count("\n") + 1
        kind_map = {
            "fn": "function", "struct": "class", "enum": "type",
            "trait": "type", "impl": "class",
        }
        yield {
            "name": name,
            "kind": kind_map.get(kind_raw, "variable"),
            "line_number": line,
            "context": match.group(0),
        }


def extract_go_variables(content: str) -> Iterator[dict]:
    """Extract Go var/const/func/type."""
    # var / const
    for match in re.finditer(
        r"^(?:var|const)\s+(\w+)\s+([\w\*\[\]]+)?",
        content,
        re.MULTILINE,
    ):
        name = match.group(1)
        type_hint = match.group(2)
        line = content[: match.start()].count("\n") + 1
        yield {
            "name": name,
            "kind": "constant" if name[0].isupper() else "variable",
            "type_hint": type_hint,
            "line_number": line,
            "context": match.group(0),
        }

    # func
    for match in re.finditer(
        r"^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(([^)]*)\)(?:\s+([\w\*\[\]]+))?",
        content,
        re.MULTILINE,
    ):
        name = match.group(1)
        params = match.group(2)
        return_type = match.group(3)
        line = content[: match.start()].count("\n") + 1
        yield {
            "name": name,
            "kind": "function",
            "type_hint": return_type,
            "line_number": line,
            "context": f"func {name}({params})",
        }

    # type
    for match in re.finditer(
        r"^type\s+(\w+)\s+(struct|interface)",
        content,
        re.MULTILINE,
    ):
        name = match.group(1)
        line = content[: match.start()].count("\n") + 1
        yield {
            "name": name,
            "kind": "type",
            "line_number": line,
            "context": match.group(0),
        }


EXTRACTORS = {
    "python": extract_python_variables,
    "javascript": extract_typescript_variables,
    "typescript": extract_typescript_variables,
    "rust": extract_rust_variables,
    "go": extract_go_variables,
}


# --- Public API ---

def extract_variables(content: str, language: str) -> list[dict]:
    """Extract all tracked entities from a code file.

    Prefers the tree-sitter backend (accurate, scope-aware). Falls back to
    the regex extractors when the optional `ast` extra isn't installed or
    the parser doesn't recognise the language.
    """
    try:
        from engram_server.ast_extractors import extract_variables_ast, AVAILABLE
        if AVAILABLE:
            ast_results = extract_variables_ast(content, language)
            if ast_results:
                return ast_results
    except ImportError:
        pass

    extractor = EXTRACTORS.get(language)
    if not extractor:
        return []
    return list(extractor(content))


def track_variables(
    db: Database,
    engram_id: str,
    filepath: str,
    content: str,
    language: str,
) -> dict:
    """Extract variables from a code file and record them in the tracker.

    Performs a full stale sweep: any variable that was previously tracked in
    this engram but is no longer present gets flagged as removed (or revived
    if it reappears in another file). Also detects likely renames by pairing
    disappeared names with newly-appeared names of the same kind + type_hint.

    Returns a dict: {tracked, added, removed, renamed}.
    """
    scope = "module"

    # Snapshot what this engram knew about before the sweep
    old_rows = db.conn.execute(
        """SELECT v.id, v.name, v.kind, v.type_hint
           FROM variables v
           JOIN variable_references r ON r.variable_id = v.id
           WHERE r.engram_id = ? AND v.language = ?""",
        (engram_id, language),
    ).fetchall()
    old_map: dict[str, dict] = {
        r[1]: {"id": r[0], "kind": r[2], "type_hint": r[3]} for r in old_rows
    }

    # Clean slate: drop this engram's references. We re-insert below.
    db.conn.execute(
        "DELETE FROM variable_references WHERE engram_id = ?", (engram_id,)
    )

    variables = extract_variables(content, language)
    new_map: dict[str, dict] = {}

    for var in variables:
        name = var["name"]
        kind = var.get("kind", "variable")
        type_hint = var.get("type_hint")
        description = var.get("description")
        line = var.get("line_number", 0)
        ctx = var.get("context", "")[:200]

        var_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"{language}::{scope}::{name}"))
        db.conn.execute(
            """INSERT INTO variables (id, name, scope, kind, type_hint, language, description)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(name, scope, language) DO UPDATE SET
                 last_seen = datetime('now'),
                 removed_at = NULL,
                 type_hint = COALESCE(excluded.type_hint, type_hint),
                 description = COALESCE(excluded.description, description)""",
            (var_id, name, scope, kind, type_hint, language, description),
        )

        row = db.conn.execute(
            "SELECT id FROM variables WHERE name = ? AND scope = ? AND language = ?",
            (name, scope, language),
        ).fetchone()
        if not row:
            continue

        canonical_id = row[0]
        db.conn.execute(
            """INSERT OR IGNORE INTO variable_references
               (variable_id, engram_id, filepath, line_number, context, ref_type)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (canonical_id, engram_id, filepath, line, ctx, "define"),
        )
        new_map[name] = {"id": canonical_id, "kind": kind, "type_hint": type_hint}

    # Variables that were in this engram last time but aren't anymore
    disappeared = set(old_map) - set(new_map)
    appeared = set(new_map) - set(old_map)

    removed_count = 0
    for name in disappeared:
        vid = old_map[name]["id"]
        remaining = db.conn.execute(
            "SELECT COUNT(*) FROM variable_references WHERE variable_id = ?",
            (vid,),
        ).fetchone()[0]
        if remaining == 0:
            db.conn.execute(
                "UPDATE variables SET removed_at = datetime('now') WHERE id = ? AND removed_at IS NULL",
                (vid,),
            )
            removed_count += 1

    # Likely renames: same kind + same type_hint, old gone, new arrived in same file
    rename_count = 0
    for old_name in disappeared:
        om = old_map[old_name]
        for new_name in appeared:
            nm = new_map[new_name]
            if om["kind"] != nm["kind"]:
                continue
            if (om["type_hint"] or "") != (nm["type_hint"] or ""):
                continue
            db.conn.execute(
                """INSERT OR IGNORE INTO variable_renames
                   (old_name, new_name, language, kind, type_hint, engram_id, filepath)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (old_name, new_name, language, om["kind"], om["type_hint"], engram_id, filepath),
            )
            rename_count += 1

    db.conn.commit()
    logger.debug(
        "Tracked {} vars from {} (+{} added, -{} removed, ~{} renames)",
        len(variables), filepath, len(appeared), removed_count, rename_count,
    )
    return {
        "tracked": len(variables),
        "added": len(appeared),
        "removed": removed_count,
        "renamed": rename_count,
    }


def find_variable(db: Database, name: str) -> dict | None:
    """Look up a variable by name. Returns definition + all references."""
    row = db.conn.execute(
        """SELECT id, name, scope, kind, type_hint, language, description,
                  first_seen, last_seen, removed_at
           FROM variables WHERE name = ? COLLATE NOCASE
           ORDER BY (removed_at IS NULL) DESC, last_seen DESC LIMIT 1""",
        (name,),
    ).fetchone()

    if not row:
        return {"found": False, "name": name, "message": f"Variable '{name}' not found"}

    var_id = row[0]
    variable = {
        "found": True,
        "id": var_id,
        "name": row[1],
        "scope": row[2],
        "kind": row[3],
        "type_hint": row[4],
        "language": row[5],
        "description": row[6],
        "first_seen": row[7],
        "last_seen": row[8],
        "removed_at": row[9],
        "status": "removed" if row[9] else "live",
    }

    # Surface any detected renames where this was the old or new name
    renames = db.conn.execute(
        """SELECT old_name, new_name, filepath, detected_at
           FROM variable_renames
           WHERE (old_name = ? OR new_name = ?) COLLATE NOCASE
           ORDER BY detected_at DESC LIMIT 5""",
        (row[1], row[1]),
    ).fetchall()
    variable["rename_candidates"] = [
        {"old_name": r[0], "new_name": r[1], "filepath": r[2], "detected_at": r[3]}
        for r in renames
    ]

    # Get all references
    refs = db.conn.execute(
        """SELECT r.filepath, r.line_number, r.context, r.ref_type, e.title
           FROM variable_references r
           JOIN engrams e ON e.id = r.engram_id
           WHERE r.variable_id = ?
           ORDER BY r.line_number ASC""",
        (var_id,),
    ).fetchall()

    variable["references"] = [
        {
            "filepath": r[0],
            "line": r[1],
            "context": r[2],
            "type": r[3],
            "source_note": r[4],
        }
        for r in refs
    ]

    return variable


def list_variables(
    db: Database,
    language: str | None = None,
    kind: str | None = None,
    status: str = "live",
    limit: int = 100,
) -> list[dict]:
    """List tracked variables. status ∈ {'live', 'removed', 'all'}."""
    conditions = []
    params: list = []

    if status == "live":
        conditions.append("removed_at IS NULL")
    elif status == "removed":
        conditions.append("removed_at IS NOT NULL")

    if language:
        conditions.append("language = ?")
        params.append(language)
    if kind:
        conditions.append("kind = ?")
        params.append(kind)

    where = " AND ".join(conditions) if conditions else "1=1"
    params.append(limit)

    rows = db.conn.execute(
        f"""SELECT name, scope, kind, type_hint, language, description, last_seen, removed_at,
                   (SELECT COUNT(*) FROM variable_references WHERE variable_id = variables.id) as ref_count
            FROM variables
            WHERE {where}
            ORDER BY ref_count DESC, last_seen DESC
            LIMIT ?""",
        params,
    ).fetchall()

    return [
        {
            "name": r[0],
            "scope": r[1],
            "kind": r[2],
            "type_hint": r[3],
            "language": r[4],
            "description": r[5],
            "last_seen": r[6],
            "removed_at": r[7],
            "status": "removed" if r[7] else "live",
            "reference_count": r[8],
        }
        for r in rows
    ]


def find_renames(db: Database, limit: int = 50) -> list[dict]:
    """Return detected rename candidates (old_name → new_name, same kind + type)."""
    rows = db.conn.execute(
        """SELECT r.old_name, r.new_name, r.language, r.kind, r.type_hint,
                  r.filepath, r.detected_at, r.confirmed
           FROM variable_renames r
           ORDER BY r.detected_at DESC LIMIT ?""",
        (limit,),
    ).fetchall()
    return [
        {
            "old_name": r[0],
            "new_name": r[1],
            "language": r[2],
            "kind": r[3],
            "type_hint": r[4],
            "filepath": r[5],
            "detected_at": r[6],
            "confirmed": bool(r[7]),
        }
        for r in rows
    ]


def variable_stats(db: Database) -> dict:
    """Overall counts: live, removed, per language, renames pending."""
    total = db.conn.execute("SELECT COUNT(*) FROM variables").fetchone()[0]
    live = db.conn.execute("SELECT COUNT(*) FROM variables WHERE removed_at IS NULL").fetchone()[0]
    removed = total - live
    by_lang = db.conn.execute(
        """SELECT language, COUNT(*) FROM variables
           WHERE removed_at IS NULL GROUP BY language ORDER BY 2 DESC"""
    ).fetchall()
    renames_pending = db.conn.execute(
        "SELECT COUNT(*) FROM variable_renames WHERE confirmed = 0"
    ).fetchone()[0]
    return {
        "total": total,
        "live": live,
        "removed": removed,
        "by_language": {r[0]: r[1] for r in by_lang},
        "renames_pending": renames_pending,
    }


def search_variables(db: Database, pattern: str, limit: int = 20) -> list[dict]:
    """Fuzzy search variables by name pattern."""
    rows = db.conn.execute(
        """SELECT name, scope, kind, type_hint, language, description,
                  (SELECT COUNT(*) FROM variable_references WHERE variable_id = variables.id) as ref_count
           FROM variables
           WHERE name LIKE ? COLLATE NOCASE
           ORDER BY ref_count DESC LIMIT ?""",
        (f"%{pattern}%", limit),
    ).fetchall()

    return [
        {
            "name": r[0],
            "scope": r[1],
            "kind": r[2],
            "type_hint": r[3],
            "language": r[4],
            "description": r[5],
            "reference_count": r[6],
        }
        for r in rows
    ]
