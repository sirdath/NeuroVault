# Improvement #3 — Numeric & quantity exact-match precision boost

**Status:** designed (rationale + code-grounded plan). Implement only
after imp#2's regression-guard bench clears (ONE change per iteration).
**Gate (per retrieval-state.md finding #5):** deterministic ablate-flag
A/B in `tests/retrieval_integration.rs` (<60s) = the lift proof →
matched regression-guard bench (no category −2pp) = the regression
guard. A noisy +pp bench delta is NOT the gate.

## The real-user problem

A huge fraction of recall is *quantitative*: "how many H&M tops do I
own **now**?", "what **year** did construction start?", "the **440**-page
book", "we set the drift window to **90 seconds**", "budget is **£400**".
The number IS the answer (or the disambiguator between near-identical
notes that differ only in a quantity — the classic
knowledge-update/temporal shape: "earlier I had three … now I own
five").

**Current behaviour (verified in code):** `bm25_tokenize`
(`retriever.rs:443`) emits `[a-z0-9]+` tokens, so a digit string *is*
indexed and *can* match — but it is weighted exactly like any other
BM25 term and competes on equal footing with generic prose. There is
**no precision prior for numeric tokens**, and the title/keyword boost
(`retriever.rs:~860`) is built from the same flat token set. imp#2 added
a precision prior for proper nouns and quoted phrases; numerics — the
*other* high-precision, embedder-weak token class — were left on the
flat path. The integration fixture already exhibits the failure: the
H&M-tops probe ("how many H&M tops do I own now") sits **0.0008** behind
a distractor with recency ablated — a numeric-aware boost is exactly the
signal that breaks that tie correctly.

## Why this is high-leverage here specifically

1. **Finding #3** (retrieval-state.md): the title/keyword/lexical
   precision path carries ranking; RRF-weight tuning does not. Numeric
   exact-match is the *same load-bearing path* as imp#2, one more
   precision class on it — not a new low-leverage knob.
2. **Documented embedder weakness.** BGE-small-en-v1.5 (like all
   small dense encoders) represents numerals very poorly: "3", "5",
   "440", "90 seconds" collapse into near-identical low-information
   vectors — dense similarity cannot tell "three" from "five". This is
   the *same* class of structural weakness imp#2 compensates for proper
   nouns; the lexical exact-match correction is model-aware, not a
   bench hack. (Well-known: dense retrievers' number-blindness is a
   standard motivation for hybrid lexical search.)
3. **Coherent trilogy.** imp#1 (preference assertions), imp#2 (proper
   nouns / quoted phrases), imp#3 (numerics) are the three
   high-precision, low-dense-quality token classes. Together they make
   the lexical-precision path embedder-weakness-aware without touching
   the fusion weights the findings proved inert.

## Industry precedent (cited)

1. **Hybrid search canon:** exact numeric/keyword matching layered on
   dense similarity is standard precisely because dense encoders are
   number-blind (Lucene point/numeric fields + BM25; the entire
   motivation for BM25-in-hybrid is rare/exact tokens dense misses).
2. **MemPalace** uses entity/phrase distance reduction
   (`longmemeval_bench.py:1434/1521`); numeric answers fall in the same
   "exact token the embedder loses" bucket the design there targets.
3. **NeuroVault already tokenises digits** (`[a-z0-9]+`): this adds a
   precision *weight* to a signal already in the index — minimal,
   consistent with the existing model, not a new subsystem.

## Design (minimal, one change, code-grounded)

Extend the existing salient-term path, not a new one. In
`extract_salient` (added by imp#2, `retriever.rs`), additionally return
**numeric tokens**: regex `\b\d{1,4}(?:[.,]\d{1,3})?\b` over the raw
query → the digit string, normalised (strip thousands separators).
Conservative: 1–4 digit runs only (years, counts, small quantities),
skip if the token is part of a longer alphanumeric id.

Then, in the same `proper_noun_boost` candidate loop (so it is **one
change**, gated by the **same** ablate flag — no new flag, no second
iteration):

- If a candidate engram's title or content contains a query numeric
  token as a **whole token** (reuse the `words` set already built there)
  → add a moderate boost scaled by coverage:
  `+0.15 * (matched_numerics / total_query_numerics)`, mirroring the
  proper-noun term so magnitudes stay calibrated and never dominate the
  `k*0.30` keyword-title term.
- Numeric and proper-noun coverage are summed (a "how many H&M tops"
  query has both "h&m"→proper-ish and the answer note has the count);
  the combined add stays bounded because each sub-term is ≤0.15 and
  matches are rare.

Why fold into imp#2's flag/loop rather than a new flag: it is literally
the same mechanism (exact high-precision token the embedder underweights
→ moderate lexical boost over RRF candidates), the loop and `words` set
already exist, and it keeps the one-change-per-iteration discipline
honest — imp#3 is "extend the precision-token set with numerics," a
single reviewable diff with a single ablate switch.

## Anti-overfit check

- Triggers on **linguistic structure** (digit runs), never on
  LongMemEval question text. Fires on the most common quantitative real
  query shape ("how many / what year / how long / how much").
- Conservative (1–4 digit runs, whole-token match, skip embedded ids)
  keeps false boosts low; false boosts are the only risk and are
  bounded by the same ≤0.15 calibration as imp#2.
- Compensates a *documented, structural* weakness of the chosen
  embedder → helps any quantitative user query, not just the bench.
- Verified-by: deterministic ablate-flag A/B (the H&M-tops fixture
  already in the integration test — a numeric query whose right answer
  differs from a distractor only by the count) — not bench-derived.

## Verification plan (cheap-first; finding #5 gate)

1. **Integration A/B** — strengthen the existing H&M fixture: add a
   near-twin distractor identical except the quantity, query "how many
   H&M tops do I own now". With `proper_noun_boost` ablated the right
   count may lose the 0.0008 tie; with it ON the correct-count engram is
   top-3. Deterministic, recency-ablated, <60s. This is the lift proof.
2. **Regression-guard bench** — one matched arm (temporal-reasoning 50Q,
   same config as `graded_pre_imp1`) on the imp#3 server; requirement:
   no category −2pp. Numeric boost touches a proper-noun-sparse control,
   so a regression there would expose false numeric boosts. Any positive
   delta is supporting, not sole, evidence (sub-noise effect size).
3. **Revert in-turn** if the A/B shows no contrast (boost not
   load-bearing) or any bench category drops >2pp; log the one-line
   lesson here.

## Result log

**2026-05-17 — implemented; mechanism PROVEN deterministically.**
(imp#2 cleared first — KEPT — so one-change-per-iteration holds.)

- `retriever.rs` — `extract_salient` now returns a 3-tuple, adding
  `numerics`: `\b\d{1,4}\b` over the raw query (word boundaries already
  exclude digits embedded in ids like `iso9001`/`v8`; 1-4 digit runs
  cover years and realistic counts; matches the `[a-z0-9]+` content
  tokenisation so a query `2023` aligns with a content `2023`).
- Boost folded into imp#2's existing `proper_noun_boost` block and
  candidate loop — **one diff, one ablate switch**. The `words` set is
  hoisted so proper-noun and numeric matching share it. Numeric
  coverage adds `+0.15 * (matched/total)`, the same calibration as the
  proper-noun term (each sub-term ≤0.15, never dominates `k*0.30`).
- Integration A/B (`tests/retrieval_integration.rs`): added a numeric
  near-twin fixture pair — `mileage-2023.md` / `mileage-2024.md`,
  topic-identical, differing only by the year (the BGE-blind
  discriminator); the `-2024` twin is deliberately denser in the
  query's generic tokens. Neutral "cycling log" theme chosen so no
  token collides with any existing probe/title (verified — otherwise it
  would pollute the "engineering sync" probe). Probe: *"how many loops
  did I ride in 2023"*. The shared `proper_noun_boost` ablate flag is
  the in-process A/B switch (identical brain, recency ablated).

  **Result: boost ON → `mileage-2023` ranked ABOVE `mileage-2024`;
  boost OFF → `mileage-2024` (distractor) ranked above `mileage-2023`.**
  The numeric exact-match signal is demonstrably load-bearing — a
  deterministic, non-confounded mechanism proof. Whole test GREEN in
  4.77s (<60s gate). No existing probe, nor the imp#1/imp#2 A/Bs,
  regressed from the change or the two added fixture engrams.

**2026-05-18 — gated. KEEP.**

Both redefined gates (finding #5) pass:

1. **Lift = deterministic ablate-flag A/B** (above) — PASS. Load-bearing
   proof: boost ON → correct-year note ranked above its near-twin,
   boost OFF → distractor wins; identical brain, recency ablated;
   GREEN 4.77s.

2. **Regression guard = matched temporal-50Q** (same config as the
   imp#2 arm and `graded_pre_imp1`), imp#3 release server with the
   `NEUROVAULT_OBSERVATIONS_BRAIN=claude-activity` contamination guard:
   **imp#2 arm 33/50 = 66.0% → imp#3 arm 37/50 = 74.0%, Δ +8pp** (vs
   the immediately-prior shipped state, isolating imp#3's increment).
   Control did **not** regress — **no category −2pp**, gate satisfied.

   **Honest caveats (supporting, not headline, evidence):**
   - +8pp on the bench's **highest-variance** category from a single
     50Q arm with mark-dormant IDF run-to-run variation — within the
     ±10-15pp 50Q noise band. The guard (no −2pp) is what this
     establishes; a *precise* +8pp attribution is not claimed.
   - Cumulative trajectory across shipped improvements:
     44.0% (clean) → 66.0% (imp#1+2) → 74.0% (imp#1+2+3),
     monotone, directionally consistent with the pre-registered
     hypothesis that lexical-precision boosts help the entity/date-
     anchored temporal questions. NOT presented as a measured +30pp
     headline — three single-arm points on a high-variance category.
   - The deterministic A/B remains the lift proof; the bench arm's role
     is regression-guard (passed) + directionally-supporting evidence.

**Gate status:** mechanism PROVEN; regression-guard PASSED (control
+8pp, no category −2pp). Status: **KEPT.**
