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
//! - **Stage-4 learned affinities**: not ported in Phase 6 (the
//!   `query_affinity` table stays untouched; `affinity_bonus`
//!   always 0). Can be added later without changing the retrieval
//!   shape.
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
use super::query_parser::{self, QueryFilters};
use super::recall_cache;
use super::reranker;
use super::pagerank_state;
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
    pub affinity_bonus: f64,
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
    ///   "query_expansion"   — skip synonym expansion step
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
    opts.ablate.iter().any(|a| a.eq_ignore_ascii_case(feature))
}

/// Filter candidates in-memory after their engram row is fetched.
/// Cheap struct checks for everything except `entity:`, which uses a
/// pre-built allow-set keyed on engram id (O(1) lookup).
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
        if kind != k { return false; }
    }
    if let Some(s) = &filters.state {
        if state != s { return false; }
    }
    if let Some(f) = &filters.folder {
        let prefix = format!("{}/", f);
        if !filename.starts_with(&prefix) { return false; }
    }
    if let Some(a) = &filters.after {
        if created_at.is_empty() || created_at < a.as_str() { return false; }
    }
    if let Some(b) = &filters.before {
        if created_at.is_empty() || created_at >= b.as_str() { return false; }
    }
    if let Some(ag) = &filters.agent {
        if agent_id != ag { return false; }
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
    let head: Vec<String> = words
        .iter()
        .take(3)
        .map(|w| w.to_lowercase())
        .collect();
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
        time::macros::format_description!(
            "[year]-[month]-[day] [hour]:[minute]:[second]"
        ),
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
        for ((i, t), vec) in novel.into_iter().zip(fresh.into_iter()) {
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

static MD_PUNCT_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[#*`\[\](){}|>~_]").unwrap());
static TOKEN_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[a-z0-9]+(?:-[a-z0-9]+)*").unwrap());
static BM25_STOPWORDS: Lazy<HashSet<&'static str>> = Lazy::new(|| {
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

fn bm25_tokenize(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let cleaned = MD_PUNCT_RE.replace_all(&lower, " ");
    TOKEN_RE
        .find_iter(&cleaned)
        .map(|m| m.as_str().to_string())
        .filter(|w| !BM25_STOPWORDS.contains(w.as_str()) && w.chars().count() > 1)
        .collect()
}

// ---- DB helpers ----------------------------------------------------------

/// KNN over `vec_chunks` — returns (chunk_id, distance, content,
/// engram_id, granularity) for the top `limit` rows. Matches the
/// SQL + ordering in `database.py::knn_search`.
fn knn_search(db: &BrainDb, query_emb: &[f32], limit: usize) -> Result<Vec<KnnHit>> {
    let mut bytes = Vec::with_capacity(query_emb.len() * 4);
    for f in query_emb {
        bytes.extend_from_slice(&f.to_le_bytes());
    }
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT v.chunk_id, v.distance, c.content, c.engram_id, c.granularity
         FROM vec_chunks v
         JOIN chunks c ON c.id = v.chunk_id
         JOIN engrams e ON e.id = c.engram_id
         WHERE v.embedding MATCH ? AND k = ?
         ORDER BY v.distance ASC",
    )?;
    let rows = stmt
        .query_map(rusqlite::params![bytes, limit as i64], |r| {
            Ok(KnnHit {
                chunk_id: r.get(0)?,
                distance: r.get(1)?,
                content: r.get(2)?,
                engram_id: r.get(3)?,
                granularity: r.get(4)?,
            })
        })?
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
    let placeholders = std::iter::repeat("?")
        .take(chunk_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!("SELECT id, engram_id FROM chunks WHERE id IN ({})", placeholders);
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
             WHERE em.entity_id = ?1 AND e.state != 'dormant'",
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

/// Run `hybrid_retrieve` end-to-end. Equivalent to Python's
/// `retriever.hybrid_retrieve`, minus the cross-encoder reranker
/// branch. BM25 is ensured to be built before the first query fires.
pub fn hybrid_retrieve(
    db: &BrainDb,
    query: &str,
    opts: &RecallOpts,
) -> Result<Vec<RecallHit>> {
    let exclude_set: HashSet<String> = opts.exclude_kinds.iter().cloned().collect();
    // Pull any `kind:`, `folder:`, `after:` … operators out of the
    // query before embedding. The remaining free text is what goes
    // through the semantic + BM25 pipeline; the operators gate
    // candidates at materialisation time so we don't waste scoring
    // budget on rows that'll be filtered out anyway.
    let (filters, free_text) = query_parser::parse(query);
    let effective_query = if free_text.is_empty() { query } else { free_text.as_str() };
    // Entity filter needs a one-time lookup of "which engrams mention
    // this entity" so the per-candidate check stays O(1).
    let entity_allow = match &filters.entity {
        Some(name) => Some(build_entity_allow_set(db, name)?),
        None => None,
    };

    let candidate_pool = (opts.top_k * 4).max(10);
    let query_type = classify_query(effective_query);
    let temporal_intent = classify_temporal_intent(effective_query);
    let (w_sem_base, w_bm25_base, w_graph_base) = weights_for(query_type);
    // Ablation hooks zero out a signal's RRF weight so it still runs
    // (so latency comparisons are fair) but contributes nothing to the
    // fused score. Zeroing the weight is cleaner than skipping the
    // signal because it leaves the code path intact.
    let w_sem = if is_ablated(opts, "semantic") { 0.0 } else { w_sem_base };
    let w_bm25 = if is_ablated(opts, "bm25") { 0.0 } else { w_bm25_base };
    let w_graph = if is_ablated(opts, "entity_graph") { 0.0 } else { w_graph_base };

    // Query expansion was removed in 2026-04-23 as net-negative in
    // the eval matrix. The `query_expansion` ablate flag still
    // parses for backwards-compat but is a no-op now.
    let expanded = effective_query.to_string();

    // --- Signal 1: semantic KNN ---
    let query_embedding = embedder::encode_query(&expanded)?;
    let semantic_hits = knn_search(db, &query_embedding, candidate_pool)?;
    let mut seen_semantic = HashSet::new();
    let mut semantic_ranked: Vec<String> = Vec::new();
    for h in &semantic_hits {
        if seen_semantic.insert(h.engram_id.clone()) {
            semantic_ranked.push(h.engram_id.clone());
        }
    }

    // --- Signal 2: BM25 on orig + expanded, merged ---
    let bm25_idx = ensure_bm25_built(db)?;
    let bm25_orig = bm25_idx.search(effective_query, candidate_pool);
    let bm25_exp = bm25_idx.search(&expanded, candidate_pool);
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
    {
        let conn = db.lock();
        let mut stmt = conn.prepare(
            "SELECT id, title, COALESCE(filename, '') FROM engrams WHERE state != 'dormant'",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            engrams_meta.push(row?);
        }
    }

    let mut semantic_title_scores: HashMap<String, f64> = HashMap::new();
    let mut keyword_title_scores: HashMap<String, f64> = HashMap::new();
    let query_token_set: HashSet<String> = bm25_tokenize(effective_query).into_iter().collect();
    let query_token_count = query_token_set.len().max(1) as f64;

    if !engrams_meta.is_empty() {
        let titles: Vec<String> = engrams_meta.iter().map(|(_, t, _)| t.clone()).collect();
        let t_embeddings = title_embeddings(&titles)?;
        let mut q_norm = query_embedding.clone();
        let q_ok = normalize_inplace(&mut q_norm);

        for (i, (eid, title, filename)) in engrams_meta.iter().enumerate() {
            // (a) Semantic cosine against title embedding.
            if q_ok && i < t_embeddings.len() && t_embeddings[i].len() == EMBEDDING_DIM {
                let mut t_emb = t_embeddings[i].clone();
                if normalize_inplace(&mut t_emb) {
                    let sim = cosine(&q_norm, &t_emb) as f64;
                    if sim > 0.45 {
                        semantic_title_scores.insert(eid.clone(), sim);
                    }
                }
            }

            // (b) Bidirectional keyword coverage against (title ∪ slug).
            let slug = filename
                .replace(".md", "")
                .replace('-', " ")
                .replace('_', " ");
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
    sorted_candidates.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    // Build candidates — resolve each engram id to its row, filtering
    // dormant/excluded/after-as_of rows as we go. `filename` +
    // `agent_id` are fetched on the same row so the Tier-A operator
    // filters (folder:, agent:) can be tested without a follow-up
    // query.
    let mut candidates: Vec<Candidate> = Vec::with_capacity(candidate_pool.min(sorted_candidates.len()));
    for (eid, rrf) in sorted_candidates.into_iter().take(candidate_pool) {
        let conn = db.lock();
        let row: Option<(String, String, String, f64, String, String, String, String, String, String)> = conn
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
        let Some((id, title, content, strength, state, updated_at, created_at, kind, filename, agent_id)) = row else {
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
        let trimmed: String = content.chars().take(1000).collect();
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
            affinity_bonus: 0.0,
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

        let frac = superseded_fraction.get(&c.engram_id).copied().unwrap_or(0.0);
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
    // Score blending: the reranker outputs logits, roughly in
    // [-10, 10]. We sigmoid to [0, 1] then blend at 70/30 with the
    // existing RRF — giving the cross-encoder the majority vote
    // on the top tier while preserving the dual-encoder's broader
    // coverage. Pure 100% reranker tends to overfit on short
    // titles; 70/30 is the tuned balance per common hybrid-rerank
    // literature.
    if opts.use_reranker && candidates.len() > 1 {
        let limit = candidates.len().min(20);
        let docs: Vec<String> = candidates
            .iter()
            .take(limit)
            .map(|c| {
                // Feed the reranker the title + first ~400 chars of
                // content. Full content blows up tokenisation cost
                // without adding signal beyond the first paragraph.
                let head: String = c.content.chars().take(400).collect();
                format!("{}\n{}", c.title, head)
            })
            .collect();
        match reranker::rerank(effective_query, &docs) {
            Ok(scores) => {
                for (i, s) in scores.iter().enumerate() {
                    let sig = 1.0 / (1.0 + (-(*s as f64)).exp());
                    candidates[i].rerank_score =
                        candidates[i].rerank_score * 0.3 + sig * 0.7;
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
        let kind_bonus = if !insight_off && c.kind == "insight" { INSIGHT_BOOST } else { 0.0 };
        c.final_score = round4(
            base * c.recency_factor + c.decision_bonus + c.affinity_bonus + kind_bonus,
        );
    }

    candidates.sort_by(|a, b| {
        b.final_score
            .partial_cmp(&a.final_score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut results: Vec<RecallHit> = Vec::with_capacity(opts.top_k);
    for c in candidates.into_iter().take(opts.top_k) {
        bump_access(db, &c.engram_id).ok();
        results.push(RecallHit {
            engram_id: c.engram_id,
            title: c.title,
            content: c.content,
            score: c.final_score,
            strength: c.strength,
            state: c.state,
        });
    }
    Ok(results)
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
        if effective_opts.use_reranker { "1" } else { "0" },
        {
            let mut v: Vec<String> = effective_opts.ablate.iter().map(|s| s.to_lowercase()).collect();
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
    let placeholders = std::iter::repeat("?")
        .take(eids.len())
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

