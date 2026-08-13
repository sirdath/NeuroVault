"""Tests for the curator scorer and gauntlet.

These are measurement-instrument tests, not model tests. Every fixture is
synthetic and tiny, and every assertion pins a metric DEFINITION, because the
scoreboard is about to be used as a training target and a scorer that
over-credits will be optimized against.

Four defects are pinned here, each with the v1 behaviour computed alongside the
v2 behaviour so the difference is visible rather than asserted on faith:

  1. duplicate credit      three restatements of one memory used to score as
                           three correct proposals (`_v1_match_count`).
  2. false-reject formula   v1 divided gold-matching rejects by ALL rejects;
                           the spec divides them by all ADMISSIBLE candidates.
  3. source_role            never checked at all before; now derived from the
                           transcript's own role markers.
  4. G2 leniency            "the token is somewhere in the unit" now reports
                           separately from "the token is in the quote".

Plus one-to-one assignment ordering and bootstrap determinism.

Usage:
    python3 eval/curator/test_score.py          # all tests
    python3 eval/curator/test_score.py -v       # print each fixture's metrics

Stdlib only. No Ollama, no network, no model.
"""

from __future__ import annotations

import json
import sys
import tempfile
import traceback
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))
import score as score_mod  # noqa: E402
import verify as verify_mod  # noqa: E402

VERBOSE = "-v" in sys.argv or "--verbose" in sys.argv


# --------------------------------------------------------------------------
# the v1 logic, kept here so "the fix changed something" is a measurement
# --------------------------------------------------------------------------

def _v1_match_count(surviving: list[dict], gold_items: list[dict]) -> int:
    """Scorer v1's post-gate numerator: every surviving proposal that matched
    ANY gold item, with no bookkeeping of which items were already claimed."""
    matched = 0
    for p in surviving:
        hit = next(
            (i for i, gi in enumerate(gold_items)
             if score_mod.statement_matches(p.get("statement"), gi)),
            None,
        )
        if hit is not None:
            matched += 1
    return matched


# --------------------------------------------------------------------------
# fixture plumbing
# --------------------------------------------------------------------------

def build_case(
    root: Path,
    units: dict[str, str],
    gold: dict[str, dict],
    proposals: dict[str, list[dict]],
    nothing_durable: dict[str, bool] | None = None,
    review_flags: dict[str, list[list[str]]] | None = None,
) -> dict[str, Any]:
    """Write a mini units/ + gold/ + results/ tree and score it.

    `review_flags[uid]` is one flag list per proposal, written into the row's
    `_sid_resolution` block exactly the way verify_sid.py's `inject()` writes
    it, so the escalation path is exercised through the real on-disk shape
    rather than a scorer-internal hook.
    """
    units_dir = root / "units"
    gold_dir = root / "gold"
    results_dir = root / "results" / "fixture"
    (results_dir / "units").mkdir(parents=True, exist_ok=True)
    units_dir.mkdir(parents=True, exist_ok=True)
    gold_dir.mkdir(parents=True, exist_ok=True)

    for uid, text in units.items():
        (units_dir / f"unit_{uid}.txt").write_text(text, encoding="utf-8")
    for uid, obj in gold.items():
        (gold_dir / f"unit_{uid}.gold.json").write_text(
            json.dumps(obj, indent=2), encoding="utf-8")
    for uid, props in proposals.items():
        row = {
            "unit_id": uid,
            "status": "ok",
            "parse_status": "ok",
            "wall_seconds": 1.0,
            "parsed": {"proposals": props,
                       "nothing_durable": (nothing_durable or {}).get(uid, not props)},
            "nothing_durable": (nothing_durable or {}).get(uid, not props),
            "incoherent_abstention": False,
        }
        flags = (review_flags or {}).get(uid)
        if flags is not None:
            row["_sid_resolution"] = {
                "contract": "sid",
                "segmenter_harness_version": 1,
                "proposals": [{"review_flags": f} for f in flags],
            }
        (results_dir / "units" / f"unit_{uid}.json").write_text(
            json.dumps(row, indent=2), encoding="utf-8")

    loaded_gold = score_mod.load_gold(gold_dir)
    loaded_units = {u["id"]: u["text"] for u in score_mod.load_units(units_dir)}
    assert loaded_gold, "fixture gold failed to load"
    assert loaded_units, "fixture units failed to load"
    metrics = score_mod.score(results_dir, loaded_gold, loaded_units)
    if VERBOSE:
        print(json.dumps({k: v for k, v in metrics.items() if k != "units"}, indent=2))
    return metrics


# ==========================================================================
# defect 1 -- duplicate credit
# ==========================================================================

DUP_UNIT = """USER: The Postgres port is 5433.

ASSISTANT: Noted.
"""

DUP_GOLD = {
    "nothing_durable": False,
    "gold_proposals": [
        {"statement": "The Postgres instance runs on port 5433.",
         "must_match_terms": ["5433"], "type": "fact"},
    ],
}

DUP_QUOTE = "The Postgres port is 5433."
DUP_PROPOSALS = [
    {"type": "fact", "statement": "The Postgres port is 5433.",
     "grounding_quote": DUP_QUOTE, "source_role": "user"},
    {"type": "fact", "statement": "Postgres runs on port 5433.",
     "grounding_quote": DUP_QUOTE, "source_role": "user"},
    {"type": "fact", "statement": "The database port is 5433.",
     "grounding_quote": DUP_QUOTE, "source_role": "user"},
]


def test_duplicates_do_not_double_credit() -> None:
    """Three restatements of one gold memory credit ONCE, not three times."""
    gold_items = DUP_GOLD["gold_proposals"]
    checked = [verify_mod.verify_proposal(p, DUP_UNIT) for p in DUP_PROPOSALS]
    surviving = [c for c in checked if c["verdict"] in ("pass", "flag(G3)")]
    assert len(surviving) == 3, f"fixture broken: {[c['verdict'] for c in checked]}"

    # RED: what scorer v1 counted.
    assert _v1_match_count(surviving, gold_items) == 3

    # GREEN: one-to-one.
    assigned, duplicates = score_mod.assign_one_to_one(surviving, gold_items)
    assert len(assigned) == 1, assigned
    assert len(duplicates) == 2, duplicates
    assert set(assigned.values()) == {0}

    with tempfile.TemporaryDirectory() as tmp:
        m = build_case(Path(tmp), {"dup": DUP_UNIT}, {"dup": DUP_GOLD},
                       {"dup": DUP_PROPOSALS})
    # v1 would have reported precision 3/3 = 1.000 for a model that said the
    # same thing three ways. v2 reports 1/3.
    assert m["post_gate_precision"] == round(1 / 3, 4), m["post_gate_precision"]
    assert m["post_gate_recall"] == 1.0, m["post_gate_recall"]
    assert m["duplicate_proposal_count"] == 2
    assert m["duplicate_rate"] == round(2 / 3, 4), m["duplicate_rate"]
    assert m["duplicate_rate_of_surviving"] == round(2 / 3, 4)


def test_a_gold_item_is_creditable_once_for_recall_too() -> None:
    """Recall never exceeded 1.0 in v1 either -- prove v2 kept that."""
    gold_items = DUP_GOLD["gold_proposals"]
    checked = [verify_mod.verify_proposal(p, DUP_UNIT) for p in DUP_PROPOSALS]
    assigned, _ = score_mod.assign_one_to_one(checked, gold_items)
    assert len(set(assigned.values())) == len(assigned) <= len(gold_items)


# ==========================================================================
# defect 1b -- greedy assignment ORDER
# ==========================================================================

def test_greedy_assignment_prefers_the_more_specific_gold_item() -> None:
    """A proposal that satisfies a tight gold item is given to the tight one.

    Naive first-index matching gives P0 to the 1-term item, leaving the
    2-term item unmatched and P1 with nothing to claim: recall 1/2. Ordering
    by match quality pairs both: recall 2/2.
    """
    gold_items = [
        {"statement": "postgres is used", "must_match_terms": ["postgres"]},
        {"statement": "postgres runs on 5433", "must_match_terms": ["postgres", "5433"]},
    ]
    proposals = [
        {"statement": "we use postgres on port 5433"},   # matches both
        {"statement": "we use postgres"},                # matches only item 0
    ]

    # RED: first-index matching leaves one gold item stranded.
    naive_claimed = set()
    for p in proposals:
        hit = next((i for i, gi in enumerate(gold_items)
                    if score_mod.statement_matches(p["statement"], gi)), None)
        if hit is not None and hit not in naive_claimed:
            naive_claimed.add(hit)
    assert naive_claimed == {0}, naive_claimed

    # GREEN: quality-ordered greedy pairs both.
    assigned, duplicates = score_mod.assign_one_to_one(proposals, gold_items)
    assert assigned == {0: 1, 1: 0}, assigned
    assert duplicates == []


def test_greedy_ties_break_by_proposal_order_then_gold_order() -> None:
    gold_items = [
        {"statement": "alpha", "must_match_terms": ["alpha"]},
        {"statement": "beta", "must_match_terms": ["beta"]},
    ]
    proposals = [
        {"statement": "alpha and beta"},   # equal quality on both
        {"statement": "beta only"},
    ]
    assigned, duplicates = score_mod.assign_one_to_one(proposals, gold_items)
    # P0 is earlier, so it claims first; among its equal-quality options it
    # takes the earlier gold index. P1 then takes what is left.
    assert assigned == {0: 0, 1: 1}, assigned
    assert duplicates == []


def test_duplicate_is_only_a_proposal_that_matched_something() -> None:
    """A proposal matching NO gold item is a plain false positive, never a
    duplicate -- otherwise duplicate_rate would just re-count precision."""
    gold_items = [{"statement": "alpha", "must_match_terms": ["alpha"]}]
    proposals = [
        {"statement": "alpha one"},
        {"statement": "alpha two"},        # duplicate
        {"statement": "unrelated thing"},  # false positive, not a duplicate
    ]
    assigned, duplicates = score_mod.assign_one_to_one(proposals, gold_items)
    assert assigned == {0: 0}
    assert duplicates == [1], duplicates


# ==========================================================================
# defect 2 -- false-reject denominator
# ==========================================================================

FR_UNIT = """USER: The alpha build is the one we ship.

ASSISTANT: Understood.

USER: beta release shipped on Tuesday.

USER: gamma release shipped too.
"""

FR_GOLD = {
    "nothing_durable": False,
    "gold_proposals": [
        {"statement": "The alpha build is what ships.",
         "must_match_terms": ["alpha"], "type": "decision"},
        {"statement": "The beta release shipped.",
         "must_match_terms": ["beta"], "type": "fact"},
        {"statement": "The gamma release shipped.",
         "must_match_terms": ["gamma"], "type": "fact"},
    ],
}

FR_PROPOSALS = [
    # admissible + survives
    {"type": "decision", "statement": "The team ships the alpha build.",
     "grounding_quote": "The alpha build is the one we ship.", "source_role": "user"},
    # admissible + killed by G1 (quote paraphrased)
    {"type": "fact", "statement": "The beta release shipped.",
     "grounding_quote": "beta release was shipped on a Tuesday.", "source_role": "user"},
    # admissible + killed by G2 (ungrounded token "Kubernetes")
    {"type": "fact", "statement": "The gamma release runs on Kubernetes.",
     "grounding_quote": "gamma release shipped too.", "source_role": "user"},
]
# four inadmissible rejects: they match no gold item at all
FR_PROPOSALS += [
    {"type": "fact", "statement": f"Unrelated invented statement number {n}.",
     "grounding_quote": f"nothing like this is in the unit {n}", "source_role": "user"}
    for n in range(11, 15)
]


def test_false_reject_denominator_is_admissible_candidates() -> None:
    checked = [verify_mod.verify_proposal(p, FR_UNIT) for p in FR_PROPOSALS]
    verdicts = [c["verdict"] for c in checked]
    assert verdicts[0] == "pass", verdicts
    assert verdicts[1] == "reject(G1)", verdicts
    assert verdicts[2] == "reject(G2)", verdicts
    assert all(v == "reject(G1)" for v in verdicts[3:]), verdicts

    with tempfile.TemporaryDirectory() as tmp:
        m = build_case(Path(tmp), {"fr": FR_UNIT}, {"fr": FR_GOLD},
                       {"fr": FR_PROPOSALS})

    # 3 candidates match gold; the gauntlet kills 2 of them.
    assert m["admissible_candidate_count"] == 3, m["admissible_candidate_count"]
    assert m["verifier_false_reject_count"] == 2
    assert m["verifier_false_reject_rate"] == round(2 / 3, 4), m["verifier_false_reject_rate"]

    # v1 divided the same 2 by all 6 rejects, which shrinks with every extra
    # piece of junk the model emits -- a gate-quality metric that a worse
    # model can improve.
    assert m["rejected_total"] == 6, m["rejected_total"]
    assert m["verifier_false_reject_est"] == round(2 / 6, 4), m["verifier_false_reject_est"]
    assert m["verifier_false_reject_est_deprecated"] is True


def test_v1_false_reject_est_is_gameable_by_adding_junk() -> None:
    """Emitting more unsupported junk lowers the v1 number and leaves the v2
    number untouched. That is the whole reason the formula changed."""
    padded = FR_PROPOSALS + [
        {"type": "fact", "statement": f"More invented filler {n}.",
         "grounding_quote": f"also absent from the unit {n}", "source_role": "user"}
        for n in range(20, 40)
    ]
    with tempfile.TemporaryDirectory() as tmp:
        m = build_case(Path(tmp), {"fr": FR_UNIT}, {"fr": FR_GOLD}, {"fr": padded})
    assert m["verifier_false_reject_rate"] == round(2 / 3, 4)      # unchanged
    assert m["verifier_false_reject_est"] == round(2 / 26, 4)      # "improved"
    assert m["verifier_false_reject_est"] < 0.1


def test_false_reject_is_measured_pre_gate() -> None:
    """The denominator counts rejected candidates too -- a gate cannot be
    audited using only the proposals it let through."""
    with tempfile.TemporaryDirectory() as tmp:
        m = build_case(Path(tmp), {"fr": FR_UNIT}, {"fr": FR_GOLD},
                       {"fr": FR_PROPOSALS})
    n_surviving = m["proposal_totals"]["pass"] + m["proposal_totals"]["flag_g3"]
    assert n_surviving == 1
    assert m["admissible_candidate_count"] > n_surviving


# ==========================================================================
# defect 3 -- source_role
# ==========================================================================

ROLE_UNIT = """USER: We standardized on PostgreSQL 16 for every new service.

ASSISTANT: Understood, I will open the tickets.

ASSISTANT [tool:Bash] pg_config --version

TOOL_RESULT: PostgreSQL 16.2 on x86_64-apple-darwin
"""


def test_role_derivation_walks_back_to_the_nearest_marker() -> None:
    cases = [
        ("We standardized on PostgreSQL 16 for every new service.", "user"),
        ("Understood, I will open the tickets.", "assistant"),
        ("pg_config --version", "assistant"),          # ASSISTANT [tool:...] line
        ("PostgreSQL 16.2 on x86_64-apple-darwin", "tool_result"),
    ]
    for quote, expected in cases:
        got = verify_mod.derive_source_role(ROLE_UNIT, quote)
        assert got["derived_role"] == expected, (quote, got)
        assert got["offset"] is not None


def test_role_mismatch_is_flagged_not_rejected() -> None:
    proposal = {
        "type": "decision",
        "statement": "New services standardize on PostgreSQL 16.",
        "grounding_quote": "We standardized on PostgreSQL 16 for every new service.",
        "source_role": "assistant",     # wrong: that line is the USER's
    }
    out = verify_mod.verify_proposal(proposal, ROLE_UNIT)
    assert out["role"]["derived"] == "user"
    assert out["role"]["claimed"] == "assistant"
    assert out["role"]["gradable"] is True
    assert out["role_mismatch"] is True
    # A flag, not a verdict.
    assert out["verdict"] == "pass", out["verdict"]


def test_role_match_is_not_flagged() -> None:
    proposal = {
        "type": "fact",
        "statement": "The tickets will be opened.",
        "grounding_quote": "Understood, I will open the tickets.",
        "source_role": "assistant",
    }
    out = verify_mod.verify_proposal(proposal, ROLE_UNIT)
    assert out["role"]["gradable"] is True
    assert out["role_mismatch"] is False


def test_tool_result_and_unlocatable_quotes_are_ungradable() -> None:
    """No schema value can be correct for a TOOL_RESULT quote, so it is
    excluded from the denominator instead of scored as wrong."""
    tool_quote = {
        "type": "fact", "statement": "The server reports version 16.2.",
        "grounding_quote": "PostgreSQL 16.2 on x86_64-apple-darwin",
        "source_role": "assistant",
    }
    out = verify_mod.verify_proposal(tool_quote, ROLE_UNIT)
    assert out["role"]["derived"] == "tool_result"
    assert out["role"]["gradable"] is False
    assert out["role_mismatch"] is False
    assert out["role"]["ungradable_reason"] == "non_speaker_source"

    invented = {
        "type": "fact", "statement": "Something entirely invented.",
        "grounding_quote": "this string is nowhere in the unit",
        "source_role": "user",
    }
    out = verify_mod.verify_proposal(invented, ROLE_UNIT)
    assert out["role"]["derived"] is None
    assert out["role"]["gradable"] is False
    assert out["role"]["ungradable_reason"] == "unlocatable_quote"


def test_source_role_accuracy_reported_by_scorer() -> None:
    gold = {
        "nothing_durable": False,
        "gold_proposals": [
            {"statement": "New services standardize on PostgreSQL 16.",
             "must_match_terms": ["PostgreSQL 16"], "type": "decision"},
        ],
    }
    props = [
        # right role
        {"type": "decision", "statement": "New services standardize on PostgreSQL 16.",
         "grounding_quote": "We standardized on PostgreSQL 16 for every new service.",
         "source_role": "user"},
        # wrong role
        {"type": "fact", "statement": "The tickets will be opened.",
         "grounding_quote": "Understood, I will open the tickets.",
         "source_role": "user"},
        # ungradable (tool result)
        {"type": "fact", "statement": "The server reports 16.2.",
         "grounding_quote": "PostgreSQL 16.2 on x86_64-apple-darwin",
         "source_role": "assistant"},
    ]
    with tempfile.TemporaryDirectory() as tmp:
        m = build_case(Path(tmp), {"role": ROLE_UNIT}, {"role": gold}, {"role": props})
    assert m["role_gradable_count"] == 2, m["role_gradable_count"]
    assert m["role_mismatch_count"] == 1
    assert m["source_role_accuracy"] == 0.5
    assert m["role_ungradable_breakdown"].get("non_speaker_source") == 1


# ==========================================================================
# defect 4 -- G2 span pass vs whole-unit fallback
# ==========================================================================

G2_UNIT = """USER: We use Redis 7 for the cache.

ASSISTANT: The port is 5433.
"""


def test_g2_span_pass_and_unit_fallback_are_distinguished() -> None:
    span = verify_mod.verify_proposal(
        {"type": "fact", "statement": "The cache uses Redis.",
         "grounding_quote": "We use Redis 7 for the cache.", "source_role": "user"},
        G2_UNIT)
    assert span["verdict"] == "pass"
    assert span["g2"]["in_quote"] == ["Redis"], span["g2"]
    assert span["g2"]["span_pass"] is True
    assert span["g2"]["unit_fallback"] is False

    fallback = verify_mod.verify_proposal(
        {"type": "fact", "statement": "The cache uses Redis on port 5433.",
         "grounding_quote": "We use Redis 7 for the cache.", "source_role": "user"},
        G2_UNIT)
    # 5433 is nowhere in the chosen quote; it only appears elsewhere in the
    # unit. v1 passed this silently. v2 still passes it -- and says so.
    assert fallback["verdict"] == "pass"
    assert fallback["g2"]["unit_only"] == ["5433"], fallback["g2"]
    assert fallback["g2"]["span_pass"] is False
    assert fallback["g2"]["unit_fallback"] is True

    invented = verify_mod.verify_proposal(
        {"type": "fact", "statement": "The cache uses Memcached.",
         "grounding_quote": "We use Redis 7 for the cache.", "source_role": "user"},
        G2_UNIT)
    assert invented["verdict"] == "reject(G2)"
    assert invented["g2"]["span_pass"] is False
    assert invented["g2"]["unit_fallback"] is False

    vacuous = verify_mod.verify_proposal(
        {"type": "preference", "statement": "The user wants short answers.",
         "grounding_quote": "We use Redis 7 for the cache.", "source_role": "user"},
        G2_UNIT)
    assert vacuous["g2"]["n_tokens"] == 0, vacuous["g2"]
    assert vacuous["g2"]["vacuous"] is True
    assert vacuous["g2"]["span_pass"] is False


def test_g2_outcome_flags_ignore_g1_rejects() -> None:
    """Token containment against a FABRICATED quote is meaningless, so a G1
    reject must not vote in the span/fallback split. Without this the split
    is dominated by the very proposals the gauntlet already threw away."""
    fabricated = verify_mod.verify_proposal(
        {"type": "fact", "statement": "The cache uses Redis.",
         "grounding_quote": "some quote that is not in the unit at all",
         "source_role": "user"},
        G2_UNIT)
    assert fabricated["verdict"] == "reject(G1)"
    # "Redis" is in the unit, so G2 itself is clean -- irrelevant.
    assert fabricated["g2"]["missing"] == []
    assert fabricated["g2"]["span_pass"] is False
    assert fabricated["g2"]["unit_fallback"] is False
    assert fabricated["g2"]["vacuous"] is False

    checked = verify_mod.verify_unit(
        {"unit_id": "g2", "parsed": {"proposals": [
            {"type": "fact", "statement": "The cache uses Redis.",
             "grounding_quote": "We use Redis 7 for the cache.", "source_role": "user"},
            {"type": "fact", "statement": "The cache uses Redis.",
             "grounding_quote": "not in the unit", "source_role": "user"},
        ]}}, G2_UNIT)
    f = checked["flags"]
    survivors = checked["counts"]["pass"] + checked["counts"]["flag_g3"]
    assert f["g2_span_pass"] + f["g2_unit_fallback"] + f["g2_vacuous"] == survivors == 1


def test_g2_rates_partition_the_survivors() -> None:
    gold = {"nothing_durable": False,
            "gold_proposals": [{"statement": "cache uses redis",
                                "must_match_terms": ["Redis"], "type": "fact"}]}
    props = [
        {"type": "fact", "statement": "The cache uses Redis.",
         "grounding_quote": "We use Redis 7 for the cache.", "source_role": "user"},
        {"type": "fact", "statement": "The cache uses Redis on port 5433.",
         "grounding_quote": "We use Redis 7 for the cache.", "source_role": "user"},
        {"type": "preference", "statement": "The user wants short answers.",
         "grounding_quote": "We use Redis 7 for the cache.", "source_role": "user"},
    ]
    with tempfile.TemporaryDirectory() as tmp:
        m = build_case(Path(tmp), {"g2": G2_UNIT}, {"g2": gold}, {"g2": props})
    assert m["g2_survivor_count"] == 3
    assert m["g2_span_pass_rate"] == round(1 / 3, 4)
    assert m["g2_unit_fallback_rate"] == round(1 / 3, 4)
    assert m["g2_vacuous_rate"] == round(1 / 3, 4)
    # The three outcomes partition the survivors (to reporting precision --
    # every rate is rounded to 4dp on the way out).
    total = (m["g2_span_pass_rate"] + m["g2_unit_fallback_rate"]
             + m["g2_vacuous_rate"])
    assert abs(total - 1.0) < 1e-3, total


# ==========================================================================
# defect 5 -- per-class breakdown
# ==========================================================================

def test_per_class_breakdown_exposes_a_class_the_aggregate_hides() -> None:
    """A model that nails every fact and misses every preference must not be
    able to hide behind a healthy aggregate recall."""
    unit = """USER: The build server is at 10.0.0.7 and I always want tests run before merge.

ASSISTANT: Understood.
"""
    gold = {
        "nothing_durable": False,
        "gold_proposals": [
            {"statement": "The build server is at 10.0.0.7.",
             "must_match_terms": ["10.0.0.7"], "type": "fact"},
            {"statement": "Tests must always run before a merge.",
             "must_match_terms": ["tests", "merge"], "type": "preference"},
        ],
    }
    props = [
        {"type": "fact", "statement": "The build server is at 10.0.0.7.",
         "grounding_quote":
             "The build server is at 10.0.0.7 and I always want tests run before merge.",
         "source_role": "user"},
    ]
    with tempfile.TemporaryDirectory() as tmp:
        m = build_case(Path(tmp), {"pc": unit}, {"pc": gold}, {"pc": props})
    assert m["post_gate_recall"] == 0.5
    assert m["per_class"]["fact"]["recall"] == 1.0
    assert m["per_class"]["preference"]["recall"] == 0.0, m["per_class"]
    assert m["per_class"]["fact"]["gold_items"] == 1
    assert m["per_class"]["preference"]["gold_items"] == 1
    assert m["type_agreement_rate"] == 1.0


def test_abstention_metrics_are_reported_separately() -> None:
    units = {"pos": DUP_UNIT, "neg": "USER: morning, is the build green?\n\nASSISTANT: yes.\n"}
    gold = {"pos": DUP_GOLD, "neg": {"nothing_durable": True, "gold_proposals": []}}
    props = {"pos": DUP_PROPOSALS, "neg": []}
    with tempfile.TemporaryDirectory() as tmp:
        m = build_case(Path(tmp), units, gold, props, nothing_durable={"neg": True})
    assert m["n_gold_negative_units"] == 1
    assert m["abstention"]["abstention_correctness"] == 1.0
    assert m["abstention"]["over_extraction_rate"] == 0.0
    # The negative unit must not have leaked into the extraction denominators.
    assert m["post_gate_precision"] == round(1 / 3, 4)


# ==========================================================================
# spec 19.1 -- generator_candidate_recall
# ==========================================================================

def test_generator_candidate_recall_is_measured_before_the_gauntlet() -> None:
    """The generator's own ceiling, and the verifier's bill.

    FR_PROPOSALS proposes all three gold memories correctly; the gauntlet
    kills two of them. Pre-gate the generator found 3/3; post-gate 1/3
    survives. The gap IS the verifier's damage, and it is the whole reason
    the spec asks for both numbers instead of only the one that flatters.
    """
    with tempfile.TemporaryDirectory() as tmp:
        m = build_case(Path(tmp), {"fr": FR_UNIT}, {"fr": FR_GOLD},
                       {"fr": FR_PROPOSALS})

    assert m["gold_item_count"] == 3, m["gold_item_count"]
    assert m["generator_candidate_recall_count"] == 3
    assert m["generator_candidate_recall"] == 1.0, m["generator_candidate_recall"]

    assert m["gold_matched_count"] == 1
    assert m["post_gate_recall"] == round(1 / 3, 4), m["post_gate_recall"]

    # Recall can only ever be lost between the two, never gained.
    assert m["generator_candidate_recall"] >= m["post_gate_recall"]


def test_generator_recall_counts_a_gold_item_once_like_post_gate_recall() -> None:
    """Pre-gate uses the SAME one-to-one assignment.

    Three restatements of one memory are one gold instance found, not three,
    exactly as post-gate. Otherwise `generator_candidate_recall` would exceed
    1.0 on a padding model and the gap to post_gate_recall would stop being
    readable as verifier damage.
    """
    with tempfile.TemporaryDirectory() as tmp:
        m = build_case(Path(tmp), {"dup": DUP_UNIT}, {"dup": DUP_GOLD},
                       {"dup": DUP_PROPOSALS})
    assert m["gold_item_count"] == 1
    assert m["generator_candidate_recall"] == 1.0
    assert m["generator_candidate_recall_count"] == 1


def test_generator_recall_is_reported_per_gold_class() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        m = build_case(Path(tmp), {"fr": FR_UNIT}, {"fr": FR_GOLD},
                       {"fr": FR_PROPOSALS})
    # gold: 1 decision (alpha, survives) + 2 fact (beta, gamma -- both killed).
    assert m["per_class"]["decision"]["generator_candidate_recall"] == 1.0
    assert m["per_class"]["decision"]["recall"] == 1.0
    assert m["per_class"]["fact"]["generator_candidate_recall"] == 1.0
    assert m["per_class"]["fact"]["recall"] == 0.0, m["per_class"]["fact"]
    assert m["per_class"]["fact"]["gold_matched_pre_gate"] == 2


# ==========================================================================
# spec 19.1 -- verifier_over_escalation_rate
# ==========================================================================

ESC_UNIT = """USER: The Postgres port is 5433.

USER: We might switch to Redis 7 for the cache.

ASSISTANT: Noted.
"""

ESC_GOLD = {
    "nothing_durable": False,
    "gold_proposals": [
        {"statement": "The Postgres port is 5433.",
         "must_match_terms": ["5433"], "type": "fact"},
        {"statement": "The team standardized on Redis.",
         "must_match_terms": ["Redis"], "type": "decision"},
    ],
}

ESC_PROPOSALS = [
    # admissible, clean pass
    {"type": "fact", "statement": "The Postgres port is 5433.",
     "grounding_quote": "The Postgres port is 5433.", "source_role": "user"},
    # admissible, survives -- but "always" over a "might" span is a judgement
    # call, so G3 routes it to a human.
    {"type": "decision", "statement": "The team always uses Redis for the cache.",
     "grounding_quote": "We might switch to Redis 7 for the cache.",
     "source_role": "user"},
]


def test_over_escalation_counts_a_g3_flag_on_an_admissible_candidate() -> None:
    checked = [verify_mod.verify_proposal(p, ESC_UNIT) for p in ESC_PROPOSALS]
    assert [c["verdict"] for c in checked] == ["pass", "flag(G3)"], \
        [c["verdict"] for c in checked]

    with tempfile.TemporaryDirectory() as tmp:
        m = build_case(Path(tmp), {"esc": ESC_UNIT}, {"esc": ESC_GOLD},
                       {"esc": ESC_PROPOSALS})

    # Both candidates match gold; one of the two is escalated.
    assert m["admissible_candidate_count"] == 2, m["admissible_candidate_count"]
    assert m["verifier_over_escalation_count"] == 1
    assert m["verifier_over_escalation_rate"] == 0.5, m["verifier_over_escalation_rate"]
    assert m["over_escalation_by_code"] == {"G3:PolarityHedge": 1}, \
        m["over_escalation_by_code"]

    # An escalation is NOT a rejection, and it is not a lost memory: the
    # flagged candidate still survives and still claims its gold item.
    assert m["verifier_false_reject_rate"] == 0.0
    assert m["post_gate_recall"] == 1.0
    assert m["generator_candidate_recall"] == 1.0


def test_over_escalation_is_reported_per_gold_class() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        m = build_case(Path(tmp), {"esc": ESC_UNIT}, {"esc": ESC_GOLD},
                       {"esc": ESC_PROPOSALS})
    assert m["per_class"]["fact"]["over_escalation_rate"] == 0.0
    assert m["per_class"]["decision"]["over_escalation_rate"] == 1.0
    assert m["per_class"]["decision"]["admissible_escalated"] == 1


# --- the sentence-ID contract's richer review flags ------------------------

SID_UNIT = """USER: The build server is at 10.0.0.7.

USER: We deploy Atlas on Tuesdays.

ASSISTANT: The staging cron runs at 03:30 UTC.

USER: The cache is Redis 7.
"""

SID_GOLD = {
    "nothing_durable": False,
    "gold_proposals": [
        {"statement": "The build server is at 10.0.0.7.",
         "must_match_terms": ["10.0.0.7"], "type": "fact"},
        {"statement": "Atlas deploys on Tuesdays.",
         "must_match_terms": ["Atlas"], "type": "decision"},
        {"statement": "The staging cron runs at 03:30 UTC.",
         "must_match_terms": ["03:30"], "type": "fact"},
        {"statement": "The cache is Redis 7.",
         "must_match_terms": ["Redis"], "type": "preference"},
    ],
}

SID_PROPOSALS = [
    {"type": "fact", "statement": "The build server is at 10.0.0.7.",
     "grounding_quote": "The build server is at 10.0.0.7.", "source_role": "user"},
    {"type": "decision", "statement": "Atlas deploys on Tuesdays.",
     "grounding_quote": "We deploy Atlas on Tuesdays.", "source_role": "user"},
    {"type": "fact", "statement": "The staging cron runs at 03:30 UTC.",
     "grounding_quote": "The staging cron runs at 03:30 UTC.", "source_role": "assistant"},
    # admissible, but invents "Memcached" -> terminal G2 reject
    {"type": "preference", "statement": "The cache is Redis 7 with Memcached.",
     "grounding_quote": "The cache is Redis 7.", "source_role": "user"},
]

# What verify_sid.py wrote back: P1 assembled its claim across the cited
# window, P2 cited an over-cap opaque block, P3 also synthesized -- and P3 is
# the one the gauntlet kills anyway.
SID_FLAGS = [[], ["synthesis"], ["oversized_evidence"], ["synthesis"]]


def test_sid_review_flags_escalate_and_oversized_is_counted_apart() -> None:
    """Spec 19.1: attribute every escalation to GateName and ReviewCode,
    'including OversizedEvidence separately from Synthesis'."""
    checked = [verify_mod.verify_proposal(p, SID_UNIT) for p in SID_PROPOSALS]
    assert [c["verdict"] for c in checked] == \
        ["pass", "pass", "pass", "reject(G2)"], [c["verdict"] for c in checked]

    with tempfile.TemporaryDirectory() as tmp:
        m = build_case(Path(tmp), {"sid": SID_UNIT}, {"sid": SID_GOLD},
                       {"sid": SID_PROPOSALS}, review_flags={"sid": SID_FLAGS})

    assert m["admissible_candidate_count"] == 4, m["admissible_candidate_count"]
    assert m["verifier_over_escalation_count"] == 2
    assert m["verifier_over_escalation_rate"] == 0.5, m["verifier_over_escalation_rate"]
    assert m["over_escalation_by_code"] == {
        "G1b:Synthesis": 1, "G1b:OversizedEvidence": 1,
    }, m["over_escalation_by_code"]

    assert m["verifier_false_reject_count"] == 1
    assert m["verifier_false_reject_rate"] == 0.25
    assert m["generator_candidate_recall"] == 1.0
    assert m["post_gate_recall"] == 0.75

    # The three outcomes partition the admissible set exactly once each.
    assert (m["verifier_false_reject_count"] + m["verifier_over_escalation_count"]
            <= m["admissible_candidate_count"])


def test_a_terminally_rejected_candidate_is_never_an_over_escalation() -> None:
    """P3 carries a `synthesis` flag AND dies at G2. It is a false reject and
    must not also be billed as an escalation -- double-counting it would let a
    verifier look busy on both counterweight metrics for one mistake."""
    with tempfile.TemporaryDirectory() as tmp:
        m = build_case(Path(tmp), {"sid": SID_UNIT}, {"sid": SID_GOLD},
                       {"sid": SID_PROPOSALS}, review_flags={"sid": SID_FLAGS})
    # Two `synthesis` flags on disk, one escalation counted.
    assert m["review_flag_breakdown"].get("G1b:Synthesis") == 1
    assert m["per_class"]["preference"]["admissible_escalated"] == 0
    assert m["per_class"]["preference"]["false_reject_rate"] == 1.0


def test_review_flags_are_dropped_when_the_writeback_does_not_line_up() -> None:
    """`inject()` skips non-dict proposals when it builds its notes, so a
    length disagreement means the indices have shifted. Attributing a flag to
    the wrong candidate is worse than attributing none, so the row's flags are
    discarded whole."""
    short = [["synthesis"], ["oversized_evidence"]]     # 2 notes, 4 proposals
    with tempfile.TemporaryDirectory() as tmp:
        m = build_case(Path(tmp), {"sid": SID_UNIT}, {"sid": SID_GOLD},
                       {"sid": SID_PROPOSALS}, review_flags={"sid": short})
    assert m["verifier_over_escalation_rate"] == 0.0
    assert m["over_escalation_by_code"] == {}
    assert m["review_flag_breakdown"] == {}
    # Everything else is untouched by the dropped flags.
    assert m["verifier_false_reject_rate"] == 0.25

    assert score_mod.row_review_flags({}, 3) == [[], [], []]
    assert score_mod.row_review_flags(
        {"_sid_resolution": {"proposals": [{"review_flags": ["synthesis"]}]}}, 1
    ) == [["synthesis"]]


def test_over_escalation_is_none_not_zero_without_admissible_candidates() -> None:
    """A model that proposes nothing right has no over-escalation rate. 0.0
    would read as 'measured, and perfect'."""
    gold = {"nothing_durable": False,
            "gold_proposals": [{"statement": "nobody proposed this",
                                "must_match_terms": ["unfindable"], "type": "fact"}]}
    props = [{"type": "fact", "statement": "Something else entirely.",
              "grounding_quote": "The Postgres port is 5433.", "source_role": "user"}]
    with tempfile.TemporaryDirectory() as tmp:
        m = build_case(Path(tmp), {"esc": ESC_UNIT}, {"esc": gold}, {"esc": props})
    assert m["admissible_candidate_count"] == 0
    assert m["verifier_over_escalation_rate"] is None
    assert m["verifier_false_reject_rate"] is None
    assert m["generator_candidate_recall"] == 0.0     # a real, measured zero


# ==========================================================================
# defect 6 -- bootstrap CIs
# ==========================================================================

def test_bootstrap_is_deterministic_and_brackets_the_point_estimate() -> None:
    pairs = [(1, 2), (2, 2), (0, 3), (3, 4), (1, 1), (0, 2), (2, 3), (1, 5)]
    a = score_mod.bootstrap_ci(pairs)
    b = score_mod.bootstrap_ci(pairs)
    assert a == b, (a, b)                      # same seed => same interval
    point = sum(n for n, _ in pairs) / sum(d for _, d in pairs)
    assert a[0] <= point <= a[1], (a, point)
    assert 0.0 <= a[0] <= a[1] <= 1.0, a


def test_bootstrap_degenerate_inputs() -> None:
    assert score_mod.bootstrap_ci([]) is None
    assert score_mod.bootstrap_ci([(0, 0), (0, 0)]) is None
    # A perfect metric has a degenerate but valid interval.
    assert score_mod.bootstrap_ci([(2, 2), (3, 3)]) == [1.0, 1.0]


def test_scorer_emits_intervals_for_the_three_headline_metrics() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        m = build_case(Path(tmp), {"fr": FR_UNIT}, {"fr": FR_GOLD},
                       {"fr": FR_PROPOSALS})
    for key in ("post_gate_precision", "post_gate_recall", "verifier_false_reject_rate"):
        interval = m["ci"][key]
        assert interval is not None, key
        assert interval[0] <= m[key] <= interval[1], (key, interval, m[key])
    assert m["ci"]["method"]["resamples"] == 1000
    assert m["ci"]["method"]["seed"] == 42


def test_the_two_spec_19_1_metrics_get_the_same_bootstrap_treatment() -> None:
    """A metric without an interval invites a threshold set on a point
    estimate, which is the failure mode the CIs exist to prevent."""
    with tempfile.TemporaryDirectory() as tmp:
        m = build_case(Path(tmp), {"sid": SID_UNIT}, {"sid": SID_GOLD},
                       {"sid": SID_PROPOSALS}, review_flags={"sid": SID_FLAGS})
    for key in ("generator_candidate_recall", "verifier_over_escalation_rate"):
        interval = m["ci"][key]
        assert interval is not None, key
        assert interval[0] <= m[key] <= interval[1], (key, interval, m[key])
        assert 0.0 <= interval[0] <= interval[1] <= 1.0, (key, interval)

    # Same seed, same corpus, same interval -- twice.
    with tempfile.TemporaryDirectory() as tmp:
        again = build_case(Path(tmp), {"sid": SID_UNIT}, {"sid": SID_GOLD},
                           {"sid": SID_PROPOSALS}, review_flags={"sid": SID_FLAGS})
    assert again["ci"]["generator_candidate_recall"] == \
        m["ci"]["generator_candidate_recall"]
    assert again["ci"]["verifier_over_escalation_rate"] == \
        m["ci"]["verifier_over_escalation_rate"]


def test_markdown_table_renders_intervals() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        m = build_case(Path(tmp), {"fr": FR_UNIT}, {"fr": FR_GOLD},
                       {"fr": FR_PROPOSALS})
    table = score_mod.markdown_table([m])
    assert "Post-gate precision" in table
    assert "[" in table and "]" in table
    assert "Per gold class" in table
    assert "Abstention (gold-negative units only)" in table
    assert "Duplicate rate" in table
    assert "Source-role accuracy" in table
    assert "deprecated" in table


def test_markdown_table_carries_the_two_new_metrics_and_their_caveat() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        m = build_case(Path(tmp), {"sid": SID_UNIT}, {"sid": SID_GOLD},
                       {"sid": SID_PROPOSALS}, review_flags={"sid": SID_FLAGS})
    table = score_mod.markdown_table([m])
    assert "Generator candidate recall (pre-gate)" in table
    assert "Verifier over-escalation rate" in table
    assert "generator recall" in table          # per-class row
    assert "over-escalation" in table           # per-class row
    assert "G1b:OversizedEvidence" in table     # attribution, apart from Synthesis
    assert "G1b:Synthesis" in table
    # The proxy caveat travels with the number, always.
    assert "Proxy caveat" in table
    assert "has never been annotated" in table


def test_markdown_says_so_when_nothing_was_escalated() -> None:
    """0.000 with an empty attribution table must not read as 'measured and
    clean'. Every committed run to date escalated nothing at all."""
    with tempfile.TemporaryDirectory() as tmp:
        m = build_case(Path(tmp), {"fr": FR_UNIT}, {"fr": FR_GOLD},
                       {"fr": FR_PROPOSALS})
    assert m["review_flag_breakdown"] == {}
    table = score_mod.markdown_table([m])
    assert "nothing was escalated" in table


# ==========================================================================
# regression guards on the untouched contract
# ==========================================================================

def test_v1_fields_survive_for_replay() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        m = build_case(Path(tmp), {"fr": FR_UNIT}, {"fr": FR_GOLD},
                       {"fr": FR_PROPOSALS})
    for key in ("degenerate_rate", "abstention_correctness",
                "pre_gate_unsupported_rate", "post_gate_precision",
                "post_gate_recall", "over_extraction_rate",
                "json_parse_failure_rate", "proposal_totals", "units"):
        assert key in m, key
    assert m["scorer_version"] == 2
    # verify.py's counts dict still holds the four verdicts and nothing else,
    # so `sum(counts.values()) == n_proposals` keeps holding.
    checked = verify_mod.verify_unit(
        {"unit_id": "fr", "parsed": {"proposals": FR_PROPOSALS}}, FR_UNIT)
    assert sum(checked["counts"].values()) == checked["n_proposals"]
    assert set(checked["counts"]) == {"pass", "flag_g3", "reject_g1", "reject_g2"}
    assert "flags" in checked


def test_malformed_proposals_do_not_crash_the_role_check() -> None:
    props = [
        {"type": "fact", "statement": "", "grounding_quote": "x", "source_role": "user"},
        {"type": "fact", "statement": "ok", "grounding_quote": "", "source_role": "user"},
        {"type": "fact", "statement": "ok", "grounding_quote": "x", "source_role": None},
        "not an object",
    ]
    checked = verify_mod.verify_unit({"unit_id": "m", "parsed": {"proposals": props}},
                                     ROLE_UNIT)
    assert checked["n_proposals"] == 4
    assert checked["flags"]["role_mismatch"] == 0
    for c in checked["proposals"]:
        assert c["role_mismatch"] is False


# --------------------------------------------------------------------------

def main() -> int:
    tests = [(n, o) for n, o in sorted(globals().items())
             if n.startswith("test_") and callable(o)]
    failures = 0
    for name, fn in tests:
        try:
            fn()
        except Exception:
            failures += 1
            print(f"FAIL {name}")
            traceback.print_exc()
        else:
            print(f"ok   {name}")
    print(f"\n{len(tests) - failures}/{len(tests)} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
