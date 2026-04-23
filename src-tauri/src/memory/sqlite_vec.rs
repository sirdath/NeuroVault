//! Loader for the `sqlite-vec` SQLite extension.
//!
//! Python's side of the house uses the `sqlite-vec` PyPI package which
//! ships the compiled extension inside the wheel. Rust has to find the
//! same binary at runtime — we don't vendor a second copy because the
//! user already has one on disk from a prior Python install. Candidate
//! locations, in order:
//!
//! 1. `$NEUROVAULT_VEC_EXTENSION` — explicit override for dev setups
//! 2. `<exe_dir>/vec0.(dll|dylib|so)` — bundled beside neurovault.exe
//! 3. `<exe_dir>/sqlite_vec/vec0.(dll|dylib|so)` — bundled subdir
//! 4. `~/.neurovault/extensions/vec0.(dll|dylib|so)` — user-installed
//!
//! If none of those exist we return `ExtensionNotFound` so the caller
//! can bail out with a clear error instead of a cryptic `no such
//! function: vec_version` from the first query that needs it.
//!
//! `LoadExtensionGuard` wraps `enable_load_extension(true)` /
//! `enable_load_extension(false)` in a RAII guard — disabling extension
//! loading after the one we care about has been pulled in is a small
//! bit of defense against a user-authored SQL query later trying to
//! load something nasty off disk.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, LoadExtensionGuard};

use super::paths::nv_home;
use super::types::{MemoryError, Result};

/// Filename the sqlite-vec project ships, minus the platform-specific
/// dynamic-library extension. Matches what `sqlite_vec.load()` on the
/// Python side resolves to.
const EXTENSION_STEM: &str = "vec0";

/// Platform-specific suffix for dynamic libraries. Kept as a const so
/// we only branch on `cfg!` once, at module scope, instead of per call.
#[cfg(target_os = "windows")]
const EXTENSION_SUFFIX: &str = "dll";
#[cfg(target_os = "macos")]
const EXTENSION_SUFFIX: &str = "dylib";
#[cfg(all(unix, not(target_os = "macos")))]
const EXTENSION_SUFFIX: &str = "so";

fn with_suffix(stem: &str) -> String {
    format!("{}.{}", stem, EXTENSION_SUFFIX)
}

/// Build the ordered list of paths we'll try, expanding env vars and
/// derived directories. Returns `PathBuf` candidates even if they
/// don't exist on disk — the caller is the one that checks existence
/// so we can log the full candidate list on failure.
fn candidate_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let filename = with_suffix(EXTENSION_STEM);

    if let Ok(explicit) = std::env::var("NEUROVAULT_VEC_EXTENSION") {
        if !explicit.is_empty() {
            out.push(PathBuf::from(explicit));
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            out.push(dir.join(&filename));
            out.push(dir.join("sqlite_vec").join(&filename));
            // Tauri's `bundle.resources` array drops files into a
            // `resources/` subdirectory next to the exe — that's
            // where the installed build ships `vec0.dll` from.
            out.push(dir.join("resources").join(&filename));
            // For `cargo run` + `tauri dev` the exe lives in
            // target/debug or target/release; the repo's bundled
            // copy sits at `src-tauri/resources/vec0.dll` which
            // resolves to this relative path.
            out.push(dir.join("..").join("..").join("src-tauri").join("resources").join(&filename));
        }
    }

    out.push(nv_home().join("extensions").join(&filename));

    out
}

/// Load the extension into `conn`. On success the `vec0`, `vec_version`
/// and virtual-table constructors become available for the lifetime of
/// the connection. Called once per `Connection::open` in `db::open`.
pub fn load(conn: &Connection) -> Result<()> {
    let candidates = candidate_paths();
    let chosen = candidates.iter().find(|p| Path::new(p).exists()).cloned();

    let path = match chosen {
        Some(p) => p,
        None => {
            let list = candidates
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", ");
            return Err(MemoryError::Other(format!(
                "sqlite-vec extension '{}' not found in any candidate location: [{}]. \
                 Set NEUROVAULT_VEC_EXTENSION or drop the library into \
                 ~/.neurovault/extensions/",
                with_suffix(EXTENSION_STEM),
                list,
            )));
        }
    };

    // SAFETY: LoadExtensionGuard + load_extension require unsafe because
    // the extension runs native code inside the SQLite process. We trust
    // the user-installed sqlite-vec binary; the override env var is opt-
    // in and the fallback paths are user-writable by design.
    unsafe {
        let _guard = LoadExtensionGuard::new(conn)?;
        // Entry point defaults (`sqlite3_vec_init`) — passing `None`
        // tells SQLite to derive the entry symbol from the filename,
        // which matches what Python's `sqlite_vec.load()` does.
        conn.load_extension(&path, None)?;
    }
    Ok(())
}

/// Report the loaded extension's version string. Useful for logging on
/// startup and as a smoke test that the extension actually took.
pub fn version(conn: &Connection) -> Result<String> {
    let v: String = conn.query_row("SELECT vec_version()", [], |r| r.get(0))?;
    Ok(v)
}
