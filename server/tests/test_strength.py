import uuid
from datetime import datetime, timedelta, timezone

from engram_server.database import Database
from engram_server.strength import compute_strength, state_from_strength, decay_all


def test_fresh_memory_full_strength():
    """A just-accessed memory should have near-full strength."""
    now = datetime.now(timezone.utc).isoformat()
    strength = compute_strength(now, access_count=0)
    assert strength > 0.95


def test_30_day_decay_halves():
    """After 30 days without access, strength should be ~50% (half-life)."""
    thirty_days_ago = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    strength = compute_strength(thirty_days_ago, access_count=0)
    assert 0.4 < strength < 0.6


def test_high_access_resists_decay():
    """Frequently accessed memories should resist decay."""
    sixty_days_ago = (datetime.now(timezone.utc) - timedelta(days=60)).isoformat()

    low_access = compute_strength(sixty_days_ago, access_count=0)
    high_access = compute_strength(sixty_days_ago, access_count=20)

    assert high_access > low_access
    assert high_access > 0.7  # Should still be strong with 20 accesses


def test_very_old_low_access_is_weak():
    """A 180-day-old memory with no accesses should be very weak."""
    old = (datetime.now(timezone.utc) - timedelta(days=180)).isoformat()
    strength = compute_strength(old, access_count=0)
    assert strength < 0.1


def test_strength_clamped():
    """Strength should always be between 0.0 and 1.0."""
    now = datetime.now(timezone.utc).isoformat()
    assert 0.0 <= compute_strength(now, access_count=0) <= 1.0
    assert 0.0 <= compute_strength(now, access_count=1000) <= 1.0

    old = (datetime.now(timezone.utc) - timedelta(days=9999)).isoformat()
    assert 0.0 <= compute_strength(old, access_count=0) <= 1.0


def test_state_transitions():
    assert state_from_strength(0.90) == "active"
    assert state_from_strength(0.50) == "connected"
    assert state_from_strength(0.25) == "dormant"
    assert state_from_strength(0.10) == "consolidated"


def test_fresh_state():
    """Newly created memories should be 'fresh'."""
    now = datetime.now(timezone.utc).isoformat()
    assert state_from_strength(0.90, created_at=now) == "fresh"


def test_decay_all_updates_db(tmp_db: Database):
    """decay_all should update engram strengths in the database."""
    # Create a memory "accessed" 60 days ago
    eid = str(uuid.uuid4())
    sixty_days_ago = (datetime.now(timezone.utc) - timedelta(days=60)).isoformat()
    tmp_db.conn.execute(
        """INSERT INTO engrams (id, filename, title, content, content_hash,
           strength, state, access_count, accessed_at, created_at)
           VALUES (?, ?, ?, ?, ?, 1.0, 'active', 0, ?, ?)""",
        (eid, "test.md", "Test", "content", "hash", sixty_days_ago, sixty_days_ago),
    )
    tmp_db.conn.commit()

    updated = decay_all(tmp_db)
    assert updated == 1

    engram = tmp_db.get_engram(eid)
    assert engram is not None
    assert engram["strength"] < 0.5  # Should have decayed significantly
    assert engram["state"] != "active"


def test_decay_all_preserves_strong_memories(tmp_db: Database):
    """Recent, frequently accessed memories should stay strong after decay."""
    eid = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    tmp_db.conn.execute(
        """INSERT INTO engrams (id, filename, title, content, content_hash,
           strength, state, access_count, accessed_at, created_at)
           VALUES (?, ?, ?, ?, ?, 1.0, 'active', 15, ?, ?)""",
        (eid, "strong.md", "Strong Memory", "content", "hash", now, now),
    )
    tmp_db.conn.commit()

    decay_all(tmp_db)

    engram = tmp_db.get_engram(eid)
    assert engram is not None
    assert engram["strength"] > 0.9
