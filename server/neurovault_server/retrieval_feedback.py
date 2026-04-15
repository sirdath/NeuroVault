"""Implicit feedback loop — self-improving recall from usage signals.

Every `recall()` logs its top-K results to `retrieval_feedback`. When the
user (via Claude) subsequently does an explicit `fetch(engram_id)` within
a short window, that counts as a positive usage signal: the retrieved
memory was actually consumed. Engrams that are frequently retrieved but
never fetched are either noise or position-biased clutter.

Stage 1 of the self-improvement pipeline. Runs entirely from usage
without any LLM calls. Safety rails inspired by online-L2R research:

- Position-bias correction via inverse propensity weighting (lower-rank
  hits are discounted, deeper hits amplified)
- Per-pass bounded delta (`max_delta`) to prevent runaway updates
- Strength floor (`strength_floor`) to prevent permadeath of rarely-used
  but critical memories
- Minimum retrieval count before any update (`min_retrievals`) to avoid
  overfitting on one-off queries
"""

from __future__ import annotations

from loguru import logger

from neurovault_server.database import Database


# Window in which a fetch counts as "used after recall"
ACCESS_WINDOW_MINUTES = 60

# Default hyperparameters for the feedback update job
DEFAULT_MIN_RETRIEVALS = 3
DEFAULT_MAX_DELTA = 0.05
DEFAULT_STRENGTH_FLOOR = 0.2
DEFAULT_STRENGTH_CEILING = 1.5
DEFAULT_WINDOW_DAYS = 7
DEFAULT_HIT_THRESHOLD = 0.5
DEFAULT_MISS_THRESHOLD = 0.15


def log_retrieval(db: Database, query: str, results: list[dict]) -> int:
    """Record the top-K results of a recall for later feedback analysis.

    Stores one row per returned engram with its rank and score. Subsequent
    explicit fetches for any of these engrams will flip `was_accessed` to
    1 via `mark_accessed`.
    """
    if not results:
        return 0
    rows = [
        (query[:200], r.get("engram_id"), rank, float(r.get("score") or 0.0))
        for rank, r in enumerate(results, 1)
        if r.get("engram_id")
    ]
    if not rows:
        return 0
    try:
        db.conn.executemany(
            "INSERT INTO retrieval_feedback (query, engram_id, rank, score) VALUES (?, ?, ?, ?)",
            rows,
        )
        db.conn.commit()
    except Exception as e:
        logger.debug("retrieval_feedback: log failed: {}", e)
        return 0
    return len(rows)


def mark_accessed(db: Database, engram_id: str) -> None:
    """Mark recent retrieval_feedback rows for an engram as accessed.

    Called when an explicit fetch-by-id happens after a recall. Only
    flips rows within the access window so stale retrievals don't get
    retroactively credited.
    """
    try:
        db.conn.execute(
            f"""UPDATE retrieval_feedback
                SET was_accessed = 1,
                    accessed_at = datetime('now')
                WHERE engram_id = ?
                  AND was_accessed = 0
                  AND retrieved_at >= datetime('now', '-{ACCESS_WINDOW_MINUTES} minutes')""",
            (engram_id,),
        )
        db.conn.commit()
    except Exception as e:
        logger.debug("retrieval_feedback: mark_accessed failed: {}", e)


def apply_feedback_update(
    db: Database,
    min_retrievals: int = DEFAULT_MIN_RETRIEVALS,
    max_delta: float = DEFAULT_MAX_DELTA,
    strength_floor: float = DEFAULT_STRENGTH_FLOOR,
    strength_ceiling: float = DEFAULT_STRENGTH_CEILING,
    window_days: int = DEFAULT_WINDOW_DAYS,
    hit_threshold: float = DEFAULT_HIT_THRESHOLD,
    miss_threshold: float = DEFAULT_MISS_THRESHOLD,
) -> dict:
    """Apply bounded strength deltas to engrams based on recent feedback.

    For every engram seen at least `min_retrievals` times in the last
    `window_days` days, compute its hit_rate = hits / retrievals.

    - hit_rate > hit_threshold → positive delta (inverse-propensity scaled)
    - hit_rate < miss_threshold → negative delta (inverse-propensity scaled)
    - otherwise → no change

    Position bias correction: a memory that got a hit at rank 1 carries
    less information than one at rank 5 (the deeper one overcame ranking
    gravity to be useful). We scale the delta by avg_rank / 5.

    Returns a dict of stats for observability.
    """
    try:
        rows = db.conn.execute(
            f"""SELECT engram_id,
                       COUNT(*)  AS retrievals,
                       SUM(was_accessed) AS hits,
                       AVG(rank) AS avg_rank
                FROM retrieval_feedback
                WHERE retrieved_at >= datetime('now', '-{int(window_days)} days')
                GROUP BY engram_id
                HAVING retrievals >= ?""",
            (min_retrievals,),
        ).fetchall()
    except Exception as e:
        logger.warning("retrieval_feedback: update failed to gather: {}", e)
        return {"error": str(e), "updated": 0}

    boosted = 0
    penalized = 0
    skipped = 0
    for engram_id, retrievals, hits, avg_rank in rows:
        hits = hits or 0
        rate = hits / retrievals if retrievals else 0.0

        if rate >= hit_threshold:
            raw = (rate - hit_threshold) * 2  # 0..1 for rate in [0.5..1]
            sign = 1
        elif rate <= miss_threshold:
            raw = (miss_threshold - rate) / max(miss_threshold, 0.0001)
            sign = -1
        else:
            skipped += 1
            continue

        # Inverse-propensity scaling: deeper hits carry more weight
        ipw_scale = min(1.0, max(0.2, (avg_rank or 1.0) / 5.0))
        delta = sign * min(max_delta, raw * max_delta * ipw_scale)

        try:
            db.conn.execute(
                """UPDATE engrams
                   SET strength = MAX(?, MIN(?, strength + ?))
                   WHERE id = ?""",
                (strength_floor, strength_ceiling, delta, engram_id),
            )
            if sign > 0:
                boosted += 1
            else:
                penalized += 1
        except Exception as e:
            logger.debug("retrieval_feedback: update failed for {}: {}", engram_id, e)

    db.conn.commit()
    logger.info(
        "retrieval_feedback: boosted={} penalized={} skipped={} (window={}d)",
        boosted, penalized, skipped, window_days,
    )
    return {
        "boosted": boosted,
        "penalized": penalized,
        "skipped": skipped,
        "considered": len(rows),
        "window_days": window_days,
    }


def get_feedback_stats(db: Database) -> dict:
    """Observability: how is the feedback loop performing?"""
    try:
        total = db.conn.execute(
            "SELECT COUNT(*) FROM retrieval_feedback"
        ).fetchone()[0]
        recent_24h = db.conn.execute(
            "SELECT COUNT(*) FROM retrieval_feedback WHERE retrieved_at >= datetime('now', '-1 day')"
        ).fetchone()[0]
        hit_rate_7d_row = db.conn.execute(
            "SELECT AVG(was_accessed) FROM retrieval_feedback WHERE retrieved_at >= datetime('now', '-7 days')"
        ).fetchone()
        hit_rate_7d = hit_rate_7d_row[0] if hit_rate_7d_row and hit_rate_7d_row[0] is not None else 0.0

        top_engrams = db.conn.execute(
            """SELECT r.engram_id, e.title,
                      COUNT(*) AS retrievals,
                      SUM(r.was_accessed) AS hits,
                      AVG(r.rank) AS avg_rank
               FROM retrieval_feedback r
               JOIN engrams e ON e.id = r.engram_id
               WHERE r.retrieved_at >= datetime('now', '-7 days')
               GROUP BY r.engram_id
               ORDER BY hits DESC, retrievals DESC
               LIMIT 10"""
        ).fetchall()

        return {
            "total_retrievals": total,
            "retrievals_last_24h": recent_24h,
            "overall_hit_rate_7d": round(float(hit_rate_7d), 3),
            "top_useful_memories": [
                {
                    "engram_id": r[0],
                    "title": r[1],
                    "retrievals": r[2],
                    "hits": r[3] or 0,
                    "avg_rank": round(float(r[4] or 0), 2),
                }
                for r in top_engrams
            ],
        }
    except Exception as e:
        return {"error": str(e)}
