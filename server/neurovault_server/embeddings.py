"""Local text embedding via ONNX Runtime (fastembed).

Uses BAAI/bge-small-en-v1.5 (384 dimensions) through Qdrant's fastembed
library, which runs the model via ONNX Runtime instead of PyTorch. Same
model, same quality, same 384-dim output — but the dependency footprint
drops from ~450 MB (torch + sentence-transformers + scipy) to ~15 MB
(onnxruntime + fastembed). This is the single biggest size reduction in
the entire packaging pipeline.

The Embedder class is a singleton with a bounded LRU query cache.
Recall latency is ~85% query embedding cost; humans and LLMs both repeat
queries in a session, so the cache pays off quickly.
"""

from collections import OrderedDict
from threading import Lock
from typing import Generator

from loguru import logger

from neurovault_server.config import EMBEDDING_MODEL, EMBEDDING_DIM


# Query-embedding LRU. 1000 entries ≈ 1.5 MB at 384 floats × 4 bytes × 1000.
_QUERY_CACHE_MAX = 1000


class Embedder:
    """Singleton wrapper around fastembed for local embedding.

    Adds a bounded LRU on `encode_query()` so repeated recall() calls in a
    session skip the model forward pass. Indexing/ingest still uses
    `encode()` / `encode_batch()` uncached.
    """

    _instance: "Embedder | None" = None

    @classmethod
    def get(cls) -> "Embedder":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def __init__(self) -> None:
        from fastembed import TextEmbedding

        logger.info("Loading embedding model: {} (ONNX/fastembed)", EMBEDDING_MODEL)
        self.model = TextEmbedding(model_name=EMBEDDING_MODEL)
        logger.info("Embedding model loaded ({} dimensions)", EMBEDDING_DIM)
        self._query_cache: "OrderedDict[str, list[float]]" = OrderedDict()
        self._query_cache_lock = Lock()
        self._query_cache_hits = 0
        self._query_cache_misses = 0

    def _embed_one(self, text: str) -> list[float]:
        """Embed a single string via fastembed. Returns a plain list[float]."""
        # fastembed.embed() returns a generator of numpy arrays
        results: Generator = self.model.embed([text])
        return next(results).tolist()

    def encode(self, text: str) -> list[float]:
        return self._embed_one(text)

    def encode_batch(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        return [vec.tolist() for vec in self.model.embed(texts)]

    def encode_query(self, query: str) -> list[float]:
        """Encode a recall-time query, hitting an LRU for repeat queries.

        Keyed on the stripped, case-sensitive query string. Hit rate in a
        typical Claude session (repeat/paraphrase-heavy) is 30-50%.
        """
        key = (query or "").strip()
        if not key:
            return self._embed_one(query)
        with self._query_cache_lock:
            cached = self._query_cache.get(key)
            if cached is not None:
                self._query_cache.move_to_end(key)
                self._query_cache_hits += 1
                return cached
            self._query_cache_misses += 1
        vec = self._embed_one(key)
        with self._query_cache_lock:
            self._query_cache[key] = vec
            self._query_cache.move_to_end(key)
            while len(self._query_cache) > _QUERY_CACHE_MAX:
                self._query_cache.popitem(last=False)
        return vec

    def query_cache_stats(self) -> dict:
        with self._query_cache_lock:
            total = self._query_cache_hits + self._query_cache_misses
            return {
                "size": len(self._query_cache),
                "max": _QUERY_CACHE_MAX,
                "hits": self._query_cache_hits,
                "misses": self._query_cache_misses,
                "hit_rate": round(self._query_cache_hits / total, 3) if total else 0.0,
            }
