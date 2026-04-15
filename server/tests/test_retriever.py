from pathlib import Path

from neurovault_server.database import Database
from neurovault_server.embeddings import Embedder
from neurovault_server.bm25_index import BM25Index
from neurovault_server.ingest import ingest_vault
from neurovault_server.retriever import hybrid_retrieve


def _setup_vault(tmp_vault: Path) -> None:
    """Create test notes with distinct topics for retrieval testing."""
    (tmp_vault / "python-web.md").write_text(
        "# Python Web Development\n\n"
        "Flask and Django are popular Python web frameworks. "
        "Flask is lightweight and flexible, while Django includes batteries like ORM, admin, and auth. "
        "Use FastAPI for modern async APIs with automatic OpenAPI documentation.",
        encoding="utf-8",
    )
    (tmp_vault / "rust-systems.md").write_text(
        "# Rust Systems Programming\n\n"
        "Rust provides memory safety without garbage collection through its ownership system. "
        "The borrow checker prevents data races at compile time. "
        "Cargo is the build system and package manager for Rust projects.",
        encoding="utf-8",
    )
    (tmp_vault / "cooking-pasta.md").write_text(
        "# Italian Pasta Recipes\n\n"
        "Carbonara uses egg yolks, pecorino romano, guanciale, and black pepper. "
        "Never add cream to a real carbonara. "
        "Cook pasta in well-salted water until al dente, about 8 to 10 minutes.",
        encoding="utf-8",
    )
    (tmp_vault / "python-ml.md").write_text(
        "# Python Machine Learning\n\n"
        "Scikit-learn provides classical machine learning algorithms in Python. "
        "PyTorch and TensorFlow are deep learning frameworks. "
        "Use pandas for data preprocessing and matplotlib for visualization.",
        encoding="utf-8",
    )


def test_hybrid_retrieve_basic(tmp_db: Database, embedder: Embedder, tmp_vault: Path):
    """Hybrid retrieval should return results for a relevant query."""
    bm25 = BM25Index()
    _setup_vault(tmp_vault)
    ingest_vault(tmp_db, embedder, bm25, tmp_vault)

    results = hybrid_retrieve("Python web framework", tmp_db, embedder, bm25, top_k=3, use_reranker=False)
    assert len(results) >= 1
    # Python Web Development should rank highly
    titles = [r["title"] for r in results]
    assert "Python Web Development" in titles


def test_hybrid_retrieve_ranks_relevant_higher(tmp_db: Database, embedder: Embedder, tmp_vault: Path):
    """More relevant notes should rank above less relevant ones."""
    bm25 = BM25Index()
    _setup_vault(tmp_vault)
    ingest_vault(tmp_db, embedder, bm25, tmp_vault)

    results = hybrid_retrieve("Rust memory safety borrow checker", tmp_db, embedder, bm25, top_k=4, use_reranker=False)
    assert len(results) >= 1
    # Rust note should be first
    assert results[0]["title"] == "Rust Systems Programming"


def test_hybrid_retrieve_cooking_vs_programming(tmp_db: Database, embedder: Embedder, tmp_vault: Path):
    """Cooking query shouldn't return programming results first."""
    bm25 = BM25Index()
    _setup_vault(tmp_vault)
    ingest_vault(tmp_db, embedder, bm25, tmp_vault)

    results = hybrid_retrieve("How to make carbonara pasta", tmp_db, embedder, bm25, top_k=4, use_reranker=False)
    assert len(results) >= 1
    assert results[0]["title"] == "Italian Pasta Recipes"


def test_hybrid_retrieve_empty_vault(tmp_db: Database, embedder: Embedder):
    """Empty vault should return empty results."""
    bm25 = BM25Index()
    results = hybrid_retrieve("anything", tmp_db, embedder, bm25, top_k=5, use_reranker=False)
    assert results == []


def test_hybrid_retrieve_bumps_access(tmp_db: Database, embedder: Embedder, tmp_vault: Path):
    """Retrieved memories should have their access count bumped."""
    bm25 = BM25Index()
    _setup_vault(tmp_vault)
    ingest_vault(tmp_db, embedder, bm25, tmp_vault)

    # All start at 0
    pre = tmp_db.conn.execute("SELECT SUM(access_count) FROM engrams").fetchone()[0]
    assert pre == 0

    hybrid_retrieve("Python", tmp_db, embedder, bm25, top_k=2, use_reranker=False)

    post = tmp_db.conn.execute("SELECT SUM(access_count) FROM engrams").fetchone()[0]
    assert post > 0


def test_hybrid_retrieve_with_reranker(tmp_db: Database, embedder: Embedder, tmp_vault: Path):
    """Full pipeline with cross-encoder reranking should work."""
    bm25 = BM25Index()
    _setup_vault(tmp_vault)
    ingest_vault(tmp_db, embedder, bm25, tmp_vault)

    # This will load the cross-encoder model on first call
    results = hybrid_retrieve("Python web framework", tmp_db, embedder, bm25, top_k=3, use_reranker=True)
    assert len(results) >= 1
    # Should still rank Python Web Dev highly with reranking
    titles = [r["title"] for r in results]
    assert "Python Web Development" in titles
