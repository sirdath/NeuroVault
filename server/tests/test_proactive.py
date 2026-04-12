"""Tests for proactive context detection (no LLM)."""

from pathlib import Path

from engram_server.database import Database
from engram_server.embeddings import Embedder
from engram_server.bm25_index import BM25Index
from engram_server.ingest import ingest_vault
from engram_server.proactive import detect_topics, proactive_context


def test_detect_topics_education():
    topics = detect_topics("What do you think about my dissertation research?")
    assert "education" in topics or "research" in topics


def test_detect_topics_work():
    topics = detect_topics("I have a meeting with my boss about the project")
    assert "work" in topics


def test_detect_topics_code():
    topics = detect_topics("I'm debugging this Python function and can't find the bug")
    assert "code" in topics


def test_detect_topics_finance():
    topics = detect_topics("Should I invest more in my savings account?")
    assert "finance" in topics


def test_detect_topics_empty_on_neutral_message():
    topics = detect_topics("Hello how are you doing today")
    assert topics == []


def test_detect_topics_multiple():
    """A message can touch multiple topics."""
    topics = detect_topics("My dissertation research on programming languages")
    assert "research" in topics or "code" in topics or "education" in topics


def test_proactive_context_returns_empty_without_match(tmp_db: Database, embedder: Embedder):
    """Neutral messages should not trigger any fetching."""
    result = proactive_context("hello", tmp_db, embedder)
    assert result["trigger"] is False
    assert result["memories"] == []


def test_proactive_context_fetches_relevant(tmp_db: Database, embedder: Embedder, tmp_vault: Path):
    bm25 = BM25Index()
    (tmp_vault / "code.md").write_text(
        "# Python Function\n\nI wrote a function to debug my API endpoints in FastAPI.",
        encoding="utf-8",
    )
    (tmp_vault / "unrelated.md").write_text(
        "# Cooking Recipe\n\nPasta carbonara with pecorino cheese and black pepper.",
        encoding="utf-8",
    )
    ingest_vault(tmp_db, embedder, bm25, tmp_vault)

    result = proactive_context(
        "Can you help me debug my Python code?", tmp_db, embedder, max_memories=5
    )

    assert result["trigger"] is True
    assert "code" in result["topics_detected"]
    # Should prefer the Python Function note over the recipe
    if result["memories"]:
        titles = [m["title"].lower() for m in result["memories"]]
        assert any("python" in t or "function" in t for t in titles)
