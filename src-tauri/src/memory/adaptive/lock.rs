//! Per-brain single-flight lock for proposal-store writers.
//!
//! The spec requires that "all proposal-mode consolidation for a brain
//! runs under one per-brain lock covering read, dedup check, append,
//! ledger updates, and watermark advance" — the current
//! read-check-append flow in `consolidate::run_proposal` is otherwise
//! vulnerable to two concurrent runs interleaving and appending the
//! same proposal twice.
//!
//! Three callers can already race `run_proposal` today (the
//! consolidation scheduler tick, `POST /api/consolidate?mode=proposal`,
//! and the MemoryReview button), and the local memory curator adds a
//! fourth writer family. They all serialize here.
//!
//! Shape: one in-process registry of in-flight brain ids, guarded by a
//! single short-lived mutex (precedent: `journal::IDEMPOTENT_APPEND_LOCK`).
//! No file lock — the app is the only writer process, and a file lock
//! would survive a crash without a live owner.
//!
//! **Try-acquire, not blocking.** A second caller must lose *cleanly*:
//! a nightly curator run that collides with a manual consolidation
//! should skip this tick and try again later, not queue behind a
//! 45-minute batch holding a thread hostage. `try_acquire_brain_run`
//! therefore returns `None` rather than waiting. (The implementation
//! guide sketched a blocking `with_brain_run_lock`; the spec's
//! single-flight requirement and the "second caller loses cleanly"
//! contract are what this module actually implements. A blocking
//! variant can be added the day a caller genuinely wants to wait —
//! nothing here forbids it.)
//!
//! The registry mutex is never held across `f`, so a long run never
//! blocks an unrelated brain, and a panic inside `f` still releases the
//! lock (the guard drops during unwind).

use std::collections::BTreeSet;
use std::fmt;
use std::sync::{Mutex, MutexGuard};

/// Brain ids with a proposal-store run in flight, in this process.
static IN_FLIGHT: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

fn in_flight() -> MutexGuard<'static, BTreeSet<String>> {
    // Poison-tolerant, exactly like journal.rs: a panic in one run must
    // not permanently wedge every future run of every brain.
    IN_FLIGHT.lock().unwrap_or_else(|p| p.into_inner())
}

/// RAII proof that this thread owns the run slot for one brain.
/// Dropping it releases the slot — including while unwinding.
#[derive(Debug)]
pub struct BrainRunGuard {
    brain_id: String,
}

impl BrainRunGuard {
    pub fn brain_id(&self) -> &str {
        &self.brain_id
    }
}

impl Drop for BrainRunGuard {
    fn drop(&mut self) {
        in_flight().remove(&self.brain_id);
    }
}

/// The loser's answer: somebody else is already running for this brain.
/// Deliberately a distinct type, not a string, so callers can map it to
/// "skip this tick" / HTTP 409 instead of guessing from an error message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrainRunBusy {
    pub brain_id: String,
}

impl fmt::Display for BrainRunBusy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "a proposal run is already in flight for brain '{}' (single-flight lock)",
            self.brain_id
        )
    }
}

impl std::error::Error for BrainRunBusy {}

/// Take the run slot for `brain_id`, or `None` if it is taken.
/// Never blocks.
pub fn try_acquire_brain_run(brain_id: &str) -> Option<BrainRunGuard> {
    let mut set = in_flight();
    if set.contains(brain_id) {
        return None;
    }
    set.insert(brain_id.to_string());
    Some(BrainRunGuard {
        brain_id: brain_id.to_string(),
    })
}

/// Run `f` under the per-brain run lock. Wrap BOTH
/// `consolidate::run_proposal` and (from Wave 3) `curator::runner::run_brain`
/// in this. The second caller gets `Err(BrainRunBusy)` immediately and is
/// expected to skip, not retry in a spin.
pub fn try_with_brain_run_lock<T>(
    brain_id: &str,
    f: impl FnOnce() -> T,
) -> Result<T, BrainRunBusy> {
    let Some(_guard) = try_acquire_brain_run(brain_id) else {
        return Err(BrainRunBusy {
            brain_id: brain_id.to_string(),
        });
    };
    Ok(f())
}

/// Diagnostics only (Inspector / tests). True while some thread holds
/// the slot for `brain_id`.
pub fn is_run_in_flight(brain_id: &str) -> bool {
    in_flight().contains(brain_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier};

    #[test]
    fn two_threads_one_winner() {
        // The A7 gate: two threads race the same brain; exactly one runs
        // the critical section, the other loses cleanly (no block, no
        // panic, no partial work).
        let brain = "lock-race-brain";
        let barrier = Arc::new(Barrier::new(2));
        let entered = Arc::new(AtomicUsize::new(0));
        let busy = Arc::new(AtomicUsize::new(0));
        // Held by the winner until the loser has had its turn, so the
        // race is deterministic instead of timing-dependent.
        let release = Arc::new(Barrier::new(2));

        let handles: Vec<_> = (0..2)
            .map(|_| {
                let barrier = Arc::clone(&barrier);
                let entered = Arc::clone(&entered);
                let busy = Arc::clone(&busy);
                let release = Arc::clone(&release);
                std::thread::spawn(move || {
                    barrier.wait();
                    match try_with_brain_run_lock(brain, || {
                        entered.fetch_add(1, Ordering::SeqCst);
                        // Wait for the other thread to have tried and lost.
                        release.wait();
                    }) {
                        Ok(()) => {}
                        Err(e) => {
                            assert_eq!(e.brain_id, brain);
                            busy.fetch_add(1, Ordering::SeqCst);
                            release.wait();
                        }
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().expect("no thread panics");
        }

        assert_eq!(entered.load(Ordering::SeqCst), 1, "exactly one winner");
        assert_eq!(busy.load(Ordering::SeqCst), 1, "the other lost cleanly");
        assert!(
            !is_run_in_flight(brain),
            "the slot is released once both threads finish"
        );
    }

    #[test]
    fn different_brains_never_block_each_other() {
        let _a = try_acquire_brain_run("brain-a").expect("first brain acquires");
        let b = try_acquire_brain_run("brain-b");
        assert!(b.is_some(), "an unrelated brain is not blocked");
        assert!(is_run_in_flight("brain-a"));
        assert!(is_run_in_flight("brain-b"));
    }

    #[test]
    fn the_slot_is_reusable_after_the_guard_drops() {
        let brain = "lock-sequential-brain";
        {
            let _g = try_acquire_brain_run(brain).expect("free at first");
            assert!(try_acquire_brain_run(brain).is_none(), "busy while held");
        }
        assert!(!is_run_in_flight(brain));
        assert!(
            try_acquire_brain_run(brain).is_some(),
            "released on drop, so the next run can start"
        );
    }

    #[test]
    fn a_panicking_run_still_releases_the_slot() {
        let brain = "lock-panic-brain";
        let hit = std::panic::catch_unwind(|| {
            let _ = try_with_brain_run_lock(brain, || panic!("boom"));
        });
        assert!(hit.is_err(), "the panic propagates to the caller");
        assert!(
            !is_run_in_flight(brain),
            "unwinding drops the guard — a crashed run must not wedge the brain"
        );
    }

    #[test]
    fn busy_error_reads_like_a_conflict_not_a_failure() {
        let _g = try_acquire_brain_run("lock-msg-brain").unwrap();
        let err = try_with_brain_run_lock("lock-msg-brain", || unreachable!())
            .expect_err("second caller is busy");
        assert!(err.to_string().contains("already in flight"));
        assert!(err.to_string().contains("lock-msg-brain"));
    }
}
