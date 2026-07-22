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
//! HTTP/MCP layer overrides it: `enabled()` returns
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

/// Persisted user preference for the optional cross-encoder. This lives in
/// the model layer because ambient recall and adaptive recipes can invoke the
/// reranker without going through an HTTP handler.
pub fn preference_path() -> std::path::PathBuf {
    nv_home().join("rerank.txt")
}

fn enabled_from_path(path: &std::path::Path) -> bool {
    match std::fs::read_to_string(path) {
        Ok(s) => !matches!(s.trim().to_lowercase().as_str(), "off" | "false" | "0"),
        Err(_) => true,
    }
}

/// Whether the optional ~1 GB reranker is permitted to initialize.
/// Missing preference files preserve the historical default (on), while an
/// explicit opt-out applies to every recall path.
pub fn enabled() -> bool {
    enabled_from_path(&preference_path())
}

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
        // engine-only at scale. RecallOpts' low-level field is false, but the
        // HTTP/MCP layer deliberately overrides that with the fresh-install ON
        // preference documented above. Model cache is shared at
        // `~/.neurovault/.fastembed_cache/`; first-use download is ~1 GB.
        let mut opts = RerankInitOptions::new(RerankerModel::BGERerankerBase)
            .with_show_download_progress(false);
        // Match embedder.rs: an explicit cache override wins; otherwise keep
        // the model under NeuroVault's data root instead of the process CWD.
        if std::env::var_os("FASTEMBED_CACHE_DIR").is_none() {
            opts = opts.with_cache_dir(nv_home().join(".fastembed_cache"));
        }
        let model = TextRerank::try_new(opts)
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
    if !enabled() {
        return Err(MemoryError::Other(
            "reranker disabled by user preference".to_string(),
        ));
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

#[cfg(test)]
mod preference_tests {
    use super::enabled_from_path;

    #[test]
    fn missing_preference_preserves_the_historical_default() {
        let path = std::env::temp_dir().join(format!(
            "neurovault-reranker-missing-{}.txt",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        assert!(enabled_from_path(&path));
    }

    #[test]
    fn every_documented_opt_out_spelling_disables_the_model() {
        let path = std::env::temp_dir().join(format!(
            "neurovault-reranker-values-{}.txt",
            std::process::id()
        ));
        for value in ["off", "false", "0", " OFF \n"] {
            std::fs::write(&path, value).expect("write preference");
            assert!(
                !enabled_from_path(&path),
                "{value:?} must disable reranking"
            );
        }
        std::fs::write(&path, "on").expect("write preference");
        assert!(enabled_from_path(&path));
        let _ = std::fs::remove_file(path);
    }
}
