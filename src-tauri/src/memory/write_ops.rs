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

use std::path::{Path, PathBuf};
use std::sync::Arc;

use slug::slugify;

use super::db::{open_brain, BrainDb};
use super::ingest;
use super::read_ops::resolve_brain_id;
use super::types::{MemoryError, Result};

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
        let trash_dir = ctx
            .vault
            .parent()
            .map(|p| p.join("trash"))
            .unwrap_or_else(|| ctx.vault.join(".trash"));
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
    }

    Ok(WriteResult {
        engram_id,
        filename: filename.to_string(),
        brain_id: ctx.brain_id.clone(),
        status: "deleted".to_string(),
    })
}
