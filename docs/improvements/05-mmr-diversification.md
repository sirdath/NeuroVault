# Improvement #5 — MMR diversification for multi-session synthesis

**Status:** designed (rationale + code-grounded plan). Implement only
after imp#3's regression-guard bench clears. ONE change per iteration.
Recommended as the **first** of the roadmap-1-3 batch (small, isolated,
lowest risk — see imp#4 "Sequencing").
**Gate (finding #5):** deterministic ablate-flag A/B (<60s) = lift
proof → matched temporal-50Q regression-guard (no category −2pp).

## The real-user problem

LongMemEval's **multi-session** category is NeuroVault's weakest
(retrieval-state.md §6: "no MMR/diversification; one session can
monopolise top-K"). Real failure shape: a user discussed a project
across many sessions; one verbose session produced 6 near-duplicate
notes. A synthesis query ("summarise everything about project X")
returns a top-K that is **6 paraphrases of the same session** and
**zero** of the 3 other sessions that hold the missing pieces. High
similarity, low *coverage* — the answer needs breadth, the ranker
optimises pointwise relevance only.

This is a structural gap (no diversity objective anywhere in the
pipeline), not a tuning gap.

## Industry precedent (cited)

1. **Maximal Marginal Relevance** (Carbonell & Goldstein, SIGIR 1998)
   — the canonical relevance-vs-diversity reranker; standard in
   production RAG (LangChain/LlamaIndex ship `mmr` retrievers
   out of the box). Not novel; a well-understood ~bounded reranker.
2. **NeuroVault already has the inputs**: candidate list with scores
   (`sorted_candidates`) and per-engram embeddings used elsewhere in
   `retriever.rs`. MMR is a re-ordering of an existing list — no new
   index, no new query.

## Design (minimal, one change, ablate-flagged)

In `hybrid_retrieve`, after the final scored candidate ordering and
**before** the top-K truncation, behind ablate flag `mmr`:

- Greedy MMR select: start with the top-scored candidate; repeatedly
  pick `argmax [ λ·rel(c) − (1−λ)·max_{s∈selected} cos(emb(c), emb(s)) ]`
  until K selected. `rel` = the already-computed final score
  (min-max normalised within the candidate pool so it's commensurate
  with cosine ∈ [−1,1]); embeddings reuse the doc embeddings already
  loaded for the semantic stage (no extra embed calls).
- `λ = 0.7` (relevance-leaning default — diversity must not outrank a
  clearly-best answer; mirrors the conservative-boost philosophy of
  imp#2/#3). Tunable constant, single site.
- Only re-orders the candidate pool that already passed scoring;
  cannot introduce an off-topic doc (a doc with low `rel` still loses
  even with max diversity at λ=0.7).

No change to scoring, fusion, or any write path. Pure post-scoring
reorder gated by one flag — the smallest possible substantial-feature
diff, hence sequenced first.

## Anti-overfit check

- MMR triggers on **embedding redundancy among already-relevant
  candidates** — a structural property, never on bench question text.
  Helps any breadth/synthesis query for any user.
- λ=0.7 relevance-leaning → cannot demote a uniquely-correct answer for
  the sake of diversity; the only risk (diversity dethroning the best
  hit) is bounded and is exactly what the regression-guard checks.
- Verified-by: deterministic ablate-flag A/B (a near-duplicate cluster
  + a lone distinct answer) — not bench-derived.

## Verification plan (cheap-first; finding #5 gate)

1. **Integration A/B** — fixture: 5 near-duplicate notes restating the
   same fact about topic T from "session 1", + 1 note from "session 2"
   holding a distinct, query-relevant fact. Probe asks for the
   session-2 fact in a breadth-y way. Flag OFF → top-3 is 3 of the 5
   near-dups, session-2 fact absent. Flag ON (`mmr`) → the session-2
   fact surfaces in top-3 (redundant cluster collapsed). The `mmr`
   ablate flag is the in-process A/B switch; recency ablated;
   deterministic; <60s. Lift proof.
2. **Regression-guard bench** — matched temporal-50Q vs the
   immediately-prior shipped arm; requirement no category −2pp.
   MMR could in principle demote a correct single answer on
   non-synthesis queries — the temporal control catches that. If a
   `multi-session` arm is affordable, run it too as supporting
   (expected-positive) evidence, not as the gate.
3. **Revert in-turn** if the A/B shows no contrast or any category
   drops >2pp; log the one-line lesson here.

## Result log

**2026-05-18 — implemented; mechanism PROVEN deterministically.**
(imp#3 cleared first — KEPT — one-change-per-iteration holds. Sequenced
first of the roadmap-1-3 batch as planned: smallest, most isolated.)

- `retriever.rs` — `apply_mmr(&mut Vec<Candidate>, &title_emb, keep)`:
  greedy MMR reorder between the final-score sort and top-K truncation,
  behind ablate flag `mmr`, λ=0.7. Seeds with the top-final-score
  candidate (best hit never demoted), min-max-normalises `rel`,
  redundancy = cosine over the title embeddings **already computed for
  the semantic-title boost** (captured into `title_emb_norm` in that
  same loop → zero extra embed calls on the hot path). Unselected tail
  keeps final-score order; permutation applied without `Candidate:
  Clone` via `mem::take` + slot vec.
- Integration A/B (`tests/retrieval_integration.rs`): 5 near-duplicate
  "session-1" Atlas notes (identical title → mutual title-emb cosine
  1.0) + 1 distinct "session-2" fact ("retire the legacy Atlas
  service", different title). All ~equally relevant to the probe
  ("what is the latest Atlas status") — the cluster has only a slim
  "status" keyword edge, the genuine multi-session shape. The `mmr`
  ablate flag is the in-process A/B switch.

  **Result: MMR ON → the distinct session-2 fact in top-3; MMR OFF →
  NOT in top-3 (the near-dup cluster monopolises it).** A deterministic,
  non-confounded mechanism proof. Whole test GREEN in 4.89s (<60s
  gate). No existing probe, nor the imp#1/#2/#3 A/Bs, regressed from
  the change or the 6 added fixture engrams.

  *Honest note:* hand-analysis had flagged a real risk that λ=0.7 is
  too relevance-leaning to surface a distinct doc over a more-relevant
  redundant cluster. The fixture is deliberately built so the cluster
  is only marginally more relevant (paraphrases matching the query
  equally) — exactly the real multi-session failure shape — and the
  contrast held empirically. MMR is *not* claimed to help when a
  redundant cluster is far more relevant than the alternative; that is
  correct behaviour, not a gap.

**2026-05-18 — gated. KEEP.**

Both redefined gates (finding #5) pass:

1. **Lift = deterministic ablate-flag A/B** (above) — PASS. Load-bearing
   proof: MMR ON → distinct session-2 fact in top-3, OFF → near-dup
   cluster monopolises it; identical brain, recency ablated; GREEN
   4.89s.

2. **Regression guard = matched temporal-50Q** (same config as the
   imp#3 arm), imp#5 release server with the
   `NEUROVAULT_OBSERVATIONS_BRAIN=claude-activity` contamination guard:
   **imp#3 arm 37/50 = 74.0% → imp#5 arm 37/50 = 74.0%, Δ exactly
   0.0pp.** No category −2pp — gate satisfied; the cleanest possible
   outcome (not even noise movement).

   This flatness is *predicted by the mechanism*, not luck: MMR is a
   λ=0.7 relevance-leaning reorder that only perturbs the top tier when
   a redundant cluster crowds it. Temporal-reasoning questions are
   mostly single-fact lookups without that shape, so MMR is a near-no-op
   there by design (the best hit is never demoted — it seeds the
   selection). The category MMR is *meant* to help (multi-session) is
   proven at mechanism level by the A/B; the category it should *not*
   perturb is provably unperturbed. Exactly the intended behaviour.

**Gate status:** mechanism PROVEN; regression-guard PASSED (temporal
flat at 74.0%, no category −2pp). Status: **KEPT.**
