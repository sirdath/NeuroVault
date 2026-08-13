//! Sentence enumeration, `RENDER_V1`, span resolution (guide §2.3, spec §5.2).
//!
//! **SEG_V1** ([`SEGMENTER_VERSION`]) turns the sanitized records of one
//! unit into a numbered sentence table. The table is the evidence
//! contract: the model may only point at `S{n}`, and the server
//! materializes the cited text itself by slicing its own offsets. There
//! is no search path in this module, by construction.
//!
//! The algorithm is closed and versioned:
//!
//! 1. **Redaction split.** Every redaction range from REDACT_V1 is a
//!    *hard* boundary. A placeholder is enumerated as its own sentence
//!    with `cite_ok = false`, and no other sentence can contain bytes
//!    from both sides of it (spec §5.2). The model may read a secret's
//!    neighbourhood as context; it can never ground a memory in it.
//! 2. **Block pass** (line-based, per zone): a fenced code block, or a
//!    run of ≥ [`MIN_LOG_RUN_LINES`] log-shaped lines, becomes ONE
//!    opaque sentence. Over [`OPAQUE_BLOCK_RENDER_CAP_BYTES`] the block
//!    keeps its full offsets and its citable ID, but RENDER_V1 truncates
//!    the model-visible body with `… [+N bytes]` and the sentence is
//!    flagged [`Sentence::over_cap`] — citing it routes to
//!    `RequireReview(OversizedEvidence)` at the gate, never a silent
//!    pass and never a reject.
//! 3. **Prose pass**: UAX#29 sentence boundaries
//!    (`unicode-segmentation`, pinned crate + Unicode data version,
//!    asserted by a test) applied **per line**. UAX#29 already breaks at
//!    every line separator, and keeping the pass line-local is what lets
//!    RENDER_V1 print exactly one line per prose sentence.
//! 4. **Trim + merge**: offsets identify the whitespace-trimmed extent;
//!    a segment under [`MIN_SENTENCE_WORDS`] words merges into its
//!    successor (UAX#29 over-splits on abbreviations and initials);
//!    empty results drop. Neither operation crosses a record, an opaque
//!    block, a redaction, or a line.
//! 5. **IDs**: one-based, contiguous, restarting at `S1` per unit,
//!    capped at [`MAX_SENTENCES_PER_UNIT`]. [`split_units`] divides a
//!    larger record set at record boundaries before enumeration.
//!
//! Determinism contract: same sanitized bytes + same
//! `SEGMENTER_VERSION` ⇒ byte-identical table ⇒ identical IDs ⇒
//! identical rendering. The table is derived data: the run audit
//! persists offsets and flags, never sentence text, and replay
//! re-verifies the prefix digest, re-runs this same-versioned code, and
//! asserts the reconstructed table is identical before resolving any
//! citation.
//!
//! Note on the pinned dependency: only `split_sentence_bound_indices`
//! is used, whose tables ship *inside* the crate. (The crate's
//! word-segmentation helpers can delegate to `core`'s Unicode data when
//! the versions match — a toolchain coupling this module deliberately
//! does not inherit.)

use std::ops::Range;

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use unicode_segmentation::UnicodeSegmentation;

use super::transcript::{sha256_hex, ParsedRecord, SourceRole};

/// Block pass + UAX#29 prose pass + trim/merge. Bump on ANY rule change
/// — `SpanIdentity` embeds it and a change also forces an
/// `IDENTITY_VERSION` bump plus migration/replay fixtures.
pub const SEGMENTER_VERSION: u32 = 1;

/// The exact `unicode-segmentation` release SEG_V1 was defined against.
/// Pinned with `=` in Cargo.toml and asserted against Cargo.lock.
pub const UNICODE_SEGMENTATION_CRATE_VERSION: &str = "1.13.2";

/// The Unicode data version behind that release.
pub const UNICODE_DATA_VERSION: (u64, u64, u64) = (17, 0, 0);

/// Small IDs keep the model's pointer accurate (long-context drift is
/// the measured failure mode). Larger units are split, never squeezed.
pub const MAX_SENTENCES_PER_UNIT: usize = 150;

/// An opaque block longer than this renders truncated. Its offsets stay
/// whole: the cap is a *rendering* rule, not an evidence rule.
pub const OPAQUE_BLOCK_RENDER_CAP_BYTES: usize = 2048;

/// Under this many words, a prose segment merges into its successor.
pub const MIN_SENTENCE_WORDS: usize = 3;

/// This many consecutive log-shaped lines collapse into one opaque ID.
pub const MIN_LOG_RUN_LINES: usize = 3;

/// One enumerated sentence. Offsets index into
/// [`ParsedRecord::sanitized`] of the record named by `record_index` —
/// never into the raw transcript, and never into the rendering.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sentence {
    /// 1-based, contiguous across the whole unit; rendered as `S{sid}`.
    /// Request-local: it is a citation token, never an identity field.
    pub sid: u32,
    pub record_index: u32,
    /// 0-based within its record — part of the durable `SpanIdentity`.
    pub sentence_index: u32,
    pub start_byte: u32,
    pub end_byte: u32,
    pub role: SourceRole,
    /// False only for a redaction placeholder: readable context that
    /// cannot support a proposal (`Reject(InvalidEvidence)` at G02).
    pub cite_ok: bool,
    /// Code fence, log run, or JSON blob: one ID for the whole block.
    pub opaque_block: bool,
    /// Opaque block past the render cap. Still citable; the citation
    /// adds `RequireReview(OversizedEvidence)`.
    pub over_cap: bool,
}

/// The server-owned table for one unit. Derived data — persisted in the
/// run audit as offsets and flags, never as text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SentenceTable {
    pub sentences: Vec<Sentence>,
    pub segmenter_version: u32,
    /// Sentences dropped by the 150-per-unit cap. Non-zero only when a
    /// single record exceeds the cap on its own, since [`split_units`]
    /// divides at record boundaries first. Visible, never silent.
    pub dropped_over_cap: u32,
}

impl SentenceTable {
    /// IDs are contiguous and one-based, so this is an index, not a scan.
    pub fn sentence_by_sid(&self, sid: u32) -> Option<&Sentence> {
        if sid == 0 {
            return None;
        }
        self.sentences
            .get(sid as usize - 1)
            .filter(|s| s.sid == sid)
    }
}

/// A cited sentence, materialized by the server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedSentence<'a> {
    pub sentence: &'a Sentence,
    pub text: &'a str,
    /// sha256 of the resolved bytes — the receipt's `span_sha256`.
    pub span_sha256: String,
}

/// Pure function of (sanitized segments, `SEGMENTER_VERSION`).
///
/// Callers with more than [`MAX_SENTENCES_PER_UNIT`] sentences' worth of
/// records should run [`split_units`] first; anything past the cap is
/// dropped here and counted in [`SentenceTable::dropped_over_cap`].
pub fn enumerate(records: &[ParsedRecord]) -> SentenceTable {
    let mut sentences: Vec<Sentence> = Vec::new();
    for record in records {
        for (index, span) in record_spans(record).into_iter().enumerate() {
            sentences.push(Sentence {
                sid: 0, // assigned once the unit is complete
                record_index: record.record_index,
                sentence_index: index as u32,
                start_byte: span.start as u32,
                end_byte: span.end as u32,
                role: record.role,
                cite_ok: !span.redacted,
                opaque_block: span.opaque,
                over_cap: span.opaque && span.end - span.start > OPAQUE_BLOCK_RENDER_CAP_BYTES,
            });
        }
    }
    let dropped = sentences.len().saturating_sub(MAX_SENTENCES_PER_UNIT);
    sentences.truncate(MAX_SENTENCES_PER_UNIT);
    for (index, sentence) in sentences.iter_mut().enumerate() {
        sentence.sid = index as u32 + 1;
    }
    SentenceTable {
        sentences,
        segmenter_version: SEGMENTER_VERSION,
        dropped_over_cap: dropped as u32,
    }
}

/// Divide a record set into consecutive sub-units of at most
/// [`MAX_SENTENCES_PER_UNIT`] sentences, splitting only at record
/// boundaries (spec §5.2 step 4). Sub-units share the turn's event IDs;
/// each is enumerated separately and restarts at `S1`.
pub fn split_units(records: &[ParsedRecord]) -> Vec<Range<usize>> {
    let mut units = Vec::new();
    let mut start = 0usize;
    let mut count = 0usize;
    for (index, record) in records.iter().enumerate() {
        let in_record = record_spans(record).len();
        if count > 0 && count + in_record > MAX_SENTENCES_PER_UNIT {
            units.push(start..index);
            start = index;
            count = 0;
        }
        count += in_record;
    }
    if start < records.len() {
        units.push(start..records.len());
    }
    units
}

/// RENDER_V1: the exact bytes the model sees. One `S{sid} [{role}]: …`
/// line per sentence in ascending ID order, each terminated by `\n`
/// (spec §6). Byte-identical across replays.
pub fn render_unit(records: &[ParsedRecord], table: &SentenceTable) -> String {
    let mut out = String::new();
    for sentence in &table.sentences {
        out.push_str(&render_sentence(records, sentence));
        out.push('\n');
    }
    out
}

/// One RENDER_V1 entry, without its trailing newline. Opaque blocks keep
/// the same header and indent every continuation line by two spaces.
pub fn render_sentence(records: &[ParsedRecord], sentence: &Sentence) -> String {
    let header = format!("S{} [{}]: ", sentence.sid, sentence.role.render_label());
    let Some(body) = sentence_text(records, sentence) else {
        // Unreachable with a table built by `enumerate` over these
        // records. Rendering nothing is the fail-closed choice: the
        // model can never be shown bytes the server cannot re-slice.
        return header;
    };
    if !sentence.opaque_block {
        return header + body;
    }
    let (kept, dropped) = truncate_on_char_boundary(body, OPAQUE_BLOCK_RENDER_CAP_BYTES);
    let mut lines = kept.split('\n');
    let mut out = header;
    if let Some(first) = lines.next() {
        out.push_str(first);
    }
    for line in lines {
        out.push_str("\n  ");
        out.push_str(line);
    }
    if dropped > 0 {
        out.push_str(&format!("… [+{dropped} bytes]"));
    }
    out
}

/// Resolve = read the table + slice the sanitized text. No search, ever.
///
/// `None` means the ID is unknown to this unit, or a stored extent is
/// not a valid slice of its record — a defensive invariant failure that
/// invalidates the prepared envelope rather than blaming the model.
pub fn resolve<'a>(
    records: &'a [ParsedRecord],
    table: &'a SentenceTable,
    sid: u32,
) -> Option<ResolvedSentence<'a>> {
    let sentence = table.sentence_by_sid(sid)?;
    let text = sentence_text(records, sentence)?;
    Some(ResolvedSentence {
        sentence,
        text,
        span_sha256: sha256_hex(text.as_bytes()),
    })
}

fn sentence_text<'a>(records: &'a [ParsedRecord], sentence: &Sentence) -> Option<&'a str> {
    let record = records
        .iter()
        .find(|record| record.record_index == sentence.record_index)?;
    // `get` refuses out-of-range and non-UTF-8-boundary extents, so a
    // corrupt table cannot produce a mangled quotation.
    record
        .sanitized
        .get(sentence.start_byte as usize..sentence.end_byte as usize)
}

/// Largest prefix of at most `cap` bytes that ends on a char boundary,
/// plus the number of bytes dropped.
fn truncate_on_char_boundary(body: &str, cap: usize) -> (&str, usize) {
    if body.len() <= cap {
        return (body, 0);
    }
    let mut cut = cap;
    while cut > 0 && !body.is_char_boundary(cut) {
        cut -= 1;
    }
    (&body[..cut], body.len() - cut)
}

// ── SEG_V1 internals ─────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RawSpan {
    start: usize,
    end: usize,
    opaque: bool,
    redacted: bool,
}

/// Step 1: split the record at redaction boundaries, then segment each
/// zone. The placeholder itself is one uncitable sentence.
fn record_spans(record: &ParsedRecord) -> Vec<RawSpan> {
    let text = record.sanitized.as_str();
    let mut spans = Vec::new();
    let mut cursor = 0usize;
    for redaction in &record.redactions {
        let start = redaction.start_byte as usize;
        let end = redaction.end_byte as usize;
        // Defensive: REDACT_V1 emits ascending, in-bounds, non-overlapping
        // ranges. A violation is skipped rather than trusted.
        if start < cursor || end > text.len() || start >= end {
            continue;
        }
        spans.extend(zone_spans(text, cursor, start));
        spans.push(RawSpan {
            start,
            end,
            opaque: false,
            redacted: true,
        });
        cursor = end;
    }
    spans.extend(zone_spans(text, cursor, text.len()));
    spans
}

/// Steps 2–4 over one redaction-free zone.
fn zone_spans(text: &str, start: usize, end: usize) -> Vec<RawSpan> {
    if start >= end {
        return Vec::new();
    }
    let lines = lines_with_offsets(text, start, end);
    let mut spans: Vec<RawSpan> = Vec::new();
    let mut index = 0usize;
    while index < lines.len() {
        let (line_start, line_end) = lines[index];
        let line = &text[line_start..line_end];

        // 2a. A fenced code block is one opaque sentence. An unclosed
        // fence runs to the end of the zone — deterministic either way.
        if is_fence(line) {
            let mut cursor = index + 1;
            while cursor < lines.len() && !is_fence(&text[lines[cursor].0..lines[cursor].1]) {
                cursor += 1;
            }
            let block_end = lines[cursor.min(lines.len() - 1)].1;
            spans.push(RawSpan {
                start: line_start,
                end: block_end,
                opaque: true,
                redacted: false,
            });
            index = cursor + 1;
            continue;
        }

        // 2b. A run of log-shaped lines is one opaque sentence.
        if is_log_line(line) {
            let mut cursor = index;
            while cursor < lines.len() && is_log_line(&text[lines[cursor].0..lines[cursor].1]) {
                cursor += 1;
            }
            if cursor - index >= MIN_LOG_RUN_LINES {
                spans.push(RawSpan {
                    start: line_start,
                    end: lines[cursor - 1].1,
                    opaque: true,
                    redacted: false,
                });
                index = cursor;
                continue;
            }
        }

        // 3–4. Prose, one line at a time.
        spans.extend(prose_spans(text, line_start, line_end));
        index += 1;
    }

    spans
        .into_iter()
        .filter_map(|span| {
            let (start, end) = trim(text, span.start, span.end);
            (end > start).then_some(RawSpan { start, end, ..span })
        })
        .collect()
}

/// UAX#29 within one line, then trim, drop empties, and merge a
/// short segment into its successor. A trailing short segment has no
/// successor and stays as it is (merging backwards would silently
/// re-attribute the sentence a citation points at).
fn prose_spans(text: &str, start: usize, end: usize) -> Vec<RawSpan> {
    let line = &text[start..end];
    let mut trimmed: Vec<(usize, usize)> = Vec::new();
    for (offset, piece) in line.split_sentence_bound_indices() {
        let (piece_start, piece_end) = trim(text, start + offset, start + offset + piece.len());
        if piece_end > piece_start {
            trimmed.push((piece_start, piece_end));
        }
    }

    let mut merged: Vec<RawSpan> = Vec::new();
    let mut carry: Option<(usize, usize)> = None;
    for (mut piece_start, piece_end) in trimmed {
        if let Some((carried_start, _)) = carry.take() {
            piece_start = carried_start;
        }
        if word_count(&text[piece_start..piece_end]) < MIN_SENTENCE_WORDS {
            carry = Some((piece_start, piece_end));
            continue;
        }
        merged.push(RawSpan {
            start: piece_start,
            end: piece_end,
            opaque: false,
            redacted: false,
        });
    }
    if let Some((carried_start, carried_end)) = carry {
        merged.push(RawSpan {
            start: carried_start,
            end: carried_end,
            opaque: false,
            redacted: false,
        });
    }
    merged
}

fn word_count(text: &str) -> usize {
    text.split_whitespace().count()
}

/// `[(line_start, line_end)]` over `text[start..end]`, newline excluded.
fn lines_with_offsets(text: &str, start: usize, end: usize) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut cursor = start;
    while cursor < end {
        let line_end = text[cursor..end]
            .find('\n')
            .map(|offset| cursor + offset)
            .unwrap_or(end);
        out.push((cursor, line_end));
        cursor = line_end + 1;
    }
    out
}

/// Shrink `[start, end)` past leading and trailing Unicode whitespace.
fn trim(text: &str, start: usize, end: usize) -> (usize, usize) {
    let slice = &text[start..end];
    let leading = slice.len() - slice.trim_start().len();
    let trailing = slice.len() - slice.trim_end().len();
    if leading + trailing >= slice.len() {
        return (start, start);
    }
    (start + leading, end - trailing)
}

fn is_fence(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with("```") || trimmed.starts_with("~~~")
}

/// "Log-shaped" = machine output rather than prose. Closed, versioned
/// list; kept deliberately in step with the eval harness's SEG_H1 so a
/// benchmark unit and a product unit collapse the same runs.
static LOG_SHAPES: Lazy<Vec<Regex>> = Lazy::new(|| {
    [
        r"^\s*[\[(]?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}",
        r"^\s*\d{1,2}:\d{2}:\d{2}",
        r"^\s*[{\[]",
        r#"^\s*"[^"]{1,80}"\s*:"#,
        r"^\s*(/|\./|\.\./|~/)\S+",
        r"^\s*\S+\.(rs|py|ts|tsx|js|jsx|json|toml|yaml|yml|md|log|txt):\d+",
        r"^\s*(at |ERROR|WARN(ING)?|INFO|DEBUG|TRACE|FATAL|PANIC)\b",
        r"^\s*(\+\+\+|---|@@|diff --git)\s",
        r"^\s*\d+\s*[|:]\s",
        r"^\s*(warning|error)(\[[^\]]+\])?:",
        r"^\s*(test|running|Compiling|Finished|Running)\s+\S",
    ]
    .iter()
    .map(|pattern| Regex::new(pattern).expect("SEG_V1 log shape must compile"))
    .collect()
});

fn is_log_line(line: &str) -> bool {
    if line.trim().is_empty() {
        return false;
    }
    LOG_SHAPES.iter().any(|shape| shape.is_match(line))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::adaptive::curator::transcript::{parse_bytes, ParseOutcome};

    const ATLAS_JSONL: &str =
        include_str!("../../../../tests/fixtures/curator/unit_atlas_tuesday/transcript.jsonl");
    const ATLAS_TABLE: &str = include_str!(
        "../../../../tests/fixtures/curator/unit_atlas_tuesday/expected_sentences.json"
    );
    const ATLAS_RENDER: &str =
        include_str!("../../../../tests/fixtures/curator/unit_atlas_tuesday/expected_render.txt");
    /// Recompiles this test when the lockfile moves, which is the point.
    const CARGO_LOCK: &str = include_str!("../../../../Cargo.lock");

    /// A unit built straight from text, bypassing the JSONL layer.
    fn unit(records: &[(SourceRole, &str)]) -> ParseOutcome {
        let jsonl: String = records
            .iter()
            .map(|(role, text)| {
                format!(
                    r#"{{"type":"{}","message":{{"role":"{}","content":{}}}}}"#,
                    role.render_label(),
                    role.render_label(),
                    serde_json::to_string(text).unwrap()
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        parse_bytes(jsonl.as_bytes())
    }

    /// `(sid, record, sentence_index, start, end, cite_ok, opaque, over_cap)`
    type Row = (u32, u32, u32, u32, u32, bool, bool, bool);

    fn rows(table: &SentenceTable) -> Vec<Row> {
        table
            .sentences
            .iter()
            .map(|s| {
                (
                    s.sid,
                    s.record_index,
                    s.sentence_index,
                    s.start_byte,
                    s.end_byte,
                    s.cite_ok,
                    s.opaque_block,
                    s.over_cap,
                )
            })
            .collect()
    }

    fn texts(outcome: &ParseOutcome, table: &SentenceTable) -> Vec<String> {
        table
            .sentences
            .iter()
            .map(|s| {
                resolve(&outcome.records, table, s.sid)
                    .unwrap()
                    .text
                    .to_string()
            })
            .collect()
    }

    // ── the guide §6.3 worked example, fixture-grade ──────────────────

    #[test]
    fn atlas_tuesday_golden_table() {
        let outcome = parse_bytes(ATLAS_JSONL.as_bytes());
        assert_eq!(outcome.records.len(), 2);
        assert_eq!(outcome.skipped_records, 0);

        let table = enumerate(&outcome.records);
        let expected: Vec<Sentence> = serde_json::from_str(ATLAS_TABLE).unwrap();
        assert_eq!(table.sentences, expected);
        assert_eq!(table.segmenter_version, SEGMENTER_VERSION);
        assert_eq!(table.dropped_over_cap, 0);

        // The sentences the server would materialize for a citation.
        assert_eq!(
            texts(&outcome, &table),
            vec![
                "From now on we deploy Atlas only on Tuesdays.",
                "Marketing keeps landing Friday hotfixes and it burned us twice.",
                "Can you update the runbook?",
                "Updated the runbook.",
                "I changed the deploy section to say Tuesday-only and noted the Friday incident history.",
                "The staging cron still runs at 03:30 UTC, so the Tuesday deploy window opens after 04:00.",
            ]
        );
        // S6 keeps 03:30 whole: G06 sees the real clock time, so the
        // model's 03:00 mutation has something to die against.
        assert!(texts(&outcome, &table)[5].contains("03:30 UTC"));
    }

    #[test]
    fn atlas_tuesday_render_v1_is_exact() {
        let outcome = parse_bytes(ATLAS_JSONL.as_bytes());
        let table = enumerate(&outcome.records);
        assert_eq!(render_unit(&outcome.records, &table), ATLAS_RENDER);
    }

    #[test]
    fn replay_is_byte_identical_twice() {
        let outcome = parse_bytes(ATLAS_JSONL.as_bytes());
        let first = enumerate(&outcome.records);
        let second = enumerate(&parse_bytes(ATLAS_JSONL.as_bytes()).records);
        assert_eq!(
            serde_json::to_string(&first).unwrap(),
            serde_json::to_string(&second).unwrap()
        );
        assert_eq!(
            render_unit(&outcome.records, &first),
            render_unit(&outcome.records, &second)
        );
        // And a third pass over a fresh parse of the same bytes.
        let third = parse_bytes(ATLAS_JSONL.as_bytes());
        assert_eq!(enumerate(&third.records), first);
        assert_eq!(render_unit(&third.records, &first), ATLAS_RENDER);
    }

    // ── golden tables for the rest of the corpus (guide §7.2(1)) ──────

    #[test]
    fn golden_table_prose_with_abbreviations_and_decimals() {
        let outcome = unit(&[(
            SourceRole::User,
            "We use PostgreSQL 16.4 in prod, e.g. for the ledger service. Ship it on Tuesday.",
        )]);
        let table = enumerate(&outcome.records);
        assert_eq!(
            rows(&table),
            vec![
                (1, 0, 0, 0, 60, true, false, false),
                (2, 0, 1, 61, 80, true, false, false),
            ]
        );
        assert_eq!(
            texts(&outcome, &table),
            vec![
                "We use PostgreSQL 16.4 in prod, e.g. for the ledger service.",
                "Ship it on Tuesday.",
            ]
        );

        // The abbreviation trap UAX#29 does NOT solve: "Dr." followed by
        // an uppercase word is a boundary under SB11, so the prose pass
        // over-splits — and step 4's short-segment merge repairs it.
        // That is why the merge rule exists, and why removing it would
        // hand the model a citable one-word "sentence".
        let outcome = unit(&[(SourceRole::User, "Dr. Smith owns billing. Bob owns auth.")]);
        let table = enumerate(&outcome.records);
        assert_eq!(
            texts(&outcome, &table),
            vec!["Dr. Smith owns billing.", "Bob owns auth."]
        );
    }

    #[test]
    fn golden_table_short_segments_merge_into_their_successor() {
        let outcome = unit(&[(
            SourceRole::User,
            "Yes. And always run migrations behind a feature flag.",
        )]);
        let table = enumerate(&outcome.records);
        assert_eq!(rows(&table), vec![(1, 0, 0, 0, 53, true, false, false)]);
        assert_eq!(
            texts(&outcome, &table),
            vec!["Yes. And always run migrations behind a feature flag."]
        );

        // A trailing short segment keeps its own ID: there is nothing to
        // merge into, and merging backwards would move the citation.
        let trailing = unit(&[(SourceRole::User, "We ship on Tuesday. Agreed.")]);
        let table = enumerate(&trailing.records);
        assert_eq!(
            texts(&trailing, &table),
            vec!["We ship on Tuesday.", "Agreed."]
        );
    }

    #[test]
    fn golden_table_code_fence_and_log_run_collapse_to_one_id() {
        let outcome = unit(&[(
            SourceRole::Assistant,
            "Here is the config.\n```json\n{\n  \"port\": 5433\n}\n```\nThat is the whole file.",
        )]);
        let table = enumerate(&outcome.records);
        assert_eq!(
            rows(&table),
            vec![
                (1, 0, 0, 0, 19, true, false, false),
                (2, 0, 1, 20, 50, true, true, false),
                (3, 0, 2, 51, 74, true, false, false),
            ]
        );
        assert!(texts(&outcome, &table)[1].contains("\"port\": 5433"));
        // Continuation lines indent by two spaces, header unchanged.
        let rendered = render_sentence(&outcome.records, &table.sentences[1]);
        assert!(rendered.starts_with("S2 [assistant]: ```json"));
        assert!(rendered.contains("\n    \"port\": 5433"));

        let logs = unit(&[(
            SourceRole::Assistant,
            "Run output:\n2026-08-01T10:00:00Z started\n2026-08-01T10:00:01Z step one\n2026-08-01T10:00:02Z done\nAll green.",
        )]);
        let table = enumerate(&logs.records);
        assert_eq!(table.sentences.len(), 3);
        assert!(table.sentences[1].opaque_block);
        assert_eq!(
            texts(&logs, &table)[1].lines().count(),
            3,
            "three log lines, one ID"
        );

        // Two log-shaped lines are under the run threshold: still prose.
        let short_run = unit(&[(
            SourceRole::Assistant,
            "2026-08-01T10:00:00Z started\n2026-08-01T10:00:01Z done",
        )]);
        let table = enumerate(&short_run.records);
        assert!(table.sentences.iter().all(|s| !s.opaque_block));
    }

    #[test]
    fn over_cap_block_keeps_full_offsets_and_renders_truncated() {
        let payload = "x".repeat(3000);
        let line = format!("{{\"payload\": \"{payload}\"}}");
        let outcome = unit(&[(SourceRole::Assistant, &format!("{line}\n{line}\n{line}"))]);
        let table = enumerate(&outcome.records);
        assert_eq!(table.sentences.len(), 1);
        let sentence = &table.sentences[0];
        assert!(sentence.opaque_block && sentence.over_cap);
        // Citable: the gate decides (RequireReview(OversizedEvidence)),
        // the segmenter never silently drops the evidence.
        assert!(sentence.cite_ok);

        let resolved = resolve(&outcome.records, &table, 1).unwrap();
        assert!(resolved.text.len() > OPAQUE_BLOCK_RENDER_CAP_BYTES);
        assert_eq!(resolved.span_sha256.len(), 64);

        let rendered = render_sentence(&outcome.records, sentence);
        let dropped = resolved.text.len() - OPAQUE_BLOCK_RENDER_CAP_BYTES;
        assert!(
            rendered.ends_with(&format!("… [+{dropped} bytes]")),
            "{}",
            &rendered[rendered.len() - 40..]
        );
        assert!(rendered.len() < resolved.text.len());
    }

    #[test]
    fn multibyte_truncation_lands_on_a_char_boundary() {
        // A block of 3-byte characters: 2048 is not a multiple of 3, so
        // the cut must step back rather than split a code point.
        let block = "日".repeat(1000);
        let outcome = unit(&[(SourceRole::Assistant, &format!("```\n{block}\n```"))]);
        let table = enumerate(&outcome.records);
        assert!(table.sentences[0].over_cap);
        let rendered = render_sentence(&outcome.records, &table.sentences[0]);
        assert!(rendered.contains("bytes]"));
        // Rendering is valid UTF-8 by type; the real assertion is that
        // the kept body is a prefix of the source block.
        let resolved = resolve(&outcome.records, &table, 1).unwrap();
        let kept = truncate_on_char_boundary(resolved.text, OPAQUE_BLOCK_RENDER_CAP_BYTES);
        assert!(resolved.text.starts_with(kept.0));
        assert!(kept.0.len() <= OPAQUE_BLOCK_RENDER_CAP_BYTES);
        assert_eq!(kept.0.len() + kept.1, resolved.text.len());
    }

    #[test]
    fn redaction_is_a_hard_segmentation_boundary() {
        let outcome = unit(&[(
            SourceRole::User,
            "The deploy key is AKIAIOSFODNN7EXAMPLE and we rotate it monthly.",
        )]);
        let record = &outcome.records[0];
        assert_eq!(record.redactions.len(), 1);
        let table = enumerate(&outcome.records);

        let placeholder = table
            .sentences
            .iter()
            .find(|s| !s.cite_ok)
            .expect("the placeholder is enumerated as its own sentence");
        assert_eq!(
            resolve(&outcome.records, &table, placeholder.sid)
                .unwrap()
                .text,
            "[REDACTED:aws_access_key_id]"
        );
        // No other sentence may contain bytes from both sides of it.
        for sentence in &table.sentences {
            if sentence.sid == placeholder.sid {
                continue;
            }
            assert!(
                sentence.end_byte <= placeholder.start_byte
                    || sentence.start_byte >= placeholder.end_byte,
                "sentence {} straddles the redaction",
                sentence.sid
            );
            assert!(sentence.cite_ok);
        }
        // Context is still readable: the model sees the placeholder line.
        assert!(render_unit(&outcome.records, &table).contains("[REDACTED:aws_access_key_id]"));
    }

    #[test]
    fn emoji_cjk_and_nbsp_offsets_stay_on_char_boundaries() {
        let outcome = unit(&[
            (
                SourceRole::User,
                "Ship 🧠 on Tuesday.\u{a0}Never on Friday. これはテストです。次の文です。",
            ),
            (
                SourceRole::Assistant,
                "cafe\u{301} au lait is fine.  Two spaces before this one.",
            ),
        ]);
        let table = enumerate(&outcome.records);
        for sentence in &table.sentences {
            let record = &outcome.records[sentence.record_index as usize];
            assert!(
                record
                    .sanitized
                    .is_char_boundary(sentence.start_byte as usize)
                    && record
                        .sanitized
                        .is_char_boundary(sentence.end_byte as usize),
                "sentence {} is not on a char boundary",
                sentence.sid
            );
            let text = resolve(&outcome.records, &table, sentence.sid)
                .unwrap()
                .text;
            assert!(!text.is_empty());
            assert_eq!(text.trim(), text, "offsets must be a trimmed extent");
            assert!(record.sanitized.contains(text));
        }
        // The rendering never loses a byte of a sentence it prints.
        let rendered = render_unit(&outcome.records, &table);
        for sentence in &table.sentences {
            assert!(rendered.contains(
                resolve(&outcome.records, &table, sentence.sid)
                    .unwrap()
                    .text
            ));
        }
    }

    #[test]
    fn ids_are_contiguous_across_records_and_indices_restart_per_record() {
        let outcome = unit(&[
            (SourceRole::User, "One sentence here. Two sentences here."),
            (SourceRole::Assistant, "Three sentences here."),
            (
                SourceRole::User,
                "Four sentences here. Five sentences here.",
            ),
        ]);
        let table = enumerate(&outcome.records);
        assert_eq!(
            table
                .sentences
                .iter()
                .map(|s| (s.sid, s.record_index, s.sentence_index))
                .collect::<Vec<_>>(),
            vec![(1, 0, 0), (2, 0, 1), (3, 1, 0), (4, 2, 0), (5, 2, 1),]
        );
    }

    #[test]
    fn units_split_at_record_boundaries_before_the_cap_bites() {
        let long_record = (0..80)
            .map(|index| format!("Sentence number {index} of this record."))
            .collect::<Vec<_>>()
            .join(" ");
        let outcome = unit(&[
            (SourceRole::User, &long_record),
            (SourceRole::Assistant, &long_record),
            (SourceRole::User, &long_record),
        ]);
        let units = split_units(&outcome.records);
        assert_eq!(units, vec![0..1, 1..2, 2..3]);
        for unit_range in units {
            let table = enumerate(&outcome.records[unit_range]);
            assert_eq!(table.sentences.len(), 80);
            assert_eq!(table.dropped_over_cap, 0);
            assert_eq!(table.sentences[0].sid, 1, "IDs restart per unit");
        }

        // One record over the cap on its own: nothing to split at, so the
        // drop is recorded rather than hidden.
        let huge = (0..200)
            .map(|index| format!("Sentence number {index} of this record."))
            .collect::<Vec<_>>()
            .join(" ");
        let outcome = unit(&[(SourceRole::User, &huge)]);
        let table = enumerate(&outcome.records);
        assert_eq!(table.sentences.len(), MAX_SENTENCES_PER_UNIT);
        assert_eq!(table.dropped_over_cap, 50);
        assert_eq!(table.sentences.last().unwrap().sid, 150);
    }

    #[test]
    fn resolve_is_a_table_lookup_and_refuses_unknown_ids() {
        let outcome = parse_bytes(ATLAS_JSONL.as_bytes());
        let table = enumerate(&outcome.records);
        assert!(resolve(&outcome.records, &table, 0).is_none());
        assert!(resolve(&outcome.records, &table, 7).is_none());
        assert!(resolve(&outcome.records, &table, 9999).is_none());

        let resolved = resolve(&outcome.records, &table, 1).unwrap();
        assert_eq!(resolved.sentence.sid, 1);
        assert_eq!(
            resolved.span_sha256,
            sha256_hex("From now on we deploy Atlas only on Tuesdays.".as_bytes())
        );
        // Same sid, same bytes, same digest — across calls and tables.
        assert_eq!(
            resolve(&outcome.records, &enumerate(&outcome.records), 1)
                .unwrap()
                .span_sha256,
            resolved.span_sha256
        );

        // A corrupt extent resolves to nothing rather than to mangled text.
        let mut broken = table.clone();
        broken.sentences[0].end_byte = 1_000;
        assert!(resolve(&outcome.records, &broken, 1).is_none());
        assert_eq!(
            render_sentence(&outcome.records, &broken.sentences[0]),
            "S1 [user]: "
        );
    }

    #[test]
    fn an_empty_unit_enumerates_to_an_empty_table() {
        let table = enumerate(&[]);
        assert!(table.sentences.is_empty());
        assert_eq!(render_unit(&[], &table), "");
        assert!(split_units(&[]).is_empty());
    }

    #[test]
    fn segmenter_version_pins_the_crate_and_unicode_data_version() {
        assert_eq!(SEGMENTER_VERSION, 1);
        assert_eq!(
            unicode_segmentation::UNICODE_VERSION,
            UNICODE_DATA_VERSION,
            "Unicode data moved: bump SEGMENTER_VERSION + IDENTITY_VERSION and re-gold the tables"
        );

        let locked = CARGO_LOCK
            .split("[[package]]")
            .find(|block| block.contains("name = \"unicode-segmentation\""))
            .and_then(|block| {
                block
                    .lines()
                    .find_map(|line| line.trim().strip_prefix("version = "))
            })
            .map(|version| version.trim_matches('"').to_string())
            .expect("unicode-segmentation must be locked");
        assert_eq!(
            locked, UNICODE_SEGMENTATION_CRATE_VERSION,
            "segmenter crate moved without a SEGMENTER_VERSION bump"
        );
    }
}
