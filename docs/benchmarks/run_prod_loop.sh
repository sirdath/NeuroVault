#!/usr/bin/env bash
# Drive the full production-config LongMemEval run to completion, one chunk at
# a time, in medium throttle mode. Each chunk advances
# ~/.neurovault/bench_progress_prod.txt and writes chunks_prod/chunk_<off>.json
# (plus a per-question .partial.jsonl checkpoint), so a crash loses at most the
# chunk in flight and a restart resumes from the last completed offset.
#
# Run detached so it survives the terminal / agent session closing:
#   cd docs/benchmarks && nohup ./run_prod_loop.sh > ~/.neurovault/prod_run.log 2>&1 &
#
# Watch:   tail -f ~/.neurovault/prod_run.log
# Resume:  just run this again — it picks up from the saved offset.
# Merge:   python3 merge_reports.py chunks_prod/chunk_*.json -o longmemeval-prod.json
set -uo pipefail
cd "$(dirname "$0")"

HOURS="${1:-6}"            # nominal chunk size; actual is longer with rerank
MODE="${2:-medium}"
PROGRESS="$HOME/.neurovault/bench_progress_prod.txt"

while :; do
  before=$(cat "$PROGRESS" 2>/dev/null || echo 0)
  BENCH_PROD=1 ./run_chunk.sh "$HOURS" "$MODE" || { echo "[loop] chunk exited non-zero — stopping"; exit 1; }
  after=$(cat "$PROGRESS" 2>/dev/null || echo 0)
  if [ "$after" = "$before" ]; then
    echo "[loop] no further progress — run complete (or nothing to do)."
    break
  fi
  echo "[loop] advanced $before → $after; next chunk…"
done
