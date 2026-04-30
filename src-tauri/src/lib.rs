use serde::Serialize;
use slug::slugify;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::SystemTime;
use tauri_plugin_shell::process::CommandChild;
use uuid::Uuid;

// Rust memory layer — the in-process replacement for the Python
// neurovault_server package. Exposes the in-process Tauri commands
// (nv_list_notes, nv_get_graph, nv_recall, ...) that the frontend
// now prefers over the legacy HTTP sidecar.
pub mod memory;

/// Shared state holding the Python sidecar child process (if running).
struct ServerState(Mutex<Option<CommandChild>>);

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
                    if let Some(brains) = parsed.get("brains").and_then(|v| v.as_array()) {
                        for b in brains {
                            let id = b.get("id").and_then(|v| v.as_str()).unwrap_or("");
                            if id != active_id { continue; }
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
                    fs::create_dir_all(&vault).ok();
                    seed_welcome_note(&vault);
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
            entries.flatten().any(|e| {
                e.path().extension().and_then(|x| x.to_str()) == Some("md")
            })
        })
        .unwrap_or(true); // if we can't read the dir, don't seed
    if has_notes {
        return;
    }
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

fn trash_dir() -> PathBuf {
    let nv_home = nv_home();

    let registry_path = nv_home.join("brains.json");
    if registry_path.exists() {
        if let Ok(data) = fs::read_to_string(&registry_path) {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&data) {
                if let Some(active_id) = parsed.get("active").and_then(|v| v.as_str()) {
                    let trash = nv_home.join("brains").join(active_id).join("trash");
                    fs::create_dir_all(&trash).ok();
                    return trash;
                }
            }
        }
    }

    let legacy_trash = nv_home.join("trash");
    if legacy_trash.exists() {
        return legacy_trash;
    }

    let default_trash = nv_home.join("brains").join("default").join("trash");
    fs::create_dir_all(&default_trash).expect("Could not create trash directory");
    default_trash
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

#[tauri::command]
fn get_vault_path() -> String {
    vault_dir().to_string_lossy().to_string()
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
            let name = b.get("name").and_then(|v| v.as_str()).unwrap_or(&id).to_string();
            let description = b
                .get("description")
                .and_then(|v| v.as_str())
                .map(String::from);
            let vault_path = b
                .get("vault_path")
                .and_then(|v| v.as_str())
                .map(String::from);
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
    let registry_path = nv_home().join("brains.json");
    let data = fs::read_to_string(&registry_path)
        .map_err(|e| format!("brains.json not readable: {e}"))?;
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

    parsed["active"] = serde_json::Value::String(brain_id.clone());
    let serialised = serde_json::to_string_pretty(&parsed)
        .map_err(|e| format!("failed to serialise registry: {e}"))?;
    fs::write(&registry_path, serialised)
        .map_err(|e| format!("could not write brains.json: {e}"))?;

    // Rotate the vault watcher to the newly-active brain. "Single
    // vault at a time" invariant keeps the ingest pipeline from
    // racing two brains' writes against the same BM25 index.
    // Watcher failures are non-fatal: a brain with a missing vault
    // should still switch (user may have just rebooted with an
    // external drive unmounted). We log and continue.
    memory::watcher::stop_all();
    if let Err(e) = memory::watcher::start_for_brain(&brain_id, vault_dir()) {
        eprintln!(
            "[neurovault] watcher start failed for {}: {}",
            brain_id, e
        );
    }

    Ok(vault_dir().to_string_lossy().to_string())
}

#[tauri::command]
fn list_notes() -> Result<Vec<NoteMeta>, String> {
    let vault = vault_dir();
    let mut notes: Vec<NoteMeta> = Vec::new();

    // Recursively walk subdirectories so notes organized into folders
    // (`agent/`, `user/`, any user-created folder) are returned too. The
    // `filename` we return is the POSIX-style relative path from the vault
    // root (e.g. `agent/foo.md`), which the frontend splits on `/` to
    // build the folder tree and the same string round-trips unchanged
    // through read_note / save_note.
    fn walk(dir: &std::path::Path, vault_root: &std::path::Path, out: &mut Vec<NoteMeta>) {
        let Ok(entries) = fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, vault_root, out);
                continue;
            }
            if path.extension().map_or(false, |ext| ext == "md") {
                let rel = path
                    .strip_prefix(vault_root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");
                let Ok(metadata) = fs::metadata(&path) else { continue };
                let modified = metadata
                    .modified()
                    .unwrap_or(SystemTime::UNIX_EPOCH)
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                let size = metadata.len();
                let content = fs::read_to_string(&path).unwrap_or_default();
                let title = extract_title(&content, &rel);
                out.push(NoteMeta { filename: rel, title, modified, size });
            }
        }
    }
    walk(&vault, &vault, &mut notes);

    notes.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(notes)
}

#[tauri::command]
fn read_note(filename: String) -> Result<String, String> {
    fs::read_to_string(vault_dir().join(&filename)).map_err(|e| format!("Failed to read note: {e}"))
}

#[tauri::command]
fn save_note(filename: String, content: String) -> Result<(), String> {
    let path = vault_dir().join(&filename);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create folder: {e}"))?;
    }
    fs::write(&path, &content).map_err(|e| format!("Failed to save note: {e}"))
}

#[tauri::command]
fn create_note(title: String) -> Result<String, String> {
    let vault = vault_dir();
    let slug = slugify(&title);
    let id = &Uuid::new_v4().to_string()[..8];
    let filename = format!("{slug}-{id}.md");
    let content = format!("# {title}\n\n");
    fs::write(vault.join(&filename), &content).map_err(|e| format!("Failed to create note: {e}"))?;
    Ok(filename)
}

#[tauri::command]
fn delete_note(filename: String) -> Result<(), String> {
    // `filename` may be a nested path like `agent/foo.md` now that notes
    // live inside folders. Trash is intentionally flat — if the leaf name
    // collides, suffix with a short uuid so nothing gets clobbered.
    let src = vault_dir().join(&filename);
    if !src.exists() {
        return Err(format!("Note not found: {filename}"));
    }
    let trash = trash_dir();
    fs::create_dir_all(&trash).map_err(|e| format!("Failed to prep trash: {e}"))?;
    let leaf = std::path::Path::new(&filename)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or(filename.clone());
    let mut dst = trash.join(&leaf);
    if dst.exists() {
        let stem = std::path::Path::new(&leaf)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| leaf.clone());
        let id = &Uuid::new_v4().to_string()[..8];
        dst = trash.join(format!("{stem}-{id}.md"));
    }
    fs::rename(&src, &dst).map_err(|e| format!("Failed to move note to trash: {e}"))
}

/// Import an external folder as a NeuroVault vault. Copies all .md files
/// from the source folder (recursively) into the target brain's vault/
/// directory. Returns the number of files imported.
#[tauri::command]
fn import_folder_as_vault(source: String, target_brain_id: String) -> Result<usize, String> {
    let src_path = PathBuf::from(&source);
    if !src_path.exists() || !src_path.is_dir() {
        return Err(format!("Source folder not found: {source}"));
    }

    let home = dirs::home_dir().ok_or_else(|| "home dir not found".to_string())?;
    let nv_home = {
        let n = home.join(".neurovault");
        if n.exists() { n } else { home.join(".engram") }
    };
    let target_vault = nv_home.join("brains").join(&target_brain_id).join("vault");
    fs::create_dir_all(&target_vault)
        .map_err(|e| format!("Could not create target vault dir: {e}"))?;

    // Walk the source folder, copy every .md file into target/vault/
    fn copy_md_files(src: &PathBuf, dst: &PathBuf, count: &mut usize) -> Result<(), String> {
        let entries = fs::read_dir(src).map_err(|e| format!("read_dir {src:?}: {e}"))?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                // Recurse but flatten into dst (no subdir nesting)
                copy_md_files(&path, dst, count)?;
            } else if path.extension().and_then(|x| x.to_str()) == Some("md") {
                let filename = path.file_name().and_then(|x| x.to_str()).unwrap_or("note.md");
                let target = dst.join(filename);
                // If filename already exists, suffix with counter
                let target = if target.exists() {
                    let stem = path.file_stem().and_then(|x| x.to_str()).unwrap_or("note");
                    dst.join(format!("{stem}-imported-{count}.md"))
                } else {
                    target
                };
                fs::copy(&path, &target).map_err(|e| format!("copy {path:?}: {e}"))?;
                *count += 1;
            }
        }
        Ok(())
    }

    let mut count: usize = 0;
    copy_md_files(&src_path, &target_vault, &mut count)?;
    Ok(count)
}

/// Start the bundled Python MCP server as a sidecar process.
/// Returns Err if already running, or if the sidecar binary can't be spawned.
#[tauri::command]
fn start_server(
    app: tauri::AppHandle,
    state: tauri::State<'_, ServerState>,
) -> Result<String, String> {
    use tauri_plugin_shell::ShellExt;
    use std::env;

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

    let cmd = app
        .shell()
        .sidecar("neurovault-server")
        .map_err(|e| {
            eprintln!("[start_server] sidecar() returned Err: {e}");
            format!("sidecar binary not found: {e}")
        })?;

    eprintln!("[start_server] sidecar command built, spawning with --http-only");

    let (_rx, child) = cmd
        .args(["--http-only"])
        .spawn()
        .map_err(|e| {
            eprintln!("[start_server] spawn() failed: {e}");
            format!("failed to spawn: {e}")
        })?;

    let pid = child.pid();
    eprintln!("[start_server] spawned successfully, pid={pid}");
    *guard = Some(child);
    Ok(format!("Server started (pid {})", pid))
}

/// Stop the running sidecar server. Returns Ok whether or not anything
/// was actually running (idempotent).
#[tauri::command]
fn stop_server(state: tauri::State<'_, ServerState>) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(|e| format!("lock: {e}"))?;
    if let Some(child) = guard.take() {
        child.kill().map_err(|e| format!("failed to kill: {e}"))?;
        Ok("Server stopped".into())
    } else {
        Ok("Server was not running".into())
    }
}

/// Report whether the sidecar is currently running (from the Tauri side).
/// The frontend also polls the HTTP endpoint, but this tells you if WE
/// spawned the server vs someone else started it externally.
#[tauri::command]
fn server_status(state: tauri::State<'_, ServerState>) -> Result<bool, String> {
    let guard = state.0.lock().map_err(|e| format!("lock: {e}"))?;
    Ok(guard.is_some())
}

/// Zip up a brain's vault + DB into a single archive at `dest_path`.
/// Internal brains get bundled complete (DB + vault/ + raw/ +
/// consolidated/); external-folder brains get just vault/ + DB since
/// the vault lives outside our tree anyway. The user picks the
/// destination via a Tauri save dialog on the frontend.
#[tauri::command]
fn export_brain_as_zip(brain_id: String, dest_path: String) -> Result<usize, String> {
    use std::io::{Read, Write};
    let nv_home = nv_home();
    let brain_root = nv_home.join("brains").join(&brain_id);
    if !brain_root.is_dir() {
        return Err(format!("brain not found: {brain_id}"));
    }

    // Resolve the external vault_path if this is an external-folder brain
    // so we can include the user's markdown alongside the internal DB.
    let registry = nv_home.join("brains.json");
    let external_vault: Option<PathBuf> = fs::read_to_string(&registry)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| {
            v.get("brains").and_then(|a| a.as_array()).and_then(|brains| {
                brains.iter().find_map(|b| {
                    if b.get("id").and_then(|x| x.as_str()) == Some(&brain_id) {
                        b.get("vault_path").and_then(|x| x.as_str()).map(PathBuf::from)
                    } else {
                        None
                    }
                })
            })
        });

    let file = fs::File::create(&dest_path).map_err(|e| format!("create zip: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let mut count: usize = 0;

    // Recursive file walker: adds every file under `src_root` into the
    // zip at `zip_prefix/<relative path>`. Skips symlinks to avoid
    // escaping the tree and silently swallows unreadable files so one
    // corrupt DB-wal shard doesn't abort the whole export.
    fn add_tree<W: Write + std::io::Seek>(
        zip: &mut zip::ZipWriter<W>,
        src_root: &std::path::Path,
        zip_prefix: &str,
        options: zip::write::SimpleFileOptions,
        count: &mut usize,
    ) -> Result<(), String> {
        let mut stack: Vec<PathBuf> = vec![src_root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = fs::read_dir(&dir) else { continue };
            for entry in entries.flatten() {
                let path = entry.path();
                let Ok(ft) = entry.file_type() else { continue };
                if ft.is_symlink() { continue; }
                if ft.is_dir() {
                    stack.push(path);
                    continue;
                }
                if ft.is_file() {
                    let Ok(rel) = path.strip_prefix(src_root) else { continue };
                    let name = format!(
                        "{}/{}",
                        zip_prefix.trim_end_matches('/'),
                        rel.to_string_lossy().replace('\\', "/"),
                    );
                    zip.start_file(&name, options)
                        .map_err(|e| format!("zip entry {name}: {e}"))?;
                    let mut f = match fs::File::open(&path) {
                        Ok(f) => f,
                        Err(_) => continue,
                    };
                    let mut buf = Vec::new();
                    if f.read_to_end(&mut buf).is_err() { continue; }
                    zip.write_all(&buf).map_err(|e| format!("zip write: {e}"))?;
                    *count += 1;
                }
            }
        }
        Ok(())
    }

    // Internal scratch (DB, fingerprint, trash, raw, consolidated, and
    // — for non-external brains — vault/).
    add_tree(&mut zip, &brain_root, &brain_id, options, &mut count)?;

    // External vault markdown goes under `<brain_id>/external_vault/`
    // so the archive is self-describing when the user unzips it.
    if let Some(ext) = external_vault {
        if ext.is_dir() {
            let prefix = format!("{brain_id}/external_vault");
            add_tree(&mut zip, &ext, &prefix, options, &mut count)?;
        }
    }

    zip.finish().map_err(|e| format!("finalize zip: {e}"))?;
    Ok(count)
}

/// Return the resolved absolute path to the `neurovault-server` sidecar
/// binary so the Settings UI can render a Claude Desktop MCP config
/// pointing at it. We check both the target-triple-suffixed name (how
/// PyInstaller ships it) and the plain name (how Tauri copies it into
/// the install dir). Returns an empty string if neither exists — the UI
/// then shows a friendly "install the server first" message instead.
#[tauri::command]
fn mcp_sidecar_path() -> String {
    use std::env;
    let exe_dir = match env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())) {
        Some(d) => d,
        None => return String::new(),
    };
    let suffix = if cfg!(target_os = "windows") { ".exe" } else { "" };
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
        home.join(".config").join("Claude").join("claude_desktop_config.json")
    };
    p.display().to_string()
}

/// Reveal the MCP config file in the OS file manager so the user can
/// open/edit it quickly. On Windows uses `explorer /select,`; on macOS
/// uses `open -R`. No-op on Linux (most distros' file managers vary).
#[tauri::command]
fn reveal_in_file_manager(path: String) -> Result<(), String> {
    use std::process::Command;
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| format!("explorer failed: {e}"))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("open failed: {e}"))?;
        return Ok(());
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = path;
        Err("reveal_in_file_manager not supported on this platform".into())
    }
}

/// Hide the main window without quitting the app. The sidecar keeps running
/// and the user can restore via Ctrl+Shift+Space (the quick-capture shortcut
/// also unhides/focuses the window).
#[tauri::command]
fn hide_to_background(window: tauri::Window) -> Result<(), String> {
    window.hide().map_err(|e| format!("hide: {e}"))
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
    let brain_root = vault.parent().map(|p| p.to_path_buf()).unwrap_or(vault.clone());

    let mut note_count: u64 = 0;
    let mut markdown_bytes: u64 = 0;
    fn walk(dir: &std::path::Path, count: &mut u64, bytes: &mut u64) {
        let Ok(entries) = fs::read_dir(dir) else { return };
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
    let (_id, db) =
        memory::brain_from_id(brain_id.as_deref()).map_err(|e| e.to_string())?;
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
    let (_id, db) =
        memory::brain_from_id(brain_id.as_deref()).map_err(|e| e.to_string())?;
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
) -> std::result::Result<memory::types::GraphData, String> {
    let (_id, db) =
        memory::brain_from_id(brain_id.as_deref()).map_err(|e| e.to_string())?;
    memory::get_graph(
        &db,
        include_observations.unwrap_or(false),
        min_similarity.unwrap_or(0.85),
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
// Brain resolution: always the active brain (from brains.json). The
// `brain_id` parameter is accepted for forwards-compat but the vault
// path resolution still reads from `vault_dir()` which tracks the
// active brain. Writing to a non-active brain needs a brain switch
// first — same contract the Python API had.

/// Write `content` to `filename` under the active brain's vault and
/// run the ingest pipeline. Returns the engram id + status.
#[tauri::command]
fn nv_save_note(
    filename: String,
    content: String,
    brain_id: Option<String>,
) -> std::result::Result<memory::WriteResult, String> {
    let ctx = memory::BrainContext::resolve(brain_id.as_deref(), vault_dir())
        .map_err(|e| e.to_string())?;
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
    let ctx = memory::BrainContext::resolve(brain_id.as_deref(), vault_dir())
        .map_err(|e| e.to_string())?;
    memory::create_note(&ctx, &title).map_err(|e| e.to_string())
}

/// Soft-delete the engram backing `filename` and move the file to the
/// per-brain trash. Returns the engram id so the frontend can
/// optimistically drop it from the sidebar store.
#[tauri::command]
fn nv_delete_note(
    filename: String,
    brain_id: Option<String>,
) -> std::result::Result<memory::WriteResult, String> {
    let ctx = memory::BrainContext::resolve(brain_id.as_deref(), vault_dir())
        .map_err(|e| e.to_string())?;
    memory::delete_note(&ctx, &filename).map_err(|e| e.to_string())
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
struct RustServerState(tokio::sync::Mutex<Option<memory::http_server::ServerHandle>>);

/// Start the in-process Rust HTTP server on 127.0.0.1:8765. Takes
/// over the port the Python sidecar used to own, so `mcp_proxy.py`
/// routes to the Rust backend transparently. Does not spawn Python.
#[tauri::command]
async fn nv_start_rust_server(
    state: tauri::State<'_, RustServerState>,
    port: Option<u16>,
) -> std::result::Result<String, String> {
    let mut guard = state.0.lock().await;
    if guard.is_some() {
        return Err("Rust HTTP server is already running".to_string());
    }
    let handle = memory::http_server::start_server(port).await?;
    let port = handle.port;
    *guard = Some(handle);
    Ok(format!("Rust HTTP server listening on 127.0.0.1:{}", port))
}

/// Stop the Rust HTTP server. Idempotent — no error if not running.
#[tauri::command]
async fn nv_stop_rust_server(
    state: tauri::State<'_, RustServerState>,
) -> std::result::Result<(), String> {
    let mut guard = state.0.lock().await;
    if let Some(mut handle) = guard.take() {
        handle.stop().await;
    }
    Ok(())
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
    let id = brain_id.unwrap_or_else(|| {
        memory::read_ops::resolve_brain_id(None).unwrap_or_default()
    });
    if id.is_empty() {
        return Err("no active brain to watch".to_string());
    }
    memory::watcher::start_for_brain(&id, vault_dir())
        .map(|_| format!("watching brain {}", id))
        .map_err(|e| e.to_string())
}

/// Stop the per-brain vault watcher. Idempotent.
#[tauri::command]
fn nv_stop_vault_watcher(brain_id: Option<String>) -> std::result::Result<(), String> {
    let id = brain_id.unwrap_or_else(|| {
        memory::read_ops::resolve_brain_id(None).unwrap_or_default()
    });
    if id.is_empty() {
        return Ok(());
    }
    memory::watcher::stop_for_brain(&id);
    Ok(())
}

// --- Phase-8 Python-as-subprocess glue --------------------------------
//
// The hot path lives in Rust (Phases 2-7). Advanced features that
// stay in Python — compilation, PDF ingest, Zotero sync, code graph,
// drafts export — run here, on demand, as short-lived subprocesses
// that finish their job and exit. No more persistent Python daemon.
//
// Contract between Rust + Python:
//   * We spawn `python -m neurovault_server <job_name>`.
//   * We pipe `args_json` into its stdin as a single JSON blob.
//   * Python prints the result as one JSON blob to stdout and exits
//     with code 0. Any non-zero exit is surfaced to the caller with
//     stderr attached so the user sees the real error, not a generic
//     "python failed".
//
// Python path resolution (in order):
//   1. `NEUROVAULT_PYTHON` env var — explicit override for dev.
//   2. `python` on PATH — typical user install.
// That's it — we don't bundle a Python anymore (Phase 9). If neither
// is present the user gets a clean error message prompting them to
// install Python + run `uv sync`.

/// Result of a one-shot Python job invocation. `stdout` holds the
/// JSON payload the CLI module printed; `stderr` is captured so the
/// frontend can surface loguru warnings to the user. Shape is stable
/// — frontend components rely on the `ok` + `data` fields.
#[derive(serde::Serialize)]
struct PythonJobResult {
    ok: bool,
    exit_code: i32,
    data: Option<serde_json::Value>,
    stderr: String,
}

/// Resolve the python executable. Env override wins, otherwise we
/// assume `python` is on PATH.
fn python_executable() -> String {
    if let Ok(v) = std::env::var("NEUROVAULT_PYTHON") {
        if !v.trim().is_empty() {
            return v;
        }
    }
    "python".to_string()
}

/// Spawn a one-shot Python job and return its parsed JSON result.
/// See module doc for the protocol. Blocking — runs in
/// `tauri::async_runtime::spawn_blocking` so it doesn't tie up the
/// Tauri IPC thread.
#[tauri::command]
async fn run_python_job(
    job_name: String,
    args_json: Option<serde_json::Value>,
    timeout_secs: Option<u64>,
) -> std::result::Result<PythonJobResult, String> {
    // Reject characters that could smuggle an extra shell argument
    // or let an attacker target a different module. The dispatcher
    // is argv-based (not shell-parsed) so quoting is already safe,
    // but defence-in-depth: jobs are internal names, not user input.
    if !job_name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(format!("invalid job name: {}", job_name));
    }

    let payload = serde_json::to_string(&args_json.unwrap_or(serde_json::json!({})))
        .map_err(|e| format!("could not serialise args_json: {e}"))?;
    let python = python_executable();

    let result = tauri::async_runtime::spawn_blocking(move || -> std::io::Result<(i32, String, String)> {
        use std::io::Write;
        use std::process::{Command, Stdio};

        let mut child = Command::new(&python)
            .args(["-m", "neurovault_server", &job_name])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        // Write args to stdin + close it so the child's read terminates.
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(payload.as_bytes())?;
        }

        // Naive timeout: a long-running compile shouldn't run forever.
        // We wait up to `timeout_secs` then kill. Rust's std Child has
        // no native timeout wait; poll with a short sleep loop.
        let deadline = timeout_secs.map(|s| std::time::Instant::now() + std::time::Duration::from_secs(s));
        loop {
            match child.try_wait()? {
                Some(status) => {
                    let exit = status.code().unwrap_or(-1);
                    let stdout = child
                        .stdout
                        .take()
                        .map(|mut s| {
                            use std::io::Read;
                            let mut buf = String::new();
                            let _ = s.read_to_string(&mut buf);
                            buf
                        })
                        .unwrap_or_default();
                    let stderr = child
                        .stderr
                        .take()
                        .map(|mut s| {
                            use std::io::Read;
                            let mut buf = String::new();
                            let _ = s.read_to_string(&mut buf);
                            buf
                        })
                        .unwrap_or_default();
                    return Ok((exit, stdout, stderr));
                }
                None => {
                    if let Some(d) = deadline {
                        if std::time::Instant::now() >= d {
                            let _ = child.kill();
                            let stderr = child
                                .stderr
                                .take()
                                .map(|mut s| {
                                    use std::io::Read;
                                    let mut buf = String::new();
                                    let _ = s.read_to_string(&mut buf);
                                    buf
                                })
                                .unwrap_or_default();
                            return Ok((
                                124,
                                String::new(),
                                format!("{stderr}\n[run_python_job] job timed out after {}s", timeout_secs.unwrap_or(0)),
                            ));
                        }
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
            }
        }
    })
    .await
    .map_err(|e| format!("spawn_blocking join failed: {e}"))?
    .map_err(|e| format!("python spawn failed: {e}. Is python on PATH? (override with NEUROVAULT_PYTHON env var)"))?;

    let (exit, stdout, stderr) = result;
    let ok = exit == 0;
    let data = if stdout.trim().is_empty() {
        None
    } else {
        serde_json::from_str::<serde_json::Value>(stdout.trim())
            .ok()
            .or(Some(serde_json::Value::String(stdout)))
    };
    Ok(PythonJobResult {
        ok,
        exit_code: exit,
        data,
        stderr,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Emitter;
    use tauri::Manager;
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

    // CmdOrCtrl+Shift+Space — opens the QuickCapture overlay even when the
    // window isn't focused. Matches Bear/Drafts/Raycast muscle memory.
    let quick_capture = Shortcut::new(
        Some(Modifiers::CONTROL | Modifiers::SHIFT),
        Code::Space,
    );

    tauri::Builder::default()
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
            eprintln!("[neurovault] deep link forwarded to running instance: {:?}", argv);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
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
                    let _ = app.emit("quick-capture-shortcut", ());
                })
                .build(),
        )
        .setup(move |app| {
            // Register the shortcut at startup. If another app already owns
            // the combo we log and move on — the in-app Ctrl+Shift+Space
            // handler still works when the window is focused.
            match app.global_shortcut().register(quick_capture) {
                Ok(_) => eprintln!("[neurovault] global shortcut registered: Ctrl/Cmd+Shift+Space"),
                Err(e) => eprintln!(
                    "[neurovault] could not register global shortcut (another app likely owns it): {e}"
                ),
            }

            // Register the `neurovault://` URL scheme with the OS. In
            // production this is a no-op because the installer already
            // wrote the registry entry; in dev mode it lets you click
            // a deep link and have it route back to the running
            // `tauri dev` instance. Failure here is non-fatal.
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
            let app_handle = app.handle().clone();
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
                "[neurovault] desktop app ready. Rust backend in-process; Python sidecar retired. \
                 Advanced features spawn on demand via run_python_job."
            );

            Ok(())
        })
        .manage(ServerState(Mutex::new(None)))
        .manage(RustServerState(tokio::sync::Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            get_vault_path, list_notes, read_note, save_note, create_note, delete_note,
            start_server, stop_server, server_status, import_folder_as_vault,
            hide_to_background, brain_storage_stats,
            mcp_sidecar_path, mcp_config_path, reveal_in_file_manager,
            export_brain_as_zip,
            list_brains_offline, set_active_brain_offline,
            // Phase-4 Rust memory commands. Each one replaces an HTTP
            // endpoint — frontend feature-detects and prefers these.
            nv_list_notes, nv_get_note, nv_list_brains, nv_brain_stats, nv_get_graph,
            // Phase-5 write-path commands. Run the full ingest pipeline
            // (chunk → embed → entities → links → BM25) in-process.
            nv_save_note, nv_create_note, nv_delete_note,
            // Phase-6 recall + Rust HTTP server on 8765. `nv_recall`
            // is the in-process Tauri path; the HTTP server serves
            // MCP proxy + external HTTP clients.
            nv_recall, nv_set_pagerank, nv_set_clusters, nv_get_cluster_names,
            nv_start_rust_server, nv_stop_rust_server,
            // Tier-A agent-efficiency: cheap 1-2 hop neighbour lookup.
            nv_get_related,
            // Phase-7 vault file watcher. Started automatically on
            // brain activation; the Tauri commands are here for
            // debug/manual control from Settings.
            nv_start_vault_watcher, nv_stop_vault_watcher,
            // Phase-8 Python-as-subprocess glue. One command spawns
            // `python -m neurovault_server <job>` for advanced
            // features (compile, pdf ingest, zotero) that stay in
            // Python. Replaces the persistent sidecar model.
            run_python_job,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Kill the sidecar when the app exits so the Python server doesn't
            // linger as an orphan process holding port 8765. Without this the
            // user sees "already running" errors on next launch.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app.try_state::<ServerState>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(child) = guard.take() {
                            let _ = child.kill();
                            eprintln!("[neurovault] killed sidecar on app exit");
                        }
                    }
                }
                // Stop every per-brain vault watcher so worker
                // threads + OS-level watches exit cleanly. Without
                // this, notify's background listener on Windows can
                // keep the process alive for a few seconds after
                // the main window closes.
                memory::watcher::stop_all();
            }
        });
}
