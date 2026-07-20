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

fn default_schema_version() -> u8 {
    1
}

/// Per-process monotonic counter backing `Event.seq`.
static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Bounded evidence: large payloads are stored by REFERENCE
/// (`source_refs`), never inlined — before/after are summaries.
const FIELD_CAP: usize = 500;

/// One experience. Field names follow the adaptive-memory spec.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Event {
    /// Journal schema version — consumers branch on this, replays
    /// across versions stay interpretable.
    #[serde(default = "default_schema_version")]
    pub schema_version: u8,
    /// Who wrote this ("neurovault-core/<crate version>").
    #[serde(default)]
    pub emitter: String,
    /// Per-process monotonic sequence — ordering must never depend
    /// solely on wall-clock timestamps (same-second events, clock
    /// skew). Readers sort by (ts, seq).
    #[serde(default)]
    pub seq: u64,
    /// Optional writer-side dedup key: repeated hook deliveries of the
    /// same underlying occurrence (retries, re-fired hooks) carry the
    /// same key and are skipped by `append_idempotent`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    /// Explicit turn correlation: the event_id of the context_decision
    /// that OPENED the turn. Consolidation groups experience units by
    /// this (and causal `caused_by:<event_id>` source_refs) — never by
    /// timestamp proximity, which interleaved sessions destroy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
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
            schema_version: 1,
            emitter: format!("neurovault-core/{}", env!("CARGO_PKG_VERSION")),
            seq: SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
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
    // Privacy exclusion: private folders never enter the journal.
    if is_private(event) {
        return Ok(());
    }
    let mut event = event.clone();
    // Bounded evidence — big payloads travel by reference.
    if let Some(b) = &event.before {
        if b.chars().count() > FIELD_CAP {
            event.before = Some(b.chars().take(FIELD_CAP).collect());
        }
    }
    if let Some(a) = &event.after {
        if a.chars().count() > FIELD_CAP {
            event.after = Some(a.chars().take(FIELD_CAP).collect());
        }
    }
    let event = &event;
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
    // ONE write syscall for line+newline: O_APPEND makes a single
    // write atomic w.r.t. the offset, but `writeln!` may split into
    // multiple writes and interleave under concurrency (caught by the
    // invariant test — 129/200 events survived 8 threads before this).
    let mut buf = line.into_bytes();
    buf.push(b'\n');
    f.write_all(&buf)
        .map_err(|e| MemoryError::Other(format!("journal write: {e}")))?;
    Ok(())
}

/// Folders whose contents never enter the journal (privacy rule; the
/// Gatekeeper employee extends this later). Matches any path segment.
fn is_private(event: &Event) -> bool {
    let private_seg = |s: &str| {
        s.split('/')
            .any(|seg| seg == "_private" || seg == ".private" || seg.starts_with('.'))
    };
    event.privacy_label.as_deref() == Some("sensitive")
        || event.room.as_deref().is_some_and(private_seg)
        || (event.object_type == "engram" && private_seg(&event.object_id))
        || event.title.as_deref().is_some_and(private_seg)
}

/// Append unless an event with the same `idempotency_key` already sits
/// in the tail of the current segment (bounded 64 KiB scan — repeated
/// hook deliveries land close together; a same-key event months apart
/// is a different occurrence).
pub fn append_idempotent(event: &Event) -> Result<bool> {
    if let Some(key) = &event.idempotency_key {
        let path = journal_dir(&event.brain_id).join(segment_for(&event.ts));
        if let Ok(raw) = fs::read_to_string(&path) {
            // `saturating_sub` stopped the underflow but not the real
            // hazard: `len - 64KiB` is an arbitrary byte index into a
            // file full of user-supplied titles and room names, and
            // slicing a `str` mid-character panics. Every append shifts
            // the length, so this re-sampled a fresh offset each time —
            // for any journal containing an accent or emoji it was a
            // question of how many events, not whether.
            let needle = format!("\"idempotency_key\":\"{key}\"");
            if crate::memory::text::tail_bytes(&raw, 64 * 1024).contains(&needle) {
                return Ok(false);
            }
        }
    }
    append(event)?;
    Ok(true)
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
    // Ordering never depends solely on wall-clock: (ts, seq) is the
    // journal's total order for same-process bursts.
    out.sort_by(|a, b| a.ts.cmp(&b.ts).then(a.seq.cmp(&b.seq)));
    out
}

/// Latest event of `event_type` for `session_id`, scanning the newest
/// segments backwards (bounded: current + previous month). The causal
/// stamp for outcome events — "which decision opened this turn" — is
/// resolved HERE, by explicit session identity, never by wall-clock
/// adjacency.
pub fn latest_for_session(brain_id: &str, session_id: &str, event_type: &str) -> Option<Event> {
    let dir = journal_dir(brain_id);
    let mut files: Vec<PathBuf> = fs::read_dir(&dir)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("events-"))
        })
        .collect();
    files.sort();
    for path in files.iter().rev().take(2) {
        let raw = fs::read_to_string(path).ok()?;
        for line in raw.lines().rev() {
            let Ok(ev) = serde_json::from_str::<Event>(line) else {
                continue;
            };
            if ev.event_type == event_type && ev.session_id.as_deref() == Some(session_id) {
                return Some(ev);
            }
        }
    }
    None
}

/// NEUROVAULT_HOME is process-global; EVERY test that redirects it
/// must hold THIS lock — one shared mutex across modules, or two
/// modules' separate locks happily interleave and wipe each other's
/// homes (bitten three times: retrieval, recall_cache, proposals).
#[cfg(test)]
pub(crate) static TEST_HOME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    fn with_temp_home<F: FnOnce()>(f: F) {
        let _guard = super::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
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
    fn concurrent_appends_do_not_interleave_or_lose_writes() {
        with_temp_home(|| {
            let b = "jconc";
            let threads: Vec<_> = (0..8)
                .map(|t| {
                    std::thread::spawn(move || {
                        for i in 0..25 {
                            let mut ev =
                                Event::now(b, "task_created", "task", &format!("t{t}-{i}"));
                            ev.title = Some(format!("payload {t}-{i} {}", "x".repeat(300)));
                            append(&ev).unwrap();
                        }
                    })
                })
                .collect();
            for t in threads {
                t.join().unwrap();
            }
            let now = OffsetDateTime::now_utc();
            let all = read_window(b, now - time::Duration::hours(1), now, None);
            assert_eq!(all.len(), 200, "no lost or torn writes");
            // every line parsed (torn writes would have been skipped
            // and dropped the count); ids unique
            let ids: std::collections::HashSet<_> = all.iter().map(|e| &e.event_id).collect();
            assert_eq!(ids.len(), 200);
        });
    }

    #[test]
    fn idempotent_append_skips_redelivery() {
        with_temp_home(|| {
            let b = "jidem";
            let mut ev = Event::now(b, "assistant_response_completed", "session", "s1");
            ev.idempotency_key = Some("stop-s1-42".into());
            assert!(append_idempotent(&ev).unwrap());
            let mut redelivery = ev.clone();
            redelivery.event_id = uuid::Uuid::new_v4().to_string();
            assert!(
                !append_idempotent(&redelivery).unwrap(),
                "redelivery skipped"
            );
            let now = OffsetDateTime::now_utc();
            assert_eq!(
                read_window(b, now - time::Duration::hours(1), now, None).len(),
                1
            );
        });
    }

    #[test]
    fn ordering_uses_seq_within_same_timestamp_and_replay_is_deterministic() {
        with_temp_home(|| {
            let b = "jorder";
            let ts = OffsetDateTime::now_utc().format(&Rfc3339).unwrap();
            for i in 0..5u64 {
                let mut ev = Event::now(b, "note_created", "engram", &format!("n{i}"));
                ev.ts = ts.clone(); // identical wall-clock
                append(&ev).unwrap();
            }
            let now = OffsetDateTime::now_utc() + time::Duration::minutes(1);
            let a = read_window(b, now - time::Duration::hours(1), now, None);
            let b2 = read_window(b, now - time::Duration::hours(1), now, None);
            let ids_a: Vec<_> = a.iter().map(|e| e.object_id.clone()).collect();
            let ids_b: Vec<_> = b2.iter().map(|e| e.object_id.clone()).collect();
            assert_eq!(ids_a, ids_b, "replay produces identical order");
            assert_eq!(ids_a, vec!["n0", "n1", "n2", "n3", "n4"], "seq order");
        });
    }

    #[test]
    fn private_paths_and_big_payloads_are_guarded() {
        with_temp_home(|| {
            let b = "jpriv";
            let mut ev = Event::now(b, "note_created", "engram", "_private/diary.md");
            append(&ev).unwrap(); // silently excluded
            ev = Event::now(b, "note_created", "engram", "ok.md");
            ev.before = Some("y".repeat(5000));
            append(&ev).unwrap();
            let now = OffsetDateTime::now_utc();
            let all = read_window(b, now - time::Duration::hours(1), now, None);
            assert_eq!(all.len(), 1, "private event never journaled");
            assert!(all[0].before.as_ref().unwrap().chars().count() <= 500);
            assert_eq!(all[0].schema_version, 1);
            assert!(all[0].emitter.starts_with("neurovault-core/"));
        });
    }

    #[test]
    fn turn_correlation_survives_interleaved_sessions() {
        with_temp_home(|| {
            let b = "jturns";
            // Two sessions, events fully interleaved in time — the
            // exact case timestamp-proximity grouping gets wrong.
            let mut turn_a = Event::now(b, "context_decision", "prompt", "sha-a1");
            turn_a.session_id = Some("sess-A".into());
            turn_a.turn_id = Some(turn_a.event_id.clone());
            append(&turn_a).unwrap();

            let mut turn_b = Event::now(b, "context_decision", "prompt", "sha-b1");
            turn_b.session_id = Some("sess-B".into());
            turn_b.turn_id = Some(turn_b.event_id.clone());
            append(&turn_b).unwrap();

            // B's response arrives BEFORE A's (interleaved).
            let opened_b = latest_for_session(b, "sess-B", "context_decision").unwrap();
            let mut resp_b = Event::now(b, "assistant_response_completed", "session", "sess-B");
            resp_b.session_id = Some("sess-B".into());
            resp_b.turn_id = opened_b.turn_id.clone();
            resp_b.source_refs = vec![format!("caused_by:{}", opened_b.event_id)];
            append(&resp_b).unwrap();

            let opened_a = latest_for_session(b, "sess-A", "context_decision").unwrap();
            let mut resp_a = Event::now(b, "assistant_response_completed", "session", "sess-A");
            resp_a.session_id = Some("sess-A".into());
            resp_a.turn_id = opened_a.turn_id.clone();
            resp_a.source_refs = vec![format!("caused_by:{}", opened_a.event_id)];
            append(&resp_a).unwrap();

            // Correlation must pair by turn_id, not order of arrival.
            assert_eq!(
                opened_b.event_id, turn_b.event_id,
                "B's response found B's turn"
            );
            assert_eq!(
                opened_a.event_id, turn_a.event_id,
                "A's response found A's turn"
            );
            let now = OffsetDateTime::now_utc();
            let evs = read_window(b, now - time::Duration::hours(1), now, None);
            let by_turn: std::collections::HashMap<Option<String>, usize> =
                evs.iter().fold(Default::default(), |mut m, e| {
                    *m.entry(e.turn_id.clone()).or_default() += 1;
                    m
                });
            assert_eq!(by_turn.get(&Some(turn_a.event_id.clone())), Some(&2));
            assert_eq!(by_turn.get(&Some(turn_b.event_id.clone())), Some(&2));
        });
    }

    #[test]
    fn segments_are_monthly() {
        assert_eq!(segment_for("2026-07-10T12:00:00Z"), "events-2026-07.jsonl");
        assert_eq!(segment_for("2020-01-15T10:00:00Z"), "events-2020-01.jsonl");
    }
}
