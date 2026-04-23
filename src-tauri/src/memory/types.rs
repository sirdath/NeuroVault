//! Shared data types for the Rust memory layer.
//!
//! Column names + types mirror the Python side exactly so a row
//! written by Python's SQLAlchemy-free `sqlite3` layer deserialises
//! cleanly into these structs via `rusqlite::Row::get`, and vice
//! versa. Source of truth for the schema is
//! `server/neurovault_server/database.py::SCHEMA_SQL` — keep this
//! file in sync when that changes.
//!
//! Serde is derived everywhere because these types flow out through
//! Tauri commands (which expects `Serialize`) and, in Phase 6,
//! through the Rust HTTP server's JSON responses.

use serde::{Deserialize, Serialize};

/// One note / memory unit. Mirrors the `engrams` SQL table.
///
/// Nullable columns become `Option<T>`. Timestamps stay as strings
/// because Python stores ISO-8601 in `TEXT` columns and the frontend
/// parses them with `new Date(string)`; switching to `DateTime` here
/// would round-trip lossy on the boundary.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Engram {
    pub id: String,
    pub filename: String,
    pub title: String,
    pub content: String,
    pub content_hash: String,
    pub summary: Option<String>,
    pub summary_l0: Option<String>,
    pub summary_l1: Option<String>,
    pub tags: Option<String>,
    pub kind: String,
    pub state: String,
    pub strength: f64,
    pub access_count: i64,
    pub agent_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// A chunk of an engram at one of the three granularities
/// (document / paragraph / sentence). Mirrors the `chunks` table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Chunk {
    pub id: String,
    pub engram_id: String,
    pub content: String,
    pub granularity: String,
    pub chunk_index: i64,
}

/// Knowledge graph entity. Mirrors the `entities` table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entity {
    pub id: String,
    pub name: String,
    pub entity_type: String,
    pub mention_count: i64,
    pub first_seen_at: String,
}

/// Edge between two engrams — semantic, entity-shared, or wikilink.
/// Mirrors the `engram_links` table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngramLink {
    pub from_engram: String,
    pub to_engram: String,
    pub similarity: f64,
    pub link_type: String,
}

/// Registry-level brain metadata. The on-disk shape in `brains.json`
/// uses `vault_path` only when the brain is an external-folder vault,
/// so it's optional here too. `is_active` is a derived field the
/// caller fills in from `brains.json::active`, not stored per-brain.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Brain {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vault_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default)]
    pub is_active: bool,
}

/// Graph payload returned by `GET /api/graph` and the upcoming Rust
/// `nv_get_graph` Tauri command. The frontend's
/// `src/lib/graphFromDisk.ts` already consumes this exact shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphData {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

/// Node in the graph view. Superset of `Engram` fields but trimmed
/// to what the UI actually renders — avoids shipping markdown content
/// of every note over the IPC boundary just to draw circles.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphNode {
    pub id: String,
    pub title: String,
    pub state: String,
    pub strength: f64,
    pub access_count: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
}

/// Undirected edge in the graph view. `link_type` carries the typed
/// relation string (`semantic`, `entity`, `manual`, `uses`, ...).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphEdge {
    pub from: String,
    pub to: String,
    pub similarity: f64,
    pub link_type: String,
}

/// Error surface for the memory module. Consumers at the Tauri
/// command boundary `map_err(|e| e.to_string())` into a `Result`
/// that serialises over IPC as a string, matching how the existing
/// Tauri commands in `lib.rs` report failures.
#[derive(Debug, thiserror::Error)]
pub enum MemoryError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("brain not found: {0}")]
    BrainNotFound(String),

    #[error("engram not found: {0}")]
    EngramNotFound(String),

    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, MemoryError>;
