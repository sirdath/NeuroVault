//! Run ledger, watermark, retry, run audit (guide §2.6, spec §14.1 +
//! §16, slice A6/B4).
//!
//! Two curator-owned files per brain, and nothing shared with
//! deterministic consolidation (it runs 6-hourly; the curator batch is
//! ~87 s/unit nightly — one watermark would couple their failure
//! modes):
//!
//! ```text
//! ~/.neurovault/brains/<id>/curator_state.json        the ledger: watermark + per-unit retry state
//! ~/.neurovault/brains/<id>/curator_runs-YYYY-MM.jsonl  CuratorRunAudit, one line per unit outcome
//! ```
//!
//! **The durable key is `(brain_id, unit_id, evidence_digest,
//! policy_epoch)`** (spec §16). [`evidence_digest`] folds in
//! `segmenter_version`, so re-segmenting the same turn produces a new
//! ledger entry that cannot inherit the old sentence table's receipts.
//!
//! **Deferred is retryable; it is NOT a rejection.** The distinction is
//! carried in the type names and enforced by the transitions:
//! [`CuratorUnitStatus::Deferred`] retries under a bounded backoff,
//! exhausting into [`CuratorUnitStatus::ExpiredVisible`] — a *visible*
//! expiry with [`CuratorErrorCode::AttemptsExhausted`], never
//! [`CuratorUnitStatus::PermanentlyRejected`], which is reserved for a
//! policy-terminal verdict. Nothing here ever writes a false rejection
//! into the metrics.
//!
//! **Durable ordering per unit** (spec §16, guide §2.6): append
//! StoredProposals (the runner) → append the audit line → update retry
//! state → advance the watermark. [`commit_unit`] owns steps 2–3 and
//! blocks step 4 on an audit-append failure: an unrecorded terminal
//! result is not a completed one, so [`CuratorLedger::advance_watermark`]
//! refuses and the unit stays deferred for the next run. A crash
//! anywhere replays; deterministic proposal ids make replay a no-op.
//!
//! **No silent units.** A unit that produces nothing durable still gets
//! a line: [`CuratorRunAudit::is_silent`] is checked on the way in, and
//! a line with neither an outcome nor a [`NoProposalReason`] is refused
//! rather than written. Rejected/Deferred/NoOp outcomes are recorded
//! too — they are the numerator of the false-reject metric.
//!
//! The audit file holds no prompt, response, quote, transcript text,
//! path, secret, or request-local handle: candidates enter as a one-way
//! `candidate_sha256`, and receipts arrive pre-serialized from the
//! runner.
//!
//! Decoupled from `receipts.rs`/`gates.rs` on purpose: generation,
//! verification and sentence-table payloads are stored as
//! [`ReceiptJson`] (the builders take any `Serialize`), so the ledger's
//! durability contract never blocks on — or rewrites for — receipt
//! shape churn in a parallel wave.

use std::collections::BTreeMap;
use std::fmt;
use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};

use crate::memory::journal::Event;
use crate::memory::types::MemoryError;

type Result<T> = std::result::Result<T, MemoryError>;

pub const CURATOR_LEDGER_VERSION: u32 = 1;
pub const DEFAULT_MAX_ATTEMPTS: u16 = 3;
pub const DEFAULT_UNIT_TTL_DAYS: i64 = 14;
pub const DEFAULT_RETRY_BACKOFF_HOURS: [i64; 3] = [1, 6, 24];
pub const EVIDENCE_POLICY_V1: &str = "curator-evidence-v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RetryPolicy {
    pub max_attempts: u16,
    pub ttl_days: i64,
    pub backoff_hours: [i64; 3],
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: DEFAULT_MAX_ATTEMPTS,
            ttl_days: DEFAULT_UNIT_TTL_DAYS,
            backoff_hours: DEFAULT_RETRY_BACKOFF_HOURS,
        }
    }
}

/// Inputs to the ledger's evidence digest. `segment_identities` are the
/// stable per-segment/`SpanIdentity` hashes the runner already has —
/// request-local handles (`run_ref`, `S<n>` labels, previews) are
/// excluded by construction because they never appear here.
pub struct EvidenceDigestInput<'a> {
    pub segment_identities: &'a [String],
    pub parser_version: u32,
    pub redaction_policy_version: u32,
    pub segmenter_version: u32,
    pub evidence_policy: &'a str,
}

/// `sha256(sorted identities + evidence policy + transform versions)`,
/// truncated to 16 hex chars (guide §3.5). Sorted and length-delimited,
/// so the same bytes hash the same across processes and a segmenter
/// bump forces a new ledger key (spec §16).
pub fn evidence_digest(input: &EvidenceDigestInput<'_>) -> String {
    let mut ids: Vec<&str> = input
        .segment_identities
        .iter()
        .map(String::as_str)
        .collect();
    ids.sort_unstable();
    ids.dedup();

    let mut h = Sha256::new();
    h.update(b"curator/evidence-digest/1\x1f");
    h.update(input.evidence_policy.as_bytes());
    h.update(b"\x1f");
    h.update(input.parser_version.to_string().as_bytes());
    h.update(b"\x1f");
    h.update(input.redaction_policy_version.to_string().as_bytes());
    h.update(b"\x1f");
    h.update(input.segmenter_version.to_string().as_bytes());
    h.update(b"\x1f");
    for id in ids {
        h.update(id.len().to_string().as_bytes());
        h.update(b":");
        h.update(id.as_bytes());
        h.update(b"\x1f");
    }
    format!("{:x}", h.finalize())[..16].to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct UnitKey {
    pub unit_id: String,
    pub evidence_digest: String,
    pub policy_epoch: String,
}

impl UnitKey {
    pub fn new(unit_id: &str, evidence_digest: &str, policy_epoch: &str) -> Self {
        Self {
            unit_id: unit_id.to_string(),
            evidence_digest: evidence_digest.to_string(),
            policy_epoch: policy_epoch.to_string(),
        }
    }

    pub fn storage_key(&self) -> String {
        format!(
            "{}|{}|{}",
            self.unit_id, self.evidence_digest, self.policy_epoch
        )
    }
}

impl fmt::Display for UnitKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.storage_key())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct JournalCursor {
    pub ts: String,
    pub seq: u64,
    pub event_id: String,
}

impl JournalCursor {
    pub fn from_event(e: &Event) -> Self {
        Self {
            ts: e.ts.clone(),
            seq: e.seq,
            event_id: e.event_id.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CuratorUnitStatus {
    Pending,
    Deferred,
    Completed,
    PermanentlyRejected,
    ExpiredVisible,
    SkippedDisabled,
}

impl CuratorUnitStatus {
    pub fn is_retryable(self) -> bool {
        matches!(self, Self::Pending | Self::Deferred)
    }

    pub fn is_terminal(self) -> bool {
        !self.is_retryable()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CuratorErrorCode {
    ProviderUnavailable,
    ProviderTimeout,
    InvalidResponse,
    EvidenceUnavailable,
    PolicyRejected,
    AttemptsExhausted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingCuratorUnit {
    pub brain_id: String,
    pub unit_id: String,
    pub evidence_digest: String,
    pub policy_epoch: String,
    pub first_event_ts: String,
    pub last_event_ts: String,
    pub first_journal_cursor: JournalCursor,
    pub status: CuratorUnitStatus,
    pub attempts: u16,
    pub max_attempts: u16,
    pub retry_after: Option<String>,
    pub expires_at: String,
    pub last_safe_error: Option<CuratorErrorCode>,
    pub first_seen: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct WatermarkBlocked {
    pub reason: String,
}

impl fmt::Display for WatermarkBlocked {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "watermark advance blocked: {}", self.reason)
    }
}

impl std::error::Error for WatermarkBlocked {}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CuratorLedger {
    pub version: u32,
    pub watermark: Option<String>,
    pub units: BTreeMap<String, PendingCuratorUnit>,
    #[serde(skip)]
    blocked: Option<String>,
}

impl Default for CuratorLedger {
    fn default() -> Self {
        Self {
            version: CURATOR_LEDGER_VERSION,
            watermark: None,
            units: BTreeMap::new(),
            blocked: None,
        }
    }
}

impl CuratorLedger {
    /// Read `curator_state.json`. Missing, unreadable, corrupt, or
    /// written by a future ledger version ⇒ an empty ledger: the run
    /// replays instead of skipping silently, and deterministic proposal
    /// ids make replay a no-op. Fail toward replay, never toward
    /// "already done".
    pub fn load(brain_id: &str) -> Self {
        let Ok(raw) = std::fs::read_to_string(state_path(brain_id)) else {
            return Self::default();
        };
        match serde_json::from_str::<Self>(&raw) {
            Ok(ledger) if ledger.version == CURATOR_LEDGER_VERSION => ledger,
            _ => Self::default(),
        }
    }

    /// Atomic (temp + rename), exactly like the consolidation watermark:
    /// a crash mid-write leaves the previous ledger intact.
    pub fn save(&self, brain_id: &str) -> Result<()> {
        let path = state_path(brain_id);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|e| MemoryError::Other(format!("curator state dir: {e}")))?;
        }
        let body = serde_json::to_string_pretty(self)
            .map_err(|e| MemoryError::Other(format!("curator state serialize: {e}")))?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, body)
            .map_err(|e| MemoryError::Other(format!("curator state write: {e}")))?;
        std::fs::rename(&tmp, &path)
            .map_err(|e| MemoryError::Other(format!("curator state rename: {e}")))?;
        Ok(())
    }

    pub fn watermark_time(&self) -> Option<OffsetDateTime> {
        self.watermark
            .as_deref()
            .and_then(|w| OffsetDateTime::parse(w, &Rfc3339).ok())
    }

    /// Step 4 of the durable order. Refuses while this run has an
    /// unrecorded terminal result (spec §14.1): an audit line that
    /// could not be appended means the unit is not completed, so the
    /// window must not move past it.
    pub fn advance_watermark(
        &mut self,
        now: OffsetDateTime,
    ) -> std::result::Result<(), WatermarkBlocked> {
        if let Some(reason) = &self.blocked {
            return Err(WatermarkBlocked {
                reason: reason.clone(),
            });
        }
        self.watermark = Some(now.format(&Rfc3339).unwrap_or_default());
        Ok(())
    }

    /// Why the watermark is pinned, if it is. Diagnostics/Inspector.
    pub fn blocked_reason(&self) -> Option<&str> {
        self.blocked.as_deref()
    }

    pub fn get(&self, key: &UnitKey) -> Option<&PendingCuratorUnit> {
        self.units.get(&key.storage_key())
    }

    /// Register a unit on first sight (idempotent — a replay of the same
    /// key keeps its original `first_seen`, attempts and TTL).
    pub fn observe(
        &mut self,
        key: &UnitKey,
        brain_id: &str,
        cursor: JournalCursor,
        last_event_ts: &str,
        policy: &RetryPolicy,
        now: OffsetDateTime,
    ) -> &PendingCuratorUnit {
        let stamp = now.format(&Rfc3339).unwrap_or_default();
        self.units
            .entry(key.storage_key())
            .or_insert_with(|| PendingCuratorUnit {
                brain_id: brain_id.to_string(),
                unit_id: key.unit_id.clone(),
                evidence_digest: key.evidence_digest.clone(),
                policy_epoch: key.policy_epoch.clone(),
                first_event_ts: cursor.ts.clone(),
                last_event_ts: last_event_ts.to_string(),
                first_journal_cursor: cursor,
                status: CuratorUnitStatus::Pending,
                attempts: 0,
                max_attempts: policy.max_attempts,
                retry_after: None,
                expires_at: (now + Duration::days(policy.ttl_days))
                    .format(&Rfc3339)
                    .unwrap_or_default(),
                last_safe_error: None,
                first_seen: stamp.clone(),
                updated_at: stamp,
            })
    }

    /// Should this run touch the unit? Unknown keys and `Pending` units
    /// yes; `Deferred` once its backoff has elapsed; every terminal
    /// status no. Callers sweep [`Self::expire_overdue`] first so a
    /// TTL-expired unit is dropped *visibly* rather than by this test.
    pub fn needs_processing(&self, key: &UnitKey, now: OffsetDateTime) -> bool {
        match self.get(key) {
            None => true,
            Some(u) => match u.status {
                CuratorUnitStatus::Pending => true,
                CuratorUnitStatus::Deferred => u
                    .retry_after
                    .as_deref()
                    .and_then(|t| OffsetDateTime::parse(t, &Rfc3339).ok())
                    .is_none_or(|due| now >= due),
                CuratorUnitStatus::Completed
                | CuratorUnitStatus::PermanentlyRejected
                | CuratorUnitStatus::ExpiredVisible
                | CuratorUnitStatus::SkippedDisabled => false,
            },
        }
    }

    fn touch(&mut self, key: &UnitKey, now: OffsetDateTime) -> Option<&mut PendingCuratorUnit> {
        let stamp = now.format(&Rfc3339).unwrap_or_default();
        let unit = self.units.get_mut(&key.storage_key())?;
        unit.updated_at = stamp;
        Some(unit)
    }

    /// The whole bounded batch reached a terminal verifier outcome and
    /// everything it produced is durably appended (spec §16).
    pub fn mark_completed(&mut self, key: &UnitKey, now: OffsetDateTime) {
        if let Some(u) = self.touch(key, now) {
            u.status = CuratorUnitStatus::Completed;
            u.retry_after = None;
        }
    }

    /// A temporary failure: keep the unit, count the attempt, back off.
    /// The cap turns into a VISIBLE expiry, never a rejection — a
    /// deferred unit that ran out of attempts is not a false reject.
    pub fn mark_deferred(
        &mut self,
        key: &UnitKey,
        code: CuratorErrorCode,
        policy: &RetryPolicy,
        now: OffsetDateTime,
    ) {
        let backoff = policy.backoff_hours;
        let Some(u) = self.touch(key, now) else {
            return;
        };
        u.attempts = u.attempts.saturating_add(1);
        u.last_safe_error = Some(code);
        if u.attempts >= u.max_attempts {
            u.status = CuratorUnitStatus::ExpiredVisible;
            u.last_safe_error = Some(CuratorErrorCode::AttemptsExhausted);
            u.retry_after = None;
        } else {
            u.status = CuratorUnitStatus::Deferred;
            let idx = (usize::from(u.attempts) - 1).min(backoff.len() - 1);
            u.retry_after = Some(
                (now + Duration::hours(backoff[idx]))
                    .format(&Rfc3339)
                    .unwrap_or_default(),
            );
        }
    }

    /// The curator is off: record the intentional skip, build no
    /// backlog (spec §16) — the unit is not retried when it comes back.
    pub fn mark_skipped_disabled(&mut self, key: &UnitKey, now: OffsetDateTime) {
        if let Some(u) = self.touch(key, now) {
            u.status = CuratorUnitStatus::SkippedDisabled;
            u.retry_after = None;
        }
    }

    /// A policy-terminal verdict (e.g. tombstoned evidence). Distinct
    /// from retry exhaustion on purpose: only this writes "rejected".
    pub fn mark_permanently_rejected(&mut self, key: &UnitKey, now: OffsetDateTime) {
        if let Some(u) = self.touch(key, now) {
            u.status = CuratorUnitStatus::PermanentlyRejected;
            u.last_safe_error = Some(CuratorErrorCode::PolicyRejected);
            u.retry_after = None;
        }
    }

    /// TTL reached before a terminal outcome.
    pub fn mark_expired(&mut self, key: &UnitKey, now: OffsetDateTime) {
        if let Some(u) = self.touch(key, now) {
            u.status = CuratorUnitStatus::ExpiredVisible;
            u.retry_after = None;
        }
    }

    /// Sweep units past their TTL into a visible expiry and RETURN them,
    /// so the caller can audit each one. Expiry is never a silent
    /// watermark skip (spec §16).
    pub fn expire_overdue(&mut self, now: OffsetDateTime) -> Vec<UnitKey> {
        let stamp = now.format(&Rfc3339).unwrap_or_default();
        let mut expired = Vec::new();
        for u in self.units.values_mut() {
            if u.status.is_terminal() {
                continue;
            }
            let due = OffsetDateTime::parse(&u.expires_at, &Rfc3339).ok();
            if due.is_some_and(|d| now >= d) {
                u.status = CuratorUnitStatus::ExpiredVisible;
                u.retry_after = None;
                u.updated_at = stamp.clone();
                expired.push(UnitKey::new(
                    &u.unit_id,
                    &u.evidence_digest,
                    &u.policy_epoch,
                ));
            }
        }
        expired
    }

    /// Oldest unit still awaiting a terminal outcome — what the read
    /// window has to reach back to.
    pub fn oldest_unprocessed(&self) -> Option<&PendingCuratorUnit> {
        self.units
            .values()
            .filter(|u| u.status.is_retryable())
            .min_by_key(|u| {
                OffsetDateTime::parse(&u.first_event_ts, &Rfc3339)
                    .unwrap_or(OffsetDateTime::UNIX_EPOCH)
            })
    }

    /// Where the next read window starts: the watermark minus its grace
    /// period (cold start: `now - cold_start`), extended backwards to
    /// the oldest unprocessed unit so a deferred unit is never stranded
    /// behind an advanced watermark (spec §16).
    pub fn window_start(
        &self,
        now: OffsetDateTime,
        grace: Duration,
        cold_start: Duration,
    ) -> OffsetDateTime {
        let mut start = match self.watermark_time() {
            Some(w) => w - grace,
            None => now - cold_start,
        };
        if let Some(oldest) = self.oldest_unprocessed() {
            if let Ok(t) = OffsetDateTime::parse(&oldest.first_event_ts, &Rfc3339) {
                start = start.min(t);
            }
        }
        start
    }

    fn block(&mut self, reason: String) {
        self.blocked = Some(reason);
    }

    /// The audit line could not be written: the unit's terminal result
    /// is unrecorded, so it goes back to `Deferred` for the next run
    /// WITHOUT burning an attempt (nothing about the extraction failed),
    /// and the watermark is pinned.
    fn mark_audit_failure(&mut self, key: &UnitKey, reason: String, now: OffsetDateTime) {
        if let Some(u) = self.touch(key, now) {
            u.status = CuratorUnitStatus::Deferred;
            u.retry_after = None;
        }
        self.block(reason);
    }
}

pub type ReceiptJson = serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditOutcomeKind {
    NoOp,
    Rejected,
    Deferred,
    ReviewRequired,
    ProposalReady,
}

impl AuditOutcomeKind {
    pub fn creates_proposal(self) -> bool {
        matches!(self, Self::ReviewRequired | Self::ProposalReady)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NoProposalReason {
    NoCandidates,
    EvidenceUnavailable,
    EvidenceTombstoned,
    ProviderUnavailable,
    ProviderTimeout,
    MalformedOutput,
    UnitOverBudget,
    CuratorDisabled,
    IneligibleEvidence,
    AttemptsExhausted,
    UnitExpired,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CandidateAuditOutcome {
    pub candidate_sha256: String,
    pub outcome: AuditOutcomeKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposal_id: Option<String>,
    pub verification: ReceiptJson,
}

impl CandidateAuditOutcome {
    pub fn new(
        candidate_bytes: &[u8],
        outcome: AuditOutcomeKind,
        verification: &impl Serialize,
    ) -> Result<Self> {
        Ok(Self {
            candidate_sha256: candidate_sha256(candidate_bytes),
            outcome,
            proposal_id: None,
            verification: serde_json::to_value(verification)?,
        })
    }

    pub fn with_proposal_id(mut self, pid: &str) -> Self {
        self.proposal_id = Some(pid.to_string());
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CuratorRunAudit {
    pub run_id: String,
    pub brain_id: String,
    pub unit_id: String,
    pub evidence_digest: String,
    pub policy_epoch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sentence_table: Option<ReceiptJson>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation: Option<ReceiptJson>,
    #[serde(default)]
    pub outcomes: Vec<CandidateAuditOutcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub no_proposal_reason: Option<NoProposalReason>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
    pub unit_status: CuratorUnitStatus,
    pub started_at: String,
    pub duration_ms: u64,
    pub ts: String,
}

impl CuratorRunAudit {
    pub fn new(run_id: &str, brain_id: &str, key: &UnitKey, started_at: OffsetDateTime) -> Self {
        let stamp = started_at.format(&Rfc3339).unwrap_or_default();
        Self {
            run_id: run_id.to_string(),
            brain_id: brain_id.to_string(),
            unit_id: key.unit_id.clone(),
            evidence_digest: key.evidence_digest.clone(),
            policy_epoch: key.policy_epoch.clone(),
            sentence_table: None,
            generation: None,
            outcomes: Vec::new(),
            no_proposal_reason: None,
            notes: Vec::new(),
            unit_status: CuratorUnitStatus::Pending,
            started_at: stamp.clone(),
            duration_ms: 0,
            ts: stamp,
        }
    }

    pub fn with_generation(mut self, receipt: &impl Serialize) -> Result<Self> {
        self.generation = Some(serde_json::to_value(receipt)?);
        Ok(self)
    }

    pub fn with_sentence_table(mut self, table: &impl Serialize) -> Result<Self> {
        self.sentence_table = Some(serde_json::to_value(table)?);
        Ok(self)
    }

    pub fn with_outcome(mut self, outcome: CandidateAuditOutcome) -> Self {
        self.outcomes.push(outcome);
        self
    }

    pub fn with_no_proposal_reason(mut self, reason: NoProposalReason) -> Self {
        self.no_proposal_reason = Some(reason);
        self
    }

    pub fn note(mut self, note: impl Into<String>) -> Self {
        self.notes.push(note.into());
        self
    }

    pub fn finished_at(mut self, now: OffsetDateTime) -> Self {
        self.ts = now.format(&Rfc3339).unwrap_or_default();
        let started = OffsetDateTime::parse(&self.started_at, &Rfc3339).unwrap_or(now);
        self.duration_ms = (now - started).whole_milliseconds().max(0) as u64;
        self
    }

    pub fn is_silent(&self) -> bool {
        self.outcomes.is_empty() && self.no_proposal_reason.is_none()
    }
}

pub fn candidate_sha256(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

pub fn new_run_id() -> String {
    format!("cr_{}", uuid::Uuid::new_v4().simple())
}

fn brain_dir(brain_id: &str) -> PathBuf {
    crate::memory::paths::nv_home()
        .join("brains")
        .join(brain_id)
}

pub fn state_path(brain_id: &str) -> PathBuf {
    brain_dir(brain_id).join("curator_state.json")
}

pub fn audit_segment_path(brain_id: &str, ts: &str) -> PathBuf {
    let month = ts.get(..7).unwrap_or("unknown");
    brain_dir(brain_id).join(format!("curator_runs-{month}.jsonl"))
}

/// Append one safe line to this month's audit segment. Refuses a
/// silent line (neither an outcome nor a no-proposal reason): a unit
/// outcome that records nothing is a bug, and treating it as a failed
/// commit keeps the watermark honest instead of losing the unit.
///
/// One `write_all` of line+newline on an `O_APPEND` handle, matching
/// `journal::append`'s atomicity contract.
pub fn append_audit(brain_id: &str, audit: &CuratorRunAudit) -> Result<()> {
    if audit.is_silent() {
        return Err(MemoryError::Other(format!(
            "curator audit for unit {} records neither an outcome nor a no-proposal reason",
            audit.unit_id
        )));
    }
    let path = audit_segment_path(brain_id, &audit.ts);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| MemoryError::Other(format!("curator audit dir: {e}")))?;
    }
    let mut line = serde_json::to_string(audit)
        .map_err(|e| MemoryError::Other(format!("curator audit serialize: {e}")))?;
    line.push('\n');
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| MemoryError::Other(format!("curator audit open: {e}")))?;
    f.write_all(line.as_bytes())
        .map_err(|e| MemoryError::Other(format!("curator audit write: {e}")))?;
    Ok(())
}

/// Every audit line for a brain, oldest segment first. Corruption
/// tolerant: an unparseable line is skipped, never fatal (the Inspector
/// must still render the rest).
pub fn read_audit(brain_id: &str) -> Vec<CuratorRunAudit> {
    let Ok(entries) = std::fs::read_dir(brain_dir(brain_id)) else {
        return Vec::new();
    };
    let mut segments: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("curator_runs-") && n.ends_with(".jsonl"))
        })
        .collect();
    segments.sort();

    let mut out = Vec::new();
    for segment in segments {
        let Ok(raw) = std::fs::read_to_string(&segment) else {
            continue;
        };
        out.extend(
            raw.lines()
                .filter(|l| !l.trim().is_empty())
                .filter_map(|l| serde_json::from_str::<CuratorRunAudit>(l).ok()),
        );
    }
    out
}

/// What this run decided about the unit as a whole (distinct from the
/// per-candidate [`AuditOutcomeKind`]s inside the audit line).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnitOutcome {
    Completed,
    /// Retryable. Bounded by [`RetryPolicy::max_attempts`], after which
    /// the unit expires visibly — it is never reclassified as rejected.
    Deferred(CuratorErrorCode),
    SkippedDisabled,
    /// Policy-terminal, e.g. tombstoned evidence.
    PermanentlyRejected,
    Expired,
}

/// The status this outcome will leave on the ledger, computed before
/// the transition so the audit line can state it.
fn project_status(
    unit: Option<&PendingCuratorUnit>,
    outcome: UnitOutcome,
    policy: &RetryPolicy,
) -> CuratorUnitStatus {
    match outcome {
        UnitOutcome::Completed => CuratorUnitStatus::Completed,
        UnitOutcome::SkippedDisabled => CuratorUnitStatus::SkippedDisabled,
        UnitOutcome::PermanentlyRejected => CuratorUnitStatus::PermanentlyRejected,
        UnitOutcome::Expired => CuratorUnitStatus::ExpiredVisible,
        UnitOutcome::Deferred(_) => {
            let (attempts, max) = unit
                .map(|u| (u.attempts, u.max_attempts))
                .unwrap_or((0, policy.max_attempts));
            if attempts.saturating_add(1) >= max {
                CuratorUnitStatus::ExpiredVisible
            } else {
                CuratorUnitStatus::Deferred
            }
        }
    }
}

/// Steps 2–3 of the durable order (spec §16): **append the audit line,
/// then update retry state, then persist the ledger.** The runner has
/// already appended any StoredProposals (step 1); the caller advances
/// the watermark (step 4) once the whole run is done.
///
/// If the audit append fails, nothing is marked terminal: the unit
/// returns to `Deferred` without burning an attempt and the ledger
/// refuses to advance its watermark until a later run records the
/// result. Errors here are safe to bubble — replay is idempotent.
pub fn commit_unit(
    brain_id: &str,
    ledger: &mut CuratorLedger,
    key: &UnitKey,
    audit: CuratorRunAudit,
    outcome: UnitOutcome,
    policy: &RetryPolicy,
    now: OffsetDateTime,
) -> Result<()> {
    let mut audit = audit;
    audit.unit_status = project_status(ledger.get(key), outcome, policy);

    if let Err(e) = append_audit(brain_id, &audit) {
        ledger.mark_audit_failure(key, e.to_string(), now);
        // Best effort: the deferral itself is recoverable state, and a
        // failure to persist it only means the unit replays anyway.
        let _ = ledger.save(brain_id);
        return Err(e);
    }

    match outcome {
        UnitOutcome::Completed => ledger.mark_completed(key, now),
        UnitOutcome::Deferred(code) => ledger.mark_deferred(key, code, policy, now),
        UnitOutcome::SkippedDisabled => ledger.mark_skipped_disabled(key, now),
        UnitOutcome::PermanentlyRejected => ledger.mark_permanently_rejected(key, now),
        UnitOutcome::Expired => ledger.mark_expired(key, now),
    }

    if let Err(e) = ledger.save(brain_id) {
        // The audit is durable but the ledger is not: replay would
        // redo the unit (idempotent), so pin the watermark and report.
        ledger.block(format!("curator ledger save failed: {e}"));
        return Err(e);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::adaptive::consolidate::group_units;
    use crate::memory::adaptive::curator::lineage;
    use crate::memory::journal::{append, read_window};

    const EPOCH: &str = "2026-08-vp1";

    fn with_temp_home<F: FnOnce()>(f: F) {
        let _guard = crate::memory::journal::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let home = std::env::temp_dir().join(format!(
            "nv-curator-state-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("NEUROVAULT_HOME", &home);
        f();
        std::env::remove_var("NEUROVAULT_HOME");
        let _ = std::fs::remove_dir_all(&home);
    }

    fn digest_of(ids: &[String], segmenter_version: u32) -> String {
        evidence_digest(&EvidenceDigestInput {
            segment_identities: ids,
            parser_version: 1,
            redaction_policy_version: 1,
            segmenter_version,
            evidence_policy: EVIDENCE_POLICY_V1,
        })
    }

    fn key_for(unit_id: &str, ids: &[String]) -> UnitKey {
        UnitKey::new(unit_id, &digest_of(ids, 1), EPOCH)
    }

    fn observe(ledger: &mut CuratorLedger, key: &UnitKey, now: OffsetDateTime) {
        let policy = RetryPolicy::default();
        let stamp = now.format(&Rfc3339).unwrap();
        ledger.observe(
            key,
            "b",
            JournalCursor {
                ts: stamp.clone(),
                seq: 1,
                event_id: key.unit_id.clone(),
            },
            &stamp,
            &policy,
            now,
        );
    }

    fn no_proposal_audit(key: &UnitKey, now: OffsetDateTime) -> CuratorRunAudit {
        CuratorRunAudit::new(&new_run_id(), "b", key, now)
            .with_no_proposal_reason(NoProposalReason::NoCandidates)
            .finished_at(now)
    }

    // --- evidence digest --------------------------------------------------

    #[test]
    fn evidence_digest_is_order_free_and_stable() {
        let a = digest_of(&["s2".into(), "s1".into()], 1);
        let b = digest_of(&["s1".into(), "s2".into()], 1);
        assert_eq!(a, b, "sorted inputs: order must not change the digest");
        assert_eq!(a.len(), 16);
        assert_ne!(a, digest_of(&["s1".into()], 1), "content matters");
    }

    #[test]
    fn evidence_digest_changes_when_the_segmenter_changes() {
        // Spec §16: a segmenter change produces a NEW ledger key and
        // cannot reuse a receipt from the prior sentence table.
        let ids = vec!["s1".to_string(), "s2".to_string()];
        assert_ne!(digest_of(&ids, 1), digest_of(&ids, 2));
    }

    // --- ledger persistence -----------------------------------------------

    #[test]
    fn ledger_round_trips_through_disk() {
        with_temp_home(|| {
            let now = OffsetDateTime::now_utc();
            let key = key_for("u1", &["s1".to_string()]);
            let mut ledger = CuratorLedger::load("b");
            observe(&mut ledger, &key, now);
            ledger.advance_watermark(now).unwrap();
            ledger.save("b").unwrap();

            let reopened = CuratorLedger::load("b");
            assert_eq!(reopened.version, CURATOR_LEDGER_VERSION);
            assert!(reopened.watermark_time().is_some());
            let unit = reopened.get(&key).expect("unit survived the round trip");
            assert_eq!(unit.status, CuratorUnitStatus::Pending);
            assert_eq!(unit.max_attempts, DEFAULT_MAX_ATTEMPTS);
        });
    }

    #[test]
    fn corrupt_ledger_fails_toward_replay() {
        with_temp_home(|| {
            let path = state_path("b");
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, b"{ not json").unwrap();
            let ledger = CuratorLedger::load("b");
            assert!(ledger.units.is_empty());
            assert!(
                ledger.watermark_time().is_none(),
                "an unreadable ledger replays rather than skipping silently"
            );
        });
    }

    // --- retry / TTL ------------------------------------------------------

    #[test]
    fn deferral_is_retryable_and_exhaustion_is_visible_not_a_rejection() {
        with_temp_home(|| {
            let policy = RetryPolicy::default();
            let now = OffsetDateTime::now_utc();
            let key = key_for("u1", &["s1".to_string()]);
            let mut ledger = CuratorLedger::load("b");
            observe(&mut ledger, &key, now);

            for attempt in 1..=2 {
                ledger.mark_deferred(&key, CuratorErrorCode::ProviderTimeout, &policy, now);
                let u = ledger.get(&key).unwrap();
                assert_eq!(u.attempts, attempt);
                assert_eq!(
                    u.status,
                    CuratorUnitStatus::Deferred,
                    "a deferred unit is retryable, not a false rejection"
                );
                assert!(u.status.is_retryable());
            }

            ledger.mark_deferred(&key, CuratorErrorCode::ProviderTimeout, &policy, now);
            let u = ledger.get(&key).unwrap();
            assert_eq!(u.attempts, policy.max_attempts);
            assert_eq!(
                u.status,
                CuratorUnitStatus::ExpiredVisible,
                "exhaustion is a VISIBLE expiry"
            );
            assert_ne!(
                u.status,
                CuratorUnitStatus::PermanentlyRejected,
                "retry exhaustion must never be recorded as a rejection"
            );
            assert_eq!(u.last_safe_error, Some(CuratorErrorCode::AttemptsExhausted));
            assert!(!ledger.needs_processing(&key, now));
        });
    }

    #[test]
    fn deferred_unit_is_not_due_until_its_backoff_elapses() {
        with_temp_home(|| {
            let policy = RetryPolicy::default();
            let now = OffsetDateTime::now_utc();
            let key = key_for("u1", &["s1".to_string()]);
            let mut ledger = CuratorLedger::load("b");
            observe(&mut ledger, &key, now);
            ledger.mark_deferred(&key, CuratorErrorCode::ProviderUnavailable, &policy, now);

            assert!(!ledger.needs_processing(&key, now), "backoff not elapsed");
            let later = now + Duration::hours(policy.backoff_hours[0] + 1);
            assert!(ledger.needs_processing(&key, later), "retry becomes due");
        });
    }

    #[test]
    fn ttl_expiry_is_visible_never_a_silent_skip() {
        with_temp_home(|| {
            let policy = RetryPolicy {
                ttl_days: 1,
                ..RetryPolicy::default()
            };
            let now = OffsetDateTime::now_utc();
            let key = key_for("u1", &["s1".to_string()]);
            let mut ledger = CuratorLedger::load("b");
            let stamp = now.format(&Rfc3339).unwrap();
            ledger.observe(
                &key,
                "b",
                JournalCursor {
                    ts: stamp.clone(),
                    seq: 1,
                    event_id: "u1".into(),
                },
                &stamp,
                &policy,
                now,
            );

            let expired = ledger.expire_overdue(now + Duration::days(2));
            assert_eq!(expired, vec![key.clone()], "expiry is reported, not silent");
            assert_eq!(
                ledger.get(&key).unwrap().status,
                CuratorUnitStatus::ExpiredVisible
            );
        });
    }

    #[test]
    fn disabled_skip_creates_no_backlog() {
        with_temp_home(|| {
            let now = OffsetDateTime::now_utc();
            let key = key_for("u1", &["s1".to_string()]);
            let mut ledger = CuratorLedger::load("b");
            observe(&mut ledger, &key, now);
            ledger.mark_skipped_disabled(&key, now);

            assert_eq!(
                ledger.get(&key).unwrap().status,
                CuratorUnitStatus::SkippedDisabled
            );
            assert!(!ledger.needs_processing(&key, now));
            assert!(
                ledger.oldest_unprocessed().is_none(),
                "an intentional skip must not build a backlog"
            );
        });
    }

    #[test]
    fn oldest_unprocessed_extends_the_read_window() {
        with_temp_home(|| {
            let now = OffsetDateTime::now_utc();
            let old = now - Duration::days(9);
            let mut ledger = CuratorLedger::load("b");
            let key = key_for("u_old", &["s1".to_string()]);
            let stamp = old.format(&Rfc3339).unwrap();
            ledger.observe(
                &key,
                "b",
                JournalCursor {
                    ts: stamp.clone(),
                    seq: 1,
                    event_id: "u_old".into(),
                },
                &stamp,
                &RetryPolicy::default(),
                old,
            );
            ledger.advance_watermark(now).unwrap();

            let start = ledger.window_start(now, Duration::hours(48), Duration::days(7));
            assert!(
                start <= old,
                "the window reaches back to the oldest unprocessed unit"
            );
        });
    }

    // --- audit ------------------------------------------------------------

    #[test]
    fn a_unit_that_yields_nothing_is_still_recorded() {
        with_temp_home(|| {
            let now = OffsetDateTime::now_utc();
            let key = key_for("u1", &["s1".to_string()]);
            let mut ledger = CuratorLedger::load("b");
            observe(&mut ledger, &key, now);
            let audit = no_proposal_audit(&key, now).note("unit skipped: evidence not captured");
            commit_unit(
                "b",
                &mut ledger,
                &key,
                audit,
                UnitOutcome::Completed,
                &RetryPolicy::default(),
                now,
            )
            .unwrap();

            let lines = read_audit("b");
            assert_eq!(lines.len(), 1, "a no-proposal unit is a recorded outcome");
            assert_eq!(
                lines[0].no_proposal_reason,
                Some(NoProposalReason::NoCandidates)
            );
            assert_eq!(lines[0].unit_status, CuratorUnitStatus::Completed);
            assert!(lines[0].outcomes.is_empty());
        });
    }

    #[test]
    fn a_silent_audit_line_is_refused() {
        with_temp_home(|| {
            let now = OffsetDateTime::now_utc();
            let key = key_for("u1", &["s1".to_string()]);
            let mut ledger = CuratorLedger::load("b");
            observe(&mut ledger, &key, now);
            let silent = CuratorRunAudit::new(&new_run_id(), "b", &key, now).finished_at(now);
            assert!(silent.is_silent());
            let err = commit_unit(
                "b",
                &mut ledger,
                &key,
                silent,
                UnitOutcome::Completed,
                &RetryPolicy::default(),
                now,
            );
            assert!(err.is_err(), "a unit outcome may never be silent");
            assert!(read_audit("b").is_empty());
        });
    }

    #[test]
    fn every_deferral_and_the_exhaustion_land_in_the_audit() {
        with_temp_home(|| {
            let policy = RetryPolicy::default();
            let now = OffsetDateTime::now_utc();
            let key = key_for("u1", &["s1".to_string()]);
            let mut ledger = CuratorLedger::load("b");
            observe(&mut ledger, &key, now);

            for _ in 0..policy.max_attempts {
                commit_unit(
                    "b",
                    &mut ledger,
                    &key,
                    CuratorRunAudit::new(&new_run_id(), "b", &key, now)
                        .with_no_proposal_reason(NoProposalReason::ProviderTimeout)
                        .finished_at(now),
                    UnitOutcome::Deferred(CuratorErrorCode::ProviderTimeout),
                    &policy,
                    now,
                )
                .unwrap();
            }

            let statuses: Vec<CuratorUnitStatus> =
                read_audit("b").iter().map(|l| l.unit_status).collect();
            assert_eq!(
                statuses,
                vec![
                    CuratorUnitStatus::Deferred,
                    CuratorUnitStatus::Deferred,
                    CuratorUnitStatus::ExpiredVisible,
                ],
                "each retry is auditable and the exhaustion is stated in the line, \
                 not inferred from a missing one"
            );
            assert_eq!(
                ledger.get(&key).unwrap().status,
                CuratorUnitStatus::ExpiredVisible,
                "the audit line agrees with the ledger"
            );
        });
    }

    #[test]
    fn rejected_and_deferred_outcomes_are_recorded() {
        with_temp_home(|| {
            let now = OffsetDateTime::now_utc();
            let key = key_for("u1", &["s1".to_string()]);
            let mut ledger = CuratorLedger::load("b");
            observe(&mut ledger, &key, now);
            let verification = serde_json::json!({
                "verifier_version": 1,
                "gates": [{"gate": "g06_verify_lexical_integrity", "effect": "reject",
                           "code": "LiteralMismatch"}],
            });
            let audit = CuratorRunAudit::new(&new_run_id(), "b", &key, now)
                .with_outcome(
                    CandidateAuditOutcome::new(
                        b"{cand-a}",
                        AuditOutcomeKind::Rejected,
                        &verification,
                    )
                    .unwrap(),
                )
                .with_outcome(
                    CandidateAuditOutcome::new(b"{cand-b}", AuditOutcomeKind::NoOp, &verification)
                        .unwrap(),
                )
                .with_outcome(
                    CandidateAuditOutcome::new(
                        b"{cand-c}",
                        AuditOutcomeKind::ProposalReady,
                        &verification,
                    )
                    .unwrap()
                    .with_proposal_id("3f8c2a94d1e07b56"),
                )
                .finished_at(now);
            commit_unit(
                "b",
                &mut ledger,
                &key,
                audit,
                UnitOutcome::Completed,
                &RetryPolicy::default(),
                now,
            )
            .unwrap();

            let lines = read_audit("b");
            assert_eq!(lines.len(), 1);
            let kinds: Vec<AuditOutcomeKind> =
                lines[0].outcomes.iter().map(|o| o.outcome).collect();
            assert_eq!(
                kinds,
                vec![
                    AuditOutcomeKind::Rejected,
                    AuditOutcomeKind::NoOp,
                    AuditOutcomeKind::ProposalReady
                ],
                "rejects are the false-reject numerator; they must survive"
            );
            assert_eq!(
                lines[0].outcomes[2].proposal_id.as_deref(),
                Some("3f8c2a94d1e07b56")
            );
            assert!(lines[0].outcomes[0].proposal_id.is_none());
        });
    }

    #[test]
    fn audit_never_contains_the_raw_candidate_bytes() {
        with_temp_home(|| {
            let now = OffsetDateTime::now_utc();
            let key = key_for("u1", &["s1".to_string()]);
            let mut ledger = CuratorLedger::load("b");
            observe(&mut ledger, &key, now);
            let secret = br#"{"statement":"token ghp_SUPERSECRET is in /Users/dath/x"}"#;
            let audit = CuratorRunAudit::new(&new_run_id(), "b", &key, now)
                .with_outcome(
                    CandidateAuditOutcome::new(
                        secret,
                        AuditOutcomeKind::Rejected,
                        &serde_json::json!({"gates": []}),
                    )
                    .unwrap(),
                )
                .finished_at(now);
            commit_unit(
                "b",
                &mut ledger,
                &key,
                audit,
                UnitOutcome::Completed,
                &RetryPolicy::default(),
                now,
            )
            .unwrap();

            let raw =
                std::fs::read_to_string(audit_segment_path("b", &now.format(&Rfc3339).unwrap()))
                    .unwrap();
            assert!(!raw.contains("ghp_SUPERSECRET"));
            assert!(!raw.contains("/Users/dath"));
            assert!(raw.contains(&candidate_sha256(secret)));
        });
    }

    #[test]
    fn audit_segments_rotate_monthly() {
        with_temp_home(|| {
            let july = OffsetDateTime::parse("2026-07-31T23:00:00Z", &Rfc3339).unwrap();
            let august = OffsetDateTime::parse("2026-08-01T01:00:00Z", &Rfc3339).unwrap();
            for (i, when) in [july, august].iter().enumerate() {
                let key = key_for(&format!("u{i}"), &["s1".to_string()]);
                append_audit("b", &no_proposal_audit(&key, *when)).unwrap();
            }
            assert!(audit_segment_path("b", "2026-07-31T23:00:00Z").exists());
            assert!(audit_segment_path("b", "2026-08-01T01:00:00Z").exists());
            let lines = read_audit("b");
            assert_eq!(lines.len(), 2, "all segments are read back, in order");
            assert_eq!(lines[0].unit_id, "u0");
            assert_eq!(lines[1].unit_id, "u1");
        });
    }

    // --- durable ordering / crash replay ----------------------------------

    #[test]
    fn audit_append_failure_keeps_the_unit_deferred_and_blocks_the_watermark() {
        with_temp_home(|| {
            let now = OffsetDateTime::now_utc();
            let key = key_for("u1", &["s1".to_string()]);
            let mut ledger = CuratorLedger::load("b");
            observe(&mut ledger, &key, now);

            // Wedge the audit segment: a DIRECTORY where the JSONL goes.
            let seg = audit_segment_path("b", &now.format(&Rfc3339).unwrap());
            std::fs::create_dir_all(&seg).unwrap();

            let err = commit_unit(
                "b",
                &mut ledger,
                &key,
                no_proposal_audit(&key, now),
                UnitOutcome::Completed,
                &RetryPolicy::default(),
                now,
            );
            assert!(err.is_err(), "an unwritable audit is a failed commit");
            assert_eq!(
                ledger.get(&key).unwrap().status,
                CuratorUnitStatus::Deferred,
                "the unit stays deferred — an unrecorded result is not completed"
            );
            assert!(
                ledger.advance_watermark(now).is_err(),
                "an audit append failure blocks the watermark"
            );
            assert!(CuratorLedger::load("b").watermark_time().is_none());
        });
    }

    // A tiny stand-in for Wave 3's runner: read → filter → group →
    // process every unit the ledger still wants.
    fn replay_pass(brain: &str, now: OffsetDateTime, crash_after_first: bool) -> usize {
        let policy = RetryPolicy::default();
        let mut ledger = CuratorLedger::load(brain);
        let start = ledger.window_start(now, Duration::hours(48), Duration::days(7));
        let mut events = read_window(brain, start, now + Duration::hours(1), None);
        lineage::retain_eligible(&mut events);
        let units = group_units(&events);
        let mut processed = 0;
        for unit in &units {
            let key = key_for(&unit.unit_id, &unit.event_ids);
            if !ledger.needs_processing(&key, now) {
                continue;
            }
            let first = events
                .iter()
                .find(|e| e.event_id == unit.event_ids[0])
                .unwrap();
            let last_ts = first.ts.clone();
            ledger.observe(
                &key,
                brain,
                JournalCursor::from_event(first),
                &last_ts,
                &policy,
                now,
            );
            commit_unit(
                brain,
                &mut ledger,
                &key,
                no_proposal_audit(&key, now),
                UnitOutcome::Completed,
                &policy,
                now,
            )
            .unwrap();
            processed += 1;
            if crash_after_first {
                // The process dies before the watermark advances.
                return processed;
            }
        }
        ledger.advance_watermark(now).unwrap();
        ledger.save(brain).unwrap();
        processed
    }

    fn turn(brain: &str, turn_id: &str) -> Vec<Event> {
        let mut open = Event::now(brain, "context_decision", "prompt", "sha-prompt");
        open.event_id = turn_id.to_string();
        open.turn_id = Some(turn_id.to_string());
        open.session_id = Some("sess-1".into());
        open.capture_method = "ambient".into();
        let mut stop = Event::now(brain, "assistant_response_completed", "session", "sess-1");
        stop.event_id = format!("{turn_id}-stop");
        stop.turn_id = Some(turn_id.to_string());
        stop.session_id = Some("sess-1".into());
        stop.capture_method = "hook".into();
        vec![open, stop]
    }

    #[test]
    fn replaying_the_same_journal_produces_zero_new_units() {
        with_temp_home(|| {
            let brain = "replay";
            for e in turn(brain, "ev_ctx_7f21") {
                append(&e).unwrap();
            }
            let now = OffsetDateTime::now_utc();
            assert_eq!(
                replay_pass(brain, now, false),
                1,
                "first pass does the work"
            );
            assert_eq!(
                replay_pass(brain, now, false),
                0,
                "same journal replayed → zero new units (watermark idempotency)"
            );
            assert_eq!(read_audit(brain).len(), 1, "and exactly one audit line");
        });
    }

    #[test]
    fn ledger_survives_process_death_mid_run() {
        with_temp_home(|| {
            let brain = "crash";
            for e in turn(brain, "turn-a") {
                append(&e).unwrap();
            }
            for e in turn(brain, "turn-b") {
                append(&e).unwrap();
            }
            let now = OffsetDateTime::now_utc();

            // Pass 1 dies after the first unit, before the watermark.
            assert_eq!(replay_pass(brain, now, true), 1);
            assert!(
                CuratorLedger::load(brain).watermark_time().is_none(),
                "the crashed run never advanced the watermark"
            );

            // Pass 2 reopens the ledger from disk: the committed unit is
            // NOT reprocessed, the unfinished one is.
            assert_eq!(replay_pass(brain, now, false), 1);
            let lines = read_audit(brain);
            assert_eq!(lines.len(), 2, "no duplicate processing across the crash");
            let mut ids: Vec<&str> = lines.iter().map(|l| l.unit_id.as_str()).collect();
            ids.sort_unstable();
            assert_eq!(ids, vec!["turn-a", "turn-b"]);

            assert_eq!(replay_pass(brain, now, false), 0, "and it settles");
        });
    }

    #[test]
    fn a_crash_before_the_audit_replays_the_unit_exactly_once() {
        with_temp_home(|| {
            let brain = "crash2";
            let now = OffsetDateTime::now_utc();
            let key = key_for("u1", &["s1".to_string()]);

            // Observed and persisted, then the process dies before the
            // audit line is written (step 2 of the durable order).
            let mut ledger = CuratorLedger::load(brain);
            observe(&mut ledger, &key, now);
            ledger.save(brain).unwrap();
            drop(ledger);

            let mut ledger = CuratorLedger::load(brain);
            assert!(
                ledger.needs_processing(&key, now),
                "an un-audited unit replays"
            );
            commit_unit(
                brain,
                &mut ledger,
                &key,
                no_proposal_audit(&key, now),
                UnitOutcome::Completed,
                &RetryPolicy::default(),
                now,
            )
            .unwrap();
            assert_eq!(read_audit(brain).len(), 1);
            assert!(!ledger.needs_processing(&key, now));
        });
    }
}
