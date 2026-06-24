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

HOURS="${1:?usage: ./run_chunk.sh <hours> [chill|medium]}"
MODE="${2:-}"
SECS_PER_Q=190                       # measured average (~3.2 min/question)
# Throttle modes (Apple Silicon QoS bands via taskpolicy). Scores are
# IDENTICAL across modes — retrieval ranking is deterministic math; only
# wall time + heat change (don't quote latency stats from throttled chunks):
#   chill  = -b (background QoS) → efficiency cores only. Coolest/quietest,
#            ~5x slower than full. Safe to run while you work or overnight.
#   medium = -c utility (utility QoS) → performance cores ALLOWED but at
#            reduced frequency and yielding to your foreground work. Roughly
#            2x faster than chill, noticeably cooler than full-speed.
#   (none) = full speed, performance cores unthrottled — fastest, hottest.
THROTTLE=()
if [ "$MODE" = "chill" ]; then
  THROTTLE=(taskpolicy -b)
  SECS_PER_Q=960
elif [ "$MODE" = "medium" ]; then
  THROTTLE=(taskpolicy -c utility)
  SECS_PER_Q=420
fi
DATASET="${DATASET:-/tmp/longmemeval/longmemeval_s_cleaned.json}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="$REPO_ROOT/src-tauri/target/release/nv-bench"

# Production mode (BENCH_PROD=1): run the REAL recall() path — cross-encoder
# rerank ON + production recency — and KEEP the abstention (_abs) questions so
# one run yields the production hit@k AND the Abstention@k dimension. Uses a
# SEPARATE progress file + chunk dir so it never mixes with the published
# engine-only (reproducible) run.  Usage: BENCH_PROD=1 ./run_chunk.sh 2 chill
# Rerank-fusion mode (BENCH_RERANK=1): the published engine-only config
# (recency + title boosts ablated, 470 answerable) PLUS the cross-encoder
# rerank — now rank-fused (fuse_cross_encoder), not the old magnitude blend.
# Isolates fusion-rerank's effect at full scale vs the engine-only 0.938
# baseline. SEPARATE progress + chunk dir so it never mixes with the
# engine-only / prod runs.  Usage: BENCH_RERANK=1 ./run_chunk.sh 6 medium
PROD="${BENCH_PROD:-}"
RERANK="${BENCH_RERANK:-}"
if [ -n "$RERANK" ]; then
  PROGRESS="$HOME/.neurovault/bench_progress_rerank.txt"
  CHUNKDIR="$(dirname "$0")/chunks_rerank"
  EXTRA_FLAGS=(--rerank --no-abstention --k 1,5,10)
elif [ -n "$PROD" ]; then
  PROGRESS="$HOME/.neurovault/bench_progress_prod.txt"
  CHUNKDIR="$(dirname "$0")/chunks_prod"
  EXTRA_FLAGS=(--rerank --keep-recency)
else
  PROGRESS="$HOME/.neurovault/bench_progress.txt"
  CHUNKDIR="$(dirname "$0")/chunks"
  EXTRA_FLAGS=()
fi
TOTAL=470

mkdir -p "$CHUNKDIR"
[ -f "$DATASET" ] || { echo "dataset missing — downloading (~277 MB, one-time)…";
  mkdir -p "$(dirname "$DATASET")";
  curl -L -o "$DATASET" "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json"; }

# Production mode keeps the _abs questions, so the iterate count is the full
# retained set (~500), not 470. Compute it from the dataset so chunk sizing +
# completion detection are correct.
if [ -n "$PROD" ]; then
  TOTAL=$(python3 -c "import json;d=json.load(open('$DATASET'));print(sum(1 for q in d if q['question_id'].endswith('_abs') or q.get('answer_session_ids')))")
fi

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
# `${THROTTLE[@]+...}` guard: on macOS bash 3.2, expanding an empty array
# under `set -u` is treated as unbound. Full-speed mode leaves THROTTLE
# empty, so guard it — expands to nothing when unset, to the elements when set.
"${THROTTLE[@]+"${THROTTLE[@]}"}" caffeinate -is "$BIN" longmemeval \
  --dataset "$DATASET" \
  --offset "$OFFSET" --limit "$N" \
  ${EXTRA_FLAGS[@]+"${EXTRA_FLAGS[@]}"} \
  --out "$CHUNKDIR/chunk_${OFFSET}.json"

echo $((OFFSET + N)) > "$PROGRESS"
echo "✓ progress saved: $((OFFSET + N))/$TOTAL done ($(python3 -c "print(f'{100*($OFFSET+$N)/$TOTAL:.0f}')")%)"
