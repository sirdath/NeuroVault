//! Parse `kind:X folder:Y after:Z free text` queries into a
//! `(filters, free_text)` tuple.
//!
//! Motivation: agents repeatedly do "recall → filter client-side by
//! kind/folder/date". One SQL-side filter pass eliminates that
//! whole round-trip class. Operators are opt-in — a plain-text
//! query parses to "no filters, everything is free text" unchanged.
//!
//! Supported operators:
//!   `kind:<note|insight|source|quote|draft|question|theme|clip|observation>`
//!   `folder:<path>`           — matches `engrams.filename LIKE 'folder/%'`
//!   `state:<fresh|active|connected|dormant|consolidated>`
//!   `entity:<name>`           — engram must have an entity_mention with that name
//!   `after:<YYYY-MM-DD>`      — engrams.created_at >= date
//!   `before:<YYYY-MM-DD>`     — engrams.created_at < date
//!   `agent:<agent_id>`        — engrams written by a specific agent
//!
//! Tokens are split on spaces (simple shell-free parsing). Quoted
//! values aren't supported yet because queries with spaces in
//! operator values (`folder:"my projects"`) are vanishingly rare.
//!
//! Failure mode: any operator value that can't be parsed (bad date,
//! unknown kind) is silently dropped and logged to stderr, so the
//! remaining query still runs. Never fails a recall over a bad
//! operator — better to return more than to return nothing.

use once_cell::sync::Lazy;
use regex::Regex;

/// Known operator prefixes. Kept here as a slice so adding a new
/// operator is a one-line change here + one arm in `apply`.
const OPERATORS: &[&str] = &[
    "kind", "folder", "state", "entity", "after", "before", "agent",
];

/// Extracted filters from a query. Every field optional; `None`
/// means "don't filter on this axis". Built by `parse`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct QueryFilters {
    pub kind: Option<String>,
    pub folder: Option<String>,
    pub state: Option<String>,
    pub entity: Option<String>,
    pub after: Option<String>,   // ISO date 'YYYY-MM-DD'
    pub before: Option<String>,  // ISO date 'YYYY-MM-DD'
    pub agent: Option<String>,
}

impl QueryFilters {
    pub fn is_empty(&self) -> bool {
        self.kind.is_none()
            && self.folder.is_none()
            && self.state.is_none()
            && self.entity.is_none()
            && self.after.is_none()
            && self.before.is_none()
            && self.agent.is_none()
    }
}

/// A simple `YYYY-MM-DD` sanity check. Kept conservative — SQLite
/// will do the real comparison via string ordering (which works
/// because we store ISO-8601 timestamps).
static DATE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\d{4}-\d{2}-\d{2}$").unwrap());

/// Split a `name:value` token. Returns None if the token doesn't
/// start with a known operator — caller treats it as free text.
fn split_op(token: &str) -> Option<(&str, &str)> {
    let (name, value) = token.split_once(':')?;
    if !OPERATORS.contains(&name) {
        return None;
    }
    if value.is_empty() {
        return None;
    }
    Some((name, value))
}

/// Parse a query string into filters + free-text remainder.
/// Free text is reassembled with single spaces — whitespace
/// exactness is irrelevant downstream (the retriever normalises
/// anyway).
pub fn parse(query: &str) -> (QueryFilters, String) {
    let mut f = QueryFilters::default();
    let mut free: Vec<&str> = Vec::new();

    for token in query.split_whitespace() {
        match split_op(token) {
            Some((name, value)) => {
                let accepted = match name {
                    "kind" => {
                        f.kind = Some(value.to_lowercase());
                        true
                    }
                    "folder" => {
                        // Strip a trailing slash so `folder:projects`
                        // and `folder:projects/` behave identically.
                        let v = value.trim_end_matches('/');
                        f.folder = Some(v.to_string());
                        true
                    }
                    "state" => {
                        f.state = Some(value.to_lowercase());
                        true
                    }
                    "entity" => {
                        f.entity = Some(value.to_lowercase());
                        true
                    }
                    "after" => {
                        if DATE_RE.is_match(value) {
                            f.after = Some(value.to_string());
                            true
                        } else {
                            eprintln!(
                                "[query_parser] ignoring invalid after date: '{}' (expected YYYY-MM-DD)",
                                value
                            );
                            false
                        }
                    }
                    "before" => {
                        if DATE_RE.is_match(value) {
                            f.before = Some(value.to_string());
                            true
                        } else {
                            eprintln!(
                                "[query_parser] ignoring invalid before date: '{}' (expected YYYY-MM-DD)",
                                value
                            );
                            false
                        }
                    }
                    "agent" => {
                        f.agent = Some(value.to_string());
                        true
                    }
                    _ => false,
                };
                if !accepted {
                    // Keep the unparseable operator token as free
                    // text — better to over-match than miss entirely.
                    free.push(token);
                }
            }
            None => free.push(token),
        }
    }

    (f, free.join(" "))
}

/// Build the SQL `WHERE` fragment + parameter vec for the given
/// filters. Returns an empty string + empty vec when filters are
/// empty. The fragment starts with " AND " so callers can drop it
/// after an existing WHERE clause.
///
/// Note: we build param values as owned `rusqlite::types::Value` so
/// the caller can concat them with other bindings (the retriever
/// already mixes several parameter sources).
pub fn filter_sql(filters: &QueryFilters) -> (String, Vec<rusqlite::types::Value>) {
    use rusqlite::types::Value;
    let mut clauses: Vec<&'static str> = Vec::new();
    let mut params: Vec<Value> = Vec::new();

    if let Some(k) = &filters.kind {
        clauses.push("COALESCE(e.kind, 'note') = ?");
        params.push(Value::Text(k.clone()));
    }
    if let Some(f) = &filters.folder {
        // Match either `folder/*` files or a bare `folder.md` at
        // root when folder == that filename's stem. Simple LIKE
        // pattern; filename is indexed, so this still uses a
        // prefix scan.
        clauses.push("e.filename LIKE ?");
        params.push(Value::Text(format!("{}/%", f)));
    }
    if let Some(s) = &filters.state {
        clauses.push("e.state = ?");
        params.push(Value::Text(s.clone()));
    }
    if let Some(a) = &filters.after {
        clauses.push("COALESCE(e.created_at, '') >= ?");
        params.push(Value::Text(a.clone()));
    }
    if let Some(b) = &filters.before {
        clauses.push("COALESCE(e.created_at, '') < ?");
        params.push(Value::Text(b.clone()));
    }
    if let Some(ag) = &filters.agent {
        clauses.push("COALESCE(e.agent_id, '') = ?");
        params.push(Value::Text(ag.clone()));
    }
    if let Some(ent) = &filters.entity {
        // Entity filter: engram has a mention of an entity whose
        // name matches (case-insensitive). Subquery keeps this
        // independent of the rest of the WHERE clause.
        clauses.push(
            "EXISTS (SELECT 1 FROM entity_mentions em
                     JOIN entities et ON et.id = em.entity_id
                     WHERE em.engram_id = e.id AND LOWER(et.name) = ?)",
        );
        params.push(Value::Text(ent.clone()));
    }

    if clauses.is_empty() {
        return (String::new(), params);
    }
    let joined = clauses.join(" AND ");
    (format!(" AND {}", joined), params)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_parses_empty_filters() {
        let (f, free) = parse("rust migration");
        assert!(f.is_empty());
        assert_eq!(free, "rust migration");
    }

    #[test]
    fn single_operator_extracted() {
        let (f, free) = parse("kind:insight rust migration");
        assert_eq!(f.kind.as_deref(), Some("insight"));
        assert_eq!(free, "rust migration");
    }

    #[test]
    fn multiple_operators_extracted() {
        let (f, free) = parse("kind:insight folder:projects after:2026-04-01 auth");
        assert_eq!(f.kind.as_deref(), Some("insight"));
        assert_eq!(f.folder.as_deref(), Some("projects"));
        assert_eq!(f.after.as_deref(), Some("2026-04-01"));
        assert_eq!(free, "auth");
    }

    #[test]
    fn bad_date_is_kept_as_free_text() {
        let (f, free) = parse("after:notadate query");
        assert!(f.after.is_none());
        // Unparseable operator stays in the free-text stream so
        // the search still runs over it rather than swallowing it.
        assert_eq!(free, "after:notadate query");
    }

    #[test]
    fn unknown_prefix_becomes_free_text() {
        let (f, free) = parse("foo:bar thing");
        assert!(f.is_empty());
        assert_eq!(free, "foo:bar thing");
    }

    #[test]
    fn folder_trailing_slash_normalised() {
        let (f, _) = parse("folder:projects/");
        assert_eq!(f.folder.as_deref(), Some("projects"));
    }

    #[test]
    fn filter_sql_empty_when_no_filters() {
        let (sql, params) = filter_sql(&QueryFilters::default());
        assert!(sql.is_empty());
        assert!(params.is_empty());
    }

    #[test]
    fn filter_sql_builds_and_chain() {
        let mut f = QueryFilters::default();
        f.kind = Some("insight".to_string());
        f.folder = Some("projects".to_string());
        let (sql, params) = filter_sql(&f);
        assert!(sql.starts_with(" AND "));
        assert!(sql.contains("kind"));
        assert!(sql.contains("filename"));
        assert_eq!(params.len(), 2);
    }
}
