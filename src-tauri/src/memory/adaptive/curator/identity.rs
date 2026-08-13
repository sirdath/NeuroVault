//! Stable keys and tombstones (guide §2.5, slice A5; spec §12).
//!
//! Owns [`IDENTITY_VERSION`], [`evidence_key`], [`claim_key`],
//! [`proposal_id`], and the append-only tombstone store
//! (`brains/<id>/curator_tombstones.jsonl`, reduce-on-read like
//! `todos.jsonl`) that makes a user-rejected memory unresurrectable
//! from the same evidence.
//!
//! Byte-stability is the whole point: sorted/BTree inputs only, never a
//! `HashMap` iteration order, anywhere near a key.
//!
//! # The hash recipe
//!
//! Every key is `sha256` over one **canonical JSON** string, lowercase
//! hex, full 256 bits. Canonical JSON here means:
//!
//! * objects — `{`, `"key":value` pairs joined by `,` with keys sorted
//!   by their UTF-8 bytes, `}`; no insignificant whitespace anywhere;
//! * arrays — `[` elements joined by `,` `]`, and every array inside a
//!   key is sorted by the element's own canonical encoding (bytewise)
//!   and deduplicated, so citation order and a doubly-cited sentence
//!   can never move a key (spec §12.5: "sort maps and evidence
//!   receipts by documented bytewise order");
//! * strings — UTF-8 verbatim, escaping only `"`, `\` and the C0
//!   controls (`\b \t \n \f \r`, otherwise `\u00xx` lowercase);
//! * numbers — unsigned decimal integers only. **No binary float ever
//!   reaches a digest** (spec §12.5).
//!
//! Each recipe opens with a `"domain"` tag. The spec writes the inputs
//! as a concatenation (`action + resolved_object + …`); plain
//! concatenation is ambiguous — `("ab","c")` and `("a","bc")` hash
//! alike — so the fields ride in a canonical object instead, which is a
//! strict tightening of the spec's intent. The domain tag then
//! guarantees the three recipes cannot collide with one another even on
//! identical inputs.
//!
//! ```text
//! evidence_key = sha256({
//!   "action":            <action>,
//!   "claim_slot":        {<canonicalized slot parts, sorted>},
//!   "domain":            "nv.curator.evidence_key",
//!   "identity_version":  2,
//!   "resolved_object":   <object>,
//!   "spans":             [<canonical SpanIdentity objects, sorted+deduped>]
//! })                                                     (spec §12.2)
//!
//! claim_key = sha256({
//!   "action":            <action>,
//!   "authority_scope":   <server-resolved scope>,
//!   "claim_slot":        {…},
//!   "domain":            "nv.curator.claim_key",
//!   "identity_version":  2
//! })                                                     (spec §12.3)
//!
//! proposal_id = sha256({
//!   "action":            <action>,
//!   "brain_id":          <brain>,
//!   "domain":            "nv.curator.proposal_id",
//!   "fields":            [{"name":…,"proposed_value":…,"spans":[…]} sorted],
//!   "identity_version":  2,
//!   "memory_type":       <derived type>,
//!   "policy_epoch":      <epoch>,
//!   "resolved_object":   <object>
//! })                                                     (spec §12.1)
//! ```
//!
//! A [`SpanIdentity`] encodes as `{"end_byte":…,`
//! `"evidence_content_sha256":…,"identity_version":…,`
//! `"parser_version":…,"record_index":…,"redaction_policy_version":…,`
//! `"segmenter_version":…,"sentence_index":…,"span_sha256":…,`
//! `"start_byte":…}` — see [`canonical_span`].
//!
//! **What is deliberately absent**: model, prompt, schema and verifier
//! fingerprints (spec §12.3 — a model upgrade must not duplicate an
//! identical proposal), the request-local `S{n}` sentence label, the
//! journal event id, and the observed transcript prefix (see the
//! `receipts` module docs — identity is content-addressed so a longer
//! prefix read tomorrow cannot resurrect a memory rejected tonight).
//!
//! Changing any of this is an [`IDENTITY_VERSION`] bump plus migration
//! and replay fixtures (spec §12.5). The byte-stability tests assert
//! literal digests derived from an independent oracle, so an accidental
//! change fails loudly instead of silently re-keying the store.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use super::receipts::SpanIdentity;
use crate::memory::paths::brain_dir;
use crate::memory::types::MemoryError;

type Result<T> = std::result::Result<T, MemoryError>;

/// The sentence-ID identity contract. `1` denoted the retired
/// model-pointer identity; the two must never collide (spec §12.5).
pub const IDENTITY_VERSION: u32 = 2;

/// Domain tag for [`evidence_key`].
pub const EVIDENCE_KEY_DOMAIN: &str = "nv.curator.evidence_key";
/// Domain tag for [`claim_key`].
pub const CLAIM_KEY_DOMAIN: &str = "nv.curator.claim_key";
/// Domain tag for [`proposal_id`].
pub const PROPOSAL_ID_DOMAIN: &str = "nv.curator.proposal_id";

/// Prefix of the UI-safe short form (spec §12.1). The `2` is the
/// identity version, so a v1 id can never be mistaken for a v2 one on
/// screen.
pub const DISPLAY_ID_PREFIX: &str = "cp2_";

/// Hex characters kept in the display form — 128 bits, the spec's
/// floor.
pub const DISPLAY_ID_HEX_LEN: usize = 32;

/// Tombstone log, one JSON object per line.
pub const TOMBSTONE_FILE: &str = "curator_tombstones.jsonl";

// ---------------------------------------------------------------------
// canonical encoding
// ---------------------------------------------------------------------

/// The only value shapes a digest input may take. There is no float and
/// no null variant, by construction.
enum Canon {
    Str(String),
    Num(u64),
    /// Elements already encoded; the caller sorts them and documents
    /// the order.
    Arr(Vec<String>),
    /// A pre-encoded fragment spliced in verbatim.
    Raw(String),
    Obj(BTreeMap<&'static str, Canon>),
}

impl Canon {
    fn encode(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }

    fn write(&self, out: &mut String) {
        match self {
            Canon::Str(s) => write_json_string(out, s),
            Canon::Num(n) => out.push_str(&n.to_string()),
            Canon::Raw(s) => out.push_str(s),
            Canon::Arr(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(item);
                }
                out.push(']');
            }
            Canon::Obj(map) => {
                out.push('{');
                // BTreeMap<&str, _> already iterates in bytewise key
                // order — the documented sort.
                for (i, (k, v)) in map.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write_json_string(out, k);
                    out.push(':');
                    v.write(out);
                }
                out.push('}');
            }
        }
    }
}

fn write_json_string(out: &mut String, s: &str) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{09}' => out.push_str("\\t"),
            '\u{0a}' => out.push_str("\\n"),
            '\u{0c}' => out.push_str("\\f"),
            '\u{0d}' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn sha256_hex(canonical: &str) -> String {
    let mut h = Sha256::new();
    h.update(canonical.as_bytes());
    format!("{:x}", h.finalize())
}

/// Bytewise sort + dedup of pre-encoded array elements.
fn sorted_unique(mut encoded: Vec<String>) -> Vec<String> {
    encoded.sort_unstable();
    encoded.dedup();
    encoded
}

/// The canonical JSON encoding of one [`SpanIdentity`] — the atom every
/// evidence digest is built from.
///
/// Keys in bytewise order: `end_byte`, `evidence_content_sha256`,
/// `identity_version`, `parser_version`, `record_index`,
/// `redaction_policy_version`, `segmenter_version`, `sentence_index`,
/// `span_sha256`, `start_byte`.
pub fn canonical_span(id: &SpanIdentity) -> String {
    let mut m: BTreeMap<&'static str, Canon> = BTreeMap::new();
    m.insert("end_byte", Canon::Num(u64::from(id.end_byte)));
    m.insert(
        "evidence_content_sha256",
        Canon::Str(id.evidence_content_sha256.clone()),
    );
    m.insert(
        "identity_version",
        Canon::Num(u64::from(id.identity_version)),
    );
    m.insert("parser_version", Canon::Num(u64::from(id.parser_version)));
    m.insert("record_index", Canon::Num(u64::from(id.record_index)));
    m.insert(
        "redaction_policy_version",
        Canon::Num(u64::from(id.redaction_policy_version)),
    );
    m.insert(
        "segmenter_version",
        Canon::Num(u64::from(id.segmenter_version)),
    );
    m.insert("sentence_index", Canon::Num(u64::from(id.sentence_index)));
    m.insert("span_sha256", Canon::Str(id.span_sha256.clone()));
    m.insert("start_byte", Canon::Num(u64::from(id.start_byte)));
    Canon::Obj(m).encode()
}

fn canonical_spans(ids: &[SpanIdentity]) -> Canon {
    Canon::Arr(sorted_unique(ids.iter().map(canonical_span).collect()))
}

/// Identity canonicalization of a human-authored value (spec §12.5):
/// trim, then collapse every internal Unicode whitespace run to one
/// space. **Nothing else.**
///
/// In particular there is no case folding — code symbols, versions,
/// paths and identifiers are case-sensitive, so `fooBar()` must never
/// hash like `foo_bar()`.
///
/// Unicode NFC is applied last (spec §12.5), so a decomposed `zoë` and a
/// composed one mint the same key. NFC has been part of
/// [`IDENTITY_VERSION`] 2 since before any digest was ever persisted;
/// changing the pinned `unicode-normalization` crate (and with it the
/// Unicode data tables) is by definition an [`IDENTITY_VERSION`] bump.
pub fn canonicalize_value(raw: &str) -> String {
    use unicode_normalization::UnicodeNormalization;

    let mut out = String::with_capacity(raw.len());
    let mut gap = false;
    for ch in raw.trim().chars() {
        if ch.is_whitespace() {
            gap = true;
            continue;
        }
        if gap && !out.is_empty() {
            out.push(' ');
        }
        gap = false;
        out.push(ch);
    }
    out.nfc().collect()
}

// ---------------------------------------------------------------------
// claim slot
// ---------------------------------------------------------------------

/// The canonical claim slot (spec §12.4): the small, named tuple of
/// already-verified components that says *which claim this is*, apart
/// from how it happens to be worded.
///
/// The **verifier** fills this in after field and object verification —
/// never the generator. Per-action recipes (spec §12.4):
///
/// | action | parts |
/// |---|---|
/// | `RecordFact` | `subject`, `attribute` |
/// | `RememberPreference` | `owner`, `topic` |
/// | `RememberDecision` | `actor`, `scope`, `topic` |
/// | `RememberCommitment` | `actor`, `scope`, `topic` |
/// | `RememberCorrection` | `target`, `attribute` |
///
/// The slot is what keeps a rejection narrow: rejecting one fact in a
/// sentence must not poison every other atomic fact that same sentence
/// supports.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ClaimSlot {
    parts: BTreeMap<String, String>,
}

impl ClaimSlot {
    pub fn new() -> Self {
        Self::default()
    }

    /// Builder form. Both name and value are canonicalized.
    pub fn with(mut self, name: &str, value: &str) -> Self {
        self.insert(name, value);
        self
    }

    pub fn insert(&mut self, name: &str, value: &str) {
        self.parts
            .insert(canonicalize_value(name), canonicalize_value(value));
    }

    pub fn get(&self, name: &str) -> Option<&str> {
        self.parts.get(name).map(String::as_str)
    }

    pub fn is_empty(&self) -> bool {
        self.parts.is_empty()
    }

    pub fn len(&self) -> usize {
        self.parts.len()
    }

    pub fn parts(&self) -> &BTreeMap<String, String> {
        &self.parts
    }

    /// The canonical JSON object this slot contributes to a digest.
    pub fn canonical_json(&self) -> String {
        let mut out = String::from("{");
        for (i, (k, v)) in self.parts.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            write_json_string(&mut out, k);
            out.push(':');
            write_json_string(&mut out, v);
        }
        out.push('}');
        out
    }

    fn as_canon(&self) -> Canon {
        Canon::Raw(self.canonical_json())
    }
}

// ---------------------------------------------------------------------
// the three keys
// ---------------------------------------------------------------------

/// `sha256(action + resolved_object + canonical claim_slot + sorted
/// SpanIdentity values)` — spec §12.2, encoded per the module recipe.
///
/// A rejected `evidence_key` is a tombstone: the curator cannot come
/// back with different wording over identical evidence. New evidence
/// makes a new key, which links back to the rejected predecessor.
pub fn evidence_key(
    action: &str,
    resolved_object: &str,
    claim_slot: &ClaimSlot,
    spans: &[SpanIdentity],
) -> String {
    let mut m: BTreeMap<&'static str, Canon> = BTreeMap::new();
    m.insert("action", Canon::Str(action.to_string()));
    m.insert("claim_slot", claim_slot.as_canon());
    m.insert("domain", Canon::Str(EVIDENCE_KEY_DOMAIN.to_string()));
    m.insert("identity_version", Canon::Num(u64::from(IDENTITY_VERSION)));
    m.insert("resolved_object", Canon::Str(resolved_object.to_string()));
    m.insert("spans", canonical_spans(spans));
    sha256_hex(&Canon::Obj(m).encode())
}

/// `sha256(action + resolved authority scope + canonical claim_slot)` —
/// spec §12.3. Links later evidence to the same conceptual claim for
/// conflict display, without collapsing distinct proposal contents.
pub fn claim_key(action: &str, authority_scope: &str, claim_slot: &ClaimSlot) -> String {
    let mut m: BTreeMap<&'static str, Canon> = BTreeMap::new();
    m.insert("action", Canon::Str(action.to_string()));
    m.insert("authority_scope", Canon::Str(authority_scope.to_string()));
    m.insert("claim_slot", claim_slot.as_canon());
    m.insert("domain", Canon::Str(CLAIM_KEY_DOMAIN.to_string()));
    m.insert("identity_version", Canon::Num(u64::from(IDENTITY_VERSION)));
    sha256_hex(&Canon::Obj(m).encode())
}

/// One verified field as it enters [`proposal_id`].
#[derive(Debug, Clone, Copy)]
pub struct ProposalIdentityField<'a> {
    pub name: &'a str,
    /// Raw proposed value; [`canonicalize_value`] is applied here, so
    /// callers pass the display text.
    pub proposed_value: &'a str,
    pub spans: &'a [SpanIdentity],
}

/// Everything semantic identity depends on (spec §12.1). Note what is
/// *not* here: the model, the prompt, the schema version, the run id.
#[derive(Debug, Clone, Copy)]
pub struct ProposalIdentityInput<'a> {
    pub policy_epoch: &'a str,
    pub brain_id: &'a str,
    pub action: &'a str,
    pub memory_type: &'a str,
    pub resolved_object: &'a str,
    pub fields: &'a [ProposalIdentityField<'a>],
}

/// Semantic identity of a curator proposal — the full 256-bit hex
/// digest (spec §12.1: "keep the full 256-bit hash internally").
///
/// The existing `consolidate::pid` over `(action, object, event_ids)`
/// is not enough for model output: two different field values over the
/// same evidence would collide.
///
/// Store this in `StoredProposal.proposal_id`, show [`display_id`] on
/// screen, and accept only the full digest on mutation.
pub fn proposal_id(input: &ProposalIdentityInput<'_>) -> String {
    let fields = sorted_unique(
        input
            .fields
            .iter()
            .map(|f| {
                let mut fm: BTreeMap<&'static str, Canon> = BTreeMap::new();
                fm.insert("name", Canon::Str(canonicalize_value(f.name)));
                fm.insert(
                    "proposed_value",
                    Canon::Str(canonicalize_value(f.proposed_value)),
                );
                fm.insert("spans", canonical_spans(f.spans));
                Canon::Obj(fm).encode()
            })
            .collect(),
    );

    let mut m: BTreeMap<&'static str, Canon> = BTreeMap::new();
    m.insert("action", Canon::Str(input.action.to_string()));
    m.insert("brain_id", Canon::Str(input.brain_id.to_string()));
    m.insert("domain", Canon::Str(PROPOSAL_ID_DOMAIN.to_string()));
    m.insert("fields", Canon::Arr(fields));
    m.insert("identity_version", Canon::Num(u64::from(IDENTITY_VERSION)));
    m.insert("memory_type", Canon::Str(input.memory_type.to_string()));
    m.insert("policy_epoch", Canon::Str(input.policy_epoch.to_string()));
    m.insert(
        "resolved_object",
        Canon::Str(input.resolved_object.to_string()),
    );
    sha256_hex(&Canon::Obj(m).encode())
}

/// UI-safe short form: `cp2_` + the first 128 bits (spec §12.1). A
/// display prefix is never sufficient to review, reject or apply a
/// proposal — mutation APIs take the full digest, see
/// [`is_full_identity_digest`].
pub fn display_id(full: &str) -> String {
    let hex: String = full.chars().take(DISPLAY_ID_HEX_LEN).collect();
    format!("{DISPLAY_ID_PREFIX}{hex}")
}

/// A full 256-bit lowercase-hex digest — the only form a mutation API
/// may accept.
pub fn is_full_identity_digest(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

// ---------------------------------------------------------------------
// tombstones
// ---------------------------------------------------------------------

/// Why an `evidence_key` may never produce a proposal again.
///
/// Exactly three writers exist in V1 (spec §12.2). An ordinary verifier
/// rejection is **not** one of them: bad model output over valid
/// evidence may be corrected on a later run, and tombstoning it would
/// silently delete a legitimate future memory.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TombstoneReason {
    /// (a) The user rejected a curator proposal in Memory Review.
    RejectedByUser,
    /// (b) A bound source stayed missing or prefix-mismatched after the
    /// evidence-recovery policy gave up.
    EvidenceVanished,
    /// (c) An applied memory was deleted; deleted information must not
    /// leak back in.
    MemoryDeleted,
}

/// One append-only tombstone line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tombstone {
    pub evidence_key: String,
    pub reason: TombstoneReason,
    pub created_at: String,
    /// The conceptual claim, when known — lets the UI say *what* was
    /// rejected without re-deriving it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claim_key: Option<String>,
    /// The proposal that occasioned the tombstone, when there was one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposal_id: Option<String>,
}

/// Reduce-on-read view of `curator_tombstones.jsonl`.
///
/// **First write wins.** A tombstone is terminal and has no removal
/// path in V1, so the original reason and timestamp are the audit
/// record; later lines for the same key reduce to no-ops (the raw log
/// still holds every one of them).
#[derive(Debug, Clone, Default)]
pub struct TombstoneStore {
    by_evidence: BTreeMap<String, Tombstone>,
}

impl TombstoneStore {
    /// The check the runner makes **before** generation (skip the unit
    /// slice) and G11 makes again (`NoOp(RejectedEvidenceTombstone)`).
    pub fn is_tombstoned(&self, evidence_key: &str) -> bool {
        self.by_evidence.contains_key(evidence_key)
    }

    pub fn get(&self, evidence_key: &str) -> Option<&Tombstone> {
        self.by_evidence.get(evidence_key)
    }

    /// Every tombstone recorded against one conceptual claim, in
    /// `evidence_key` order.
    pub fn by_claim_key(&self, claim_key: &str) -> Vec<&Tombstone> {
        self.by_evidence
            .values()
            .filter(|t| t.claim_key.as_deref() == Some(claim_key))
            .collect()
    }

    /// The guide's `HashMap<String, Tombstone>` view, ordered.
    pub fn by_evidence_key(&self) -> &BTreeMap<String, Tombstone> {
        &self.by_evidence
    }

    /// Tombstoned evidence keys — the spec's
    /// `CuratorStateView::rejected_evidence_keys`.
    pub fn evidence_keys(&self) -> impl Iterator<Item = &String> {
        self.by_evidence.keys()
    }

    pub fn len(&self) -> usize {
        self.by_evidence.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_evidence.is_empty()
    }
}

fn tombstone_path(brain_id: &str) -> PathBuf {
    brain_dir(brain_id).join(TOMBSTONE_FILE)
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_default()
}

/// Read + reduce the tombstone log. A missing file is an empty store; a
/// corrupt line is skipped, exactly like `todos.jsonl` — a partial
/// tombstone set must never take down a nightly run.
pub fn tombstones(brain_id: &str) -> TombstoneStore {
    let mut store = TombstoneStore::default();
    let Ok(raw) = fs::read_to_string(tombstone_path(brain_id)) else {
        return store;
    };
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(t) = serde_json::from_str::<Tombstone>(trimmed) {
            // First write wins.
            store.by_evidence.entry(t.evidence_key.clone()).or_insert(t);
        }
    }
    store
}

/// Append one line (single write, same discipline as the journal and
/// the proposal store).
pub fn append_tombstone(brain_id: &str, t: &Tombstone) -> Result<()> {
    let path = tombstone_path(brain_id);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)
            .map_err(|e| MemoryError::Other(format!("curator tombstone dir: {e}")))?;
    }
    let mut buf = serde_json::to_string(t)
        .map_err(|e| MemoryError::Other(format!("curator tombstone serialize: {e}")))?
        .into_bytes();
    buf.push(b'\n');
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| MemoryError::Other(format!("curator tombstone open: {e}")))?;
    f.write_all(&buf)
        .map_err(|e| MemoryError::Other(format!("curator tombstone write: {e}")))?;
    Ok(())
}

fn record(
    brain_id: &str,
    reason: TombstoneReason,
    evidence_key: &str,
    claim_key: Option<&str>,
    proposal_id: Option<&str>,
) -> Result<Tombstone> {
    let t = Tombstone {
        evidence_key: evidence_key.to_string(),
        reason,
        created_at: now_iso(),
        claim_key: claim_key.map(str::to_string),
        proposal_id: proposal_id.map(str::to_string),
    };
    append_tombstone(brain_id, &t)?;
    Ok(t)
}

/// Writer (a): the user rejected a curator proposal in Memory Review.
/// This evidence can never re-spawn this claim — not reworded, and not
/// after a model or prompt upgrade.
pub fn record_user_rejection(
    brain_id: &str,
    evidence_key: &str,
    claim_key: Option<&str>,
    proposal_id: Option<&str>,
) -> Result<Tombstone> {
    record(
        brain_id,
        TombstoneReason::RejectedByUser,
        evidence_key,
        claim_key,
        proposal_id,
    )
}

/// Writer (b): `reopen_verified` kept returning `PrefixMismatch` (or the
/// source stayed unavailable) until the retries were exhausted.
pub fn record_evidence_vanished(
    brain_id: &str,
    evidence_key: &str,
    claim_key: Option<&str>,
    proposal_id: Option<&str>,
) -> Result<Tombstone> {
    record(
        brain_id,
        TombstoneReason::EvidenceVanished,
        evidence_key,
        claim_key,
        proposal_id,
    )
}

/// Writer (c): an applied memory was deleted. A caller holding several
/// evidence keys for one memory calls this once per key.
pub fn record_memory_deleted(
    brain_id: &str,
    evidence_key: &str,
    claim_key: Option<&str>,
    proposal_id: Option<&str>,
) -> Result<Tombstone> {
    record(
        brain_id,
        TombstoneReason::MemoryDeleted,
        evidence_key,
        claim_key,
        proposal_id,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::adaptive::curator::receipts::{
        GateOutcome, GateRecord, SourceRole, VerifiedSpan,
    };

    // ---- shared fixture, mirrored byte-for-byte by the oracle ----

    const EV_SHA: &str = "5e1d0b8f4a2c6e9d0f3b7a15c8d24e6f0a9b3c5d7e1f2a4b6c8d0e2f4a6b8c0d";
    const SPAN_SHA: &str = "9b41c7e2f0a5d38b6c1e94f7a20d5b8e3c6f9a1d4b7e0c2f5a8d1b4e7c0f3a6d";
    const SPAN_SHA_2: &str = "1c04f8b3e6a9d25c7f0b3e6a9d2c5f8b1e4a7d0c3f6b9e2a5d8c1f4b7e0a3d6c";

    const ACTION: &str = "curator_remember_decision";
    const OBJECT: &str = "curator/atlas#deploy-window";
    const SCOPE: &str = "brain:NeuroVaultBrain1/project:atlas";
    const EPOCH: &str = "2026-08-vp1";

    fn span_a() -> SpanIdentity {
        SpanIdentity {
            identity_version: IDENTITY_VERSION,
            evidence_content_sha256: EV_SHA.into(),
            parser_version: 1,
            redaction_policy_version: 1,
            segmenter_version: 1,
            record_index: 0,
            sentence_index: 0,
            start_byte: 0,
            end_byte: 45,
            span_sha256: SPAN_SHA.into(),
        }
    }

    fn span_b() -> SpanIdentity {
        SpanIdentity {
            sentence_index: 3,
            start_byte: 120,
            end_byte: 168,
            span_sha256: SPAN_SHA_2.into(),
            ..span_a()
        }
    }

    fn slot() -> ClaimSlot {
        ClaimSlot::new()
            .with("actor", "user")
            .with("scope", "atlas")
            .with("topic", "deploys only on Tuesdays")
    }

    // ---- byte stability (literal digests from an independent oracle)

    #[test]
    fn canonical_span_encoding_is_frozen() {
        assert_eq!(
            canonical_span(&span_a()),
            concat!(
                "{\"end_byte\":45,",
                "\"evidence_content_sha256\":\"5e1d0b8f4a2c6e9d0f3b7a15c8d24e6f0a9b3c5d7e1f2a4b6c8d0e2f4a6b8c0d\",",
                "\"identity_version\":2,",
                "\"parser_version\":1,",
                "\"record_index\":0,",
                "\"redaction_policy_version\":1,",
                "\"segmenter_version\":1,",
                "\"sentence_index\":0,",
                "\"span_sha256\":\"9b41c7e2f0a5d38b6c1e94f7a20d5b8e3c6f9a1d4b7e0c2f5a8d1b4e7c0f3a6d\",",
                "\"start_byte\":0}"
            )
        );
    }

    #[test]
    fn claim_slot_encoding_is_frozen() {
        assert_eq!(
            slot().canonical_json(),
            "{\"actor\":\"user\",\"scope\":\"atlas\",\"topic\":\"deploys only on Tuesdays\"}"
        );
        assert_eq!(slot().len(), 3);
        assert_eq!(slot().get("scope"), Some("atlas"));
        assert!(!slot().is_empty());
        assert!(ClaimSlot::new().is_empty());
        assert_eq!(ClaimSlot::new().canonical_json(), "{}");
    }

    #[test]
    fn evidence_key_is_byte_stable() {
        // sha256 over the documented canonical string, computed outside
        // this implementation. Any change to the recipe fails here.
        assert_eq!(
            evidence_key(ACTION, OBJECT, &slot(), &[span_a(), span_b()]),
            "dbf69342ad7f5183da78b0f3e0ef43bad162589443c65a93a3906e8a8b6854ef"
        );
    }

    #[test]
    fn claim_key_is_byte_stable() {
        assert_eq!(
            claim_key(ACTION, SCOPE, &slot()),
            "f54325315865bcf98cce3b97019094d3dc8d5dc6d885b089fc7dc304c68ec2b2"
        );
    }

    #[test]
    fn proposal_id_is_byte_stable() {
        let a = [span_a()];
        let ab = [span_a(), span_b()];
        let fields = [
            ProposalIdentityField {
                name: "statement",
                proposed_value: "Atlas deploys only on Tuesdays.",
                spans: &a,
            },
            ProposalIdentityField {
                name: "subject",
                proposed_value: "deployment",
                spans: &ab,
            },
        ];
        assert_eq!(
            proposal_id(&ProposalIdentityInput {
                policy_epoch: EPOCH,
                brain_id: "NeuroVaultBrain1",
                action: ACTION,
                memory_type: "decision",
                resolved_object: OBJECT,
                fields: &fields,
            }),
            "32281a16c895ac90430c113468f3b28e6594e850c56743e1f2a48aad3bc847e5"
        );
    }

    #[test]
    fn string_escaping_is_byte_stable() {
        let s = ClaimSlot::new().with("topic", "he said \"a\\b\" zoë 🧠");
        assert_eq!(
            s.canonical_json(),
            "{\"topic\":\"he said \\\"a\\\\b\\\" zoë 🧠\"}"
        );
        assert_eq!(
            claim_key(ACTION, SCOPE, &s),
            "d5227fa181f14ca856d42abe6a26de4b588b44a5b8fbff2d4f54d1416cb58b1a"
        );
    }

    #[test]
    fn control_characters_escape_to_short_forms_then_hex() {
        let mut out = String::new();
        write_json_string(&mut out, "a\u{08}b\tc\nd\u{0c}e\rf\u{01}g");
        assert_eq!(out, "\"a\\bb\\tc\\nd\\fe\\rf\\u0001g\"");
    }

    #[test]
    fn every_digest_is_full_width_lowercase_hex() {
        for k in [
            evidence_key(ACTION, OBJECT, &slot(), &[span_a()]),
            claim_key(ACTION, SCOPE, &slot()),
        ] {
            assert!(is_full_identity_digest(&k), "{k} must be 64 hex chars");
        }
        assert!(!is_full_identity_digest("3f8c2a94d1e07b56"));
        assert!(!is_full_identity_digest(&"A".repeat(64)));
    }

    #[test]
    fn display_id_is_128_bits_behind_a_version_prefix() {
        let full = claim_key(ACTION, SCOPE, &slot());
        let short = display_id(&full);
        assert_eq!(short, "cp2_f54325315865bcf98cce3b97019094d3");
        assert_eq!(short.len(), DISPLAY_ID_PREFIX.len() + DISPLAY_ID_HEX_LEN);
        assert!(short.starts_with(DISPLAY_ID_PREFIX));
        assert!(full.starts_with(&short[DISPLAY_ID_PREFIX.len()..]));
    }

    // ---- order/duplicate invariance and sensitivity --------------

    #[test]
    fn citation_order_and_duplicates_cannot_move_a_key() {
        let one = evidence_key(ACTION, OBJECT, &slot(), &[span_a(), span_b()]);
        let reversed = evidence_key(ACTION, OBJECT, &slot(), &[span_b(), span_a()]);
        let duplicated = evidence_key(
            ACTION,
            OBJECT,
            &slot(),
            &[span_b(), span_a(), span_a(), span_b()],
        );
        assert_eq!(one, reversed);
        assert_eq!(one, duplicated);
    }

    #[test]
    fn slot_insertion_order_cannot_move_a_key() {
        let forwards = ClaimSlot::new()
            .with("actor", "user")
            .with("scope", "atlas")
            .with("topic", "deploys only on Tuesdays");
        let backwards = ClaimSlot::new()
            .with("topic", "deploys only on Tuesdays")
            .with("scope", "atlas")
            .with("actor", "user");
        assert_eq!(
            claim_key(ACTION, SCOPE, &forwards),
            claim_key(ACTION, SCOPE, &backwards)
        );
    }

    #[test]
    fn a_different_sentence_is_different_evidence() {
        let base = evidence_key(ACTION, OBJECT, &slot(), &[span_a()]);
        assert_ne!(base, evidence_key(ACTION, OBJECT, &slot(), &[span_b()]));
        assert_ne!(
            base,
            evidence_key(ACTION, OBJECT, &slot(), &[span_a(), span_b()])
        );
        assert_ne!(
            base,
            evidence_key("curator_record_fact", OBJECT, &slot(), &[span_a()])
        );
        assert_ne!(
            base,
            evidence_key(ACTION, "curator/other", &slot(), &[span_a()])
        );
        assert_ne!(
            base,
            evidence_key(
                ACTION,
                OBJECT,
                &slot().with("topic", "deploys on Fridays"),
                &[span_a()]
            )
        );
    }

    #[test]
    fn the_three_recipes_never_collide_on_identical_inputs() {
        // Same action, same scope-shaped object, same slot — only the
        // domain tag differs.
        assert_ne!(
            evidence_key(ACTION, SCOPE, &slot(), &[]),
            claim_key(ACTION, SCOPE, &slot())
        );
    }

    #[test]
    fn canonicalization_applies_nfc_so_decomposed_text_mints_the_same_key() {
        // "zoë" typed composed (U+00EB) vs decomposed (e + U+0308).
        assert_eq!(
            canonicalize_value("zo\u{00eb}"),
            canonicalize_value("zoe\u{0308}")
        );
        assert_eq!(
            claim_key(ACTION, SCOPE, &ClaimSlot::new().with("who", "zo\u{00eb}")),
            claim_key(ACTION, SCOPE, &ClaimSlot::new().with("who", "zoe\u{0308}"))
        );
        // NFC never rewrites already-composed ASCII/steady text.
        assert_eq!(canonicalize_value("plain ascii"), "plain ascii");
    }

    #[test]
    fn canonicalization_collapses_whitespace_and_keeps_case() {
        assert_eq!(canonicalize_value("  a\t\n b  "), "a b");
        assert_eq!(canonicalize_value("fooBar()"), "fooBar()");
        // Identifiers are case-sensitive (policy §12.5).
        assert_ne!(
            claim_key(ACTION, SCOPE, &ClaimSlot::new().with("topic", "fooBar()")),
            claim_key(ACTION, SCOPE, &ClaimSlot::new().with("topic", "foobar()"))
        );
        // …but pure re-wrapping of the same words is the same claim.
        assert_eq!(
            claim_key(ACTION, SCOPE, &ClaimSlot::new().with("topic", "a b")),
            claim_key(ACTION, SCOPE, &ClaimSlot::new().with("topic", " a \n b "))
        );
    }

    #[test]
    fn field_order_cannot_move_a_proposal_id() {
        let a = [span_a()];
        let f1 = ProposalIdentityField {
            name: "statement",
            proposed_value: "Atlas deploys only on Tuesdays.",
            spans: &a,
        };
        let f2 = ProposalIdentityField {
            name: "subject",
            proposed_value: "deployment",
            spans: &a,
        };
        let mk = |fields: &[ProposalIdentityField]| {
            proposal_id(&ProposalIdentityInput {
                policy_epoch: EPOCH,
                brain_id: "NeuroVaultBrain1",
                action: ACTION,
                memory_type: "decision",
                resolved_object: OBJECT,
                fields,
            })
        };
        assert_eq!(mk(&[f1, f2]), mk(&[f2, f1]));
        // A different value is a different proposal — the collision the
        // old event-id `pid` could not see.
        let f2b = ProposalIdentityField {
            proposed_value: "deploys",
            ..f2
        };
        assert_ne!(mk(&[f1, f2]), mk(&[f1, f2b]));
        // …as is a different policy epoch.
        let other_epoch = proposal_id(&ProposalIdentityInput {
            policy_epoch: "2026-09-vp2",
            brain_id: "NeuroVaultBrain1",
            action: ACTION,
            memory_type: "decision",
            resolved_object: OBJECT,
            fields: &[f1, f2],
        });
        assert_ne!(mk(&[f1, f2]), other_epoch);
    }

    #[test]
    fn a_model_upgrade_does_not_duplicate_a_proposal() {
        // §7.2(5): the generation receipt is not an identity input, and
        // neither are a VerifiedSpan's replay coordinates.
        let today = VerifiedSpan {
            evidence_event_id: "ev_stop_9c44".into(),
            transcript_prefix_sha256: "c0ffee11".repeat(8),
            observed_prefix_len: 871,
            record_index: 0,
            segment_content_sha256: EV_SHA.into(),
            parser_version: 1,
            redaction_policy_version: 1,
            segmenter_version: 1,
            sentence_index: 0,
            start_byte: 0,
            end_byte: 45,
            span_sha256: SPAN_SHA.into(),
            role: SourceRole::User,
        };
        let tomorrow = VerifiedSpan {
            evidence_event_id: "ev_stop_ffff".into(),
            transcript_prefix_sha256: "deadbeef".repeat(8),
            observed_prefix_len: 12_004,
            ..today.clone()
        };
        let a = [today.identity()];
        let b = [tomorrow.identity()];
        assert_eq!(
            evidence_key(ACTION, OBJECT, &slot(), &a),
            evidence_key(ACTION, OBJECT, &slot(), &b)
        );
        let mk = |spans: &[SpanIdentity]| {
            proposal_id(&ProposalIdentityInput {
                policy_epoch: EPOCH,
                brain_id: "NeuroVaultBrain1",
                action: ACTION,
                memory_type: "decision",
                resolved_object: OBJECT,
                fields: &[ProposalIdentityField {
                    name: "statement",
                    proposed_value: "Atlas deploys only on Tuesdays.",
                    spans,
                }],
            })
        };
        assert_eq!(mk(&a), mk(&b));
    }

    #[test]
    fn a_segmenter_upgrade_mints_new_identities_rather_than_colliding() {
        let mut upgraded = span_a();
        upgraded.segmenter_version = 2;
        assert_ne!(
            evidence_key(ACTION, OBJECT, &slot(), &[span_a()]),
            evidence_key(ACTION, OBJECT, &slot(), &[upgraded])
        );
    }

    // ---- tombstones ---------------------------------------------

    fn with_temp_home<F: FnOnce()>(f: F) {
        let _guard = crate::memory::journal::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let home = std::env::temp_dir().join(format!(
            "nv-curator-identity-{}-{}",
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
    fn missing_log_is_an_empty_store() {
        with_temp_home(|| {
            let store = tombstones("btomb");
            assert!(store.is_empty());
            assert_eq!(store.len(), 0);
            assert!(!store.is_tombstoned("anything"));
        });
    }

    #[test]
    fn the_three_writers_land_and_look_up() {
        with_temp_home(|| {
            let brain = "btomb";
            let ek_a = evidence_key(ACTION, OBJECT, &slot(), &[span_a()]);
            let ek_b = evidence_key(ACTION, OBJECT, &slot(), &[span_b()]);
            let ek_c = evidence_key(ACTION, "curator/other", &slot(), &[span_a()]);
            let ck = claim_key(ACTION, SCOPE, &slot());

            record_user_rejection(brain, &ek_a, Some(&ck), Some("3f8c")).unwrap();
            record_evidence_vanished(brain, &ek_b, Some(&ck), None).unwrap();
            record_memory_deleted(brain, &ek_c, None, None).unwrap();

            let store = tombstones(brain);
            assert_eq!(store.len(), 3);
            assert_eq!(
                store.get(&ek_a).unwrap().reason,
                TombstoneReason::RejectedByUser
            );
            assert_eq!(
                store.get(&ek_a).unwrap().proposal_id.as_deref(),
                Some("3f8c")
            );
            assert_eq!(
                store.get(&ek_b).unwrap().reason,
                TombstoneReason::EvidenceVanished
            );
            assert_eq!(
                store.get(&ek_c).unwrap().reason,
                TombstoneReason::MemoryDeleted
            );
            assert!(store.is_tombstoned(&ek_a));
            assert!(!store.is_tombstoned("some-other-key"));

            // Claim-key lookup finds the two that recorded one.
            assert_eq!(store.by_claim_key(&ck).len(), 2);
            assert!(store.by_claim_key("no-such-claim").is_empty());
            assert_eq!(store.evidence_keys().count(), 3);
            assert_eq!(store.by_evidence_key().len(), 3);
        });
    }

    #[test]
    fn a_rejected_memory_cannot_come_back_reworded() {
        with_temp_home(|| {
            // The GateMem steal: the user rejects tonight's wording, and
            // tomorrow the model words it differently over the SAME
            // sentence and the SAME claim slot. The proposal id moves,
            // the evidence key does not — so the tombstone still bites.
            let brain = "btomb";
            let spans = [span_a()];
            let ek = evidence_key(ACTION, OBJECT, &slot(), &spans);
            record_user_rejection(brain, &ek, None, None).unwrap();

            let mk = |value: &str| {
                proposal_id(&ProposalIdentityInput {
                    policy_epoch: EPOCH,
                    brain_id: "b",
                    action: ACTION,
                    memory_type: "decision",
                    resolved_object: OBJECT,
                    fields: &[ProposalIdentityField {
                        name: "statement",
                        proposed_value: value,
                        spans: &spans,
                    }],
                })
            };
            assert_ne!(
                mk("Atlas deploys only on Tuesdays."),
                mk("Deployment of Atlas happens on Tuesdays only."),
                "different wording is a different proposal"
            );

            let reworded_ek = evidence_key(ACTION, OBJECT, &slot(), &spans);
            assert_eq!(
                reworded_ek, ek,
                "same evidence + same claim slot ⇒ same key"
            );
            assert!(tombstones(brain).is_tombstoned(&reworded_ek));

            // New evidence is a NEW key and may propose again.
            let fresh = evidence_key(ACTION, OBJECT, &slot(), &[span_b()]);
            assert_ne!(fresh, ek);
            assert!(!tombstones(brain).is_tombstoned(&fresh));
        });
    }

    #[test]
    fn a_verifier_rejection_does_not_tombstone() {
        with_temp_home(|| {
            // Spec §12.2: a gate rejecting bad model output over VALID
            // evidence must leave that evidence proposable on a later
            // run. There is deliberately no writer for it.
            let brain = "btomb";
            let ek = evidence_key(ACTION, OBJECT, &slot(), &[span_a()]);

            let rejection = GateRecord::coded(
                "g06_verify_lexical_integrity",
                GateOutcome::Reject,
                "literal_mismatch",
            );
            assert!(rejection.effect.is_terminal());

            let store = tombstones(brain);
            assert!(store.is_empty(), "a gate rejection writes no tombstone");
            assert!(!store.is_tombstoned(&ek));

            // Exhaustive: exactly three reasons, exactly three writers.
            // A fourth variant fails to compile here rather than
            // quietly acquiring a write path.
            type Writer = fn(&str, &str, Option<&str>, Option<&str>) -> Result<Tombstone>;
            for reason in [
                TombstoneReason::RejectedByUser,
                TombstoneReason::EvidenceVanished,
                TombstoneReason::MemoryDeleted,
            ] {
                let writer: Writer = match reason {
                    TombstoneReason::RejectedByUser => record_user_rejection,
                    TombstoneReason::EvidenceVanished => record_evidence_vanished,
                    TombstoneReason::MemoryDeleted => record_memory_deleted,
                };
                let key = format!("{ek}-{reason:?}");
                assert_eq!(writer(brain, &key, None, None).unwrap().reason, reason);
            }
            assert_eq!(tombstones(brain).len(), 3);
            // …and the untouched evidence key is still proposable.
            assert!(!tombstones(brain).is_tombstoned(&ek));
        });
    }

    #[test]
    fn first_write_wins_and_corrupt_lines_are_skipped() {
        with_temp_home(|| {
            let brain = "btomb";
            let ek = evidence_key(ACTION, OBJECT, &slot(), &[span_a()]);
            let first = record_user_rejection(brain, &ek, None, Some("p1")).unwrap();
            record_memory_deleted(brain, &ek, None, Some("p2")).unwrap();

            // Garbage between good lines must not lose the good ones.
            let path = tombstone_path(brain);
            let mut f = fs::OpenOptions::new().append(true).open(&path).unwrap();
            f.write_all(b"{not json\n\n").unwrap();
            drop(f);
            let ek2 = evidence_key(ACTION, OBJECT, &slot(), &[span_b()]);
            record_evidence_vanished(brain, &ek2, None, None).unwrap();

            let store = tombstones(brain);
            assert_eq!(store.len(), 2);
            let kept = store.get(&ek).unwrap();
            assert_eq!(kept.reason, TombstoneReason::RejectedByUser);
            assert_eq!(kept.proposal_id.as_deref(), Some("p1"));
            assert_eq!(kept.created_at, first.created_at);
            assert!(store.is_tombstoned(&ek2));

            // The raw log keeps every line — the audit is append-only.
            let rawlog = fs::read_to_string(&path).unwrap();
            assert_eq!(rawlog.lines().filter(|l| l.contains("\"p2\"")).count(), 1);
        });
    }

    #[test]
    fn tombstone_wire_shape_is_stable() {
        let t = Tombstone {
            evidence_key: "a".repeat(64),
            reason: TombstoneReason::EvidenceVanished,
            created_at: "2026-08-12T02:10:44Z".into(),
            claim_key: None,
            proposal_id: None,
        };
        let json = serde_json::to_string(&t).unwrap();
        assert_eq!(
            json,
            format!(
                "{{\"evidence_key\":\"{}\",\"reason\":\"evidence_vanished\",\"created_at\":\"2026-08-12T02:10:44Z\"}}",
                "a".repeat(64)
            )
        );
        let back: Tombstone = serde_json::from_str(&json).unwrap();
        assert_eq!(t, back);
        for (reason, tag) in [
            (TombstoneReason::RejectedByUser, "rejected_by_user"),
            (TombstoneReason::EvidenceVanished, "evidence_vanished"),
            (TombstoneReason::MemoryDeleted, "memory_deleted"),
        ] {
            assert_eq!(serde_json::to_value(reason).unwrap(), tag);
        }
    }
}
