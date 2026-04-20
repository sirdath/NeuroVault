"""Tests for the retroactive entity-link enrichment (A-Mem pattern).

When a new engram is ingested, every older engram that shares an entity
should immediately gain an ``entity`` link pointing to the newcomer.
This is the incremental equivalent of ``_compute_entity_links``.
"""

from __future__ import annotations

import hashlib
import uuid

from neurovault_server.database import Database
from neurovault_server.entities import store_entities
from neurovault_server.ingest import _update_entity_links


def _new_engram(db: Database, title: str, content: str = "") -> str:
    engram_id = str(uuid.uuid4())
    content_hash = hashlib.sha256((content or title).encode()).hexdigest()
    db.conn.execute(
        """INSERT INTO engrams (id, filename, title, content, content_hash, state, strength)
           VALUES (?, ?, ?, ?, ?, 'active', 1.0)""",
        (engram_id, f"{title}-{engram_id[:8]}.md", title, content, content_hash),
    )
    db.conn.commit()
    return engram_id


def _links_between(db: Database, a: str, b: str) -> list[tuple]:
    rows = db.conn.execute(
        """SELECT from_engram, to_engram, similarity, link_type
           FROM engram_links
           WHERE (from_engram = ? AND to_engram = ?)
              OR (from_engram = ? AND to_engram = ?)""",
        (a, b, b, a),
    ).fetchall()
    return [tuple(r) for r in rows]


def test_no_shared_entities_creates_no_links(tmp_db: Database):
    older = _new_engram(tmp_db, "older")
    store_entities(tmp_db, older, [{"name": "Alice", "kind": "PERSON", "salience": 0.8}])

    newer = _new_engram(tmp_db, "newer")
    store_entities(tmp_db, newer, [{"name": "Bob", "kind": "PERSON", "salience": 0.8}])

    touched = _update_entity_links(tmp_db, newer)
    assert touched == 0
    assert _links_between(tmp_db, older, newer) == []


def test_shared_entity_creates_bidirectional_link(tmp_db: Database):
    older = _new_engram(tmp_db, "older")
    store_entities(tmp_db, older, [{"name": "NeuroVault", "kind": "PROJECT", "salience": 0.9}])

    newer = _new_engram(tmp_db, "newer")
    store_entities(tmp_db, newer, [{"name": "NeuroVault", "kind": "PROJECT", "salience": 0.9}])

    touched = _update_entity_links(tmp_db, newer)
    assert touched == 1
    links = _links_between(tmp_db, older, newer)
    # Both directions should exist
    assert len(links) == 2
    assert all(link[3] == "entity" for link in links)
    # Similarity formula: 0.5 + count*0.1 — one shared entity → 0.6
    assert all(abs(link[2] - 0.6) < 1e-9 for link in links)


def test_multiple_shared_entities_boost_similarity(tmp_db: Database):
    older = _new_engram(tmp_db, "older")
    store_entities(tmp_db, older, [
        {"name": "NeuroVault", "kind": "PROJECT", "salience": 0.9},
        {"name": "MCP", "kind": "CONCEPT", "salience": 0.8},
        {"name": "SQLite", "kind": "TECH", "salience": 0.7},
    ])

    newer = _new_engram(tmp_db, "newer")
    store_entities(tmp_db, newer, [
        {"name": "NeuroVault", "kind": "PROJECT", "salience": 0.9},
        {"name": "MCP", "kind": "CONCEPT", "salience": 0.8},
        {"name": "SQLite", "kind": "TECH", "salience": 0.7},
    ])

    _update_entity_links(tmp_db, newer)
    links = _links_between(tmp_db, older, newer)
    # 3 shared → 0.5 + 0.3 = 0.8
    assert all(abs(link[2] - 0.8) < 1e-9 for link in links)


def test_retroactive_applies_to_many_older_engrams(tmp_db: Database):
    olders = [_new_engram(tmp_db, f"old_{i}") for i in range(3)]
    for oid in olders:
        store_entities(tmp_db, oid, [{"name": "SharedTopic", "kind": "CONCEPT", "salience": 0.8}])

    newer = _new_engram(tmp_db, "newer")
    store_entities(tmp_db, newer, [{"name": "SharedTopic", "kind": "CONCEPT", "salience": 0.8}])

    touched = _update_entity_links(tmp_db, newer)
    assert touched == 3
    for oid in olders:
        links = _links_between(tmp_db, oid, newer)
        assert len(links) == 2  # bidirectional


def test_second_call_is_idempotent(tmp_db: Database):
    older = _new_engram(tmp_db, "older")
    store_entities(tmp_db, older, [{"name": "X", "kind": "CONCEPT", "salience": 0.8}])
    newer = _new_engram(tmp_db, "newer")
    store_entities(tmp_db, newer, [{"name": "X", "kind": "CONCEPT", "salience": 0.8}])

    _update_entity_links(tmp_db, newer)
    _update_entity_links(tmp_db, newer)  # second pass shouldn't dup rows

    links = _links_between(tmp_db, older, newer)
    # Still exactly 2 rows (INSERT OR REPLACE keyed by PK {from,to,type})
    assert len(links) == 2
