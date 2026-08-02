//! Fact-supersession extraction (improvement #4) — pull *revised*
//! values out of notes so recall can answer "what's the CURRENT X?".
//!
//! WHY (real-user problem, structural — not bench-shape):
//! Users restate and revise facts over time ("my grocery budget is
//! £400" … months later … "bumped the grocery budget to £550"). Today
//! NeuroVault has only similarity recall: both notes match "what's my
//! grocery budget" and ranking between them rests on a recency tilt +
//! a title-Jaccard temporal backstop that misses any update whose
//! title differs. There is no representation of "£550 supersedes £400"
//! and no current-value primitive. This is the structural reason
//! knowledge-update / multi-session are the weakest categories.
//!
//! PRECEDENT: Letta/MemGPT, Mem0, MemPalace all do write-time
//! atomic-fact extraction + an explicit update/supersede step;
//! bitemporal / SCD-Type-2 "current row" modelling is standard data
//! engineering.
//!
//! DESIGN — CONSERVATIVE BY CONSTRUCTION:
//! A false fact (or a false supersede that demotes the only correct
//! answer) is strictly worse than a miss — past false-positive
//! temporal demotions cost −16pp on the bench. So this extracts ONLY
//! constructions with an explicit subject AND an explicit value joined
//! by a revision/assignment marker. Vague forms with no clean subject
//! ("switched from nvim to zed" — subject unknown) are deliberately
//! NOT extracted in v1; precision over recall.

use once_cell::sync::Lazy;
use regex::Regex;
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};

/// Max facts pulled from one note — a note that is itself a long
/// config list shouldn't spawn dozens of rows; recall it directly.
const MAX_PER_NOTE: usize = 8;

/// Subject/value length bounds (chars). Tight on purpose: a 60-char
/// "subject" is a sentence, not a subject — reject it.
const MAX_SUBJECT_CHARS: usize = 40;
const MAX_VALUE_CHARS: usize = 40;
const MIN_SUBJECT_CHARS: usize = 3;
const MIN_VALUE_CHARS: usize = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fact {
    pub subject: String,
    pub attribute: String,
    pub value: String,
}

/// Revision/assignment patterns. Each MUST bind an explicit subject and
/// an explicit value. Case-insensitive. Named groups `subj` / `val`.
///
/// Intentionally omitted (v1, precision-first): "switched/migrated
/// from A to B" (no clean subject token), bare "X is Y" without a
/// revision cue (would fire on every descriptive sentence). These are
/// documented omissions, not oversights.
static PATTERNS: Lazy<Vec<Regex>> = Lazy::new(|| {
    // The value group is NON-greedy and ends at a boundary — a
    // connective that starts trailing prose ("£550 *after* the raise",
    // "550 pounds *going* forward"), or sentence end. Without this the
    // greedy class swallowed the rest of the clause. Sentences are
    // pre-split on . ! ? ; \n so those never appear mid-value.
    const VAL: &str = r"(?P<val>[a-z0-9£$€][a-z0-9£$€.%/ \-]{0,38}?)(?:\s+(?:after|this|next|going|starting|effective|from|for|since|because|so|but|and|then|now|as)\b|\s*$)";
    [
        // "my/our <subj> is (now|currently) <val>"  — the "now"/copula
        // is the revision cue; require it so plain description doesn't
        // match.
        format!(r"(?:my|our)\s+(?P<subj>[a-z0-9][a-z0-9 \-]{{2,39}}?)\s+(?:is|are|=)\s+(?:now|currently)\s+{VAL}"),
        // "(bumped|raised|lowered|changed|set|moved|increased|decreased|
        //   updated|switched) [my|our|the] <subj> to <val>"
        format!(r"\b(?:bumped|raised|lowered|changed|set|moved|increased|decreased|updated|switched)\s+(?:my\s+|our\s+|the\s+)?(?P<subj>[a-z0-9][a-z0-9 \-]{{2,39}}?)\s+to\s+{VAL}"),
        // "update: <subj> = <val>"  /  "update: <subj> is <val>"
        format!(r"\bupdate:?\s+(?P<subj>[a-z0-9][a-z0-9 \-]{{2,39}}?)\s*(?:=|:|\bis\b)\s*{VAL}"),
    ]
    .iter()
    .map(|p| Regex::new(&format!("(?i){p}")).expect("static fact regex"))
    .collect()
});

/// Leading words stripped from a captured subject so "the grocery
/// budget" / "grocery budget" normalise to the same key.
static SUBJECT_LEAD: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^(?i)(?:the|my|our|a|an)\s+").unwrap());

/// Normalise a subject/value: lowercase, trim, collapse internal
/// whitespace, strip a leading article. Deterministic so the same
/// real-world fact always maps to the same `(subject, value)` key.
fn normalise(s: &str) -> String {
    let lowered = s.trim().to_lowercase();
    let stripped = SUBJECT_LEAD.replace(&lowered, "");
    stripped.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn split_sentences(content: &str) -> Vec<String> {
    content
        .replace(['\n', '\r'], ". ")
        .split(['.', '!', '?', ';'])
        .map(|s| {
            s.trim()
                .trim_start_matches(|c: char| {
                    c == '#' || c == '*' || c == '-' || c == '>' || c == '`' || c == ' '
                })
                .trim()
                .to_string()
        })
        .filter(|s| !s.is_empty())
        .collect()
}

/// Extract revised facts from note content. Deduped, length-bounded,
/// capped. The newest-ingested wins at write time (caller's concern);
/// this is purely the per-note extractor.
pub fn extract_facts(content: &str) -> Vec<Fact> {
    let mut out: Vec<Fact> = Vec::new();
    let mut seen: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    for sentence in split_sentences(content) {
        for re in PATTERNS.iter() {
            let Some(caps) = re.captures(&sentence) else {
                continue;
            };
            let (Some(subj_m), Some(val_m)) = (caps.name("subj"), caps.name("val")) else {
                continue;
            };
            let subject = normalise(subj_m.as_str());
            // Trim a trailing connective the greedy value class may
            // have eaten ("£550 and" → "£550").
            let value = normalise(val_m.as_str())
                .trim_end_matches([',', ':', '/'])
                .trim()
                .to_string();
            if subject.len() < MIN_SUBJECT_CHARS
                || subject.len() > MAX_SUBJECT_CHARS
                || value.len() < MIN_VALUE_CHARS
                || value.len() > MAX_VALUE_CHARS
            {
                continue;
            }
            // One fact per (subject) per note — a note that says "the
            // budget is now £550 … the budget is now £550" shouldn't
            // double-insert; the newest *note* supersedes, not
            // intra-note repeats.
            if seen.insert((subject.clone(), value.clone())) {
                out.push(Fact {
                    subject,
                    attribute: String::new(),
                    value,
                });
                if out.len() >= MAX_PER_NOTE {
                    return out;
                }
            }
        }
    }
    out
}

/// Deterministic fact id: `sha256(subject \0 attribute \0 value)[:16]`.
///
/// Value-hashed on purpose — the id IS the identity of the statement,
/// so re-stating the same `(subject, attribute, value)` always lands on
/// the same row instead of accumulating duplicates. It also means the
/// `id` PRIMARY KEY and the `UNIQUE(subject, attribute, value)`
/// constraint on `facts` can never disagree about which row is which.
pub fn fact_id(subject: &str, attribute: &str, value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{subject}\u{0}{attribute}\u{0}{value}").as_bytes());
    format!("{:x}", hasher.finalize())[..16].to_string()
}

/// Record `(subject, attribute) = value` as the CURRENT fact, superseding
/// whatever different value was live before. Returns the fact id.
///
/// Single implementation on purpose: auto-ingest (`ingest::write_facts`)
/// and the `POST /api/facts` handler are the same logical operation, and
/// when they were written separately they drifted into two *different*
/// wrong answers for the restatement case (A → B → A): ingest skipped the
/// third statement on "id already present" and left A superseded forever
/// (recall kept answering B); the handler superseded B and then no-op'd on
/// `INSERT OR IGNORE`, leaving the subject with zero live rows.
///
/// RESURRECT SEMANTICS — the newest STATEMENT wins, not the newest row
/// insert. Because the id is value-hashed, restating an earlier value
/// lands back on that original row; the row is then reset to current
/// (`superseded_by = NULL`) rather than being treated as already-known.
/// A fact the user re-asserts is a fact they mean *now*, whatever its
/// row's history — so A → B → A ends with exactly one live row: A.
pub fn upsert_fact(
    conn: &Connection,
    subject: &str,
    attribute: &str,
    value: &str,
    source_engram: &str,
) -> rusqlite::Result<String> {
    let id = fact_id(subject, attribute, value);

    // Point every live row holding a DIFFERENT value at this statement.
    // The `value != ?4` guard is what keeps a re-statement of the current
    // value from superseding itself (its row is about to be the winner).
    conn.execute(
        "UPDATE facts SET superseded_by = ?1 \
         WHERE subject = ?2 AND attribute = ?3 AND value != ?4 AND superseded_by IS NULL",
        params![id, subject, attribute, value],
    )?;
    // Insert-or-resurrect. ON CONFLICT targets the `id` PRIMARY KEY; since
    // the id is the hash of the triple it fires on exactly the same rows
    // `UNIQUE(subject, attribute, value)` would, so the two constraints
    // cannot disagree. Clearing `superseded_by` is the resurrect.
    conn.execute(
        "INSERT INTO facts (id, subject, attribute, value, source_engram, superseded_by) \
         VALUES (?1, ?2, ?3, ?4, ?5, NULL) \
         ON CONFLICT(id) DO UPDATE SET \
           superseded_by = NULL, source_engram = excluded.source_engram",
        params![id, subject, attribute, value, source_engram],
    )?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real `facts` DDL from schema.sql (plus the `engrams` parent it
    /// references), so these tests exercise the actual PK / UNIQUE /
    /// foreign-key constraints rather than a permissive stand-in.
    fn fact_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE engrams (id TEXT PRIMARY KEY);
             INSERT INTO engrams VALUES ('e1'),('e2'),('e3');
             CREATE TABLE facts (
                 id            TEXT PRIMARY KEY,
                 subject       TEXT NOT NULL,
                 attribute     TEXT NOT NULL DEFAULT '',
                 value         TEXT NOT NULL,
                 source_engram TEXT NOT NULL REFERENCES engrams(id) ON DELETE CASCADE,
                 created_at    TEXT DEFAULT (datetime('now')),
                 superseded_by TEXT,
                 UNIQUE(subject, attribute, value)
             );",
        )
        .unwrap();
        conn
    }

    /// Every live (`superseded_by IS NULL`) value for a subject.
    fn live_values(conn: &Connection, subject: &str) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT value FROM facts WHERE subject = ?1 AND superseded_by IS NULL")
            .unwrap();
        let rows = stmt
            .query_map(params![subject], |r| r.get::<_, String>(0))
            .unwrap();
        rows.map(|r| r.unwrap()).collect()
    }

    fn superseded_by(conn: &Connection, id: &str) -> Option<String> {
        conn.query_row(
            "SELECT superseded_by FROM facts WHERE id = ?1",
            params![id],
            |r| r.get::<_, Option<String>>(0),
        )
        .unwrap()
    }

    #[test]
    fn newer_value_supersedes_older() {
        let conn = fact_db();
        let a = upsert_fact(&conn, "deploy target", "", "staging", "e1").unwrap();
        let b = upsert_fact(&conn, "deploy target", "", "production", "e2").unwrap();

        assert_eq!(live_values(&conn, "deploy target"), vec!["production"]);
        assert_eq!(superseded_by(&conn, &a).as_deref(), Some(b.as_str()));
        assert_eq!(superseded_by(&conn, &b), None);
    }

    #[test]
    fn restating_an_earlier_value_makes_it_current_again() {
        // A → B → A. The newest STATEMENT wins, so after the third call
        // the answer to "what's the deploy target?" is staging again.
        let conn = fact_db();
        let a = upsert_fact(&conn, "deploy target", "", "staging", "e1").unwrap();
        let b = upsert_fact(&conn, "deploy target", "", "production", "e2").unwrap();
        let a2 = upsert_fact(&conn, "deploy target", "", "staging", "e3").unwrap();

        // Restating reuses the original row (value-hashed id).
        assert_eq!(a, a2);
        assert_eq!(live_values(&conn, "deploy target"), vec!["staging"]);
        assert_eq!(superseded_by(&conn, &a), None);
        assert_eq!(superseded_by(&conn, &b).as_deref(), Some(a.as_str()));
    }

    #[test]
    fn restating_updates_the_source_engram() {
        // The resurrected row should point at the note that most recently
        // asserted it, not the note from the first time around.
        let conn = fact_db();
        upsert_fact(&conn, "deploy target", "", "staging", "e1").unwrap();
        upsert_fact(&conn, "deploy target", "", "production", "e2").unwrap();
        let a = upsert_fact(&conn, "deploy target", "", "staging", "e3").unwrap();

        let src: String = conn
            .query_row(
                "SELECT source_engram FROM facts WHERE id = ?1",
                params![a],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(src, "e3");
    }

    #[test]
    fn same_value_twice_is_idempotent() {
        let conn = fact_db();
        let a = upsert_fact(&conn, "grocery budget", "", "£550", "e1").unwrap();
        let a2 = upsert_fact(&conn, "grocery budget", "", "£550", "e2").unwrap();

        assert_eq!(a, a2, "id must be stable for the same statement");
        assert_eq!(live_values(&conn, "grocery budget"), vec!["£550"]);
        // No self-supersede: a fact must never point at itself.
        assert_eq!(superseded_by(&conn, &a), None);
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM facts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1);
    }

    #[test]
    fn attribute_scopes_supersession() {
        // Different attributes on the same subject are independent facts;
        // writing one must not supersede the other.
        let conn = fact_db();
        upsert_fact(&conn, "server", "region", "eu-west", "e1").unwrap();
        upsert_fact(&conn, "server", "size", "large", "e2").unwrap();

        let mut live = live_values(&conn, "server");
        live.sort();
        assert_eq!(live, vec!["eu-west", "large"]);
    }

    #[test]
    fn catches_is_now_revision() {
        let f = extract_facts("Quick note: my grocery budget is now £550 after the raise.");
        assert_eq!(f.len(), 1, "got {f:?}");
        assert_eq!(f[0].subject, "grocery budget");
        assert_eq!(f[0].value, "£550");
    }

    #[test]
    fn catches_bumped_to_revision_with_article() {
        let f = extract_facts("I bumped the grocery budget to £550 this month.");
        assert_eq!(f.len(), 1, "got {f:?}");
        assert_eq!(f[0].subject, "grocery budget");
        assert_eq!(f[0].value, "£550");
    }

    #[test]
    fn catches_update_colon_form() {
        let f = extract_facts("Update: deploy target = staging");
        assert_eq!(f.len(), 1, "got {f:?}");
        assert_eq!(f[0].subject, "deploy target");
        assert_eq!(f[0].value, "staging");
    }

    #[test]
    fn ignores_plain_description_without_revision_cue() {
        // "is" alone is NOT a revision cue (needs now/currently); a bare
        // descriptive sentence must not become a fact.
        let f = extract_facts("The grocery budget is tight this quarter and groceries are pricey.");
        assert!(f.is_empty(), "false positive: {f:?}");
    }

    #[test]
    fn ignores_one_off_spend_mention() {
        let f = extract_facts("I spent £550 on groceries and then went home.");
        assert!(f.is_empty(), "false positive: {f:?}");
    }

    #[test]
    fn normalisation_makes_article_variants_one_key() {
        let a = &extract_facts("bumped the deploy target to staging")[0];
        let b = &extract_facts("update: deploy target = staging")[0];
        assert_eq!(a.subject, b.subject);
        assert_eq!(a.value, b.value);
    }

    #[test]
    fn caps_pathological_notes() {
        let mut note = String::new();
        for i in 0..30 {
            note.push_str(&format!("bumped metric{i} to {i}. "));
        }
        let f = extract_facts(&note);
        assert!(f.len() <= MAX_PER_NOTE, "got {}", f.len());
    }
}
