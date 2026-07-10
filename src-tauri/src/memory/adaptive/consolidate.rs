//! Consolidation — SHADOW MODE (stage 1 of 3; adaptive spec §12b).
//!
//! Reads complete experience units from the Event Journal, produces a
//! deterministic ConsolidationReport, and WRITES NOTHING. Every
//! proposed action cites the exact event ids that justify it. The
//! acceptance bar (set by Dath, 2026-07-10) is not "tests green":
//!
//!   Given a complete experience unit, NeuroVault creates the same
//!   justified memories on replay, creates nothing unsupported, and
//!   shows the exact evidence behind every proposed field.
//!
//! Stage discipline:
//!   1. SHADOW (this file): report-only; visible in the Inspector.
//!   2. PROPOSAL: high/medium-confidence interpretations become
//!      reviewable proposals; approve/reject are journal events;
//!      precision measured per memory type.
//!   3. RESTRICTED AUTO: only narrow, demonstrably safe classes
//!      (explicit corrections, explicit decisions, confirmed
//!      deadlines, deterministic state transitions) auto-write.
//!
//! Grouping is by explicit `turn_id` / session identity — NEVER
//! timestamp proximity (interleaved sessions destroy it). No
//! PersonProfile inference (inferred social traits go confidently
//! wrong fast). No LLM in shadow mode: deterministic rules only.

use serde::Serialize;
use sha2::{Digest, Sha256};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use super::Scope;
use crate::memory::journal::{read_window, Event};
use crate::memory::types::MemoryError;

type Result<T> = std::result::Result<T, MemoryError>;

/// One prompt→outcome experience: everything sharing a turn, plus
/// session-scoped events bucketed by session.
#[derive(Debug, Serialize)]
pub struct ExperienceUnit {
    /// The opening context_decision's event_id, or "session:<id>" for
    /// events that belong to a session but no specific turn.
    pub unit_id: String,
    pub session_id: Option<String>,
    pub event_ids: Vec<String>,
    pub event_types: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Band {
    High,
    Medium,
    Low,
}

#[derive(Debug, Serialize)]
pub struct Proposal {
    /// Deterministic: sha256(action + object + sorted evidence)[..16].
    /// Identical on replay by construction.
    pub proposal_id: String,
    /// working_state_refresh | supersession_suggestion |
    /// memory_strengthened | room_summary_refresh
    pub action: &'static str,
    pub memory_type: &'static str,
    pub object_id: String,
    pub title: String,
    pub reason: String,
    pub band: Band,
    /// Journal event ids justifying this proposal — never empty.
    pub evidence: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ConsolidationReport {
    pub report_id: String,
    pub ts: String,
    pub brain: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room: Option<String>,
    pub mode: &'static str, // "shadow"
    pub window_start: String,
    pub window_end: String,
    pub events_read: usize,
    pub units: Vec<ExperienceUnit>,
    pub proposals: Vec<Proposal>,
    /// What produced no proposal and why — silence is explained here
    /// exactly like the ambient gate explains it.
    pub notes: Vec<String>,
}

fn pid(action: &str, object: &str, evidence: &[String]) -> String {
    let mut ev = evidence.to_vec();
    ev.sort();
    let mut h = Sha256::new();
    h.update(action.as_bytes());
    h.update(object.as_bytes());
    for e in &ev {
        h.update(e.as_bytes());
    }
    format!("{:x}", h.finalize())[..16].to_string()
}

/// Group events into experience units by explicit correlation.
pub fn group_units(events: &[Event]) -> Vec<ExperienceUnit> {
    use std::collections::BTreeMap;
    let mut by_unit: BTreeMap<String, Vec<&Event>> = BTreeMap::new();
    for e in events {
        let key = e
            .turn_id
            .clone()
            .or_else(|| e.session_id.as_ref().map(|s| format!("session:{s}")))
            .unwrap_or_else(|| "unsessioned".to_string());
        by_unit.entry(key).or_default().push(e);
    }
    by_unit
        .into_iter()
        .map(|(unit_id, evs)| ExperienceUnit {
            unit_id,
            session_id: evs.iter().find_map(|e| e.session_id.clone()),
            event_ids: evs.iter().map(|e| e.event_id.clone()).collect(),
            event_types: evs.iter().map(|e| e.event_type.clone()).collect(),
        })
        .collect()
}

/// The deterministic rule set. Every rule: explicit trigger events →
/// one proposal citing them. Nothing inferred, nothing unsupported.
fn propose(events: &[Event]) -> (Vec<Proposal>, Vec<String>) {
    let mut proposals: Vec<Proposal> = Vec::new();
    let mut notes: Vec<String> = Vec::new();

    // Rule 1 — memory_strengthened (deterministic state transition):
    // a completed task whose creation cited a source engram is REAL
    // outcome evidence for that engram (the anti-feedback rule's
    // approved list: successful task outcome).
    for e in events.iter().filter(|e| e.event_type == "task_completed") {
        if let Some(engram) = e
            .source_refs
            .iter()
            .find(|r| !r.starts_with("caused_by:") && !r.starts_with("reason:"))
        {
            let evidence = vec![e.event_id.clone()];
            proposals.push(Proposal {
                proposal_id: pid("memory_strengthened", engram, &evidence),
                action: "memory_strengthened",
                memory_type: "engram",
                object_id: engram.clone(),
                title: e.title.clone().unwrap_or_default(),
                reason: "task completed; its source engram earned outcome-based usage strength"
                    .into(),
                band: Band::High,
                evidence,
            });
        }
    }

    // Rule 2 — supersession suggestions: two notes created in the same
    // room whose normalized titles collide strongly. Suggest, never
    // decide (the pair might be intentional).
    let notes_created: Vec<&Event> = events
        .iter()
        .filter(|e| e.event_type == "note_created")
        .collect();
    for (i, a) in notes_created.iter().enumerate() {
        for b in notes_created.iter().skip(i + 1) {
            if a.room != b.room {
                continue;
            }
            let norm = |t: &Option<String>| {
                t.as_deref()
                    .unwrap_or("")
                    .to_lowercase()
                    .chars()
                    .filter(|c| c.is_alphanumeric())
                    .collect::<String>()
            };
            let (ta, tb) = (norm(&a.title), norm(&b.title));
            if ta.len() >= 12
                && tb.len() >= 12
                && (ta.starts_with(&tb[..12.min(tb.len())])
                    || tb.starts_with(&ta[..12.min(ta.len())]))
            {
                let evidence = vec![a.event_id.clone(), b.event_id.clone()];
                proposals.push(Proposal {
                    proposal_id: pid("supersession_suggestion", &b.object_id, &evidence),
                    action: "supersession_suggestion",
                    memory_type: "engram",
                    object_id: a.object_id.clone(),
                    title: a.title.clone().unwrap_or_default(),
                    reason: format!(
                        "two notes with strongly colliding titles in the same room; newer {} may supersede older {}",
                        &b.object_id.chars().take(8).collect::<String>(),
                        &a.object_id.chars().take(8).collect::<String>()
                    ),
                    band: Band::Medium,
                    evidence,
                });
            }
        }
    }

    // Rule 3 — working_state refresh: a session ended after real
    // activity, but the working-state buffer never moved in the
    // window. "continue" would replay stale intent.
    let session_ended: Vec<&Event> = events
        .iter()
        .filter(|e| e.event_type == "session_ended")
        .collect();
    let ws_updated = events
        .iter()
        .any(|e| e.event_type == "working_state_updated");
    for end in &session_ended {
        let decisions_in_session: Vec<&Event> = events
            .iter()
            .filter(|e| e.event_type == "context_decision" && e.session_id == end.session_id)
            .collect();
        if !decisions_in_session.is_empty() && !ws_updated {
            let mut evidence: Vec<String> = decisions_in_session
                .iter()
                .map(|e| e.event_id.clone())
                .collect();
            evidence.push(end.event_id.clone());
            proposals.push(Proposal {
                proposal_id: pid(
                    "working_state_refresh",
                    end.session_id.as_deref().unwrap_or("?"),
                    &evidence,
                ),
                action: "working_state_refresh",
                memory_type: "working_state",
                object_id: end.session_id.clone().unwrap_or_default(),
                title: "Working state not updated during an active session".into(),
                reason: format!(
                    "session ended after {} context decision(s) without a working-state update; 'continue' would replay stale intent",
                    decisions_in_session.len()
                ),
                band: Band::Medium,
                evidence,
            });
        }
    }

    // Rule 4 — room summary refresh: enough meaningful room activity
    // that the summary is likely stale.
    use std::collections::BTreeMap;
    let mut per_room: BTreeMap<String, Vec<&Event>> = BTreeMap::new();
    for e in events.iter().filter(|e| {
        matches!(
            e.event_type.as_str(),
            "note_created" | "note_superseded" | "playbook_rule_added" | "task_completed"
        )
    }) {
        if let Some(r) = &e.room {
            per_room.entry(r.clone()).or_default().push(e);
        }
    }
    for (room, evs) in per_room {
        if evs.len() >= 3 {
            let evidence: Vec<String> = evs.iter().map(|e| e.event_id.clone()).collect();
            proposals.push(Proposal {
                proposal_id: pid("room_summary_refresh", &room, &evidence),
                action: "room_summary_refresh",
                memory_type: "room_summary",
                object_id: room.clone(),
                title: format!("Room '{room}' had {} meaningful changes", evs.len()),
                reason: "enough meaningful room activity that the room summary is likely stale"
                    .into(),
                band: Band::Low,
                evidence,
            });
        } else {
            notes.push(format!(
                "room '{room}': only {} meaningful event(s); below the summary-refresh bar (3)",
                evs.len()
            ));
        }
    }

    // Determinism: order by proposal_id, not construction order.
    proposals.sort_by(|a, b| a.proposal_id.cmp(&b.proposal_id));
    (proposals, notes)
}

/// Run shadow consolidation over a window. Reads the journal, writes
/// NOTHING to memories — only a report line for the Inspector.
pub fn run_shadow(
    scope: &Scope,
    start: OffsetDateTime,
    end: OffsetDateTime,
) -> Result<ConsolidationReport> {
    let events = read_window(&scope.brain_id, start, end, scope.room.as_deref());
    let units = group_units(&events);
    let (proposals, mut notes) = propose(&events);
    if proposals.is_empty() {
        notes.push("no proposal-worthy patterns in this window (that is a valid outcome)".into());
    }
    let fmt = |t: OffsetDateTime| t.format(&Rfc3339).unwrap_or_default();
    let report = ConsolidationReport {
        report_id: uuid::Uuid::new_v4().to_string(),
        ts: fmt(OffsetDateTime::now_utc()),
        brain: scope.brain_id.clone(),
        room: scope.room.clone(),
        mode: "shadow",
        window_start: fmt(start),
        window_end: fmt(end),
        events_read: events.len(),
        units,
        proposals,
        notes,
    };
    // Best-effort report log (the Inspector's consolidation feed).
    let path = crate::memory::paths::nv_home()
        .join("logs")
        .join("consolidation_reports.jsonl");
    if let Ok(v) = serde_json::to_value(&report) {
        if let Err(e) = crate::memory::ambient::append_log(&path, &v) {
            eprintln!("[consolidate] report log write failed: {e}");
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::journal::{append, Event};

    static HOME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn with_temp_home<F: FnOnce()>(f: F) {
        let _guard = HOME_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let home = std::env::temp_dir().join(format!(
            "nv-consolidate-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("NEUROVAULT_HOME", &home);
        f();
        std::env::remove_var("NEUROVAULT_HOME");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Seed one complete experience unit + surrounding activity.
    fn seed(brain: &str) -> (String, String) {
        // turn: decision -> response -> session end (no ws update)
        let mut turn = Event::now(brain, "context_decision", "prompt", "sha-1");
        turn.session_id = Some("s-1".into());
        turn.turn_id = Some(turn.event_id.clone());
        append(&turn).unwrap();
        let mut resp = Event::now(brain, "assistant_response_completed", "session", "s-1");
        resp.session_id = Some("s-1".into());
        resp.turn_id = Some(turn.event_id.clone());
        resp.source_refs = vec![format!("caused_by:{}", turn.event_id)];
        append(&resp).unwrap();
        let mut end = Event::now(brain, "session_ended", "session", "s-1");
        end.session_id = Some("s-1".into());
        append(&end).unwrap();
        // completed task citing an engram
        let mut done = Event::now(brain, "task_completed", "task", "t-9");
        done.title = Some("Send deck".into());
        done.source_refs = vec!["engram-abc".into()];
        append(&done).unwrap();
        // colliding titles in one room
        for (id, title) in [
            ("e-old", "Pricing model draft v1"),
            ("e-new", "Pricing model draft v2"),
        ] {
            let mut n = Event::now(brain, "note_created", "engram", id);
            n.title = Some(title.into());
            n.room = Some("clients/acme".into());
            append(&n).unwrap();
        }
        (turn.event_id.clone(), resp.event_id.clone())
    }

    #[test]
    fn shadow_is_deterministic_supported_and_writes_nothing() {
        with_temp_home(|| {
            let brain = "ctest";
            seed(brain);
            let scope = Scope::brain(brain);
            let now = OffsetDateTime::now_utc() + time::Duration::minutes(1);
            let start = now - time::Duration::hours(1);

            let r1 = run_shadow(&scope, start, now).unwrap();
            let r2 = run_shadow(&scope, start, now).unwrap();

            // ACCEPTANCE 1: same justified memories on replay.
            let p1 = serde_json::to_string(&r1.proposals).unwrap();
            let p2 = serde_json::to_string(&r2.proposals).unwrap();
            assert_eq!(p1, p2, "replay produces identical proposals");

            // ACCEPTANCE 2: nothing unsupported — every proposal cites
            // evidence, and every cited id exists in the window.
            let known: std::collections::HashSet<String> =
                crate::memory::journal::read_window(brain, start, now, None)
                    .into_iter()
                    .map(|e| e.event_id)
                    .collect();
            assert!(!r1.proposals.is_empty());
            for p in &r1.proposals {
                assert!(!p.evidence.is_empty(), "{} has no evidence", p.action);
                for ev in &p.evidence {
                    assert!(known.contains(ev), "{} cites unknown event {ev}", p.action);
                }
            }

            // The three deterministic rules fired as designed.
            let actions: Vec<&str> = r1.proposals.iter().map(|p| p.action).collect();
            assert!(actions.contains(&"memory_strengthened"));
            assert!(actions.contains(&"supersession_suggestion"));
            assert!(actions.contains(&"working_state_refresh"));

            // ACCEPTANCE 3: shadow writes nothing — the journal gained
            // no events from consolidating (report log is not the journal).
            let before = known.len();
            let _ = run_shadow(&scope, start, now).unwrap();
            let after = crate::memory::journal::read_window(brain, start, now, None).len();
            assert_eq!(before, after, "shadow consolidation writes no events");
        });
    }

    #[test]
    fn units_group_by_turn_not_time_and_empty_window_is_explained() {
        with_temp_home(|| {
            let brain = "ctest2";
            // interleaved turns from two sessions
            for (sess, sha) in [("A", "sha-a"), ("B", "sha-b")] {
                let mut t = Event::now(brain, "context_decision", "prompt", sha);
                t.session_id = Some(sess.into());
                t.turn_id = Some(t.event_id.clone());
                append(&t).unwrap();
            }
            let scope = Scope::brain(brain);
            let now = OffsetDateTime::now_utc() + time::Duration::minutes(1);
            let r = run_shadow(&scope, now - time::Duration::hours(1), now).unwrap();
            assert_eq!(
                r.units.len(),
                2,
                "one unit per turn, not one blob per time bucket"
            );

            // far-future empty window: no proposals, but the silence is explained
            let r = run_shadow(
                &scope,
                now + time::Duration::days(10),
                now + time::Duration::days(11),
            )
            .unwrap();
            assert!(r.proposals.is_empty());
            assert!(r.notes.iter().any(|n| n.contains("valid outcome")));
        });
    }
}
