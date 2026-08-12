//! Run ledger, watermark, retry, run audit (guide §2.6, slice A6/B4).
//!
//! Will own: `curator_state.json` (watermark + per-unit attempts, cap 3,
//! exhaustion recorded VISIBLY), `curator_runs.jsonl` (`CuratorRunAudit`
//! — one safe line per unit outcome, rejects included because they are
//! the false-reject numerator), and the durable ordering contract:
//! append proposals → append audit → update retry state → advance
//! watermark, where an audit-append failure blocks the watermark.
//!
//! Curator-owned files only. Never share `consolidation_state.json`:
//! deterministic consolidation runs 6-hourly and the curator batch is
//! ~87 s/unit nightly, so a shared watermark would couple their failure
//! modes.
//!
//! Wave 0 stub: declared in `mod.rs` up front so no later wave has to
//! edit that shared file. Filling this in is slice A6/B4 (Wave 1C).
