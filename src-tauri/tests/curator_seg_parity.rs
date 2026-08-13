//! `SEG_H1 ↔ SEG_V1` — one fixture, both segmenters, both tables pinned.
//!
//! WHY THIS EXISTS
//! ---------------
//! The gold re-annotation ran under the **eval harness** segmenter
//! (`eval/curator/sid.py`, `SEGMENTER_HARNESS_VERSION = 1`). The product
//! ships a different implementation, the Rust `SEG_V1`
//! (`segment.rs::SEGMENTER_VERSION = 1`). Sentence IDs in `gold_sid/`
//! are therefore only comparable to a Rust run's IDs *where the two
//! agree*, and until this file existed **no fixture pinned them
//! together** — which made every SID-level number in the benchmark an
//! unverified cross-implementation comparison. MANIFEST-V1.md carries
//! that as a standing caveat; the acceptance walk carries it as the last
//! of its standing flags.
//!
//! This is the fixture it asks for. `tests/fixtures/curator/seg_parity/`
//! holds ONE conversation in the two input shapes the two segmenters
//! actually take — `transcript.jsonl` (host JSONL, what PARSER_V1 reads)
//! and `unit.txt` (the flat `USER:`/`ASSISTANT:` framing `build_units.py`
//! writes) — over the **same sanitized bytes**, plus both output tables
//! as committed goldens. This test owns the Rust half; Wave 4b-E's
//! Python test pins `expected_seg_h1.json` from the other side.
//!
//! WHAT IT BUYS
//! ------------
//! Drift on either side now breaks a visible fixture instead of quietly
//! re-pointing the gold set's citations:
//!
//! * a SEG_V1 rule change fails [`seg_v1_table_is_pinned`] /
//!   [`seg_v1_render_is_pinned`];
//! * a SEG_H1 rule change fails Wave 4b-E's test against the same
//!   fixture's `expected_seg_h1.json`;
//! * a change that makes the two **agree or diverge differently** fails
//!   [`the_documented_divergences_are_exactly_these`], which pins the
//!   divergences themselves.
//!
//! That last one is the point. The divergences are not bugs to be fixed
//! in this wave — they are the mapping rule the benchmark owes itself,
//! and they belong written down and asserted rather than rediscovered by
//! the next person who wonders why `S4` means two different things.
//! `README.md` in the fixture directory is the prose copy.

use std::path::{Path, PathBuf};

use neurovault_lib::memory::adaptive::curator::segment::{self, SentenceTable};
use neurovault_lib::memory::adaptive::curator::transcript::{self, ParsedRecord, SourceRole};

use serde::Deserialize;

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/curator/seg_parity")
}

fn read(name: &str) -> String {
    let path = fixture_dir().join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// PARSER_V1 + REDACT_V1 + SEG_V1 over the committed transcript bytes.
fn seg_v1() -> (Vec<ParsedRecord>, SentenceTable) {
    let outcome = transcript::parse_bytes(read("transcript.jsonl").as_bytes());
    let table = segment::enumerate(&outcome.records);
    (outcome.records, table)
}

// =====================================================================
// the SEG_H1 golden, as the Python harness emits it
// =====================================================================

/// One `sid.py` sentence. `deny_unknown_fields` so a harness schema
/// change cannot be absorbed silently on this side.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct HarnessSentence {
    sid: u32,
    record_index: u32,
    sentence_index: u32,
    /// **Character** offsets into the whole `unit.txt` — not bytes, and
    /// not record-relative. See [`the_documented_divergences_are_exactly_these`].
    start: usize,
    end: usize,
    role: String,
    /// SEG_H1 infers a leading role when the unit opens without a
    /// marker; PARSER_V1 has host structure and never guesses.
    role_inferred: bool,
    cite_ok: bool,
    opaque_block: bool,
    over_cap: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct HarnessTable {
    segmenter_harness_version: u32,
    n_records: usize,
    dropped_over_cap: u32,
    sentences: Vec<HarnessSentence>,
    /// `sid -> the exact text SEG_H1 would materialize`. Committed so
    /// this side can compare *content* without re-implementing the
    /// harness's character-offset arithmetic.
    materialized: std::collections::BTreeMap<String, String>,
}

fn seg_h1() -> HarnessTable {
    serde_json::from_str(&read("expected_seg_h1.json")).expect("the SEG_H1 golden decodes")
}

// =====================================================================
// 1. the Rust half — both goldens pinned
// =====================================================================

/// The SEG_V1 table, byte for byte. Regenerate deliberately or not at
/// all: this table is what `SpanIdentity` is built from, so a silent
/// change here re-points every stored citation.
#[test]
fn seg_v1_table_is_pinned() {
    let (_records, table) = seg_v1();
    let got = serde_json::to_string_pretty(&table).expect("table serializes") + "\n";
    let expected = read("expected_seg_v1.json");
    assert_eq!(
        got.trim_end(),
        expected.trim_end(),
        "SEG_V1 drifted. If this is intentional, bump SEGMENTER_VERSION \
         (and IDENTITY_VERSION with it) and rewrite the golden:\n{got}"
    );
}

/// RENDER_V1 over the same table — the exact bytes a model would see.
#[test]
fn seg_v1_render_is_pinned() {
    let (records, table) = seg_v1();
    let got = segment::render_unit(&records, &table);
    assert_eq!(got.trim_end(), read("expected_render.txt").trim_end());
}

/// The premise the whole fixture rests on: the two inputs are two
/// framings of **one** conversation. Every record's sanitized text —
/// post-REDACT_V1, exactly what SEG_V1 segments — appears verbatim
/// inside `unit.txt`, which is what SEG_H1 segments. Without this the
/// two tables below would just be two tables over two documents.
#[test]
fn both_segmenters_see_the_same_sanitized_bytes() {
    let (records, _table) = seg_v1();
    let unit_text = read("unit.txt");
    assert_eq!(records.len(), 2, "one user turn, one assistant turn");
    for record in &records {
        assert!(
            unit_text.contains(record.sanitized.as_str()),
            "record {} (role {:?}) is not present verbatim in unit.txt — \
             the fixture's two halves have drifted apart",
            record.record_index,
            record.role
        );
    }
    // And the redaction really happened on the Rust side rather than
    // being pre-baked into the fixture: the raw transcript carries the
    // credential, the sanitized text carries only the placeholder.
    let raw = read("transcript.jsonl");
    assert!(raw.contains("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"));
    for record in &records {
        assert!(!record.sanitized.contains("ghp_ABCDEFG"));
    }
    assert!(records[0].sanitized.contains("[REDACTED:api_token]"));
    assert!(!unit_text.contains("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"));
}

// =====================================================================
// 2. the divergences, pinned from both ends
// =====================================================================

/// Where the two implementations disagree, stated as assertions.
///
/// Each block below is one row of the fixture README. A change that
/// makes a row stop being true — in either direction — fails here, which
/// is the only way "the mapping rule between SEG_H1 and SEG_V1" stays a
/// fact instead of a memory.
#[test]
fn the_documented_divergences_are_exactly_these() {
    let (records, v1) = seg_v1();
    let h1 = seg_h1();
    assert_eq!(v1.segmenter_version, 1);
    assert_eq!(h1.segmenter_harness_version, 1);

    // ── 1. SENTENCE COUNT: the redaction rule differs ────────────────
    //
    // SEG_V1 treats a redaction range as a HARD boundary: the
    // placeholder is enumerated as its own sentence with cite_ok=false,
    // and the prose either side of it stays citable. SEG_H1 has no
    // redactor — it consumes text `build_units.py` already redacted and
    // marks any sentence *containing* the marker uncitable. So one
    // credential costs SEG_V1 three sentences where it costs SEG_H1 one,
    // and SEG_V1 keeps two citable fragments SEG_H1 throws away.
    let v1_uncitable: Vec<u32> = v1
        .sentences
        .iter()
        .filter(|s| !s.cite_ok)
        .map(|s| s.sid)
        .collect();
    let h1_uncitable: Vec<u32> = h1
        .sentences
        .iter()
        .filter(|s| !s.cite_ok)
        .map(|s| s.sid)
        .collect();
    assert_eq!(v1_uncitable.len(), 1, "one placeholder, one uncitable ID");
    assert_eq!(h1_uncitable.len(), 1);
    let v1_placeholder = v1
        .sentences
        .iter()
        .find(|s| !s.cite_ok)
        .expect("SEG_V1 uncitable");
    let v1_placeholder_text = segment::resolve(&records, &v1, v1_placeholder.sid)
        .expect("resolves")
        .text;
    assert_eq!(
        v1_placeholder_text, "[REDACTED:api_token]",
        "SEG_V1's uncitable sentence is the placeholder ALONE"
    );
    let h1_placeholder_text = &h1.materialized[&h1_uncitable[0].to_string()];
    assert!(
        h1_placeholder_text.contains("[REDACTED:api_token]")
            && h1_placeholder_text.len() > "[REDACTED:api_token]".len(),
        "SEG_H1's uncitable sentence is the whole SENTENCE around the \
         placeholder, not the placeholder: {h1_placeholder_text:?}"
    );

    // ── 2. CJK: THE TWO SIDES AGREE BY ACCIDENT ──────────────────────
    //
    // The interesting one, and not what you would predict. SEG_V1 uses
    // UAX#29, which *does* break at U+3002 IDEOGRAPHIC FULL STOP;
    // SEG_H1's boundary regex is `[.!?]+["')\]]*[ \t]+`, ASCII
    // terminators followed by ASCII space, which never breaks there. So
    // the two should disagree — and they do not. Both emit ONE sentence
    // for the two Japanese sentences.
    //
    // The reason is SEG_V1's short-segment merge: `word_count` is
    // `split_whitespace().count()`, Japanese is written without spaces,
    // so each half counts as ONE word, falls under MIN_SENTENCE_WORDS,
    // and is merged forward into the next. SEG_V1 splits the line and
    // then immediately un-splits it.
    //
    // That makes the agreement a coincidence of two unrelated rules
    // rather than a contract, and it is worth pinning precisely because
    // it is fragile: raising MIN_SENTENCE_WORDS, or making `word_count`
    // script-aware (the correct fix — the merge rule exists to repair
    // UAX#29's over-splitting on English abbreviations and has no
    // business firing on CJK), breaks the agreement on the Rust side
    // ALONE and silently re-points every Japanese sentence ID.
    let v1_cjk: Vec<&str> = v1
        .sentences
        .iter()
        .filter_map(|s| segment::resolve(&records, &v1, s.sid))
        .map(|r| r.text)
        .filter(|t| t.contains('。'))
        .collect();
    let h1_cjk: Vec<&String> = h1
        .materialized
        .values()
        .filter(|t| t.contains('。'))
        .collect();
    assert_eq!(v1_cjk.len(), 1, "SEG_V1 re-merges the CJK line: {v1_cjk:?}");
    assert_eq!(h1_cjk.len(), 1, "SEG_H1 never split it: {h1_cjk:?}");
    assert_eq!(
        v1_cjk[0].matches('。').count(),
        2,
        "one SEG_V1 ID covering two Japanese sentences"
    );
    // The mechanism, asserted rather than asserted-in-prose.
    assert_eq!(segment::MIN_SENTENCE_WORDS, 3);
    for half in ["締め切りは火曜日です。", "よろしくお願いします。"] {
        assert!(
            half.split_whitespace().count() < segment::MIN_SENTENCE_WORDS,
            "the merge fires because whitespace word-counting reads {half:?} as one word"
        );
    }
    // And SEG_V1 *does* split multiple sentences inside one line when
    // they are whitespace-delimited — so the CJK result above is the
    // merge rule, not a missing terminator.
    assert_eq!(
        v1.sentences
            .iter()
            .filter(|s| s.record_index == 0 && s.sid <= 3)
            .count(),
        3,
        "three ASCII sentences on one line become three IDs"
    );

    // ── 3. THE SHORT-SEGMENT REPAIR: AGREEMENT, DIFFERENT MECHANISM ──
    //
    // SEG_V1 merges a segment of fewer than MIN_SENTENCE_WORDS words
    // FORWARD into its successor, because UAX#29 over-splits on
    // abbreviations and initials. SEG_H1 instead carries a closed
    // abbreviation list and never merges at all. Two different repairs
    // for the same problem, landing on the same answer here — which is
    // what makes a mapping possible on English prose and is exactly why
    // it cannot be assumed on anything else (see divergence 2).
    let v1_texts: Vec<&str> = v1
        .sentences
        .iter()
        .filter_map(|s| segment::resolve(&records, &v1, s.sid))
        .map(|r| r.text)
        .collect();
    assert!(
        !v1_texts.contains(&"Understood."),
        "SEG_V1 must not emit a sub-MIN_SENTENCE_WORDS segment that has a successor"
    );
    assert!(v1_texts.contains(&"Understood. The patch is below."));
    assert!(h1
        .materialized
        .values()
        .any(|t| t == "Understood. The patch is below."));
    // The exception that proves the rule: a short *trailing* segment has
    // no successor, so SEG_V1 emits it alone rather than merging
    // backwards — merging backwards would re-attribute the sentence a
    // citation points at. "for staging." is that case, and it exists
    // only on the Rust side because only the Rust side split the
    // redaction out of the middle of it.
    assert!(v1_texts.contains(&"for staging."));

    // ── 4. ABBREVIATIONS AND DECIMALS SURVIVE ON BOTH ────────────────
    //
    // The one place the two DO agree, and worth pinning because it is
    // what makes any mapping possible at all: `i.e.`, `Dr.`, `1.5` and
    // `2.0` never open a new sentence on either side.
    for fragment in ["i.e. after the nightly cron", "1.5 s, not 2.0 s"] {
        assert!(
            v1.sentences
                .iter()
                .filter_map(|s| segment::resolve(&records, &v1, s.sid))
                .any(|r| r.text.contains(fragment)),
            "SEG_V1 split inside {fragment:?}"
        );
        assert!(
            h1.materialized.values().any(|t| t.contains(fragment)),
            "SEG_H1 split inside {fragment:?}"
        );
    }
    // `Dr. Nakamura` is the abbreviation case proper: SEG_V1 reaches it
    // by the merge rule, SEG_H1 by its abbreviation list, and both end
    // up with the name attached to the honorific.
    for table_has in [
        v1.sentences
            .iter()
            .filter_map(|s| segment::resolve(&records, &v1, s.sid))
            .any(|r| r.text.contains("Dr. Nakamura approved it.")),
        h1.materialized
            .values()
            .any(|t| t.contains("Dr. Nakamura approved it.")),
    ] {
        assert!(table_has, "an honorific opened a sentence");
    }

    // ── 5. OPAQUE BLOCKS AGREE ───────────────────────────────────────
    //
    // The fence rule and the ≥3-log-line rule are deliberately kept in
    // step (segment.rs says so in a comment). Both sides collapse the
    // Rust fence to one ID and the three ISO-stamped lines to one ID.
    assert_eq!(
        v1.sentences.iter().filter(|s| s.opaque_block).count(),
        2,
        "SEG_V1: one fence + one log run"
    );
    assert_eq!(
        h1.sentences.iter().filter(|s| s.opaque_block).count(),
        2,
        "SEG_H1: one fence + one log run"
    );
    assert!(v1.sentences.iter().all(|s| !s.over_cap));
    assert!(h1.sentences.iter().all(|s| !s.over_cap));

    // ── 6. ROLE VOCABULARY ───────────────────────────────────────────
    //
    // SEG_V1's role is a two-valued enum derived from host structure.
    // SEG_H1's is a free string over four values (user / assistant /
    // tool / system) plus a `role_inferred` flag for a unit that opens
    // without a marker. The nine TOOL_RESULT gold items are unreachable
    // under PARSER_V1 for exactly this reason, and they are ungradable
    // for `source_role` besides — the output schema offers two roles, so
    // there is no right answer to grade a tool-sourced claim against.
    assert!(v1
        .sentences
        .iter()
        .all(|s| matches!(s.role, SourceRole::User | SourceRole::Assistant)));
    assert!(h1.sentences.iter().all(|s| !s.role_inferred));
    assert!(h1
        .sentences
        .iter()
        .all(|s| s.role == "user" || s.role == "assistant"));

    // ── 7. OFFSET BASIS ──────────────────────────────────────────────
    //
    // SEG_V1: BYTE offsets into ONE record's `sanitized` string, so they
    // restart per record. SEG_H1: CHARACTER offsets into the WHOLE
    // `unit.txt`, so they are globally monotonic and count the
    // `USER: `/`ASSISTANT: ` markers. The two coordinate systems are not
    // convertible without the record table — which is the concrete
    // reason a gold_sid offset must never be compared to a receipt span.
    assert_eq!(records.len(), h1.n_records);
    let second_record_first = v1
        .sentences
        .iter()
        .find(|s| s.record_index == 1)
        .expect("assistant record enumerated");
    assert_eq!(
        second_record_first.start_byte, 0,
        "SEG_V1 offsets restart at 0 for each record"
    );
    let h1_second_record_first = h1
        .sentences
        .iter()
        .find(|s| s.record_index == 1)
        .expect("assistant record enumerated");
    assert!(
        h1_second_record_first.start > 0,
        "SEG_H1 offsets are global to the unit text"
    );
    assert_eq!(
        h1_second_record_first.sentence_index, 0,
        "sentence_index restarts per record on BOTH sides — the one \
         coordinate the two tables share"
    );
    assert!(h1.sentences.iter().all(|s| s.end > s.start));
    // Non-ASCII proves the units differ too: the CJK line makes byte and
    // character offsets diverge for everything after it.
    let unit_text = read("unit.txt");
    assert!(
        unit_text.chars().count() < unit_text.len(),
        "the fixture must contain multi-byte text for this to mean anything"
    );

    // ── 8. THE CAP ───────────────────────────────────────────────────
    //
    // SEG_V1 caps a unit at MAX_SENTENCES_PER_UNIT and `split_units`
    // divides the overflow at record boundaries. SEG_H1's default is
    // UNCAPPED (`DEFAULT_MAX_SENTENCES = 0`) so a benchmark unit is never
    // silently shortened relative to the anchor baseline. This fixture
    // is far under either, so the flag is what is pinned, not a count.
    assert_eq!(v1.dropped_over_cap, 0);
    assert_eq!(h1.dropped_over_cap, 0);

    // ── 9. RENDERING ─────────────────────────────────────────────────
    //
    // RENDER_V1 exists only on the product side. `sid.py` ships no
    // renderer: the harness prompt is built by `run_bench.py` from the
    // unit text directly. So there is no "expected_render" to compare
    // across the two, and a prompt-shape comparison between a benchmark
    // run and a product run is a comparison of two different documents.
    let render = segment::render_unit(&records, &v1);
    assert!(render.starts_with("S1 [user]: "));
    let headers = render
        .lines()
        .filter(|line| line.starts_with('S') && line.contains("]: ") && !line.starts_with("S  "))
        .count();
    assert_eq!(
        headers,
        v1.sentences.len(),
        "RENDER_V1 opens exactly one `S{{n}} [role]: ` entry per sentence"
    );
    // An opaque block is one entry over several LINES — continuation
    // lines are indented by two spaces so the model can still tell where
    // the citable unit begins and ends.
    assert!(render.lines().count() > v1.sentences.len());
    assert!(render.contains("\n  fn main() {"));
}

/// The headline number, on its own so a failure reads plainly: the two
/// segmenters do **not** produce the same table for the same
/// conversation, and this is by how much.
#[test]
fn the_two_tables_do_not_agree_and_the_gap_is_pinned() {
    let (_records, v1) = seg_v1();
    let h1 = seg_h1();
    assert_eq!(v1.sentences.len(), 12, "SEG_V1 sentence count");
    assert_eq!(h1.sentences.len(), 10, "SEG_H1 sentence count");
    assert_ne!(
        v1.sentences.len(),
        h1.sentences.len(),
        "if these ever agree, the mapping caveat in MANIFEST-V1.md and the \
         acceptance walk's last standing flag can be retired — but that is a \
         decision, not something to discover by this assertion flipping"
    );
}
