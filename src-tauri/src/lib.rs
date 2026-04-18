use serde::Serialize;
use slug::slugify;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::SystemTime;
use tauri_plugin_shell::process::CommandChild;
use uuid::Uuid;

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
## How it works\n\n\
- **Notes live here as plain markdown files** — you own them forever\n\
- Type `[[` to link notes together\n\
- Press `Ctrl+N` to create a new note\n\
- Press `Ctrl+K` to search everything\n\
- Switch to the **Graph** tab to see connections\n\
- Click the **gear** icon (bottom-left) to customize themes\n\n\
## Memory features (requires server)\n\n\
Start the server from Settings to enable:\n\
- **Search** that understands meaning, not just keywords\n\
- **Connections** between related notes, automatically\n\
- **Knowledge graph** visualization\n\
- **Compilations** — AI-maintained canonical wiki pages\n\n\
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

            // The Python MCP server is NOT auto-started. The user controls
            // it via Settings → Server → Start/Stop. The frontend shows a
            // "server offline" banner when 8765 isn't responding, with
            // instructions on how to start it.
            //
            // For packaged builds with a sidecar binary, a future "Start
            // Server" button in Settings can call shell().sidecar() on demand.
            eprintln!(
                "[neurovault] desktop app ready. Start the server via Settings or: \
                 cd server && uv run python -m neurovault_server --http-only"
            );

            Ok(())
        })
        .manage(ServerState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            get_vault_path, list_notes, read_note, save_note, create_note, delete_note,
            start_server, stop_server, server_status, import_folder_as_vault,
            hide_to_background, brain_storage_stats,
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
            }
        });
}
