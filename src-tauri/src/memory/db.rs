//! Connection lifecycle for per-brain `brain.db` files.
//!
//! Python's `Database` class owns a single `sqlite3.Connection` with
//! `check_same_thread=False` — it relies on SQLite's internal mutex for
//! serialisation. Rust takes the same approach but expresses the
//! invariant in the type system: a `BrainDb` wraps one `Connection`
//! behind a `parking_lot::Mutex`. Callers take a lock, query, and drop
//! it; the short critical sections match how SQLite already serialises
//! writes under the hood.
//!
//! **WAL coexistence with Python.** Python opens the same file in WAL
//! mode (`journal_mode=WAL`). Rust mirrors every startup PRAGMA:
//!   - `journal_mode=WAL` — enables concurrent readers while a writer
//!     is mid-transaction.
//!   - `foreign_keys=ON` — Python has it on; without the same pragma,
//!     Rust's writes would skip the cascade-delete behaviour the
//!     schema assumes.
//!   - `busy_timeout=5000` — covers the ~200 ms windows where Python's
//!     background jobs hold a write lock. Without it Rust readers hit
//!     `SQLITE_BUSY` intermittently during Python's ingest batches.
//!
//! **Singleton cache.** `open(brain_id)` is cached in a
//! `OnceCell<RwLock<HashMap<_, Arc<BrainDb>>>>` so switching brains is
//! cheap and we don't leak file handles. `close_brain(id)` drops the
//! cached handle explicitly for tests + brain-switch logic.

use std::collections::HashMap;
#[cfg(test)]
use std::path::Path;
use std::sync::Arc;

use once_cell::sync::OnceCell;
use parking_lot::{Mutex, MutexGuard, RwLock};
use rusqlite::Connection;

use super::paths::{brain_dir, db_path};
use super::types::Result;
use super::{migrations, sqlite_vec};

/// Dimension of the embedding vectors we store in `vec_chunks`. Must
/// match `config.py::EMBEDDING_DIM`. Hard-coded here rather than read
/// from env — if this changes, both runtimes need to agree at compile
/// time on the shape of every stored vector.
pub const EMBEDDING_DIM: usize = 384;

/// Embedded schema, included at compile time. `include_str!` pulls the
/// file as a `&'static str` so we can pass it to `execute_batch`
/// without opening the file at runtime — matters for the packaged exe
/// where the schema source isn't shipped separately.
const SCHEMA_SQL: &str = include_str!("schema.sql");

/// Wrapper around a single per-brain SQLite connection. Clone-cheap
/// because the inner `Arc<Mutex<_>>` is reference-counted.
pub struct BrainDb {
    brain_id: String,
    conn: Mutex<Connection>,
}

impl BrainDb {
    /// Return the brain id this handle is bound to. Used by the HTTP
    /// layer (Phase 6) to tag responses with the active brain.
    pub fn brain_id(&self) -> &str {
        &self.brain_id
    }

    /// Acquire an exclusive lock on the underlying connection. Blocks
    /// until the lock is free; `parking_lot::Mutex` is a tiny cmpxchg
    /// loop for uncontended locks so the common case is effectively
    /// free. Callers should keep the guard short — holding it through
    /// a long read delays every other query for the same brain.
    pub fn lock(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock()
    }
}

/// Process-wide cache of open `BrainDb` handles keyed by brain id.
/// `RwLock` so hot-path reads (`open_brain` on the active brain) don't
/// block each other. `OnceCell` so initialisation is lazy — the cache
/// allocates on first access, not at crate load.
fn cache() -> &'static RwLock<HashMap<String, Arc<BrainDb>>> {
    static CACHE: OnceCell<RwLock<HashMap<String, Arc<BrainDb>>>> = OnceCell::new();
    CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Open (or return cached) `brain.db` for the given brain id. Creates
/// the brain directory and initialises the schema on first open.
///
/// Returns an `Arc<BrainDb>` because the cache also holds one — the
/// caller is free to hold onto their clone across an await or thread
/// boundary without forcing the cache to drop its own.
pub fn open_brain(brain_id: &str) -> Result<Arc<BrainDb>> {
    if let Some(existing) = cache().read().get(brain_id).cloned() {
        return Ok(existing);
    }

    let mut map = cache().write();
    // Double-check after taking the write lock — a concurrent caller
    // may have initialised it between our read-lock release and
    // write-lock acquire.
    if let Some(existing) = map.get(brain_id).cloned() {
        return Ok(existing);
    }

    let handle = Arc::new(open_new(brain_id)?);
    map.insert(brain_id.to_string(), handle.clone());
    Ok(handle)
}

/// Drop the cached handle for `brain_id`. Next `open_brain` reopens
/// the file. Used by brain-switching logic and unit tests.
pub fn close_brain(brain_id: &str) {
    cache().write().remove(brain_id);
}

/// Drop every cached handle. Tests + graceful-shutdown only.
pub fn close_all() {
    cache().write().clear();
}

/// Core open routine: create the brain dir, open the SQLite file, set
/// pragmas, load sqlite-vec, run migrations, apply the schema script,
/// create the vec0 virtual table if it's absent. Not cached — callers
/// go through `open_brain` which adds the cache layer.
fn open_new(brain_id: &str) -> Result<BrainDb> {
    let dir = brain_dir(brain_id);
    if !dir.exists() {
        std::fs::create_dir_all(&dir)?;
    }

    let path = db_path(brain_id);
    let conn = Connection::open(&path)?;
    apply_startup_pragmas(&conn)?;
    sqlite_vec::load(&conn)?;
    migrations::run_all(&conn)?;
    conn.execute_batch(SCHEMA_SQL)?;
    ensure_vec_chunks(&conn)?;

    Ok(BrainDb {
        brain_id: brain_id.to_string(),
        conn: Mutex::new(conn),
    })
}

/// Open the pragmas Python's `Database.__init__` sets PLUS the
/// read-heavy tuning levers from phiresky's SQLite benchmark. Each
/// one is safe under WAL journal mode (which we enforce below).
///
/// Why each pragma matters for NeuroVault's workload:
///
///   journal_mode=WAL     — concurrent readers while a writer is
///                          mid-transaction. Existing setting.
///   foreign_keys=ON      — cascade deletes on engrams → chunks.
///                          Existing setting.
///   busy_timeout=5000    — smooths over brief write-lock windows.
///                          Existing setting.
///   synchronous=NORMAL   — safe under WAL: skip fsync on every
///                          commit, only at WAL checkpoint time.
///                          ~2× write throughput; crash-safety
///                          unchanged (WAL is append-only).
///   cache_size=-65536    — 64 MiB page cache per connection
///                          (negative = KiB). Default is ~2 MiB;
///                          on a ~30 MiB brain.db this means the
///                          whole working set stays RAM-resident
///                          between queries. Biggest single lever
///                          for read-heavy workloads.
///   mmap_size=268435456  — 256 MiB memory-mapped region. SQLite
///                          reads through the mmap rather than
///                          read() syscalls, which removes kernel
///                          round-trips on hot SELECTs. Virtual
///                          memory only; doesn't consume RSS until
///                          pages are actually touched.
///   temp_store=MEMORY    — sort/group temp tables go to RAM
///                          instead of disk. Negligible for our
///                          queries but free.
///   wal_autocheckpoint   — 1000 pages before auto-checkpoint.
///                          Default is 1000, set explicitly for
///                          clarity. Keeps WAL from growing
///                          unbounded under bursty writes.
fn apply_startup_pragmas(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode=WAL; \
         PRAGMA foreign_keys=ON; \
         PRAGMA busy_timeout=5000; \
         PRAGMA synchronous=NORMAL; \
         PRAGMA cache_size=-65536; \
         PRAGMA mmap_size=268435456; \
         PRAGMA temp_store=MEMORY; \
         PRAGMA wal_autocheckpoint=1000;",
    )?;
    // rusqlite's prepared statement cache — reuses the parsed SQL
    // across repeat calls (every `nv_recall` hits the same ~10
    // queries). Capacity 64 comfortably covers the ~30 distinct
    // statements in hot paths.
    conn.set_prepared_statement_cache_capacity(64);
    Ok(())
}

/// Create the `vec_chunks` virtual table if it doesn't exist yet.
/// Separate from `SCHEMA_SQL` because virtual tables can't use
/// `CREATE VIRTUAL TABLE IF NOT EXISTS` with the same portability —
/// we emulate it with the same `sqlite_master` probe Python does.
fn ensure_vec_chunks(conn: &Connection) -> Result<()> {
    let exists: Option<String> = conn
        .query_row(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='vec_chunks'",
            [],
            |r| r.get(0),
        )
        .ok();
    if exists.is_some() {
        return Ok(());
    }
    let stmt = format!(
        "CREATE VIRTUAL TABLE vec_chunks USING vec0(chunk_id TEXT PRIMARY KEY, embedding float[{}])",
        EMBEDDING_DIM,
    );
    conn.execute(&stmt, [])?;
    Ok(())
}

/// Report the number of engram rows in the given brain — cheap health
/// check used by unit tests and the `nv_brain_stats` Tauri command in
/// Phase 4.
pub fn engram_count(db: &BrainDb) -> Result<i64> {
    let conn = db.lock();
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM engrams", [], |r| r.get(0))?;
    Ok(n)
}

/// Convenience wrapper for the common "open a specific file path"
/// pattern used in tests. Production code goes through `open_brain`.
#[cfg(test)]
pub fn open_file(path: &Path) -> Result<BrainDb> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(path)?;
    apply_startup_pragmas(&conn)?;
    // Tests rarely have sqlite-vec installed; skip the extension so
    // schema/migration tests run without the binary. `ensure_vec_chunks`
    // will still fail, so tests that need vec0 call `open_brain`
    // against a temp `NEUROVAULT_HOME` with the extension in place.
    migrations::run_all(&conn)?;
    conn.execute_batch(SCHEMA_SQL)?;
    Ok(BrainDb {
        brain_id: "test".to_string(),
        conn: Mutex::new(conn),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_sql_creates_expected_tables() {
        let conn = Connection::open_in_memory().unwrap();
        apply_startup_pragmas(&conn).unwrap();
        migrations::run_all(&conn).unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();

        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        for required in [
            "engrams",
            "drafts",
            "draft_sections",
            "chunks",
            "entities",
            "entity_mentions",
            "engram_links",
            "variables",
            "variable_renames",
            "function_calls",
            "variable_references",
            "memory_types",
            "temporal_facts",
            "working_memory",
            "core_memory_blocks",
            "episodic_facts",
            "edge_activity",
            "themes",
            "theme_members",
            "query_affinity",
            "retrieval_feedback",
            "contradictions",
            "compilations",
        ] {
            assert!(
                tables.iter().any(|t| t == required),
                "missing table {} — found {:?}",
                required,
                tables
            );
        }
    }

    #[test]
    fn running_schema_twice_is_noop() {
        let conn = Connection::open_in_memory().unwrap();
        apply_startup_pragmas(&conn).unwrap();
        migrations::run_all(&conn).unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();
        // Second run must not raise — every statement is IF NOT EXISTS.
        conn.execute_batch(SCHEMA_SQL).unwrap();
    }

    #[test]
    fn engrams_table_has_all_migrated_columns() {
        let conn = Connection::open_in_memory().unwrap();
        apply_startup_pragmas(&conn).unwrap();
        migrations::run_all(&conn).unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();

        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(engrams)")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        for required in [
            "id",
            "filename",
            "title",
            "content",
            "content_hash",
            "summary",
            "summary_l0",
            "summary_l1",
            "tags",
            "kind",
            "state",
            "strength",
            "access_count",
            "agent_id",
            "created_at",
            "updated_at",
            "accessed_at",
        ] {
            assert!(
                cols.iter().any(|c| c == required),
                "missing column {} — found {:?}",
                required,
                cols,
            );
        }
    }
}

