import uuid
from pathlib import Path

from neurovault_server.database import Database
from neurovault_server.embeddings import Embedder
from neurovault_server.bm25_index import BM25Index
from neurovault_server.ingest import ingest_file, ingest_vault


def test_ingest_single_file(tmp_db: Database, embedder: Embedder, tmp_vault: Path):
    bm25 = BM25Index()

    # Create a markdown file
    filepath = tmp_vault / "test-note.md"
    filepath.write_text("# My Test Note\n\nThis is a test note with enough content to be indexed properly.", encoding="utf-8")

    result = ingest_file(filepath, tmp_db, embedder, bm25)
    assert result is not None

    # Verify engram was created
    engrams = tmp_db.list_engrams()
    assert len(engrams) == 1
    assert engrams[0]["title"] == "My Test Note"

    # Verify chunks were created
    chunks = tmp_db.conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
    assert chunks >= 1

    # Verify BM25 index was built
    assert bm25.size >= 1


def test_ingest_skips_unchanged(tmp_db: Database, embedder: Embedder, tmp_vault: Path):
    bm25 = BM25Index()

    filepath = tmp_vault / "static.md"
    filepath.write_text("# Static Note\n\nThis content does not change.", encoding="utf-8")

    # First ingest
    result1 = ingest_file(filepath, tmp_db, embedder, bm25)
    assert result1 is not None

    # Second ingest (unchanged) — should skip
    result2 = ingest_file(filepath, tmp_db, embedder, bm25)
    assert result2 is None


def test_ingest_updates_on_change(tmp_db: Database, embedder: Embedder, tmp_vault: Path):
    bm25 = BM25Index()

    filepath = tmp_vault / "changing.md"
    filepath.write_text("# Version 1\n\nOriginal content.", encoding="utf-8")
    ingest_file(filepath, tmp_db, embedder, bm25)

    filepath.write_text("# Version 2\n\nUpdated content with new information.", encoding="utf-8")
    result = ingest_file(filepath, tmp_db, embedder, bm25)
    assert result is not None

    engram = tmp_db.list_engrams()[0]
    assert engram["title"] == "Version 2"


def test_ingest_vault_multiple_files(tmp_db: Database, embedder: Embedder, tmp_vault: Path):
    bm25 = BM25Index()

    for i in range(3):
        (tmp_vault / f"note-{i}.md").write_text(
            f"# Note {i}\n\nThis is note number {i} with enough content.", encoding="utf-8"
        )

    count = ingest_vault(tmp_db, embedder, bm25, tmp_vault)
    assert count == 3
    assert len(tmp_db.list_engrams()) == 3


def test_semantic_links_created(tmp_db: Database, embedder: Embedder, tmp_vault: Path):
    """Two similar notes should get a semantic link."""
    bm25 = BM25Index()

    (tmp_vault / "python-tips.md").write_text(
        "# Python Programming Tips\n\nUse list comprehensions for cleaner code. Python is great for data science and machine learning.",
        encoding="utf-8",
    )
    (tmp_vault / "python-ml.md").write_text(
        "# Python Machine Learning\n\nPython is the best language for machine learning. Use scikit-learn and pytorch for data science.",
        encoding="utf-8",
    )
    (tmp_vault / "cooking.md").write_text(
        "# Cooking Recipes\n\nHow to make pasta: boil water, add salt, cook for 10 minutes.",
        encoding="utf-8",
    )

    ingest_vault(tmp_db, embedder, bm25, tmp_vault)

    # Check that semantic links exist
    links = tmp_db.conn.execute("SELECT COUNT(*) FROM engram_links WHERE link_type = 'semantic'").fetchone()[0]
    # The two Python notes should be linked, cooking should be more distant
    assert links >= 2  # bidirectional link between the Python notes


def test_wikilinks_create_manual_links(tmp_db: Database, embedder: Embedder, tmp_vault: Path):
    """Notes with [[wikilinks]] should create manual links."""
    bm25 = BM25Index()

    (tmp_vault / "note-a.md").write_text(
        "# Alpha Project\n\nThis is about the alpha project.",
        encoding="utf-8",
    )
    (tmp_vault / "note-b.md").write_text(
        "# Beta Project\n\nThis relates to [[Alpha Project]] directly.",
        encoding="utf-8",
    )

    ingest_vault(tmp_db, embedder, bm25, tmp_vault)

    manual_links = tmp_db.conn.execute(
        "SELECT COUNT(*) FROM engram_links WHERE link_type = 'manual'"
    ).fetchone()[0]
    assert manual_links >= 1


def test_bm25_search_after_ingest(tmp_db: Database, embedder: Embedder, tmp_vault: Path):
    bm25 = BM25Index()

    (tmp_vault / "rust-lang.md").write_text(
        "# Rust Programming\n\nRust is a systems programming language focused on safety and performance.",
        encoding="utf-8",
    )

    ingest_vault(tmp_db, embedder, bm25, tmp_vault)

    results = bm25.search("rust programming safety")
    assert len(results) >= 1
