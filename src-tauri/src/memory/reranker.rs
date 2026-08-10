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
//! OPT-IN, as of the 2026-08-10 audit fixes. It is worth having: the
//! benchmark credits it with +3.83pp hit@5 (0.9362 → 0.9745). It is also
//! ~1.1 GB on disk and resident, downloaded on first use.
//!
//! Two things used to make that an ambush rather than a choice, and both
//! are now fixed:
//!
//! - `handlers::rerank_enabled()` returned `true` when the pref file was
//!   absent — every fresh install. First search = silent 1.1 GB fetch.
//!   It now returns `false`; Settings writes `on` to opt in.
//! - Even with the pref off, `hybrid_retrieve` OR'd the caller's flag
//!   with a query-shape heuristic, so any short query re-enabled it
//!   anyway. The caller's `false` is now final (`rerank_decision`).
//!
//! The remaining tension is a measurement question, not a shipping one:
//! `build_reranker` below records the CE as NEUTRAL vs engine-only at
//! scale on LongMemEval while `docs/benchmarks/` credits the +3.83pp.
//! Both cannot describe the same configuration; until that is
//! re-measured, the user decides.

use fastembed::{RerankInitOptions, RerankerModel, TextRerank};
use once_cell::sync::{Lazy, OnceCell};
use parking_lot::Mutex;

use super::embedder::{init_once, ModelInitGate};
use super::paths::nv_home;
use super::types::{MemoryError, Result};

/// Global lazy-init reranker singleton. Guards concurrent use; the
/// underlying ONNX session isn't documented as thread-safe so we
/// serialise access via `Mutex`, same pattern as `embedder::instance`.
struct Reranker {
    model: Mutex<TextRerank>,
}

/// How long a recall waits for the cross-encoder before going on without
/// it. Short on purpose, and much shorter than the embedder's: losing the
/// CE costs a re-ordering of results the hybrid engine already found
/// (`rerank` returning `Err` falls back to RRF), so there is no reason to
/// hold a search hostage to a 1.1 GB download. The download continues in
/// the background and a later query picks it up.
const RERANKER_INIT_WAIT: std::time::Duration = std::time::Duration::from_secs(20);

fn build_reranker() -> Result<Reranker> {
    // `BGERerankerBase` is fastembed's default cross-encoder — a
    // ~278M-param model whose fp32 ONNX is ~1.0 GB on disk and
    // resident (NOT ~110 MB; corrected 2026-06-26). fastembed 4.9.1
    // exposes NO quantized BGERerankerBase variant (RerankerModel has
    // only BGERerankerBase / BGERerankerV2M3 / JINA*), so this cannot
    // be int8-swapped the way the embedder can (BGESmallENV15Q).
    // It is CPU/RAM-heavy and — measured on LongMemEval — NEUTRAL vs
    // engine-only at scale, which is why it is opt-in (see the module
    // header). Model cache is shared at `~/.neurovault/.fastembed_cache/`;
    // first-use download is the full ~1 GB.
    let model = TextRerank::try_new(
        RerankInitOptions::new(RerankerModel::BGERerankerBase)
            // Progress ON (it was suppressed): a user who has explicitly
            // opted into a ~1.1 GB download deserves to see it happen
            // somewhere. fastembed's embedder already defaults to true, so
            // this is also the consistent choice; indicatif draws to
            // stderr and stays silent when that isn't a terminal, so it
            // can't corrupt the MCP server's stdio.
            .with_show_download_progress(true)
            // Pin the model cache to ~/.neurovault/.fastembed_cache (matches
            // embedder.rs). Without this, fastembed defaults to the process
            // CWD — fine for the GUI app (launched from a stable dir) but
            // wrong for a headless `neurovault-server` started from an
            // arbitrary cwd (npm bin shim, brew, curl), which would scatter
            // a ~1.0 GB model under whatever folder the agent ran from.
            .with_cache_dir(nv_home().join(".fastembed_cache")),
    )
    .map_err(|e| MemoryError::Other(format!("reranker init failed: {}", e)))?;
    Ok(Reranker {
        model: Mutex::new(model),
    })
}

fn instance() -> Result<&'static Reranker> {
    static INSTANCE: OnceCell<Reranker> = OnceCell::new();
    // Shares the embedder's gate machinery: bounded wait, one attempt at
    // a time, negative-cached failure with backoff. Without it a failed
    // download was re-attempted from scratch on every recall, because
    // `OnceCell::get_or_try_init` leaves the cell empty on error.
    static GATE: Lazy<ModelInitGate> =
        Lazy::new(|| ModelInitGate::new("reranker model", RERANKER_INIT_WAIT));
    init_once(&GATE, &INSTANCE, build_reranker)
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
