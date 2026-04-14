"""Tests for the 2026 retriever additions: temporal intent, as_of, exclude_kinds, ms timestamps."""

import uuid

from engram_server.bm25_index import BM25Index
from engram_server.database import Database
from engram_server.retriever import (
    classify_temporal_intent,
    _recency_params,
    _recency_lambda,
    _age_days,
    hybrid_retrieve,
)


# --- Temporal intent classifier -------------------------------------------

def test_intent_fresh_for_latest_keyword():
    assert classify_temporal_intent("what is my latest setup") == "fresh"
    assert classify_temporal_intent("what did I do today") == "fresh"
    assert classify_temporal_intent("the most recent decision about X") == "fresh"
    assert classify_temporal_intent("currently using which DB") == "fresh"


def test_intent_historical_for_past_keywords():
    assert classify_temporal_intent("what was my original plan") == "historical"
    assert classify_temporal_intent("what did we use initially") == "historical"
    assert classify_temporal_intent("originally we chose X") == "historical"
    assert classify_temporal_intent("back then we thought") == "historical"


def test_intent_neutral_for_ambiguous():
    assert classify_temporal_intent("who is the project lead") == "neutral"
    assert classify_temporal_intent("explain how authentication works") == "neutral"
    assert classify_temporal_intent("") == "neutral"


def test_intent_neutral_when_both_signals_present():
    # Conservative fallback: contradictory signals → neutral, not a wrong bet
    assert classify_temporal_intent("what is the latest original decision") == "neutral"


# --- Recency params -------------------------------------------------------

def test_recency_params_fresh_strong_spread():
    newest, oldest = _recency_params("fresh")
    assert newest > oldest
    assert newest == 1.00
    assert oldest < 0.8


def test_recency_params_historical_inverted():
    newest, oldest = _recency_params("historical")
    assert oldest > newest
    assert oldest == 1.00


def test_recency_params_neutral_flat():
    newest, oldest = _recency_params("neutral")
    assert newest == oldest == 1.00


def test_recency_lambda_historical_is_zero():
    assert _recency_lambda("historical") == 0.0


def test_recency_lambda_fresh_positive():
    assert _recency_lambda("fresh") > _recency_lambda("neutral") > 0


# --- Age computation ------------------------------------------------------

def test_age_days_handles_none_and_empty():
    assert _age_days(None) == 0.0
    assert _age_days("") == 0.0
    assert _age_days("not-a-date") == 0.0


def test_age_days_positive_for_past_timestamps():
    # A very old date should give a large age
    age = _age_days("2020-01-01 00:00:00")
    assert age > 1000  # More than ~3 years of days


def test_age_days_zero_for_near_now():
    from datetime import datetime, timezone
    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%f")
    age = _age_days(now_str)
    assert age < 0.01  # Well under a day


# --- Millisecond timestamps -----------------------------------------------

def test_insert_engram_uses_millisecond_timestamps(tmp_db: Database):
    """Every new engram's timestamp should include a fractional-second component.

    The purpose: SQLite's default `datetime('now')` is second-resolution,
    which causes tied timestamps in rapid ingests and breaks the
    recency-sort tiebreakers. We use `strftime('%Y-%m-%d %H:%M:%f', 'now')`
    to get ms resolution. On fast machines two inserts can still collide
    at ms granularity, so we don't assert uniqueness — we only require
    that the ms format is present.
    """
    eids = []
    for i in range(5):
        eid = str(uuid.uuid4())
        tmp_db.insert_engram(eid, f"f{i}.md", f"Note {i}", f"body {i}", f"hash{i}")
        eids.append(eid)

    timestamps = [
        tmp_db.conn.execute(
            "SELECT created_at FROM engrams WHERE id = ?", (eid,)
        ).fetchone()[0]
        for eid in eids
    ]
    # Each timestamp must have ms precision, i.e. include a dot-separated
    # fractional component of 3+ digits.
    for ts in timestamps:
        assert "." in ts, f"second-resolution timestamp leaked: {ts}"
        frac = ts.split(".", 1)[1]
        assert len(frac) >= 3, f"expected ≥3 decimal places, got {ts}"


# --- exclude_kinds filter -------------------------------------------------

def _insert_engram_with_kind(db: Database, title: str, kind: str) -> str:
    eid = str(uuid.uuid4())
    db.insert_engram(eid, f"{eid}.md", title, f"{title} body", "h")
    db.conn.execute("UPDATE engrams SET kind = ? WHERE id = ?", (kind, eid))
    db.conn.commit()
    return eid


def test_exclude_kinds_removes_observations_by_default(tmp_db: Database, embedder):
    from engram_server.ingest import ingest_file
    from pathlib import Path
    import tempfile

    vault = Path(tempfile.mkdtemp()) / "vault"
    vault.mkdir()
    bm25 = BM25Index()

    # Create a regular memory and a fake observation about the same topic
    p1 = vault / "note.md"
    p1.write_text("# Real Memory\n\nImportant insight about authentication.", encoding="utf-8")
    real_eid = ingest_file(p1, tmp_db, embedder, bm25)

    p2 = vault / "obs-xyz-posttooluse-abc.md"
    p2.write_text("# Edit · xyz\n\nTool call about authentication edited file.", encoding="utf-8")
    obs_eid = ingest_file(p2, tmp_db, embedder, bm25)
    tmp_db.conn.execute(
        "UPDATE engrams SET kind = 'observation' WHERE id = ?", (obs_eid,)
    )
    tmp_db.conn.commit()
    bm25.build(tmp_db)

    # Default: observation excluded
    results = hybrid_retrieve("authentication", tmp_db, embedder, bm25, top_k=5)
    ids = [r["engram_id"] for r in results]
    assert real_eid in ids
    assert obs_eid not in ids

    # Explicit include: observation visible
    results_all = hybrid_retrieve(
        "authentication", tmp_db, embedder, bm25, top_k=5, exclude_kinds=[]
    )
    ids_all = [r["engram_id"] for r in results_all]
    assert real_eid in ids_all
    assert obs_eid in ids_all


def test_exclude_kinds_custom_list(tmp_db: Database, embedder):
    """Custom exclude_kinds should drop the specified kinds only."""
    from engram_server.ingest import ingest_file
    from pathlib import Path
    import tempfile

    vault = Path(tempfile.mkdtemp()) / "vault"
    vault.mkdir()
    bm25 = BM25Index()

    p1 = vault / "note.md"
    p1.write_text("# Note\n\ncommon topic", encoding="utf-8")
    ingest_file(p1, tmp_db, embedder, bm25)

    p2 = vault / "draft.md"
    p2.write_text("# Draft\n\ncommon topic", encoding="utf-8")
    draft_eid = ingest_file(p2, tmp_db, embedder, bm25)
    tmp_db.conn.execute("UPDATE engrams SET kind = 'draft' WHERE id = ?", (draft_eid,))
    tmp_db.conn.commit()
    bm25.build(tmp_db)

    # Exclude drafts explicitly
    results = hybrid_retrieve(
        "common topic", tmp_db, embedder, bm25, top_k=5, exclude_kinds=["draft"]
    )
    ids = [r["engram_id"] for r in results]
    assert draft_eid not in ids
