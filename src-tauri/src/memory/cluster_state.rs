//! Per-brain Louvain community summaries + named-cluster registry.
//!
//! The frontend computes communities via `graphMetrics.louvain` when
//! Analytics mode is enabled. It pushes a summary of each unnamed
//! cluster (top 5 nodes by PageRank, total member count, sample
//! wikilinks) into here via the `nv_set_clusters` Tauri command.
//! The Rust HTTP server exposes those summaries via GET /api/clusters
//! so an MCP-speaking agent (the user's Claude session) can read
//! them, propose names, and POST them back via /api/clusters/names.
//!
//! The names are *persisted* to `~/.neurovault/brains/{id}/cluster_names.json`
//! so the user's chosen names survive app restarts. The summaries
//! themselves are *not* persisted — they're rebuilt every time the
//! frontend pushes (cheap; the cost is the Louvain run itself, not
//! the JSON shuffle).
//!
//! Concurrency note: protected by a single Mutex. Reads/writes are
//! short and infrequent (push on graph change, read on /api/clusters
//! or skill invocation), so contention isn't a concern at our scale.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use once_cell::sync::Lazy;

use super::paths::brain_dir;

type BrainId = String;

/// One community's summary as the agent will see it. Frontend builds
/// this and pushes via nv_set_clusters; the agent reads it via the
/// MCP `list_unnamed_clusters` tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClusterSummary {
    pub id: u32,
    /// Total notes in this cluster (after Louvain partition).
    pub size: usize,
    /// Top-N member note titles by PageRank (or by graph degree if
    /// PR isn't available client-side). Frontend caps to 5.
    pub top_titles: Vec<String>,
    /// Sample wikilinks the agent can use as additional naming
    /// signal — strings already extracted from member-note bodies
    /// client-side. Capped to 10 to keep payload small.
    pub sample_links: Vec<String>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct PerBrain {
    /// Latest cluster summaries pushed by the frontend. Replaced
    /// wholesale on each push; nothing accumulates.
    summaries: Vec<ClusterSummary>,
}

static STATE: Lazy<Mutex<HashMap<BrainId, PerBrain>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Replace a brain's cluster summaries. Frontend pushes this every
/// time Louvain runs (Analytics enabled, graph data changed, etc).
pub fn set_summaries(brain_id: &str, summaries: Vec<ClusterSummary>) {
    let mut g = STATE.lock();
    let entry = g.entry(brain_id.to_string()).or_default();
    entry.summaries = summaries;
}

/// Read the latest cluster summaries pushed for this brain. Returns
/// an empty vec if Analytics mode hasn't been enabled this session
/// or the frontend hasn't pushed yet.
pub fn get_summaries(brain_id: &str) -> Vec<ClusterSummary> {
    let g = STATE.lock();
    g.get(brain_id).map(|s| s.summaries.clone()).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Persisted name registry — disk-backed.
// ---------------------------------------------------------------------------

fn names_path(brain_id: &str) -> PathBuf {
    brain_dir(brain_id).join("cluster_names.json")
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct NamesFile {
    /// Map from community id (as a string for JSON ergonomics) → user-
    /// or agent-supplied label. Hand-edits to this file are picked up
    /// next time `read_names` is called; no reload watcher needed.
    names: HashMap<String, String>,
}

/// Load names from `~/.neurovault/brains/{id}/cluster_names.json`.
/// Missing file = empty map (default state).
pub fn read_names(brain_id: &str) -> HashMap<u32, String> {
    let path = names_path(brain_id);
    let raw = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return HashMap::new(),
    };
    let parsed: NamesFile = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return HashMap::new(),
    };
    parsed
        .names
        .into_iter()
        .filter_map(|(k, v)| k.parse::<u32>().ok().map(|id| (id, v)))
        .collect()
}

/// Merge new names into the persisted file. Existing entries for ids
/// not in `incoming` are preserved (so the agent can name a few at
/// a time without clobbering earlier work).
pub fn merge_names(
    brain_id: &str,
    incoming: HashMap<u32, String>,
) -> Result<HashMap<u32, String>, String> {
    let mut current = read_names(brain_id);
    for (id, name) in incoming {
        let trimmed = name.trim().to_string();
        if trimmed.is_empty() {
            current.remove(&id);
        } else {
            current.insert(id, trimmed);
        }
    }

    let path = names_path(brain_id);
    let parent = path.parent().ok_or_else(|| "no parent dir".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;

    let payload = NamesFile {
        names: current
            .iter()
            .map(|(id, name)| (id.to_string(), name.clone()))
            .collect(),
    };
    let json = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(current)
}

#[allow(dead_code)]
pub fn clear(brain_id: &str) {
    STATE.lock().remove(brain_id);
}
