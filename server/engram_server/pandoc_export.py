"""Pandoc export pipeline — turn notes into formatted documents.

Converts markdown notes (or stitched drafts) into DOCX, PDF, HTML, LaTeX, etc.
Requires `pandoc` on PATH. Citations handled via the standard Pandoc Citeproc
pipeline: resolve @citekey references against a bundled bibliography.

Supported output formats: docx, pdf, html, latex, epub, markdown, rst
Supported citation styles: any CSL file (user-provided or bundled).
"""

import shutil
import subprocess
import tempfile
import uuid
from datetime import datetime
from pathlib import Path

from loguru import logger


SUPPORTED_FORMATS = {"docx", "pdf", "html", "latex", "epub", "md", "rst", "odt"}


def check_pandoc_installed() -> dict:
    """Check if pandoc is available and return version info."""
    pandoc = shutil.which("pandoc")
    if not pandoc:
        return {"installed": False, "error": "pandoc not found on PATH"}

    try:
        result = subprocess.run(
            [pandoc, "--version"], capture_output=True, text=True, timeout=5
        )
        version_line = result.stdout.split("\n")[0]
        return {"installed": True, "path": pandoc, "version": version_line}
    except Exception as e:
        return {"installed": False, "error": str(e)}


def export_note(
    content: str,
    output_format: str,
    output_path: Path | None = None,
    title: str = "",
    author: str = "",
    csl: str | None = None,
    bibliography: Path | None = None,
) -> dict:
    """Export markdown content to a given format via Pandoc.

    Args:
        content: The markdown content to convert
        output_format: docx/pdf/html/latex/epub/md/rst/odt
        output_path: Where to save the output (temp file if None)
        title: Document title for metadata
        author: Document author for metadata
        csl: Path to a CSL file for citations (e.g. "chicago-author-date.csl")
        bibliography: Path to a .bib file for resolving @citekey references

    Returns:
        {"status", "output_path", "size_bytes"} or {"error"}
    """
    check = check_pandoc_installed()
    if not check["installed"]:
        return {
            "error": check.get("error", "pandoc not installed"),
            "hint": "Install pandoc: https://pandoc.org/installing.html",
        }

    output_format = output_format.lower().lstrip(".")
    if output_format not in SUPPORTED_FORMATS:
        return {
            "error": f"Unsupported format: {output_format}",
            "supported": sorted(SUPPORTED_FORMATS),
        }

    if output_path is None:
        tmp_dir = Path(tempfile.gettempdir()) / "neurovault-exports"
        tmp_dir.mkdir(parents=True, exist_ok=True)
        output_path = tmp_dir / f"export-{uuid.uuid4().hex[:8]}.{output_format}"

    # Write markdown to a temp input file
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".md", delete=False, encoding="utf-8"
    ) as tmp_in:
        if title or author:
            tmp_in.write("---\n")
            if title:
                tmp_in.write(f"title: {title}\n")
            if author:
                tmp_in.write(f"author: {author}\n")
            tmp_in.write(f"date: {datetime.now().strftime('%Y-%m-%d')}\n")
            tmp_in.write("---\n\n")
        tmp_in.write(content)
        input_path = Path(tmp_in.name)

    cmd = ["pandoc", str(input_path), "-o", str(output_path), "--from", "markdown"]

    if output_format == "pdf":
        # PDF requires a LaTeX engine; try xelatex, fall back to html if missing
        if not shutil.which("xelatex") and not shutil.which("pdflatex"):
            # Fallback: export HTML (user can print to PDF from browser)
            output_path = output_path.with_suffix(".html")
            cmd[-3] = str(output_path)
            output_format = "html"

    # Citations
    if bibliography and bibliography.exists():
        cmd.extend(["--citeproc", "--bibliography", str(bibliography)])
    if csl:
        cmd.extend(["--csl", csl])

    # Standalone output for formats that need a full document
    if output_format in {"html", "latex", "docx"}:
        cmd.append("--standalone")

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            return {
                "error": "Pandoc failed",
                "stderr": result.stderr[:500],
                "cmd": " ".join(cmd),
            }
    except subprocess.TimeoutExpired:
        return {"error": "Pandoc timeout (>30s)"}
    finally:
        try:
            input_path.unlink()
        except Exception:
            pass

    if not output_path.exists():
        return {"error": "Pandoc returned 0 but output file missing"}

    return {
        "status": "ok",
        "output_path": str(output_path),
        "size_bytes": output_path.stat().st_size,
        "format": output_format,
    }


def export_note_by_id(
    engram_id: str,
    output_format: str,
    db,
    **kwargs,
) -> dict:
    """Export a single engram by ID."""
    engram = db.get_engram(engram_id)
    if not engram:
        return {"error": f"Engram not found: {engram_id}"}

    return export_note(
        content=engram["content"],
        output_format=output_format,
        title=engram["title"],
        **kwargs,
    )


def export_draft(
    draft_id: str,
    output_format: str,
    db,
    **kwargs,
) -> dict:
    """Export a full Draft (ordered collection of engrams) as one document.

    Sections are stitched in order, separated by blank lines.
    """
    draft = db.conn.execute(
        "SELECT id, title, description FROM drafts WHERE id = ?", (draft_id,)
    ).fetchone()
    if not draft:
        return {"error": f"Draft not found: {draft_id}"}

    sections = db.conn.execute(
        """SELECT e.title, e.content, ds.position
           FROM draft_sections ds
           JOIN engrams e ON e.id = ds.engram_id
           WHERE ds.draft_id = ? AND e.state != 'dormant'
           ORDER BY ds.position ASC""",
        (draft_id,),
    ).fetchall()

    if not sections:
        return {"error": "Draft has no sections"}

    parts = [f"# {draft[1]}"]  # Draft title
    if draft[2]:
        parts.append(draft[2] + "\n")

    for section in sections:
        parts.append(section[1])
        parts.append("")

    content = "\n\n".join(parts)
    return export_note(
        content=content,
        output_format=output_format,
        title=draft[1],
        **kwargs,
    )
