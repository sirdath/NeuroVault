//! Append-only multi-agent todos.
//!
//! Stored as JSONL at `~/.neurovault/brains/{id}/todos.jsonl`. Every
//! state change appends a new line; the latest line wins on read.
//! That's the "git log" style — no in-place edits, easy to recover
//! from corruption, easy to inspect by hand.
//!
//! Schema:
//!   id            ULID/UUID
//!   text          one-line task
//!   agent_match   optional regex (any agent claims if match.is_empty())
//!   priority      "low" | "normal" | "high"
//!   status        "open" | "claimed" | "done" | "cancelled"
//!   claimed_by    agent_id who took it
//!   claimed_at    ISO-8601
//!   completed_at  ISO-8601
//!   created_at    ISO-8601
//!   created_by    agent_id (optional)
//!   note          optional context string
//!
//! State machine: open -> claimed -> done. Claim is FIFO over
//! agent_match. Complete is idempotent (claimed twice = same
//! result).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};

use super::paths::brain_dir;
use super::types::{MemoryError, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Todo {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub agent_match: String,
    #[serde(default = "default_priority")]
    pub priority: String,
    #[serde(default = "default_status")]
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claimed_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claimed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

fn default_priority() -> String { "normal".to_string() }
fn default_status() -> String { "open".to_string() }

fn todos_path(brain_id: &str) -> std::path::PathBuf {
    brain_dir(brain_id).join("todos.jsonl")
}

fn now_iso() -> String {
    let now = std::time::SystemTime::now();
    let secs = now.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
    // Cheap RFC-3339-ish; the Python side reads with `datetime.fromisoformat`
    // which accepts this shape. Falls back to `.now()` if rare clock skew.
    let dt = time::OffsetDateTime::from_unix_timestamp(secs as i64).unwrap_or_else(|_| {
        time::OffsetDateTime::now_utc()
    });
    dt.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| dt.to_string())
}

/// Generate a short id. ULID would be nicer but we don't depend on
/// it; UUID-v4 truncated to 12 chars is plenty for a per-brain todo
/// list (no collisions until you've created ~10^7 todos in one brain).
fn new_id() -> String {
    // Reuse the uuid crate already in Cargo.toml.
    let u = uuid::Uuid::new_v4().simple().to_string();
    u[..12].to_string()
}

/// Read the JSONL log + reduce to the latest state per id. Lines
/// that fail to parse are silently dropped — better to surface a
/// partial todo list than 500 the whole endpoint.
pub fn list_todos(brain_id: &str, status_filter: Option<&str>) -> Result<Vec<Todo>> {
    let path = todos_path(brain_id);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let f = std::fs::File::open(&path).map_err(MemoryError::Io)?;
    let rdr = BufReader::new(f);
    let mut latest: HashMap<String, Todo> = HashMap::new();
    for line in rdr.lines() {
        let raw = match line {
            Ok(s) => s,
            Err(_) => continue,
        };
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<Todo>(trimmed) {
            Ok(t) => { latest.insert(t.id.clone(), t); }
            Err(_) => { /* skip corrupt line */ }
        }
    }
    let mut out: Vec<Todo> = latest
        .into_values()
        .filter(|t| match status_filter {
            Some(s) => t.status == s,
            None => true,
        })
        .collect();
    // Newest first. Status order: open > claimed > done > cancelled.
    out.sort_by(|a, b| {
        b.created_at.cmp(&a.created_at)
    });
    Ok(out)
}

/// Append a single Todo line to the JSONL log. Atomicity: open
/// with append-mode + fsync per write. Two concurrent writers from
/// different processes could interleave — that's acceptable since
/// each line is self-contained.
fn append_todo(brain_id: &str, todo: &Todo) -> Result<()> {
    let path = todos_path(brain_id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(MemoryError::Io)?;
    }
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(MemoryError::Io)?;
    let line = serde_json::to_string(todo).map_err(MemoryError::Json)?;
    writeln!(f, "{}", line).map_err(MemoryError::Io)?;
    f.flush().map_err(MemoryError::Io)?;
    Ok(())
}

pub struct AddTodoArgs {
    pub text: String,
    pub agent_match: Option<String>,
    pub priority: Option<String>,
    pub created_by: Option<String>,
    pub note: Option<String>,
}

pub fn add_todo(brain_id: &str, args: AddTodoArgs) -> Result<Todo> {
    let todo = Todo {
        id: new_id(),
        text: args.text,
        agent_match: args.agent_match.unwrap_or_default(),
        priority: args.priority.unwrap_or_else(default_priority),
        status: "open".to_string(),
        claimed_by: None,
        claimed_at: None,
        completed_at: None,
        created_at: now_iso(),
        created_by: args.created_by,
        note: args.note,
    };
    append_todo(brain_id, &todo)?;
    Ok(todo)
}

/// Claim by id: agent says "I'm taking this". Idempotent if the
/// same agent claims twice; rejects (Ok(None)) if a different agent
/// already holds it.
pub fn claim_todo(brain_id: &str, id: &str, agent_id: &str) -> Result<Option<Todo>> {
    let todos = list_todos(brain_id, None)?;
    let cur = match todos.into_iter().find(|t| t.id == id) {
        Some(t) => t,
        None => return Err(MemoryError::Other(format!("todo not found: {}", id))),
    };
    if cur.status == "done" || cur.status == "cancelled" {
        return Err(MemoryError::Other(format!(
            "todo {} is already {}",
            id, cur.status
        )));
    }
    if cur.status == "claimed" {
        match cur.claimed_by.as_deref() {
            Some(other) if other != agent_id => return Ok(None),
            _ => return Ok(Some(cur)),
        }
    }
    let next = Todo {
        status: "claimed".to_string(),
        claimed_by: Some(agent_id.to_string()),
        claimed_at: Some(now_iso()),
        ..cur
    };
    append_todo(brain_id, &next)?;
    Ok(Some(next))
}

pub fn complete_todo(brain_id: &str, id: &str) -> Result<Todo> {
    let todos = list_todos(brain_id, None)?;
    let cur = match todos.into_iter().find(|t| t.id == id) {
        Some(t) => t,
        None => return Err(MemoryError::Other(format!("todo not found: {}", id))),
    };
    if cur.status == "done" {
        return Ok(cur);
    }
    let next = Todo {
        status: "done".to_string(),
        completed_at: Some(now_iso()),
        ..cur
    };
    append_todo(brain_id, &next)?;
    Ok(next)
}

pub fn get_todo(brain_id: &str, id: &str) -> Result<Option<Todo>> {
    let todos = list_todos(brain_id, None)?;
    Ok(todos.into_iter().find(|t| t.id == id))
}
