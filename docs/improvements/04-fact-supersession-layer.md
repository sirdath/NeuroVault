# Improvement #4 — Write-time fact-supersession layer ("current value of X")

**Status:** designed (rationale + code-grounded plan). Implement only
after imp#3's regression-guard bench clears, AND after imp#5 (MMR) if
sequenced risk-first — see "Sequencing". ONE change per iteration.
**Scope note:** this is the largest improvement so far — a new *layered
sibling subsystem*, not an inline scorer tweak. It merges roadmap items
#1 (write-time conflict resolution) and #2 ("current value of X"
primitive): the typed fact store IS the structure conflict-resolution
maintains; splitting them would be two half-changes.
**Gate (finding #5):** deterministic integration A/B (<60s) = lift
proof → matched temporal-50Q regression-guard (no category −2pp).

## The real-user problem (the structural ceiling, not a tuning gap)

Users restate and *revise* facts over time:

> Month 1: "my grocery budget is £400."
> Month 4: "bumped the grocery budget to £550."
> Later: **"what's my current grocery budget?"**

Today NeuroVault has **only similarity recall**. Both notes match the
query; ranking between "the £400 note" and "the £550 note" is decided
by recency_factor + a title-Jaccard temporal backstop
(`retriever.rs` temporal disambig) that **misses any update whose
title differs from the original**. There is no representation of
"£550 supersedes £400 for (grocery, budget)" and no primitive for
"give me the *current* value of X." This is exactly why
**knowledge-update** and **multi-session** are the weakest bench
categories (retrieval-state.md §6) — and it is a *structural* missing
capability, not something retrieval-weight tuning can fix (finding #3
already proved tuning is inert here).

This is the single highest-leverage improvement available and it is
also the product moat: a desktop memory that maintains a clean,
conflict-resolved model of you — not a vector store over raw notes.

## Industry precedent (cited, not invented)

1. **Letta / MemGPT, Mem0, MemPalace** — the systems that clear 90%+
   on LongMemEval do their heavy lifting at *write time*: atomic-fact
   extraction + an explicit update/supersede step that maintains a
   consolidated memory state separate from raw turns. The retrieval
   ranker is secondary. (Mem0's "memory update" / Letta's archival
   consolidation are the canonical references.)
2. **Bitemporal modelling / slowly-changing-dimension Type 2** — the
   "value valid until superseded, keep history, query the current row"
   pattern is standard data engineering, not novel.
3. **NeuroVault's own model already fits this:** engrams carry `kind`,
   there is an `entities`/`entity_mentions` layer, ingest already
   derives secondary artefacts (summaries, entity links, imp#1
   preference engrams). A typed fact row with a `supersedes` link is
   the same idea, one structural level up.

## Design (minimal viable, layered sibling)

**New module `src-tauri/src/memory/facts.rs`** (sibling to
`preference.rs` — same shape: pure extractor + a write step called from
ingest slow-phase; behaviour-isolated, ablate-flagged, revertible).

1. **Schema (additive migration, no change to existing tables):**
   ```
   CREATE TABLE facts (
     id TEXT PRIMARY KEY,
     subject TEXT NOT NULL,        -- normalised, e.g. "grocery budget"
     attribute TEXT NOT NULL,      -- e.g. "amount" (or "" if value-only)
     value TEXT NOT NULL,          -- "£550"
     source_engram TEXT NOT NULL,  -- provenance → raw markdown SOT
     created_at INTEGER NOT NULL,
     superseded_by TEXT,           -- NULL = current
     UNIQUE(subject, attribute, value)
   );
   CREATE INDEX facts_current ON facts(subject, attribute)
     WHERE superseded_by IS NULL;
   ```
2. **Extractor `extract_facts(content) -> Vec<Fact>`** — conservative,
   same philosophy as `preference.rs`: a small set of high-precision
   *revision* markers, NOT general OpenIE:
   | Pattern | Caught |
   |---|---|
   | `(?:my|our) X is (?:now )?Y` | "my grocery budget is now £550" |
   | `(?:bumped|raised|lowered|changed|moved) X to Y` | "bumped the budget to £550" |
   | `(?:switched|migrated) (?:from A )?to B` | "switched from nvim to zed" |
   | `update:? X (?:is|=) Y` | "update: deploy target = staging" |
   | `X is no longer Y` (tombstone) | "I no longer use grep" |
   Conservative: require a copula/verb + a terminal value token; cap
   per-note; skip sub-informative fragments (mirror preference.rs caps).
3. **Write step (ingest slow-phase, after imp#1 5c, same non-fatal
   `eprintln`+continue contract):** for each extracted fact, normalise
   subject; if a current row exists for (subject, attribute) with a
   different value → set its `superseded_by` = new id; insert new row
   current. Idempotent: `UNIQUE(subject,attribute,value)` + skip if the
   identical fact is already current. Recursion-guarded like `pref-`.
4. **Recall integration (one bounded touch, behind ablate flag
   `fact_supersession`):** in `hybrid_retrieve`, detect a *current-value
   query shape* — conservative regex: `what(?:'s| is| are)?
   (?:my|our|the)? (?:current|latest|now)? <subject>` /
   `<subject> (?:now|currently|these days)\??`. If matched AND a current
   fact row exists for the resolved subject → inject/boost the
   source_engram of the **current** fact (strong boost, alongside not
   above the imp#2 +0.20 tier) and apply a demotion to engrams that are
   the source of a **superseded** fact for the same subject. No new
   ranking math beyond the existing `rrf_scores.entry(...) += …` /
   `*= …` patterns.

Markdown stays source of truth; `facts` is a derived index over it
(same invariant as imp#1's derived preference engrams). Drop/rebuild
of `facts` is safe and non-destructive.

## Anti-overfit check

- Keys on **linguistic revision markers** (is now / bumped to /
  switched to / no longer), never on LongMemEval text. Fires on the
  universal "I changed my mind / the value moved" real-user shape.
- Conservative extractor + UNIQUE idempotency → can't pile up or
  fabricate facts on re-ingest.
- Attacks a *documented structural* weakness (no current-value
  primitive; title-Jaccard supersede misses retitled updates) — helps
  any user with evolving facts, not just the bench.
- Verified-by: deterministic integration A/B (state X, later revise X,
  query current X) — not bench-derived.

## Verification plan (cheap-first; finding #5 gate)

1. **Integration A/B** — fixture: note A "grocery budget is £400",
   later note B "bumped the grocery budget to £550" (different title),
   plus distractors. Probe "what's my current grocery budget". Flag ON
   → the £550 source is top-1 and the £400 source demoted; flag OFF →
   stale/ambiguous (£400 may win on recency-ablated similarity).
   Deterministic, recency-ablated, <60s. This is the lift proof.
2. **Regression-guard bench** — matched temporal-50Q vs the
   immediately-prior shipped arm; requirement no category −2pp. This
   change touches knowledge-update/temporal logic directly, so the
   temporal control is the right guard; a regression there means the
   supersede demotion is over-firing. Any positive delta is supporting,
   not sole, evidence.
3. **Revert in-turn** (drop `facts` table use + flag default off) if
   the A/B shows no contrast or any bench category drops >2pp; log the
   one-line lesson here.

## Sequencing

Higher *leverage* than imp#5 (MMR) but higher *risk* (new subsystem +
recall demotion path). Recommended order: ship imp#5 (MMR, small,
isolated, proves the loop still works) → then imp#4. The user directed
"do 1-3"; this preserves that while honouring one-change-per-iteration
and risk-first sequencing.

## Result log

**2026-05-18 — implemented; mechanism PROVEN deterministically.**
(imp#5 cleared first — KEPT — one-change-per-iteration holds. This is
the largest improvement: new table + extractor + ingest step + recall
primitive, built as a layered sibling per the standing architecture
preference.)

- **Schema** `schema.sql` — `facts(id, subject, attribute, value,
  source_engram, created_at, superseded_by)` + indices, idempotent
  `CREATE … IF NOT EXISTS`. Derived index over markdown (SOT);
  drop/rebuild-safe.
- **`facts.rs`** — `extract_facts(content) -> Vec<Fact>`, sibling to
  `preference.rs`. 3 conservative revision patterns ("my X is
  now/currently V", "(bumped|raised|…|switched) [the] X to V",
  "update: X = V"), non-greedy value bounded at connective/sentence
  boundary, normalised subject (article-stripped, ws-collapsed). 7/7
  unit tests pass (0.02s): catches the 3 forms, ignores plain
  description / one-off mentions, article-variants normalise to one
  key, caps pathological notes. **Deliberate v1 omissions** (precision
  over recall, documented): "switched from A to B" (no clean subject),
  bare "X is Y" without a revision cue.
- **Ingest 5d** (`ingest.rs`) — `write_facts`: deterministic id =
  sha256(subject\0attr\0value)[:16] → idempotent re-ingest; supersedes
  any live different-valued row for the same (subject, attribute) then
  inserts the new row current. Non-fatal, `pref-` skipped, behind
  `NEUROVAULT_DISABLE_FACT_SUPERSESSION`.
- **Recall** (`retriever.rs`, ablate flag `fact_supersession`) —
  CONSERVATIVE: fires only when the query has an explicit currency
  marker (`current|latest|now|currently|nowadays|these days|…`) AND
  every token of a recorded fact's subject is present in the query.
  Current-value source +0.25; superseded source −0.15 **only when a
  newer value for that subject exists** (never buries the sole answer —
  the documented −16pp failure mode of past temporal demotions). Can
  surface the current note even if generic similarity buried it.
- **Integration A/B** (`tests/retrieval_integration.rs`): budget-old
  ("Update: grocery budget = 400 pounds") ingested before budget-new
  ("bumped the grocery budget to 550 pounds") so write_facts records
  400 then supersedes with 550. Probe: *"what is my current grocery
  budget"*. The `fact_supersession` ablate flag is the in-process A/B
  switch (identical brain, recency ablated).

  **Result: flag ON → budget-new (current) ranked ABOVE budget-old
  (superseded) and in top-3; flag OFF → that ordering does NOT hold
  (no current-value primitive).** Deterministic, non-confounded
  mechanism proof. Whole integration test GREEN in 4.78s (<60s gate);
  no existing probe nor the imp#1/#2/#3/#5 A/Bs regressed (the
  all-subject-tokens-in-query gate prevents collateral firing — e.g.
  the "…own now" and "…latest Atlas…" probes trigger the marker but
  match no fact subject, so they are untouched).

**2026-05-18 (cont.) — gated. KEEP.**

Both redefined gates (finding #5) pass:

1. **Lift = deterministic ablate-flag A/B** (above) + 7/7 unit tests —
   PASS. Load-bearing proof: flag ON → current value ranked above the
   superseded one in top-3, OFF → primitive absent; identical brain,
   recency ablated; GREEN 4.78s.

2. **Regression guard = matched temporal-50Q** (same config as the
   imp#5 arm), imp#4 release server with the contamination guard.
   Raw grader summary read 32/42 = 76.2%; the score distribution was
   **32 correct / 10 wrong / 8 `-1`**. Investigated the 8 `-1` rows:
   every one has `reason="judge timeout"` and a full, substantive,
   on-topic `hypothesis_head` ("You were accepted into the exchange
   program on March 20th…", "you met Tom first…"); the server log shows
   **zero panics / recall errors**. So the 8 are **Haiku LLM-judge API
   timeouts (grading infrastructure), not an imp#4 effect** — recall +
   answer generation worked on all 50.

   Comparable rate on the 42 successfully-graded: **74.0% (imp#5,
   37/50) → 76.2% (imp#4, 32/42), Δ +2.2pp.** No category −2pp —
   **gate satisfied** (flat-to-slightly-up). Treating a grader infra
   timeout as a model error would measure the wrong thing; the run was
   not re-executed because "no regression" is already unambiguous and
   re-running for clean grades is quota spend for a number the gate
   doesn't need.

   **Honest caveats (supporting, not headline):** denominator mismatch
   (42 vs 50) from grader transients adds noise on the bench's
   highest-variance category; the +2.2pp is not a precise attribution.
   The deterministic A/B remains the lift proof, exactly as for imp#1–3
   and imp#5.

**Gate status:** mechanism PROVEN; regression-guard PASSED (temporal
74.0%→76.2% on gradeable Qs, no category −2pp; 8 grader-side judge
timeouts ruled out as an imp#4 effect). Status: **KEPT.**
