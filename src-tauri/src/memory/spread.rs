//! Read-path spreading activation: expand the candidate pool with
//! 1-hop neighbours of the top seeds.
//!
//! Port of `retriever.py::_spread_neighbors`. Mutates the candidate
//! list in place, appending up to `max_new` rows whose `rrf_score`
//! is `seed_rrf × link_similarity × dampening` — dampening prevents
//! a spread neighbour from out-ranking a direct match unless the
//! direct match was already weak.
//!
//! This is DIFFERENT from the consolidation-pass spread (which
//! strengthens links for future queries). This one surfaces
//! linked-but-not-directly-matching engrams at query time.

use std::collections::HashSet;

use rusqlite::params_from_iter;

use super::db::BrainDb;
use super::retriever::Candidate;
use super::types::Result;

/// Tunable hyper-parameters for `_spread_neighbors`. Defaults match
/// what `retriever.py::hybrid_retrieve` passes (seed_count=3,
/// link_threshold=0.55, dampening=0.4, max_new=10).
#[derive(Debug, Clone, Copy)]
pub struct SpreadOpts {
    pub seed_count: usize,
    pub link_threshold: f64,
    pub dampening: f64,
    pub max_new: usize,
}

impl Default for SpreadOpts {
    fn default() -> Self {
        Self {
            seed_count: 3,
            link_threshold: 0.55,
            dampening: 0.4,
            max_new: 10,
        }
    }
}

/// Mutate `candidates` in place by appending neighbour rows of the
/// top seeds. `exclude_kinds` skips engrams whose `kind` is in the
/// set (observations by default). `as_of`, when provided, drops
/// neighbours whose `created_at` is strictly greater than the
/// supplied ISO timestamp.
pub fn spread_neighbors(
    db: &BrainDb,
    candidates: &mut Vec<Candidate>,
    opts: SpreadOpts,
    as_of: Option<&str>,
    exclude_kinds: &HashSet<String>,
) -> Result<()> {
    if candidates.is_empty() || opts.seed_count == 0 {
        return Ok(());
    }

    // Top-`seed_count` candidates by current RRF score get to radiate.
    let mut by_rrf: Vec<(usize, f64)> = candidates
        .iter()
        .enumerate()
        .map(|(i, c)| (i, c.rrf_score))
        .collect();
    by_rrf.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    by_rrf.truncate(opts.seed_count);
    if by_rrf.is_empty() {
        return Ok(());
    }

    let seed_ids: Vec<String> = by_rrf
        .iter()
        .map(|(i, _)| candidates[*i].engram_id.clone())
        .collect();
    let seed_rrf: std::collections::HashMap<String, f64> = by_rrf
        .iter()
        .map(|(i, s)| (candidates[*i].engram_id.clone(), *s))
        .collect();
    let already: HashSet<String> = candidates.iter().map(|c| c.engram_id.clone()).collect();

    let placeholders = std::iter::repeat("?")
        .take(seed_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT l.from_engram, l.to_engram, l.similarity, l.link_type,
                e.id, e.title, e.content, e.strength, e.state,
                e.updated_at, e.created_at, COALESCE(e.kind, 'note')
         FROM engram_links l
         JOIN engrams e ON e.id = l.to_engram
         WHERE l.from_engram IN ({})
           AND l.similarity >= ?
           AND e.state != 'dormant'
         ORDER BY l.similarity DESC",
        placeholders
    );

    let conn = db.lock();
    let mut stmt = conn.prepare(&sql)?;

    // Bind seed_ids + threshold in one parameter iterator — mix-typing
    // is handled by going through `Value`.
    let mut bind: Vec<rusqlite::types::Value> = Vec::with_capacity(seed_ids.len() + 1);
    for id in &seed_ids {
        bind.push(rusqlite::types::Value::Text(id.clone()));
    }
    bind.push(rusqlite::types::Value::Real(opts.link_threshold));

    let mut already_seen = already.clone();
    let mut added: usize = 0;

    let mut rows = stmt.query(params_from_iter(bind.iter()))?;
    while let Some(row) = rows.next()? {
        if added >= opts.max_new {
            break;
        }
        let from_id: String = row.get(0)?;
        let to_id: String = row.get(1)?;
        let sim: f64 = row.get(2)?;
        let _link_type: String = row.get(3)?;
        let id: String = row.get(4)?;
        let title: String = row.get(5)?;
        let content: String = row.get(6).unwrap_or_default();
        let strength: f64 = row.get(7)?;
        let state: String = row.get(8)?;
        let updated_at: String = row.get(9).unwrap_or_default();
        let created_at: String = row.get(10).unwrap_or_default();
        let kind: String = row.get(11)?;

        if already_seen.contains(&to_id) {
            continue;
        }
        if exclude_kinds.contains(&kind) {
            continue;
        }
        if let Some(cutoff) = as_of {
            if !created_at.is_empty() && created_at.as_str() > cutoff {
                continue;
            }
        }

        let base_rrf = seed_rrf.get(&from_id).copied().unwrap_or(0.0);
        let rrf = base_rrf * sim * opts.dampening;

        // First 1000 chars, like Python.
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
            via_spread: true,
            rerank_score: rrf,
            recency_factor: 1.0,
            decision_bonus: 0.0,
            affinity_bonus: 0.0,
            final_score: 0.0,
        });
        already_seen.insert(to_id);
        added += 1;
    }

    Ok(())
}
