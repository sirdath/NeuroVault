"""In-memory BM25 keyword search index.

Rebuilt from the database on startup and after ingestion changes.
Provides keyword-based retrieval to complement semantic search.
"""

from rank_bm25 import BM25Okapi
from loguru import logger


class BM25Index:
    """Maintains an in-memory BM25 index over all chunk content."""

    def __init__(self) -> None:
        self._corpus: list[list[str]] = []
        self._chunk_ids: list[str] = []
        self._index: BM25Okapi | None = None

    def build(self, db) -> None:
        """Rebuild the entire index from the database."""
        rows = db.conn.execute(
            """SELECT c.id, c.content
               FROM chunks c
               JOIN engrams e ON e.id = c.engram_id
               WHERE e.state != 'dormant'
               ORDER BY c.id"""
        ).fetchall()

        self._corpus = []
        self._chunk_ids = []

        for row in rows:
            chunk_id = row[0]
            content = row[1]
            tokens = content.lower().split()
            if tokens:
                self._corpus.append(tokens)
                self._chunk_ids.append(chunk_id)

        if self._corpus:
            self._index = BM25Okapi(self._corpus)
        else:
            self._index = None

        logger.info("BM25 index built with {} chunks", len(self._corpus))

    def search(self, query: str, n: int = 25) -> list[tuple[str, float]]:
        """Search the index. Returns list of (chunk_id, score) pairs."""
        if self._index is None or not self._corpus:
            return []

        tokens = query.lower().split()
        if not tokens:
            return []

        scores = self._index.get_scores(tokens)

        # Pair with chunk IDs and sort by score descending
        # BM25Okapi can return negative scores with small corpora; include all non-trivial scores
        max_score = max(scores) if len(scores) > 0 else 0
        threshold = max_score * 0.1 if max_score > 0 else -float('inf')
        scored = [(self._chunk_ids[i], float(scores[i])) for i in range(len(scores)) if scores[i] > threshold]
        scored.sort(key=lambda x: x[1], reverse=True)

        return scored[:n]

    @property
    def size(self) -> int:
        return len(self._corpus)
