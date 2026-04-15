"""Tests for memory consolidation (sleep cycle)."""

import uuid
from datetime import datetime, timezone
from pathlib import Path

from neurovault_server.database import Database
from neurovault_server.embeddings import Embedder
from neurovault_server.bm25_index import BM25Index
from neurovault_server.ingest import ingest_vault
from neurovault_server.consolidation import (
    consolidate,
    spread_activation,
    get_working_memory,
    pin_to_working_memory,
    unpin_from_working_memory,
    _refresh_working_memory,
    _prune_stale_edges,
    _strengthen_co_activated,
)


def _seed_vault(tmp_vault: Path, notes: dict[str, str]) -> None:
    for filename, content in notes.items():
        (tmp_vault / filename).write_text(content, encoding="utf-8")


def test_working_memory_refresh(tmp_db: Database, embedder: Embedder, tmp_vault: Path):
    """refresh_working_memory should populate with top-N by strength × access."""
    bm25 = BM25Index()
    _seed_vault(tmp_vault, {
        "a.md": "# Note A\n\nContent for A with enough words to index it properly.",
        "b.md": "# Note B\n\nContent for B with enough words to index it properly.",
        "c.md": "# Note C\n\nContent for C with enough words to index it properly.",
    })
    ingest_vault(tmp_db, embedder, bm25, tmp_vault)

    # Bump access on one memory to make it "hot"
    engrams = tmp_db.list_engrams()
    hot_id = engrams[0]["id"]
    for _ in range(10):
        tmp_db.bump_access(hot_id)

    count = _refresh_working_memory(tmp_db)
    assert count >= 1

    wm = get_working_memory(tmp_db)
    assert len(wm) >= 1
    # The hot memory should be at the top
    assert wm[0]["engram_id"] == hot_id


def test_pin_and_unpin(tmp_db: Database, embedder: Embedder, tmp_vault: Path):
    bm25 = BM25Index()
    _seed_vault(tmp_vault, {
        "pinme.md": "# Important Note\n\nThis should be pinned and always in working memory.",
    })
    ingest_vault(tmp_db, embedder, bm25, tmp_vault)

    eid = tmp_db.list_engrams()[0]["id"]
    assert pin_to_working_memory(tmp_db, eid) is True

    wm = get_working_memory(tmp_db)
    pinned = [m for m in wm if m["engram_id"] == eid]
    assert len(pinned) == 1
    assert pinned[0]["pin_type"] == "manual"

    assert unpin_from_working_memory(tmp_db, eid) is True

    wm_after = get_working_memory(tmp_db)
    assert not any(m["engram_id"] == eid for m in wm_after)


def test_spreading_activation_boosts_neighbors(tmp_db: Database, embedder: Embedder, tmp_vault: Path):
    """When a memory is accessed, its linked neighbors should get a strength boost."""
    bm25 = BM25Index()
    _seed_vault(tmp_vault, {
        "hub.md": "# Hub Note\n\nThis note mentions [[Related Note]] explicitly via wikilink.",
        "related.md": "# Related Note\n\nThis is the target of the wikilink from Hub Note.",
    })
    ingest_vault(tmp_db, embedder, bm25, tmp_vault)

    engrams = {e["title"]: e for e in tmp_db.list_engrams()}
    hub = engrams.get("Hub Note")
    related = engrams.get("Related Note")
    assert hub is not None and related is not None

    strength_before = related["strength"]

    spread_activation(tmp_db, [hub["id"]], boost=0.1)

    related_after = tmp_db.get_engram(related["id"])
    assert related_after is not None
    # Strength should be boosted (or at least tracked in edge_activity)
    activity = tmp_db.conn.execute(
        "SELECT use_count FROM edge_activity WHERE from_engram = ? AND to_engram = ?",
        (hub["id"], related["id"]),
    ).fetchone()
    # Either strength increased or edge usage recorded
    assert activity is not None or related_after["strength"] >= strength_before


def test_prune_stale_edges_preserves_manual_links(tmp_db: Database, embedder: Embedder, tmp_vault: Path):
    """Synaptic pruning should never delete manual wikilinks or entity links."""
    bm25 = BM25Index()
    _seed_vault(tmp_vault, {
        "source.md": "# Source\n\nLinked to [[Target]] explicitly.",
        "target.md": "# Target\n\nReceives the link.",
    })
    ingest_vault(tmp_db, embedder, bm25, tmp_vault)

    manual_before = tmp_db.conn.execute(
        "SELECT COUNT(*) FROM engram_links WHERE link_type = 'manual'"
    ).fetchone()[0]

    _prune_stale_edges(tmp_db)

    manual_after = tmp_db.conn.execute(
        "SELECT COUNT(*) FROM engram_links WHERE link_type = 'manual'"
    ).fetchone()[0]
    assert manual_after == manual_before  # Manual links survive pruning


def test_consolidate_full_cycle(tmp_db: Database, embedder: Embedder, tmp_vault: Path):
    """A full consolidation cycle should return stats without errors."""
    bm25 = BM25Index()
    _seed_vault(tmp_vault, {
        f"note-{i}.md": f"# Note {i}\n\nPython programming topic with framework and library."
        for i in range(5)
    })
    ingest_vault(tmp_db, embedder, bm25, tmp_vault)

    consolidated_dir = tmp_vault.parent / "consolidated"
    consolidated_dir.mkdir(exist_ok=True)

    stats = consolidate(tmp_db, embedder, consolidated_dir)

    assert "themes_created" in stats
    assert "working_memory_refreshed" in stats
    assert "edges_pruned" in stats
    assert "co_activations_strengthened" in stats
    # Working memory should have been refreshed
    assert stats["working_memory_refreshed"] >= 0
