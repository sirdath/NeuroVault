//! Cross-encoder reranker via `fastembed::TextRerank`.
//!
//! Second-stage scorer that re-ranks the top-N candidates from the
//! hybrid retriever. Unlike the dual-encoder path (query/doc
//! encoded independently), a cross-encoder sees `(query, doc)` as
//! a single input and can attend across both — yields measurably
//! better top-1 precision at the cost of ~50-100 ms per call.
//!
//! Off by default. Enabled per-recall via `RecallOpts::use_reranker`.
//! The singleton is lazy — the model only loads on first enable,
//! so users who never turn it on pay zero memory cost.

use fastembed::{RerankInitOptions, RerankerModel, TextRerank};
use once_cell::sync::OnceCell;
use parking_lot::Mutex;

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
        // `BGERerankerBase` is fastembed's default cross-encoder
        // — ~110 MB ONNX, same HF repo the Python side used for
        // the optional rerank path. Model cache is shared at
        // `~/.cache/fastembed/` so first-use download is ~10s;
        // subsequent runs are instant.
        let model = TextRerank::try_new(
            RerankInitOptions::new(RerankerModel::BGERerankerBase)
                .with_show_download_progress(false),
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
            by_idx[r.index] = r.score as f32;
        }
    }
    Ok(by_idx)
}
