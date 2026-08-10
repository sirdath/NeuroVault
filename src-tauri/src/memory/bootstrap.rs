//! First-run bootstrap: the backend always comes up with a brain.
//!
//! README promises *"Agent auto-start — your MCP agent starts the memory
//! backend for you on first use; no need to open the app first."* The
//! auto-start half worked (`mcp::ensure_backend` spawns a headless
//! server), but **nothing ever created a brain**: the only code path that
//! wrote `brains.json` was `POST /api/brains`, which only the GUI's
//! onboarding calls. So on a fresh machine the agent-first path brought a
//! backend up over an empty `~/.neurovault` and every tool call answered
//! `{"error":"brains.json unreadable: No such file or directory (os error 2)"}`.
//!
//! `ensure_default_brain()` closes that gap at server start. It writes
//! exactly what `handlers::brains_create` + `handlers::brains_activate`
//! write for a GUI-made brain — a registry entry
//! (`id`/`name`/`description`/`created_at`), `active` pointing at it, the
//! brain dir + `brain.db`, plus the vault folder — so a bootstrapped brain
//! is structurally indistinguishable from one the user made in the app.
//!
//! Three invariants, in priority order:
//!
//! 1. **Never touch an existing `brains.json`.** The registry is the
//!    user's brain list; a bootstrap that rewrote it could orphan vaults.
//!    The write is an exclusive create (`create_new` / `link`), never a
//!    `rename` — `rename` clobbers, so a slow second process could
//!    overwrite a registry the winner had already added a brain to.
//! 2. **Never hide existing data.** A pre-multi-brain install
//!    (`~/.neurovault/vault/`, no registry) is left alone: writing a
//!    registry there would make `app::vault_dir()` prefer the new empty
//!    brain and the user's notes would vanish from the UI. Orphaned brain
//!    directories with no registry are adopted rather than shadowed.
//! 3. **Never block startup.** Every step past the registry write is
//!    best-effort: a `brain.db` that can't be opened (missing `vec0`
//!    extension, read-only disk) is recreated lazily on first use, and a
//!    warning on stderr beats refusing to serve.

use std::fs;
use std::io::Write;
use std::path::Path;

use super::db::open_brain;
use super::paths::{brain_dir, brains_root, nv_home, registry_path, vault_dir};
use super::read_ops::is_safe_brain_id;

/// Id of the brain a fresh install gets. A plain slug — same shape
/// `brains_create` derives from a user-typed name, and already in the
/// accepted-ids list `read_ops::is_safe_brain_id` is tested against.
pub const DEFAULT_BRAIN_ID: &str = "main";

/// Display name for the bootstrapped brain. Title-case because the
/// registry's `name` is what the brain picker shows.
pub const DEFAULT_BRAIN_NAME: &str = "Main";

/// Make sure this NeuroVault home has at least one brain and an active
/// one. Returns the id it activated when this call did the bootstrap,
/// `None` when there was nothing to do (registry already present) or when
/// bootstrapping was deliberately skipped (see invariant 2).
///
/// Idempotent and safe to call from several processes at once.
pub fn ensure_default_brain() -> Option<String> {
    let registry = registry_path();
    // Invariant 1. Cheap pre-check so the common case (every start after
    // the first) touches nothing; the write below is exclusive anyway, so
    // this racing with another process is harmless.
    if registry.exists() {
        return None;
    }
    // Invariant 2. Pre-multi-brain home: `~/.neurovault/vault/*.md` and no
    // registry. `app::vault_dir()` prefers the registry once one exists,
    // so inventing one here would swap the user's notes for an empty
    // brain. Leave it to the app's own legacy path.
    if nv_home().join("vault").is_dir() {
        eprintln!(
            "[neurovault] legacy single-brain vault found and no brains.json — \
             not bootstrapping a default brain (open the app to migrate)"
        );
        return None;
    }

    // Registry lost but brain data still on disk: re-register what's there
    // rather than shadowing it with an empty `main` the picker would show
    // instead. A fresh machine has none of these and gets `main`.
    let adopted = adoptable_brain_ids();
    let brains: Vec<(String, String)> = if adopted.is_empty() {
        vec![(DEFAULT_BRAIN_ID.to_string(), DEFAULT_BRAIN_NAME.to_string())]
    } else {
        adopted.iter().map(|id| (id.clone(), id.clone())).collect()
    };
    let active = brains[0].0.clone();

    let now = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();
    // Field-for-field what `handlers::brains_create` writes, plus the
    // `active` key `handlers::brains_activate` sets — a bootstrapped brain
    // must not be a second, subtly different shape.
    let doc = serde_json::json!({
        "brains": brains
            .iter()
            .map(|(id, name)| serde_json::json!({
                "id": id,
                "name": name,
                "description": "",
                "created_at": now,
            }))
            .collect::<Vec<_>>(),
        "active": active,
    });
    let body = match serde_json::to_string_pretty(&doc) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[neurovault] bootstrap: could not serialise brains.json: {e}");
            return None;
        }
    };

    match claim_registry(&registry, &body) {
        Ok(true) => {}
        // Another process bootstrapped between our check and our write.
        Ok(false) => return None,
        Err(e) => {
            eprintln!("[neurovault] bootstrap: could not write {registry:?}: {e}");
            return None;
        }
    }

    // Invariant 3: everything from here is best-effort. The registry is
    // what unblocks `resolve_brain_id`; the vault dir and the schema are
    // recreated on demand by `write_ops` / `open_brain` if this fails.
    if let Err(e) = fs::create_dir_all(vault_dir(&active)) {
        eprintln!("[neurovault] bootstrap: could not create vault dir: {e}");
    }
    if let Err(e) = open_brain(&active) {
        eprintln!("[neurovault] bootstrap: could not initialise brain.db: {e}");
    }
    eprintln!("[neurovault] first run: created default brain '{active}'");
    Some(active)
}

/// Brain directories that already hold data but aren't in any registry.
/// Sorted so the choice of active brain is deterministic across processes
/// racing to bootstrap.
///
/// A `vault/` counts as data on its own, not just a `brain.db`: the app's
/// pre-registry fallback (`app::vault_dir()`) seeds
/// `brains/default/vault/welcome.md` with no database, and a `main` that
/// shadowed it would leave that note stranded.
fn adoptable_brain_ids() -> Vec<String> {
    let Ok(entries) = fs::read_dir(brains_root()) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().into_string().ok())
        // The id becomes a path segment again via `brain_dir()`, so it has
        // to clear the same guard an API-supplied id does.
        .filter(|id| {
            is_safe_brain_id(id)
                && (brain_dir(id).join("brain.db").exists() || brain_dir(id).join("vault").is_dir())
        })
        .collect();
    ids.sort();
    ids
}

/// Publish `body` at `path` only if nothing is there yet. `Ok(false)`
/// means someone else won the race.
///
/// Deliberately NOT the `write(tmp) + rename` pattern used elsewhere in
/// the codebase: `rename` overwrites unconditionally, so a second process
/// arriving late would clobber a registry the winner had already added a
/// brain to. `link` is atomic AND fails on an existing target, which is
/// exactly "create if absent" — and it publishes a file that was already
/// written and fsynced, so no reader can observe a half-written registry.
/// `create_new` is the fallback for filesystems without hard links.
fn claim_registry(path: &Path, body: &str) -> std::io::Result<bool> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    // Unique per process AND per call: two threads staging through the
    // same filename would truncate each other's buffer mid-write.
    static STAGE_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let staged = path.with_extension(format!(
        "json.{}-{}.tmp",
        std::process::id(),
        STAGE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
    ));
    {
        let mut f = fs::File::create(&staged)?;
        f.write_all(body.as_bytes())?;
        f.sync_all()?;
    }
    let claimed = match fs::hard_link(&staged, path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(_) => match fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(path)
        {
            Ok(mut f) => {
                f.write_all(body.as_bytes())?;
                f.sync_all()?;
                Ok(true)
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
            Err(e) => Err(e),
        },
    };
    let _ = fs::remove_file(&staged);
    claimed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::journal::TEST_HOME_LOCK;
    use std::path::PathBuf;

    /// Same isolation pattern as `journal.rs`: one shared lock (env vars
    /// are process-global and cargo runs tests as threads) + a throwaway
    /// `NEUROVAULT_HOME`. Also drops any cached `BrainDb` for the ids we
    /// touch — `db::open_brain` caches by id alone, so a handle to a
    /// deleted temp home would leak into the next test.
    fn with_temp_home<F: FnOnce(&PathBuf)>(f: F) {
        let _guard = TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let home = std::env::temp_dir().join(format!(
            "nv-bootstrap-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("NEUROVAULT_HOME", &home);
        let vec0 = install_vec0();
        f(&home);
        for id in [DEFAULT_BRAIN_ID, "legacy-one", "default"] {
            crate::memory::db::close_brain(id);
        }
        if vec0 {
            std::env::remove_var("NEUROVAULT_VEC_EXTENSION");
        }
        std::env::remove_var("NEUROVAULT_HOME");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Point `sqlite_vec` at the checked-in extension (same idiom as the
    /// retriever tests) so the bootstrapped `brain.db` is initialised for
    /// real. Returns false where the platform's library isn't in the repo
    /// — there `open_brain` fails for every brain, bootstrapped or not,
    /// and the schema assertion is skipped rather than made platform-dependent.
    fn install_vec0() -> bool {
        let file = if cfg!(target_os = "windows") {
            "vec0.dll"
        } else if cfg!(target_os = "macos") {
            "vec0.dylib"
        } else {
            "vec0.so"
        };
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(file);
        if !path.exists() {
            return false;
        }
        std::env::set_var("NEUROVAULT_VEC_EXTENSION", &path);
        true
    }

    fn read_registry(home: &Path) -> serde_json::Value {
        let raw = std::fs::read_to_string(home.join("brains.json"))
            .expect("brains.json must exist after bootstrap");
        serde_json::from_str(&raw).expect("brains.json must be valid JSON")
    }

    /// THE BLOCKER. A fresh home + a backend start must leave a brain that
    /// is present, active, and well-formed — otherwise every MCP tool call
    /// from an auto-started backend dies on a missing registry.
    #[test]
    fn fresh_home_creates_and_activates_the_default_brain() {
        with_temp_home(|home| {
            let created = ensure_default_brain();
            assert_eq!(
                created.as_deref(),
                Some(DEFAULT_BRAIN_ID),
                "a fresh home must be bootstrapped"
            );

            let reg = read_registry(home);
            assert_eq!(
                reg["active"].as_str(),
                Some(DEFAULT_BRAIN_ID),
                "the bootstrapped brain must be the active one"
            );
            let brains = reg["brains"].as_array().expect("brains must be an array");
            assert_eq!(brains.len(), 1, "exactly one brain: {reg}");
            assert_eq!(brains[0]["id"].as_str(), Some(DEFAULT_BRAIN_ID));
            assert_eq!(brains[0]["name"].as_str(), Some(DEFAULT_BRAIN_NAME));
            // `brains_create` stamps these two on every GUI-made brain;
            // a bootstrapped one must not be a different shape.
            assert!(brains[0]["description"].is_string());
            assert!(
                brains[0]["created_at"]
                    .as_str()
                    .is_some_and(|s| s.contains('T')),
                "created_at must be RFC3339: {}",
                brains[0]
            );

            // Same on-disk layout the app builds.
            assert!(
                home.join("brains")
                    .join(DEFAULT_BRAIN_ID)
                    .join("vault")
                    .is_dir(),
                "vault dir must exist"
            );
            assert!(
                home.join("brains")
                    .join(DEFAULT_BRAIN_ID)
                    .join("brain.db")
                    .exists(),
                "brain.db must exist"
            );

            // Not just a file — a real brain. (Skipped only where the
            // vec0 extension isn't in the repo for this platform.)
            if let Ok(db) = open_brain(DEFAULT_BRAIN_ID) {
                let conn = db.lock();
                let n: i64 = conn
                    .query_row("SELECT COUNT(*) FROM engrams", [], |r| r.get(0))
                    .expect("the bootstrapped brain.db must have the schema applied");
                assert_eq!(n, 0, "a new brain starts empty");
            }

            // And the resolution path the whole API sits on must work.
            assert_eq!(
                crate::memory::read_ops::resolve_brain_id(None).ok(),
                Some(DEFAULT_BRAIN_ID.to_string()),
                "resolve_brain_id(None) is what every handler calls first"
            );
            let listed = crate::memory::read_ops::list_brains_with_stats()
                .expect("GET /api/brains must succeed");
            assert_eq!(listed.len(), 1, "GET /api/brains must not be empty");
            assert!(listed[0].is_active);
        });
    }

    /// An existing home is sacred: the registry is the user's brain list.
    #[test]
    fn existing_registry_is_left_byte_identical() {
        with_temp_home(|home| {
            let registry = home.join("brains.json");
            let original = "{\n  \"brains\": [ {\"id\": \"work\", \"name\": \"Work\"} ],\n  \"active\": \"work\"\n}\n";
            std::fs::write(&registry, original).unwrap();

            assert_eq!(
                ensure_default_brain(),
                None,
                "must not bootstrap over an existing registry"
            );
            assert_eq!(
                std::fs::read_to_string(&registry).unwrap(),
                original,
                "brains.json must be byte-identical"
            );
            assert!(
                !home.join("brains").join(DEFAULT_BRAIN_ID).exists(),
                "no stray default brain dir"
            );
        });
    }

    /// Backends restart. The second start must be a no-op, not a second
    /// brain and not a rewritten registry.
    #[test]
    fn repeat_calls_are_idempotent() {
        with_temp_home(|home| {
            assert!(ensure_default_brain().is_some());
            let after_first = std::fs::read_to_string(home.join("brains.json")).unwrap();

            assert_eq!(ensure_default_brain(), None, "second call is a no-op");
            assert_eq!(ensure_default_brain(), None, "third call is a no-op");

            assert_eq!(
                std::fs::read_to_string(home.join("brains.json")).unwrap(),
                after_first,
                "repeat starts must not rewrite brains.json"
            );
            assert_eq!(read_registry(home)["brains"].as_array().unwrap().len(), 1);
        });
    }

    /// Two backends racing to start (the MCP shim auto-start losing to the
    /// desktop app, say) must not corrupt or duplicate anything.
    #[test]
    fn concurrent_starts_produce_one_valid_registry() {
        with_temp_home(|home| {
            let winners: usize = std::thread::scope(|scope| {
                let handles: Vec<_> = (0..8)
                    .map(|_| scope.spawn(|| ensure_default_brain().is_some()))
                    .collect();
                handles
                    .into_iter()
                    .map(|h| h.join().expect("no thread may panic"))
                    .filter(|claimed| *claimed)
                    .count()
            });
            assert_eq!(winners, 1, "exactly one caller may claim the bootstrap");

            let reg = read_registry(home);
            assert_eq!(reg["active"].as_str(), Some(DEFAULT_BRAIN_ID));
            assert_eq!(
                reg["brains"].as_array().map(Vec::len),
                Some(1),
                "no duplicate brains: {reg}"
            );
        });
    }

    /// Pre-multi-brain layout: `~/.neurovault/vault/*.md` with no registry.
    /// Writing one would make `app::vault_dir()` prefer a new empty brain
    /// and the user's notes would disappear from the UI.
    #[test]
    fn legacy_single_brain_vault_is_not_hijacked() {
        with_temp_home(|home| {
            std::fs::create_dir_all(home.join("vault")).unwrap();
            std::fs::write(home.join("vault").join("note.md"), "# mine").unwrap();

            assert_eq!(
                ensure_default_brain(),
                None,
                "a legacy single-brain home must be left alone"
            );
            assert!(
                !home.join("brains.json").exists(),
                "no registry may be invented over a legacy vault"
            );
        });
    }

    /// Registry lost but brain data still on disk. Inventing an empty
    /// `main` would leave the real brains invisible in the picker, so we
    /// re-register what's there instead. A bare `vault/` counts — that's
    /// what the app's pre-registry fallback leaves behind.
    #[test]
    fn orphaned_brain_dirs_are_adopted_not_hidden() {
        with_temp_home(|home| {
            let with_db = home.join("brains").join("legacy-one");
            std::fs::create_dir_all(with_db.join("vault")).unwrap();
            std::fs::write(with_db.join("brain.db"), b"").unwrap();
            // The `app::vault_dir()` fallback shape: vault, no database.
            let vault_only = home.join("brains").join("default");
            std::fs::create_dir_all(vault_only.join("vault")).unwrap();
            std::fs::write(vault_only.join("vault").join("welcome.md"), "# hi").unwrap();

            assert_eq!(
                ensure_default_brain().as_deref(),
                Some("default"),
                "an existing brain must be adopted, not shadowed by `main`"
            );
            let reg = read_registry(home);
            assert_eq!(reg["active"].as_str(), Some("default"));
            let ids: Vec<&str> = reg["brains"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|b| b["id"].as_str())
                .collect();
            assert_eq!(
                ids,
                vec!["default", "legacy-one"],
                "every orphan is re-registered, and no `main` is invented"
            );
        });
    }
}
