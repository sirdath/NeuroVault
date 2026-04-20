"""Tests for the BM25 rebuild debounce — the write-amplification fix.

A burst of ingests used to each trigger a full O(chunks) BM25Okapi
rebuild on the single-worker slow-phase executor. On a mature brain
with Claude Code observation hooks firing 10+/min that sustained
enough CPU to TDR-crash unstable Intel iGPU drivers. The fix is
``BM25Index.schedule_rebuild(db)`` which debounces to one rebuild
per quiet window. This file pins that behaviour."""

from __future__ import annotations

import time
from unittest.mock import patch

from neurovault_server.bm25_index import BM25Index


def test_schedule_rebuild_coalesces_burst(tmp_db, embedder):
    """20 schedule_rebuild calls inside the window → exactly 1 build."""
    bm25 = BM25Index()

    build_calls = 0
    real_build = BM25Index.build

    def counting_build(self, db):
        nonlocal build_calls
        build_calls += 1
        return real_build(self, db)

    with patch.object(BM25Index, "build", counting_build):
        for _ in range(20):
            # Tight delay so the test finishes quickly while still
            # exercising the coalescing path — each call cancels the
            # previous timer before it can fire.
            bm25.schedule_rebuild(tmp_db, delay=0.15)
            time.sleep(0.01)

        # Wait long enough that the final debounce fires.
        time.sleep(0.4)

    assert build_calls == 1, (
        f"expected one coalesced rebuild, got {build_calls} — the debounce "
        f"regressed and per-write CPU amplification is back"
    )


def test_flush_runs_immediately_and_cancels_pending(tmp_db, embedder):
    """flush() should rebuild synchronously and skip a scheduled rebuild."""
    bm25 = BM25Index()

    build_calls = 0
    real_build = BM25Index.build

    def counting_build(self, db):
        nonlocal build_calls
        build_calls += 1
        return real_build(self, db)

    with patch.object(BM25Index, "build", counting_build):
        bm25.schedule_rebuild(tmp_db, delay=5.0)  # won't fire in this test window
        bm25.flush(tmp_db)
        time.sleep(0.2)  # a scheduled timer would have had time to fire here

    assert build_calls == 1, "flush should run exactly one build synchronously"


def test_schedule_rebuild_survives_build_failure(tmp_db, embedder):
    """A failing rebuild should clear the timer so the next schedule works."""
    bm25 = BM25Index()

    calls = {"n": 0}

    def flaky_build(self, db):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("simulated DB hiccup")

    with patch.object(BM25Index, "build", flaky_build):
        bm25.schedule_rebuild(tmp_db, delay=0.1)
        time.sleep(0.25)
        bm25.schedule_rebuild(tmp_db, delay=0.1)
        time.sleep(0.25)

    assert calls["n"] == 2, "second schedule_rebuild should run despite first failing"
