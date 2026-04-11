"""Three-granularity text chunking for the ingestion pipeline.

Produces document, paragraph, and sentence level chunks from markdown content.
Each granularity serves a different retrieval need:
  - document: broad topic matching
  - paragraph: contextual retrieval
  - sentence: precise fact retrieval
"""

import re
import uuid


def _split_sentences(text: str) -> list[str]:
    """Split text into sentences using regex. Handles common abbreviations."""
    # Split on period/question/exclamation followed by space and uppercase letter
    # Also split on newlines
    parts = re.split(r'(?<=[.!?])\s+(?=[A-Z])', text)
    sentences: list[str] = []
    for part in parts:
        # Further split on newlines
        for line in part.split('\n'):
            stripped = line.strip()
            if stripped:
                sentences.append(stripped)
    return sentences


def hierarchical_chunk(content: str, engram_id: str) -> list[dict]:
    """Chunk content at three granularities.

    Returns a list of chunk dicts with:
      id, engram_id, content, granularity, chunk_index
    """
    chunks: list[dict] = []
    idx = 0

    # Level 1: Document — first 2000 chars for broad matching
    doc_text = content[:2000].strip()
    if doc_text:
        chunks.append({
            "id": f"{engram_id}-doc-0",
            "engram_id": engram_id,
            "content": doc_text,
            "granularity": "document",
            "chunk_index": idx,
        })
        idx += 1

    # Level 2: Paragraphs — split on double newline, min 20 words
    paragraphs = content.split('\n\n')
    for p in paragraphs:
        text = p.strip()
        # Skip headings-only paragraphs and short fragments
        if len(text.split()) < 20:
            continue
        chunks.append({
            "id": f"{engram_id}-para-{idx}",
            "engram_id": engram_id,
            "content": text[:1000],  # cap paragraph chunks
            "granularity": "paragraph",
            "chunk_index": idx,
        })
        idx += 1

    # Level 3: Sentences — min 8 words for meaningful facts
    sentences = _split_sentences(content)
    for s in sentences:
        if len(s.split()) < 8:
            continue
        chunks.append({
            "id": f"{engram_id}-sent-{idx}",
            "engram_id": engram_id,
            "content": s[:500],
            "granularity": "sentence",
            "chunk_index": idx,
        })
        idx += 1

    return chunks


def extract_wikilinks(content: str) -> list[str]:
    """Extract [[wikilink]] references from markdown content.

    Returns a list of referenced note titles (lowercased, trimmed).
    """
    pattern = r'\[\[([^\]]+)\]\]'
    matches = re.findall(pattern, content)
    return [m.strip().lower() for m in matches if m.strip()]
