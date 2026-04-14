"""Code-aware ingestion for any programming project.

Handles 30+ language file extensions via regex-based structure extraction
(no tree-sitter dependency, no compile step). For each code file:

1. Extract module-level docstring/comment (used as summary)
2. Extract functions/classes + their docstrings/comments
3. Extract TODO/FIXME/HACK/WHY/XXX/NOTE markers as rationale memories
4. Create a Source engram for the file + Quote engrams for each marker
5. Auto-classify kind: source (file) vs snippet (code block) vs todo (marker)

Inspired by Graphify's code extraction but without the tree-sitter deps.
Works across Python, JS/TS, Rust, Go, Java, C/C++, Ruby, PHP, etc.
"""

import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from loguru import logger

from engram_server.database import Database
from engram_server.embeddings import Embedder


# Languages we understand via file extension
LANGUAGE_EXTENSIONS: dict[str, str] = {
    ".py": "python",
    ".pyw": "python",
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".kt": "kotlin",
    ".kts": "kotlin",
    ".scala": "scala",
    ".rb": "ruby",
    ".php": "php",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".hpp": "cpp",
    ".cs": "csharp",
    ".swift": "swift",
    ".m": "objc",
    ".lua": "lua",
    ".zig": "zig",
    ".ex": "elixir",
    ".exs": "elixir",
    ".jl": "julia",
    ".ps1": "powershell",
    ".sh": "shell",
    ".bash": "shell",
    ".zsh": "shell",
    ".fish": "shell",
    ".sql": "sql",
    ".r": "r",
    ".dart": "dart",
    ".vue": "vue",
    ".svelte": "svelte",
    ".toml": "toml",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".json": "json",
    ".md": "markdown",
    ".mdx": "markdown",
    ".rst": "rst",
    ".tex": "latex",
}

# Marker comment patterns — picks up TODO/FIXME/HACK/XXX/NOTE/WHY
MARKER_PATTERN = re.compile(
    r"(?://|#|<!--|/\*|\*)\s*(TODO|FIXME|HACK|XXX|NOTE|WHY|WARNING|BUG|OPTIMIZE|REFACTOR)(\s*[:\-]\s*|\s+)(.+?)(?:\*/|-->|$)",
    re.IGNORECASE | re.MULTILINE,
)

# Python/JS/TS function definition patterns
FUNCTION_PATTERNS: dict[str, list[re.Pattern]] = {
    "python": [
        re.compile(r"^\s*def\s+(\w+)\s*\(", re.MULTILINE),
        re.compile(r"^\s*async\s+def\s+(\w+)\s*\(", re.MULTILINE),
        re.compile(r"^\s*class\s+(\w+)", re.MULTILINE),
    ],
    "javascript": [
        re.compile(r"function\s+(\w+)\s*\("),
        re.compile(r"(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(", re.MULTILINE),
        re.compile(r"(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?function", re.MULTILINE),
        re.compile(r"class\s+(\w+)"),
    ],
    "typescript": [
        re.compile(r"function\s+(\w+)\s*[\(<]"),
        re.compile(r"(?:const|let|var)\s+(\w+)\s*[:=]", re.MULTILINE),
        re.compile(r"class\s+(\w+)"),
        re.compile(r"interface\s+(\w+)"),
        re.compile(r"type\s+(\w+)\s*="),
        re.compile(r"export\s+function\s+(\w+)"),
    ],
    "rust": [
        re.compile(r"fn\s+(\w+)\s*[\(<]"),
        re.compile(r"struct\s+(\w+)"),
        re.compile(r"enum\s+(\w+)"),
        re.compile(r"trait\s+(\w+)"),
        re.compile(r"impl\s+(\w+)"),
    ],
    "go": [
        re.compile(r"func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\("),
        re.compile(r"type\s+(\w+)\s+(?:struct|interface)"),
    ],
    "java": [
        re.compile(r"(?:public|private|protected|static|\s)+(?:[\w<>\[\]]+\s+)+(\w+)\s*\("),
        re.compile(r"(?:public|private)\s+(?:abstract\s+)?class\s+(\w+)"),
        re.compile(r"interface\s+(\w+)"),
    ],
}

# Files we skip (binary, vendored, generated)
SKIP_DIRS = {
    ".git", ".svn", ".hg", "node_modules", "venv", ".venv", "__pycache__",
    "target", "build", "dist", "out", ".next", ".nuxt", ".cache", ".pytest_cache",
    "coverage", ".coverage", ".idea", ".vscode", ".DS_Store", ".tox",
    "vendor", "bower_components",
}

SKIP_FILES = {
    ".min.js", ".min.css", ".bundle.js", ".lock",
    "package-lock.json", "yarn.lock", "Cargo.lock", "poetry.lock", "uv.lock",
}


def language_for(filepath: Path) -> str | None:
    """Return the language name for a file path, or None if not code."""
    return LANGUAGE_EXTENSIONS.get(filepath.suffix.lower())


def should_skip(filepath: Path) -> bool:
    """Check if we should skip this path (binary, vendored, etc.)."""
    parts = set(filepath.parts)
    if parts & SKIP_DIRS:
        return True
    if filepath.name in SKIP_FILES:
        return True
    if any(filepath.name.endswith(s) for s in SKIP_FILES):
        return True
    # Skip files > 500KB (likely minified or binary)
    try:
        if filepath.stat().st_size > 500_000:
            return True
    except OSError:
        return True
    return False


def extract_markers(content: str, language: str) -> list[dict]:
    """Extract TODO/FIXME/HACK/WHY/NOTE/etc markers from code.

    Returns a list of dicts: {type, text, line_number, context}
    """
    markers: list[dict] = []
    for match in MARKER_PATTERN.finditer(content):
        marker_type = match.group(1).upper()
        text = match.group(3).strip()
        # Clean up trailing */ or --> that might have slipped through
        text = re.sub(r"\s*(?:\*/|-->)$", "", text).strip()
        if not text or len(text) < 3:
            continue

        # Find the line number (1-indexed)
        line_number = content[: match.start()].count("\n") + 1

        # Grab 2 lines before + 2 lines after for context
        lines = content.split("\n")
        start = max(0, line_number - 3)
        end = min(len(lines), line_number + 2)
        context = "\n".join(lines[start:end])

        markers.append({
            "type": marker_type,
            "text": text[:300],
            "line_number": line_number,
            "context": context[:500],
        })

    return markers


def extract_functions(content: str, language: str) -> list[str]:
    """Extract function/class/type names from code."""
    patterns = FUNCTION_PATTERNS.get(language, [])
    names: set[str] = set()
    for pattern in patterns:
        for match in pattern.finditer(content):
            name = match.group(1)
            if name and len(name) > 1 and not name.startswith("_"):
                names.add(name)
    return sorted(names)[:30]


def extract_imports(content: str, language: str) -> list[str]:
    """Extract import statements — reveals the dependency graph."""
    imports: list[str] = []

    if language == "python":
        for match in re.finditer(
            r"^(?:from\s+([\w\.]+)\s+import|import\s+([\w\.]+))",
            content,
            re.MULTILINE,
        ):
            name = match.group(1) or match.group(2)
            if name:
                imports.append(name.split(".")[0])

    elif language in ("javascript", "typescript"):
        for match in re.finditer(
            r"""(?:import\s+.*?\s+from\s+['"]([^'"]+)['"]|require\(['"]([^'"]+)['"]\))""",
            content,
        ):
            name = match.group(1) or match.group(2)
            if name:
                imports.append(name)

    elif language == "rust":
        for match in re.finditer(r"^use\s+([\w:]+)", content, re.MULTILINE):
            imports.append(match.group(1).split("::")[0])

    elif language == "go":
        for match in re.finditer(r'"([^"]+)"', content):
            name = match.group(1)
            if "/" in name or not name.startswith(("http://", "https://")):
                imports.append(name)

    elif language == "java":
        for match in re.finditer(r"^import\s+([\w\.]+);", content, re.MULTILINE):
            imports.append(match.group(1))

    return list(dict.fromkeys(imports))[:20]  # Unique, ordered, capped


def ingest_code_file(
    filepath: Path,
    vault_dir: Path,
    db: Database,
    embedder: Embedder,
    bm25,
    project_name: str = "",
) -> dict | None:
    """Ingest a single code file into the brain.

    Creates:
    - A Source engram with the file summary + structure
    - A TODO engram for each TODO/FIXME/HACK/WHY marker
    """
    from engram_server.ingest import ingest_file

    if should_skip(filepath):
        return None

    language = language_for(filepath)
    if language is None:
        return None

    try:
        content = filepath.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        logger.debug("Can't read {}: {}", filepath, e)
        return None

    if not content.strip():
        return None

    # Extract structure
    functions = extract_functions(content, language)
    imports = extract_imports(content, language)
    markers = extract_markers(content, language)

    # Build the Source note
    rel_path = filepath.name
    line_count = content.count("\n") + 1
    slug = re.sub(r"[^a-z0-9]+", "-", filepath.stem.lower())[:50].strip("-")
    short_id = uuid.uuid4().hex[:6]
    source_filename = f"source-{slug}-{short_id}.md"
    source_filepath = vault_dir / source_filename

    source_md_lines = [
        f"# {filepath.name}",
        "",
        f"**Type:** Code source",
        f"**Language:** {language}",
        f"**Path:** `{filepath}`",
        f"**Lines:** {line_count}",
    ]
    if project_name:
        source_md_lines.append(f"**Project:** {project_name}")

    if functions:
        source_md_lines.append("")
        source_md_lines.append("## Definitions")
        source_md_lines.append("")
        for fn in functions:
            source_md_lines.append(f"- `{fn}`")

    if imports:
        source_md_lines.append("")
        source_md_lines.append("## Imports")
        source_md_lines.append("")
        for imp in imports:
            source_md_lines.append(f"- `{imp}`")

    if markers:
        source_md_lines.append("")
        source_md_lines.append("## Markers")
        source_md_lines.append("")
        for m in markers[:15]:
            source_md_lines.append(f"- **{m['type']}** (line {m['line_number']}): {m['text']}")

    # Include first ~1000 chars of the actual code as a reference
    source_md_lines.append("")
    source_md_lines.append("## Excerpt")
    source_md_lines.append("")
    source_md_lines.append(f"```{language}")
    source_md_lines.append(content[:1200])
    if len(content) > 1200:
        source_md_lines.append("...")
    source_md_lines.append("```")

    source_filepath.write_text("\n".join(source_md_lines), encoding="utf-8")
    source_engram_id = ingest_file(source_filepath, db, embedder, bm25)

    # Track variables/functions/classes from this file
    if source_engram_id:
        try:
            from engram_server.variable_tracker import track_variables
            track_variables(db, source_engram_id, str(filepath), content, language)
        except Exception as e:
            logger.debug("Variable tracking failed for {}: {}", filepath, e)
        try:
            from engram_server.call_graph import track_calls
            track_calls(db, source_engram_id, str(filepath), content, language)
        except Exception as e:
            logger.debug("Call graph tracking failed for {}: {}", filepath, e)

    # Create a todo/hack/note memory for each marker
    marker_count = 0
    for m in markers:
        marker_id = str(uuid.uuid4())
        marker_short = marker_id[:8]
        marker_slug = re.sub(r"[^a-z0-9]+", "-", m["text"][:30].lower()).strip("-")
        marker_filename = f"todo-{marker_slug}-{marker_short}.md"
        marker_filepath = vault_dir / marker_filename

        marker_md = (
            f"# {m['type']}: {m['text'][:60]}\n"
            f"\n"
            f"**Source:** [[{filepath.name}]]\n"
            f"**Line:** {m['line_number']}\n"
            f"**Type:** {m['type']}\n"
            f"\n"
            f"## Note\n"
            f"\n"
            f"> {m['text']}\n"
            f"\n"
            f"## Context\n"
            f"\n"
            f"```{language}\n"
            f"{m['context']}\n"
            f"```\n"
        )
        marker_filepath.write_text(marker_md, encoding="utf-8")
        ingest_file(marker_filepath, db, embedder, bm25)
        marker_count += 1

    logger.info(
        "Ingested {} ({} lines, {} defs, {} imports, {} markers)",
        filepath.name, line_count, len(functions), len(imports), marker_count,
    )

    return {
        "source_engram_id": source_engram_id,
        "filename": source_filename,
        "path": str(filepath),
        "language": language,
        "functions": len(functions),
        "imports": len(imports),
        "markers": marker_count,
        "lines": line_count,
    }


def ingest_repo(
    repo_path: Path,
    vault_dir: Path,
    db: Database,
    embedder: Embedder,
    bm25,
    max_files: int = 500,
) -> dict:
    """Walk a repository and ingest all code files.

    Respects SKIP_DIRS and SKIP_FILES. Caps at max_files to avoid runaway ingestion.
    """
    if not repo_path.exists() or not repo_path.is_dir():
        return {"error": f"Not a directory: {repo_path}"}

    project_name = repo_path.name
    ingested = 0
    skipped = 0
    errors = 0
    markers_total = 0

    logger.info("Scanning repo: {}", repo_path)

    for filepath in repo_path.rglob("*"):
        if ingested >= max_files:
            logger.warning("Hit max_files cap: {}", max_files)
            break

        if not filepath.is_file():
            continue

        if should_skip(filepath):
            skipped += 1
            continue

        if language_for(filepath) is None:
            skipped += 1
            continue

        try:
            result = ingest_code_file(
                filepath, vault_dir, db, embedder, bm25, project_name=project_name
            )
            if result:
                ingested += 1
                markers_total += result.get("markers", 0)
            else:
                skipped += 1
        except Exception as e:
            logger.warning("Failed on {}: {}", filepath, e)
            errors += 1

    return {
        "status": "ok",
        "project": project_name,
        "ingested": ingested,
        "skipped": skipped,
        "errors": errors,
        "total_markers": markers_total,
    }


def find_todos(
    db: Database,
    marker_type: str | None = None,
    limit: int = 50,
) -> list[dict]:
    """Find all TODO/FIXME/HACK/etc markers in the brain.

    Optionally filter by marker type. Useful for reviewing open work items.
    """
    query = """
        SELECT e.id, e.title, e.content, e.updated_at
        FROM engrams e
        WHERE e.filename LIKE 'todo-%' AND e.state != 'dormant'
        ORDER BY e.updated_at DESC
        LIMIT ?
    """

    rows = db.conn.execute(query, (limit * 2 if marker_type else limit,)).fetchall()

    results: list[dict] = []
    for r in rows:
        eid, title, content, updated = r[0], r[1], r[2], r[3]
        # Extract marker type from title ("TODO: something" or "FIXME: ...")
        title_upper = title.upper()
        detected_type = None
        for mt in ("TODO", "FIXME", "HACK", "XXX", "NOTE", "WHY", "WARNING", "BUG", "OPTIMIZE", "REFACTOR"):
            if title_upper.startswith(mt + ":"):
                detected_type = mt
                break

        if marker_type and detected_type != marker_type.upper():
            continue

        # Pull the quoted text (line after "> ")
        quote_match = re.search(r"^>\s*(.+)$", content, re.MULTILINE)
        text = quote_match.group(1) if quote_match else title

        # Pull the source filename
        source_match = re.search(r"\*\*Source:\*\*\s*\[\[(.+?)\]\]", content)
        source = source_match.group(1) if source_match else None

        line_match = re.search(r"\*\*Line:\*\*\s*(\d+)", content)
        line = int(line_match.group(1)) if line_match else None

        results.append({
            "engram_id": eid,
            "type": detected_type or "TODO",
            "text": text,
            "source": source,
            "line": line,
            "updated_at": updated,
        })

        if len(results) >= limit:
            break

    return results
