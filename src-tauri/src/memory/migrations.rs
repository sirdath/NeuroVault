//! Idempotent schema migrations for `brain.db`.
//!
//! Each function mirrors one `_migrate_*` method from
//! `server/neurovault_server/database.py` and follows the same pattern:
//!   1. Check the target table exists (no-op on fresh DBs — the
//!      subsequent schema script will create it with the new column).
//!   2. Check the target column already exists (no-op on already-migrated
//!      DBs).
//!   3. `ALTER TABLE ... ADD COLUMN` the new column.
//!   4. For the kind migration only: backfill legacy rows whose
//!      filename reveals their kind.
//!
//! Running any migration twice is a no-op. Running them against a DB
//! that Python has already migrated is also a no-op — the column-exists
//! check is the source of truth, not a migrations bookkeeping table.
//! This lets Rust and Python coexist during the migration window
//! without stepping on each other.
//!
//! Order must match `Database._init_schema` in the Python file so a
//! brain.db that Python partially migrated between boots doesn't end
//! up in a half-migrated state when Rust first touches it.

use rusqlite::Connection;

use super::types::Result;

/// Run every migration in the order Python runs them. Called from
/// `db::open` right after the sqlite-vec extension loads and before the
/// schema script so the `CREATE TABLE IF NOT EXISTS` statements don't
/// conflict with renamed columns on an already-migrated DB.
pub fn run_all(conn: &Connection) -> Result<()> {
    migrate_add_kind_column(conn)?;
    migrate_add_removed_at(conn)?;
    migrate_add_query_embedding(conn)?;
    migrate_add_review_comment(conn)?;
    migrate_add_agent_id(conn)?;
    migrate_add_summaries(conn)?;
    migrate_add_expired_at(conn)?;
    Ok(())
}

/// Returns `true` if the given table exists in `sqlite_master`.
fn table_exists(conn: &Connection, name: &str) -> Result<bool> {
    let exists: Option<String> = conn
        .query_row(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?1",
            [name],
            |r| r.get(0),
        )
        .ok();
    Ok(exists.is_some())
}

/// Returns the list of column names for a table via `PRAGMA table_info`.
/// `PRAGMA table_info` returns rows of (cid, name, type, notnull,
/// dflt_value, pk); we only need `name`.
fn column_names(conn: &Connection, table: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", table))?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(1))?;
    let mut cols = Vec::new();
    for row in rows {
        cols.push(row?);
    }
    Ok(cols)
}

/// Returns true if `table` has a column named `column`.
fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    Ok(column_names(conn, table)?.iter().any(|c| c == column))
}

/// Add `kind` to `engrams` and backfill existing rows by filename prefix.
/// Ported from `_migrate_add_kind_column`.
pub fn migrate_add_kind_column(conn: &Connection) -> Result<()> {
    if !table_exists(conn, "engrams")? {
        return Ok(());
    }
    if column_exists(conn, "engrams", "kind")? {
        return Ok(());
    }
    conn.execute(
        "ALTER TABLE engrams ADD COLUMN kind TEXT DEFAULT 'note'",
        [],
    )?;
    // Auto-classify existing rows by filename prefix — same backfill
    // statements Python runs so a brain.db migrated by either runtime
    // ends up with identical kind values.
    conn.execute(
        "UPDATE engrams SET kind = 'source' WHERE filename LIKE 'source-%'",
        [],
    )?;
    conn.execute(
        "UPDATE engrams SET kind = 'quote' WHERE filename LIKE 'quote-%'",
        [],
    )?;
    conn.execute(
        "UPDATE engrams SET kind = 'draft' WHERE filename LIKE 'draft-%'",
        [],
    )?;
    Ok(())
}

/// Add `removed_at` to `variables`. Ported from `_migrate_add_removed_at`.
pub fn migrate_add_removed_at(conn: &Connection) -> Result<()> {
    if !table_exists(conn, "variables")? {
        return Ok(());
    }
    if column_exists(conn, "variables", "removed_at")? {
        return Ok(());
    }
    conn.execute("ALTER TABLE variables ADD COLUMN removed_at TEXT", [])?;
    Ok(())
}

/// Add `query_embedding` BLOB to `query_affinity` (Stage 4 v2).
/// Ported from `_migrate_add_query_embedding`.
pub fn migrate_add_query_embedding(conn: &Connection) -> Result<()> {
    if !table_exists(conn, "query_affinity")? {
        return Ok(());
    }
    if column_exists(conn, "query_affinity", "query_embedding")? {
        return Ok(());
    }
    conn.execute(
        "ALTER TABLE query_affinity ADD COLUMN query_embedding BLOB",
        [],
    )?;
    Ok(())
}

/// Add `review_comment` to `compilations`. Ported from
/// `_migrate_add_review_comment`.
pub fn migrate_add_review_comment(conn: &Connection) -> Result<()> {
    if !table_exists(conn, "compilations")? {
        return Ok(());
    }
    if column_exists(conn, "compilations", "review_comment")? {
        return Ok(());
    }
    conn.execute(
        "ALTER TABLE compilations ADD COLUMN review_comment TEXT",
        [],
    )?;
    Ok(())
}

/// Add `agent_id` to `engrams` for multi-agent scoping. Ported from
/// `_migrate_add_agent_id`.
pub fn migrate_add_agent_id(conn: &Connection) -> Result<()> {
    if !table_exists(conn, "engrams")? {
        return Ok(());
    }
    if column_exists(conn, "engrams", "agent_id")? {
        return Ok(());
    }
    conn.execute("ALTER TABLE engrams ADD COLUMN agent_id TEXT", [])?;
    Ok(())
}

/// Add tiered-summary columns (`summary_l0`, `summary_l1`) to `engrams`.
/// Ported from `_migrate_add_summaries`.
pub fn migrate_add_summaries(conn: &Connection) -> Result<()> {
    if !table_exists(conn, "engrams")? {
        return Ok(());
    }
    let cols = column_names(conn, "engrams")?;
    if !cols.iter().any(|c| c == "summary_l0") {
        conn.execute("ALTER TABLE engrams ADD COLUMN summary_l0 TEXT", [])?;
    }
    if !cols.iter().any(|c| c == "summary_l1") {
        conn.execute("ALTER TABLE engrams ADD COLUMN summary_l1 TEXT", [])?;
    }
    Ok(())
}

/// Add `expired_at` to `temporal_facts`. Ported from
/// `_migrate_add_expired_at`.
pub fn migrate_add_expired_at(conn: &Connection) -> Result<()> {
    if !table_exists(conn, "temporal_facts")? {
        return Ok(());
    }
    if column_exists(conn, "temporal_facts", "expired_at")? {
        return Ok(());
    }
    conn.execute(
        "ALTER TABLE temporal_facts ADD COLUMN expired_at TEXT",
        [],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_conn() -> Connection {
        Connection::open_in_memory().unwrap()
    }

    #[test]
    fn run_all_is_noop_on_empty_db() {
        let conn = fresh_conn();
        run_all(&conn).unwrap();
    }

    #[test]
    fn add_kind_column_backfills_by_prefix() {
        let conn = fresh_conn();
        // Build a minimal legacy engrams table (pre-kind-migration shape).
        conn.execute(
            "CREATE TABLE engrams (id TEXT PRIMARY KEY, filename TEXT NOT NULL, \
             title TEXT, content TEXT, content_hash TEXT)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO engrams VALUES ('a','source-foo.md','foo','x','h')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO engrams VALUES ('b','quote-bar.md','bar','x','h')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO engrams VALUES ('c','plain.md','baz','x','h')",
            [],
        )
        .unwrap();

        migrate_add_kind_column(&conn).unwrap();

        let kind_a: String = conn
            .query_row("SELECT kind FROM engrams WHERE id='a'", [], |r| r.get(0))
            .unwrap();
        let kind_b: String = conn
            .query_row("SELECT kind FROM engrams WHERE id='b'", [], |r| r.get(0))
            .unwrap();
        let kind_c: String = conn
            .query_row("SELECT kind FROM engrams WHERE id='c'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kind_a, "source");
        assert_eq!(kind_b, "quote");
        assert_eq!(kind_c, "note");
    }

    #[test]
    fn add_summaries_is_idempotent() {
        let conn = fresh_conn();
        conn.execute(
            "CREATE TABLE engrams (id TEXT PRIMARY KEY, filename TEXT, title TEXT, \
             content TEXT, content_hash TEXT)",
            [],
        )
        .unwrap();
        migrate_add_summaries(&conn).unwrap();
        // Second call must not raise "duplicate column name".
        migrate_add_summaries(&conn).unwrap();
        let cols = column_names(&conn, "engrams").unwrap();
        assert!(cols.iter().any(|c| c == "summary_l0"));
        assert!(cols.iter().any(|c| c == "summary_l1"));
    }
}
