"""Tests for dissertation features: quick capture, tags, BibTeX export."""

import uuid
import hashlib
from pathlib import Path

from engram_server.database import Database
from engram_server.embeddings import Embedder
from engram_server.bm25_index import BM25Index
from engram_server.dissertation import (
    quick_capture,
    add_tag,
    remove_tag,
    list_tags,
    find_by_tag,
    export_bibtex,
    mark_read,
    get_reading_list,
)


def _insert_note(db: Database, title: str, content: str) -> str:
    eid = str(uuid.uuid4())
    h = hashlib.sha256(content.encode()).hexdigest()
    db.insert_engram(eid, f"{title.lower()}-{eid[:8]}.md", title, content, h)
    return eid


def test_quick_capture_auto_title(tmp_db: Database, embedder: Embedder, tmp_vault: Path):
    bm25 = BM25Index()
    text = "This is the first line which becomes the title\n\nRest of the content here."
    result = quick_capture(text, None, tmp_vault, tmp_db, embedder, bm25)
    assert result["title"] is not None
    assert len(result["title"]) > 0
    # File should exist in vault
    assert (tmp_vault / result["filename"]).exists()


def test_quick_capture_with_explicit_title(tmp_db: Database, embedder: Embedder, tmp_vault: Path):
    bm25 = BM25Index()
    result = quick_capture("Some content", "My Title", tmp_vault, tmp_db, embedder, bm25)
    assert result["title"] == "My Title"


def test_add_and_list_tags(tmp_db: Database):
    eid = _insert_note(tmp_db, "Test Note", "Some content")
    assert add_tag(tmp_db, eid, "important") is True
    assert add_tag(tmp_db, eid, "methodology") is True

    tags = list_tags(tmp_db)
    tag_names = {t["tag"] for t in tags}
    assert "important" in tag_names
    assert "methodology" in tag_names


def test_add_tag_ignores_duplicate(tmp_db: Database):
    eid = _insert_note(tmp_db, "Note", "Content")
    add_tag(tmp_db, eid, "important")
    add_tag(tmp_db, eid, "important")  # Duplicate should be no-op

    tags = list_tags(tmp_db)
    important = next((t for t in tags if t["tag"] == "important"), None)
    assert important is not None
    assert important["count"] == 1


def test_remove_tag(tmp_db: Database):
    eid = _insert_note(tmp_db, "Note", "Content")
    add_tag(tmp_db, eid, "temporary")
    assert remove_tag(tmp_db, eid, "temporary") is True
    assert not any(t["tag"] == "temporary" for t in list_tags(tmp_db))


def test_find_by_tag(tmp_db: Database):
    a = _insert_note(tmp_db, "Paper A", "First paper")
    b = _insert_note(tmp_db, "Paper B", "Second paper")
    _insert_note(tmp_db, "Paper C", "Third paper, untagged")

    add_tag(tmp_db, a, "important")
    add_tag(tmp_db, b, "important")

    results = find_by_tag(tmp_db, "important")
    assert len(results) == 2
    titles = {r["title"] for r in results}
    assert "Paper A" in titles
    assert "Paper B" in titles
    assert "Paper C" not in titles


def test_export_bibtex_with_metadata(tmp_db: Database):
    content = """# Example Paper

**Author:** Smith, J.
**Year:** 2024
**Journal:** Nature

Abstract content here."""
    _insert_note(tmp_db, "Example Paper", content)

    bibtex = export_bibtex(tmp_db)
    assert "@article" in bibtex
    assert "Smith" in bibtex or "smith" in bibtex.lower()
    assert "2024" in bibtex


def test_export_bibtex_skips_notes_without_metadata(tmp_db: Database):
    _insert_note(tmp_db, "Just A Note", "Plain content with no citation metadata")
    bibtex = export_bibtex(tmp_db)
    # Should return placeholder comment, not crash
    assert "@article" not in bibtex or "citations" in bibtex.lower()


def test_mark_read_and_reading_list(tmp_db: Database):
    a = _insert_note(tmp_db, "Queue Paper", "Unread paper")
    mark_read(tmp_db, a, "to-read")

    reading_list = get_reading_list(tmp_db, "to-read")
    assert len(reading_list) == 1
    assert reading_list[0]["title"] == "Queue Paper"

    mark_read(tmp_db, a, "read")
    # Should no longer be in to-read list
    assert len(get_reading_list(tmp_db, "to-read")) == 0
