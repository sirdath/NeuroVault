//! Canonical path helpers for the Rust memory layer.
//!
//! Ports the filesystem conventions `server/neurovault_server/config.py`
//! established — same `~/.neurovault/` root, same `brains/{id}/` layout,
//! same `brain.db` / `vault/` / `audit.jsonl` filenames. The Python
//! side keeps working throughout the migration because we write to the
//! exact same paths it's expecting.
//!
//! `NEUROVAULT_HOME` env var override is honored (the Python config
//! respects it for dev-bench isolation; Rust does too so dev setups
//! stay symmetric across runtimes).

use std::env;
use std::path::PathBuf;

/// Root directory for all NeuroVault state. Matches
/// `config.py::NEUROVAULT_HOME` including the env override.
///
/// Resolution order:
/// 1. `$NEUROVAULT_HOME` if set
/// 2. `$ENGRAM_HOME` if set (legacy — mirrors Python's backward-compat
///    shim; emits no warning from Rust because the message belongs to
///    the CLI/subprocess layer, not the core library)
/// 3. `%USERPROFILE%\.neurovault` on Windows / `~/.neurovault`
///    elsewhere via the `dirs` crate
pub fn nv_home() -> PathBuf {
    if let Ok(explicit) = env::var("NEUROVAULT_HOME") {
        if !explicit.is_empty() {
            return PathBuf::from(explicit);
        }
    }
    if let Ok(legacy) = env::var("ENGRAM_HOME") {
        if !legacy.is_empty() {
            return PathBuf::from(legacy);
        }
    }
    dirs::home_dir()
        .map(|h| h.join(".neurovault"))
        // If we can't resolve a home dir at all we fall back to the
        // working directory. This should never happen in normal
        // installs but stops the library from panicking at import
        // time on exotic CI setups.
        .unwrap_or_else(|| PathBuf::from(".neurovault"))
}

/// Directory that holds every brain's per-brain state.
pub fn brains_root() -> PathBuf {
    nv_home().join("brains")
}

/// Path to `~/.neurovault/brains.json` — the registry the Rust side
/// already reads via `list_brains_offline` / `set_active_brain_offline`
/// in `lib.rs`. Centralising it here so the memory module doesn't
/// duplicate the string literal.
pub fn registry_path() -> PathBuf {
    nv_home().join("brains.json")
}

/// Per-brain directory containing `brain.db`, `vault/`, `audit.jsonl`,
/// `trash/`, etc. Matches the layout BrainManager creates in Python.
pub fn brain_dir(brain_id: &str) -> PathBuf {
    brains_root().join(brain_id)
}

/// Per-brain SQLite database path. Rust and Python both open this
/// file; WAL mode + shared-cache lets them coexist safely during the
/// migration window.
pub fn db_path(brain_id: &str) -> PathBuf {
    brain_dir(brain_id).join("brain.db")
}

/// Default internal vault directory. For brains with an external
/// `vault_path` in `brains.json`, the caller resolves that override
/// separately via the registry; this helper just returns the
/// canonical internal location.
pub fn vault_dir(brain_id: &str) -> PathBuf {
    brain_dir(brain_id).join("vault")
}

/// Append-only audit log per brain. Python's `audit.py` writes to
/// this same file; Rust will appendin the same JSONL format once
/// the HTTP server lands in Phase 6.
pub fn audit_path(brain_id: &str) -> PathBuf {
    brain_dir(brain_id).join("audit.jsonl")
}

/// Raw drop-folder for a brain: `~/.neurovault/brains/{id}/raw`.
/// Karpathy-style raw layer — paste arbitrary documents here (PDFs,
/// exports, transcripts) and the connected Claude agent reads them over
/// MCP, writes cleaned `.md` notes into `vault/`, then marks each raw
/// file done. The folder is NOT watched/ingested — only the vault is —
/// so binaries sit here safely until the agent processes them. A seeded
/// `README.md` guide explains the workflow (see `inbox::ensure_raw_dir`).
pub fn inbox_dir(brain_id: &str) -> PathBuf {
    brain_dir(brain_id).join("raw")
}

/// Where processed raw files are moved once the agent has turned them
/// into a note. Keeps the raw listing clean without deleting the user's
/// original file. `~/.neurovault/brains/{id}/raw/_done`.
pub fn inbox_done_dir(brain_id: &str) -> PathBuf {
    inbox_dir(brain_id).join("_done")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_override_wins_over_default() {
        // We can't mutate env vars safely inside a parallel test run,
        // so this is just a smoke test that nv_home returns a path
        // that looks reasonable. The real override behaviour is
        // covered by integration tests in Phase 2 when we actually
        // open a test-owned brain.db.
        let p = nv_home();
        assert!(p.is_absolute() || p == std::path::Path::new(".neurovault"));
    }

    #[test]
    fn brain_dir_is_under_brains_root() {
        let d = brain_dir("test-brain");
        assert!(d.ends_with("brains/test-brain") || d.ends_with("brains\\test-brain"));
    }

    // Asserted from ONE db_path() call on purpose. This used to also call
    // brain_dir() and assert db.starts_with(brain_dir) -- but both resolve
    // through nv_home(), which reads $NEUROVAULT_HOME at call time. Sibling
    // tests (journal, consolidate, proposals, retriever) set and remove that
    // var, and cargo runs tests as parallel threads sharing one process
    // environment, so a flip landing between the two reads resolved them
    // against different roots and failed the assert at random. Same invariant,
    // no race.
    #[test]
    fn db_path_sits_inside_brain_dir() {
        let db = db_path("test-brain");
        assert_eq!(db.file_name().and_then(|s| s.to_str()), Some("brain.db"));
        let parent = db.parent().expect("db path must have a parent dir");
        assert!(parent.ends_with("brains/test-brain") || parent.ends_with("brains\\test-brain"));
    }
}
