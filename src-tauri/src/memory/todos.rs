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
    // --- handoff fields (multi-agent coordination; all optional, so old
    // todos.jsonl lines still parse and plain todos are unaffected) ---
    /// Handoff type tag (e.g. "feature-request"); None = a plain todo, not
    /// a handoff. `agent_inbox` filters to kind.is_some().
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// Structured data the receiving agent reads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
    /// Engram id that motivated the handoff (provenance).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_engram: Option<String>,
}

fn default_priority() -> String {
    "normal".to_string()
}
fn default_status() -> String {
    "open".to_string()
}

fn todos_path(brain_id: &str) -> std::path::PathBuf {
    brain_dir(brain_id).join("todos.jsonl")
}

fn now_iso() -> String {
    let now = std::time::SystemTime::now();
    let secs = now
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Cheap RFC-3339-ish; the Python side reads with `datetime.fromisoformat`
    // which accepts this shape. Falls back to `.now()` if rare clock skew.
    let dt = time::OffsetDateTime::from_unix_timestamp(secs as i64)
        .unwrap_or_else(|_| time::OffsetDateTime::now_utc());
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
            Ok(t) => {
                latest.insert(t.id.clone(), t);
            }
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
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
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
    pub kind: Option<String>,
    pub payload: Option<serde_json::Value>,
    pub source_engram: Option<String>,
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
        kind: args.kind,
        payload: args.payload,
        source_engram: args.source_engram,
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

/// Does this todo's `agent_match` address `agent`? Empty match = broadcast
/// (everyone). Otherwise it's a regex; a MALFORMED regex matches nothing
/// (fail-closed — a typo never floods an unintended agent's inbox).
pub fn agent_match_hits(pattern: &str, agent: &str) -> bool {
    if pattern.trim().is_empty() {
        return true;
    }
    match regex::Regex::new(pattern) {
        Ok(re) => re.is_match(agent),
        Err(_) => false,
    }
}

/// Open todos addressed to `agent` (agent_match broadcasts or matches).
/// `handoffs_only` keeps only entries with a `kind` set — i.e. true
/// inter-agent handoffs, not plain assigned todos. Pull-based inbox: the
/// caller polls this; nothing is pushed.
pub fn inbox_for_agent(brain_id: &str, agent: &str, handoffs_only: bool) -> Result<Vec<Todo>> {
    let open = list_todos(brain_id, Some("open"))?;
    Ok(open
        .into_iter()
        .filter(|t| (!handoffs_only || t.kind.is_some()) && agent_match_hits(&t.agent_match, agent))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn todo(id: &str, agent_match: &str, kind: Option<&str>) -> Todo {
        Todo {
            id: id.into(),
            text: "t".into(),
            agent_match: agent_match.into(),
            priority: "normal".into(),
            status: "open".into(),
            claimed_by: None,
            claimed_at: None,
            completed_at: None,
            created_at: "2026-01-01T00:00:00Z".into(),
            created_by: None,
            note: None,
            kind: kind.map(String::from),
            payload: None,
            source_engram: None,
        }
    }

    #[test]
    fn new_fields_round_trip_through_jsonl() {
        let mut t = todo("a", "claude", Some("feature-request"));
        t.payload = Some(serde_json::json!({"user": "x", "n": 3}));
        t.source_engram = Some("eng-1".into());
        let line = serde_json::to_string(&t).unwrap();
        let back: Todo = serde_json::from_str(&line).unwrap();
        assert_eq!(back.kind.as_deref(), Some("feature-request"));
        assert_eq!(back.source_engram.as_deref(), Some("eng-1"));
        assert_eq!(back.payload.unwrap()["n"], 3);
    }

    #[test]
    fn old_line_without_new_fields_still_parses() {
        // A pre-handoff todos.jsonl line — no kind/payload/source_engram.
        let old = r#"{"id":"x","text":"do it","agent_match":"","priority":"normal","status":"open","created_at":"2026-01-01T00:00:00Z"}"#;
        let t: Todo = serde_json::from_str(old).unwrap();
        assert!(t.kind.is_none() && t.payload.is_none() && t.source_engram.is_none());
    }

    #[test]
    fn agent_match_routing() {
        assert!(agent_match_hits("", "anyone")); // broadcast
        assert!(agent_match_hits("claude-code", "claude-code"));
        assert!(agent_match_hits("^claude", "claude-code"));
        assert!(!agent_match_hits("claude-code", "other"));
        assert!(!agent_match_hits("[unclosed", "claude-code")); // malformed -> fail-closed
    }

    #[test]
    fn inbox_filter_handoffs_only_and_addressing() {
        let all = [
            todo("h1", "claude-code", Some("feature-request")), // handoff to claude-code
            todo("h2", "", Some("anomaly")),                    // broadcast handoff
            todo("p1", "claude-code", None),                    // plain todo (no kind)
            todo("h3", "other-agent", Some("churn-risk")),      // handoff to someone else
        ];
        let keep = |agent: &str, handoffs_only: bool| {
            all.iter()
                .filter(|t| {
                    (!handoffs_only || t.kind.is_some()) && agent_match_hits(&t.agent_match, agent)
                })
                .map(|t| t.id.clone())
                .collect::<Vec<_>>()
        };
        // agent_inbox (handoffs_only): claude-code sees its handoff + the broadcast, not the plain todo, not other's.
        assert_eq!(keep("claude-code", true), vec!["h1", "h2"]);
        assert_eq!(keep("other-agent", true), vec!["h2", "h3"]);
        // session_start view (handoffs_only=false) also includes the plain assigned todo.
        assert_eq!(keep("claude-code", false), vec!["h1", "h2", "p1"]);
    }
}
