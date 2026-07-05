//! Cross-platform vault file watcher.
//!
//! Port of `server/neurovault_server/watcher.py`. Uses the `notify`
//! crate (same underlying C APIs Python's `watchdog` wraps) with a
//! **per-file 500 ms debounce** so an editor's save-burst pattern
//! (temp file → rename → fsync → another fsync on some filesystems)
//! collapses into one ingest per write.
//!
//! Per-brain model: one watcher per active brain. Activating a
//! brain starts its watcher; switching brains stops the previous
//! watcher and starts a new one. Callers hold onto the
//! `WatcherHandle` returned by `start_watcher`; dropping it stops
//! the OS-level watch + signals the worker thread to exit.
//!
//! Events we react to:
//!   * `Create`, `Modify` on `.md` files → `ingest::ingest_file`
//!   * `Remove`, `Rename(to non-md or gone)` → no-op here; the
//!     next full-vault scan picks up the disappearance and the
//!     Rust `nv_delete_note` command handles user-initiated deletes
//!     directly. Watcher-driven deletion was a Python quirk that
//!     deadlocked on Windows whenever the editor held a file handle
//!     during save-then-reopen.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use once_cell::sync::OnceCell;
use parking_lot::RwLock;

use super::db::open_brain;
use super::ingest;
use super::types::{MemoryError, Result};

/// Per-file debounce window. A file that fires two events inside
/// this window only gets one ingest. Matches the 500 ms window
/// Python's watcher used after we tuned it for atomic-rename
/// editors (VSCode, IntelliJ) on Windows.
const DEBOUNCE_MS: u64 = 500;

/// How often the worker wakes up to check its shutdown flag when
/// no events are pending. Short enough that `stop()` is snappy;
/// long enough not to burn CPU in an idle vault.
const POLL_MS: u64 = 200;

/// Handle to a running watcher. Drop it (or call `stop()`) to
/// release the OS watch and join the worker thread. `_watcher`
/// stays in the struct solely so its Drop runs last.
pub struct WatcherHandle {
    brain_id: String,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
    // Keep the underlying platform watcher alive for the lifetime
    // of this handle. Dropping it stops the OS-level watch.
    _watcher: RecommendedWatcher,
    // Source-folder mirroring (per-brain `source_folders`). When the active
    // brain has configured source folders we ALSO watch each one and mirror
    // its `.md` changes into the vault. These stay alive for the lifetime of
    // the handle; dropping them stops the OS-level source watches. Empty for
    // a brain with no sources, so a plain vault-only brain is unaffected.
    _source_watchers: Vec<RecommendedWatcher>,
    source_worker: Option<JoinHandle<()>>,
}

impl WatcherHandle {
    pub fn brain_id(&self) -> &str {
        &self.brain_id
    }

    /// Graceful shutdown. Signals the worker thread, waits for it
    /// to finish processing any in-flight event, then returns.
    /// Idempotent — calling twice is a no-op after the first.
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(w) = self.worker.take() {
            let _ = w.join();
        }
        if let Some(w) = self.source_worker.take() {
            let _ = w.join();
        }
    }
}

impl Drop for WatcherHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Start watching `vault_path` for `.md` changes. Events coming
/// out of the notify crate get funnelled through a std mpsc
/// channel into a worker thread that debounces per-file and
/// invokes `ingest::ingest_file`.
///
/// Returns immediately — the watcher + worker are background.
pub fn start_watcher(brain_id: &str, vault_path: PathBuf) -> Result<WatcherHandle> {
    if !vault_path.exists() {
        return Err(MemoryError::Other(format!(
            "vault path does not exist: {}",
            vault_path.display()
        )));
    }

    let (tx, rx) = mpsc::channel::<notify::Event>();
    let mut watcher = RecommendedWatcher::new(
        move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                // Channel send failure means the worker exited; the
                // OS-level watcher hasn't been dropped yet so we
                // still get called. Silent discard — next event
                // also sees a closed channel and also drops. No
                // useful action here.
                let _ = tx.send(event);
            }
        },
        Config::default(),
    )
    .map_err(|e| MemoryError::Other(format!("notify init failed: {}", e)))?;

    watcher
        .watch(&vault_path, RecursiveMode::Recursive)
        .map_err(|e| MemoryError::Other(format!("notify watch failed: {}", e)))?;

    let stop = Arc::new(AtomicBool::new(false));
    let stop_worker = Arc::clone(&stop);
    let brain_id_owned = brain_id.to_string();
    let vault_root = vault_path.clone();
    let worker = thread::Builder::new()
        .name(format!("nv-watch-{}", brain_id))
        .spawn(move || worker_loop(brain_id_owned, vault_root, rx, stop_worker))
        .map_err(|e| MemoryError::Other(format!("worker spawn failed: {}", e)))?;

    // Source-folder mirroring. If this brain has enabled source folders,
    // start a recursive watcher on each + a worker that routes events through
    // the mirror engine. Failures here are non-fatal: a brain with an
    // unavailable source (unplugged drive) still watches its vault normally.
    let (source_watchers, source_worker) = start_source_watchers(brain_id, &stop);

    Ok(WatcherHandle {
        brain_id: brain_id.to_string(),
        stop,
        worker: Some(worker),
        _watcher: watcher,
        _source_watchers: source_watchers,
        source_worker,
    })
}

/// Build recursive watchers for each enabled source folder of `brain_id`
/// plus a worker thread that mirrors their `.md` changes into the vault.
/// Returns `(watchers, worker)` — both empty/`None` when the brain has no
/// usable source folders. Never errors: a folder that can't be watched
/// (missing, permissions) is logged + skipped so the rest of the watcher
/// keeps working.
fn start_source_watchers(
    brain_id: &str,
    stop: &Arc<AtomicBool>,
) -> (Vec<RecommendedWatcher>, Option<JoinHandle<()>>) {
    let folders = match super::read_ops::registry_source_folders(brain_id) {
        Ok(f) => f,
        Err(e) => {
            eprintln!(
                "[watcher] could not read source_folders for {}: {}",
                brain_id, e
            );
            return (Vec::new(), None);
        }
    };
    let enabled: Vec<PathBuf> = folders
        .into_iter()
        .filter(|f| f.enabled)
        .map(|f| PathBuf::from(f.path))
        .filter(|p| p.is_dir())
        .collect();
    if enabled.is_empty() {
        return (Vec::new(), None);
    }

    let (tx, rx) = mpsc::channel::<notify::Event>();
    let mut watchers = Vec::with_capacity(enabled.len());
    for root in &enabled {
        let tx = tx.clone();
        let mut w = match RecommendedWatcher::new(
            move |res: notify::Result<notify::Event>| {
                if let Ok(event) = res {
                    let _ = tx.send(event);
                }
            },
            Config::default(),
        ) {
            Ok(w) => w,
            Err(e) => {
                eprintln!(
                    "[watcher] source notify init failed for {}: {}",
                    root.display(),
                    e
                );
                continue;
            }
        };
        if let Err(e) = w.watch(root, RecursiveMode::Recursive) {
            eprintln!(
                "[watcher] source watch failed for {}: {}",
                root.display(),
                e
            );
            continue;
        }
        watchers.push(w);
    }
    if watchers.is_empty() {
        return (Vec::new(), None);
    }

    let stop_worker = Arc::clone(stop);
    let brain_id_owned = brain_id.to_string();
    let worker = thread::Builder::new()
        .name(format!("nv-src-watch-{}", brain_id))
        .spawn(move || source_worker_loop(brain_id_owned, rx, stop_worker))
        .ok();
    (watchers, worker)
}

/// Worker loop for source-folder events. Mirrors the vault worker's per-file
/// debounce, but routes by event kind: Create/Modify of a `.md` →
/// mirror+ingest; Remove/Rename → unmirror (delete vault file + engram +
/// manifest entry). The vault worker can't do the second half because it
/// ignores Remove/Rename — that's exactly why the mirror owns deletions.
fn source_worker_loop(brain_id: String, rx: mpsc::Receiver<notify::Event>, stop: Arc<AtomicBool>) {
    // Pending upserts + removes, each with a fire-at deadline (debounce).
    let mut pending_upsert: HashMap<PathBuf, Instant> = HashMap::new();
    let mut pending_remove: HashMap<PathBuf, Instant> = HashMap::new();

    while !stop.load(Ordering::Acquire) {
        match rx.recv_timeout(Duration::from_millis(POLL_MS)) {
            Ok(event) => {
                let deadline = Instant::now() + Duration::from_millis(DEBOUNCE_MS);
                match event.kind {
                    EventKind::Create(_) | EventKind::Modify(_) => {
                        for p in &event.paths {
                            if is_markdown(p) && !is_temp_or_dotfile(p) {
                                pending_remove.remove(p);
                                pending_upsert.insert(p.clone(), deadline);
                            }
                        }
                    }
                    EventKind::Remove(_) => {
                        for p in &event.paths {
                            // A removed file may no longer have an extension
                            // reported reliably; mirror by path match in the
                            // manifest, so accept any path.
                            pending_upsert.remove(p);
                            pending_remove.insert(p.clone(), deadline);
                        }
                    }
                    // Rename shows up as Modify(Name(_)) on most platforms;
                    // notify also surfaces it under Modify(_) which we treat
                    // as upsert above. The "from" side of a rename (file now
                    // gone) is caught by the manifest-diff on the next full
                    // sync; we additionally enqueue a remove for any path that
                    // no longer exists when its deadline fires (below).
                    _ => {}
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }

        let now = Instant::now();

        let ready_up: Vec<PathBuf> = pending_upsert
            .iter()
            .filter(|(_, d)| **d <= now)
            .map(|(p, _)| p.clone())
            .collect();
        for path in ready_up {
            pending_upsert.remove(&path);
            // A path that vanished before its deadline (rename/atomic save)
            // becomes a remove instead.
            if !path.exists() {
                if let Err(e) = super::source_mirror::handle_source_remove(&brain_id, &path) {
                    eprintln!("[src-watch] remove {} failed: {}", path.display(), e);
                }
                continue;
            }
            if let Err(e) = super::source_mirror::handle_source_upsert(&brain_id, &path) {
                eprintln!("[src-watch] upsert {} failed: {}", path.display(), e);
            }
        }

        let ready_rm: Vec<PathBuf> = pending_remove
            .iter()
            .filter(|(_, d)| **d <= now)
            .map(|(p, _)| p.clone())
            .collect();
        for path in ready_rm {
            pending_remove.remove(&path);
            if let Err(e) = super::source_mirror::handle_source_remove(&brain_id, &path) {
                eprintln!("[src-watch] remove {} failed: {}", path.display(), e);
            }
        }
    }
}

/// The worker thread main loop. Debounces per-file and runs
/// `ingest::ingest_file` for each coalesced event.
fn worker_loop(
    brain_id: String,
    vault_root: PathBuf,
    rx: mpsc::Receiver<notify::Event>,
    stop: Arc<AtomicBool>,
) {
    // Per-file debounce state. Tracks the instant of the last
    // ingest attempt for each path so a flurry of writes inside
    // the debounce window collapses to one.
    let mut last_fired: HashMap<PathBuf, Instant> = HashMap::new();

    // Queue of paths pending ingest after their debounce window
    // closes. We could ingest synchronously inside the recv loop,
    // but that would block subsequent events from landing — instead
    // we stamp the path into this map with a "fire-at" deadline
    // and drain deadlines on each loop iteration.
    let mut pending: HashMap<PathBuf, Instant> = HashMap::new();

    while !stop.load(Ordering::Acquire) {
        match rx.recv_timeout(Duration::from_millis(POLL_MS)) {
            Ok(event) => {
                for path in relevant_paths(&event, &vault_root) {
                    // Stamp or restamp the fire-at deadline for this
                    // path. Restamping a pending path pushes its
                    // deadline out — that's the debounce.
                    pending.insert(path, Instant::now() + Duration::from_millis(DEBOUNCE_MS));
                }
            }
            Err(RecvTimeoutError::Timeout) => { /* fall through to drain */ }
            Err(RecvTimeoutError::Disconnected) => break,
        }

        // Drain any pending paths whose debounce window has closed.
        let now = Instant::now();
        let ready: Vec<PathBuf> = pending
            .iter()
            .filter(|(_, deadline)| **deadline <= now)
            .map(|(p, _)| p.clone())
            .collect();
        for path in ready {
            pending.remove(&path);
            // Skip if we just ingested this file — guards against
            // an ingest that's itself triggering a notify event
            // (write → notify → ingest → rewrite-via-git → notify
            // loop). The 200 ms threshold is short enough to still
            // catch normal editor save-then-save patterns.
            if let Some(last) = last_fired.get(&path) {
                if now.duration_since(*last) < Duration::from_millis(200) {
                    continue;
                }
            }
            last_fired.insert(path.clone(), now);
            if let Err(e) = ingest_path(&brain_id, &vault_root, &path) {
                eprintln!(
                    "[watcher] ingest of {} in brain {} failed: {}",
                    path.display(),
                    brain_id,
                    e
                );
            }
        }
    }
}

/// Extract the set of `.md` paths from a notify event that we want
/// to ingest. Filters out non-markdown files, non-create/modify
/// event kinds, and temp-file editor crud.
fn relevant_paths(event: &notify::Event, vault_root: &Path) -> Vec<PathBuf> {
    // Only act on create / modify. Remove + rename-away leave the
    // DB row in place (consistent with the Python watcher) — the
    // user triggers deletion explicitly via `nv_delete_note`.
    match event.kind {
        EventKind::Create(_) | EventKind::Modify(_) => {}
        _ => return Vec::new(),
    }

    let mut out = Vec::new();
    for p in &event.paths {
        if !is_markdown(p) {
            continue;
        }
        if is_temp_or_dotfile(p) {
            continue;
        }
        // Must live under the vault root — notify can sometimes
        // report events for the watch root itself; skip them.
        if !p.starts_with(vault_root) {
            continue;
        }
        out.push(p.clone());
    }
    out
}

fn is_markdown(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("md"))
        .unwrap_or(false)
}

/// Skip editor temp files. VSCode writes `.md.tmp` then renames;
/// Vim writes `4913` / `~` files; Obsidian writes `.obsidian` crud.
fn is_temp_or_dotfile(p: &Path) -> bool {
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    if name.starts_with('.') {
        return true;
    }
    if name.ends_with('~') {
        return true;
    }
    if name.contains(".tmp") || name.contains(".swp") {
        return true;
    }
    false
}

fn ingest_path(brain_id: &str, vault_root: &Path, path: &Path) -> Result<()> {
    // Skip if the file vanished between the notify event firing
    // and us getting to it — atomic-rename editors briefly unlink
    // the target during save.
    if !path.exists() {
        return Ok(());
    }
    let db = open_brain(brain_id)?;
    let _ = ingest::ingest_file(path, Some(vault_root), &db)?;
    Ok(())
}

// ---- Process-wide cache --------------------------------------------------

/// One watcher per brain. Activating a brain starts its watcher
/// (if not already running) via `start_for_brain`. Switching
/// brains stops the old handle first; the `Drop` on the returned
/// `WatcherHandle` handles the actual teardown.
fn cache() -> &'static RwLock<HashMap<String, WatcherHandle>> {
    static CACHE: OnceCell<RwLock<HashMap<String, WatcherHandle>>> = OnceCell::new();
    CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Start (or no-op, if already running) the watcher for `brain_id`
/// pointing at `vault_path`. Returns the port the watcher is
/// serving on — a stub string for now; the caller displays it in
/// the UI's "watcher: on" indicator.
pub fn start_for_brain(brain_id: &str, vault_path: PathBuf) -> Result<()> {
    // Make sure the brain's raw/ drop-folder + its README guide exist so
    // the user always has an empty folder to paste documents into.
    // Best-effort — never block the watcher on it.
    let _ = super::inbox::ensure_raw_dir(brain_id);
    {
        let guard = cache().read();
        if guard.contains_key(brain_id) {
            return Ok(());
        }
    }
    let handle = start_watcher(brain_id, vault_path)?;
    cache().write().insert(brain_id.to_string(), handle);

    // Initial source-folder mirror for the now-active brain. This is the
    // integration point that makes activation pick up source folders: any
    // activation path that calls `start_for_brain` gets an initial sync for
    // free without those callers knowing about sources. Run on a detached
    // thread so a large initial mirror doesn't block the activation request;
    // errors are logged, never fatal.
    let brain_owned = brain_id.to_string();
    let _ = thread::Builder::new()
        .name(format!("nv-src-sync-{}", brain_id))
        .spawn(move || {
            if let Err(e) = super::source_mirror::sync(&brain_owned) {
                eprintln!(
                    "[watcher] initial source sync for {} failed: {}",
                    brain_owned, e
                );
            }
        });
    Ok(())
}

/// Restart the watcher for `brain_id` (stop + start), re-reading its
/// `source_folders` from the registry and running a fresh initial sync.
/// Called by the PUT /sources handler after persisting a new source list
/// for the ACTIVE brain so the OS-level source watches reflect the new
/// config immediately. No-op-safe to call for a non-running brain: it
/// simply starts a fresh watcher.
pub fn restart_for_brain(brain_id: &str, vault_path: PathBuf) -> Result<()> {
    stop_for_brain(brain_id);
    start_for_brain(brain_id, vault_path)
}

/// Stop the watcher for `brain_id` if one is running. Idempotent.
pub fn stop_for_brain(brain_id: &str) {
    if let Some(mut handle) = cache().write().remove(brain_id) {
        handle.stop();
    }
}

/// Stop every running watcher. Called on app shutdown + brain
/// switch (stop all, then start the new active brain's watcher).
pub fn stop_all() {
    let mut map = cache().write();
    let ids: Vec<String> = map.keys().cloned().collect();
    for id in ids {
        if let Some(mut handle) = map.remove(&id) {
            handle.stop();
        }
    }
}
