//! Per-brain source-folder mirror engine.
//!
//! A brain can be configured with a list of external File-Explorer
//! folders (its `source_folders`, persisted in `brains.json`). Those
//! folders are the **read-only, authoritative** source of truth for a
//! subset of the brain's vault: NeuroVault MIRRORS each enabled
//! folder's `*.md` files into the brain's internal vault, keeps them in
//! sync on change, and removes the corresponding note when a source
//! file is deleted. Originals are never modified.
//!
//! ## Where things live
//!
//! - **Config** (`source_folders`) lives in `brains.json` — see
//!   `types::SourceFolder`, parsed in `read_ops`, persisted in
//!   `write_ops`. It is canonical config and so NEVER lives only in
//!   `brain.db` (which is a rebuildable index, wiped on reindex).
//! - **Manifest** (`sources_manifest.json`, one per brain) tracks the
//!   source→vault file mapping + content hashes so sync is incremental
//!   and deletions are detectable. The manifest is derived state — it
//!   can be rebuilt by a full `sync()` — but keeping it on disk lets us
//!   diff against the previous mirror cheaply.
//!
//! ## Vault layout (shared with the `/update-brain` skill)
//!
//! A mirrored file lands at:
//!
//! ```text
//! vault/_source_files/<source folder name>/<path relative to the source root>
//! ```
//!
//! This is deliberately the SAME layout the `/update-brain` skill writes
//! (`_source_files/<folder name>/…`), so the same source file maps to the
//! same vault path regardless of which tool imported it. The in-app Sync
//! and the skill therefore reconcile against each other (matching
//! `engrams.filename` → the ingest pipeline's hash check skips a re-import)
//! instead of producing two copies. Two distinct folders sharing a basename
//! intentionally merge under one subfolder — the same assumption the skill
//! makes.
//!
//! ## Deletions
//!
//! The vault watcher deliberately ignores Remove/Rename events, so when
//! the mirror removes a vault file it MUST itself remove the backing
//! note from the index — it cannot rely on the watcher. We do that by
//! computing the vault-relative POSIX path the ingest pipeline stores
//! as `engrams.filename` and calling `write_ops::delete_note`, which
//! soft-deletes the engram (drops chunks + links) and moves the vault
//! file to trash.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::ingest;
use super::paths::brain_dir;
use super::read_ops::registry_source_folders;
use super::types::{MemoryError, Result, SourceFolder};
use super::write_ops::{delete_note, BrainContext};

/// Manifest filename inside a brain's directory.
const MANIFEST_NAME: &str = "sources_manifest.json";

/// One mirrored file. Keyed (within the manifest map) by `vault_rel_path`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestEntry {
    /// Absolute path of the source `.md` file on disk, normalized.
    pub source_abs_path: String,
    /// Vault-relative POSIX path of the mirrored copy — this is exactly
    /// what the ingest pipeline stores in `engrams.filename`, so it
    /// doubles as the delete key.
    pub vault_rel_path: String,
    /// SHA-256 hex of the source file's bytes — same hashing convention
    /// `ingest::content_hash` uses, so "unchanged" means the same thing
    /// on both sides.
    pub content_hash: String,
    /// Absolute path of the source ROOT folder this file came from,
    /// normalized. Lets us drop a file when its whole folder is removed
    /// or disabled.
    pub source_root: String,
    /// RFC3339 UTC timestamp of the last sync that touched this entry.
    pub synced_at: String,
}

/// On-disk manifest shape: a list of entries plus a top-level
/// `synced_at` stamp for the most recent full sync. Stored as a list
/// (not a map) so the JSON is stable + diff-friendly; we index it by
/// `vault_rel_path` in memory.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Manifest {
    #[serde(default)]
    pub entries: Vec<ManifestEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub synced_at: Option<String>,
}

/// Result of a `sync()` run — how many files were copied/updated, how many
/// notes were removed, and how many were skipped as cross-path duplicates.
#[derive(Debug, Clone, Default, Serialize)]
pub struct SyncReport {
    pub synced: u32,
    pub removed: u32,
    #[serde(default)]
    pub skipped_duplicates: u32,
}

/// What `mirror_one_file` did with a single file.
enum MirrorOutcome {
    /// Copied into the vault (+ attempted ingest) — new or changed.
    Copied,
    /// Same content already mirrored at this path — nothing to do.
    Unchanged,
    /// This exact content already exists in the brain under another path
    /// (e.g. a prior import), so we skipped it instead of duplicating.
    SkippedDuplicate,
}

/// A read-only preview of what `sync()` WOULD do, so the UI can show
/// "will add / update / remove / skip" and let the user confirm before
/// anything touches the brain. Lists hold source-file absolute paths.
#[derive(Debug, Clone, Default, Serialize)]
pub struct SyncPlan {
    pub to_add: Vec<String>,
    pub to_update: Vec<String>,
    pub to_remove: Vec<String>,
    pub duplicates: Vec<String>,
    pub unchanged: u32,
}

/// Per-source rollup the GET handler needs: how many files this source
/// currently contributes + when it last synced. Both derived from the
/// manifest at call time (never stored in the brain record).
#[derive(Debug, Clone, Default)]
pub struct SourceStatus {
    pub file_count: u32,
    pub last_synced: Option<String>,
}

// ---- timestamp helper -----------------------------------------------------

/// RFC3339 / ISO-8601 UTC "now" — matches the timestamp style the rest
/// of the crate emits for observations.
fn now_iso() -> String {
    use time::format_description::well_known::Iso8601;
    use time::OffsetDateTime;
    OffsetDateTime::now_utc()
        .format(&Iso8601::DEFAULT)
        .unwrap_or_else(|_| "unknown".to_string())
}

// ---- path / hashing helpers -----------------------------------------------

/// Normalize a path to a stable string key. We canonicalize when the
/// path exists (resolves `..`, symlinks, drive-letter case on Windows);
/// otherwise we fall back to the lossy display string so a since-deleted
/// source still has a comparable key. Backslashes are left as-is in the
/// canonical form — the value is only ever compared to other values
/// produced by this same function, so internal consistency is all that
/// matters.
fn normalize_abs(p: &Path) -> String {
    match p.canonicalize() {
        Ok(c) => c.to_string_lossy().to_string(),
        Err(_) => p.to_string_lossy().to_string(),
    }
}

/// SHA-256 hex of a file's bytes. Mirrors `ingest::content_hash`'s
/// digest so an unchanged file hashes identically on both sides.
fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for b in digest.iter() {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

/// The vault subfolder a source root maps to: the source folder's own name
/// (its last path segment), matching the `/update-brain` skill's
/// `_source_files/<folder name>/…` layout EXACTLY. Using the same name (no
/// sanitizing, no hash) is what lets the in-app Sync and the skill reconcile
/// against each other — the same source file lands at the same vault path
/// under both tools, so neither duplicates the other's copy. (Two distinct
/// folders that share a basename intentionally merge under one subfolder,
/// the same assumption the skill makes.)
fn source_subdir(source_root_abs: &str) -> String {
    Path::new(source_root_abs)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("source")
        .to_string()
}

/// Directory names that are never worth mirroring: dependency trees, VCS
/// internals, build output, and caches. Skipping them is what stops a
/// source folder from flooding a brain with thousands of vendored
/// `README.md` / `CHANGELOG.md` files — the `node_modules` problem. Match
/// is case-insensitive so `Node_Modules` etc. are caught too.
fn is_ignored_dir(name: &str) -> bool {
    const IGNORED: &[&str] = &[
        "node_modules",
        ".git",
        ".svn",
        ".hg",
        "dist",
        "build",
        "target",
        ".next",
        ".nuxt",
        "out",
        ".output",
        ".cache",
        ".turbo",
        ".parcel-cache",
        "coverage",
        "vendor",
        "__pycache__",
        ".venv",
        "venv",
        "env",
        "bower_components",
        ".idea",
        ".vscode",
        ".gradle",
        "pods",
        ".pytest_cache",
        ".mypy_cache",
        ".tox",
        "obj",
        ".terraform",
        ".serverless",
        ".expo",
    ];
    let lower = name.to_ascii_lowercase();
    IGNORED.iter().any(|d| *d == lower)
}

/// Recursively collect every `*.md` file under `root`. Skips symlinks
/// (a misconfigured source can't escape via a link), skips dependency /
/// build / cache directories (see `is_ignored_dir`), and silently
/// tolerates unreadable subdirectories — best-effort, matching the
/// `count_markdown` / `walk_and_delete_md` helpers elsewhere in the
/// crate. We use std recursion rather than pulling in `walkdir`
/// (not a direct dependency).
fn collect_md_files(root: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        let path = entry.path();
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            // Skip dependency/build/cache dirs so a source folder can't
            // flood the brain with vendored markdown.
            if entry
                .file_name()
                .to_str()
                .map(is_ignored_dir)
                .unwrap_or(false)
            {
                continue;
            }
            collect_md_files(&path, out);
        } else if path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("md"))
            .unwrap_or(false)
        {
            // TODO: only *.md files are mirrored today. Other file types
            // (PDFs, images, code) are out of scope for the markdown
            // ingest pipeline; revisit if the inbox/raw flow grows to
            // cover them.
            out.push(path);
        }
    }
}

/// Compute the vault-relative POSIX path a source file maps to:
/// `_source_files/<folder name>/<file path relative to its source root>`,
/// with backslashes normalized to `/`. This matches BOTH what the ingest
/// pipeline stores as `engrams.filename` AND the `/update-brain` skill's
/// layout, so a file imported by either tool lands at the same path and the
/// two reconcile against each other instead of duplicating.
fn vault_rel_for(source_root: &Path, source_root_abs: &str, file: &Path) -> Option<String> {
    let rel = file.strip_prefix(source_root).ok()?;
    let rel_posix = rel.to_string_lossy().replace('\\', "/");
    if rel_posix.is_empty() {
        return None;
    }
    Some(format!(
        "_source_files/{}/{}",
        source_subdir(source_root_abs),
        rel_posix
    ))
}

// ---- manifest IO ----------------------------------------------------------

fn manifest_path(brain_id: &str) -> PathBuf {
    brain_dir(brain_id).join(MANIFEST_NAME)
}

/// Load a brain's manifest, returning an empty one when none exists or
/// it can't be parsed (a corrupt manifest just forces a fresh full
/// mirror — the source folders are still authoritative).
pub fn load_manifest(brain_id: &str) -> Manifest {
    let path = manifest_path(brain_id);
    let Ok(data) = std::fs::read_to_string(&path) else {
        return Manifest::default();
    };
    serde_json::from_str(&data).unwrap_or_default()
}

fn save_manifest(brain_id: &str, manifest: &Manifest) -> Result<()> {
    let path = manifest_path(brain_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let serialised = serde_json::to_string_pretty(manifest)?;
    std::fs::write(&path, serialised)?;
    Ok(())
}

// ---- GET-side helpers ------------------------------------------------------

/// Per-source rollup keyed by the source folder's configured `path`.
/// `file_count` counts manifest entries whose `source_root` matches the
/// folder; `last_synced` is the newest `synced_at` among them. A folder
/// with no mirrored files yet (never synced, or empty) reports
/// `file_count = 0` + `last_synced = None`.
pub fn source_status(brain_id: &str, folder_path: &str) -> SourceStatus {
    let manifest = load_manifest(brain_id);
    let root_key = normalize_abs(Path::new(folder_path));
    let mut file_count = 0u32;
    let mut last_synced: Option<String> = None;
    for entry in &manifest.entries {
        if entry.source_root == root_key {
            file_count += 1;
            match &last_synced {
                Some(cur) if cur >= &entry.synced_at => {}
                _ => last_synced = Some(entry.synced_at.clone()),
            }
        }
    }
    SourceStatus {
        file_count,
        last_synced,
    }
}

// ---- the mirror engine -----------------------------------------------------

/// True if an active engram with this exact `content_hash` already exists
/// in the brain under a filename OTHER than `vault_rel` — i.e. the content
/// is already in the brain via another path/import, so re-mirroring it
/// would duplicate it. Best-effort: content imported with different
/// wrapping (e.g. `.neurovault.md` wrappers) won't hash-match and so won't
/// be detected here.
fn content_exists_elsewhere(ctx: &BrainContext, content_hash: &str, vault_rel: &str) -> bool {
    let conn = ctx.db.lock();
    conn.query_row(
        "SELECT 1 FROM engrams \
         WHERE content_hash = ?1 AND filename != ?2 AND state != 'dormant' LIMIT 1",
        rusqlite::params![content_hash, vault_rel],
        |_| Ok(()),
    )
    .is_ok()
}

/// True if an active engram already exists at exactly `vault_rel` with this
/// `content_hash` — i.e. this file is already in the brain at its shared
/// `_source_files/<name>/…` path, e.g. because the `/update-brain` skill
/// imported it. The mirror treats this as "already in sync" rather than a
/// new add, so the two tools reconcile instead of double-reporting.
fn engram_matches_at(ctx: &BrainContext, vault_rel: &str, content_hash: &str) -> bool {
    let conn = ctx.db.lock();
    conn.query_row(
        "SELECT 1 FROM engrams \
         WHERE filename = ?1 AND content_hash = ?2 AND state != 'dormant' LIMIT 1",
        rusqlite::params![vault_rel, content_hash],
        |_| Ok(()),
    )
    .is_ok()
}

/// Mirror one source file into the vault + ingest it, upserting the
/// manifest entry. Shared by `sync` and the watcher's single-file fast
/// path. See `MirrorOutcome` for the three results.
fn mirror_one_file(
    ctx: &BrainContext,
    source_root: &Path,
    source_root_abs: &str,
    file: &Path,
    manifest: &mut HashMap<String, ManifestEntry>,
) -> Result<MirrorOutcome> {
    let bytes = match std::fs::read(file) {
        Ok(b) => b,
        // File vanished between enumeration and read (atomic-rename
        // editors) — treat as "nothing to do".
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(MirrorOutcome::Unchanged),
        Err(e) => return Err(MemoryError::Io(e)),
    };
    let new_hash = hash_bytes(&bytes);
    let Some(vault_rel) = vault_rel_for(source_root, source_root_abs, file) else {
        return Ok(MirrorOutcome::Unchanged);
    };

    // Unchanged fast path: same vault path + same hash already mirrored.
    if let Some(existing) = manifest.get(&vault_rel) {
        if existing.content_hash == new_hash {
            return Ok(MirrorOutcome::Unchanged);
        }
    }

    // Already-in-sync via another tool: not in OUR manifest, but an identical
    // engram already exists at this exact vault path (e.g. the /update-brain
    // skill imported it into the shared _source_files/<name>/ layout). Adopt
    // it into our manifest so we track it going forward, but skip the
    // redundant copy + ingest — it's already in sync.
    if !manifest.contains_key(&vault_rel) && engram_matches_at(ctx, &vault_rel, &new_hash) {
        manifest.insert(
            vault_rel.clone(),
            ManifestEntry {
                source_abs_path: normalize_abs(file),
                vault_rel_path: vault_rel.clone(),
                content_hash: new_hash.clone(),
                source_root: source_root_abs.to_string(),
                synced_at: now_iso(),
            },
        );
        return Ok(MirrorOutcome::Unchanged);
    }

    // Cross-path dedup: if we haven't mirrored this file before AND its
    // exact content already exists in the brain under another path (a prior
    // import), skip it rather than create a duplicate. An already-mirrored
    // file (in the manifest) keeps updating in place.
    if !manifest.contains_key(&vault_rel) && content_exists_elsewhere(ctx, &new_hash, &vault_rel) {
        return Ok(MirrorOutcome::SkippedDuplicate);
    }

    // Copy bytes into the vault (create parent dirs), then ingest so the
    // engram exists immediately — this works whether or not the brain is
    // the active one (an inactive brain has no running vault watcher, so we
    // can't rely on the watcher alone).
    //
    // Race tolerance: for the ACTIVE brain the vault watcher ALSO sees this
    // write and may ingest the same file concurrently, which can surface as
    // `UNIQUE constraint failed: engrams.filename`. That just means the
    // other side won the insert and the file is already indexed — not a
    // real failure — so we swallow exactly that error and let anything else
    // propagate.
    let target = ctx.vault.join(&vault_rel);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&target, &bytes)?;
    match ingest::ingest_file(&target, Some(&ctx.vault), &ctx.db) {
        Ok(_) => {}
        Err(e) if e.to_string().contains("UNIQUE constraint") => {}
        Err(e) => return Err(e),
    }

    manifest.insert(
        vault_rel.clone(),
        ManifestEntry {
            source_abs_path: normalize_abs(file),
            vault_rel_path: vault_rel,
            content_hash: new_hash,
            source_root: source_root_abs.to_string(),
            synced_at: now_iso(),
        },
    );
    Ok(MirrorOutcome::Copied)
}

/// Remove a previously-mirrored file: delete its engram (soft-delete +
/// move vault file to trash) and drop the manifest entry. Used for both
/// source deletions during `sync` and Remove/Rename watcher events.
fn unmirror_one(
    ctx: &BrainContext,
    vault_rel: &str,
    manifest: &mut HashMap<String, ManifestEntry>,
) -> Result<bool> {
    // delete_note is keyed by the vault-relative filename, which is
    // exactly our manifest key (and the `engrams.filename` value).
    match delete_note(ctx, vault_rel) {
        Ok(_) => {}
        // Already gone from the index (e.g. user deleted the note in the
        // app) — still drop the manifest entry so we don't keep trying.
        Err(MemoryError::EngramNotFound(_)) => {}
        Err(e) => return Err(e),
    }
    manifest.remove(vault_rel);
    Ok(true)
}

/// Full incremental mirror of every ENABLED source folder for `brain_id`.
///
/// 1. Load manifest.
/// 2. For each enabled folder: walk `*.md`, copy+ingest new/changed
///    files, upsert manifest entries (counts toward `synced`).
/// 3. Drop any manifest entry whose source file no longer exists OR
///    whose source root was removed/disabled (counts toward `removed`).
/// 4. Persist manifest + stamp `synced_at`.
///
/// Idempotent: a re-run with no on-disk changes copies nothing and
/// removes nothing. Works whether or not the brain is the active one.
pub fn sync(brain_id: &str) -> Result<SyncReport> {
    let folders = registry_source_folders(brain_id)?;

    // Opt-in guarantee: a brain with NO configured source folders and no
    // existing manifest gets ZERO writes — we don't create the vault dir,
    // a BrainContext, or even an empty manifest file. Nothing on disk (or
    // the SSD) is touched unless the user has actually added a source
    // folder. If a manifest DOES exist, a now-empty folder list means the
    // user removed all their sources, so we fall through to clean up the
    // previously-mirrored notes.
    if folders.is_empty() && !manifest_path(brain_id).exists() {
        return Ok(SyncReport::default());
    }

    let vault = super::read_ops::resolve_vault_path(brain_id)?;
    std::fs::create_dir_all(&vault)?;
    let ctx = BrainContext::resolve(Some(brain_id), vault)?;

    // In-memory manifest indexed by vault_rel_path for upsert/lookup.
    let loaded = load_manifest(brain_id);
    let mut manifest: HashMap<String, ManifestEntry> = loaded
        .entries
        .into_iter()
        .map(|e| (e.vault_rel_path.clone(), e))
        .collect();

    // Set of source roots that are currently enabled + valid. An entry
    // whose root is NOT in this set gets removed (folder disabled or
    // deleted from the config).
    let mut active_roots: Vec<String> = Vec::new();
    let mut report = SyncReport::default();

    for folder in &folders {
        if !folder.enabled {
            continue;
        }
        let root = PathBuf::from(&folder.path);
        if !root.is_dir() {
            // A configured folder that's currently unavailable (e.g.
            // unplugged drive) — skip it WITHOUT treating its files as
            // deleted, so a temporarily-missing source doesn't wipe the
            // mirrored notes. Its root stays "active" so step 3 leaves
            // its entries alone.
            let root_abs = normalize_abs(&root);
            active_roots.push(root_abs);
            continue;
        }
        let root_abs = normalize_abs(&root);
        active_roots.push(root_abs.clone());

        let mut files: Vec<PathBuf> = Vec::new();
        collect_md_files(&root, &mut files);
        for file in &files {
            match mirror_one_file(&ctx, &root, &root_abs, file, &mut manifest) {
                Ok(MirrorOutcome::Copied) => report.synced += 1,
                Ok(MirrorOutcome::SkippedDuplicate) => report.skipped_duplicates += 1,
                Ok(MirrorOutcome::Unchanged) => {}
                Err(e) => {
                    eprintln!(
                        "[source_mirror] mirror of {} (brain {}) failed: {}",
                        file.display(),
                        brain_id,
                        e
                    );
                }
            }
        }
    }

    // Deletions: any manifest entry whose source file is gone, or whose
    // source root is no longer active (removed/disabled). Collect first
    // to avoid mutating the map while iterating.
    let to_remove: Vec<String> = manifest
        .values()
        .filter(|entry| {
            let root_active = active_roots.iter().any(|r| r == &entry.source_root);
            let source_exists = Path::new(&entry.source_abs_path).exists();
            // Remove when the root was dropped/disabled, OR the root is
            // active+available but this specific file disappeared. A root
            // that's active-but-unavailable (unplugged) has no walked
            // files and its `source_exists` may be false, so guard with
            // whether the root dir currently exists.
            if !root_active {
                return true;
            }
            let root_available = Path::new(&entry.source_root).is_dir()
                || PathBuf::from(&entry.source_root).is_dir();
            root_available && !source_exists
        })
        .map(|e| e.vault_rel_path.clone())
        .collect();

    for vault_rel in to_remove {
        match unmirror_one(&ctx, &vault_rel, &mut manifest) {
            Ok(_) => report.removed += 1,
            Err(e) => {
                eprintln!(
                    "[source_mirror] unmirror of {} (brain {}) failed: {}",
                    vault_rel, brain_id, e
                );
            }
        }
    }

    // Persist the manifest as a list + fresh top-level stamp.
    let out = Manifest {
        entries: manifest.into_values().collect(),
        synced_at: Some(now_iso()),
    };
    save_manifest(brain_id, &out)?;

    Ok(report)
}

/// Read-only preview of what `sync()` would do for `brain_id`, WITHOUT
/// changing anything on disk or in the DB. Mirrors sync()'s classification:
/// new files → `to_add`, changed → `to_update`, vanished sources →
/// `to_remove`, content already in the brain elsewhere → `duplicates`,
/// everything else → `unchanged` count.
pub fn plan(brain_id: &str) -> Result<SyncPlan> {
    let folders = registry_source_folders(brain_id)?;
    let mut plan = SyncPlan::default();

    if folders.is_empty() && !manifest_path(brain_id).exists() {
        return Ok(plan);
    }

    let vault = super::read_ops::resolve_vault_path(brain_id)?;
    let ctx = BrainContext::resolve(Some(brain_id), vault)?;
    let loaded = load_manifest(brain_id);
    let manifest: HashMap<String, ManifestEntry> = loaded
        .entries
        .into_iter()
        .map(|e| (e.vault_rel_path.clone(), e))
        .collect();

    let mut active_roots: Vec<String> = Vec::new();
    for folder in &folders {
        if !folder.enabled {
            continue;
        }
        let root = PathBuf::from(&folder.path);
        if !root.is_dir() {
            active_roots.push(normalize_abs(&root));
            continue;
        }
        let root_abs = normalize_abs(&root);
        active_roots.push(root_abs.clone());

        let mut files: Vec<PathBuf> = Vec::new();
        collect_md_files(&root, &mut files);
        for file in &files {
            let Ok(bytes) = std::fs::read(file) else {
                continue;
            };
            let new_hash = hash_bytes(&bytes);
            let Some(vault_rel) = vault_rel_for(&root, &root_abs, file) else {
                continue;
            };
            match manifest.get(&vault_rel) {
                Some(existing) if existing.content_hash == new_hash => plan.unchanged += 1,
                Some(_) => plan.to_update.push(file.display().to_string()),
                None if engram_matches_at(&ctx, &vault_rel, &new_hash) => {
                    // Already in the brain at this path (e.g. the /update-brain
                    // skill put it there) — already in sync, not an add.
                    plan.unchanged += 1;
                }
                None => {
                    if content_exists_elsewhere(&ctx, &new_hash, &vault_rel) {
                        plan.duplicates.push(file.display().to_string());
                    } else {
                        plan.to_add.push(file.display().to_string());
                    }
                }
            }
        }
    }

    // Removals: manifest entries whose root was dropped/disabled, or whose
    // source file vanished while its (available) root is still configured.
    for entry in manifest.values() {
        let root_active = active_roots.iter().any(|r| r == &entry.source_root);
        let root_available = Path::new(&entry.source_root).is_dir();
        let source_exists = Path::new(&entry.source_abs_path).exists();
        if !root_active || (root_available && !source_exists) {
            plan.to_remove.push(entry.source_abs_path.clone());
        }
    }

    Ok(plan)
}

// ---- single-file watcher fast paths ---------------------------------------

/// Find which enabled source folder a changed path belongs to, if any.
/// Returns `(source_root, source_root_abs)`.
fn owning_root(folders: &[SourceFolder], path: &Path) -> Option<(PathBuf, String)> {
    let abs = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    for folder in folders {
        if !folder.enabled {
            continue;
        }
        let root = PathBuf::from(&folder.path);
        let root_abs = root.canonicalize().unwrap_or_else(|_| root.clone());
        if abs.starts_with(&root_abs) || path.starts_with(&root) {
            let root_abs_key = normalize_abs(&root);
            return Some((root, root_abs_key));
        }
    }
    None
}

/// Watcher Create/Modify fast path for a single source `.md` file:
/// copy into the vault + ingest + upsert the manifest entry. No-op if
/// the path isn't under any enabled source folder for this brain.
pub fn handle_source_upsert(brain_id: &str, path: &Path) -> Result<()> {
    let folders = registry_source_folders(brain_id)?;
    let Some((root, root_abs)) = owning_root(&folders, path) else {
        return Ok(());
    };
    let vault = super::read_ops::resolve_vault_path(brain_id)?;
    let ctx = BrainContext::resolve(Some(brain_id), vault)?;

    let loaded = load_manifest(brain_id);
    let mut manifest: HashMap<String, ManifestEntry> = loaded
        .entries
        .into_iter()
        .map(|e| (e.vault_rel_path.clone(), e))
        .collect();

    mirror_one_file(&ctx, &root, &root_abs, path, &mut manifest)?;

    let out = Manifest {
        entries: manifest.into_values().collect(),
        synced_at: Some(now_iso()),
    };
    save_manifest(brain_id, &out)
}

/// Watcher Remove/Rename fast path: a source `.md` disappeared — remove
/// the mirrored vault file + its engram + the manifest entry. We resolve
/// the entry by matching the removed source path against the manifest
/// (the source file is already gone, so we can't recompute its hash).
pub fn handle_source_remove(brain_id: &str, path: &Path) -> Result<()> {
    let vault = super::read_ops::resolve_vault_path(brain_id)?;
    let ctx = BrainContext::resolve(Some(brain_id), vault)?;

    let loaded = load_manifest(brain_id);
    let mut manifest: HashMap<String, ManifestEntry> = loaded
        .entries
        .into_iter()
        .map(|e| (e.vault_rel_path.clone(), e))
        .collect();

    // Match by normalized absolute source path. notify may hand us the
    // path with different casing / separators than we stored, so compare
    // both the raw display form and the canonical-of-the-removed-path.
    let removed_abs = normalize_abs(path);
    let removed_display = path.to_string_lossy().replace('\\', "/");
    let victims: Vec<String> = manifest
        .values()
        .filter(|e| {
            e.source_abs_path == removed_abs
                || e.source_abs_path.replace('\\', "/") == removed_display
        })
        .map(|e| e.vault_rel_path.clone())
        .collect();

    if victims.is_empty() {
        return Ok(());
    }
    for vault_rel in victims {
        if let Err(e) = unmirror_one(&ctx, &vault_rel, &mut manifest) {
            eprintln!(
                "[source_mirror] watcher unmirror of {} (brain {}) failed: {}",
                vault_rel, brain_id, e
            );
        }
    }

    let out = Manifest {
        entries: manifest.into_values().collect(),
        synced_at: Some(now_iso()),
    };
    save_manifest(brain_id, &out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subdir_is_the_raw_folder_name() {
        // Matches the /update-brain skill's `source.name` exactly — raw last
        // path segment, spaces and all, no sanitizing or hash.
        assert_eq!(source_subdir("/mnt/d/Projects/Foo"), "Foo");
        // Backslash is only a path separator on Windows; on Unix the whole
        // string is one component. Users only ever enter native paths, so
        // assert the Windows-style case only where it's meaningful.
        #[cfg(windows)]
        assert_eq!(source_subdir(r"D:\NEURO VAULT\My Notes"), "My Notes");
        // Two distinct roots sharing a basename intentionally map to the same
        // subdir (they merge under _source_files/<name>/, like the skill).
        assert_eq!(source_subdir("/a/Foo"), source_subdir("/b/Foo"));
    }

    #[test]
    fn vault_rel_matches_update_brain_layout() {
        let root = Path::new("/src/My Project");
        let root_abs = "/src/My Project";
        let file = Path::new("/src/My Project/sub/dir/note.md");
        let rel = vault_rel_for(root, root_abs, file).unwrap();
        // Exactly the layout `/update-brain` writes: _source_files/<name>/<rel>.
        assert_eq!(rel, "_source_files/My Project/sub/dir/note.md");
        assert!(!rel.contains('\\'));
    }

    #[test]
    fn hash_matches_sha256_known_vector() {
        // hashlib.sha256(b"hello").hexdigest()
        assert_eq!(
            hash_bytes(b"hello"),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }
}
