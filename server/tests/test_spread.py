"""Tests for read-path spreading activation — `_spread_neighbors()`.

Unit-scoped: builds the DB state manually (engram rows + engram_links
edges) rather than going through the full ingest pipeline, so these
tests don't need the embedder fixture and run in milliseconds.
"""

from __future__ import annotations

import hashlib
import uuid

from neurovault_server.database import Database
from neurovault_server.retriever import _spread_neighbors


def _insert(db: Database, title: str, content: str, state: str = "active") -> str:
    eid = str(uuid.uuid4())
    h = hashlib.sha256(content.encode()).hexdigest()
    db.insert_engram(eid, f"{title.lower().replace(' ', '-')}-{eid[:8]}.md", title, content, h)
    if state != "active":
        db.conn.execute("UPDATE engrams SET state = ? WHERE id = ?", (state, eid))
    db.conn.commit()
    return eid


def _link(db: Database, frm: str, to: str, sim: float, link_type: str = "semantic") -> None:
    db.conn.execute(
        """INSERT OR REPLACE INTO engram_links
             (from_engram, to_engram, similarity, link_type)
           VALUES (?, ?, ?, ?)""",
        (frm, to, sim, link_type),
    )
    db.conn.commit()


def _seed_candidate(db: Database, eid: str, rrf_score: float = 0.5) -> dict:
    """Build a candidate dict the way hybrid_retrieve builds them, from
    the DB row. Caller uses this as the input to _spread_neighbors so
    the test doesn't recreate every scoring field by hand.
    """
    row = db.get_engram(eid)
    return {
        "engram_id": eid,
        "title": row["title"],
        "content": (row["content"] or "")[:1000],
        "strength": row["strength"],
        "state": row["state"],
        "updated_at": row.get("updated_at", ""),
        "created_at": row.get("created_at", ""),
        "kind": row.get("kind") or "note",
        "rrf_score": rrf_score,
    }


def test_spread_adds_linked_neighbor(tmp_db: Database):
    seed = _insert(tmp_db, "Database Decisions", "We decided to use Postgres as primary.")
    neighbor = _insert(tmp_db, "Postgres Switchover", "Migrating from Mongo to Postgres on 2026-03-01.")
    _link(tmp_db, seed, neighbor, sim=0.80)

    candidates = [_seed_candidate(tmp_db, seed, rrf_score=0.5)]
    _spread_neighbors(tmp_db, candidates, seed_count=1, link_threshold=0.55)

    ids = [c["engram_id"] for c in candidates]
    assert neighbor in ids, "linked neighbor should surface via spread"
    nbr = next(c for c in candidates if c["engram_id"] == neighbor)
    assert nbr.get("via_spread") is True
    assert nbr.get("spread_from") == seed
    assert abs(nbr.get("spread_similarity", 0) - 0.80) < 1e-6


def test_spread_respects_link_threshold(tmp_db: Database):
    seed = _insert(tmp_db, "Topic A", "Seed for threshold test.")
    neighbor = _insert(tmp_db, "Topic B", "Weak neighbor.")
    _link(tmp_db, seed, neighbor, sim=0.40)  # below default 0.55

    candidates = [_seed_candidate(tmp_db, seed, rrf_score=0.5)]
    _spread_neighbors(tmp_db, candidates, seed_count=1, link_threshold=0.55)

    ids = [c["engram_id"] for c in candidates]
    assert neighbor not in ids, "weak-similarity links must be gated out"


def test_spread_dampens_score(tmp_db: Database):
    seed = _insert(tmp_db, "Seed", "Content.")
    neighbor = _insert(tmp_db, "Neighbor", "Content.")
    _link(tmp_db, seed, neighbor, sim=0.80)

    candidates = [_seed_candidate(tmp_db, seed, rrf_score=0.6)]
    _spread_neighbors(
        tmp_db, candidates,
        seed_count=1, link_threshold=0.55, dampening=0.5,
    )

    nbr = next(c for c in candidates if c["engram_id"] == neighbor)
    # 0.6 seed × 0.80 sim × 0.5 dampening = 0.24
    assert abs(nbr["rrf_score"] - 0.24) < 1e-4


def test_spread_skips_dormant(tmp_db: Database):
    seed = _insert(tmp_db, "Seed", "Content.")
    neighbor = _insert(tmp_db, "Dormant", "Retired.", state="dormant")
    _link(tmp_db, seed, neighbor, sim=0.90)

    candidates = [_seed_candidate(tmp_db, seed, rrf_score=0.5)]
    _spread_neighbors(tmp_db, candidates, seed_count=1, link_threshold=0.55)

    ids = [c["engram_id"] for c in candidates]
    assert neighbor not in ids, "dormant engrams must not surface via spread"


def test_spread_does_not_duplicate_existing_candidate(tmp_db: Database):
    """If a neighbor is already in candidates (e.g. matched the query
    directly), spreading should not re-add it."""
    seed = _insert(tmp_db, "Seed", "Content.")
    other = _insert(tmp_db, "Also Matched", "Already in pool.")
    _link(tmp_db, seed, other, sim=0.80)

    candidates = [
        _seed_candidate(tmp_db, seed, rrf_score=0.6),
        _seed_candidate(tmp_db, other, rrf_score=0.4),  # already matched
    ]
    _spread_neighbors(tmp_db, candidates, seed_count=1, link_threshold=0.55)

    # Should still be exactly 2 candidates, not 3
    assert len([c for c in candidates if c["engram_id"] == other]) == 1


def test_spread_respects_max_new(tmp_db: Database):
    seed = _insert(tmp_db, "Seed", "Content.")
    nbrs = [_insert(tmp_db, f"N{i}", f"Content {i}.") for i in range(5)]
    for n in nbrs:
        _link(tmp_db, seed, n, sim=0.80)

    candidates = [_seed_candidate(tmp_db, seed, rrf_score=0.5)]
    _spread_neighbors(
        tmp_db, candidates,
        seed_count=1, link_threshold=0.55, max_new=2,
    )

    # 1 seed + 2 new neighbors == 3 total
    assert len(candidates) == 3


def test_spread_only_top_seeds_radiate(tmp_db: Database):
    """With seed_count=1, only the highest-rrf candidate should spread.
    Lower-ranked candidates' neighbors should NOT be pulled in."""
    top_seed = _insert(tmp_db, "Top", "Content.")
    weak_seed = _insert(tmp_db, "Weak", "Content.")
    top_nbr = _insert(tmp_db, "TopNbr", "Content.")
    weak_nbr = _insert(tmp_db, "WeakNbr", "Content.")
    _link(tmp_db, top_seed, top_nbr, sim=0.80)
    _link(tmp_db, weak_seed, weak_nbr, sim=0.80)

    candidates = [
        _seed_candidate(tmp_db, top_seed, rrf_score=0.9),
        _seed_candidate(tmp_db, weak_seed, rrf_score=0.3),
    ]
    _spread_neighbors(tmp_db, candidates, seed_count=1, link_threshold=0.55)

    ids = [c["engram_id"] for c in candidates]
    assert top_nbr in ids
    assert weak_nbr not in ids, "weak seed shouldn't spread when seed_count=1"


def test_spread_respects_as_of(tmp_db: Database):
    """Neighbors created after the as_of timestamp must be skipped —
    matches the temporal filter on direct candidates."""
    seed = _insert(tmp_db, "Seed", "Content.")
    neighbor = _insert(tmp_db, "Future Fact", "Didn't exist yet.")
    _link(tmp_db, seed, neighbor, sim=0.80)
    # Force the neighbor's created_at to a specific future moment.
    tmp_db.conn.execute(
        "UPDATE engrams SET created_at = '2030-01-01T00:00:00' WHERE id = ?",
        (neighbor,),
    )
    tmp_db.conn.commit()

    candidates = [_seed_candidate(tmp_db, seed, rrf_score=0.5)]
    _spread_neighbors(
        tmp_db, candidates,
        seed_count=1, link_threshold=0.55,
        as_of="2026-04-20T00:00:00",
    )

    ids = [c["engram_id"] for c in candidates]
    assert neighbor not in ids, "neighbor in the future must not surface for as_of queries"


def test_spread_zero_seeds_is_noop(tmp_db: Database):
    seed = _insert(tmp_db, "Seed", "Content.")
    candidates = [_seed_candidate(tmp_db, seed, rrf_score=0.5)]
    _spread_neighbors(tmp_db, candidates, seed_count=0)
    assert len(candidates) == 1


def test_spread_empty_candidates_is_noop(tmp_db: Database):
    _spread_neighbors(tmp_db, [], seed_count=3)
    # Shouldn't crash. No assertion needed beyond completion.
