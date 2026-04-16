"""Hierarchical text chunking v3 — contextual embeddings with overlap.

Key insight: chunks must carry their parent context. A sentence like
"It uses Tauri 2.0" means nothing without knowing it's from "Tauri Development Setup".

Each chunk is prefixed with the note title before embedding, so the semantic model
knows the topic context. This is the #1 retrieval quality improvement.

Three granularities with overlap:
  - document: title + full note (first 2000 chars)
  - paragraph: title + overlapping 2-paragraph windows
  - sentence: title + overlapping 3-sentence windows
"""

import re


def _split_sentences(text: str) -> list[str]:
    """Split text into sentences."""
    parts = re.split(r'(?<=[.!?])\s+(?=[A-Z])', text)
    sentences: list[str] = []
    for part in parts:
        for line in part.split('\n'):
            stripped = line.strip()
            if stripped:
                sentences.append(stripped)
    return sentences


def _extract_title(content: str) -> str:
    """Extract title from the first markdown heading."""
    for line in content.split('\n'):
        stripped = line.strip()
        if stripped.startswith('# '):
            return stripped[2:].strip()
    return ""


def hierarchical_chunk(content: str, engram_id: str) -> list[dict]:
    """Chunk content at three granularities with title context and overlap.

    CRITICAL: The 'embed_text' field is what gets embedded (title-prefixed).
    The 'content' field is the raw text for display/BM25.
    """
    chunks: list[dict] = []
    idx = 0
    title = _extract_title(content)
    title_prefix = f"{title}: " if title else ""

    # Strip the title line from content for chunking (avoid double-counting)
    body = content
    for line in content.split('\n'):
        if line.strip().startswith('# '):
            body = content[len(line):].strip()
            break

    # Level 1: Document — title + first 2000 chars
    doc_text = content[:2000].strip()
    if doc_text:
        chunks.append({
            "id": f"{engram_id}-doc-0",
            "engram_id": engram_id,
            "content": doc_text,
            "embed_text": f"{title_prefix}{doc_text}",
            "granularity": "document",
            "chunk_index": idx,
        })
        idx += 1

    # Level 2: Paragraphs — title + sliding window of 2 paragraphs
    paragraphs = [p.strip() for p in body.split('\n\n') if p.strip()]
    for i in range(len(paragraphs)):
        window_end = min(i + 2, len(paragraphs))
        window_text = '\n\n'.join(paragraphs[i:window_end])

        if len(window_text.split()) < 15:
            continue

        chunks.append({
            "id": f"{engram_id}-para-{idx}",
            "engram_id": engram_id,
            "content": window_text[:1200],
            "embed_text": f"{title_prefix}{window_text[:1200]}",
            "granularity": "paragraph",
            "chunk_index": idx,
        })
        idx += 1

    # Level 3: Sentences — title + sliding window of 3 sentences
    sentences = _split_sentences(body)
    for i in range(len(sentences)):
        start = max(0, i - 1)
        end = min(i + 2, len(sentences))
        window_text = ' '.join(sentences[start:end])

        if len(window_text.split()) < 6:
            continue

        chunks.append({
            "id": f"{engram_id}-sent-{idx}",
            "engram_id": engram_id,
            "content": window_text[:500],
            "embed_text": f"{title_prefix}{window_text[:500]}",
            "granularity": "sentence",
            "chunk_index": idx,
        })
        idx += 1

    return chunks


def extract_wikilinks(content: str) -> list[str]:
    """Extract [[wikilink]] references from markdown content.

    Returns a flat list of lowercased target names. For typed links like
    ``[[Target|uses]]`` this returns just the target (``"target"``).
    Use `extract_typed_wikilinks()` when you need the link types.
    """
    return [target for target, _type in extract_typed_wikilinks(content)]


# Allowed typed-link vocabulary. Unknown types are logged as warnings
# (not hard errors) so authors can experiment, but the canonical set
# is what the graph UI colorizes and the compiler uses for traversal.
LINK_TYPES = frozenset({
    "works_at",
    "uses",
    "extends",
    "depends_on",
    "supersedes",
    "contradicts",
    "mentions",
    "defines",
    "part_of",
    "caused_by",
})

# Regex: [[Target]] or [[Target|link_type]]
_WIKILINK_RE = re.compile(r'\[\[([^\]|]+)(?:\|([^\]]+))?\]\]')


def extract_typed_wikilinks(content: str) -> list[tuple[str, str | None]]:
    """Extract wikilinks with optional type annotations.

    Handles both ``[[Target]]`` (returns target, None) and
    ``[[Target|uses]]`` (returns target, "uses").

    Unknown types are kept (not dropped) so callers can decide how to
    handle them — the lint pass logs a warning, the ingest pipeline
    stores whatever it gets.
    """
    results: list[tuple[str, str | None]] = []
    for m in _WIKILINK_RE.finditer(content):
        target = m.group(1).strip().lower()
        link_type = m.group(2).strip().lower() if m.group(2) else None
        if target:
            results.append((target, link_type))
    return results
