//! Core-memory blocks (Letta / MemGPT pattern).
//!
//! Short, persistent, structured strings the agent maintains about
//! the user — persona, project, preferences. Always loaded into
//! `session_start`'s response so the agent has them in-context
//! without needing to recall(). The agent edits via append /
//! replace / set tools.
//!
//! Storage: the `core_memory_blocks` table in `brain.db`. Schema:
//!   label       TEXT PRIMARY KEY
//!   value       TEXT
//!   description TEXT
//!   char_limit  INTEGER (default 2000)
//!   updated_at  TEXT
//!
//! Char-limit enforcement is gentle — we truncate on write rather
//! than reject, so a one-off oversize append doesn't fail the call.
//! The agent can re-`set` if it wants exact bytes.

use serde::{Deserialize, Serialize};

use super::db::open_brain;
use super::types::{MemoryError, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoreBlock {
    pub label: String,
    pub value: String,
    pub description: String,
    pub char_limit: i64,
    pub updated_at: String,
}

/// List all core-memory blocks for a brain. Used by `session_start`
/// + `core_memory_read(label=None)`. Returns empty vec when no
/// blocks have been seeded yet.
pub fn list_blocks(brain_id: &str) -> Result<Vec<CoreBlock>> {
    let db = open_brain(brain_id)?;
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT label, value, description, char_limit, COALESCE(updated_at, '') \
         FROM core_memory_blocks ORDER BY label",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(CoreBlock {
                label: r.get(0)?,
                value: r.get(1)?,
                description: r.get(2)?,
                char_limit: r.get(3)?,
                updated_at: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Read a single block by label. None = not seeded.
pub fn read_block(brain_id: &str, label: &str) -> Result<Option<CoreBlock>> {
    let db = open_brain(brain_id)?;
    let conn = db.lock();
    let result = conn.query_row(
        "SELECT label, value, description, char_limit, COALESCE(updated_at, '') \
         FROM core_memory_blocks WHERE label = ?1",
        rusqlite::params![label],
        |r| {
            Ok(CoreBlock {
                label: r.get(0)?,
                value: r.get(1)?,
                description: r.get(2)?,
                char_limit: r.get(3)?,
                updated_at: r.get(4)?,
            })
        },
    );
    match result {
        Ok(b) => Ok(Some(b)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(MemoryError::from(e)),
    }
}

fn truncate_to_limit(s: String, limit: i64) -> String {
    if limit <= 0 || (s.len() as i64) <= limit {
        return s;
    }
    // Cut on a char boundary, not a byte boundary, so we don't
    // emit invalid UTF-8.
    let limit_usize = limit as usize;
    let mut idx = limit_usize;
    while idx > 0 && !s.is_char_boundary(idx) {
        idx -= 1;
    }
    s[..idx].to_string()
}

/// Replace the entire block contents. Creates the block if it
/// doesn't exist. Auto-truncates to char_limit.
pub fn set_block(brain_id: &str, label: &str, value: String) -> Result<CoreBlock> {
    let db = open_brain(brain_id)?;
    let conn = db.lock();
    // Look up char_limit (or use default if new).
    let char_limit: i64 = conn
        .query_row(
            "SELECT char_limit FROM core_memory_blocks WHERE label = ?1",
            rusqlite::params![label],
            |r| r.get(0),
        )
        .unwrap_or(2000);
    let trimmed = truncate_to_limit(value, char_limit);
    conn.execute(
        "INSERT INTO core_memory_blocks (label, value, char_limit, updated_at) \
         VALUES (?1, ?2, ?3, datetime('now')) \
         ON CONFLICT(label) DO UPDATE SET value = excluded.value, \
                                          updated_at = excluded.updated_at",
        rusqlite::params![label, trimmed, char_limit],
    )?;
    drop(conn);
    Ok(read_block(brain_id, label)?.expect("just inserted"))
}

/// Append text (with a leading newline if the block is non-empty).
/// Auto-truncates if the result exceeds char_limit.
pub fn append_block(brain_id: &str, label: &str, text: &str) -> Result<CoreBlock> {
    let existing = read_block(brain_id, label)?;
    let (current, char_limit) = match existing {
        Some(b) => (b.value, b.char_limit),
        None => (String::new(), 2000),
    };
    let glue = if current.is_empty() { "" } else { "\n" };
    let next = format!("{current}{glue}{text}");
    let trimmed = truncate_to_limit(next, char_limit);
    set_block(brain_id, label, trimmed)
}

/// Find-and-replace inside a block. Returns Ok(None) when `old`
/// wasn't found (no-op, non-destructive). Useful when the agent
/// wants to surgically update one fact without rewriting the
/// whole persona.
pub fn replace_in_block(
    brain_id: &str,
    label: &str,
    old: &str,
    new: &str,
) -> Result<Option<CoreBlock>> {
    let existing = read_block(brain_id, label)?;
    let block = match existing {
        Some(b) => b,
        None => return Ok(None),
    };
    if !block.value.contains(old) {
        return Ok(None);
    }
    let next = block.value.replacen(old, new, 1);
    Ok(Some(set_block(brain_id, label, next)?))
}
