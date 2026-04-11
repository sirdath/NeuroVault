use serde::Serialize;
use slug::slugify;
use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;
use uuid::Uuid;

/// Metadata for a note displayed in the sidebar
#[derive(Debug, Serialize, Clone)]
pub struct NoteMeta {
    pub filename: String,
    pub title: String,
    pub modified: u64,
    pub size: u64,
}

/// Read brains.json to find the active brain directory
fn active_brain_dir() -> PathBuf {
    let home = dirs::home_dir().expect("Could not determine home directory");
    let registry_path = home.join(".engram").join("brains.json");

    if registry_path.exists() {
        if let Ok(data) = fs::read_to_string(&registry_path) {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&data) {
                if let Some(active_id) = parsed.get("active").and_then(|v| v.as_str()) {
                    return home.join(".engram").join("brains").join(active_id);
                }
            }
        }
    }

    // Fallback: default brain
    home.join(".engram").join("brains").join("default")
}

/// Get the vault directory for the active brain
fn vault_dir() -> PathBuf {
    let vault = active_brain_dir().join("vault");
    fs::create_dir_all(&vault).expect("Could not create vault directory");
    vault
}

/// Get the trash directory for the active brain
fn trash_dir() -> PathBuf {
    let trash = active_brain_dir().join("trash");
    fs::create_dir_all(&trash).expect("Could not create trash directory");
    trash
}

/// Extract the title from markdown content (first # heading or first line)
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
            let filename = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

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

            notes.push(NoteMeta {
                filename,
                title,
                modified,
                size,
            });
        }
    }

    notes.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(notes)
}

#[tauri::command]
fn read_note(filename: String) -> Result<String, String> {
    let path = vault_dir().join(&filename);
    fs::read_to_string(&path).map_err(|e| format!("Failed to read note: {e}"))
}

#[tauri::command]
fn save_note(filename: String, content: String) -> Result<(), String> {
    let path = vault_dir().join(&filename);
    fs::write(&path, &content).map_err(|e| format!("Failed to save note: {e}"))
}

#[tauri::command]
fn create_note(title: String) -> Result<String, String> {
    let vault = vault_dir();
    let slug = slugify(&title);
    let id = &Uuid::new_v4().to_string()[..8];
    let filename = format!("{slug}-{id}.md");
    let path = vault.join(&filename);

    let content = format!("# {title}\n\n");
    fs::write(&path, &content).map_err(|e| format!("Failed to create note: {e}"))?;

    Ok(filename)
}

#[tauri::command]
fn delete_note(filename: String) -> Result<(), String> {
    let vault = vault_dir();
    let trash = trash_dir();
    let src = vault.join(&filename);
    let dst = trash.join(&filename);

    if src.exists() {
        fs::rename(&src, &dst).map_err(|e| format!("Failed to move note to trash: {e}"))
    } else {
        Err(format!("Note not found: {filename}"))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            #[cfg(not(dev))]
            {
                use tauri_plugin_shell::ShellExt;
                let sidecar = app
                    .shell()
                    .sidecar("engram-server")
                    .expect("failed to create engram-server sidecar");
                let (_rx, _child) = sidecar
                    .spawn()
                    .expect("failed to spawn engram-server sidecar");
                app.manage(_child);
            }
            #[cfg(dev)]
            {
                let _ = app;
                eprintln!("[engram] dev mode: start the server manually with `cd server && uv run python -m engram_server --http-only`");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_vault_path,
            list_notes,
            read_note,
            save_note,
            create_note,
            delete_note,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
