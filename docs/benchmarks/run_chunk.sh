#!/usr/bin/env bash
# Run the next chunk of the full LongMemEval benchmark — sized in HOURS.
#
#   ./run_chunk.sh 2        # run ~2 hours' worth of questions, then stop
#   ./run_chunk.sh 1.5      # ~90 minutes
#
# Progress lives in ~/.neurovault/bench_progress.txt (just the next offset).
# Each chunk writes docs/benchmarks/chunks/chunk_<offset>.json; when all 470
# are done, combine with:
#   python3 merge_reports.py chunks/chunk_*.json -o longmemeval-470q.json
set -euo pipefail

HOURS="${1:?usage: ./run_chunk.sh <hours> [chill]}"
MODE="${2:-}"
SECS_PER_Q=190                       # measured average (~3.2 min/question)
# chill mode: taskpolicy -b puts the run in the background QoS band — on
# Apple Silicon that means efficiency cores only. ~3x slower, but cool and
# quiet enough to run while you work (or overnight) with no thermal-emergency
# risk. Scores are identical — retrieval ranking is deterministic math; only
# wall time changes (don't quote latency stats from chill chunks).
THROTTLE=()
if [ "$MODE" = "chill" ]; then
  THROTTLE=(taskpolicy -b)
  SECS_PER_Q=570
fi
DATASET="${DATASET:-/tmp/longmemeval/longmemeval_s_cleaned.json}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="$REPO_ROOT/src-tauri/target/release/nv-bench"
PROGRESS="$HOME/.neurovault/bench_progress.txt"
CHUNKDIR="$(dirname "$0")/chunks"
TOTAL=470

mkdir -p "$CHUNKDIR"
[ -f "$DATASET" ] || { echo "dataset missing — downloading (~277 MB, one-time)…";
  mkdir -p "$(dirname "$DATASET")";
  curl -L -o "$DATASET" "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json"; }

OFFSET=$(cat "$PROGRESS" 2>/dev/null || echo 0)
if [ "$OFFSET" -ge "$TOTAL" ]; then
  echo "All $TOTAL questions already done 🎉  Merge with:"
  echo "  python3 $(dirname "$0")/merge_reports.py $CHUNKDIR/chunk_*.json -o longmemeval-470q.json"
  exit 0
fi

N=$(python3 -c "print(max(1, int($HOURS*3600/$SECS_PER_Q)))")
REMAIN=$((TOTAL - OFFSET))
[ "$N" -gt "$REMAIN" ] && N=$REMAIN
ETA_MIN=$((N * SECS_PER_Q / 60))

echo "chunk: questions $OFFSET..$((OFFSET+N-1)) of $TOTAL  (~${ETA_MIN} min${MODE:+, $MODE mode})"
"${THROTTLE[@]}" caffeinate -is "$BIN" longmemeval \
  --dataset "$DATASET" \
  --offset "$OFFSET" --limit "$N" \
  --out "$CHUNKDIR/chunk_${OFFSET}.json"

echo $((OFFSET + N)) > "$PROGRESS"
echo "✓ progress saved: $((OFFSET + N))/$TOTAL done ($(python3 -c "print(f'{100*($OFFSET+$N)/$TOTAL:.0f}')")%)"
