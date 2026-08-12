"""Deterministic verification gauntlet for the SENTENCE-ID contract.

Sibling of verify.py (quote contract) and verify_anchor.py (anchor contract).
One changed premise, and it is the whole point: the model no longer produces
evidence text of any kind. The server enumerates the sentences of the unit,
the model emits `evidence: ["S12"]`, and this verifier -- playing the role the
product plays -- resolves those IDs against its OWN table and slices its OWN
text. A fabricated quote is not a validation failure here; it is unexpressible.

Enumeration comes from `sid.py`, the same module `run_bench.py --render sid`
uses to build the prompt. One implementation, two callers: if the prompt says
S12 and the verifier reads S12, they are the same sentence by construction,
not by convention.

Gates
  G1a resolve      Every ID must match ^S[1-9][0-9]{0,3}$, exist in this
                   unit's table, be distinct, and -- for a multi-ID citation
                   -- name ADJACENT sentences (prompt rule 3; LongCite's
                   fragmented-citation failure engineered away). A sentence
                   touched by redaction is enumerable but not citable
                   (guide 2.2, product G02). 1 to 3 IDs.
  G1b primary      The server designates ONE Primary sentence, per the
                   amended spec's G05 rule: the cited sentence whose
                   protected-token coverage of the statement is complete
                   (lowest sid on a tie). If none covers it, the
                   HIGHEST-COVERAGE sentence (lowest sid on a tie) is
                   retained anyway -- deliberately, as failure plumbing --
                   so a token mismatch surfaces at the lexical gate with a
                   precise reason instead of dying ambiguously at
                   designation. If the union of the citation covers the
                   claim, that is legitimate synthesis: a review FLAG, not a
                   reject. The other cited IDs are recorded as context.
                   Materialization happens here and only here.
  G2  containment  identical to verify.py, with the materialized PRIMARY
                   sentence as the haystack and the whole unit as a recorded
                   fallback (`unit_only`) rather than a reject. This is the
                   harness twin of product G06: a token in neither is an
                   invention and rejects the proposal.
  G3  polarity     identical to verify.py, run against the Primary sentence.

Verdicts: pass | reject(G1) | reject(G2) | flag(G3), precedence G1 > G2 > G3
-- the same ladder verify.py and verify_anchor.py use, so all three contracts
are comparable on one axis.

Review flags are additive and never change a verdict, mirroring the product's
non-terminal `RequireReview`: `synthesis` (claim assembled across the cited
window), `oversized_evidence` (an over-cap opaque block was cited), and
`unclaimable_role` (the Primary is a tool/system sentence, which the output
schema has no value for).

HOW score.py SEES THIS
  score.py imports `verify_unit` from verify.py and re-derives verdicts from
  `parsed.proposals[].grounding_quote`, so the resolved evidence has to exist
  in the result rows. This verifier writes it back (disable with --no-inject):

    resolved      -> grounding_quote = the materialized Primary sentence. It
                     is a literal substring of the unit, so verify.py reports
                     g1.match = "exact". Honest: the system really did produce
                     verbatim evidence -- it read it off its own table.
    unresolved    -> grounding_quote = a sentinel that cannot occur in any
                     transcript -> "none" -> reject. Under this contract there
                     is no case-drift ladder: materialization is exact or it
                     did not happen.

  The model's raw output is never destroyed: `content` keeps the verbatim
  response body and each proposal keeps its `evidence` ID list. Injected rows
  are stamped `_sid_resolution` so nobody mistakes a sid run for a quote run.

  One honest limitation of the write-back: verify.py re-locates the injected
  quote by SEARCH and attributes it to the nearest preceding role marker, so a
  sentence whose text occurs twice in a unit can be attributed to the earlier
  occurrence. This verifier does not have that problem -- it knows the offset
  -- and reports the exact figure as `source_role_accuracy_from_table`. Prefer
  that number over score.py's re-derived one for the sid contract.

Usage:
    python3 eval/curator/verify_sid.py \
        --results-dir eval/curator/results/qwen3-coder-30b-sid \
        --units-dir eval/curator/units

Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))
import sid as sidmod  # noqa: E402  (THE shared enumeration; see module docstring)
from run_bench import load_units  # noqa: E402  (shared unit loader)
from verify import _fold, content_tokens, polarity_flag  # noqa: E402

# The schema's anchored pattern. Re-checked here because a grammar guarantees
# shape, never completeness: truncation and post-processing can bypass it.
SID_PATTERN = re.compile(r"^S[1-9][0-9]{0,3}$")

MIN_IDS = 1
MAX_IDS = 3

# Cannot occur in a transcript, so verify.py's G1 always reports "none".
SENTINEL = "␟<sid-unresolved:{reason}>"


# --------------------------------------------------------------------------
# G1a: resolve the citation
# --------------------------------------------------------------------------

def resolve_citation(
    evidence: Any,
    table: dict[str, Any],
    max_ids: int = MAX_IDS,
) -> tuple[list[int] | None, str]:
    """Validate the ID list. Returns (sorted sids, reason). sids None on failure.

    Order of checks is deliberate: shape, then existence, then the properties
    that only make sense once every ID resolves.
    """
    if not isinstance(evidence, list) or not evidence:
        return None, "missing_evidence"
    if len(evidence) < MIN_IDS or len(evidence) > max_ids:
        return None, "too_many_ids" if len(evidence) > max_ids else "missing_evidence"

    sids: list[int] = []
    for raw in evidence:
        if not isinstance(raw, str) or not SID_PATTERN.match(raw):
            return None, "invalid_id_format"
        n = int(raw[1:])
        if sidmod.sentence_by_sid(table, n) is None:
            return None, "id_not_found"
        if n in sids:
            return None, "duplicate_id"
        sids.append(n)

    ordered = sorted(sids)
    # Multi-ID citations must name adjacent sentences.
    if any(b != a + 1 for a, b in zip(ordered, ordered[1:])):
        return None, "non_adjacent"
    # Redaction-touched sentences are readable context, never citable.
    for n in ordered:
        if not sidmod.sentence_by_sid(table, n)["cite_ok"]:
            return None, "redacted_evidence"
    return ordered, "resolved"


# --------------------------------------------------------------------------
# G1b: Primary designation (amended spec G05) + materialization
# --------------------------------------------------------------------------

def designate_primary(
    statement: str,
    sids: list[int],
    unit_text: str,
    table: dict[str, Any],
) -> dict[str, Any]:
    """Pick the Primary sentence and materialize the citation.

    Coverage uses verify.py's `content_tokens` -- the harness's protected-token
    extractor -- so G1b and G2 can never disagree about what a protected token
    is. Two implementations of "which tokens matter" would be the same class of
    bug as two implementations of sentence enumeration.
    """
    tokens = [t["token"] for t in content_tokens(statement)]
    per_sid: dict[int, dict[str, Any]] = {}
    for n in sids:
        text = sidmod.resolve(unit_text, table, n) or ""
        folded = _fold(text)
        covered = [t for t in tokens if t.lower() in folded]
        per_sid[n] = {"text": text, "covered": len(covered), "covers_all": len(covered) == len(tokens)}

    complete = [n for n in sids if per_sid[n]["covers_all"]]
    union_covered = {
        t for t in tokens
        if any(t.lower() in _fold(per_sid[n]["text"]) for n in sids)
    }

    if complete:
        # Exactly the spec's rule: eligible set, lowest sid wins.
        primary = min(complete)
        designation = "complete_single" if tokens else "vacuous_no_tokens"
        synthesis = False
    else:
        # Highest-coverage fallback, lowest sid on a tie (amended spec / G05).
        best = max(per_sid[n]["covered"] for n in sids)
        primary = min(n for n in sids if per_sid[n]["covered"] == best)
        if len(union_covered) == len(tokens):
            designation = "union_synthesis"
            synthesis = True
        else:
            # Failure plumbing: keep a deterministic Primary so the lexical
            # gate can name the introduced token, rather than failing here.
            designation = "uncovered_fallback"
            synthesis = False

    sentence = sidmod.sentence_by_sid(table, primary)
    return {
        "primary_sid": primary,
        "primary_text": per_sid[primary]["text"],
        "primary_role": sentence["role"],
        "primary_over_cap": bool(sentence["over_cap"]),
        "primary_opaque": bool(sentence["opaque_block"]),
        "context_sids": [n for n in sids if n != primary],
        "designation": designation,
        "synthesis": synthesis,
        "n_tokens": len(tokens),
        "primary_covered": per_sid[primary]["covered"],
        "union_covered": len(union_covered),
    }


# --------------------------------------------------------------------------
# gauntlet
# --------------------------------------------------------------------------

def verify_proposal(
    proposal: dict,
    unit_text: str,
    table: dict[str, Any],
    max_ids: int = MAX_IDS,
) -> dict[str, Any]:
    statement = proposal.get("statement")
    evidence = proposal.get("evidence")
    claimed_role = proposal.get("source_role")

    out: dict[str, Any] = {
        "statement": statement,
        "evidence": evidence,
        "grounding_quote": None,       # filled with the MATERIALIZED sentence
        "type": proposal.get("type"),
        "source_role": claimed_role,
        "review_flags": [],
    }

    def fail(reason: str, **g1_extra: Any) -> dict[str, Any]:
        g1 = {"match": "none", "reason": reason,
              "n_ids": len(evidence) if isinstance(evidence, list) else 0}
        g1.update(g1_extra)
        out.update(verdict="reject(G1)", g1=g1,
                   resolved=SENTINEL.format(reason=reason), g2=None, g3=None,
                   primary=None)
        return out

    if not isinstance(statement, str) or not statement.strip():
        return fail("missing_statement")
    if not isinstance(evidence, list) or not evidence:
        return fail("missing_evidence")

    sids, reason = resolve_citation(evidence, table, max_ids)
    if sids is None:
        return fail(reason)

    # --- G1b: Primary designation + materialization ---------------------
    primary = designate_primary(statement, sids, unit_text, table)
    span = primary["primary_text"]

    g1: dict[str, Any] = {
        "match": "resolved",
        "n_ids": len(sids),
        "sids": sids,
        "primary_sid": primary["primary_sid"],
        "context_sids": primary["context_sids"],
        "designation": primary["designation"],
        "primary_role": primary["primary_role"],
        "span_chars": len(span),
        "quote_chars": len(span),        # verify.py-compatible field name
        "n_tokens": primary["n_tokens"],
        "primary_covered": primary["primary_covered"],
        "union_covered": primary["union_covered"],
    }
    out["g1"] = g1
    out["primary"] = primary
    out["grounding_quote"] = span
    out["resolved"] = span               # verify.py -> "exact" -> passes its G1

    # Non-terminal review flags, exactly like the product's RequireReview:
    # recorded, never a verdict.
    if primary["synthesis"]:
        out["review_flags"].append("synthesis")
    if primary["primary_over_cap"]:
        out["review_flags"].append("oversized_evidence")
    if primary["primary_role"] not in sidmod.CLAIMABLE_ROLES:
        # The product's parser never enumerates a tool record at all; the
        # harness does, because dropping those lines would hand the sid run a
        # different transcript than the anchor baseline saw.
        out["review_flags"].append("unclaimable_role")

    # Role attribution, read off the table at the exact offset -- no search,
    # so no duplicate-text ambiguity. This is the honest source_role number.
    claimed_norm = claimed_role.strip().lower() if isinstance(claimed_role, str) else None
    gradable = (
        primary["primary_role"] in sidmod.CLAIMABLE_ROLES
        and claimed_norm in sidmod.CLAIMABLE_ROLES
    )
    out["sid_role"] = {
        "claimed": claimed_norm,
        "derived": primary["primary_role"],
        "gradable": gradable,
        "mismatch": bool(gradable and claimed_norm != primary["primary_role"]),
    }

    # --- G2: containment against the PRIMARY sentence -------------------
    tokens = content_tokens(statement)
    fold_span, fold_unit = _fold(span), _fold(unit_text)
    in_quote, unit_only, missing = [], [], []
    for t in tokens:
        low = t["token"].lower()
        if low in fold_span:
            in_quote.append(t["token"])
        elif low in fold_unit:
            unit_only.append(t["token"])
        else:
            missing.append(t["token"])

    out["g2"] = {
        "checked": [t["token"] for t in tokens],
        "in_quote": in_quote,
        "unit_only": unit_only,
        "missing": missing,
        "fell_back_to_unit": bool(unit_only),
    }

    # --- G3: polarity, against the Primary sentence ---------------------
    out["g3"] = polarity_flag(statement, span)

    if missing:
        out["verdict"] = "reject(G2)"
    elif out["g3"]:
        out["verdict"] = "flag(G3)"
    else:
        out["verdict"] = "pass"
    return out


def verify_unit(
    row: dict,
    unit_text: str,
    max_ids: int = MAX_IDS,
    max_sentences: int = sidmod.DEFAULT_MAX_SENTENCES,
) -> dict[str, Any]:
    parsed = row.get("parsed") or {}
    proposals = parsed.get("proposals") if isinstance(parsed, dict) else None
    if not isinstance(proposals, list):
        proposals = []

    # The SAME enumeration the prompt was built from.
    table = sidmod.enumerate_unit(unit_text, max_sentences=max_sentences)

    checked = []
    for p in proposals:
        if isinstance(p, dict):
            checked.append(verify_proposal(p, unit_text, table, max_ids))
        else:
            checked.append({
                "verdict": "reject(G1)",
                "g1": {"match": "none", "reason": "not_an_object"},
                "resolved": SENTINEL.format(reason="not_an_object"),
                "review_flags": [],
            })

    return {
        "unit_id": row.get("unit_id"),
        "status": row.get("status"),
        "parse_status": row.get("parse_status"),
        "nothing_durable": row.get("nothing_durable"),
        "incoherent_abstention": row.get("incoherent_abstention", False),
        "wall_seconds": row.get("wall_seconds"),
        "n_sentences": len(table["sentences"]),
        "n_records": table["n_records"],
        "dropped_over_sentence_cap": table["dropped_over_cap"],
        "n_proposals": len(checked),
        "proposals": checked,
        "counts": {
            "pass": sum(1 for c in checked if c["verdict"] == "pass"),
            "flag_g3": sum(1 for c in checked if c["verdict"] == "flag(G3)"),
            "reject_g1": sum(1 for c in checked if c["verdict"] == "reject(G1)"),
            "reject_g2": sum(1 for c in checked if c["verdict"] == "reject(G2)"),
        },
    }


# --------------------------------------------------------------------------
# write-back so score.py (which re-verifies via verify.py) works unchanged
# --------------------------------------------------------------------------

def inject(row_path: Path, row: dict, checked: dict) -> None:
    parsed = row.get("parsed") or {}
    proposals = parsed.get("proposals") if isinstance(parsed, dict) else None
    if not isinstance(proposals, list):
        return
    notes = []
    for p, c in zip(proposals, checked["proposals"]):
        if not isinstance(p, dict):
            continue
        p["grounding_quote"] = c.get("resolved")
        g1 = c.get("g1") or {}
        notes.append({
            "evidence": p.get("evidence"),
            "match": g1.get("match"),
            "reason": g1.get("reason"),
            "primary_sid": g1.get("primary_sid"),
            "designation": g1.get("designation"),
            "review_flags": c.get("review_flags") or [],
            "verdict": c.get("verdict"),
        })
    row["_sid_resolution"] = {
        "contract": "sid",
        "segmenter_harness_version": sidmod.SEGMENTER_HARNESS_VERSION,
        "note": ("grounding_quote is NOT model output. It is the sentence this "
                 "system materialized from the model's `evidence` IDs by "
                 "slicing its own table, or a sentinel when the citation could "
                 "not be resolved. Raw model output is in `content` and in each "
                 "proposal's `evidence`."),
        "proposals": notes,
    }
    row_path.write_text(json.dumps(row, indent=2), encoding="utf-8")


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Verify sentence-ID-contract curator proposals.")
    ap.add_argument("--results-dir", required=True, type=Path, help="results/<model>-sid/")
    ap.add_argument("--units-dir", required=True, type=Path)
    ap.add_argument("--out", type=Path, default=None,
                    help="default: <results-dir>/verify_sid.json")
    ap.add_argument("--max-ids", type=int, default=MAX_IDS,
                    help=f"citation cardinality ceiling (pre-registered: {MAX_IDS}); "
                         "change only for a labelled sensitivity run")
    ap.add_argument("--max-sentences", type=int, default=sidmod.DEFAULT_MAX_SENTENCES,
                    help="sentence cap per unit; MUST match the value run_bench.py "
                         f"rendered with (default {sidmod.DEFAULT_MAX_SENTENCES} = uncapped; "
                         f"the product caps at {sidmod.PRODUCT_MAX_SENTENCES} and splits)")
    ap.add_argument("--no-inject", action="store_true",
                    help="do not write resolved grounding_quote back into the result rows "
                         "(score.py will then reject everything)")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    units = {u["id"]: u["text"] for u in load_units(args.units_dir)}
    if not units:
        print(f"FATAL: no units in {args.units_dir}", file=sys.stderr)
        return 2

    units_out = args.results_dir / "units"
    if not units_out.is_dir():
        print(f"FATAL: no results in {units_out}", file=sys.stderr)
        return 2

    verified: list[dict[str, Any]] = []
    sid_stats: dict[str, int] = {
        "resolved": 0, "invalid_id_format": 0, "id_not_found": 0,
        "duplicate_id": 0, "non_adjacent": 0, "redacted_evidence": 0,
        "missing_evidence": 0, "too_many_ids": 0, "missing_statement": 0,
        "not_an_object": 0,
    }
    designation_stats: dict[str, int] = {}
    review_flag_stats: dict[str, int] = {}
    n_ids_hist: dict[int, int] = {}
    role_gradable = role_mismatch = 0
    span_chars: list[int] = []
    sentence_counts: list[int] = []
    over_product_cap = 0

    for path in sorted(units_out.glob("unit_*.json")):
        try:
            row = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"  ! unreadable result {path.name}: {exc}", file=sys.stderr)
            continue
        uid = row.get("unit_id")
        text = units.get(uid)
        if text is None:
            print(f"  ! no unit text for '{uid}', skipped", file=sys.stderr)
            continue

        checked = verify_unit(row, text, args.max_ids, args.max_sentences)
        verified.append(checked)
        sentence_counts.append(checked["n_sentences"])
        if checked["n_sentences"] > sidmod.PRODUCT_MAX_SENTENCES:
            over_product_cap += 1

        for c in checked["proposals"]:
            g1 = c.get("g1") or {}
            reason = g1.get("reason")
            if g1.get("match") == "resolved":
                sid_stats["resolved"] += 1
            elif reason in sid_stats:
                sid_stats[reason] += 1
            else:
                sid_stats[str(reason)] = sid_stats.get(str(reason), 0) + 1
            if isinstance(g1.get("n_ids"), int):
                n_ids_hist[g1["n_ids"]] = n_ids_hist.get(g1["n_ids"], 0) + 1
            if g1.get("designation"):
                designation_stats[g1["designation"]] = designation_stats.get(g1["designation"], 0) + 1
            if isinstance(g1.get("span_chars"), int):
                span_chars.append(g1["span_chars"])
            for flag in c.get("review_flags") or []:
                review_flag_stats[flag] = review_flag_stats.get(flag, 0) + 1
            sr = c.get("sid_role") or {}
            if sr.get("gradable"):
                role_gradable += 1
                if sr.get("mismatch"):
                    role_mismatch += 1

        if not args.no_inject:
            inject(path, row, checked)

    totals = {"pass": 0, "flag_g3": 0, "reject_g1": 0, "reject_g2": 0}
    for v in verified:
        for k in totals:
            totals[k] += v["counts"][k]
    n_props = sum(totals.values())

    def rate(num: int, den: int) -> float:
        return round(num / den, 4) if den else 0.0

    def mean(xs: list[int]) -> float | None:
        return round(sum(xs) / len(xs), 2) if xs else None

    report = {
        "results_dir": str(args.results_dir),
        "contract": "sid",
        "segmenter_harness_version": sidmod.SEGMENTER_HARNESS_VERSION,
        "max_ids": args.max_ids,
        "max_ids_is_preregistered": args.max_ids == MAX_IDS,
        "max_sentences": args.max_sentences,
        "n_units": len(verified),
        "n_proposals": n_props,
        "totals": totals,
        "rates": {
            "pass_rate": rate(totals["pass"], n_props),
            "g1_reject_rate": rate(totals["reject_g1"], n_props),
            "g2_reject_rate": rate(totals["reject_g2"], n_props),
            "g3_flag_rate": rate(totals["flag_g3"], n_props),
            # The sid twin of anchor_located_rate / the quote contract's
            # pre-gate unsupported rate: how often a citation resolved at all.
            "citation_resolved_rate": rate(sid_stats["resolved"], n_props),
            # Exact, offset-derived attribution -- no locate-by-search step.
            "source_role_accuracy_from_table": rate(
                role_gradable - role_mismatch, role_gradable),
        },
        "sid_stats": sid_stats,
        "primary_designation": designation_stats,
        "review_flags": review_flag_stats,
        "n_ids_histogram": {str(k): v for k, v in sorted(n_ids_hist.items())},
        "role_gradable": role_gradable,
        "role_mismatch": role_mismatch,
        "span_chars_mean": mean(span_chars),
        "sentences_per_unit": {
            "mean": mean(sentence_counts),
            "min": min(sentence_counts) if sentence_counts else None,
            "max": max(sentence_counts) if sentence_counts else None,
            f"units_over_product_cap_{sidmod.PRODUCT_MAX_SENTENCES}": over_product_cap,
        },
        "injected_into_results": not args.no_inject,
        "units": verified,
    }

    dest = args.out or (args.results_dir / "verify_sid.json")
    dest.write_text(json.dumps(report, indent=2), encoding="utf-8")
    if not args.quiet:
        print(f"verified {len(verified)} units / {n_props} proposals -> {dest}")
        print(f"  pass={totals['pass']} flag(G3)={totals['flag_g3']} "
              f"reject(G1)={totals['reject_g1']} reject(G2)={totals['reject_g2']}")
        print(f"  citations: resolved={sid_stats['resolved']} "
              f"not_found={sid_stats['id_not_found']} "
              f"non_adjacent={sid_stats['non_adjacent']} "
              f"dup={sid_stats['duplicate_id']} "
              f"redacted={sid_stats['redacted_evidence']} "
              f"bad_format={sid_stats['invalid_id_format']}")
        print(f"  primary: {designation_stats}")
        print(f"  review flags: {review_flag_stats or '{}'}")
        print(f"  source_role (from table): "
              f"{report['rates']['source_role_accuracy_from_table']} "
              f"over {role_gradable} gradable")
        if not args.no_inject:
            print("  materialized sentences written back into units/*.json for score.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
