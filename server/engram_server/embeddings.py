from sentence_transformers import SentenceTransformer
from loguru import logger

from engram_server.config import EMBEDDING_MODEL


class Embedder:
    """Singleton wrapper around sentence-transformers for local embedding."""

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

    def encode(self, text: str) -> list[float]:
        return self.model.encode(text).tolist()

    def encode_batch(self, texts: list[str]) -> list[list[float]]:
        return self.model.encode(texts).tolist()
