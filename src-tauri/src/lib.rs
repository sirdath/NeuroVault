use serde::Serialize;
use slug::slugify;
use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;
use uuid::Uuid;

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

    // Try brains.json first (multi-brain mode)
    let registry_path = nv_home.join("brains.json");
    if registry_path.exists() {
        if let Ok(data) = fs::read_to_string(&registry_path) {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&data) {
                if let Some(active_id) = parsed.get("active").and_then(|v| v.as_str()) {
                    let vault = nv_home.join("brains").join(active_id).join("vault");
                    fs::create_dir_all(&vault).ok();
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
    default_vault
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

    let entries = fs::read_dir(&vault).map_err(|e| format!("Failed to read vault: {e}"))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().map_or(false, |ext| ext == "md") {
            let filename = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            let metadata = fs::metadata(&path).map_err(|e| format!("Failed to read metadata: {e}"))?;
            let modified = metadata
                .modified()
                .unwrap_or(SystemTime::UNIX_EPOCH)
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let size = metadata.len();
            let content = fs::read_to_string(&path).unwrap_or_default();
            let title = extract_title(&content, &filename);

            notes.push(NoteMeta { filename, title, modified, size });
        }
    }

    notes.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(notes)
}

#[tauri::command]
fn read_note(filename: String) -> Result<String, String> {
    fs::read_to_string(vault_dir().join(&filename)).map_err(|e| format!("Failed to read note: {e}"))
}

#[tauri::command]
fn save_note(filename: String, content: String) -> Result<(), String> {
    fs::write(vault_dir().join(&filename), &content).map_err(|e| format!("Failed to save note: {e}"))
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
    let src = vault_dir().join(&filename);
    let dst = trash_dir().join(&filename);
    if src.exists() {
        fs::rename(&src, &dst).map_err(|e| format!("Failed to move note to trash: {e}"))
    } else {
        Err(format!("Note not found: {filename}"))
    }
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
        .invoke_handler(tauri::generate_handler![
            get_vault_path, list_notes, read_note, save_note, create_note, delete_note,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
