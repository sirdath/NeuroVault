//! The clock for adaptive consolidation.
//!
//! `adaptive::consolidate::run_proposal` was complete but had nothing
//! calling it: MemoryReview stayed empty unless a human POSTed
//! `/api/consolidate`. This module is the missing timer — and only the
//! timer. It adds no rules, no execution, no new side effects; it calls
//! the exact same function the endpoint calls
//! (`adaptive::consolidate::run_proposal`), in-process, never over
//! loopback HTTP.
//!
//! ## Why this may default ON
//!
//! A proposal run is INERT. `run_proposal` appends `StoredProposal`
//! records with `review_status: Unreviewed` / `application_status:
//! Pending` and advances a watermark — it never touches an engram. The
//! only code that mutates memory from a proposal is
//! `handlers::proposal_approve`, reached solely by a human clicking
//! Approve in MemoryReview (POST `/api/proposals/:id/approve`). So the
//! worst case of an automatic run is "a review queue has items in it".
//! That is the feature. (The AI-employee scheduler gates on explicit
//! opt-in because employees *act*; this one only *suggests*.)
//!
//! ## Cadence
//!
//! `run_proposal` is cheap and boring: it reads the monthly journal
//! JSONL segments intersecting its window, applies deterministic
//! rules in pure CPU (no DB, no embeddings, no model, no network),
//! reduces `proposals.jsonl`, and appends whatever is new. There is no
//! benefit to running it faster than a human reviews, so the interval
//! is set by cost and recovery guarantees, not by latency:
//!
//! - Every run already replays `GRACE_HOURS` (48h) behind the
//!   watermark, so a 6h cadence re-reads ~54h of journal per run —
//!   bounded, and the overlap is free because `proposal_id` is a hash
//!   of (action, object, evidence): a replayed proposal is recognised
//!   as "already known" and skipped.
//! - A missed tick costs nothing: the pending-turn index keeps
//!   unresolved turns recoverable for `PENDING_TTL_DAYS` (14d).
//!
//! ## Debounce
//!
//! The loop asks one question — `is_due` — at startup and on every
//! poll. It is never "run on boot": a last-run stamp is persisted
//! per-brain, so restarting the app ten times in an hour still yields
//! at most one run. Per-brain (not global) because the run itself,
//! its watermark, and its pending index are all per-brain — a global
//! stamp would starve a brain the user just switched to.

use std::sync::atomic::{AtomicBool, Ordering};

use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use super::adaptive::{consolidate, Scope};
use super::types::{MemoryError, Result};

/// Minimum gap between two automatic proposal runs for one brain.
/// See the cadence note above: cost-driven, not latency-driven.
pub const RUN_INTERVAL_HOURS: i64 = 6;

/// How often the loop wakes to *ask* whether a run is due. Short
/// relative to the interval on purpose: a laptop that slept through
/// its 6h boundary picks the run up at the next poll instead of
/// drifting, and the check itself is one small file read.
pub const CHECK_INTERVAL_SECS: u64 = 30 * 60;

/// Grace period before the first check after launch, so consolidation
/// never competes with startup (server bind, watcher start, first
/// index pass). Startup is not special-cased beyond this delay — it
/// asks `is_due` like every other tick.
pub const STARTUP_DELAY_SECS: u64 = 120;

static STARTED: AtomicBool = AtomicBool::new(false);

/// `~/.neurovault/brains/<id>/consolidation_last_run.txt` — one
/// RFC-3339 line, next to the brain's `consolidation_state.json`
/// watermark it debounces.
pub fn last_run_path(brain_id: &str) -> std::path::PathBuf {
    super::paths::brain_dir(brain_id).join("consolidation_last_run.txt")
}

/// Last automatic run for this brain, or `None` when there has never
/// been one — an unreadable or unparseable stamp is also `None`, which
/// makes a corrupt file fail *towards* running rather than silently
/// disabling the clock.
pub fn read_last_run(brain_id: &str) -> Option<OffsetDateTime> {
    let raw = std::fs::read_to_string(last_run_path(brain_id)).ok()?;
    OffsetDateTime::parse(raw.trim(), &Rfc3339).ok()
}

/// Stamp an attempt (atomic temp + rename). Recorded whether the run
/// succeeded or failed, so a brain that errors every time retries at
/// the normal cadence instead of hammering the poll interval.
pub fn record_run(brain_id: &str, now: OffsetDateTime) -> Result<()> {
    let path = last_run_path(brain_id);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| MemoryError::Other(format!("last-run dir: {e}")))?;
    }
    let tmp = path.with_extension("txt.tmp");
    std::fs::write(&tmp, now.format(&Rfc3339).unwrap_or_default())
        .map_err(|e| MemoryError::Other(format!("last-run write: {e}")))?;
    std::fs::rename(&tmp, &path)
        .map_err(|e| MemoryError::Other(format!("last-run rename: {e}")))?;
    Ok(())
}

/// The debounce decision, isolated from the timer so it is testable.
///
/// A stamp in the future (clock moved backwards, or a hand-edited
/// file) counts as due: the run then rewrites the stamp with `now`,
/// so the anomaly self-corrects after exactly one run instead of
/// stalling consolidation until the clock catches up.
pub fn is_due(last_run: Option<OffsetDateTime>, now: OffsetDateTime) -> bool {
    match last_run {
        None => true,
        Some(prev) if prev > now => true,
        Some(prev) => now - prev >= time::Duration::hours(RUN_INTERVAL_HOURS),
    }
}

/// Full gate for one tick: the Settings toggle, then the debounce.
pub fn should_run(brain_id: &str, now: OffsetDateTime) -> bool {
    super::handlers::consolidation_auto_enabled() && is_due(read_last_run(brain_id), now)
}

/// One automatic run, brain-wide (`room: None`). Blocking; callers use
/// `spawn_blocking`. Returns `(events_read, new_proposals)`.
fn run_once(brain_id: &str) -> Result<(usize, usize)> {
    let scope = Scope::brain(brain_id);
    let outcome = consolidate::run_proposal(&scope);
    // Stamp the attempt either way — see `record_run`.
    let _ = record_run(brain_id, OffsetDateTime::now_utc());
    let report = outcome?;
    Ok((report.events_read, report.proposals.len()))
}

/// One poll: gate, run, log. Every failure path is silent-safe — it
/// logs and returns so the next tick still happens.
async fn tick() {
    let Ok(brain) = super::read_ops::resolve_brain_id(None) else {
        return; // no active brain yet (fresh install) — nothing to do
    };
    if brain.is_empty() || !should_run(&brain, OffsetDateTime::now_utc()) {
        return;
    }
    let target = brain.clone();
    match tokio::task::spawn_blocking(move || run_once(&target)).await {
        Ok(Ok((events, proposals))) => {
            eprintln!("[consolidate] auto run: brain={brain} events={events} proposals={proposals}")
        }
        Ok(Err(e)) => eprintln!("[consolidate] auto run failed for {brain}: {e}"),
        Err(e) => eprintln!("[consolidate] auto run panicked for {brain}: {e}"),
    }
}

/// Start the consolidation clock once per process. Returns
/// immediately; the work happens on a detached task, so this never
/// blocks startup. Must be called from inside a Tokio runtime (the
/// app calls it from the same `tauri::async_runtime::spawn` block
/// that starts the HTTP server and the vault watcher).
pub fn start() {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    tokio::spawn(async move {
        tokio::time::sleep(tokio::time::Duration::from_secs(STARTUP_DELAY_SECS)).await;
        loop {
            tick().await;
            tokio::time::sleep(tokio::time::Duration::from_secs(CHECK_INTERVAL_SECS)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_temp_home<F: FnOnce()>(f: F) {
        let _guard = crate::memory::journal::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let home = std::env::temp_dir().join(format!(
            "nv-consol-sched-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("NEUROVAULT_HOME", &home);
        f();
        std::env::remove_var("NEUROVAULT_HOME");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn fresh_brain_is_due_recent_run_is_not_stale_run_is() {
        let now = OffsetDateTime::now_utc();
        // never run -> run
        assert!(is_due(None, now));
        // ran 10 minutes ago -> skip (restart spam cannot re-trigger)
        assert!(!is_due(Some(now - time::Duration::minutes(10)), now));
        // ran just under the interval -> still skip
        assert!(!is_due(
            Some(now - time::Duration::hours(RUN_INTERVAL_HOURS) + time::Duration::minutes(1)),
            now
        ));
        // exactly at the interval -> run
        assert!(is_due(
            Some(now - time::Duration::hours(RUN_INTERVAL_HOURS)),
            now
        ));
        // long stale -> run
        assert!(is_due(Some(now - time::Duration::days(3)), now));
    }

    #[test]
    fn future_stamp_does_not_stall_the_clock() {
        let now = OffsetDateTime::now_utc();
        assert!(is_due(Some(now + time::Duration::hours(48)), now));
    }

    #[test]
    fn last_run_persists_across_reads_and_debounces_the_next_tick() {
        with_temp_home(|| {
            let brain = "sched-test";
            assert!(read_last_run(brain).is_none());
            assert!(is_due(read_last_run(brain), OffsetDateTime::now_utc()));

            let stamped = OffsetDateTime::now_utc();
            record_run(brain, stamped).unwrap();

            let back = read_last_run(brain).expect("stamp must round-trip");
            assert!((back - stamped).abs() < time::Duration::seconds(2));
            // Immediately after a run: not due.
            assert!(!is_due(read_last_run(brain), OffsetDateTime::now_utc()));
            // Six hours later: due again.
            assert!(is_due(
                read_last_run(brain),
                OffsetDateTime::now_utc() + time::Duration::hours(RUN_INTERVAL_HOURS)
            ));
        });
    }

    #[test]
    fn corrupt_last_run_file_fails_towards_running() {
        with_temp_home(|| {
            let brain = "sched-corrupt";
            let path = last_run_path(brain);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "not-a-timestamp").unwrap();
            assert!(read_last_run(brain).is_none());
            assert!(is_due(read_last_run(brain), OffsetDateTime::now_utc()));
        });
    }

    #[test]
    fn settings_toggle_gates_the_run_and_defaults_on() {
        with_temp_home(|| {
            let brain = "sched-toggle";
            let now = OffsetDateTime::now_utc();
            // No pref file -> ON (proposals are inert; see module docs).
            assert!(should_run(brain, now));

            let pref = crate::memory::handlers::consolidation_auto_pref_path();
            std::fs::create_dir_all(pref.parent().unwrap()).unwrap();
            std::fs::write(&pref, "off").unwrap();
            assert!(!should_run(brain, now));

            std::fs::write(&pref, "on").unwrap();
            assert!(should_run(brain, now));
        });
    }
}
