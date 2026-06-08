//! Append-only audit log for the external API gateway.
//!
//! Audit log for the optional external API gateway. Separate from the per-brain
//! audit.jsonl so external traffic is triageable independently.
//!
//! Format: one JSON object per line (ndjson). Fields:
//!   ts            ISO-8601 UTC of request start
//!   key_id        AuthedKey id (or null on failed auth)
//!   method        HTTP verb
//!   path          matched route template (e.g. /v1/notes/:engram_id)
//!   status        HTTP status code
//!   brain         the ?brain= query param if present (else null)
//!   ip            best-effort remote IP from the connection
//!   duration_ms   wall-clock from request entry to response exit
//!
//! Storage: `~/.neurovault/api_audit.jsonl`. Rotation at 10 MB →
//! moves to `api_audit.1.jsonl`, shifting prior numbered files
//! down. We keep the last 5 numbered files; older ones get
//! deleted.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use once_cell::sync::OnceCell;
use serde::Serialize;

use super::paths::nv_home;

const ROTATE_BYTES: u64 = 10 * 1024 * 1024; // 10 MB
const KEEP_ROTATIONS: usize = 5;

/// Path to the active audit file.
pub fn audit_path() -> PathBuf {
    nv_home().join("api_audit.jsonl")
}

fn rotated_path(n: usize) -> PathBuf {
    nv_home().join(format!("api_audit.{}.jsonl", n))
}

/// One audit record. Public — handlers + middleware build these
/// and pass them through `record` for persistence.
#[derive(Clone, Debug, Serialize)]
pub struct AuditEntry {
    pub ts: String,
    pub key_id: Option<String>,
    pub method: String,
    pub path: String,
    pub status: u16,
    pub brain: Option<String>,
    pub ip: Option<String>,
    pub duration_ms: u64,
}

/// Serialise `entry` as a single JSON line and append. Best-effort
/// — if the write fails we log to stderr and continue. Audit
/// failure must NEVER 500 the request that produced it.
pub fn record(entry: &AuditEntry) {
    if let Err(e) = record_inner(entry) {
        eprintln!("[api_audit] write failed: {}", e);
    }
}

fn record_inner(entry: &AuditEntry) -> std::io::Result<()> {
    let line = match serde_json::to_string(entry) {
        Ok(s) => s,
        Err(e) => return Err(std::io::Error::new(std::io::ErrorKind::Other, e)),
    };

    // Mutex serialises concurrent writes. The append happens under
    // the lock so the file never sees interleaved partial lines.
    static MUTEX: OnceCell<Mutex<()>> = OnceCell::new();
    let m = MUTEX.get_or_init(|| Mutex::new(()));
    let _guard = m.lock().expect("api_audit mutex poisoned");

    let path = audit_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    // Rotate if the active file is at or over the cap.
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() >= ROTATE_BYTES {
            rotate(&path);
        }
    }

    let mut f = OpenOptions::new().create(true).append(true).open(&path)?;
    f.write_all(line.as_bytes())?;
    f.write_all(b"\n")?;
    Ok(())
}

/// Cascade rename: api_audit.4.jsonl → 5, 3 → 4, …, 1 → 2,
/// active → 1. The oldest (numbered KEEP_ROTATIONS) is deleted
/// before the cascade so we cap disk use.
fn rotate(active: &PathBuf) {
    // Drop the oldest if it would overflow the keep window.
    let oldest = rotated_path(KEEP_ROTATIONS);
    let _ = fs::remove_file(&oldest);

    // Shift each numbered file one slot up.
    for n in (1..KEEP_ROTATIONS).rev() {
        let from = rotated_path(n);
        let to = rotated_path(n + 1);
        if from.exists() {
            let _ = fs::rename(&from, &to);
        }
    }

    // Move the active log into the .1 slot.
    let _ = fs::rename(active, rotated_path(1));
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entry_serialises_with_expected_fields() {
        let e = AuditEntry {
            ts: "2026-05-06T12:00:00Z".to_string(),
            key_id: Some("key_abc123".to_string()),
            method: "POST".to_string(),
            path: "/v1/notes".to_string(),
            status: 201,
            brain: Some("default".to_string()),
            ip: Some("192.168.1.1".to_string()),
            duration_ms: 42,
        };
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"ts\":\"2026-05-06T12:00:00Z\""));
        assert!(json.contains("\"key_id\":\"key_abc123\""));
        assert!(json.contains("\"status\":201"));
        assert!(json.contains("\"duration_ms\":42"));
    }

    #[test]
    fn null_key_id_serialises() {
        let e = AuditEntry {
            ts: "2026-05-06T12:00:00Z".to_string(),
            key_id: None,
            method: "GET".to_string(),
            path: "/v1/status".to_string(),
            status: 401,
            brain: None,
            ip: None,
            duration_ms: 1,
        };
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"key_id\":null"));
    }
}
