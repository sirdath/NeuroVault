from pathlib import Path

from neurovault_server.database import Database
from neurovault_server.embeddings import Embedder
from neurovault_server.bm25_index import BM25Index
from neurovault_server.write_back import (
    write_back,
    build_session_context,
    _extract_local,
)
from neurovault_server.ingest import ingest_vault


def test_extract_local_finds_decisions():
    result = _extract_local(
        "I decided to use FastAPI instead of Flask for the new project",
        "Great choice! FastAPI has better async support and auto-generates OpenAPI docs.",
    )
    assert len(result["facts"]) >= 1
    assert result["should_create_engram"] is True


def test_extract_local_finds_learnings():
    result = _extract_local(
        "What did we learn?",
        "The key insight is that SQLite-vec performs better than ChromaDB for small datasets",
    )
    assert len(result["facts"]) >= 1


def test_extract_local_skips_ephemeral():
    result = _extract_local(
        "Hello, how are you?",
        "I'm doing well! How can I help you today?",
    )
    assert result["should_create_engram"] is False
    assert len(result["facts"]) == 0


def test_write_back_creates_engram(tmp_db: Database, embedder: Embedder, tmp_vault: Path):
    bm25 = BM25Index()

    result = write_back(
        user_message="I decided to use Rust for the backend instead of Go",
        assistant_response="Rust is a great choice for systems programming with memory safety guarantees.",
        retrieved_engram_ids=[],
        db=tmp_db,
        embedder=embedder,
        bm25=bm25,
        vault_dir=tmp_vault,
    )

    assert result is not None
    assert result["facts_count"] >= 1
    assert result["title"] != ""

    md_files = list(tmp_vault.glob("*.md"))
    assert len(md_files) >= 1

    engrams = tmp_db.list_engrams()
    assert len(engrams) >= 1


def test_write_back_returns_none_for_small_talk(tmp_db: Database, embedder: Embedder, tmp_vault: Path):
    bm25 = BM25Index()

    result = write_back(
        user_message="Hi there",
        assistant_response="Hello! How can I help?",
        retrieved_engram_ids=[],
        db=tmp_db,
        embedder=embedder,
        bm25=bm25,
        vault_dir=tmp_vault,
    )

    assert result is None


def test_write_back_bumps_access(tmp_db: Database, embedder: Embedder, tmp_vault: Path):
    bm25 = BM25Index()

    import uuid, hashlib
    eid = str(uuid.uuid4())
    tmp_db.insert_engram(eid, "existing.md", "Existing Note", "content", hashlib.sha256(b"c").hexdigest())

    pre_access = tmp_db.get_engram(eid)["access_count"]

    write_back(
        user_message="test",
        assistant_response="test",
        retrieved_engram_ids=[eid],
        db=tmp_db,
        embedder=embedder,
        bm25=bm25,
        vault_dir=tmp_vault,
    )

    post_access = tmp_db.get_engram(eid)["access_count"]
    assert post_access == pre_access + 1


def test_build_session_context_empty(tmp_db: Database):
    ctx = build_session_context(tmp_db)
    assert "l0" in ctx
    assert "l1" in ctx
    assert ctx["stats"]["total_memories"] == 0


def test_build_session_context_with_data(tmp_db: Database, embedder: Embedder, tmp_vault: Path):
    bm25 = BM25Index()

    for i in range(5):
        (tmp_vault / f"note-{i}.md").write_text(
            f"# Memory {i}\n\nThis is a test memory number {i} with some content.",
            encoding="utf-8",
        )

    ingest_vault(tmp_db, embedder, bm25, tmp_vault)

    engrams = tmp_db.list_engrams()
    for e in engrams[:2]:
        for _ in range(5):
            tmp_db.bump_access(e["id"])

    ctx = build_session_context(tmp_db)
    assert ctx["stats"]["total_memories"] == 5
    assert "Memory" in ctx["l0"]
    assert len(ctx["l1"]) > 0
