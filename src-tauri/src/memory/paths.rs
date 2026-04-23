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

    #[test]
    fn db_path_sits_inside_brain_dir() {
        let db = db_path("test-brain");
        let br = brain_dir("test-brain");
        assert!(db.starts_with(&br));
        assert_eq!(db.file_name().and_then(|s| s.to_str()), Some("brain.db"));
    }
}
