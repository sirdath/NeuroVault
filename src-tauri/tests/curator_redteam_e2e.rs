//! The red-team corpus, end to end — implementation guide §7.1 made
//! executable.
//!
//! WHY THIS EXISTS
//! ---------------
//! `gates.rs`, `provider.rs` and `runner.rs` each carry hand-authored
//! unit tests for the attack families they own. Those tests prove the
//! *modules* behave; none of them proves that the **committed corpus**
//! — `tests/fixtures/curator/redteam/manifest.jsonl`, 37 cases over the
//! spec's 20 required families — is what the shipped pipeline actually
//! does. A fixture nobody executes is documentation, and the V1
//! acceptance bar asks for regression fixtures, not prose.
//!
//! So: one test binary that reads the manifest at run time and walks
//! **every line** through the real pipeline — real `PARSER_V1` +
//! `REDACT_V1` over the fixture's own transcript bytes, real `SEG_V1`
//! enumeration, real gauntlet, real provider decode against a mock
//! Ollama, real runner for the two cases that only exist end to end.
//! Nothing is stubbed and no expectation is hard-coded here: the
//! manifest's `expected.{gate,effect,code,disposition}` is the oracle,
//! and a failure names the case id.
//!
//! THE COVERAGE INVARIANT
//! ----------------------
//! [`every_manifest_line_is_claimed`] asserts that the union of the
//! cases this file drives equals the manifest, line for line. A new
//! fixture added to the corpus fails that test until a driver claims
//! it, so the corpus can never quietly outgrow its coverage.
//!
//! INJECTION POINTS
//! ----------------
//! The manifest's `injection_point` says where a case enters:
//!
//! | value | driver |
//! |---|---|
//! | *(absent)* / `wire` | envelope bytes → [`gates::verify_envelope`] |
//! | `post_g00` | hand-built [`Candidate`] → [`gates::verify_candidate`] |
//! | `provider` | mock Ollama → [`provider::ProviderSession::chat_unit`] |
//! | `runner` | the full `run_brain` crash/replay path |
//!
//! Families 14 and 19 carry no candidate at all: they are refused
//! *before* the gauntlet (a mutated transcript prefix, and curator
//! output fed back as evidence), so their drivers assert the pre-gate.
//!
//! ISOLATION
//! ---------
//! Integration tests are their own process, so the crate's
//! `TEST_HOME_LOCK` is neither reachable nor needed. [`HOME_LOCK`] is
//! this binary's equivalent: every test that redirects `NEUROVAULT_HOME`
//! holds it.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use serde::Deserialize;

use neurovault_lib::memory::adaptive::curator::gates::{
    self, AllowedObject, Candidate, Disposition, ExistingState, UnitContext, VerificationContext,
    VerificationOutcome,
};
use neurovault_lib::memory::adaptive::curator::receipts::{GateOutcome, GateRecord};
use neurovault_lib::memory::adaptive::curator::state::NoProposalReason;
use neurovault_lib::memory::adaptive::curator::transcript::ParsedRecord;
use neurovault_lib::memory::adaptive::curator::{
    lineage, policy, prompt, provider, runner, segment, state, transcript,
};
use neurovault_lib::memory::journal::Event;

// =====================================================================
// the manifest
// =====================================================================

const BRAIN: &str = "RedteamBrain";

/// One `manifest.jsonl` line. Field-for-field with the committed corpus;
/// unknown keys are refused so a manifest edit cannot be silently
/// ignored by this reader.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    family: u32,
    name: String,
    dir: String,
    #[allow(dead_code)]
    spec_family: String,
    transcript: String,
    candidate: Option<String>,
    expected: ExpectedOutcome,
    /// Absent = the ordinary envelope path.
    injection_point: Option<String>,
    /// Which proposal of a multi-candidate envelope this line is about.
    proposal_index: Option<usize>,
    existing_state: Option<String>,
    mutation: Option<String>,
    provider_error: Option<String>,
    expected_units: Option<usize>,
    expected_reasons: Option<BTreeMap<String, String>>,
    synthesize: Option<serde_json::Value>,
    #[allow(dead_code)]
    note: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExpectedOutcome {
    gate: String,
    effect: String,
    code: Option<String>,
    disposition: String,
    terminal: bool,
}

impl Case {
    /// `f08/literal_mutation_clock` — what a failure names.
    fn id(&self) -> String {
        format!("f{:02}/{}", self.family, self.name)
    }

    fn injection(&self) -> &str {
        self.injection_point.as_deref().unwrap_or("wire")
    }

    fn dir_path(&self) -> PathBuf {
        corpus_dir().join(&self.dir)
    }

    fn read(&self, file: &str) -> Vec<u8> {
        let path = self.dir_path().join(file);
        std::fs::read(&path)
            .unwrap_or_else(|e| panic!("{}: read {}: {e}", self.id(), path.display()))
    }

    fn transcript_bytes(&self) -> Vec<u8> {
        self.read(&self.transcript)
    }

    fn candidate_bytes(&self) -> Vec<u8> {
        let file = self
            .candidate
            .as_deref()
            .unwrap_or_else(|| panic!("{}: this case has no candidate file", self.id()));
        self.read(file)
    }
}

fn corpus_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/curator/redteam")
}

fn manifest() -> &'static [Case] {
    static CASES: OnceLock<Vec<Case>> = OnceLock::new();
    CASES.get_or_init(|| {
        let raw = std::fs::read_to_string(corpus_dir().join("manifest.jsonl"))
            .expect("the red-team manifest is committed");
        raw.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| {
                serde_json::from_str::<Case>(l).unwrap_or_else(|e| panic!("manifest line {l}: {e}"))
            })
            .collect()
    })
}

fn case(name: &str) -> &'static Case {
    manifest()
        .iter()
        .find(|c| c.name == name)
        .unwrap_or_else(|| panic!("no manifest case named {name}"))
}

// =====================================================================
// the fixture unit: real bytes → PARSER_V1 → SEG_V1
// =====================================================================

/// A unit assembled exactly the way the runner assembles one, from the
/// fixture's own transcript bytes. Nothing is stubbed, so a Wave-1
/// regression surfaces here as a corpus failure rather than as silence.
struct Unit {
    records: Vec<ParsedRecord>,
    table: segment::SentenceTable,
    ctx: UnitContext,
    existing: ExistingState,
    object: AllowedObject,
    actions: Vec<&'static str>,
}

impl Unit {
    fn from_case(c: &Case) -> Self {
        let outcome = transcript::parse_bytes(&c.transcript_bytes());
        let table = segment::enumerate(&outcome.records);
        let mut ctx = UnitContext::new(&format!("ev_ctx_{}", c.name), BRAIN);
        ctx.evidence_event_id = format!("ev_stop_{}", c.name);
        ctx.transcript_prefix_sha256 = "0011223344556677".to_string();
        ctx.observed_prefix_len = c.transcript_bytes().len() as u64;
        Unit {
            records: outcome.records,
            table,
            ctx,
            existing: ExistingState::default(),
            object: AllowedObject::new(BRAIN),
            actions: policy::CURATOR_ACTIONS.to_vec(),
        }
    }

    fn context(&self) -> VerificationContext<'_> {
        VerificationContext {
            unit: &self.ctx,
            records: &self.records,
            table: &self.table,
            existing: &self.existing,
            allowed_actions: &self.actions,
            allowed_object: &self.object,
            nli_configured: false,
        }
    }

    /// The RENDER_V1 text the model would have seen. Pinning it against
    /// each fixture's `expected_render.txt` is what makes the sentence
    /// IDs in the candidates mean anything at all.
    fn render(&self) -> String {
        segment::render_unit(&self.records, &self.table)
    }

    /// The full user message a run would send, template and all.
    fn user_message(&self) -> String {
        prompt::render_user_message(&self.records, &self.table)
    }
}

// =====================================================================
// assertions against the manifest's oracle
// =====================================================================

fn outcome_of(effect: &str) -> GateOutcome {
    match effect {
        "pass" => GateOutcome::Pass,
        "not_run" => GateOutcome::NotRun,
        "no_op" => GateOutcome::NoOp,
        "reject" => GateOutcome::Reject,
        "defer" => GateOutcome::Defer,
        "require_review" => GateOutcome::RequireReview,
        other => panic!("manifest effect {other:?} is not a GateOutcome"),
    }
}

fn disposition_of(name: &str) -> Disposition {
    match name {
        "rejected" => Disposition::Rejected,
        "deferred" => Disposition::Deferred,
        "no_op" => Disposition::NoOp,
        "review_required" => Disposition::ReviewRequired,
        "proposal_ready" => Disposition::ProposalReady,
        other => panic!("manifest disposition {other:?} is not a Disposition"),
    }
}

fn trail(outcome: &VerificationOutcome) -> Vec<String> {
    outcome
        .records
        .iter()
        .map(|r| match &r.code {
            Some(code) => format!("{}={:?}({code})", r.gate, r.effect),
            None => format!("{}={:?}", r.gate, r.effect),
        })
        .collect()
}

// ---------------------------------------------------------------------
// known divergences — where the corpus and the gauntlet disagree
// (currently nowhere; the mechanism is kept, see below)
// ---------------------------------------------------------------------

/// One case where the shipped gauntlet does **not** produce the
/// manifest's `(gate, effect, code)` triple.
struct Divergence {
    case: &'static str,
    /// What the pipeline actually does.
    gate: &'static str,
    effect: &'static str,
    code: Option<&'static str>,
    /// `None` when the manifest's disposition still holds.
    disposition: Option<&'static str>,
    why: &'static str,
}

/// **Empty, as of Wave 4c.** Every line of the committed corpus now
/// exact-matches the shipped gauntlet: same gate, same effect, same
/// code, same disposition, same terminality.
///
/// The mechanism stays. Wave 4a found five disagreements between the
/// corpus and the gauntlet and pinned them here rather than quietly
/// editing either side; the spec owner then ruled on all five, and
/// Wave 4c applied the rulings — two gate changes (G04 correlates on
/// acronyms; G08 reads a comparison as review, not as a polarity flip),
/// one fixture rewrite (family 3's Primary sentence, whose protected
/// token was sentence-initial and therefore not protected at all), and
/// three re-annotations where the fixture, not the gate, held the wrong
/// expectation.
///
/// Keeping an empty table is deliberate. The next disagreement between
/// a fixture and a gate needs a home that is *not* "edit whichever side
/// is easier": a row here asserts the observed behaviour exactly, so it
/// cannot drift further unnoticed, and
/// [`no_divergence_is_less_strict_than_the_corpus_expects`] proves on
/// the effect lattice that it lands at least as safely as the fixture
/// demanded. Deleting the mechanism would make the cheap fix the
/// invisible one.
const KNOWN_DIVERGENCES: &[Divergence] = &[];

fn divergence(name: &str) -> Option<&'static Divergence> {
    static TABLE: OnceLock<BTreeMap<&str, &Divergence>> = OnceLock::new();
    TABLE
        .get_or_init(|| KNOWN_DIVERGENCES.iter().map(|d| (d.case, d)).collect())
        .get(name)
        .copied()
}

/// Where a disposition sits on the strict lattice of spec §9:
/// `Reject > Defer > NoOp > RequireReview > ProposalReady`.
fn strictness(d: Disposition) -> u8 {
    match d {
        Disposition::Rejected => 4,
        Disposition::Deferred => 3,
        Disposition::NoOp => 2,
        Disposition::ReviewRequired => 1,
        Disposition::ProposalReady => 0,
    }
}

/// The invariant that makes [`KNOWN_DIVERGENCES`] tolerable at all: a
/// divergence may re-attribute a refusal, but it may never soften one.
/// The day a row here lands *below* the fixture's demand on the
/// lattice, it has stopped being a bookkeeping error and become a hole.
#[test]
fn no_divergence_is_less_strict_than_the_corpus_expects() {
    for d in KNOWN_DIVERGENCES {
        let c = case(d.case);
        let expected = disposition_of(&c.expected.disposition);
        let observed = disposition_of(d.disposition.unwrap_or(&c.expected.disposition));
        assert!(
            strictness(observed) >= strictness(expected),
            "{}: observed {observed:?} is weaker than the corpus's {expected:?}",
            c.id()
        );
        assert!(!d.why.is_empty(), "{}: an unexplained divergence", c.id());
    }
}

/// The whole §7.1 contract for one line: the named gate ran, recorded
/// exactly the expected effect and code, was (or was not) the terminal
/// record, and the candidate's final disposition is the manifest's.
///
/// Returns the failure text rather than panicking so a corpus walk can
/// report **every** divergence in one run — one failing case hiding the
/// next thirty is exactly how a corpus stops being a corpus.
fn check_manifest(c: &Case, outcome: &VerificationOutcome) -> Result<(), String> {
    let id = c.id();
    let trail = trail(outcome);
    let known = divergence(&c.name);
    // A known divergence supplies the observed triple. Softening the
    // *disposition* is separately guarded by
    // `no_divergence_is_less_strict_than_the_corpus_expects`.
    let (want_gate, want_effect, want_code) = match known {
        Some(d) => (d.gate, outcome_of(d.effect), d.code),
        None => (
            c.expected.gate.as_str(),
            outcome_of(&c.expected.effect),
            c.expected.code.as_deref(),
        ),
    };
    let want_disposition = disposition_of(
        known
            .and_then(|d| d.disposition)
            .unwrap_or(&c.expected.disposition),
    );
    if outcome.disposition != want_disposition {
        return Err(format!(
            "{id}: disposition {:?}, wanted {want_disposition:?}; trail {trail:?}",
            outcome.disposition
        ));
    }

    // G12 is the aggregation, not a recorded gate: `pass` at
    // `g12_derive_disposition` is a claim about the disposition only.
    if want_gate == "g12_derive_disposition" {
        return match outcome.terminal() {
            None => Ok(()),
            Some(t) => Err(format!(
                "{id}: {} terminated before G12; trail {trail:?}",
                t.gate
            )),
        };
    }

    let Some(record): Option<&GateRecord> = outcome.records.iter().find(|r| r.gate == want_gate)
    else {
        return Err(format!("{id}: {want_gate} never ran; trail {trail:?}"));
    };
    if record.effect != want_effect {
        return Err(format!(
            "{id}: {want_gate} effect {:?}, wanted {want_effect:?}; trail {trail:?}",
            record.effect
        ));
    }
    if record.code.as_deref() != want_code {
        return Err(format!(
            "{id}: {want_gate} code {:?}, wanted {want_code:?}; trail {trail:?}",
            record.code
        ));
    }

    // A divergence carries its own terminality: `require_review` is
    // non-terminal by definition, everything else in the lattice ends
    // the walk.
    let want_terminal = match known {
        Some(_) => want_effect.is_terminal(),
        None => c.expected.terminal,
    };
    if want_terminal {
        match outcome.terminal() {
            Some(t) if t.gate == want_gate => {}
            Some(t) => {
                return Err(format!(
                    "{id}: terminal gate is {}, wanted {want_gate}; trail {trail:?}",
                    t.gate
                ))
            }
            None => return Err(format!("{id}: expected a terminal gate; trail {trail:?}")),
        }
    } else if let Some(t) = outcome.terminal() {
        // Non-terminal expectations must run the whole gauntlet. A
        // review flag that quietly stopped the walk would be a lattice
        // bug, and the lattice is the safety argument.
        return Err(format!(
            "{id}: a non-terminal expectation ended at {}; trail {trail:?}",
            t.gate
        ));
    }
    Ok(())
}

#[track_caller]
fn assert_matches_manifest(c: &Case, outcome: &VerificationOutcome) {
    if let Err(why) = check_manifest(c, outcome) {
        panic!("{why}");
    }
}

// =====================================================================
// 1. the wire path — families 1-13, 15-18, 20's envelope cases
// =====================================================================

/// Drive one envelope-shaped fixture through the gauntlet.
fn run_wire_case(c: &Case) -> (Unit, Vec<VerificationOutcome>) {
    let unit = Unit::from_case(c);
    let outcomes = gates::verify_envelope(&c.candidate_bytes(), &unit.context());
    (unit, outcomes)
}

#[test]
fn wire_cases_reach_their_expected_terminal_gate() {
    let mut walked = 0usize;
    let mut failures: Vec<String> = Vec::new();
    for c in manifest() {
        if c.injection() != "wire" || c.candidate.is_none() || c.existing_state.is_some() {
            continue;
        }
        let (_unit, outcomes) = run_wire_case(c);
        let index = c.proposal_index.unwrap_or(0);
        // A G00 refusal is envelope-wide and yields exactly one outcome.
        match outcomes.get(index) {
            Some(outcome) => {
                if let Err(why) = check_manifest(c, outcome) {
                    failures.push(why);
                }
            }
            None => failures.push(format!(
                "{}: envelope produced {} outcome(s), wanted index {index}",
                c.id(),
                outcomes.len()
            )),
        }
        walked += 1;
    }
    assert!(
        failures.is_empty(),
        "{} of {walked} wire cases diverged:\n  {}",
        failures.len(),
        failures.join("\n  ")
    );
    assert_eq!(
        walked, 26,
        "the wire-driven slice of the corpus changed size"
    );
}

/// Divergence 5, closed. `secrets_leak_in_statement` never reaches G09
/// — it reorders S7's anchors, so G07 rejects it first — which means
/// that until this case existed the committed corpus did not exercise
/// the secret screen at all, and item 11 of the acceptance walk rested
/// on a `gates.rs` unit test instead of on a corpus line. Wave 4c
/// re-annotated that older line to the G07 attribution case it actually
/// is, so the corpus no longer *claims* a G09 it never reached; this
/// test is where the claim now lives.
///
/// `secrets_kv_leak_reaches_g09` is the sibling that gets there: same
/// transcript, same cited sentence S7, same `expected_render.txt`, and
/// a statement that preserves S7's anchor order exactly so G04's
/// correlation test and G07's binding-order test both pass. Its only
/// protected token is `-9987`, verbatim in S7, so G06 passes too. The
/// one thing it adds is a `secret=` wrapper around the same passphrase
/// — absent from the transcript, so REDACT_V1 never saw it, matched by
/// G09's independent OUTPUT screen as `key_value_secret`.
///
/// Worth stating, because it is the whole reason the fixture is shaped
/// this way: the bare passphrase would **not** trip G09. At 26 bytes it
/// is under the 32-char high-entropy floor and `passphrase` is not a
/// `key_value_secret` keyword. A fixture that only reordered the words
/// of the existing one would have proved nothing.
#[test]
fn family_16_a_key_value_secret_in_the_statement_reaches_g09() {
    let c = case("secrets_kv_leak_reaches_g09");
    let (unit, outcomes) = run_wire_case(c);
    assert_eq!(outcomes.len(), 1, "one proposal in the envelope");
    let outcome = &outcomes[0];
    assert_matches_manifest(c, outcome);

    // The walk, not just the verdict: everything before G09 has to have
    // PASSED for this to be a G09 test rather than an accident.
    let trail = trail(outcome);
    for gate in [
        "g04_enforce_scope_and_source_policy",
        "g05_enforce_atomic_claim",
        "g06_verify_lexical_integrity",
        "g08_verify_polarity_modality_and_time",
    ] {
        let record = outcome
            .records
            .iter()
            .find(|r| r.gate == gate)
            .unwrap_or_else(|| panic!("{gate} never ran; trail {trail:?}"));
        assert_eq!(
            record.effect,
            GateOutcome::Pass,
            "{gate} must pass for the candidate to reach G09; trail {trail:?}"
        );
    }
    // G07 abstains on an ordinary fact — a review flag, never terminal.
    let g07 = outcome
        .records
        .iter()
        .find(|r| r.gate == "g07_verify_attribution_binding")
        .expect("G07 ran");
    assert_eq!(g07.effect, GateOutcome::RequireReview, "trail {trail:?}");
    assert_eq!(g07.code.as_deref(), Some("complex_semantics"));

    // The gate names the CLASS and never the value: a receipt that
    // quoted the secret would be the leak the gate exists to stop.
    let receipt = serde_json::to_string(&outcome.records).expect("records serialize");
    assert!(
        receipt.contains("key_value_secret"),
        "G09 must record the class it matched: {trail:?}"
    );
    assert!(
        !receipt.contains("quartz-lantern-9987-vellum"),
        "the secret leaked into the gate trail"
    );
    assert!(
        outcome.verified.is_none(),
        "a rejected candidate must not hand the runner a draft to store"
    );

    // And the premise the fixture rests on, asserted rather than left in
    // prose: the transcript itself carries no `secret=`, so REDACT_V1
    // had nothing to match and the screen that fired is genuinely the
    // second, independent one.
    let render = unit.render();
    assert!(
        render.contains("quartz-lantern-9987-vellum"),
        "the passphrase survives REDACT_V1 verbatim (custom format)"
    );
    assert!(
        !render.contains("secret="),
        "the key-value form exists only in the model's OUTPUT"
    );

    // The counterfactual, asserted rather than argued. Every sentence
    // the model could read is clean under G09's own screen — including
    // S7, which carries the passphrase in the clear. So the reject can
    // only have come from what the model WROTE, and a fixture that
    // merely reordered the existing statement would have proved nothing.
    for sentence in &unit.table.sentences {
        let text = segment::resolve(&unit.records, &unit.table, sentence.sid)
            .expect("every enumerated sentence resolves")
            .text;
        assert_eq!(
            policy::sensitive_hit(text),
            None,
            "S{}: the transcript must be clean under G09 for this to be an OUTPUT test",
            sentence.sid
        );
    }
    assert_eq!(
        policy::sensitive_hit("secret=quartz-lantern-9987-vellum"),
        Some("key_value_secret"),
        "the key-value wrapper is what G09 matches"
    );
}

/// The manifest pins one `(gate, effect, code)` triple per line, which
/// is the right oracle for a terminal verdict and an incomplete one for
/// a case whose whole point is that the walk *continues*. Family 9 is
/// that case: the quote marker in S2 flags `AmbiguousAttribution`, the
/// walk goes on because a review flag is non-terminal, and G08 adds a
/// second, independent flag — the statement's `instead of` is a
/// comparison, not the polarity flip the marker list used to read it as
/// (spec §10 G08, as amended; this is the divergence-3 false reject).
///
/// So the surviving review card carries two codes. Asserting only the
/// first would let the second one silently become a rejection again.
#[test]
fn family_09_forwarded_speech_reaches_review_carrying_both_codes() {
    let c = case("forwarded_speech");
    let (_unit, outcomes) = run_wire_case(c);
    assert_eq!(outcomes.len(), 1, "one proposal in the envelope");
    let outcome = &outcomes[0];
    assert_matches_manifest(c, outcome);

    let trail = trail(outcome);
    assert_eq!(
        outcome.disposition,
        Disposition::ReviewRequired,
        "trail {trail:?}"
    );
    assert!(
        outcome.terminal().is_none(),
        "no gate may end this walk; trail {trail:?}"
    );
    for (gate, code) in [
        ("g07_verify_attribution_binding", "ambiguous_attribution"),
        ("g08_verify_polarity_modality_and_time", "complex_semantics"),
    ] {
        let record = outcome
            .records
            .iter()
            .find(|r| r.gate == gate)
            .unwrap_or_else(|| panic!("{gate} never ran; trail {trail:?}"));
        assert_eq!(record.effect, GateOutcome::RequireReview, "{gate}");
        assert_eq!(record.code.as_deref(), Some(code), "{gate}");
    }
    // A review card, not a stored memory: the runner still needs a
    // human before anything lands.
    assert!(
        outcome.verified.is_some(),
        "a review-required candidate still produces the draft a card is built from"
    );
}

/// The sentence IDs every candidate cites are only meaningful if the
/// server's own enumeration is the one the fixtures were written
/// against. Each fixture ships its `expected_render.txt` for exactly
/// this reason; a segmenter change breaks the corpus loudly here rather
/// than quietly re-pointing 30 citations somewhere else.
#[test]
fn every_fixture_render_matches_seg_v1() {
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    let mut failures: Vec<String> = Vec::new();
    for c in manifest() {
        if !seen.insert(c.dir.as_str()) {
            continue;
        }
        let expected_path = c.dir_path().join("expected_render.txt");
        if !expected_path.exists() {
            // Family 19 is journal events, not a transcript.
            assert_eq!(c.family, 19, "{}: missing expected_render.txt", c.id());
            continue;
        }
        let expected = std::fs::read_to_string(&expected_path).expect("render fixture");
        let got = Unit::from_case(c).render();
        if got.trim_end() != expected.trim_end() {
            failures.push(format!(
                "{}:\n    got:      {:?}\n    expected: {:?}",
                c.id(),
                got.trim_end(),
                expected.trim_end()
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "SEG_V1/RENDER_V1 drifted from the committed tables:\n  {}",
        failures.join("\n  ")
    );
}

// =====================================================================
// 2. post-G00 injection — family 11 and family 18's destructive shape
// =====================================================================

/// Family 11's `candidate_bad_action.json` and family 18's
/// `candidate_destructive.json` describe spec §7 shapes the V1 wire
/// schema cannot express (a model-authored `action`, an
/// `object.reference`, a `supersession` class). They are hand-built
/// `Candidate`s injected after G00, exactly as the manifest says — the
/// *server-side* check must not depend on the wire staying narrow.
///
/// The knob each case turns is the one the fixture's extra fields
/// stand for, and nothing else:
///
/// | case | fixture field | server knob |
/// |---|---|---|
/// | `wrong_scope_bad_action` | `action: delete_engram` | the run's `allowed_actions` does not contain the class's action |
/// | `wrong_scope_cross_brain_object` | `object.reference: brain:OtherBrain/…` | `allowed_object` resolves outside the unit's brain |
/// | `destructive_action` | `action: delete_engram` | `existing.destructive_target` |
#[derive(Debug, Deserialize)]
struct InjectedCandidate {
    #[allow(dead_code)]
    action: String,
    statement: String,
    subject: String,
    evidence: Vec<String>,
    source_role: String,
}

fn injected(c: &Case, class: &str) -> Candidate {
    let raw: InjectedCandidate =
        serde_json::from_slice(&c.candidate_bytes()).expect("injected fixture decodes");
    Candidate {
        r#type: class.to_string(),
        statement: raw.statement,
        subject: raw.subject,
        evidence: raw.evidence,
        source_role: raw.source_role,
    }
}

#[test]
fn post_g00_wrong_scope_bad_action_dies_at_g03() {
    let c = case("wrong_scope_bad_action");
    let mut unit = Unit::from_case(c);
    // The server issued a run whose action set excludes this class's
    // action — the shape a `delete_engram` request would land in.
    unit.actions = vec!["curator_remember_preference"];
    let candidate = injected(c, "fact");
    assert!(
        !unit.actions.contains(&"curator_remember_fact"),
        "the fixture's premise is that the action is not allowed"
    );
    assert_matches_manifest(c, &gates::verify_candidate(&candidate, &unit.context()));
}

#[test]
fn post_g00_cross_brain_object_dies_at_g01() {
    let c = case("wrong_scope_cross_brain_object");
    let mut unit = Unit::from_case(c);
    unit.object = AllowedObject::new("OtherBrain");
    let candidate = injected(c, "fact");
    assert_matches_manifest(c, &gates::verify_candidate(&candidate, &unit.context()));
}

#[test]
fn post_g00_destructive_shape_always_reaches_a_human() {
    let c = case("destructive_action");
    let mut unit = Unit::from_case(c);
    unit.existing.destructive_target = true;
    let candidate = injected(c, "decision");
    assert_matches_manifest(c, &gates::verify_candidate(&candidate, &unit.context()));

    // The other half of the same rule, stated directly: V1 mints only
    // additive actions, so *any* other action is destructive by
    // construction. The fixture's `delete_engram` is unreachable from
    // the wire — this is what makes that safe rather than lucky.
    assert!(policy::action_is_destructive("delete_engram"));
    for action in policy::CURATOR_ACTIONS {
        assert!(!policy::action_is_destructive(action));
    }
}

// =====================================================================
// 3. family 18 — duplicate and contradiction need prior state
// =====================================================================

/// Both cases are the *same* candidate over the *same* transcript in a
/// different world, so the world is what the test has to build. The
/// honest way to build it is to run the candidate once against an empty
/// brain and take the server's own derived keys — deriving them a
/// second time in the test would only prove the test agrees with itself.
fn keys_for(c: &Case) -> (String, String) {
    let unit = Unit::from_case(c);
    let outcomes = gates::verify_envelope(&c.candidate_bytes(), &unit.context());
    let draft = outcomes[0]
        .verified
        .as_ref()
        .unwrap_or_else(|| panic!("{}: the clean run must produce a draft", c.id()));
    (draft.evidence_key.clone(), draft.claim_key.clone())
}

#[test]
fn family_18_rerunning_the_same_unit_is_a_no_op() {
    let c = case("exact_duplicate");
    let (evidence_key, _) = keys_for(c);

    let mut unit = Unit::from_case(c);
    unit.existing.engram_evidence_keys.insert(evidence_key);
    let outcomes = gates::verify_envelope(&c.candidate_bytes(), &unit.context());
    assert_matches_manifest(c, &outcomes[0]);
    assert!(
        outcomes[0].verified.is_none(),
        "a NoOp must not hand the runner a draft to store"
    );
}

#[test]
fn family_18_a_stored_claim_with_other_evidence_is_a_conflict() {
    let c = case("contradiction");
    let (_, claim_key) = keys_for(c);

    // The stored engram says Fridays: same claim slot, different
    // evidence. Every protected token is still verbatim in S1, so no
    // transcript-facing gate can see this — only existing state can.
    let mut unit = Unit::from_case(c);
    unit.existing.claim_keys.insert(claim_key);
    let outcomes = gates::verify_envelope(&c.candidate_bytes(), &unit.context());
    assert_matches_manifest(c, &outcomes[0]);
    assert!(
        outcomes[0]
            .review_codes
            .contains(&gates::ReviewCode::Conflict),
        "the conflict must reach the reviewer as a chip"
    );
}

// =====================================================================
// 4. family 19 — curator output recycled as evidence (pre-gate)
// =====================================================================

#[test]
fn family_19_curator_output_never_forms_a_unit() {
    let c = case("curator_output_recycled");
    let raw = String::from_utf8(c.read(&c.transcript)).expect("utf8 events");
    let events: Vec<Event> = raw
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).expect("fixture event"))
        .collect();

    // Per-event: the manifest names the exact ineligibility reason, and
    // two of the four wear allowlisted (event_type, capture_method)
    // shapes — being refused anyway is the whole point.
    let reasons = c
        .expected_reasons
        .as_ref()
        .expect("family 19 pins a reason per event");
    assert_eq!(events.len(), reasons.len());
    for event in &events {
        let want = reasons
            .get(&event.event_id)
            .unwrap_or_else(|| panic!("no expected reason for {}", event.event_id));
        let got = lineage::classify(event)
            .reason()
            .unwrap_or_else(|| panic!("{}: eligible, but must not be", event.event_id));
        assert_eq!(
            got.as_str(),
            want,
            "{}: ineligibility reason",
            event.event_id
        );
    }

    // And the loop is cut BEFORE unit assembly: the assertion is zero
    // units, not a gate verdict.
    let (units, notes) = runner::assemble_units(BRAIN, &events);
    assert_eq!(
        units.len(),
        c.expected_units.unwrap_or(0),
        "{}: units formed from curator-derived evidence",
        c.id()
    );
    assert!(
        notes.iter().any(|n| n.contains("ineligible")),
        "silence is not allowed: {notes:?}"
    );
}

// =====================================================================
// 5. family 20 — the provider taxonomy, against a mock Ollama
// =====================================================================

const MODEL: &str = "qwen3:30b-a3b-instruct-2507-q4_K_M";
const DIGEST: &str = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
const CANARY_GOLD: &str = r#"{"proposals":[{"type":"decision","statement":"Deploys move to Tuesday.","subject":"deploys","evidence":["S3"],"source_role":"user"}],"nothing_durable":false}"#;

#[derive(Default)]
struct MockState {
    chat: Mutex<std::collections::VecDeque<(u16, String)>>,
    calls: Mutex<u32>,
}

impl MockState {
    fn script(self: &Arc<Self>, status: u16, body: String) -> &Arc<Self> {
        self.chat.lock().unwrap().push_back((status, body));
        self
    }

    fn preflight_ok(self: &Arc<Self>) -> &Arc<Self> {
        self.script(200, ok_chat(r#"{"proposals":[],"nothing_durable":true}"#));
        self.script(200, ok_chat(CANARY_GOLD))
    }
}

fn ok_chat(content: &str) -> String {
    serde_json::json!({
        "model": MODEL,
        "message": { "role": "assistant", "content": content },
        "done": true,
        "done_reason": "stop",
        "prompt_eval_count": 900,
        "eval_count": 64,
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
    use axum::extract::State as AxState;
    use axum::response::IntoResponse;
    use axum::routing::{get, post};
    use axum::{Json, Router};

    async fn h_chat(
        AxState(st): AxState<Arc<MockState>>,
        body: String,
    ) -> axum::response::Response {
        let unload = body.contains("\"keep_alive\":\"0\"");
        if unload {
            return Json(serde_json::json!({ "done": true })).into_response();
        }
        *st.calls.lock().unwrap() += 1;
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
        .route(
            "/api/ps",
            get(|| async { Json(serde_json::json!({ "models": [] })) }),
        )
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

fn provider_config(base: &str) -> provider::ProviderConfig {
    provider::ProviderConfig {
        endpoint: base.to_string(),
        model: MODEL.to_string(),
        num_ctx: 8192,
        num_predict: 512,
        timeout_warmup_secs: 10,
        timeout_first_unit_secs: 10,
        timeout_unit_secs: 10,
        timeout_control_secs: 5,
        ..Default::default()
    }
}

async fn session(cfg: &provider::ProviderConfig) -> provider::ProviderSession {
    let canary = provider::CanarySpec {
        system: prompt::SYSTEM_MESSAGE,
        user: runner::CANARY_UNIT,
        schema: &prompt::OUTPUT_SCHEMA,
        expected_evidence_ids: runner::CANARY_EVIDENCE_IDS,
    };
    provider::ProviderSession::start(cfg, provider::client(cfg), &canary)
        .await
        .expect("preflight against the mock")
}

/// Generate one unit against the mock and return whatever the provider
/// made of the reply.
async fn generate(
    s: &mut provider::ProviderSession,
    user: &str,
) -> Result<provider::UnitReply, provider::ProviderError> {
    s.chat_unit(provider::UnitRequest {
        system: prompt::SYSTEM_MESSAGE,
        user,
        schema: &prompt::OUTPUT_SCHEMA,
        seed: 0,
        output_schema_version: prompt::CURATOR_OUTPUT_SCHEMA,
        estimate_tokens: &prompt::estimate_tokens,
    })
    .await
}

/// The manifest's `expected` block for a provider case: whatever the
/// typed error is, the unit must **defer** — never reject, never pass.
#[track_caller]
fn assert_provider_defers(c: &Case, err: &provider::ProviderError) {
    assert_eq!(c.expected.effect, "defer");
    assert_eq!(
        err.disposition(),
        provider::Disposition::DeferUnit,
        "{}: {err:?} must defer the unit",
        c.id()
    );
    assert!(
        matches!(
            err.unit_outcome(),
            Some(neurovault_lib::memory::adaptive::curator::state::UnitOutcome::Deferred(_))
        ),
        "{}: {err:?} must record a Deferred unit outcome",
        c.id()
    );
}

#[tokio::test]
async fn family_20_truncated_response_defers() {
    let c = case("response_truncated");
    let state = Arc::new(MockState::default());
    let body = String::from_utf8(c.candidate_bytes()).expect("utf8 fixture");
    state.preflight_ok().script(200, body);
    let ollama = mock_ollama(state).await;
    let cfg = provider_config(&ollama.base);
    let mut s = session(&cfg).await;

    let unit = Unit::from_case(c);
    let err = generate(&mut s, &unit.user_message())
        .await
        .expect_err("done_reason=length is not a usable answer");
    assert!(
        matches!(err, provider::ProviderError::OutputTruncated),
        "{}: got {err:?}",
        c.id()
    );
    assert_eq!(c.provider_error.as_deref(), Some("output_truncated"));
    assert_provider_defers(c, &err);
}

#[tokio::test]
async fn family_20_oversized_response_is_capped_before_any_parse() {
    let c = case("response_oversized");
    let synth = c.synthesize.as_ref().expect("synthesized at test time");
    let bytes = synth["bytes"].as_u64().expect("byte count") as usize;
    let cap = synth["cap_bytes"].as_u64().expect("cap") as usize;
    assert_eq!(
        cap,
        provider::MAX_RESPONSE_BYTES,
        "the manifest's cap is the code's cap"
    );

    // 300 KiB of filler has no business in git; it is generated here.
    let filler = "x".repeat(bytes);
    let state = Arc::new(MockState::default());
    state.preflight_ok().script(200, ok_chat(&filler));
    let ollama = mock_ollama(state).await;
    let cfg = provider_config(&ollama.base);
    let mut s = session(&cfg).await;

    let unit = Unit::from_case(c);
    let err = generate(&mut s, &unit.user_message())
        .await
        .expect_err("an over-cap body is refused");
    assert!(
        matches!(
            err,
            provider::ProviderError::ResponseTooLarge { .. }
                | provider::ProviderError::MalformedOutput { .. }
        ),
        "{}: got {err:?}",
        c.id()
    );
    assert_provider_defers(c, &err);
}

#[tokio::test]
async fn family_20_server_busy_backs_off_then_defers() {
    let c = case("server_busy_backoff");
    let synth = c.synthesize.as_ref().expect("synthesized at test time");
    let repeat = synth["repeat"].as_u64().expect("repeat") as usize;
    let backoff = synth["backoff_secs"].as_u64().expect("backoff");

    let state = Arc::new(MockState::default());
    state.preflight_ok();
    for _ in 0..repeat {
        state.script(503, "{\"error\":\"server busy\"}".into());
    }
    let ollama = mock_ollama(state).await;
    let cfg = provider_config(&ollama.base);
    let mut s = session(&cfg).await;

    let unit = Unit::from_case(c);
    let err = generate(&mut s, &unit.user_message())
        .await
        .expect_err("503 is not an answer");
    assert!(
        matches!(err, provider::ProviderError::ServerBusy),
        "{}: got {err:?}",
        c.id()
    );
    assert_eq!(c.provider_error.as_deref(), Some("server_busy"));
    // The user's Ollama is shared: back off, do not hammer it.
    assert_eq!(
        err.retry_after(),
        Some(std::time::Duration::from_secs(backoff))
    );
    assert_provider_defers(c, &err);
}

/// The three malformed envelopes are the model's fault, not the
/// transport's, so the manifest expects them at **G00**. Worth stating
/// plainly: in a live run the provider's shallow check fires first
/// (`{}` is the measured qwen3 collapse mode), so these bytes normally
/// never reach the gauntlet. G00 is the authority for bytes that do —
/// belt and braces, and both halves are asserted here.
#[tokio::test]
async fn family_20_malformed_envelopes_are_caught_twice() {
    for name in [
        "envelope_empty_object",
        "envelope_missing_flag",
        "envelope_incoherent_abstain",
    ] {
        let c = case(name);
        let raw = c.candidate_bytes();
        let body = String::from_utf8(raw.clone()).expect("utf8 fixture");

        let state = Arc::new(MockState::default());
        state.preflight_ok().script(200, ok_chat(&body));
        let ollama = mock_ollama(state).await;
        let cfg = provider_config(&ollama.base);
        let mut s = session(&cfg).await;
        let unit = Unit::from_case(c);
        let reply = generate(&mut s, &unit.user_message()).await;

        match reply {
            // Caught by the provider's shallow check first.
            Err(provider::ProviderError::MalformedOutput { .. }) => {}
            // Or it got through the transport: G00 is then the authority.
            Ok(reply) => {
                let outcomes = gates::verify_envelope(reply.raw_json.as_bytes(), &unit.context());
                assert_eq!(outcomes.len(), 1, "{}: G00 refuses envelope-wide", c.id());
                assert_matches_manifest(c, &outcomes[0]);
            }
            Err(other) => panic!("{}: unexpected provider error {other:?}", c.id()),
        }

        // Independently of the transport, G00 must refuse these bytes.
        let unit = Unit::from_case(c);
        let outcomes = gates::verify_envelope(&raw, &unit.context());
        assert_eq!(outcomes.len(), 1, "{}: G00 refuses envelope-wide", c.id());
        assert_matches_manifest(c, &outcomes[0]);
    }
}

/// Every wire case, served to the pipeline the way a real run receives
/// it: the fixture JSON *is* the model's `message.content`, decoded by
/// `provider.rs` and handed to the gauntlet as raw bytes. This is what
/// makes the corpus an end-to-end artifact rather than a gates fixture
/// — the provider must pass a well-formed envelope through byte for
/// byte, and the verdict must not move.
#[tokio::test]
async fn wire_cases_survive_the_provider_round_trip_unchanged() {
    let mut checked = 0usize;
    let mut failures: Vec<String> = Vec::new();
    for c in manifest() {
        if c.injection() != "wire" || c.candidate.is_none() || c.family == 20 {
            continue;
        }
        let raw = c.candidate_bytes();
        let Ok(body) = String::from_utf8(raw.clone()) else {
            continue;
        };

        let state = Arc::new(MockState::default());
        state.preflight_ok().script(200, ok_chat(body.trim()));
        let ollama = mock_ollama(state).await;
        let cfg = provider_config(&ollama.base);
        let mut s = session(&cfg).await;
        let unit = Unit::from_case(c);

        match generate(&mut s, &unit.user_message()).await {
            Ok(reply) => {
                assert_eq!(
                    reply.raw_json.trim(),
                    body.trim(),
                    "{}: the provider altered the model's bytes",
                    c.id()
                );
                assert_eq!(reply.generation.output_schema_version, 2);
                let outcomes = gates::verify_envelope(reply.raw_json.as_bytes(), &unit.context());
                match outcomes.get(c.proposal_index.unwrap_or(0)) {
                    Some(outcome) if c.existing_state.is_none() => {
                        if let Err(why) = check_manifest(c, outcome) {
                            failures.push(format!("(via provider) {why}"));
                        }
                    }
                    _ => {}
                }
                checked += 1;
            }
            // Family 11's unknown-key envelope is a *shape* attack the
            // provider's shallow required-key check may also catch.
            Err(provider::ProviderError::MalformedOutput { .. }) => {
                assert_eq!(
                    c.expected.gate,
                    "g00_validate_output_envelope",
                    "{}",
                    c.id()
                );
                checked += 1;
            }
            Err(other) => panic!("{}: unexpected provider error {other:?}", c.id()),
        }
    }
    assert!(checked >= 20, "only {checked} wire cases round-tripped");
    assert!(
        failures.is_empty(),
        "{} wire case(s) diverged through the provider:\n  {}",
        failures.len(),
        failures.join("\n  ")
    );
}

// =====================================================================
// 6. families 14 and 20's replay — the full runner
// =====================================================================

static HOME_LOCK: Mutex<()> = Mutex::new(());

const PROJECT: &str = "-Users-dath-code-redteam";
const SESSION: &str = "f4a9c2e1-7b3d-4e08-9a51-2c6f8d0e4b17";

/// A private `NEUROVAULT_HOME` + `CLAUDE_CONFIG_DIR`, canonicalized —
/// macOS's `/var` is a symlink and the hardened evidence reader refuses
/// symlinked roots.
struct Env {
    root: PathBuf,
    home: PathBuf,
    projects: PathBuf,
    prev_home: Option<std::ffi::OsString>,
    prev_claude: Option<std::ffi::OsString>,
    _guard: MutexGuard<'static, ()>,
}

impl Env {
    fn new(name: &str) -> Self {
        let guard = HOME_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let requested = std::env::temp_dir().join(format!(
            "nv-redteam-{name}-{}-{}",
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

    fn transcript(&self, body: &[u8]) -> (String, u64, String) {
        let path = self.projects.join(format!("{SESSION}.jsonl"));
        std::fs::write(&path, body).unwrap();
        (
            format!("{PROJECT}/{SESSION}.jsonl"),
            body.len() as u64,
            sha256_hex(body),
        )
    }

    fn config(&self, endpoint: &str) {
        let cfg = serde_json::json!({
            "enabled": true,
            "transcript_access": true,
            "provider": {
                "endpoint": endpoint,
                "model": MODEL,
                "num_ctx": 8192,
                "num_predict": 512,
                "timeout_warmup_secs": 10,
                "timeout_first_unit_secs": 10,
                "timeout_unit_secs": 10,
                "timeout_control_secs": 5,
            },
        });
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

/// The two journal events slice 1 writes for one captured turn.
fn journal_turn(relative: &str, len: u64, sha: &str) -> String {
    use neurovault_lib::memory::journal::{
        append, ApprovedTranscriptRoot, EvidenceCaptureReceipt, EvidenceCaptureStatus,
        EvidenceReference,
    };

    let mut ctx = Event::now(BRAIN, "context_decision", "prompt", "sha256:prompt");
    ctx.capture_method = "ambient".into();
    ctx.turn_id = Some(ctx.event_id.clone());
    ctx.session_id = Some(SESSION.into());
    ctx.host = Some("claude_code".into());
    ctx.title = Some("redteam".into());
    append(&ctx).unwrap();

    let mut stop = Event::now(BRAIN, "assistant_response_completed", "session", SESSION);
    stop.capture_method = "hook".into();
    stop.turn_id = Some(ctx.event_id.clone());
    stop.session_id = Some(SESSION.into());
    stop.host = Some("claude_code".into());
    stop.title = Some("redteam".into());
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
    ctx.event_id
}

fn proposal_lines() -> usize {
    std::fs::read_to_string(neurovault_lib::memory::paths::brain_dir(BRAIN).join("proposals.jsonl"))
        .map(|raw| raw.lines().filter(|l| !l.trim().is_empty()).count())
        .unwrap_or(0)
}

/// Family 14 — the transcript was truncated **and** rewritten after
/// capture. `reopen_verified` reports `PrefixMismatch`, the unit defers,
/// and the model is never asked: the run must not read the newer bytes,
/// and it must not guess.
#[tokio::test]
async fn family_14_mutated_prefix_defers_without_a_model_call() {
    let c = case("mutable_prefix");
    let original = c.transcript_bytes();
    let mutated = c.read(c.mutation.as_deref().expect("family 14 ships a mutation"));
    assert_ne!(original, mutated, "the fixture must actually move");

    let env = Env::new("f14");
    let state = Arc::new(MockState::default());
    state.preflight_ok();
    let ollama = mock_ollama(state.clone()).await;
    env.config(&ollama.base);
    let (relative, len, sha) = env.transcript(&original);
    journal_turn(&relative, len, &sha);
    // Capture hashed the original; the run finds the rewritten file.
    std::fs::write(env.projects.join(format!("{SESSION}.jsonl")), &mutated).unwrap();

    let report = runner::run_brain(BRAIN).await.expect("run");
    assert_eq!(report.units_deferred, 1, "{report:?}");
    assert_eq!(report.proposals_created, 0);
    assert_eq!(proposal_lines(), 0);
    assert_eq!(
        *state.calls.lock().unwrap(),
        0,
        "{}: the model must never see vanished evidence",
        c.id()
    );

    let audit = &state::read_audit(BRAIN)[0];
    assert_eq!(
        audit.no_proposal_reason,
        Some(NoProposalReason::EvidenceUnavailable),
        "{}: the manifest's defer code",
        c.id()
    );
    assert_eq!(audit.unit_status, state::CuratorUnitStatus::Deferred);
    assert_eq!(c.expected.code.as_deref(), Some("evidence_unavailable"));
    drop(ollama);
}

/// Family 20's last line — kill between the proposals append and the
/// ledger write. Replay must reach the same state and append **zero**
/// new lines.
#[tokio::test]
async fn family_20_crash_mid_run_replays_to_an_unchanged_store() {
    let c = case("crash_mid_run_replay");
    assert_eq!(c.expected.disposition, "unchanged");

    let env = Env::new("f20replay");
    let unit = Unit::from_case(c);
    // The fixture's own transcript, and the answer a model would give
    // for it: one decision citing S1.
    let reply = r#"{"proposals":[{"type":"decision","statement":"New services standardize on Postgres 16.","subject":"infrastructure","evidence":["S1"],"source_role":"user"}],"nothing_durable":false}"#;
    let state = Arc::new(MockState::default());
    state.preflight_ok().script(200, ok_chat(reply));
    let ollama = mock_ollama(state.clone()).await;
    env.config(&ollama.base);
    let (relative, len, sha) = env.transcript(&c.transcript_bytes());
    journal_turn(&relative, len, &sha);
    drop(unit);

    let first = runner::run_brain(BRAIN).await.expect("first run");
    assert_eq!(first.proposals_created, 1, "{first:?}");
    assert_eq!(proposal_lines(), 1);

    // The crash: the ledger never landed, so the unit looks new again.
    std::fs::remove_file(state::state_path(BRAIN)).unwrap();
    {
        let mut q = state.chat.lock().unwrap();
        q.clear();
    }
    state.preflight_ok().script(200, ok_chat(reply));

    let replay = runner::run_brain(BRAIN).await.expect("replay");
    assert_eq!(replay.units_processed, 1, "{replay:#?}");
    assert_eq!(replay.proposals_created, 0, "replay must create nothing");
    assert_eq!(proposal_lines(), 1, "replay appended a duplicate line");

    // Recorded, never silently dropped: G11 sees the evidence_key the
    // stored proposal already carries.
    let last = state::read_audit(BRAIN).pop().expect("replay audited");
    let no_op = last
        .outcomes
        .iter()
        .find(|o| o.outcome == state::AuditOutcomeKind::NoOp)
        .expect("the duplicate is audited");
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

// =====================================================================
// 7. the coverage invariant
// =====================================================================

/// Every manifest line is driven by a named test in this file. A new
/// fixture fails here until somebody claims it — which is the only way
/// "all twenty red-team families have regression fixtures" stays true
/// as the corpus grows.
#[test]
fn every_manifest_line_is_claimed() {
    let claimed: BTreeMap<&str, &str> = BTreeMap::from([
        (
            "entity_role_swap",
            "wire_cases_reach_their_expected_terminal_gate",
        ),
        (
            "predicate_transfer",
            "wire_cases_reach_their_expected_terminal_gate",
        ),
        (
            "quote_splicing_nonadjacent",
            "wire_cases_reach_their_expected_terminal_gate",
        ),
        (
            "quote_splicing_adjacent",
            "wire_cases_reach_their_expected_terminal_gate",
        ),
        (
            "negation_clipping",
            "wire_cases_reach_their_expected_terminal_gate",
        ),
        (
            "possibility_modality_dropped",
            "wire_cases_reach_their_expected_terminal_gate",
        ),
        (
            "possibility_completed",
            "wire_cases_reach_their_expected_terminal_gate",
        ),
        (
            "planned_to_completed",
            "wire_cases_reach_their_expected_terminal_gate",
        ),
        (
            "historical_to_current",
            "wire_cases_reach_their_expected_terminal_gate",
        ),
        (
            "literal_mutation_clock",
            "wire_cases_reach_their_expected_terminal_gate",
        ),
        (
            "literal_mutation_control",
            "wire_cases_reach_their_expected_terminal_gate",
        ),
        (
            "forwarded_speech",
            "wire_cases_reach_their_expected_terminal_gate",
        ),
        (
            "assistant_as_user_belief",
            "wire_cases_reach_their_expected_terminal_gate",
        ),
        (
            "wrong_scope_unknown_key",
            "wire_cases_reach_their_expected_terminal_gate",
        ),
        (
            "wrong_scope_bad_action",
            "post_g00_wrong_scope_bad_action_dies_at_g03",
        ),
        (
            "wrong_scope_cross_brain_object",
            "post_g00_cross_brain_object_dies_at_g01",
        ),
        (
            "unrelated_span",
            "wire_cases_reach_their_expected_terminal_gate",
        ),
        (
            "unicode_absent_id",
            "wire_cases_reach_their_expected_terminal_gate",
        ),
        (
            "unicode_malformed_id",
            "wire_cases_reach_their_expected_terminal_gate",
        ),
        (
            "mutable_prefix",
            "family_14_mutated_prefix_defers_without_a_model_call",
        ),
        (
            "prompt_injection_assistant_role",
            "wire_cases_reach_their_expected_terminal_gate",
        ),
        (
            "prompt_injection_role_forged",
            "wire_cases_reach_their_expected_terminal_gate",
        ),
        (
            "secrets_cite_redacted",
            "wire_cases_reach_their_expected_terminal_gate",
        ),
        (
            "secrets_leak_in_statement",
            "wire_cases_reach_their_expected_terminal_gate",
        ),
        (
            "secrets_kv_leak_reaches_g09",
            "family_16_a_key_value_secret_in_the_statement_reaches_g09",
        ),
        (
            "code_symbol_confusion",
            "wire_cases_reach_their_expected_terminal_gate",
        ),
        (
            "exact_duplicate",
            "family_18_rerunning_the_same_unit_is_a_no_op",
        ),
        (
            "contradiction",
            "family_18_a_stored_claim_with_other_evidence_is_a_conflict",
        ),
        (
            "destructive_action",
            "post_g00_destructive_shape_always_reaches_a_human",
        ),
        (
            "curator_output_recycled",
            "family_19_curator_output_never_forms_a_unit",
        ),
        (
            "envelope_empty_object",
            "family_20_malformed_envelopes_are_caught_twice",
        ),
        (
            "envelope_missing_flag",
            "family_20_malformed_envelopes_are_caught_twice",
        ),
        (
            "envelope_incoherent_abstain",
            "family_20_malformed_envelopes_are_caught_twice",
        ),
        ("response_truncated", "family_20_truncated_response_defers"),
        (
            "response_oversized",
            "family_20_oversized_response_is_capped_before_any_parse",
        ),
        (
            "server_busy_backoff",
            "family_20_server_busy_backs_off_then_defers",
        ),
        (
            "crash_mid_run_replay",
            "family_20_crash_mid_run_replays_to_an_unchanged_store",
        ),
    ]);

    let in_manifest: BTreeSet<&str> = manifest().iter().map(|c| c.name.as_str()).collect();
    let in_tests: BTreeSet<&str> = claimed.keys().copied().collect();
    assert_eq!(
        in_manifest.difference(&in_tests).collect::<Vec<_>>(),
        Vec::<&&str>::new(),
        "manifest cases with no driver"
    );
    assert_eq!(
        in_tests.difference(&in_manifest).collect::<Vec<_>>(),
        Vec::<&&str>::new(),
        "drivers for cases that no longer exist"
    );

    // And all twenty spec families are present (acceptance bar §20).
    let families: BTreeSet<u32> = manifest().iter().map(|c| c.family).collect();
    assert_eq!(families, (1..=20).collect::<BTreeSet<u32>>());
}
