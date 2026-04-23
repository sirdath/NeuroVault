//! Session-level recall result cache.
//!
//! Pattern borrowed from `mksglu/context-mode`'s MCP efficiency work:
//! agents (Claude Code, Cursor, etc.) typically repeat the same recall
//! query multiple times in a single turn — paraphrased, follow-up-
//! driven, or because they forgot they asked. The cache returns the
//! previously-computed result inside a 60-second window for zero
//! compute cost, collapsing the 40-60% repeat-query rate into cache
//! hits.
//!
//! Safety rails:
//! - Bounded LRU (100 entries per brain × N brains). Memory ceiling
//!   ≈ 500 KB total for a typical user — negligible.
//! - Epoch-based invalidation: any write to a brain bumps its epoch;
//!   cache entries stamped with an older epoch are evicted on next
//!   access. Guarantees no stale reads after writes.
//! - 60s TTL cap on top of epoch. Belt-and-braces for the case where
//!   writes go through a different path (filesystem watcher, direct
//!   SQL) without calling `invalidate_brain`.
//! - Cache keys normalise the query (trim + lowercase) so "foo" and
//!   "FOO  " hit the same entry.
//!
//! Not shared across brains: a cache miss on brain A doesn't consult
//! brain B's cache. That'd be a correctness hazard (different engram
//! sets) with zero upside.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use parking_lot::Mutex;

use super::retriever::RecallHit;

/// Cache lifetime per entry. Short enough that stale data isn't a
/// concern; long enough that a typical Claude Code turn's repeat
/// queries all hit. Matches the throttle window used elsewhere.
const TTL: Duration = Duration::from_secs(60);

/// Per-brain LRU cap. 100 entries × ~5 KB/result ≈ 500 KB max.
const MAX_PER_BRAIN: usize = 100;

/// One cached entry. Stamped with the brain epoch at insert time so
/// a later `invalidate_brain` bump evicts this lazily.
struct Entry {
    value: Vec<RecallHit>,
    inserted: Instant,
    epoch_at_insert: u64,
}

/// Per-brain state: an LRU-ish map + an eviction-order ring.
/// `order` is a Vec rather than a VecDeque because the common case
/// is a hit — we move the hit key to the back — and Vec::remove
/// for small n outperforms a deque's header overhead here.
struct BrainCache {
    entries: HashMap<String, Entry>,
    order: Vec<String>,
}

impl BrainCache {
    fn new() -> Self {
        Self {
            entries: HashMap::with_capacity(MAX_PER_BRAIN),
            order: Vec::with_capacity(MAX_PER_BRAIN),
        }
    }
}

/// Process-wide state: one BrainCache per brain + one epoch atomic
/// per brain. Both live in the same Mutex so the read/invalidate
/// paths are straightforward.
struct State {
    by_brain: HashMap<String, BrainCache>,
    epochs: HashMap<String, u64>,
}

static STATE: Lazy<Mutex<State>> = Lazy::new(|| {
    Mutex::new(State {
        by_brain: HashMap::new(),
        epochs: HashMap::new(),
    })
});

/// Global monotonic counter used to mint fresh epoch values on
/// bump. Separate from the per-brain epoch map so we never reuse an
/// epoch across brains (which could otherwise produce a race where
/// brain A's bump happens to land on brain B's stamped epoch).
static EPOCH_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Normalise a query string for cache keying. Lowercases + trims +
/// collapses internal whitespace. Matches the shape real agent
/// queries take (they're mostly ASCII, varying-case, occasional
/// trailing space).
fn normalize(q: &str) -> String {
    let trimmed = q.trim().to_lowercase();
    let mut out = String::with_capacity(trimmed.len());
    let mut last_was_space = false;
    for c in trimmed.chars() {
        if c.is_whitespace() {
            if !last_was_space && !out.is_empty() {
                out.push(' ');
            }
            last_was_space = true;
        } else {
            out.push(c);
            last_was_space = false;
        }
    }
    out
}

/// Look up a cached result. Returns `Some` on hit, `None` on miss
/// (including TTL expiry or epoch-invalidated stamps).
pub fn get(brain_id: &str, query: &str) -> Option<Vec<RecallHit>> {
    let key = normalize(query);
    if key.is_empty() {
        return None;
    }
    let mut state = STATE.lock();
    let current_epoch = *state.epochs.get(brain_id).unwrap_or(&0);
    let cache = state.by_brain.get_mut(brain_id)?;

    let entry = cache.entries.get(&key)?;
    if entry.inserted.elapsed() > TTL {
        // Expired. Don't return, and take the chance to lazily evict.
        cache.entries.remove(&key);
        cache.order.retain(|k| k != &key);
        return None;
    }
    if entry.epoch_at_insert < current_epoch {
        // Brain has been mutated since this was cached.
        cache.entries.remove(&key);
        cache.order.retain(|k| k != &key);
        return None;
    }
    let value = entry.value.clone();

    // Move to back of eviction order — "recently used".
    if let Some(pos) = cache.order.iter().position(|k| k == &key) {
        let k = cache.order.remove(pos);
        cache.order.push(k);
    }
    Some(value)
}

/// Store a recall result. Silently drops if the brain's cache is
/// full and the oldest entry can't be evicted (shouldn't happen in
/// practice — it can always be evicted).
pub fn put(brain_id: &str, query: &str, value: Vec<RecallHit>) {
    let key = normalize(query);
    if key.is_empty() {
        return;
    }
    let mut state = STATE.lock();
    let current_epoch = *state.epochs.get(brain_id).unwrap_or(&0);
    let cache = state
        .by_brain
        .entry(brain_id.to_string())
        .or_insert_with(BrainCache::new);

    // If we're replacing an existing entry, move its key to the back
    // of the order vec; if new, push a fresh key + evict from front
    // when we overflow.
    if cache.entries.contains_key(&key) {
        cache.entries.insert(
            key.clone(),
            Entry {
                value,
                inserted: Instant::now(),
                epoch_at_insert: current_epoch,
            },
        );
        if let Some(pos) = cache.order.iter().position(|k| k == &key) {
            let k = cache.order.remove(pos);
            cache.order.push(k);
        }
        return;
    }

    cache.entries.insert(
        key.clone(),
        Entry {
            value,
            inserted: Instant::now(),
            epoch_at_insert: current_epoch,
        },
    );
    cache.order.push(key);
    while cache.order.len() > MAX_PER_BRAIN {
        if let Some(evict) = cache.order.first().cloned() {
            cache.order.remove(0);
            cache.entries.remove(&evict);
        } else {
            break;
        }
    }
}

/// Bump the brain's epoch so all currently-cached entries for it are
/// considered stale. Called after any write — ingest, delete, etc.
/// Fast: one atomic read + one map update.
pub fn invalidate_brain(brain_id: &str) {
    let new_epoch = EPOCH_COUNTER.fetch_add(1, Ordering::AcqRel);
    let mut state = STATE.lock();
    state.epochs.insert(brain_id.to_string(), new_epoch);
    // Don't actively sweep — lazy eviction on next `get` is cheap
    // enough and keeps `invalidate_brain` O(1) even if a brain has
    // a full cache.
}

/// Wipe all cache state. Tests + the exit hook use this to avoid
/// leaking between test cases.
#[cfg(test)]
pub fn clear_all() {
    let mut state = STATE.lock();
    state.by_brain.clear();
    state.epochs.clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(id: &str) -> RecallHit {
        RecallHit {
            engram_id: id.to_string(),
            title: id.to_string(),
            content: "x".to_string(),
            score: 0.0,
            strength: 1.0,
            state: "fresh".to_string(),
        }
    }

    #[test]
    fn hit_returns_cached_value() {
        clear_all();
        put("brain-a", "foo", vec![hit("e1")]);
        let got = get("brain-a", "foo").unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].engram_id, "e1");
    }

    #[test]
    fn normalisation_matches_variants() {
        clear_all();
        put("brain-a", "  FOO  bar  ", vec![hit("e1")]);
        assert!(get("brain-a", "foo bar").is_some());
        assert!(get("brain-a", "FoO  BAR").is_some());
    }

    #[test]
    fn invalidate_wipes_brain() {
        clear_all();
        put("brain-a", "foo", vec![hit("e1")]);
        invalidate_brain("brain-a");
        assert!(get("brain-a", "foo").is_none());
    }

    #[test]
    fn invalidate_is_brain_scoped() {
        clear_all();
        put("brain-a", "foo", vec![hit("e1")]);
        put("brain-b", "foo", vec![hit("e2")]);
        invalidate_brain("brain-a");
        assert!(get("brain-a", "foo").is_none());
        assert!(get("brain-b", "foo").is_some());
    }

    #[test]
    fn lru_evicts_oldest_when_over_cap() {
        clear_all();
        for i in 0..(MAX_PER_BRAIN + 20) {
            put("brain-a", &format!("q{}", i), vec![hit(&format!("e{}", i))]);
        }
        // The first entries should have been evicted.
        assert!(get("brain-a", "q0").is_none());
        // Recent entries should still be present.
        assert!(get("brain-a", &format!("q{}", MAX_PER_BRAIN + 19)).is_some());
    }
}
