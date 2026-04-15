"""Tests for retrieval_feedback: log, mark, IPW update, safety rails."""

import uuid

from neurovault_server.database import Database
from neurovault_server.retrieval_feedback import (
    log_retrieval,
    mark_accessed,
    apply_feedback_update,
    get_feedback_stats,
    DEFAULT_STRENGTH_FLOOR,
)


def _insert_engram(db: Database, title: str = "stub") -> str:
    eid = str(uuid.uuid4())
    db.insert_engram(eid, f"{eid}.md", title, "body", "hash")
    return eid


def test_log_retrieval_writes_rows(tmp_db: Database):
    eids = [_insert_engram(tmp_db, f"n{i}") for i in range(3)]
    results = [{"engram_id": eid, "score": 0.9 - i * 0.1} for i, eid in enumerate(eids)]

    logged = log_retrieval(tmp_db, "test query", results)
    assert logged == 3

    rows = tmp_db.conn.execute("SELECT COUNT(*) FROM retrieval_feedback").fetchone()[0]
    assert rows == 3


def test_log_retrieval_ignores_empty_list(tmp_db: Database):
    assert log_retrieval(tmp_db, "q", []) == 0
    rows = tmp_db.conn.execute("SELECT COUNT(*) FROM retrieval_feedback").fetchone()[0]
    assert rows == 0


def test_mark_accessed_flips_recent_row(tmp_db: Database):
    eid = _insert_engram(tmp_db)
    log_retrieval(tmp_db, "q", [{"engram_id": eid, "score": 0.9}])

    mark_accessed(tmp_db, eid)
    row = tmp_db.conn.execute(
        "SELECT was_accessed FROM retrieval_feedback WHERE engram_id = ?", (eid,)
    ).fetchone()
    assert row[0] == 1


def test_feedback_update_boosts_useful_memories(tmp_db: Database):
    # Set up: one memory that's retrieved 5 times at rank 1, all 5 are hits
    useful = _insert_engram(tmp_db, "Useful")

    initial_strength = tmp_db.conn.execute(
        "SELECT strength FROM engrams WHERE id = ?", (useful,)
    ).fetchone()[0]

    for _ in range(5):
        log_retrieval(tmp_db, "q", [{"engram_id": useful, "score": 0.9}])
        mark_accessed(tmp_db, useful)

    result = apply_feedback_update(tmp_db, min_retrievals=3)
    assert result["boosted"] >= 1

    new_strength = tmp_db.conn.execute(
        "SELECT strength FROM engrams WHERE id = ?", (useful,)
    ).fetchone()[0]
    assert new_strength > initial_strength


def test_feedback_update_penalizes_noise(tmp_db: Database):
    # A memory retrieved often but never accessed → penalized
    noise = _insert_engram(tmp_db, "Noise")

    initial_strength = tmp_db.conn.execute(
        "SELECT strength FROM engrams WHERE id = ?", (noise,)
    ).fetchone()[0]

    # Log 5 retrievals at rank 3 (deeper hit, stronger IPW signal)
    for _ in range(5):
        log_retrieval(tmp_db, "q", [
            {"engram_id": _insert_engram(tmp_db), "score": 0.9},  # rank 1 (won't penalize)
            {"engram_id": _insert_engram(tmp_db), "score": 0.8},  # rank 2
            {"engram_id": noise, "score": 0.7},                   # rank 3, never accessed
        ])

    result = apply_feedback_update(tmp_db, min_retrievals=3)
    assert result["penalized"] >= 1

    new_strength = tmp_db.conn.execute(
        "SELECT strength FROM engrams WHERE id = ?", (noise,)
    ).fetchone()[0]
    assert new_strength < initial_strength


def test_feedback_update_respects_strength_floor(tmp_db: Database):
    eid = _insert_engram(tmp_db, "FloorTest")

    # Force strength near the floor and run many penalty updates
    tmp_db.conn.execute(
        "UPDATE engrams SET strength = ? WHERE id = ?",
        (DEFAULT_STRENGTH_FLOOR + 0.01, eid),
    )
    tmp_db.conn.commit()

    # Simulate heavy negative feedback
    for _ in range(20):
        log_retrieval(tmp_db, "q", [
            {"engram_id": _insert_engram(tmp_db), "score": 0.9},
            {"engram_id": eid, "score": 0.7},
        ])
        apply_feedback_update(tmp_db, min_retrievals=1)

    final = tmp_db.conn.execute(
        "SELECT strength FROM engrams WHERE id = ?", (eid,)
    ).fetchone()[0]
    # Must never go below the floor
    assert final >= DEFAULT_STRENGTH_FLOOR - 1e-9


def test_feedback_update_skips_below_min_retrievals(tmp_db: Database):
    eid = _insert_engram(tmp_db)
    log_retrieval(tmp_db, "q", [{"engram_id": eid, "score": 0.9}])  # only 1 retrieval

    result = apply_feedback_update(tmp_db, min_retrievals=3)
    assert result["boosted"] == 0
    assert result["penalized"] == 0


def test_feedback_stats_reports_counts(tmp_db: Database):
    eid = _insert_engram(tmp_db, "Stats Test")
    for _ in range(3):
        log_retrieval(tmp_db, "q", [{"engram_id": eid, "score": 0.9}])
        mark_accessed(tmp_db, eid)

    stats = get_feedback_stats(tmp_db)
    assert stats["total_retrievals"] == 3
    assert stats["retrievals_last_24h"] == 3
    assert stats["overall_hit_rate_7d"] == 1.0  # all accessed
    assert any(t["engram_id"] == eid for t in stats["top_useful_memories"])
