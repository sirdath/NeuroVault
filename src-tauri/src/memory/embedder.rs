//! Local text embedding via fastembed-rs.
//!
//! Port of `server/neurovault_server/embeddings.py`. Same model
//! (`BAAI/bge-small-en-v1.5`), same 384 dims, same on-disk ONNX cache
//! under `~/.cache/fastembed/`. Existing Python installs have the
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
use once_cell::sync::OnceCell;
use parking_lot::Mutex;

use super::types::{MemoryError, Result};

/// Max entries in the encode_query LRU. Matches `_QUERY_CACHE_MAX` in
/// the Python embedder. 1000 × 384 × 4 bytes ≈ 1.5 MB of float data,
/// well under the memory budget for the hot path.
const QUERY_CACHE_MAX: usize = 1000;

/// Dimension the current model emits. Asserted at first encode so a
/// silent upstream model swap doesn't corrupt the vec0 table.
pub const EMBEDDING_DIM: usize = 384;

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

fn instance() -> Result<&'static Embedder> {
    static INSTANCE: OnceCell<Embedder> = OnceCell::new();
    INSTANCE.get_or_try_init(|| {
        // `InitOptions::new` + explicit model id matches what the
        // Python side passes: "BAAI/bge-small-en-v1.5". fastembed-rs
        // downloads to the same cache dir Python uses, so existing
        // installs skip the download entirely.
        let model = TextEmbedding::try_new(InitOptions::new(EmbeddingModel::BGESmallENV15))
            .map_err(|e| MemoryError::Other(format!("fastembed init failed: {}", e)))?;
        Ok::<Embedder, MemoryError>(Embedder {
            model: Mutex::new(model),
            cache: Mutex::new(QueryCache::new()),
        })
    })
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
    // ~/.cache/fastembed/ skips them — run with `cargo test -- --ignored`
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
