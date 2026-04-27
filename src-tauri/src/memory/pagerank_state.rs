//! Per-brain PageRank scores held in-memory.
//!
//! The frontend computes PageRank when the user enables Analytics mode
//! (see src/lib/graphMetrics.ts) and pushes the resulting scores here
//! via the `nv_set_pagerank` Tauri command. The retriever reads them
//! during hybrid_retrieve and applies a multiplicative boost so that
//! "important" notes (in graph terms) float up in recall results.
//!
//! Why state lives here instead of being recomputed in Rust:
//!   - The TS implementation already runs and is tested. Porting
//!     PageRank to Rust + keeping it in sync with edge changes would
//!     be a bigger surface than necessary.
//!   - The frontend has live access to the graph data after each
//!     ingest; it pushes once on graph load + on toggle, costs ~30 ms
//!     for a 1000-node brain, no big deal.
//!   - When Analytics mode is OFF, the frontend doesn't push. State
//!     stays empty → retriever applies no boost → identical recall to
//!     pre-G7 baseline. The Analytics opt-in IS the eval gate.
//!
//! Storage: process-wide. Cleared on app restart (intentional — we
//! recompute on next graph load anyway). Per-brain because someone
//! might switch brains and we don't want stale scores leaking.

use parking_lot::Mutex;
use std::collections::HashMap;
use once_cell::sync::Lazy;

type BrainId = String;
type EngramId = String;

static STATE: Lazy<Mutex<HashMap<BrainId, HashMap<EngramId, f64>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Replace the PageRank scores for a brain. Empty map clears them.
pub fn set(brain_id: &str, scores: HashMap<EngramId, f64>) {
    let mut g = STATE.lock();
    if scores.is_empty() {
        g.remove(brain_id);
    } else {
        g.insert(brain_id.to_string(), scores);
    }
}

/// Look up the score for a single engram id within a brain. Returns
/// `None` when no scores have been pushed for the brain (either
/// Analytics mode is off, or the frontend hasn't pushed yet). The
/// retriever uses `None` as the signal to skip the boost entirely.
pub fn get(brain_id: &str, engram_id: &str) -> Option<f64> {
    let g = STATE.lock();
    g.get(brain_id).and_then(|m| m.get(engram_id).copied())
}

/// Are scores available for this brain at all? Cheaper than calling
/// `get` per-candidate when the answer is going to be no.
pub fn has_scores(brain_id: &str) -> bool {
    let g = STATE.lock();
    g.get(brain_id).map(|m| !m.is_empty()).unwrap_or(false)
}

/// Drop all scores for a brain. Called when the brain is deleted or
/// when the active brain changes (we don't want a stale score map
/// applying to the new brain's recall).
#[allow(dead_code)]
pub fn clear(brain_id: &str) {
    STATE.lock().remove(brain_id);
}
