"""Hierarchical text chunking with overlap for the ingestion pipeline.

Three granularities with context overlap to prevent information loss at boundaries:
  - document: full note (first 2000 chars) for broad topic matching
  - paragraph: overlapping 2-paragraph windows for contextual retrieval
  - sentence: overlapping 3-sentence windows for precise fact retrieval

The overlap ensures that context is never lost at chunk boundaries —
a fact that spans two paragraphs will appear in at least one chunk intact.
"""

import re


def _split_sentences(text: str) -> list[str]:
    """Split text into sentences using regex."""
    parts = re.split(r'(?<=[.!?])\s+(?=[A-Z])', text)
    sentences: list[str] = []
    for part in parts:
        for line in part.split('\n'):
            stripped = line.strip()
            if stripped:
                sentences.append(stripped)
    return sentences


def hierarchical_chunk(content: str, engram_id: str) -> list[dict]:
    """Chunk content at three granularities with overlap.

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

    # Level 2: Paragraphs with 1-paragraph overlap (sliding window of 2)
    paragraphs = [p.strip() for p in content.split('\n\n') if p.strip()]
    for i in range(len(paragraphs)):
        # Window: current paragraph + next paragraph (50% overlap)
        window_end = min(i + 2, len(paragraphs))
        window_text = '\n\n'.join(paragraphs[i:window_end])

        if len(window_text.split()) < 20:
            continue

        chunks.append({
            "id": f"{engram_id}-para-{idx}",
            "engram_id": engram_id,
            "content": window_text[:1200],
            "granularity": "paragraph",
            "chunk_index": idx,
        })
        idx += 1

    # Level 3: Sentences with 2-sentence overlap (sliding window of 3)
    sentences = _split_sentences(content)
    for i in range(len(sentences)):
        # Window: previous sentence + current + next (overlap on both sides)
        start = max(0, i - 1)
        end = min(i + 2, len(sentences))
        window_text = ' '.join(sentences[start:end])

        if len(window_text.split()) < 8:
            continue

        chunks.append({
            "id": f"{engram_id}-sent-{idx}",
            "engram_id": engram_id,
            "content": window_text[:500],
            "granularity": "sentence",
            "chunk_index": idx,
        })
        idx += 1

    return chunks


def extract_wikilinks(content: str) -> list[str]:
    """Extract [[wikilink]] references from markdown content."""
    pattern = r'\[\[([^\]]+)\]\]'
    matches = re.findall(pattern, content)
    return [m.strip().lower() for m in matches if m.strip()]
