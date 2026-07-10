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

use super::proposals::{self, ProposedField, StoredProposal};
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
    /// Per-field provenance: every proposed field carries ITS OWN
    /// evidence, not just the proposal as a whole (stage-2 rule).
    pub fields: Vec<ProposedField>,
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

    // Loop guard (stage-2 rule): consolidation NEVER consumes its own
    // review/consolidation events as fresh source evidence.
    let events: Vec<&Event> = events
        .iter()
        .filter(|e| e.capture_method != "review" && !e.event_type.starts_with("consolidation_"))
        .collect();
    let events: &[&Event] = &events;

    // Late-outcome guard: a turn whose outcome hasn't arrived yet is
    // INCOMPLETE — unit-scoped rules defer, the report says so, and
    // the watermark's grace window guarantees the unit is reconsidered
    // when the outcome lands.
    let incomplete_turns: std::collections::HashSet<&str> = events
        .iter()
        .filter(|e| e.event_type == "context_decision")
        .filter(|d| {
            !events
                .iter()
                .any(|o| o.turn_id == d.turn_id && o.event_type == "assistant_response_completed")
                && !events
                    .iter()
                    .any(|o| o.event_type == "session_ended" && o.session_id == d.session_id)
        })
        .filter_map(|d| d.turn_id.as_deref())
        .collect();
    if !incomplete_turns.is_empty() {
        notes.push(format!(
            "{} turn(s) awaiting outcome evidence; deferred, not skipped (grace-window replay reconsiders them)",
            incomplete_turns.len()
        ));
    }

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
                fields: vec![ProposedField {
                    name: "last_confirmed_at".into(),
                    proposed_value: "now".into(),
                    approved_value: None,
                    evidence: evidence.clone(),
                }],
                evidence,
            });
        }
    }

    // Rule 2 — supersession suggestions: two notes created in the same
    // room whose normalized titles collide strongly. Suggest, never
    // decide (the pair might be intentional).
    let notes_created: Vec<&Event> = events
        .iter()
        .copied()
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
                let fields = vec![
                    ProposedField {
                        name: "superseded_engram".into(),
                        proposed_value: a.object_id.clone(),
                        approved_value: None,
                        evidence: vec![a.event_id.clone()],
                    },
                    ProposedField {
                        name: "superseded_by".into(),
                        proposed_value: b.object_id.clone(),
                        approved_value: None,
                        evidence: vec![b.event_id.clone()],
                    },
                ];
                proposals.push(Proposal {
                    fields,
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
        .copied()
        .filter(|e| e.event_type == "session_ended")
        .collect();
    let ws_updated = events
        .iter()
        .any(|e| e.event_type == "working_state_updated");
    for end in &session_ended {
        let decisions_in_session: Vec<&Event> = events
            .iter()
            .copied()
            .filter(|e| e.event_type == "context_decision" && e.session_id == end.session_id)
            .collect();
        if !decisions_in_session.is_empty() && !ws_updated {
            let mut evidence: Vec<String> = decisions_in_session
                .iter()
                .map(|e| e.event_id.clone())
                .collect();
            evidence.push(end.event_id.clone());
            // Stage-2 rule: WORKING-STATE CONTENTS ARE NOT INFERRED
            // until the hardened transcript reader exists. This
            // proposes only the FACT that a refresh is needed — the
            // task/draft/next-step fields stay empty by design.
            proposals.push(Proposal {
                fields: vec![ProposedField {
                    name: "needs_refresh".into(),
                    proposed_value: "true".into(),
                    approved_value: None,
                    evidence: evidence.clone(),
                }],
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
                fields: vec![ProposedField {
                    name: "refresh".into(),
                    proposed_value: "true".into(),
                    approved_value: None,
                    evidence: evidence.clone(),
                }],
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
    build_report(scope, start, end, "shadow")
}

// ---------------------------------------------------------------------------
// Proposal mode (stage 2): watermark + grace window + store dedupe
// ---------------------------------------------------------------------------

/// Late outcomes must not be skipped: the window always replays a
/// GRACE period behind the watermark, and deterministic proposal_ids
/// make the replay idempotent against the store. An incomplete turn
/// (decision without outcome) produces no unit-scoped proposal today;
/// when its outcome lands inside the grace window, the next run sees
/// the completed unit and proposes exactly once.
pub const GRACE_HOURS: i64 = 48;

#[derive(Debug, Serialize, serde::Deserialize)]
struct ConsolidationState {
    watermark: String,
}

fn state_path(brain_id: &str) -> std::path::PathBuf {
    crate::memory::paths::nv_home()
        .join("brains")
        .join(brain_id)
        .join("consolidation_state.json")
}

fn read_watermark(brain_id: &str) -> Option<OffsetDateTime> {
    let raw = std::fs::read_to_string(state_path(brain_id)).ok()?;
    let st: ConsolidationState = serde_json::from_str(&raw).ok()?;
    OffsetDateTime::parse(&st.watermark, &Rfc3339).ok()
}

/// Atomic (temp + rename): a crash between store appends and this
/// write only means the overlap is replayed — and replay reduces to
/// no-ops via deterministic ids. At-least-once, exactly-once effect.
fn write_watermark(brain_id: &str, now: OffsetDateTime) -> Result<()> {
    let path = state_path(brain_id);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| MemoryError::Other(format!("state dir: {e}")))?;
    }
    let st = ConsolidationState {
        watermark: now.format(&Rfc3339).unwrap_or_default(),
    };
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string(&st).unwrap_or_default())
        .map_err(|e| MemoryError::Other(format!("state write: {e}")))?;
    std::fs::rename(&tmp, &path).map_err(|e| MemoryError::Other(format!("state rename: {e}")))?;
    Ok(())
}

/// Stage-2 run: everything shadow does, PLUS new proposals enter the
/// review store. Known proposal_ids are skipped whatever their status
/// — a REJECTED proposal is never regenerated from identical evidence
/// (new evidence hashes to a new id, linked to its rejected
/// predecessor via same action+object).
pub fn run_proposal(scope: &Scope) -> Result<ConsolidationReport> {
    let now = OffsetDateTime::now_utc();
    let start = read_watermark(&scope.brain_id)
        .map(|w| w - time::Duration::hours(GRACE_HOURS))
        .unwrap_or(now - time::Duration::days(7));
    let mut report = build_report(scope, start, now, "proposal")?;

    let store = proposals::load_all(&scope.brain_id);
    let mut kept: Vec<Proposal> = Vec::new();
    for p in report.proposals.drain(..) {
        if let Some(existing) = store.get(&p.proposal_id) {
            report.notes.push(format!(
                "proposal {} already known (status {:?}); not regenerated",
                p.proposal_id, existing.status
            ));
            continue;
        }
        let predecessor = store
            .values()
            .find(|sp| {
                sp.status == proposals::ProposalStatus::Rejected
                    && sp.action == p.action
                    && sp.object_id == p.object_id
            })
            .map(|sp| sp.proposal_id.clone());
        if let Some(pred) = &predecessor {
            report.notes.push(format!(
                "proposal {} supersedes rejected predecessor {pred} (new evidence)",
                p.proposal_id
            ));
        }
        let rec = StoredProposal {
            proposal_id: p.proposal_id.clone(),
            brain_id: scope.brain_id.clone(),
            action: p.action.to_string(),
            memory_type: p.memory_type.to_string(),
            object_id: p.object_id.clone(),
            title: p.title.clone(),
            reason: p.reason.clone(),
            band: format!("{:?}", p.band).to_lowercase(),
            fields: p.fields.clone(),
            evidence: p.evidence.clone(),
            status: proposals::ProposalStatus::Proposed,
            proposed_at: now.format(&Rfc3339).unwrap_or_default(),
            decided_at: None,
            decided_by: None,
            decision_reason: None,
            predecessor,
            applied: false,
        };
        proposals::append(&scope.brain_id, &rec)?;
        kept.push(p);
    }
    report.proposals = kept;
    // Watermark advances only after store appends succeeded.
    write_watermark(&scope.brain_id, now)?;
    Ok(report)
}

/// Shared internals for shadow + proposal runs.
fn build_report(
    scope: &Scope,
    start: OffsetDateTime,
    end: OffsetDateTime,
    mode: &'static str,
) -> Result<ConsolidationReport> {
    let events = read_window(&scope.brain_id, start, end, scope.room.as_deref());
    let units = group_units(&events);
    let (props, mut notes) = propose(&events);
    if props.is_empty() {
        notes.push("no proposal-worthy patterns in this window (that is a valid outcome)".into());
    }
    let fmt = |t: OffsetDateTime| t.format(&Rfc3339).unwrap_or_default();
    let report = ConsolidationReport {
        report_id: uuid::Uuid::new_v4().to_string(),
        ts: fmt(OffsetDateTime::now_utc()),
        brain: scope.brain_id.clone(),
        room: scope.room.clone(),
        mode,
        window_start: fmt(start),
        window_end: fmt(end),
        events_read: events.len(),
        units,
        proposals: props,
        notes,
    };
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

    fn with_temp_home<F: FnOnce()>(f: F) {
        let _guard = crate::memory::journal::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
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

    /// Dath's late-outcome invariant, verbatim: decision arrives →
    /// run sees incomplete turn → watermark advances → outcome arrives
    /// LATER → next run completes the SAME experience unit → exactly
    /// one stable proposal exists.
    #[test]
    fn late_outcomes_are_never_skipped() {
        with_temp_home(|| {
            let brain = "clate";
            let scope = Scope::brain(brain);

            // 1. context decision arrives (turn opens; no outcome yet)
            let mut turn = Event::now(brain, "context_decision", "prompt", "sha-late");
            turn.session_id = Some("s-late".into());
            turn.turn_id = Some(turn.event_id.clone());
            append(&turn).unwrap();

            // 2. consolidation runs; the turn is incomplete
            let r1 = run_proposal(&scope).unwrap();
            assert!(
                !r1.proposals
                    .iter()
                    .any(|p| p.action == "working_state_refresh"),
                "incomplete turn must not produce the unit-scoped proposal"
            );
            assert!(
                r1.notes.iter().any(|n| n.contains("awaiting outcome")),
                "deferral is visible, not silent: {:?}",
                r1.notes
            );
            // 3. watermark advanced
            assert!(read_watermark(brain).is_some());

            // 4. the outcome arrives later
            let mut end_ev = Event::now(brain, "session_ended", "session", "s-late");
            end_ev.session_id = Some("s-late".into());
            append(&end_ev).unwrap();

            // 5. next run replays the grace window and completes the unit
            let r2 = run_proposal(&scope).unwrap();
            let ws: Vec<_> = r2
                .proposals
                .iter()
                .filter(|p| p.action == "working_state_refresh")
                .collect();
            assert_eq!(ws.len(), 1, "the completed unit proposes exactly once");
            let pid = ws[0].proposal_id.clone();

            // 6. exactly one stable proposal exists — further runs are no-ops
            let r3 = run_proposal(&scope).unwrap();
            assert!(
                r3.proposals.is_empty(),
                "replay is idempotent: {:?}",
                r3.proposals.iter().map(|p| p.action).collect::<Vec<_>>()
            );
            let store = proposals::load_all(brain);
            let ws_stored: Vec<_> = store
                .values()
                .filter(|p| p.action == "working_state_refresh")
                .collect();
            assert_eq!(ws_stored.len(), 1);
            assert_eq!(ws_stored[0].proposal_id, pid);
            // stage-2 rule: contents were NOT inferred
            assert_eq!(ws_stored[0].fields.len(), 1);
            assert_eq!(ws_stored[0].fields[0].name, "needs_refresh");
        });
    }

    /// Rejected proposals are not regenerated from identical evidence;
    /// new evidence creates a NEW proposal linked to the predecessor.
    #[test]
    fn rejected_is_final_and_new_evidence_links_back() {
        with_temp_home(|| {
            let brain = "crej";
            let scope = Scope::brain(brain);
            // completed task citing an engram -> memory_strengthened
            let mut done = Event::now(brain, "task_completed", "task", "t-r");
            done.title = Some("Ship deck".into());
            done.source_refs = vec!["engram-r".into()];
            append(&done).unwrap();

            let r1 = run_proposal(&scope).unwrap();
            let pid = r1
                .proposals
                .iter()
                .find(|p| p.action == "memory_strengthened")
                .unwrap()
                .proposal_id
                .clone();
            proposals::decide(
                brain,
                &pid,
                false,
                &std::collections::HashMap::new(),
                "dath",
                Some("not meaningful"),
            )
            .unwrap();

            // identical evidence -> never regenerated
            let r2 = run_proposal(&scope).unwrap();
            assert!(r2.proposals.is_empty());
            assert!(r2
                .notes
                .iter()
                .any(|n| n.contains(&pid) && n.contains("Rejected")));

            // NEW evidence (another completed task citing same engram)
            let mut done2 = Event::now(brain, "task_completed", "task", "t-r2");
            done2.title = Some("Ship deck v2".into());
            done2.source_refs = vec!["engram-r".into()];
            append(&done2).unwrap();
            let r3 = run_proposal(&scope).unwrap();
            let newp: Vec<_> = r3
                .proposals
                .iter()
                .filter(|p| p.action == "memory_strengthened")
                .collect();
            assert_eq!(newp.len(), 1);
            assert_ne!(newp[0].proposal_id, pid, "new evidence, new id");
            let stored = proposals::get(brain, &newp[0].proposal_id).unwrap();
            assert_eq!(
                stored.predecessor.as_deref(),
                Some(pid.as_str()),
                "linked to the rejected predecessor"
            );
        });
    }

    /// Review events never become fresh source evidence (no loops).
    #[test]
    fn consolidation_ignores_its_own_events() {
        with_temp_home(|| {
            let brain = "cloop";
            let scope = Scope::brain(brain);
            let mut ev = Event::now(brain, "consolidation_approved", "proposal", "p-x");
            ev.capture_method = "review".into();
            append(&ev).unwrap();
            let r = run_proposal(&scope).unwrap();
            assert!(r.proposals.is_empty(), "review events are not evidence");
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
