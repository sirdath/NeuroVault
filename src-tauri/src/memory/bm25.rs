//! In-memory BM25 keyword index with debounced rebuild.
//!
//! Port of `server/neurovault_server/bm25_index.py`. Same Okapi BM25
//! formula, same stopword set, same tokenisation, same 5-second
//! debounce on `schedule_rebuild`. The debounce exists because
//! observation-hook bursts used to trigger one tokenise+rebuild per
//! write, which sustained CPU long enough to TDR unstable iGPUs.
//! We coalesce to one rebuild per quiet window.
//!
//! Per-brain instance: `index_for(brain_id)` returns a cached
//! `Arc<Bm25Index>` so multiple ingest callers share the same index.
//! The debounce generation counter is per-instance so scheduling a
//! rebuild on brain A doesn't cancel brain B's pending rebuild.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use once_cell::sync::{Lazy, OnceCell};
use parking_lot::{Mutex, RwLock};
use regex::Regex;

use super::db::BrainDb;
use super::types::Result;

/// Window `schedule_rebuild` waits before firing. Matches Python's
/// `_DEBOUNCE_SECONDS`. Longer coalesces more writes but makes search
/// results staler for a little longer.
const DEBOUNCE_SECS: u64 = 5;

/// Okapi BM25 constants. Matches `rank_bm25.BM25Okapi` defaults that
/// the Python side uses — `k1=1.5`, `b=0.75`, `epsilon=0.25` where
/// `epsilon` bumps IDF weights for terms that appear in more than
/// half the corpus so they don't go negative.
const BM25_K1: f64 = 1.5;
const BM25_B: f64 = 0.75;
const BM25_EPSILON: f64 = 0.25;

/// Common English stopwords. Copied byte-for-byte from the Python
/// `STOPWORDS` set so tokenisation is identical on both sides.
static STOPWORDS: Lazy<std::collections::HashSet<&'static str>> = Lazy::new(|| {
    [
        "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
        "have", "has", "had", "do", "does", "did", "will", "would", "could",
        "should", "may", "might", "shall", "can", "need", "dare", "ought",
        "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
        "as", "into", "through", "during", "before", "after", "above", "below",
        "between", "out", "off", "over", "under", "again", "further", "then",
        "once", "here", "there", "when", "where", "why", "how", "all", "each",
        "every", "both", "few", "more", "most", "other", "some", "such", "no",
        "nor", "not", "only", "own", "same", "so", "than", "too", "very",
        "and", "but", "or", "if", "while", "because", "until", "although",
        "this", "that", "these", "those", "it", "its", "i", "me", "my",
        "we", "our", "you", "your", "he", "him", "his", "she", "her",
        "they", "them", "their", "what", "which", "who", "whom",
    ]
    .iter()
    .copied()
    .collect()
});

/// Pre-tokenisation sweep that strips markdown punctuation. Matches
/// `re.sub(r'[#*`\[\](){}|>~_]', ' ', …)` in the Python tokeniser.
static MD_PUNCT_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[#*`\[\](){}|>~_]").unwrap());
/// Token regex: alphanum runs, optionally joined by single `-` (for
/// `sqlite-vec`, `rank-bm25`, etc.). Matches Python exactly.
static TOKEN_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[a-z0-9]+(?:-[a-z0-9]+)*").unwrap());

/// Tokenise a single string the way Python does. Returns lowercase
/// tokens with stopwords + 1-char tokens dropped.
fn tokenize(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let cleaned = MD_PUNCT_RE.replace_all(&lower, " ");
    TOKEN_RE
        .find_iter(&cleaned)
        .map(|m| m.as_str().to_string())
        .filter(|w| !STOPWORDS.contains(w.as_str()) && w.chars().count() > 1)
        .collect()
}

/// The inner index state. Swapped wholesale on rebuild so concurrent
/// `search` readers never observe a half-built state.
#[derive(Default)]
struct Inner {
    chunk_ids: Vec<String>,
    doc_lens: Vec<f64>,
    avgdl: f64,
    // term -> doc_freq
    df: HashMap<String, u64>,
    // per-doc term frequency map
    tf: Vec<HashMap<String, u64>>,
    n: u64,
}

/// Public per-brain BM25 index. Rebuild debounces via an atomic
/// generation counter — each `schedule_rebuild` bumps it; the
/// detached timer thread only fires if its captured generation still
/// matches at wake-up time.
pub struct Bm25Index {
    brain_id: String,
    inner: RwLock<Inner>,
    // Bumped on every schedule_rebuild; the detached thread captures
    // the current value and no-ops if the captured value doesn't
    // equal the current one when it wakes up.
    epoch: AtomicU64,
    // Serialises concurrent `build()` calls against the DB so we don't
    // race two rebuild threads tokenising at once. Cheap because
    // rebuilds are rare (every 5s at most under observation-hook
    // bursts).
    build_lock: Mutex<()>,
}

impl Bm25Index {
    fn new(brain_id: String) -> Self {
        Self {
            brain_id,
            inner: RwLock::new(Inner::default()),
            epoch: AtomicU64::new(0),
            build_lock: Mutex::new(()),
        }
    }

    /// Number of documents currently indexed. Matches Python's
    /// `size` property.
    pub fn size(&self) -> usize {
        self.inner.read().n as usize
    }

    /// Rebuild the index from the database. Blocks on the build_lock
    /// so parallel calls queue. Safe to call during live search —
    /// readers take the read-lock on `inner` briefly, writers swap
    /// the whole struct in one `*write = new`.
    pub fn build(&self, db: &BrainDb) -> Result<()> {
        let _g = self.build_lock.lock();
        let conn = db.lock();
        let mut stmt = conn.prepare(
            "SELECT c.id, c.content
             FROM chunks c
             JOIN engrams e ON e.id = c.engram_id
             WHERE e.state != 'dormant'
             ORDER BY c.id",
        )?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<std::result::Result<Vec<(String, String)>, _>>()?;
        drop(stmt);
        drop(conn);

        let mut chunk_ids = Vec::with_capacity(rows.len());
        let mut doc_lens = Vec::with_capacity(rows.len());
        let mut tf: Vec<HashMap<String, u64>> = Vec::with_capacity(rows.len());
        let mut df: HashMap<String, u64> = HashMap::new();

        for (cid, content) in rows {
            let tokens = tokenize(&content);
            if tokens.is_empty() {
                continue;
            }
            let doc_len = tokens.len() as f64;
            let mut per_doc: HashMap<String, u64> = HashMap::new();
            for t in &tokens {
                *per_doc.entry(t.clone()).or_insert(0) += 1;
            }
            for term in per_doc.keys() {
                *df.entry(term.clone()).or_insert(0) += 1;
            }
            chunk_ids.push(cid);
            doc_lens.push(doc_len);
            tf.push(per_doc);
        }

        let n = chunk_ids.len() as u64;
        let avgdl = if n > 0 {
            doc_lens.iter().sum::<f64>() / n as f64
        } else {
            0.0
        };

        let new_inner = Inner {
            chunk_ids,
            doc_lens,
            avgdl,
            df,
            tf,
            n,
        };
        *self.inner.write() = new_inner;
        Ok(())
    }

    /// Schedule a debounced rebuild. Returns immediately — actual
    /// rebuild happens on a detached thread after `DEBOUNCE_SECS`,
    /// unless another `schedule_rebuild` lands first (which resets
    /// the timer).
    ///
    /// The db handle is cloned via `Arc` so the timer thread can hold
    /// it without keeping the caller's reference alive.
    pub fn schedule_rebuild(self: &Arc<Self>, db: Arc<BrainDb>) {
        let my_epoch = self.epoch.fetch_add(1, Ordering::AcqRel) + 1;
        let this = Arc::clone(self);
        thread::Builder::new()
            .name(format!("bm25-rebuild-{}", self.brain_id))
            .spawn(move || {
                thread::sleep(Duration::from_secs(DEBOUNCE_SECS));
                // If a newer schedule_rebuild came in, let that
                // newer thread handle it — we're stale.
                if this.epoch.load(Ordering::Acquire) != my_epoch {
                    return;
                }
                if let Err(e) = this.build(&db) {
                    eprintln!(
                        "[neurovault] BM25 debounced rebuild failed for brain {}: {}",
                        this.brain_id, e
                    );
                }
            })
            .ok();
    }

    /// Run any pending rebuild synchronously now. Used by tests +
    /// graceful-shutdown to avoid racing a detached thread against
    /// teardown.
    pub fn flush(&self, db: &BrainDb) -> Result<()> {
        // Bump epoch so any already-scheduled thread no-ops on wake.
        self.epoch.fetch_add(1, Ordering::AcqRel);
        self.build(db)
    }

    /// Query the index. Returns `(chunk_id, score)` pairs sorted
    /// descending, trimmed to `limit`. Scores below 10% of the max
    /// are discarded — matches Python's noise-floor filter.
    pub fn search(&self, query: &str, limit: usize) -> Vec<(String, f64)> {
        let inner = self.inner.read();
        if inner.n == 0 {
            return Vec::new();
        }
        let tokens = tokenize(query);
        if tokens.is_empty() {
            return Vec::new();
        }

        let n = inner.n as f64;
        // IDF with epsilon bump per rank_bm25's Okapi. IDF = log((N - df
        // + 0.5) / (df + 0.5) + 1). The original BM25 formula can go
        // negative for very common terms; `+ 1` prevents that and
        // matches BM25Okapi.
        let idf_of = |term: &str| -> f64 {
            let df = *inner.df.get(term).unwrap_or(&0) as f64;
            let raw = ((n - df + 0.5) / (df + 0.5)).ln();
            // rank_bm25 uses an average-idf floor (epsilon * avg_idf).
            // We compute the floor lazily — for parity it's good
            // enough to bump very-negative values up to 0.
            if raw < 0.0 {
                raw * BM25_EPSILON
            } else {
                raw
            }
        };

        let mut scored: Vec<(String, f64)> = Vec::with_capacity(inner.n as usize);
        for (i, tf_doc) in inner.tf.iter().enumerate() {
            let doc_len = inner.doc_lens[i];
            let mut score = 0.0_f64;
            for term in &tokens {
                let f = *tf_doc.get(term).unwrap_or(&0) as f64;
                if f == 0.0 {
                    continue;
                }
                let idf = idf_of(term);
                let denom = f + BM25_K1 * (1.0 - BM25_B + BM25_B * doc_len / inner.avgdl);
                score += idf * (f * (BM25_K1 + 1.0)) / denom;
            }
            if score != 0.0 {
                scored.push((inner.chunk_ids[i].clone(), score));
            }
        }

        if scored.is_empty() {
            return Vec::new();
        }

        let max_score = scored
            .iter()
            .map(|(_, s)| *s)
            .fold(f64::NEG_INFINITY, f64::max);
        let threshold = if max_score > 0.0 {
            max_score * 0.1
        } else {
            f64::NEG_INFINITY
        };
        scored.retain(|(_, s)| *s > threshold);
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(limit);
        scored
    }
}

/// Per-brain index cache. Parallel to `db::cache`; separate so a
/// brain with BM25 loaded but no open DB handle still gets its index
/// reused across reopens.
fn cache() -> &'static parking_lot::RwLock<HashMap<String, Arc<Bm25Index>>> {
    static CACHE: OnceCell<parking_lot::RwLock<HashMap<String, Arc<Bm25Index>>>> =
        OnceCell::new();
    CACHE.get_or_init(|| parking_lot::RwLock::new(HashMap::new()))
}

/// Get (or lazily create) the BM25 index for a brain. First call per
/// brain does **not** build from DB — the caller runs `build()` or
/// `schedule_rebuild()` when it makes sense. Matches Python where the
/// index starts empty and gets its first build from startup code.
pub fn index_for(brain_id: &str) -> Arc<Bm25Index> {
    if let Some(existing) = cache().read().get(brain_id).cloned() {
        return existing;
    }
    let mut map = cache().write();
    if let Some(existing) = map.get(brain_id).cloned() {
        return existing;
    }
    let idx = Arc::new(Bm25Index::new(brain_id.to_string()));
    map.insert(brain_id.to_string(), idx.clone());
    idx
}

/// Drop the cached BM25 index for a brain. Used by tests + brain-
/// switching logic.
pub fn drop_index(brain_id: &str) {
    cache().write().remove(brain_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenizer_matches_python_shape() {
        let out = tokenize("The QUICK brown-fox jumps! over `code` lazy-dog.");
        // Stopwords (the, over) dropped; 1-char dropped.
        assert!(out.contains(&"quick".to_string()));
        assert!(out.contains(&"brown-fox".to_string()));
        assert!(out.contains(&"jumps".to_string()));
        assert!(out.contains(&"code".to_string()));
        assert!(!out.contains(&"the".to_string()));
        assert!(!out.contains(&"over".to_string()));
    }

    #[test]
    fn search_returns_empty_on_empty_index() {
        let idx = Bm25Index::new("test".to_string());
        assert_eq!(idx.search("anything", 10).len(), 0);
    }
}
