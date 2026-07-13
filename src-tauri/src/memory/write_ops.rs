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

use slug::slugify;

use super::db::{open_brain, BrainDb};
use super::ingest;
use super::paths::registry_path;
use super::read_ops::resolve_brain_id;
use super::types::{MemoryError, Result, SourceFolder};

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

fn safe_markdown_relative_path(filename: &str) -> bool {
    let path = Path::new(filename);
    !path.is_absolute()
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
            .filter(|name| safe_markdown_relative_path(name))
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
        .filter(|name| safe_markdown_relative_path(name))
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
    let mut result = save_note(ctx, &restored_filename, &content)?;
    result.status = "restored".to_string();
    Ok(result)
}

/// Write `content` to `filename` under the brain's vault, then
/// ingest. `filename` is a POSIX-style path relative to the vault
/// root (e.g. `agent/foo.md`). Parent folders are created on
/// demand.
pub fn save_note(ctx: &BrainContext, filename: &str, content: &str) -> Result<WriteResult> {
    let target = ctx.vault.join(filename);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&target, content)?;

    let before = ingest::lookup_engram_by_filename(&ctx.db, filename)?;
    let ingested = ingest::ingest_content(filename, content, &ctx.db)?;
    let (engram_id, status) = match (before, ingested) {
        (None, Some(id)) => (id, "created".to_string()),
        (Some(_), Some(id)) => (id, "updated".to_string()),
        (Some(existing), None) => (existing, "unchanged".to_string()),
        (None, None) => {
            // Ingest returned None but no prior row exists — shouldn't
            // happen for a `.md` file with non-empty content. Most
            // likely a non-markdown extension made ingest_content
            // bail early. Surface a clean error.
            return Err(MemoryError::Other(
                "ingest produced no engram id and none existed".to_string(),
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

/// Soft-delete the engram backing `filename`, then move the file to
/// the per-brain trash directory. The DB row stays (state='dormant')
/// for audit; chunks + vec embeddings are dropped so recall no
/// longer surfaces the note.
pub fn delete_note(ctx: &BrainContext, filename: &str) -> Result<WriteResult> {
    let engram_id = ingest::lookup_engram_by_filename(&ctx.db, filename)?
        .ok_or_else(|| MemoryError::EngramNotFound(filename.to_string()))?;

    // DB-first: if the file move fails, the row goes back via a
    // future ingest when the user restores the file. If we moved
    // the file first and then the DB update crashed, we'd have a
    // dormant file on disk with a live DB row — harder to recover.
    ingest::soft_delete_engram(&ctx.db, &engram_id)?;

    let src = ctx.vault.join(filename);
    if src.exists() {
        let trash_dir = trash_dir(ctx);
        std::fs::create_dir_all(&trash_dir)?;
        let leaf = Path::new(filename)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| filename.to_string());
        let mut dest = trash_dir.join(&leaf);
        if dest.exists() {
            // Collision — suffix with 8 uuid chars (same pattern the
            // legacy `delete_note` command uses for its trash step).
            let stem = Path::new(&leaf)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| leaf.clone());
            let id = uuid::Uuid::new_v4().to_string();
            dest = trash_dir.join(format!("{}-{}.md", stem, &id[..8]));
        }
        std::fs::rename(&src, &dest)?;
        let trash_meta = TrashMetadata {
            original_filename: filename.to_string(),
            deleted_at: unix_seconds_now(),
        };
        if let Ok(bytes) = serde_json::to_vec_pretty(&trash_meta) {
            if let Err(error) = std::fs::write(trash_metadata_path(&dest), bytes) {
                eprintln!("[trash] could not persist restore metadata: {error}");
            }
        }
    }

    Ok(WriteResult {
        engram_id,
        filename: filename.to_string(),
        brain_id: ctx.brain_id.clone(),
        status: "deleted".to_string(),
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

    #[test]
    fn restore_paths_must_stay_inside_the_vault() {
        assert!(safe_markdown_relative_path("note.md"));
        assert!(safe_markdown_relative_path("projects/note.md"));
        assert!(!safe_markdown_relative_path("../note.md"));
        assert!(!safe_markdown_relative_path("/tmp/note.md"));
        assert!(!safe_markdown_relative_path("note.txt"));
    }

    #[test]
    fn trash_metadata_is_a_sidecar_not_a_markdown_note() {
        let note = Path::new("/tmp/trash/example.md");
        assert_eq!(
            trash_metadata_path(note),
            PathBuf::from("/tmp/trash/example.md.neurovault-trash.json")
        );
    }
}
