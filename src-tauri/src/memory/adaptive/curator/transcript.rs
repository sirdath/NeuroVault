//! Versioned transcript parser + pre-model redaction (guide §2.2, slice A2).
//!
//! Two transforms live here, each with its own version constant:
//!
//! * **PARSER_V1** ([`PARSER_VERSION`]) — splits a hash-pinned transcript
//!   prefix into role-tagged records. The role comes from *host
//!   structure* (record `type` plus `message.role`), never from content
//!   (spec §5 step 8). Unknown record shapes are skipped **visibly**
//!   (spec L306–311), counted, never guessed at.
//! * **REDACT_V1** ([`REDACTION_POLICY_VERSION`]) — replaces credential
//!   shapes with fixed `[REDACTED:<class>]` placeholders *before* any
//!   byte can reach a model (spec §5 step 7).
//!
//! Both are deterministic **bytes-to-bytes** transforms. Per spec §5.2
//! and guide §9 amendment 13, sanitization performs **no Unicode
//! normalization and no CRLF rewriting**: given the hash-verified raw
//! prefix plus the two version constants, the sanitized bytes are
//! reproducible exactly. That is what makes the sentence table (see
//! [`super::segment`]) replayable years later.
//!
//! Re-opening is *not* re-implemented here. [`reopen_verified`] drives
//! the same five hardened primitives slice 1 uses
//! (`open_absolute_directory_no_links`, `open_relative_no_links`,
//! `openat_child`, `reject_descendant_links`, `hash_exact_prefix` —
//! promoted to `pub(crate)` in Wave 0), so capture-time and read-time
//! containment are one implementation, not two with one name.
//!
//! ## Parser V1 scope, and the evidence it cannot see
//!
//! A JSONL line is consumed iff `type ∈ {"user","assistant"}` and
//! `message.content` is a string or an array of `{type:"text", text}`
//! blocks (joined with [`TEXT_BLOCK_JOIN`]). Everything else — most
//! importantly `tool_use` and **`tool_result`** blocks, which Claude
//! Code carries inside `type:"user"` records — is counted in
//! [`ParseOutcome::skipped_records`] (and, for tool shapes, in
//! [`ParseOutcome::skipped_tool_records`]) and is invisible to the
//! model. This is a deliberate V1 narrowing with a measured cost: **9
//! items of the 58-unit gold set are unreachable** because their
//! evidence lives in a TOOL_RESULT payload. Widening the parser means a
//! new `SourceKind` (spec §5.3), a class-policy row for tool-sourced
//! claims, and a `PARSER_VERSION` bump — not a quiet edit here.
//!
//! Quoted or forwarded text *inside* a user message stays attributed to
//! the user record: host structure cannot prove otherwise. The
//! pasted-content ambiguity is G07's problem (`AmbiguousAttribution`),
//! never the parser's.

use std::ops::Range;
use std::path::{Path, PathBuf};

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::memory::journal::{ApprovedTranscriptRoot, EvidenceReference};

/// Claude Code JSONL parser. Bump on ANY change to record selection,
/// role derivation, or text extraction — `SpanIdentity` embeds it.
pub const PARSER_VERSION: u32 = 1;

/// Redaction pattern set + placeholder spelling. Bump on ANY change.
pub const REDACTION_POLICY_VERSION: u32 = 1;

/// Text blocks of one record are joined with this separator. Part of
/// PARSER_V1: changing it changes every downstream byte offset.
pub const TEXT_BLOCK_JOIN: &str = "\n\n";

/// A transcript prefix, re-opened and re-verified at read time.
///
/// Constructing one re-runs the slice-1 gauntlet: consent, containment,
/// no-follow traversal, regular-file check, then hashes EXACTLY
/// `observed_prefix_len` bytes and compares to the stored digest.
/// `bytes` is the hashed prefix itself — never a byte more (spec §5.1:
/// extra bytes in the live file are invisible by construction).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedPrefix {
    /// The journal's typed locator (input, echoed for the receipt).
    pub reference: EvidenceReference,
    /// Exactly `observed_prefix_len` bytes, digest-checked twice.
    pub bytes: Vec<u8>,
}

/// Why a pinned prefix could not be produced. Every variant is a safe,
/// path-free code: `PrefixMismatch` maps to `Defer(EvidenceUnavailable)`
/// plus the tombstone path, never to a silent read of newer bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrefixReadError {
    /// `local_curator.json` no longer grants both switches.
    ConsentRevoked,
    /// File gone, unreadable, traversal refused, or locator out of policy.
    SourceUnavailable,
    /// The digest over `observed_prefix_len` bytes no longer matches, or
    /// the file is now shorter than the observed prefix.
    PrefixMismatch,
    /// Windows: handle-relative reparse-point rejection is not built yet.
    PlatformUnsupported,
}

/// The V1 realizable subset of the spec's `SourceKind` (§5.3).
///
/// PARSER_V1 emits records for exactly these two roles; `ToolResult`,
/// `FileContent`, `WebContent`, and `SystemEvent` records are skipped
/// visibly instead of being mis-attributed. [`Self::render_label`] is
/// the closed, server-authored label RENDER_V1 prints — the model can
/// never author one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceRole {
    User,
    Assistant,
}

impl SourceRole {
    /// The RENDER_V1 role label (spec §6: closed set, server-derived).
    pub const fn render_label(self) -> &'static str {
        match self {
            SourceRole::User => "user",
            SourceRole::Assistant => "assistant",
        }
    }
}

/// A credential shape REDACT_V1 knows how to remove.
///
/// The class is part of the placeholder text, so it is part of the
/// sanitized bytes: renaming one is a `REDACTION_POLICY_VERSION` bump.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RedactionClass {
    PemBlock,
    AwsAccessKeyId,
    ApiToken,
    BearerToken,
    KeyValueSecret,
    HighEntropy,
}

impl RedactionClass {
    /// The exact bytes written in place of the secret.
    pub const fn placeholder(self) -> &'static str {
        match self {
            RedactionClass::PemBlock => "[REDACTED:pem_block]",
            RedactionClass::AwsAccessKeyId => "[REDACTED:aws_access_key_id]",
            RedactionClass::ApiToken => "[REDACTED:api_token]",
            RedactionClass::BearerToken => "[REDACTED:bearer_token]",
            RedactionClass::KeyValueSecret => "[REDACTED:key_value_secret]",
            RedactionClass::HighEntropy => "[REDACTED:high_entropy]",
        }
    }
}

/// Every placeholder starts with this. The segmenter uses it only for a
/// defensive invariant; redaction *ranges*, not substring search, drive
/// the hard segmentation boundaries.
pub const REDACTION_PREFIX: &str = "[REDACTED:";

/// One placeholder, located in the **sanitized** text (not the raw
/// bytes): `sanitized[start_byte..end_byte] == class.placeholder()`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Redaction {
    pub class: RedactionClass,
    pub start_byte: u32,
    pub end_byte: u32,
}

impl Redaction {
    pub fn range(&self) -> Range<usize> {
        self.start_byte as usize..self.end_byte as usize
    }
}

/// One parsed transcript record. Role is derived from host structure,
/// never inferred from content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParsedRecord {
    /// 0-based index into [`ParseOutcome::records`] — contiguous over
    /// *emitted* records, so `records[record_index]` always holds. Both
    /// this and a raw-line index are stable for a hash-pinned prefix;
    /// this one is the sliceable choice.
    pub record_index: u32,
    /// Byte range of the JSONL line inside the pinned prefix, newline
    /// excluded. Kept for replay + the audit ledger, never rendered.
    pub raw_range: Range<u64>,
    pub role: SourceRole,
    /// Sanitized, model-visible text: text blocks extracted and joined,
    /// secrets replaced by fixed placeholders. Sentence offsets are
    /// relative to THIS string. No NFC, no CRLF rewriting.
    pub sanitized: String,
    /// sha256 of `sanitized` — the spec's `evidence_content_sha256`.
    pub sanitized_sha256: String,
    /// Placeholder ranges within `sanitized`, ascending, non-overlapping.
    pub redactions: Vec<Redaction>,
}

/// The result of PARSER_V1 + REDACT_V1 over one pinned prefix.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParseOutcome {
    pub records: Vec<ParsedRecord>,
    /// Lines that were valid JSON but not a V1-consumable record, plus
    /// lines that were not JSON at all. Skipped VISIBLY (spec L306–311).
    pub skipped_records: u32,
    /// The subset of `skipped_records` that carried tool traffic
    /// (`tool_use` / `tool_result`). Counted separately because it is
    /// the measurable cost of the V1 narrowing (see the module docs).
    pub skipped_tool_records: u32,
    pub parser_version: u32,
    pub redaction_policy_version: u32,
}

/// Pure function of (bytes, `PARSER_VERSION`, `REDACTION_POLICY_VERSION`).
pub fn parse_prefix(prefix: &VerifiedPrefix) -> ParseOutcome {
    parse_bytes(&prefix.bytes)
}

/// The same transform against raw bytes — the shape replay and fixtures
/// use. No IO, no clock, no global state.
pub fn parse_bytes(bytes: &[u8]) -> ParseOutcome {
    let mut records: Vec<ParsedRecord> = Vec::new();
    let mut skipped_records = 0u32;
    let mut skipped_tool_records = 0u32;

    for (start, line) in jsonl_lines(bytes) {
        if line.iter().all(u8::is_ascii_whitespace) {
            // Blank framing, not a record. Nothing to skip visibly.
            continue;
        }
        match extract_record(line) {
            Extracted::Text { role, text } => {
                let (sanitized, redactions) = redact(&text);
                let sanitized_sha256 = sha256_hex(sanitized.as_bytes());
                records.push(ParsedRecord {
                    record_index: records.len() as u32,
                    raw_range: start..(start + line.len() as u64),
                    role,
                    sanitized,
                    sanitized_sha256,
                    redactions,
                });
            }
            Extracted::SkippedTool => {
                skipped_records += 1;
                skipped_tool_records += 1;
            }
            Extracted::Skipped => skipped_records += 1,
        }
    }

    ParseOutcome {
        records,
        skipped_records,
        skipped_tool_records,
        parser_version: PARSER_VERSION,
        redaction_policy_version: REDACTION_POLICY_VERSION,
    }
}

/// `(line_start_offset, line_bytes)` with the newline excluded. A final
/// line without a trailing newline is still offered to the parser: a
/// truncated JSON object fails to parse and is skipped visibly, while a
/// complete last line of a complete file is not silently dropped.
fn jsonl_lines(bytes: &[u8]) -> Vec<(u64, &[u8])> {
    let mut out = Vec::new();
    let mut cursor = 0usize;
    while cursor < bytes.len() {
        let end = bytes[cursor..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|offset| cursor + offset)
            .unwrap_or(bytes.len());
        out.push((cursor as u64, &bytes[cursor..end]));
        cursor = end + 1;
    }
    out
}

enum Extracted {
    Text { role: SourceRole, text: String },
    SkippedTool,
    Skipped,
}

fn extract_record(line: &[u8]) -> Extracted {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(line) else {
        return Extracted::Skipped;
    };
    // Host structure says this line is CLI scaffolding, not something a
    // party said. Trusting that flag is still host structure; guessing
    // the same thing from the text would not be.
    if value.get("isMeta").and_then(serde_json::Value::as_bool) == Some(true) {
        return Extracted::Skipped;
    }
    let record_type = value.get("type").and_then(serde_json::Value::as_str);
    let message = value.get("message");
    let claimed_role = message
        .and_then(|message| message.get("role"))
        .and_then(serde_json::Value::as_str);

    // `type` and `message.role` must agree. A record where they differ
    // has no single host-structural answer, so it is skipped, not
    // adjudicated.
    let role = match (record_type, claimed_role) {
        (Some("user"), None | Some("user")) => SourceRole::User,
        (Some("assistant"), None | Some("assistant")) => SourceRole::Assistant,
        _ => return Extracted::Skipped,
    };

    let Some(content) = message.and_then(|message| message.get("content")) else {
        return Extracted::Skipped;
    };

    let mut parts: Vec<&str> = Vec::new();
    let mut saw_tool_block = false;
    match content {
        serde_json::Value::String(text) => parts.push(text),
        serde_json::Value::Array(blocks) => {
            for block in blocks {
                match block.get("type").and_then(serde_json::Value::as_str) {
                    Some("text") => {
                        if let Some(text) = block.get("text").and_then(serde_json::Value::as_str) {
                            parts.push(text);
                        }
                    }
                    Some("tool_use" | "tool_result") => saw_tool_block = true,
                    _ => {}
                }
            }
        }
        _ => return Extracted::Skipped,
    }

    let parts: Vec<&str> = parts
        .into_iter()
        .filter(|part| !part.trim().is_empty())
        .collect();
    if parts.is_empty() {
        // A tool-only record (Claude Code files `tool_result` under
        // `type:"user"`). Visible, counted, unreachable in V1.
        return if saw_tool_block || value.get("toolUseResult").is_some() {
            Extracted::SkippedTool
        } else {
            Extracted::Skipped
        };
    }
    Extracted::Text {
        role,
        text: parts.join(TEXT_BLOCK_JOIN),
    }
}

// ── REDACT_V1 ────────────────────────────────────────────────────────
//
// Deterministic, ordered, bytes-to-bytes. Patterns are tried in the
// fixed order below; overlapping matches resolve by (earliest start,
// then longest, then lowest pattern index) and the loser is dropped, so
// the output never depends on match arrival order.

struct RedactionPattern {
    class: RedactionClass,
    regex: Regex,
    /// Capture group carrying the secret; 0 = redact the whole match.
    group: usize,
    /// Extra deterministic screen (entropy), applied to the group text.
    entropy_screen: bool,
}

static REDACTION_PATTERNS: Lazy<Vec<RedactionPattern>> = Lazy::new(|| {
    let compile = |class, pattern: &str, group, entropy_screen| RedactionPattern {
        class,
        // Every pattern here is a compile-time literal covered by tests;
        // a bad one is a build-breaking bug, not a runtime condition.
        regex: Regex::new(pattern).expect("REDACT_V1 pattern must compile"),
        group,
        entropy_screen,
    };
    vec![
        compile(
            RedactionClass::PemBlock,
            r"(?s)-----BEGIN [A-Z0-9 ]{1,64}-----.*?-----END [A-Z0-9 ]{1,64}-----",
            0,
            false,
        ),
        compile(
            RedactionClass::BearerToken,
            r"(?i)\bauthorization\s*:\s*(?:bearer|token|basic)\s+([A-Za-z0-9._~+/=-]{8,})",
            1,
            false,
        ),
        compile(
            RedactionClass::AwsAccessKeyId,
            r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b",
            0,
            false,
        ),
        compile(
            RedactionClass::ApiToken,
            r"\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b",
            0,
            false,
        ),
        compile(
            RedactionClass::ApiToken,
            r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b",
            0,
            false,
        ),
        compile(
            RedactionClass::ApiToken,
            r"\bgithub_pat_[A-Za-z0-9_]{20,}\b",
            0,
            false,
        ),
        compile(
            RedactionClass::ApiToken,
            r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b",
            0,
            false,
        ),
        compile(
            RedactionClass::KeyValueSecret,
            r#"(?i)\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?token|client[_-]?secret)\b\s*[=:]\s*["']?([^\s"',;]{6,})"#,
            1,
            false,
        ),
        // The length-≥32 high-entropy screen. The character class alone
        // matches long slugs and paths, so the entropy + digit test
        // below decides; both halves are pure functions of the text.
        compile(
            RedactionClass::HighEntropy,
            r"\b[A-Za-z0-9+/=_-]{32,}\b",
            0,
            true,
        ),
    ]
});

/// Shannon entropy in bits per character. Pure and platform-stable: the
/// float is only ever compared against a fixed threshold, never stored
/// or formatted.
fn shannon_entropy(text: &str) -> f64 {
    let mut counts = [0usize; 128];
    let mut wide = 0usize;
    let mut total = 0usize;
    for character in text.chars() {
        total += 1;
        match u32::from(character) {
            code if code < 128 => counts[code as usize] += 1,
            _ => wide += 1,
        }
    }
    if total == 0 {
        return 0.0;
    }
    let total_f = total as f64;
    let mut entropy = 0.0;
    for count in counts.iter().copied().chain(std::iter::once(wide)) {
        if count > 0 {
            let probability = count as f64 / total_f;
            entropy -= probability * probability.log2();
        }
    }
    entropy
}

/// A ≥32-char token is a secret if it looks like a hash or a key rather
/// than a slug: pure hex, or high entropy with both digits and letters.
fn looks_high_entropy(text: &str) -> bool {
    let has_digit = text.chars().any(|character| character.is_ascii_digit());
    let has_alpha = text
        .chars()
        .any(|character| character.is_ascii_alphabetic());
    let all_hex = text.chars().all(|character| character.is_ascii_hexdigit());
    if all_hex && has_digit && text.len() >= 32 {
        return true;
    }
    has_digit && has_alpha && shannon_entropy(text) >= 3.5
}

/// REDACT_V1. Returns the sanitized text plus the placeholder ranges
/// *in the sanitized coordinate space*.
pub fn redact(text: &str) -> (String, Vec<Redaction>) {
    let mut hits: Vec<(usize, usize, usize, RedactionClass)> = Vec::new();
    for (index, pattern) in REDACTION_PATTERNS.iter().enumerate() {
        for captures in pattern.regex.captures_iter(text) {
            let Some(matched) = captures.get(pattern.group).or_else(|| captures.get(0)) else {
                continue;
            };
            if pattern.entropy_screen && !looks_high_entropy(matched.as_str()) {
                continue;
            }
            hits.push((matched.start(), matched.end(), index, pattern.class));
        }
    }
    if hits.is_empty() {
        return (text.to_string(), Vec::new());
    }
    // Earliest start wins; then the longest match; then the
    // higher-priority (lower index) pattern. A total order ⇒ one
    // possible output for one input.
    hits.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then(right.1.cmp(&left.1))
            .then(left.2.cmp(&right.2))
    });

    let mut sanitized = String::with_capacity(text.len());
    let mut redactions = Vec::new();
    let mut cursor = 0usize;
    for (start, end, _, class) in hits {
        if start < cursor {
            continue; // overlaps an already-accepted redaction
        }
        sanitized.push_str(&text[cursor..start]);
        let placeholder_start = sanitized.len();
        sanitized.push_str(class.placeholder());
        redactions.push(Redaction {
            class,
            start_byte: placeholder_start as u32,
            end_byte: sanitized.len() as u32,
        });
        cursor = end;
    }
    sanitized.push_str(&text[cursor..]);
    (sanitized, redactions)
}

/// Lowercase hex sha256. One implementation for sanitized-content
/// digests, span digests, and the read-back check below.
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

// ── read-time rebind ─────────────────────────────────────────────────

/// Read-time consent + approved root. Built from
/// `~/.neurovault/local_curator.json` in production; built from a
/// fixture root in tests, so no test ever reads the real consent file.
#[derive(Debug, Clone)]
pub(crate) struct ReadPolicy {
    consent: bool,
    resolved_root: Option<PathBuf>,
}

impl ReadPolicy {
    pub(crate) fn load(consent: bool, configured_root: PathBuf) -> Self {
        // Consent is checked before the root is even resolved, so a
        // disabled curator cannot be used as a filesystem oracle.
        let resolved_root = (consent && configured_root.is_absolute() && cfg!(unix))
            .then(|| std::fs::canonicalize(&configured_root).ok())
            .flatten();
        Self {
            consent,
            resolved_root,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
struct ReadConsentConfig {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    transcript_access: bool,
}

/// Both switches, explicitly true, or nothing happens. This mirrors
/// `evidence`'s capture-time contract at read time; Wave 0 promoted the
/// traversal primitives but not the consent loader, so the two-line
/// config shape is restated here and pinned by
/// `consent_requires_both_switches`.
fn production_read_policy() -> ReadPolicy {
    let raw = std::fs::read_to_string(crate::memory::paths::nv_home().join("local_curator.json"));
    let config: ReadConsentConfig = raw
        .ok()
        .and_then(|body| serde_json::from_str(&body).ok())
        .unwrap_or_default();
    ReadPolicy::load(
        config.enabled && config.transcript_access,
        crate::memory::paths::claude_projects_dir(),
    )
}

/// Read-time rebind. NEVER reads past `observed_prefix_len`; extra bytes
/// in the live file are invisible by construction (spec §5.1).
pub fn reopen_verified(reference: &EvidenceReference) -> Result<VerifiedPrefix, PrefixReadError> {
    reopen_with_policy(reference, &production_read_policy())
}

#[cfg(not(unix))]
fn reopen_with_policy(
    _reference: &EvidenceReference,
    _policy: &ReadPolicy,
) -> Result<VerifiedPrefix, PrefixReadError> {
    // Same fail-closed posture as capture: without handle-relative
    // reparse-point rejection there is no read at all.
    Err(PrefixReadError::PlatformUnsupported)
}

#[cfg(unix)]
fn reopen_with_policy(
    reference: &EvidenceReference,
    policy: &ReadPolicy,
) -> Result<VerifiedPrefix, PrefixReadError> {
    use std::io::{Read, Seek, SeekFrom};

    use super::evidence::{
        hash_exact_prefix, open_absolute_directory_no_links, open_relative_no_links,
        reject_descendant_links, MAX_TRANSCRIPT_PREFIX_BYTES,
    };

    if !policy.consent {
        return Err(PrefixReadError::ConsentRevoked);
    }
    let EvidenceReference::Transcript {
        root,
        relative_path,
        observed_prefix_len,
        source_prefix_sha256,
    } = reference;
    // One approved root today; the match keeps a future variant from
    // silently inheriting these guarantees.
    match root {
        ApprovedTranscriptRoot::ClaudeProjects => {}
    }
    if *observed_prefix_len == 0 || *observed_prefix_len > MAX_TRANSCRIPT_PREFIX_BYTES {
        return Err(PrefixReadError::SourceUnavailable);
    }
    let relative = validated_relative(relative_path)?;
    let Some(resolved_root) = policy.resolved_root.as_deref() else {
        return Err(PrefixReadError::SourceUnavailable);
    };
    reject_descendant_links(resolved_root, &relative)
        .map_err(|_| PrefixReadError::SourceUnavailable)?;
    let root_handle = open_absolute_directory_no_links(resolved_root)
        .map_err(|_| PrefixReadError::SourceUnavailable)?;
    let mut file = open_relative_no_links(root_handle, &relative)
        .map_err(|_| PrefixReadError::SourceUnavailable)?;
    let metadata = file
        .metadata()
        .map_err(|_| PrefixReadError::SourceUnavailable)?;
    if !metadata.is_file() {
        return Err(PrefixReadError::SourceUnavailable);
    }
    if metadata.len() < *observed_prefix_len {
        // Truncated or replaced: the bound evidence is gone. Deferred,
        // never "read whatever is there now".
        return Err(PrefixReadError::PrefixMismatch);
    }
    let on_disk = hash_exact_prefix(&mut file, *observed_prefix_len)
        .map_err(|_| PrefixReadError::SourceUnavailable)?;
    if &on_disk != source_prefix_sha256 {
        return Err(PrefixReadError::PrefixMismatch);
    }

    let length = usize::try_from(*observed_prefix_len)
        // A prefix longer than this machine's address space is an
        // unreadable source, not a digest disagreement.
        .map_err(|_| PrefixReadError::SourceUnavailable)?;
    file.seek(SeekFrom::Start(0))
        .map_err(|_| PrefixReadError::SourceUnavailable)?;
    let mut bytes = Vec::with_capacity(length);
    file.take(*observed_prefix_len)
        .read_to_end(&mut bytes)
        .map_err(|_| PrefixReadError::SourceUnavailable)?;
    if bytes.len() != length {
        return Err(PrefixReadError::PrefixMismatch);
    }
    // Hash the bytes we are about to hand out, not merely the bytes on
    // disk a moment ago: what the parser sees is what was verified.
    if sha256_hex(&bytes) != *source_prefix_sha256 {
        return Err(PrefixReadError::PrefixMismatch);
    }

    Ok(VerifiedPrefix {
        reference: reference.clone(),
        bytes,
    })
}

/// The durable locator is server-authored, but it is still parsed before
/// it steers a filesystem walk: one meaning, or no read. The traversal
/// itself stays in the slice-1 primitives.
#[cfg(unix)]
fn validated_relative(relative_path: &str) -> Result<PathBuf, PrefixReadError> {
    use std::path::Component;

    if relative_path.is_empty()
        || relative_path.contains('\\')
        || relative_path.contains('\0')
        || relative_path.starts_with('/')
    {
        return Err(PrefixReadError::SourceUnavailable);
    }
    let candidate = Path::new(relative_path);
    if candidate
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(PrefixReadError::SourceUnavailable);
    }
    if candidate.extension().and_then(|value| value.to_str()) != Some("jsonl") {
        return Err(PrefixReadError::SourceUnavailable);
    }
    Ok(candidate.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn user_line(text: &str) -> String {
        format!(
            r#"{{"type":"user","uuid":"a1","message":{{"role":"user","content":{}}}}}"#,
            serde_json::to_string(text).unwrap()
        )
    }

    fn assistant_line(text: &str) -> String {
        format!(
            r#"{{"type":"assistant","uuid":"b2","message":{{"role":"assistant","content":[{{"type":"text","text":{}}}]}}}}"#,
            serde_json::to_string(text).unwrap()
        )
    }

    #[test]
    fn parses_role_tagged_records_from_host_structure() {
        let jsonl = format!("{}\n{}\n", user_line("hello there"), assistant_line("hi"));
        let outcome = parse_bytes(jsonl.as_bytes());
        assert_eq!(outcome.records.len(), 2);
        assert_eq!(outcome.skipped_records, 0);
        assert_eq!(outcome.parser_version, PARSER_VERSION);
        assert_eq!(outcome.redaction_policy_version, REDACTION_POLICY_VERSION);
        assert_eq!(outcome.records[0].role, SourceRole::User);
        assert_eq!(outcome.records[0].record_index, 0);
        assert_eq!(outcome.records[0].sanitized, "hello there");
        assert_eq!(outcome.records[1].role, SourceRole::Assistant);
        assert_eq!(outcome.records[1].record_index, 1);
        // Raw ranges point back into the pinned prefix, newline excluded.
        let first_len = user_line("hello there").len() as u64;
        assert_eq!(outcome.records[0].raw_range, 0..first_len);
        assert_eq!(outcome.records[1].raw_range.start, first_len + 1);
    }

    #[test]
    fn text_blocks_join_with_the_versioned_separator() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"one"},{"type":"tool_use","name":"Bash"},{"type":"text","text":"two"}]}}"#;
        let outcome = parse_bytes(line.as_bytes());
        assert_eq!(outcome.records.len(), 1);
        assert_eq!(
            outcome.records[0].sanitized,
            format!("one{TEXT_BLOCK_JOIN}two")
        );
        // A tool block alongside text does not make the record a skip.
        assert_eq!(outcome.skipped_tool_records, 0);
    }

    #[test]
    fn tool_records_are_skipped_visibly_and_counted() {
        // Claude Code files tool results under `type:"user"`.
        let tool_result = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]},"toolUseResult":{"stdout":"ok"}}"#;
        let tool_use = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}]}}"#;
        let unknown_shape = r#"{"type":"summary","summary":"a session"}"#;
        let not_json = "{oops";
        let role_disagreement =
            r#"{"type":"user","message":{"role":"assistant","content":"who said this?"}}"#;
        let meta = r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"<system-reminder>ignore me</system-reminder>"}}"#;
        let jsonl = format!(
            "{tool_result}\n{tool_use}\n{unknown_shape}\n{not_json}\n{role_disagreement}\n{meta}\n{}\n",
            user_line("a real sentence from the user")
        );

        let outcome = parse_bytes(jsonl.as_bytes());
        assert_eq!(outcome.records.len(), 1);
        assert_eq!(outcome.records[0].record_index, 0);
        assert_eq!(outcome.skipped_records, 6);
        // The measurable cost of the V1 narrowing: TOOL_RESULT evidence
        // is unreachable (9 items of the 58-unit gold set).
        assert_eq!(outcome.skipped_tool_records, 2);
    }

    #[test]
    fn blank_lines_are_framing_not_skipped_records() {
        let jsonl = format!("\n{}\n\n\n", user_line("only one record"));
        let outcome = parse_bytes(jsonl.as_bytes());
        assert_eq!(outcome.records.len(), 1);
        assert_eq!(outcome.skipped_records, 0);
    }

    #[test]
    fn final_line_without_a_newline_is_parsed_but_truncation_is_not() {
        let complete = user_line("complete last line");
        let outcome = parse_bytes(complete.as_bytes());
        assert_eq!(outcome.records.len(), 1);

        let truncated = &complete[..complete.len() - 12];
        let outcome = parse_bytes(truncated.as_bytes());
        assert_eq!(outcome.records.len(), 0);
        assert_eq!(outcome.skipped_records, 1);
    }

    #[test]
    fn sanitization_performs_no_unicode_normalization_and_no_crlf_rewriting() {
        // Decomposed e + combining acute, a CRLF, an NBSP and an emoji:
        // every byte must survive the transform unchanged (spec §5.2).
        let raw = "cafe\u{301}\r\nnon\u{a0}breaking 🧠 end";
        let outcome = parse_bytes(user_line(raw).as_bytes());
        assert_eq!(outcome.records[0].sanitized, raw);
        assert_eq!(outcome.records[0].sanitized.as_bytes(), raw.as_bytes());
        assert!(outcome.records[0].sanitized.contains("\r\n"));
        assert!(!outcome.records[0].sanitized.contains('\u{e9}'));
        assert_eq!(
            outcome.records[0].sanitized_sha256,
            sha256_hex(raw.as_bytes())
        );
    }

    #[test]
    fn redaction_replaces_every_class_and_records_sanitized_ranges() {
        let cases = [
            (
                "key -----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY----- done",
                RedactionClass::PemBlock,
                "MIIBOgIBAAJBAK",
            ),
            (
                "use AKIAIOSFODNN7EXAMPLE for the bucket",
                RedactionClass::AwsAccessKeyId,
                "AKIAIOSFODNN7EXAMPLE",
            ),
            (
                "token sk-abcdefghijklmnop0123 is live",
                RedactionClass::ApiToken,
                "sk-abcdefghijklmnop0123",
            ),
            (
                "header Authorization: Bearer eyJhbGciOi.J9x-y_z=",
                RedactionClass::BearerToken,
                "eyJhbGciOi.J9x-y_z=",
            ),
            (
                "set password=hunter2000 in the env",
                RedactionClass::KeyValueSecret,
                "hunter2000",
            ),
            (
                "digest 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 ok",
                RedactionClass::HighEntropy,
                "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
            ),
        ];
        for (raw, class, secret) in cases {
            let (sanitized, redactions) = redact(raw);
            assert!(
                !sanitized.contains(secret),
                "secret survived redaction: {sanitized}"
            );
            assert_eq!(redactions.len(), 1, "in {raw:?} -> {sanitized:?}");
            assert_eq!(redactions[0].class, class, "in {raw:?}");
            assert_eq!(&sanitized[redactions[0].range()], class.placeholder());
            assert!(class.placeholder().starts_with(REDACTION_PREFIX));
        }
    }

    #[test]
    fn redaction_keeps_ordinary_long_tokens_and_is_deterministic() {
        let prose = "Read src/memory/adaptive/curator/segment.rs and the-very-long-slug-name-goes-here for context.";
        let (sanitized, redactions) = redact(prose);
        assert_eq!(sanitized, prose);
        assert!(redactions.is_empty());

        let secret = "password=hunter2000 and sk-abcdefghijklmnop0123";
        let (first, first_ranges) = redact(secret);
        let (second, second_ranges) = redact(secret);
        assert_eq!(first, second);
        assert_eq!(first_ranges, second_ranges);
        assert_eq!(first_ranges.len(), 2);
        // Ascending, non-overlapping, and each range really is a placeholder.
        assert!(first_ranges[0].end_byte <= first_ranges[1].start_byte);
        for redaction in &first_ranges {
            assert_eq!(&first[redaction.range()], redaction.class.placeholder());
        }
    }

    #[test]
    fn overlapping_patterns_resolve_to_one_deterministic_winner() {
        // Coverage first: `token=<40 hex>` matches KeyValueSecret from
        // byte 6 and the high-entropy screen from byte 0, so the wider
        // match wins and the key name goes with it. One placeholder, and
        // never fewer bytes redacted than any single pattern asked for.
        let raw = "token=0123456789abcdef0123456789abcdef01234567 end";
        let (sanitized, redactions) = redact(raw);
        assert_eq!(redactions.len(), 1, "{sanitized}");
        assert_eq!(redactions[0].class, RedactionClass::HighEntropy);
        assert_eq!(sanitized, "[REDACTED:high_entropy] end");

        // Same start AND same end: the lower pattern index wins, so the
        // receipt gets the specific class rather than the catch-all.
        let bearer = "Authorization: Bearer abcdefghij0123456789abcdefghij0123";
        let (sanitized, redactions) = redact(bearer);
        assert_eq!(redactions.len(), 1, "{sanitized}");
        assert_eq!(redactions[0].class, RedactionClass::BearerToken);
        assert_eq!(sanitized, "Authorization: Bearer [REDACTED:bearer_token]");
    }

    #[test]
    fn consent_requires_both_switches() {
        for raw in [
            "{}",
            r#"{"enabled":true}"#,
            r#"{"transcript_access":true}"#,
            "not json",
        ] {
            let config: ReadConsentConfig = serde_json::from_str(raw).unwrap_or_default();
            assert!(!(config.enabled && config.transcript_access), "{raw}");
        }
        let config: ReadConsentConfig =
            serde_json::from_str(r#"{"enabled":true,"transcript_access":true}"#).unwrap();
        assert!(config.enabled && config.transcript_access);
    }

    // ── read-time rebind (fixture roots only; never ~/.neurovault) ────

    #[cfg(unix)]
    mod reopen {
        use super::*;
        use std::fs;

        fn fixture(name: &str) -> (PathBuf, PathBuf) {
            let requested = std::env::temp_dir().join(format!(
                "nv-curator-transcript-{name}-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4().simple()
            ));
            fs::create_dir_all(&requested).unwrap();
            let root = fs::canonicalize(requested).unwrap();
            let project = root.join("-Users-dath-code-atlas");
            fs::create_dir_all(&project).unwrap();
            (root, project)
        }

        fn reference(relative_path: &str, bytes: &[u8]) -> EvidenceReference {
            EvidenceReference::Transcript {
                root: ApprovedTranscriptRoot::ClaudeProjects,
                relative_path: relative_path.to_string(),
                observed_prefix_len: bytes.len() as u64,
                source_prefix_sha256: sha256_hex(bytes),
            }
        }

        #[test]
        fn happy_path_returns_exactly_the_pinned_prefix() {
            let (root, project) = fixture("happy");
            let pinned = b"{\"type\":\"user\"}\n";
            let mut on_disk = pinned.to_vec();
            on_disk.extend_from_slice(b"{\"type\":\"assistant\"}\n");
            fs::write(project.join("s-1.jsonl"), &on_disk).unwrap();

            let policy = ReadPolicy::load(true, root.clone());
            let verified = reopen_with_policy(
                &reference("-Users-dath-code-atlas/s-1.jsonl", pinned),
                &policy,
            )
            .unwrap();
            // Bytes appended after capture are invisible by construction.
            assert_eq!(verified.bytes, pinned);
            let _ = fs::remove_dir_all(root);
        }

        #[test]
        fn consent_is_checked_before_any_filesystem_access() {
            let (root, _) = fixture("consent");
            let policy = ReadPolicy::load(false, root.clone());
            let missing = reference("-Users-dath-code-atlas/never.jsonl", b"x");
            assert_eq!(
                reopen_with_policy(&missing, &policy),
                Err(PrefixReadError::ConsentRevoked)
            );
            let _ = fs::remove_dir_all(root);
        }

        #[test]
        fn mutated_truncated_and_missing_sources_never_read_newer_bytes() {
            let (root, project) = fixture("mutation");
            let pinned = b"original bytes here\n";
            let path = project.join("s-1.jsonl");
            fs::write(&path, pinned).unwrap();
            let policy = ReadPolicy::load(true, root.clone());
            let reference = reference("-Users-dath-code-atlas/s-1.jsonl", pinned);

            fs::write(&path, b"mutated bytes here\n").unwrap();
            assert_eq!(
                reopen_with_policy(&reference, &policy),
                Err(PrefixReadError::PrefixMismatch)
            );

            fs::write(&path, b"short\n").unwrap();
            assert_eq!(
                reopen_with_policy(&reference, &policy),
                Err(PrefixReadError::PrefixMismatch)
            );

            fs::remove_file(&path).unwrap();
            assert_eq!(
                reopen_with_policy(&reference, &policy),
                Err(PrefixReadError::SourceUnavailable)
            );
            let _ = fs::remove_dir_all(root);
        }

        #[test]
        fn symlinks_and_malformed_locators_are_refused() {
            use std::os::unix::fs::symlink;

            let (root, project) = fixture("locators");
            let real = project.join("s-1.jsonl");
            fs::write(&real, b"x\n").unwrap();
            symlink(&real, project.join("s-2.jsonl")).unwrap();
            let policy = ReadPolicy::load(true, root.clone());

            assert_eq!(
                reopen_with_policy(
                    &reference("-Users-dath-code-atlas/s-2.jsonl", b"x\n"),
                    &policy
                ),
                Err(PrefixReadError::SourceUnavailable)
            );
            for bad in [
                "",
                "/absolute/s-1.jsonl",
                "../escape/s-1.jsonl",
                "-Users-dath-code-atlas/s-1.txt",
                "-Users-dath-code-atlas\\s-1.jsonl",
            ] {
                assert_eq!(
                    reopen_with_policy(&reference(bad, b"x\n"), &policy),
                    Err(PrefixReadError::SourceUnavailable),
                    "{bad}"
                );
            }
            let _ = fs::remove_dir_all(root);
        }

        #[test]
        fn parse_prefix_and_parse_bytes_agree() {
            let (root, project) = fixture("parse");
            let jsonl = format!("{}\n", user_line("a durable sentence."));
            fs::write(project.join("s-1.jsonl"), jsonl.as_bytes()).unwrap();
            let policy = ReadPolicy::load(true, root.clone());
            let verified = reopen_with_policy(
                &reference("-Users-dath-code-atlas/s-1.jsonl", jsonl.as_bytes()),
                &policy,
            )
            .unwrap();
            assert_eq!(parse_prefix(&verified), parse_bytes(jsonl.as_bytes()));
            let _ = fs::remove_dir_all(root);
        }
    }
}
