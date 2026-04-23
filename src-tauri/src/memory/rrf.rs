//! Reciprocal Rank Fusion — tiny, single-file helper.
//!
//! Port of `retriever.py::_rrf_score` + `RRF_K`. RRF fuses multiple
//! ranked lists by summing `1 / (k + rank)` for each document across
//! lists — it's dimensionless (no score normalisation needed) and
//! robust to wildly different score scales (BM25 scores range over
//! orders of magnitude, semantic cosines stay in ~[0, 1]). Together
//! with the weight tuple `(w_semantic, w_bm25, w_graph)` it composes
//! the final rank score in `hybrid_retrieve`.

/// The RRF constant. Matches Python's `RRF_K = 60`. A common tuning
/// choice for RRF — smaller k boosts the tail of each list more
/// aggressively; the Cormack et al. 2009 paper recommends 60 as a
/// broadly-useful default.
pub const RRF_K: f64 = 60.0;

/// RRF score for a 1-based rank. `rank = 1` → `1 / 61 ≈ 0.0164`,
/// `rank = 10` → `1 / 70 ≈ 0.0143`. Callers multiply by per-signal
/// weights (`w_semantic`, `w_bm25`, `w_graph`) before summing.
#[inline]
pub fn rrf_score(rank: usize) -> f64 {
    1.0 / (RRF_K + rank as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rank_one_is_higher_than_rank_two() {
        assert!(rrf_score(1) > rrf_score(2));
    }

    #[test]
    fn known_values_match_python() {
        // Python: 1 / (60 + 1) = 0.016393442622950821
        let v = rrf_score(1);
        assert!((v - 1.0 / 61.0).abs() < 1e-12);
    }
}
