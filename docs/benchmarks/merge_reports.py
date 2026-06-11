#!/usr/bin/env python3
"""Merge chunked nv-bench longmemeval reports into one combined scorecard.

Chunked runs (nv-bench longmemeval --offset N --limit M) each write their own
JSON report. Every report carries per-question receipts (gold ids + the ranked
top-10), so all metrics are recomputed here from the receipts — no averaging
of averages, and duplicate question_ids (re-run chunks) are deduped keeping
the latest occurrence.

Usage:
    python3 merge_reports.py chunk1.json chunk2.json ... [-o combined.json]
"""
import json
import math
import sys


def recall_at_k(ranked, gold, k):
    if not gold:
        return 0.0
    top = ranked[:k]
    return sum(1 for g in gold if g in top) / len(gold)


def hit_at_k(ranked, gold, k):
    top = ranked[:k]
    return 1.0 if any(g in top for g in gold) else 0.0


def mrr(ranked, gold):
    for i, r in enumerate(ranked):
        if r in gold:
            return 1.0 / (i + 1)
    return 0.0


def ndcg_at_k(ranked, gold, k):
    if not gold:
        return 0.0
    dcg = sum(1.0 / math.log2(i + 2) for i, r in enumerate(ranked[:k]) if r in gold)
    idcg = sum(1.0 / math.log2(i + 2) for i in range(min(len(gold), k)))
    return dcg / idcg if idcg else 0.0


def main():
    args = [a for a in sys.argv[1:] if a != "-o"]
    out = None
    if "-o" in sys.argv:
        out = sys.argv[sys.argv.index("-o") + 1]
        args.remove(out)
    if not args:
        sys.exit(__doc__)

    by_id = {}
    for path in args:
        with open(path) as f:
            report = json.load(f)
        for q in report["per_question"]:
            by_id[q["question_id"]] = q  # later files win on duplicates

    qs = list(by_id.values())
    n = len(qs)
    ks = (1, 3, 5, 10)
    means = {}
    for k in ks:
        means[f"hit@{k}"] = sum(hit_at_k(q["ranked_top"], q["gold"], k) for q in qs) / n
        means[f"recall@{k}"] = sum(recall_at_k(q["ranked_top"], q["gold"], k) for q in qs) / n
        means[f"ndcg@{k}"] = sum(ndcg_at_k(q["ranked_top"], q["gold"], k) for q in qs) / n
    means["mrr"] = sum(mrr(q["ranked_top"], q["gold"]) for q in qs) / n

    by_type = {}
    for q in qs:
        by_type.setdefault(q["type"], []).append(q)

    print(f"━━ combined scorecard — {n} unique questions from {len(args)} report(s) ━━")
    for key in sorted(means):
        print(f"{key:<12} {means[key]:.4f}")
    print("\nper question type (recall@5):")
    for t in sorted(by_type):
        tq = by_type[t]
        r5 = sum(recall_at_k(q["ranked_top"], q["gold"], 5) for q in tq) / len(tq)
        print(f"  {t:<28} {r5:.4f}  (n={len(tq)})")

    if out:
        with open(out, "w") as f:
            json.dump({"questions": n, "means": means, "per_question": qs}, f, indent=2)
        print(f"\ncombined report written: {out}")


if __name__ == "__main__":
    main()
