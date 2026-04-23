# NeuroVault retrieval eval

Controlled benchmark for the hybrid-retrieval pipeline. Lets us make
scoring changes with *evidence* instead of intuition.

## Files

- `testset.jsonl` — hand-curated queries + expected title matches
- `run_eval.py` — runs the set, prints hit@k + MRR + latency
- `baselines/` — saved JSON snapshots for before/after diffs
- `README.md` — this file

## Running

NeuroVault desktop app must be open so the HTTP server on `127.0.0.1:8765` is responding.

```bash
# Run + print report
python eval/run_eval.py

# Run + save as a named baseline
python eval/run_eval.py --save 2026-04-23-tier1

# Run + diff against a saved baseline
python eval/run_eval.py --compare 2026-04-23-tier1
```

## What the metrics mean

- **hit@k** — fraction of queries where *any* expected title appears in the top-k hits. hit@1 = top result was right. hit@5 = right answer in top 5.
- **MRR** (Mean Reciprocal Rank) — mean of 1/rank across the set, missing answers contribute 0. A single-number scorecard; higher is better, 1.0 is perfect.
- **median_ms / p95_ms** — per-query latency. Useful to catch "fix helped quality, broke speed" regressions.

## Interpreting results

- hit@1 = 0.60 means 60% of queries returned the right note as the *top* result.
- hit@5 = 0.90 means 90% of queries had the right note somewhere in the top 5.
- MRR = 0.75 means on average the right answer is at rank ~1.33.

**hit@1 matters for Claude Code** because it typically picks the top hit. hit@5 matters for exploratory queries where the user browses.

## Iterating

1. Save a baseline *before* any scoring change: `python eval/run_eval.py --save before-foo`
2. Make the change, rebuild, reinstall.
3. Run `python eval/run_eval.py --compare before-foo`.
4. If MRR or hit@1 drops by >2%, revert. If it improves, keep.

## Growing the testset

Add JSON lines to `testset.jsonl`. Each one:

```jsonl
{"id": "slug", "query": "what you'd actually type", "expect": ["Expected Title 1", "Also Acceptable 2"], "notes": "why this case exists"}
```

Title matching is **case-insensitive + exact**. If a title changes, the test needs updating — that's a feature, not a bug (catches accidental title drift).

30-50 cases gives reliable numbers. More than ~100 hits diminishing returns.

## Ablating scoring features

Today the retriever is monolithic — you can't disable features at query time. If ablation becomes important, the clean approach is adding a `?disable_features=decision_bonus,entity_edges` query param to `/api/recall` that the Rust retriever respects, then running the eval with different combinations.

Small ~30-line change in `retriever.rs` + `http_server.rs`. Do this if the baseline shows features that don't pull their weight.
