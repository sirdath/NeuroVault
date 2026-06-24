#!/usr/bin/env bash
# Drive the full rerank-FUSION LongMemEval run (470 answerable) to completion,
# one chunk at a time, in medium throttle. Each chunk advances
# ~/.neurovault/bench_progress_rerank.txt and writes
# chunks_rerank/chunk_<off>.json (+ a per-question .partial.jsonl checkpoint),
# so a crash/sleep loses at most the chunk in flight and a restart resumes
# from the last completed offset.
#
# Config = engine-only (recency + title boosts ablated) PLUS the rank-fused
# cross-encoder rerank. Compare the merged hit@5 against the published
# engine-only 0.938 to isolate fusion-rerank's effect at full scale.
#
# Run detached so it survives the terminal / agent session closing:
#   cd docs/benchmarks && nohup ./run_rerank_loop.sh > ~/.neurovault/rerank_run.log 2>&1 &
#
# Watch:   tail -f ~/.neurovault/rerank_run.log
# Progress: cat ~/.neurovault/bench_progress_rerank.txt   # next offset / 470
# Stop:    kill the loop's PID (resumable — just rerun to continue)
# Merge:   python3 merge_reports.py chunks_rerank/chunk_*.json -o longmemeval-rerank-470q.json
set -uo pipefail
cd "$(dirname "$0")"

HOURS="${1:-6}"            # nominal chunk size in hours
MODE="${2:-medium}"
PROGRESS="$HOME/.neurovault/bench_progress_rerank.txt"

while :; do
  before=$(cat "$PROGRESS" 2>/dev/null || echo 0)
  BENCH_RERANK=1 ./run_chunk.sh "$HOURS" "$MODE" || { echo "[loop] chunk exited non-zero — stopping"; exit 1; }
  after=$(cat "$PROGRESS" 2>/dev/null || echo 0)
  if [ "$after" = "$before" ]; then
    echo "[loop] no further progress — run complete (or nothing to do)."
    break
  fi
  echo "[loop] advanced $before → $after of 470; next chunk…"
done
