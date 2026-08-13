//! Run orchestration (guide §1, §2.6, §3.5; spec §13–§17).
//!
//! This module owns the *only* path from a journal turn to a review
//! card: unit assembly under the lineage allowlist, prefix
//! re-verification, the impure materialization that feeds the pure
//! gauntlet, the `VerifiedDraft` → [`StoredProposal`] converter, and the
//! durable write ordering. Every rule it enforces was built and tested
//! in an earlier wave; the runner's job is to compose them in the one
//! order that keeps the guarantees true, and to record what it did.
//!
//! The order (guide §1, and the reason for each step):
//!
//! 1. **Consent** — both switches in `local_curator.json`, read through
//!    the single loader in [`evidence::consent`]. Disabled is a
//!    *recorded* skip, never silence.
//! 2. **Lock** — [`lock::try_acquire_brain_run`]; the second caller
//!    loses immediately rather than queueing behind a 45-minute batch.
//! 3. **Ledger** — load, then `expire_overdue` FIRST, so a TTL expiry is
//!    audited before anything else can advance past it.
//! 4. **Units** — journal window → [`lineage::eligible_events`] → group
//!    by `turn_id` → ledger key (spec §16's 4-tuple).
//! 5. **Evidence** — [`transcript::reopen_verified`] per reference
//!    (prefix re-verification; `PrefixMismatch` ⇒ defer, never a read of
//!    newer bytes) → parse → [`segment::enumerate`] → render.
//! 6. **Provider** — one [`provider::ProviderSession`] per run, started
//!    lazily so a night with nothing to do never loads a 30B model.
//! 7. **Gauntlet + persistence** — [`gates::verify_candidate`] against a
//!    real [`gates::UnitContext`], then survivors become
//!    `StoredProposal`s with `ApplicationStatus::NotApplicable`
//!    (review-only by construction).
//! 8. **Commit** — [`state::commit_unit`] per unit (audit → retry state
//!    → ledger, watermark pinned on audit failure), then the run-level
//!    watermark advance and a verified model unload.
//!
//! **Parser scope, decided (V1).** The runner does **not** content-filter
//! `<system-reminder>` blocks (or any other injected framing) inside
//! non-`isMeta` user records. Role forgery — an assistant suggestion or
//! an injected instruction dressed as a user decision — is caught
//! downstream by G04 (server-derived role must equal the claimed role,
//! plus correlated-evidence anchors) and G07 (attribution binding),
//! which is red-team family 15's assigned defence. Filtering transcript
//! *content* would change the sanitized bytes, hence
//! `segment_content_sha256`, hence every `SpanIdentity` and ledger key
//! derived from it — so it is a `PARSER_V2` decision with its own replay
//! tests, not something to sneak into the runner. See
//! [`assemble_units`].

use std::collections::{BTreeMap, HashMap};
use std::fmt;

use serde::Serialize;
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};

use super::super::lock;
use super::super::proposals::{
    self, ApplicationStatus, ProposedField, ReviewStatus, StoredProposal,
};
use super::gates::{Disposition, VerifiedDraft};
use super::receipts::CuratorExtension;
use super::state::{CuratorLedger, CuratorRunAudit, NoProposalReason, UnitKey, UnitOutcome};
use super::transcript::{ParsedRecord, PrefixReadError};
use super::{
    evidence, gates, identity, lineage, policy, prompt, provider, receipts, segment, state,
    transcript,
};
use crate::memory::journal::{
    read_window, Event, EvidenceCaptureReceipt, EvidenceCaptureStatus, EvidenceReference,
};
use crate::memory::types::MemoryError;

type Result<T> = std::result::Result<T, MemoryError>;

// ---------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------

/// Replayed behind the watermark on every run, so an outcome that
/// arrives late still finds its opening decision (`consolidate.rs`'s
/// `GRACE_HOURS`, same reasoning, deliberately a separate constant in a
/// separate file — the two pipelines must not couple).
pub const GRACE_HOURS: i64 = 48;

/// How far back a brain with no watermark looks on its first run.
pub const COLD_START_DAYS: i64 = 7;

/// The preflight canary unit (guide §4.3, spec §18): a fixed, rendered,
/// six-sentence known-answer unit whose gold output is exactly one
/// decision citing `S3`. It is *rendered* text, not a transcript — the
/// canary must never touch the user's files.
pub const CANARY_UNIT: &str = "S1 [user]: Morning, quick status check.\n\
S2 [assistant]: The nightly build finished at 03:12 and all tests passed.\n\
S3 [user]: From now on we move deploys to Tuesday.\n\
S4 [assistant]: Understood, I will update the release checklist.\n\
S5 [user]: Thanks, that is all for now.\n\
S6 [assistant]: Anything else you need?\n";

/// The sentence IDs the canary's gold answer may cite.
pub const CANARY_EVIDENCE_IDS: &[&str] = &["S3"];

// ---------------------------------------------------------------------
// report
// ---------------------------------------------------------------------

/// How a run ended. Every variant is a *recorded* outcome — there is no
/// "nothing happened" the Inspector cannot explain.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    /// Every eligible unit reached a terminal per-unit outcome.
    Completed,
    /// Consent (or the enabled flag) is off: units were marked
    /// `SkippedDisabled` and no backlog was created (spec §16).
    SkippedDisabled,
    /// No eligible unit needed processing.
    NoUnits,
    /// Preflight failed. No unit was generated and the watermark did not
    /// move (guide §4.3).
    ProviderUnavailable,
    /// The batch stopped on its own budget (wall clock, unit cap, or a
    /// run-fatal provider fault). Unprocessed units stay `Pending` and
    /// run tomorrow.
    BudgetExhausted,
}

/// One run, summarized for the Inspector and the manual-run response.
/// Safe to serialize: counts, codes and IDs only — no prompt, response,
/// quote or path.
#[derive(Debug, Clone, Serialize)]
pub struct CuratorRunReport {
    pub run_id: String,
    pub brain_id: String,
    pub status: RunStatus,
    pub started_at: String,
    pub finished_at: String,
    pub window_start: String,
    pub window_end: String,
    pub events_read: usize,
    pub units_eligible: usize,
    pub units_processed: usize,
    pub units_skipped: usize,
    pub units_deferred: usize,
    pub units_expired: usize,
    pub candidates_seen: usize,
    pub proposals_created: usize,
    pub proposals_deduped: usize,
    pub candidates_rejected: usize,
    /// `Some(false)` means the model was still resident when the run
    /// gave up polling — surfaced, never assumed away.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unload_verified: Option<bool>,
    /// Why the watermark is pinned, when it is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub watermark_blocked: Option<String>,
    pub notes: Vec<String>,
}

impl CuratorRunReport {
    fn new(run_id: &str, brain_id: &str, started: OffsetDateTime) -> Self {
        let stamp = fmt_ts(started);
        Self {
            run_id: run_id.to_string(),
            brain_id: brain_id.to_string(),
            status: RunStatus::NoUnits,
            started_at: stamp.clone(),
            finished_at: stamp.clone(),
            window_start: stamp.clone(),
            window_end: stamp,
            events_read: 0,
            units_eligible: 0,
            units_processed: 0,
            units_skipped: 0,
            units_deferred: 0,
            units_expired: 0,
            candidates_seen: 0,
            proposals_created: 0,
            proposals_deduped: 0,
            candidates_rejected: 0,
            unload_verified: None,
            watermark_blocked: None,
            notes: Vec::new(),
        }
    }

    fn note(&mut self, note: impl Into<String>) {
        self.notes.push(note.into());
    }
}

/// A run refusal the caller must distinguish. `Busy` is the only reason
/// an HTTP caller gets a 409 rather than a 500 — it is not a failure, it
/// is somebody else already holding the brain.
#[derive(Debug)]
pub enum RunError {
    Busy(lock::BrainRunBusy),
    Memory(MemoryError),
}

impl fmt::Display for RunError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RunError::Busy(b) => write!(f, "{b}"),
            RunError::Memory(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for RunError {}

impl From<MemoryError> for RunError {
    fn from(e: MemoryError) -> Self {
        RunError::Memory(e)
    }
}

// ---------------------------------------------------------------------
// unit assembly
// ---------------------------------------------------------------------

/// One curator unit: a complete turn whose Stop event actually captured
/// transcript evidence, and every event of which passed the lineage
/// allowlist.
///
/// Assembled from the journal alone — no transcript byte has been read
/// at this point, which is what lets a consent-off run still *record*
/// what it skipped.
#[derive(Debug, Clone)]
pub struct CuratorUnit {
    /// The opening `context_decision`'s event_id
    /// (`consolidate::ExperienceUnit::unit_id`).
    pub unit_id: String,
    pub brain_id: String,
    pub session_id: Option<String>,
    /// Project label from the events, for the review card's copy.
    pub project: Option<String>,
    pub room: Option<String>,
    pub event_ids: Vec<String>,
    /// The `assistant_response_completed` carrying the reference below.
    pub evidence_event_id: String,
    pub reference: EvidenceReference,
    pub first_cursor: state::JournalCursor,
    pub first_event_ts: String,
    pub last_event_ts: String,
}

impl CuratorUnit {
    /// `(prefix_sha256, observed_prefix_len)` — the two coordinates
    /// every span is stamped with.
    fn prefix(&self) -> (&str, u64) {
        let EvidenceReference::Transcript {
            observed_prefix_len,
            source_prefix_sha256,
            ..
        } = &self.reference;
        (source_prefix_sha256.as_str(), *observed_prefix_len)
    }

    /// The spec §16 ledger key: `(unit_id, evidence_digest,
    /// policy_epoch)`, brain-scoped by the file the ledger lives in.
    ///
    /// `evidence_digest` is computed from the **pinned evidence
    /// reference** (its prefix digest and length) plus the parser,
    /// redaction and segmenter versions — not from the resolved sentence
    /// table. Deliberate: a unit whose transcript vanished, or which was
    /// skipped with consent off, must still have exactly one stable key,
    /// and a sentence table cannot be built without reading bytes. A
    /// segmenter or parser bump still mints a new key, because those
    /// versions are inputs to the digest.
    pub fn key(&self) -> UnitKey {
        let (sha, len) = self.prefix();
        let digest = state::evidence_digest(&state::EvidenceDigestInput {
            segment_identities: &[format!("{sha}:{len}")],
            parser_version: transcript::PARSER_VERSION,
            redaction_policy_version: transcript::REDACTION_POLICY_VERSION,
            segmenter_version: segment::SEGMENTER_VERSION,
            evidence_policy: state::EVIDENCE_POLICY_V1,
        });
        UnitKey::new(&self.unit_id, &digest, policy::POLICY_EPOCH)
    }
}

/// Group eligible events into curator units.
///
/// Three independent conditions, each of which drops a turn *visibly*
/// (the returned notes carry the counts):
///
/// - **lineage** — [`lineage::eligible_events`] runs first, so curator,
///   review and consolidation output can never enter a unit. It is an
///   allowlist over (event_type, capture_method) plus derivation, not a
///   blacklist of bad names (red-team family 19).
/// - **correlation** — `turn_id`, never timestamp proximity. Events with
///   no `turn_id` (session-scoped) are not curator units.
/// - **evidence** — the turn must carry an `assistant_response_completed`
///   whose `evidence_capture.status == Captured` *and* a transcript
///   reference. `Disabled`/`Ineligible` receipts are a normal,
///   receipted, skipped state, not a retryable failure (guide §2.6).
///
/// Note what is deliberately absent: any inspection of record *content*.
/// A `<system-reminder>` block inside a user record stays in the
/// sanitized bytes and is enumerated like any other sentence; forging a
/// user decision out of it dies at G04/G07 with a code, which is a
/// receipt a content filter could never produce. Changing that is
/// `PARSER_V2` (see the module docs).
pub fn assemble_units(brain_id: &str, events: &[Event]) -> (Vec<CuratorUnit>, Vec<String>) {
    let mut notes = Vec::new();
    for (reason, count) in lineage::ineligible_counts(events) {
        notes.push(format!("{count} event(s) ineligible: {reason}"));
    }

    let mut by_turn: BTreeMap<&str, Vec<&Event>> = BTreeMap::new();
    for e in lineage::eligible_events(events) {
        let Some(turn) = e.turn_id.as_deref() else {
            continue;
        };
        by_turn.entry(turn).or_default().push(e);
    }

    let mut units = Vec::new();
    let mut without_evidence = 0usize;
    for (turn, mut group) in by_turn {
        group.sort_by(|a, b| (&a.ts, a.seq).cmp(&(&b.ts, b.seq)));
        let outcome = group.iter().find(|e| {
            e.event_type == "assistant_response_completed"
                && matches!(
                    e.evidence_capture,
                    Some(EvidenceCaptureReceipt {
                        status: EvidenceCaptureStatus::Captured,
                        ..
                    })
                )
                && !e.evidence_refs.is_empty()
        });
        let Some(outcome) = outcome else {
            without_evidence += 1;
            continue;
        };
        let first = group[0];
        let last = group[group.len() - 1];
        units.push(CuratorUnit {
            unit_id: turn.to_string(),
            brain_id: brain_id.to_string(),
            session_id: group.iter().find_map(|e| e.session_id.clone()),
            project: group.iter().find_map(|e| e.title.clone()),
            room: group.iter().find_map(|e| e.room.clone()),
            event_ids: group.iter().map(|e| e.event_id.clone()).collect(),
            evidence_event_id: outcome.event_id.clone(),
            reference: outcome.evidence_refs[0].clone(),
            first_cursor: state::JournalCursor::from_event(first),
            first_event_ts: first.ts.clone(),
            last_event_ts: last.ts.clone(),
        });
    }
    if without_evidence > 0 {
        notes.push(format!(
            "{without_evidence} turn(s) had no captured transcript evidence (receipted skip, not a retry)"
        ));
    }
    (units, notes)
}

// ---------------------------------------------------------------------
// the converter (spec §13.1, guide §3.5)
// ---------------------------------------------------------------------

/// Bounded, char-boundary-safe preview for the card title.
fn truncate(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let kept: String = s.chars().take(max_chars.saturating_sub(1)).collect();
    format!("{kept}…")
}

/// `VerifiedDraft` → `StoredProposal`, constructed directly (spec §13.1).
///
/// The model authors `statement` and `subject` and nothing else: action,
/// object, band, title and reason are all server-derived here, and the
/// identity is the spec-form [`identity::proposal_id`] over the field
/// values and their span identities — never the run id, the model or the
/// prompt (a model upgrade must not duplicate a proposal).
///
/// `application_status` is [`ApplicationStatus::NotApplicable`]: V1 is
/// review-only *and says so on the card*, rather than showing a Pending
/// write no executor will ever perform.
pub fn to_stored(
    draft: &VerifiedDraft,
    unit: &CuratorUnit,
    disposition: Disposition,
    ext: CuratorExtension,
    brain_id: &str,
) -> StoredProposal {
    let spans = draft.span_identities();
    let memory_type = "engram";
    let proposal_id = identity::proposal_id(&identity::ProposalIdentityInput {
        policy_epoch: policy::POLICY_EPOCH,
        brain_id,
        action: draft.action,
        memory_type,
        resolved_object: &draft.resolved_object,
        fields: &[
            identity::ProposalIdentityField {
                name: "statement",
                proposed_value: &draft.statement,
                spans: &spans,
            },
            identity::ProposalIdentityField {
                name: "subject",
                proposed_value: &draft.subject,
                spans: &spans,
            },
        ],
    });
    let field = |name: &str, value: &str| ProposedField {
        name: name.to_string(),
        proposed_value: value.to_string(),
        approved_value: None,
        evidence: unit.event_ids.clone(),
    };
    StoredProposal {
        proposal_id,
        brain_id: brain_id.to_string(),
        action: draft.action.to_string(),
        memory_type: memory_type.to_string(),
        object_id: draft.resolved_object.clone(),
        title: format!("Remember: {}", truncate(&draft.statement, 60)),
        reason: format!(
            "Extracted from your {} session; every value verified against the transcript ({} gates).",
            unit.project.as_deref().unwrap_or("recent"),
            ext.verification.gates.len()
        ),
        // No curator proposal is ever `high` (spec §13.1): band is
        // review prioritization, not model confidence.
        band: match disposition {
            Disposition::ProposalReady => "medium",
            _ => "low",
        }
        .to_string(),
        fields: vec![
            field("statement", &draft.statement),
            field("subject", &draft.subject),
        ],
        // JOURNAL EVENT IDS — the seam the existing evidence Disclosure
        // already resolves. The stronger proof rides in `curator`.
        evidence: unit.event_ids.clone(),
        review_status: ReviewStatus::Unreviewed,
        application_status: ApplicationStatus::NotApplicable,
        application_error: None,
        proposed_at: fmt_ts(OffsetDateTime::now_utc()),
        decided_at: None,
        decided_by: None,
        decision_reason: None,
        predecessor: None,
        curator: Some(ext),
    }
}

/// The receipt bundle that rides on the proposal.
fn extension(
    unit: &CuratorUnit,
    draft: &VerifiedDraft,
    generation: &receipts::GenerationReceipt,
    verification: receipts::VerificationReceipt,
    review_codes: &[gates::ReviewCode],
) -> CuratorExtension {
    CuratorExtension {
        ext_version: receipts::EXT_VERSION,
        unit_id: unit.unit_id.clone(),
        claim_class: draft.claim_class.as_str().to_string(),
        source_role: draft.source_role,
        primary: draft.primary.clone(),
        context: draft.context.clone(),
        evidence_key: draft.evidence_key.clone(),
        claim_key: draft.claim_key.clone(),
        generation: generation.clone(),
        verification,
        review_codes: review_codes
            .iter()
            .map(|c| c.as_str().to_string())
            .collect(),
    }
}

// ---------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------

fn fmt_ts(t: OffsetDateTime) -> String {
    t.format(&Rfc3339).unwrap_or_default()
}

/// Everything a unit needs from the transcript, materialized once.
struct Prepared {
    records: Vec<ParsedRecord>,
    skipped_records: u32,
}

/// Re-open, re-verify and parse a unit's pinned prefix.
///
/// The digest check happens inside [`transcript::reopen_verified`] over
/// exactly `observed_prefix_len` bytes; a mismatch returns
/// `PrefixMismatch` and never bytes.
fn prepare(reference: &EvidenceReference) -> std::result::Result<Prepared, PrefixReadError> {
    let verified = transcript::reopen_verified(reference)?;
    let parsed = transcript::parse_prefix(&verified);
    Ok(Prepared {
        records: parsed.records,
        skipped_records: parsed.skipped_records,
    })
}

/// Existing state for G11, read once per run from the proposal store and
/// the tombstone log.
fn existing_state(brain_id: &str, store: &HashMap<String, StoredProposal>) -> gates::ExistingState {
    let mut existing =
        gates::ExistingState::default().with_tombstones(&identity::tombstones(brain_id));
    for rec in store.values() {
        let Some(ext) = &rec.curator else {
            continue;
        };
        if rec.review_status == ReviewStatus::Rejected {
            // A rejected curator proposal must never come back — not
            // reworded, not after a model upgrade. The tombstone log is
            // the record of that; until the review UI writes it (Wave
            // 3B), the store is authoritative for the rejections it
            // already holds, so both feed G11.
            existing
                .tombstoned_evidence_keys
                .insert(ext.evidence_key.clone());
        } else {
            existing
                .proposal_evidence_keys
                .insert(ext.evidence_key.clone());
            existing.claim_keys.insert(ext.claim_key.clone());
        }
    }
    existing
}

/// Map a `reopen_verified` failure to its unit outcome and audit reason.
fn evidence_failure(e: PrefixReadError) -> (UnitOutcome, NoProposalReason, &'static str) {
    match e {
        // The bound evidence moved: defer and let the retry budget
        // decide. Never a silent read of the newer bytes.
        PrefixReadError::PrefixMismatch => (
            UnitOutcome::Deferred(state::CuratorErrorCode::EvidenceUnavailable),
            NoProposalReason::EvidenceUnavailable,
            "transcript prefix no longer matches the captured digest",
        ),
        PrefixReadError::SourceUnavailable => (
            UnitOutcome::Deferred(state::CuratorErrorCode::EvidenceUnavailable),
            NoProposalReason::EvidenceUnavailable,
            "transcript source unavailable at replay time",
        ),
        PrefixReadError::ConsentRevoked => (
            UnitOutcome::SkippedDisabled,
            NoProposalReason::CuratorDisabled,
            "transcript access revoked between the consent gate and the read",
        ),
        PrefixReadError::PlatformUnsupported => (
            UnitOutcome::SkippedDisabled,
            NoProposalReason::CuratorDisabled,
            "transcript reads are unix-only in V1 (fails closed elsewhere)",
        ),
    }
}

/// Tombstone the evidence keys of every proposal this unit produced,
/// once its evidence is gone for good. Called when a deferral exhausts
/// the retry budget: the card can no longer show its evidence, so the
/// claim must never be regenerated from it either.
fn tombstone_vanished_unit(brain_id: &str, unit_id: &str, store: &HashMap<String, StoredProposal>) {
    for rec in store.values() {
        let Some(ext) = &rec.curator else { continue };
        if ext.unit_id != unit_id {
            continue;
        }
        let _ = identity::record_evidence_vanished(
            brain_id,
            &ext.evidence_key,
            Some(&ext.claim_key),
            Some(&rec.proposal_id),
        );
    }
}

/// The gate-visible projection of a unit. Every field is server-stamped;
/// nothing here can be widened by model output.
fn unit_context(unit: &CuratorUnit) -> gates::UnitContext {
    let (sha, len) = unit.prefix();
    let mut ctx = gates::UnitContext::new(&unit.unit_id, &unit.brain_id);
    ctx.room_id = unit.room.clone();
    ctx.evidence_event_id = unit.evidence_event_id.clone();
    ctx.transcript_prefix_sha256 = sha.to_string();
    ctx.observed_prefix_len = len;
    ctx
}

/// Link a rejected predecessor with the same (action, object), exactly
/// like `consolidate::run_proposal` does.
fn link_predecessor(
    mut rec: StoredProposal,
    store: &HashMap<String, StoredProposal>,
) -> StoredProposal {
    rec.predecessor = store
        .values()
        .find(|sp| {
            sp.review_status == ReviewStatus::Rejected
                && sp.action == rec.action
                && sp.object_id == rec.object_id
        })
        .map(|sp| sp.proposal_id.clone());
    rec
}

/// Provider failure → the audit's no-proposal reason.
fn provider_reason(e: &provider::ProviderError) -> NoProposalReason {
    match e.error_code() {
        state::CuratorErrorCode::ProviderTimeout => NoProposalReason::ProviderTimeout,
        state::CuratorErrorCode::InvalidResponse => NoProposalReason::MalformedOutput,
        state::CuratorErrorCode::PolicyRejected => NoProposalReason::UnitOverBudget,
        state::CuratorErrorCode::EvidenceUnavailable => NoProposalReason::EvidenceUnavailable,
        state::CuratorErrorCode::AttemptsExhausted => NoProposalReason::AttemptsExhausted,
        state::CuratorErrorCode::ProviderUnavailable => NoProposalReason::ProviderUnavailable,
    }
}

// ---------------------------------------------------------------------
// in-flight registry
// ---------------------------------------------------------------------

/// A run executing right now.
///
/// The audit ledger only gains a line when a *unit* finishes, so a long
/// batch would otherwise be invisible for minutes. The runs feed joins
/// this in, which is what lets a caller start a run, get its id back
/// immediately, and poll for it.
#[derive(Debug, Clone, Serialize)]
pub struct InFlightRun {
    pub run_id: String,
    pub brain_id: String,
    pub started_at: String,
    /// Always `"running"` — a row exists only while one is.
    pub status: &'static str,
}

static IN_FLIGHT_RUNS: std::sync::Mutex<BTreeMap<String, InFlightRun>> =
    std::sync::Mutex::new(BTreeMap::new());

fn in_flight_runs() -> std::sync::MutexGuard<'static, BTreeMap<String, InFlightRun>> {
    // Poison-tolerant, like every other registry here: one panicking run
    // must not wedge the feed forever.
    IN_FLIGHT_RUNS.lock().unwrap_or_else(|p| p.into_inner())
}

/// The run currently executing for this brain, if any.
pub fn in_flight_run(brain_id: &str) -> Option<InFlightRun> {
    in_flight_runs().get(brain_id).cloned()
}

/// RAII: the row disappears when the run ends, panics included.
struct InFlightGuard(String);

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        in_flight_runs().remove(&self.0);
    }
}

/// One nightly (or manual) run for one brain, with a fresh run id.
pub async fn run_brain(brain_id: &str) -> std::result::Result<CuratorRunReport, RunError> {
    run_brain_with_id(brain_id, &state::new_run_id()).await
}

/// One run, with a caller-chosen run id.
///
/// The id is a parameter so an HTTP caller can hand it back *before* the
/// run finishes — a batch is ~87 s per unit, far past any sensible
/// request timeout, so the manual endpoint returns the id and the caller
/// polls the audit feed for it.
///
/// Async because generation is; every other step is small synchronous
/// file IO on the brain's own directory. Returns [`RunError::Busy`] —
/// having written nothing at all — when another proposal run holds the
/// brain.
pub async fn run_brain_with_id(
    brain_id: &str,
    run_id: &str,
) -> std::result::Result<CuratorRunReport, RunError> {
    let started = OffsetDateTime::now_utc();
    let run_id = run_id.to_string();
    let mut report = CuratorRunReport::new(&run_id, brain_id, started);

    // 1. Consent, decided by the single loader. The *decision* precedes
    //    every file read below; recording the skips needs the ledger, so
    //    that happens under the lock.
    let enabled = evidence::consent().both_switches();

    // 2. Single-flight per brain — shared with deterministic
    //    consolidation, because both write the same proposal store.
    let _guard = lock::try_acquire_brain_run(brain_id).ok_or_else(|| {
        RunError::Busy(lock::BrainRunBusy {
            brain_id: brain_id.to_string(),
        })
    })?;
    // Visible for the whole run, gone on the way out — panics included.
    in_flight_runs().insert(
        brain_id.to_string(),
        InFlightRun {
            run_id: run_id.clone(),
            brain_id: brain_id.to_string(),
            started_at: fmt_ts(started),
            status: "running",
        },
    );
    let _in_flight = InFlightGuard(brain_id.to_string());

    let retry = state::RetryPolicy::default();
    let mut ledger = CuratorLedger::load(brain_id);

    // 3. TTL expiry FIRST, and audited: an expired unit is a visible
    //    orphan, never a silent watermark skip (spec §16).
    for key in ledger.expire_overdue(started) {
        let audit = CuratorRunAudit::new(&run_id, brain_id, &key, started)
            .with_no_proposal_reason(NoProposalReason::UnitExpired)
            .note("unit expired before a terminal outcome (TTL)")
            .finished_at(OffsetDateTime::now_utc());
        state::commit_unit(
            brain_id,
            &mut ledger,
            &key,
            audit,
            UnitOutcome::Expired,
            &retry,
            started,
        )?;
        report.units_expired += 1;
    }

    // 4. Units.
    let window_start = ledger.window_start(
        started,
        Duration::hours(GRACE_HOURS),
        Duration::days(COLD_START_DAYS),
    );
    report.window_start = fmt_ts(window_start);
    report.window_end = fmt_ts(started);
    let events = read_window(brain_id, window_start, started, None);
    report.events_read = events.len();
    let (units, notes) = assemble_units(brain_id, &events);
    for note in notes {
        report.note(note);
    }
    report.units_eligible = units.len();

    let mut store = proposals::load_all(brain_id);
    let mut session: Option<provider::ProviderSession> = None;
    let mut budget_stop = false;
    let mut preflight_failed = false;

    for unit in &units {
        let key = unit.key();
        ledger.observe(
            &key,
            brain_id,
            unit.first_cursor.clone(),
            &unit.last_event_ts,
            &retry,
            started,
        );
        if !ledger.needs_processing(&key, started) {
            continue;
        }
        let audit = CuratorRunAudit::new(&run_id, brain_id, &key, OffsetDateTime::now_utc());

        // 1 (continued). Consent off: record the intentional skip and
        // build no backlog. The unit is terminal, so enabling the
        // curator tomorrow curates tomorrow's turns, not last month's.
        if !enabled {
            let audit = audit
                .with_no_proposal_reason(NoProposalReason::CuratorDisabled)
                .note("curator disabled by consent; skip recorded, no backlog")
                .finished_at(OffsetDateTime::now_utc());
            state::commit_unit(
                brain_id,
                &mut ledger,
                &key,
                audit,
                UnitOutcome::SkippedDisabled,
                &retry,
                started,
            )?;
            report.units_skipped += 1;
            continue;
        }

        // 5. Evidence: re-open, re-verify, parse.
        let prepared = match prepare(&unit.reference) {
            Ok(p) => p,
            Err(e) => {
                let (outcome, reason, note) = evidence_failure(e);
                let audit = audit
                    .with_no_proposal_reason(reason)
                    .note(note)
                    .finished_at(OffsetDateTime::now_utc());
                state::commit_unit(brain_id, &mut ledger, &key, audit, outcome, &retry, started)?;
                match outcome {
                    UnitOutcome::SkippedDisabled => report.units_skipped += 1,
                    _ => report.units_deferred += 1,
                }
                // Retries exhausted ⇒ the evidence is gone for good, so
                // anything already proposed from it is tombstoned.
                if ledger
                    .get(&key)
                    .is_some_and(|u| u.status == state::CuratorUnitStatus::ExpiredVisible)
                {
                    tombstone_vanished_unit(brain_id, &unit.unit_id, &store);
                    report.note(format!(
                        "unit {} exhausted its retries with unreadable evidence; tombstoned",
                        unit.unit_id
                    ));
                }
                report.note(format!("unit {}: {note}", unit.unit_id));
                continue;
            }
        };
        if prepared.records.is_empty() {
            let audit = audit
                .with_no_proposal_reason(NoProposalReason::NoCandidates)
                .note("no parseable user/assistant records in the pinned prefix")
                .finished_at(OffsetDateTime::now_utc());
            state::commit_unit(
                brain_id,
                &mut ledger,
                &key,
                audit,
                UnitOutcome::Completed,
                &retry,
                started,
            )?;
            report.units_processed += 1;
            continue;
        }

        // 6. Provider — started lazily, so a night with nothing to
        //    curate never loads a model.
        if session.is_none() {
            let file = provider::LocalCuratorFile::load();
            let cfg = match file.provider() {
                Ok(cfg) => cfg.clone(),
                Err(e) => {
                    preflight_failed = true;
                    report.note(format!("provider not configured: {}", e.code()));
                    break;
                }
            };
            let canary = provider::CanarySpec {
                system: prompt::SYSTEM_MESSAGE,
                user: CANARY_UNIT,
                schema: &prompt::OUTPUT_SCHEMA,
                expected_evidence_ids: CANARY_EVIDENCE_IDS,
            };
            match provider::ProviderSession::start(&cfg, provider::client(&cfg), &canary).await {
                Ok(s) => session = Some(s),
                Err(e) => {
                    // Preflight failure aborts the run whatever its
                    // mid-batch disposition would be: no unit was
                    // generated, so the watermark must not move.
                    preflight_failed = true;
                    report.note(format!("preflight failed: {}", e.code()));
                    break;
                }
            }
        }
        let Some(active) = session.as_mut() else {
            break;
        };
        if active.deadline_exceeded() || active.unit_budget_spent() {
            budget_stop = true;
            break;
        }

        // Sub-units: `split_units` keeps every envelope under the
        // 150-sentence cap, splitting only at record boundaries. One
        // generation per sub-unit, all recorded under this unit's key.
        let ranges = segment::split_units(&prepared.records);
        let attempts = ledger.get(&key).map(|u| u.attempts).unwrap_or(0);
        let mut audit = audit;
        let mut unit_outcome = UnitOutcome::Completed;
        let mut recorded_any = false;
        if prepared.skipped_records > 0 {
            audit = audit.note(format!(
                "{} unsupported record(s) skipped by PARSER_V1",
                prepared.skipped_records
            ));
        }
        if ranges.len() > 1 {
            audit = audit.note(format!(
                "unit split into {} sub-units at the sentence cap",
                ranges.len()
            ));
        }

        for (index, range) in ranges.iter().enumerate() {
            let sub = &prepared.records[range.clone()];
            let table = segment::enumerate(sub);
            if table.sentences.is_empty() {
                continue;
            }
            if index == 0 {
                audit = audit.with_sentence_table(&table)?;
            }
            let user = prompt::render_user_message(sub, &table);
            let request = provider::UnitRequest {
                system: prompt::SYSTEM_MESSAGE,
                user: &user,
                schema: &prompt::OUTPUT_SCHEMA,
                // Retries at temperature 0 must not reproduce the same
                // failure byte for byte.
                seed: u64::from(attempts) + index as u64,
                output_schema_version: prompt::CURATOR_OUTPUT_SCHEMA,
                estimate_tokens: &prompt::estimate_tokens,
            };
            let reply = match active.chat_unit(request).await {
                Ok(reply) => reply,
                Err(e) => {
                    unit_outcome = e
                        .unit_outcome()
                        .unwrap_or(UnitOutcome::Deferred(e.error_code()));
                    audit = audit
                        .with_no_proposal_reason(provider_reason(&e))
                        .note(format!("provider: {}", e.code()));
                    recorded_any = true;
                    if matches!(
                        e.disposition(),
                        provider::Disposition::RunAbort | provider::Disposition::RunFault
                    ) {
                        budget_stop = true;
                    }
                    break;
                }
            };
            if index == 0 {
                audit = audit.with_generation(&reply.generation)?;
            }

            // 7. The gauntlet. G00 is called directly rather than
            //    through `verify_envelope` for one reason: the audit
            //    line hashes the per-candidate bytes, and only the
            //    decoded envelope has them.
            let unit_ctx = unit_context(unit);
            let allowed_object = gates::AllowedObject {
                brain_id: brain_id.to_string(),
                room_id: unit.room.clone(),
            };
            let existing = existing_state(brain_id, &store);
            let ctx = gates::VerificationContext {
                unit: &unit_ctx,
                records: sub,
                table: &table,
                existing: &existing,
                allowed_actions: &policy::CURATOR_ACTIONS,
                allowed_object: &allowed_object,
                // V1 ships no entailment scorer, so G10 records
                // `not_run` — recorded, never silently skipped.
                nli_configured: false,
            };
            let envelope_sha = state::candidate_sha256(reply.raw_json.as_bytes());
            let candidates = match gates::g00_validate_output_envelope(reply.raw_json.as_bytes()) {
                Ok(envelope) => envelope.proposals,
                Err(code) => {
                    let outcome = gates::VerificationOutcome::envelope_rejected(code);
                    let receipt =
                        outcome.receipt(&envelope_sha, &fmt_ts(OffsetDateTime::now_utc()));
                    audit = audit.with_outcome(state::CandidateAuditOutcome::new(
                        reply.raw_json.as_bytes(),
                        outcome.disposition.into(),
                        &receipt,
                    )?);
                    recorded_any = true;
                    report.candidates_rejected += 1;
                    continue;
                }
            };
            if candidates.is_empty() {
                // `nothing_durable: true` with an empty list is the
                // model's only legal silence, and it is authoritative.
                audit = audit.with_no_proposal_reason(NoProposalReason::NoCandidates);
                recorded_any = true;
                continue;
            }

            for candidate in &candidates {
                report.candidates_seen += 1;
                let outcome = gates::verify_candidate(candidate, &ctx);
                let receipt = outcome.receipt(&envelope_sha, &fmt_ts(OffsetDateTime::now_utc()));
                let bytes = serde_json::to_vec(candidate)
                    .map_err(|e| MemoryError::Other(format!("candidate serialize: {e}")))?;
                let mut line = state::CandidateAuditOutcome::new(
                    &bytes,
                    outcome.disposition.into(),
                    &receipt,
                )?;

                if let Some(draft) = outcome.verified.as_ref() {
                    let ext = extension(
                        unit,
                        draft,
                        &reply.generation,
                        receipt,
                        &outcome.review_codes,
                    );
                    let rec = to_stored(draft, unit, outcome.disposition, ext, brain_id);
                    let pid = rec.proposal_id.clone();
                    if store.contains_key(&pid) {
                        // Replay: identical evidence and values hash to
                        // the same id, so this is a no-op, not a second
                        // card.
                        report.proposals_deduped += 1;
                    } else {
                        let rec = link_predecessor(rec, &store);
                        proposals::append(brain_id, &rec)?;
                        store.insert(pid.clone(), rec);
                        report.proposals_created += 1;
                    }
                    line = line.with_proposal_id(&pid);
                } else if outcome.disposition == Disposition::Rejected {
                    report.candidates_rejected += 1;
                }
                audit = audit.with_outcome(line);
                recorded_any = true;
            }
        }

        if !recorded_any {
            audit = audit.with_no_proposal_reason(NoProposalReason::NoCandidates);
        }
        let audit = audit.finished_at(OffsetDateTime::now_utc());
        // 8. Durable order: proposals were appended above, then the
        //    audit line, then retry state, then the ledger. An audit
        //    append failure pins the watermark rather than losing the
        //    unit.
        state::commit_unit(
            brain_id,
            &mut ledger,
            &key,
            audit,
            unit_outcome,
            &retry,
            started,
        )?;
        match unit_outcome {
            UnitOutcome::Completed => report.units_processed += 1,
            UnitOutcome::SkippedDisabled => report.units_skipped += 1,
            _ => report.units_deferred += 1,
        }
        if budget_stop {
            break;
        }
    }

    // The model is released before the run reports success — a
    // successful unload *request* proves nothing about residency.
    if let Some(mut active) = session {
        match active.finish().await {
            Ok(unload) => report.unload_verified = Some(unload.verified),
            Err(e) => {
                report.unload_verified = Some(false);
                report.note(format!("model unload unverified: {}", e.code()));
            }
        }
    }

    if preflight_failed {
        report.status = RunStatus::ProviderUnavailable;
        report.watermark_blocked = Some("provider preflight failed; window unchanged".to_string());
    } else {
        report.status = if !enabled {
            RunStatus::SkippedDisabled
        } else if budget_stop {
            RunStatus::BudgetExhausted
        } else if report.units_eligible == 0 {
            RunStatus::NoUnits
        } else {
            RunStatus::Completed
        };
        // The watermark moves only when the run actually worked the
        // window. Units observed but never reached stay `Pending`, and
        // `window_start` reaches back to the oldest of them.
        if let Err(blocked) = ledger.advance_watermark(started) {
            report.watermark_blocked = Some(blocked.reason.clone());
        }
    }
    if let Some(reason) = ledger.blocked_reason() {
        report.watermark_blocked = Some(reason.to_string());
    }
    ledger.save(brain_id)?;

    report.finished_at = fmt_ts(OffsetDateTime::now_utc());
    Ok(report)
}

// ---------------------------------------------------------------------
// span preview (read-only)
// ---------------------------------------------------------------------

/// One resolved sentence, re-derived from the transcript at view time.
#[derive(Debug, Clone, Serialize)]
pub struct PreviewSpan {
    pub role: String,
    pub record_index: u32,
    pub sentence_index: u32,
    pub text: String,
    /// True when the re-sliced bytes still hash to the stored
    /// `span_sha256`. False means the file drifted under a still-valid
    /// prefix — shown, never hidden.
    pub digest_matches: bool,
    pub primary: bool,
}

/// What the review card's evidence panel gets back.
#[derive(Debug, Clone, Serialize)]
pub struct SpanPreview {
    pub proposal_id: String,
    pub brain_id: String,
    pub available: bool,
    /// Safe code when `available` is false: `evidence_unavailable`,
    /// `consent_revoked`, `platform_unsupported`,
    /// `not_a_curator_proposal`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    pub spans: Vec<PreviewSpan>,
}

fn preview_code(e: PrefixReadError) -> &'static str {
    match e {
        PrefixReadError::PrefixMismatch | PrefixReadError::SourceUnavailable => {
            "evidence_unavailable"
        }
        PrefixReadError::ConsentRevoked => "consent_revoked",
        PrefixReadError::PlatformUnsupported => "platform_unsupported",
    }
}

/// Resolve a stored curator proposal's spans back to sentence text.
///
/// Read-only and re-verifying: the transcript is re-opened through the
/// same no-symlink machinery, the pinned prefix digest is re-checked,
/// and the sentences are re-sliced *server-side*. Transcript text is
/// never stored in the proposal, so when the file changed the panel says
/// so instead of showing bytes nobody verified.
pub fn preview_spans(brain_id: &str, proposal_id: &str) -> Result<SpanPreview> {
    let rec = proposals::get(brain_id, proposal_id)
        .ok_or_else(|| MemoryError::Other(format!("unknown proposal {proposal_id}")))?;
    let mut out = SpanPreview {
        proposal_id: proposal_id.to_string(),
        brain_id: brain_id.to_string(),
        available: false,
        code: None,
        spans: Vec::new(),
    };
    let Some(ext) = rec.curator.as_ref() else {
        out.code = Some("not_a_curator_proposal".to_string());
        return Ok(out);
    };

    // The reference lives on the journal event, never on the proposal: a
    // proposal must not carry a filesystem path.
    let now = OffsetDateTime::now_utc();
    let reference = read_window(brain_id, now - Duration::days(365), now, None)
        .into_iter()
        .find(|e| e.event_id == ext.primary.evidence_event_id)
        .and_then(|e| e.evidence_refs.first().cloned());
    let Some(reference) = reference else {
        out.code = Some("evidence_unavailable".to_string());
        return Ok(out);
    };

    let prepared = match prepare(&reference) {
        Ok(p) => p,
        Err(e) => {
            out.code = Some(preview_code(e).to_string());
            return Ok(out);
        }
    };

    let wanted: Vec<(&receipts::VerifiedSpan, bool)> = std::iter::once((&ext.primary, true))
        .chain(ext.context.iter().map(|s| (s, false)))
        .collect();
    for range in segment::split_units(&prepared.records) {
        let sub = &prepared.records[range];
        let table = segment::enumerate(sub);
        for (span, primary) in &wanted {
            let Some(sentence) = table.sentences.iter().find(|s| {
                s.record_index == span.record_index && s.sentence_index == span.sentence_index
            }) else {
                continue;
            };
            let Some(resolved) = segment::resolve(sub, &table, sentence.sid) else {
                continue;
            };
            out.spans.push(PreviewSpan {
                role: sentence.role.render_label().to_string(),
                record_index: sentence.record_index,
                sentence_index: sentence.sentence_index,
                text: resolved.text.to_string(),
                digest_matches: resolved.span_sha256 == span.span_sha256,
                primary: *primary,
            });
        }
    }
    if out.spans.is_empty() {
        out.code = Some("evidence_unavailable".to_string());
        return Ok(out);
    }
    out.spans
        .sort_by_key(|s| (!s.primary, s.record_index, s.sentence_index));
    out.available = true;
    Ok(out)
}

// ---------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------

// Unix-only for the same reason the reader is: without handle-relative
// traversal there is no transcript read to test.
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use axum::extract::State as AxState;
    use axum::response::IntoResponse;
    use axum::routing::{get, post};
    use axum::{Json, Router};
    use std::collections::VecDeque;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    use crate::memory::journal::{
        append, ApprovedTranscriptRoot, EvidenceCaptureReceipt, EvidenceCaptureStatus,
    };

    const MODEL: &str = "qwen3:30b-a3b-instruct-2507-q4_K_M";
    const DIGEST: &str = "sha256:9f3c1e00000000000000000000000000000000000000000000000000000000ff";
    const BRAIN: &str = "NeuroVaultBrain1";
    const PROJECT: &str = "-Users-dath-code-atlas";
    const SESSION: &str = "f4a9c2e1-7b3d-4e08-9a51-2c6f8d0e4b17";

    /// The guide §6.1 session, byte for byte (the same fixture
    /// `segment.rs` and `prompt.rs` pin their golden tables against).
    const ATLAS: &str =
        include_str!("../../../../tests/fixtures/curator/unit_atlas_tuesday/transcript.jsonl");

    /// Guide §6.4 — what qwen3-30B actually returned: P1 correct, P2 the
    /// classic protected-token mutation (03:30 → 03:00).
    const ATLAS_REPLY: &str = r#"{"proposals":[{"type":"decision","statement":"Atlas deploys only on Tuesdays.","subject":"deployment","evidence":["S1"],"source_role":"user"},{"type":"fact","statement":"The staging cron runs at 03:00 UTC.","subject":"operations","evidence":["S6"],"source_role":"assistant"}],"nothing_durable":false}"#;

    /// The canary's gold answer: one decision citing S3.
    const CANARY_GOLD: &str = r#"{"proposals":[{"type":"decision","statement":"Deploys move to Tuesday.","subject":"deploys","evidence":["S3"],"source_role":"user"}],"nothing_durable":false}"#;

    // ───────────────── the mock Ollama (in-process axum) ─────────────

    #[derive(Default)]
    struct MockState {
        /// Scripted `/api/chat` bodies. The last one repeats, so a test
        /// only scripts what it cares about.
        chat: Mutex<VecDeque<(u16, String)>>,
        requests: Mutex<Vec<serde_json::Value>>,
        resident: Mutex<bool>,
    }

    impl MockState {
        fn script(self: &Arc<Self>, status: u16, body: String) -> &Arc<Self> {
            self.chat.lock().unwrap().push_back((status, body));
            self
        }

        /// Drop whatever is left of the previous run's script, so the
        /// next run's warm-up does not consume it.
        fn reset(self: &Arc<Self>) -> &Arc<Self> {
            self.chat.lock().unwrap().clear();
            self
        }

        /// Warm-up + canary: the prelude every run pays before unit 1.
        fn preflight_ok(self: &Arc<Self>) -> &Arc<Self> {
            self.script(200, ok_chat(r#"{"proposals":[],"nothing_durable":true}"#));
            self.script(200, ok_chat(CANARY_GOLD))
        }

        /// Generation calls only — warm-up, canary and the unload are
        /// excluded, so a test can assert "the model was never asked".
        fn generations(&self) -> usize {
            self.requests
                .lock()
                .unwrap()
                .iter()
                .filter(|r| {
                    r.get("format").is_some()
                        && r["messages"][1]["content"]
                            .as_str()
                            .is_some_and(|c| c.contains("S1 [user]:"))
                        && !r["messages"][1]["content"]
                            .as_str()
                            .is_some_and(|c| c.contains("Morning, quick status check"))
                })
                .count()
        }
    }

    fn ok_chat(content: &str) -> String {
        serde_json::json!({
            "model": MODEL,
            "message": { "role": "assistant", "content": content },
            "done": true,
            "done_reason": "stop",
            "prompt_eval_count": 900,
            "prompt_eval_duration": 1_000_000_000u64,
            "eval_count": 64,
            "eval_duration": 1_000_000_000u64,
            "load_duration": 0,
            "total_duration": 2_000_000_000u64,
        })
        .to_string()
    }

    struct MockOllama {
        base: String,
        handle: tokio::task::JoinHandle<()>,
    }

    impl Drop for MockOllama {
        fn drop(&mut self) {
            self.handle.abort();
        }
    }

    async fn mock_ollama(state: Arc<MockState>) -> MockOllama {
        let app = Router::new()
            .route(
                "/api/version",
                get(|| async { Json(serde_json::json!({ "version": "0.9.3" })) }),
            )
            .route(
                "/api/tags",
                get(|| async {
                    Json(serde_json::json!({
                        "models": [{ "name": MODEL, "model": MODEL, "digest": DIGEST }]
                    }))
                }),
            )
            .route(
                "/api/show",
                post(|| async {
                    Json(serde_json::json!({
                        "capabilities": ["completion", "thinking"],
                        "model_info": { "qwen3.context_length": 32768 },
                    }))
                }),
            )
            .route("/api/chat", post(h_chat))
            .route("/api/ps", get(h_ps))
            .with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        MockOllama {
            base: format!("http://127.0.0.1:{port}"),
            handle,
        }
    }

    async fn h_chat(
        AxState(st): AxState<Arc<MockState>>,
        Json(body): Json<serde_json::Value>,
    ) -> axum::response::Response {
        st.requests.lock().unwrap().push(body.clone());
        let unload = body.get("keep_alive").and_then(|v| v.as_str()) == Some("0");
        *st.resident.lock().unwrap() = !unload;
        if unload {
            return Json(serde_json::json!({ "done": true })).into_response();
        }
        let script = {
            let mut q = st.chat.lock().unwrap();
            if q.len() > 1 {
                q.pop_front().unwrap()
            } else {
                q.front()
                    .cloned()
                    .unwrap_or((200, ok_chat(r#"{"proposals":[],"nothing_durable":true}"#)))
            }
        };
        (
            axum::http::StatusCode::from_u16(script.0).unwrap(),
            script.1,
        )
            .into_response()
    }

    async fn h_ps(AxState(st): AxState<Arc<MockState>>) -> axum::response::Response {
        let models = if *st.resident.lock().unwrap() {
            vec![serde_json::json!({ "name": MODEL, "model": MODEL, "digest": DIGEST })]
        } else {
            Vec::new()
        };
        Json(serde_json::json!({ "models": models })).into_response()
    }

    // ───────────────── the temp environment ─────────────────

    /// A private `NEUROVAULT_HOME` + `CLAUDE_CONFIG_DIR`, canonicalized
    /// (macOS's `/var` is a symlink and the hardened reader refuses
    /// symlinked roots), under the shared home lock.
    struct Env {
        root: PathBuf,
        home: PathBuf,
        projects: PathBuf,
        prev_home: Option<std::ffi::OsString>,
        prev_claude: Option<std::ffi::OsString>,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl Env {
        fn new(name: &str) -> Self {
            let guard = crate::memory::journal::TEST_HOME_LOCK
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            let requested = std::env::temp_dir().join(format!(
                "nv-curator-runner-{name}-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&requested).unwrap();
            let root = std::fs::canonicalize(requested).unwrap();
            let home = root.join("nv-home");
            let claude = root.join("claude");
            let projects = claude.join("projects").join(PROJECT);
            std::fs::create_dir_all(&home).unwrap();
            std::fs::create_dir_all(&projects).unwrap();
            let prev_home = std::env::var_os("NEUROVAULT_HOME");
            let prev_claude = std::env::var_os("CLAUDE_CONFIG_DIR");
            std::env::set_var("NEUROVAULT_HOME", &home);
            std::env::set_var("CLAUDE_CONFIG_DIR", &claude);
            Env {
                root,
                home,
                projects,
                prev_home,
                prev_claude,
                _guard: guard,
            }
        }

        /// Write the transcript and return `(relative_path, prefix_len,
        /// prefix_sha256)`.
        fn transcript(&self, body: &str) -> (String, u64, String) {
            let path = self.projects.join(format!("{SESSION}.jsonl"));
            std::fs::write(&path, body).unwrap();
            (
                format!("{PROJECT}/{SESSION}.jsonl"),
                body.len() as u64,
                sha256_hex(body.as_bytes()),
            )
        }

        fn config(&self, enabled: bool, endpoint: Option<&str>) {
            let mut cfg = serde_json::json!({
                "enabled": enabled,
                "transcript_access": enabled,
            });
            if let Some(endpoint) = endpoint {
                cfg["provider"] = serde_json::json!({
                    "endpoint": endpoint,
                    "model": MODEL,
                    "num_ctx": 8192,
                    "num_predict": 512,
                    "timeout_warmup_secs": 10,
                    "timeout_first_unit_secs": 10,
                    "timeout_unit_secs": 10,
                    "timeout_control_secs": 5,
                });
            }
            std::fs::write(
                self.home.join("local_curator.json"),
                serde_json::to_string(&cfg).unwrap(),
            )
            .unwrap();
        }
    }

    impl Drop for Env {
        fn drop(&mut self) {
            match &self.prev_claude {
                Some(v) => std::env::set_var("CLAUDE_CONFIG_DIR", v),
                None => std::env::remove_var("CLAUDE_CONFIG_DIR"),
            }
            match &self.prev_home {
                Some(v) => std::env::set_var("NEUROVAULT_HOME", v),
                None => std::env::remove_var("NEUROVAULT_HOME"),
            }
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(bytes);
        format!("{:x}", h.finalize())
    }

    /// The two journal events slice 1 really writes for one turn
    /// (guide §6.2). Returns `(unit_id, evidence_event_id)`.
    fn journal_turn(relative: &str, len: u64, sha: &str) -> (String, String) {
        let mut ctx = Event::now(BRAIN, "context_decision", "prompt", "sha256:prompt");
        ctx.capture_method = "ambient".into();
        ctx.turn_id = Some(ctx.event_id.clone());
        ctx.session_id = Some(SESSION.into());
        ctx.host = Some("claude_code".into());
        ctx.title = Some("atlas".into());
        append(&ctx).unwrap();

        let mut stop = Event::now(BRAIN, "assistant_response_completed", "session", SESSION);
        stop.capture_method = "hook".into();
        stop.turn_id = Some(ctx.event_id.clone());
        stop.session_id = Some(SESSION.into());
        stop.host = Some("claude_code".into());
        stop.title = Some("atlas".into());
        stop.evidence_refs = vec![EvidenceReference::Transcript {
            root: ApprovedTranscriptRoot::ClaudeProjects,
            relative_path: relative.to_string(),
            observed_prefix_len: len,
            source_prefix_sha256: sha.to_string(),
        }];
        stop.evidence_capture = Some(EvidenceCaptureReceipt {
            status: EvidenceCaptureStatus::Captured,
            code: None,
        });
        append(&stop).unwrap();
        (ctx.event_id, stop.event_id)
    }

    fn proposal_lines() -> usize {
        std::fs::read_to_string(crate::memory::paths::brain_dir(BRAIN).join("proposals.jsonl"))
            .map(|raw| raw.lines().filter(|l| !l.trim().is_empty()).count())
            .unwrap_or(0)
    }

    // ───────────────── the worked example (guide §6) ─────────────────

    #[tokio::test]
    async fn worked_example_stores_p1_and_rejects_p2_at_g06() {
        let env = Env::new("atlas");
        let state = Arc::new(MockState::default());
        state.preflight_ok().script(200, ok_chat(ATLAS_REPLY));
        let ollama = mock_ollama(state).await;
        env.config(true, Some(&ollama.base));
        let (relative, len, sha) = env.transcript(ATLAS);
        let (unit_id, stop_id) = journal_turn(&relative, len, &sha);

        let report = run_brain(BRAIN).await.expect("run");

        // §6.5: two candidates in, one proposal out, one rejected.
        assert_eq!(report.status, RunStatus::Completed, "{report:?}");
        assert_eq!(report.units_eligible, 1);
        assert_eq!(report.units_processed, 1);
        assert_eq!(report.candidates_seen, 2);
        assert_eq!(report.proposals_created, 1);
        assert_eq!(report.candidates_rejected, 1);
        assert_eq!(report.unload_verified, Some(true));

        // §6.6: what lands in the store.
        let store = proposals::load_all(BRAIN);
        assert_eq!(store.len(), 1, "{store:?}");
        let rec = store.values().next().unwrap();
        assert_eq!(rec.action, "curator_remember_decision");
        assert_eq!(rec.memory_type, "engram");
        assert_eq!(rec.title, "Remember: Atlas deploys only on Tuesdays.");
        assert_eq!(rec.band, "medium");
        assert!(rec.reason.contains("atlas session"), "{}", rec.reason);
        assert!(rec.reason.contains("(12 gates)"), "{}", rec.reason);
        assert_eq!(rec.evidence, vec![unit_id.clone(), stop_id.clone()]);
        assert_eq!(rec.review_status, ReviewStatus::Unreviewed);
        // Review-only, made visible on the card.
        assert_eq!(rec.application_status, ApplicationStatus::NotApplicable);
        assert!(rec.predecessor.is_none());

        let fields: Vec<(&str, &str)> = rec
            .fields
            .iter()
            .map(|f| (f.name.as_str(), f.proposed_value.as_str()))
            .collect();
        assert_eq!(
            fields,
            vec![
                ("statement", "Atlas deploys only on Tuesdays."),
                ("subject", "deployment"),
            ]
        );
        for f in &rec.fields {
            assert_eq!(f.evidence, vec![unit_id.clone(), stop_id.clone()]);
            assert!(f.approved_value.is_none());
        }

        let ext = rec.curator.as_ref().expect("curator extension");
        assert_eq!(ext.ext_version, 1);
        assert_eq!(ext.unit_id, unit_id);
        assert_eq!(ext.claim_class, "decision");
        assert_eq!(ext.source_role, receipts::SourceRole::User);
        assert_eq!(rec.object_id, format!("curator/{}", ext.claim_key));
        assert!(ext.context.is_empty());
        assert!(ext.review_codes.is_empty());
        // The Primary span is S1: record 0, sentence 0, bytes 0..45.
        assert_eq!(ext.primary.evidence_event_id, stop_id);
        assert_eq!(ext.primary.record_index, 0);
        assert_eq!(ext.primary.sentence_index, 0);
        assert_eq!(ext.primary.start_byte, 0);
        assert_eq!(ext.primary.end_byte, 45);
        assert_eq!(ext.primary.role, receipts::SourceRole::User);
        assert_eq!(ext.primary.transcript_prefix_sha256, sha);
        assert_eq!(ext.primary.observed_prefix_len, len);
        assert_eq!(ext.primary.parser_version, transcript::PARSER_VERSION);
        assert_eq!(ext.primary.segmenter_version, segment::SEGMENTER_VERSION);
        // Generation receipt: hashes only, never prompt or response text.
        assert_eq!(ext.generation.provider, "ollama");
        assert_eq!(ext.generation.model_id, MODEL);
        assert_eq!(ext.generation.model_digest, DIGEST);
        assert_eq!(ext.generation.output_schema_version, 2);
        assert!(ext.is_safe(), "receipts must be free of unsafe strings");
        // The full twelve-record gate trail from §6.6, in order.
        let trail: Vec<(&str, receipts::GateOutcome)> = ext
            .verification
            .gates
            .iter()
            .map(|g| (g.gate.as_str(), g.effect))
            .collect();
        assert_eq!(
            trail,
            vec![
                ("g00_validate_output_envelope", receipts::GateOutcome::Pass),
                ("g01_resolve_allowed_object", receipts::GateOutcome::Pass),
                ("g02_resolve_allowed_evidence", receipts::GateOutcome::Pass),
                (
                    "g03_enforce_action_field_contract",
                    receipts::GateOutcome::Pass
                ),
                (
                    "g04_enforce_scope_and_source_policy",
                    receipts::GateOutcome::Pass
                ),
                ("g05_enforce_atomic_claim", receipts::GateOutcome::Pass),
                ("g06_verify_lexical_integrity", receipts::GateOutcome::Pass),
                (
                    "g07_verify_attribution_binding",
                    receipts::GateOutcome::Pass
                ),
                (
                    "g08_verify_polarity_modality_and_time",
                    receipts::GateOutcome::Pass
                ),
                ("g09_screen_sensitive_content", receipts::GateOutcome::Pass),
                ("g10_score_entailment", receipts::GateOutcome::NotRun),
                ("g11_check_existing_state", receipts::GateOutcome::Pass),
            ]
        );
        assert_eq!(ext.verification.policy_epoch, policy::POLICY_EPOCH);
        assert!(ext.verification.nli.is_none());

        // §6.5 P2: rejected at G06 with the exact code, audit line only.
        let audits = state::read_audit(BRAIN);
        assert_eq!(audits.len(), 1, "{audits:?}");
        let audit = &audits[0];
        assert_eq!(audit.unit_id, unit_id);
        assert_eq!(audit.unit_status, state::CuratorUnitStatus::Completed);
        assert!(audit.generation.is_some());
        assert!(audit.sentence_table.is_some());
        assert_eq!(audit.outcomes.len(), 2);
        let ready = audit
            .outcomes
            .iter()
            .find(|o| o.outcome == state::AuditOutcomeKind::ProposalReady)
            .expect("P1 recorded");
        assert_eq!(ready.proposal_id.as_deref(), Some(rec.proposal_id.as_str()));
        let rejected = audit
            .outcomes
            .iter()
            .find(|o| o.outcome == state::AuditOutcomeKind::Rejected)
            .expect("P2 recorded");
        assert!(rejected.proposal_id.is_none(), "no card for a rejection");
        let terminal = rejected.verification["gates"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()
            .clone();
        assert_eq!(terminal["gate"], "g06_verify_lexical_integrity");
        assert_eq!(terminal["effect"], "reject");
        assert_eq!(terminal["code"], "literal_mismatch");
        // G07..G11 never ran: their absence IS the record.
        assert_eq!(rejected.verification["gates"].as_array().unwrap().len(), 7);
        // A gate rejection tombstones nothing — the same evidence may
        // support a correct extraction tomorrow.
        assert!(identity::tombstones(BRAIN).is_empty());
        drop(ollama);
    }

    #[tokio::test]
    async fn span_preview_reslices_the_primary_sentence_and_notices_drift() {
        let env = Env::new("preview");
        let state = Arc::new(MockState::default());
        state.preflight_ok().script(200, ok_chat(ATLAS_REPLY));
        let ollama = mock_ollama(state).await;
        env.config(true, Some(&ollama.base));
        let (relative, len, sha) = env.transcript(ATLAS);
        journal_turn(&relative, len, &sha);
        run_brain(BRAIN).await.expect("run");
        let pid = proposals::load_all(BRAIN)
            .into_keys()
            .next()
            .expect("one proposal");

        let preview = preview_spans(BRAIN, &pid).expect("preview");
        assert!(preview.available, "{preview:?}");
        assert_eq!(preview.spans.len(), 1);
        assert_eq!(
            preview.spans[0].text,
            "From now on we deploy Atlas only on Tuesdays."
        );
        assert_eq!(preview.spans[0].role, "user");
        assert!(preview.spans[0].primary);
        assert!(preview.spans[0].digest_matches);

        // The transcript changes: the panel refuses rather than showing
        // bytes nobody verified.
        std::fs::write(
            env.projects.join(format!("{SESSION}.jsonl")),
            ATLAS.replace("Tuesdays", "Fridays."),
        )
        .unwrap();
        let stale = preview_spans(BRAIN, &pid).expect("preview");
        assert!(!stale.available);
        assert_eq!(stale.code.as_deref(), Some("evidence_unavailable"));
        assert!(stale.spans.is_empty());
        drop(ollama);
    }

    // ───────────────── replay & crash (guide §7.2, family 20) ────────

    #[tokio::test]
    async fn replay_and_crash_recovery_process_each_unit_exactly_once() {
        let env = Env::new("replay");
        let state = Arc::new(MockState::default());
        state.preflight_ok().script(200, ok_chat(ATLAS_REPLY));
        let ollama = mock_ollama(state.clone()).await;
        env.config(true, Some(&ollama.base));
        let (relative, len, sha) = env.transcript(ATLAS);
        journal_turn(&relative, len, &sha);

        let first = run_brain(BRAIN).await.expect("first run");
        assert_eq!(first.proposals_created, 1);
        assert_eq!(proposal_lines(), 1);
        assert_eq!(state.generations(), 1);

        // A second ordinary run: the unit is Completed in the ledger, so
        // it is not even re-read, let alone re-generated.
        let second = run_brain(BRAIN).await.expect("second run");
        assert_eq!(second.units_processed, 0);
        assert_eq!(second.proposals_created, 0);
        assert_eq!(state.generations(), 1, "no second generation");
        assert_eq!(proposal_lines(), 1);

        // Crash between the proposal append and the ledger write: the
        // ledger is gone, so the unit looks new. Replay must reach the
        // same state and append ZERO new lines — the deterministic
        // proposal_id reduces it to a no-op.
        std::fs::remove_file(state::state_path(BRAIN)).unwrap();
        state
            .reset()
            .preflight_ok()
            .script(200, ok_chat(ATLAS_REPLY));
        let replay = run_brain(BRAIN).await.expect("replay");
        assert_eq!(replay.units_processed, 1, "{replay:#?}");
        assert_eq!(replay.candidates_seen, 2);
        assert_eq!(replay.proposals_created, 0);
        assert_eq!(proposal_lines(), 1, "replay appended a duplicate line");
        assert_eq!(proposals::load_all(BRAIN).len(), 1);

        // Two independent layers make a replay inert, and it is the
        // *outer* one that fires here: G11 recognises the evidence_key
        // the stored proposal already carries and returns NoOp before
        // the converter ever runs. The deterministic `proposal_id` is
        // the second net, behind it.
        let last = state::read_audit(BRAIN).pop().expect("replay audited");
        let no_op = last
            .outcomes
            .iter()
            .find(|o| o.outcome == state::AuditOutcomeKind::NoOp)
            .expect("the duplicate is recorded, never silently dropped");
        let terminal = no_op.verification["gates"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()
            .clone();
        assert_eq!(terminal["gate"], "g11_check_existing_state");
        assert_eq!(terminal["effect"], "no_op");
        drop(ollama);
    }

    #[tokio::test]
    async fn provider_failure_defers_the_unit_without_advancing_past_it() {
        let env = Env::new("defer");
        let state = Arc::new(MockState::default());
        state.preflight_ok().script(500, "boom".into());
        let ollama = mock_ollama(state.clone()).await;
        env.config(true, Some(&ollama.base));
        let (relative, len, sha) = env.transcript(ATLAS);
        journal_turn(&relative, len, &sha);

        let report = run_brain(BRAIN).await.expect("run");
        assert_eq!(report.units_deferred, 1);
        assert_eq!(report.proposals_created, 0);
        assert_eq!(proposal_lines(), 0);

        let ledger = CuratorLedger::load(BRAIN);
        let unit = ledger.units.values().next().expect("unit tracked");
        assert_eq!(unit.status, state::CuratorUnitStatus::Deferred);
        assert_eq!(unit.attempts, 1);
        assert_eq!(
            unit.last_safe_error,
            Some(state::CuratorErrorCode::ProviderUnavailable)
        );
        // The deferral is recorded, and the next window still reaches
        // back to this unit even though the watermark advanced.
        let audit = &state::read_audit(BRAIN)[0];
        assert_eq!(
            audit.no_proposal_reason,
            Some(NoProposalReason::ProviderUnavailable)
        );
        let start = ledger.window_start(
            OffsetDateTime::now_utc(),
            Duration::hours(GRACE_HOURS),
            Duration::days(COLD_START_DAYS),
        );
        assert!(start <= OffsetDateTime::parse(&unit.first_event_ts, &Rfc3339).unwrap());
        drop(ollama);
    }

    // ───────────────── family 14 — mutated prefix ────────────────────

    #[tokio::test]
    async fn family_14_mutated_prefix_defers_and_never_calls_the_model() {
        let env = Env::new("f14");
        let state = Arc::new(MockState::default());
        state.preflight_ok();
        let ollama = mock_ollama(state.clone()).await;
        env.config(true, Some(&ollama.base));
        let original = include_str!(
            "../../../../tests/fixtures/curator/redteam/f14_mutable_prefix/transcript.jsonl"
        );
        let mutated = include_str!(
            "../../../../tests/fixtures/curator/redteam/f14_mutable_prefix/transcript_mutated.jsonl"
        );
        let (relative, len, sha) = env.transcript(original);
        journal_turn(&relative, len, &sha);
        // Capture hashed the original; replay finds a rewritten, shorter
        // file — both the length and the digest moved.
        std::fs::write(env.projects.join(format!("{SESSION}.jsonl")), mutated).unwrap();

        let report = run_brain(BRAIN).await.expect("run");
        assert_eq!(report.units_deferred, 1);
        assert_eq!(report.proposals_created, 0);
        assert_eq!(state.generations(), 0, "no model call on vanished evidence");
        // Not even preflight: the provider is never started, because the
        // unit never reached generation.
        assert!(state.requests.lock().unwrap().is_empty());

        let audit = &state::read_audit(BRAIN)[0];
        assert_eq!(
            audit.no_proposal_reason,
            Some(NoProposalReason::EvidenceUnavailable)
        );
        let unit = CuratorLedger::load(BRAIN)
            .units
            .values()
            .next()
            .cloned()
            .expect("unit tracked");
        assert_eq!(unit.status, state::CuratorUnitStatus::Deferred);
        assert_eq!(
            unit.last_safe_error,
            Some(state::CuratorErrorCode::EvidenceUnavailable)
        );
        drop(ollama);
    }

    // ───────────────── family 19 — recycled curator output ───────────

    #[test]
    fn family_19_curator_output_never_becomes_a_unit() {
        let raw = include_str!(
            "../../../../tests/fixtures/curator/redteam/f19_curator_output_recycled/events.jsonl"
        );
        let events: Vec<Event> = raw
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).expect("fixture event"))
            .collect();
        assert_eq!(events.len(), 4);

        let (units, notes) = assemble_units(BRAIN, &events);
        // The loop is cut BEFORE unit assembly: zero units, not a gate
        // verdict. Two of these wear allowlisted (event_type,
        // capture_method) shapes and are still ineligible.
        assert!(units.is_empty(), "{units:?}");
        assert!(
            notes.iter().any(|n| n.contains("ineligible")),
            "silence is not allowed: {notes:?}"
        );
    }

    // ───────────────── the additive proposals field ──────────────────

    /// The one edit to `proposals.rs` has to be invisible in both
    /// directions: a line written before the curator existed decodes
    /// with `curator: None`, and a record without receipts serializes
    /// without the key — so `proposals.jsonl` is byte-identical to what
    /// the deterministic pipeline wrote yesterday.
    #[test]
    fn a_pre_curator_proposal_line_still_decodes_and_round_trips() {
        const OLD_LINE: &str = r#"{"proposal_id":"a1b2","brain_id":"b","action":"memory_strengthened",
            "memory_type":"engram","object_id":"e-1","title":"t","reason":"r","band":"low",
            "fields":[{"name":"n","proposed_value":"v","evidence":["ev-1"]}],
            "evidence":["ev-1"],"review_status":"unreviewed","application_status":"pending",
            "proposed_at":"2026-08-01T00:00:00Z"}"#;

        let rec: StoredProposal = serde_json::from_str(OLD_LINE).expect("old line must decode");
        assert!(rec.curator.is_none());
        let round_tripped = serde_json::to_string(&rec).unwrap();
        assert!(
            !round_tripped.contains("curator"),
            "the key must not appear on a rule-derived proposal: {round_tripped}"
        );
    }

    // ───────────────── consent + lock ────────────────────────────────

    #[tokio::test]
    async fn consent_off_records_a_skip_and_reads_no_transcript() {
        let env = Env::new("consent");
        let state = Arc::new(MockState::default());
        state.preflight_ok();
        let ollama = mock_ollama(state.clone()).await;
        env.config(false, Some(&ollama.base));
        let (relative, len, sha) = env.transcript(ATLAS);
        let (unit_id, _) = journal_turn(&relative, len, &sha);

        let report = run_brain(BRAIN).await.expect("run");
        assert_eq!(report.status, RunStatus::SkippedDisabled);
        assert_eq!(report.units_skipped, 1);
        assert_eq!(report.proposals_created, 0);
        assert!(state.requests.lock().unwrap().is_empty(), "model untouched");

        // Recorded, never silent — and terminal, so no backlog builds up
        // for the day the user opts in.
        let audit = &state::read_audit(BRAIN)[0];
        assert_eq!(audit.unit_id, unit_id);
        assert_eq!(
            audit.no_proposal_reason,
            Some(NoProposalReason::CuratorDisabled)
        );
        assert_eq!(audit.unit_status, state::CuratorUnitStatus::SkippedDisabled);
        let ledger = CuratorLedger::load(BRAIN);
        assert!(!ledger.needs_processing(
            &ledger.units.values().next().map(unit_key_of).unwrap(),
            OffsetDateTime::now_utc()
        ));
        drop(ollama);
    }

    fn unit_key_of(u: &state::PendingCuratorUnit) -> UnitKey {
        UnitKey::new(&u.unit_id, &u.evidence_digest, &u.policy_epoch)
    }

    #[tokio::test]
    async fn a_second_caller_loses_the_lock_cleanly() {
        let env = Env::new("busy");
        env.config(false, None);
        let held = lock::try_acquire_brain_run(BRAIN).expect("first caller wins");
        match run_brain(BRAIN).await {
            Err(RunError::Busy(b)) => assert_eq!(b.brain_id, BRAIN),
            other => panic!("expected Busy, got {other:?}"),
        }
        drop(held);
        // And with the slot free, the same call proceeds.
        assert!(run_brain(BRAIN).await.is_ok());
    }

    // ───────────────── the consent-loader dedupe (Wave 3) ────────────

    /// One consent decision in the crate. `provider::LocalCuratorFile`
    /// still parses the same file for its provider block and round-trips
    /// the booleans for the settings API; this pins the two readings
    /// together so a rename in one can never silently mean "off" in the
    /// other.
    #[test]
    fn consent_views_cannot_drift() {
        for raw in [
            "{}",
            r#"{"enabled":true}"#,
            r#"{"transcript_access":true}"#,
            r#"{"enabled":true,"transcript_access":true}"#,
            r#"{"enabled":true,"transcript_access":true,"provider":{"model":"m"}}"#,
            r#"{"enabled":false,"transcript_access":true}"#,
        ] {
            let consent = evidence::decode_local_config(Some(raw));
            let file = provider::LocalCuratorFile::parse(raw).expect("parses");
            assert_eq!(consent.enabled, file.enabled, "{raw}");
            assert_eq!(consent.transcript_access, file.transcript_access, "{raw}");
        }
        // Both fail closed on bytes that are not JSON at all.
        assert!(!evidence::decode_local_config(Some("not json")).both_switches());
        assert!(provider::LocalCuratorFile::parse("not json").is_none());
    }

    #[test]
    fn truncate_never_splits_a_char() {
        let s = "日本語のとても長い文章です。".repeat(10);
        let cut = truncate(&s, 60);
        assert!(cut.chars().count() <= 60);
        assert!(cut.ends_with('…'));
        assert_eq!(truncate("short", 60), "short");
    }
}
