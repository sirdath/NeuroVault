"""Generate L0/L1 summaries for every engram that doesn't have them.

Heuristic only — no LLM calls, ~1ms per engram. Run after migrating the
schema so existing vaults pick up tiered summaries without a full
re-ingest. Idempotent: only touches rows where both summary columns
are NULL.

Usage:
  # From server/ with venv active:
  python -m scripts.backfill_summaries
"""

from __future__ import annotations

import sys
import time

from neurovault_server.brain import BrainManager
from neurovault_server.summaries import generate_summaries


def backfill_brain(ctx) -> tuple[int, int]:
    """Returns (updated, scanned)."""
    rows = ctx.db.conn.execute(
        """SELECT id, title, content FROM engrams
           WHERE (summary_l0 IS NULL OR summary_l0 = '')
             AND (summary_l1 IS NULL OR summary_l1 = '')
             AND state != 'dormant'"""
    ).fetchall()
    scanned = len(rows)
    updated = 0
    for row in rows:
        eid, title, content = row[0], row[1], row[2]
        if not content:
            continue
        l0, l1 = generate_summaries(content or "", title=title or "")
        ctx.db.conn.execute(
            "UPDATE engrams SET summary_l0 = ?, summary_l1 = ? WHERE id = ?",
            (l0 or None, l1 or None, eid),
        )
        updated += 1
        if updated % 50 == 0:
            ctx.db.conn.commit()
    ctx.db.conn.commit()
    return updated, scanned


def main() -> int:
    mgr = BrainManager()
    total_updated = 0
    total_scanned = 0
    brains = mgr.list_brains()
    print(f"Backfilling L0/L1 across {len(brains)} brain(s)...")
    for b in brains:
        bid = b["id"]
        try:
            ctx = mgr.get_context(bid, activate=False)
        except Exception as e:
            print(f"  [skip] {bid}: {e}")
            continue
        t0 = time.perf_counter()
        updated, scanned = backfill_brain(ctx)
        dt = time.perf_counter() - t0
        print(f"  {bid}: {updated}/{scanned} updated in {dt*1000:.0f}ms")
        total_updated += updated
        total_scanned += scanned
    print(f"\nDone: {total_updated}/{total_scanned} engrams got L0/L1 summaries")
    return 0


if __name__ == "__main__":
    sys.exit(main())
