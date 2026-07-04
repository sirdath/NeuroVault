#!/usr/bin/env python3
"""Aggregate a chunked --compare-ablate run into the full-set A/B.

Reads the per-chunk A/B blocks from a run log (each chunk prints
`running N (...)` then a `metric baseline treatment delta` table) and
prints the question-weighted overall baseline vs treatment for every
metric. Makes the full-470 headline reproducible from the committed log:

    python3 docs/benchmarks/merge_chunked_ab.py docs/benchmarks/rerank_ab/full470_matched_chunk_ab_chunks.log
"""
import re, sys

log = open(sys.argv[1] if len(sys.argv) > 1 else
           "docs/benchmarks/rerank_ab/full470_matched_chunk_ab_chunks.log").read()
ns = [int(n) for n in re.findall(r'running (\d+) \(\d+ answerable', log)]
blocks = re.split(r'A/B: ablate', log)[1:]
agg, total, done = {}, 0, 0
for i, b in enumerate(blocks):
    rows = re.findall(r'^(hit@\d+|recall@\d+|ndcg@\d+|precision@\d+|mrr)\s+([\d.]+)\s+([\d.]+)\s+[+\-][\d.]+', b, re.M)
    if not rows:
        continue
    n = ns[done] if done < len(ns) else 94
    done += 1; total += n
    for name, base, treat in rows:
        d = agg.setdefault(name, [0.0, 0.0])
        d[0] += float(base) * n; d[1] += float(treat) * n

order = ["hit@1","hit@5","hit@10","recall@5","recall@10","ndcg@5","mrr","precision@5"]
print(f"# Full-set A/B over {done} chunks = {total} questions\n")
print(f"{'metric':11s} {'baseline':>9s} {'+reranker':>10s} {'delta':>9s}")
for name in order:
    if name in agg:
        base, treat = agg[name][0]/total, agg[name][1]/total
        print(f"{name:11s} {base:9.4f} {treat:10.4f} {treat-base:+9.4f}")
