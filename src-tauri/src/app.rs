use serde::Serialize;
use slug::slugify;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::SystemTime;
#[cfg(feature = "direct-distribution")]
use tauri_plugin_shell::process::CommandChild;
use uuid::Uuid;

// Rust memory layer — the in-process replacement for the Python
// neurovault_server package. Exposes the in-process Tauri commands
// (nv_list_notes, nv_get_graph, nv_recall, ...) that the frontend
// now prefers over the legacy HTTP sidecar.
use crate::memory;

/// Shared state holding the Python sidecar child process (if running).
#[cfg(feature = "direct-distribution")]
struct ServerState(Mutex<Option<CommandChild>>);

/// The Store build has no child-process capability, but the command surface
/// keeps an inert state marker so frontend calls can return an explicit error.
#[cfg(feature = "app-store")]
struct ServerState;

/// Store setup failures are recoverable UI state, never a reason to abort the
/// process and strand the user's sandbox. React reads this before enabling any
/// vault mutation and can offer export/recovery guidance.
struct StoreStartupState(Mutex<Option<String>>);

/// Serialises every native read-modify-write of `brains.json` and the long
/// import/export operations that depend on a registry entry staying alive.
/// Atomic rename prevents torn JSON; this lock additionally prevents two IPC
/// commands from each publishing a valid but stale copy over the other.
static BRAIN_REGISTRY_LOCK: Mutex<()> = Mutex::new(());

fn lock_brain_registry() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    BRAIN_REGISTRY_LOCK
        .lock()
        .map_err(|_| "vault registry lock was poisoned".to_string())
}

#[derive(serde::Serialize)]
struct StoreStartupStatus {
    ready: bool,
    error: Option<String>,
}

#[tauri::command]
fn store_startup_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, StoreStartupState>,
) -> StoreStartupStatus {
    #[cfg(feature = "app-store")]
    {
        let should_retry = state.0.lock().map(|guard| guard.is_some()).unwrap_or(false);
        if should_retry {
            let retry_error = prepare_store_environment(&app).err();
            if let Ok(mut guard) = state.0.lock() {
                *guard = retry_error;
            }
        }
    }
    #[cfg(not(feature = "app-store"))]
    let _ = app;

    let error = state
        .0
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_else(|_| Some("startup status lock was poisoned".to_string()));
    StoreStartupStatus {
        ready: error.is_none(),
        error,
    }
}

#[cfg(feature = "direct-distribution")]
fn server_state() -> ServerState {
    ServerState(Mutex::new(None))
}

#[cfg(feature = "app-store")]
fn server_state() -> ServerState {
    ServerState
}

// Explicit Quit is a two-phase handshake: ExitRequested asks the frontend to
// flush its revisioned note buffer; only `quit_after_save` opens this gate.
static ALLOW_EXIT_AFTER_SAVE: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Serialize, Clone)]
pub struct NoteMeta {
    pub filename: String,
    pub title: String,
    pub modified: u64,
    pub size: u64,
}

/// Resolve the active NeuroVault data directory, with a one-time fallback
/// to the legacy `~/.engram/` path.
///
/// During the engram -> neurovault rename, some users will have data at
/// `~/.engram/` but not yet at `~/.neurovault/` — the Python server migrates
/// the directory on its first boot after the rename ships. If the desktop
/// app launches BEFORE the Python server has had a chance to migrate, this
/// helper still finds the vault so the UI isn't empty.
fn nv_home() -> PathBuf {
    if let Some(configured) = std::env::var_os("NEUROVAULT_HOME") {
        return PathBuf::from(configured);
    }
    let home = dirs::home_dir().expect("Could not determine home directory");
    let new_home = home.join(".neurovault");
    if new_home.exists() {
        return new_home;
    }
    let legacy_home = home.join(".engram");
    if legacy_home.exists() {
        return legacy_home;
    }
    // Fresh install: return the new path, caller will mkdir it.
    new_home
}

/// Find the active vault directory. Checks (in order):
/// 1. brains.json registry (multi-brain mode)
/// 2. Legacy single-brain ~/.neurovault/vault/ (pre-multi-brain migration)
/// 3. Creates ~/.neurovault/brains/default/vault/ as fallback
fn vault_dir() -> PathBuf {
    let nv_home = nv_home();

    // Try brains.json first (multi-brain mode). When the active brain has
    // an explicit `vault_path` (Obsidian-style external folder), honor it —
    // the user's folder is the vault, we don't create or seed it. Fall back
    // to the canonical internal path if vault_path is missing or stale.
    let registry_path = nv_home.join("brains.json");
    if registry_path.exists() {
        if let Ok(data) = fs::read_to_string(&registry_path) {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&data) {
                if let Some(active_id) = parsed.get("active").and_then(|v| v.as_str()) {
                    if !memory::read_ops::is_safe_brain_id(active_id) {
                        eprintln!(
                            "[neurovault] refusing unsafe active vault id from brains.json: {active_id:?}"
                        );
                        return nv_home.join("brains").join("default").join("vault");
                    }
                    if let Some(brains) = parsed.get("brains").and_then(|v| v.as_array()) {
                        for b in brains {
                            let id = b.get("id").and_then(|v| v.as_str()).unwrap_or("");
                            if id != active_id {
                                continue;
                            }
                            #[cfg(not(feature = "app-store"))]
                            if let Some(ext) = b.get("vault_path").and_then(|v| v.as_str()) {
                                let p = PathBuf::from(ext);
                                if p.is_dir() {
                                    return p;
                                }
                                eprintln!(
                                    "[neurovault] active brain {} has vault_path {:?} but it's missing \u{2014} falling back to internal vault",
                                    active_id, p
                                );
                            }
                            break;
                        }
                    }
                    let vault = nv_home.join("brains").join(active_id).join("vault");
                    return vault;
                }
            }
        }
    }

    // Legacy single-brain mode: {nv_home}/vault/
    let legacy_vault = nv_home.join("vault");
    if legacy_vault.exists() {
        return legacy_vault;
    }

    // Fresh install fallback: create default brain vault
    let default_vault = nv_home.join("brains").join("default").join("vault");
    fs::create_dir_all(&default_vault).expect("Could not create vault directory");
    seed_welcome_note(&default_vault);
    default_vault
}

/// Drop a welcome note into an empty vault so new users have something
/// to read when they first open the app. Does nothing if the vault
/// already has any .md files.
fn seed_welcome_note(vault: &PathBuf) {
    let has_notes = fs::read_dir(vault)
        .map(|entries| {
            entries
                .flatten()
                .any(|e| e.path().extension().and_then(|x| x.to_str()) == Some("md"))
        })
        .unwrap_or(true); // if we can't read the dir, don't seed
    if has_notes {
        return;
    }
    #[cfg(feature = "app-store")]
    let welcome = "# Welcome to NeuroVault\n\n\
**A private home for the knowledge you want to keep.**\n\n\
NeuroVault stores your notes and memory index locally inside this app's\n\
sandbox. Nothing is uploaded by NeuroVault.\n\n\
## Quick start\n\n\
- **Cmd+N** — create a note\n\
- **Cmd+K** — open the command palette\n\
- **Cmd+/** — search inside notes\n\
- **Cmd+2** — see your notes and their connections\n\
- Type `[[` in the editor to link notes together\n\n\
Use the vault menu to create another private vault or import a Markdown\n\
folder. Importing copies the Markdown files into NeuroVault; the original\n\
folder stays unchanged and is not watched in the background.\n\n\
You can export a vault as a ZIP at any time. Delete this welcome note when\n\
you're ready to make the space your own.\n";
    #[cfg(not(feature = "app-store"))]
    let welcome = "# Welcome to NeuroVault\n\n\
**Your AI memory system.**\n\n\
Claude forgets you after every conversation. NeuroVault doesn't.\n\n\
## Quick start\n\n\
- **Ctrl+N** — new note\n\
- **Ctrl+K** — command palette (everything lives here)\n\
- **Ctrl+/** — search inside notes\n\
- **?** — full shortcut list\n\
- Type `[[` in the editor to link notes together\n\
- Press **Ctrl+2** to see connections in the graph\n\n\
## Organizing notes\n\n\
Hover any note in the sidebar and click the pencil to rename. Type a\n\
slash in the name (e.g. `projects/kickoff.md`) to move it into a\n\
folder — the folder is created on the fly.\n\n\
## Your data\n\n\
Notes live as plain markdown files at **~/.neurovault/**. Point\n\
NeuroVault at an existing Obsidian vault via the dropdown (bottom-left)\n\
→ \"Open folder as vault\" and the folder stays in place.\n\n\
## Memory features (requires the server)\n\n\
Start the server from Settings to enable:\n\
- **Search** that understands meaning, not just keywords\n\
- **Connections** between related notes, automatically\n\
- **Knowledge graph** visualization\n\
- **Compilations** — AI-maintained canonical wiki pages\n\
- **Claude Desktop integration** — Settings → Connect Claude Desktop\n\n\
Delete this note when you're ready to start your own.\n";
    let path = vault.join("welcome.md");
    let _ = fs::write(&path, welcome);
}

fn extract_title(content: &str, filename: &str) -> String {
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(heading) = trimmed.strip_prefix("# ") {
            let title = heading.trim();
            if !title.is_empty() {
                return title.to_string();
            }
        }
    }
    filename
        .strip_suffix(".md")
        .unwrap_or(filename)
        .replace('-', " ")
}

fn vault_dir_for(brain_id: Option<&str>) -> Result<PathBuf, String> {
    let id = memory::resolve_brain_id(brain_id).map_err(|error| error.to_string())?;
    let vault = memory::resolve_vault_path(&id).map_err(|error| error.to_string())?;
    if !vault.is_dir() {
        return Err(format!(
            "vault directory is missing for registered brain {id:?}: {}",
            vault.display()
        ));
    }
    Ok(vault)
}

#[tauri::command]
fn get_vault_path(brain_id: Option<String>) -> Result<String, String> {
    Ok(vault_dir_for(brain_id.as_deref())?
        .to_string_lossy()
        .to_string())
}

/// Brain summary for the offline-fallback path. Fields mirror the server's
/// ``/api/brains`` response shape so the frontend can treat them identically.
#[derive(serde::Serialize)]
struct BrainInfoOffline {
    id: String,
    name: String,
    description: Option<String>,
    vault_path: Option<String>,
    is_active: bool,
}

#[derive(serde::Serialize)]
struct BrainMutationOffline {
    brain_id: String,
    name: String,
    vault_path: Option<String>,
    is_external: bool,
}

#[derive(serde::Serialize)]
struct BrainDeletionOffline {
    cleanup_pending: bool,
    recovery_path: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct DeletedBrainCleanupMarker {
    brain_id: String,
    archive_name: String,
}

fn is_valid_deleted_brain_cleanup_marker(marker: &DeletedBrainCleanupMarker) -> bool {
    if !memory::read_ops::is_safe_brain_id(&marker.brain_id) {
        return false;
    }
    let archive_name = std::path::Path::new(&marker.archive_name);
    let Some(name) = archive_name.to_str() else {
        return false;
    };
    if archive_name.components().count() != 1
        || !matches!(
            archive_name.components().next(),
            Some(std::path::Component::Normal(_))
        )
    {
        return false;
    }
    let Some(uuid) = name.strip_prefix(&format!("{}-", marker.brain_id)) else {
        return false;
    };
    Uuid::parse_str(uuid).is_ok()
}

fn remove_deleted_cleanup_tombstone(
    registry: &mut serde_json::Value,
    target: &DeletedBrainCleanupMarker,
) -> bool {
    let Some(tombstones) = registry
        .get_mut("deleted_cleanup")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return false;
    };
    let before = tombstones.len();
    tombstones.retain(|value| {
        serde_json::from_value::<DeletedBrainCleanupMarker>(value.clone())
            .map_or(true, |marker| marker != *target)
    });
    before != tombstones.len()
}

/// Best-effort physical erasure after the registry has committed the logical
/// deletion. The registry tombstone is the durable retry authority; this
/// sidecar marker preserves compatibility and observability, but failure to
/// write it must never stop an immediate attempt to erase the archive.
fn cleanup_deleted_archive_now(
    archive_root: &std::path::Path,
    archive: &std::path::Path,
    marker: &DeletedBrainCleanupMarker,
) -> bool {
    let marker_path = archive_root.join(format!("{}.cleanup.json", marker.archive_name));
    match serde_json::to_vec_pretty(marker) {
        Ok(marker_bytes) => {
            if let Err(error) = fs::write(&marker_path, marker_bytes) {
                eprintln!(
                    "[neurovault] cleanup marker write failed for {}: {error}; attempting immediate erasure",
                    archive.display()
                );
            }
        }
        Err(error) => eprintln!(
            "[neurovault] cleanup marker serialization failed for {}: {error}; attempting immediate erasure",
            archive.display()
        ),
    }

    if archive.exists() {
        if let Err(error) = fs::remove_dir_all(archive) {
            eprintln!(
                "[neurovault] deleted vault {:?}, but cleanup remains at {}: {error}",
                marker.brain_id,
                archive.display()
            );
            return false;
        }
    }
    let _ = fs::remove_file(marker_path);
    true
}

fn write_brain_registry(parsed: &serde_json::Value) -> Result<(), String> {
    let path = nv_home().join("brains.json");
    let parent = path
        .parent()
        .ok_or_else(|| "brains.json has no parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("create data directory: {e}"))?;
    let tmp = parent.join(format!(".brains-{}.json.tmp", Uuid::new_v4()));
    let serialised = serde_json::to_vec_pretty(parsed)
        .map_err(|e| format!("failed to serialise registry: {e}"))?;
    fs::write(&tmp, serialised).map_err(|e| format!("write temporary registry: {e}"))?;

    #[cfg(target_os = "windows")]
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("replace brains.json: {e}"))?;
    }
    if let Err(error) = fs::rename(&tmp, &path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("replace brains.json: {error}"));
    }
    Ok(())
}

/// Create a valid first vault for a sandboxed install before React asks for
/// the registry. Existing data is never replaced: a malformed registry is a
/// visible startup error, not an excuse to reset the user's memories.
#[cfg(feature = "app-store")]
fn ensure_store_default_brain() -> Result<String, String> {
    let _registry_guard = lock_brain_registry()?;
    let path = nv_home().join("brains.json");
    if path.exists() {
        let raw = fs::read_to_string(&path).map_err(|e| format!("read brains.json: {e}"))?;
        let mut parsed: serde_json::Value =
            serde_json::from_str(&raw).map_err(|e| format!("brains.json is malformed: {e}"))?;
        let brains = parsed
            .get("brains")
            .and_then(|value| value.as_array())
            .ok_or_else(|| "brains.json has no brains array".to_string())?;
        if brains.is_empty() {
            return Err("brains.json contains no vaults".to_string());
        }
        for brain in brains {
            let id = brain
                .get("id")
                .and_then(|value| value.as_str())
                .ok_or_else(|| "a vault in brains.json has no id".to_string())?;
            if !memory::read_ops::is_safe_brain_id(id) {
                return Err(format!("brains.json contains an unsafe vault id: {id:?}"));
            }
        }
        let active_is_valid = parsed
            .get("active")
            .and_then(|value| value.as_str())
            .is_some_and(|active| {
                brains
                    .iter()
                    .any(|brain| brain.get("id").and_then(|value| value.as_str()) == Some(active))
            });
        let mut registry_needs_repair = false;
        let active_id = if active_is_valid {
            parsed
                .get("active")
                .and_then(|value| value.as_str())
                .expect("validated active vault must be a string")
                .to_string()
        } else {
            let first = brains[0]
                .get("id")
                .and_then(|value| value.as_str())
                .ok_or_else(|| "first vault has no id".to_string())?
                .to_string();
            parsed["active"] = serde_json::Value::String(first);
            registry_needs_repair = true;
            parsed["active"]
                .as_str()
                .expect("new active vault must be a string")
                .to_string()
        };
        let vault = nv_home().join("brains").join(&active_id).join("vault");
        if !vault.is_dir() {
            return Err(format!(
                "registered vault {active_id:?} is missing from disk: {}",
                vault.display()
            ));
        }
        // Repair the active pointer only after proving the selected existing
        // vault is usable. Missing user data is a visible recovery state and
        // is never replaced with an empty Welcome library.
        if registry_needs_repair {
            write_brain_registry(&parsed)?;
        }
        return Ok(active_id);
    }

    let created_at = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string();
    let parsed = serde_json::json!({
        "active": "default",
        "brains": [{
            "id": "default",
            "name": "My Memory",
            "description": "Private local memory",
            "created_at": created_at
        }]
    });
    let vault = nv_home().join("brains").join("default").join("vault");
    fs::create_dir_all(&vault).map_err(|e| format!("create default vault: {e}"))?;
    fs::create_dir_all(nv_home().join("brains").join("default").join("trash"))
        .map_err(|e| format!("create default trash: {e}"))?;
    seed_welcome_note(&vault);
    write_brain_registry(&parsed)?;
    Ok("default".to_string())
}

#[cfg(feature = "app-store")]
fn prepare_store_environment(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    use tauri::Manager;

    let data_root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("resolve sandbox data directory: {error}"))?
        .join("Core");
    let model_root = app
        .path()
        .resource_dir()
        .map_err(|error| format!("resolve application resources: {error}"))?
        .join("appstore-model")
        .join("bge-small-en-v1.5");
    for required in [
        "model.onnx",
        "tokenizer.json",
        "config.json",
        "special_tokens_map.json",
        "tokenizer_config.json",
    ] {
        if !model_root.join(required).is_file() {
            return Err(format!(
                "bundled embedding model is incomplete: missing {required}"
            ));
        }
    }
    fs::create_dir_all(&data_root)
        .map_err(|error| format!("create sandbox data directory: {error}"))?;
    std::env::set_var("NEUROVAULT_HOME", &data_root);
    std::env::set_var("NEUROVAULT_BUNDLED_MODEL_DIR", &model_root);
    ensure_store_default_brain().map_err(|error| format!("prepare first local vault: {error}"))?;
    retry_deleted_cleanup(&data_root);
    Ok((data_root, model_root))
}

fn retry_deleted_cleanup(data_root: &std::path::Path) {
    let Ok(_registry_guard) = lock_brain_registry() else {
        return;
    };
    let Ok(raw_registry) = fs::read_to_string(data_root.join("brains.json")) else {
        return;
    };
    let Ok(mut registry) = serde_json::from_str::<serde_json::Value>(&raw_registry) else {
        return;
    };
    let Some(brains) = registry.get("brains").and_then(|value| value.as_array()) else {
        return;
    };
    let registered = brains
        .iter()
        .filter_map(|brain| brain.get("id").and_then(|value| value.as_str()))
        .map(str::to_string)
        .collect::<std::collections::HashSet<_>>();
    let deleted_root = data_root.join("deleted-brains");
    let registry_tombstones = registry
        .get("deleted_cleanup")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(|value| serde_json::from_value::<DeletedBrainCleanupMarker>(value.clone()).ok())
        .collect::<Vec<_>>();
    let mut cleared = Vec::new();

    // Registry tombstones are committed atomically with logical deletion, so
    // they remain a safe retry authority even when a full disk prevented the
    // optional sidecar marker from being written.
    for marker in registry_tombstones {
        if !is_valid_deleted_brain_cleanup_marker(&marker) || registered.contains(&marker.brain_id)
        {
            continue;
        }
        let archive = deleted_root.join(&marker.archive_name);
        if !archive.exists() || fs::remove_dir_all(&archive).is_ok() {
            let marker_path = deleted_root.join(format!("{}.cleanup.json", marker.archive_name));
            let _ = fs::remove_file(marker_path);
            cleared.push(marker);
        } else {
            eprintln!(
                "[neurovault] deferred deleted-library cleanup still pending at {}",
                archive.display()
            );
        }
    }

    // Continue accepting sidecar markers created by older builds. Strictly
    // validate their brain-id/UUID naming contract and registry state before
    // touching any path; arbitrary unmarked directories are never enumerated
    // for deletion.
    if let Ok(entries) = fs::read_dir(&deleted_root) {
        for entry in entries.flatten() {
            let marker_path = entry.path();
            if !entry.file_type().is_ok_and(|kind| kind.is_file())
                || !entry
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".cleanup.json")
            {
                continue;
            }
            let Some(marker) = fs::read_to_string(&marker_path)
                .ok()
                .and_then(|raw| serde_json::from_str::<DeletedBrainCleanupMarker>(&raw).ok())
            else {
                continue;
            };
            if !is_valid_deleted_brain_cleanup_marker(&marker)
                || registered.contains(&marker.brain_id)
            {
                continue;
            }
            let archive = deleted_root.join(&marker.archive_name);
            if !archive.exists() || fs::remove_dir_all(&archive).is_ok() {
                let _ = fs::remove_file(&marker_path);
                cleared.push(marker);
            } else {
                eprintln!(
                    "[neurovault] deferred deleted-library cleanup still pending at {}",
                    archive.display()
                );
            }
        }
    }

    let mut registry_changed = false;
    for marker in &cleared {
        registry_changed |= remove_deleted_cleanup_tombstone(&mut registry, marker);
    }
    if registry_changed {
        if let Err(error) = write_brain_registry(&registry) {
            // A stale registry tombstone is safe: the next launch sees the
            // archive is already absent and retries only the metadata cleanup.
            eprintln!("[neurovault] could not clear completed cleanup tombstones: {error}");
        }
    }
}

#[tauri::command]
fn create_brain_offline(name: String, description: String) -> Result<BrainMutationOffline, String> {
    let _registry_guard = lock_brain_registry()?;
    let name = name.trim();
    if name.is_empty() {
        return Err("Give the vault a name".to_string());
    }

    let path = nv_home().join("brains.json");
    let raw = fs::read_to_string(&path).map_err(|e| format!("read brains.json: {e}"))?;
    let mut parsed: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("brains.json malformed: {e}"))?;
    let base = slugify(name);
    if base.is_empty() || !memory::read_ops::is_safe_brain_id(&base) {
        return Err("The vault name could not be converted into a safe identifier".to_string());
    }
    let brains = parsed
        .get("brains")
        .and_then(|value| value.as_array())
        .ok_or_else(|| "brains.json has no brains array".to_string())?;
    let mut id = base.clone();
    let mut suffix = 2usize;
    while brains
        .iter()
        .any(|brain| brain.get("id").and_then(|value| value.as_str()) == Some(&id))
        || nv_home().join("brains").join(&id).exists()
    {
        id = format!("{base}-{suffix}");
        suffix += 1;
    }

    // Prepare the new app-owned directory before publishing it in the
    // registry. A disk-full or permission error must not leave a selectable
    // vault whose files were never created.
    let brain_root = nv_home().join("brains").join(&id);
    let vault = brain_root.join("vault");
    if let Err(error) =
        fs::create_dir_all(&vault).and_then(|_| fs::create_dir_all(brain_root.join("trash")))
    {
        let _ = fs::remove_dir_all(&brain_root);
        return Err(format!("create local vault: {error}"));
    }
    seed_welcome_note(&vault);

    let created_at = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string();
    parsed
        .get_mut("brains")
        .and_then(|value| value.as_array_mut())
        .expect("brains array was validated above")
        .push(serde_json::json!({
            "id": id,
            "name": name,
            "description": description.trim(),
            "created_at": created_at
        }));
    if parsed
        .get("active")
        .and_then(|value| value.as_str())
        .is_none()
    {
        parsed["active"] = serde_json::Value::String(id.clone());
    }
    if let Err(error) = write_brain_registry(&parsed) {
        let _ = fs::remove_dir_all(&brain_root);
        return Err(error);
    }

    Ok(BrainMutationOffline {
        brain_id: id,
        name: name.to_string(),
        vault_path: None,
        is_external: false,
    })
}

#[tauri::command]
fn update_brain_offline(
    brain_id: String,
    name: Option<String>,
    description: Option<String>,
) -> Result<(), String> {
    let _registry_guard = lock_brain_registry()?;
    if !memory::read_ops::is_safe_brain_id(&brain_id) {
        return Err("Invalid vault identifier".to_string());
    }
    let path = nv_home().join("brains.json");
    let raw = fs::read_to_string(&path).map_err(|e| format!("read brains.json: {e}"))?;
    let mut parsed: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("brains.json malformed: {e}"))?;
    let brain = parsed
        .get_mut("brains")
        .and_then(|value| value.as_array_mut())
        .and_then(|brains| {
            brains
                .iter_mut()
                .find(|brain| brain.get("id").and_then(|value| value.as_str()) == Some(&brain_id))
        })
        .ok_or_else(|| format!("vault '{brain_id}' not found"))?;
    if let Some(name) = name {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("Vault name cannot be empty".to_string());
        }
        brain["name"] = serde_json::Value::String(trimmed.to_string());
    }
    if let Some(description) = description {
        brain["description"] = serde_json::Value::String(description.trim().to_string());
    }
    write_brain_registry(&parsed)
}

#[tauri::command]
fn delete_brain_offline(brain_id: String) -> Result<BrainDeletionOffline, String> {
    let _registry_guard = lock_brain_registry()?;
    // Wait for any native save/index/export touching the app-owned tree.
    // An Arc<BrainDb> held by a detached index task remains writable even
    // after the cache entry is closed, so deletion must share its mutation
    // boundary rather than racing a database that has just been archived.
    let _mutation_guard = memory::write_ops::NOTE_MUTATION_LOCK.lock();
    if !memory::read_ops::is_safe_brain_id(&brain_id) {
        return Err("Invalid vault identifier".to_string());
    }
    let path = nv_home().join("brains.json");
    let raw = fs::read_to_string(&path).map_err(|e| format!("read brains.json: {e}"))?;
    let mut parsed: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("brains.json malformed: {e}"))?;
    let brains = parsed
        .get_mut("brains")
        .and_then(|value| value.as_array_mut())
        .ok_or_else(|| "brains.json has no brains array".to_string())?;
    if brains.len() <= 1 {
        return Err("Keep at least one vault".to_string());
    }
    let index = brains
        .iter()
        .position(|brain| brain.get("id").and_then(|value| value.as_str()) == Some(&brain_id))
        .ok_or_else(|| format!("vault '{brain_id}' not found"))?;
    brains.remove(index);
    if parsed.get("active").and_then(|value| value.as_str()) == Some(&brain_id) {
        let replacement = parsed["brains"][0]["id"]
            .as_str()
            .ok_or_else(|| "replacement vault has no id".to_string())?
            .to_string();
        parsed["active"] = serde_json::Value::String(replacement);
    }

    #[cfg(feature = "direct-distribution")]
    memory::watcher::stop_for_brain(&brain_id);
    memory::db::close_brain(&brain_id);
    let brain_dir = nv_home().join("brains").join(&brain_id);
    let archive_root = nv_home().join("deleted-brains");
    fs::create_dir_all(&archive_root).map_err(|e| format!("create recovery folder: {e}"))?;
    let archive = archive_root.join(format!("{}-{}", brain_id, Uuid::new_v4()));
    let moved = if brain_dir.exists() {
        fs::rename(&brain_dir, &archive)
            .map_err(|e| format!("archive vault before delete: {e}"))?;
        true
    } else {
        false
    };
    let cleanup_marker = moved.then(|| DeletedBrainCleanupMarker {
        brain_id: brain_id.clone(),
        archive_name: archive
            .file_name()
            .and_then(|value| value.to_str())
            .expect("UUID deletion archive names are valid UTF-8")
            .to_string(),
    });
    if let Some(marker) = cleanup_marker.as_ref() {
        let cleanup_value = parsed
            .as_object_mut()
            .expect("registry with a brains array is an object")
            .entry("deleted_cleanup")
            .or_insert_with(|| serde_json::Value::Array(Vec::new()));
        let Some(cleanup) = cleanup_value.as_array_mut() else {
            let rollback = fs::rename(&archive, &brain_dir);
            return match rollback {
                Ok(()) => Err("brains.json has an invalid deleted_cleanup field".to_string()),
                Err(rollback_error) => Err(format!(
                    "brains.json has an invalid deleted_cleanup field; CRITICAL rollback failure: {rollback_error}; intact recovery data remains at {}",
                    archive.display()
                )),
            };
        };
        cleanup.push(
            serde_json::to_value(marker)
                .expect("deleted cleanup markers contain only serializable strings"),
        );
    }
    if let Err(error) = write_brain_registry(&parsed) {
        if moved {
            if let Err(rollback_error) = fs::rename(&archive, &brain_dir) {
                return Err(format!(
                    "write registry after archiving vault: {error}; CRITICAL rollback failure: {rollback_error}; intact recovery data remains at {}",
                    archive.display()
                ));
            }
        }
        return Err(error);
    }
    if let Some(marker) = cleanup_marker.as_ref() {
        if !cleanup_deleted_archive_now(&archive_root, &archive, marker) {
            // Recursive deletion may already have removed part of the tree,
            // so pretending we can roll it back would republish a damaged
            // library. The registry removal and its tombstone are one durable
            // commit; startup will retry only this validated archive path.
            return Ok(BrainDeletionOffline {
                cleanup_pending: true,
                recovery_path: Some(archive.to_string_lossy().to_string()),
            });
        }
        if remove_deleted_cleanup_tombstone(&mut parsed, marker) {
            if let Err(error) = write_brain_registry(&parsed) {
                // Physical erasure succeeded. A stale tombstone contains no
                // user data and startup can clear it idempotently.
                eprintln!(
                    "[neurovault] deleted vault {brain_id:?}, but could not clear its completed cleanup tombstone: {error}"
                );
            }
        }
    }
    Ok(BrainDeletionOffline {
        cleanup_pending: false,
        recovery_path: None,
    })
}

/// List every brain from ``brains.json`` on disk, no HTTP server needed.
///
/// This is the fallback the Tauri frontend uses when the Python sidecar
/// is off. Without it, the BrainSelector dropdown shows an empty list and
/// the user can only create a new vault — they can't switch to an
/// existing one. Returns an empty vec when the registry is missing (fresh
/// install) so the frontend doesn't need to special-case that.
#[tauri::command]
fn list_brains_offline() -> Vec<BrainInfoOffline> {
    let registry_path = nv_home().join("brains.json");
    let Ok(data) = fs::read_to_string(&registry_path) else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&data) else {
        return Vec::new();
    };
    let active_id = parsed
        .get("active")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let Some(brains) = parsed.get("brains").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    brains
        .iter()
        .filter_map(|b| {
            let id = b.get("id").and_then(|v| v.as_str())?.to_string();
            if !memory::read_ops::is_safe_brain_id(&id) {
                eprintln!("[neurovault] skipping unsafe vault id in brains.json: {id:?}");
                return None;
            }
            let name = b
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or(&id)
                .to_string();
            let description = b
                .get("description")
                .and_then(|v| v.as_str())
                .map(String::from);
            #[cfg(not(feature = "app-store"))]
            let vault_path = b
                .get("vault_path")
                .and_then(|v| v.as_str())
                .map(String::from);
            #[cfg(feature = "app-store")]
            let vault_path = None;
            let is_active = id == active_id;
            Some(BrainInfoOffline {
                id,
                name,
                description,
                vault_path,
                is_active,
            })
        })
        .collect()
}

/// Switch the active brain by rewriting ``brains.json`` directly. Used
/// by the frontend when the server is off — ``vault_dir()`` re-reads
/// the registry on every filesystem call, so subsequent ``list_notes``
/// etc. will pick up the new active brain's vault without a restart.
///
/// Returns the new active brain's vault path so the frontend can
/// immediately fetch the note list for the switched-to vault.
#[tauri::command]
fn set_active_brain_offline(brain_id: String) -> Result<String, String> {
    let _registry_guard = lock_brain_registry()?;
    if !memory::read_ops::is_safe_brain_id(&brain_id) {
        return Err("Invalid vault identifier".to_string());
    }
    let registry_path = nv_home().join("brains.json");
    let data =
        fs::read_to_string(&registry_path).map_err(|e| format!("brains.json not readable: {e}"))?;
    let mut parsed: serde_json::Value =
        serde_json::from_str(&data).map_err(|e| format!("brains.json malformed: {e}"))?;

    // Validate the target id exists before switching — silently activating
    // a non-existent brain would leave the user stuck with no vault.
    let exists = parsed
        .get("brains")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .any(|b| b.get("id").and_then(|v| v.as_str()) == Some(&brain_id))
        })
        .unwrap_or(false);
    if !exists {
        return Err(format!("brain '{brain_id}' not found in registry"));
    }

    let target_vault = memory::resolve_vault_path(&brain_id).map_err(|e| e.to_string())?;
    if !target_vault.is_dir() {
        return Err(format!(
            "registered vault {brain_id:?} is missing from disk: {}",
            target_vault.display()
        ));
    }

    parsed["active"] = serde_json::Value::String(brain_id.clone());
    write_brain_registry(&parsed)?;

    // Direct builds watch external folders and serialize their changes into
    // the ingest pipeline. Store libraries are app-owned and use explicit
    // native save + background-index operations guarded by NOTE_MUTATION_LOCK;
    // starting a second watcher there would create a competing write path.
    #[cfg(feature = "direct-distribution")]
    {
        memory::watcher::stop_all();
        if let Err(e) = memory::watcher::start_for_brain(&brain_id, target_vault.clone()) {
            eprintln!("[neurovault] watcher start failed for {}: {}", brain_id, e);
        }
    }

    Ok(target_vault.to_string_lossy().to_string())
}

#[tauri::command]
fn list_notes(brain_id: Option<String>) -> Result<Vec<NoteMeta>, String> {
    let vault = vault_dir_for(brain_id.as_deref())?;
    let mut notes: Vec<NoteMeta> = Vec::new();

    // Recursively walk subdirectories so notes organized into folders
    // (`agent/`, `user/`, any user-created folder) are returned too. The
    // `filename` we return is the POSIX-style relative path from the vault
    // root (e.g. `agent/foo.md`), which the frontend splits on `/` to
    // build the folder tree and the same string round-trips unchanged
    // through read_note / save_note.
    fn walk(dir: &std::path::Path, vault_root: &std::path::Path, out: &mut Vec<NoteMeta>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                walk(&path, vault_root, out);
                continue;
            }
            if file_type.is_file() && path.extension().is_some_and(|ext| ext == "md") {
                let rel = path
                    .strip_prefix(vault_root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");
                let Ok(metadata) = fs::metadata(&path) else {
                    continue;
                };
                let modified = metadata
                    .modified()
                    .unwrap_or(SystemTime::UNIX_EPOCH)
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                let size = metadata.len();
                let content = fs::read_to_string(&path).unwrap_or_default();
                let title = extract_title(&content, &rel);
                out.push(NoteMeta {
                    filename: rel,
                    title,
                    modified,
                    size,
                });
            }
        }
    }
    walk(&vault, &vault, &mut notes);

    notes.sort_by_key(|n| std::cmp::Reverse(n.modified));
    Ok(notes)
}

#[tauri::command]
fn read_note(filename: String, brain_id: Option<String>) -> Result<String, String> {
    let ctx = write_context(brain_id.as_deref())?;
    memory::read_note_content(&ctx, &filename).map_err(|e| format!("Failed to read note: {e}"))
}

#[tauri::command]
fn save_note(filename: String, content: String) -> Result<(), String> {
    let ctx = write_context(None)?;
    memory::save_note(&ctx, &filename, &content)
        .map(|_| ())
        .map_err(|e| format!("Failed to save note: {e}"))
}

#[tauri::command]
fn create_note(title: String) -> Result<String, String> {
    let ctx = write_context(None)?;
    memory::create_note(&ctx, &title)
        .map(|result| result.filename)
        .map_err(|e| format!("Failed to create note: {e}"))
}

#[tauri::command]
fn delete_note(filename: String) -> Result<(), String> {
    let ctx = write_context(None)?;
    memory::delete_note(&ctx, &filename)
        .map(|_| ())
        .map_err(|e| format!("Failed to delete note: {e}"))
}

/// Import an external folder as a NeuroVault vault. Copies all .md files
/// from the source folder (recursively) into the target brain's vault/
/// directory. Returns the number of files imported.
#[tauri::command]
fn import_folder_as_vault(source: String, target_brain_id: String) -> Result<usize, String> {
    let _registry_guard = lock_brain_registry()?;
    let _mutation_guard = memory::write_ops::NOTE_MUTATION_LOCK.lock();
    if !memory::read_ops::is_safe_brain_id(&target_brain_id) {
        return Err("Invalid target vault identifier".to_string());
    }
    let registry_raw = fs::read_to_string(nv_home().join("brains.json"))
        .map_err(|error| format!("read brains.json before import: {error}"))?;
    let registry: serde_json::Value = serde_json::from_str(&registry_raw)
        .map_err(|error| format!("brains.json malformed before import: {error}"))?;
    let target_exists = registry
        .get("brains")
        .and_then(|value| value.as_array())
        .is_some_and(|brains| {
            brains.iter().any(|brain| {
                brain.get("id").and_then(|value| value.as_str()) == Some(&target_brain_id)
            })
        });
    if !target_exists {
        return Err(format!(
            "target vault {target_brain_id:?} is not registered"
        ));
    }
    let src_path = PathBuf::from(&source);
    if !src_path.exists() || !src_path.is_dir() {
        return Err(format!("Source folder not found: {source}"));
    }

    // Imports always copy into the app-owned vault. In the Store flavor the
    // source path is a temporary user-selected sandbox grant; persisting that
    // raw path would stop working after relaunch without a security-scoped
    // bookmark. A one-shot copy is both durable and honest about ownership.
    let target_root = nv_home().join("brains").join(&target_brain_id);
    let target_vault = target_root.join("vault");
    if !target_vault.is_dir() {
        return Err(format!(
            "Registered target vault is missing: {}",
            target_vault.display()
        ));
    }

    let source_root =
        fs::canonicalize(&src_path).map_err(|e| format!("Could not resolve source folder: {e}"))?;
    let canonical_target = fs::canonicalize(&target_vault)
        .map_err(|e| format!("Could not resolve target vault: {e}"))?;
    if source_root.starts_with(&canonical_target) || canonical_target.starts_with(&source_root) {
        return Err("Choose a folder outside the destination vault".to_string());
    }

    struct RemoveDirOnDrop(PathBuf);
    impl Drop for RemoveDirOnDrop {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    // Assemble a complete replacement beside the live vault. No imported
    // file becomes visible until every source file has copied successfully.
    let stage = target_root.join(format!(".import-{}", Uuid::new_v4()));
    fs::create_dir(&stage).map_err(|e| format!("create import staging folder: {e}"))?;
    let stage_guard = RemoveDirOnDrop(stage.clone());

    fn copy_owned_tree(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
        for entry in
            fs::read_dir(src).map_err(|e| format!("read existing vault {}: {e}", src.display()))?
        {
            let entry = entry.map_err(|e| format!("read existing vault entry: {e}"))?;
            let path = entry.path();
            let file_type = entry
                .file_type()
                .map_err(|e| format!("inspect existing vault item {}: {e}", path.display()))?;
            if file_type.is_symlink() {
                return Err(format!(
                    "Existing vault contains a symbolic link that cannot be imported safely: {}",
                    path.display()
                ));
            }
            let entry_name = entry.file_name();
            let Some(entry_name_text) = entry_name.to_str() else {
                return Err("Existing vault paths must use valid UTF-8 filenames".to_string());
            };
            if entry_name_text.contains('\\') || entry_name_text == "." || entry_name_text == ".." {
                return Err(format!(
                    "Existing vault contains an unsafe filename: {entry_name_text:?}"
                ));
            }
            let target = dst.join(entry_name);
            if file_type.is_dir() {
                fs::create_dir(&target)
                    .map_err(|e| format!("stage existing folder {}: {e}", target.display()))?;
                copy_owned_tree(&path, &target)?;
            } else if file_type.is_file() {
                fs::copy(&path, &target)
                    .map_err(|e| format!("stage existing note {}: {e}", path.display()))?;
            }
        }
        Ok(())
    }
    copy_owned_tree(&target_vault, &stage)?;

    // Walk the source folder, preserve its Markdown hierarchy, skip symlinks,
    // and never overwrite a file already owned by the destination vault.
    fn copy_md_files(
        src: &PathBuf,
        source_root: &PathBuf,
        dst: &PathBuf,
        copied: &mut Vec<String>,
    ) -> Result<(), String> {
        let entries = fs::read_dir(src).map_err(|e| format!("read_dir {src:?}: {e}"))?;
        for entry in entries {
            let entry = entry.map_err(|error| format!("read entry in {src:?}: {error}"))?;
            let path = entry.path();
            let file_type = entry
                .file_type()
                .map_err(|e| format!("inspect {path:?}: {e}"))?;
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                copy_md_files(&path, source_root, dst, copied)?;
                continue;
            }
            let is_markdown = path
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("md"));
            if !file_type.is_file() || !is_markdown {
                continue;
            }

            let relative = path
                .strip_prefix(source_root)
                .map_err(|e| format!("resolve relative import path: {e}"))?;
            for component in relative.components() {
                let std::path::Component::Normal(name) = component else {
                    return Err(format!("Unsafe import path: {}", relative.display()));
                };
                let Some(name) = name.to_str() else {
                    return Err("Import paths must use valid UTF-8 filenames".to_string());
                };
                // A literal backslash is a legal macOS filename character but
                // becomes a ZIP separator in many extractors. Reject it at
                // ingress so one note can never turn into a `../` archive path
                // or an unopenable frontend filename later.
                if name.contains('\\') || name == "." || name == ".." {
                    return Err(format!("Unsafe import filename: {name:?}"));
                }
            }
            // The ingest/read surfaces use canonical lowercase `.md` paths.
            // Accept `.MD` from a user-selected source, but normalize the
            // copied filename so it cannot be reported as imported while
            // remaining invisible to Memories and graph indexing.
            let mut normalized_relative = relative.to_path_buf();
            normalized_relative.set_extension("md");
            let requested_target = dst.join(normalized_relative);
            let mut target = requested_target.clone();
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("create import folder {parent:?}: {e}"))?;
            }
            let mut input = fs::File::open(&path).map_err(|e| format!("open {path:?}: {e}"))?;
            loop {
                match fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&target)
                {
                    Ok(mut output) => {
                        if let Err(error) =
                            std::io::copy(&mut input, &mut output).and_then(|_| output.sync_all())
                        {
                            drop(output);
                            let _ = fs::remove_file(&target);
                            return Err(format!("copy {path:?}: {error}"));
                        }
                        break;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                        let stem = requested_target
                            .file_stem()
                            .and_then(|value| value.to_str())
                            .unwrap_or("note");
                        let collision =
                            format!("{stem}-imported-{}.md", &Uuid::new_v4().to_string()[..8]);
                        target = requested_target.with_file_name(collision);
                    }
                    Err(error) => {
                        return Err(format!("create imported note {target:?}: {error}"));
                    }
                }
            }
            let imported_filename = target
                .strip_prefix(dst)
                .map_err(|e| format!("resolve imported Markdown path: {e}"))?
                .to_string_lossy()
                .replace('\\', "/");
            copied.push(imported_filename);
        }
        Ok(())
    }

    let mut copied = Vec::new();
    copy_md_files(&source_root, &source_root, &stage, &mut copied)?;

    // Publish the fully staged tree. If the second rename fails, restore the
    // original directory before returning so callers never observe a partial
    // import while believing the operation simply failed.
    let backup = target_root.join(format!(".pre-import-{}", Uuid::new_v4()));
    fs::rename(&target_vault, &backup)
        .map_err(|e| format!("prepare atomic import publish: {e}"))?;
    if let Err(error) = fs::rename(&stage, &target_vault) {
        let rollback = fs::rename(&backup, &target_vault);
        return match rollback {
            Ok(()) => Err(format!("publish imported vault: {error}")),
            Err(rollback_error) => Err(format!(
                "publish imported vault: {error}; CRITICAL rollback failure: {rollback_error}; original data remains at {}",
                backup.display()
            )),
        };
    }
    drop(stage_guard);
    fs::remove_dir_all(&backup).map_err(|e| {
        format!(
            "import published, but the pre-import recovery copy could not be removed at {}: {e}",
            backup.display()
        )
    })?;

    Ok(copied.len())
}

/// Start the bundled Python MCP server as a sidecar process.
/// Returns Err if already running, or if the sidecar binary can't be spawned.
#[tauri::command]
fn start_server(
    app: tauri::AppHandle,
    state: tauri::State<'_, ServerState>,
) -> Result<String, String> {
    #[cfg(feature = "app-store")]
    {
        let _ = (app, state);
        return Err(
            "The Mac App Store build does not install or launch an MCP sidecar. \
             NeuroVault Core runs separately and does not share this app's memories."
                .into(),
        );
    }

    #[cfg(feature = "direct-distribution")]
    {
        use std::env;
        use tauri_plugin_shell::ShellExt;

        let mut guard = state.0.lock().map_err(|e| format!("lock: {e}"))?;
        if guard.is_some() {
            return Err("Server is already running".into());
        }

        // Log where we're looking for the sidecar so we can diagnose failures
        let current_exe = env::current_exe()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| "<unknown>".into());
        let exe_dir = env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.display().to_string()))
            .unwrap_or_else(|| "<unknown>".into());
        eprintln!("[start_server] main exe: {current_exe}");
        eprintln!("[start_server] exe dir:  {exe_dir}");

        // Check what files actually exist in the exe directory
        if let Ok(dir) = fs::read_dir(&exe_dir) {
            eprintln!("[start_server] files in exe dir:");
            for entry in dir.flatten() {
                let name = entry.file_name();
                eprintln!("[start_server]   - {}", name.to_string_lossy());
            }
        }

        let cmd = app.shell().sidecar("neurovault-server").map_err(|e| {
            eprintln!("[start_server] sidecar() returned Err: {e}");
            format!("sidecar binary not found: {e}")
        })?;

        eprintln!("[start_server] sidecar command built, spawning with --http-only");

        let (_rx, child) = cmd.args(["--http-only"]).spawn().map_err(|e| {
            eprintln!("[start_server] spawn() failed: {e}");
            format!("failed to spawn: {e}")
        })?;

        let pid = child.pid();
        eprintln!("[start_server] spawned successfully, pid={pid}");
        *guard = Some(child);
        Ok(format!("Server started (pid {})", pid))
    }
}

/// Stop the running sidecar server. Returns Ok whether or not anything
/// was actually running (idempotent).
#[tauri::command]
fn stop_server(state: tauri::State<'_, ServerState>) -> Result<String, String> {
    #[cfg(feature = "app-store")]
    {
        let _ = state;
        return Ok("The Mac App Store build has no sidecar process".into());
    }

    #[cfg(feature = "direct-distribution")]
    {
        let mut guard = state.0.lock().map_err(|e| format!("lock: {e}"))?;
        if let Some(child) = guard.take() {
            child.kill().map_err(|e| format!("failed to kill: {e}"))?;
            Ok("Server stopped".into())
        } else {
            Ok("Server was not running".into())
        }
    }
}

/// Report whether the sidecar is currently running (from the Tauri side).
/// The frontend also polls the HTTP endpoint, but this tells you if WE
/// spawned the server vs someone else started it externally.
#[tauri::command]
fn server_status(state: tauri::State<'_, ServerState>) -> Result<bool, String> {
    #[cfg(feature = "app-store")]
    {
        let _ = state;
        return Ok(false);
    }

    #[cfg(feature = "direct-distribution")]
    {
        let guard = state.0.lock().map_err(|e| format!("lock: {e}"))?;
        Ok(guard.is_some())
    }
}

/// Zip up a brain's Markdown and structured state into a single archive at
/// `dest_path`. SQLite's online-backup API supplies a transactionally
/// consistent `brain.db`; live WAL/SHM files are never copied. Internal brains
/// include the remaining app-owned tree, while direct-distribution external
/// brains also include a read-only copy of their Markdown folder.
#[tauri::command]
fn export_brain_as_zip(brain_id: String, dest_path: String) -> Result<usize, String> {
    use std::io::Write;
    let _registry_guard = lock_brain_registry()?;
    // One coherent boundary covers the SQLite snapshot and every file read.
    // Native save/index/delete/import commands share this same lock.
    let _mutation_guard = memory::write_ops::NOTE_MUTATION_LOCK.lock();
    if !memory::read_ops::is_safe_brain_id(&brain_id) {
        return Err("Invalid vault identifier".to_string());
    }
    let nv_home = nv_home();
    let brain_root = nv_home.join("brains").join(&brain_id);
    if !brain_root.is_dir() {
        return Err(format!("brain not found: {brain_id}"));
    }

    let requested_dest = PathBuf::from(dest_path);
    let requested_parent = requested_dest
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("."));
    let dest_parent = fs::canonicalize(requested_parent)
        .map_err(|e| format!("resolve export destination: {e}"))?;
    let dest_name = requested_dest
        .file_name()
        .ok_or_else(|| "Choose a ZIP filename, not a directory".to_string())?;
    let dest_name = dest_name
        .to_str()
        .ok_or_else(|| "Export filenames must use valid UTF-8".to_string())?;
    if dest_name.starts_with('.')
        || dest_name.contains('/')
        || dest_name.contains('\\')
        || dest_name.chars().any(char::is_control)
        || !dest_name.to_ascii_lowercase().ends_with(".zip")
        || dest_name.len() <= ".zip".len()
    {
        return Err("Choose a safe filename ending in .zip".to_string());
    }
    let dest_path = dest_parent.join(dest_name);
    let canonical_nv_home = fs::canonicalize(&nv_home)
        .map_err(|e| format!("resolve NeuroVault data directory before export: {e}"))?;
    if dest_parent.starts_with(&canonical_nv_home) {
        return Err(
            "Choose an export destination outside NeuroVault's private data directory".into(),
        );
    }
    if dest_path.exists() {
        return Err("An item already exists at the export destination; choose another name".into());
    }
    let canonical_brain_root =
        fs::canonicalize(&brain_root).map_err(|e| format!("resolve vault before export: {e}"))?;
    if dest_parent.starts_with(&canonical_brain_root) {
        return Err("Choose an export destination outside this vault".to_string());
    }

    // Resolve the external vault_path if this is an external-folder brain
    // so we can include the user's markdown alongside the internal DB.
    #[cfg(not(feature = "app-store"))]
    let registry = nv_home.join("brains.json");
    #[cfg(not(feature = "app-store"))]
    let external_vault: Option<PathBuf> = fs::read_to_string(&registry)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| {
            v.get("brains")
                .and_then(|a| a.as_array())
                .and_then(|brains| {
                    brains.iter().find_map(|b| {
                        if b.get("id").and_then(|x| x.as_str()) == Some(&brain_id) {
                            b.get("vault_path")
                                .and_then(|x| x.as_str())
                                .map(PathBuf::from)
                        } else {
                            None
                        }
                    })
                })
        });

    // Store libraries always live in the sandbox container. Even if a
    // hand-edited registry contains a stale host path, the Store flavor must
    // not treat it as an implicitly authorised external source.
    #[cfg(feature = "app-store")]
    let external_vault: Option<PathBuf> = None;

    #[cfg(not(feature = "app-store"))]
    if let Some(external) = external_vault.as_ref().filter(|path| path.is_dir()) {
        let canonical_external = fs::canonicalize(external)
            .map_err(|e| format!("resolve external vault before export: {e}"))?;
        if dest_parent.starts_with(&canonical_external) {
            return Err("Choose an export destination outside the source Markdown folder".into());
        }
    }

    struct RemoveOnDrop(PathBuf);
    impl Drop for RemoveOnDrop {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }

    // Never archive a live `brain.db` beside independently changing WAL/SHM
    // files. The SQLite backup API observes one consistent database snapshot
    // while ordinary reads and writes continue safely.
    let live_db = brain_root.join("brain.db");
    let db_snapshot = if live_db.is_file() {
        let snapshot = std::env::temp_dir().join(format!(
            "neurovault-export-{}-{}.db",
            brain_id,
            Uuid::new_v4()
        ));
        let handle =
            memory::db::open_brain(&brain_id).map_err(|e| format!("open index for export: {e}"))?;
        handle
            .lock()
            .backup(rusqlite::DatabaseName::Main, &snapshot, None)
            .map_err(|e| format!("create consistent index snapshot: {e}"))?;
        Some(RemoveOnDrop(snapshot))
    } else {
        None
    };

    // Build beside the destination and publish only after ZIP finalisation.
    // A failed export therefore leaves neither a half-written archive nor a
    // truncated previous backup at the user-selected path.
    let output_tmp = dest_parent.join(format!(".{}.{}.tmp", dest_name, Uuid::new_v4()));
    let output_guard = RemoveOnDrop(output_tmp.clone());
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&output_tmp)
        .map_err(|e| format!("create temporary zip: {e}"))?;

    let mut zip = zip::ZipWriter::new(file);
    let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let mut count: usize = 0;

    // Recursive file walker: adds every readable regular file under
    // `src_root` into the ZIP and skips symlinks. For the app-owned brain tree
    // it excludes the live SQLite files, which are replaced by the consistent
    // snapshot above.
    fn add_tree<W: Write + std::io::Seek>(
        zip: &mut zip::ZipWriter<W>,
        src_root: &std::path::Path,
        zip_prefix: &str,
        options: zip::write::SimpleFileOptions,
        count: &mut usize,
        skip_live_db: bool,
    ) -> Result<(), String> {
        fn zip_entry_name(prefix: &str, relative: &std::path::Path) -> Result<String, String> {
            let mut parts = Vec::new();
            for component in relative.components() {
                let std::path::Component::Normal(name) = component else {
                    return Err(format!(
                        "unsafe relative export path: {}",
                        relative.display()
                    ));
                };
                let Some(name) = name.to_str() else {
                    return Err("Export paths must use valid UTF-8 filenames".to_string());
                };
                if name.contains('\\') || name.contains('/') || name == "." || name == ".." {
                    return Err(format!("Unsafe export filename: {name:?}"));
                }
                parts.push(name);
            }
            if parts.is_empty() {
                return Err("Refusing an empty ZIP entry name".to_string());
            }
            Ok(format!(
                "{}/{}",
                prefix.trim_end_matches('/'),
                parts.join("/")
            ))
        }

        let mut stack: Vec<PathBuf> = vec![src_root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let entries = fs::read_dir(&dir)
                .map_err(|e| format!("read export folder {}: {e}", dir.display()))?;
            for entry in entries {
                let entry = entry.map_err(|e| {
                    format!("read an entry in export folder {}: {e}", dir.display())
                })?;
                let path = entry.path();
                let ft = entry
                    .file_type()
                    .map_err(|e| format!("inspect export item {}: {e}", path.display()))?;
                if ft.is_symlink() {
                    continue;
                }
                if ft.is_dir() {
                    stack.push(path);
                    continue;
                }
                if ft.is_file() {
                    let rel = path
                        .strip_prefix(src_root)
                        .map_err(|e| format!("resolve export path {}: {e}", path.display()))?;
                    if skip_live_db
                        && rel.components().count() == 1
                        && matches!(
                            rel.file_name().and_then(|name| name.to_str()),
                            Some("brain.db" | "brain.db-wal" | "brain.db-shm")
                        )
                    {
                        continue;
                    }
                    let mut input = fs::File::open(&path)
                        .map_err(|e| format!("open export file {}: {e}", path.display()))?;
                    let name = zip_entry_name(zip_prefix, rel)?;
                    zip.start_file(&name, options)
                        .map_err(|e| format!("zip entry {name}: {e}"))?;
                    std::io::copy(&mut input, zip)
                        .map_err(|e| format!("stream export file {}: {e}", path.display()))?;
                    *count += 1;
                }
            }
        }
        Ok(())
    }

    // Internal scratch (DB, fingerprint, trash, raw, consolidated, and
    // — for non-external brains — vault/).
    add_tree(&mut zip, &brain_root, &brain_id, options, &mut count, true)?;

    if let Some(snapshot) = db_snapshot.as_ref() {
        let mut input = fs::File::open(&snapshot.0)
            .map_err(|e| format!("open consistent index snapshot: {e}"))?;
        let name = format!("{brain_id}/brain.db");
        zip.start_file(&name, options)
            .map_err(|e| format!("zip entry {name}: {e}"))?;
        std::io::copy(&mut input, &mut zip).map_err(|e| format!("stream index snapshot: {e}"))?;
        count += 1;
    }

    // External vault markdown goes under `<brain_id>/external_vault/`
    // so the archive is self-describing when the user unzips it.
    if let Some(ext) = external_vault {
        if ext.is_dir() {
            let prefix = format!("{brain_id}/external_vault");
            add_tree(&mut zip, &ext, &prefix, options, &mut count, false)?;
        }
    }

    let output = zip.finish().map_err(|e| format!("finalize zip: {e}"))?;
    output
        .sync_all()
        .map_err(|e| format!("flush completed zip: {e}"))?;
    // A sibling hard link is an atomic, no-clobber publish: unlike rename it
    // fails if another file appeared after our initial collision check. The
    // temporary link is then removed by the guard, leaving exactly the final
    // user-visible archive.
    fs::hard_link(&output_tmp, &dest_path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            "An item already exists at the export destination; choose another name".to_string()
        } else {
            format!("publish completed zip without overwriting: {error}")
        }
    })?;
    drop(output_guard);
    Ok(count)
}

#[cfg(test)]
mod export_tests {
    use super::*;
    use std::ffi::OsString;
    use std::io::Read;

    struct TestEnvironment {
        root: PathBuf,
        extra_roots: Vec<PathBuf>,
        brain_id: String,
        previous_home: Option<OsString>,
        previous_vec: Option<OsString>,
    }

    impl Drop for TestEnvironment {
        fn drop(&mut self) {
            memory::db::close_brain(&self.brain_id);
            match self.previous_home.take() {
                Some(value) => std::env::set_var("NEUROVAULT_HOME", value),
                None => std::env::remove_var("NEUROVAULT_HOME"),
            }
            match self.previous_vec.take() {
                Some(value) => std::env::set_var("NEUROVAULT_VEC_EXTENSION", value),
                None => std::env::remove_var("NEUROVAULT_VEC_EXTENSION"),
            }
            let _ = fs::remove_dir_all(&self.root);
            for root in &self.extra_roots {
                let _ = fs::remove_dir_all(root);
            }
        }
    }

    #[cfg(feature = "app-store")]
    #[test]
    fn store_startup_never_reseeds_or_recreates_an_existing_registered_library() {
        let _home_guard = crate::memory::journal::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let brain_id = format!("startup-{}", Uuid::new_v4().simple());
        let root = std::env::temp_dir().join(format!("neurovault-startup-test-{brain_id}"));
        fs::create_dir_all(&root).unwrap();
        let environment = TestEnvironment {
            root: root.clone(),
            extra_roots: Vec::new(),
            brain_id: brain_id.clone(),
            previous_home: std::env::var_os("NEUROVAULT_HOME"),
            previous_vec: std::env::var_os("NEUROVAULT_VEC_EXTENSION"),
        };
        std::env::set_var("NEUROVAULT_HOME", &root);

        let vault = root.join("brains").join(&brain_id).join("vault");
        fs::create_dir_all(vault.join("projects")).unwrap();
        fs::write(vault.join("projects/proof.md"), "# Existing nested note\n").unwrap();
        fs::write(
            root.join("brains.json"),
            serde_json::to_vec(&serde_json::json!({
                "active": brain_id,
                "brains": [{ "id": brain_id, "name": "Existing" }]
            }))
            .unwrap(),
        )
        .unwrap();

        assert_eq!(ensure_store_default_brain().unwrap(), brain_id);
        assert!(vault.join("projects/proof.md").is_file());
        assert!(
            !vault.join("welcome.md").exists(),
            "resolution must not recreate a welcome note the user deleted"
        );

        fs::remove_dir_all(&vault).unwrap();
        let error = ensure_store_default_brain().unwrap_err();
        assert!(error.contains("missing from disk"));
        assert!(
            !vault.exists(),
            "missing registered data must stay a visible recovery error"
        );

        drop(environment);
    }

    #[test]
    fn cleanup_still_erases_archive_when_sidecar_marker_cannot_be_written() {
        let brain_id = format!("deleted-{}", Uuid::new_v4().simple());
        let archive_root =
            std::env::temp_dir().join(format!("neurovault-cleanup-marker-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&archive_root).unwrap();
        let marker = DeletedBrainCleanupMarker {
            brain_id: brain_id.clone(),
            archive_name: format!("{brain_id}-{}", Uuid::new_v4()),
        };
        let archive = archive_root.join(&marker.archive_name);
        fs::create_dir_all(&archive).unwrap();
        fs::write(archive.join("private.md"), "erase me").unwrap();

        // A directory at the marker filename makes fs::write fail reliably on
        // every platform without relying on permission behavior.
        let marker_path = archive_root.join(format!("{}.cleanup.json", marker.archive_name));
        fs::create_dir_all(&marker_path).unwrap();

        assert!(cleanup_deleted_archive_now(
            &archive_root,
            &archive,
            &marker
        ));
        assert!(!archive.exists(), "marker failure must not block erasure");
        let _ = fs::remove_dir_all(archive_root);
    }

    #[test]
    fn cleanup_retries_registry_tombstones_and_leaves_unmarked_archives_alone() {
        let _home_guard = crate::memory::journal::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let root =
            std::env::temp_dir().join(format!("neurovault-cleanup-retry-test-{}", Uuid::new_v4()));
        let default_id = format!("default-{}", Uuid::new_v4().simple());
        let removed_id = format!("removed-{}", Uuid::new_v4().simple());
        let environment = TestEnvironment {
            root: root.clone(),
            extra_roots: Vec::new(),
            brain_id: default_id.clone(),
            previous_home: std::env::var_os("NEUROVAULT_HOME"),
            previous_vec: std::env::var_os("NEUROVAULT_VEC_EXTENSION"),
        };
        std::env::set_var("NEUROVAULT_HOME", &root);

        let deleted_root = root.join("deleted-brains");
        let marker = DeletedBrainCleanupMarker {
            brain_id: removed_id.clone(),
            archive_name: format!("{removed_id}-{}", Uuid::new_v4()),
        };
        let archive = deleted_root.join(&marker.archive_name);
        let unmarked = deleted_root.join(format!("unmarked-{}", Uuid::new_v4()));
        fs::create_dir_all(&archive).unwrap();
        fs::create_dir_all(&unmarked).unwrap();
        fs::write(archive.join("private.md"), "retry erasure").unwrap();
        fs::write(unmarked.join("keep.md"), "not authorised for deletion").unwrap();
        fs::write(
            root.join("brains.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "active": default_id,
                "brains": [{ "id": default_id, "name": "Keep" }],
                "deleted_cleanup": [marker]
            }))
            .unwrap(),
        )
        .unwrap();

        retry_deleted_cleanup(&root);

        assert!(!archive.exists(), "registry tombstone must authorize retry");
        assert!(
            unmarked.is_dir(),
            "unmarked directories must never be deleted"
        );
        let registry: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join("brains.json")).unwrap()).unwrap();
        assert_eq!(
            registry["deleted_cleanup"].as_array().unwrap().len(),
            0,
            "completed cleanup tombstone should be removed"
        );

        drop(environment);
    }

    #[test]
    fn export_uses_a_consistent_sqlite_snapshot_and_never_archives_itself() {
        let _home_guard = crate::memory::journal::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let brain_id = format!("export-{}", Uuid::new_v4().simple());
        let root = std::env::temp_dir().join(format!("neurovault-export-test-{brain_id}"));
        fs::create_dir_all(&root).unwrap();
        let export_root = std::env::temp_dir().join(format!("neurovault-exports-{brain_id}"));
        fs::create_dir_all(&export_root).unwrap();
        let environment = TestEnvironment {
            root: root.clone(),
            extra_roots: vec![export_root.clone()],
            brain_id: brain_id.clone(),
            previous_home: std::env::var_os("NEUROVAULT_HOME"),
            previous_vec: std::env::var_os("NEUROVAULT_VEC_EXTENSION"),
        };
        std::env::set_var("NEUROVAULT_HOME", &root);

        #[cfg(not(feature = "app-store"))]
        {
            let extension = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("resources")
                .join(if cfg!(target_os = "windows") {
                    "vec0.dll"
                } else if cfg!(target_os = "macos") {
                    "vec0.dylib"
                } else {
                    "vec0.so"
                });
            std::env::set_var("NEUROVAULT_VEC_EXTENSION", extension);
        }

        let brain_root = root.join("brains").join(&brain_id);
        let vault = brain_root.join("vault");
        fs::create_dir_all(&vault).unwrap();
        fs::write(
            vault.join("proof.md"),
            "# Durable proof\n\nMarkdown survives.",
        )
        .unwrap();
        fs::write(
            root.join("brains.json"),
            serde_json::to_vec(&serde_json::json!({
                "active": brain_id,
                "brains": [{ "id": brain_id, "name": "Export test" }]
            }))
            .unwrap(),
        )
        .unwrap();

        let db = memory::db::open_brain(&environment.brain_id).unwrap();
        db.lock()
            .execute_batch(
                "CREATE TABLE export_probe(value TEXT NOT NULL);\
                 INSERT INTO export_probe(value) VALUES ('committed');",
            )
            .unwrap();

        let archive_path = export_root.join("backup.zip");
        let count = export_brain_as_zip(
            environment.brain_id.clone(),
            archive_path.to_string_lossy().to_string(),
        )
        .unwrap();
        assert!(
            count >= 2,
            "Markdown and the database snapshot must both ship"
        );

        let file = fs::File::open(&archive_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let names = archive.file_names().map(str::to_string).collect::<Vec<_>>();
        assert!(names.contains(&format!("{}/vault/proof.md", environment.brain_id)));
        assert!(names.contains(&format!("{}/brain.db", environment.brain_id)));
        assert!(!names.iter().any(|name| name.ends_with("brain.db-wal")));
        assert!(!names.iter().any(|name| name.ends_with("brain.db-shm")));
        assert!(!names.iter().any(|name| name.ends_with("backup.zip")));

        let extracted_db = root.join("exported-brain.db");
        let mut db_bytes = Vec::new();
        archive
            .by_name(&format!("{}/brain.db", environment.brain_id))
            .unwrap()
            .read_to_end(&mut db_bytes)
            .unwrap();
        fs::write(&extracted_db, db_bytes).unwrap();
        let exported = rusqlite::Connection::open(extracted_db).unwrap();
        let value: String = exported
            .query_row("SELECT value FROM export_probe", [], |row| row.get(0))
            .unwrap();
        assert_eq!(value, "committed");

        let unsafe_destination = vault.join("recursive-backup.zip");
        let error = export_brain_as_zip(
            environment.brain_id.clone(),
            unsafe_destination.to_string_lossy().to_string(),
        )
        .unwrap_err();
        assert!(error.contains("outside NeuroVault's private data directory"));
        assert!(!unsafe_destination.exists());

        let non_zip_destination = export_root.join("backup.txt");
        let error = export_brain_as_zip(
            environment.brain_id.clone(),
            non_zip_destination.to_string_lossy().to_string(),
        )
        .unwrap_err();
        assert!(error.contains("safe filename ending in .zip"));
        assert!(!non_zip_destination.exists());

        let unsafe_basename = export_root.join(r"..\forged.zip");
        let error = export_brain_as_zip(
            environment.brain_id.clone(),
            unsafe_basename.to_string_lossy().to_string(),
        )
        .unwrap_err();
        assert!(error.contains("safe filename ending in .zip"));
        assert!(!unsafe_basename.exists());

        let original_archive = fs::read(&archive_path).unwrap();
        let error = export_brain_as_zip(
            environment.brain_id.clone(),
            archive_path.to_string_lossy().to_string(),
        )
        .unwrap_err();
        assert!(error.contains("already exists"));
        assert_eq!(fs::read(&archive_path).unwrap(), original_archive);

        let archive_size = fs::metadata(&archive_path).unwrap().len();
        fs::write(vault.join(r"..\..\escape.md"), "# Unsafe archive name\n").unwrap();
        let unsafe_content_destination = export_root.join("unsafe-content.zip");
        let error = export_brain_as_zip(
            environment.brain_id.clone(),
            unsafe_content_destination.to_string_lossy().to_string(),
        )
        .unwrap_err();
        assert!(error.contains("Unsafe export filename"));
        assert!(!unsafe_content_destination.exists());
        assert_eq!(
            fs::metadata(&archive_path).unwrap().len(),
            archive_size,
            "a failed export must preserve the previous good archive"
        );

        drop(exported);
        drop(archive);
        drop(db);
        drop(environment);
    }

    #[test]
    fn import_is_copy_only_normalises_markdown_and_never_overwrites() {
        let _home_guard = crate::memory::journal::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let brain_id = format!("import-{}", Uuid::new_v4().simple());
        let root = std::env::temp_dir().join(format!("neurovault-import-test-{brain_id}"));
        fs::create_dir_all(&root).unwrap();
        let environment = TestEnvironment {
            root: root.clone(),
            extra_roots: Vec::new(),
            brain_id: brain_id.clone(),
            previous_home: std::env::var_os("NEUROVAULT_HOME"),
            previous_vec: std::env::var_os("NEUROVAULT_VEC_EXTENSION"),
        };
        std::env::set_var("NEUROVAULT_HOME", &root);

        let source = root.join("selected-source");
        fs::create_dir_all(source.join("nested")).unwrap();
        fs::write(source.join("nested/idea.MD"), "# Imported idea\n").unwrap();
        fs::write(source.join("second.md"), "# Second note\n").unwrap();
        fs::write(source.join("ignored.txt"), "not Markdown\n").unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let outside = root.join("outside");
            fs::create_dir_all(&outside).unwrap();
            fs::write(outside.join("secret.md"), "# Must not follow\n").unwrap();
            symlink(&outside, source.join("linked-folder")).unwrap();
        }

        let destination = root.join("brains").join(&brain_id).join("vault");
        fs::create_dir_all(destination.join("nested")).unwrap();
        fs::write(destination.join("nested/idea.md"), "# Existing note\n").unwrap();
        fs::write(
            root.join("brains.json"),
            serde_json::to_vec(&serde_json::json!({
                "active": brain_id,
                "brains": [{ "id": brain_id, "name": "Import test" }]
            }))
            .unwrap(),
        )
        .unwrap();

        let imported = import_folder_as_vault(
            source.to_string_lossy().to_string(),
            environment.brain_id.clone(),
        )
        .unwrap();
        assert_eq!(imported, 2);
        assert_eq!(
            fs::read_to_string(destination.join("nested/idea.md")).unwrap(),
            "# Existing note\n"
        );
        let collision = fs::read_dir(destination.join("nested"))
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("idea-imported-") && name.ends_with(".md"))
            })
            .expect("the imported collision must get a unique lowercase .md name");
        assert_eq!(fs::read_to_string(collision).unwrap(), "# Imported idea\n");
        assert_eq!(
            fs::read_to_string(destination.join("second.md")).unwrap(),
            "# Second note\n"
        );
        assert!(!destination.join("ignored.txt").exists());
        assert!(!destination.join("linked-folder/secret.md").exists());
        assert_eq!(
            fs::read_to_string(source.join("nested/idea.MD")).unwrap(),
            "# Imported idea\n",
            "the user-selected source must remain untouched"
        );

        let registry = fs::read_to_string(root.join("brains.json")).unwrap();
        assert!(!registry.contains(&source.to_string_lossy().to_string()));

        fs::write(
            source.join(r"..\..\escape.MD"),
            "# Must remain a literal source filename\n",
        )
        .unwrap();
        let error = import_folder_as_vault(
            source.to_string_lossy().to_string(),
            environment.brain_id.clone(),
        )
        .unwrap_err();
        assert!(error.contains("Unsafe import filename"));
        assert_eq!(
            fs::read_to_string(destination.join("second.md")).unwrap(),
            "# Second note\n",
            "a rejected staged import must not alter the live library"
        );
        assert!(!root.join("escape.md").exists());

        drop(environment);
    }
}

/// Is automatic recall (Claude Code hooks) currently installed?
#[tauri::command]
fn nv_auto_recall_status() -> bool {
    #[cfg(feature = "app-store")]
    {
        return false;
    }

    #[cfg(not(feature = "app-store"))]
    memory::hooks::hooks_installed_at(&memory::hooks::claude_settings_path())
}

#[cfg(feature = "direct-distribution")]
fn set_automatic_context_menu_state(app: &tauri::AppHandle, enabled: bool) {
    use tauri::menu::MenuItemKind;
    let Some(menu) = app.menu() else { return };
    let Some(MenuItemKind::Submenu(application_menu)) = menu.get("neurovault-menu") else {
        return;
    };
    let Some(MenuItemKind::Check(item)) = application_menu.get("automatic-context") else {
        return;
    };
    let _ = item.set_checked(enabled);
}

/// Install or remove the automatic-recall hooks in the user's Claude
/// Code settings. Install points the hook entries at the bundled
/// `neurovault-server` sidecar; idempotent (re-install refreshes the
/// path). The hooks themselves fail open when the app isn't running.
#[tauri::command]
fn nv_auto_recall_set(app: tauri::AppHandle, enabled: bool) -> std::result::Result<String, String> {
    #[cfg(feature = "app-store")]
    {
        let _ = (app, enabled);
        return Err(
            "The Mac App Store sandbox cannot edit Claude Code settings. \
             NeuroVault Core runs separately and does not share this app's memories."
                .into(),
        );
    }

    #[cfg(not(feature = "app-store"))]
    {
        let settings = memory::hooks::claude_settings_path();
        let result = if enabled {
            let sidecar = mcp_sidecar_path();
            if sidecar.is_empty() {
                return Err("sidecar binary not found next to the app".into());
            }
            memory::hooks::install_hooks_at(&settings, std::path::Path::new(&sidecar))
                .map_err(|e| e.to_string())
        } else {
            memory::hooks::uninstall_hooks_at(&settings).map_err(|e| e.to_string())
        };
        if result.is_ok() {
            set_automatic_context_menu_state(&app, enabled);
        }
        result
    }
}

/// Return the resolved absolute path to the `neurovault-server` sidecar
/// binary so the Settings UI can render a Claude Desktop MCP config
/// pointing at it. We check both the target-triple-suffixed name (how
/// PyInstaller ships it) and the plain name (how Tauri copies it into
/// the install dir). Returns an empty string if neither exists — the UI
/// then shows a friendly "install the server first" message instead.
#[tauri::command]
fn mcp_sidecar_path() -> String {
    #[cfg(feature = "app-store")]
    {
        return String::new();
    }

    #[cfg(not(feature = "app-store"))]
    {
        use std::env;
        let exe_dir = match env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        {
            Some(d) => d,
            None => return String::new(),
        };
        let suffix = if cfg!(target_os = "windows") {
            ".exe"
        } else {
            ""
        };
        let candidates = [
            format!("neurovault-server{suffix}"),
            #[cfg(target_os = "windows")]
            format!("neurovault-server-x86_64-pc-windows-msvc{suffix}"),
            #[cfg(target_os = "macos")]
            format!("neurovault-server-aarch64-apple-darwin{suffix}"),
            #[cfg(target_os = "macos")]
            format!("neurovault-server-x86_64-apple-darwin{suffix}"),
        ];
        for name in candidates.iter() {
            let p = exe_dir.join(name);
            if p.exists() {
                return p.display().to_string();
            }
        }
        String::new()
    }
}

/// Return the OS-specific path to Claude Desktop's MCP config file.
/// Returns the path even if the file doesn't exist yet — the user may
/// need to create it on first setup.
#[tauri::command]
fn mcp_config_path() -> String {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return String::new(),
    };
    let p = if cfg!(target_os = "windows") {
        dirs::config_dir()
            .unwrap_or_else(|| home.join("AppData").join("Roaming"))
            .join("Claude")
            .join("claude_desktop_config.json")
    } else if cfg!(target_os = "macos") {
        home.join("Library")
            .join("Application Support")
            .join("Claude")
            .join("claude_desktop_config.json")
    } else {
        home.join(".config")
            .join("Claude")
            .join("claude_desktop_config.json")
    };
    p.display().to_string()
}

/// Path to Claude Code's user-scope config: `~/.claude.json` — a file at the
/// home-directory ROOT. This is deliberately NOT `~/.claude/.mcp.json`: that
/// path is only read by Claude Code for project-level approval
/// (`enabledMcpjsonServers`), never as a source of servers to spawn. Claude
/// Code loads user-scope MCP servers from `~/.claude.json` → `mcpServers`.
#[tauri::command]
fn claude_code_config_path() -> String {
    match dirs::home_dir() {
        Some(h) => h.join(".claude.json").display().to_string(),
        None => String::new(),
    }
}

#[derive(Debug, Serialize)]
struct McpRegisterResult {
    /// Absolute path written.
    path: String,
    /// The file did not exist and was created fresh.
    created: bool,
    /// An existing `neurovault` entry was replaced (vs. added for the first time).
    updated: bool,
}

/// One-click "Connect Claude Code": register (or refresh) the NeuroVault MCP
/// server in `~/.claude.json` under `mcpServers.neurovault`.
///
/// This MERGES into the existing file and never blindly overwrites it —
/// `~/.claude.json` also holds the user's Claude Code auth tokens and other
/// state, so clobbering it would log them out. Rules:
///   - missing file        → create `{ "mcpServers": { "neurovault": … } }`
///   - present + valid JSON → splice our entry into `mcpServers`, keep the rest
///   - present + INVALID    → abort with an error (we will NOT destroy a file
///                            we can't safely round-trip)
/// The write is atomic (temp file in the same dir + rename) so a crash
/// mid-write can never leave `~/.claude.json` truncated.
#[tauri::command]
fn register_claude_code_mcp() -> Result<McpRegisterResult, String> {
    #[cfg(feature = "app-store")]
    {
        return Err("The Mac App Store sandbox cannot modify ~/.claude.json. \
             NeuroVault Core runs separately and does not share this app's memories."
            .into());
    }

    #[cfg(not(feature = "app-store"))]
    {
        let sidecar = mcp_sidecar_path();
        if sidecar.is_empty() {
            return Err(
                "neurovault-server sidecar not found next to the app — reinstall NeuroVault".into(),
            );
        }
        let home = dirs::home_dir().ok_or("could not resolve home directory")?;
        let path = home.join(".claude.json");

        // Load existing config. Crucially, a parse failure must NOT fall through
        // to an empty object — that would overwrite a real (just malformed) file
        // and wipe the user's login. Only a genuinely missing file starts empty.
        let (mut root, created) = match fs::read_to_string(&path) {
            Ok(text) => {
                let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
                    format!(
                    "~/.claude.json exists but isn't valid JSON ({e}). Refusing to overwrite it \
                     (it holds your Claude Code login). Fix the file, or register manually."
                )
                })?;
                (v, false)
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => (serde_json::json!({}), true),
            Err(e) => return Err(format!("read ~/.claude.json: {e}")),
        };

        let obj = root
            .as_object_mut()
            .ok_or("~/.claude.json is not a JSON object; refusing to modify it")?;
        let servers = obj
            .entry("mcpServers")
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .ok_or("\"mcpServers\" in ~/.claude.json is not an object; refusing to modify it")?;

        let updated = servers.contains_key("neurovault");
        servers.insert(
            "neurovault".to_string(),
            serde_json::json!({
                "type": "stdio",
                "command": sidecar,
                "args": ["--mcp-only"],
            }),
        );

        let pretty =
            serde_json::to_string_pretty(&root).map_err(|e| format!("serialize config: {e}"))?;
        let tmp = path.with_extension("json.nv-tmp");
        fs::write(&tmp, pretty.as_bytes()).map_err(|e| format!("write temp config: {e}"))?;
        fs::rename(&tmp, &path).map_err(|e| {
            let _ = fs::remove_file(&tmp);
            format!("replace ~/.claude.json: {e}")
        })?;

        Ok(McpRegisterResult {
            path: path.display().to_string(),
            created,
            updated,
        })
    }
}

/// Reveal the MCP config file in the OS file manager so the user can
/// open/edit it quickly. On Windows uses `explorer /select,`; on macOS
/// uses `open -R`. No-op on Linux (most distros' file managers vary).
#[tauri::command]
fn reveal_in_file_manager(path: String) -> Result<(), String> {
    #[cfg(feature = "app-store")]
    {
        let _ = path;
        return Err("Reveal is unavailable in the Mac App Store build".into());
    }

    #[cfg(not(feature = "app-store"))]
    {
        // Only the Windows and macOS arms below spawn anything; the Linux arm is a
        // deliberate no-op, so an unconditional import is dead there and trips
        // `-D warnings` on the Linux CI runner.
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        use std::process::Command;
        #[cfg(target_os = "windows")]
        {
            Command::new("explorer")
                .args(["/select,", &path])
                .spawn()
                .map_err(|e| format!("explorer failed: {e}"))?;
            Ok(())
        }
        #[cfg(target_os = "macos")]
        {
            Command::new("open")
                .args(["-R", &path])
                .spawn()
                .map_err(|e| format!("open failed: {e}"))?;
            Ok(())
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            let _ = path;
            Err("reveal_in_file_manager not supported on this platform".into())
        }
    }
}

/// Tell the user ONCE that closing the window did not stop memory.
/// Delivered as an OS notification because the window is already hidden
/// (an in-app toast would be invisible). Flag lives next to the other
/// app state so it survives restarts; failures are silent — a missing
/// hint must never break closing a window.
fn notify_hidden_once() {
    let flag = crate::memory::paths::nv_home().join(".close-hint-shown");
    if flag.exists() {
        return;
    }
    let _ = fs::create_dir_all(flag.parent().unwrap_or(&flag));
    let _ = fs::write(&flag, "1");
    #[cfg(all(target_os = "macos", not(feature = "app-store")))]
    {
        let _ = std::process::Command::new("osascript")
            .arg("-e")
            .arg(
                "display notification \"Memory keeps running in the background. \
                 Reopen from the Dock, or quit to stop it.\" with title \"NeuroVault\"",
            )
            .spawn();
    }
}

/// Hide the main window without quitting the app. The sidecar keeps running
/// and the user can restore via Cmd+Shift+Space on macOS or Ctrl+Shift+Space
/// elsewhere (the quick-capture shortcut
/// also unhides/focuses the window).
#[tauri::command]
fn hide_to_background(window: tauri::Window) -> Result<(), String> {
    window.hide().map_err(|e| format!("hide: {e}"))
}

#[tauri::command]
fn quit_after_save(app: tauri::AppHandle) {
    ALLOW_EXIT_AFTER_SAVE.store(true, Ordering::SeqCst);
    app.exit(0);
}

/// Minimise the *main* window to the Dock / taskbar. Targets the main window
/// by label (not the calling window) so it works from the minitab too, and
/// uses the Rust window API directly so it needs no `core:window` ACL grant.
/// Restored by clicking the Dock/taskbar icon — on macOS that routes through
/// the `RunEvent::Reopen` handler (unminimise+show+focus) — or via the global
/// Ctrl/Cmd+Shift+Space shortcut.
#[tauri::command]
fn minimize_main(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("main") {
        w.minimize().map_err(|e| format!("minimize: {e}"))?;
    }
    Ok(())
}

/// Bring the full app window to the front — the minitab's "Open app" button.
#[tauri::command]
fn open_main_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        w.show().map_err(|e| format!("show main: {e}"))?;
        let _ = w.set_focus();
    }
    Ok(())
}

/// Bring the existing app window forward and ask its router to show Settings.
/// A single webview means one theme, one health store, and one unsaved-note
/// barrier instead of a second copy of application state.
fn open_settings_in_main(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        window.show().map_err(|e| format!("show main: {e}"))?;
        let _ = window.set_focus();
        window
            .emit("open-settings-requested", ())
            .map_err(|e| format!("open settings: {e}"))?;
    }
    Ok(())
}

/// Show the floating "minitab" control, parked near the top-right corner.
#[tauri::command]
fn show_minitab(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("minitab") {
        park_minitab_top_right(&w);
        w.show().map_err(|e| format!("show minitab: {e}"))?;
        let _ = w.set_focus();
    }
    Ok(())
}

/// Hide the floating minitab.
#[tauri::command]
fn hide_minitab(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("minitab") {
        w.hide().map_err(|e| format!("hide minitab: {e}"))?;
    }
    Ok(())
}

/// Toggle the minitab between its full control card and a tiny logo-only
/// "puck". The webview decides what to render (full UI vs. just the logo);
/// this resizes the OS window to match so the transparent area never eats
/// clicks meant for whatever is behind it, then re-parks top-right so the
/// shrink/grow always anchors to the same corner.
#[tauri::command]
fn set_minitab_collapsed(app: tauri::AppHandle, collapsed: bool) -> Result<(), String> {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("minitab") {
        // Logical sizes — keep in sync with the React layout in Minitab.tsx.
        let (lw, lh) = if collapsed {
            (60.0, 60.0)
        } else {
            (248.0, 132.0)
        };
        w.set_size(tauri::LogicalSize::new(lw, lh))
            .map_err(|e| format!("resize minitab: {e}"))?;
        // Position from the *target* logical size rather than outer_size(),
        // which can still report the pre-resize dimensions on this turn of
        // the event loop.
        park_minitab(&w, Some((lw, lh)));
    }
    Ok(())
}

/// Park the minitab window near the top-right corner of its current monitor
/// (falls back to the primary monitor), with a small margin. Pass `logical`
/// to position against a known logical size (used right after a resize, when
/// `outer_size()` may still be stale); pass `None` to use the live size.
fn park_minitab(w: &tauri::WebviewWindow, logical: Option<(f64, f64)>) {
    let monitor = w
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| w.primary_monitor().ok().flatten());
    if let Some(m) = monitor {
        let ms = m.size();
        let mp = m.position();
        let scale = m.scale_factor();
        let win_w = match logical {
            Some((lw, _)) => (lw * scale) as u32,
            None => w
                .outer_size()
                .map(|s| s.width)
                .unwrap_or_else(|_| (224.0 * scale) as u32),
        };
        let margin = (16.0 * scale) as i32;
        let x = mp.x + ms.width as i32 - win_w as i32 - margin;
        let y = mp.y + margin;
        let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
    }
}

/// Back-compat wrapper: park using the window's live size.
fn park_minitab_top_right(w: &tauri::WebviewWindow) {
    park_minitab(w, None);
}

/// "Shrink to widget": swap the full app window for the floating minitab.
/// Shows + parks the minitab top-right FIRST so there is always an on-screen
/// surface, *then* hides the main window — the user is never left staring at
/// nothing. The minitab keeps whatever size/state it was last in (full card
/// or collapsed puck), so window size and React state stay in sync. Recover
/// via the minitab's "Open app" button, the Dock icon (macOS Reopen), or
/// Ctrl/Cmd+Shift+Space.
#[tauri::command]
fn shrink_to_widget(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if let Some(mt) = app.get_webview_window("minitab") {
        park_minitab_top_right(&mt);
        mt.show().map_err(|e| format!("show minitab: {e}"))?;
        let _ = mt.set_focus();
    }
    if let Some(main) = app.get_webview_window("main") {
        main.hide().map_err(|e| format!("hide main: {e}"))?;
    }
    Ok(())
}

#[derive(Debug, Serialize)]
struct BrainStorageStats {
    note_count: u64,
    markdown_bytes: u64,
    db_bytes: u64,
    total_bytes: u64,
}

/// Walk the active brain's vault and report markdown file count + total size.
/// Also includes the SQLite DB size so the user sees true on-disk footprint.
#[tauri::command]
fn brain_storage_stats() -> Result<BrainStorageStats, String> {
    let vault = vault_dir();
    let brain_root = vault
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or(vault.clone());

    let mut note_count: u64 = 0;
    let mut markdown_bytes: u64 = 0;
    fn walk(dir: &std::path::Path, count: &mut u64, bytes: &mut u64) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, count, bytes);
            } else if path.extension().and_then(|s| s.to_str()) == Some("md") {
                if let Ok(meta) = entry.metadata() {
                    *count += 1;
                    *bytes += meta.len();
                }
            }
        }
    }
    walk(&vault, &mut note_count, &mut markdown_bytes);

    let mut db_bytes: u64 = 0;
    for name in ["brain.db", "brain.db-wal", "brain.db-shm"] {
        if let Ok(meta) = fs::metadata(brain_root.join(name)) {
            db_bytes += meta.len();
        }
    }

    Ok(BrainStorageStats {
        note_count,
        markdown_bytes,
        db_bytes,
        total_bytes: markdown_bytes + db_bytes,
    })
}

// --- Rust memory layer: Phase-4 read-path commands ----------------------
//
// These Tauri commands expose `memory::read_ops` to the frontend. They're
// the first user-visible piece of the Python→Rust migration — each one
// replaces an HTTP endpoint (`GET /api/notes`, `/api/graph`, etc.) with
// an in-process call that doesn't require the Python sidecar to be
// running. The frontend uses feature detection: if the Tauri command
// is available it calls here, otherwise it falls back to the HTTP
// path. That keeps behaviour stable throughout the migration.
//
// Error handling: `memory::MemoryError` is mapped to `String` at the
// Tauri boundary so it serialises cleanly through IPC. The matching
// HTTP layer already returns strings, so the frontend handles both
// error shapes identically.

/// List every non-dormant engram in the given (or active) brain.
/// Replaces `GET /api/notes`. `brain_id` = null → active brain from
/// `brains.json`.
#[tauri::command]
fn nv_list_notes(
    brain_id: Option<String>,
) -> std::result::Result<Vec<memory::NoteListRow>, String> {
    let (_id, db) = memory::brain_from_id(brain_id.as_deref()).map_err(|e| e.to_string())?;
    memory::list_notes(&db).map_err(|e| e.to_string())
}

/// Fetch one engram by id, including outbound connections + entities.
/// Replaces `GET /api/notes/{engram_id}`. 404 from Python becomes a
/// `MemoryError::EngramNotFound` string here.
#[tauri::command]
fn nv_get_note(
    engram_id: String,
    brain_id: Option<String>,
) -> std::result::Result<memory::FullNote, String> {
    let (_id, db) = memory::brain_from_id(brain_id.as_deref()).map_err(|e| e.to_string())?;
    memory::get_note(&db, &engram_id).map_err(|e| e.to_string())
}

/// List every brain in the registry enriched with disk footprint.
/// Replaces `GET /api/brains`. Broken brains (unreadable vault,
/// missing DB) are returned with zeroed stats so the BrainSelector
/// stays populated even when one brain is in a bad state.
#[tauri::command]
fn nv_list_brains() -> std::result::Result<Vec<memory::BrainSummary>, String> {
    memory::list_brains_with_stats().map_err(|e| e.to_string())
}

/// Disk + note-count footprint for one brain. Replaces
/// `GET /api/brains/{brain_id}/stats`.
#[tauri::command]
fn nv_brain_stats(brain_id: String) -> std::result::Result<memory::BrainStats, String> {
    memory::brain_stats(&brain_id).map_err(|e| e.to_string())
}

/// Knowledge graph payload for the given (or active) brain. Replaces
/// `GET /api/graph`. Defaults: observations excluded, `min_similarity
/// = 0.85` (raised from the 0.75 Python legacy in v0.1.7 — the
/// looser threshold turned dense brains into a visually unreadable
/// hairball). The frontend's `graphFromDisk.ts` already consumes
/// this exact shape.
#[tauri::command]
fn nv_get_graph(
    brain_id: Option<String>,
    include_observations: Option<bool>,
    min_similarity: Option<f64>,
    exclude_types: Option<Vec<String>>,
) -> std::result::Result<memory::types::GraphData, String> {
    let (_id, db) = memory::brain_from_id(brain_id.as_deref()).map_err(|e| e.to_string())?;
    memory::get_graph(
        &db,
        include_observations.unwrap_or(false),
        min_similarity.unwrap_or(0.85),
        &exclude_types.unwrap_or_default(),
    )
    .map_err(|e| e.to_string())
}

// --- Phase-5 write-path commands ---------------------------------------
//
// These replace `save_note` / `create_note` / `delete_note` for callers
// that want the full ingest pipeline to run (chunk, embed, entities,
// links, BM25 rebuild). The legacy file-only commands stay around for
// back-compat — frontend code that already uses them keeps working
// and the ingest can be run asynchronously (via file watcher) if
// needed. The Phase-5 variants are the path the frontend migrates to.
//
// Brain resolution binds the DB and vault path to the same explicit id. This
// matters during a UI vault switch: an old buffered write must never resolve
// its filesystem destination from the newly-active process-global brain.

fn write_context(brain_id: Option<&str>) -> std::result::Result<memory::BrainContext, String> {
    let id = memory::resolve_brain_id(brain_id).map_err(|e| e.to_string())?;
    let vault = memory::resolve_vault_path(&id).map_err(|e| e.to_string())?;
    memory::BrainContext::resolve(Some(&id), vault).map_err(|e| e.to_string())
}

/// Write `content` to `filename` under the active brain's vault and
/// run the ingest pipeline. Returns the engram id + status.
#[tauri::command]
fn nv_save_note(
    filename: String,
    content: String,
    brain_id: Option<String>,
) -> std::result::Result<memory::WriteResult, String> {
    let ctx = write_context(brain_id.as_deref())?;
    memory::save_note(&ctx, &filename, &content).map_err(|e| e.to_string())
}

/// Create a new note from `title`. Generates a slug-based filename
/// and seeds the file with a `# title` heading before ingest. Returns
/// the generated filename so the frontend can navigate to it.
#[tauri::command]
fn nv_create_note(
    title: String,
    brain_id: Option<String>,
) -> std::result::Result<memory::WriteResult, String> {
    let ctx = write_context(brain_id.as_deref())?;
    memory::create_note(&ctx, &title).map_err(|e| e.to_string())
}

/// Rename or move one Markdown note in-process. The memory layer retains the
/// stable engram id and either preserves the existing derived index (a path
/// only move) or rebuilds it when the Markdown title changes.
#[tauri::command]
fn nv_rename_note(
    filename: String,
    new_filename: String,
    new_title: Option<String>,
    brain_id: Option<String>,
) -> std::result::Result<memory::WriteResult, String> {
    let ctx = write_context(brain_id.as_deref())?;
    memory::rename_note(&ctx, &filename, &new_filename, new_title.as_deref())
        .map_err(|e| e.to_string())
}

/// Rescan regular Markdown already inside one vault. Embedding can take long
/// enough to block the webview on a copied vault, so run the synchronous
/// memory pipeline on Tauri's blocking pool and return per-file failures.
#[tauri::command]
async fn nv_index_brain(
    brain_id: Option<String>,
) -> std::result::Result<memory::IndexBrainResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ctx = write_context(brain_id.as_deref())?;
        memory::index_brain(&ctx).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("vault indexing task failed: {error}"))?
}

/// Soft-delete the engram backing `filename` and move the file to the
/// per-brain trash. Returns the engram id so the frontend can
/// optimistically drop it from the sidebar store.
#[tauri::command]
fn nv_delete_note(
    filename: String,
    brain_id: Option<String>,
) -> std::result::Result<memory::WriteResult, String> {
    let ctx = write_context(brain_id.as_deref())?;
    memory::delete_note(&ctx, &filename).map_err(|e| e.to_string())
}

/// List recoverable Markdown notes in the active brain's trash folder.
#[tauri::command]
fn nv_list_trash(brain_id: Option<String>) -> std::result::Result<Vec<memory::TrashEntry>, String> {
    let ctx = write_context(brain_id.as_deref())?;
    memory::list_trash(&ctx).map_err(|e| e.to_string())
}

/// Restore one trash leaf to its original vault-relative path (or a safe
/// collision-suffixed path) and rebuild its searchable memory representation.
#[tauri::command]
fn nv_restore_note(
    trashed_filename: String,
    brain_id: Option<String>,
) -> std::result::Result<memory::WriteResult, String> {
    let ctx = write_context(brain_id.as_deref())?;
    memory::restore_note(&ctx, &trashed_filename).map_err(|e| e.to_string())
}

/// Copy dropped files into the active brain's drop-folder inbox. Called
/// by the UI's global file-drop handler with the absolute paths the
/// webview hands us. The connected Claude agent later reads these over
/// MCP and turns them into clean notes. Returns the names that landed
/// in the inbox (post collision-resolution) so the UI can report a
/// count.
#[tauri::command]
fn nv_inbox_add(
    paths: Vec<String>,
    brain_id: Option<String>,
) -> std::result::Result<Vec<String>, String> {
    let id = memory::resolve_brain_id(brain_id.as_deref()).map_err(|e| e.to_string())?;
    memory::inbox::add_files(&id, &paths).map_err(|e| e.to_string())
}

/// List files currently waiting in the active brain's inbox. Mirrors
/// the MCP `list_inbox` tool for any UI that wants to show a pending
/// count without going through the HTTP server.
#[tauri::command]
fn nv_inbox_list(
    brain_id: Option<String>,
) -> std::result::Result<Vec<memory::inbox::InboxFile>, String> {
    let id = memory::resolve_brain_id(brain_id.as_deref()).map_err(|e| e.to_string())?;
    memory::inbox::list_inbox(&id).map_err(|e| e.to_string())
}

/// Brain health scorecard for the active (or named) brain. In-process
/// path for the Diagnostic panel; the HTTP `/api/diagnostic` endpoint +
/// MCP `diagnose_brain` tool compute the same report.
#[tauri::command]
fn nv_diagnose(
    brain_id: Option<String>,
) -> std::result::Result<memory::diagnostic::DiagnosticReport, String> {
    let id = memory::resolve_brain_id(brain_id.as_deref()).map_err(|e| e.to_string())?;
    let db = memory::open_brain(&id).map_err(|e| e.to_string())?;
    memory::diagnostic::diagnose(&db).map_err(|e| e.to_string())
}

/// Mark `old_id` superseded by `new_id` so recall stops serving the stale
/// note (reversible metadata). Mirrors POST /api/notes/supersede + the
/// `supersede_note` MCP tool. Returns true if the old note existed.
#[tauri::command]
fn nv_supersede_note(
    old_id: String,
    new_id: String,
    reason: Option<String>,
    brain_id: Option<String>,
) -> std::result::Result<bool, String> {
    let id = memory::resolve_brain_id(brain_id.as_deref()).map_err(|e| e.to_string())?;
    let db = memory::open_brain(&id).map_err(|e| e.to_string())?;
    memory::supersede_note(&db, &old_id, &new_id, reason.as_deref()).map_err(|e| e.to_string())
}

// --- Phase-6 recall + HTTP server -------------------------------------

/// Hybrid recall — the main retrieval entry point. Replaces
/// `GET /api/recall`. Args mirror Python's `hybrid_retrieve` with
/// a few sensible defaults when the caller passes null:
///   - `limit` → 10
///   - `spread_hops` → 0 (no graph expand)
///   - `include_observations` → false (exclude observation kind)
#[tauri::command]
fn nv_recall(
    query: String,
    brain_id: Option<String>,
    limit: Option<usize>,
    spread_hops: Option<u8>,
    include_observations: Option<bool>,
    as_of: Option<String>,
) -> std::result::Result<Vec<memory::RecallHit>, String> {
    let (_, db) = memory::brain_from_id(brain_id.as_deref()).map_err(|e| e.to_string())?;
    let opts = memory::RecallOpts {
        top_k: limit.unwrap_or(10),
        spread_hops: spread_hops.unwrap_or(0),
        exclude_kinds: if include_observations.unwrap_or(false) {
            Vec::new()
        } else {
            vec!["observation".to_string()]
        },
        as_of,
        use_reranker: false, // Tauri UI stays fast by default; HTTP/MCP opts in
        ablate: Vec::new(),  // Tauri command always uses full pipeline
    };
    memory::hybrid_retrieve_throttled(&db, &query, &opts).map_err(|e| e.to_string())
}

/// Push PageRank scores for a brain into in-memory state. Called by
/// the frontend whenever Analytics mode is enabled (and recomputed
/// when the graph data changes). The retriever applies a multiplier
/// of `1 + 0.15 * ln(1 + score)` to RRF scores during recall when
/// state is non-empty for the active brain — important notes float
/// up automatically.
///
/// Pass an empty map to clear scores (the frontend does this when
/// the user disables Analytics mode, restoring identical recall to
/// the pre-G7 baseline).
#[tauri::command]
fn nv_set_pagerank(
    scores: std::collections::HashMap<String, f64>,
    brain_id: Option<String>,
) -> std::result::Result<(), String> {
    let (resolved, _db) = memory::brain_from_id(brain_id.as_deref()).map_err(|e| e.to_string())?;
    memory::pagerank_state::set(&resolved, scores);
    Ok(())
}

/// Push Louvain cluster summaries into in-memory state. The Rust
/// HTTP server exposes them via GET /api/clusters so the
/// `/name-clusters` skill (or any MCP-speaking agent) can read +
/// propose names. Frontend calls this whenever Louvain runs in
/// Analytics mode.
#[tauri::command]
fn nv_set_clusters(
    clusters: Vec<memory::cluster_state::ClusterSummary>,
    brain_id: Option<String>,
) -> std::result::Result<(), String> {
    let (resolved, _db) = memory::brain_from_id(brain_id.as_deref()).map_err(|e| e.to_string())?;
    memory::cluster_state::set_summaries(&resolved, clusters);
    Ok(())
}

/// Read cluster names persisted to disk for the brain. Frontend
/// reads this on graph load so the analytics view can display
/// "API design" instead of "Cluster 3" once names exist.
#[tauri::command]
fn nv_get_cluster_names(
    brain_id: Option<String>,
) -> std::result::Result<std::collections::HashMap<String, String>, String> {
    let (resolved, _db) = memory::brain_from_id(brain_id.as_deref()).map_err(|e| e.to_string())?;
    let names = memory::cluster_state::read_names(&resolved);
    Ok(names.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}

/// Shared state holding the Rust HTTP server handle (if running).
/// Separate from `ServerState` (which tracks the legacy Python
/// sidecar) so both can coexist during the migration window — the
/// user can run one, the other, or (briefly, for debugging) neither.
#[cfg(feature = "direct-distribution")]
struct RustServerState(tokio::sync::Mutex<Option<memory::http_server::ServerHandle>>);

#[cfg(feature = "app-store")]
struct RustServerState;

#[cfg(feature = "direct-distribution")]
fn rust_server_state() -> RustServerState {
    RustServerState(tokio::sync::Mutex::new(None))
}

#[cfg(feature = "app-store")]
fn rust_server_state() -> RustServerState {
    RustServerState
}

/// Start the in-process Rust HTTP server on 127.0.0.1:8765. Takes
/// over the port the Python sidecar used to own, so `mcp_proxy.py`
/// routes to the Rust backend transparently. Does not spawn Python.
#[tauri::command]
async fn nv_start_rust_server(
    state: tauri::State<'_, RustServerState>,
    port: Option<u16>,
) -> std::result::Result<String, String> {
    #[cfg(feature = "app-store")]
    {
        let _ = (state, port);
        return Err(
            "Loopback serving is unavailable in the Mac App Store build. \
             NeuroVault Core runs separately and does not share this app's memories."
                .into(),
        );
    }

    #[cfg(feature = "direct-distribution")]
    {
        let mut guard = state.0.lock().await;
        if guard.is_some() {
            return Err("Rust HTTP server is already running".to_string());
        }
        let handle = memory::http_server::start_server(port).await?;
        let port = handle.port;
        *guard = Some(handle);
        Ok(format!("Rust HTTP server listening on 127.0.0.1:{}", port))
    }
}

/// Stop the Rust HTTP server. Idempotent — no error if not running.
#[tauri::command]
async fn nv_stop_rust_server(
    state: tauri::State<'_, RustServerState>,
) -> std::result::Result<(), String> {
    #[cfg(feature = "app-store")]
    {
        let _ = state;
        return Ok(());
    }

    #[cfg(feature = "direct-distribution")]
    {
        let mut guard = state.0.lock().await;
        if let Some(mut handle) = guard.take() {
            handle.stop().await;
        }
        Ok(())
    }
}

/// Tier-A agent-efficiency: fetch direct + 2-hop neighbours of an
/// engram. Much cheaper than a recall (single SQL query against
/// `engram_links`). Replaces the common "recall → pick hit →
/// follow-up recall on that hit's topic" two-call pattern.
#[tauri::command]
fn nv_get_related(
    engram_id: String,
    brain_id: Option<String>,
    hops: Option<u8>,
    limit: Option<usize>,
    min_similarity: Option<f64>,
    link_types: Option<Vec<String>>,
    include_observations: Option<bool>,
) -> std::result::Result<Vec<memory::RelatedHit>, String> {
    let (_, db) = memory::brain_from_id(brain_id.as_deref()).map_err(|e| e.to_string())?;
    let opts = memory::RelatedOpts {
        hops: hops.unwrap_or(1),
        limit: limit.unwrap_or(20),
        min_similarity: min_similarity.unwrap_or(0.55),
        link_types,
        exclude_kinds: if include_observations.unwrap_or(false) {
            Vec::new()
        } else {
            vec!["observation".to_string()]
        },
    };
    memory::get_related_checked(&db, &engram_id, &opts).map_err(|e| e.to_string())
}

// --- Phase-7 vault file watcher ---------------------------------------
//
// Replaces Python's `watchdog`-based watcher. Uses the `notify`
// crate with a 500ms per-file debounce so editor save bursts
// (VSCode atomic-rename, Obsidian's fsync dance) collapse into one
// ingest call per save. One watcher per brain; activating a brain
// starts its watcher, switching brains rotates.

/// Start watching the active brain's vault for .md file changes.
/// Each change triggers the ingest pipeline (chunk → embed →
/// entities → links → BM25). No-op if a watcher for this brain is
/// already running.
#[tauri::command]
fn nv_start_vault_watcher(brain_id: Option<String>) -> std::result::Result<String, String> {
    #[cfg(feature = "app-store")]
    {
        let _ = brain_id;
        return Err(
            "The Mac App Store edition indexes app-owned libraries through native saves and explicit rescans; its direct-distribution vault watcher is not available."
                .to_string(),
        );
    }

    #[cfg(feature = "direct-distribution")]
    {
        let id = brain_id
            .unwrap_or_else(|| memory::read_ops::resolve_brain_id(None).unwrap_or_default());
        if id.is_empty() {
            return Err("no active brain to watch".to_string());
        }
        memory::watcher::start_for_brain(&id, vault_dir())
            .map(|_| format!("watching brain {}", id))
            .map_err(|e| e.to_string())
    }
}

/// Stop the per-brain vault watcher. Idempotent.
#[tauri::command]
fn nv_stop_vault_watcher(brain_id: Option<String>) -> std::result::Result<(), String> {
    #[cfg(feature = "app-store")]
    {
        let _ = brain_id;
        return Ok(());
    }

    #[cfg(feature = "direct-distribution")]
    {
        let id = brain_id
            .unwrap_or_else(|| memory::read_ops::resolve_brain_id(None).unwrap_or_default());
        if id.is_empty() {
            return Ok(());
        }
        memory::watcher::stop_for_brain(&id);
        Ok(())
    }
}

// The Python-as-subprocess bridge (`run_python_job` + `python -m
// neurovault_server <job>`) was removed 2026-05-16 when the Python
// server package was deleted. The Rust backend now covers every
// surface the UI calls; "advanced features that stay in Python"
// (compile / PDF / Zotero / code graph / drafts) were never wired
// to any UI component, so removing the bridge cost nothing.
//
// If you ever want to invoke an out-of-process tool from the Tauri
// app again — for a one-shot ML model run, a third-party CLI, etc.
// — add a focused command for that specific tool rather than a
// generic "run any python module" surface. See docs/python-server-
// reference.md for what the bridge used to look like.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Emitter;
    use tauri::Manager;
    #[cfg(feature = "direct-distribution")]
    use tauri_plugin_global_shortcut::{
        Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
    };

    // Cmd+Shift+Space on macOS, Ctrl+Shift+Space elsewhere — opens Quick
    // Capture even when the window isn't focused. Keep native registration
    // aligned with the shortcut the UI advertises.
    #[cfg(feature = "direct-distribution")]
    let primary_modifier = if cfg!(target_os = "macos") {
        Modifiers::SUPER
    } else {
        Modifiers::CONTROL
    };
    #[cfg(feature = "direct-distribution")]
    let quick_capture = Shortcut::new(Some(primary_modifier | Modifiers::SHIFT), Code::Space);

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init());

    #[cfg(feature = "direct-distribution")]
    let builder = builder
        // Single-instance guard with deep-link forwarding: when a
        // `neurovault://engram/<id>` URL is opened while the app is
        // already running, Windows would normally spawn a second
        // neurovault.exe. This plugin detects that, forwards the
        // argv (including the URL) to the running instance, and
        // exits the new one. The deep-link plugin below then picks
        // up the forwarded URL and emits it to the frontend.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // Bring the existing window to the front so the user
            // doesn't stare at nothing after clicking a URL. The
            // actual URL handling is done by the deep-link plugin's
            // `on_open_url` callback, which single-instance triggers
            // when it sees a URL arg in argv.
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            // Log once so a user staring at stderr knows the URL
            // round-tripped; the frontend will emit a second log
            // when it acts on it.
            eprintln!(
                "[neurovault] deep link forwarded to running instance: {:?}",
                argv
            );
        }))
        .plugin(tauri_plugin_deep_link::init());

    #[cfg(feature = "direct-distribution")]
    let builder = builder
        .plugin(tauri_plugin_shell::init())
        // In-app updater + process (relaunch after install). The plugin
        // deserializes `plugins.updater` from tauri.conf.json *at startup*
        // and the whole app aborts (panic = "abort") if that block is
        // missing — so the block must exist even while updates are off. It
        // ships inert today: `pubkey: ""` + `endpoints: []` makes the
        // native `check()` return ReleaseNotFound, which the frontend
        // catches and turns into "open the GitHub release page". Flip on
        // real signed updates per docs/UPDATER-SETUP.md.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if shortcut != &quick_capture {
                        return;
                    }
                    // Bring the main window to the front + focus, then
                    // emit the event. The frontend listens for it and
                    // opens the overlay regardless of current view.
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                    // Also re-summon the floating minitab if it was hidden.
                    // This is the recovery path for the minitab's "hide"
                    // (eye) button — the shortcut is the universal "bring
                    // NeuroVault back" gesture. Showing an already-visible
                    // minitab is a harmless no-op.
                    if let Some(mt) = app.get_webview_window("minitab") {
                        let visible = mt.is_visible().unwrap_or(false);
                        if !visible {
                            park_minitab_top_right(&mt);
                            let _ = mt.show();
                        }
                    }
                    let _ = app.emit("quick-capture-shortcut", ());
                })
                .build(),
        );

    let builder = builder
        .menu(|app| {
            #[cfg(feature = "direct-distribution")]
            use tauri::menu::CheckMenuItem;
            use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

            let settings = MenuItemBuilder::with_id("open-settings", "Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;
            #[cfg(feature = "direct-distribution")]
            let automatic_context = CheckMenuItem::with_id(
                app,
                "automatic-context",
                "Automatic Context",
                true,
                nv_auto_recall_status(),
                None::<&str>,
            )?;
            let application_menu = SubmenuBuilder::with_id(app, "neurovault-menu", "NeuroVault")
                .about(None)
                .separator()
                .item(&settings);
            #[cfg(feature = "direct-distribution")]
            let application_menu = application_menu.item(&automatic_context);
            let application_menu = application_menu
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let window_menu = SubmenuBuilder::new(app, "Window")
                .minimize()
                .close_window()
                .build()?;

            MenuBuilder::new(app)
                .items(&[&application_menu, &edit_menu, &window_menu])
                .build()
        })
        .on_menu_event(|app, event| {
            if event.id() == "open-settings" {
                let _ = open_settings_in_main(app.clone());
                return;
            }
            #[cfg(feature = "direct-distribution")]
            {
                if event.id() != "automatic-context" {
                    return;
                }

                use tauri::menu::MenuItemKind;
                use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

                let check_item = app.menu().and_then(|menu| {
                    let MenuItemKind::Submenu(application_menu) = menu.get("neurovault-menu")?
                    else {
                        return None;
                    };
                    let MenuItemKind::Check(item) = application_menu.get("automatic-context")?
                    else {
                        return None;
                    };
                    Some(item)
                });
                let enabled = check_item
                    .as_ref()
                    .and_then(|item| item.is_checked().ok())
                    .unwrap_or_else(|| !nv_auto_recall_status());

                if let Err(error) = nv_auto_recall_set(app.clone(), enabled) {
                    if let Some(item) = check_item {
                        let _ = item.set_checked(!enabled);
                    }
                    app.dialog()
                        .message(format!(
                            "NeuroVault could not change Automatic Context.\n\n{error}"
                        ))
                        .title("Automatic Context")
                        .kind(MessageDialogKind::Error)
                        .show(|_| {});
                }
            }
        })
        .setup(move |app| {
            #[cfg(feature = "app-store")]
            {
                let prepared = prepare_store_environment(app.handle());
                match prepared {
                    Ok((data_root, _)) => eprintln!(
                        "[neurovault] App Store data root: {}",
                        data_root.display()
                    ),
                    Err(error) => {
                        eprintln!("[neurovault] App Store startup needs recovery: {error}");
                        if let Some(state) = app.try_state::<StoreStartupState>() {
                            if let Ok(mut guard) = state.0.lock() {
                                *guard = Some(error);
                            }
                        }
                    }
                }
            }

            // Register the shortcut at startup. If another app already owns
            // the combo we log and move on — the in-app Cmd/Ctrl+Shift+Space
            // handler still works when the window is focused.
            #[cfg(feature = "direct-distribution")]
            {
                // Native deletion uses the same registry tombstones in both
                // distributions. Retry only those validated, unregistered
                // archive paths before background writers/watchers start.
                retry_deleted_cleanup(&nv_home());
                match app.global_shortcut().register(quick_capture) {
                    Ok(_) => {
                        eprintln!("[neurovault] global shortcut registered: Ctrl/Cmd+Shift+Space")
                    }
                    Err(e) => eprintln!(
                        "[neurovault] could not register global shortcut (another app likely owns it): {e}"
                    ),
                }
            }

            // Register the `neurovault://` URL scheme with the OS. In
            // production this is a no-op because the installer already
            // wrote the registry entry; in dev mode it lets you click
            // a deep link and have it route back to the running
            // `tauri dev` instance. Failure here is non-fatal.
            #[cfg(feature = "direct-distribution")]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(e) = app.deep_link().register_all() {
                    eprintln!("[neurovault] deep-link register_all failed: {}", e);
                }
                // Emit every incoming URL to the frontend so React can
                // parse `neurovault://engram/<id>` and focus the note.
                // Fires for both cold-start URLs (app opened by click)
                // and hot URLs (clicked while app already running,
                // forwarded via single-instance).
                let app_handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    let urls: Vec<String> = event
                        .urls()
                        .iter()
                        .map(|u| u.to_string())
                        .collect();
                    eprintln!("[neurovault] deep link open: {:?}", urls);
                    let _ = app_handle.emit("neurovault-deep-link", urls);
                });
            }

            // Python MCP sidecar is NOT auto-started (sidecar binary
            // was retired in the Rust migration). Instead we auto-
            // start the in-process Rust HTTP server on 8765 so the
            // MCP proxy has something to talk to from first boot, and
            // start the vault watcher for the currently-active brain
            // so external-editor saves (Obsidian, VSCode) get picked
            // up immediately.
            //
            // Both are spawned on `tauri::async_runtime` — failure is
            // non-fatal (port already taken, vault missing, etc.) so
            // the app still opens even if one of them can't bind.
            #[cfg(not(feature = "app-store"))]
            let app_handle = app.handle().clone();
            #[cfg(not(feature = "app-store"))]
            tauri::async_runtime::spawn(async move {
                // 1) HTTP server on 127.0.0.1:8765. If the user has an
                // older Python sidecar still running on the port, our
                // bind fails and we just log; the user can stop the
                // sidecar via Settings and restart the app.
                let rust_state = app_handle.state::<RustServerState>();
                let mut guard = rust_state.0.lock().await;
                match memory::http_server::start_server(None).await {
                    Ok(handle) => {
                        let p = handle.port;
                        *guard = Some(handle);
                        eprintln!(
                            "[neurovault] Rust HTTP server auto-started on 127.0.0.1:{}",
                            p
                        );
                    }
                    Err(e) => {
                        eprintln!(
                            "[neurovault] Rust HTTP server did NOT start (port may be busy): {}",
                            e
                        );
                    }
                }
                drop(guard);

                // 2) Vault watcher for the active brain. A missing
                // active brain (fresh install) is expected — skip
                // quietly.
                if let Ok(active) = memory::read_ops::resolve_brain_id(None) {
                    if !active.is_empty() {
                        if let Err(e) = memory::watcher::start_for_brain(&active, vault_dir()) {
                            eprintln!(
                                "[neurovault] vault watcher did NOT start for brain {}: {}",
                                active, e
                            );
                        } else {
                            eprintln!("[neurovault] vault watcher started for brain {}", active);
                        }
                    }
                }
            });

            eprintln!(
                "[neurovault] desktop app ready. Rust backend in-process; \
                 no Python sidecar — the MCP proxy is a thin HTTP forwarder."
            );

            // `--minitab`: launch straight into the floating control (main
            // window hidden). This is how the agent brings NeuroVault up
            // visibly-but-unobtrusively: the backend runs, only the minitab
            // shows. The user can Open app from there anytime.
            if std::env::args().any(|a| a == "--minitab") {
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.hide();
                }
                if let Some(mt) = app.get_webview_window("minitab") {
                    park_minitab_top_right(&mt);
                    let _ = mt.show();
                }
            }

            Ok(())
        })
        // WINDOW LIFECYCLE (docs/specs/window-lifecycle.md, Phase 1).
        //
        // NeuroVault is a memory SERVICE with a viewer attached: the HTTP
        // server on :8765 that every Claude Code hook, the MCP server, and
        // every other agent depends on runs INSIDE this process. So the
        // window's lifecycle must be decoupled from the service's.
        //
        // Before this, the close button was completely unhandled: clicking
        // the red X (or Cmd+W) DESTROYED the main window while the hidden
        // `minitab` window kept the app alive — leaving an invisible zombie
        // that still held :8765, with `Reopen` (Dock click) unable to find a
        // "main" window to restore. The only way out was force-quit.
        //
        // Now: close HIDES. The window always exists, always restores (Dock
        // click / Cmd+Shift+Space / the minitab), and memory never dies by
        // accident. Only an explicit Quit stops the service — and that still
        // runs the ExitRequested cleanup below (checkpoint + close DBs).
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    // Closing hides rather than exits, so the flush may finish
                    // while hidden. On failure the frontend reopens the window
                    // and presents the retained buffer + Retry state.
                    let _ = window.emit("neurovault-save-requested", "window-close");
                    let _ = window.hide();
                    // One-time hint, delivered as a SYSTEM notification —
                    // an in-app toast would render into the window we just
                    // hid, where nobody could read it. Once per install.
                    notify_hidden_once();
                }
            }
        })
        .manage(server_state())
        .manage(rust_server_state())
        .manage(StoreStartupState(Mutex::new(None)));

    // The Store binary exposes only commands used by its single-window,
    // app-container library experience. Sidecars, loopback serving, hooks,
    // shell/reveal actions, external inboxes, watchers, minitabs, and agent
    // mutation commands are absent from the IPC allow-list, not merely hidden
    // in React.
    #[cfg(feature = "app-store")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        get_vault_path,
        list_notes,
        read_note,
        import_folder_as_vault,
        hide_to_background,
        quit_after_save,
        open_main_window,
        minimize_main,
        export_brain_as_zip,
        list_brains_offline,
        set_active_brain_offline,
        create_brain_offline,
        update_brain_offline,
        delete_brain_offline,
        store_startup_status,
        nv_list_notes,
        nv_get_note,
        nv_list_brains,
        nv_brain_stats,
        nv_get_graph,
        nv_save_note,
        nv_create_note,
        nv_rename_note,
        nv_index_brain,
        nv_delete_note,
        nv_list_trash,
        nv_restore_note,
        nv_recall,
        nv_set_pagerank,
        nv_set_clusters,
        nv_get_cluster_names,
        nv_diagnose,
    ]);

    #[cfg(feature = "direct-distribution")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        get_vault_path,
        list_notes,
        read_note,
        save_note,
        create_note,
        delete_note,
        start_server,
        stop_server,
        server_status,
        import_folder_as_vault,
        hide_to_background,
        quit_after_save,
        brain_storage_stats,
        open_main_window,
        show_minitab,
        hide_minitab,
        set_minitab_collapsed,
        minimize_main,
        shrink_to_widget,
        mcp_sidecar_path,
        mcp_config_path,
        reveal_in_file_manager,
        nv_auto_recall_status,
        nv_auto_recall_set,
        claude_code_config_path,
        register_claude_code_mcp,
        export_brain_as_zip,
        list_brains_offline,
        set_active_brain_offline,
        create_brain_offline,
        update_brain_offline,
        delete_brain_offline,
        store_startup_status,
        // Phase-4 Rust memory commands. Each one replaces an HTTP
        // endpoint — frontend feature-detects and prefers these.
        nv_list_notes,
        nv_get_note,
        nv_list_brains,
        nv_brain_stats,
        nv_get_graph,
        // Phase-5 write-path commands. Run the full ingest pipeline
        // (chunk → embed → entities → links → BM25) in-process.
        nv_save_note,
        nv_create_note,
        nv_rename_note,
        nv_index_brain,
        nv_delete_note,
        nv_list_trash,
        nv_restore_note,
        // Phase-6 recall + Rust HTTP server on 8765. `nv_recall`
        // is the in-process Tauri path; the HTTP server serves
        // MCP proxy + external HTTP clients.
        nv_recall,
        nv_set_pagerank,
        nv_set_clusters,
        nv_get_cluster_names,
        nv_start_rust_server,
        nv_stop_rust_server,
        // Tier-A agent-efficiency: cheap 1-2 hop neighbour lookup.
        nv_get_related,
        // Phase-7 vault file watcher. Started automatically on
        // brain activation; the Tauri commands are here for
        // debug/manual control from Settings.
        nv_start_vault_watcher,
        nv_stop_vault_watcher,
        // Drop-folder inbox: UI file-drop copies raw files into the
        // brain inbox for the connected agent to turn into notes.
        nv_inbox_add,
        nv_inbox_list,
        // Brain health scorecard (also on HTTP + MCP).
        nv_diagnose,
        // Engram-level supersession (new note retires a stale one).
        nv_supersede_note,
    ]);

    builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            match &event {
                // Kill the sidecar when the app exits so it doesn't linger as
                // an orphan process holding port 8765. Without this the user
                // sees "already running" errors on next launch.
                tauri::RunEvent::ExitRequested { api, .. } => {
                    if !ALLOW_EXIT_AFTER_SAVE.load(Ordering::SeqCst) {
                        api.prevent_exit();
                        let _ = app.emit("neurovault-save-requested", "quit");
                        return;
                    }
                    #[cfg(feature = "direct-distribution")]
                    {
                        if let Some(state) = app.try_state::<ServerState>() {
                            if let Ok(mut guard) = state.0.lock() {
                                if let Some(child) = guard.take() {
                                    let _ = child.kill();
                                    eprintln!("[neurovault] killed sidecar on app exit");
                                }
                            }
                        }
                    }
                    // Stop every per-brain vault watcher so worker threads +
                    // OS-level watches exit cleanly. Without this, notify's
                    // background listener on Windows can keep the process
                    // alive for a few seconds after the main window closes.
                    memory::watcher::stop_all();
                    // Watchers are now stopped, so nothing is mid-write:
                    // flush every brain's WAL into brain.db and release the
                    // memory-maps + file handles. This leaves each brain.db
                    // complete and self-contained on disk, so a volume hosting
                    // the brains (e.g. an external SSD) can be unmounted
                    // cleanly right after quit. Best-effort.
                    memory::db::checkpoint_all();
                    memory::db::close_all();
                }
                // macOS only: clicking the Dock icon while no window is on
                // screen — after a native minimise, or after
                // hide_to_background — fires Reopen. Without handling it, the
                // window can't be brought back from the Dock, so minimising
                // "traps" the app on macOS. (Windows restores from the taskbar
                // natively, which is why this only bit macOS.) Bring the main
                // window back: unminimise + show + focus.
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                _ => {}
            }
        });
}
