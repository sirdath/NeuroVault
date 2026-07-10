//! The Event Journal — NeuroVault's episodic memory substrate.
//!
//! An append-only, immutable record of WHAT HAPPENED: notes created
//! and edited (with before/after evidence), tasks transitioning,
//! rules captured, working state moving, sessions starting, context
//! injected. Typed memories are DERIVED state; journal events are the
//! historical evidence from which they can be rebuilt — and the
//! authoritative source for temporal_diff, consolidation, feedback,
//! and multi-agent continuity (adaptive-memory spec, V1c-2 direction
//! set by Dath 2026-07-10: `updated_at` cannot tell you what changed,
//! the previous value, who changed it, or whether it was meaningful).
//!
//! Design rules:
//! - IMMUTABLE. Events are never edited or deleted; corrections are
//!   new events. Monthly segment files (`events-YYYY-MM.jsonl`) bound
//!   read cost without ever discarding history.
//! - HONEST. Emitters record only what they know: an ingest that
//!   found `content_hash` unchanged emits NOTHING (an index refresh
//!   is not an experience). `before`/`after` are present only when
//!   the emitter truly had both.
//! - CHEAP + FAIL-SOFT. One serialized line per event, atomic append.
//!   Journal failure must never fail the user's operation — callers
//!   log and continue — but failures are eprintln'd loudly.

use std::fs;
use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use super::types::MemoryError;

type Result<T> = std::result::Result<T, MemoryError>;

/// One experience. Field names follow the adaptive-memory spec.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Event {
    #[serde(default)]
    pub event_id: String,
    #[serde(default)]
    pub ts: String,
    #[serde(default)]
    pub brain_id: String,
    /// Vault-folder room, when the emitter knows it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub room: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    /// user | agent:<id> | system.
    #[serde(default)]
    pub actor: String,
    /// note_created | note_updated | note_superseded | note_deleted |
    /// task_created | task_claimed | task_completed |
    /// playbook_rule_added | working_state_updated | session_started |
    /// context_injected | prompt_observed | … (open vocabulary; the
    /// temporal projection maps known types, unknown types survive in
    /// the journal for future consumers).
    #[serde(default)]
    pub event_type: String,
    #[serde(default)]
    pub object_type: String,
    #[serde(default)]
    pub object_id: String,
    /// Human-readable object name at event time (titles drift later;
    /// the journal keeps what it looked like THEN).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Engram kind at event time (decision/preference/source/...) —
    /// the temporal projection types changes with it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub source_refs: Vec<String>,
    /// Emitter's trust in the event content, [0,1].
    #[serde(default)]
    pub confidence: f64,
    /// hook | endpoint | ingest | todos | system | backfill.
    #[serde(default)]
    pub capture_method: String,
    /// normal | sensitive — consumers must not surface `sensitive`
    /// events outside the owner's own Inspector.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub privacy_label: Option<String>,
}

impl Event {
    /// Convenience constructor stamping id/ts and the common fields.
    pub fn now(brain_id: &str, event_type: &str, object_type: &str, object_id: &str) -> Self {
        Event {
            event_id: uuid::Uuid::new_v4().to_string(),
            ts: OffsetDateTime::now_utc()
                .format(&Rfc3339)
                .unwrap_or_default(),
            brain_id: brain_id.to_string(),
            actor: "user".to_string(),
            event_type: event_type.to_string(),
            object_type: object_type.to_string(),
            object_id: object_id.to_string(),
            confidence: 1.0,
            capture_method: "system".to_string(),
            ..Event::default()
        }
    }
}

/// `~/.neurovault/brains/<id>/journal/`
fn journal_dir(brain_id: &str) -> PathBuf {
    super::paths::nv_home()
        .join("brains")
        .join(brain_id)
        .join("journal")
}

/// Monthly segment for a timestamp ("events-2026-07.jsonl").
fn segment_for(ts: &str) -> String {
    let month = ts.get(..7).unwrap_or("unknown");
    format!("events-{month}.jsonl")
}

/// Append one event. Atomic at the line level (single write syscall
/// on a file opened O_APPEND). Errors bubble; hot-path callers use
/// [`record`] instead.
pub fn append(event: &Event) -> Result<()> {
    let dir = journal_dir(&event.brain_id);
    fs::create_dir_all(&dir).map_err(|e| MemoryError::Other(format!("journal dir: {e}")))?;
    let path = dir.join(segment_for(&event.ts));
    let line = serde_json::to_string(event)
        .map_err(|e| MemoryError::Other(format!("journal serialize: {e}")))?;
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| MemoryError::Other(format!("journal open: {e}")))?;
    writeln!(f, "{line}").map_err(|e| MemoryError::Other(format!("journal write: {e}")))?;
    Ok(())
}

/// Fail-soft append for hot paths (ingest, hooks, endpoints): the
/// user's operation must never fail because the journal hiccuped —
/// but the hiccup is loud.
pub fn record(event: Event) {
    if let Err(e) = append(&event) {
        eprintln!(
            "[journal] DROPPED {} event for {}: {e}",
            event.event_type, event.object_id
        );
    }
}

/// Read events in `[start, end]`, oldest first, optionally filtered to
/// a room (matches the event's `room` OR object ids under the folder).
/// Reads only the segments the window touches.
pub fn read_window(
    brain_id: &str,
    start: OffsetDateTime,
    end: OffsetDateTime,
    room: Option<&str>,
) -> Vec<Event> {
    let dir = journal_dir(brain_id);
    let mut out: Vec<Event> = Vec::new();
    let Ok(entries) = fs::read_dir(&dir) else {
        return out;
    };
    // Which monthly segments can intersect the window?
    let months: Vec<String> = {
        let mut m = Vec::new();
        let mut cur = start.replace_day(1).unwrap_or(start);
        while cur <= end {
            m.push(
                cur.format(&Rfc3339)
                    .unwrap_or_default()
                    .get(..7)
                    .unwrap_or("")
                    .to_string(),
            );
            // advance one month
            let (y, mo) = (cur.year(), cur.month() as u8);
            let (ny, nmo) = if mo == 12 { (y + 1, 1) } else { (y, mo + 1) };
            match time::Month::try_from(nmo) {
                Ok(month) => {
                    cur = cur
                        .replace_year(ny)
                        .and_then(|c| c.replace_month(month))
                        .unwrap_or(end + time::Duration::days(1));
                }
                Err(_) => break,
            }
        }
        m
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| months.iter().any(|m| n.contains(m.as_str())))
                .unwrap_or(false)
        })
        .collect();
    files.sort();
    for path in files {
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        for line in raw.lines() {
            let Ok(ev) = serde_json::from_str::<Event>(line) else {
                continue; // a corrupt line never breaks history reads
            };
            let Ok(ts) = OffsetDateTime::parse(&ev.ts, &Rfc3339) else {
                continue;
            };
            if ts < start || ts > end {
                continue;
            }
            if let Some(r) = room {
                // Brain-wide events (no room recorded — e.g. todos)
                // belong to every room's story; only events tagged to
                // a DIFFERENT room are excluded.
                let in_room = ev.room.is_none()
                    || ev.room.as_deref() == Some(r)
                    || ev.object_id.starts_with(&format!("{r}/"));
                if !in_room {
                    continue;
                }
            }
            out.push(ev);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_temp_home<F: FnOnce()>(f: F) {
        let home = std::env::temp_dir().join(format!(
            "nv-journal-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("NEUROVAULT_HOME", &home);
        f();
        std::env::remove_var("NEUROVAULT_HOME");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn append_read_window_room_filter_and_corruption_tolerance() {
        with_temp_home(|| {
            let b = "jtest";
            let mut e1 = Event::now(b, "note_created", "engram", "clients/acme/deck.md");
            e1.room = Some("clients/acme".into());
            e1.title = Some("Deck".into());
            append(&e1).unwrap();

            let mut e2 = Event::now(b, "task_created", "task", "t-1");
            e2.ts = "2020-01-15T10:00:00Z".into(); // old segment
            append(&e2).unwrap();

            let mut e3 = Event::now(b, "note_created", "engram", "other/thing.md");
            e3.room = Some("other".into());
            append(&e3).unwrap();

            // corrupt line must not break reads
            let dir = journal_dir(b);
            let seg = dir.join(segment_for(&e1.ts));
            let mut f = fs::OpenOptions::new().append(true).open(&seg).unwrap();
            writeln!(f, "{{ not json").unwrap();

            let now = OffsetDateTime::now_utc();
            let all = read_window(b, now - time::Duration::hours(1), now, None);
            assert_eq!(
                all.len(),
                2,
                "old-segment event excluded, corrupt line skipped"
            );

            let acme = read_window(b, now - time::Duration::hours(1), now, Some("clients/acme"));
            assert_eq!(acme.len(), 1);
            assert_eq!(acme[0].event_type, "note_created");
            assert_eq!(acme[0].title.as_deref(), Some("Deck"));

            // the old event is reachable with a wide window (separate
            // monthly segment, never discarded)
            let wide_start = OffsetDateTime::parse("2020-01-01T00:00:00Z", &Rfc3339).unwrap();
            let wide = read_window(b, wide_start, now, None);
            assert_eq!(wide.len(), 3);
        });
    }

    #[test]
    fn segments_are_monthly() {
        assert_eq!(segment_for("2026-07-10T12:00:00Z"), "events-2026-07.jsonl");
        assert_eq!(segment_for("2020-01-15T10:00:00Z"), "events-2020-01.jsonl");
    }
}
