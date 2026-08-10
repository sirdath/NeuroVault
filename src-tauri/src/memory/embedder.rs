//! Local text embedding via fastembed-rs.
//!
//! Port of `server/neurovault_server/embeddings.py`. Same model
//! (`BAAI/bge-small-en-v1.5`), same 384 dims, same on-disk ONNX cache
//! under `~/.neurovault/.fastembed_cache/`. Existing Python installs have the
//! weights already downloaded; Rust picks them up on first `encode()`
//! with no extra download.
//!
//! Singleton by design — the ONNX session is ~30 MB resident and we
//! only want one copy regardless of how many brains are active. Lazy
//! init via `OnceCell` means app boot doesn't pay the model-load cost
//! until the first recall/ingest triggers it.
//!
//! Query cache mirrors Python's bounded LRU (1000 entries ≈ 1.5 MB).
//! Typical Claude session has 30-50% query repeat, so the cache
//! removes the dominant latency cost from recall.

use std::collections::{HashMap, VecDeque};

use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use once_cell::sync::{Lazy, OnceCell};
use parking_lot::Mutex;

use super::paths::nv_home;
use super::types::{MemoryError, Result};

/// Max entries in the encode_query LRU. Matches `_QUERY_CACHE_MAX` in
/// the Python embedder. 1000 × 384 × 4 bytes ≈ 1.5 MB of float data,
/// well under the memory budget for the hot path.
const QUERY_CACHE_MAX: usize = 1000;

/// Dimension the current model emits. Asserted at first encode so a
/// silent upstream model swap doesn't corrupt the vec0 table.
pub const EMBEDDING_DIM: usize = 384;

// NOTE: We tried adding the BGE-en query prefix
// ("Represent this sentence for searching relevant passages: ") in
// 2026-05-08, following the BAAI/bge-en-v1.5 model card's guidance
// on s2p retrieval. Empirically — measured against actual bench
// query/passage pairs through fastembed-rs's ONNX export — the
// prefix HURT cosine similarity in 5/5 sampled cases (delta ~-0.03
// avg) and dropped LongMemEval-Oracle overall from 64.1% to 40.2%.
// The model card guidance does not match this export's behavior;
// we leave queries unprefixed, matching the passage-side encoding.

/// Simple bounded LRU keyed on the query string. Keeps an insertion
/// order queue separate from the HashMap so eviction is O(1) amortised.
struct QueryCache {
    map: HashMap<String, Vec<f32>>,
    order: VecDeque<String>,
    hits: u64,
    misses: u64,
}

impl QueryCache {
    fn new() -> Self {
        Self {
            map: HashMap::with_capacity(QUERY_CACHE_MAX),
            order: VecDeque::with_capacity(QUERY_CACHE_MAX),
            hits: 0,
            misses: 0,
        }
    }

    /// Lookup — on hit, move the key to the back of the eviction queue.
    /// The linear `position` scan is O(n) but n ≤ 1000 and hit rate is
    /// the fast path we care about, not cache maintenance cost.
    fn get(&mut self, key: &str) -> Option<Vec<f32>> {
        let val = self.map.get(key).cloned();
        if val.is_some() {
            self.hits += 1;
            if let Some(idx) = self.order.iter().position(|k| k == key) {
                let k = self.order.remove(idx).unwrap();
                self.order.push_back(k);
            }
        } else {
            self.misses += 1;
        }
        val
    }

    fn insert(&mut self, key: String, vec: Vec<f32>) {
        // If already present, replace value + move to back. If new,
        // push to back and evict from front when we overflow.
        if self.map.contains_key(&key) {
            self.map.insert(key.clone(), vec);
            if let Some(idx) = self.order.iter().position(|k| k == &key) {
                let k = self.order.remove(idx).unwrap();
                self.order.push_back(k);
            }
            return;
        }
        self.map.insert(key.clone(), vec);
        self.order.push_back(key);
        while self.order.len() > QUERY_CACHE_MAX {
            if let Some(evicted) = self.order.pop_front() {
                self.map.remove(&evicted);
            }
        }
    }
}

/// Global embedder instance. `OnceCell` gives us lazy init + no
/// double-initialisation across threads. The inner `Mutex` serialises
/// `TextEmbedding::embed` calls — fastembed's model isn't documented
/// as Send-safe for concurrent inference, so we keep it behind a
/// mutex. In practice contention is low; the model is ~5 ms/query and
/// we batch where we can.
struct Embedder {
    model: Mutex<TextEmbedding>,
    cache: Mutex<QueryCache>,
}

// ---- Test seam: a deliberately dead model ---------------------------------
//
// The offline first-run failure (no model cache + no network) is the one
// behaviour the retriever MUST survive, so it has to be reproducible in a
// unit test — and a test may never reach the network to prove it. The
// switch is thread-local, not an env var, because `cargo test` runs the
// lib tests in parallel threads of ONE process: a global toggle would
// blind every other test that happens to embed at the same moment.
#[cfg(test)]
thread_local! {
    static FORCE_DEAD_MODEL: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// RAII switch that makes every embedder entry point on THIS thread fail
/// exactly the way a cache-less offline install does. Restores the
/// previous value on drop so a panicking test can't leak the state.
#[cfg(test)]
pub(super) struct DeadModelGuard(bool);

#[cfg(test)]
impl DeadModelGuard {
    pub(super) fn new() -> Self {
        Self(FORCE_DEAD_MODEL.with(|f| f.replace(true)))
    }
}

#[cfg(test)]
impl Drop for DeadModelGuard {
    fn drop(&mut self) {
        FORCE_DEAD_MODEL.with(|f| f.set(self.0));
    }
}

/// The exact error text a missing ONNX cache produces in the wild, so the
/// test asserts against the real string and not a friendlier stand-in.
#[cfg(test)]
const DEAD_MODEL_ERROR: &str = "fastembed init failed: Failed to retrieve onnx/model.onnx";

// ---- Model-init gate ------------------------------------------------------
//
// Shared by this module and `reranker.rs`; both load an ONNX model that
// fastembed may have to DOWNLOAD, and both were failing the same three
// ways.
//
// 1. No retry, no timeout, and no way to add either. fastembed 4.9.1
//    builds its own `hf_hub::api::sync::ApiBuilder` inside `pull_from_hf`
//    and never exposes it, so `.with_retries()` is unreachable
//    (`max_retries` stays 0) and so is the ureq agent (`timeout_read` is
//    None — a stalled socket mid-download blocks forever). Neither knob
//    can be set from here at these pinned versions.
// 2. `OnceCell::get_or_try_init` leaves the cell EMPTY on failure, so
//    every later call re-enters the closure. With a download in that
//    closure, one dead network turned into a fresh ~130 MB (embedder) /
//    ~1.1 GB (reranker) attempt on every single recall — and the ambient
//    hook recalls on every prompt.
// 3. The attempt ran on the caller's thread, so a hung download hung the
//    request instead of degrading it.
//
// Since the upstream knobs are out of reach, the gate supplies the same
// guarantees from outside: at most one attempt in flight, a bounded wait
// before the caller is released to the degraded path, and a
// negative-cached failure with exponential backoff so a broken network
// costs one attempt per cooldown rather than one per keystroke.

/// First cooldown after a failed init, and the ceiling backoff walks to.
/// 30 s is long enough that a recall storm can't re-trigger a download,
/// short enough that plugging the network back in feels immediate.
const INIT_COOLDOWN_MIN: std::time::Duration = std::time::Duration::from_secs(30);
const INIT_COOLDOWN_MAX: std::time::Duration = std::time::Duration::from_secs(600);

/// Serialises init attempts and remembers failures. See the module note
/// above for why this lives outside fastembed rather than inside it.
pub(super) struct ModelInitGate {
    label: &'static str,
    /// How long a caller waits before giving up on a first-time load.
    /// Per-model: losing the reranker costs a rank ordering, losing the
    /// embedder costs ingestion, so they buy different amounts of patience.
    wait: std::time::Duration,
    state: Mutex<GateState>,
}

#[derive(Default)]
struct GateState {
    /// An attempt is running on a background thread right now.
    in_flight: bool,
    /// (when it failed, what it said, how long to wait before retrying).
    last_failure: Option<(std::time::Instant, String, std::time::Duration)>,
}

impl ModelInitGate {
    pub(super) fn new(label: &'static str, wait: std::time::Duration) -> Self {
        Self {
            label,
            wait,
            state: Mutex::new(GateState::default()),
        }
    }
}

/// Initialise `cell` at most once, without ever parking the caller for an
/// unbounded time.
///
/// The build runs on a detached thread and the caller waits for `wait`.
/// If the deadline passes first the caller gets an error (and, upstream,
/// degrades to the keyword path) while the download keeps going — so a
/// slow first fetch costs one degraded query instead of a frozen app, and
/// the model is simply there for the next one. Nothing is retried in a
/// loop: a failure is remembered, and the backoff doubles to
/// `INIT_COOLDOWN_MAX` so a permanently offline machine stops asking.
pub(super) fn init_once<T: Send + Sync + 'static>(
    gate: &'static ModelInitGate,
    cell: &'static OnceCell<T>,
    build: fn() -> Result<T>,
) -> Result<&'static T> {
    if let Some(v) = cell.get() {
        return Ok(v);
    }
    {
        let mut st = gate.state.lock();
        if st.in_flight {
            return Err(MemoryError::Other(format!(
                "{} is still loading in the background",
                gate.label
            )));
        }
        if let Some((at, msg, backoff)) = &st.last_failure {
            if at.elapsed() < *backoff {
                return Err(MemoryError::Other(msg.clone()));
            }
        }
        st.in_flight = true;
    }

    let (tx, rx) = std::sync::mpsc::channel::<std::result::Result<(), String>>();
    std::thread::spawn(move || {
        let outcome = match build() {
            Ok(v) => {
                // `set` can only lose a race it can't be in (one attempt
                // at a time), but ignore the result either way — a value
                // already present is the same success.
                let _ = cell.set(v);
                Ok(())
            }
            Err(e) => Err(e.to_string()),
        };
        {
            let mut st = gate.state.lock();
            st.in_flight = false;
            st.last_failure = match &outcome {
                Ok(()) => None,
                Err(msg) => {
                    let backoff = st
                        .last_failure
                        .as_ref()
                        .map(|(_, _, b)| (*b * 2).min(INIT_COOLDOWN_MAX))
                        .unwrap_or(INIT_COOLDOWN_MIN);
                    Some((std::time::Instant::now(), msg.clone(), backoff))
                }
            };
        }
        // The caller may already have walked away past the deadline.
        let _ = tx.send(outcome);
    });

    match rx.recv_timeout(gate.wait) {
        Ok(Ok(())) => cell.get().ok_or_else(|| {
            MemoryError::Other(format!("{} init reported success but is empty", gate.label))
        }),
        Ok(Err(msg)) => Err(MemoryError::Other(msg)),
        Err(_) => Err(MemoryError::Other(format!(
            "{} did not load within {}s — still downloading in the background",
            gate.label,
            gate.wait.as_secs()
        ))),
    }
}

/// How long a caller waits for the embedding model. Generous because the
/// write path needs it: ingest has no keyword fallback to degrade to, so
/// timing out a first-run download costs an unindexed note, while recall
/// (which does have one) rarely waits at all — an offline machine fails
/// the connection in seconds, well inside this.
const EMBEDDER_INIT_WAIT: std::time::Duration = std::time::Duration::from_secs(60);

fn build_embedder() -> Result<Embedder> {
    // `InitOptions::new` + explicit model id matches what the
    // Python side passes: "BAAI/bge-small-en-v1.5".
    //
    // Cache dir: fastembed-rs defaults to a CWD-RELATIVE
    // `.fastembed_cache`. That silently breaks a GUI app launched
    // from Finder/`open`, whose working directory is `/` — it can't
    // create/write there, so the first embed fails with "Failed to
    // retrieve onnx/model.onnx". Pin an absolute, app-owned, writable
    // dir under the data root so the model resolves no matter where
    // the app was launched from. An explicit FASTEMBED_CACHE_DIR env
    // still wins (fastembed reads it when we don't override).
    let mut opts = InitOptions::new(EmbeddingModel::BGESmallENV15);
    if std::env::var_os("FASTEMBED_CACHE_DIR").is_none() {
        opts = opts.with_cache_dir(nv_home().join(".fastembed_cache"));
    }
    let model = TextEmbedding::try_new(opts)
        .map_err(|e| MemoryError::Other(format!("fastembed init failed: {}", e)))?;
    Ok(Embedder {
        model: Mutex::new(model),
        cache: Mutex::new(QueryCache::new()),
    })
}

fn instance() -> Result<&'static Embedder> {
    #[cfg(test)]
    if FORCE_DEAD_MODEL.with(|f| f.get()) {
        return Err(MemoryError::Other(DEAD_MODEL_ERROR.to_string()));
    }
    static INSTANCE: OnceCell<Embedder> = OnceCell::new();
    static GATE: Lazy<ModelInitGate> =
        Lazy::new(|| ModelInitGate::new("embedding model", EMBEDDER_INIT_WAIT));
    init_once(&GATE, &INSTANCE, build_embedder)
}

/// Assert the embedder emits the expected dimension. Called once on
/// first encode — if someone swaps the model upstream and the dim
/// changes, we fail loudly instead of corrupting `vec_chunks`.
fn check_dim(vec: &[f32]) -> Result<()> {
    if vec.len() != EMBEDDING_DIM {
        return Err(MemoryError::Other(format!(
            "embedder produced {}-dim vector, expected {}",
            vec.len(),
            EMBEDDING_DIM
        )));
    }
    Ok(())
}

/// Encode a single string. Not cached — matches Python's `encode()`
/// path used by ingest, where every input is new.
pub fn encode(text: &str) -> Result<Vec<f32>> {
    let e = instance()?;
    let out = e
        .model
        .lock()
        .embed(vec![text.to_string()], None)
        .map_err(|err| MemoryError::Other(format!("embed failed: {}", err)))?;
    let first = out
        .into_iter()
        .next()
        .ok_or_else(|| MemoryError::Other("embed returned no vectors".to_string()))?;
    check_dim(&first)?;
    Ok(first)
}

/// Max texts we feed to fastembed in one `embed()` call. The
/// library will happily accept an unbounded batch, but it internally
/// allocates attention / KV tensors proportional to (batch × max_seq
/// × hidden), which can peak at multi-GB on large inputs. A 25 KB
/// markdown file chunks to ~115 docs; letting that run as a single
/// batch was observed to spike RAM to 7+ GB on an 8 GB box.
///
/// 32 is comfortable: peak tensor budget ≈ 32 × 512 × 384 × 4 bytes
/// ≈ 25 MB per inference, times ~3 for intermediates ≈ 75 MB. Safe
/// on any consumer machine. Throughput loss vs bigger batches is
/// negligible because the model is CPU-bound and tiny.
const MAX_BATCH: usize = 32;

/// Encode a batch. Internally chunks into `MAX_BATCH`-sized slices
/// so peak memory stays bounded regardless of how many texts the
/// caller hands us. Empty input returns an empty vec without
/// calling the model.
pub fn encode_batch(texts: &[String]) -> Result<Vec<Vec<f32>>> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    let e = instance()?;
    let mut out: Vec<Vec<f32>> = Vec::with_capacity(texts.len());
    for chunk in texts.chunks(MAX_BATCH) {
        let part = e
            .model
            .lock()
            .embed(chunk.to_vec(), None)
            .map_err(|err| MemoryError::Other(format!("embed failed: {}", err)))?;
        for v in &part {
            check_dim(v)?;
        }
        out.extend(part);
    }
    Ok(out)
}

/// Encode a recall-time query, hitting the LRU for repeats. Key is the
/// trimmed query — same as Python. Empty queries bypass the cache and
/// go straight to `encode()` so we don't cache garbage keys.
pub fn encode_query(query: &str) -> Result<Vec<f32>> {
    let key = query.trim();
    if key.is_empty() {
        return encode(query);
    }
    let e = instance()?;
    if let Some(cached) = e.cache.lock().get(key) {
        return Ok(cached);
    }
    let vec = encode(key)?;
    e.cache.lock().insert(key.to_string(), vec.clone());
    Ok(vec)
}

/// Query-cache telemetry mirroring Python's `query_cache_stats()`.
/// Returned as a plain struct; the Phase 6 HTTP layer serialises it.
#[derive(Debug, Clone)]
pub struct QueryCacheStats {
    pub size: usize,
    pub max: usize,
    pub hits: u64,
    pub misses: u64,
    pub hit_rate: f64,
}

pub fn query_cache_stats() -> Result<QueryCacheStats> {
    let e = instance()?;
    let c = e.cache.lock();
    let total = c.hits + c.misses;
    let hit_rate = if total > 0 {
        (c.hits as f64 / total as f64 * 1000.0).round() / 1000.0
    } else {
        0.0
    };
    Ok(QueryCacheStats {
        size: c.map.len(),
        max: QUERY_CACHE_MAX,
        hits: c.hits,
        misses: c.misses,
        hit_rate,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // These tests reach the network on first run to download the ONNX
    // model. Mark them `#[ignore]` so CI that doesn't pre-populate
    // ~/.neurovault/.fastembed_cache/ skips them — run with `cargo test -- --ignored`
    // once the model is cached locally.

    #[test]
    #[ignore]
    fn encode_returns_384_dim_vector() {
        let v = encode("hello world").unwrap();
        assert_eq!(v.len(), EMBEDDING_DIM);
    }

    #[test]
    #[ignore]
    fn encode_query_cache_hits() {
        let _ = encode_query("repeated").unwrap();
        let _ = encode_query("repeated").unwrap();
        let stats = query_cache_stats().unwrap();
        assert!(stats.hits >= 1);
    }

    /// The download-storm regression. `OnceCell::get_or_try_init` leaves
    /// the cell empty when init fails, so before the gate every recall
    /// (and the ambient hook runs one per prompt) re-entered a closure
    /// that tries to fetch ~1.1 GB. One offline machine, unbounded
    /// attempts.
    #[test]
    fn a_failed_init_is_negative_cached_instead_of_retried_per_call() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        static ATTEMPTS: AtomicUsize = AtomicUsize::new(0);
        static CELL: OnceCell<u8> = OnceCell::new();
        static GATE: Lazy<ModelInitGate> =
            Lazy::new(|| ModelInitGate::new("test model", std::time::Duration::from_secs(5)));
        fn always_fails() -> Result<u8> {
            ATTEMPTS.fetch_add(1, Ordering::SeqCst);
            Err(MemoryError::Other("no network".to_string()))
        }

        let first = super::init_once(&GATE, &CELL, always_fails);
        assert!(first.is_err(), "a failing build must surface as an error");
        assert_eq!(ATTEMPTS.load(Ordering::SeqCst), 1);

        for _ in 0..25 {
            let again = super::init_once(&GATE, &CELL, always_fails);
            assert!(again.is_err(), "the cached failure is still a failure");
        }
        assert_eq!(
            ATTEMPTS.load(Ordering::SeqCst),
            1,
            "the cooldown must absorb the retry storm, not forward it"
        );
    }

    #[test]
    fn a_successful_init_happens_exactly_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        static ATTEMPTS: AtomicUsize = AtomicUsize::new(0);
        static CELL: OnceCell<u8> = OnceCell::new();
        static GATE: Lazy<ModelInitGate> =
            Lazy::new(|| ModelInitGate::new("test model", std::time::Duration::from_secs(5)));
        fn succeeds() -> Result<u8> {
            ATTEMPTS.fetch_add(1, Ordering::SeqCst);
            Ok(7)
        }

        for _ in 0..10 {
            assert_eq!(*super::init_once(&GATE, &CELL, succeeds).unwrap(), 7);
        }
        assert_eq!(ATTEMPTS.load(Ordering::SeqCst), 1, "the model loads once");
    }

    #[test]
    fn cache_evicts_when_full() {
        let mut c = QueryCache::new();
        for i in 0..(QUERY_CACHE_MAX + 50) {
            c.insert(format!("k{}", i), vec![0.0; EMBEDDING_DIM]);
        }
        assert_eq!(c.map.len(), QUERY_CACHE_MAX);
        assert_eq!(c.order.len(), QUERY_CACHE_MAX);
        // Oldest keys evicted first.
        assert!(c.get("k0").is_none());
        assert!(c.get(&format!("k{}", QUERY_CACHE_MAX + 10)).is_some());
    }
}
