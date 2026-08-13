//! Unit-eligibility allowlist — feedback-loop isolation (guide §2.7,
//! spec §17, slice A7).
//!
//! Evidence selection is an **allowlist over lineage and source role**,
//! never a blacklist of bad event names. Curator output, review
//! decisions, consolidation output and unknown emitters are ineligible
//! *by construction*, so a future event type cannot accidentally become
//! curator input — the property red-team family #19 exists to prove.
//!
//! Two independent barriers, in this order:
//!
//! 1. **Derived-state markers.** Anything carrying curator lineage —
//!    `capture_method: "curator"`, a `curator_` event-type prefix, the
//!    synthetic `curator/<claim_key>` object, or a
//!    `derived_from:curator:<pid>` source ref (the lineage the post-V1
//!    executor stamps on its `note_created` events, spec §6.7) — is
//!    rejected *even if it otherwise matches the allowlist*. A forged
//!    or replayed event cannot launder itself into a unit.
//! 2. **The allowlist.** Only the handful of (event_type,
//!    capture_method) shapes the turn correlation actually produces are
//!    eligible. Missing lineage never defaults to eligible; an unknown
//!    future emitter fails closed.
//!
//! Journal events carry no `DerivationMetadata` yet (spec §17 proposes
//! adding it). Until they do, the markers above ARE the durable
//! lineage, and the allowlist is what makes their absence safe: nothing
//! is eligible unless it is named here. When `derivation` lands on
//! `journal::Event`, this module gains an origin check and
//! `LINEAGE_POLICY_VERSION` is bumped — no caller changes.
//!
//! Pure and IO-free: the runner calls [`retain_eligible`] on the window
//! it read, then hands the survivors to unit assembly.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::memory::journal::Event;

pub const LINEAGE_POLICY_VERSION: u32 = 1;
pub const CURATOR_CAPTURE_METHOD: &str = "curator";
pub const CURATOR_EVENT_PREFIX: &str = "curator_";
pub const CONSOLIDATION_EVENT_PREFIX: &str = "consolidation_";
pub const REVIEW_CAPTURE_METHOD: &str = "review";
pub const DERIVED_FROM_CURATOR_PREFIX: &str = "derived_from:curator:";
pub const CURATOR_OBJECT_PREFIX: &str = "curator/";
pub const SENSITIVE_PRIVACY_LABEL: &str = "sensitive";

pub const ELIGIBLE_SHAPES: &[(&str, &str)] = &[
    ("context_decision", "ambient"),
    ("assistant_response_completed", "hook"),
    ("assistant_response_completed", "endpoint"),
    ("session_ended", "hook"),
    ("session_ended", "endpoint"),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IneligibleReason {
    CuratorDerived,
    ConsolidationDerived,
    ReviewDerived,
    SensitiveLabel,
    NotAllowlisted,
}

impl IneligibleReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CuratorDerived => "curator_derived",
            Self::ConsolidationDerived => "consolidation_derived",
            Self::ReviewDerived => "review_derived",
            Self::SensitiveLabel => "sensitive_label",
            Self::NotAllowlisted => "not_allowlisted",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Eligibility {
    Eligible,
    Ineligible(IneligibleReason),
}

impl Eligibility {
    pub fn is_eligible(self) -> bool {
        matches!(self, Self::Eligible)
    }

    pub fn reason(self) -> Option<IneligibleReason> {
        match self {
            Self::Eligible => None,
            Self::Ineligible(r) => Some(r),
        }
    }
}

/// Does this event carry curator lineage? Checked BEFORE the
/// allowlist, so a curator artifact wearing an allowlisted shape is
/// still excluded.
pub fn is_curator_derived(e: &Event) -> bool {
    e.capture_method == CURATOR_CAPTURE_METHOD
        || e.event_type.starts_with(CURATOR_EVENT_PREFIX)
        || e.object_id.starts_with(CURATOR_OBJECT_PREFIX)
        || e.source_refs
            .iter()
            .any(|r| r.starts_with(DERIVED_FROM_CURATOR_PREFIX))
}

/// Eligibility with an attributable reason — the audit records WHY a
/// candidate event never became evidence, so silence is explained.
pub fn classify(e: &Event) -> Eligibility {
    if is_curator_derived(e) {
        return Eligibility::Ineligible(IneligibleReason::CuratorDerived);
    }
    // Review decisions first: `consolidation_approved` arrives with
    // `capture_method: "review"` and is a human decision, not a
    // consolidation artifact.
    if e.capture_method == REVIEW_CAPTURE_METHOD {
        return Eligibility::Ineligible(IneligibleReason::ReviewDerived);
    }
    if e.event_type.starts_with(CONSOLIDATION_EVENT_PREFIX) {
        return Eligibility::Ineligible(IneligibleReason::ConsolidationDerived);
    }
    // `journal::append` already drops sensitive events; a legacy or
    // hand-edited line must not slip past at read time.
    if e.privacy_label
        .as_deref()
        .is_some_and(|l| l.eq_ignore_ascii_case(SENSITIVE_PRIVACY_LABEL))
    {
        return Eligibility::Ineligible(IneligibleReason::SensitiveLabel);
    }
    if ELIGIBLE_SHAPES
        .iter()
        .any(|(t, c)| *t == e.event_type && *c == e.capture_method)
    {
        Eligibility::Eligible
    } else {
        Eligibility::Ineligible(IneligibleReason::NotAllowlisted)
    }
}

/// The guide's §2.7 predicate, kept as the one-line form callers use.
pub fn event_eligible(e: &Event) -> bool {
    classify(e).is_eligible()
}

/// Borrowing filter, for callers that keep the full window.
pub fn eligible_events(events: &[Event]) -> Vec<&Event> {
    events.iter().filter(|e| event_eligible(e)).collect()
}

/// In-place filter — what the runner calls on a `read_window` result
/// before unit assembly.
pub fn retain_eligible(events: &mut Vec<Event>) {
    events.retain(event_eligible);
}

/// Exclusion counts by reason, for the run audit's notes. Deterministic
/// order (BTreeMap), and reasons only — never event ids or content.
pub fn ineligible_counts(events: &[Event]) -> BTreeMap<&'static str, usize> {
    let mut counts = BTreeMap::new();
    for e in events {
        if let Some(reason) = classify(e).reason() {
            *counts.entry(reason.as_str()).or_insert(0) += 1;
        }
    }
    counts
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::adaptive::consolidate::group_units;

    fn ev(event_id: &str, event_type: &str, capture_method: &str) -> Event {
        Event {
            event_id: event_id.to_string(),
            event_type: event_type.to_string(),
            capture_method: capture_method.to_string(),
            ts: "2026-08-12T02:00:00Z".to_string(),
            brain_id: "lineage-test".to_string(),
            session_id: Some("sess-1".to_string()),
            ..Event::default()
        }
    }

    fn owned(events: &[Event]) -> Vec<Event> {
        eligible_events(events).into_iter().cloned().collect()
    }

    /// The §6.2 worked example: the two events a real turn produces.
    fn worked_example_turn() -> Vec<Event> {
        let mut open = ev("ev_ctx_7f21", "context_decision", "ambient");
        open.turn_id = Some("ev_ctx_7f21".into());
        let mut stop = ev("ev_stop_9c44", "assistant_response_completed", "hook");
        stop.turn_id = Some("ev_ctx_7f21".into());
        vec![open, stop]
    }

    // --- red-team family #19 ----------------------------------------------

    #[test]
    fn family_19_curator_output_recycled_as_evidence_yields_zero_units() {
        let mut run = ev("ev_cur_1", "curator_run_completed", CURATOR_CAPTURE_METHOD);
        run.turn_id = Some("ev_cur_1".into());
        let mut deferral = ev("ev_cur_2", "curator_unit_deferred", CURATOR_CAPTURE_METHOD);
        deferral.turn_id = Some("ev_cur_2".into());
        let mut approved = ev("ev_rev_1", "consolidation_approved", REVIEW_CAPTURE_METHOD);
        approved.turn_id = Some("ev_rev_1".into());

        let stream = vec![run, deferral, approved];
        let survivors = owned(&stream);
        assert!(
            survivors.is_empty(),
            "no curator/review-derived event is eligible"
        );
        assert!(
            group_units(&survivors).is_empty(),
            "family #19: zero units form from curator-derived evidence"
        );
        assert_eq!(
            ineligible_counts(&stream),
            BTreeMap::from([("curator_derived", 2), ("review_derived", 1)]),
            "and the exclusion is attributable in the audit"
        );
    }

    #[test]
    fn family_19_curator_output_cannot_join_the_turn_it_derived_from() {
        // The nastiest shape: a curator event correlated to the very turn
        // it was extracted from would otherwise land in that unit.
        let mut stream = worked_example_turn();
        let mut echo = ev("ev_cur_3", "curator_run_completed", CURATOR_CAPTURE_METHOD);
        echo.turn_id = Some("ev_ctx_7f21".into());
        stream.push(echo);

        let units = group_units(&owned(&stream));
        assert_eq!(units.len(), 1);
        assert_eq!(units[0].event_ids, vec!["ev_ctx_7f21", "ev_stop_9c44"]);
        assert!(!units[0].event_ids.iter().any(|id| id == "ev_cur_3"));
    }

    #[test]
    fn a_derived_from_curator_marker_beats_an_allowlisted_shape() {
        // A perfectly-shaped event that is nonetheless curator output —
        // e.g. the post-V1 executor's note_created lineage, or a forged
        // replay. The marker wins.
        let mut forged = ev("ev_fake", "assistant_response_completed", "hook");
        forged
            .source_refs
            .push("derived_from:curator:3f8c2a94d1e07b56".into());
        assert!(is_curator_derived(&forged));
        assert_eq!(
            classify(&forged),
            Eligibility::Ineligible(IneligibleReason::CuratorDerived)
        );

        let mut synthetic = ev("ev_fake2", "assistant_response_completed", "hook");
        synthetic.object_id = "curator/7d2e91c40b5aa318".into();
        assert!(is_curator_derived(&synthetic));
        assert!(!event_eligible(&synthetic));
    }

    #[test]
    fn note_created_is_never_eligible_even_from_a_hook() {
        // Belt and suspenders for the post-V1 executor (§6.7).
        let mut note = ev("ev_note", "note_created", "hook");
        note.source_refs
            .push("derived_from:curator:3f8c2a94d1e07b56".into());
        assert!(!event_eligible(&note));
        let plain = ev("ev_note2", "note_created", "hook");
        assert_eq!(
            classify(&plain),
            Eligibility::Ineligible(IneligibleReason::NotAllowlisted)
        );
    }

    // --- the allowlist itself ---------------------------------------------

    #[test]
    fn the_worked_example_turn_is_eligible_and_forms_one_unit() {
        let stream = worked_example_turn();
        assert!(stream.iter().all(event_eligible));
        let units = group_units(&owned(&stream));
        assert_eq!(units.len(), 1);
        assert_eq!(units[0].unit_id, "ev_ctx_7f21");
        assert_eq!(units[0].event_ids.len(), 2);
    }

    #[test]
    fn every_allowlisted_shape_is_eligible() {
        for (event_type, capture_method) in ELIGIBLE_SHAPES {
            let e = ev("ev_x", event_type, capture_method);
            assert!(
                event_eligible(&e),
                "{event_type}/{capture_method} is on the allowlist"
            );
        }
    }

    #[test]
    fn an_unknown_future_emitter_fails_closed() {
        // Right event type, wrong capture method; right capture method,
        // unknown event type; and a shape nobody has invented yet.
        for (event_type, capture_method) in [
            ("assistant_response_completed", "ingest"),
            ("context_decision", "hook"),
            ("prompt_observed", "ambient"),
            ("agent_dreamed", "quantum"),
            ("", ""),
        ] {
            let e = ev("ev_x", event_type, capture_method);
            assert_eq!(
                classify(&e),
                Eligibility::Ineligible(IneligibleReason::NotAllowlisted),
                "missing lineage never defaults to eligible: {event_type}/{capture_method}"
            );
        }
    }

    #[test]
    fn consolidation_output_is_ineligible_by_lineage_not_by_name_list() {
        let e = ev("ev_c", "consolidation_report_written", "system");
        assert_eq!(
            classify(&e),
            Eligibility::Ineligible(IneligibleReason::ConsolidationDerived)
        );
    }

    #[test]
    fn sensitive_events_are_ineligible_even_when_allowlisted() {
        let mut e = ev("ev_s", "assistant_response_completed", "hook");
        e.privacy_label = Some(SENSITIVE_PRIVACY_LABEL.into());
        assert_eq!(
            classify(&e),
            Eligibility::Ineligible(IneligibleReason::SensitiveLabel)
        );
        let mut normal = ev("ev_n", "assistant_response_completed", "hook");
        normal.privacy_label = Some("normal".into());
        assert!(event_eligible(&normal));
    }

    #[test]
    fn retain_eligible_filters_in_place_for_the_runner() {
        let mut stream = worked_example_turn();
        stream.push(ev(
            "ev_cur",
            "curator_run_completed",
            CURATOR_CAPTURE_METHOD,
        ));
        retain_eligible(&mut stream);
        assert_eq!(stream.len(), 2);
        assert!(stream.iter().all(event_eligible));
    }
}
