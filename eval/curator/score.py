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
  post_gate_precision      of the proposals that SURVIVE the gauntlet on
                           gold-positive units, the fraction matching gold.
  post_gate_recall         of all gold items, the fraction matched by a
                           surviving proposal.
  over_extraction_rate     gold-negative units with >=1 surviving proposal.
                           Noise injected into a clean brain.
  verifier_false_reject    rejected proposals whose statement DID match gold
                           -- i.e. the gauntlet's own error rate. Keeps the
                           verifier honest; a high value means the gates are
                           too tight, not that the model is bad.
  latency p50/p95          warm per-unit wall time.
  json_parse_failure_rate  content that was not JSON at all.

Usage:
    python eval/curator/score.py --results-dir eval/curator/results/qwen3-1.7b \
        --gold-dir eval/curator/gold --units-dir eval/curator/units

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
from run_bench import load_units  # noqa: E402
from verify import verify_unit  # noqa: E402


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


# --------------------------------------------------------------------------
# scoring
# --------------------------------------------------------------------------

def score(
    results_dir: Path, gold: dict[str, dict[str, Any]], units: dict[str, str]
) -> dict[str, Any]:
    units_out = results_dir / "units"
    rows: list[dict[str, Any]] = []
    for path in sorted(units_out.glob("unit_*.json")):
        try:
            rows.append(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            continue

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

            matched_gold_idx: set[int] = set()
            for p in surviving:
                hit = next(
                    (i for i, gi in enumerate(gold_items)
                     if statement_matches(p.get("statement"), gi)),
                    None,
                )
                if hit is not None:
                    postgate_matched += 1
                    matched_gold_idx.add(hit)
            gold_items_matched += len(matched_gold_idx)
            unit_rec["gold_matched"] = len(matched_gold_idx)
            unit_rec["gold_total"] = len(gold_items)

            # Verifier self-check: did we reject something that was right?
            for p in rejected:
                rejected_total += 1
                if any(statement_matches(p.get("statement"), gi) for gi in gold_items):
                    rejected_but_gold += 1
                    unit_rec.setdefault("false_rejects", []).append(p.get("statement"))
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

    metrics = {
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
        "verifier_false_reject_rate": pct(rejected_but_gold, rejected_total),
        "verifier_false_reject_count": rejected_but_gold,

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

ROWS = [
    ("Degenerate rate (gold+, empty out)", "degenerate_rate", "lower"),
    ("Abstention correctness (gold-)", "abstention_correctness", "higher"),
    ("Pre-gate unsupported (G1/props)", "pre_gate_unsupported_rate", "lower"),
    ("Post-gate precision", "post_gate_precision", "higher"),
    ("Post-gate recall", "post_gate_recall", "higher"),
    ("Over-extraction rate (gold-)", "over_extraction_rate", "lower"),
    ("Verifier false-reject est.", "verifier_false_reject_rate", "lower"),
    ("Incoherent abstention rate", "incoherent_abstention_rate", "lower"),
    ("JSON parse failure rate", "json_parse_failure_rate", "lower"),
    ("Latency p50 (s)", "latency_p50_s", "lower"),
    ("Latency p95 (s)", "latency_p95_s", "lower"),
    ("Cold load (s)", "cold_load_s", "lower"),
]


def markdown_table(all_metrics: list[dict[str, Any]]) -> str:
    models = [m["model"] for m in all_metrics]
    lines = [
        "| Metric | Want | " + " | ".join(models) + " |",
        "|---|---|" + "---|" * len(models),
    ]
    for label, key, want in ROWS:
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
        ("timeouts", "timeout_count"),
    ]:
        vals = []
        for m in all_metrics:
            v = m[path[0]].get(path[1]) if isinstance(path, tuple) else m.get(path)
            vals.append(fmt(v))
        lines.append(f"| {label} | " + " | ".join(vals) + " |")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Score curator runs against gold.")
    ap.add_argument("--results-dir", required=True, type=Path, nargs="+",
                    help="one or more results/<model>/ dirs (multiple => comparison table)")
    ap.add_argument("--gold-dir", required=True, type=Path)
    ap.add_argument("--units-dir", required=True, type=Path)
    ap.add_argument("--out-md", type=Path, default=None,
                    help="markdown summary path (default: alongside the first results dir)")
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
        m = score(rd, gold, units)
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
