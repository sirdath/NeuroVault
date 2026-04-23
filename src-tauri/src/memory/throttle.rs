//! Per-session recall throttle.
//!
//! Inspired by `mksglu/context-mode`'s MCP throttling pattern: agents
//! that spam `recall()` in tight loops burn their context window on
//! redundant results. A 60-second rolling call counter degrades the
//! response rather than rejecting it — callers 1-3 get the full
//! `top_k`, 4-8 get half, 9+ get one result plus a synthetic hint
//! pointing the agent at a better query strategy.
//!
//! The throttle is per-brain (different brains = different agents
//! usually, and a multi-agent user shouldn't penalise each other).
//! Window state lives in a process-wide `Lazy<Mutex<HashMap>>` so
//! both the Tauri `nv_recall` command and the HTTP `/api/recall`
//! handler share it — a caller that oscillates between transports
//! doesn't get a free pass from the throttle.
//!
//! No timers, no background threads: the window rolls lazily on
//! each call (cheap Instant compare + reset).

use std::collections::HashMap;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use parking_lot::Mutex;

/// Rolling window length. Matches context-mode's 60s default.
const WINDOW_SECS: u64 = 60;

/// Cut-offs for the staircase. Chosen to match context-mode's shape
/// (1-3 normal, 4-8 reduced, 9+ strongly throttled).
const SOFT_LIMIT: u64 = 3;
const HARD_LIMIT: u64 = 8;

/// Process-wide state, one entry per brain.
struct WindowState {
    window_start: Instant,
    count: u64,
}

fn windows() -> &'static Mutex<HashMap<String, WindowState>> {
    static STATE: Lazy<Mutex<HashMap<String, WindowState>>> =
        Lazy::new(|| Mutex::new(HashMap::new()));
    &STATE
}

/// What the throttle decided for this call. `max_results` is the
/// cap the caller should apply to its `top_k`. `hint` is set only
/// when the call was throttled — expected to be surfaced to the
/// agent (e.g. as a synthetic recall hit) so the model can course-
/// correct on its own.
#[derive(Debug, Clone)]
pub struct ThrottleDecision {
    pub max_results: usize,
    pub hint: Option<String>,
    /// How many recall calls fired on this brain inside the current
    /// 60-second window (including this one). Surfaced for logging
    /// + so callers can emit a debug field if they want.
    pub window_count: u64,
}

/// Record a recall call for `brain_id` and return the decision.
/// `requested_top_k` is what the caller would return if the window
/// were fresh; we clamp based on the rolling count.
pub fn tick(brain_id: &str, requested_top_k: usize) -> ThrottleDecision {
    let now = Instant::now();
    let mut map = windows().lock();

    // Pull or create the entry. Reset if the window rolled past.
    let entry = map
        .entry(brain_id.to_string())
        .or_insert_with(|| WindowState {
            window_start: now,
            count: 0,
        });
    if now.duration_since(entry.window_start) >= Duration::from_secs(WINDOW_SECS) {
        entry.window_start = now;
        entry.count = 0;
    }
    entry.count += 1;
    let c = entry.count;

    // Decide based on the staircase. Keep `requested_top_k` as the
    // ceiling even when the window is fresh — we never return MORE
    // than the caller asked for, only less.
    let (max_results, hint) = if c <= SOFT_LIMIT {
        (requested_top_k, None)
    } else if c <= HARD_LIMIT {
        let cap = requested_top_k.max(1) / 2;
        let capped = cap.max(1).min(requested_top_k);
        (
            capped,
            Some(format!(
                "Recall rate-limited: {} calls in the last {}s on this brain. \
                 Showing {} result(s) (normally {}). Consider a single broader query \
                 or use `recall_chunks` for passage-level retrieval.",
                c, WINDOW_SECS, capped, requested_top_k,
            )),
        )
    } else {
        (
            1,
            Some(format!(
                "Recall hard-throttled: {} calls in {}s. Returning 1 result only. \
                 Your current query strategy is probably inefficient — prefer one \
                 well-scoped recall over many narrow ones, or switch to \
                 `recall_chunks` / `explore(topic)` for broader context.",
                c, WINDOW_SECS,
            )),
        )
    };

    ThrottleDecision {
        max_results,
        hint,
        window_count: c,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reset() {
        windows().lock().clear();
    }

    #[test]
    fn first_calls_pass_through() {
        reset();
        for _ in 0..3 {
            let d = tick("brain-a", 10);
            assert_eq!(d.max_results, 10);
            assert!(d.hint.is_none());
        }
    }

    #[test]
    fn mid_range_halves_top_k() {
        reset();
        for _ in 0..4 {
            tick("brain-b", 10);
        }
        let d = tick("brain-b", 10);
        assert_eq!(d.max_results, 5);
        assert!(d.hint.is_some());
    }

    #[test]
    fn hard_range_returns_one() {
        reset();
        for _ in 0..8 {
            tick("brain-c", 10);
        }
        let d = tick("brain-c", 10);
        assert_eq!(d.max_results, 1);
        assert!(d.hint.as_ref().unwrap().contains("hard-throttled"));
    }

    #[test]
    fn different_brains_have_independent_windows() {
        reset();
        for _ in 0..9 {
            tick("brain-x", 10);
        }
        let d = tick("brain-y", 10);
        assert_eq!(d.max_results, 10);
        assert!(d.hint.is_none());
    }
}
