//! Cross-encoder reranker via `fastembed::TextRerank`.
//!
//! Second-stage scorer that re-ranks the top-N candidates from the
//! hybrid retriever. Unlike the dual-encoder path (query/doc
//! encoded independently), a cross-encoder sees `(query, doc)` as
//! a single input and can attend across both — yields measurably
//! better top-1 precision at the cost of ~50-100 ms per call.
//!
//! ## Default state — read this before trusting anything else
//!
//! This header used to read: "Off by default … users who never turn it
//! on pay zero memory cost." That is FALSE as shipped, and the gap
//! matters because the model is ~1 GB.
//!
//! `RecallOpts::default()` does set `use_reranker: false`, but the
//! HTTP/MCP layer overrides it: `handlers::rerank_enabled()` returns
//! `true` when the rerank pref file is absent — which is every fresh
//! install. So on a new machine the first keyword-shaped recall
//! triggers a ~1 GB download, then pins ~1 GB resident for the life of
//! the process (`OnceCell`, never unloaded). Nobody pays "zero".
//!
//! The repo currently argues with itself about whether ON is right:
//! the comment in `instance()` below records the reranker as NEUTRAL
//! vs engine-only at scale on LongMemEval, while `docs/benchmarks/`
//! credits it with the headline +3.83pp hit@5 (0.9362 → 0.9745). Both
//! cannot describe the same configuration. Until that is re-measured
//! the default is left ON, so the shipped product matches the
//! published benchmark — but the cost is now stated instead of denied.
//!
//! Users opt out in Settings, which writes `off` to the pref file.

use fastembed::{RerankInitOptions, RerankerModel, TextRerank};
use once_cell::sync::OnceCell;
use parking_lot::Mutex;

use super::paths::nv_home;
use super::types::{MemoryError, Result};

/// Global lazy-init reranker singleton. Guards concurrent use; the
/// underlying ONNX session isn't documented as thread-safe so we
/// serialise access via `Mutex`, same pattern as `embedder::instance`.
struct Reranker {
    model: Mutex<TextRerank>,
}

fn instance() -> Result<&'static Reranker> {
    static INSTANCE: OnceCell<Reranker> = OnceCell::new();
    INSTANCE.get_or_try_init(|| {
        // `BGERerankerBase` is fastembed's default cross-encoder — a
        // ~278M-param model whose fp32 ONNX is ~1.0 GB on disk and
        // resident (NOT ~110 MB; corrected 2026-06-26). fastembed 4.9.1
        // exposes NO quantized BGERerankerBase variant (RerankerModel has
        // only BGERerankerBase / BGERerankerV2M3 / JINA*), so this cannot
        // be int8-swapped the way the embedder can (BGESmallENV15Q).
        // It is CPU/RAM-heavy and — measured on LongMemEval — NEUTRAL vs
        // engine-only at scale, so it stays OFF by default (use_reranker
        // false; fires only for keyword-shaped queries). Model cache is
        // shared at `~/.neurovault/.fastembed_cache/`; first-use download
        // is the full ~1 GB.
        let model = TextRerank::try_new(
            RerankInitOptions::new(RerankerModel::BGERerankerBase)
                .with_show_download_progress(false)
                // Pin the model cache to ~/.neurovault/.fastembed_cache (matches
                // embedder.rs). Without this, fastembed defaults to the process
                // CWD — fine for the GUI app (launched from a stable dir) but
                // wrong for a headless `neurovault-server` started from an
                // arbitrary cwd (npm bin shim, brew, curl), which would scatter
                // a ~1.0 GB model under whatever folder the agent ran from.
                .with_cache_dir(nv_home().join(".fastembed_cache")),
        )
        .map_err(|e| MemoryError::Other(format!("reranker init failed: {}", e)))?;
        Ok::<Reranker, MemoryError>(Reranker {
            model: Mutex::new(model),
        })
    })
}

/// Rerank `documents` against `query`. Returns the cross-encoder
/// scores aligned with the input order (score[i] is the rerank score
/// for documents[i]). Higher = more relevant.
///
/// The reranker runs as a single batch of `(query, doc)` pairs. CPU-
/// bound (~50-100 ms for 20 pairs on a modern laptop). Keep the
/// candidate count ≤20 to stay inside the interactive latency budget.
pub fn rerank(query: &str, documents: &[String]) -> Result<Vec<f32>> {
    if documents.is_empty() {
        return Ok(Vec::new());
    }
    let inst = instance()?;
    let doc_refs: Vec<&str> = documents.iter().map(|s| s.as_str()).collect();
    let results = inst
        .model
        .lock()
        .rerank(query, doc_refs, false, None)
        .map_err(|e| MemoryError::Other(format!("rerank failed: {}", e)))?;

    // `rerank` returns Vec<RerankResult> ordered by descending score.
    // We want alignment to input order, so build an index→score map.
    let mut by_idx: Vec<f32> = vec![0.0; documents.len()];
    for r in results {
        if r.index < by_idx.len() {
            by_idx[r.index] = r.score;
        }
    }
    Ok(by_idx)
}
