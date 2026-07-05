//! Per-brain MCP-tool audit log.
//!
//! Append-only JSONL at `<brain_dir>/audit.jsonl`. Each handler that
//! wants its activity surfaced in the UI's "recent activity" panel
//! calls `tool_audit::append()` once it has its result. The
//! `/api/audit/recent` endpoint reads the tail and returns the last N
//! entries as the `AuditEntry` shape the frontend expects.
//!
//! This is intentionally simpler than tower middleware: a handler-side
//! helper keeps the audit decision in the handler (where the
//! semantically-meaningful result lives) instead of on the wire. The
//! handler knows whether a recall returned 5 hits or zero, whether a
//! save was a `created` or a `merged`, whether the call failed — all
//! signal that's awkward to derive from raw HTTP middleware.
//!
//! Failure mode: writing is best-effort. If the file can't be opened,
//! disk is full, etc., we log to stderr and continue. The audit log
//! is observability, not data — losing an entry never breaks the
//! actual tool call.
//!
//! Rotation: when `audit.jsonl` exceeds ~10 MB, it's moved to
//! `audit.1.jsonl` (shifting `.1.jsonl → .2.jsonl`, etc.) and a fresh
//! `audit.jsonl` is started. Five numbered backups are kept; older
//! ones get deleted. This caps total audit disk per brain at ~50 MB.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::paths::brain_dir;
use super::types::Result;

/// Rotate when audit.jsonl exceeds this many bytes. Picked so a brain
/// with heavy daily usage (~1k tool calls × ~250 bytes/entry) still
/// fits 40+ days of history before the first rotation, and so reading
/// the whole file for "show me the last 50 entries" stays under 50 ms.
const ROTATION_BYTES: u64 = 10 * 1024 * 1024;

/// Keep this many numbered backups: `audit.1.jsonl` … `audit.5.jsonl`.
/// Older ones get unlinked on rotation. 5 × 10 MB caps per-brain
/// audit disk at ~50 MB; old enough to investigate "what happened
/// last week" without ballooning indefinitely.
const ROTATION_KEEP: u32 = 5;

/// One audit row — matches `src/lib/api.ts::AuditEntry` exactly so the
/// JSON round-trips to the frontend without any field mapping.
///
/// All fields except `ts` and `tool` are optional because different
/// tools have different signals (a recall has `result_count` and
/// `result_ids`; a remember has `modified_ids`; a failed call has
/// `error`). Keeping them all `Option` avoids forcing every handler
/// to fill in placeholders.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntry {
    /// ISO-8601 UTC timestamp of the tool call (record time, not
    /// request-arrival time — close enough for the activity panel).
    pub ts: String,
    /// Tool name as the agent would recognise it: `recall`,
    /// `remember`, `observations`, `reset`, etc. Free-form string;
    /// the frontend just displays it.
    pub tool: String,
    /// Arguments the tool was called with. The frontend renders this
    /// as a one-line JSON preview; keep it small (handlers should
    /// elide huge payloads before passing them in).
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub args: serde_json::Value,
    /// Engram IDs the tool returned (for read tools like recall).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_ids: Option<Vec<String>>,
    /// Total result count (when `result_ids` would be too long to
    /// store and we still want a quick summary).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_count: Option<usize>,
    /// Engram IDs the tool wrote or modified (for write tools like
    /// remember, observations, update).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_ids: Option<Vec<String>>,
    /// Session id if the call carried one (hooks always do; manual
    /// API calls usually don't).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Filled when the tool errored out. Empty `error` means success.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Wall-clock duration of the tool call, in milliseconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// HTTP status code returned to the caller. Frontend uses this
    /// to colour-code rows (2xx green, 4xx amber, 5xx red).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_code: Option<u16>,
}

impl AuditEntry {
    /// Cheap constructor with just `tool` filled in. Most callers
    /// follow it with `.with_args()` / `.with_result_count()` /
    /// `.with_modified_ids()` chained to set whatever signal the
    /// specific tool produces.
    pub fn new(tool: impl Into<String>) -> Self {
        Self {
            ts: now_iso(),
            tool: tool.into(),
            args: serde_json::Value::Null,
            result_ids: None,
            result_count: None,
            modified_ids: None,
            session_id: None,
            error: None,
            duration_ms: None,
            status_code: None,
        }
    }

    pub fn with_args(mut self, args: serde_json::Value) -> Self {
        self.args = args;
        self
    }

    pub fn with_result_ids(mut self, ids: Vec<String>) -> Self {
        self.result_count = Some(ids.len());
        self.result_ids = Some(ids);
        self
    }

    pub fn with_modified_ids(mut self, ids: Vec<String>) -> Self {
        self.modified_ids = Some(ids);
        self
    }

    pub fn with_session_id(mut self, sid: impl Into<String>) -> Self {
        self.session_id = Some(sid.into());
        self
    }

    pub fn with_error(mut self, err: impl Into<String>) -> Self {
        self.error = Some(err.into());
        self
    }

    pub fn with_duration(mut self, ms: u64) -> Self {
        self.duration_ms = Some(ms);
        self
    }

    pub fn with_status(mut self, code: u16) -> Self {
        self.status_code = Some(code);
        self
    }
}

fn now_iso() -> String {
    use time::format_description::well_known::Iso8601;
    use time::OffsetDateTime;
    OffsetDateTime::now_utc()
        .format(&Iso8601::DEFAULT)
        .unwrap_or_else(|_| String::from("unknown"))
}

/// Path to the current audit log for a brain.
fn audit_path(brain_id: &str) -> PathBuf {
    brain_dir(brain_id).join("audit.jsonl")
}

/// Path to a rotated backup file `audit.<n>.jsonl`.
fn rotated_path(brain_id: &str, n: u32) -> PathBuf {
    brain_dir(brain_id).join(format!("audit.{}.jsonl", n))
}

/// Append one entry to `<brain>/audit.jsonl`. Best-effort: logs to
/// stderr and returns Ok on filesystem errors so a failing audit can
/// never break the underlying tool call. The only Err returned is
/// for serialisation failure, which would indicate a programmer bug
/// (an `AuditEntry` field that can't be JSON-encoded).
pub fn append(brain_id: &str, entry: &AuditEntry) -> Result<()> {
    let line = serde_json::to_string(entry)
        .map_err(|e| super::types::MemoryError::Other(format!("audit serialise: {}", e)))?;

    let path = audit_path(brain_id);
    if let Err(e) = maybe_rotate(brain_id, &path) {
        eprintln!(
            "[tool_audit] rotate check failed for {}: {} (continuing)",
            brain_id, e
        );
    }

    match OpenOptions::new().create(true).append(true).open(&path) {
        Ok(mut f) => {
            // One write per line keeps half-written records out of the
            // file. OS-level append is atomic for writes smaller than
            // PIPE_BUF; our lines are well under that.
            if let Err(e) = writeln!(f, "{}", line) {
                eprintln!(
                    "[tool_audit] write failed for {}: {} (entry lost)",
                    brain_id, e
                );
            }
        }
        Err(e) => {
            eprintln!(
                "[tool_audit] open failed for {}: {} (entry lost)",
                brain_id, e
            );
        }
    }
    Ok(())
}

/// Read the most recent `limit` entries from the audit log, newest
/// first. Truncated entries are skipped. Missing file returns empty.
pub fn recent(brain_id: &str, limit: usize) -> Result<Vec<AuditEntry>> {
    let path = audit_path(brain_id);
    if !path.exists() {
        return Ok(Vec::new());
    }
    // Read the whole file and tail. For a 10 MB cap this is at most
    // ~40k entries — under 50 ms on a warm disk and trivial RAM.
    // Tailing properly (seeking from the end + reading line-by-line
    // backward) would matter if we let the file grow unbounded, but
    // rotation makes it not worth the complexity here.
    let raw = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[tool_audit] read failed for {}: {}", brain_id, e);
            return Ok(Vec::new());
        }
    };
    let mut out: Vec<AuditEntry> = Vec::with_capacity(limit);
    for line in raw.lines().rev() {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<AuditEntry>(line) {
            Ok(e) => out.push(e),
            Err(_) => {} // skip corrupt rows silently
        }
        if out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

/// Rotate `audit.jsonl → audit.1.jsonl` (shifting existing numbered
/// files down) when the current file exceeds `ROTATION_BYTES`. Backups
/// beyond `ROTATION_KEEP` get deleted.
fn maybe_rotate(brain_id: &str, current: &PathBuf) -> std::io::Result<()> {
    let meta = match fs::metadata(current) {
        Ok(m) => m,
        Err(_) => return Ok(()), // file doesn't exist yet, nothing to rotate
    };
    if meta.len() < ROTATION_BYTES {
        return Ok(());
    }
    // Walk from the highest-numbered file down so renames don't
    // collide. `audit.5.jsonl` -> deleted, `.4.jsonl` -> `.5.jsonl`,
    // ..., `audit.jsonl` -> `audit.1.jsonl`.
    let oldest = rotated_path(brain_id, ROTATION_KEEP);
    if oldest.exists() {
        fs::remove_file(&oldest)?;
    }
    for n in (1..ROTATION_KEEP).rev() {
        let from = rotated_path(brain_id, n);
        let to = rotated_path(brain_id, n + 1);
        if from.exists() {
            fs::rename(from, to)?;
        }
    }
    fs::rename(current, rotated_path(brain_id, 1))?;
    Ok(())
}
