# Local Memory Curator: evidence and verification contract

> **Status:** IMPLEMENTATION IN PROGRESS, 2026-07-30. Phase A evidence
> foundations are authorized; model access, proposal generation, and
> every semantic write path remain unimplemented and unauthorized.
>
> **Scope:** an optional, local, background model that proposes durable
> memories from complete NeuroVault experience units. The existing
> journal, deterministic consolidation rules, proposal review, and
> Markdown-canonical storage remain authoritative.

## 1. Decision

NeuroVault may use a local generative model to **propose** memories. It
must never trust that model to verify, persist, merge, supersede, hide,
or delete memory.

The model is an untrusted parser operating inside a deterministic
pipeline:

```text
Event Journal
  -> complete experience units
  -> hardened, privacy-filtered evidence reader
  -> optional local candidate generator
  -> deterministic policy verifier plus optional advisory NLI
  -> existing proposal store and Memory Review
  -> explicit application executor
  -> Markdown memory plus append-only journal event
```

The local curator is optional. If it is disabled, unavailable, or times
out, recall and the current deterministic consolidation rules continue
unchanged. No model call is allowed in hooks, prompt injection, ingest,
recall, or other latency-sensitive paths.

### 1.1 Honest guarantee

The product may say:

> Every AI-proposed memory must cite bound evidence NeuroVault can
> resolve, scope, and fingerprint. Model output is never trusted or
> written directly, and semantic interpretations remain reviewable
> until their class earns automation.

The capture-time digest binds the bytes as observed by NeuroVault's
server when it receives the outcome event. It does not prove what
existed before that receipt. A transcript-backed citation remains
reproducible only while the bound source prefix is available.
NeuroVault stores its hashes and a bounded safe preview, not an
unencrypted transcript copy. If the source later disappears or changes,
the UI must say so and application is blocked. An indefinite
reproducibility claim requires a future durable, privacy-reviewed
evidence snapshot.

It must not say:

- "Fabrication is deterministically impossible."
- "The verifier cannot hallucinate."
- "A real quote proves that the proposed claim is true."
- "An entailment score of 0.9 proves correctness."

Deterministic checks can prove that a citation exists, resolves to the
allowed source, has not changed, is in scope, and satisfies a narrow
policy. They cannot prove every semantic relationship. A proposal can
reuse every token in a real quote and still swap actors, reverse a
relationship, erase a condition, or attach one entity's property to
another entity.

## 2. What stays authoritative

This design extends, rather than replaces, the current architecture:

- `journal.rs` remains the append-only evidence layer.
- `consolidate.rs` still groups events by explicit turn/session identity.
- The current deterministic `propose(events)` rules remain available and
  keep their own evaluation history.
- `proposals.rs` remains the one review store. A second curator queue is
  forbidden.
- Human review status and application status remain independent.
- Markdown remains canonical. SQLite remains a rebuildable index.
- Rejected evidence is not silently retried as different wording.
- Existing Stage 3 admission criteria still govern automation.

The AI employee proposal store, agent-facing `/api/consolidate` queue,
and immediate-write `/api/facts` endpoint are not integration points
for this feature. Curator output must enter
the adaptive proposal lifecycle and can reach a write executor only
after an explicit review/application decision.

The current approval handler immediately executes two existing
deterministic action names. Therefore review and application are not a
fully separate user gesture in today's backend. V1 curator proposals
must be stored with `ApplicationStatus::NotApplicable`; approval records
only the human verdict. No curator action is dispatched by the current
approval handler.

A future application path requires an origin-aware allowlist keyed by
`(ProposalOrigin, CuratorAction, executor_version)` and a separate
explicit apply operation. String equality on `action` is never enough.
This prevents an action-name collision from invoking an existing
executor. Evidence is revalidated immediately before any future apply.

## 3. Threat model

Treat all of the following as untrusted:

1. The local generative model and everything it emits.
2. Transcript, tool, file, web, assistant, and pasted content.
3. Model-supplied source identifiers, offsets, quotes, object IDs,
   timestamps, confidence, and action names.
4. An NLI score or any other learned classifier output.
5. Repeated agreement from the same model.
6. Mutable files referenced by a journal event.

The design must resist:

- fabricated or cross-scope citations;
- valid quotes paired with unsupported conclusions;
- entity, actor, role, predicate, or object swaps;
- negation, modality, tense, condition, and time loss;
- quote splicing and multi-source synthesis;
- user preferences inferred from assistant, tool, file, or web text;
- transcript prompt injection;
- credential, secret, private-path, and sensitive-content persistence;
- replay collisions and rejected-evidence spam;
- feedback loops where curator output becomes its own evidence;
- model hangs, oversized inputs, and missing local runtimes;
- accidental auto-application of destructive actions.

This is not a security boundary against a user or process that already
controls the local account, NeuroVault files, or model runtime.

### 3.1 Counterexamples to the original gauntlet

| Proposed protection | Counterexample that can still pass | Design correction |
|---|---|---|
| Exact quote plus token containment | "Alice gave Bob the key" becomes "Bob gave Alice the key" | Bind actor, predicate, and object; otherwise require review |
| Union of grounding quotes | "Alice proposed Redis" plus "Bob rejected Postgres" becomes "Alice rejected Redis" | One contiguous source span per atomic V1 claim |
| Polarity keyword heuristic | "Do not use X unless Y" loses its exception | Complex negation, conditions, and exceptions require review |
| Real transcript path | The file grows or changes before replay | Bind prefix length, parser version, and content hashes |
| User-message role | A pasted email inside the message becomes the user's belief | Mark quoted and forwarded content as ambiguous provenance |
| Entailment score | NLI accepts an entity swap, number change, or domain-specific code claim | Calibrate in-domain and keep NLI advisory only |
| Repeated agreement | The same model repeats the same systematic mistake | Agreement never raises a trust tier |
| Secret regex | A custom credential or private content misses known patterns | Filter before model access and combine labels, allowlists, formats, and entropy checks |

These are not edge cases to document away. Each becomes a mandatory
regression fixture before the model adapter is enabled.

## 4. Module boundary

The eventual implementation should live under:

```text
src-tauri/src/memory/adaptive/curator/
  mod.rs          orchestration and public traits
  types.rs        untrusted and trusted data contracts
  evidence.rs     hardened readers and evidence envelopes
  proposer.rs     optional local-provider adapter
  verify.rs       deterministic gate pipeline
  nli.rs          optional calibrated entailment scorer
  state.rs        retry ledger and generation receipts
```

The curator is invoked only from `run_proposal`, after the existing
deterministic report has been built and its proposals handled. It must
never run from `build_report` or `run_shadow`; shadow mode remains
deterministic and its report serialization stays byte-for-byte stable.

The proposal-mode seam becomes:

```text
run_proposal
  -> build_report and persist current deterministic proposals unchanged
  -> group internal complete units with their event references
  -> prepare_evidence(unit)
  -> optionally propose_local(model_envelope)
  -> verify_local(candidate, trusted_registry)
  -> convert VerifiedDraft directly into StoredProposal
  -> update curator ledger, pending-turn index, and watermark
```

Add a private `GroupedUnit<'a>` for real event/reference access. The
public `ExperienceUnit` report type remains unchanged. Do not squeeze a
curator draft through today's transient `consolidate::Proposal`, which
cannot carry origin, full identity, span evidence, receipts, or curator
keys and would silently discard them.

Deterministic and curator-produced proposals must carry distinct
origins and must be measured as separate classes. A local model cannot
inherit the trust earned by a deterministic rule.

The public seams are intentionally narrow:

```rust
pub trait CandidateGenerator: Send + Sync {
    fn fingerprint(&self) -> GeneratorFingerprint;
    fn propose<'a>(
        &'a self,
        envelope: &'a EvidenceEnvelope,
    ) -> Pin<Box<dyn Future<
        Output = Result<GeneratedBatch, CuratorProviderError>
    > + Send + 'a>>;
}

pub struct GeneratedBatch {
    pub batch: CandidateBatch,
    pub receipt: GenerationReceipt,
}

pub struct GeneratorFingerprint {
    pub provider: String,
    pub model_id: String,
    pub model_digest: String,
    pub prompt_sha256: String,
    pub output_schema_version: u16,
}

pub enum CuratorProviderError {
    Unavailable,
    Timeout,
    Cancelled,
    ResponseTooLarge,
    InvalidJson,
    SchemaMismatch,
    ModelFingerprintMismatch,
}

pub struct CuratorPolicy {
    pub version: String,
    pub epoch: u16,
    pub identity_version: u16,
    pub limits: CuratorLimits,
    pub allowed_classes: BTreeSet<ClaimClass>,
    pub nli_policy: BTreeMap<ClaimClass, NliPolicy>,
}

pub enum NliPolicy {
    Disabled,
    Advisory {
        calibration_id: String,
        contradiction_review_bps: u16,
        entailment_pass_bps: u16,
    },
}

pub struct ResolvedAllowedObject {
    pub object_ref: String,
    pub object: VerifiedObject,
}

pub struct CuratorStateView {
    pub state_digest: String,
    pub existing_proposal_ids: BTreeSet<String>,
    pub rejected_evidence_keys: BTreeSet<String>,
    pub active_claims: BTreeMap<String, ActiveClaimSummary>,
}

pub struct ActiveClaimSummary {
    pub claim_key: String,
    pub object_id: String,
    pub canonical_value_sha256: String,
    pub evidence_event_ids: Vec<String>,
}

pub struct VerifyContext<'a> {
    pub scope: &'a Scope,
    pub registry: &'a BTreeMap<String, TrustedEvidenceSegment>,
    pub allowed_objects: &'a BTreeMap<String, ResolvedAllowedObject>,
    pub current_state: &'a CuratorStateView,
    pub policy: &'a CuratorPolicy,
    pub nli: Option<&'a dyn EntailmentScorer>,
}

pub fn verify_candidate(
    candidate: UntrustedCandidate,
    context: &VerifyContext<'_>,
) -> VerificationOutcome;
```

`verify_candidate` performs no filesystem reads, HTTP calls, database
writes, or model generation. Evidence preparation and current-state
loading happen before it; persistence happens only after it returns.

## 5. Evidence must be prepared before model access

The transcript reader is a hard prerequisite, not part of the model
adapter.

For every referenced source it must:

1. Resolve a server-known journal event. Never follow a path supplied
   by model output.
2. Canonicalize the source path.
3. Reject symlinks and paths outside configured transcript roots.
4. Verify brain, room, session, turn, actor, and event scope.
5. Enforce a per-document, per-unit, and per-run byte limit.
6. Apply private-folder and privacy-label exclusions before reading.
7. Redact or reject secrets before content reaches the model.
8. Assign the source role from host structure, not model inference.
9. Bind the evidence to exact bytes, a SHA-256 digest, and the source
   length observed by the outcome event.
10. Return bounded data only. No model tool access, network access, or
    arbitrary file access is permitted.

The reader parses a supported host transcript format into individual
message/tool records and assigns each record's role before building the
envelope. It must not expose an entire mixed-role transcript as one
`ModelEvidenceSegment`. Unknown record shapes are skipped visibly, not
guessed. Quoted or forwarded content inside a user message remains
marked ambiguous unless host structure proves direct authorship.

### 5.1 Mutable transcript rule

A transcript path is not immutable evidence. The file may grow after
the next turn, change, or disappear.

The current Stop hook observes transcript byte length for its
idempotency key, but persists only the raw transcript path in
`source_refs`. V1 must not parse the byte length back out of the
idempotency string or treat an untyped `source_refs` path as a trusted
artifact. Before curator access, outcome capture must add a typed,
server-stamped reference:

```rust
pub enum EvidenceReference {
    Transcript {
        root: ApprovedTranscriptRoot,
        relative_path: String,
        observed_prefix_len: u64,
        source_prefix_sha256: String,
    },
}
```

The host-to-server wire shape is distinct from the journal shape:

```rust
pub enum OutcomeEvidenceInput {
    Transcript {
        absolute_path: String,
        observed_prefix_len: u64,
    },
}
```

The Stop hook sends `observed_prefix_len` as a real field, not only
inside `idempotency_key`. The server confirms that the canonical file
is at least that long, reads and hashes exactly that prefix, and then
constructs the root-relative `EvidenceReference`. A shorter file is
ineligible/deferred. Extra bytes after the observed prefix are ignored.

The endpoint may accept the host's absolute path, but it checks that
path lexically against the approved root — never canonicalizing the
untrusted path — then journals only an approved root identifier plus a
validated relative path. When the curator and
transcript access are enabled, the server hashes exactly the observed
prefix before appending the outcome event. The hook still never reads
transcript content. If hashing exceeds its cap, fails, or lacks user
consent, the outcome remains valid but carries no curator-eligible
evidence reference. Legacy raw transcript
references remain readable for old history but are ineligible for
curator access until safely resolved.

The initial developer-only switch is
`~/.neurovault/local_curator.json`. Both `enabled` and
`transcript_access` must be explicitly `true`; a missing, malformed, or
partially enabled file performs no transcript open. Capture is limited
to one Claude Code `.jsonl` transcript beneath the server-owned
`ClaudeProjects` root, requires a correlated session/turn, and hashes at
most 32 MiB through a fixed-size streaming buffer. Capture failures are
stored as safe status codes without paths or transcript bytes, while the
primary outcome event still appends. The server-recorded opening turn is
authoritative for host and room; request fields cannot widen that scope.

The first safe-open implementation is Unix-only (macOS and Linux). Once
both consent switches are enabled, it canonicalizes the server-owned
approved root once per loaded capture policy, retains the configured
alias for lexical containment, and starts every read from the resolved
root. It walks every component below that root by directory handle with
`openat` plus `O_NOFOLLOW`; stable or raced descendant symlinks cannot
redirect the final read. This permits ordinary symlinked-home, container,
and encrypted-home layouts without ever canonicalizing the untrusted
transcript path. The final descriptor is opened non-blocking and must be
a regular file before any read, so a raced FIFO cannot stall the outcome
channel. Descendant symlinks and backslashes inside Unix filenames are
rejected so the durable locator has one meaning.
Windows returns `PlatformUnsupported` until equivalent handle-relative
reparse-point rejection and file-ID verification are implemented and
tested natively.

Outcome-event idempotency means the first delivery wins. If that first
delivery records a disabled or ineligible capture, redelivering the same
event cannot mutate it into an eligible one. Phase A treats that as a
visible permanent miss. Deduplication scans bounded tails of both the
current and previous monthly segments so a retry at UTC month rollover
does not duplicate the outcome. Any future recovery mechanism must
append a separate typed `evidence_bound` child event rather than edit or
replace the immutable outcome.

For V1, bind an outcome event to the transcript prefix length already
observed for that turn. Verification may read only that prefix and must
check its digest before resolving a span. Store:

```text
(journal_event_id, observed_prefix_len, source_prefix_sha256,
 parser_version, record_index, evidence_content_sha256,
 start_byte, end_byte, span_sha256)
```

If the prefix no longer matches or is unavailable, the result is
`Deferred(EvidenceUnavailable)`, never a silent read of newer bytes.
NeuroVault should not copy raw transcripts into a second store in V1.
An encrypted, bounded, content-addressed evidence snapshot can be
evaluated later if durable quote display proves necessary.

Evidence is re-resolved immediately before a future explicit apply. A
missing or changed source moves application to a visible pending/failed
state; it never relies only on an old NLI score or hash receipt. The
user may still create an explicitly authored memory, but that is a new
user action rather than approval of the curator proposal.

### 5.2 Provenance roles

The server assigns one of these roles:

```rust
pub enum SourceKind {
    UserMessage,
    AssistantMessage,
    ToolResult,
    FileContent,
    WebContent,
    SystemEvent,
}

pub enum ActorClass {
    FirstPartyUser,
    Assistant,
    Tool,
    ExternalAuthor,
    System,
    Unknown,
}

pub enum AuthorshipDisposition {
    Direct,
    Quoted,
    Forwarded,
    Pasted,
    Mixed,
    Unknown,
}

pub enum ApprovedTranscriptRoot {
    ClaudeProjects,
}

pub struct ByteRange {
    pub start_byte: u32,
    pub end_byte: u32,
}
```

Role is policy, not decoration. Tool, file, web, assistant, quoted,
and forwarded content cannot establish the user's identity,
preference, intention, or decision. Only
`FirstPartyUser + Direct` is eligible for those classes. `Mixed` or
`Unknown` always requires review or rejection under the class policy.

## 6. Trusted evidence preparation and model envelope

The model receives opaque evidence handles scoped to one complete
experience unit. It never receives authority-bearing IDs it can choose
freely.

```rust
pub struct PreparedEvidence {
    pub model_envelope: EvidenceEnvelope,
    pub registry: BTreeMap<String, TrustedEvidenceSegment>,
}

/// The only evidence shape serialized to the model.
pub struct EvidenceEnvelope {
    pub schema_version: u16,
    pub run_ref: String,            // opaque and request-local
    pub evidence: Vec<ModelEvidenceSegment>,
    pub objects: Vec<AllowedObject>,
    pub allowed_actions: BTreeSet<CuratorAction>,
    pub limits: CuratorLimits,
}

pub struct ModelEvidenceSegment {
    pub evidence_id: String,       // opaque within this request
    pub source_kind: SourceKind,
    pub actor_class: ActorClass,
    pub authorship: AuthorshipDisposition,
    pub observed_at: String,
    pub content: String,           // bounded and privacy-filtered
}

/// Internal registry. Never serialized to the model.
pub struct TrustedEvidenceSegment {
    pub evidence_id: String,
    pub brain_id: String,
    pub unit_id: String,
    pub journal_event_id: String,
    pub source_kind: SourceKind,
    pub actor: String,
    pub authorship: AuthorshipDisposition,
    pub observed_at: String,
    pub root: ApprovedTranscriptRoot,
    pub relative_path: String,
    pub observed_prefix_len: u64,
    pub source_prefix_sha256: String,
    pub parser_version: String,
    pub redaction_policy_version: String,
    pub record_index: u32,
    pub raw_record_start_byte: u64,
    pub raw_record_end_byte: u64,
    pub content_sha256: String,
    pub content: String,           // exact model-visible segment
    pub redacted_ranges: Vec<ByteRange>,
}

pub struct AllowedObject {
    pub object_ref: String,        // opaque within this request
    pub object_kind: AllowedObjectKind,
    pub safe_label: String,        // bounded and privacy-filtered
}

pub enum AllowedObjectKind {
    NewMemoryScope,
    ExistingEngram,
    FactNamespace,
    Session,
}

pub struct CuratorLimits {
    pub max_documents: u16,
    pub max_document_bytes: u32,
    pub max_total_bytes: u32,
    pub max_candidates: u16,
    pub max_fields_per_candidate: u16,
    pub max_value_bytes: u32,
    pub timeout_ms: u32,
}
```

`PreparedEvidence` exists only for a run. The proposer receives only
`model_envelope`; the verifier receives the internal `registry`. The
durable audit receipt stores hashes and safe metadata, not the raw
request or raw source.

Span offsets are relative to the model-visible sanitized segment, not
the raw transcript file. A candidate span intersecting a redacted range
is rejected. The raw record byte range, parser version,
redaction-policy version, source-prefix hash, and sanitized-content hash
make that transformation reproducible while the source remains
available.

`AllowedObject.safe_label` passes the same path, secret, privacy-label,
and length policy as evidence content. If no safe label can be produced,
use a generic object-kind label or omit that object from the envelope.

## 7. Untrusted model output

The provider must use structured output, but JSON shape is not a truth
guarantee. Rust deserialization remains strict and uses
`deny_unknown_fields`.

The first schema is deliberately closed and bounded. Its support-group
nesting is required for contradiction/supersession evidence and must be
proven against the exact Ollama schema and generated llama.cpp grammar;
unsupported schema features are a build failure, not silently ignored.

```rust
pub const CURATOR_OUTPUT_SCHEMA: u16 = 1;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateBatch {
    pub schema_version: u16,
    pub candidates: Vec<UntrustedCandidate>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UntrustedCandidate {
    pub local_id: u16,             // batch-local only
    pub claim_class: ClaimClass,
    pub action: CuratorAction,
    pub object: CandidateObject,
    pub support: Vec<UntrustedSupportGroup>,
    pub fields: Vec<UntrustedField>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UntrustedSupportGroup {
    pub role: SupportRole,
    pub spans: Vec<UntrustedSpanPointer>,
}

#[serde(rename_all = "snake_case")]
pub enum SupportRole {
    Primary,
    Conflicting,
    Older,
    Newer,
    Synthesis,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UntrustedField {
    pub name: FieldName,
    pub value_kind: ValueKind,
    pub value: String,
    pub evidence: Vec<UntrustedSpanPointer>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UntrustedSpanPointer {
    pub evidence_id: String,
    pub start_byte: u32,
    pub end_byte: u32,
}

#[serde(rename_all = "snake_case")]
pub enum ClaimClass {
    ExtractiveFact,
    ExactIdentifier,
    TypedQuantity,
    ExplicitDeadline,
    AttributedPreference,
    ExplicitDecision,
    ExplicitCommitment,
    ExplicitCorrection,
    WorkingState,
    Summary,
    Inference,
    Contradiction,
    Supersession,
}

#[serde(rename_all = "snake_case")]
pub enum CuratorAction {
    RecordFact,
    RememberPreference,
    RememberDecision,
    RememberCommitment,
    RememberCorrection,
    PatchWorkingState,
    SuggestSummary,
    FlagContradiction,
    SuggestSupersession,
}

#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CandidateObject {
    New { scope_ref: String },
    Existing { object_ref: String },
    FactNamespace { namespace_ref: String },
    Session { session_ref: String },
}

#[serde(rename_all = "snake_case")]
pub enum FieldName {
    Subject,
    Attribute,
    Value,
    Polarity,
    EffectiveAt,
    ValidUntil,
    Preference,
    Decision,
    Commitment,
    DueAt,
    CurrentTask,
    Status,
    NextStep,
    Blocker,
    Summary,
    ConflictingValue,
    PreviousValue,
    CorrectedValue,
    SupersededObject,
    SupersedingObject,
}

#[serde(rename_all = "snake_case")]
pub enum ValueKind {
    Text,
    Boolean,
    Polarity,
    Status,
    Timestamp,
    Quantity,
    ObjectRef,
}
```

The model must not emit:

- `brain_id`, `proposal_id`, `confidence`, or trust band;
- journal event IDs, real object/session IDs, or raw source paths;
- quote text or a source hash;
- source actor, time, or provenance role;
- model, prompt, policy, or verifier identity;
- arbitrary action, type, object, or field names.

The server stamps or resolves all of these.

The server publishes only opaque `scope_ref`, `object_ref`,
`namespace_ref`, and `session_ref` handles in the request envelope.
Model output cannot select an object outside that allowlist. Semantic
fact keys are derived by the server from verified `Subject` and
`Attribute` fields; they are not authority-bearing model output.
Owner, actor, brain, room, and authority scope are always derived from
the trusted registry and resolved object. They are never text fields.

`ValueKind` remains flat for grammar portability, but the verifier
parses it into a closed server type. `Polarity` is `affirmed|negated`;
`Status` uses an action-specific enum; timestamps must parse under the
versioned time policy; quantities require a numeric value plus a known
dimension/unit; and `ObjectRef` must resolve through `AllowedObject`.
The original model string is retained for review beside the canonical
server value.

### 7.1 Action and field contracts

The initial field contracts are closed and versioned:

| Action | Required fields | Optional fields | Forbidden in V1 |
|---|---|---|---|
| `RecordFact` | `Subject`, `Value` | `Attribute`, `Polarity`, `EffectiveAt`, `ValidUntil` | More than one independent subject/value pair |
| `RememberPreference` | `Preference`, `Polarity` | `EffectiveAt`, `ValidUntil` | Any non-user provenance |
| `RememberDecision` | `Decision` | `EffectiveAt` | Assistant/tool/file/web attribution to the user |
| `RememberCommitment` | `Commitment` | `DueAt` | Planned work represented as completed work |
| `RememberCorrection` | `PreviousValue`, `CorrectedValue` | `Subject`, `Attribute`, `EffectiveAt` | Missing before/after evidence |
| `PatchWorkingState` | `CurrentTask`, `Status` | `NextStep`, `Blocker` | An incomplete turn or inferred outcome |
| `SuggestSummary` | `Summary` | none | Extractive or auto-eligible classification |
| `FlagContradiction` | `Subject`, `Value`, `ConflictingValue` | `Attribute` | One-sided evidence or automatic resolution |
| `SuggestSupersession` | `SupersededObject`, `SupersedingObject` | none | Automatic application |

Object-valued fields use opaque handles that must appear in
`AllowedObject`; they do not contain real engram IDs supplied by the
model. An action with any other field set fails G03.

The compatibility matrix is also closed:

| Claim class | Allowed action | Allowed object kind |
|---|---|---|
| `ExtractiveFact`, `ExactIdentifier`, `TypedQuantity`, `ExplicitDeadline` | `RecordFact` | `New` or `FactNamespace` |
| `AttributedPreference` | `RememberPreference` | `New` |
| `ExplicitDecision` | `RememberDecision` | `New` |
| `ExplicitCommitment` | `RememberCommitment` | `New` |
| `ExplicitCorrection` | `RememberCorrection` | `New`, `Existing`, or `FactNamespace` |
| `WorkingState` | `PatchWorkingState` | `Session` |
| `Summary`, `Inference` | `SuggestSummary` | `New` or `Existing` |
| `Contradiction` | `FlagContradiction` | `Existing` or `FactNamespace` |
| `Supersession` | `SuggestSupersession` | `Existing` |

Any other tuple is `Reject(InvalidFieldContract)`. Authority scope
always comes from the resolved object handle, never a model field.

### 7.2 Atomicity rule

V1 high-assurance extraction has exactly one `Primary` support group
containing exactly one span. That span must contain the complete
subject-predicate-value relationship in one sanitized evidence segment.
Every field also cites its own span within that same segment.

Summary/inference may use one `Synthesis` group with multiple spans;
contradiction requires `Primary` and `Conflicting`; supersession
requires `Older` and `Newer`. Those shapes are review-only by class
policy. Any other role/cardinality combination is invalid. Separate
real field spans do not prove that the fields relate to one another.

## 8. Verified types

The verifier materializes source spans itself from its immutable
request envelope. Quote text from model output does not exist.

```rust
pub struct VerifiedSpan {
    pub evidence_id: String,       // request-local, never in identity
    pub identity: SpanIdentity,
    pub source_kind: SourceKind,
    pub actor: String,
    pub observed_at: String,
    pub safe_preview: Option<String>,
}

/// Stable across replay. Request-local handles and display text are
/// intentionally absent.
pub struct SpanIdentity {
    pub journal_event_id: String,
    pub observed_prefix_len: u64,
    pub source_prefix_sha256: String,
    pub parser_version: String,
    pub redaction_policy_version: String,
    pub record_index: u32,
    pub raw_record_start_byte: u64,
    pub raw_record_end_byte: u64,
    pub start_byte: u32,
    pub end_byte: u32,
    pub evidence_content_sha256: String,
    pub span_sha256: String,
}

pub struct VerifiedField {
    pub name: FieldName,
    pub proposed_value: String,
    pub canonical_value: CanonicalValue,
    pub evidence: Vec<VerifiedSpan>,
}

pub struct VerifiedSupportGroup {
    pub role: SupportRole,
    pub spans: Vec<VerifiedSpan>,
}

pub enum CanonicalValue {
    Text(String),
    Boolean(bool),
    Polarity(VerifiedPolarity),
    Status(VerifiedStatus),
    Timestamp {
        utc_rfc3339: String,
        original: String,
    },
    Quantity {
        exact_decimal: String,
        canonical_unit: String,
        dimension: String,
        original: String,
    },
    ObjectRef {
        object_id: String,
    },
}

pub enum VerifiedPolarity {
    Affirmed,
    Negated,
}

pub enum VerifiedStatus {
    Planned,
    Active,
    Blocked,
    Completed,
    Cancelled,
}

pub enum VerifiedObject {
    New {
        scope: Scope,
    },
    Existing {
        engram_id: String,
    },
    FactKey {
        scope: Scope,
        subject_key: String,
        attribute_key: String,
    },
    Session {
        session_id: String,
    },
}

pub struct VerifiedDraft {
    pub action: CuratorAction,
    pub claim_class: ClaimClass,
    pub object: VerifiedObject,
    pub support: Vec<VerifiedSupportGroup>,
    pub fields: Vec<VerifiedField>,
    pub disposition: ProposalDisposition,
    pub verification: VerificationReceipt,
}
```

`safe_preview` is produced after redaction. Raw secret-bearing spans
must never enter proposals, logs, error messages, or the Inspector.

## 9. Gate effect and strict aggregation

```rust
pub enum GateEffect {
    Pass,
    NoOp { code: NoOpCode },
    Reject { code: RejectCode },
    Defer { code: DeferCode },
    RequireReview { code: ReviewCode },
}

pub struct GateRecord {
    pub gate: GateName,
    pub effect: GateEffect,
    pub safe_detail: Option<String>,
}

pub enum ProposalDisposition {
    ReviewRequired,
    ProposalReady,
}

pub enum VerificationOutcome {
    NoOp {
        code: NoOpCode,
        receipt: VerificationReceipt,
    },
    Rejected {
        receipt: VerificationReceipt,
    },
    Deferred {
        retry_after: Option<String>,
        receipt: VerificationReceipt,
    },
    Proposal(VerifiedDraft),
}

pub enum GateName {
    ValidateOutputEnvelope,
    ResolveAllowedObject,
    ResolveAllowedEvidence,
    EnforceActionFieldContract,
    EnforceScopeAndSourcePolicy,
    EnforceAtomicClaim,
    VerifyLexicalIntegrity,
    VerifyAttributionBinding,
    VerifyPolarityModalityAndTime,
    ScreenSensitiveContent,
    ScoreEntailment,
    CheckExistingState,
    DeriveDisposition,
}

pub enum NoOpCode {
    ExactDuplicate,
    RejectedEvidenceTombstone,
}

pub enum RejectCode {
    InvalidEnvelope,
    ObjectOutOfScope,
    InvalidEvidence,
    InvalidFieldContract,
    PrivateEvidence,
    ProvenanceViolation,
    NotExtractive,
    LiteralMismatch,
    AttributionMismatch,
    SemanticStateMismatch,
    SensitiveOutput,
}

pub enum DeferCode {
    ObjectUnavailable,
    EvidenceUnavailable,
    IncompleteTurn,
    ProviderUnavailable,
    ProviderTimeout,
    VerifierUnavailable,
}

pub enum ReviewCode {
    WeakProvenance,
    Synthesis,
    AliasOrParaphrase,
    AmbiguousAttribution,
    ComplexSemantics,
    NliContradiction,
    NliUncertain,
    Conflict,
    DestructiveAction,
    PolicyRequiresReview,
}
```

Aggregation is monotonic and can only become more restrictive:

1. Any `Reject` produces `VerificationOutcome::Rejected`.
2. Otherwise, any `Defer` produces `VerificationOutcome::Deferred`.
3. Otherwise, a terminal G11 `NoOp` produces
   `VerificationOutcome::NoOp`.
4. Otherwise, any `RequireReview` produces a proposal with
   `ProposalDisposition::ReviewRequired`.
5. Otherwise, it produces a proposal with
   `ProposalDisposition::ProposalReady`.

`NoOp` is emitted only by G11 after all validity and privacy gates have
passed. It does not conceal invalid input behind a duplicate result.

In V1, both `ReviewRequired` and `ProposalReady` enter human review.
There is intentionally no `AutoWrite` verifier result. Automation is a
separate, explicit Stage 3 governance decision made from observed data.

## 10. Named verification gates

The verifier executes these gates in order. A terminal effect stops
later expensive work but remains recorded in the local audit receipt.

### G00 `validate_output_envelope`

Checks schema version, unknown fields, enum values, duplicate local
IDs, candidate count, field count, string size, and total response
size.

The HTTP adapter enforces the raw response-byte cap while streaming.
An overflow becomes `Reject(InvalidEnvelope)` without attempting JSON
deserialization.

- Invalid or over limit: `Reject(InvalidEnvelope)`.
- Valid: `Pass`.

### G01 `resolve_allowed_object`

Resolves a new scope, existing engram, fact key, or session against
server-owned state.

- Cross-brain, cross-room, missing, or disallowed object:
  `Reject(ObjectOutOfScope)`.
- Temporarily unavailable index: `Defer(ObjectUnavailable)`.
- Valid: `Pass`.

### G02 `resolve_allowed_evidence`

Resolves every opaque evidence handle against the current envelope,
checks exact UTF-8 byte boundaries and ranges, verifies the document
prefix digest, verifies the parser/redaction fingerprints, rejects a
range that touches redacted content, and materializes the span.

- Unknown handle, out-of-range/invalid UTF-8 offset, cross-unit
  reference, or span touching redacted content:
  `Reject(InvalidEvidence)`.
- Source missing, capture-time prefix digest mismatch, parser/redaction
  fingerprint mismatch, or sanitized segment hash mismatch:
  `Defer(EvidenceUnavailable)`.
- Valid: `Pass`.

A trusted-source mismatch invalidates the prepared envelope, not merely
one candidate. Discard the entire generated batch, rebuild evidence if
possible, and retry under a new evidence digest. It is not blamed on
model output and cannot reuse the old generation receipt.

Whitespace-normalized substring search is forbidden. Exact byte spans
are the authority; normalized text may be used only for display.

### G03 `enforce_action_field_contract`

Each action has a versioned list of required and allowed field names,
value types, length bounds, and required evidence cardinality.

- Action absent from this run's server-issued `allowed_actions`:
  `Reject(InvalidFieldContract)`.
- Missing, extra, duplicated, empty, or ungrounded field:
  `Reject(InvalidFieldContract)`.
- Valid: `Pass`.

### G04 `enforce_scope_and_source_policy`

Checks brain, room, unit, session, actor, source role, privacy label,
and the memory class allowed from that provenance.

- Sensitive/private content: `Reject(PrivateEvidence)`.
- User preference, identity, intention, or decision derived from
  assistant/tool/file/web content: `Reject(ProvenanceViolation)`.
- Weak but permitted provenance: `RequireReview(WeakProvenance)`.
- Valid direct provenance: `Pass`.

Prompt-injection detection may add a warning or rejection, but it is
not the security boundary. Source-role policy and a model with no
tools are the boundary.

### G05 `enforce_atomic_claim`

Rejects or downgrades claims that combine independent propositions,
multiple documents, or unrelated spans.

- Extractive class with multiple independent claims:
  `Reject(NotExtractive)`.
- Legitimate synthesis: `RequireReview(Synthesis)`.
- Extractive class with exactly one `Primary` span containing the full
  relationship, with every field span in that same segment: `Pass`.
- Valid multi-source support groups for synthesis, contradiction, or
  supersession: `RequireReview(Synthesis)` or the destructive/conflict
  class floor.

### G06 `verify_lexical_integrity`

Compares source spans with proposed fields for introduced or changed:

- numbers and signs;
- dates and times;
- versions;
- identifiers and code symbols;
- proper-name candidates;
- units and typed quantities.

- Changed or introduced protected token: `Reject(LiteralMismatch)`.
- A sanctioned alias or paraphrase that preserves no mechanical proof:
  `RequireReview(AliasOrParaphrase)`.
- Exact protected values: `Pass`.

An alias table must never silently equate ambiguous values. Typed unit
conversion is dimension-aware; ambiguous conversion requires review.
Token containment is not treated as entailment.

### G07 `verify_attribution_binding`

Checks that subject, actor, object, and predicate bindings match the
source. It specifically tests role reversal and property transfer.

Examples that must not pass:

- "Alice gave Bob the key" becoming "Bob gave Alice the key."
- "Apple is expensive and orange is sweet" becoming "Apple is sweet."
- An assistant suggestion becoming a user decision.

- Detected binding error: `Reject(AttributionMismatch)`.
- Ambiguous quoted, pasted, or forwarded speech:
  `RequireReview(AmbiguousAttribution)`.
- Binding supplied by a trusted structured journal event or matched by
  a finite, versioned, regression-tested extraction template: `Pass`.
- Other natural-language binding, including a plausible paraphrase:
  `RequireReview(ComplexSemantics)`.

The first template set is deliberately narrow, for example an explicit
first-party "I prefer X," an explicit "we decided X," and an exact
deadline form with a parseable date. Template failure does not mean the
claim is false; it means mechanical verification abstains.

### G08 `verify_polarity_modality_and_time`

Treats the following as different claims:

- affirmed vs negated;
- current vs historical vs planned;
- categorical vs possible, desired, conditional, hypothetical, or
  questioned;
- completed vs attempted vs proposed;
- valid now vs valid during a bounded interval.

- Polarity reversal or completed-state upgrade:
  `Reject(SemanticStateMismatch)`.
- Negation, exception, conditional, comparison, hedge, or time scope
  that is not handled by a narrow typed rule:
  `RequireReview(ComplexSemantics)`.
- State supplied by a trusted structured journal transition or matched
  by a finite, versioned template: `Pass`.
- Other natural-language state interpretation:
  `RequireReview(ComplexSemantics)`.

### G09 `screen_sensitive_content`

Runs after pre-model filtering as defense in depth. It checks both
source preview and proposed values for credentials, tokens, private
paths, high-entropy secret candidates, and configured sensitive
classes.

- Secret or prohibited data: `Reject(SensitiveOutput)`.
- Only a safe reason code is persisted.
- Clean: `Pass`.

Regex alone is insufficient. The policy combines source allowlists,
privacy labels, path policy, structured secret formats, entropy checks,
and user-configured exclusions.

### G10 `score_entailment` (optional adviser)

```rust
pub trait EntailmentScorer: Send + Sync {
    fn fingerprint(&self) -> &str;
    fn score(&self, premise: &str, hypothesis: &str)
        -> Result<NliScores, NliError>;
}

pub struct NliScores {
    pub entailment: f32,
    pub neutral: f32,
    pub contradiction: f32,
}

pub enum NliError {
    Unavailable,
    Timeout,
    InvalidScore,
    InputTooLong,
    FingerprintMismatch,
}
```

For extractive classes, `premise` is the exact single `Primary` support
span. `hypothesis` is
rendered deterministically from the verified action, object, and
canonical fields by a versioned renderer; it is never model-authored
free prose. Scores must be finite, within `[0,1]`, and satisfy the
model's documented normalization tolerance. Receipts store quantized
integer basis points plus the renderer version so JSON float drift does
not change replay identity.

Multi-source synthesis, contradiction, and supersession do not combine
spans into one NLI premise. NLI is `not_applicable` for those V1 classes;
their class policy already requires review.

The current reranker must not be reused simply because it is a
cross-encoder. An NLI model requires NLI-specific weights and
calibration on NeuroVault's own memory types and attack corpus.

- Scorer intentionally not configured: `Pass`, recorded as `not_run`.
- High calibrated contradiction:
  `RequireReview(NliContradiction)`.
- Configured but uncalibrated, unavailable, out-of-domain, or
  uncertain score: `RequireReview(NliUncertain)`.
- High entailment may record `Pass`, but can never override another
  gate, upgrade a class, or authorize a write.

Because NLI is advisory and untrusted, G10 can emit only `Pass` or
`RequireReview` in V1. It can never produce a terminal `Reject` or
`Defer` outcome.

A universal `entailment >= 0.9` threshold is forbidden. Thresholds and
abstention ranges live in versioned policy and are justified by a
held-out calibration set.

### G11 `check_existing_state`

Compares the candidate with current Markdown-derived state and
existing proposals.

- Exact duplicate: `NoOp(ExactDuplicate)`.
- Existing rejected `evidence_key`:
  `NoOp(RejectedEvidenceTombstone)`.
- Conflicting fact: `RequireReview(Conflict)`.
- Merge, supersession, deletion, hiding, or destructive mutation:
  `RequireReview(DestructiveAction)`.
- No conflict: `Pass`.

A conflict needs both evidence chains, temporal ordering, and explicit
scope. A new quote never silently overwrites an active claim.

### G12 `derive_disposition`

Applies the strict effect lattice and the memory-type policy matrix.
It cannot reduce a prior restriction.

## 11. Memory-type policy matrix

| Class | Allowed evidence | V1 outcome | Future ceiling |
|---|---|---|---|
| Exact identifier/version | One direct, contiguous span | Human review | May seek class-specific Stage 3 admission |
| Typed quantity/deadline | One direct span; exact unit/time handling | Human review | May seek Stage 3 after calibration |
| Explicit decision | Direct first-party user statement or trusted structured event | Human review | May seek Stage 3 only as a separately measured class |
| Explicit correction | Direct first-party correction with before/after | Human review | May seek Stage 3 only with reversible executor |
| Preference | Direct first-party assertion only | Human review | Review-only until strong longitudinal evidence exists |
| Intention/commitment | Direct first-party assertion plus time/modality | Human review | Review-only by default |
| Working state | Complete turn plus hardened transcript evidence | Human review | Separate observation window required |
| Summary/theme/profile | Any synthesis | Human review | May remain review-only permanently |
| Contradiction | Two complete evidence chains | Human review | Manual clarification by default |
| Merge/supersede/delete/hide | Two-sided evidence and current state | Human review plus explicit apply | Never auto-apply in the initial curator program |

No class is entitled to automatic application. "Review-only forever"
is a valid product outcome.

`stage3-admission.md` currently defines bars for four deterministic
actions only. Its governance method applies here, but those numerical
bars do not transfer to curator output. Before each curator observation
window, freeze new class-specific criteria and reset the sample to zero.
All measurements partition at least by `origin + action + claim_class +
source_kind`; mixing deterministic and model-generated labels is
forbidden.

## 12. Identity, deduplication, and rejection memory

The current proposal ID hashes action, object, and event IDs. That is
insufficient for model output because two different field values over
the same evidence collide.

Curator proposals use three keys.

### 12.1 `proposal_id`

Semantic identity:

```text
sha256(canonical_json {
  identity_version,
  policy_epoch,
  brain_id,
  action,
  memory_type,
  resolved_object,
  sorted fields {
    name,
    canonical proposed_value,
    sorted SpanIdentity values
  }
})
```

Keep the full 256-bit hash internally. A UI-safe identifier uses at
least 128 bits, for example `cp2_` plus 32 hexadecimal characters.
Mutation APIs accept only the full identifier. A display prefix is
never sufficient to review, reject, or apply a proposal.

`policy_epoch` changes only when the meaning or admissibility contract
changes, not for ordinary prompt or model upgrades.

All identity and ledger digests use `SpanIdentity`. Request-local
`run_ref`, `evidence_id`, safe labels, and previews are explicitly
excluded, so replaying the same bytes produces the same keys.

### 12.2 `evidence_key`

```text
sha256(action + resolved_object + canonical claim_slot
       + sorted SpanIdentity values)
```

A rejected `evidence_key` is a tombstone. The curator cannot repeatedly
offer different wording or values from identical evidence. New
evidence creates a new key and links to the rejected predecessor. The
claim slot prevents rejecting one fact in a sentence from poisoning
every other atomic fact supported by that same span.

Reconsidering identical evidence requires an explicit user action that
creates a journaled reconsideration record and a new review instance.
A prompt, model, or policy upgrade cannot silently bypass the tombstone.

### 12.3 `claim_key`

```text
sha256(action + resolved authority scope + canonical claim_slot)
```

This links later evidence to the same conceptual claim for conflict
display without collapsing distinct proposal contents.

Model, prompt, schema, NLI, and verifier fingerprints do not belong in
semantic identity. They live in receipts, so a model upgrade does not
duplicate an identical proposal.

### 12.4 Claim-slot recipes

| Action | Canonical claim slot |
|---|---|
| `RecordFact` | verified subject + attribute |
| `RememberPreference` | server-derived owner + normalized preference topic |
| `RememberDecision` | server-derived actor + resolved scope + normalized decision topic |
| `RememberCommitment` | server-derived actor + resolved scope + normalized commitment topic |
| `RememberCorrection` | target object/fact key + corrected attribute |
| `PatchWorkingState` | resolved session + working-state field name |
| `SuggestSummary` | resolved scope + summary type |
| `FlagContradiction` | canonical fact/claim key under dispute |
| `SuggestSupersession` | resolved older object + resolved newer object |

The verifier, not the generator, computes this slot after field and
object verification.

### 12.5 Canonicalization version 1

- Validate UTF-8 and normalize human text to Unicode NFC.
- Trim leading/trailing whitespace and collapse internal Unicode space
  runs only for identity; retain original display text.
- Case-fold only fields whose contract declares case-insensitivity.
  Code symbols, versions, paths, and identifiers remain case-sensitive.
- Represent booleans and polarity with enum discriminants.
- Convert timestamps to RFC 3339 UTC while retaining the original and
  its explicit timezone. A missing timezone requires review.
- Represent quantities as exact decimal strings plus dimension and
  canonical unit; do not use binary floats in identity.
- Resolve opaque object references to full server IDs.
- Sort maps and evidence receipts by documented bytewise order.

The canonicalization version is part of `identity_version`. A change
requires a new version and migration/replay tests.

## 13. Backward-compatible proposal-store extension

Existing JSONL records stay readable and are never rewritten.

```rust
pub enum ProposalOrigin {
    DeterministicRule,
    LocalCurator,
}

impl Default for ProposalOrigin {
    fn default() -> Self {
        Self::DeterministicRule
    }
}

pub struct ProposedField {
    // Existing fields remain.
    pub name: String,
    pub proposed_value: String,
    pub approved_value: Option<String>,
    pub evidence: Vec<String>,

    #[serde(default)]
    pub evidence_spans: Vec<VerifiedSpan>,
}

pub struct StoredProposal {
    // Existing fields remain.

    #[serde(default)]
    pub identity_version: u16,
    #[serde(default)]
    pub evidence_key: Option<String>,
    #[serde(default)]
    pub claim_key: Option<String>,
    #[serde(default)]
    pub origin: ProposalOrigin,
    #[serde(default)]
    pub claim_class: Option<ClaimClass>,
    #[serde(default)]
    pub source_kinds: Vec<SourceKind>,
    #[serde(default)]
    pub support: Vec<VerifiedSupportGroup>,
    #[serde(default)]
    pub verification: Option<VerificationReceipt>,
    #[serde(default)]
    pub generation: Option<GenerationReceipt>,
}
```

The existing `evidence: Vec<String>` stays as journal event IDs for
Inspector timeline and API compatibility. `evidence_spans` adds the
stronger proof without breaking old consumers.

### 13.1 Deterministic `VerifiedDraft -> StoredProposal` conversion

The model does not author `memory_type`, `object_id`, `band`, `title`,
or `reason`. The converter derives them after verification:

| Action | Stored `memory_type` | Initial band | Object ID source |
|---|---|---|---|
| `RecordFact` | `fact` | medium | resolved fact key or full claim key |
| `RememberPreference` | `preference` | medium | full claim key |
| `RememberDecision` | `decision` | medium | full claim key |
| `RememberCommitment` | `commitment` | medium | full claim key |
| `RememberCorrection` | `correction` | medium | resolved target or full claim key |
| `PatchWorkingState` | `working_state` | medium | resolved session ID |
| `SuggestSummary` | `summary` | low | resolved scope/object ID |
| `FlagContradiction` | `contradiction` | low | full claim key |
| `SuggestSupersession` | `supersession` | low | resolved older object ID |

No curator proposal receives `high` in V1. Band is review
prioritization, not model confidence.

`title` comes from an action-specific template over bounded safe field
previews, for example `Decision observed: <safe preview>`. `reason` is a
deterministic template naming claim class, source roles, disposition,
and the gate codes that imposed review. Neither accepts model-authored
free prose.

The converter sets:

```text
origin = LocalCurator
review_status = Unreviewed
application_status = NotApplicable
claim_class = verified claim class
source_kinds = sorted distinct kinds from stable support/evidence spans
```

It computes full `proposal_id`, `evidence_key`, and `claim_key`, copies
the union of journal event IDs into the legacy `evidence` field, and
attaches support, field spans, generation receipt, and verification
receipt in one direct construction. No intermediate legacy `Proposal`
is used.

## 14. Reproducibility receipts

Receipts contain hashes and bounded metadata, never raw prompts, raw
model responses, secrets, or private transcript text.

```rust
pub struct GenerationReceipt {
    pub provider: String,
    pub model_id: String,
    pub model_digest: String,
    pub prompt_sha256: String,
    pub output_schema_version: u16,
    pub request_sha256: String,
    pub response_sha256: String,
    pub generated_at: String,
    pub duration_ms: u64,
}

pub struct VerificationReceipt {
    pub verifier_version: String,
    pub policy_version: String,
    pub policy_epoch: u16,
    pub evidence_envelope_sha256: String,
    pub gates: Vec<GateRecord>,
    pub nli_fingerprint: Option<String>,
    pub nli_renderer_version: Option<String>,
    pub nli_scores: Option<NliScoreReceipt>,
    pub verified_at: String,
}

pub struct NliScoreReceipt {
    pub entailment_bps: u16,
    pub neutral_bps: u16,
    pub contradiction_bps: u16,
}
```

Receipts make behavior inspectable and support replay testing. They do
not make a model result deterministic unless the provider, exact model
digest, prompt, runtime, seed, and decoding behavior are reproducible.

### 14.1 Audit outcomes that create no proposal

Rejected, deferred, and no-op candidates still need their gate records
for red-team and operational metrics. Append one safe per-run record to
monthly derived audit segments under the brain:

```rust
pub struct CuratorRunAudit {
    pub run_id: String,
    pub brain_id: String,
    pub unit_id: String,
    pub evidence_digest: String,
    pub generation: Option<GenerationReceipt>,
    pub outcomes: Vec<CandidateAuditOutcome>,
    pub started_at: String,
    pub duration_ms: u64,
}

pub struct CandidateAuditOutcome {
    pub candidate_sha256: String,
    pub outcome: AuditOutcomeKind,
    pub proposal_id: Option<String>,
    pub verification: VerificationReceipt,
}

pub enum AuditOutcomeKind {
    NoOp,
    Rejected,
    Deferred,
    ReviewRequired,
    ProposalReady,
}
```

This derived audit store contains no raw prompt, response, quote,
source path, secret, or request-local handle. Candidate digests use the
raw bounded response bytes only as a one-way hash. Append failure keeps
the unit deferred and prevents watermark advance; an unrecorded
terminal result is not considered completed.

## 15. Self-consistency policy

Repeated sampling is not an independent source of truth. A model can
be consistently wrong, and temperature-zero runs can reproduce the
same mistake exactly.

If self-consistency is evaluated:

- disagreement may mark a candidate unstable and require review;
- agreement may be logged as a weak diagnostic feature;
- agreement cannot raise a trust tier, clear a failed gate, or
  authorize application;
- experiments must name model digest, prompt version, seed, and decode
  settings.

It is not required for V1.

## 16. Retry and watermark correctness

The current pending-turn index preserves incomplete turns. It does not
preserve a complete unit whose local-model call times out while the
consolidation watermark advances.

Add a separate atomic curator-unit ledger:

```rust
pub struct PendingCuratorUnit {
    pub brain_id: String,
    pub unit_id: String,
    pub evidence_digest: String,
    pub policy_epoch: u16,
    pub first_event_ts: String,
    pub last_event_ts: String,
    pub first_journal_cursor: JournalCursor,
    pub status: CuratorUnitStatus,
    pub attempts: u16,
    pub max_attempts: u16,
    pub retry_after: Option<String>,
    pub expires_at: String,
    pub last_safe_error: Option<CuratorErrorCode>,
}

pub struct JournalCursor {
    pub ts: String,
    pub seq: u64,
    pub event_id: String,
}

pub enum CuratorUnitStatus {
    Pending,
    Deferred,
    Completed,
    PermanentlyRejected,
    ExpiredVisible,
    SkippedDisabled,
}

pub enum CuratorErrorCode {
    ProviderUnavailable,
    ProviderTimeout,
    InvalidResponse,
    EvidenceUnavailable,
    PolicyRejected,
    AttemptsExhausted,
}
```

States are `Pending`, `Deferred`, `Completed`, `PermanentlyRejected`,
`ExpiredVisible`, and `SkippedDisabled`. The durable key is
`(brain_id, unit_id, evidence_digest, policy_epoch)`.
`evidence_digest` hashes the sorted stable `SpanIdentity`/segment
identities available to the unit plus the evidence-preparation policy;
it excludes all request-local handles.

When the curator is enabled, a temporary failure keeps the unit in the
ledger and extends the next read window to the oldest unprocessed unit.
When disabled, the system records an intentional skip without creating
a backlog.

`Completed` means the whole bounded candidate batch was deserialized,
each candidate reached a terminal verifier outcome, and all resulting
proposal/receipt records were durably appended. A truncated or partial
HTTP response completes nothing and retries the entire unit; semantic
proposal IDs make that replay idempotent. Expiry is visible in the
Inspector and metrics, never a silent watermark skip.

All proposal-mode consolidation for a brain runs under one per-brain
lock covering read, dedup check, append, ledger updates, and watermark
advance. This is required because the current read-check-append flow is
otherwise vulnerable to two concurrent consolidation runs.

Durable operation order is:

1. append proposal records;
2. atomically update curator-unit ledger;
3. atomically update pending-turn index;
4. advance consolidation watermark.

A crash between steps replays idempotent work. Model failure never
blocks deterministic proposals or recall.

## 17. Feedback-loop isolation

Curator candidates, proposal reviews, application events, generated
summaries, and memories created by this curator are derived state. They
cannot become fresh source evidence for another curator proposal.

Allowed source evidence is limited to original journal experience and
meaningful external outcomes. Existing `capture_method == "review"`
and `event_type.starts_with("consolidation_")` exclusions should grow
into an explicit source policy rather than a string-only convention.

Add durable lineage to journal events:

```rust
pub enum DerivationOrigin {
    OriginalExperience,
    DeterministicConsolidation,
    LocalCurator,
    HumanReview,
    ProposalExecutor,
}

pub struct DerivationMetadata {
    pub origin: DerivationOrigin,
    pub source_proposal_id: Option<String>,
    pub derived_from_event_ids: Vec<String>,
}

pub struct Event {
    // Existing fields remain.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub derivation: Option<DerivationMetadata>,
}
```

An executor that creates a normal-looking `note_created` event must
carry this lineage. Curator evidence selection is an allowlist over
lineage plus source role, not an event-name blacklist. Review and
curator-derived events can support audit timelines but cannot create
new semantic curator candidates.

Missing lineage never defaults to `OriginalExperience`. Legacy events
are ineligible unless they match a narrow, versioned allowlist of
pre-curator emitter/version/event-type combinations whose provenance is
already deterministic. Every new emitter must stamp lineage, and an
unknown future emitter fails closed.

Curator proposals never enter ambient retrieval. A future applied
curator memory remains explicitly lineage-tagged. Any later
auto-eligible addition begins with a low retrieval weight, visible
provenance, rollback, a kill switch, and spot audits.

## 18. Provider contract

V1 should use an optional loopback provider rather than bundle a model
runtime into the app.

Required provider behavior:

- adapter accepts only literal loopback IPs or a Unix socket and rejects
  redirects, proxies, DNS names, non-loopback resolution, and cloud
  fallback;
- exact model digest pinned and displayed;
- strict structured-output schema;
- temperature zero by default;
- no tools exposed by NeuroVault;
- bounded context, response, batch, and timeout;
- response byte cap enforced while streaming, before JSON
  deserialization;
- cancellation on shutdown;
- fail-closed candidate handling;
- no persistence of prompts by NeuroVault;
- visible "local curator unavailable" state without breaking the app.

NeuroVault can enforce its own adapter behavior. It cannot prove that
an independently installed Ollama-compatible runtime has no other
network access, telemetry, or prompt logging. The settings UI must
disclose those behaviors as provider-dependent and show the configured
endpoint, provider, and exact model digest. "Local-only" means
NeuroVault sends curator requests only to its verified loopback
endpoint; it is not a blanket attestation about another process.

Structured output constrains syntax only. Rust must validate the
returned JSON again. llama.cpp schema-to-grammar support must be tested
for the exact schema because unsupported features can be omitted by
the converter.

### 18.1 Same-host evidence constraint

V1 transcript curation works only when the event host, NeuroVault
server, and approved transcript root share the same filesystem. A
remote/headless HTTP client cannot submit a path for the server to read.
Remote evidence requires a separate authenticated, bounded,
content-addressed upload/snapshot protocol with its own consent and
threat review. That protocol is out of V1 scope.

## 19. Red-team corpus

Build the adversarial corpus before enabling the curator in a user
build. Every example has an allowed evidence envelope and a gold result:
no proposal, exact proposal fields, review-only, defer, or reject.

Required attack families:

1. Entity and role swaps.
2. Predicate/property transfer between entities.
3. Quote splicing across sentences or documents.
4. Negation, double negation, exceptions, and conditionals.
5. Possibility or desire upgraded to fact.
6. Planned or attempted work upgraded to completed work.
7. Historical fact upgraded to current fact.
8. Date, timezone, number, sign, version, and unit mutation.
9. Quoted speech, forwarded email, pasted logs, and multi-speaker text.
10. Assistant/tool/file/web text misattributed to the user.
11. Wrong brain, room, project, session, turn, or object.
12. Valid event ID with an unrelated span.
13. Invalid UTF-8 boundaries and whitespace/Unicode ambiguity.
14. Mutable transcript prefix and missing source.
15. Prompt injection in every source role.
16. API keys, passwords, tokens, private paths, PII, and high-entropy
    custom secrets.
17. Code symbol, stack trace, and diff confusion.
18. Duplicate, contradiction, supersession, merge, and deletion.
19. Curator/review output recycled as evidence.
20. Oversized input, malformed JSON, model timeout, model crash, and
    corrupted model identity.

### 19.1 Required metrics

Measure by memory class and provenance role:

- candidate precision;
- `generator_candidate_recall`: gold memory instances proposed by the
  generator before verification, divided by all gold memory instances;
- `verifier_false_reject_rate`: correctly formed labeled candidates
  whose gold disposition is `ProposalReady` or `ReviewRequired` but
  whose verifier outcome is terminal `Rejected`, divided by all such
  admissible labeled candidates. Attribute every error to `GateName`
  and `RejectCode` using the section 14.1 audit receipt;
- `verifier_over_escalation_rate`: labeled candidates whose gold
  disposition is `ProposalReady` but whose verifier disposition is
  `ReviewRequired`, divided by all gold `ProposalReady` candidates;
- `defer_recovery_rate`: deferred candidates that reach a non-deferred
  terminal outcome within the frozen retry/TTL policy, divided by all
  deferred candidates old enough to evaluate;
- `defer_expiry_rate`: deferred candidates that reach
  `ExpiredVisible` without recovery, divided by all deferred candidates
  old enough to evaluate. Still-pending candidates are reported
  separately and excluded from both denominators until mature;
- `end_to_end_candidate_recall`: gold memory instances that ultimately
  reach human review, divided by all gold memory instances;
- unsupported-claim rate;
- valid-span and evidence-resolution rate;
- actor/subject/object attribution accuracy;
- polarity, modality, temporal, quantity, and action accuracy;
- conflict and supersession accuracy;
- secret exposure count, with a target of zero;
- false-negative rate from a predetermined audit sample;
- untouched approval, edit, and rejection rates;
- review time and queue burden;
- p50/p95 runtime, peak RAM, and deferred backlog;
- replay stability and deduplication correctness.

Approval rate alone is insufficient because a system can appear
precise by proposing almost nothing. Precision and no-leak metrics are
also insufficient because a verifier can appear safe by rejecting
almost everything. `verifier_false_reject_rate` and
`defer_expiry_rate` are the counterweight, and terminal loss matters
most because it has no human backstop in V1.

## 20. V1 acceptance bar

The feature may enter a developer-only build when all of these are
true:

- hardened transcript/evidence reader tests pass;
- enabled outcome capture stores a typed, capture-time prefix digest;
- the versioned host parser emits per-record roles, coordinate ranges,
  and sanitized segments with reproducible hashes;
- the model envelope contains no journal, brain, session, path, or real
  object identifiers;
- model disabled/unavailable leaves current behavior unchanged;
- raw provider responses are capped before deserialization;
- every proposed field has at least one server-resolved span;
- every extractive candidate has one complete-proposition `Primary`
  span, and every multi-source class matches its closed support-group
  contract;
- invalid, cross-scope, changed, private, or secret evidence fails
  closed;
- different field values over identical evidence cannot collide;
- rejected evidence cannot be rephrased into repeated review spam;
- a timed-out complete unit is retried after watermark advance;
- concurrent runs are serialized by a per-brain consolidation lock;
- deterministic proposals remain byte-for-byte stable;
- all curator proposals are quarantined, review-only, and stored with
  application `NotApplicable`;
- no curator path calls an immediate-write fact endpoint;
- curator-derived journal events carry durable lineage and cannot feed
  later curator extraction;
- all twenty red-team families have regression fixtures;
- before the frozen labeled corpus is scored, a committed benchmark
  manifest records the corpus hash, generator/verifier/policy
  fingerprints, retry/TTL policy, included claim classes, and
  pre-registered thresholds for `generator_candidate_recall`,
  `verifier_false_reject_rate`, `verifier_over_escalation_rate`,
  `defer_recovery_rate`, `defer_expiry_rate`, and
  `end_to_end_candidate_recall`;
- every included claim class meets those pre-registered recall and
  verifier thresholds on the frozen corpus. "Fail closed" must not
  degenerate into "fail empty";
- model, prompt, schema, evidence, policy, and NLI fingerprints appear
  in safe local receipts;
- a global curator kill switch is test-locked.

There is no V1 auto-write acceptance bar because V1 has no auto-write.

## 21. Rollout

### Phase A: evidence and replay, no model

Phase A ships as seven independently reviewable slices. The list below is
that order; each bullet is one slice.

1. **(slice 1 of 7 — implemented)** Add consent-gated typed transcript
   references and capture-time prefix hashing. This slice binds evidence
   at capture only: it resolves the approved root once per enabled
   policy, opens exclusively from that resolved root under `openat`
   `O_NOFOLLOW`, and stops at bytes and hashes. It does **not** parse,
   redact, materialize spans, or create proposals — those are later
   slices and remain unimplemented and unauthorized.
2. Build the versioned same-host transcript parser and redaction map.
3. Materialize exact evidence spans from test fixtures.
4. Add verified-span and receipt types.
5. Fix proposal identity and evidence tombstones.
6. Add curator-unit retry state.
7. Add durable derivation lineage and the per-brain consolidation lock.

### Phase B: verifier, synthetic candidates only

- Implement every deterministic gate.
- Feed hand-authored malicious candidates into the verifier.
- Build the red-team and calibration corpus.
- Keep the feature unavailable in consumer settings.

### Phase C: optional local proposal generation

- Add one loopback provider behind a feature flag.
- Run manual/developer-only consolidation.
- Show evidence and gate outcomes in Memory Review.
- Measure without tuning frozen acceptance criteria mid-window.

### Phase D: user opt-in proposal mode

- Explain model size, RAM, privacy boundary, and failure behavior.
- Keep all outputs quarantined pending review.
- Start a new observation window for every curator memory class.

### Phase E: restricted automation, possibly never

- Consider only additive, narrow, reversible classes.
- Require pre-frozen class-specific Stage 3 criteria.
- Keep contradiction, merge, supersession, delete, and hide operations
  manually confirmed.

## 22. Research basis and constraints

- [Ollama structured outputs](https://docs.ollama.com/capabilities/structured-outputs)
  support JSON Schema and explicitly recommend validating the response
  again. Shape is not truth.
- [Ollama local-only configuration](https://docs.ollama.com/faq) can
  enforce a loopback runtime with cloud features disabled.
- [llama.cpp grammar documentation](https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md)
  warns that unsupported JSON Schema features may be skipped. The exact
  generated grammar must be inspected and tested.
- [Right for the Wrong Reasons](https://aclanthology.org/P19-1334/)
  demonstrates that NLI models can rely on lexical-overlap and
  subsequence heuristics.
- [An Analysis of NLI Benchmarks through the Lens of Negation](https://aclanthology.org/2020.emnlp-main.732/)
  shows why negation needs explicit tests rather than blind classifier
  trust.
- [Simple but Challenging: NLI Models Fail on Compositionality](https://aclanthology.org/2022.findings-emnlp.252/)
  documents entity-predicate binding failures that quote and token
  containment do not prevent.
- [Calibration of Pre-trained Transformers](https://aclanthology.org/2020.emnlp-main.21/)
  supports calibrating the exact model on in-domain data instead of
  treating a generic probability as a universal safety threshold.

## 23. Review decisions still open

These choices should be made only after the evidence reader and attack
corpus exist:

1. Whether V1 supports Ollama only or an OpenAI-compatible loopback
   interface with an explicit local-only attestation.
2. The first model and exact pinned digest.
3. Whether any NLI model improves decisions enough to justify its disk,
   RAM, calibration, and maintenance cost.
4. Whether evidence previews remain re-readable from transcript
   prefixes or require encrypted content-addressed snapshots.
5. Which one or two additive claim classes enter the first observation
   window.
6. Whether summaries and profiles remain permanently review-only.

None of these choices changes the core contract: the model proposes,
Rust validates evidence and policy, the review system decides, and only
an explicit executor can change canonical memory.
