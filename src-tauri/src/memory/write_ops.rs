//! Write-path helpers: create / save / delete a note end-to-end.
//!
//! Unlike read_ops.rs, these functions don't just hit the DB — they
//! also touch the filesystem (write + move-to-trash) because the
//! vault is the user-facing source of truth. The order matters:
//!
//!   create → write file → ingest (DB catches up)
//!   save   → write file → ingest (DB catches up)
//!   delete → ingest soft-delete → move file to trash
//!
//! On `delete`, we soft-delete first so a crash between steps leaves
//! the user's file on disk rather than orphaning the DB row — we'd
//! rather replay the ingest next boot than lose the content.
//!
//! `BrainContext` bundles the handle + vault path so Tauri commands
//! resolve the brain once up-front, then hand the context down.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use rusqlite::OptionalExtension;
use slug::slugify;

use super::db::{open_brain, BrainDb};
use super::ingest;
use super::paths::registry_path;
use super::read_ops::resolve_brain_id;
use super::types::{MemoryError, Result, SourceFolder};

/// Serialises native Markdown mutation with its in-process ingest. The Store
/// UI deliberately indexes beside the editor; without this boundary a slow
/// startup embedding pass could commit an older file body after a newer save.
pub(crate) static NOTE_MUTATION_LOCK: Lazy<parking_lot::Mutex<()>> =
    Lazy::new(|| parking_lot::Mutex::new(()));

/// Convenience bundle — brain id + open DB handle + vault path.
/// Every write command resolves this once, then uses it for both
/// filesystem and DB work.
pub struct BrainContext {
    pub brain_id: String,
    pub db: Arc<BrainDb>,
    pub vault: PathBuf,
}

impl BrainContext {
    pub fn resolve(brain_id: Option<&str>, vault: PathBuf) -> Result<Self> {
        let id = resolve_brain_id(brain_id)?;
        // Creation/import owns directory creation. Resolution must never turn
        // a deleted or damaged registered library into a plausible empty one.
        if !vault.is_dir() {
            return Err(MemoryError::Other(format!(
                "vault directory is missing for registered brain {id:?}: {}",
                vault.display()
            )));
        }
        let db = open_brain(&id)?;
        Ok(Self {
            brain_id: id,
            db,
            vault,
        })
    }
}

/// Result of a create/save op — what the frontend needs to update
/// its stores + optionally navigate to the new note.
#[derive(Debug, Clone, serde::Serialize)]
pub struct WriteResult {
    pub engram_id: String,
    pub filename: String,
    pub brain_id: String,
    /// `"created"` on first ingest, `"updated"` on subsequent
    /// saves, `"unchanged"` when the content hash matches what's
    /// already in the DB (we still rewrote the file because the
    /// caller asked us to, but ingest was a no-op).
    pub status: String,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
pub struct IndexFileError {
    pub filename: String,
    pub error: String,
}

/// Truthful result for a native vault rescan. `failed` is the total number of
/// failures even when the bounded `errors` list has omitted repetitive detail.
#[derive(Debug, Clone, Default, serde::Serialize, PartialEq, Eq)]
pub struct IndexBrainResult {
    pub scanned: u32,
    pub indexed: u32,
    pub unchanged: u32,
    pub failed: u32,
    pub errors: Vec<IndexFileError>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TrashEntry {
    /// Current leaf name inside the per-brain trash directory.
    pub trashed_filename: String,
    /// Vault-relative path the note occupied before deletion. Legacy trash
    /// entries without metadata fall back to the trash leaf at vault root.
    pub original_filename: String,
    pub title: String,
    pub deleted_at: u64,
    pub size: u64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct TrashMetadata {
    original_filename: String,
    deleted_at: u64,
}

fn trash_dir(ctx: &BrainContext) -> PathBuf {
    ctx.vault
        .parent()
        .map(|p| p.join("trash"))
        .unwrap_or_else(|| ctx.vault.join(".trash"))
}

fn unix_seconds_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn trash_metadata_path(note_path: &Path) -> PathBuf {
    let leaf = note_path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "note.md".to_string());
    note_path.with_file_name(format!("{leaf}.neurovault-trash.json"))
}

pub fn is_safe_markdown_relative_path(filename: &str) -> bool {
    let path = Path::new(filename);
    !filename.is_empty()
        && !filename.contains('\0')
        && !filename.contains('\\')
        && !path.is_absolute()
        && path.extension().and_then(|ext| ext.to_str()) == Some("md")
        && path
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
}

fn title_from_markdown(content: &str, filename: &str) -> String {
    content
        .lines()
        .find_map(|line| line.trim().strip_prefix("# ").map(str::trim))
        .filter(|title| !title.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            Path::new(filename)
                .file_stem()
                .map(|stem| stem.to_string_lossy().replace('-', " "))
                .unwrap_or_else(|| filename.to_string())
        })
}

fn durable_markdown_index_error(filename: &str, error: impl std::fmt::Display) -> MemoryError {
    MemoryError::Other(format!(
        "The Markdown file was saved and remains the durable source of truth at {filename:?}, \
         but NeuroVault could not update its search index: {error}. Retry the save or run \
         reindex after the embedding model is available."
    ))
}

fn atomic_write(path: &Path, content: &str) -> Result<()> {
    let parent = path.parent().ok_or_else(|| {
        MemoryError::Other(format!("note path has no parent: {}", path.display()))
    })?;
    let tmp = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .map(|name| name.to_string_lossy())
            .unwrap_or_default(),
        uuid::Uuid::new_v4()
    ));
    if let Err(error) = std::fs::write(&tmp, content) {
        let _ = std::fs::remove_file(&tmp);
        return Err(MemoryError::Io(error));
    }
    if let Err(error) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(MemoryError::Io(error));
    }
    Ok(())
}

/// Move a regular file without ever replacing an existing destination.
/// `std::fs::rename` overwrites on Unix, so an `exists()` preflight alone is
/// racy. A hard link publishes the destination atomically with create-new
/// semantics; unlinking the source then completes the move on the same vault
/// volume. If unlinking fails, the new link is removed and the source stays.
fn move_file_without_overwrite(source: &Path, destination: &Path) -> Result<()> {
    if let Err(link_error) = std::fs::hard_link(source, destination) {
        if link_error.kind() == std::io::ErrorKind::AlreadyExists {
            return Err(MemoryError::Other(format!(
                "refusing to overwrite existing note at {}",
                destination.display()
            )));
        }

        // External direct-distribution vaults may live on exFAT, SMB, or
        // other volumes without hard-link support. Preserve the same
        // create-new guarantee with an exclusive copy fallback.
        let mut input = std::fs::File::open(source)?;
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)
            .map_err(|copy_error| {
                MemoryError::Other(format!(
                    "could not move {} to {} without overwriting (hard link: {link_error}; exclusive copy: {copy_error})",
                    source.display(),
                    destination.display()
                ))
            })?;
        if let Err(copy_error) =
            std::io::copy(&mut input, &mut output).and_then(|_| output.sync_all())
        {
            drop(output);
            let _ = std::fs::remove_file(destination);
            return Err(MemoryError::Other(format!(
                "could not copy {} to {} safely: {copy_error}",
                source.display(),
                destination.display()
            )));
        }
        drop(output);
    }
    if let Err(error) = std::fs::remove_file(source) {
        let rollback = std::fs::remove_file(destination);
        return Err(MemoryError::Other(match rollback {
            Ok(()) => format!(
                "could not finish moving {} to {}: {error}; the original file was kept",
                source.display(),
                destination.display()
            ),
            Err(rollback_error) => format!(
                "could not finish moving {} to {}: {error}; both names now exist and cleanup failed: {rollback_error}",
                source.display(),
                destination.display()
            ),
        }));
    }
    Ok(())
}

fn markdown_with_title(content: &str, title: &str) -> String {
    let mut replaced = false;
    let mut lines = content
        .split_inclusive('\n')
        .map(|line| {
            if !replaced && line.trim_end_matches(['\r', '\n']).trim().starts_with("# ") {
                replaced = true;
                if line.ends_with("\r\n") {
                    format!("# {title}\r\n")
                } else if line.ends_with('\n') {
                    format!("# {title}\n")
                } else {
                    format!("# {title}")
                }
            } else {
                line.to_string()
            }
        })
        .collect::<String>();
    if !replaced {
        lines = if content.is_empty() {
            format!("# {title}\n\n")
        } else {
            format!("# {title}\n\n{content}")
        };
    }
    lines
}

fn checked_vault_path(ctx: &BrainContext, filename: &str, create_parent: bool) -> Result<PathBuf> {
    if !is_safe_markdown_relative_path(filename) {
        return Err(MemoryError::Other(format!(
            "refusing to address a note outside the vault: {filename:?} must be a relative .md path with no `..` segments"
        )));
    }

    let vault = std::fs::canonicalize(&ctx.vault).map_err(|error| {
        MemoryError::Other(format!(
            "could not resolve vault {}: {error}",
            ctx.vault.display()
        ))
    })?;
    let relative = Path::new(filename);
    let mut resolved_parent = vault.clone();
    for component in relative
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .components()
    {
        let Component::Normal(segment) = component else {
            return Err(MemoryError::Other(format!(
                "unsafe note folder in {filename:?}"
            )));
        };
        let candidate = resolved_parent.join(segment);
        match std::fs::symlink_metadata(&candidate) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(MemoryError::Other(format!(
                    "refusing to follow a symbolic-link folder in {filename:?}"
                )))
            }
            Ok(metadata) if !metadata.is_dir() => {
                return Err(MemoryError::Other(format!(
                    "note folder is not a directory in {filename:?}"
                )))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && create_parent => {
                std::fs::create_dir(&candidate)?;
            }
            Err(error) => {
                return Err(MemoryError::Other(format!(
                    "could not resolve note folder {}: {error}",
                    candidate.display()
                )))
            }
        }
        resolved_parent = std::fs::canonicalize(&candidate)?;
        if !resolved_parent.starts_with(&vault) {
            return Err(MemoryError::Other(format!(
                "refusing to follow a note folder outside the vault: {filename:?}"
            )));
        }
    }
    let leaf = relative
        .file_name()
        .ok_or_else(|| MemoryError::Other(format!("note path has no filename: {filename:?}")))?;
    Ok(resolved_parent.join(leaf))
}

/// Read one regular Markdown file after proving its relative path and every
/// resolved component remain inside the selected vault.
pub fn read_note_content(ctx: &BrainContext, filename: &str) -> Result<String> {
    let path = checked_vault_path(ctx, filename, false)?;
    let metadata = std::fs::symlink_metadata(&path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(MemoryError::Other(format!(
            "refusing to read a non-regular Markdown file at {filename:?}"
        )));
    }
    let vault = std::fs::canonicalize(&ctx.vault)?;
    let resolved = std::fs::canonicalize(&path)?;
    if !resolved.starts_with(&vault) {
        return Err(MemoryError::Other(format!(
            "refusing to follow a note path outside the vault: {filename:?}"
        )));
    }
    Ok(std::fs::read_to_string(path)?)
}

pub fn list_trash(ctx: &BrainContext) -> Result<Vec<TrashEntry>> {
    let dir = trash_dir(ctx);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut entries = Vec::new();
    for item in std::fs::read_dir(&dir)? {
        let item = item?;
        let path = item.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("md") || !path.is_file() {
            continue;
        }
        let trashed_filename = item.file_name().to_string_lossy().to_string();
        let file_meta = item.metadata()?;
        let fallback_deleted_at = file_meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs())
            .unwrap_or_default();
        let trash_meta: Option<TrashMetadata> = std::fs::read(trash_metadata_path(&path))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok());
        let original_filename = trash_meta
            .as_ref()
            .map(|meta| meta.original_filename.clone())
            .filter(|name| is_safe_markdown_relative_path(name))
            .unwrap_or_else(|| trashed_filename.clone());
        let deleted_at = trash_meta
            .as_ref()
            .map(|meta| meta.deleted_at)
            .unwrap_or(fallback_deleted_at);
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        entries.push(TrashEntry {
            trashed_filename: trashed_filename.clone(),
            original_filename: original_filename.clone(),
            title: title_from_markdown(&content, &original_filename),
            deleted_at,
            size: file_meta.len(),
        });
    }
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.deleted_at));
    Ok(entries)
}

pub fn restore_note(ctx: &BrainContext, trashed_filename: &str) -> Result<WriteResult> {
    let _guard = NOTE_MUTATION_LOCK.lock();
    restore_note_locked(ctx, trashed_filename)
}

fn restore_note_locked(ctx: &BrainContext, trashed_filename: &str) -> Result<WriteResult> {
    // Only a leaf may address the trash directory. This prevents traversal
    // even if a compromised webview invokes the command directly.
    if Path::new(trashed_filename)
        .file_name()
        .and_then(|name| name.to_str())
        != Some(trashed_filename)
        || Path::new(trashed_filename)
            .extension()
            .and_then(|ext| ext.to_str())
            != Some("md")
    {
        return Err(MemoryError::Other("invalid trash filename".to_string()));
    }

    let dir = trash_dir(ctx);
    let source = dir.join(trashed_filename);
    if !source.is_file() {
        return Err(MemoryError::Other(format!(
            "trash item not found: {trashed_filename}"
        )));
    }
    let meta_path = trash_metadata_path(&source);
    let trash_meta: Option<TrashMetadata> = std::fs::read(&meta_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok());
    let requested = trash_meta
        .map(|meta| meta.original_filename)
        .filter(|name| is_safe_markdown_relative_path(name))
        .unwrap_or_else(|| trashed_filename.to_string());

    let requested_path = Path::new(&requested);
    let parent = requested_path.parent().unwrap_or_else(|| Path::new(""));
    let stem = requested_path
        .file_stem()
        .map(|part| part.to_string_lossy().to_string())
        .unwrap_or_else(|| "restored-note".to_string());
    let mut restored_filename = requested.clone();
    let mut destination = ctx.vault.join(&restored_filename);
    if destination.exists() {
        let id = uuid::Uuid::new_v4().to_string();
        restored_filename = parent
            .join(format!("{stem}-restored-{}.md", &id[..8]))
            .to_string_lossy()
            .to_string();
        destination = ctx.vault.join(&restored_filename);
    }
    if let Some(destination_parent) = destination.parent() {
        std::fs::create_dir_all(destination_parent)?;
    }
    let content = std::fs::read_to_string(&source)?;
    std::fs::rename(&source, &destination)?;
    let _ = std::fs::remove_file(meta_path);

    // save_note rebuilds chunks/embeddings and reactivates the dormant row.
    // The file is already back in the user-owned vault if indexing fails, so
    // no content is lost and the watcher can retry later.
    let mut result = save_note_locked(ctx, &restored_filename, &content)?;
    result.status = "restored".to_string();
    Ok(result)
}

/// Write `content` to `filename` under the brain's vault, then
/// ingest. `filename` is a POSIX-style path relative to the vault
/// root (e.g. `agent/foo.md`). Parent folders are created on
/// demand.
///
/// The path is validated BEFORE any filesystem work. `PathBuf::join`
/// silently discards the base when given an absolute path, so an
/// unchecked `filename` of `/Users/you/.zshrc` wrote straight there,
/// and `../` escaped just as easily. Worse, the write landed before
/// the ingest step that rejects non-`.md` files, so the stray file
/// survived even when the request went on to 500.
///
/// This reaches the network: `PUT /api/notes` on the loopback API and
/// the `remember` MCP tool, which ships in the DEFAULT `lite` tier.
pub fn save_note(ctx: &BrainContext, filename: &str, content: &str) -> Result<WriteResult> {
    let _guard = NOTE_MUTATION_LOCK.lock();
    save_note_locked(ctx, filename, content)
}

fn save_note_locked(ctx: &BrainContext, filename: &str, content: &str) -> Result<WriteResult> {
    if !is_safe_markdown_relative_path(filename) {
        return Err(MemoryError::Other(format!(
            "refusing to write outside the vault: {filename:?} must be a \
             relative .md path with no `..` segments"
        )));
    }
    let target = checked_vault_path(ctx, filename, true)?;
    atomic_write(&target, content)?;

    // Capture whether the durable content itself changed independently from
    // whether ingest had to repair its derived index. A same-content repair
    // must stay `unchanged` and must not create a false note-updated event.
    let before: Option<(String, bool)> = {
        let conn = ctx.db.lock();
        conn.query_row(
            "SELECT id, content = ?2 AND COALESCE(state, 'fresh') != 'dormant'
             FROM engrams WHERE filename = ?1",
            rusqlite::params![filename, content],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
    }
    .map_err(|error| durable_markdown_index_error(filename, error))?;
    let ingested = ingest::ingest_content(filename, content, &ctx.db)
        .map_err(|error| durable_markdown_index_error(filename, error))?;
    let (engram_id, status) = match (before, ingested) {
        (None, Some(id)) => (id, "created".to_string()),
        (Some((_, true)), Some(id)) => (id, "unchanged".to_string()),
        (Some((_, false)), Some(id)) => (id, "updated".to_string()),
        (Some((existing, _)), None) => (existing, "unchanged".to_string()),
        (None, None) => {
            // Ingest returned None but no prior row exists — shouldn't
            // happen for a `.md` file with non-empty content. Most
            // likely a non-markdown extension made ingest_content
            // bail early. Surface a clean error.
            return Err(durable_markdown_index_error(
                filename,
                "ingest produced no engram id and none existed",
            ));
        }
    };

    // Journal: only REAL changes are experiences — `unchanged` means
    // the content hash matched (an index refresh, not an event).
    if status != "unchanged" {
        let kind: Option<String> = {
            let conn = ctx.db.lock();
            conn.query_row(
                "SELECT COALESCE(kind,'note') FROM engrams WHERE id = ?1",
                [&engram_id],
                |r| r.get(0),
            )
            .ok()
        };
        let mut ev = super::journal::Event::now(
            &ctx.brain_id,
            if status == "created" {
                "note_created"
            } else {
                "note_updated"
            },
            "engram",
            &engram_id,
        );
        ev.title = Some(filename.to_string());
        ev.kind = kind;
        ev.room = std::path::Path::new(filename)
            .parent()
            .and_then(|p| p.to_str())
            .filter(|p| !p.is_empty())
            .map(String::from);
        ev.capture_method = "ingest".into();
        super::journal::record(ev);
    }

    Ok(WriteResult {
        engram_id,
        filename: filename.to_string(),
        brain_id: ctx.brain_id.clone(),
        status,
    })
}

/// Create a brand-new note from `title`. Generates a slug-based
/// filename, seeds the file with a `# title` heading, and ingests.
/// Returns the generated filename + engram id.
pub fn create_note(ctx: &BrainContext, title: &str) -> Result<WriteResult> {
    let slug_base = slugify(title);
    let short = uuid::Uuid::new_v4().to_string();
    let short = &short[..8];
    let filename = format!("{}-{}.md", slug_base, short);
    let seed = format!("# {}\n\n", title);

    save_note(ctx, &filename, &seed)
}

/// Index Markdown that is already present in the vault without rewriting it.
///
/// This is the write-side bridge used after a sandbox import and for the
/// first-run welcome note. The Markdown remains the source of truth; a model
/// or database failure is surfaced as an indexing error and never removes the
/// copied file.
pub fn ingest_existing_note(ctx: &BrainContext, filename: &str) -> Result<Option<String>> {
    let _guard = NOTE_MUTATION_LOCK.lock();
    ingest_existing_note_locked(ctx, filename)
}

fn ingest_existing_note_locked(ctx: &BrainContext, filename: &str) -> Result<Option<String>> {
    let path = checked_vault_path(ctx, filename, false)?;
    let metadata = std::fs::symlink_metadata(&path).map_err(|error| {
        MemoryError::Other(format!(
            "could not read imported Markdown at {filename:?}: {error}"
        ))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(MemoryError::Other(format!(
            "refusing to index a non-regular Markdown file at {filename:?}"
        )));
    }
    ingest::ingest_file(&path, Some(&ctx.vault), &ctx.db)
        .map_err(|error| durable_markdown_index_error(filename, error))
}

const MAX_INDEX_ERROR_DETAILS: usize = 100;

fn record_index_error(result: &mut IndexBrainResult, filename: String, error: impl ToString) {
    result.failed = result.failed.saturating_add(1);
    // Reserve the final slot for a truthful omitted-count marker.
    if result.errors.len() < MAX_INDEX_ERROR_DETAILS.saturating_sub(1) {
        result.errors.push(IndexFileError {
            filename,
            error: error.to_string(),
        });
    }
}

fn collect_index_candidates(
    root: &Path,
    directory: &Path,
    files: &mut Vec<(String, PathBuf)>,
    result: &mut IndexBrainResult,
) {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) => {
            let relative = directory
                .strip_prefix(root)
                .ok()
                .filter(|path| !path.as_os_str().is_empty())
                .map(|path| path.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|| ".".to_string());
            record_index_error(result, relative, format!("could not scan folder: {error}"));
            return;
        }
    };

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                record_index_error(
                    result,
                    directory.to_string_lossy().to_string(),
                    format!("could not read directory entry: {error}"),
                );
                continue;
            }
        };
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            record_index_error(
                result,
                path.to_string_lossy().to_string(),
                "filename is not valid UTF-8",
            );
            continue;
        };
        // App/editor metadata is not user-authored memory. Trash normally sits
        // beside the vault, but skip an in-vault legacy folder as well.
        if name.starts_with('.') || name == "trash" {
            continue;
        }

        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) => {
                record_index_error(
                    result,
                    path.to_string_lossy().to_string(),
                    format!("could not inspect path: {error}"),
                );
                continue;
            }
        };
        if metadata.file_type().is_symlink() {
            if path.extension().and_then(|ext| ext.to_str()) == Some("md") {
                result.scanned = result.scanned.saturating_add(1);
            }
            record_index_error(
                result,
                path.strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/"),
                "symbolic links are not indexed",
            );
            continue;
        }
        if metadata.is_dir() {
            collect_index_candidates(root, &path, files, result);
            continue;
        }
        if !metadata.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("md") {
            continue;
        }

        result.scanned = result.scanned.saturating_add(1);
        let relative = match path.strip_prefix(root) {
            Ok(relative) => relative.to_string_lossy().replace('\\', "/"),
            Err(error) => {
                record_index_error(
                    result,
                    path.to_string_lossy().to_string(),
                    format!("file escaped the vault boundary: {error}"),
                );
                continue;
            }
        };
        if !is_safe_markdown_relative_path(&relative) {
            record_index_error(result, relative, "unsafe Markdown path");
            continue;
        }
        files.push((relative, path));
    }
}

/// Rescan all regular Markdown files already inside one vault. This is
/// additive/reparative only: it never deletes Markdown or inferred database
/// rows. Each file uses the ordinary ingest primitive, including its
/// precomputed embeddings and atomic engram/chunk/vector commit.
pub fn index_brain(ctx: &BrainContext) -> Result<IndexBrainResult> {
    if !super::read_ops::is_safe_brain_id(&ctx.brain_id) {
        return Err(MemoryError::Other(format!(
            "invalid brain id {:?}: must be a single safe path segment",
            ctx.brain_id
        )));
    }
    std::fs::create_dir_all(&ctx.vault)?;
    let root = std::fs::canonicalize(&ctx.vault).map_err(|error| {
        MemoryError::Other(format!(
            "could not resolve vault {}: {error}",
            ctx.vault.display()
        ))
    })?;
    if !root.is_dir() {
        return Err(MemoryError::Other(format!(
            "vault is not a directory: {}",
            root.display()
        )));
    }

    let mut result = IndexBrainResult::default();
    let mut files = Vec::new();
    collect_index_candidates(&root, &root, &mut files, &mut result);
    files.sort_by(|left, right| left.0.cmp(&right.0));

    for (filename, _) in files {
        match ingest_existing_note(ctx, &filename) {
            Ok(Some(_)) => result.indexed = result.indexed.saturating_add(1),
            Ok(None) => result.unchanged = result.unchanged.saturating_add(1),
            Err(error) => record_index_error(&mut result, filename, error),
        }
    }

    let detailed = result.errors.len() as u32;
    if result.failed > detailed {
        result.errors.push(IndexFileError {
            filename: "[additional errors]".to_string(),
            error: format!(
                "{} additional indexing errors were omitted",
                result.failed - detailed
            ),
        });
    }
    Ok(result)
}

/// Rename or move one vault note while retaining its stable engram id.
///
/// A filename-only move does not rebuild chunks or embeddings because their
/// content and ids are still valid. If `new_title` is supplied, the Markdown
/// H1 is changed atomically and the ordinary ingest pipeline refreshes every
/// derived index. Any failure before ingest commits rolls both the database
/// filename and the durable file back to their original values.
pub fn rename_note(
    ctx: &BrainContext,
    filename: &str,
    new_filename: &str,
    new_title: Option<&str>,
) -> Result<WriteResult> {
    let _guard = NOTE_MUTATION_LOCK.lock();
    rename_note_locked(ctx, filename, new_filename, new_title)
}

fn rename_note_locked(
    ctx: &BrainContext,
    filename: &str,
    new_filename: &str,
    new_title: Option<&str>,
) -> Result<WriteResult> {
    let source = checked_vault_path(ctx, filename, false)?;
    let destination = checked_vault_path(ctx, new_filename, true)?;
    let source_metadata = std::fs::symlink_metadata(&source)
        .map_err(|error| MemoryError::Other(format!("note not found at {filename:?}: {error}")))?;
    if source_metadata.file_type().is_symlink() || !source_metadata.is_file() {
        return Err(MemoryError::Other(format!(
            "refusing to rename a non-regular Markdown file at {filename:?}"
        )));
    }
    let moved = filename != new_filename;
    if moved {
        match std::fs::symlink_metadata(&destination) {
            Ok(_) => {
                return Err(MemoryError::Other(format!(
                    "a note already exists at {new_filename:?}"
                )))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(MemoryError::Io(error)),
        }
    }

    let requested_title = new_title.map(str::trim).filter(|title| !title.is_empty());
    if new_title.is_some() && requested_title.is_none() {
        return Err(MemoryError::Other(
            "a note title cannot be empty".to_string(),
        ));
    }
    if requested_title.is_some_and(|title| title.len() > 500 || title.contains(['\r', '\n', '\0']))
    {
        return Err(MemoryError::Other(
            "a note title must be one line of at most 500 bytes".to_string(),
        ));
    }

    let original_content = std::fs::read_to_string(&source)?;
    let next_content = requested_title
        .map(|title| markdown_with_title(&original_content, title))
        .unwrap_or_else(|| original_content.clone());
    let content_changed = next_content != original_content;

    let indexed: Option<(String, String)> = {
        let conn = ctx.db.lock();
        conn.query_row(
            "SELECT id, title FROM engrams WHERE filename = ?1 AND COALESCE(state, 'fresh') != 'dormant'",
            [filename],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
    };

    // Markdown is canonical. A failed or interrupted first index must not
    // take ordinary file management away from the user. Move/update the file
    // safely now; the background rescan will create its derived engram later.
    let Some((engram_id, original_title)) = indexed else {
        if moved {
            move_file_without_overwrite(&source, &destination)?;
        }
        if content_changed {
            if let Err(error) = atomic_write(&destination, &next_content) {
                if moved {
                    if let Err(rollback_error) = move_file_without_overwrite(&destination, &source)
                    {
                        return Err(MemoryError::Other(format!(
                            "could not update the title during rename ({error}); restoring the original path also failed ({rollback_error})"
                        )));
                    }
                }
                return Err(error);
            }
        }
        return Ok(WriteResult {
            engram_id: String::new(),
            filename: new_filename.to_string(),
            brain_id: ctx.brain_id.clone(),
            status: if moved {
                "renamed_unindexed"
            } else if content_changed {
                "updated_unindexed"
            } else {
                "unchanged"
            }
            .to_string(),
        });
    };

    if moved {
        move_file_without_overwrite(&source, &destination)?;
    }
    if content_changed {
        if let Err(error) = atomic_write(&destination, &next_content) {
            if moved {
                if let Err(rollback_error) = move_file_without_overwrite(&destination, &source) {
                    return Err(MemoryError::Other(format!(
                        "could not update the title during rename ({error}); restoring the original path also failed ({rollback_error})"
                    )));
                }
            }
            return Err(error);
        }
    }

    let derived_title = title_from_markdown(&next_content, new_filename);
    let database_move = (|| -> Result<()> {
        let conn = ctx.db.lock();
        let tx = conn.unchecked_transaction()?;
        let changed = if content_changed {
            tx.execute(
                "UPDATE engrams SET filename = ?1 WHERE id = ?2 AND filename = ?3",
                rusqlite::params![new_filename, &engram_id, filename],
            )?
        } else {
            tx.execute(
                "UPDATE engrams SET filename = ?1, title = ?2, updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
                 WHERE id = ?3 AND filename = ?4",
                rusqlite::params![new_filename, &derived_title, &engram_id, filename],
            )?
        };
        if changed != 1 {
            return Err(MemoryError::Other(
                "the note changed while its rename was being applied".to_string(),
            ));
        }
        for table in ["variable_renames", "function_calls", "variable_references"] {
            tx.execute(
                &format!("UPDATE {table} SET filepath = ?1 WHERE engram_id = ?2 AND filepath = ?3"),
                rusqlite::params![new_filename, &engram_id, filename],
            )?;
        }
        tx.commit()?;
        Ok(())
    })();

    if let Err(error) = database_move {
        if content_changed {
            if let Err(rollback_error) = atomic_write(&destination, &original_content) {
                return Err(MemoryError::Other(format!(
                    "database rename failed ({error}); restoring the original Markdown also failed ({rollback_error}). The note remains at {}",
                    destination.display()
                )));
            }
        }
        if moved {
            if let Err(rollback_error) = move_file_without_overwrite(&destination, &source) {
                return Err(MemoryError::Other(format!(
                    "database rename failed ({error}); restoring the original path also failed ({rollback_error}). The note remains at {}",
                    destination.display()
                )));
            }
        }
        return Err(error);
    }

    // Always pass through ingest, even for a filename-only move. A healthy
    // unchanged index exits cheaply; an old matching-hash partial index is
    // repaired using the same precompute + atomic commit invariant as save.
    if let Err(error) = ingest::ingest_content(new_filename, &next_content, &ctx.db) {
        let database_rollback = (|| -> Result<()> {
            let conn = ctx.db.lock();
            let tx = conn.unchecked_transaction()?;
            tx.execute(
                "UPDATE engrams SET filename = ?1, title = ?2 WHERE id = ?3",
                rusqlite::params![filename, &original_title, &engram_id],
            )?;
            for table in ["variable_renames", "function_calls", "variable_references"] {
                tx.execute(
                    &format!(
                        "UPDATE {table} SET filepath = ?1 WHERE engram_id = ?2 AND filepath = ?3"
                    ),
                    rusqlite::params![filename, &engram_id, new_filename],
                )?;
            }
            tx.commit()?;
            Ok(())
        })();
        let file_rollback = atomic_write(&destination, &original_content).and_then(|_| {
            if moved {
                move_file_without_overwrite(&destination, &source)
            } else {
                Ok(())
            }
        });
        if let Err(rollback_error) = database_rollback.and(file_rollback) {
            return Err(MemoryError::Other(format!(
                "rename indexing failed ({error}); automatic rollback also failed ({rollback_error}). The Markdown remains at {} and needs manual recovery.",
                destination.display()
            )));
        }
        return Err(MemoryError::Other(format!(
            "rename was not applied because the search index could not be updated: {error}. The original Markdown remains at {filename:?}."
        )));
    }

    if moved || content_changed {
        let mut event =
            super::journal::Event::now(&ctx.brain_id, "note_renamed", "engram", &engram_id);
        event.title = Some(derived_title);
        event.before = Some(filename.to_string());
        event.after = Some(new_filename.to_string());
        event.capture_method = "user".to_string();
        super::journal::record(event);
    }

    Ok(WriteResult {
        engram_id,
        filename: new_filename.to_string(),
        brain_id: ctx.brain_id.clone(),
        status: if moved {
            "renamed"
        } else if content_changed {
            "updated"
        } else {
            "unchanged"
        }
        .to_string(),
    })
}

fn existing_regular_note_path(ctx: &BrainContext, filename: &str) -> Result<Option<PathBuf>> {
    if !is_safe_markdown_relative_path(filename) {
        return Err(MemoryError::Other(format!(
            "refusing to address a note outside the vault: {filename:?} must be a relative .md path with no `..` segments"
        )));
    }
    let source = ctx.vault.join(filename);
    let metadata = match std::fs::symlink_metadata(&source) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(MemoryError::Io(error)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(MemoryError::Other(format!(
            "refusing to delete a non-regular Markdown file at {filename:?}"
        )));
    }
    let vault = std::fs::canonicalize(&ctx.vault)?;
    let canonical_source = std::fs::canonicalize(&source)?;
    if !canonical_source.starts_with(&vault) {
        return Err(MemoryError::Other(format!(
            "refusing to follow a note path outside the vault: {filename:?}"
        )));
    }
    Ok(Some(source))
}

fn move_note_to_trash(ctx: &BrainContext, filename: &str, source: &Path) -> Result<()> {
    let dir = trash_dir(ctx);
    std::fs::create_dir_all(&dir)?;
    let leaf = Path::new(filename)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "note.md".to_string());
    let stem = Path::new(&leaf)
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_else(|| "note".to_string());
    let mut destination = dir.join(&leaf);
    loop {
        match std::fs::symlink_metadata(&destination) {
            Ok(_) => {
                let id = uuid::Uuid::new_v4().to_string();
                destination = dir.join(format!("{stem}-{}.md", &id[..8]));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(MemoryError::Io(error)),
        }
    }
    move_file_without_overwrite(source, &destination)?;
    let trash_meta = TrashMetadata {
        original_filename: filename.to_string(),
        deleted_at: unix_seconds_now(),
    };
    if let Ok(bytes) = serde_json::to_vec_pretty(&trash_meta) {
        if let Err(error) = std::fs::write(trash_metadata_path(&destination), bytes) {
            eprintln!("[trash] could not persist restore metadata: {error}");
        }
    }
    Ok(())
}

/// Soft-delete the engram backing `filename`, then move the file to
/// the per-brain trash directory. The DB row stays (state='dormant')
/// for audit; chunks + vec embeddings are dropped so recall no
/// longer surfaces the note.
pub fn delete_note(ctx: &BrainContext, filename: &str) -> Result<WriteResult> {
    let _guard = NOTE_MUTATION_LOCK.lock();
    delete_note_locked(ctx, filename)
}

fn delete_note_locked(ctx: &BrainContext, filename: &str) -> Result<WriteResult> {
    // Validate and inspect the canonical file before changing the database.
    // An interrupted first ingest may legitimately leave Markdown with no
    // engram; that file must still be deletable and recoverable from trash.
    let source = existing_regular_note_path(ctx, filename)?;
    let engram_id = ingest::lookup_engram_by_filename(&ctx.db, filename)?;
    if engram_id.is_none() && source.is_none() {
        return Err(MemoryError::EngramNotFound(filename.to_string()));
    }

    // DB-first: if the file move fails, the row goes back via a
    // future ingest when the user restores the file. If we moved
    // the file first and then the DB update crashed, we'd have a
    // dormant file on disk with a live DB row — harder to recover.
    if let Some(ref id) = engram_id {
        ingest::soft_delete_engram(&ctx.db, id)?;
    }
    if let Some(source) = source.as_deref() {
        move_note_to_trash(ctx, filename, source)?;
    }

    Ok(WriteResult {
        engram_id: engram_id.clone().unwrap_or_default(),
        filename: filename.to_string(),
        brain_id: ctx.brain_id.clone(),
        status: if engram_id.is_some() {
            "deleted"
        } else {
            "deleted_unindexed"
        }
        .to_string(),
    })
}

/// Persist a brain's `source_folders` list into its record in `brains.json`.
/// Read-modify-write on the registry, mirroring the pattern brain activation
/// uses for the `active` field. Errors if the registry is
/// unreadable/unparseable or the brain id isn't present.
///
/// This writes ONLY config — it does not touch the manifest, the vault, or
/// any watcher. The caller (the PUT handler) decides whether to (re)start
/// watchers + run a sync after a successful persist.
pub fn set_source_folders(brain_id: &str, folders: &[SourceFolder]) -> Result<()> {
    let data = std::fs::read_to_string(registry_path())
        .map_err(|e| MemoryError::Other(format!("brains.json unreadable: {}", e)))?;
    let mut parsed: serde_json::Value = serde_json::from_str(&data)?;
    let brains = parsed
        .get_mut("brains")
        .and_then(|v| v.as_array_mut())
        .ok_or_else(|| MemoryError::BrainNotFound(brain_id.to_string()))?;
    let brain = brains
        .iter_mut()
        .find(|b| b.get("id").and_then(|v| v.as_str()) == Some(brain_id))
        .ok_or_else(|| MemoryError::BrainNotFound(brain_id.to_string()))?;
    brain["source_folders"] = serde_json::to_value(folders)?;
    let serialised = serde_json::to_string_pretty(&parsed)?;
    std::fs::write(registry_path(), serialised)?;
    Ok(())
}

/// Mark `old_id` as superseded by `new_id` at the engram level.
///
/// Sets `superseded_by` (+ optional `superseded_reason`) so recall hides
/// the old note by default — the note stays on disk and in the DB, so
/// this is reversible metadata, not a delete. Always caller-driven (an
/// agent or the user decided the new note replaces the old); nothing in
/// here decides supersession on its own.
///
/// Returns `true` if the old engram existed and was updated. Errors if
/// `new_id` doesn't exist (can't point at a missing replacement) or if
/// the two ids are equal.
pub fn supersede_note(
    db: &BrainDb,
    old_id: &str,
    new_id: &str,
    reason: Option<&str>,
) -> Result<bool> {
    if old_id == new_id {
        return Err(MemoryError::Other(
            "a note can't supersede itself".to_string(),
        ));
    }
    let conn = db.lock();
    let count = |id: &str| -> Result<i64> {
        Ok(
            conn.query_row("SELECT COUNT(*) FROM engrams WHERE id = ?1", [id], |r| {
                r.get(0)
            })?,
        )
    };
    if count(new_id)? == 0 {
        return Err(MemoryError::EngramNotFound(new_id.to_string()));
    }
    if count(old_id)? == 0 {
        return Ok(false);
    }
    let n = conn.execute(
        "UPDATE engrams SET superseded_by = ?1, superseded_reason = ?2, \
         updated_at = datetime('now') WHERE id = ?3",
        rusqlite::params![new_id, reason, old_id],
    )?;
    if n > 0 {
        let title: Option<String> = conn
            .query_row("SELECT title FROM engrams WHERE id = ?1", [old_id], |r| {
                r.get(0)
            })
            .ok();
        drop(conn);
        let mut ev = super::journal::Event::now(db.brain_id(), "note_superseded", "engram", old_id);
        ev.title = title;
        ev.before = Some("active".into());
        ev.after = Some(format!("superseded by {}", &new_id[..new_id.len().min(8)]));
        if let Some(r) = reason {
            ev.source_refs = vec![format!(
                "reason: {}",
                r.chars().take(120).collect::<String>()
            )];
        }
        super::journal::record(ev);
        return Ok(true);
    }
    Ok(n > 0)
}

#[cfg(test)]
mod trash_tests {
    use super::*;

    fn test_context(label: &str) -> (PathBuf, BrainContext) {
        let root =
            std::env::temp_dir().join(format!("neurovault-write-{label}-{}", uuid::Uuid::new_v4()));
        let vault = root.join("brains/test/vault");
        std::fs::create_dir_all(&vault).unwrap();
        let db = Arc::new(crate::memory::db::open_file(&root.join("test.db")).unwrap());
        db.lock()
            .execute_batch(
                "CREATE TABLE vec_chunks (
                    chunk_id TEXT PRIMARY KEY,
                    embedding BLOB NOT NULL
                 );",
            )
            .unwrap();
        (
            root,
            BrainContext {
                brain_id: "test".to_string(),
                db,
                vault,
            },
        )
    }

    fn content_hash_for_test(content: &str) -> String {
        use sha2::{Digest, Sha256};
        format!("{:x}", Sha256::digest(content.as_bytes()))
    }

    fn seed_complete_note(ctx: &BrainContext, id: &str, filename: &str, content: &str) {
        let chunks = crate::memory::hierarchical_chunk(content, id);
        let conn = ctx.db.lock();
        conn.execute(
            "INSERT INTO engrams (id, filename, title, content, content_hash)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                id,
                filename,
                title_from_markdown(content, filename),
                content,
                content_hash_for_test(content)
            ],
        )
        .unwrap();
        for chunk in chunks {
            conn.execute(
                "INSERT INTO chunks (id, engram_id, content, granularity, chunk_index)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    chunk.id,
                    chunk.engram_id,
                    chunk.content,
                    chunk.granularity,
                    chunk.chunk_index
                ],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?1, ?2)",
                rusqlite::params![
                    chunk.id,
                    vec![0_u8; crate::memory::EMBEDDING_DIM * std::mem::size_of::<f32>()]
                ],
            )
            .unwrap();
        }
    }

    #[test]
    fn restore_paths_must_stay_inside_the_vault() {
        assert!(is_safe_markdown_relative_path("note.md"));
        assert!(is_safe_markdown_relative_path("projects/note.md"));
        assert!(!is_safe_markdown_relative_path("../note.md"));
        assert!(!is_safe_markdown_relative_path("/tmp/note.md"));
        assert!(!is_safe_markdown_relative_path("folder\\note.md"));
        assert!(!is_safe_markdown_relative_path("nul\0note.md"));
        assert!(!is_safe_markdown_relative_path("note.txt"));
    }

    #[test]
    fn native_read_and_save_reject_traversal_and_absolute_paths() {
        let root =
            std::env::temp_dir().join(format!("neurovault-path-guard-{}", uuid::Uuid::new_v4()));
        let vault = root.join("vault");
        std::fs::create_dir_all(&vault).unwrap();
        let outside = root.join("outside.md");
        std::fs::write(&outside, "do not change").unwrap();
        let db = Arc::new(crate::memory::db::open_file(&root.join("test.db")).unwrap());
        let ctx = BrainContext {
            brain_id: "test".to_string(),
            db,
            vault,
        };

        let absolute = outside.to_string_lossy().to_string();
        for unsafe_name in ["../outside.md", absolute.as_str()] {
            assert!(read_note_content(&ctx, unsafe_name).is_err());
            assert!(save_note(&ctx, unsafe_name, "overwritten").is_err());
        }
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "do not change");
        drop(ctx);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn trash_metadata_is_a_sidecar_not_a_markdown_note() {
        let note = Path::new("/tmp/trash/example.md");
        assert_eq!(
            trash_metadata_path(note),
            PathBuf::from("/tmp/trash/example.md.neurovault-trash.json")
        );
    }

    #[test]
    fn indexing_error_says_the_markdown_write_succeeded() {
        let error = durable_markdown_index_error("projects/idea.md", "model unavailable");
        let message = error.to_string();
        assert!(message.contains("Markdown file was saved"));
        assert!(message.contains("remains the durable source of truth"));
        assert!(message.contains("projects/idea.md"));
        assert!(message.contains("search index"));
        assert!(message.contains("model unavailable"));
    }

    #[test]
    fn atomic_markdown_replace_is_complete_and_cleans_failed_temps() {
        let root =
            std::env::temp_dir().join(format!("neurovault-atomic-write-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let note = root.join("note.md");
        std::fs::write(&note, "old").unwrap();
        atomic_write(&note, "new complete body").unwrap();
        assert_eq!(std::fs::read_to_string(&note).unwrap(), "new complete body");

        let invalid_target = root.join("folder.md");
        std::fs::create_dir(&invalid_target).unwrap();
        assert!(atomic_write(&invalid_target, "must fail").is_err());
        let leftovers = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(
            leftovers, 0,
            "failed atomic replace left a temp file behind"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rename_moves_markdown_and_keeps_the_same_indexed_identity() {
        let _home_guard = crate::memory::journal::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous_home = std::env::var_os("NEUROVAULT_HOME");
        let (root, ctx) = test_context("rename");
        let vault = ctx.vault.clone();
        std::env::set_var("NEUROVAULT_HOME", &root);

        let content = "# Durable title\n\nBody";
        seed_complete_note(&ctx, "stable-id", "inbox/old.md", content);
        std::fs::create_dir_all(vault.join("inbox")).unwrap();
        std::fs::write(vault.join("inbox/old.md"), content).unwrap();

        let result = rename_note(&ctx, "inbox/old.md", "projects/new.md", None).unwrap();
        assert_eq!(result.engram_id, "stable-id");
        assert_eq!(result.filename, "projects/new.md");
        assert!(!vault.join("inbox/old.md").exists());
        assert_eq!(
            std::fs::read_to_string(vault.join("projects/new.md")).unwrap(),
            "# Durable title\n\nBody"
        );
        {
            let conn = ctx.db.lock();
            let row: (String, String, String) = conn
                .query_row(
                    "SELECT id, filename, title FROM engrams WHERE id = 'stable-id'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
            assert_eq!(
                row,
                (
                    "stable-id".to_string(),
                    "projects/new.md".to_string(),
                    "Durable title".to_string()
                )
            );
            let chunk_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM chunks WHERE engram_id = 'stable-id'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(chunk_count, 1, "filename-only rename must preserve chunks");
        }

        drop(ctx);
        match previous_home {
            Some(value) => std::env::set_var("NEUROVAULT_HOME", value),
            None => std::env::remove_var("NEUROVAULT_HOME"),
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rename_never_overwrites_an_existing_destination() {
        let (root, ctx) = test_context("rename-collision");
        std::fs::write(ctx.vault.join("old.md"), "old").unwrap();
        std::fs::write(ctx.vault.join("taken.md"), "keep me").unwrap();

        let error = rename_note(&ctx, "old.md", "taken.md", None).unwrap_err();
        assert!(error.to_string().contains("already exists"));
        assert_eq!(
            std::fs::read_to_string(ctx.vault.join("old.md")).unwrap(),
            "old"
        );
        assert_eq!(
            std::fs::read_to_string(ctx.vault.join("taken.md")).unwrap(),
            "keep me"
        );

        drop(ctx);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rename_keeps_working_when_markdown_has_not_been_indexed() {
        let (root, ctx) = test_context("rename-unindexed");
        std::fs::create_dir_all(ctx.vault.join("imports")).unwrap();
        std::fs::write(
            ctx.vault.join("imports/original.md"),
            "# Original title\n\nDurable body",
        )
        .unwrap();

        let result = rename_note(
            &ctx,
            "imports/original.md",
            "projects/renamed.md",
            Some("Renamed title"),
        )
        .unwrap();

        assert_eq!(result.engram_id, "");
        assert_eq!(result.status, "renamed_unindexed");
        assert!(!ctx.vault.join("imports/original.md").exists());
        assert_eq!(
            std::fs::read_to_string(ctx.vault.join("projects/renamed.md")).unwrap(),
            "# Renamed title\n\nDurable body"
        );
        let indexed_count: i64 = ctx
            .db
            .lock()
            .query_row("SELECT COUNT(*) FROM engrams", [], |row| row.get(0))
            .unwrap();
        assert_eq!(indexed_count, 0);

        drop(ctx);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rescan_reports_unchanged_and_per_file_utf8_errors() {
        let (root, ctx) = test_context("rescan");
        let content = "# Indexed\n\nThis note already has a complete local search index.";
        seed_complete_note(&ctx, "indexed-id", "nested/indexed.md", content);
        std::fs::create_dir_all(ctx.vault.join("nested")).unwrap();
        std::fs::write(ctx.vault.join("nested/indexed.md"), content).unwrap();
        std::fs::write(ctx.vault.join("broken.md"), [0xff, 0xfe, 0xfd]).unwrap();
        std::fs::write(ctx.vault.join("ignore.txt"), "not markdown").unwrap();

        let result = index_brain(&ctx).unwrap();
        assert_eq!(result.scanned, 2);
        assert_eq!(result.indexed, 0);
        assert_eq!(result.unchanged, 1);
        assert_eq!(result.failed, 1);
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].filename, "broken.md");
        assert!(result.errors[0].error.contains("durable source of truth"));

        drop(ctx);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn delete_moves_unindexed_markdown_to_recoverable_trash() {
        let (root, ctx) = test_context("delete-unindexed");
        std::fs::create_dir_all(ctx.vault.join("imports")).unwrap();
        std::fs::write(
            ctx.vault.join("imports/interrupted.md"),
            "# Still durable\n",
        )
        .unwrap();

        let result = delete_note(&ctx, "imports/interrupted.md").unwrap();
        assert_eq!(result.engram_id, "");
        assert_eq!(result.status, "deleted_unindexed");
        assert!(!ctx.vault.join("imports/interrupted.md").exists());
        let entries = list_trash(&ctx).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].original_filename, "imports/interrupted.md");
        assert_eq!(entries[0].title, "Still durable");

        drop(ctx);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn markdown_title_update_is_single_line_and_canonical() {
        assert_eq!(
            markdown_with_title("preface\n# Old\n\nBody", "New"),
            "preface\n# New\n\nBody"
        );
        assert_eq!(markdown_with_title("Body", "New"), "# New\n\nBody");
    }

    #[cfg(unix)]
    #[test]
    fn creating_a_note_never_follows_a_folder_symlink_outside_the_vault() {
        use std::os::unix::fs::symlink;

        let (root, ctx) = test_context("symlink-boundary");
        let outside = root.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        symlink(&outside, ctx.vault.join("escape")).unwrap();

        let error = checked_vault_path(&ctx, "escape/created/note.md", true).unwrap_err();
        assert!(error.to_string().contains("symbolic-link folder"));
        assert!(
            !outside.join("created").exists(),
            "validation must happen before creating anything through the link"
        );

        drop(ctx);
        let _ = std::fs::remove_dir_all(root);
    }
}
