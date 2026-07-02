# LongMemEval miss forensics — 2026-07-02

Source run: `longmemeval-rerank-fusion-result.json` (384 answerable, rerank-fusion config).
Scorecard: hit@1 0.779 · hit@5 0.9375 · hit@10 0.966 · recall@5 0.902 · MRR 0.847.

## Where the losses are

hit@5 misses: 24. By type:

| type | miss@5 | of type | partial recall@5 | miss@1 |
|---|---|---|---|---|
| single-session-user | **13** | **20.3%** | 0 | **50.0%** |
| single-session-preference | 3 | 10.0% | 0 | 43.3% |
| knowledge-update | 3 | 4.2% | 14 | 11.1% |
| temporal-reasoning | 3 | 3.7% | 8 | 18.5% |
| single-session-assistant | 1 | 1.8% | 0 | 17.9% |
| multi-session | 1 | 1.2% | 9 | 8.6% |

More than half of all misses come from the supposedly easiest type.

## Root cause (verified by reading all 13 ssu misses against the dataset)

Every missed single-session-user question has the same shape: **the fact is a
buried aside** ("By the way, the bookshelf is from IKEA" dropped mid-chat about
room decluttering; a 10% discount aside inside a chat about promoting writing
services). Two mechanisms compound:

1. **Embedding dilution**: session engrams and even 3-sentence chunk windows
   are dominated by the surrounding topic; the aside's signal shrinks.
   LongMemEval haystacks deliberately contain distractor sessions that are
   *entirely about* the query topic, which outrank the aside on both KNN and
   BM25. (hit@10 0.966 vs hit@5 0.9375: gold usually sits at ranks 6-10,
   just under the distractors.)
2. **The reranker scores blind** (the smoking gun): `retriever.rs` built the
   cross-encoder doc as `title + first 400 chars of content`. Candidate
   content is head(1200) + the matched chunk appended at the END (a
   display-path fix), so `take(400)` = the session head. The one passage that
   actually matched, the aside, was never shown to the cross-encoder, while
   distractor sessions LEAD with the topic in their head. The CE cannot win
   with that input.

## Fix shipped (behind ablation for A/B)

`retriever.rs` rerank docs now feed `title + matched chunk (best_chunk_text,
clipped 400)`; falls back to the head when no chunk matched. Old behavior kept
behind the `rerank_matched_chunk` ablation flag.

`nv-bench` gained `--only <ids|@file>` for targeted re-runs.

## The A/B (run when CPU budget allows)

48 questions: 24 misses + 6 partial-recall probes + 18 stratified clean-hit
controls (regression canary), ids in `rerank_ab/miss5_targeted_ids.txt`:

```bash
cd src-tauri && taskpolicy -c utility caffeinate -is ./target/release/nv-bench longmemeval \
  --dataset /tmp/longmemeval/longmemeval_s_cleaned.json \
  --compare-ablate rerank_matched_chunk --no-abstention --rerank \
  --only @../docs/benchmarks/rerank_ab/miss5_targeted_ids.txt \
  --k 1,5,10 --out /tmp/rerank_matched_chunk_ab.json
```

Success = misses convert at hit@5 with controls flat. Expected: also a broad
hit@1 lift (85 misses at @1 today; the CE finally sees the evidence text).

## Next levers if this lands (in order)

1. **Level-4 single-sentence chunks** for multi-topic content: the 3-sentence
   window still carries 2 off-topic sentences around an aside. A pure-sentence
   vector level sharpens asides further (storage cost, bench-verify first).
2. **Partial-recall on knowledge-update/temporal (14+8 partials)**: needs gold
   *diversity* in top-5, not just presence: MMR/dedup tuning so multiple gold
   sessions surface, and update-chains rank both old + new states.
3. **hit@1 push**: after the CE sees matched chunks, re-tune
   RERANK_HYBRID_W/RERANK_CE_W fusion weights (the CE deserves more weight
   once its input isn't garbage).
