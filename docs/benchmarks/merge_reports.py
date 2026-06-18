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


def abstention_curve(samples):
    """Recompute the retrieval-confidence abstention metric from merged
    receipts. `samples` is a list of (top_score, is_abs). Mirrors the Rust
    `abstention_curve` in nv-bench.rs exactly: sweep tau over midpoints of the
    observed score distribution, pick tau* = argmax balanced accuracy (ties →
    larger tau). Returns None when either class is absent (gate undefined).

    Calibrating tau over the FULL merged distribution is why this must run at
    merge time, not per-chunk — a per-chunk tau would be meaningless.
    """
    n_abs = sum(1 for _, a in samples if a)
    n_ans = len(samples) - n_abs
    if n_abs == 0 or n_ans == 0:
        return None
    scores = sorted(s for s, _ in samples)
    taus = [scores[0] - 1e-6]
    for i in range(len(scores) - 1):
        taus.append((scores[i] + scores[i + 1]) / 2.0)
    taus.append(scores[-1] + 1e-6)
    uniq = []
    for t in taus:
        if not uniq or abs(t - uniq[-1]) > 1e-12:
            uniq.append(t)
    best = None
    for tau in uniq:
        tp = fp = fn = tn = 0
        for s, is_abs in samples:
            ab = s < tau  # abstain = top score below threshold
            if is_abs and ab:
                tp += 1
            elif is_abs and not ab:
                fn += 1
            elif not is_abs and ab:
                fp += 1
            else:
                tn += 1
        sens = tp / max(1, tp + fn)
        spec = tn / max(1, tn + fp)
        bal = 0.5 * (sens + spec)
        prec = tp / (tp + fp) if (tp + fp) else 0.0
        f1 = 2 * prec * sens / (prec + sens) if (prec + sens) else 0.0
        acc = (tp + tn) / len(samples)
        if best is None or bal > best["balanced_accuracy"] or (
            bal == best["balanced_accuracy"] and tau > best["tau_star"]
        ):
            ans_mean = sum(s for s, a in samples if not a) / n_ans
            abs_mean = sum(s for s, a in samples if a) / n_abs
            best = dict(
                tau_star=tau, accuracy=acc, balanced_accuracy=bal,
                precision=prec, recall=sens, specificity=spec, f1=f1,
                n_abs=n_abs, n_ans=n_ans,
                answerable_mean_top_score=ans_mean, abs_mean_top_score=abs_mean,
            )
    return best


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
            if path.endswith(".jsonl"):
                # Incremental checkpoint files: one per-question record per
                # line, written as each question completes. An interrupted
                # chunk's partial work merges like any finished report.
                questions = [json.loads(line) for line in f if line.strip()]
            else:
                questions = json.load(f)["per_question"]
        for q in questions:
            by_id[q["question_id"]] = q  # later files win on duplicates

    qs = list(by_id.values())
    n = len(qs)
    # Gold-retrieval metrics apply ONLY to answerable questions; `_abs`
    # questions carry a decoy gold and are judged solely by the abstention
    # gate, so counting them here would dilute hit@k. Old engine-only chunks
    # predate the is_abs field → default False (all answerable).
    answerable = [q for q in qs if not q.get("is_abs", False)]
    na = len(answerable) or 1
    ks = (1, 3, 5, 10)
    means = {}
    for k in ks:
        means[f"hit@{k}"] = sum(hit_at_k(q["ranked_top"], q["gold"], k) for q in answerable) / na
        means[f"recall@{k}"] = sum(recall_at_k(q["ranked_top"], q["gold"], k) for q in answerable) / na
        means[f"ndcg@{k}"] = sum(ndcg_at_k(q["ranked_top"], q["gold"], k) for q in answerable) / na
    means["mrr"] = sum(mrr(q["ranked_top"], q["gold"]) for q in answerable) / na

    # Abstention: recompute the retrieval-confidence gate over EVERY receipt
    # that carries a top score (answerable + _abs together — the curve needs
    # both classes). Absent on legacy engine-only chunks → skipped.
    samples = [
        (q["abstain_top_score"], bool(q.get("is_abs", False)))
        for q in qs
        if "abstain_top_score" in q
    ]
    abstention = abstention_curve(samples) if samples else None

    by_type = {}
    for q in answerable:
        by_type.setdefault(q["type"], []).append(q)

    n_abs = len(qs) - len(answerable)
    print(
        f"━━ combined scorecard — {n} unique questions "
        f"({len(answerable)} answerable + {n_abs} abstention) from {len(args)} report(s) ━━"
    )
    for key in sorted(means):
        print(f"{key:<12} {means[key]:.4f}")
    print("\nper question type (recall@5):")
    for t in sorted(by_type):
        tq = by_type[t]
        r5 = sum(recall_at_k(q["ranked_top"], q["gold"], 5) for q in tq) / len(tq)
        print(f"  {t:<28} {r5:.4f}  (n={len(tq)})")

    if abstention:
        print("\n━━ abstention (retrieval-confidence gate) ━━")
        print(f"  tau*                     {abstention['tau_star']:.4f}")
        print(f"  Abstention@tau*          {abstention['accuracy']:.4f}")
        print(f"  balanced accuracy        {abstention['balanced_accuracy']:.4f}")
        print(f"  precision / recall / F1  {abstention['precision']:.4f} / {abstention['recall']:.4f} / {abstention['f1']:.4f}")
        print(
            f"  top-score separation     answerable μ={abstention['answerable_mean_top_score']:.4f}"
            f"  vs  _abs μ={abstention['abs_mean_top_score']:.4f}"
        )
        print(f"  (n: {abstention['n_ans']} answerable, {abstention['n_abs']} abstention)")

    if out:
        with open(out, "w") as f:
            json.dump(
                {
                    "questions": n,
                    "answerable": len(answerable),
                    "abstention_questions": n_abs,
                    "means": means,
                    "abstention": abstention,
                    "per_question": qs,
                },
                f,
                indent=2,
            )
        print(f"\ncombined report written: {out}")


if __name__ == "__main__":
    main()
