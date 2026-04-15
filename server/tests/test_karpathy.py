"""Tests for Karpathy LLM Wiki pattern (index.md, log.md, CLAUDE.md)."""

from pathlib import Path

from neurovault_server.database import Database
from neurovault_server.embeddings import Embedder
from neurovault_server.bm25_index import BM25Index
from neurovault_server.ingest import ingest_vault
from neurovault_server.karpathy import (
    rebuild_index,
    append_log,
    ensure_schema,
    get_index,
    get_log,
    get_schema,
    update_schema,
    _extract_summary,
)


def test_extract_summary_skips_title_and_frontmatter():
    content = "# Title\n\n*Captured today*\n\nThis is the real summary content."
    assert "real summary" in _extract_summary(content)


def test_extract_summary_handles_empty():
    assert _extract_summary("# Just a title") == "(no summary)"


def test_rebuild_index_empty_vault(tmp_db: Database, tmp_vault: Path):
    path = rebuild_index(tmp_db, tmp_vault)
    assert path.exists()
    content = path.read_text()
    assert "Wiki Index" in content
    assert "No notes yet" in content


def test_rebuild_index_with_notes(tmp_db: Database, embedder: Embedder, tmp_vault: Path):
    bm25 = BM25Index()
    (tmp_vault / "a.md").write_text(
        "# Note A\n\nFirst test memory content with enough substance to be indexed.",
        encoding="utf-8",
    )
    (tmp_vault / "b.md").write_text(
        "# Note B\n\nSecond test memory with different content for variety.",
        encoding="utf-8",
    )
    ingest_vault(tmp_db, embedder, bm25, tmp_vault)

    path = rebuild_index(tmp_db, tmp_vault)
    content = path.read_text()
    assert "Note A" in content
    assert "Note B" in content
    assert "memories" in content


def test_append_log_creates_header_on_first_entry(tmp_vault: Path):
    append_log(tmp_vault, "test", "first entry")
    log_path = tmp_vault / "log.md"
    assert log_path.exists()
    content = log_path.read_text()
    assert "Activity Log" in content
    assert "test | first entry" in content


def test_append_log_appends_multiple_entries(tmp_vault: Path):
    append_log(tmp_vault, "ingest", "note A")
    append_log(tmp_vault, "query", "something")
    append_log(tmp_vault, "consolidate", "done")

    content = (tmp_vault / "log.md").read_text()
    assert "ingest | note A" in content
    assert "query | something" in content
    assert "consolidate | done" in content


def test_ensure_schema_creates_default(tmp_vault: Path):
    path = ensure_schema(tmp_vault, "Test Brain")
    assert path.exists()
    content = path.read_text()
    assert "Test Brain" in content
    assert "Naming conventions" in content
    assert "Tag taxonomy" in content
    assert "Rules for Claude" in content


def test_ensure_schema_doesnt_overwrite(tmp_vault: Path):
    """User edits to CLAUDE.md must be preserved."""
    custom = "# My Custom Schema\n\nCustom rules here."
    (tmp_vault / "CLAUDE.md").write_text(custom, encoding="utf-8")

    ensure_schema(tmp_vault, "Test Brain")

    content = (tmp_vault / "CLAUDE.md").read_text()
    assert content == custom


def test_update_schema_overwrites(tmp_vault: Path):
    ensure_schema(tmp_vault, "Test Brain")
    new_content = "# New Schema\n\nBrand new rules."
    update_schema(tmp_vault, new_content)

    assert (tmp_vault / "CLAUDE.md").read_text() == new_content


def test_get_log_tail_returns_last_n(tmp_vault: Path):
    for i in range(10):
        append_log(tmp_vault, "test", f"entry {i}")

    tail_output = get_log(tmp_vault, tail=3)
    assert "entry 9" in tail_output
    assert "entry 8" in tail_output
    assert "entry 7" in tail_output
    # Very old entries should not be in the tail
    assert "entry 0" not in tail_output


def test_get_index_and_schema_readers(tmp_db: Database, tmp_vault: Path):
    # Index
    rebuild_index(tmp_db, tmp_vault)
    idx = get_index(tmp_vault)
    assert "Wiki Index" in idx

    # Schema
    ensure_schema(tmp_vault, "Test")
    schema = get_schema(tmp_vault)
    assert "Test" in schema
