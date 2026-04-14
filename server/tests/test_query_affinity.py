"""Tests for query_affinity: record, lookup, reconcile loop, bounded boost."""

import math
import uuid

from engram_server.database import Database
from engram_server.query_affinity import (
    record_affinity,
    lookup_affinities,
    affinity_boost,
    get_affinity_stats,
    _cosine,
    _serialize_embedding,
    _deserialize_embedding,
    SIMILARITY_THRESHOLD,
    MAX_AFFINITY_BOOST,
    HIT_COUNT_CEILING,
)


def _insert_engram(db: Database, title: str = "stub") -> str:
    eid = str(uuid.uuid4())
    db.insert_engram(eid, f"{eid}.md", title, "body", "hash")
    return eid


def test_record_affinity_creates_row(tmp_db: Database):
    eid = _insert_engram(tmp_db)
    record_affinity(tmp_db, "test query", eid)

    rows = lookup_affinities(tmp_db, "test query")
    assert len(rows) == 1
    assert rows[0]["engram_id"] == eid
    assert rows[0]["hit_count"] == 1


def test_record_affinity_upsert_increments(tmp_db: Database):
    eid = _insert_engram(tmp_db)
    for _ in range(4):
        record_affinity(tmp_db, "same query", eid)

    rows = lookup_affinities(tmp_db, "same query")
    assert len(rows) == 1
    assert rows[0]["hit_count"] == 4


def test_lookup_is_case_insensitive(tmp_db: Database):
    eid = _insert_engram(tmp_db)
    record_affinity(tmp_db, "What IS THE ci Timeout?", eid)

    same = lookup_affinities(tmp_db, "what is the ci timeout?")
    assert len(same) == 1
    assert same[0]["engram_id"] == eid


def test_lookup_returns_nothing_for_unseen_query(tmp_db: Database):
    rows = lookup_affinities(tmp_db, "never asked")
    assert rows == []


def test_lookup_min_hits_filter(tmp_db: Database):
    eid = _insert_engram(tmp_db)
    record_affinity(tmp_db, "q", eid)  # hit_count = 1

    assert len(lookup_affinities(tmp_db, "q", min_hits=1)) == 1
    assert len(lookup_affinities(tmp_db, "q", min_hits=2)) == 0

    record_affinity(tmp_db, "q", eid)  # hit_count = 2
    assert len(lookup_affinities(tmp_db, "q", min_hits=2)) == 1


# --- Bounded boost math ---------------------------------------------------

def test_affinity_boost_zero_for_no_hits():
    assert affinity_boost(0) == 0.0


def test_affinity_boost_scales_linearly_then_caps():
    # 1 hit → small fraction of MAX
    b1 = affinity_boost(1)
    assert 0 < b1 < MAX_AFFINITY_BOOST
    # At ceiling → MAX
    assert affinity_boost(HIT_COUNT_CEILING) == MAX_AFFINITY_BOOST
    # Beyond ceiling → still MAX, never exceeds
    assert affinity_boost(HIT_COUNT_CEILING * 5) == MAX_AFFINITY_BOOST


def test_affinity_boost_monotonic():
    """More hits should never reduce the boost."""
    prev = 0.0
    for n in range(0, 20):
        cur = affinity_boost(n)
        assert cur >= prev
        prev = cur


# --- Observability --------------------------------------------------------

def test_get_affinity_stats_reports_top(tmp_db: Database):
    ea = _insert_engram(tmp_db, "Memory A")
    eb = _insert_engram(tmp_db, "Memory B")
    for _ in range(3):
        record_affinity(tmp_db, "query x", ea)
    for _ in range(1):
        record_affinity(tmp_db, "query y", eb)

    stats = get_affinity_stats(tmp_db)
    assert stats["total_learned_shortcuts"] == 2
    top_titles = [s["engram_title"] for s in stats["top_shortcuts"]]
    assert "Memory A" in top_titles
    # Most-hit should be first
    assert stats["top_shortcuts"][0]["engram_title"] == "Memory A"
    assert stats["top_shortcuts"][0]["hit_count"] == 3


# --- Embedding helpers ----------------------------------------------------

def test_cosine_of_identical_vectors_is_one():
    v = [0.1, 0.2, 0.3, 0.4]
    assert math.isclose(_cosine(v, v), 1.0, abs_tol=1e-9)


def test_cosine_of_orthogonal_vectors_is_zero():
    a = [1.0, 0.0, 0.0]
    b = [0.0, 1.0, 0.0]
    assert math.isclose(_cosine(a, b), 0.0, abs_tol=1e-9)


def test_cosine_handles_empty_and_zero_vectors():
    assert _cosine([], [1.0]) == 0.0
    assert _cosine([0.0, 0.0], [1.0, 1.0]) == 0.0


def test_cosine_length_mismatch_returns_zero():
    assert _cosine([1.0, 2.0], [1.0, 2.0, 3.0]) == 0.0


def test_embedding_serialise_roundtrip():
    original = [0.1, -0.2, 0.3, 0.4, -0.5]
    blob = _serialize_embedding(original)
    assert blob is not None
    restored = _deserialize_embedding(blob)
    assert restored is not None
    for a, b in zip(original, restored):
        assert math.isclose(a, b, abs_tol=1e-6)


def test_embedding_serialise_none():
    assert _serialize_embedding(None) is None
    assert _serialize_embedding([]) is None
    assert _deserialize_embedding(None) is None
    assert _deserialize_embedding(b"") is None


# --- Semantic lookup (Stage 4 v2) -----------------------------------------

def test_lookup_uses_exact_text_match_first(tmp_db: Database):
    eid = _insert_engram(tmp_db)
    stored_emb = [1.0, 0.0, 0.0]
    record_affinity(tmp_db, "the exact query", eid, query_embedding=stored_emb)

    hits = lookup_affinities(tmp_db, "the exact query", query_embedding=[0.0, 1.0, 0.0])
    assert len(hits) == 1
    assert hits[0]["match_type"] == "exact"
    assert hits[0]["similarity"] == 1.0


def test_lookup_semantic_match_fires_on_paraphrase(tmp_db: Database):
    eid = _insert_engram(tmp_db, "Keys location memory")
    stored_emb = [1.0, 0.0, 0.0]
    record_affinity(tmp_db, "where did i put my keys", eid, query_embedding=stored_emb)

    # A near-identical embedding (slight noise) with a *different* text
    similar_emb = [0.99, 0.05, 0.05]
    hits = lookup_affinities(tmp_db, "where are the keys", query_embedding=similar_emb)
    assert len(hits) == 1
    assert hits[0]["engram_id"] == eid
    assert hits[0]["match_type"] == "semantic"
    assert hits[0]["similarity"] > SIMILARITY_THRESHOLD


def test_lookup_semantic_skips_below_threshold(tmp_db: Database):
    eid = _insert_engram(tmp_db)
    stored_emb = [1.0, 0.0, 0.0]
    record_affinity(tmp_db, "where did i put my keys", eid, query_embedding=stored_emb)

    unrelated_emb = [0.0, 0.0, 1.0]  # orthogonal → cosine 0
    hits = lookup_affinities(tmp_db, "billing report summary", query_embedding=unrelated_emb)
    assert hits == []


def test_lookup_ranks_by_similarity_times_hits(tmp_db: Database):
    ea = _insert_engram(tmp_db, "A")
    eb = _insert_engram(tmp_db, "B")

    # A: very similar embedding, 1 hit
    record_affinity(tmp_db, "query alpha", ea, query_embedding=[1.0, 0.0, 0.0])
    # B: slightly less similar embedding (still above threshold), 5 hits
    for _ in range(5):
        record_affinity(tmp_db, "query beta", eb, query_embedding=[0.9, 0.3, 0.0])

    probe = [0.98, 0.1, 0.0]
    hits = lookup_affinities(tmp_db, "query gamma", query_embedding=probe)
    assert len(hits) >= 2
    # B's 5-hit count plus solid similarity should dominate A's 1-hit
    assert hits[0]["engram_id"] == eb


def test_lookup_no_embedding_falls_back_to_exact_only(tmp_db: Database):
    eid = _insert_engram(tmp_db)
    record_affinity(tmp_db, "original phrasing", eid, query_embedding=[1.0, 0.0, 0.0])

    # No embedding passed → only exact text path runs → paraphrase misses
    hits = lookup_affinities(tmp_db, "a different way of saying it")
    assert hits == []


def test_record_affinity_stores_embedding(tmp_db: Database):
    eid = _insert_engram(tmp_db)
    record_affinity(tmp_db, "has embedding", eid, query_embedding=[0.5, 0.5])

    row = tmp_db.conn.execute(
        "SELECT query_embedding FROM query_affinity WHERE query_text = ?",
        ("has embedding",),
    ).fetchone()
    assert row is not None
    assert row[0] is not None  # blob present


def test_record_affinity_upsert_preserves_existing_embedding(tmp_db: Database):
    eid = _insert_engram(tmp_db)
    record_affinity(tmp_db, "repeat me", eid, query_embedding=[0.1, 0.2, 0.3])
    # Second call without an embedding should NOT wipe the stored blob
    record_affinity(tmp_db, "repeat me", eid, query_embedding=None)

    row = tmp_db.conn.execute(
        "SELECT query_embedding, hit_count FROM query_affinity WHERE query_text = ?",
        ("repeat me",),
    ).fetchone()
    assert row[0] is not None  # embedding preserved
    assert row[1] == 2         # hit_count incremented
