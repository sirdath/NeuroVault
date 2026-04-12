"""PDF ingestion for academic papers — the dissertation killer feature.

Uses PyMuPDF (fitz) to:
1. Extract full text from PDFs
2. Extract highlight annotations as separate Quote engrams
3. Capture page numbers, colors, and surrounding context
4. Link Quotes back to the parent Source paper
5. Make every highlight semantically searchable

The key insight: a researcher's highlights ARE their research database.
After ingesting their PDFs, they can ask "what did I highlight about X?"
and get answers from across their entire reading history.
"""

import re
import uuid
from pathlib import Path

from loguru import logger

from engram_server.database import Database
from engram_server.embeddings import Embedder


# Highlight color → category mapping (researchers' convention)
COLOR_CATEGORIES = {
    "yellow": "important",
    "green": "quote",
    "blue": "concept",
    "red": "disagree",
    "orange": "key",
    "pink": "method",
    "purple": "related",
}


def ingest_pdf(
    pdf_path: Path,
    vault_dir: Path,
    db: Database,
    embedder: Embedder,
    bm25,
    raw_dir: Path | None = None,
) -> dict:
    """Ingest a PDF: create a Source note + extract all highlights as Quote notes.

    The original PDF is copied to raw/pdfs/ so the processed vault can be
    rebuilt from raw at any time. The vault is a projection of the raw data.
    """
    try:
        import fitz  # PyMuPDF
    except ImportError:
        return {"error": "PyMuPDF not installed. Run: uv add pymupdf"}

    if not pdf_path.exists() or pdf_path.suffix.lower() != ".pdf":
        return {"error": f"Not a PDF file: {pdf_path}"}

    from engram_server.ingest import ingest_file
    import shutil

    # Copy original to raw/pdfs/ if a raw_dir was provided and we're not already there
    archived_path = None
    if raw_dir is not None:
        pdfs_dir = raw_dir / "pdfs"
        pdfs_dir.mkdir(parents=True, exist_ok=True)
        archived_path = pdfs_dir / pdf_path.name
        if pdf_path.resolve() != archived_path.resolve() and not archived_path.exists():
            try:
                shutil.copy2(str(pdf_path), str(archived_path))
                logger.info("Archived PDF to raw: {}", archived_path.name)
            except Exception as e:
                logger.warning("Could not archive PDF: {}", e)

    doc = fitz.open(str(pdf_path))

    # Extract metadata
    metadata = doc.metadata or {}
    title = metadata.get("title", "").strip() or pdf_path.stem.replace("_", " ").replace("-", " ")
    author = metadata.get("author", "").strip()

    # Extract full text
    full_text_parts = []
    highlights: list[dict] = []

    for page_num, page in enumerate(doc, 1):
        # Get page text
        text = page.get_text()
        if text.strip():
            full_text_parts.append(text)

        # Extract highlight annotations
        for annot in page.annots() or []:
            if annot.type[0] == 8:  # Highlight annotation type
                color = _annotation_color_name(annot.colors.get("stroke") or annot.colors.get("fill"))
                category = COLOR_CATEGORIES.get(color, "highlight")

                # Get text under the highlight rectangle(s)
                quad_points = annot.vertices
                if quad_points and len(quad_points) >= 4:
                    highlight_text = ""
                    # Each highlight has groups of 4 points (one per highlighted region)
                    for i in range(0, len(quad_points), 4):
                        if i + 3 < len(quad_points):
                            quad = quad_points[i:i+4]
                            try:
                                rect = fitz.Quad(quad).rect
                                text_in_rect = page.get_textbox(rect).strip()
                                if text_in_rect:
                                    highlight_text += text_in_rect + " "
                            except Exception:
                                continue

                    highlight_text = highlight_text.strip()
                    if highlight_text and len(highlight_text) > 5:
                        highlights.append({
                            "text": highlight_text,
                            "page": page_num,
                            "color": color,
                            "category": category,
                            "comment": annot.info.get("content", "").strip(),
                        })

    doc.close()

    # Extract publication year from text or filename
    year = _extract_year(metadata.get("creationDate", "") + " " + " ".join(full_text_parts[:1]) + " " + pdf_path.stem)

    # Create the Source note
    source_id = str(uuid.uuid4())
    short_id = source_id[:8]
    slug = re.sub(r'[^a-z0-9]+', '-', title.lower())[:50].strip('-') or "paper"
    source_filename = f"source-{slug}-{short_id}.md"
    source_filepath = vault_dir / source_filename

    citekey = _generate_citekey(author, year, title)

    source_md_lines = [
        f"# {title}",
        "",
        f"**Type:** Source paper",
        f"**Citekey:** `{citekey}`",
    ]
    if author:
        source_md_lines.append(f"**Author:** {author}")
    if year:
        source_md_lines.append(f"**Year:** {year}")
    source_md_lines.append(f"**File:** `{pdf_path.name}`")
    source_md_lines.append(f"**Pages:** {doc.page_count if hasattr(doc, 'page_count') else len(full_text_parts)}")
    source_md_lines.append(f"**Highlights:** {len(highlights)}")
    source_md_lines.append("")
    source_md_lines.append("## Abstract")
    source_md_lines.append("")

    # Try to extract abstract (first 500 chars after a heading or first substantial paragraph)
    full_text = "\n".join(full_text_parts)
    abstract = _extract_abstract(full_text)
    source_md_lines.append(abstract or "_No abstract extracted_")
    source_md_lines.append("")

    if highlights:
        source_md_lines.append("## Highlights Summary")
        source_md_lines.append("")
        for h in highlights[:20]:  # Cap preview
            source_md_lines.append(f"- *p.{h['page']} ({h['category']}):* {h['text'][:200]}")
        source_md_lines.append("")

    source_filepath.write_text("\n".join(source_md_lines), encoding="utf-8")
    source_engram_id = ingest_file(source_filepath, db, embedder, bm25)

    # Create Quote notes for each highlight
    quote_count = 0
    for h in highlights:
        quote_id = str(uuid.uuid4())
        quote_short = quote_id[:8]
        quote_slug = re.sub(r'[^a-z0-9]+', '-', h["text"][:30].lower()).strip('-')
        quote_filename = f"quote-{quote_slug}-{quote_short}.md"
        quote_filepath = vault_dir / quote_filename

        quote_md = (
            f"# Quote: {h['text'][:60]}...\n"
            f"\n"
            f"**Source:** [[{title}]]\n"
            f"**Page:** {h['page']}\n"
            f"**Category:** {h['category']}\n"
            f"**Color:** {h['color']}\n"
            f"\n"
            f"## Quote\n"
            f"\n"
            f"> {h['text']}\n"
        )
        if h["comment"]:
            quote_md += f"\n## My note\n\n{h['comment']}\n"

        quote_filepath.write_text(quote_md, encoding="utf-8")
        ingest_file(quote_filepath, db, embedder, bm25)
        quote_count += 1

    logger.info("Ingested PDF: {} ({} highlights -> Quote notes)", title, quote_count)

    return {
        "source_engram_id": source_engram_id,
        "source_filename": source_filename,
        "title": title,
        "author": author,
        "year": year,
        "citekey": citekey,
        "highlights_extracted": quote_count,
        "page_count": len(full_text_parts),
    }


def _annotation_color_name(rgb: tuple | None) -> str:
    """Map an RGB tuple to a human-readable color name."""
    if not rgb or len(rgb) < 3:
        return "yellow"
    r, g, b = rgb[0], rgb[1], rgb[2]

    # Yellow: high R+G, low B
    if r > 0.7 and g > 0.7 and b < 0.4:
        return "yellow"
    # Green
    if g > 0.6 and r < 0.5:
        return "green"
    # Blue
    if b > 0.6 and r < 0.5:
        return "blue"
    # Red
    if r > 0.7 and g < 0.4 and b < 0.4:
        return "red"
    # Orange
    if r > 0.8 and g > 0.4 and b < 0.3:
        return "orange"
    # Pink
    if r > 0.8 and g < 0.5 and b > 0.5:
        return "pink"
    # Purple
    if r > 0.4 and r < 0.7 and b > 0.5:
        return "purple"
    return "yellow"


def _extract_year(text: str) -> str:
    """Find a 4-digit year in text (1900-2099)."""
    matches = re.findall(r'\b(19\d{2}|20\d{2})\b', text)
    if matches:
        return matches[0]
    return ""


def _extract_abstract(text: str) -> str:
    """Try to extract an abstract from the first part of a paper's text."""
    # Look for "Abstract" heading
    match = re.search(
        r'(?i)abstract[:\s]*\n+(.{100,1500}?)(?:\n\s*\n|introduction|keywords|1\.\s)',
        text,
        re.DOTALL,
    )
    if match:
        return match.group(1).strip().replace("\n", " ")[:1000]

    # Fallback: first substantial paragraph
    for para in text.split("\n\n"):
        para = para.strip()
        if 100 < len(para) < 1500:
            return para[:1000]

    return ""


def _generate_citekey(author: str, year: str, title: str) -> str:
    """Generate a BibTeX-style citekey: firstauthorYEARfirstword."""
    if not author and not year:
        return re.sub(r'[^a-z0-9]', '', title[:20].lower()) or "untitled"

    first_author = author.split(",")[0].split()[-1] if author else "anon"
    first_author = re.sub(r'[^a-zA-Z]', '', first_author).lower()

    first_title_word = ""
    if title:
        for word in title.split():
            clean = re.sub(r'[^a-zA-Z]', '', word)
            if len(clean) > 3:
                first_title_word = clean.lower()
                break

    return f"{first_author}{year or 'nd'}{first_title_word}"
