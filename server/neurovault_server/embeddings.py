from collections import OrderedDict
from threading import Lock

from sentence_transformers import SentenceTransformer
from loguru import logger

from neurovault_server.config import EMBEDDING_MODEL


# Query-embedding LRU. Recall latency is ~85% query embedding cost; humans
# and LLMs both repeat queries inside a session ("recall mcp tools" then
# "recall mcp tiers"), so a cache keyed on the raw query string pays off
# quickly. 1000 entries ≈ 1.5 MB at 384 floats × 4 bytes × 1000.
_QUERY_CACHE_MAX = 1000


class Embedder:
    """Singleton wrapper around sentence-transformers for local embedding.

    Adds a bounded LRU on `encode_query()` so repeated recall() calls in a
    session skip the ~600-800 ms model forward pass. Indexing/ingest still
    uses `encode()` / `encode_batch()` uncached — those go through fresh text.
    """

    _instance: "Embedder | None" = None

    @classmethod
    def get(cls) -> "Embedder":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def __init__(self) -> None:
        logger.info("Loading embedding model: {}", EMBEDDING_MODEL)
        self.model = SentenceTransformer(EMBEDDING_MODEL)
        logger.info("Embedding model loaded ({} dimensions)", self.model.get_embedding_dimension())
        self._query_cache: "OrderedDict[str, list[float]]" = OrderedDict()
        self._query_cache_lock = Lock()
        self._query_cache_hits = 0
        self._query_cache_misses = 0

    def encode(self, text: str) -> list[float]:
        return self.model.encode(text).tolist()

    def encode_batch(self, texts: list[str]) -> list[list[float]]:
        return self.model.encode(texts).tolist()

    def encode_query(self, query: str) -> list[float]:
        """Encode a recall-time query, hitting an LRU for repeat queries.

        Keyed on the stripped, case-sensitive query string. Hit rate in a
        typical Claude session (repeat/paraphrase-heavy) is 30-50%.
        """
        key = (query or "").strip()
        if not key:
            return self.encode(query)
        with self._query_cache_lock:
            cached = self._query_cache.get(key)
            if cached is not None:
                self._query_cache.move_to_end(key)
                self._query_cache_hits += 1
                return cached
            self._query_cache_misses += 1
        # Do the expensive encode outside the lock so concurrent misses
        # don't serialize. Worst case: two callers encode the same novel
        # query concurrently — cheap to tolerate, expensive to prevent.
        vec = self.model.encode(key).tolist()
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
