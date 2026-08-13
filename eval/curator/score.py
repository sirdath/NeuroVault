"""Score one model's curator run against a gold directory.

Consumes `results/<model>/units/*.json` (from run_bench.py), the verifier
report (`verify.json`, produced here on demand if absent) and a gold
directory, and emits `results/<model>/metrics.json` plus a markdown summary.

Gold format -- `gold/unit_<id>.gold.json`:

    {"gold_proposals": [{"statement": "...", "must_match_terms": ["pg16"]}],
     "nothing_durable": false}

A model proposal *matches* a gold item when every one of that item's
`must_match_terms` appears in the proposal's `statement`, case-insensitively.
Deliberately crude: term lists are auditable by eye and do not drift the way
an embedding threshold would. Write the terms tight enough that a wrong
statement cannot satisfy them.

Metric definitions (pre-registered -- do not tune these after seeing results):

  degenerate_rate          gold-POSITIVE units where the model produced zero
                           proposals, for any reason (empty array, `{}`,
                           parse error, timeout). This is the kill criterion
                           for the Qwen3-under-grammar collapse.
  abstention_correctness   gold-NEGATIVE units answered with the sanctioned
                           abstention: nothing_durable=true AND no proposals.
  pre_gate_unsupported     G1 rejects / all proposals. How often the model
                           invents a quote. Measured BEFORE gating, because
                           post-gate numbers hide it.
  generator_candidate_recall
                           spec section 19.1, verbatim: "gold memory instances
                           proposed by the generator BEFORE verification,
                           divided by all gold memory instances". Same
                           one-to-one assignment as post_gate_recall, run over
                           EVERY pre-gate proposal instead of the survivors, so
                           the pair brackets the verifier: whatever the
                           generator found and post_gate_recall lost, the
                           gauntlet destroyed. A generator ceiling this metric
                           cannot exceed is the point -- it is the honest
                           denominator for judging the verifier.
  post_gate_precision      of the proposals that SURVIVE the gauntlet on
                           gold-positive units, the fraction ASSIGNED to a
                           gold item under one-to-one matching (see below).
  post_gate_recall         of all gold items, the fraction claimed by an
                           assigned proposal. The harness stand-in for the
                           spec's `end_to_end_candidate_recall`, exact only
                           while every survivor reaches review (true in V1).
  duplicate_rate           proposals that matched only gold items already
                           claimed by a better proposal, over all proposals.
                           The measure of restatement padding.
  over_extraction_rate     gold-negative units with >=1 surviving proposal.
                           Noise injected into a clean brain.
  verifier_false_reject_rate
                           over the ADMISSIBLE candidates -- every pre-gate
                           proposal whose statement matches gold -- the
                           fraction the gauntlet routes to a terminal reject
                           (G1 or G2). This is the gauntlet's own error rate
                           per the curator spec (545cda0): the denominator is
                           what the model got right, not what the gauntlet
                           happened to reject.
  verifier_over_escalation_rate
                           spec section 19.1: labeled candidates whose gold
                           disposition is ProposalReady but whose verifier
                           disposition is ReviewRequired, over all gold
                           ProposalReady candidates. Same ADMISSIBLE
                           denominator as verifier_false_reject_rate, for the
                           same reason -- see the PROXY note below -- so the
                           two partition the admissible set together with the
                           clean passes. A candidate counts as escalated when
                           it SURVIVES (never terminally rejected) and carries
                           a non-terminal review outcome: verify.py's
                           `flag(G3)`, or a review flag verify_sid.py wrote
                           back to the row (`synthesis`, `oversized_evidence`,
                           `unclaimable_role`). Every escalation is attributed
                           to a GateName:ReviewCode pair in
                           `over_escalation_by_code`, with OversizedEvidence
                           reported separately from Synthesis, as section 19.1
                           requires.

PROXY WARNING on the two verifier metrics. The spec defines both against a
per-item gold DISPOSITION (`ProposalReady` / `ReviewRequired`) that the gold
set has never been annotated with. Both therefore use the harness's only
available stand-in: "the statement matches a gold item", i.e. the model got
the memory right. That set is adjacent to `ProposalReady or ReviewRequired`,
not equal to it, and using it for `verifier_over_escalation_rate` additionally
assumes every gold item is a gold `ProposalReady` -- the gold set records
memories a human judged durable, never memories a human wanted reviewed. Both
numbers are therefore CALIBRATION, not acceptance scores, until dispositions
exist. `MANIFEST-V1.json` records this as a blocking gap; do not freeze a
threshold against either proxy.
  source_role_accuracy     of the proposals whose grounding quote can be
                           located under a USER or ASSISTANT marker, the
                           fraction whose claimed `source_role` agrees.
  g2_span_pass_rate /      of the proposals that survive G2, how many were
  g2_unit_fallback_rate    grounded by the quote span itself vs only by the
                           lenient "appears somewhere in the unit" fallback.
  latency p50/p95          warm per-unit wall time.
  json_parse_failure_rate  content that was not JSON at all.

One-to-one matching (scorer v2). A gold item can be credited AT MOST ONCE and
a proposal can claim AT MOST ONE gold item. Pairs are assigned greedily: most
must_match_terms first (a 3-term gold item is a more specific claim than a
1-term one), ties broken by proposal order then gold order. Before v2 every
duplicate restatement of the same memory scored as an independent correct
proposal, so a model that said the same true thing four times was credited
four times.

Per-class breakdown. Precision / recall / false-reject are additionally
reported per gold `type` (fact / preference / decision). Recall and
false-reject key off the GOLD item's type; precision keys off the type the
model DECLARED, because a false positive has no gold item to inherit from.
`type_agreement_rate` reports how often the two agree on assigned pairs.

Confidence intervals. Unit-level bootstrap, 1000 resamples, seed 42: gold
positive units are resampled with replacement and the metric recomputed from
the resampled per-unit (numerator, denominator) pairs. Reported as
`metric [lo, hi]` at 95%. Unit-level, not proposal-level, because proposals
within one unit are not independent draws.

DEPRECATED. `verifier_false_reject_est` is the v1 formula (gold-matching
rejects / ALL rejects). It is retained so old runs stay comparable and is not
the headline metric. `metrics.json` files without `scorer_version` were
produced by v1, where the key `verifier_false_reject_rate` carried the v1
formula.

Usage:
    python eval/curator/score.py --results-dir eval/curator/results/qwen3-1.7b \
        --gold-dir eval/curator/gold --units-dir eval/curator/units

Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))
from run_bench import load_units  # noqa: E402
from verify import verify_unit  # noqa: E402

SCORER_VERSION = 2

# Bootstrap configuration. Fixed, so two runs over the same results produce
# byte-identical intervals; a moving seed would let a rerun "improve" a CI.
BOOTSTRAP_RESAMPLES = 1000
BOOTSTRAP_SEED = 42
BOOTSTRAP_ALPHA = 0.05

GOLD_TYPES = ("fact", "preference", "decision")

# --- non-terminal review outcomes (spec 19.1 GateName + ReviewCode) --------
#
# The harness has two sources of a `RequireReview`-shaped outcome and both are
# read, because a run is re-verified through verify.py whichever contract
# produced it:
#
#   verify.py      one non-terminal verdict, `flag(G3)` -- a settled-sounding
#                  statement built on a hedged span.
#   verify_sid.py  richer, product-shaped flags written back onto the result
#                  row under `_sid_resolution.proposals[i].review_flags`. It
#                  runs first and injects the materialized sentence, so by the
#                  time score.py re-verifies through verify.py those flags are
#                  already on disk.
#
# Spec 19.1 demands `OversizedEvidence` be counted apart from `Synthesis`, so
# the code is carried through rather than collapsed into one "escalated" bit.
SID_REVIEW_CODES = {
    "synthesis": "G1b:Synthesis",
    "oversized_evidence": "G1b:OversizedEvidence",
    "unclaimable_role": "G1b:UnclaimableRole",
}
G3_REVIEW_CODE = "G3:PolarityHedge"

# Verdicts that are NOT terminal. An escalation is a candidate that SURVIVED;
# one the gauntlet killed is a false reject, never an over-escalation, even
# when it also carries a review flag.
SURVIVING_VERDICTS = ("pass", "flag(G3)")


def row_review_flags(row: dict[str, Any], n_proposals: int) -> list[list[str]]:
    """Per-proposal review flags from verify_sid.py's write-back, or [] each.

    Positional, so it fails closed on any length disagreement: `inject()`
    skips non-dict proposals when building its notes, which can shift the
    indices. A mismatched row yields no flags at all rather than flags
    attributed to the wrong candidate.
    """
    notes = (row.get("_sid_resolution") or {}).get("proposals")
    if not isinstance(notes, list) or len(notes) != n_proposals:
        return [[] for _ in range(n_proposals)]
    out: list[list[str]] = []
    for note in notes:
        flags = note.get("review_flags") if isinstance(note, dict) else None
        out.append([str(f) for f in flags] if isinstance(flags, list) else [])
    return out


def escalation_codes(checked: dict[str, Any], flags: list[str]) -> list[str]:
    """GateName:ReviewCode labels for one candidate, or [] if not escalated.

    Empty for a terminally rejected candidate whatever flags it carries. A
    candidate may carry more than one code (synthesis over an over-cap block,
    say), which is why codes are counted separately from candidates.
    """
    if checked.get("verdict") not in SURVIVING_VERDICTS:
        return []
    codes = [SID_REVIEW_CODES.get(f, f"G1b:{f}") for f in flags]
    if checked.get("verdict") == "flag(G3)":
        codes.append(G3_REVIEW_CODE)
    return codes


def pct(numerator: float, denominator: float) -> float | None:
    """Rate, or None when the denominator is zero.

    None is not 0.0: "no negative units in the set" must never be reported as
    "0% correct abstention".
    """
    if not denominator:
        return None
    return round(numerator / denominator, 4)


def percentile(values: list[float], q: float) -> float | None:
    """Nearest-rank percentile. q in [0, 100]."""
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return round(ordered[0], 3)
    k = max(0, min(len(ordered) - 1, int(round((q / 100.0) * (len(ordered) - 1)))))
    return round(ordered[k], 3)


def fmt(value: Any) -> str:
    if value is None:
        return "n/a"
    if isinstance(value, float):
        return f"{value:.3f}"
    return str(value)


# --------------------------------------------------------------------------
# gold
# --------------------------------------------------------------------------

def load_gold(gold_dir: Path) -> dict[str, dict[str, Any]]:
    gold: dict[str, dict[str, Any]] = {}
    if not gold_dir.is_dir():
        return gold
    for path in sorted(gold_dir.glob("*.json")):
        stem = path.name
        for suffix in (".gold.json", ".json"):
            if stem.endswith(suffix):
                stem = stem[: -len(suffix)]
                break
        if stem.startswith("unit_"):
            stem = stem[len("unit_"):]
        try:
            obj = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"  ! bad gold {path.name}: {exc}", file=sys.stderr)
            continue
        items = obj.get("gold_proposals") or []
        gold[stem] = {
            "gold_proposals": items,
            # A unit is negative if it says so, or simply has no gold items.
            "nothing_durable": bool(obj.get("nothing_durable", not items)),
        }
    return gold


def statement_matches(statement: str, gold_item: dict) -> bool:
    """Every must_match_term present in the statement, case-insensitively."""
    if not isinstance(statement, str):
        return False
    hay = re.sub(r"\s+", " ", statement).lower()
    terms = gold_item.get("must_match_terms") or []
    if not terms:
        # No terms => fall back to the gold statement itself, so a
        # half-written gold file degrades to "never matches" rather than
        # "always matches", which would silently inflate precision.
        ref = (gold_item.get("statement") or "").strip().lower()
        return bool(ref) and ref in hay
    return all(str(t).lower() in hay for t in terms)


def match_quality(gold_item: dict) -> int:
    """How specific a gold item's claim is, for assignment ordering.

    The number of must_match_terms: satisfying a 3-term item is stronger
    evidence of a real hit than satisfying a 1-term one, so the tighter item
    gets first claim on a proposal. A term-less item (matched by its full
    statement) counts as 1.
    """
    return len(gold_item.get("must_match_terms") or []) or 1


def assign_one_to_one(
    proposals: list[dict], gold_items: list[dict]
) -> tuple[dict[int, int], list[int]]:
    """Greedy one-to-one assignment of proposals to gold items.

    Returns ({proposal index: gold index}, [duplicate proposal indices]).

    Every candidate (proposal, gold) pair that satisfies `statement_matches`
    is sorted by match quality (most must_match_terms first), then proposal
    order, then gold order, and taken greedily. A proposal that matched
    something but whose every match was already claimed is a DUPLICATE: before
    scorer v2 it was credited as an independent correct proposal, which let a
    model inflate precision by restating one memory five ways.
    """
    candidates: list[tuple[int, int, int]] = []
    for pi, p in enumerate(proposals):
        statement = p.get("statement")
        for gi, gold_item in enumerate(gold_items):
            if statement_matches(statement, gold_item):
                candidates.append((match_quality(gold_item), pi, gi))
    candidates.sort(key=lambda c: (-c[0], c[1], c[2]))

    assigned: dict[int, int] = {}
    claimed: set[int] = set()
    for _, pi, gi in candidates:
        if pi in assigned or gi in claimed:
            continue
        assigned[pi] = gi
        claimed.add(gi)

    matched_any = {pi for _, pi, _ in candidates}
    duplicates = sorted(matched_any - set(assigned))
    return assigned, duplicates


# --------------------------------------------------------------------------
# bootstrap
# --------------------------------------------------------------------------

def bootstrap_ci(
    pairs: list[tuple[int, int]],
    resamples: int = BOOTSTRAP_RESAMPLES,
    seed: int = BOOTSTRAP_SEED,
    alpha: float = BOOTSTRAP_ALPHA,
) -> list[float] | None:
    """Percentile bootstrap CI for a ratio-of-sums, resampling UNITS.

    `pairs` is one (numerator, denominator) per unit. Units are the
    independent draw here, not proposals: five proposals from one transcript
    slice share a topic, a speaker and a failure mode, so resampling them
    individually would report an interval several times too narrow.

    Returns None when there is nothing to resample (no units, or every
    denominator zero).
    """
    if not pairs:
        return None
    if not sum(den for _, den in pairs):
        return None

    rng = random.Random(seed)
    n = len(pairs)
    draws: list[float] = []
    for _ in range(resamples):
        num_sum = den_sum = 0
        for _ in range(n):
            num, den = pairs[rng.randrange(n)]
            num_sum += num
            den_sum += den
        if den_sum:
            draws.append(num_sum / den_sum)
    if not draws:
        return None
    draws.sort()
    last = len(draws) - 1
    lo = draws[max(0, int(round((alpha / 2) * last)))]
    hi = draws[min(last, int(round((1 - alpha / 2) * last)))]
    return [round(lo, 4), round(hi, 4)]


# --------------------------------------------------------------------------
# scoring
# --------------------------------------------------------------------------

def score(
    results_dir: Path,
    gold: dict[str, dict[str, Any]],
    units: dict[str, str],
    allow_partial: bool = False,
) -> dict[str, Any]:
    units_out = results_dir / "units"
    rows: list[dict[str, Any]] = []
    for path in sorted(units_out.glob("unit_*.json")):
        try:
            rows.append(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            continue

    # Run-validity guard. `timeout` is a model outcome and stays scoreable;
    # transport_error / http_error / bad_body mean the request never produced
    # model output. Scoring them would report a dead server as abstention
    # (fail-closed degenerating into fail-empty — the exact failure this
    # harness exists to measure, not commit).
    infra = [r for r in rows if r.get("status") not in ("ok", "timeout")]
    if infra:
        by_status: dict[str, int] = {}
        for r in infra:
            key = str(r.get("status") or "?")
            by_status[key] = by_status.get(key, 0) + 1
        msg = (
            f"{results_dir}: {len(infra)}/{len(rows)} rows are infrastructure "
            f"failures ({by_status}), not model output"
        )
        if not allow_partial:
            raise SystemExit(
                f"FATAL: {msg}. Re-run the bench (failed rows re-run "
                f"automatically) or pass --allow-partial to score only the "
                f"rows that reached the model."
            )
        print(f"  ! {msg} — excluded from scoring (--allow-partial)", file=sys.stderr)
        rows = [r for r in rows if r.get("status") in ("ok", "timeout")]

    meta = {}
    meta_path = results_dir / "run_meta.json"
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            meta = {}

    n_total = n_scored = 0
    n_parse_error = n_timeout = n_degenerate_output = n_incoherent = 0
    pos_units = neg_units = 0
    degenerate_on_positive = 0
    degenerate_breakdown: dict[str, int] = {}
    correct_abstentions = 0
    over_extracted_units = 0

    all_proposals = 0
    g1_rejects = g2_rejects = g3_flags = passes = 0
    postgate_on_positive = 0
    postgate_matched = 0
    gold_items_total = gold_items_matched = 0
    rejected_total = rejected_but_gold = 0
    latencies: list[float] = []
    per_unit: list[dict[str, Any]] = []

    # v2 accumulators
    duplicate_proposals = 0
    admissible_total = admissible_rejected = 0
    role_gradable = role_mismatch = 0
    role_ungradable: dict[str, int] = {}
    g2_span_pass = g2_unit_fallback = g2_vacuous = 0
    type_agree = type_agree_den = 0

    # spec 19.1 accumulators
    generator_matched = 0            # gold items claimed PRE-gate
    admissible_escalated = 0         # admissible survivors routed to review
    over_escalation_by_code: dict[str, int] = {}
    review_flag_breakdown: dict[str, int] = {}

    _CLS_KEYS = ("prec_num", "prec_den", "rec_num", "rec_den",
                 "fr_num", "fr_den", "gen_num", "oe_num")
    cls: dict[str, dict[str, int]] = {
        t: dict.fromkeys(_CLS_KEYS, 0) for t in GOLD_TYPES
    }

    def cls_bucket(name: Any) -> dict[str, int]:
        """Per-class counters, with an 'other' bin so an off-enum type from a
        model (or a gold file) is visible instead of silently dropped."""
        key = str(name).strip().lower() if isinstance(name, str) else "other"
        if key not in cls:
            cls[key] = dict.fromkeys(_CLS_KEYS, 0)
        return cls[key]

    # Per-unit (numerator, denominator) pairs, for the unit-level bootstrap.
    boot_precision: list[tuple[int, int]] = []
    boot_recall: list[tuple[int, int]] = []
    boot_false_reject: list[tuple[int, int]] = []
    boot_generator_recall: list[tuple[int, int]] = []
    boot_over_escalation: list[tuple[int, int]] = []

    for row in rows:
        n_total += 1
        uid = row.get("unit_id")
        status = row.get("status")
        parse_status = row.get("parse_status")

        if status == "timeout":
            n_timeout += 1
        if parse_status == "parse_error":
            n_parse_error += 1
        if parse_status == "degenerate":
            n_degenerate_output += 1
        if row.get("incoherent_abstention"):
            n_incoherent += 1
        if status == "ok" and isinstance(row.get("wall_seconds"), (int, float)):
            latencies.append(float(row["wall_seconds"]))

        g = gold.get(uid)
        if g is None:
            continue
        text = units.get(uid, "")
        n_scored += 1

        checked = verify_unit(row, text)
        props = checked["proposals"]
        all_proposals += len(props)
        g1_rejects += checked["counts"]["reject_g1"]
        g2_rejects += checked["counts"]["reject_g2"]
        g3_flags += checked["counts"]["flag_g3"]
        passes += checked["counts"]["pass"]

        # verify_sid.py's non-terminal review flags, positionally aligned to
        # `props`. Empty for a quote-contract run, which has none.
        rflags = row_review_flags(row, len(props))
        for p, flags in zip(props, rflags):
            for code in escalation_codes(p, flags):
                review_flag_breakdown[code] = review_flag_breakdown.get(code, 0) + 1

        # --- verifier-side flags (orthogonal to gold; count everywhere) ----
        unit_flags = checked.get("flags") or {}
        role_gradable += unit_flags.get("role_gradable", 0)
        role_mismatch += unit_flags.get("role_mismatch", 0)
        g2_span_pass += unit_flags.get("g2_span_pass", 0)
        g2_unit_fallback += unit_flags.get("g2_unit_fallback", 0)
        g2_vacuous += unit_flags.get("g2_vacuous", 0)
        for p in props:
            role = p.get("role") or {}
            if not role.get("gradable"):
                reason = role.get("ungradable_reason") or "unknown"
                role_ungradable[reason] = role_ungradable.get(reason, 0) + 1

        surviving = [p for p in props if p["verdict"] in ("pass", "flag(G3)")]
        rejected = [p for p in props if p["verdict"].startswith("reject")]

        gold_items = g["gold_proposals"]
        # Positive == there is something to find. `nothing_durable` in gold is
        # the human's assertion about the same thing; gold_proposals is the
        # operative field, so a gold file that sets both is not ambiguous.
        is_positive = bool(gold_items)

        unit_rec: dict[str, Any] = {
            "unit_id": uid,
            "gold_positive": is_positive,
            "status": status,
            "parse_status": parse_status,
            "n_proposals": len(props),
            "n_surviving": len(surviving),
            "wall_seconds": row.get("wall_seconds"),
        }

        if is_positive:
            pos_units += 1
            gold_items_total += len(gold_items)

            if len(props) == 0:
                degenerate_on_positive += 1
                reason = (
                    "timeout" if status == "timeout"
                    else parse_status if parse_status in ("parse_error", "degenerate", "no_content")
                    else "empty_proposals"
                )
                degenerate_breakdown[reason] = degenerate_breakdown.get(reason, 0) + 1
                unit_rec["degenerate_reason"] = reason

            postgate_on_positive += len(surviving)

            # --- one-to-one assignment (scorer v2) -------------------------
            assigned, duplicates = assign_one_to_one(surviving, gold_items)
            postgate_matched += len(assigned)
            gold_items_matched += len(assigned)   # == |claimed gold|, by construction
            duplicate_proposals += len(duplicates)

            unit_rec["gold_matched"] = len(assigned)
            unit_rec["gold_total"] = len(gold_items)
            unit_rec["duplicate_proposals"] = len(duplicates)
            if duplicates:
                unit_rec["duplicates"] = [surviving[i].get("statement") for i in duplicates]

            boot_precision.append((len(assigned), len(surviving)))
            boot_recall.append((len(assigned), len(gold_items)))

            # --- generator_candidate_recall (spec 19.1) --------------------
            # The SAME one-to-one assignment, run over every PRE-gate
            # proposal. Deliberately the same function: if the two used
            # different matching rules the difference between them would
            # measure the scorer, not the verifier.
            gen_assigned, _ = assign_one_to_one(props, gold_items)
            generator_matched += len(gen_assigned)
            unit_rec["generator_matched"] = len(gen_assigned)
            boot_generator_recall.append((len(gen_assigned), len(gold_items)))

            # --- per-class -------------------------------------------------
            for gold_item in gold_items:
                cls_bucket(gold_item.get("type"))["rec_den"] += 1
            for gi in gen_assigned.values():
                cls_bucket(gold_items[gi].get("type"))["gen_num"] += 1
            for p in surviving:
                cls_bucket(p.get("type"))["prec_den"] += 1
            for pi, gi in assigned.items():
                gold_type = gold_items[gi].get("type")
                prop_type = surviving[pi].get("type")
                cls_bucket(gold_type)["rec_num"] += 1
                cls_bucket(prop_type)["prec_num"] += 1
                type_agree_den += 1
                if isinstance(prop_type, str) and isinstance(gold_type, str) \
                        and prop_type.strip().lower() == gold_type.strip().lower():
                    type_agree += 1

            # --- verifier false-reject, per the curator spec ----------------
            # Denominator: every ADMISSIBLE candidate -- a pre-gate proposal
            # whose statement matches gold, i.e. one the model got right.
            # Numerator: those the gauntlet terminally rejected. Measured
            # pre-gate on purpose; a gate cannot be audited by the survivors
            # it produced.
            # verifier_over_escalation_rate rides the SAME admissible
            # denominator (see the PROXY WARNING in the module docstring), so
            # false rejects, escalations and clean passes partition it.
            unit_adm = unit_adm_rejected = unit_adm_escalated = 0
            for idx, p in enumerate(props):
                hits = [gi for gi, gold_item in enumerate(gold_items)
                        if statement_matches(p.get("statement"), gold_item)]
                if not hits:
                    continue
                unit_adm += 1
                bucket = cls_bucket(gold_items[hits[0]].get("type"))
                bucket["fr_den"] += 1
                if p["verdict"].startswith("reject"):
                    unit_adm_rejected += 1
                    bucket["fr_num"] += 1
                    unit_rec.setdefault("false_rejects", []).append(p.get("statement"))
                    continue
                codes = escalation_codes(p, rflags[idx])
                if codes:
                    unit_adm_escalated += 1
                    bucket["oe_num"] += 1
                    # Candidates and codes are counted separately: one
                    # candidate can carry Synthesis AND OversizedEvidence, and
                    # 19.1 wants both attributed.
                    for code in codes:
                        over_escalation_by_code[code] = (
                            over_escalation_by_code.get(code, 0) + 1)
                    unit_rec.setdefault("over_escalations", []).append(
                        {"statement": p.get("statement"), "codes": codes})
            admissible_total += unit_adm
            admissible_rejected += unit_adm_rejected
            admissible_escalated += unit_adm_escalated
            unit_rec["admissible"] = unit_adm
            unit_rec["admissible_rejected"] = unit_adm_rejected
            unit_rec["admissible_escalated"] = unit_adm_escalated
            boot_false_reject.append((unit_adm_rejected, unit_adm))
            boot_over_escalation.append((unit_adm_escalated, unit_adm))

            # --- v1 false-reject formula, kept for continuity --------------
            for p in rejected:
                rejected_total += 1
                if any(statement_matches(p.get("statement"), gi) for gi in gold_items):
                    rejected_but_gold += 1
        else:
            neg_units += 1
            if row.get("nothing_durable") and len(props) == 0:
                correct_abstentions += 1
                unit_rec["abstained"] = True
            if surviving:
                over_extracted_units += 1
                unit_rec["over_extracted"] = [p.get("statement") for p in surviving]
            # Anything emitted on a negative unit is by definition unwanted,
            # so every reject here is a correct reject (no gold to match).
            rejected_total += len(rejected)

        per_unit.append(unit_rec)

    g2_survivors = g2_span_pass + g2_unit_fallback + g2_vacuous
    per_class = {}
    for name, c in cls.items():
        if not any(c.values()):
            continue
        per_class[name] = {
            "precision": pct(c["prec_num"], c["prec_den"]),
            "recall": pct(c["rec_num"], c["rec_den"]),
            "generator_candidate_recall": pct(c["gen_num"], c["rec_den"]),
            "false_reject_rate": pct(c["fr_num"], c["fr_den"]),
            "over_escalation_rate": pct(c["oe_num"], c["fr_den"]),
            "gold_items": c["rec_den"],
            "gold_matched": c["rec_num"],
            "gold_matched_pre_gate": c["gen_num"],
            "surviving_declared": c["prec_den"],
            "admissible": c["fr_den"],
            "admissible_rejected": c["fr_num"],
            "admissible_escalated": c["oe_num"],
        }

    metrics = {
        "scorer_version": SCORER_VERSION,
        "model": meta.get("model") or results_dir.name,
        "results_dir": str(results_dir),
        "n_result_files": n_total,
        "n_scored_against_gold": n_scored,
        "n_gold_positive_units": pos_units,
        "n_gold_negative_units": neg_units,

        "degenerate_rate": pct(degenerate_on_positive, pos_units),
        "degenerate_count": degenerate_on_positive,
        "degenerate_breakdown": degenerate_breakdown,

        "abstention_correctness": pct(correct_abstentions, neg_units),
        "abstention_count": correct_abstentions,

        "pre_gate_unsupported_rate": pct(g1_rejects, all_proposals),
        "post_gate_precision": pct(postgate_matched, postgate_on_positive),
        "post_gate_recall": pct(gold_items_matched, gold_items_total),
        "over_extraction_rate": pct(over_extracted_units, neg_units),

        # spec 19.1: the generator's own ceiling, measured PRE-gate. The gap
        # to post_gate_recall is exactly what the verifier destroyed, which is
        # the "fail closed must not degenerate into fail empty" reading.
        "generator_candidate_recall": pct(generator_matched, gold_items_total),
        "generator_candidate_recall_count": generator_matched,
        "gold_matched_count": gold_items_matched,
        "gold_item_count": gold_items_total,

        # v2: one-to-one matching fallout.
        "duplicate_rate": pct(duplicate_proposals, all_proposals),
        "duplicate_rate_of_surviving": pct(duplicate_proposals, postgate_on_positive),
        "duplicate_proposal_count": duplicate_proposals,

        # v2: the spec's false-reject metric -- admissible candidates the
        # gauntlet killed / all admissible candidates.
        "verifier_false_reject_rate": pct(admissible_rejected, admissible_total),
        "verifier_false_reject_count": admissible_rejected,
        "admissible_candidate_count": admissible_total,

        # spec 19.1: the OTHER half of the same denominator -- admissible
        # candidates the gauntlet neither killed nor passed clean, but routed
        # to a human. `over_escalation_by_code` counts CODES (a candidate can
        # carry two); `verifier_over_escalation_count` counts CANDIDATES, and
        # only that one is the rate's numerator.
        "verifier_over_escalation_rate": pct(admissible_escalated, admissible_total),
        "verifier_over_escalation_count": admissible_escalated,
        "over_escalation_by_code": over_escalation_by_code,
        # Every escalation in the run, admissible or not: the queue-burden
        # view, since a reviewer pays for the escalations gold never labeled
        # too.
        "review_flag_breakdown": review_flag_breakdown,

        # DEPRECATED (v1 formula: gold-matching rejects / ALL rejects). Kept
        # so pre-v2 metrics.json files stay comparable. Do not headline it.
        "verifier_false_reject_est": pct(rejected_but_gold, rejected_total),
        "verifier_false_reject_est_deprecated": True,
        "verifier_false_reject_est_count": rejected_but_gold,
        "rejected_total": rejected_total,

        # v2: source_role attribution (a flag, never a reject).
        "source_role_accuracy": pct(role_gradable - role_mismatch, role_gradable),
        "role_mismatch_count": role_mismatch,
        "role_gradable_count": role_gradable,
        "role_ungradable_breakdown": role_ungradable,

        # v2: how G2 was actually satisfied by the proposals that survived it.
        "g2_span_pass_rate": pct(g2_span_pass, g2_survivors),
        "g2_unit_fallback_rate": pct(g2_unit_fallback, g2_survivors),
        "g2_vacuous_rate": pct(g2_vacuous, g2_survivors),
        "g2_survivor_count": g2_survivors,

        "type_agreement_rate": pct(type_agree, type_agree_den),
        "per_class": per_class,
        "abstention": {
            "n_gold_negative_units": neg_units,
            "abstention_correctness": pct(correct_abstentions, neg_units),
            "over_extraction_rate": pct(over_extracted_units, neg_units),
            "incoherent_abstention_rate": pct(n_incoherent, n_total),
        },
        "ci": {
            "post_gate_precision": bootstrap_ci(boot_precision),
            "post_gate_recall": bootstrap_ci(boot_recall),
            "verifier_false_reject_rate": bootstrap_ci(boot_false_reject),
            "generator_candidate_recall": bootstrap_ci(boot_generator_recall),
            "verifier_over_escalation_rate": bootstrap_ci(boot_over_escalation),
            "method": {
                "kind": "unit-level percentile bootstrap",
                "resamples": BOOTSTRAP_RESAMPLES,
                "seed": BOOTSTRAP_SEED,
                "level": round(1 - BOOTSTRAP_ALPHA, 3),
            },
        },

        "json_parse_failure_rate": pct(n_parse_error, n_total),
        "degenerate_output_count": n_degenerate_output,
        "timeout_count": n_timeout,
        "incoherent_abstention_count": n_incoherent,
        "incoherent_abstention_rate": pct(n_incoherent, n_total),

        "latency_p50_s": percentile(latencies, 50),
        "latency_p95_s": percentile(latencies, 95),
        "latency_n": len(latencies),
        "cold_load_s": meta.get("cold_load_seconds"),

        "proposal_totals": {
            "all": all_proposals,
            "pass": passes,
            "flag_g3": g3_flags,
            "reject_g1": g1_rejects,
            "reject_g2": g2_rejects,
        },
        "think_sent": meta.get("think_sent"),
        "units": per_unit,
    }
    return metrics


# --------------------------------------------------------------------------
# reporting
# --------------------------------------------------------------------------

# (label, metrics key, direction, show a bootstrap CI alongside the point value)
ROWS = [
    ("Degenerate rate (gold+, empty out)", "degenerate_rate", "lower", False),
    ("Abstention correctness (gold-)", "abstention_correctness", "higher", False),
    ("Pre-gate unsupported (G1/props)", "pre_gate_unsupported_rate", "lower", False),
    ("Generator candidate recall (pre-gate)", "generator_candidate_recall", "higher", True),
    ("Post-gate precision", "post_gate_precision", "higher", True),
    ("Post-gate recall", "post_gate_recall", "higher", True),
    ("Duplicate rate (dupes/props)", "duplicate_rate", "lower", False),
    ("Over-extraction rate (gold-)", "over_extraction_rate", "lower", False),
    ("Verifier false-reject rate", "verifier_false_reject_rate", "lower", True),
    ("Verifier over-escalation rate", "verifier_over_escalation_rate", "lower", True),
    ("Verifier false-reject est. (v1, deprecated)", "verifier_false_reject_est", "lower", False),
    ("Source-role accuracy", "source_role_accuracy", "higher", False),
    ("G2 span pass rate", "g2_span_pass_rate", "higher", False),
    ("G2 unit-fallback rate", "g2_unit_fallback_rate", "lower", False),
    ("Incoherent abstention rate", "incoherent_abstention_rate", "lower", False),
    ("JSON parse failure rate", "json_parse_failure_rate", "lower", False),
    ("Latency p50 (s)", "latency_p50_s", "lower", False),
    ("Latency p95 (s)", "latency_p95_s", "lower", False),
    ("Cold load (s)", "cold_load_s", "lower", False),
]

PER_CLASS_ROWS = [
    ("precision", "precision"),
    ("generator recall", "generator_candidate_recall"),
    ("recall", "recall"),
    ("false-reject", "false_reject_rate"),
    ("over-escalation", "over_escalation_rate"),
]


def fmt_ci(metrics: dict[str, Any], key: str) -> str:
    """`0.312 [0.241, 0.388]` -- point estimate plus its bootstrap interval."""
    point = fmt(metrics.get(key))
    interval = (metrics.get("ci") or {}).get(key)
    if not interval:
        return point
    return f"{point} [{interval[0]:.3f}, {interval[1]:.3f}]"


def markdown_table(all_metrics: list[dict[str, Any]]) -> str:
    models = [m["model"] for m in all_metrics]
    lines = [
        "| Metric | Want | " + " | ".join(models) + " |",
        "|---|---|" + "---|" * len(models),
    ]
    for label, key, want, with_ci in ROWS:
        if with_ci:
            cells = " | ".join(fmt_ci(m, key) for m in all_metrics)
        else:
            cells = " | ".join(fmt(m.get(key)) for m in all_metrics)
        lines.append(f"| {label} | {want} | {cells} |")

    lines.append("")
    lines.append("| Counts | " + " | ".join(models) + " |")
    lines.append("|---|" + "---|" * len(models))
    for label, path in [
        ("units scored", "n_scored_against_gold"),
        ("gold-positive units", "n_gold_positive_units"),
        ("gold-negative units", "n_gold_negative_units"),
        ("proposals total", ("proposal_totals", "all")),
        ("  pass", ("proposal_totals", "pass")),
        ("  flag(G3)", ("proposal_totals", "flag_g3")),
        ("  reject(G1)", ("proposal_totals", "reject_g1")),
        ("  reject(G2)", ("proposal_totals", "reject_g2")),
        ("duplicate proposals", "duplicate_proposal_count"),
        ("gold items (denominator)", "gold_item_count"),
        ("  claimed pre-gate", "generator_candidate_recall_count"),
        ("  still claimed post-gate", "gold_matched_count"),
        ("admissible candidates (pre-gate)", "admissible_candidate_count"),
        ("  of which rejected", "verifier_false_reject_count"),
        ("  of which escalated to review", "verifier_over_escalation_count"),
        ("role-gradable proposals", "role_gradable_count"),
        ("  role mismatches", "role_mismatch_count"),
        ("timeouts", "timeout_count"),
    ]:
        vals = []
        for m in all_metrics:
            v = m[path[0]].get(path[1]) if isinstance(path, tuple) else m.get(path)
            vals.append(fmt(v))
        lines.append(f"| {label} | " + " | ".join(vals) + " |")

    # --- per gold class ---------------------------------------------------
    # Aggregate numbers hide a model that is competent on `fact` and blind to
    # `preference`, which for a memory curator is the worse failure.
    classes = [t for t in GOLD_TYPES
               if any(t in (m.get("per_class") or {}) for m in all_metrics)]
    extra = sorted({c for m in all_metrics for c in (m.get("per_class") or {})}
                   - set(GOLD_TYPES))
    lines.append("")
    lines.append("### Per gold class")
    lines.append("")
    lines.append("| Class | Metric | " + " | ".join(models) + " |")
    lines.append("|---|---|" + "---|" * len(models))
    for cname in classes + extra:
        for label, key in PER_CLASS_ROWS:
            vals = []
            for m in all_metrics:
                block = (m.get("per_class") or {}).get(cname) or {}
                vals.append(fmt(block.get(key)))
            lines.append(f"| {cname} | {label} | " + " | ".join(vals) + " |")
        vals = []
        for m in all_metrics:
            block = (m.get("per_class") or {}).get(cname) or {}
            vals.append(fmt(block.get("gold_items")))
        lines.append(f"| {cname} | gold items | " + " | ".join(vals) + " |")

    lines.append("")
    lines.append("Per-class precision keys off the type the model DECLARED "
                 "(a false positive has no gold item to inherit one from); "
                 "recall and false-reject key off the GOLD item's type. "
                 "`type_agreement_rate` below is how often they agree on an "
                 "assigned pair.")
    lines.append("")
    vals = " | ".join(fmt(m.get("type_agreement_rate")) for m in all_metrics)
    lines.append("| Metric | " + " | ".join(models) + " |")
    lines.append("|---|" + "---|" * len(models))
    lines.append("| Type agreement (assigned pairs) | " + vals + " |")

    # --- abstention, reported apart from the extraction metrics -----------
    lines.append("")
    lines.append("### Abstention (gold-negative units only)")
    lines.append("")
    lines.append("| Metric | Want | " + " | ".join(models) + " |")
    lines.append("|---|---|" + "---|" * len(models))
    for label, key, want in [
        ("Abstention correctness", "abstention_correctness", "higher"),
        ("Over-extraction rate", "over_extraction_rate", "lower"),
        ("Incoherent abstention rate", "incoherent_abstention_rate", "lower"),
    ]:
        cells = " | ".join(fmt((m.get("abstention") or {}).get(key)) for m in all_metrics)
        lines.append(f"| {label} | {want} | {cells} |")
    n_neg = all_metrics[0].get("n_gold_negative_units")
    lines.append("")
    lines.append(f"Computed over {n_neg} gold-negative units — too few for a "
                 "usable interval, so no CI is quoted. Treat these as a "
                 "directional smell test, not a measurement.")

    # --- spec 19.1 escalation attribution ---------------------------------
    lines.append("")
    lines.append("### Review escalations, by gate and code (spec 19.1)")
    lines.append("")
    codes = sorted({c for m in all_metrics
                    for c in (m.get("review_flag_breakdown") or {})})
    if not codes:
        lines.append("No non-terminal review outcome in any run "
                     "(`flag(G3)` and the sentence-ID review flags were all "
                     "absent). An over-escalation rate of 0.000 here means "
                     "*nothing was escalated*, not that escalation was "
                     "measured and found correct.")
    else:
        lines.append("| GateName:ReviewCode | " + " | ".join(models) + " |")
        lines.append("|---|" + "---|" * len(models))
        for code in codes:
            cells = " | ".join(
                fmt((m.get("review_flag_breakdown") or {}).get(code, 0))
                for m in all_metrics)
            lines.append(f"| {code} | {cells} |")
        lines.append("")
        lines.append("Whole-run counts (the reviewer's queue). The "
                     "`verifier_over_escalation_rate` above restricts the same "
                     "attribution to ADMISSIBLE candidates and counts "
                     "candidates, not codes — one candidate can carry two. "
                     "`OversizedEvidence` is listed apart from `Synthesis` "
                     "because §19.1 requires it.")
    lines.append("")
    lines.append("**Proxy caveat.** `generator_candidate_recall` is the spec's "
                 "metric exactly. `verifier_false_reject_rate` and "
                 "`verifier_over_escalation_rate` are NOT: both are defined "
                 "against a gold `ProposalReady`/`ReviewRequired` disposition "
                 "that has never been annotated, and both stand in "
                 "\"the statement matches a gold item\" for it. Calibration "
                 "numbers, not acceptance scores.")

    ci_method = (all_metrics[0].get("ci") or {}).get("method") or {}
    lines.append("")
    lines.append(
        f"Intervals are 95% unit-level percentile bootstrap "
        f"({ci_method.get('resamples')} resamples, seed {ci_method.get('seed')}), "
        "resampling gold-positive units with replacement."
    )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Score curator runs against gold.")
    ap.add_argument("--results-dir", required=True, type=Path, nargs="+",
                    help="one or more results/<model>/ dirs (multiple => comparison table)")
    ap.add_argument("--gold-dir", required=True, type=Path)
    ap.add_argument("--units-dir", required=True, type=Path)
    ap.add_argument("--out-md", type=Path, default=None,
                    help="markdown summary path (default: alongside the first results dir)")
    ap.add_argument("--allow-partial", action="store_true",
                    help="score a run containing infrastructure-failure rows "
                         "(transport_error/http_error/bad_body) by excluding "
                         "them, instead of refusing the run outright")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    gold = load_gold(args.gold_dir)
    if not gold:
        print(f"FATAL: no gold files in {args.gold_dir}", file=sys.stderr)
        return 2
    units = {u["id"]: u["text"] for u in load_units(args.units_dir)}
    if not units:
        print(f"FATAL: no units in {args.units_dir}", file=sys.stderr)
        return 2

    all_metrics = []
    for rd in args.results_dir:
        if not (rd / "units").is_dir():
            print(f"  ! skipping {rd}: no units/ subdir", file=sys.stderr)
            continue
        m = score(rd, gold, units, allow_partial=args.allow_partial)
        (rd / "metrics.json").write_text(json.dumps(m, indent=2), encoding="utf-8")
        all_metrics.append(m)

    if not all_metrics:
        print("FATAL: nothing scored", file=sys.stderr)
        return 2

    table = markdown_table(all_metrics)
    dest = args.out_md or (args.results_dir[0] / "metrics.md")
    dest.write_text(
        "# Curator benchmark\n\n" + table + "\n", encoding="utf-8"
    )
    if not args.quiet:
        print(table)
        print(f"\nwrote {dest} and metrics.json per model")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
