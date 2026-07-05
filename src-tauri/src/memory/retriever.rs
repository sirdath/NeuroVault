//! Hybrid retrieval: semantic (sqlite-vec KNN) + BM25 + graph + RRF.
//!
//! Port of `server/neurovault_server/retriever.py::hybrid_retrieve`.
//! The Python file runs to 965 lines; the Rust port is lean by
//! design:
//!
//! - **Cross-encoder reranker**: dropped entirely per the migration
//!   plan. `use_reranker=False` is the new default; the
//!   sentence-transformers path was ~80 MB of deps for a feature
//!   that wasn't on by default anyway.
//! - **Stage-4 learned affinities**: removed 2026-05-17. Was a dead
//!   `affinity_bonus` field that was always 0 (nothing ever wrote to
//!   `query_affinity`). If learned affinities are revived, add the
//!   signal back at the final-score step — the table is still in
//!   the schema.
//! - **Temporal-fact supersede fraction**: implemented with the
//!   same SQL as Python, but the `intelligence` module that populates
//!   the table doesn't run on the Rust write path yet. On fresh
//!   Rust-ingested brains the fraction is always 0; on brains
//!   migrated from Python the existing rows still apply the penalty
//!   correctly.
//! - **Title-embedding LRU**: implemented via the same
//!   `embedder::encode_batch` singleton — one call per query, novel
//!   titles embed once and stay in the model's caller-side cache.
//!
//! The scoring ladder matches Python precisely:
//!   1. Three-signal RRF with query-type-adapted weights.
//!   2. Title boost: keyword coverage (uncapped) + semantic title
//!      cosine (top-10 only).
//!   3. Spreading activation (opt-in, default off).
//!   4. Temporal-intent recency: linear rank-relative spread × per-
//!      intent exponential age decay.
//!   5. Decision / negation bonuses.
//!   6. Final = rerank_score × 0.75 + strength × 0.15, scaled by
//!      recency_factor, plus decision / affinity / insight bonuses.

use std::collections::{HashMap, HashSet};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use regex::Regex;
use rusqlite::params_from_iter;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use super::bm25::{self, Bm25Index};
use super::db::{BrainDb, EMBEDDING_DIM};
use super::embedder;
use super::entities::extract_entities_locally;
use super::pagerank_state;
use super::query_parser::{self, QueryFilters};
use super::recall_cache;
use super::reranker;
use super::rrf::rrf_score;
use super::spread::{spread_neighbors, SpreadOpts};
use super::throttle;
use super::types::Result;

/// The in-flight candidate passed through every scoring stage.
/// Public so `spread.rs` can append neighbour rows. Matches the Python
/// dict-in-a-list shape one-to-one (field names line up).
#[derive(Debug, Clone)]
pub struct Candidate {
    pub engram_id: String,
    pub title: String,
    pub content: String,
    pub strength: f64,
    pub state: String,
    pub updated_at: String,
    pub created_at: String,
    pub kind: String,
    pub rrf_score: f64,
    pub via_spread: bool,
    pub rerank_score: f64,
    pub recency_factor: f64,
    pub decision_bonus: f64,
    pub final_score: f64,
}

/// Recall result — matches the Python `/api/recall` response shape.
/// MCP proxy serialises this straight to JSON; do not rename fields
/// without checking `mcp_proxy.py`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecallHit {
    pub engram_id: String,
    pub title: String,
    pub content: String,
    pub score: f64,
    pub strength: f64,
    pub state: String,
    /// How much to TRUST this fact, in [0,1] — distinct from `score`
    /// (retrieval relevance) and `strength` (usage/recency). Zero-LLM:
    /// an authoritative value from `memory_types` if one was written,
    /// else a structural estimate from the engram kind (provenance, not
    /// an LLM judge). Lets a reading agent weigh facts — especially ones
    /// written by OTHER agents — instead of trusting every hit equally.
    #[serde(default = "default_confidence")]
    pub confidence: f64,
}

fn default_confidence() -> f64 {
    1.0
}

/// Zero-LLM structural confidence by engram kind. Source-mirrored facts
/// are verbatim-from-disk (verified); human/agent-authored notes are
/// trusted; passive observations are weakest. Deliberately conservative
/// and tunable; overridden by an authoritative `memory_types.confidence`
/// when present.
pub fn structural_confidence(kind: &str) -> f64 {
    match kind {
        "source" | "code" => 1.0,
        "decision" | "insight" | "note" => 0.9,
        "preference" => 0.85,
        "observation" => 0.6,
        _ => 0.8,
    }
}

/// Confidence for one engram: the authoritative `memory_types` value if
/// written (the column is otherwise dormant), else the structural
/// estimate from kind. Cheap PK lookup; safe to call per hit.
fn engram_confidence(db: &BrainDb, engram_id: &str, kind: &str) -> f64 {
    let stored = {
        let conn = db.lock();
        conn.query_row(
            "SELECT confidence FROM memory_types WHERE engram_id = ?1",
            [engram_id],
            |r| r.get::<_, f64>(0),
        )
        .ok()
    };
    stored
        .map(|c| c.clamp(0.0, 1.0))
        .unwrap_or_else(|| structural_confidence(kind))
}

/// Recall inputs. `mode` is accepted for forwards-compat with the
/// Python API but currently only switches between "titles" (title-
/// only shape) and "preview" / "full" (content included). Most
/// callers pass `None`.
#[derive(Debug, Clone)]
pub struct RecallOpts {
    pub top_k: usize,
    pub spread_hops: u8,
    pub exclude_kinds: Vec<String>,
    pub as_of: Option<String>,
    /// Enable the cross-encoder second-stage reranker on the top-20
    /// candidates. Adds ~50-100 ms per call; improves top-1 precision
    /// on queries where the dual-encoder picks a close-but-wrong
    /// candidate. Off by default (opt-in per recall).
    pub use_reranker: bool,
    /// Feature-ablation switches, for A/B testing what each scoring
    /// signal is worth. Empty = full pipeline (default). Recognised
    /// values (matched case-insensitive):
    ///
    ///   "title_semantic"    — skip semantic title-cosine boost
    ///   "title_keyword"     — skip keyword-coverage title boost
    ///   "decision"          — skip decision/negation content bonus
    ///   "recency"           — skip temporal-intent + age decay
    ///   "supersede"         — skip superseded-fact penalty
    ///   "entity_graph"      — skip graph retrieval signal entirely
    ///   "bm25"              — skip BM25 (keyword) signal entirely
    ///   "semantic"          — skip semantic KNN signal entirely
    ///   "insight_boost"     — skip insight kind_bonus
    ///
    /// Ablation is production-safe but off by default; exercised
    /// only through the eval harness when comparing configurations.
    pub ablate: Vec<String>,
}

/// Synthetic engram id stamped on the hint-hit that `hybrid_retrieve_throttled`
/// prepends when the rate limiter kicks in. Clients that want to hide
/// it from their UI can filter on this sentinel — everyone else gets
/// a naturally-formatted warning hit at position 0.
pub const THROTTLE_HINT_ID: &str = "__throttle_hint__";

impl Default for RecallOpts {
    fn default() -> Self {
        Self {
            top_k: 10,
            spread_hops: 0,
            exclude_kinds: vec!["observation".to_string()],
            as_of: None,
            use_reranker: false,
            ablate: Vec::new(),
        }
    }
}

/// Helper: did the caller ablate `feature`? Case-insensitive match
/// against the opts list.
fn is_ablated(opts: &RecallOpts, feature: &str) -> bool {
    if opts.ablate.iter().any(|a| a.eq_ignore_ascii_case(feature)) {
        return true;
    }
    // Env-var override (`NEUROVAULT_DISABLE_<FEATURE>`) — lets the bench
    // harness ablate any flag without an API change. Lower-cased flag,
    // dashes -> underscores. Bench-only; default is no override.
    let env_name = format!(
        "NEUROVAULT_DISABLE_{}",
        feature.to_uppercase().replace('-', "_")
    );
    std::env::var(&env_name)
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

/// Filter candidates in-memory after their engram row is fetched.
/// Cheap struct checks for everything except `entity:`, which uses a
/// pre-built allow-set keyed on engram id (O(1) lookup).
// One parameter per engram column tested in place; a params struct would only relay the same fields.
#[allow(clippy::too_many_arguments)]
fn passes_filters(
    filters: &QueryFilters,
    kind: &str,
    state: &str,
    filename: &str,
    created_at: &str,
    agent_id: &str,
    engram_id: &str,
    entity_allow: Option<&std::collections::HashSet<String>>,
) -> bool {
    if let Some(k) = &filters.kind {
        if kind != k {
            return false;
        }
    }
    if let Some(s) = &filters.state {
        if state != s {
            return false;
        }
    }
    if let Some(f) = &filters.folder {
        let prefix = format!("{}/", f);
        if !filename.starts_with(&prefix) {
            return false;
        }
    }
    if let Some(a) = &filters.after {
        if created_at.is_empty() || created_at < a.as_str() {
            return false;
        }
    }
    if let Some(b) = &filters.before {
        if created_at.is_empty() || created_at >= b.as_str() {
            return false;
        }
    }
    if let Some(ag) = &filters.agent {
        if agent_id != ag {
            return false;
        }
    }
    if filters.entity.is_some() {
        match entity_allow {
            Some(allow) if allow.contains(engram_id) => {}
            _ => return false,
        }
    }
    true
}

/// Pre-build the set of engram ids that mention a named entity
/// (case-insensitive). One query up-front keeps the per-candidate
/// loop O(1) afterward.
fn build_entity_allow_set(
    db: &BrainDb,
    entity_name: &str,
) -> Result<std::collections::HashSet<String>> {
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT em.engram_id FROM entity_mentions em
         JOIN entities et ON et.id = em.entity_id
         WHERE LOWER(et.name) = ?1",
    )?;
    let rows = stmt.query_map([entity_name], |r| r.get::<_, String>(0))?;
    let mut out = std::collections::HashSet::new();
    for r in rows {
        out.insert(r?);
    }
    Ok(out)
}

// ---- Query classification helpers -----------------------------------------

static QUESTION_WORDS: &[&str] = &[
    "what", "how", "why", "which", "where", "when", "who", "does", "is", "can",
];

fn classify_query(query: &str) -> &'static str {
    let words: Vec<&str> = query.split_whitespace().collect();
    let head: Vec<String> = words.iter().take(3).map(|w| w.to_lowercase()).collect();
    let has_qword = head.iter().any(|w| QUESTION_WORDS.contains(&w.as_str()));
    if words.len() <= 4 && !has_qword {
        return "keyword";
    }
    if has_qword && words.len() > 6 {
        return "natural";
    }
    "mixed"
}

fn weights_for(query_type: &str) -> (f64, f64, f64) {
    match query_type {
        "keyword" => (0.30, 0.50, 0.20),
        "natural" => (0.55, 0.25, 0.20),
        _ => (0.45, 0.35, 0.20),
    }
}

// ---- Cross-encoder rank fusion -------------------------------------------
//
// The cross-encoder reranker (cross-attention query↔doc) is a stronger
// relevance signal than any single dual-encoder / BM25 / graph list, but
// its raw output is a logit in ~[-10, 10] → sigmoid ∈ [0, 1]. The previous
// design blended `0.3·hybrid + 0.7·sigmoid(CE)` directly into rerank_score.
// Because the hybrid score lives in ~[0.01, 0.4] (RRF base ~0.016 plus
// additive title / exact-match / graph boosts), the [0, 1] sigmoid term
// numerically SWAMPS the hybrid — the 0.3 weight is nominal, CE effectively
// gets the whole vote, and a single CE miss ejects a true gold past k.
// Measured on a recency-ablated LongMemEval slice (2026-06-24): rerank kept
// hit@5 flat but cost −5pp recall@10 / −1q hit@10, while winning +13pp
// hit@1 — the signature of a good reranker behind a broken fusion.
//
// Fix: rank fusion. Convert BOTH the hybrid ordering and the CE ordering to
// reciprocal-rank scores (commensurable by construction), fuse them, then
// map the window's existing score magnitudes back onto the fused order.
// CE re-orders the window without erasing the hybrid prior, and the
// downstream final-score scale is untouched because the multiset of
// magnitudes is preserved — only their assignment permutes. The weights
// are the tuning lever: CE leads, the hybrid rank anchors against ejection.
const RERANK_HYBRID_W: f64 = 0.7;
const RERANK_CE_W: f64 = 1.0;

/// Rank-fuse the cross-encoder against the hybrid ordering.
///
/// `mags[i]` is windowed candidate `i`'s current hybrid score; the slice is
/// in hybrid-rank order, so the index `i` IS the hybrid rank (0-based).
/// `ce[i]` is the cross-encoder logit for that same candidate. Returns a new
/// score per candidate: the SAME multiset of magnitudes, permuted so the
/// k-th best fused candidate receives the k-th largest magnitude. Preserving
/// the multiset keeps the downstream final-score scale (strength, recency)
/// byte-identical; only the order changes.
fn fuse_cross_encoder(mags: &[f64], ce: &[f32], w_hybrid: f64, w_ce: f64) -> Vec<f64> {
    let w = mags.len().min(ce.len());
    if w == 0 {
        return mags.to_vec();
    }
    // CE rank = position in CE-logit-descending order, per candidate.
    let mut ce_order: Vec<usize> = (0..w).collect();
    ce_order.sort_by(|&a, &b| {
        ce[b]
            .partial_cmp(&ce[a])
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut ce_rank = vec![0usize; w];
    for (r, &i) in ce_order.iter().enumerate() {
        ce_rank[i] = r;
    }
    // Fused reciprocal-rank score: hybrid rank is the index, CE rank above.
    let mut fused: Vec<(usize, f64)> = (0..w)
        .map(|i| {
            (
                i,
                w_hybrid * rrf_score(i + 1) + w_ce * rrf_score(ce_rank[i] + 1),
            )
        })
        .collect();
    fused.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    // The window's magnitudes, largest first, to remap onto the fused order.
    let mut sorted_mags: Vec<f64> = mags[..w].to_vec();
    sorted_mags.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
    // k-th fused-ranked candidate gets the k-th largest magnitude. Any
    // candidate beyond `w` (defensive: mismatched lengths) keeps its own.
    let mut out = mags.to_vec();
    for (k, &(i, _)) in fused.iter().enumerate() {
        out[i] = sorted_mags[k];
    }
    out
}

// ---- Query expansion ------------------------------------------------------
//
// REMOVED. The hardcoded synonym table (`frontend` → `ui, react, …`
// etc.) tested as net-negative in the 2026-04-23 eval matrix:
// removing it improved hit@1 by 3.3 points with zero downside. The
// synonyms promoted off-topic hits more often than they surfaced
// missed ones — the embedder already handles the common paraphrases
// the table was trying to cover.
//
// Kept as a comment rather than deleted-without-trace so a future
// maintainer finds this decision instead of re-adding the table.

// ---- Temporal intent classifier ------------------------------------------

static FRESH_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)\b(recent|recently|latest|newest|current|currently|now|today|tonight|yesterday|just now|lately|updated|newly|most recent|this (week|month|year|morning|afternoon|evening)|in the last \w+|for the last \w+)\b",
    )
    .unwrap()
});

static HISTORICAL_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)\b(original|originally|first|initially|initial|used to|back then|back when|previously|formerly|historically|ancient|long ago|in the past|at the start|at the beginning|early on|earlier|old(est|er)?|was (the|a|an|my|our|your)|were (the|a|my|our|your)|before (we|i|they|you))\b",
    )
    .unwrap()
});

fn classify_temporal_intent(query: &str) -> &'static str {
    if query.is_empty() {
        return "neutral";
    }
    let fresh = FRESH_RE.is_match(query);
    let historical = HISTORICAL_RE.is_match(query);
    match (fresh, historical) {
        (true, false) => "fresh",
        (false, true) => "historical",
        _ => "neutral",
    }
}

fn recency_params(intent: &str) -> (f64, f64) {
    match intent {
        "fresh" => (1.00, 0.60),
        "historical" => (0.60, 1.00),
        _ => (1.00, 1.00),
    }
}

fn recency_lambda(intent: &str) -> f64 {
    match intent {
        "fresh" => 0.01,
        "historical" => 0.0,
        _ => 0.001,
    }
}

/// Parse an ISO timestamp (the shape `insert_engram` writes via
/// `strftime('%Y-%m-%d %H:%M:%f', 'now')`) and return age in days.
/// Returns 0 on parse failure to match Python's conservative default.
fn age_days(updated_at: &str) -> f64 {
    if updated_at.is_empty() {
        return 0.0;
    }
    // SQLite's strftime doesn't write a `T` separator, so try the
    // space-separated form first; fall back to an ISO-8601 form so
    // rows written by other tools still parse.
    let formats: &[&[time::format_description::FormatItem]] = &[
        // "2026-04-22 18:03:45.123"
        time::macros::format_description!(
            "[year]-[month]-[day] [hour]:[minute]:[second].[subsecond]"
        ),
        // "2026-04-22 18:03:45"
        time::macros::format_description!("[year]-[month]-[day] [hour]:[minute]:[second]"),
        // "2026-04-22T18:03:45.123"
        time::macros::format_description!(
            "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond]"
        ),
    ];
    for fmt in formats {
        if let Ok(dt) = time::PrimitiveDateTime::parse(updated_at, fmt) {
            let parsed = dt.assume_utc();
            let now = OffsetDateTime::now_utc();
            let delta = (now - parsed).as_seconds_f64();
            return (delta / 86400.0).max(0.0);
        }
    }
    0.0
}

// ---- Embedding helpers ---------------------------------------------------

fn normalize_inplace(v: &mut [f32]) -> bool {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm == 0.0 {
        return false;
    }
    for x in v.iter_mut() {
        *x /= norm;
    }
    true
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

// ---- Title-embedding LRU -------------------------------------------------

/// Capped LRU for title → embedding. Matches Python's `_TITLE_CACHE_MAX`.
const TITLE_CACHE_MAX: usize = 4000;

struct TitleCache {
    map: HashMap<String, Vec<f32>>,
    order: Vec<String>,
}

impl TitleCache {
    fn new() -> Self {
        Self {
            map: HashMap::with_capacity(TITLE_CACHE_MAX),
            order: Vec::with_capacity(TITLE_CACHE_MAX),
        }
    }
}

static TITLE_CACHE: Lazy<Mutex<TitleCache>> = Lazy::new(|| Mutex::new(TitleCache::new()));

fn title_embeddings(titles: &[String]) -> Result<Vec<Vec<f32>>> {
    // Resolve cached entries first, collect novel ones for a single
    // batch embed call.
    let mut out: Vec<Option<Vec<f32>>> = vec![None; titles.len()];
    let mut novel: Vec<(usize, String)> = Vec::new();
    {
        let mut c = TITLE_CACHE.lock();
        for (i, t) in titles.iter().enumerate() {
            if let Some(v) = c.map.get(t) {
                out[i] = Some(v.clone());
            } else {
                novel.push((i, t.clone()));
            }
        }
        // Move hits to the end of the order vec so they stay warm.
        for t in titles {
            if c.map.contains_key(t) {
                if let Some(pos) = c.order.iter().position(|k| k == t) {
                    let k = c.order.remove(pos);
                    c.order.push(k);
                }
            }
        }
    }
    if !novel.is_empty() {
        let texts: Vec<String> = novel.iter().map(|(_, t)| t.clone()).collect();
        let fresh = embedder::encode_batch(&texts)?;
        let mut c = TITLE_CACHE.lock();
        for ((i, t), vec) in novel.into_iter().zip(fresh) {
            out[i] = Some(vec.clone());
            c.map.insert(t.clone(), vec);
            c.order.push(t);
        }
        while c.order.len() > TITLE_CACHE_MAX {
            let evicted = c.order.remove(0);
            c.map.remove(&evicted);
        }
    }
    Ok(out.into_iter().flatten().collect())
}

// ---- BM25 token helpers (mirror of memory::bm25 tokenise) -----------------

static MD_PUNCT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[#*`\[\](){}|>~_]").unwrap());
static TOKEN_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[a-z0-9]+(?:-[a-z0-9]+)*").unwrap());
static BM25_STOPWORDS: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    [
        "a", "an", "the", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
        "do", "does", "did", "will", "would", "could", "should", "may", "might", "shall", "can",
        "need", "dare", "ought", "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
        "as", "into", "through", "during", "before", "after", "above", "below", "between", "out",
        "off", "over", "under", "again", "further", "then", "once", "here", "there", "when",
        "where", "why", "how", "all", "each", "every", "both", "few", "more", "most", "other",
        "some", "such", "no", "nor", "not", "only", "own", "same", "so", "than", "too", "very",
        "and", "but", "or", "if", "while", "because", "until", "although", "this", "that", "these",
        "those", "it", "its", "i", "me", "my", "we", "our", "you", "your", "he", "him", "his",
        "she", "her", "they", "them", "their", "what", "which", "who", "whom",
    ]
    .iter()
    .copied()
    .collect()
});

/// Crude suffix stripper — just enough to bridge a query word to a fact's
/// attribute across inflection ("owns" vs "owner" → "own"; "signals" →
/// "signal"). NOT a real stemmer; used only to score attribute/value
/// relevance when disambiguating multiple facts that share a subject, a
/// narrow + low-risk context. Longer suffixes are checked first.
fn light_stem(t: &str) -> String {
    for suf in [
        "ations", "ation", "ings", "ing", "ers", "er", "ors", "or", "ions", "ion", "ed", "es", "s",
    ] {
        if t.len() > suf.len() + 2 && t.ends_with(suf) {
            return t[..t.len() - suf.len()].to_string();
        }
    }
    t.to_string()
}

fn bm25_tokenize(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let cleaned = MD_PUNCT_RE.replace_all(&lower, " ");
    TOKEN_RE
        .find_iter(&cleaned)
        .map(|m| m.as_str().to_string())
        .filter(|w| !BM25_STOPWORDS.contains(w.as_str()) && w.chars().count() > 1)
        .collect()
}

// ---- Improvement #2: salient query terms (proper nouns / phrases) --------
//
// Named entities and exact quoted phrases are the highest-precision
// retrieval signal a user can give. The keyword-title boost is
// proper-noun-blind (it weights "sarah" == "meeting"); this extracts
// the salient terms so a separate, conservative boost can reward exact
// entity/phrase hits. Detection keys on *linguistic structure*
// (capitalisation, quotes) only — never on bench question text.
static QUOTED_DQ_RE: Lazy<Regex> = Lazy::new(|| Regex::new("\"([^\"]{2,60})\"").unwrap());
static QUOTED_SQ_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"'([^']{2,60})'").unwrap());
// Capitalised word, >=3 chars (Upper + >=2 lower): "Sarah", "Postgres".
static CAP_WORD_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\p{Lu}\p{Ll}{2,}$").unwrap());
// Internal-caps token: a lowercase letter immediately followed by an
// uppercase one ("PostgreSQL", "NeuroVault"). Normal prose words are
// never camel-cased, so these are proper nouns even sentence-initially.
static INTERNAL_CAPS_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^\p{L}*\p{Ll}\p{Lu}\p{L}*$").unwrap());
// Improvement #3: standalone numeric token (years/counts/quantities).
// `\b…\b` already excludes digits embedded in alphanumeric ids
// ("iso9001", "v8"); 1-4 digit runs cover years and realistic counts.
// Matches the `[a-z0-9]+` content tokenisation, so a query "2023"
// aligns with a content "2023" as a whole token.
static NUM_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b\d{1,4}\b").unwrap());
// imp#4: explicit "current value" intent. The supersession boost only
// fires when the query asks for the CURRENT value — without this gate
// it would perturb ordinary recall (and a false supersede-demotion of
// the sole answer is the only real risk; history: false temporal
// demotions cost −16pp).
static FACT_CURRENCY_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)\b(current|currently|latest|now|nowadays|these days|right now|at the moment|as of now)\b",
    )
    .unwrap()
});

/// Returns (proper-noun tokens, quoted phrases, numeric tokens), all
/// lowercased. Conservative on purpose: a false boost is worse than a
/// miss, so sentence-initial capitalised words and stopwords are
/// dropped, single-quoted captures must contain a space (so a
/// contraction like `don't ... O'Brien's` can't masquerade as a
/// phrase), and numerics are bare 1-4 digit runs only.
fn extract_salient(query: &str) -> (Vec<String>, Vec<String>, Vec<String>) {
    let mut phrases: Vec<String> = Vec::new();
    for cap in QUOTED_DQ_RE.captures_iter(query) {
        let p = cap[1].trim().to_lowercase();
        if !p.is_empty() {
            phrases.push(p);
        }
    }
    for cap in QUOTED_SQ_RE.captures_iter(query) {
        let p = cap[1].trim().to_lowercase();
        if p.contains(' ') {
            phrases.push(p);
        }
    }
    phrases.sort();
    phrases.dedup();

    let mut nouns: Vec<String> = Vec::new();
    let mut sentence_start = true;
    for raw in query.split_whitespace() {
        let word = raw.trim_matches(|c: char| !c.is_alphanumeric());
        let ends_sentence = raw.ends_with('.') || raw.ends_with('?') || raw.ends_with('!');
        if word.is_empty() {
            if ends_sentence {
                sentence_start = true;
            }
            continue;
        }
        let internal = INTERNAL_CAPS_RE.is_match(word);
        let cap = CAP_WORD_RE.is_match(word);
        let lc = word.to_lowercase();
        // Internal-caps tokens count even sentence-initially; a plain
        // Capitalised word at sentence start is ambiguous → skip it.
        let candidate = internal || (cap && !sentence_start);
        if candidate && lc.chars().count() >= 3 && !BM25_STOPWORDS.contains(lc.as_str()) {
            nouns.push(lc);
        }
        sentence_start = ends_sentence;
    }
    nouns.sort();
    nouns.dedup();

    let mut numerics: Vec<String> = NUM_RE
        .find_iter(query)
        .map(|m| m.as_str().to_string())
        .collect();
    numerics.sort();
    numerics.dedup();

    (nouns, phrases, numerics)
}

// ---- DB helpers ----------------------------------------------------------

/// KNN over `vec_chunks` — returns (chunk_id, distance, content,
/// engram_id, granularity) for the top `limit` rows.
///
/// Dormant filtering: vec_chunks has no `state` column (it is a vec0
/// virtual table). Previously, `WHERE v.embedding MATCH ? AND k = ?`
/// returned the top-K nearest neighbours over the *entire* vector
/// pool — including chunks whose engrams are now `state='dormant'`.
/// Those were silently filtered later at candidate materialisation,
/// after they had already consumed K slots. For brains with a large
/// dormant tail (notably the bench, which mark-dormants per-question)
/// the live yield in top-K could drop near zero, starving the agent
/// of related-context coverage (root cause identified 2026-05-20 from
/// a question-level v1 vs Rust diff on single-session-preference).
///
/// Fix: oversample by `OVERSAMPLE` (request `limit * 8` from vec0),
/// filter dormant in the join WHERE, then `LIMIT ?` to the requested
/// `limit` after filtering. Costs nothing on a normal brain (almost
/// no dormant rows → top-`limit` == top-`limit*8`-filtered); on
/// bench/heavy-dormant workloads it restores live-K parity.
fn knn_search(db: &BrainDb, query_emb: &[f32], limit: usize) -> Result<Vec<KnnHit>> {
    const OVERSAMPLE: usize = 8;
    let mut bytes = Vec::with_capacity(query_emb.len() * 4);
    for f in query_emb {
        bytes.extend_from_slice(&f.to_le_bytes());
    }
    // sqlite-vec rejects KNN queries with k > 4096 outright. Deep callers
    // (chunk_search_depth × this oversample) can exceed that on big pools;
    // clamping trades a little dormant-filtering parity for not erroring.
    let oversampled_k = limit.saturating_mul(OVERSAMPLE).max(limit).min(4096);
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT v.chunk_id, v.distance, c.content, c.engram_id, c.granularity
         FROM vec_chunks v
         JOIN chunks c ON c.id = v.chunk_id
         JOIN engrams e ON e.id = c.engram_id
         WHERE v.embedding MATCH ? AND k = ?
           AND e.state != 'dormant'
           AND e.superseded_by IS NULL
         ORDER BY v.distance ASC
         LIMIT ?",
    )?;
    let rows = stmt
        .query_map(
            rusqlite::params![bytes, oversampled_k as i64, limit as i64],
            |r| {
                Ok(KnnHit {
                    chunk_id: r.get(0)?,
                    distance: r.get(1)?,
                    content: r.get(2)?,
                    engram_id: r.get(3)?,
                    granularity: r.get(4)?,
                })
            },
        )?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[derive(Debug, Clone)]
#[allow(dead_code)] // every field except engram_id is retained for future debug output
struct KnnHit {
    chunk_id: String,
    distance: f64,
    content: String,
    engram_id: String,
    granularity: String,
}

fn resolve_chunk_engrams(db: &BrainDb, chunk_ids: &[String]) -> Result<HashMap<String, String>> {
    if chunk_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let placeholders = std::iter::repeat_n("?", chunk_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT id, engram_id FROM chunks WHERE id IN ({})",
        placeholders
    );
    let conn = db.lock();
    let mut stmt = conn.prepare(&sql)?;
    let bind: Vec<rusqlite::types::Value> = chunk_ids
        .iter()
        .map(|s| rusqlite::types::Value::Text(s.clone()))
        .collect();
    let rows = stmt
        .query_map(params_from_iter(bind.iter()), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows.into_iter().collect())
}

/// Graph retrieve: entity match + 2-hop expand. Ported from
/// `_graph_retrieve`. Returns up to `limit` engram ids.
fn graph_retrieve(db: &BrainDb, query: &str, limit: usize) -> Result<Vec<String>> {
    let query_entities = extract_entities_locally(query);
    let query_words: HashSet<String> = query
        .to_lowercase()
        .split_whitespace()
        .map(|w| w.to_string())
        .collect();

    let conn = db.lock();

    let mut entity_ids: Vec<String> = Vec::new();
    for ent in &query_entities {
        let id: Option<String> = conn
            .query_row(
                "SELECT id FROM entities WHERE name = ?1 COLLATE NOCASE",
                [&ent.name],
                |r| r.get::<_, String>(0),
            )
            .ok();
        if let Some(id) = id {
            entity_ids.push(id);
        }
    }

    // Scan all entities for word-overlap fallback.
    let mut stmt = conn.prepare("SELECT id, name FROM entities")?;
    let all: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);
    for (eid, name) in all {
        let name_words: HashSet<String> = name
            .to_lowercase()
            .split_whitespace()
            .map(|w| w.to_string())
            .collect();
        if name_words.intersection(&query_words).next().is_some() && !entity_ids.contains(&eid) {
            entity_ids.push(eid);
        }
    }

    if entity_ids.is_empty() {
        return Ok(Vec::new());
    }

    // Hop 1: entity_mentions → engrams.
    let mut hop1: HashSet<String> = HashSet::new();
    for eid in &entity_ids {
        let mut stmt = conn.prepare(
            "SELECT em.engram_id FROM entity_mentions em
             JOIN engrams e ON e.id = em.engram_id
             WHERE em.entity_id = ?1 AND e.state != 'dormant'
               AND e.superseded_by IS NULL",
        )?;
        let rows: Vec<String> = stmt
            .query_map([eid], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for r in rows {
            hop1.insert(r);
        }
    }

    // Hop 2: engram_links from hop1 engrams with similarity > 0.5.
    let mut hop2: HashSet<String> = HashSet::new();
    for eng_id in &hop1 {
        let mut stmt = conn.prepare(
            "SELECT l.to_engram FROM engram_links l
             JOIN engrams e ON e.id = l.to_engram
             WHERE l.from_engram = ?1 AND e.state != 'dormant'
               AND e.superseded_by IS NULL
               AND l.similarity > 0.5 LIMIT 5",
        )?;
        let rows: Vec<String> = stmt
            .query_map([eng_id], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for r in rows {
            if !hop1.contains(&r) {
                hop2.insert(r);
            }
        }
    }

    let mut out: Vec<String> = hop1.into_iter().take(limit).collect();
    if out.len() < limit {
        out.extend(hop2.into_iter().take(limit - out.len()));
    }
    Ok(out)
}

// ---- Main entry ----------------------------------------------------------

/// One engram row fetched during candidate building:
/// `(id, title, content, strength, state, updated_at, created_at, kind, filename, agent_id)`.
type EngramRow = (
    String,
    String,
    String,
    f64,
    String,
    String,
    String,
    String,
    String,
    String,
);

/// Run `hybrid_retrieve` end-to-end. Equivalent to Python's
/// `retriever.hybrid_retrieve`, minus the cross-encoder reranker
/// branch. BM25 is ensured to be built before the first query fires.
pub fn hybrid_retrieve(db: &BrainDb, query: &str, opts: &RecallOpts) -> Result<Vec<RecallHit>> {
    let exclude_set: HashSet<String> = opts.exclude_kinds.iter().cloned().collect();
    // Pull any `kind:`, `folder:`, `after:` … operators out of the
    // query before embedding. The remaining free text is what goes
    // through the semantic + BM25 pipeline; the operators gate
    // candidates at materialisation time so we don't waste scoring
    // budget on rows that'll be filtered out anyway.
    let (filters, free_text) = query_parser::parse(query);
    let effective_query = if free_text.is_empty() {
        query
    } else {
        free_text.as_str()
    };
    // Entity filter needs a one-time lookup of "which engrams mention
    // this entity" so the per-candidate check stays O(1).
    let entity_allow = match &filters.entity {
        Some(name) => Some(build_entity_allow_set(db, name)?),
        None => None,
    };

    // candidate_pool: how many distinct engrams reach the scorer. Wider lets
    // more distinct sessions compete (recall@k upside) but costs per-query CPU
    // (bigger title-embed pool + chunk_search_depth = pool*8). Phase-1 probe:
    // default *6; `--ablate wide_pool` restores the *4 baseline for A/B.
    let pool_mult = if is_ablated(opts, "wide_pool") { 4 } else { 6 };
    let candidate_pool = (opts.top_k * pool_mult).max(10);
    // Chunk-level search depth. The candidate pool is counted in ENGRAMS,
    // but KNN/BM25 rank CHUNKS — and a long document fans out into hundreds
    // of chunks, so a pool-sized chunk cutoff lets a few verbose documents
    // crowd everything else out of the candidate set before scoring even
    // runs (measured on LongMemEval-style 50-transcript brains: the right
    // session was absent from the top-10 because 40 chunks ≈ 4 documents).
    // Searching 8× deeper at chunk level and cutting at candidate_pool
    // DISTINCT engrams fixes the starvation; downstream scoring cost is
    // unchanged because each signal still contributes at most
    // candidate_pool engrams. sqlite-vec computes every row's distance
    // regardless of LIMIT, so the deeper KNN is effectively free.
    let chunk_search_depth = candidate_pool * 8;
    let query_type = classify_query(effective_query);
    let temporal_intent = classify_temporal_intent(effective_query);
    let (w_sem_base, w_bm25_base, w_graph_base) = weights_for(query_type);
    // Ablation hooks zero out a signal's RRF weight so it still runs
    // (so latency comparisons are fair) but contributes nothing to the
    // fused score. Zeroing the weight is cleaner than skipping the
    // signal because it leaves the code path intact.
    let w_sem = if is_ablated(opts, "semantic") {
        0.0
    } else {
        w_sem_base
    };
    let w_bm25 = if is_ablated(opts, "bm25") {
        0.0
    } else {
        w_bm25_base
    };
    let w_graph = if is_ablated(opts, "entity_graph") {
        0.0
    } else {
        w_graph_base
    };

    // Query expansion (synonym injection) was removed 2026-04-23 as
    // net-negative in the eval matrix. The retrieval query is the
    // parsed free-text verbatim.
    let expanded = effective_query.to_string();

    // --- Signal 1: semantic KNN ---
    let query_embedding = embedder::encode_query(&expanded)?;
    let semantic_hits = knn_search(db, &query_embedding, chunk_search_depth)?;
    let mut seen_semantic = HashSet::new();
    let mut semantic_ranked: Vec<String> = Vec::new();
    for h in &semantic_hits {
        if seen_semantic.insert(h.engram_id.clone()) {
            semantic_ranked.push(h.engram_id.clone());
            if semantic_ranked.len() >= candidate_pool {
                break;
            }
        }
    }

    // --- Signal 2: BM25 on orig + expanded, merged ---
    let bm25_idx = ensure_bm25_built(db)?;
    let bm25_orig = bm25_idx.search(effective_query, chunk_search_depth);
    let bm25_exp = bm25_idx.search(&expanded, chunk_search_depth);
    let mut bm25_scores: HashMap<String, f64> = HashMap::new();
    for (cid, s) in bm25_orig {
        bm25_scores.insert(cid, s * 1.2);
    }
    for (cid, s) in bm25_exp {
        bm25_scores.entry(cid).or_insert(s);
    }
    let mut bm25_sorted: Vec<(String, f64)> = bm25_scores.into_iter().collect();
    bm25_sorted.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let chunk_ids: Vec<String> = bm25_sorted.iter().map(|(c, _)| c.clone()).collect();
    let chunk_to_engram = resolve_chunk_engrams(db, &chunk_ids)?;
    let mut seen_bm25 = HashSet::new();
    let mut bm25_ranked: Vec<String> = Vec::new();
    for cid in &chunk_ids {
        if let Some(eid) = chunk_to_engram.get(cid) {
            if seen_bm25.insert(eid.clone()) {
                bm25_ranked.push(eid.clone());
                if bm25_ranked.len() >= candidate_pool {
                    break;
                }
            }
        }
    }

    // --- Matched-chunk content map (engram_id -> best-matching chunk text) --
    // Recall fuses to engram granularity, but the *located* answer span lives
    // in the specific chunk that matched. We thread that chunk's text through
    // so candidate assembly can surface it even when it sits past the engram
    // -content head window — fixing long-turn "remind me detail X" truncation
    // (the matched chunk, not the head, is what scored). Semantic hits already
    // carry chunk content; BM25 gives chunk ids we resolve against `chunks`.
    // Ordered fill (semantic best first, then BM25 in rank order) means each
    // engram keeps its highest-ranked matching chunk.
    let mut best_chunk_text: HashMap<String, String> = HashMap::new();
    for h in &semantic_hits {
        if !h.content.trim().is_empty() {
            best_chunk_text
                .entry(h.engram_id.clone())
                .or_insert_with(|| h.content.clone());
        }
    }
    {
        let top_bm: Vec<String> = chunk_ids.iter().take(candidate_pool).cloned().collect();
        if !top_bm.is_empty() {
            let placeholders = std::iter::repeat_n("?", top_bm.len())
                .collect::<Vec<_>>()
                .join(",");
            // Resolve matched-chunk content in a tight scope so the lock /
            // statement / rows all drop before the fill loop runs.
            let id_content: HashMap<String, String> = {
                let conn = db.lock();
                let map = match conn.prepare(&format!(
                    "SELECT id, content FROM chunks WHERE id IN ({})",
                    placeholders
                )) {
                    Ok(mut stmt) => match stmt
                        .query_map(rusqlite::params_from_iter(top_bm.iter()), |r| {
                            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                        }) {
                        Ok(rows) => rows.flatten().collect(),
                        Err(_) => HashMap::new(),
                    },
                    Err(_) => HashMap::new(),
                };
                map
            };
            for cid in &top_bm {
                if let (Some(eid), Some(ct)) = (chunk_to_engram.get(cid), id_content.get(cid)) {
                    if !ct.trim().is_empty() {
                        best_chunk_text
                            .entry(eid.clone())
                            .or_insert_with(|| ct.clone());
                    }
                }
            }
        }
    }

    // --- Signal 3: graph traverse ---
    let graph_ranked = graph_retrieve(db, query, candidate_pool)?;

    // --- Signal 4: titles ---
    // Pull (id, title, filename) for every non-dormant engram.
    // Build the vec imperatively: the block-as-expression form tripped
    // the borrow checker because the `collect::<Result<_,_>>()?`
    // temporary outlived `conn`/`stmt` at the block's closing brace.
    let mut engrams_meta: Vec<(String, String, String)> = Vec::new();
    // eid -> (title, content) for the imp#2 proper-noun/phrase boost.
    // Same single non-dormant scan we already do for title embeddings,
    // one extra column — no additional query.
    let mut engram_tc: HashMap<String, (String, String)> = HashMap::new();
    {
        let conn = db.lock();
        let mut stmt = conn.prepare(
            "SELECT id, title, COALESCE(filename, ''), COALESCE(content, '') \
             FROM engrams WHERE state != 'dormant' AND superseded_by IS NULL",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?;
        for row in rows {
            let (id, title, filename, content) = row?;
            engram_tc.insert(id.clone(), (title.clone(), content));
            engrams_meta.push((id, title, filename));
        }
    }

    let mut semantic_title_scores: HashMap<String, f64> = HashMap::new();
    let mut keyword_title_scores: HashMap<String, f64> = HashMap::new();
    let query_token_set: HashSet<String> = bm25_tokenize(effective_query).into_iter().collect();
    let query_token_count = query_token_set.len().max(1) as f64;

    if !engrams_meta.is_empty() {
        // (b) Bidirectional keyword coverage against (title ∪ slug). Pure
        // token overlap — NO model inference — so it stays whole-vault:
        // find-by-title keeps working for every engram at negligible cost.
        for (eid, title, filename) in engrams_meta.iter() {
            let slug = filename.replace(".md", "").replace(['-', '_'], " ");
            let mut title_tokens: HashSet<String> = HashSet::new();
            for src in [title.as_str(), slug.as_str()] {
                for tok in bm25_tokenize(src) {
                    if tok.chars().count() > 1 {
                        title_tokens.insert(tok);
                    }
                }
            }
            if !query_token_set.is_empty() && !title_tokens.is_empty() {
                let overlap: HashSet<&String> =
                    query_token_set.intersection(&title_tokens).collect();
                if !overlap.is_empty() {
                    let c_query = overlap.len() as f64 / query_token_count;
                    let c_title = overlap.len() as f64 / title_tokens.len().max(1) as f64;
                    let coverage = c_query.max(c_title);
                    if coverage >= 0.4 {
                        keyword_title_scores.insert(eid.clone(), 0.4 + 0.6 * coverage);
                    }
                }
            }
        }

        // (a) Semantic cosine against title embedding — the EXPENSIVE leg
        // (one ONNX forward pass per title). Scope the embedding to the
        // candidate pool (union of the three primary signals) so a large
        // vault does NOT re-embed every title on every recall — the
        // per-recall O(notes) title-embedding storm that pegs the CPU on
        // big brains (titles overflow the LRU and thrash). `--ablate
        // title_pool_scope` embeds ALL titles (old behavior) for A/B.
        // Bench-neutral on LongMemEval (titles are session ids that never
        // match the query); in production this only changes the weak,
        // top-10-capped semantic-title boost for engrams ALREADY outside
        // all three primary signals. Keyword-title (above) is unscoped, so
        // exact "find by title" is unaffected.
        let scope_pool = !is_ablated(opts, "title_pool_scope");
        let pool: HashSet<&String> = if scope_pool {
            semantic_ranked
                .iter()
                .chain(bm25_ranked.iter())
                .chain(graph_ranked.iter())
                .collect()
        } else {
            engrams_meta.iter().map(|(e, _, _)| e).collect()
        };
        let scored: Vec<(&String, &String)> = engrams_meta
            .iter()
            .filter(|(e, _, _)| pool.contains(e))
            .map(|(e, t, _)| (e, t))
            .collect();
        let titles: Vec<String> = scored.iter().map(|(_, t)| (*t).clone()).collect();
        let t_embeddings = title_embeddings(&titles)?;
        let mut q_norm = query_embedding.clone();
        if normalize_inplace(&mut q_norm) {
            for (j, (eid, _)) in scored.iter().enumerate() {
                if j < t_embeddings.len() && t_embeddings[j].len() == EMBEDDING_DIM {
                    let mut t_emb = t_embeddings[j].clone();
                    if normalize_inplace(&mut t_emb) {
                        let sim = cosine(&q_norm, &t_emb) as f64;
                        if sim > 0.45 {
                            semantic_title_scores.insert((*eid).clone(), sim);
                        }
                    }
                }
            }
        }
    }

    // --- RRF fusion ---
    let mut rrf_scores: HashMap<String, f64> = HashMap::new();
    for (rank, eid) in semantic_ranked.iter().enumerate() {
        *rrf_scores.entry(eid.clone()).or_insert(0.0) += w_sem * rrf_score(rank + 1);
    }
    for (rank, eid) in bm25_ranked.iter().enumerate() {
        *rrf_scores.entry(eid.clone()).or_insert(0.0) += w_bm25 * rrf_score(rank + 1);
    }
    for (rank, eid) in graph_ranked.iter().enumerate() {
        *rrf_scores.entry(eid.clone()).or_insert(0.0) += w_graph * rrf_score(rank + 1);
    }

    // RRF top-rank bonus removed 2026-05-09 after empirical regression:
    // v5 50-Q sample showed the +0.005/+0.002 nudges promoted wrong-but-
    // confident hits often enough to net -16pp vs v1's pure RRF baseline.
    // Theory was that consensus across signals would help; in practice on
    // small per-question haystacks, the bonus over-amplified single-signal
    // confidence on lexically-similar but semantically-wrong matches. We
    // keep the cross-query merge that is itself a form of consensus
    // reranking via multi-query escalation, which is a cleaner signal.

    // Title boost: keyword (uncapped) + semantic-cosine (top-10 capped).
    if !is_ablated(opts, "title_keyword") {
        for (eid, k) in &keyword_title_scores {
            *rrf_scores.entry(eid.clone()).or_insert(0.0) += k * 0.30;
        }
    }
    if !is_ablated(opts, "title_semantic") {
        let mut sem_top: Vec<(&String, &f64)> = semantic_title_scores.iter().collect();
        sem_top.sort_by(|a, b| b.1.partial_cmp(a.1).unwrap_or(std::cmp::Ordering::Equal));
        for (eid, s) in sem_top.into_iter().take(10) {
            *rrf_scores.entry(eid.clone()).or_insert(0.0) += s * 0.15;
        }
    }

    // Improvement #2/#3 — high-precision exact-match boost for the token
    // classes BGE-small structurally under-represents: proper nouns,
    // quoted phrases (imp#2), and numerics/quantities (imp#3). An exact
    // entity/phrase/number match is the strongest precision signal a
    // user can give, but the keyword-title path weights "sarah" ==
    // "meeting" == "2023". Sits *alongside* (not above) the k*0.30
    // keyword-title boost: quoted-phrase hit +0.20, proper-noun coverage
    // +0.15*(matched/total), numeric coverage +0.15*(matched/total).
    // Title+content (not title-only): a buried "Sarah"/"2023" in a long
    // note is exactly the case the generic title path misses. Operates
    // only on RRF candidates. imp#3 shares imp#2's ablate flag and loop
    // — it is the same mechanism (one more embedder-weak precision
    // class), one reviewable diff, one switch.
    if !is_ablated(opts, "proper_noun_boost") {
        let (proper_nouns, quoted, numerics) = extract_salient(query);
        if !proper_nouns.is_empty() || !quoted.is_empty() || !numerics.is_empty() {
            let total_pn = proper_nouns.len().max(1) as f64;
            let total_num = numerics.len().max(1) as f64;
            for (eid, score) in rrf_scores.iter_mut() {
                let Some((title, content)) = engram_tc.get(eid) else {
                    continue;
                };
                let hay = format!("{title}\n{content}").to_lowercase();
                if !quoted.is_empty() && quoted.iter().any(|p| hay.contains(p.as_str())) {
                    *score += 0.20;
                }
                if !proper_nouns.is_empty() || !numerics.is_empty() {
                    let words: HashSet<&str> = hay
                        .split(|c: char| !c.is_alphanumeric())
                        .filter(|w| !w.is_empty())
                        .collect();
                    if !proper_nouns.is_empty() {
                        let matched = proper_nouns
                            .iter()
                            .filter(|pn| words.contains(pn.as_str()))
                            .count() as f64;
                        if matched > 0.0 {
                            *score += 0.15 * (matched / total_pn);
                        }
                    }
                    if !numerics.is_empty() {
                        let matched = numerics
                            .iter()
                            .filter(|n| words.contains(n.as_str()))
                            .count() as f64;
                        if matched > 0.0 {
                            *score += 0.15 * (matched / total_num);
                        }
                    }
                }
            }
        }
    }

    // Improvement #4 + structured-fact lookup ("what's my X / who owns Y").
    // GENERALISED 2026-05-21 (Option D / Layer 2): the fact boost now
    // fires for ANY query whose tokens fully cover a recorded fact's
    // subject — not only "current/latest" queries. Rationale (diagnosed
    // from the fast-eval): embedder near-ties (BGE-small) can't separate
    // a topical distractor from the answer note in vector space; a
    // structured fact ("retrieval pipeline / owner / Sarah") boosted by
    // EXACT subject-token match sidesteps the embedder entirely for
    // fact-shaped questions. The all-subject-tokens-in-query gate keeps
    // false fires rare. We always BOOST the current fact's source; we
    // only DEMOTE a superseded value's source when the query also
    // carries a currency marker (asking for the *latest*) — never bury
    // the sole answer otherwise (the −16pp demotion failure mode).
    // Facts are populated by regex (facts.rs) today and, under Option D,
    // by the connected agent via record_fact. Gated by fact_supersession
    // ablate flag; verified on the fast-eval.
    if !is_ablated(opts, "fact_supersession") {
        let currency_intent = FACT_CURRENCY_RE.is_match(query);
        let qtokens: HashSet<String> = bm25_tokenize(query).into_iter().collect();
        if !qtokens.is_empty() {
            // Pull subject + attribute + value so we can disambiguate
            // WHICH fact about a subject answers the query — not just
            // boost every fact that shares the subject (the over-fire that
            // let a "pipeline / signals" fact win a "who owns pipeline"
            // query, demonstrated in the agent-loop test 2026-05-21).
            struct FactRow {
                subject: String,
                attribute: String,
                value: String,
                src: String,
                current: bool,
            }
            let mut rows: Vec<FactRow> = Vec::new();
            {
                let conn = db.lock();
                let prepared = conn.prepare(
                    "SELECT subject, attribute, value, source_engram, superseded_by FROM facts",
                );
                if let Ok(mut stmt) = prepared {
                    if let Ok(mapped) = stmt.query_map([], |r| {
                        Ok(FactRow {
                            subject: r.get::<_, String>(0)?,
                            attribute: r.get::<_, String>(1)?,
                            value: r.get::<_, String>(2)?,
                            src: r.get::<_, String>(3)?,
                            current: r.get::<_, Option<String>>(4)?.is_none(),
                        })
                    }) {
                        for row in mapped.flatten() {
                            rows.push(row);
                        }
                    }
                }
            }
            let qstems: HashSet<String> = qtokens.iter().map(|t| light_stem(t)).collect();
            // (subject, src, attribute/value relevance) for matched current facts.
            let mut matched: Vec<(String, String, usize)> = Vec::new();
            let mut have_current_subject: HashSet<String> = HashSet::new();
            let mut matched_superseded: Vec<(String, String)> = Vec::new();
            for f in &rows {
                let stoks = bm25_tokenize(&f.subject);
                if stoks.is_empty() || !stoks.iter().all(|t| qtokens.contains(t)) {
                    continue;
                }
                if !f.current {
                    matched_superseded.push((f.subject.clone(), f.src.clone()));
                    continue;
                }
                have_current_subject.insert(f.subject.clone());
                // Relevance = query stems (excluding the subject's own
                // stems) that appear in this fact's attribute or value.
                // This is what makes "who OWNS x" prefer the owner fact
                // over a co-subject "signals" fact (owns~owner via
                // light_stem). 0 = subject-only match.
                let subj_stems: HashSet<String> = stoks.iter().map(|t| light_stem(t)).collect();
                let mut av_stems: HashSet<String> = HashSet::new();
                for tok in bm25_tokenize(&f.attribute)
                    .into_iter()
                    .chain(bm25_tokenize(&f.value))
                {
                    av_stems.insert(light_stem(&tok));
                }
                let relevance = qstems
                    .iter()
                    .filter(|s| !subj_stems.contains(*s) && av_stems.contains(*s))
                    .count();
                matched.push((f.subject.clone(), f.src.clone(), relevance));
            }
            // Per subject, boost the MOST query-relevant fact's source.
            // Single fact for a subject → boost unconditionally
            // (unambiguous). Multiple facts → boost only the top-relevance
            // one(s); if none has any attribute/value relevance the query
            // can't pick, so boost NONE — a missed boost beats a confident
            // wrong one.
            let mut counts: HashMap<&str, usize> = HashMap::new();
            let mut maxrel: HashMap<&str, usize> = HashMap::new();
            for (subj, _src, rel) in &matched {
                *counts.entry(subj.as_str()).or_insert(0) += 1;
                let e = maxrel.entry(subj.as_str()).or_insert(0);
                if *rel > *e {
                    *e = *rel;
                }
            }
            for (subj, src, rel) in &matched {
                let n = counts[subj.as_str()];
                let mr = maxrel[subj.as_str()];
                if n == 1 || (mr > 0 && *rel == mr) {
                    *rrf_scores.entry(src.clone()).or_insert(0.0) += 0.25;
                }
            }
            // Only actively demote a stale value's source when the query
            // signals it wants the LATEST; otherwise boosting the current
            // value is enough (don't bury a still-useful note).
            if currency_intent {
                for (subject, src) in &matched_superseded {
                    if have_current_subject.contains(subject) {
                        if let Some(s) = rrf_scores.get_mut(src) {
                            *s -= 0.15;
                        }
                    }
                }
            } else {
                let _ = &matched_superseded;
            }
        }
    }

    // PageRank importance boost — only when the frontend has pushed
    // scores for this brain (= Analytics mode is on). Multiplier
    // formula `1 + 0.15 * ln(1 + pr)` keeps the boost gentle: PR=1
    // (mean) → 1.10×; PR=3 → 1.21×; PR=10 → 1.36×. Caps the long tail
    // so a single super-hub doesn't dominate every recall result.
    // Skipped when ablated for clean A/B vs no-boost baseline.
    if !is_ablated(opts, "pagerank") && pagerank_state::has_scores(db.brain_id()) {
        let brain_id = db.brain_id();
        for (eid, score) in rrf_scores.iter_mut() {
            if let Some(pr) = pagerank_state::get(brain_id, eid) {
                let boost = 1.0 + 0.15 * (1.0_f64 + pr.max(0.0)).ln();
                *score *= boost;
            }
        }
    }

    // Sort by RRF and take candidate_pool for scoring.
    let mut sorted_candidates: Vec<(String, f64)> = rrf_scores.into_iter().collect();
    // Deterministic tie-break by engram id (a.0) — see the final-score sort
    // below: HashMap iteration order must not decide which tied engrams make
    // the candidate-pool cut, or results aren't reproducible run-to-run.
    sorted_candidates.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });

    // Build candidates — resolve each engram id to its row, filtering
    // dormant/excluded/after-as_of rows as we go. `filename` +
    // `agent_id` are fetched on the same row so the Tier-A operator
    // filters (folder:, agent:) can be tested without a follow-up
    // query.
    let mut candidates: Vec<Candidate> =
        Vec::with_capacity(candidate_pool.min(sorted_candidates.len()));
    for (eid, rrf) in sorted_candidates.into_iter().take(candidate_pool) {
        let conn = db.lock();
        let row: Option<EngramRow> = conn
            .query_row(
                "SELECT id, title, content, strength, state,
                        COALESCE(updated_at, ''), COALESCE(created_at, ''),
                        COALESCE(kind, 'note'), COALESCE(filename, ''),
                        COALESCE(agent_id, '')
                 FROM engrams WHERE id = ?1",
                [&eid],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, f64>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, String>(5)?,
                        r.get::<_, String>(6)?,
                        r.get::<_, String>(7)?,
                        r.get::<_, String>(8)?,
                        r.get::<_, String>(9)?,
                    ))
                },
            )
            .ok();
        drop(conn);
        let Some((
            id,
            title,
            content,
            strength,
            state,
            updated_at,
            created_at,
            kind,
            filename,
            agent_id,
        )) = row
        else {
            continue;
        };
        if state == "dormant" {
            continue;
        }
        if exclude_set.contains(&kind) {
            continue;
        }
        if let Some(ref cutoff) = opts.as_of {
            if !created_at.is_empty() && created_at.as_str() > cutoff.as_str() {
                continue;
            }
        }
        if !filters.is_empty()
            && !passes_filters(
                &filters,
                &kind,
                &state,
                &filename,
                &created_at,
                &agent_id,
                &id,
                entity_allow.as_ref(),
            )
        {
            continue;
        }
        // Return content that includes the *matched* region, not just the
        // engram head. If the best-matching chunk's opening isn't already
        // within the head window, append it so a detail buried past the head
        // (e.g. "the 27th parameter", "the third objective") is present.
        // Bounded so recall payload stays reasonable.
        let head: String = content.chars().take(1200).collect();
        let trimmed: String = match best_chunk_text.get(&id) {
            Some(ch) if !ch.trim().is_empty() && !is_ablated(opts, "chunk_window") => {
                let probe: String = ch.trim().chars().take(40).collect();
                if head.contains(&probe) {
                    head
                } else {
                    let mut s = head;
                    s.push_str("\n…\n");
                    s.push_str(ch.trim());
                    s.chars().take(3200).collect()
                }
            }
            _ => head,
        };
        candidates.push(Candidate {
            engram_id: id,
            title,
            content: trimmed,
            strength,
            state,
            updated_at,
            created_at,
            kind,
            rrf_score: rrf,
            via_spread: false,
            rerank_score: rrf,
            recency_factor: 1.0,
            decision_bonus: 0.0,
            final_score: 0.0,
        });
    }

    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    // --- Spreading activation (opt-in) ---
    if opts.spread_hops >= 1 {
        let _ = spread_neighbors(
            db,
            &mut candidates,
            SpreadOpts::default(),
            opts.as_of.as_deref(),
            &exclude_set,
        );
    }

    // --- Temporal / supersede adjustments ---
    // Ablated recency → factor stays 1.0 for every candidate (no tilt).
    let recency_off = is_ablated(opts, "recency");
    let supersede_off = is_ablated(opts, "supersede");
    let decision_off = is_ablated(opts, "decision");

    if !recency_off {
        let (newest_f, oldest_f) = recency_params(temporal_intent);
        let lambda = recency_lambda(temporal_intent);

        // Rank-relative recency spread — order candidates by updated_at DESC.
        let mut by_recency: Vec<usize> = (0..candidates.len()).collect();
        by_recency.sort_by(|a, b| candidates[*b].updated_at.cmp(&candidates[*a].updated_at));
        let n = by_recency.len();
        for (i, idx) in by_recency.iter().enumerate() {
            let linear = if n <= 1 {
                newest_f
            } else {
                let t = i as f64 / (n - 1) as f64;
                newest_f + t * (oldest_f - newest_f)
            };
            let age_factor = if lambda > 0.0 {
                let days = age_days(&candidates[*idx].updated_at);
                (-lambda * days).exp()
            } else {
                1.0
            };
            candidates[*idx].recency_factor = linear * age_factor;
        }
    }

    // Supersede fraction from temporal_facts. Cheap GROUP BY query.
    // We still compute it so `historical` intent logic can use the
    // set — the actual penalty application is gated below.
    let eids: Vec<String> = candidates.iter().map(|c| c.engram_id.clone()).collect();
    let superseded_fraction = if supersede_off {
        HashMap::new()
    } else {
        compute_superseded_fraction(db, &eids, opts.as_of.as_deref())?
    };
    let superseded_set: HashSet<String> = superseded_fraction.keys().cloned().collect();

    // Decision / negation bonus was REMOVED in 2026-04-23. The eval
    // matrix showed it was net-negative: +3.3 points hit@1 when
    // disabled. Hand-tuned magic constants (+0.08 for titles with
    // "decided:" / "update:", +0.05 for content with "not using" /
    // "deprecated") were promoting wrong answers as often as right
    // ones. Removing also simplifies the hot loop below.
    //
    // The `decision` ablate flag still parses (no-op now); kept for
    // future re-experimentation if a richer test set shows we were
    // wrong.
    let _ = decision_off; // silences unused-variable warning

    for c in candidates.iter_mut() {
        c.decision_bonus = 0.0;

        if temporal_intent == "historical" && !recency_off {
            if superseded_set.contains(&c.engram_id) {
                c.recency_factor = (c.recency_factor * 1.5).min(1.0);
            }
            continue;
        }

        let frac = superseded_fraction
            .get(&c.engram_id)
            .copied()
            .unwrap_or(0.0);
        if frac > 0.0 {
            c.recency_factor *= 1.0 - 0.5 * frac;
        }
    }

    // --- Optional cross-encoder rerank (Tier-C addition) ---
    // Runs AFTER candidate materialisation so the reranker only
    // sees the top ~candidate_pool candidates (40 for top_k=10),
    // not every non-dormant engram in the vault. The cross-encoder
    // is CPU-bound at ~5ms per pair so 40 pairs is ~200ms worst
    // case; we cap at 20 below to stay interactive.
    //
    // Score fusion: the reranker outputs logits, roughly in [-10, 10].
    // Rather than blend the sigmoid into rerank_score (which let the
    // [0,1] CE term swamp the ~[0.01,0.4] hybrid score and eject golds),
    // we RANK-fuse the cross-encoder against the hybrid ordering on a
    // commensurable reciprocal-rank scale — see fuse_cross_encoder.
    // Conditional reranking (2026-05-21). The cross-encoder helps focused
    // keyword lookups (picking the best of many lexically-similar
    // candidates) but HURTS natural-language / conversational recall: it
    // scores query↔doc *surface* similarity, so on a chat haystack it
    // promotes the turns that mirror the query's phrasing — typically the
    // user's OWN past questions — over the answer-bearing turns. Proven on
    // LongMemEval qid 0a34ad58 (Tokyo): rerank=true pushed the user's
    // question turns to the top and buried the assistant's tips, costing
    // −15pp on single-session-preference. v1 never ran the reranker at all
    // (sentence-transformers wasn't bundled → silent RRF fallback) and
    // scored higher there.
    //
    // So: run the reranker only for `keyword`-shaped queries (short,
    // no question word — the disambiguation case). Everything else falls
    // back to RRF, which equals v1's effective behaviour. `use_reranker`
    // (explicit caller opt-in) still forces it on for any shape.
    // HEURISTIC pending per-category bench tuning on a bench-capable
    // machine; fails safe toward no-rerank per adaptive-retrieval
    // guidance (Adaptive-RAG 2403.14403, DAT 2503.23013).
    let rerank_by_shape = classify_query(effective_query) == "keyword";
    let do_rerank = (opts.use_reranker || rerank_by_shape) && !is_ablated(opts, "reranker");
    if do_rerank && candidates.len() > 1 {
        let limit = candidates.len().min(20);
        let docs: Vec<String> = candidates
            .iter()
            .take(limit)
            .map(|c| {
                // Feed the reranker the title + the MATCHED chunk, not the
                // content head. The matched chunk is the passage that
                // actually scored; for facts dropped as asides mid-session
                // the head never contains them, so a head-window doc leaves
                // the cross-encoder scoring blind (LongMemEval miss
                // forensics 2026-07-02: 13/24 hit@5 misses were
                // single-session-user asides buried past the head, invisible
                // to the CE while distractor sessions led with the topic).
                // Old head-400 behavior kept behind the
                // `rerank_matched_chunk` ablation for paired A/B.
                let body: String = if !is_ablated(opts, "rerank_matched_chunk") {
                    match best_chunk_text.get(&c.engram_id) {
                        Some(ch) if !ch.trim().is_empty() => ch.trim().chars().take(400).collect(),
                        _ => c.content.chars().take(400).collect(),
                    }
                } else {
                    c.content.chars().take(400).collect()
                };
                format!("{}\n{}", c.title, body)
            })
            .collect();
        match reranker::rerank(effective_query, &docs) {
            Ok(scores) => {
                // Rank-fuse the cross-encoder with the hybrid ordering
                // (see fuse_cross_encoder) instead of a magnitude blend.
                let mags: Vec<f64> = candidates
                    .iter()
                    .take(scores.len())
                    .map(|c| c.rerank_score)
                    .collect();
                let fused = fuse_cross_encoder(&mags, &scores, RERANK_HYBRID_W, RERANK_CE_W);
                for (i, s) in fused.into_iter().enumerate() {
                    candidates[i].rerank_score = s;
                }
            }
            Err(e) => {
                eprintln!("[retriever] rerank skipped: {} — falling back to RRF", e);
            }
        }
    }

    // --- Final score ---
    const INSIGHT_BOOST: f64 = 0.06;
    let insight_off = is_ablated(opts, "insight_boost");
    for c in candidates.iter_mut() {
        let base = c.rerank_score * 0.75 + c.strength * 0.15;
        let kind_bonus = if !insight_off && c.kind == "insight" {
            INSIGHT_BOOST
        } else {
            0.0
        };
        c.final_score = round4(base * c.recency_factor + c.decision_bonus + kind_bonus);
    }

    // --- Temporal disambiguation (knowledge-update fix) ---
    //
    // Failure mode this fixes: when the user updates a fact over time
    // ("my best 5K was 27:12" → later → "I improved to 25:50"),
    // semantic similarity ranks both highly. The OLDER mention
    // (especially when paired with a celebratory assistant turn) often
    // outranks the newer one because keyword density is stronger on
    // the original statement. The agent then takes the highest-ranked
    // hit as authoritative and reports the OBSOLETE fact.
    //
    // Fix: walk the top candidates, find pairs whose titles share
    // significant token overlap (>= 35% Jaccard), and if one is
    // materially newer than the other (created_at differs by ≥ 1 day),
    // penalize the older one's final_score by 0.05. Net effect: in
    // close races, the newer fact wins. We don't penalize when the
    // dates are within a day (likely the same conversation thread)
    // and we cap the penalty so a strong-enough older match still
    // shows up in top-K.
    if !is_ablated(opts, "temporal_disambig") {
        apply_temporal_disambiguation(&mut candidates);
    }

    candidates.sort_by(|a, b| {
        b.final_score
            .partial_cmp(&a.final_score)
            .unwrap_or(std::cmp::Ordering::Equal)
            // Deterministic tie-break by engram_id. rrf_scores is a HashMap
            // (randomized iteration order per instance), so without this,
            // tied final_scores ranked differently on every recall —
            // non-reproducible results and a hit@1 noise floor that
            // confounds same-brain A/B isolation.
            .then_with(|| a.engram_id.cmp(&b.engram_id))
    });

    // imp#5 — MMR diversification (post-scoring reorder, ablate flag
    // `mmr`). Greedy relevance-vs-redundancy reorder of the top tier so
    // a single verbose session can't monopolise top-K (the documented
    // multi-session weakness). λ=0.7 is
    // relevance-leaning: the best hit stays #1; only the 2..K slots are
    // diversified. Zero extra embed cost — reuses title embeddings.
    if !is_ablated(opts, "mmr") {
        // MMR redundancy = title-embedding cosine, computed HERE over the
        // CANDIDATE set (≤candidate_pool, cheap + LRU-cached) rather than
        // piggybacking on the semantic-title boost pass. Decoupling makes
        // the diversification identical regardless of `title_pool_scope`,
        // so the scope flag only ever changes the production semantic-title
        // BOOST — never MMR, and provably nothing on the LongMemEval bench
        // (where title boosts are already ablated). A candidate whose title
        // fails to embed is simply absent → MMR treats it as maximally
        // novel (apply_mmr's documented, conservative fallback).
        let cand_titles: Vec<String> = candidates.iter().map(|c| c.title.clone()).collect();
        let mut title_emb_norm: HashMap<String, Vec<f32>> = HashMap::new();
        if let Ok(embs) = title_embeddings(&cand_titles) {
            for (c, mut e) in candidates.iter().zip(embs) {
                if e.len() == EMBEDDING_DIM && normalize_inplace(&mut e) {
                    title_emb_norm.insert(c.engram_id.clone(), e);
                }
            }
        }
        apply_mmr(&mut candidates, &title_emb_norm, opts.top_k);
    }

    let mut results: Vec<RecallHit> = Vec::with_capacity(opts.top_k);
    for c in candidates.into_iter().take(opts.top_k) {
        let confidence = engram_confidence(db, &c.engram_id, &c.kind);
        bump_access(db, &c.engram_id).ok();
        results.push(RecallHit {
            engram_id: c.engram_id,
            title: c.title,
            content: c.content,
            score: c.final_score,
            strength: c.strength,
            state: c.state,
            confidence,
        });
    }
    Ok(results)
}

/// Temporal disambiguation: penalize older candidates when a newer
/// near-duplicate exists in the same result set.
///
/// "Near-duplicate" = title-token Jaccard >= 0.35. "Materially newer"
/// = created_at difference >= 1 day. Penalty = 0.05 on final_score
/// for the older one. Idempotent against itself (penalty applied
/// once per candidate even if multiple newer near-dupes exist —
/// we cap at one penalty hit per candidate so we don't bury a
/// candidate that's near-dupe of three newer engrams into oblivion).
///
/// O(n²) over the candidate list; with top-k pools of 30-60, that's
/// ~1000 token-set comparisons — sub-millisecond.
/// imp#5 — Maximal Marginal Relevance reorder of the (already
/// final-score-sorted) candidate list, in place.
///
/// Greedy: seed with the top-final-score candidate, then repeatedly
/// pick `argmax [ λ·rel − (1−λ)·max_{s∈selected} cos(title_emb) ]`
/// until `keep` are chosen; the unselected tail keeps its
/// final-score order so positions beyond top_k stay well-defined.
///
/// λ=0.7 is relevance-leaning by design: diversity cannot dethrone a
/// clearly-best answer (the only real risk of MMR, and exactly what
/// the regression-guard bench checks). `rel` is min-max-normalised
/// final_score so it is commensurate with cosine ∈ [−1,1]. Redundancy
/// uses the title embeddings already computed for the semantic-title
/// boost — no extra embed calls. A candidate without a title embedding
/// is treated as maximally non-redundant (sim 0): conservative, it can
/// only avoid a demotion, never cause a wrong one.
///
/// O(keep·n) cosine ops over EMBEDDING_DIM; with pools of 30-60 and
/// keep≤10 that is a few hundred dot products — sub-millisecond.
fn apply_mmr(candidates: &mut Vec<Candidate>, title_emb: &HashMap<String, Vec<f32>>, keep: usize) {
    let n = candidates.len();
    if n <= 1 || keep == 0 {
        return;
    }
    const LAMBDA: f64 = 0.7;

    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    for c in candidates.iter() {
        lo = lo.min(c.final_score);
        hi = hi.max(c.final_score);
    }
    let span = (hi - lo).max(1e-9);
    let rel: Vec<f64> = candidates
        .iter()
        .map(|c| (c.final_score - lo) / span)
        .collect();
    let emb: Vec<Option<&Vec<f32>>> = candidates
        .iter()
        .map(|c| title_emb.get(&c.engram_id))
        .collect();

    let limit = keep.min(n);
    let mut chosen = vec![false; n];
    let mut order: Vec<usize> = Vec::with_capacity(n);
    // List is already sorted by final_score DESC → index 0 is the best
    // hit; seeding with it guarantees the top result is never demoted.
    order.push(0);
    chosen[0] = true;
    while order.len() < limit {
        let mut best_i: Option<usize> = None;
        let mut best_mmr = f64::NEG_INFINITY;
        for i in 0..n {
            if chosen[i] {
                continue;
            }
            let mut max_sim = 0.0_f64;
            if let Some(ei) = emb[i] {
                for &s in &order {
                    if let Some(es) = emb[s] {
                        let sim = cosine(ei, es) as f64;
                        if sim > max_sim {
                            max_sim = sim;
                        }
                    }
                }
            }
            let score = LAMBDA * rel[i] - (1.0 - LAMBDA) * max_sim;
            if score > best_mmr {
                best_mmr = score;
                best_i = Some(i);
            }
        }
        match best_i {
            Some(i) => {
                chosen[i] = true;
                order.push(i);
            }
            None => break,
        }
    }
    // Unselected tail keeps original (final-score) order.
    for (i, &is_chosen) in chosen.iter().enumerate() {
        if !is_chosen {
            order.push(i);
        }
    }

    // Apply the permutation without requiring Candidate: Clone.
    let taken = std::mem::take(candidates);
    let mut slots: Vec<Option<Candidate>> = taken.into_iter().map(Some).collect();
    candidates.reserve(n);
    for idx in order {
        if let Some(c) = slots[idx].take() {
            candidates.push(c);
        }
    }
}

fn apply_temporal_disambiguation(candidates: &mut [Candidate]) {
    // Reverted to v1's tuning (0.05 / 0.35) on 2026-05-09. The v4 attempt
    // at 0.10 / 0.30 produced false-positive demotions on the bench:
    // unrelated dated entries with modest title overlap (e.g. two
    // different events that both began with "Workshop on …") triggered
    // the penalty, pushing the older relevant fact below top-k. Net
    // result was -16pp vs v1 on a 50-Q sample. Original 0.05 / 0.35
    // remains the right balance: aggressive enough to break ties on
    // genuine fact updates, conservative enough to leave independent
    // dated entries alone.
    const PENALTY: f64 = 0.05;
    const JACCARD_THRESHOLD: f64 = 0.35;
    // Pre-tokenize titles once (lowercase + alphanumeric word split).
    let token_sets: Vec<std::collections::HashSet<String>> =
        candidates.iter().map(|c| title_tokens(&c.title)).collect();

    let n = candidates.len();
    let mut penalties = vec![0.0_f64; n];
    for i in 0..n {
        if token_sets[i].is_empty() {
            continue;
        }
        let i_date = &candidates[i].created_at;
        if i_date.is_empty() {
            continue;
        }
        for j in 0..n {
            if i == j {
                continue;
            }
            if token_sets[j].is_empty() {
                continue;
            }
            let j_date = &candidates[j].created_at;
            if j_date.is_empty() {
                continue;
            }
            // Only penalize if j is materially newer than i (i is older).
            if !is_materially_newer(j_date, i_date) {
                continue;
            }
            let jaccard = jaccard_similarity(&token_sets[i], &token_sets[j]);
            if jaccard >= JACCARD_THRESHOLD {
                penalties[i] = PENALTY;
                break; // cap at one penalty per candidate
            }
        }
    }
    for (i, p) in penalties.iter().enumerate() {
        if *p > 0.0 {
            candidates[i].final_score = round4(candidates[i].final_score - p);
        }
    }
}

fn title_tokens(title: &str) -> std::collections::HashSet<String> {
    let mut out: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut buf = String::new();
    for ch in title.chars() {
        if ch.is_alphanumeric() {
            buf.push(ch.to_ascii_lowercase());
        } else if !buf.is_empty() {
            // Skip very short / very common stop-tokens.
            if buf.len() >= 3 && !STOP_TOKENS.contains(&buf.as_str()) {
                out.insert(buf.clone());
            }
            buf.clear();
        }
    }
    if !buf.is_empty() && buf.len() >= 3 && !STOP_TOKENS.contains(&buf.as_str()) {
        out.insert(buf);
    }
    out
}

const STOP_TOKENS: &[&str] = &[
    "the",
    "and",
    "for",
    "you",
    "your",
    "with",
    "that",
    "this",
    "from",
    "are",
    "was",
    "were",
    "have",
    "has",
    "had",
    "will",
    "would",
    "could",
    "what",
    "when",
    "where",
    "which",
    "who",
    "how",
    "why",
    "but",
    "not",
    "all",
    "any",
    "some",
    "more",
    "less",
    "than",
    "into",
    "out",
    "about",
    "session",
    "turn",
    "user",
    "assistant",
];

fn jaccard_similarity(
    a: &std::collections::HashSet<String>,
    b: &std::collections::HashSet<String>,
) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let inter = a.intersection(b).count() as f64;
    let union = a.union(b).count() as f64;
    if union == 0.0 {
        0.0
    } else {
        inter / union
    }
}

/// Is `b` materially newer than `a`? "Materially" = >= 1 calendar day,
/// detected by comparing the date prefix of each timestamp string.
/// We accept any timestamp format whose lexicographic ordering matches
/// chronological ordering at day-granularity (ISO-8601 like
/// "2023-05-25...", "2023/05/25 ...", "2026-04-01T00:00:00Z").
fn is_materially_newer(b: &str, a: &str) -> bool {
    // Pull the first 10 chars (yyyy-mm-dd or yyyy/mm/dd). String
    // comparison at that prefix is correct chronological ordering for
    // both formats.
    if a.len() < 10 || b.len() < 10 {
        return false;
    }
    let a_day = &a[..10];
    let b_day = &b[..10];
    b_day > a_day
}

/// Throttle-aware wrapper around `hybrid_retrieve`. Adopted from the
/// `mksglu/context-mode` MCP-server pattern: a 60-second rolling
/// counter degrades the response (not rejects it) when an agent
/// spams recall in tight loops. When rate-limited, the decision's
/// hint text rides along as a synthetic first result with
/// `engram_id = THROTTLE_HINT_ID`. Clients that want to hide the
/// hint from users filter on that sentinel; most agents (Claude
/// Code, MCP passthrough) surface it as-is and self-correct.
///
/// Both the Tauri `nv_recall` command and the HTTP `/api/recall`
/// handler call this instead of `hybrid_retrieve` directly — so
/// cross-transport spam (Tauri IPC + HTTP from MCP) lands on the
/// same counter and can't bypass the limiter by switching channels.
pub fn hybrid_retrieve_throttled(
    db: &BrainDb,
    query: &str,
    opts: &RecallOpts,
) -> Result<Vec<RecallHit>> {
    let decision = throttle::tick(db.brain_id(), opts.top_k);

    // Short-circuit if the caller asked for zero results — still
    // tick the counter (so repeated empty calls still count against
    // the window) but skip the actual retrieval.
    let effective_top_k = decision.max_results.min(opts.top_k);
    let effective_opts = RecallOpts {
        top_k: effective_top_k,
        ..opts.clone()
    };

    // Session cache: identical recalls inside the 60s window return
    // the cached result with zero compute. Keyed on (brain, query,
    // top_k, spread_hops, exclude_kinds, as_of) so parameter changes
    // miss the cache even for the same query text. Invalidated
    // brain-wide by any write via `recall_cache::invalidate_brain`.
    let cache_key = format!(
        "{}|k{}|s{}|x{}|a{}|r{}|ab{}",
        query,
        effective_opts.top_k,
        effective_opts.spread_hops,
        effective_opts.exclude_kinds.join(","),
        effective_opts.as_of.as_deref().unwrap_or(""),
        if effective_opts.use_reranker {
            "1"
        } else {
            "0"
        },
        {
            let mut v: Vec<String> = effective_opts
                .ablate
                .iter()
                .map(|s| s.to_lowercase())
                .collect();
            v.sort();
            v.join(",")
        },
    );
    if effective_top_k > 0 {
        if let Some(cached) = recall_cache::get(db.brain_id(), &cache_key) {
            // Still layer the throttle hint on top of cached results
            // so repeat-spammers still see the slow-down signal.
            let mut out = cached;
            if let Some(hint) = decision.hint {
                out.insert(
                    0,
                    RecallHit {
                        engram_id: THROTTLE_HINT_ID.to_string(),
                        title: "⚠️ Recall rate-limit hint".to_string(),
                        content: hint,
                        score: 0.0,
                        strength: 0.0,
                        state: "throttle_hint".to_string(),
                        confidence: 1.0,
                    },
                );
            }
            return Ok(out);
        }
    }

    let mut hits = if effective_top_k == 0 {
        Vec::new()
    } else {
        let h = hybrid_retrieve(db, query, &effective_opts)?;
        // Cache the fresh result BEFORE we layer in any hint. The
        // hint is ephemeral (throttle-window-local); the recall
        // result is what we want to reuse.
        recall_cache::put(db.brain_id(), &cache_key, h.clone());
        h
    };

    if let Some(hint) = decision.hint {
        // Prepend a synthetic hint-hit. score = 0.0, state tagged
        // so the React sidebar can visually distinguish it if it
        // wants; by default it just appears at position 0 with a
        // loud title. Keep it terse — agents read the title first.
        hits.insert(
            0,
            RecallHit {
                engram_id: THROTTLE_HINT_ID.to_string(),
                title: "⚠️ Recall rate-limit hint".to_string(),
                content: hint,
                score: 0.0,
                strength: 0.0,
                state: "throttle_hint".to_string(),
                confidence: 1.0,
            },
        );
    }

    Ok(hits)
}

fn round4(x: f64) -> f64 {
    (x * 10000.0).round() / 10000.0
}

/// Build the BM25 index for this brain if it's empty. First recall
/// after boot takes the cost; subsequent calls are free. Debounced
/// rebuilds from the write path keep it up-to-date.
fn ensure_bm25_built(db: &BrainDb) -> Result<std::sync::Arc<Bm25Index>> {
    let idx = bm25::index_for(db.brain_id());
    if idx.size() == 0 {
        idx.build(db)?;
    }
    Ok(idx)
}

fn bump_access(db: &BrainDb, engram_id: &str) -> Result<()> {
    let conn = db.lock();
    conn.execute(
        "UPDATE engrams SET access_count = access_count + 1,
                            accessed_at = datetime('now')
         WHERE id = ?1",
        [engram_id],
    )?;
    Ok(())
}

fn compute_superseded_fraction(
    db: &BrainDb,
    eids: &[String],
    as_of: Option<&str>,
) -> Result<HashMap<String, f64>> {
    if eids.is_empty() {
        return Ok(HashMap::new());
    }
    let placeholders = std::iter::repeat_n("?", eids.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = if as_of.is_some() {
        format!(
            "SELECT engram_id,
                    SUM(CASE WHEN valid_until IS NOT NULL AND valid_until <= ?
                             THEN 1 ELSE 0 END) AS not_current,
                    COUNT(*) AS total
             FROM temporal_facts
             WHERE engram_id IN ({})
             GROUP BY engram_id",
            placeholders
        )
    } else {
        format!(
            "SELECT engram_id,
                    SUM(CASE WHEN is_current = 0 THEN 1 ELSE 0 END) AS not_current,
                    COUNT(*) AS total
             FROM temporal_facts
             WHERE engram_id IN ({})
             GROUP BY engram_id",
            placeholders
        )
    };
    let conn = db.lock();
    let mut stmt = conn.prepare(&sql)?;
    let mut bind: Vec<rusqlite::types::Value> = Vec::with_capacity(eids.len() + 1);
    if let Some(cutoff) = as_of {
        bind.push(rusqlite::types::Value::Text(cutoff.to_string()));
    }
    for e in eids {
        bind.push(rusqlite::types::Value::Text(e.clone()));
    }
    let mut out: HashMap<String, f64> = HashMap::new();
    let mut rows = stmt.query(params_from_iter(bind.iter()))?;
    while let Some(row) = rows.next()? {
        let eid: String = row.get(0)?;
        let not_current: i64 = row.get(1).unwrap_or(0);
        let total: i64 = row.get(2).unwrap_or(0);
        if total > 0 && not_current > 0 {
            out.insert(eid, not_current as f64 / total as f64);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod confidence_tests {
    use super::structural_confidence;

    #[test]
    fn structural_confidence_orders_provenance() {
        // Verified-from-disk > authored notes > passive observation.
        assert_eq!(structural_confidence("source"), 1.0);
        assert!(structural_confidence("note") > structural_confidence("preference"));
        assert!(structural_confidence("preference") > structural_confidence("observation"));
        assert_eq!(structural_confidence("observation"), 0.6);
        // Unknown kind gets the conservative middle default, never >1 or <0.
        let d = structural_confidence("something-new");
        assert!((0.0..=1.0).contains(&d) && d == 0.8);
    }
}

#[cfg(test)]
mod fusion_tests {
    use super::fuse_cross_encoder;

    // Helper: is `out` a permutation of `mags` (same multiset)? The fusion
    // must never invent or drop a magnitude — only reorder. We compare
    // sorted copies because the floats are exact here (we only move them).
    fn same_multiset(a: &[f64], b: &[f64]) -> bool {
        let mut a = a.to_vec();
        let mut b = b.to_vec();
        a.sort_by(|x, y| x.partial_cmp(y).unwrap());
        b.sort_by(|x, y| x.partial_cmp(y).unwrap());
        a == b
    }

    #[test]
    fn empty_input_is_identity() {
        let out = fuse_cross_encoder(&[], &[], 0.7, 1.0);
        assert!(out.is_empty());
    }

    #[test]
    fn agreement_is_identity() {
        // CE order == hybrid order (both descending) → nothing should move.
        let mags = vec![0.5, 0.4, 0.3, 0.2, 0.1];
        let ce = vec![5.0_f32, 4.0, 3.0, 2.0, 1.0];
        let out = fuse_cross_encoder(&mags, &ce, 0.7, 1.0);
        assert_eq!(out, mags);
    }

    #[test]
    fn preserves_magnitude_multiset_and_scale() {
        // Whatever CE says, the set of scores (hence min/max → downstream
        // scale) is unchanged; only the assignment permutes.
        let mags = vec![0.40, 0.32, 0.18, 0.05];
        let ce = vec![-2.0_f32, 9.0, 1.0, 4.0]; // CE disagrees wildly
        let out = fuse_cross_encoder(&mags, &ce, 0.7, 1.0);
        assert!(same_multiset(&mags, &out));
        let max_in = mags.iter().cloned().fold(f64::MIN, f64::max);
        let min_in = mags.iter().cloned().fold(f64::MAX, f64::min);
        let max_out = out.iter().cloned().fold(f64::MIN, f64::max);
        let min_out = out.iter().cloned().fold(f64::MAX, f64::min);
        assert_eq!(max_in, max_out);
        assert_eq!(min_in, min_out);
    }

    #[test]
    fn cross_encoder_promotes_a_hybrid_low_candidate() {
        // Hybrid ranks index 4 last; CE ranks it FIRST. With CE leading,
        // index 4's fused score should outrank index 0's → it receives a
        // larger magnitude than it started with, and beats the old top.
        let mags = vec![0.50, 0.40, 0.30, 0.20, 0.10];
        let ce = vec![0.0_f32, 0.1, 0.2, 0.3, 9.0]; // index 4 is CE's best
        let out = fuse_cross_encoder(&mags, &ce, 0.7, 1.0);
        assert!(same_multiset(&mags, &out));
        assert!(
            out[4] > out[0],
            "CE's favourite (idx4) should now outrank the old hybrid top (idx0): out={out:?}"
        );
        assert!(out[4] > mags[4], "idx4 should have been promoted: {out:?}");
    }

    #[test]
    fn hybrid_prior_anchors_against_ejection() {
        // The failure the fix targets: CE buries a hybrid-strong gold.
        // Here idx0 is hybrid #1 but CE ranks it LAST. The hybrid anchor
        // (w_hybrid·rrf(1)) must keep it from collapsing to the bottom —
        // it should not receive the smallest magnitude.
        let mags = vec![0.50, 0.40, 0.30, 0.20, 0.10];
        let ce = vec![-9.0_f32, 0.3, 0.2, 0.1, 0.0]; // idx0 is CE's worst
        let out = fuse_cross_encoder(&mags, &ce, 0.7, 1.0);
        let min_out = out.iter().cloned().fold(f64::MAX, f64::min);
        assert!(
            out[0] > min_out,
            "hybrid #1 should not collapse to the lowest score: out={out:?}"
        );
    }
}
