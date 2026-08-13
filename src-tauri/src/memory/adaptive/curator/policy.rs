//! Versioned verification policy data (guide §2/§3.3, slice B1).
//!
//! Owns: [`POLICY_EPOCH`], the class-from-provenance matrix
//! ([`CLASS_POLICY_V1`]), the G07 attribution-template registry, the
//! G08 marker lists, the alias table (exact entries only — an alias is
//! a review flag, never proof), the deterministic protected-token
//! extractor ([`extract_protected`]), the anchor-entity helpers G04
//! uses for correlated evidence, and the G09 sensitive screen.
//!
//! Data, not logic: every table here is versioned by [`POLICY_EPOCH`]
//! and pinned by a regression test, so a policy edit is a visible,
//! replayable change rather than silent behavioural drift. Spec §10
//! says the same thing twice, for G07 and G08 — *changing a template or
//! marker list requires a policy-epoch bump plus positive, negative,
//! role-reversal and near-miss regression fixtures.* The tests at the
//! bottom of this file are the mechanical half of that promise.
//!
//! Everything here is a pure function of its `&str` input. No clock, no
//! filesystem, no locale: the same bytes produce the same tokens on
//! every machine, which is what makes the receipts replayable.

use std::collections::{BTreeMap, BTreeSet};

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};

use super::receipts::SourceRole;

/// The admissibility contract these tables encode.
///
/// Bumped only when the *meaning* of a verdict changes — never for an
/// ordinary prompt or model upgrade (spec §12.1). It is stamped into
/// every [`super::receipts::VerificationReceipt`] and into every
/// `proposal_id`, so two runs under different epochs can neither
/// collide nor silently compare.
///
/// `vp2` (2026-08, Wave 4c) carries the spec's two conformance rulings:
/// correlation anchors admit ASCII acronyms so a shared `DB` is evidence
/// rather than noise, and [`COMPARISON_MARKERS`] route `X instead of Y`
/// to review instead of letting the one-sided-negation rule read it as
/// an inversion. Both change what a verdict *means*, which is what an
/// epoch is for.
pub const POLICY_EPOCH: &str = "2026-08-vp2";

// ---------------------------------------------------------------------
// claim vocabulary
// ---------------------------------------------------------------------

/// The V1 wire projection of spec §7's thirteen claim classes.
///
/// `eval/curator/schema_sid.json` — the schema actually served to the
/// model — closes `type` to three values. The spec's wider vocabulary
/// (`ExactIdentifier`, `TypedQuantity`, `Supersession`, …) is not
/// reachable in V1 because no served enum branch produces it; the fact
/// family absorbs the extractive classes exactly as spec §7.1 says
/// ("`CLASS_POLICY_V1` groups the extractive `RecordFact` classes as
/// the fact family").
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaimClass {
    Fact,
    Preference,
    Decision,
}

impl ClaimClass {
    /// Parse the model's `type` field. `None` is `Reject(InvalidEnvelope)`
    /// at G00 — never a coerced default.
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "fact" => Some(ClaimClass::Fact),
            "preference" => Some(ClaimClass::Preference),
            "decision" => Some(ClaimClass::Decision),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ClaimClass::Fact => "fact",
            ClaimClass::Preference => "preference",
            ClaimClass::Decision => "decision",
        }
    }

    /// The server-issued action this class maps to. The model never
    /// names an action — spec §7 lists "arbitrary action, type, object,
    /// or field names" among the things it must not emit.
    pub fn action(self) -> &'static str {
        match self {
            ClaimClass::Fact => "curator_remember_fact",
            ClaimClass::Preference => "curator_remember_preference",
            ClaimClass::Decision => "curator_remember_decision",
        }
    }
}

/// Every action V1 can mint. A run issues its own `allowed_actions`;
/// this is the closed universe those are drawn from.
pub const CURATOR_ACTIONS: [&str; 3] = [
    "curator_remember_fact",
    "curator_remember_preference",
    "curator_remember_decision",
];

/// V1 mints only additive `curator_remember_*` actions, so G11's
/// destructive branch has no reachable action today. The predicate
/// exists so that branch is written and tested rather than discovered
/// later (spec §11: merge/supersede/delete/hide are review plus
/// explicit apply, never auto-apply).
pub fn action_is_destructive(action: &str) -> bool {
    !CURATOR_ACTIONS.contains(&action)
}

// ---------------------------------------------------------------------
// provenance vocabulary + CLASS_POLICY_V1
// ---------------------------------------------------------------------

/// Spec §5.3. Who authored the bytes — policy, not decoration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActorClass {
    FirstPartyUser,
    /// The implementation's first-party agent role (spec §7.1).
    Assistant,
    Tool,
    ExternalAuthor,
    System,
    Unknown,
}

/// Spec §5.3. How the bytes reached the record.
///
/// PARSER_V1 attributes pasted or quoted text *inside* a user message
/// to the user record — host structure cannot prove otherwise — so
/// every V1 record is [`AuthorshipDisposition::Direct`] at G04, and the
/// pasted-content ambiguity is G07's `AmbiguousAttribution` problem
/// (guide §2.2). The wider grid is encoded anyway: it is the contract a
/// future host-aware parser plugs into, and its rows are pinned today.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthorshipDisposition {
    Direct,
    Quoted,
    Forwarded,
    Pasted,
    Mixed,
    Unknown,
}

/// What [`CLASS_POLICY_V1`] permits for one (class, actor, authorship).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClassPermission {
    /// Admissible with no provenance review flag.
    Allow,
    /// Admissible but weak — G04 adds `RequireReview(WeakProvenance)`.
    Weak,
    /// Inadmissible — G04/G07 reject with `ProvenanceViolation`.
    Deny,
}

/// One row of the permission matrix.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClassPolicyRow {
    pub class: ClaimClass,
    pub actor: ActorClass,
    pub authorship: AuthorshipDisposition,
    pub permission: ClassPermission,
}

const fn row(
    class: ClaimClass,
    actor: ActorClass,
    authorship: AuthorshipDisposition,
    permission: ClassPermission,
) -> ClassPolicyRow {
    ClassPolicyRow {
        class,
        actor,
        authorship,
        permission,
    }
}

/// The class × (actor, authorship) permission matrix (spec §7.1, §11).
///
/// Read it as the provenance *floor*, not a suggestion:
///
/// - `decision` / `preference` ← `FirstPartyUser + Direct` only.
///   Assistant, tool, file, web, quoted, forwarded, pasted, mixed and
///   unknown are all `Deny`. Context may carry any role; the
///   *deciding* sentence may not.
/// - `fact` ← `FirstPartyUser + Direct` or `Assistant + Direct`, both
///   without a review flag (the prompt's Example 3 — "the nightly sync
///   runs at 02:00 UTC" — is the normal case). Quoted/forwarded/pasted
///   first-party or assistant text is `Weak`: admissible, flagged.
///   Tool/external/system/unknown authorship is `Deny` for every class:
///   `ActorClass::Assistant`'s allowance is explicitly not inherited.
///
/// Any tuple absent from this table is `Deny` — it is an allowlist, so
/// a new enum variant fails closed instead of inheriting a permission.
pub const CLASS_POLICY_V1: &[ClassPolicyRow] = &[
    // ── decision: first-party user, direct, full stop ──
    row(
        ClaimClass::Decision,
        ActorClass::FirstPartyUser,
        AuthorshipDisposition::Direct,
        ClassPermission::Allow,
    ),
    // ── preference: the same floor ──
    row(
        ClaimClass::Preference,
        ActorClass::FirstPartyUser,
        AuthorshipDisposition::Direct,
        ClassPermission::Allow,
    ),
    // ── fact family ──
    row(
        ClaimClass::Fact,
        ActorClass::FirstPartyUser,
        AuthorshipDisposition::Direct,
        ClassPermission::Allow,
    ),
    row(
        ClaimClass::Fact,
        ActorClass::Assistant,
        AuthorshipDisposition::Direct,
        ClassPermission::Allow,
    ),
    row(
        ClaimClass::Fact,
        ActorClass::FirstPartyUser,
        AuthorshipDisposition::Quoted,
        ClassPermission::Weak,
    ),
    row(
        ClaimClass::Fact,
        ActorClass::FirstPartyUser,
        AuthorshipDisposition::Forwarded,
        ClassPermission::Weak,
    ),
    row(
        ClaimClass::Fact,
        ActorClass::FirstPartyUser,
        AuthorshipDisposition::Pasted,
        ClassPermission::Weak,
    ),
    row(
        ClaimClass::Fact,
        ActorClass::Assistant,
        AuthorshipDisposition::Quoted,
        ClassPermission::Weak,
    ),
    row(
        ClaimClass::Fact,
        ActorClass::Assistant,
        AuthorshipDisposition::Forwarded,
        ClassPermission::Weak,
    ),
    row(
        ClaimClass::Fact,
        ActorClass::Assistant,
        AuthorshipDisposition::Pasted,
        ClassPermission::Weak,
    ),
];

/// Matrix lookup. An absent tuple is [`ClassPermission::Deny`].
pub fn class_permission(
    class: ClaimClass,
    actor: ActorClass,
    authorship: AuthorshipDisposition,
) -> ClassPermission {
    CLASS_POLICY_V1
        .iter()
        .find(|r| r.class == class && r.actor == actor && r.authorship == authorship)
        .map(|r| r.permission)
        .unwrap_or(ClassPermission::Deny)
}

/// Server-derived record role → actor class. Never inferred from
/// content: `transcript.rs` reads the host's record structure, and
/// `receipts::SourceRole` is the persisted spelling of that reading.
pub fn actor_class(role: SourceRole) -> ActorClass {
    match role {
        SourceRole::User => ActorClass::FirstPartyUser,
        SourceRole::Assistant => ActorClass::Assistant,
        SourceRole::ToolResult => ActorClass::Tool,
        SourceRole::FileContent | SourceRole::WebContent => ActorClass::ExternalAuthor,
        SourceRole::SystemEvent => ActorClass::System,
    }
}

// ---------------------------------------------------------------------
// G07 — attribution template registry
// ---------------------------------------------------------------------

/// One binding template (spec §10 G07). Templates are policy data with
/// stable IDs, not ad hoc gate branches; the ID is what lands in the
/// receipt note (`"template:DEC_T1"`).
#[derive(Debug, Clone, Copy)]
pub struct AttributionTemplate {
    /// `PREF_T1`, `DEC_T2`, … — stable across epochs, never recycled.
    pub id: &'static str,
    pub class: ClaimClass,
    /// Matched against the **complete** server-extracted Primary
    /// sentence. Never a clipped span, never model-authored text.
    pub pattern: &'static str,
    /// The actor the template binds. Every V1 template binds the
    /// first-party user; that is the point of the narrow set.
    pub actor: ActorClass,
}

/// The V1 registry — deliberately narrow (spec §10 G07: "The first
/// template set is deliberately narrow").
///
/// **There is no fact template in V1, by design.** A mechanical binding
/// for arbitrary declarative prose does not exist, so the fact family
/// abstains into `RequireReview(ComplexSemantics)` rather than
/// pretending. That is the honest reading of "template failure does not
/// mean the claim is false; it means mechanical verification abstains",
/// and it is what makes red-team family 2 (property transfer) land on
/// review instead of a false pass.
pub const ATTRIBUTION_TEMPLATES_V1: &[AttributionTemplate] = &[
    AttributionTemplate {
        id: "PREF_T1",
        class: ClaimClass::Preference,
        // explicit first-party preference: "I prefer X", "I want X"
        pattern: r"(?i)\bi\s+(?:prefer|want|like|expect)\b",
        actor: ActorClass::FirstPartyUser,
    },
    AttributionTemplate {
        id: "PREF_T2",
        class: ClaimClass::Preference,
        // standing instruction: "always run X", "never merge without Y"
        pattern: r"(?i)(?:^|[.;!?]\s+|\band\s+)(?:please\s+)?(?:always|never)\s+[a-z]+",
        actor: ActorClass::FirstPartyUser,
    },
    AttributionTemplate {
        id: "DEC_T1",
        class: ClaimClass::Decision,
        // policy adoption: "From now on we deploy …" (guide §6.5 P1)
        pattern: r"(?i)^\s*(?:from now on|going forward|starting (?:now|today))\b.*\bwe\s+[a-z]+",
        actor: ActorClass::FirstPartyUser,
    },
    AttributionTemplate {
        id: "DEC_T2",
        class: ClaimClass::Decision,
        // explicit decision: "we decided to X", "we've agreed on X"
        pattern: r"(?i)\bwe(?:'ve|\s+have)?\s+(?:decided|agreed|settled)\s+(?:to|on|that)\b",
        actor: ActorClass::FirstPartyUser,
    },
    AttributionTemplate {
        id: "DEC_T3",
        class: ClaimClass::Decision,
        // adoption verb: "we're standardizing on X", "we are switching to X"
        pattern: r"(?i)\bwe(?:'re|\s+are)?\s+(?:standardi[sz]ing|switching|moving|migrating)\s+(?:on|to)\b",
        actor: ActorClass::FirstPartyUser,
    },
];

struct CompiledTemplate {
    template: AttributionTemplate,
    regex: Regex,
}

static COMPILED_TEMPLATES: Lazy<Vec<CompiledTemplate>> = Lazy::new(|| {
    ATTRIBUTION_TEMPLATES_V1
        .iter()
        .map(|template| CompiledTemplate {
            template: *template,
            regex: Regex::new(template.pattern).expect("template pattern must compile"),
        })
        .collect()
});

/// The first template of `class` whose pattern matches the complete
/// Primary sentence, with the actor it binds. `None` ⇒ mechanical
/// abstention, which G07 turns into review rather than a verdict.
pub fn match_attribution(class: ClaimClass, primary: &str) -> Option<(&'static str, ActorClass)> {
    COMPILED_TEMPLATES
        .iter()
        .find(|c| c.template.class == class && c.regex.is_match(primary))
        .map(|c| (c.template.id, c.template.actor))
}

// ---------------------------------------------------------------------
// G07/G08 — marker lists (POLICY_EPOCH-versioned data)
// ---------------------------------------------------------------------

/// Quoted / forwarded / pasted speech inside an otherwise first-party
/// record. A hit is `RequireReview(AmbiguousAttribution)`: the record
/// really is the user's, but the *claim* may be someone else's.
pub const QUOTATION_MARKERS: &[&str] = &[
    "wrote:",
    "writes:",
    "said:",
    "says:",
    "quote:",
    "forwarded",
    "fwd:",
    "pasted",
    "according to",
    "email from",
    "message from",
    "as per",
];

/// Polarity. A hit on one side only is a claim inversion.
pub const NEGATION_MARKERS: &[&str] = &[
    "not",
    "n't",
    "never",
    "no",
    "none",
    "cannot",
    "without",
    "neither",
    "nor",
    "avoid",
    "stop",
    "don't",
    "doesn't",
    "won't",
    "shouldn't",
    "can't",
];

/// Comparison, not inversion (spec §10 G08, as amended). "Tabs instead
/// of spaces" chooses between two options; it does not negate either.
/// The polarity rule below compares the *presence* of a negation marker
/// on each side, so a source that says "we use tabs, never spaces" and
/// a statement that says "tabs instead of spaces" look like a flip to
/// it. They are not, and V1 ships no typed rule that can tell which of
/// the two options a comparison selected — so the honest verdict is a
/// human, not a reject.
pub const COMPARISON_MARKERS: &[&str] = &["instead of", "rather than", "as opposed to", "versus"];

/// Modality — possible / desired / hypothetical rather than categorical.
pub const MODALITY_MARKERS: &[&str] = &[
    "might",
    "may",
    "could",
    "maybe",
    "perhaps",
    "possibly",
    "probably",
    "potentially",
    "considering",
    "thinking about",
    "we should",
    "should we",
    "proposed",
    "option",
    "idea",
    "wondering",
];

/// Conditionals and exceptions.
pub const CONDITIONAL_MARKERS: &[&str] = &[
    "unless",
    "except",
    "if",
    "provided that",
    "as long as",
    "in case",
    "otherwise",
    "only when",
    "only if",
    "depending on",
];

/// Completed state asserted by the *statement*.
pub const COMPLETION_MARKERS: &[&str] = &[
    "was",
    "were",
    "has been",
    "have been",
    "had been",
    "completed",
    "finished",
    "shipped",
    "already",
    "no longer",
];

/// Planned / future state asserted by the *source*.
pub const PLANNED_MARKERS: &[&str] = &[
    "will",
    "i'll",
    "we'll",
    "going to",
    "plan to",
    "plans to",
    "planning to",
    "tomorrow",
    "next week",
    "next month",
    "next quarter",
    "soon",
    "later",
    "might",
    "may",
    "could",
    "intend to",
];

/// Bounded-interval or historical scope.
pub const TEMPORAL_MARKERS: &[&str] = &[
    "used to",
    "previously",
    "formerly",
    "historically",
    "back then",
    "at the time",
    "until",
    "last year",
    "last month",
    "last quarter",
    "no longer",
    "for now",
    "temporarily",
];

/// Words ending in `ed` that are not past participles. Without this the
/// completed-state rule fires on "we need X" or "top speed".
pub const ED_EXCLUSIONS: &[&str] = &[
    "need", "speed", "feed", "seed", "indeed", "embed", "exceed", "proceed", "succeed", "red",
    "bed", "led", "fed", "wed", "shed", "sled", "bred", "fled", "shred", "spread", "thread",
    "ahead", "instead", "used", "based", "named", "called",
];

/// Word-boundary-aware marker search. Multi-word markers match as
/// substrings; single tokens must stand alone, so `"not"` does not fire
/// inside `"cannot"` and `"no"` does not fire inside `"note"`.
pub fn find_marker<'a>(text: &str, markers: &[&'a str]) -> Option<&'a str> {
    let haystack = text.to_ascii_lowercase();
    markers
        .iter()
        .copied()
        .find(|marker| contains_marker(&haystack, marker))
}

/// True iff `lowercased` contains `marker` as a standalone token
/// (single-word markers) or as a substring (phrases).
fn contains_marker(lowercased: &str, marker: &str) -> bool {
    if marker.contains(' ') {
        return lowercased.contains(marker);
    }
    let bytes = lowercased.as_bytes();
    let mut from = 0usize;
    while from < lowercased.len() {
        let Some(offset) = lowercased[from..].find(marker) else {
            return false;
        };
        let start = from + offset;
        let end = start + marker.len();
        let before_ok = start == 0 || !is_word_byte(bytes[start - 1]);
        let after_ok = end == bytes.len() || !is_word_byte(bytes[end]);
        if before_ok && after_ok {
            return true;
        }
        from = start + 1;
    }
    false
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'\''
}

/// A past participle in `statement` that `source` never used — the
/// mechanical half of "planned work represented as completed work".
pub fn introduces_past_participle(statement: &str, source: &str) -> Option<String> {
    static PARTICIPLE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"\b[a-z]{3,}ed\b").expect("participle pattern must compile"));
    let source_lower = source.to_ascii_lowercase();
    let statement_lower = statement.to_ascii_lowercase();
    PARTICIPLE
        .find_iter(&statement_lower)
        .map(|m| m.as_str().to_string())
        .find(|token| {
            !ED_EXCLUSIONS.contains(&token.as_str())
                && !contains_marker(&source_lower, token.as_str())
        })
}

// ---------------------------------------------------------------------
// protected tokens (G05 coverage + G06 lexical integrity)
// ---------------------------------------------------------------------

/// The seven protected classes of spec §10 G06.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenClass {
    Numbers,
    Times,
    Dates,
    Versions,
    Identifiers,
    Names,
    Units,
}

impl TokenClass {
    /// Closed, receipt-safe label.
    pub fn as_str(self) -> &'static str {
        match self {
            TokenClass::Numbers => "numbers",
            TokenClass::Times => "times",
            TokenClass::Dates => "dates",
            TokenClass::Versions => "versions",
            TokenClass::Identifiers => "identifiers",
            TokenClass::Names => "names",
            TokenClass::Units => "units",
        }
    }
}

/// Deterministic protected-token extraction over one text.
///
/// Sets are `BTreeSet`s so iteration order is content-defined, never
/// hash-defined: identity and receipts must not depend on allocator
/// behaviour (guide §7.2(3)).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProtectedTokens {
    pub numbers: BTreeSet<String>,
    pub times: BTreeSet<String>,
    pub dates: BTreeSet<String>,
    pub versions: BTreeSet<String>,
    pub identifiers: BTreeSet<String>,
    pub names: BTreeSet<String>,
    pub units: BTreeSet<String>,
}

impl ProtectedTokens {
    /// The seven classes in a fixed order — what G05 and G06 iterate.
    pub const CLASSES: [TokenClass; 7] = [
        TokenClass::Times,
        TokenClass::Dates,
        TokenClass::Versions,
        TokenClass::Identifiers,
        TokenClass::Units,
        TokenClass::Numbers,
        TokenClass::Names,
    ];

    fn set_mut(&mut self, class: TokenClass) -> &mut BTreeSet<String> {
        match class {
            TokenClass::Numbers => &mut self.numbers,
            TokenClass::Times => &mut self.times,
            TokenClass::Dates => &mut self.dates,
            TokenClass::Versions => &mut self.versions,
            TokenClass::Identifiers => &mut self.identifiers,
            TokenClass::Names => &mut self.names,
            TokenClass::Units => &mut self.units,
        }
    }

    pub fn set(&self, class: TokenClass) -> &BTreeSet<String> {
        match class {
            TokenClass::Numbers => &self.numbers,
            TokenClass::Times => &self.times,
            TokenClass::Dates => &self.dates,
            TokenClass::Versions => &self.versions,
            TokenClass::Identifiers => &self.identifiers,
            TokenClass::Names => &self.names,
            TokenClass::Units => &self.units,
        }
    }

    pub fn is_empty(&self) -> bool {
        Self::CLASSES.iter().all(|c| self.set(*c).is_empty())
    }

    pub fn len(&self) -> usize {
        Self::CLASSES.iter().map(|c| self.set(*c).len()).sum()
    }

    /// Every token, class-tagged, in [`Self::CLASSES`] order.
    pub fn iter(&self) -> impl Iterator<Item = (TokenClass, &String)> {
        Self::CLASSES
            .iter()
            .flat_map(move |class| self.set(*class).iter().map(move |token| (*class, token)))
    }

    /// How many of `self`'s tokens appear in `other`, class for class.
    /// This is G05's coverage measure.
    pub fn covered_by(&self, other: &ProtectedTokens) -> usize {
        self.iter()
            .filter(|(class, token)| other.set(*class).contains(*token))
            .count()
    }

    /// True iff every token of `self` appears in `other`.
    pub fn fully_covered_by(&self, other: &ProtectedTokens) -> bool {
        self.covered_by(other) == self.len()
    }

    /// Union in place — G05's "does the union of the citation cover it".
    pub fn absorb(&mut self, other: &ProtectedTokens) {
        for class in Self::CLASSES {
            let tokens: Vec<String> = other.set(class).iter().cloned().collect();
            self.set_mut(class).extend(tokens);
        }
    }
}

struct TokenPattern {
    class: TokenClass,
    regex: Regex,
    /// Capture group to take (0 = the whole match).
    group: usize,
}

/// Ordered: an earlier pattern consumes the bytes, so `03:30` is one
/// time token rather than the numbers `03` and `30`, and `March 14` is
/// one date rather than a name plus a number.
static TOKEN_PATTERNS: Lazy<Vec<TokenPattern>> = Lazy::new(|| {
    let compile = |class: TokenClass, pattern: &str, group: usize| TokenPattern {
        class,
        regex: Regex::new(pattern).expect("token pattern must compile"),
        group,
    };
    vec![
        // clock times, seconds optional
        compile(TokenClass::Times, r"\b\d{1,2}:\d{2}(?::\d{2})?\b", 0),
        // ISO dates
        compile(TokenClass::Dates, r"\b\d{4}-\d{2}-\d{2}\b", 0),
        // "March 14", "Mar 14, 2026"
        compile(
            TokenClass::Dates,
            r"\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\.?\s+\d{1,2}(?:,\s*\d{4})?\b",
            0,
        ),
        // weekdays and months standing alone ("Tuesdays", "March")
        compile(
            TokenClass::Dates,
            r"\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)s?\b",
            0,
        ),
        compile(
            TokenClass::Dates,
            r"\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b",
            0,
        ),
        // explicit versions
        compile(TokenClass::Versions, r"\b[vV]\d+(?:\.\d+)*\b", 0),
        compile(TokenClass::Versions, r"\b\d+\.\d+(?:\.\d+)*\b", 0),
        // "PostgreSQL 16" — the 16 is a version, not a loose number
        compile(
            TokenClass::Versions,
            r"\b[A-Z][A-Za-z]*[A-Za-z0-9]\s+(\d+(?:\.\d+)*)\b",
            1,
        ),
        // identifiers and code symbols — case- and form-sensitive
        // (spec §12.5 canonicalization is case-preserving for these)
        compile(
            TokenClass::Identifiers,
            r"\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b",
            0,
        ),
        compile(
            TokenClass::Identifiers,
            r"\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b",
            0,
        ),
        compile(TokenClass::Identifiers, r"\b[a-z]+(?:[A-Z][a-z0-9]*)+\b", 0),
        compile(
            TokenClass::Identifiers,
            r"\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]+)+\b",
            0,
        ),
        // typed quantities and bare unit words
        compile(
            TokenClass::Units,
            r"\b\d+(?:\.\d+)?\s?(?:ms|GB|MB|KB|TB|kg|km|rpm|fps)\b",
            0,
        ),
        compile(TokenClass::Units, r"\b\d+(?:\.\d+)?%", 0),
        compile(
            TokenClass::Units,
            r"\b(?:UTC|GMT|CET|PST|EST|GB|MB|KB|TB|KiB|MiB|GiB|USD|EUR|GBP)\b",
            0,
        ),
        // whatever numbers survive
        compile(TokenClass::Numbers, r"[-+]?\b\d+(?:\.\d+)?\b", 0),
        // proper-name candidates: Capitalized, at least one lowercase
        // letter (so ALL-CAPS units never land here), and not
        // sentence-initial — see `extract_protected`.
        compile(TokenClass::Names, r"\b[A-Z][a-z][A-Za-z]*\b", 0),
    ]
});

/// Deterministic protected-token extractor (guide §3.3).
///
/// **Sentence-initial capitalized words are not names.** Capitalization
/// at a sentence boundary is grammar, not evidence: treating "Deploys
/// happen Fridays." as introducing a proper name "Deploys" would make
/// ordinary paraphrase a `LiteralMismatch`. The cost is that an
/// introduced name in sentence-initial position is caught by G07's
/// binding check rather than G06's literal check — a documented V1
/// limitation, and part of why G07 exists (red-team family 1, where G06
/// passes *by design* because both names are verbatim).
pub fn extract_protected(text: &str) -> ProtectedTokens {
    let mut tokens = ProtectedTokens::default();
    let mut consumed: Vec<(usize, usize)> = Vec::new();
    for pattern in TOKEN_PATTERNS.iter() {
        for captures in pattern.regex.captures_iter(text) {
            let Some(matched) = captures.get(pattern.group) else {
                continue;
            };
            let (start, end) = (matched.start(), matched.end());
            if consumed.iter().any(|(s, e)| start < *e && *s < end) {
                continue;
            }
            if pattern.class == TokenClass::Names && is_sentence_initial(text, start) {
                continue;
            }
            consumed.push((start, end));
            tokens
                .set_mut(pattern.class)
                .insert(matched.as_str().to_string());
        }
    }
    tokens
}

/// True when the token at `start` opens the text or follows a sentence
/// terminator (`.`, `!`, `?`, `:`, `;`).
fn is_sentence_initial(text: &str, start: usize) -> bool {
    let mut cursor = start;
    while cursor > 0 {
        let previous = text[..cursor]
            .chars()
            .next_back()
            .expect("cursor > 0 implies a previous char");
        if previous.is_whitespace() {
            cursor -= previous.len_utf8();
            continue;
        }
        return matches!(previous, '.' | '!' | '?' | ':' | ';');
    }
    true
}

// ---------------------------------------------------------------------
// alias table
// ---------------------------------------------------------------------

/// Exact, hand-curated equivalences. An alias is **never proof** — a
/// hit is `RequireReview(AliasOrParaphrase)` — which is why ambiguous
/// values ("3.30" ≈ "03:30") must never appear here. No clock time, no
/// number, no version, no unit conversion: only names and identifiers
/// whose equivalence is a naming convention rather than a computation
/// (spec §10 G06: "An alias table must never silently equate ambiguous
/// values"; typed unit conversion is dimension-aware and V1 ships no
/// conversion table at all, so a converted value lands in G06's
/// introduced-token branch and is rejected).
pub const ALIAS_TABLE_V1: &[(TokenClass, &str, &str)] = &[
    (TokenClass::Names, "Postgres", "PostgreSQL"),
    (TokenClass::Names, "Psql", "PostgreSQL"),
    (TokenClass::Names, "Mongo", "MongoDB"),
    (TokenClass::Names, "Kube", "Kubernetes"),
    (TokenClass::Names, "Js", "JavaScript"),
    (TokenClass::Names, "Ts", "TypeScript"),
    (TokenClass::Names, "Py", "Python"),
    (TokenClass::Identifiers, "k8s", "kubernetes"),
];

/// True iff `token` has an exact alias entry, in the same class, whose
/// counterpart appears in `source`.
pub fn alias_equivalent(class: TokenClass, token: &str, source: &BTreeSet<String>) -> bool {
    ALIAS_TABLE_V1.iter().any(|(c, left, right)| {
        *c == class
            && ((*left == token && source.contains(*right))
                || (*right == token && source.contains(*left)))
    })
}

// ---------------------------------------------------------------------
// anchors (G04 correlated evidence, G07 binding order, claim topics)
// ---------------------------------------------------------------------

/// Function words that carry no correlation signal. Pinned by test:
/// adding one changes what "shares an anchor" means, which is a
/// [`POLICY_EPOCH`] change.
pub const STOPWORDS: &[&str] = &[
    "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "had", "her", "was",
    "one", "our", "out", "day", "get", "has", "him", "his", "how", "man", "new", "now", "old",
    "see", "two", "way", "who", "boy", "did", "its", "let", "put", "say", "she", "too", "use",
    "with", "that", "this", "from", "they", "will", "would", "there", "their", "what", "about",
    "which", "when", "make", "like", "time", "just", "know", "take", "into", "your", "some",
    "them", "than", "then", "only", "also", "back", "after", "other", "these", "those", "want",
    "because", "very", "well", "even", "still", "should", "could", "might", "must", "shall",
    "does", "done", "each", "such", "were", "been", "being", "have", "here", "over", "under",
    "again", "more", "most", "much", "many", "same", "both", "every", "please", "yes", "say",
    "before", "while", "where", "why", "who", "whom", "whose", "onto", "upon", "per", "via",
];

/// One anchor occurrence: the lowercased token and where it started.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Anchor {
    pub token: String,
    pub start: usize,
}

/// Anchor entities in order of first byte — lowercased protected
/// tokens plus content words (≥3 chars, not a stopword).
///
/// Order is load-bearing for G07's binding check; the set form is what
/// G04 correlates and what a claim topic is built from.
pub fn ordered_anchors(text: &str) -> Vec<Anchor> {
    static WORD: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"[A-Za-z][A-Za-z0-9_-]*").expect("word pattern must compile"));
    let protected = extract_protected(text);
    let mut anchors: Vec<Anchor> = Vec::new();
    let mut consumed: Vec<(usize, usize)> = Vec::new();

    // protected tokens first, located at their first free occurrence
    for (_, token) in protected.iter() {
        let mut from = 0usize;
        while from <= text.len().saturating_sub(token.len()) {
            let Some(offset) = text[from..].find(token.as_str()) else {
                break;
            };
            let start = from + offset;
            let end = start + token.len();
            if !consumed.iter().any(|(s, e)| start < *e && *s < end) {
                consumed.push((start, end));
                anchors.push(Anchor {
                    token: token.to_ascii_lowercase(),
                    start,
                });
                break;
            }
            from = start + 1;
        }
    }

    for matched in WORD.find_iter(text) {
        let (start, end) = (matched.start(), matched.end());
        if consumed.iter().any(|(s, e)| start < *e && *s < end) {
            continue;
        }
        let token = matched.as_str().to_ascii_lowercase();
        if token.len() < 3 || STOPWORDS.contains(&token.as_str()) {
            continue;
        }
        anchors.push(Anchor { token, start });
    }

    anchors.sort_by_key(|anchor| anchor.start);
    anchors
}

/// Set form of [`ordered_anchors`].
pub fn anchor_entities(text: &str) -> BTreeSet<String> {
    ordered_anchors(text)
        .into_iter()
        .map(|anchor| anchor.token)
        .collect()
}

/// [`anchor_entities`] plus exact ASCII all-uppercase acronym tokens,
/// lowercased, stopwords excluded — the set G04 correlates with.
///
/// Why a second set instead of widening the first: [`ordered_anchors`]
/// drops tokens under three bytes, which is right for binding order (a
/// two-letter word carries no reliable role) and right for claim
/// topics (identity must not churn on noise), but wrong for
/// correlation. `DB`, `CI`, `UI`, `S3` are the ordinary vocabulary of
/// the transcripts this runs over, and a claim that shares one with its
/// citation is *related to it*. Spec §10 G04, as amended: "correlation
/// anchors include exact ASCII all-uppercase acronym tokens, so common
/// technical acronyms correlate rather than false-reject."
///
/// Correlation only. Binding order, protected tokens and claim-topic
/// identity all read [`ordered_anchors`] and are deliberately unchanged
/// — this set widens what counts as *related*, never what counts as
/// verbatim, ordered, or the same claim.
pub fn correlation_anchors(text: &str) -> BTreeSet<String> {
    static ACRONYM: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"\b[A-Z][A-Z0-9]{1,15}\b").expect("acronym pattern must compile"));
    let mut anchors = anchor_entities(text);
    for matched in ACRONYM.find_iter(text) {
        let token = matched.as_str().to_ascii_lowercase();
        if STOPWORDS.contains(&token.as_str()) {
            continue;
        }
        anchors.insert(token);
    }
    anchors
}

/// G04's correlated-evidence test: does this sentence relate to the
/// claim at all? Kills "verbatim but irrelevant" citations — the
/// residual failure mode sentence IDs do not fix by themselves.
///
/// `anchors` must come from [`correlation_anchors`]; the sentence side
/// is derived here so both halves are read under the same rule.
pub fn shares_anchor(anchors: &BTreeSet<String>, text: &str) -> bool {
    !anchors.is_disjoint(&correlation_anchors(text))
}

/// Greedy subsequence test over the anchors the statement and the
/// source share. A statement that reorders shared anchors relative to
/// the source has moved a binding ("Alice owns billing; Bob owns auth"
/// → "Bob owns billing"); order-preserving reuse has not.
///
/// Greedy matching decides subsequence existence exactly, so the only
/// heuristic here is the claim that order encodes binding — which is
/// why a failure rejects inside G07 only, and only alongside the class
/// policy and the template registry.
pub fn preserves_binding_order(statement: &str, source: &str) -> bool {
    let source_anchors = ordered_anchors(source);
    let source_set: BTreeSet<&str> = source_anchors
        .iter()
        .map(|anchor| anchor.token.as_str())
        .collect();
    let shared: Vec<String> = ordered_anchors(statement)
        .into_iter()
        .filter(|anchor| source_set.contains(anchor.token.as_str()))
        .map(|anchor| anchor.token)
        .collect();
    let mut cursor = 0usize;
    for token in shared {
        match source_anchors[cursor..]
            .iter()
            .position(|anchor| anchor.token == token)
        {
            Some(offset) => cursor += offset + 1,
            None => return false,
        }
    }
    true
}

/// Normalized claim topic: the statement's anchor set, sorted and
/// space-joined. Wording-robust enough that two phrasings of one claim
/// share a `claim_key`, deterministic enough that identity replays.
pub fn topic(text: &str) -> String {
    anchor_entities(text)
        .into_iter()
        .collect::<Vec<_>>()
        .join(" ")
}

// ---------------------------------------------------------------------
// G09 — sensitive screen (defence in depth, after pre-model redaction)
// ---------------------------------------------------------------------

/// Closed, receipt-safe labels for what G09 found. The value itself is
/// never recorded — that is the whole point of the gate.
pub const SENSITIVE_CLASSES: &[&str] = &[
    "private_path",
    "credential",
    "bearer_token",
    "key_value_secret",
    "high_entropy",
];

struct SensitivePattern {
    class: &'static str,
    regex: Regex,
    entropy_screen: bool,
}

static SENSITIVE_PATTERNS: Lazy<Vec<SensitivePattern>> = Lazy::new(|| {
    let compile = |class: &'static str, pattern: &str, entropy_screen: bool| SensitivePattern {
        class,
        regex: Regex::new(pattern).expect("sensitive pattern must compile"),
        entropy_screen,
    };
    vec![
        // Home-relative and absolute user paths. REDACT_V1 does not
        // touch these (they are not secrets by shape), which is exactly
        // why G09 is defence in depth rather than a duplicate layer.
        compile(
            "private_path",
            r"(?:/Users/|/home/|/var/folders/|[A-Z]:\\Users\\|~/\.)[A-Za-z0-9._-]+",
            false,
        ),
        compile(
            "credential",
            r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b",
            false,
        ),
        compile("credential", r"\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b", false),
        compile("credential", r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b", false),
        compile("credential", r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b", false),
        compile("credential", r"-----BEGIN [A-Z0-9 ]{1,64}-----", false),
        compile(
            "bearer_token",
            r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{8,}",
            false,
        ),
        compile(
            "key_value_secret",
            r#"(?i)\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\b\s*[=:]\s*["']?[^\s"',;]{6,}"#,
            false,
        ),
        compile("high_entropy", r"\b[A-Za-z0-9+/=_-]{32,}\b", true),
    ]
});

/// Shannon entropy in bits per character.
///
/// Deliberately a local copy of REDACT_V1's screen rather than a shared
/// helper: G09 is *defence in depth*, and one shared implementation
/// would mean one bug disables both layers at once. The float is only
/// ever compared to a fixed threshold — never stored, never hashed.
fn shannon_entropy(text: &str) -> f64 {
    let mut counts: BTreeMap<char, usize> = BTreeMap::new();
    let mut total = 0usize;
    for character in text.chars() {
        *counts.entry(character).or_insert(0) += 1;
        total += 1;
    }
    if total == 0 {
        return 0.0;
    }
    let total_f = total as f64;
    counts.values().fold(0.0, |entropy, count| {
        let probability = *count as f64 / total_f;
        entropy - probability * probability.log2()
    })
}

fn looks_high_entropy(text: &str) -> bool {
    let has_digit = text.chars().any(|c| c.is_ascii_digit());
    let has_alpha = text.chars().any(|c| c.is_ascii_alphabetic());
    let all_hex = text.chars().all(|c| c.is_ascii_hexdigit());
    if all_hex && has_digit && text.len() >= 32 {
        return true;
    }
    has_digit && has_alpha && shannon_entropy(text) >= 3.5
}

/// The closed class label of the first sensitive hit, or `None`.
pub fn sensitive_hit(text: &str) -> Option<&'static str> {
    SENSITIVE_PATTERNS.iter().find_map(|pattern| {
        pattern.regex.find_iter(text).find_map(|matched| {
            if pattern.entropy_screen && !looks_high_entropy(matched.as_str()) {
                return None;
            }
            Some(pattern.class)
        })
    })
}

// ---------------------------------------------------------------------
// tests — the regression half of "policy data is versioned"
// ---------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ── epoch pinning ────────────────────────────────────────────────

    #[test]
    fn policy_epoch_is_pinned() {
        // Changing this without changing the tables below is a mistake;
        // changing the tables without changing this is a worse one
        // (spec §10 G08: "Every data change requires regression
        // fixtures and a policy epoch bump").
        assert_eq!(POLICY_EPOCH, "2026-08-vp2");
    }

    #[test]
    fn epoch_contents_are_pinned() {
        assert_eq!(CLASS_POLICY_V1.len(), 10, "class matrix row count");
        assert_eq!(ATTRIBUTION_TEMPLATES_V1.len(), 5, "template registry size");
        assert_eq!(ALIAS_TABLE_V1.len(), 8, "alias table size");
        assert_eq!(QUOTATION_MARKERS.len(), 12);
        assert_eq!(NEGATION_MARKERS.len(), 16);
        assert_eq!(COMPARISON_MARKERS.len(), 4);
        assert_eq!(MODALITY_MARKERS.len(), 16);
        assert_eq!(CONDITIONAL_MARKERS.len(), 10);
        assert_eq!(COMPLETION_MARKERS.len(), 10);
        assert_eq!(PLANNED_MARKERS.len(), 17);
        assert_eq!(TEMPORAL_MARKERS.len(), 13);
        assert_eq!(ED_EXCLUSIONS.len(), 27);
        assert_eq!(SENSITIVE_CLASSES.len(), 5);
        assert_eq!(TOKEN_PATTERNS.len(), 17);
    }

    #[test]
    fn template_ids_are_stable_and_unique() {
        let ids: Vec<&str> = ATTRIBUTION_TEMPLATES_V1.iter().map(|t| t.id).collect();
        assert_eq!(
            ids,
            vec!["PREF_T1", "PREF_T2", "DEC_T1", "DEC_T2", "DEC_T3"]
        );
        let unique: BTreeSet<&str> = ids.iter().copied().collect();
        assert_eq!(unique.len(), ids.len());
        assert_eq!(COMPILED_TEMPLATES.len(), ATTRIBUTION_TEMPLATES_V1.len());
    }

    #[test]
    fn claim_classes_map_to_closed_actions() {
        for class in [
            ClaimClass::Fact,
            ClaimClass::Preference,
            ClaimClass::Decision,
        ] {
            assert!(CURATOR_ACTIONS.contains(&class.action()));
            assert_eq!(ClaimClass::parse(class.as_str()), Some(class));
        }
        assert_eq!(ClaimClass::parse("summary"), None);
        assert_eq!(ClaimClass::parse("FACT"), None);
    }

    #[test]
    fn only_curator_actions_are_non_destructive() {
        assert!(!action_is_destructive("curator_remember_decision"));
        assert!(action_is_destructive("curator_delete_engram"));
    }

    // ── CLASS_POLICY_V1 ──────────────────────────────────────────────

    #[test]
    fn decision_and_preference_require_first_party_direct() {
        for class in [ClaimClass::Decision, ClaimClass::Preference] {
            assert_eq!(
                class_permission(
                    class,
                    ActorClass::FirstPartyUser,
                    AuthorshipDisposition::Direct
                ),
                ClassPermission::Allow
            );
            for actor in [
                ActorClass::Assistant,
                ActorClass::Tool,
                ActorClass::ExternalAuthor,
                ActorClass::System,
                ActorClass::Unknown,
            ] {
                assert_eq!(
                    class_permission(class, actor, AuthorshipDisposition::Direct),
                    ClassPermission::Deny,
                    "{class:?} must not accept {actor:?}"
                );
            }
            for authorship in [
                AuthorshipDisposition::Quoted,
                AuthorshipDisposition::Forwarded,
                AuthorshipDisposition::Pasted,
                AuthorshipDisposition::Mixed,
                AuthorshipDisposition::Unknown,
            ] {
                assert_eq!(
                    class_permission(class, ActorClass::FirstPartyUser, authorship),
                    ClassPermission::Deny,
                    "{class:?} must not accept {authorship:?}"
                );
            }
        }
    }

    #[test]
    fn fact_family_accepts_user_and_assistant_direct_without_a_flag() {
        for actor in [ActorClass::FirstPartyUser, ActorClass::Assistant] {
            assert_eq!(
                class_permission(ClaimClass::Fact, actor, AuthorshipDisposition::Direct),
                ClassPermission::Allow
            );
        }
    }

    #[test]
    fn fact_family_flags_quoted_and_denies_third_party() {
        assert_eq!(
            class_permission(
                ClaimClass::Fact,
                ActorClass::Assistant,
                AuthorshipDisposition::Quoted
            ),
            ClassPermission::Weak
        );
        for actor in [
            ActorClass::Tool,
            ActorClass::ExternalAuthor,
            ActorClass::System,
            ActorClass::Unknown,
        ] {
            assert_eq!(
                class_permission(ClaimClass::Fact, actor, AuthorshipDisposition::Direct),
                ClassPermission::Deny,
                "the assistant allowance must not be inherited by {actor:?}"
            );
        }
        assert_eq!(
            class_permission(
                ClaimClass::Fact,
                ActorClass::FirstPartyUser,
                AuthorshipDisposition::Mixed
            ),
            ClassPermission::Deny
        );
    }

    #[test]
    fn actor_class_is_a_total_map_of_source_roles() {
        assert_eq!(actor_class(SourceRole::User), ActorClass::FirstPartyUser);
        assert_eq!(actor_class(SourceRole::Assistant), ActorClass::Assistant);
        assert_eq!(actor_class(SourceRole::ToolResult), ActorClass::Tool);
        assert_eq!(
            actor_class(SourceRole::FileContent),
            ActorClass::ExternalAuthor
        );
        assert_eq!(
            actor_class(SourceRole::WebContent),
            ActorClass::ExternalAuthor
        );
        assert_eq!(actor_class(SourceRole::SystemEvent), ActorClass::System);
    }

    // ── G07 templates: positive, negative, near-miss ──────────────────

    #[test]
    fn dec_t1_matches_the_worked_fixture_sentence() {
        let (id, actor) = match_attribution(
            ClaimClass::Decision,
            "From now on we deploy Atlas only on Tuesdays.",
        )
        .expect("DEC_T1 must match the guide §6.5 primary");
        assert_eq!(id, "DEC_T1");
        assert_eq!(actor, ActorClass::FirstPartyUser);
    }

    #[test]
    fn templates_are_class_scoped() {
        // near miss: the right sentence, the wrong class
        assert!(match_attribution(
            ClaimClass::Fact,
            "From now on we deploy Atlas only on Tuesdays."
        )
        .is_none());
    }

    #[test]
    fn decision_templates_cover_the_named_shapes() {
        assert_eq!(
            match_attribution(
                ClaimClass::Decision,
                "We decided to drop the legacy exporter."
            )
            .map(|m| m.0),
            Some("DEC_T2")
        );
        assert_eq!(
            match_attribution(
                ClaimClass::Decision,
                "We're standardizing on PostgreSQL 16 for every new service."
            )
            .map(|m| m.0),
            Some("DEC_T3")
        );
    }

    #[test]
    fn preference_templates_cover_the_named_shapes() {
        assert_eq!(
            match_attribution(ClaimClass::Preference, "I prefer tabs over spaces.").map(|m| m.0),
            Some("PREF_T1")
        );
        assert_eq!(
            match_attribution(
                ClaimClass::Preference,
                "And always run migrations behind a feature flag."
            )
            .map(|m| m.0),
            Some("PREF_T2")
        );
    }

    #[test]
    fn no_template_matches_ordinary_declarative_prose() {
        // the honest abstention: the fact family has no V1 template
        for class in [
            ClaimClass::Fact,
            ClaimClass::Preference,
            ClaimClass::Decision,
        ] {
            assert!(
                match_attribution(class, "The staging cron still runs at 03:30 UTC.").is_none(),
                "{class:?} must abstain on plain declarative prose"
            );
        }
    }

    // ── markers ──────────────────────────────────────────────────────

    #[test]
    fn single_word_markers_respect_word_boundaries() {
        assert_eq!(
            find_marker("Do not use the exporter.", NEGATION_MARKERS),
            Some("not")
        );
        // "moot" must not fire the bare "no"/"not" markers
        assert_eq!(find_marker("This is a moot point.", NEGATION_MARKERS), None);
        assert_eq!(
            find_marker("We might switch.", MODALITY_MARKERS),
            Some("might")
        );
        assert_eq!(
            find_marker("We used to deploy Fridays.", TEMPORAL_MARKERS),
            Some("used to")
        );
    }

    /// Ruling 3 (Wave 4c): positive, role-reversal and near-miss for the
    /// newest marker list, in the shape spec §10 demands of every
    /// `POLICY_EPOCH` data change.
    #[test]
    fn comparison_markers_are_phrases_and_never_fire_inside_a_word() {
        assert_eq!(
            find_marker("Tabs are used instead of spaces.", COMPARISON_MARKERS),
            Some("instead of")
        );
        assert_eq!(
            find_marker("We picked pnpm rather than npm.", COMPARISON_MARKERS),
            Some("rather than")
        );
        assert_eq!(
            find_marker("Run the canary A versus B.", COMPARISON_MARKERS),
            Some("versus")
        );
        assert_eq!(
            find_marker(
                "Ship the exporter as opposed to the importer.",
                COMPARISON_MARKERS
            ),
            Some("as opposed to")
        );
        // near miss: the bare adverb is not a comparison…
        assert_eq!(
            find_marker("We shipped the exporter instead.", COMPARISON_MARKERS),
            None
        );
        // …and a marker buried in an identifier or code literal is not
        // one either, exactly as the other single-token lists behave.
        assert_eq!(
            find_marker(
                "The flag is renderer_versus_shim today.",
                COMPARISON_MARKERS
            ),
            None
        );
    }

    #[test]
    fn the_worked_fixture_primary_carries_no_state_markers() {
        let primary = "From now on we deploy Atlas only on Tuesdays.";
        assert_eq!(find_marker(primary, NEGATION_MARKERS), None);
        assert_eq!(find_marker(primary, MODALITY_MARKERS), None);
        assert_eq!(find_marker(primary, CONDITIONAL_MARKERS), None);
        assert_eq!(find_marker(primary, TEMPORAL_MARKERS), None);
        let statement = "Atlas deploys only on Tuesdays.";
        assert_eq!(find_marker(statement, COMPLETION_MARKERS), None);
        assert_eq!(introduces_past_participle(statement, primary), None);
    }

    #[test]
    fn introduced_past_participles_are_detected_and_excluded() {
        assert_eq!(
            introduces_past_participle("The DB was migrated.", "I'll migrate the DB tomorrow."),
            Some("migrated".to_string())
        );
        // already present in the source ⇒ not introduced
        assert_eq!(
            introduces_past_participle("The DB was migrated.", "The DB was migrated last night."),
            None
        );
        // the exclusion list keeps ordinary vocabulary out
        assert_eq!(
            introduces_past_participle("We need the exporter.", "I'll fix it tomorrow."),
            None
        );
    }

    // ── protected tokens ─────────────────────────────────────────────

    #[test]
    fn times_are_one_token_not_two_numbers() {
        let tokens = extract_protected("The staging cron still runs at 03:30 UTC.");
        assert_eq!(tokens.times, ["03:30".to_string()].into_iter().collect());
        assert!(
            tokens.numbers.is_empty(),
            "03 and 30 must not leak as numbers: {tokens:?}"
        );
        assert_eq!(tokens.units, ["UTC".to_string()].into_iter().collect());
    }

    #[test]
    fn the_worked_fixture_tokens_match_the_guide_walk() {
        let s1 = extract_protected("From now on we deploy Atlas only on Tuesdays.");
        assert!(s1.names.contains("Atlas"), "{s1:?}");
        assert!(s1.dates.contains("Tuesdays"), "{s1:?}");
        let statement = extract_protected("Atlas deploys only on Tuesdays.");
        assert!(statement.dates.contains("Tuesdays"));
        // "Atlas" is sentence-initial in the statement, so it is not a
        // name token — the documented extractor rule. G06 still passes,
        // which is what the §6.5 walk asserts.
        assert!(statement.names.is_empty(), "{statement:?}");
        assert!(statement.fully_covered_by(&s1));
    }

    #[test]
    fn the_worked_fixture_mutation_is_an_introduced_time_token() {
        let s6 = extract_protected(
            "The staging cron still runs at 03:30 UTC, so the Tuesday deploy window opens after 04:00.",
        );
        let statement = extract_protected("The staging cron runs at 03:00 UTC.");
        assert_eq!(statement.times, ["03:00".to_string()].into_iter().collect());
        assert!(!s6.times.contains("03:00"));
        assert!(!statement.fully_covered_by(&s6));
    }

    #[test]
    fn identifiers_are_case_and_form_sensitive() {
        let source = extract_protected("Always call foo_bar() from the adapter.");
        let statement = extract_protected("The adapter should call fooBar().");
        assert!(source.identifiers.contains("foo_bar"), "{source:?}");
        assert!(statement.identifiers.contains("fooBar"), "{statement:?}");
        assert!(!statement.fully_covered_by(&source));
    }

    #[test]
    fn versions_capture_the_product_number() {
        let tokens = extract_protected("We're standardizing on PostgreSQL 16 for new services.");
        assert!(tokens.versions.contains("16"), "{tokens:?}");
        let dotted = extract_protected("Upgrade to v2.1.0 before Friday.");
        assert!(dotted.versions.contains("v2.1.0"), "{dotted:?}");
    }

    #[test]
    fn dates_absorb_weekdays_and_months() {
        let tokens = extract_protected("Ship it on March 14, not on Fridays.");
        assert!(tokens.dates.contains("March 14"), "{tokens:?}");
        assert!(tokens.dates.contains("Fridays"), "{tokens:?}");
    }

    #[test]
    fn sentence_initial_capitals_are_not_names() {
        let tokens = extract_protected("Deploys happen Fridays. Atlas is the exception.");
        assert!(!tokens.names.contains("Deploys"));
        assert!(
            !tokens.names.contains("Atlas"),
            "post-terminator capitals are sentence-initial too: {tokens:?}"
        );
    }

    #[test]
    fn coverage_is_class_for_class_and_unions_compose() {
        let statement = extract_protected("The window opens after 04:00.");
        let a = extract_protected("The staging cron runs at 03:30 UTC.");
        let b = extract_protected("The deploy window opens after 04:00.");
        assert!(!statement.fully_covered_by(&a));
        assert!(statement.fully_covered_by(&b));
        let mut union = a.clone();
        union.absorb(&b);
        assert!(statement.fully_covered_by(&union));
    }

    #[test]
    fn extraction_is_deterministic() {
        let text = "Atlas deploys at 03:30 UTC on Tuesdays, per foo_bar v2.1.";
        let first = extract_protected(text);
        for _ in 0..8 {
            assert_eq!(extract_protected(text), first);
        }
    }

    // ── alias table ──────────────────────────────────────────────────

    #[test]
    fn aliases_are_exact_and_class_scoped() {
        let source: BTreeSet<String> = ["PostgreSQL".to_string()].into_iter().collect();
        assert!(alias_equivalent(TokenClass::Names, "Postgres", &source));
        assert!(!alias_equivalent(
            TokenClass::Identifiers,
            "Postgres",
            &source
        ));
        assert!(!alias_equivalent(TokenClass::Names, "MySQL", &source));
    }

    #[test]
    fn no_alias_entry_may_equate_a_time_number_version_or_unit() {
        for (class, _, _) in ALIAS_TABLE_V1 {
            assert!(
                matches!(class, TokenClass::Names | TokenClass::Identifiers),
                "ambiguous-value classes must never appear in the alias table"
            );
        }
        let source: BTreeSet<String> = ["03:30".to_string()].into_iter().collect();
        assert!(!alias_equivalent(TokenClass::Times, "3.30", &source));
        assert!(!alias_equivalent(TokenClass::Times, "03:00", &source));
    }

    // ── anchors ──────────────────────────────────────────────────────

    #[test]
    fn anchors_correlate_the_worked_fixture() {
        let anchors = anchor_entities("Atlas deploys only on Tuesdays.");
        assert!(shares_anchor(
            &anchors,
            "From now on we deploy Atlas only on Tuesdays."
        ));
        assert!(!shares_anchor(&anchors, "hey, is the build green?"));
    }

    /// Ruling 2 (Wave 4c): a shared technical acronym is a correlation,
    /// not noise. `DB` is two bytes, below the content-word floor, so
    /// before this the tense-change attack of red-team family 6 looked
    /// like an unrelated citation and died at G04 instead of at the gate
    /// it was written for.
    #[test]
    fn correlation_anchors_include_uppercase_acronyms() {
        let statement = correlation_anchors("The DB was migrated.");
        assert!(statement.contains("db"), "{statement:?}");
        assert!(shares_anchor(
            &statement,
            "I will migrate the DB tomorrow morning."
        ));

        // Correlation only. The anchor set G07 orders, the protected
        // tokens G06 compares and the claim topic identity hashes are
        // all untouched — a two-letter token is still below the
        // content-word floor everywhere else.
        assert!(!anchor_entities("The DB was migrated.").contains("db"));
        assert!(!topic("The DB was migrated.").contains("db"));
        assert!(extract_protected("The DB was migrated.").is_empty());
    }

    #[test]
    fn an_unrelated_acronym_does_not_manufacture_a_correlation() {
        let statement = correlation_anchors("The DB was migrated.");
        assert!(!shares_anchor(
            &statement,
            "The CDN cache was purged this morning."
        ));
        // Stopwords are excluded on the acronym path too, or SHOUTED
        // prose would correlate with everything.
        assert!(!correlation_anchors("ALL HANDS ON DECK").contains("all"));
    }

    #[test]
    fn anchors_include_protected_tokens_lowercased() {
        let anchors = anchor_entities("The staging cron runs at 03:00 UTC.");
        assert!(anchors.contains("03:00"), "{anchors:?}");
        assert!(anchors.contains("utc"), "{anchors:?}");
        assert!(anchors.contains("staging"));
        assert!(!anchors.contains("the"));
    }

    #[test]
    fn binding_order_separates_role_swap_from_property_transfer() {
        // family 1: role swap — shared anchors reordered
        assert!(!preserves_binding_order(
            "Bob owns billing.",
            "Alice owns billing; Bob owns auth."
        ));
        // family 2: property transfer — order preserved, so G07 must
        // fall through to review rather than reject
        assert!(preserves_binding_order(
            "The cron opens at 04:00.",
            "The staging cron still runs at 03:30 UTC, so the Tuesday deploy window opens after 04:00."
        ));
        // the worked fixture must not trip it
        assert!(preserves_binding_order(
            "Atlas deploys only on Tuesdays.",
            "From now on we deploy Atlas only on Tuesdays."
        ));
    }

    #[test]
    fn topics_are_deterministic_and_order_independent() {
        let statement = "Atlas deploys only on Tuesdays.";
        let first = topic(statement);
        assert_eq!(first, topic(statement));
        assert!(!first.is_empty());
        assert_eq!(
            topic("tuesdays atlas"),
            topic("atlas tuesdays"),
            "a topic must not depend on word order"
        );
    }

    // ── G09 ──────────────────────────────────────────────────────────

    #[test]
    fn sensitive_screen_catches_paths_and_credentials() {
        assert_eq!(
            sensitive_hit("The key lives at /Users/dath/.ssh/id_rsa on my laptop."),
            Some("private_path")
        );
        assert_eq!(
            sensitive_hit("token ghp_abcdefghijklmnopqrstuvwxyz0123"),
            Some("credential")
        );
        assert_eq!(sensitive_hit("Atlas deploys only on Tuesdays."), None);
        assert_eq!(
            sensitive_hit("The staging cron still runs at 03:30 UTC."),
            None
        );
    }

    #[test]
    fn entropy_screen_ignores_ordinary_long_words() {
        assert_eq!(sensitive_hit("internationalization considerations"), None);
        assert_eq!(
            sensitive_hit("d41d8cd98f00b204e9800998ecf8427e5f1a2b3c"),
            Some("high_entropy")
        );
    }

    #[test]
    fn every_policy_label_is_receipt_safe() {
        for class in SENSITIVE_CLASSES {
            assert!(super::super::receipts::is_safe_token(class));
        }
        for class in ProtectedTokens::CLASSES {
            assert!(super::super::receipts::is_safe_token(class.as_str()));
        }
    }
}
