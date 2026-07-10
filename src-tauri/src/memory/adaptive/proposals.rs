//! Proposal store — consolidation stage 2 (adaptive spec §12b).
//!
//! Proposals are how NeuroVault EARNS permission to learn: every
//! interpretation becomes a reviewable object whose every field cites
//! evidence, whose review decisions are journal events, and whose
//! lifecycle the Inspector can render without ambiguity:
//!
//!   proposed → approved            (untouched approval)
//!            → edited_approved     (both values retained)
//!            → rejected            (never regenerated from the same
//!                                   evidence; new evidence links back)
//!            → superseded          (a newer proposal replaced it)
//!   awaiting_evidence              (incomplete unit; late outcomes
//!                                   must not be skipped)
//!
//! Storage: `proposals.jsonl` per brain — append-only records reduced
//! to latest-state-per-proposal_id on read (the todos.jsonl pattern).
//! Appending a decision is paired with a journal event; the store is
//! DERIVED state, the journal is the truth. Atomicity with the
//! consolidation watermark comes from ordering + idempotence: store
//! appends happen before watermark advance, and replaying the overlap
//! regenerates identical deterministic proposal_ids that reduce to
//! no-ops — at-least-once processing, exactly-once effect.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::memory::types::MemoryError;

type Result<T> = std::result::Result<T, MemoryError>;

/// One proposed field with ITS OWN evidence — "every proposed field
/// has evidence, not merely the proposal as a whole".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProposedField {
    pub name: String,
    pub proposed_value: String,
    /// Set on edited approvals; both values are retained forever.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved_value: Option<String>,
    pub evidence: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProposalStatus {
    Proposed,
    Approved,
    EditedApproved,
    Rejected,
    Superseded,
    AwaitingEvidence,
}

/// The stored proposal record. Appended on creation and on every
/// status transition; reads reduce to the latest record per id.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredProposal {
    pub proposal_id: String,
    pub brain_id: String,
    pub action: String,
    pub memory_type: String,
    pub object_id: String,
    pub title: String,
    pub reason: String,
    pub band: String, // high | medium | low
    pub fields: Vec<ProposedField>,
    /// Evidence for the proposal as a whole (union of field evidence
    /// plus unit-level events).
    pub evidence: Vec<String>,
    pub status: ProposalStatus,
    pub proposed_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decided_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decided_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision_reason: Option<String>,
    /// Rejected predecessor this proposal supersedes (new evidence →
    /// new proposal, clearly linked).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub predecessor: Option<String>,
    /// True when the approval also executed a write (stage-2 applies
    /// only demonstrably safe classes; the rest acknowledge-only).
    #[serde(default)]
    pub applied: bool,
}

fn store_path(brain_id: &str) -> PathBuf {
    crate::memory::paths::nv_home()
        .join("brains")
        .join(brain_id)
        .join("proposals.jsonl")
}

/// Append one record (single-syscall line append, same discipline as
/// the journal).
pub fn append(brain_id: &str, rec: &StoredProposal) -> Result<()> {
    let path = store_path(brain_id);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| MemoryError::Other(format!("proposals dir: {e}")))?;
    }
    let mut buf = serde_json::to_string(rec)
        .map_err(|e| MemoryError::Other(format!("proposal serialize: {e}")))?
        .into_bytes();
    buf.push(b'\n');
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| MemoryError::Other(format!("proposals open: {e}")))?;
    f.write_all(&buf)
        .map_err(|e| MemoryError::Other(format!("proposals write: {e}")))?;
    Ok(())
}

/// Latest state per proposal_id (reduce-on-read; corrupt lines skipped).
pub fn load_all(brain_id: &str) -> HashMap<String, StoredProposal> {
    let mut out: HashMap<String, StoredProposal> = HashMap::new();
    let Ok(raw) = fs::read_to_string(store_path(brain_id)) else {
        return out;
    };
    for line in raw.lines() {
        if let Ok(rec) = serde_json::from_str::<StoredProposal>(line) {
            out.insert(rec.proposal_id.clone(), rec);
        }
    }
    out
}

pub fn get(brain_id: &str, proposal_id: &str) -> Option<StoredProposal> {
    load_all(brain_id).remove(proposal_id)
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_default()
}

/// Record a review decision: appends the transition to the store AND
/// journals it (approve/reject are experiences). Idempotent: deciding
/// an already-decided proposal in the same direction is a no-op
/// (concurrent approvals must not double-apply); flipping a decision
/// is rejected — corrections are new proposals, not edits of history.
pub fn decide(
    brain_id: &str,
    proposal_id: &str,
    approve: bool,
    edits: &HashMap<String, String>,
    reviewer: &str,
    reason: Option<&str>,
) -> Result<(StoredProposal, bool)> {
    let mut rec = get(brain_id, proposal_id)
        .ok_or_else(|| MemoryError::Other(format!("unknown proposal {proposal_id}")))?;
    let target = if approve {
        if edits.is_empty() {
            ProposalStatus::Approved
        } else {
            ProposalStatus::EditedApproved
        }
    } else {
        ProposalStatus::Rejected
    };
    match rec.status {
        ProposalStatus::Proposed | ProposalStatus::AwaitingEvidence => {}
        existing if existing == target => return Ok((rec, false)), // idempotent
        existing => {
            return Err(MemoryError::Other(format!(
                "proposal {proposal_id} already {existing:?}; decisions are immutable — new evidence makes a NEW proposal"
            )));
        }
    }
    // Field edits retain BOTH values.
    for f in rec.fields.iter_mut() {
        if let Some(v) = edits.get(&f.name) {
            f.approved_value = Some(v.clone());
        }
    }
    for name in edits.keys() {
        if !rec.fields.iter().any(|f| &f.name == name) {
            return Err(MemoryError::Other(format!(
                "edit targets unknown field '{name}'"
            )));
        }
    }
    rec.status = target;
    rec.decided_at = Some(now_iso());
    rec.decided_by = Some(reviewer.to_string());
    rec.decision_reason = reason.map(String::from);
    append(brain_id, &rec)?;

    // The decision is itself an experience — but consolidation must
    // never consume its own review events as source evidence (loop
    // guard lives in the collector: capture_method == "review").
    let mut ev = crate::memory::journal::Event::now(
        brain_id,
        if approve {
            "consolidation_approved"
        } else {
            "consolidation_rejected"
        },
        "proposal",
        proposal_id,
    );
    ev.actor = format!("user:{reviewer}");
    ev.title = Some(rec.title.clone());
    ev.after = Some(format!("{:?}", rec.status));
    ev.source_refs = rec.evidence.clone();
    ev.capture_method = "review".into();
    ev.idempotency_key = Some(format!(
        "decide-{proposal_id}-{}",
        if approve { "approve" } else { "reject" }
    ));
    crate::memory::journal::record(ev);
    Ok((rec, true))
}

/// Review-quality metrics — more than approval rate, per Dath: a
/// system can hit impressive precision by proposing almost nothing,
/// so unreviewed counts and audited false negatives are first-class.
#[derive(Debug, Default, Serialize)]
pub struct Metrics {
    pub total: usize,
    pub proposed: usize,
    pub awaiting_evidence: usize,
    pub approved_untouched: usize,
    pub approved_after_edits: usize,
    pub rejected: usize,
    pub superseded: usize,
    pub field_edit_rate: f64,
    pub rejection_rate: f64,
    pub median_review_seconds: Option<i64>,
    /// action → (approved, rejected) — precision per proposal type.
    pub by_action: HashMap<String, (usize, usize)>,
    /// band → (approved, rejected).
    pub by_band: HashMap<String, (usize, usize)>,
    /// Human-audited misses (journal consolidation_false_negative).
    pub audited_false_negatives: usize,
}

pub fn metrics(brain_id: &str) -> Metrics {
    let all = load_all(brain_id);
    let mut m = Metrics {
        total: all.len(),
        ..Metrics::default()
    };
    let mut review_secs: Vec<i64> = Vec::new();
    let mut edited_fields = 0usize;
    let mut total_fields = 0usize;
    for p in all.values() {
        total_fields += p.fields.len();
        edited_fields += p
            .fields
            .iter()
            .filter(|f| f.approved_value.is_some())
            .count();
        match p.status {
            ProposalStatus::Proposed => m.proposed += 1,
            ProposalStatus::AwaitingEvidence => m.awaiting_evidence += 1,
            ProposalStatus::Approved => m.approved_untouched += 1,
            ProposalStatus::EditedApproved => m.approved_after_edits += 1,
            ProposalStatus::Rejected => m.rejected += 1,
            ProposalStatus::Superseded => m.superseded += 1,
        }
        let decided = matches!(
            p.status,
            ProposalStatus::Approved | ProposalStatus::EditedApproved | ProposalStatus::Rejected
        );
        if decided {
            let e = m.by_action.entry(p.action.clone()).or_default();
            let b = m.by_band.entry(p.band.clone()).or_default();
            if p.status == ProposalStatus::Rejected {
                e.1 += 1;
                b.1 += 1;
            } else {
                e.0 += 1;
                b.0 += 1;
            }
            if let (Ok(a), Some(Ok(d))) = (
                OffsetDateTime::parse(&p.proposed_at, &Rfc3339),
                p.decided_at
                    .as_deref()
                    .map(|d| OffsetDateTime::parse(d, &Rfc3339)),
            ) {
                review_secs.push((d - a).whole_seconds());
            }
        }
    }
    let decided_n = m.approved_untouched + m.approved_after_edits + m.rejected;
    if decided_n > 0 {
        m.rejection_rate = m.rejected as f64 / decided_n as f64;
    }
    if total_fields > 0 {
        m.field_edit_rate = edited_fields as f64 / total_fields as f64;
    }
    if !review_secs.is_empty() {
        review_secs.sort();
        m.median_review_seconds = Some(review_secs[review_secs.len() / 2]);
    }
    // audited false negatives live in the journal (this month + last).
    let now = OffsetDateTime::now_utc();
    m.audited_false_negatives =
        crate::memory::journal::read_window(brain_id, now - time::Duration::days(60), now, None)
            .iter()
            .filter(|e| e.event_type == "consolidation_false_negative")
            .count();
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_temp_home<F: FnOnce()>(f: F) {
        let _guard = crate::memory::journal::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let home = std::env::temp_dir().join(format!(
            "nv-proposals-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("NEUROVAULT_HOME", &home);
        f();
        std::env::remove_var("NEUROVAULT_HOME");
        let _ = std::fs::remove_dir_all(&home);
    }

    fn fixture(id: &str) -> StoredProposal {
        StoredProposal {
            proposal_id: id.into(),
            brain_id: "ptest".into(),
            action: "supersession_suggestion".into(),
            memory_type: "engram".into(),
            object_id: "e-old".into(),
            title: "Pricing draft v1".into(),
            reason: "colliding titles".into(),
            band: "medium".into(),
            fields: vec![ProposedField {
                name: "superseded_by".into(),
                proposed_value: "e-new".into(),
                approved_value: None,
                evidence: vec!["ev-1".into(), "ev-2".into()],
            }],
            evidence: vec!["ev-1".into(), "ev-2".into()],
            status: ProposalStatus::Proposed,
            proposed_at: now_iso(),
            decided_at: None,
            decided_by: None,
            decision_reason: None,
            predecessor: None,
            applied: false,
        }
    }

    #[test]
    fn decide_is_idempotent_immutable_and_retains_both_values() {
        with_temp_home(|| {
            let b = "ptest";
            append(b, &fixture("p1")).unwrap();

            // edited approval retains proposed AND approved values
            let mut edits = HashMap::new();
            edits.insert("superseded_by".to_string(), "e-newer".to_string());
            let (rec, changed) = decide(b, "p1", true, &edits, "dath", None).unwrap();
            assert!(changed);
            assert_eq!(rec.status, ProposalStatus::EditedApproved);
            assert_eq!(rec.fields[0].proposed_value, "e-new");
            assert_eq!(rec.fields[0].approved_value.as_deref(), Some("e-newer"));

            // concurrent/repeated approval: idempotent no-op
            let (_, changed2) = decide(b, "p1", true, &edits, "dath", None).unwrap();
            assert!(!changed2, "second identical decision is a no-op");

            // flipping the decision is refused — history is immutable
            let err = decide(b, "p1", false, &HashMap::new(), "dath", None);
            assert!(err.is_err());

            // unknown field edit is refused
            append(b, &fixture("p2")).unwrap();
            let mut bad = HashMap::new();
            bad.insert("nope".to_string(), "x".to_string());
            assert!(decide(b, "p2", true, &bad, "dath", None).is_err());

            // decisions journaled with capture_method=review (loop guard)
            let now = OffsetDateTime::now_utc();
            let evs =
                crate::memory::journal::read_window(b, now - time::Duration::hours(1), now, None);
            let reviews: Vec<_> = evs
                .iter()
                .filter(|e| e.event_type == "consolidation_approved")
                .collect();
            assert_eq!(reviews.len(), 1);
            assert_eq!(reviews[0].capture_method, "review");
        });
    }

    #[test]
    fn metrics_track_more_than_approval_rate() {
        with_temp_home(|| {
            let b = "ptest";
            append(b, &fixture("m1")).unwrap();
            append(b, &fixture("m2")).unwrap();
            append(b, &fixture("m3")).unwrap();
            decide(b, "m1", true, &HashMap::new(), "dath", None).unwrap();
            let mut edits = HashMap::new();
            edits.insert("superseded_by".into(), "x".into());
            decide(b, "m2", true, &edits, "dath", None).unwrap();
            decide(b, "m3", false, &HashMap::new(), "dath", Some("wrong pair")).unwrap();

            let m = metrics(b);
            assert_eq!(m.total, 3);
            assert_eq!(m.approved_untouched, 1);
            assert_eq!(m.approved_after_edits, 1);
            assert_eq!(m.rejected, 1);
            assert!((m.rejection_rate - 1.0 / 3.0).abs() < 1e-9);
            assert!(m.field_edit_rate > 0.0);
            assert!(m.median_review_seconds.is_some());
            let sup = m.by_action.get("supersession_suggestion").unwrap();
            assert_eq!(*sup, (2, 1));
        });
    }
}
