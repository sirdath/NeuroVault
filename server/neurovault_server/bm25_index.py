"""In-memory BM25 keyword search index v2.

Improvements over v1:
- Stopword removal (the, is, a, etc. don't pollute results)
- Lowercased tokenization
- Punctuation stripping
- Rebuilt from database on startup and after changes
"""

import re
from rank_bm25 import BM25Okapi
from loguru import logger

# Common English stopwords to filter out
STOPWORDS = frozenset({
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "dare", "ought",
    "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
    "as", "into", "through", "during", "before", "after", "above", "below",
    "between", "out", "off", "over", "under", "again", "further", "then",
    "once", "here", "there", "when", "where", "why", "how", "all", "each",
    "every", "both", "few", "more", "most", "other", "some", "such", "no",
    "nor", "not", "only", "own", "same", "so", "than", "too", "very",
    "and", "but", "or", "if", "while", "because", "until", "although",
    "this", "that", "these", "those", "it", "its", "i", "me", "my",
    "we", "our", "you", "your", "he", "him", "his", "she", "her",
    "they", "them", "their", "what", "which", "who", "whom",
})


def _tokenize(text: str) -> list[str]:
    """Tokenize text: lowercase, strip punctuation, remove stopwords."""
    # Remove markdown syntax
    text = re.sub(r'[#*`\[\](){}|>~_]', ' ', text.lower())
    # Split on whitespace and punctuation
    words = re.findall(r'[a-z0-9]+(?:-[a-z0-9]+)*', text)
    # Remove stopwords and very short tokens
    return [w for w in words if w not in STOPWORDS and len(w) > 1]


class BM25Index:
    """In-memory BM25 index with stopword removal and proper tokenization."""

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
            tokens = _tokenize(content)
            if tokens:
                self._corpus.append(tokens)
                self._chunk_ids.append(chunk_id)

        if self._corpus:
            self._index = BM25Okapi(self._corpus)
        else:
            self._index = None

        logger.info("BM25 index built with {} chunks (stopwords removed)", len(self._corpus))

    def search(self, query: str, n: int = 25) -> list[tuple[str, float]]:
        """Search the index. Returns (chunk_id, score) pairs."""
        if self._index is None or not self._corpus:
            return []

        tokens = _tokenize(query)
        if not tokens:
            return []

        scores = self._index.get_scores(tokens)

        # Include all non-trivial scores (BM25Okapi can give negatives with small corpus)
        max_score = max(scores) if len(scores) > 0 else 0
        threshold = max_score * 0.1 if max_score > 0 else -float('inf')
        scored = [(self._chunk_ids[i], float(scores[i])) for i in range(len(scores)) if scores[i] > threshold]
        scored.sort(key=lambda x: x[1], reverse=True)

        return scored[:n]

    @property
    def size(self) -> int:
        return len(self._corpus)
