import uuid

from neurovault_server.database import Database


def test_schema_creation(tmp_db: Database):
    """All expected tables should exist after init."""
    tables = [
        r[0]
        for r in tmp_db.conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).fetchall()
    ]
    assert "engrams" in tables
    assert "chunks" in tables
    assert "vec_chunks" in tables
    assert "entities" in tables
    assert "entity_mentions" in tables
    assert "engram_links" in tables


def test_insert_and_get_engram(tmp_db: Database):
    eid = str(uuid.uuid4())
    tmp_db.insert_engram(eid, "test.md", "Test Note", "Hello world", "abc123")

    result = tmp_db.get_engram(eid)
    assert result is not None
    assert result["title"] == "Test Note"
    assert result["content"] == "Hello world"
    assert result["state"] == "fresh"
    assert result["strength"] == 1.0


def test_list_engrams(tmp_db: Database):
    for i in range(3):
        eid = str(uuid.uuid4())
        tmp_db.insert_engram(eid, f"note-{i}.md", f"Note {i}", f"Content {i}", f"hash{i}")

    results = tmp_db.list_engrams()
    assert len(results) == 3


def test_soft_delete(tmp_db: Database):
    eid = str(uuid.uuid4())
    tmp_db.insert_engram(eid, "delete-me.md", "Delete Me", "bye", "hash")

    assert tmp_db.soft_delete(eid)
    engram = tmp_db.get_engram(eid)
    assert engram is not None
    assert engram["state"] == "dormant"

    # Dormant notes don't appear in list
    assert len(tmp_db.list_engrams()) == 0


def test_upsert_engram(tmp_db: Database):
    eid = str(uuid.uuid4())
    tmp_db.insert_engram(eid, "upsert.md", "Original", "v1", "hash1")
    tmp_db.insert_engram(eid, "upsert.md", "Updated", "v2", "hash2")

    result = tmp_db.get_engram(eid)
    assert result is not None
    assert result["title"] == "Updated"
    assert result["content"] == "v2"


def test_get_engram_by_title(tmp_db: Database):
    eid = str(uuid.uuid4())
    tmp_db.insert_engram(eid, "find-me.md", "Find This Note", "content", "hash")

    result = tmp_db.get_engram_by_title("Find This Note")
    assert result is not None
    assert result["id"] == eid

    # Case insensitive
    result2 = tmp_db.get_engram_by_title("find this note")
    assert result2 is not None
    assert result2["id"] == eid


def test_bump_access(tmp_db: Database):
    eid = str(uuid.uuid4())
    tmp_db.insert_engram(eid, "access.md", "Access Test", "content", "hash")

    tmp_db.bump_access(eid)
    tmp_db.bump_access(eid)

    result = tmp_db.get_engram(eid)
    assert result is not None
    assert result["access_count"] == 2


def test_knn_search(tmp_db: Database, embedder):
    """Insert a chunk with embedding, then search for it."""
    eid = str(uuid.uuid4())
    tmp_db.insert_engram(eid, "cat.md", "My Cat", "Luna is a tabby cat", "hash")

    chunk_id = f"{eid}-doc-0"
    tmp_db.insert_chunk(chunk_id, eid, "Luna is a tabby cat", "document", 0)

    embedding = embedder.encode("Luna is a tabby cat")
    tmp_db.insert_embedding(chunk_id, embedding)

    # Search for something semantically similar
    query_emb = embedder.encode("What pet do I have?")
    results = tmp_db.knn_search(query_emb, limit=5)

    assert len(results) >= 1
    assert results[0]["title"] == "My Cat"
