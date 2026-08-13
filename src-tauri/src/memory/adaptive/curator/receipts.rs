//! Receipts that attach to a proposal (guide §2.4/§3.4, slice A4).
//!
//! Owns `VerifiedSpan`, `SpanIdentity`, `GateRecord`,
//! `GenerationReceipt`, `VerificationReceipt`, and `CuratorExtension` —
//! the single additive, optional field on `StoredProposal`.
//!
//! Rule inherited from `journal::EvidenceCaptureReceipt`: codes,
//! coordinates and hashes only. No paths, no transcript bytes, no
//! prompts, ever (spec §14). [`CuratorExtension::is_safe`] is the
//! executable form of that rule; a test asserts it over a realistic
//! receipt.
//!
//! # What is identity and what is only a receipt
//!
//! [`VerifiedSpan`] carries two kinds of field:
//!
//! * **Durable identity** — the sanitized segment hash, the three
//!   transform versions, the record-local coordinates and the span
//!   hash. [`VerifiedSpan::identity`] projects exactly these into a
//!   [`SpanIdentity`], and `identity.rs` hashes *only* that projection.
//! * **Replay coordinates** — `evidence_event_id`,
//!   `transcript_prefix_sha256`, `observed_prefix_len`. They let the
//!   server re-open the transcript and re-slice the sentence for the
//!   span-preview panel, and they are deliberately **excluded from
//!   identity**: a later capture that observed a *longer* prefix of the
//!   same session must not mint a new `evidence_key`, or a rejected
//!   memory would resurrect the next night (spec §12.2's
//!   anti-resurrection rule — GateMem's headline failure).
//!
//! Model and prompt fingerprints live in [`GenerationReceipt`] and
//! never enter identity either (spec §12.3: "a model upgrade does not
//! duplicate an identical proposal").

use serde::{Deserialize, Serialize};

/// `CuratorExtension.ext_version`. Bump when the *shape* of the
/// extension changes; the identity contract has its own version in
/// [`super::identity::IDENTITY_VERSION`].
pub const EXT_VERSION: u32 = 1;

/// Longest safe detail a gate may attach to its record. Gate notes are
/// operator hints (`"template:DEC_T1"`), never prose and never text
/// lifted from the transcript.
pub const MAX_GATE_NOTE_BYTES: usize = 120;

/// Longest closed code string (`"literal_mismatch"`).
pub const MAX_CODE_BYTES: usize = 64;

/// Who produced the bytes a span was cut from — derived by the server
/// from host record structure, never inferred from content.
///
/// This is the wire spelling of the spec's `SourceKind` (§5.3), using
/// the short tags the guide's §6.6 fixture stores (`"user"`, not
/// `"user_message"`). `transcript.rs` derives the value; this module
/// owns the persisted form because it is part of the stored schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceRole {
    /// spec `SourceKind::UserMessage`
    User,
    /// spec `SourceKind::AssistantMessage`
    Assistant,
    /// spec `SourceKind::ToolResult`
    ToolResult,
    /// spec `SourceKind::FileContent`
    FileContent,
    /// spec `SourceKind::WebContent`
    WebContent,
    /// spec `SourceKind::SystemEvent`
    SystemEvent,
}

impl SourceRole {
    /// Stable wire tag (matches the serde spelling).
    pub fn as_str(self) -> &'static str {
        match self {
            SourceRole::User => "user",
            SourceRole::Assistant => "assistant",
            SourceRole::ToolResult => "tool_result",
            SourceRole::FileContent => "file_content",
            SourceRole::WebContent => "web_content",
            SourceRole::SystemEvent => "system_event",
        }
    }
}

/// A server-resolved citation. Safe to persist: coordinates + hashes,
/// never sentence text, never a filesystem path.
///
/// The model never authors any field here. It points at a request-local
/// sentence label (`"S12"`); the server resolves the label against its
/// own sentence table and materializes this record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerifiedSpan {
    /// Journal event id of the `assistant_response_completed` that
    /// carries the `EvidenceReference` this span resolves under — the
    /// UI joins on it. **Replay coordinate, not identity.**
    pub evidence_event_id: String,
    /// `EvidenceReference::Transcript::source_prefix_sha256`.
    /// **Replay coordinate, not identity.**
    pub transcript_prefix_sha256: String,
    /// Bytes of the transcript that were hashed at capture time.
    /// **Replay coordinate, not identity.**
    pub observed_prefix_len: u64,
    /// Index of the parsed record inside the unit's transcript slice.
    pub record_index: u32,
    /// Sha-256 over the **sanitized segment** the sentence was cut
    /// from (the spec's `evidence_content_sha256`, §12.4 tuple). This
    /// is what makes identity content-addressed.
    pub segment_content_sha256: String,
    pub parser_version: u32,
    pub redaction_policy_version: u32,
    pub segmenter_version: u32,
    /// Zero-based sentence index within the record — the durable half
    /// of the sentence ID (the `S{n}` label is request-local).
    pub sentence_index: u32,
    /// Server-derived replay field (spec §12.5), never a model
    /// assertion: byte offset within the sanitized segment.
    pub start_byte: u32,
    /// Server-derived replay field; exclusive end offset.
    pub end_byte: u32,
    /// Sha-256 over the resolved sentence bytes.
    pub span_sha256: String,
    pub role: SourceRole,
}

impl VerifiedSpan {
    /// Durable identity (spec §12.5 + amendment 4).
    ///
    /// Excludes run-local ids (the request-local `"S12"` label does not
    /// appear anywhere in this crate's identity path), excludes the
    /// journal event id and the observed prefix (see the module docs),
    /// and excludes model fingerprints (spec §12.3).
    pub fn identity(&self) -> SpanIdentity {
        SpanIdentity {
            identity_version: super::identity::IDENTITY_VERSION,
            evidence_content_sha256: self.segment_content_sha256.clone(),
            parser_version: self.parser_version,
            redaction_policy_version: self.redaction_policy_version,
            segmenter_version: self.segmenter_version,
            record_index: self.record_index,
            sentence_index: self.sentence_index,
            start_byte: self.start_byte,
            end_byte: self.end_byte,
            span_sha256: self.span_sha256.clone(),
        }
    }
}

/// Stable across replay. Request-local handles and display text are
/// intentionally absent (spec §8).
///
/// All three transform versions ride along, so a segmenter or parser
/// upgrade mints *new* identities rather than colliding with the old
/// ones; old identities stay valid under their recorded versions
/// (guide §2.1, spec L1380–1381).
///
/// The canonical byte encoding used for hashing lives in
/// [`super::identity::canonical_span`].
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SpanIdentity {
    /// `2` — the sentence-ID contract. `1` denoted the retired
    /// model-pointer identity and must never collide with it.
    pub identity_version: u32,
    /// Sha-256 of the sanitized segment (`VerifiedSpan::segment_content_sha256`).
    pub evidence_content_sha256: String,
    pub parser_version: u32,
    pub redaction_policy_version: u32,
    pub segmenter_version: u32,
    pub record_index: u32,
    pub sentence_index: u32,
    pub start_byte: u32,
    pub end_byte: u32,
    pub span_sha256: String,
}

/// What a gate did. Serialized flat so the stored line reads as
/// `{"gate":"g06_verify_lexical_integrity","effect":"reject","code":"literal_mismatch"}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GateOutcome {
    Pass,
    /// Gate was skipped by policy (V1 runs no NLI, so G10 is `not_run`).
    NotRun,
    NoOp,
    Reject,
    Defer,
    RequireReview,
}

impl GateOutcome {
    /// Terminal outcomes stop the lattice; later gates are simply
    /// absent from the trail.
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            GateOutcome::NoOp | GateOutcome::Reject | GateOutcome::Defer
        )
    }
}

/// One line of the verification trail (spec §9's `GateRecord`).
///
/// `gates.rs` (Wave 2) owns the closed `GateName` / `NoOpCode` /
/// `RejectCode` / `DeferCode` / `ReviewCode` enums of spec §9 and
/// renders them into these two stable snake_case strings. Keeping the
/// *stored* form stringly-typed lets the gate lattice evolve without a
/// stored-schema migration; [`GateRecord::is_safe`] enforces that only
/// closed-vocabulary tokens ever reach disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GateRecord {
    /// Stable gate name, e.g. `"g06_verify_lexical_integrity"`.
    pub gate: String,
    pub effect: GateOutcome,
    /// Closed code from the gate's own enum, e.g. `"literal_mismatch"`.
    /// Absent for `pass` / `not_run`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// Bounded safe detail (the spec's `safe_detail`), e.g.
    /// `"template:DEC_T1"`. Never prose, never transcript text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl GateRecord {
    /// A passing gate with no detail.
    pub fn pass(gate: &str) -> Self {
        GateRecord {
            gate: gate.to_string(),
            effect: GateOutcome::Pass,
            code: None,
            note: None,
        }
    }

    /// A gate that policy skipped.
    pub fn not_run(gate: &str) -> Self {
        GateRecord {
            gate: gate.to_string(),
            effect: GateOutcome::NotRun,
            code: None,
            note: None,
        }
    }

    /// A gate that ended the lattice with a closed code.
    pub fn coded(gate: &str, effect: GateOutcome, code: &str) -> Self {
        GateRecord {
            gate: gate.to_string(),
            effect,
            code: Some(code.to_string()),
            note: None,
        }
    }

    /// Attach a bounded operator hint.
    pub fn with_note(mut self, note: &str) -> Self {
        self.note = Some(note.to_string());
        self
    }

    /// True when every stored string is a closed-vocabulary token and
    /// the note is a bounded, path-free, quote-free hint. The receipt
    /// rule ("codes only") is only worth as much as its enforcement.
    pub fn is_safe(&self) -> bool {
        is_safe_token(&self.gate)
            && self.code.as_deref().map(is_safe_token).unwrap_or(true)
            && self.note.as_deref().map(is_safe_note).unwrap_or(true)
    }
}

/// `[a-z0-9_]{1,64}` — the shape every closed code and gate name takes.
pub fn is_safe_token(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= MAX_CODE_BYTES
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// A gate note is bounded, printable ASCII, and carries no path
/// separator, quote, or space that could smuggle prose or a filesystem
/// location into the store.
pub fn is_safe_note(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= MAX_GATE_NOTE_BYTES
        && s.bytes()
            .all(|b| b.is_ascii_graphic() && b != b'/' && b != b'\\' && b != b'"' && b != b'\'')
}

/// How the candidate was generated. Hashes only — the rendered prompt,
/// the request body and the raw response are hashed and dropped
/// (spec §14).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GenerationReceipt {
    /// `"ollama"`.
    pub provider: String,
    /// Model tag as requested, e.g. `"qwen3:30b-a3b-instruct-2507-q4_K_M"`.
    pub model_id: String,
    /// The digest actually served, from the provider's `/api/show` —
    /// pinning what ran, not what was asked for.
    pub model_digest: String,
    /// Sha-256 of the rendered prompt. The prompt text is NEVER stored.
    pub prompt_sha256: String,
    pub request_sha256: String,
    pub response_sha256: String,
    /// `prompt::CURATOR_OUTPUT_SCHEMA` (2 = sentence IDs).
    pub output_schema_version: u32,
    /// RFC-3339 (the spec calls this field `generated_at`; the stored
    /// shape in guide §6.6 is `started_at`).
    pub started_at: String,
    pub duration_ms: u64,
}

/// Optional NLI receipt. V1 ships with `nli: None` — G10 records
/// `not_run` — and the scores are quantized basis points so no binary
/// float can ever reach a digest (spec §12.5, §14).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NliRecord {
    /// Model fingerprint — a receipt, never part of identity.
    pub model_fingerprint: String,
    /// Version of the deterministic premise/hypothesis renderer.
    pub renderer_version: u32,
    pub entailment_bps: u16,
    pub neutral_bps: u16,
    pub contradiction_bps: u16,
}

/// What the deterministic gauntlet checked, under which versions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerificationReceipt {
    /// `gates::VERIFIER_VERSION`.
    pub verifier_version: u32,
    /// `policy::POLICY_EPOCH`, e.g. `"2026-08-vp1"` — bumped only when
    /// the *meaning* or admissibility contract changes, never for an
    /// ordinary prompt or model upgrade (spec §12.1).
    pub policy_epoch: String,
    pub parser_version: u32,
    pub redaction_policy_version: u32,
    /// Amendment 3: the segmenter joins the fingerprint set.
    pub segmenter_version: u32,
    /// Sha-256 over the immutable request envelope the gates read.
    pub envelope_sha256: String,
    /// The full trail including the terminal gate; gates after it are
    /// absent rather than recorded as skipped.
    pub gates: Vec<GateRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nli: Option<NliRecord>,
    pub verified_at: String,
}

impl VerificationReceipt {
    /// The gate that ended the lattice, if any.
    pub fn terminal_gate(&self) -> Option<&GateRecord> {
        self.gates.iter().find(|g| g.effect.is_terminal())
    }

    /// Every gate record carries only closed-vocabulary strings.
    pub fn is_safe(&self) -> bool {
        self.gates.iter().all(GateRecord::is_safe)
    }
}

/// The single additive field on `StoredProposal` (guide §2.4).
/// Everything the review UI needs beyond the existing card, and
/// everything replay needs.
///
/// Wave 3 wires it in as
///
/// ```ignore
/// #[serde(default, skip_serializing_if = "Option::is_none")]
/// pub curator: Option<CuratorExtension>,
/// ```
///
/// on `adaptive::proposals::StoredProposal` — additive and optional, so
/// old `proposals.jsonl` lines decode untouched and the TypeScript
/// `Proposal` type simply ignores the key until the review UI renders
/// it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CuratorExtension {
    /// [`EXT_VERSION`].
    pub ext_version: u32,
    /// The opening `context_decision` event id (`ExperienceUnit::unit_id`).
    pub unit_id: String,
    /// `"fact" | "preference" | "decision"` — the verified claim class
    /// (`policy.rs` owns the closed vocabulary).
    pub claim_class: String,
    /// Server-derived role of the primary span's source.
    pub source_role: SourceRole,
    /// The one complete sentence the claim is extracted from (G05
    /// designates exactly one Primary).
    pub primary: VerifiedSpan,
    /// Adjacent sentences recorded as context. They cannot be combined
    /// into an extractive window.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub context: Vec<VerifiedSpan>,
    /// [`super::identity::evidence_key`] over the primary + context
    /// identities. Tombstone lookup key.
    pub evidence_key: String,
    /// [`super::identity::claim_key`] — links later evidence to the
    /// same conceptual claim.
    pub claim_key: String,
    pub generation: GenerationReceipt,
    pub verification: VerificationReceipt,
    /// Why the band is `low`, rendered as chips. Closed codes.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub review_codes: Vec<String>,
}

impl CuratorExtension {
    /// Primary first, then context — the order identity hashing sees
    /// before it sorts (sorting lives in `identity.rs`, so no caller
    /// can accidentally make identity order-dependent).
    pub fn span_identities(&self) -> Vec<SpanIdentity> {
        let mut out = Vec::with_capacity(1 + self.context.len());
        out.push(self.primary.identity());
        out.extend(self.context.iter().map(VerifiedSpan::identity));
        out
    }

    /// Distinct source roles across primary + context, sorted — the
    /// spec's `source_kinds` projection (§13.1).
    pub fn source_roles(&self) -> Vec<SourceRole> {
        let mut out: Vec<SourceRole> = std::iter::once(self.primary.role)
            .chain(self.context.iter().map(|s| s.role))
            .collect();
        out.sort_unstable();
        out.dedup();
        out
    }

    /// The receipt rule, executable: closed codes only, and no free
    /// prose or path-shaped string anywhere in the verification trail.
    pub fn is_safe(&self) -> bool {
        is_safe_token(&self.claim_class)
            && self.verification.is_safe()
            && self.review_codes.iter().all(|c| is_safe_token(c))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn span() -> VerifiedSpan {
        VerifiedSpan {
            evidence_event_id: "ev_stop_9c44".into(),
            transcript_prefix_sha256: "c0ffee11".repeat(8),
            observed_prefix_len: 871,
            record_index: 0,
            segment_content_sha256: "5e1d0b8f".repeat(8),
            parser_version: 1,
            redaction_policy_version: 1,
            segmenter_version: 1,
            sentence_index: 0,
            start_byte: 0,
            end_byte: 45,
            span_sha256: "9b41c7e2".repeat(8),
            role: SourceRole::User,
        }
    }

    fn extension() -> CuratorExtension {
        CuratorExtension {
            ext_version: EXT_VERSION,
            unit_id: "ev_ctx_7f21".into(),
            claim_class: "decision".into(),
            source_role: SourceRole::User,
            primary: span(),
            context: Vec::new(),
            evidence_key: "a77b12c9e03d4f58".into(),
            claim_key: "7d2e91c40b5aa318".into(),
            generation: GenerationReceipt {
                provider: "ollama".into(),
                model_id: "qwen3:30b-a3b-instruct-2507-q4_K_M".into(),
                model_digest: "sha256:9f3c1e".into(),
                prompt_sha256: "aa".repeat(32),
                request_sha256: "bb".repeat(32),
                response_sha256: "cc".repeat(32),
                output_schema_version: 2,
                started_at: "2026-08-12T02:09:12Z".into(),
                duration_ms: 86_412,
            },
            verification: VerificationReceipt {
                verifier_version: 1,
                policy_epoch: "2026-08-vp1".into(),
                parser_version: 1,
                redaction_policy_version: 1,
                segmenter_version: 1,
                envelope_sha256: "dd".repeat(32),
                gates: vec![
                    GateRecord::pass("g00_validate_output_envelope"),
                    GateRecord::pass("g07_verify_attribution_binding").with_note("template:DEC_T1"),
                    GateRecord::not_run("g10_score_entailment"),
                ],
                nli: None,
                verified_at: "2026-08-12T02:10:44Z".into(),
            },
            review_codes: Vec::new(),
        }
    }

    /// The guide's §6.6 stored line, verbatim (hashes illustrative,
    /// structure exact). JSON tolerates the doc's line wrapping.
    const GOLDEN_6_6: &str = r#"
{"proposal_id":"3f8c2a94d1e07b56","brain_id":"NeuroVaultBrain1","action":"curator_remember_decision",
 "memory_type":"engram","object_id":"curator/7d2e91c40b5aa318","title":"Remember: Atlas deploys only on Tuesdays.",
 "reason":"Extracted from your atlas session; every value verified against the transcript (12 gates).",
 "band":"medium",
 "fields":[{"name":"statement","proposed_value":"Atlas deploys only on Tuesdays.","evidence":["ev_ctx_7f21","ev_stop_9c44"]},
           {"name":"subject","proposed_value":"deployment","evidence":["ev_ctx_7f21","ev_stop_9c44"]}],
 "evidence":["ev_ctx_7f21","ev_stop_9c44"],
 "review_status":"unreviewed","application_status":"not_applicable","proposed_at":"2026-08-12T02:10:44Z",
 "curator":{"ext_version":1,"unit_id":"ev_ctx_7f21","claim_class":"decision","source_role":"user",
   "primary":{"evidence_event_id":"ev_stop_9c44","transcript_prefix_sha256":"c0ffee11…","observed_prefix_len":871,
              "record_index":0,"segment_content_sha256":"5eg0…","parser_version":1,"redaction_policy_version":1,
              "segmenter_version":1,"sentence_index":0,"start_byte":0,"end_byte":45,"span_sha256":"9b41…","role":"user"},
   "context":[],"evidence_key":"a77b12c9e03d4f58","claim_key":"7d2e91c40b5aa318",
   "generation":{"provider":"ollama","model_id":"qwen3:30b-a3b-instruct-2507-q4_K_M","model_digest":"sha256:9f3c1e…",
                 "prompt_sha256":"…","request_sha256":"…","response_sha256":"…","output_schema_version":2,
                 "started_at":"2026-08-12T02:09:12Z","duration_ms":86412},
   "verification":{"verifier_version":1,"policy_epoch":"2026-08-vp1","parser_version":1,"redaction_policy_version":1,
                   "segmenter_version":1,"envelope_sha256":"…","verified_at":"2026-08-12T02:10:44Z",
                   "gates":[{"gate":"g00_validate_output_envelope","effect":"pass"}, {"gate":"g01_resolve_allowed_object","effect":"pass"},
                            {"gate":"g02_resolve_allowed_evidence","effect":"pass"}, {"gate":"g03_enforce_action_field_contract","effect":"pass"},
                            {"gate":"g04_enforce_scope_and_source_policy","effect":"pass"}, {"gate":"g05_enforce_atomic_claim","effect":"pass"},
                            {"gate":"g06_verify_lexical_integrity","effect":"pass"}, {"gate":"g07_verify_attribution_binding","effect":"pass","note":"template:DEC_T1"},
                            {"gate":"g08_verify_polarity_modality_and_time","effect":"pass"}, {"gate":"g09_screen_sensitive_content","effect":"pass"},
                            {"gate":"g10_score_entailment","effect":"not_run"}, {"gate":"g11_check_existing_state","effect":"pass"}]},
   "review_codes":[]}}
"#;

    /// The Wave-3 wiring shape, exercised here without touching
    /// `proposals.rs`: `StoredProposal` + one additive optional key.
    #[derive(Debug, Serialize, Deserialize)]
    struct StoredProposalWithCurator {
        #[serde(flatten)]
        base: crate::memory::adaptive::proposals::StoredProposal,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        curator: Option<CuratorExtension>,
    }

    // ---- §6.6 shape fixture -------------------------------------

    #[test]
    fn golden_line_decodes_as_todays_stored_proposal() {
        // The curator key is additive: the CURRENT type ignores it.
        let base: crate::memory::adaptive::proposals::StoredProposal =
            serde_json::from_str(GOLDEN_6_6).expect("§6.6 line must parse as a StoredProposal");
        assert_eq!(base.proposal_id, "3f8c2a94d1e07b56");
        assert_eq!(base.band, "medium");
        assert_eq!(base.evidence, vec!["ev_ctx_7f21", "ev_stop_9c44"]);
        assert_eq!(base.fields.len(), 2);
    }

    #[test]
    fn golden_line_decodes_into_the_wave3_shape() {
        let rec: StoredProposalWithCurator =
            serde_json::from_str(GOLDEN_6_6).expect("§6.6 line must parse with the extension");
        let ext = rec.curator.expect("curator extension present");
        assert_eq!(ext.ext_version, EXT_VERSION);
        assert_eq!(ext.unit_id, "ev_ctx_7f21");
        assert_eq!(ext.claim_class, "decision");
        assert_eq!(ext.source_role, SourceRole::User);
        assert_eq!(ext.primary.evidence_event_id, "ev_stop_9c44");
        assert_eq!(ext.primary.observed_prefix_len, 871);
        assert_eq!(ext.primary.end_byte, 45);
        assert!(ext.context.is_empty());
        assert_eq!(ext.generation.output_schema_version, 2);
        assert_eq!(ext.generation.duration_ms, 86_412);
        assert_eq!(ext.verification.policy_epoch, "2026-08-vp1");
        assert_eq!(ext.verification.gates.len(), 12);
        assert_eq!(
            ext.verification.gates[7].note.as_deref(),
            Some("template:DEC_T1")
        );
        assert_eq!(ext.verification.gates[10].effect, GateOutcome::NotRun);
        assert!(ext.verification.nli.is_none());
        assert!(ext.verification.terminal_gate().is_none());
        assert!(ext.review_codes.is_empty());
    }

    // ---- schema-shape stability ---------------------------------

    /// The stored key set, alphabetically — `serde_json::Value` holds a
    /// `BTreeMap` here (no `preserve_order` feature), so this is the
    /// *set* of names, which is what must never drift. Wire order is
    /// pinned separately, against the serialized string.
    fn keys(v: &serde_json::Value) -> Vec<String> {
        v.as_object().expect("object").keys().cloned().collect()
    }

    #[test]
    fn extension_key_set_never_changes_silently() {
        let v = serde_json::to_value(extension()).unwrap();
        assert_eq!(
            keys(&v),
            vec![
                "claim_class",
                "claim_key",
                "evidence_key",
                "ext_version",
                "generation",
                "primary",
                "source_role",
                "unit_id",
                "verification",
            ],
            "empty `context` and `review_codes` are omitted; every other key is load-bearing"
        );
        assert_eq!(
            keys(&v["primary"]),
            vec![
                "end_byte",
                "evidence_event_id",
                "observed_prefix_len",
                "parser_version",
                "record_index",
                "redaction_policy_version",
                "role",
                "segment_content_sha256",
                "segmenter_version",
                "sentence_index",
                "span_sha256",
                "start_byte",
                "transcript_prefix_sha256",
            ]
        );
        assert_eq!(
            keys(&v["generation"]),
            vec![
                "duration_ms",
                "model_digest",
                "model_id",
                "output_schema_version",
                "prompt_sha256",
                "provider",
                "request_sha256",
                "response_sha256",
                "started_at",
            ]
        );
        assert_eq!(
            keys(&v["verification"]),
            vec![
                "envelope_sha256",
                "gates",
                "parser_version",
                "policy_epoch",
                "redaction_policy_version",
                "segmenter_version",
                "verified_at",
                "verifier_version",
            ],
            "`nli` is absent in V1 (G10 not_run)"
        );
        assert_eq!(keys(&v["verification"]["gates"][0]), vec!["effect", "gate"]);
        assert_eq!(
            keys(&v["verification"]["gates"][1]),
            vec!["effect", "gate", "note"]
        );
    }

    #[test]
    fn span_identity_key_set_never_changes_silently() {
        let v = serde_json::to_value(span().identity()).unwrap();
        assert_eq!(
            keys(&v),
            vec![
                "end_byte",
                "evidence_content_sha256",
                "identity_version",
                "parser_version",
                "record_index",
                "redaction_policy_version",
                "segmenter_version",
                "sentence_index",
                "span_sha256",
                "start_byte",
            ]
        );
        // …and the wire order, which serde emits in declaration order.
        assert_eq!(
            serde_json::to_string(&span().identity()).unwrap(),
            concat!(
                "{\"identity_version\":2,",
                "\"evidence_content_sha256\":\"5e1d0b8f5e1d0b8f5e1d0b8f5e1d0b8f5e1d0b8f5e1d0b8f5e1d0b8f5e1d0b8f\",",
                "\"parser_version\":1,",
                "\"redaction_policy_version\":1,",
                "\"segmenter_version\":1,",
                "\"record_index\":0,",
                "\"sentence_index\":0,",
                "\"start_byte\":0,",
                "\"end_byte\":45,",
                "\"span_sha256\":\"9b41c7e29b41c7e29b41c7e29b41c7e29b41c7e29b41c7e29b41c7e29b41c7e2\"}"
            )
        );
        assert_eq!(v["identity_version"], 2);
    }

    #[test]
    fn source_role_wire_tags_are_stable() {
        for (role, tag) in [
            (SourceRole::User, "user"),
            (SourceRole::Assistant, "assistant"),
            (SourceRole::ToolResult, "tool_result"),
            (SourceRole::FileContent, "file_content"),
            (SourceRole::WebContent, "web_content"),
            (SourceRole::SystemEvent, "system_event"),
        ] {
            assert_eq!(serde_json::to_value(role).unwrap(), tag);
            assert_eq!(role.as_str(), tag);
            let back: SourceRole = serde_json::from_str(&format!("\"{tag}\"")).unwrap();
            assert_eq!(back, role);
        }
    }

    #[test]
    fn gate_outcome_wire_tags_are_stable() {
        for (o, tag) in [
            (GateOutcome::Pass, "pass"),
            (GateOutcome::NotRun, "not_run"),
            (GateOutcome::NoOp, "no_op"),
            (GateOutcome::Reject, "reject"),
            (GateOutcome::Defer, "defer"),
            (GateOutcome::RequireReview, "require_review"),
        ] {
            assert_eq!(serde_json::to_value(o).unwrap(), tag);
        }
    }

    // ---- serde round-trip stability -----------------------------

    #[test]
    fn extension_round_trips_identically() {
        let ext = extension();
        let json = serde_json::to_string(&ext).unwrap();
        let back: CuratorExtension = serde_json::from_str(&json).unwrap();
        assert_eq!(ext, back);
        assert_eq!(json, serde_json::to_string(&back).unwrap());
    }

    #[test]
    fn receipts_round_trip_individually() {
        let ext = extension();
        let s = ext.primary.clone();
        let back: VerifiedSpan = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        assert_eq!(s, back);
        let g = ext.generation.clone();
        let back: GenerationReceipt =
            serde_json::from_str(&serde_json::to_string(&g).unwrap()).unwrap();
        assert_eq!(g, back);
        let v = ext.verification.clone();
        let back: VerificationReceipt =
            serde_json::from_str(&serde_json::to_string(&v).unwrap()).unwrap();
        assert_eq!(v, back);
        let id = s.identity();
        let back: SpanIdentity =
            serde_json::from_str(&serde_json::to_string(&id).unwrap()).unwrap();
        assert_eq!(id, back);
    }

    #[test]
    fn nli_record_round_trips_when_present() {
        let mut ext = extension();
        ext.verification.nli = Some(NliRecord {
            model_fingerprint: "sha256:deadbeef".into(),
            renderer_version: 1,
            entailment_bps: 9_412,
            neutral_bps: 500,
            contradiction_bps: 88,
        });
        let json = serde_json::to_string(&ext).unwrap();
        assert!(json.contains("\"nli\""));
        let back: CuratorExtension = serde_json::from_str(&json).unwrap();
        assert_eq!(ext, back);
    }

    #[test]
    fn absent_optional_keys_decode_as_defaults() {
        let ext = extension();
        let json = serde_json::to_string(&ext).unwrap();
        assert!(!json.contains("\"context\""));
        assert!(!json.contains("\"review_codes\""));
        assert!(!json.contains("\"nli\""));
        let back: CuratorExtension = serde_json::from_str(&json).unwrap();
        assert!(back.context.is_empty());
        assert!(back.review_codes.is_empty());
    }

    // ---- identity projection ------------------------------------

    #[test]
    fn identity_takes_the_durable_fields_only() {
        let s = span();
        let id = s.identity();
        assert_eq!(
            id.identity_version,
            super::super::identity::IDENTITY_VERSION
        );
        assert_eq!(id.evidence_content_sha256, s.segment_content_sha256);
        assert_eq!(id.span_sha256, s.span_sha256);
        assert_eq!(id.sentence_index, s.sentence_index);
        assert_eq!(id.record_index, s.record_index);
        assert_eq!((id.start_byte, id.end_byte), (s.start_byte, s.end_byte));
        // No replay coordinate leaked in.
        let json = serde_json::to_string(&id).unwrap();
        assert!(!json.contains("evidence_event_id"));
        assert!(!json.contains(&s.evidence_event_id));
        assert!(!json.contains(&s.transcript_prefix_sha256));
        assert!(!json.contains("871"));
    }

    #[test]
    fn identity_survives_a_longer_observed_prefix() {
        // The anti-resurrection property: tonight's capture read 871
        // bytes, tomorrow's reads 4 210 of the same growing session and
        // binds a different journal event. Same sentence ⇒ same
        // identity ⇒ the tombstone still bites.
        let today = span();
        let mut tomorrow = span();
        tomorrow.observed_prefix_len = 4_210;
        tomorrow.transcript_prefix_sha256 = "ffffffff".repeat(8);
        tomorrow.evidence_event_id = "ev_stop_aa01".into();
        assert_ne!(today, tomorrow);
        assert_eq!(today.identity(), tomorrow.identity());
    }

    #[test]
    fn identity_changes_when_a_transform_version_changes() {
        let base = span();
        let mutations: [fn(&mut VerifiedSpan); 9] = [
            |s| s.parser_version = 2,
            |s| s.redaction_policy_version = 2,
            |s| s.segmenter_version = 2,
            |s| s.sentence_index = 1,
            |s| s.record_index = 1,
            |s| s.segment_content_sha256 = "00".repeat(32),
            |s| s.span_sha256 = "11".repeat(32),
            |s| s.start_byte = 7,
            |s| s.end_byte = 46,
        ];
        for mutate in mutations {
            let mut other = base.clone();
            mutate(&mut other);
            assert_ne!(
                base.identity(),
                other.identity(),
                "a transform/coordinate change must mint a new identity"
            );
        }
    }

    #[test]
    fn span_identities_lists_primary_then_context() {
        let mut ext = extension();
        let mut ctx = span();
        ctx.sentence_index = 3;
        ctx.role = SourceRole::Assistant;
        ext.context = vec![ctx];
        let ids = ext.span_identities();
        assert_eq!(ids.len(), 2);
        assert_eq!(ids[0], ext.primary.identity());
        assert_eq!(ids[1].sentence_index, 3);
        assert_eq!(
            ext.source_roles(),
            vec![SourceRole::User, SourceRole::Assistant]
        );
    }

    // ---- the receipt rule ---------------------------------------

    #[test]
    fn a_realistic_receipt_carries_no_path_prompt_or_transcript_text() {
        let json = serde_json::to_string(&extension()).unwrap();
        assert!(!json.contains("/Users/"));
        assert!(!json.contains(".jsonl"));
        assert!(!json.contains("Atlas deploys"));
        assert!(extension().is_safe());
    }

    #[test]
    fn gate_records_reject_prose_paths_and_quotes() {
        assert!(GateRecord::pass("g06_verify_lexical_integrity").is_safe());
        assert!(GateRecord::coded(
            "g06_verify_lexical_integrity",
            GateOutcome::Reject,
            "literal_mismatch"
        )
        .is_safe());
        assert!(GateRecord::pass("g07_verify_attribution_binding")
            .with_note("template:DEC_T1")
            .is_safe());

        // A gate that tries to explain itself in prose, leak a path, or
        // quote the transcript fails the check.
        assert!(!GateRecord::pass("G06 Verify Lexical Integrity").is_safe());
        assert!(!GateRecord::pass("g06")
            .with_note("/Users/dath/.claude/projects/x.jsonl")
            .is_safe());
        assert!(!GateRecord::pass("g06")
            .with_note("the source said \"deploy on Tuesdays\"")
            .is_safe());
        assert!(!GateRecord::coded("g06", GateOutcome::Reject, "Literal Mismatch").is_safe());
        assert!(!GateRecord::pass("g06")
            .with_note(&"x".repeat(121))
            .is_safe());

        let mut ext = extension();
        ext.verification
            .gates
            .push(GateRecord::pass("g11").with_note("/etc/passwd"));
        assert!(!ext.is_safe());
    }

    #[test]
    fn terminal_gate_is_the_one_that_stopped_the_lattice() {
        let mut ext = extension();
        assert!(ext.verification.terminal_gate().is_none());
        ext.verification.gates.push(GateRecord::coded(
            "g06_verify_lexical_integrity",
            GateOutcome::Reject,
            "literal_mismatch",
        ));
        let t = ext.verification.terminal_gate().expect("terminal gate");
        assert_eq!(t.gate, "g06_verify_lexical_integrity");
        assert_eq!(t.code.as_deref(), Some("literal_mismatch"));
        assert!(!GateOutcome::Pass.is_terminal());
        assert!(!GateOutcome::NotRun.is_terminal());
        assert!(!GateOutcome::RequireReview.is_terminal());
        assert!(GateOutcome::Reject.is_terminal());
        assert!(GateOutcome::NoOp.is_terminal());
        assert!(GateOutcome::Defer.is_terminal());
    }
}
