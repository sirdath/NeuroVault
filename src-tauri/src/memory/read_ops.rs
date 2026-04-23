//! Read-path queries behind the Phase-4 Tauri commands.
//!
//! Each function here mirrors one HTTP endpoint from
//! `server/neurovault_server/api.py`:
//!
//!   `GET /api/notes`              → `list_notes`
//!   `GET /api/notes/{id}`         → `get_note`
//!   `GET /api/graph`              → `get_graph`
//!   `GET /api/brains/{id}/stats`  → `brain_stats`
//!   `GET /api/brains`             → `list_brains_with_stats`
//!
//! Response shapes are byte-compatible with what the frontend already
//! parses from the HTTP layer. That's the stable-contracts rule from
//! the migration plan: Rust answers the same questions with the same
//! JSON shape so the frontend's feature-detection code can swap the
//! transport without touching any downstream logic.
//!
//! Brain resolution: every command accepts `Option<&str>` for brain_id.
//! `None` means "the brain that's active in `brains.json`". Unknown /
//! missing brain ids return `BrainNotFound` so the Tauri layer can
//! surface a clean error to the UI.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::db::{open_brain, BrainDb};
use super::paths::{brain_dir, registry_path};
use super::types::{GraphData, GraphEdge, GraphNode, MemoryError, Result};

// ---- Response shapes ------------------------------------------------------

/// One row in the sidebar note list. Matches the columns Python selects
/// in `GET /api/notes`. `updated_at` stays a string because SQLite
/// stores ISO-8601 text; the frontend parses it with `new Date(s)`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteListRow {
    pub id: String,
    pub filename: String,
    pub title: String,
    pub state: String,
    pub strength: f64,
    pub access_count: i64,
    pub updated_at: String,
}

/// One connection in a note's detail view. `similarity` is rounded to
/// 3 decimals to match Python's `round(x, 3)` — the UI sorts by this
/// value, rounding here keeps the order stable across runtimes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Connection {
    pub engram_id: String,
    pub title: String,
    pub similarity: f64,
    pub link_type: String,
}

/// One entity mentioned in a note.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EntityRef {
    pub name: String,
    #[serde(rename = "type")]
    pub entity_type: String,
}

/// Full note detail. Field set = `engrams` row + connections + entities.
/// Uses `serde_json::Value` for the extensible payload so any future
/// column we add (kind, summary_l0, …) round-trips without this struct
/// needing to know about it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FullNote {
    /// Raw engram columns as a JSON map — preserves forwards-compat
    /// when new columns land. Separate `connections` / `entities`
    /// fields are attached at the top level for UI convenience.
    #[serde(flatten)]
    pub engram: serde_json::Map<String, serde_json::Value>,
    pub connections: Vec<Connection>,
    pub entities: Vec<EntityRef>,
}

/// Disk footprint for a brain — same shape as
/// `GET /api/brains/{id}/stats`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrainStats {
    pub brain_id: String,
    pub note_count: i64,
    pub markdown_bytes: u64,
    pub db_bytes: u64,
    pub total_bytes: u64,
    pub vault_path: String,
    pub is_external: bool,
}

/// Brain registry entry enriched with disk footprint — superset of the
/// `list_brains_offline` shape that Phase 4 replaces. Keeps the
/// `is_active` flag the sidebar already relies on.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrainSummary {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub vault_path: Option<String>,
    pub is_active: bool,
    pub stats: BrainStats,
}

// ---- Brain resolution -----------------------------------------------------

/// Resolve a brain id. `None` means "the one marked `active` in
/// `brains.json`". Errors when the registry is missing / malformed /
/// has no active id — that's an invariant violation, not a "no
/// brains" situation (fresh installs always have a default brain
/// created by the first-run flow).
pub fn resolve_brain_id(explicit: Option<&str>) -> Result<String> {
    if let Some(id) = explicit {
        if !id.is_empty() {
            return Ok(id.to_string());
        }
    }
    let data = fs::read_to_string(registry_path())
        .map_err(|e| MemoryError::Other(format!("brains.json unreadable: {}", e)))?;
    let parsed: serde_json::Value = serde_json::from_str(&data)?;
    let active = parsed
        .get("active")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| MemoryError::Other("brains.json has no active brain".to_string()))?;
    Ok(active.to_string())
}

/// Load the full registry as a list of `(id, name, description?, vault_path?, is_active)`.
/// Pure filesystem read — no DB access. Used by `list_brains_with_stats`
/// which then looks up stats per-brain.
fn registry_entries() -> Result<Vec<(String, String, Option<String>, Option<String>, bool)>> {
    let Ok(data) = fs::read_to_string(registry_path()) else {
        return Ok(Vec::new());
    };
    let parsed: serde_json::Value = serde_json::from_str(&data)?;
    let active = parsed
        .get("active")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let brains = parsed.get("brains").and_then(|v| v.as_array());
    let Some(brains) = brains else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for b in brains {
        let Some(id) = b.get("id").and_then(|v| v.as_str()).map(String::from) else {
            continue;
        };
        let name = b
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or(&id)
            .to_string();
        let description = b.get("description").and_then(|v| v.as_str()).map(String::from);
        let vault_path = b.get("vault_path").and_then(|v| v.as_str()).map(String::from);
        let is_active = id == active;
        out.push((id, name, description, vault_path, is_active));
    }
    Ok(out)
}

// ---- Notes ----------------------------------------------------------------

/// Equivalent of `GET /api/notes`. Returns non-dormant engrams in
/// `updated_at DESC` order. The Python side projects exactly these
/// columns; we mirror that for byte-identical JSON.
pub fn list_notes(db: &BrainDb) -> Result<Vec<NoteListRow>> {
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT id, filename, title, state, strength, access_count, updated_at
         FROM engrams WHERE state != 'dormant'
         ORDER BY updated_at DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(NoteListRow {
            id: r.get(0)?,
            filename: r.get(1)?,
            title: r.get(2)?,
            state: r.get(3)?,
            strength: r.get(4)?,
            access_count: r.get(5)?,
            updated_at: r.get(6)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Equivalent of `GET /api/notes/{id}`. Returns the engram row plus
/// outbound connections + mentioned entities. Errors with
/// `EngramNotFound` when the id doesn't exist — matches the 404 the
/// HTTP layer returned.
pub fn get_note(db: &BrainDb, engram_id: &str) -> Result<FullNote> {
    let conn = db.lock();

    // Select * to preserve every column without this code caring about
    // which ones exist — keeps the struct forwards-compat with future
    // migrations. The `column_names` + `row_to_map` combo reproduces
    // `sqlite3.Row` → dict on the Python side.
    let mut stmt = conn.prepare("SELECT * FROM engrams WHERE id = ?1")?;
    let column_names: Vec<String> = stmt
        .column_names()
        .into_iter()
        .map(|s| s.to_string())
        .collect();
    let mut rows = stmt.query([engram_id])?;
    let row = rows
        .next()?
        .ok_or_else(|| MemoryError::EngramNotFound(engram_id.to_string()))?;

    let mut engram_map = serde_json::Map::new();
    for (idx, name) in column_names.iter().enumerate() {
        let value = row_value_to_json(row, idx)?;
        engram_map.insert(name.clone(), value);
    }
    drop(rows);
    drop(stmt);

    // Outbound connections — same query as Python's `/api/notes/{id}`.
    let mut stmt = conn.prepare(
        "SELECT e.id, e.title, l.similarity, l.link_type
         FROM engram_links l
         JOIN engrams e ON e.id = l.to_engram
         WHERE l.from_engram = ?1 AND e.state != 'dormant'
         ORDER BY l.similarity DESC",
    )?;
    let connections = stmt
        .query_map([engram_id], |r| {
            Ok(Connection {
                engram_id: r.get(0)?,
                title: r.get(1)?,
                similarity: round3(r.get(2)?),
                link_type: r.get(3)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);

    // Mentioned entities.
    let mut stmt = conn.prepare(
        "SELECT ent.name, ent.entity_type
         FROM entity_mentions em
         JOIN entities ent ON ent.id = em.entity_id
         WHERE em.engram_id = ?1",
    )?;
    let entities = stmt
        .query_map([engram_id], |r| {
            Ok(EntityRef {
                name: r.get(0)?,
                entity_type: r.get(1)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    Ok(FullNote {
        engram: engram_map,
        connections,
        entities,
    })
}

/// Convert one column of a SQLite row to a `serde_json::Value`. Handles
/// the common types engrams uses — TEXT, INTEGER, REAL, NULL, BLOB.
/// BLOBs (e.g. `query_embedding`) are base64-encoded so the JSON is
/// safe; no engrams column on the read path is a BLOB so this is
/// defensive, not currently exercised.
fn row_value_to_json(row: &rusqlite::Row, idx: usize) -> Result<serde_json::Value> {
    use rusqlite::types::ValueRef;
    let v = row.get_ref(idx)?;
    Ok(match v {
        ValueRef::Null => serde_json::Value::Null,
        ValueRef::Integer(i) => serde_json::Value::Number(i.into()),
        ValueRef::Real(f) => serde_json::Number::from_f64(f)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        ValueRef::Text(b) => {
            serde_json::Value::String(std::str::from_utf8(b).unwrap_or("").to_string())
        }
        ValueRef::Blob(b) => serde_json::Value::Array(
            b.iter().map(|byte| serde_json::Value::Number((*byte).into())).collect(),
        ),
    })
}

// ---- Graph ----------------------------------------------------------------

/// Equivalent of `GET /api/graph`. Returns the brain's semantic graph
/// with edges pruned below `min_similarity`, observations optionally
/// excluded. Matches Python's default (`min_similarity=0.75`,
/// `include_observations=false`).
pub fn get_graph(
    db: &BrainDb,
    include_observations: bool,
    min_similarity: f64,
) -> Result<GraphData> {
    let conn = db.lock();

    // kind_filter is concatenated into the query to replicate Python's
    // string interpolation. It's a parameter-free clause (no user
    // input) so there's no SQL-injection risk; the values it gates
    // (`observation`, `session_summary`) are hard-coded literals.
    let kind_filter = if include_observations {
        ""
    } else {
        " AND COALESCE(kind, 'note') NOT IN ('observation', 'session_summary')"
    };
    let e1_kind_filter = kind_filter.replace("kind", "e1.kind");
    let e2_kind_filter = kind_filter.replace("kind", "e2.kind");

    let nodes_sql = format!(
        "SELECT id, title, state, strength, access_count
         FROM engrams
         WHERE state != 'dormant'{}",
        kind_filter
    );
    let mut stmt = conn.prepare(&nodes_sql)?;
    let nodes: Vec<GraphNode> = stmt
        .query_map([], |r| {
            Ok(GraphNode {
                id: r.get(0)?,
                title: r.get(1)?,
                state: r.get(2)?,
                strength: r.get(3)?,
                access_count: r.get(4)?,
                folder: None,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);

    let edges_sql = format!(
        "SELECT l.from_engram, l.to_engram, l.similarity, l.link_type
         FROM engram_links l
         JOIN engrams e1 ON e1.id = l.from_engram AND e1.state != 'dormant'{}
         JOIN engrams e2 ON e2.id = l.to_engram AND e2.state != 'dormant'{}
         WHERE l.from_engram < l.to_engram
           AND l.similarity >= ?1",
        e1_kind_filter, e2_kind_filter
    );
    let mut stmt = conn.prepare(&edges_sql)?;
    let edges: Vec<GraphEdge> = stmt
        .query_map([min_similarity], |r| {
            Ok(GraphEdge {
                from: r.get(0)?,
                to: r.get(1)?,
                similarity: round3(r.get(2)?),
                link_type: r.get(3)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    Ok(GraphData { nodes, edges })
}

fn round3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

// ---- Brain stats ----------------------------------------------------------

/// Equivalent of `GET /api/brains/{id}/stats`. Walks the vault
/// directory + sums `brain.db*` file sizes. Matches Python byte-for-byte.
pub fn brain_stats(brain_id: &str) -> Result<BrainStats> {
    let entry = registry_entries()?
        .into_iter()
        .find(|(id, _, _, _, _)| id == brain_id)
        .ok_or_else(|| MemoryError::BrainNotFound(brain_id.to_string()))?;
    let (_, _, _, vault_override, _) = entry;

    let root = brain_dir(brain_id);
    let (vault, is_external) = match vault_override {
        Some(ext) => (std::path::PathBuf::from(ext), true),
        None => (root.join("vault"), false),
    };

    let (note_count, markdown_bytes) = if vault.exists() {
        count_markdown(&vault)
    } else {
        (0, 0)
    };

    let mut db_bytes: u64 = 0;
    for name in ["brain.db", "brain.db-wal", "brain.db-shm"] {
        let f = root.join(name);
        if let Ok(meta) = fs::metadata(&f) {
            db_bytes += meta.len();
        }
    }

    Ok(BrainStats {
        brain_id: brain_id.to_string(),
        note_count,
        markdown_bytes,
        db_bytes,
        total_bytes: markdown_bytes + db_bytes,
        vault_path: vault.to_string_lossy().to_string(),
        is_external,
    })
}

/// Recursively count markdown files + byte total under `root`. Silently
/// skips entries we can't stat — matches Python's `OSError` swallow.
fn count_markdown(root: &Path) -> (i64, u64) {
    let mut count: i64 = 0;
    let mut bytes: u64 = 0;
    let Ok(entries) = fs::read_dir(root) else {
        return (0, 0);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let (c, b) = count_markdown(&path);
            count += c;
            bytes += b;
            continue;
        }
        if path.extension().map_or(false, |e| e == "md") {
            if let Ok(meta) = fs::metadata(&path) {
                bytes += meta.len();
                count += 1;
            }
        }
    }
    (count, bytes)
}

/// Equivalent of `GET /api/brains` — every brain in `brains.json`
/// enriched with disk stats. The Phase-4 Tauri command `nv_list_brains`
/// wraps this for the BrainSelector UI.
pub fn list_brains_with_stats() -> Result<Vec<BrainSummary>> {
    let entries = registry_entries()?;
    let mut out = Vec::with_capacity(entries.len());
    for (id, name, description, vault_path, is_active) in entries {
        // Skip-on-error per brain: one broken brain shouldn't blank
        // the sidebar for the rest. Fall back to zeroed stats instead.
        let stats = brain_stats(&id).unwrap_or_else(|_| BrainStats {
            brain_id: id.clone(),
            note_count: 0,
            markdown_bytes: 0,
            db_bytes: 0,
            total_bytes: 0,
            vault_path: vault_path.clone().unwrap_or_default(),
            is_external: vault_path.is_some(),
        });
        out.push(BrainSummary {
            id,
            name,
            description,
            vault_path,
            is_active,
            stats,
        });
    }
    Ok(out)
}

// ---- Convenience: resolve + open ------------------------------------------

/// Helper used by the Tauri commands — resolve the brain id (explicit
/// or active), then open (or return cached) the `BrainDb`. Returns an
/// `Arc<BrainDb>` the caller can hold for the lifetime of the request.
pub fn brain_from_id(explicit: Option<&str>) -> Result<(String, std::sync::Arc<BrainDb>)> {
    let id = resolve_brain_id(explicit)?;
    let db = open_brain(&id)?;
    Ok((id, db))
}

/// Resolve the vault directory for a brain, honoring the external
/// `vault_path` override if `brains.json` has one set. Falls back to
/// `~/.neurovault/brains/<id>/vault/` — the canonical internal vault.
/// Used by the HTTP `remember` endpoint which runs off the Tauri
/// thread and can't use `crate::vault_dir` (which reads the active
/// brain); here we specifically want the vault for whichever brain
/// the caller targeted.
pub fn resolve_vault_path(brain_id: &str) -> Result<std::path::PathBuf> {
    let entry = registry_entries()?
        .into_iter()
        .find(|(id, _, _, _, _)| id == brain_id);
    let external = entry.and_then(|(_, _, _, vp, _)| vp);
    if let Some(ext) = external {
        let p = std::path::PathBuf::from(ext);
        if p.is_dir() {
            return Ok(p);
        }
    }
    Ok(super::paths::vault_dir(brain_id))
}
