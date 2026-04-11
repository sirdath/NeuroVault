"""Memory strength model — Ebbinghaus forgetting curve with access reinforcement.

Memories decay over time but are reinforced by access. This creates a natural
prioritization: frequently retrieved memories stay strong, unused ones fade.

States:
  - fresh:        < 1 day old
  - active:       strength > 0.70
  - connected:    strength > 0.40
  - dormant:      strength <= 0.20
  - consolidated: merged with other memories (future)
"""

import math
import threading
from datetime import datetime, timezone

from loguru import logger

from engram_server.database import Database

# Half-life in days: after 30 days without access, strength drops to 50%
DECAY_HALF_LIFE = 30.0


def compute_strength(
    accessed_at: str | None,
    access_count: int,
    created_at: str | None = None,
) -> float:
    """Compute memory strength using Ebbinghaus forgetting curve.

    Args:
        accessed_at: ISO datetime string of last access
        access_count: Total number of times this memory was retrieved
        created_at: ISO datetime string of creation

    Returns:
        Strength value between 0.0 and 1.0
    """
    now = datetime.now(timezone.utc)

    if accessed_at:
        try:
            last_access = datetime.fromisoformat(accessed_at.replace('Z', '+00:00'))
            if last_access.tzinfo is None:
                last_access = last_access.replace(tzinfo=timezone.utc)
        except (ValueError, AttributeError):
            last_access = now
    else:
        last_access = now

    days_elapsed = max(0, (now - last_access).total_seconds() / 86400)

    # Ebbinghaus forgetting curve: exponential decay
    decay_rate = math.log(2) / DECAY_HALF_LIFE
    base_decay = math.exp(-decay_rate * days_elapsed)

    # Access reinforcement: diminishing returns after ~15 accesses
    # More accesses = slower decay
    access_boost = 1 - math.exp(-access_count / 5)

    # Final strength: high-access memories resist decay
    strength = base_decay * (1 - access_boost) + access_boost

    return max(0.0, min(1.0, strength))


def state_from_strength(strength: float, created_at: str | None = None) -> str:
    """Determine memory state from strength value."""
    # Check if freshly created (< 1 day)
    if created_at:
        try:
            created = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
            if created.tzinfo is None:
                created = created.replace(tzinfo=timezone.utc)
            now = datetime.now(timezone.utc)
            if (now - created).total_seconds() < 86400:
                return "fresh"
        except (ValueError, AttributeError):
            pass

    if strength > 0.70:
        return "active"
    if strength > 0.40:
        return "connected"
    if strength > 0.20:
        return "dormant"
    return "consolidated"


def decay_all(db: Database) -> int:
    """Run decay computation on all engrams. Returns count of updated engrams."""
    engrams = db.conn.execute(
        "SELECT id, accessed_at, access_count, created_at, strength, state FROM engrams WHERE state != 'dormant'"
    ).fetchall()

    updated = 0
    for e in engrams:
        eid, accessed_at, access_count, created_at, old_strength, old_state = (
            e[0], e[1], e[2], e[3], e[4], e[5]
        )

        new_strength = compute_strength(accessed_at, access_count, created_at)
        new_state = state_from_strength(new_strength, created_at)

        if abs(new_strength - old_strength) > 0.001 or new_state != old_state:
            db.conn.execute(
                "UPDATE engrams SET strength = ?, state = ? WHERE id = ?",
                (round(new_strength, 4), new_state, eid),
            )
            updated += 1

    db.conn.commit()
    if updated > 0:
        logger.info("Decay pass: updated {}/{} engrams", updated, len(engrams))
    return updated


class DecayScheduler:
    """Runs decay_all periodically in a background thread."""

    def __init__(self, db: Database, interval_seconds: float = 3600) -> None:
        self.db = db
        self.interval = interval_seconds
        self._timer: threading.Timer | None = None
        self._running = False

    def start(self) -> None:
        """Start the periodic decay job."""
        self._running = True
        # Run immediately on start
        decay_all(self.db)
        self._schedule_next()
        logger.info("Decay scheduler started (interval: {}s)", self.interval)

    def _schedule_next(self) -> None:
        if not self._running:
            return
        self._timer = threading.Timer(self.interval, self._tick)
        self._timer.daemon = True
        self._timer.start()

    def _tick(self) -> None:
        if not self._running:
            return
        try:
            decay_all(self.db)
        except Exception as e:
            logger.error("Decay job failed: {}", e)
        self._schedule_next()

    def stop(self) -> None:
        self._running = False
        if self._timer:
            self._timer.cancel()
