//! `get_related(engram_id, hops)` — cheap neighbour lookup.
//!
//! Agents commonly follow up a recall with "tell me what's connected
//! to hit #1". Today they have to issue another full `recall` against
//! the hit's title (lossy) or fetch the engram detail + parse its
//! `connections` array (fine, but forces a second round-trip). This
//! tool is a direct graph lookup — one SQL query for 1-hop, a JOIN
//! for 2-hop — that returns a flat list of neighbours with edge
//! type + similarity. ~50-100× cheaper than a recall.
//!
//! Safety: hop count is hard-capped at 2. Result count is capped by
//! `limit` (default 20, max 50). Dormant / soft-deleted engrams
//! never appear. Skipped `kind`s (observation by default) are
//! excluded so the output is "useful memories", not an event feed.

use rusqlite::params_from_iter;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use super::db::BrainDb;
use super::types::{MemoryError, Result};

/// Hard cap on `hops`. 1 is the common case; 2 gives you the
/// "neighbourhood of neighbourhood" but starts blowing up on hub
/// engrams. 3+ is never what agents need and quickly returns the
/// whole graph.
const MAX_HOPS: u8 = 2;

/// Hard cap on result count. Caller can ask for less via `limit`;
/// asking for more is silently clamped. 50 is enough for a human
/// reader + rarely useful beyond it for an agent.
const MAX_LIMIT: usize = 50;

/// Default similarity floor for the edge filter. Matches the
/// `spread_neighbors` default — anything below 0.55 is "weakly
/// related" and adds noise.
const DEFAULT_MIN_SIMILARITY: f64 = 0.55;

/// Default kinds excluded from the output. Same rationale as the
/// retriever: observations are a noisy firehose that drowns the
/// signal for most queries.
fn default_exclude() -> Vec<String> {
    vec!["observation".to_string()]
}

#[derive(Debug, Clone, Deserialize)]
pub struct RelatedOpts {
    pub hops: u8,
    pub limit: usize,
    pub min_similarity: f64,
    pub link_types: Option<Vec<String>>,
    pub exclude_kinds: Vec<String>,
}

impl Default for RelatedOpts {
    fn default() -> Self {
        Self {
            hops: 1,
            limit: 20,
            min_similarity: DEFAULT_MIN_SIMILARITY,
            link_types: None,
            exclude_kinds: default_exclude(),
        }
    }
}

/// Row shape agents get back. `hop_distance` is 1 for direct
/// neighbours, 2 for second-hop; lets the caller decide whether to
/// show 2-hop rows as a separate section or a single list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelatedHit {
    pub engram_id: String,
    pub title: String,
    pub similarity: f64,
    pub link_type: String,
    pub kind: String,
    pub hop_distance: u8,
}

/// Fetch neighbours of `engram_id` up to `hops` steps away. Filters
/// by link type (if supplied), minimum similarity, and excluded
/// kinds. Result is sorted by `(hop_distance ASC, similarity DESC)`
/// so 1-hop strong neighbours come first.
pub fn get_related(
    db: &BrainDb,
    engram_id: &str,
    opts: &RelatedOpts,
) -> Result<Vec<RelatedHit>> {
    let hops = opts.hops.min(MAX_HOPS).max(1);
    let limit = opts.limit.min(MAX_LIMIT).max(1);
    let min_sim = opts.min_similarity.max(0.0).min(1.0);
    let exclude: HashSet<&str> = opts.exclude_kinds.iter().map(|s| s.as_str()).collect();
    let link_type_filter: Option<HashSet<&str>> = opts
        .link_types
        .as_ref()
        .map(|v| v.iter().map(|s| s.as_str()).collect());

    // Single query for direct + second-hop. Uses a UNION so one
    // round-trip returns both tiers. `hop_distance` is a synthetic
    // column so the caller can group / sort by it.
    //
    // Second-hop branch guards against cycling back to the source
    // (`l2.to_engram != ?1`) and against already-seen first-hop
    // engrams (filtered in Rust because expressing it in SQL
    // requires a CTE and the set is tiny anyway).
    let conn = db.lock();
    let mut stmt_hop1 = conn.prepare(
        "SELECT l.to_engram, e.title, l.similarity, l.link_type,
                COALESCE(e.kind, 'note')
         FROM engram_links l
         JOIN engrams e ON e.id = l.to_engram
         WHERE l.from_engram = ?1
           AND e.state != 'dormant'
           AND l.similarity >= ?2
         ORDER BY l.similarity DESC",
    )?;
    let hop1_rows: Vec<(String, String, f64, String, String)> = stmt_hop1
        .query_map(params_from_iter([
            rusqlite::types::Value::Text(engram_id.to_string()),
            rusqlite::types::Value::Real(min_sim),
        ].iter()), |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, f64>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt_hop1);

    // Prepare first-hop output with filter application. Keep a set
    // of already-seen engram ids for the hop-2 dedupe.
    let mut seen: HashSet<String> = HashSet::new();
    seen.insert(engram_id.to_string());
    let mut out: Vec<RelatedHit> = Vec::new();
    for (to_id, title, sim, link_type, kind) in hop1_rows {
        if exclude.contains(kind.as_str()) {
            continue;
        }
        if let Some(ref allowed) = link_type_filter {
            if !allowed.contains(link_type.as_str()) {
                continue;
            }
        }
        seen.insert(to_id.clone());
        out.push(RelatedHit {
            engram_id: to_id,
            title,
            similarity: round3(sim),
            link_type,
            kind,
            hop_distance: 1,
        });
    }

    // Second hop: only run if requested AND the first-hop set is
    // non-empty (otherwise there's no seed to expand from).
    if hops >= 2 && !out.is_empty() {
        let seeds: Vec<String> = out.iter().map(|h| h.engram_id.clone()).collect();
        let placeholders = std::iter::repeat("?")
            .take(seeds.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT DISTINCT l.to_engram, e.title, MAX(l.similarity), l.link_type,
                    COALESCE(e.kind, 'note')
             FROM engram_links l
             JOIN engrams e ON e.id = l.to_engram
             WHERE l.from_engram IN ({}) AND l.similarity >= ?
               AND e.state != 'dormant'
               AND l.to_engram != ?
             GROUP BY l.to_engram
             ORDER BY l.similarity DESC",
            placeholders
        );
        let mut bind: Vec<rusqlite::types::Value> = Vec::new();
        for s in &seeds {
            bind.push(rusqlite::types::Value::Text(s.clone()));
        }
        bind.push(rusqlite::types::Value::Real(min_sim));
        bind.push(rusqlite::types::Value::Text(engram_id.to_string()));

        let mut stmt_hop2 = conn.prepare(&sql)?;
        let hop2_rows: Vec<(String, String, f64, String, String)> = stmt_hop2
            .query_map(params_from_iter(bind.iter()), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, f64>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(stmt_hop2);

        for (to_id, title, sim, link_type, kind) in hop2_rows {
            if seen.contains(&to_id) {
                continue;
            }
            if exclude.contains(kind.as_str()) {
                continue;
            }
            if let Some(ref allowed) = link_type_filter {
                if !allowed.contains(link_type.as_str()) {
                    continue;
                }
            }
            seen.insert(to_id.clone());
            out.push(RelatedHit {
                engram_id: to_id,
                title,
                similarity: round3(sim),
                link_type,
                kind,
                hop_distance: 2,
            });
        }
    }

    // Sort: (hop ASC, similarity DESC) gives 1-hop strong first,
    // then 2-hop strong. Truncate.
    out.sort_by(|a, b| {
        a.hop_distance
            .cmp(&b.hop_distance)
            .then_with(|| b.similarity.partial_cmp(&a.similarity).unwrap_or(std::cmp::Ordering::Equal))
    });
    out.truncate(limit);
    Ok(out)
}

fn round3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

/// Convenience wrapper that verifies the source engram exists
/// before running the neighbour queries. Agents get a clean error
/// instead of an empty list if they pass a bad id.
pub fn get_related_checked(
    db: &BrainDb,
    engram_id: &str,
    opts: &RelatedOpts,
) -> Result<Vec<RelatedHit>> {
    {
        let conn = db.lock();
        let exists: Option<String> = conn
            .query_row(
                "SELECT id FROM engrams WHERE id = ?1",
                [engram_id],
                |r| r.get(0),
            )
            .ok();
        if exists.is_none() {
            return Err(MemoryError::EngramNotFound(engram_id.to_string()));
        }
    }
    get_related(db, engram_id, opts)
}
