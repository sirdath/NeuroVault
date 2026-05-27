//! Drop-folder inbox: a staging area where users dump arbitrary files
//! for the connected Claude agent to turn into clean `.md` notes.
//!
//! Flow:
//!   1. User drops files (UI drag-drop or by hand) → they land in
//!      `~/.neurovault/brains/{id}/_inbox/` (see [`paths::inbox_dir`]).
//!   2. The agent, over MCP, calls `list_inbox` / `read_inbox_file` to
//!      see what's waiting and read its contents (or the absolute path,
//!      for binaries it wants to open with its own tools).
//!   3. The agent writes a cleaned note into the vault via the normal
//!      `remember` / save-note path; the vault watcher indexes it.
//!   4. The agent calls `mark_done` to move the raw file into
//!      `_inbox/_done/` so it stops showing up as pending.
//!
//! The inbox is deliberately NOT watched or auto-ingested — only the
//! vault is. That keeps binaries (PDFs, images) from ever hitting the
//! `.md`-only ingest pipeline; they wait here until the agent handles
//! them. No converters are bundled.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::paths::{inbox_dir, inbox_done_dir};
use super::types::{MemoryError, Result};

/// Largest text payload we'll inline in `read_inbox_file`. Bigger files
/// still return their path + size so the agent can open them directly;
/// we just don't shove a megabyte of text through the MCP boundary.
const MAX_INLINE_TEXT_BYTES: u64 = 256 * 1024;

/// One pending file in the inbox listing.
#[derive(Debug, Clone, Serialize)]
pub struct InboxFile {
    /// File name (no directory component).
    pub name: String,
    /// Size in bytes.
    pub size: u64,
    /// Lowercased extension without the dot (e.g. "pdf", "md", ""}.
    pub ext: String,
    /// Absolute path on disk — handy for the agent to open binaries
    /// with its own file tools rather than via `read_inbox_file`.
    pub path: String,
}

/// Contents of a single inbox file.
#[derive(Debug, Clone, Serialize)]
pub struct InboxFileContent {
    pub name: String,
    pub path: String,
    pub size: u64,
    /// Best-effort UTF-8 text. `None` when the file looks binary or is
    /// larger than [`MAX_INLINE_TEXT_BYTES`] — use `path` in that case.
    pub text: Option<String>,
    /// True when we couldn't decode the bytes as UTF-8 text.
    pub is_binary: bool,
    /// True when the file was too large to inline (text omitted by size,
    /// not by content).
    pub truncated: bool,
}

/// Reject anything that isn't a plain file name — no separators, no
/// parent-dir hops. Inbox names always refer to a file directly inside
/// the inbox dir, never a path. Defends the MCP-exposed read/done ops
/// against traversal.
fn safe_name(name: &str) -> Result<String> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
        || Path::new(trimmed).file_name().map(|f| f != trimmed).unwrap_or(true)
    {
        return Err(MemoryError::Other(format!("invalid inbox file name: {name:?}")));
    }
    Ok(trimmed.to_string())
}

fn ext_of(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default()
}

/// List pending files in a brain's inbox. Skips the `_done` subdir and
/// any dotfiles. Returns an empty vec (not an error) when the inbox
/// doesn't exist yet.
pub fn list_inbox(brain_id: &str) -> Result<Vec<InboxFile>> {
    let dir = inbox_dir(brain_id);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        let path = entry.path();
        // Skip the _done subdir and any other directories.
        if path.is_dir() {
            continue;
        }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if name.starts_with('.') {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        out.push(InboxFile {
            ext: ext_of(&path),
            size,
            path: path.to_string_lossy().to_string(),
            name,
        });
    }
    // Stable, name-sorted ordering so the listing is deterministic.
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Read one inbox file. Returns inline UTF-8 text for reasonably-sized
/// text files; otherwise leaves `text` empty and flags `is_binary` /
/// `truncated` so the caller knows to open the `path` directly.
pub fn read_inbox_file(brain_id: &str, name: &str) -> Result<InboxFileContent> {
    let name = safe_name(name)?;
    let path = inbox_dir(brain_id).join(&name);
    if !path.is_file() {
        return Err(MemoryError::Other(format!("inbox file not found: {name}")));
    }
    let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let path_str = path.to_string_lossy().to_string();

    if size > MAX_INLINE_TEXT_BYTES {
        return Ok(InboxFileContent {
            name,
            path: path_str,
            size,
            text: None,
            is_binary: false,
            truncated: true,
        });
    }
    let bytes = fs::read(&path)?;
    match String::from_utf8(bytes) {
        Ok(text) => Ok(InboxFileContent {
            name,
            path: path_str,
            size,
            text: Some(text),
            is_binary: false,
            truncated: false,
        }),
        Err(_) => Ok(InboxFileContent {
            name,
            path: path_str,
            size,
            text: None,
            is_binary: true,
            truncated: false,
        }),
    }
}

/// Move a processed file from the inbox into `_inbox/_done/`. Idempotent:
/// a missing source is treated as already-done (no error) so an agent
/// retrying the call doesn't blow up. On a name collision in `_done`,
/// suffixes the destination so nothing is overwritten.
pub fn mark_done(brain_id: &str, name: &str) -> Result<()> {
    let name = safe_name(name)?;
    let src = inbox_dir(brain_id).join(&name);
    if !src.exists() {
        return Ok(());
    }
    let done = inbox_done_dir(brain_id);
    fs::create_dir_all(&done)?;
    let dest = unique_dest(&done, &name);
    // rename() fails across devices on some platforms; fall back to copy+remove.
    if fs::rename(&src, &dest).is_err() {
        fs::copy(&src, &dest)?;
        fs::remove_file(&src)?;
    }
    Ok(())
}

/// Copy external files (given by absolute path, e.g. from a UI file-drop)
/// into the brain's inbox. Creates the inbox dir on first use. Returns
/// the final names landed in the inbox (post collision-resolution).
/// Skips silently-missing sources but errors on a genuine copy failure.
pub fn add_files(brain_id: &str, src_paths: &[String]) -> Result<Vec<String>> {
    let dir = inbox_dir(brain_id);
    fs::create_dir_all(&dir)?;
    let mut added = Vec::new();
    for src in src_paths {
        let src_path = PathBuf::from(src);
        if !src_path.is_file() {
            continue; // dropped a folder or a vanished path — skip it.
        }
        let base = match src_path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        let dest = unique_dest(&dir, &base);
        fs::copy(&src_path, &dest)?;
        if let Some(n) = dest.file_name().and_then(|n| n.to_str()) {
            added.push(n.to_string());
        }
    }
    Ok(added)
}

/// Resolve a non-colliding destination path inside `dir` for `name`,
/// suffixing `-1`, `-2`, … before the extension as needed.
fn unique_dest(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let p = Path::new(name);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or(name);
    let ext = p.extension().and_then(|e| e.to_str());
    for n in 1..10_000 {
        let next = match ext {
            Some(e) => format!("{stem}-{n}.{e}"),
            None => format!("{stem}-{n}"),
        };
        let candidate = dir.join(&next);
        if !candidate.exists() {
            return candidate;
        }
    }
    // Pathological fallback — 10k collisions. Overwrite the last one.
    dir.join(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_name_rejects_traversal() {
        assert!(safe_name("../etc/passwd").is_err());
        assert!(safe_name("a/b.md").is_err());
        assert!(safe_name("a\\b.md").is_err());
        assert!(safe_name("").is_err());
        assert!(safe_name("notes.md").is_ok());
    }
}
