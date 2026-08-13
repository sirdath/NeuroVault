# Curator V1 thresholds — a PROPOSAL for ratification

*Wave 4b-E. Written 2026-08-13 against `aa535b4` plus the Wave 4b working tree.*

> **Every number in this document is PROPOSED. Nothing here is final, nothing
> here is normative, and nothing here may be cited as an acceptance criterion
> until the owner ratifies it.** Spec §20 requires thresholds to be
> *pre-registered* — set before the scoring run and never edited after seeing
> results. This file exists so there is something concrete to ratify, not so
> that ratification can be skipped.

Spec §19.1 names six metrics and supplies no numbers for any of them. §20 then
demands that "every included claim class meets those pre-registered recall and
verifier thresholds on the frozen corpus. 'Fail closed' must not degenerate
into 'fail empty'." That sentence is the whole design constraint: a threshold
set is invalid unless it puts a **floor under recall** and a **ceiling on
terminal loss** for every class, because a verifier that rejects everything
scores perfectly on precision and a generator that proposes nothing scores
perfectly on secret exposure.

---

## The framework this proposal is built inside

Ratified separately and treated here as given:

| Rule | Consequence for this document |
|---|---|
| **HARD** = `generator_candidate_recall` floor, `verifier_false_reject_rate` ceiling, `defer_expiry_rate` ceiling, `end_to_end_candidate_recall` floor | Four metrics gate the release. |
| **MONITORED-only** = `verifier_over_escalation_rate` (alert ceiling), `defer_recovery_rate` (alert floor) | Two metrics get frozen numeric alert bands. Crossing one is a **recorded review before the next manifest version**, never an automatic fail. |
| No threshold freezes against a **proxy** definition | `verifier_false_reject_rate` and `verifier_over_escalation_rate` are proxies today. Their numbers are proposed but **not freezable** until gold dispositions exist. |
| Dev-set numbers are **calibration only, never acceptance** | Every measured figure below is from the 58-unit dev set. None of them is a pass mark; they exist to anchor a margin. |
| Thresholds come from **harm budgets + a predeclared non-inferiority margin** against the corrected qwen baseline | No threshold is "whatever the best model scored". |
| Hard **floors** graded on the one-sided 95% **lower** bound; **ceilings** on the one-sided **upper** bound | A point estimate never grades a gate. |
| An **underpowered class is INSUFFICIENT EVIDENCE**, never a pass | A class too small to bound is blocked exactly as a failing class is. |

Two named exclusions, carried from the manifest and repeated because they are
easy to reach for:

- **Do not use gemma3-12b-sid's `verifier_false_reject_rate` of 0.0714 as a
  target.** Its reject profile is inverted (1 G1 reject, 79 G2), so the low
  number is a different phenomenon, not a better one.
- **Do not canonize qwen3-coder-30b-sid's recall of 0.2087 as the bar.** It is
  a dev-set point estimate on a set that has been argued with repeatedly. It
  anchors a margin; it does not define adequacy.

---

## Measured baselines

Computed read-only by re-running `score.score()` in memory over the committed
result rows. Nothing under `results/` was rewritten, and every metric that
existed before reproduced exactly — which is what makes the two new columns on
the same rows trustworthy.

`1s-lo` / `1s-hi` are one-sided 95% bootstrap bounds (unit-level, 1000
resamples, seed 42) — the grading statistic, not the point estimate.

| Run | `generator_candidate_recall` | `end_to_end` (via `post_gate_recall`) | `verifier_false_reject_rate` | `verifier_over_escalation_rate` |
|---|---|---|---|---|
| **qwen3-coder-30b-sid** *(strongest arm)* | **0.2913** (67/230) · 1s-lo **0.2437** | **0.2087** (48/230) · 1s-lo **0.1590** | **0.2857** (20/70) · 1s-hi **0.3944** | **0.0429** (3/70) · 1s-hi **0.0847** |
| qwen3-coder-30b (quote contract) | 0.2261 (52/230) · 1s-lo 0.1857 | 0.1696 (39/230) · 1s-lo 0.1318 | 0.2407 (13/54) · 1s-hi 0.3333 | 0.0 — structurally, see below |
| gemma3-12b-sid | 0.1217 (28/230) · 1s-lo 0.0851 | 0.1130 (26/230) · 1s-lo 0.0809 | 0.0714 (2/28) · 1s-hi 0.1429 | 0.0 — see below |
| qwen3-1.7b | 0.1783 (41/230) | 0.0478 (11/230) | 0.7442 (32/43) | 0.0 |
| qwen3-4b | 0.0826 (19/230) | 0.0522 (12/230) | 0.4000 (8/20) | 0.0 |
| qwen3.5-2b | 0.0826 (19/230) | 0.0261 (6/230) | 0.6842 (13/19) | 0.0 |
| nuextract-2.0-2b | 0.0217 (5/230) | 0.0130 (3/230) | 0.4000 (2/5) · 1s-hi 1.0 | 0.0 |

Per class, strongest arm only (`gen` = generator recall, `e2e` = post-gate
recall, `fr` = false reject, `oe` = over-escalation):

| Class | gold items | gen · 1s-lo | e2e · 1s-lo | admissible | fr · 1s-hi | oe · 1s-hi |
|---|---|---|---|---|---|---|
| fact | 116 | 0.1983 · **0.1415** | 0.1552 · **0.1000** | 23 | 0.2174 · **0.3889** | 0.0 · 0.0 |
| preference | 41 | 0.3659 · **0.2444** | 0.2683 · **0.1613** | 15 | 0.2667 · **0.4667** | 0.0 · 0.0 |
| decision | 73 | 0.3973 · **0.3059** | 0.2603 · **0.1757** | 32 | 0.3438 · **0.5143** | 0.0938 · 0.1875 |

**The one number worth reading twice.** The generator found 67 gold memories;
48 reached review. **19 correct memories — 28% of everything the model got
right — were destroyed by the gauntlet.** That subtraction is what §20 means
by fail-closed degenerating into fail-empty, and until Wave 4b-E it could not
be computed at all, because `generator_candidate_recall` did not exist.

### The corrected baseline

`230` is not the denominator a product threshold should be set against.

- **9 gold items live in `TOOL_RESULT` blocks.** `PARSER_V1` emits no record
  for those, so they are unreachable by construction in the product — but the
  *harness* feeds the model unit text that still contains the tool lines. The
  harness therefore **over-states** what the product can reach, and every
  harness recall figure is an upper bound on the shipped one.
- Reachable-under-`PARSER_V1` denominator: **221**.
- Whether any of the 67 matched items were tool-sourced cannot be settled
  without re-running the annotation, so the corrected figure is a bracket:
  **0.262 (58/221, worst case) to 0.303 (67/221, best case)**, against 0.291
  uncorrected.

The conservative end, **0.262**, is what the recall margin below is taken from.

---

## The proposal

### M1 · `generator_candidate_recall` — **HARD FLOOR**

| | |
|---|---|
| Status | Spec-exact. The only one of the six that needs no proxy. |
| Measured (dev) | 0.2913, one-sided lower **0.2437** |
| Corrected | 0.262 – 0.303 |
| **PROPOSED floor** | **0.20**, per class, graded on the one-sided 95% lower bound over the **blind** set |
| Freezable | **Yes**, once a blind set exists |

Derived as the conservative corrected baseline (0.262) minus a predeclared
non-inferiority margin of 0.06, rounded down to a round number. The margin is
sized to consequence, not to noise: 230 gold items make 0.06 roughly fourteen
memories, and on a nightly run over the shipped ceiling of 24 units that is
about one memory every other night — the smallest change a user would
plausibly notice as "it stopped catching things". The floor itself is anchored
to fail-empty: below one durable memory in five, the curator is spending a
nightly 30B inference pass to surface less than 20% of what the user would
have wanted saved, and the honest product decision is not to ship it rather
than to lower the bar. It is deliberately **not** derived from qwen's number —
freezing today's model as the definition of adequate is how a benchmark stops
measuring anything.

> **On today's dev evidence, `fact` would not clear this floor** (one-sided
> lower 0.1415 against 0.20), and `fact` is the largest class at 116 of 230
> items. That is a finding about the current arm, not an argument for a lower
> number.

### M2 · `verifier_false_reject_rate` — **HARD CEILING** *(number not yet freezable)*

| | |
|---|---|
| Status | **PROXY.** The spec's denominator is "gold disposition is `ProposalReady` or `ReviewRequired`"; the gold set has no dispositions, so score.py substitutes "the statement matches a gold item". |
| Measured (dev, proxy) | 0.2857, one-sided upper **0.3944** |
| **PROPOSED ceiling** | **0.15**, per class, one-sided 95% upper bound |
| Freezable | **No** — conditional on the gold set gaining per-item dispositions |

Anchored to terminal loss, which §19.1 singles out because it "has no human
backstop in V1". A false reject is not a missing card; it is the assistant
demonstrably reading a fact, correctly extracting it, and then silently
throwing it away. The user experiences that as forgetting something it just
saw — worse for trust than never having offered anything, because it is
invisible and unappealable. At the measured 0.286 the gauntlet destroys
19 of every 67 correct memories; 0.15 roughly halves that while leaving the
gauntlet room to be strict about the things it should be strict about.

Explicitly not anchored to gemma's 0.0714, for the reason recorded above. And
explicitly not freezable yet: a ceiling on a proxy denominator is a number
about the gold set's labeling gaps as much as about the verifier.

> Every class fails this today (upper bounds 0.389 / 0.467 / 0.514), and every
> one of those bounds is wide because the admissible sets are 23, 15 and 32
> candidates. See the power rule below.

### M3 · `verifier_over_escalation_rate` — **MONITORED ONLY**

| | |
|---|---|
| Status | **PROXY, twice over.** The admissible stand-in, *plus* an assumption that every gold item is a gold `ProposalReady` — the gold set records memories a human judged durable, never memories a human wanted reviewed. |
| Measured (dev, proxy) | 0.0429 (3/70), one-sided upper 0.0847 |
| Attribution | `G1b:Synthesis` 2 · `G1b:UnclaimableRole` 1 · `G1b:OversizedEvidence` **0** |
| Whole-run queue view | `G1b:Synthesis` 8 · `G1b:UnclaimableRole` 5 |
| **PROPOSED alert band** | rate **> 0.20**, **or** whole-run escalations **> 1.0 per gold-positive unit** |
| Freezable as a gate | **No.** Monitored only. |

Over-escalation is workload, not loss: the candidate still reaches a human, so
the harm is queue burden and the currency is cards per night, not a rate —
hence the second, absolute limb of the band. The deeper reason it cannot gate
a release is that a low value is ambiguous. gemma3-12b-sid reads **0.0** while
carrying 18 `UnclaimableRole` flags across the run, every one on a candidate
gold never labeled. A metric that reads 0.0 both for "escalates correctly and
rarely" and for "escalates constantly, just never on anything gold knows
about" is an alarm, not a gate.

Crossing either limb triggers a recorded review before the next manifest
version, with the `over_escalation_by_code` breakdown attached —
`OversizedEvidence` read separately from `Synthesis`, as §19.1 requires.

### M4 · `defer_recovery_rate` — **MONITORED ONLY** *(no number possible yet)*

| | |
|---|---|
| Status | **Not implemented and not implementable in the Python harness.** Defer and retry live in the Rust ledger (`state.rs::CuratorLedger`); the harness has no run clock. |
| Measured | none. Nothing in the repo has produced a deferral in anger. |
| **PROPOSED alert floor** | **< 0.90** of mature deferrals recovering |
| Freezable | **No** — conditional on the cohort described under M5 |

Redundant as a gate and useful as an alarm: recovery, expiry and still-pending
partition the mature cohort, so a recovery floor is the arithmetic complement
of the expiry ceiling and would gate the same failure twice. It earns its place
as a leading indicator — recovery degrades before expiry does, because a unit
must exhaust its retries before it can expire.

### M5 · `defer_expiry_rate` — **HARD CEILING** *(no number possible yet)*

| | |
|---|---|
| Status | Not implemented, not measurable from Python, and **not measurable at all** without a matured cohort. |
| **PROPOSED ceiling, once measurable** | **0.05**, one-sided 95% upper bound |
| Freezable | **No** — hard-blocked on the cohort below |

An expired deferral is terminal loss with *no card ever shown* — the same harm
class as a false reject, but one the user cannot even notice, which is why
§19.1 pairs it with `verifier_false_reject_rate` as the counterweight. One in
twenty is the most a system may silently drop before "fail closed" and "fail
empty" stop being distinguishable from the outside.

**The cohort this number requires, and does not have:**

1. **Frozen** before measurement, like any other pre-registration.
2. **Stratified by defer reason** — provider failure, mutated transcript
   prefix, per-request timeout, run-window exhaustion. These have different
   recovery physics: a mutated prefix may never recover, a busy server almost
   always does. A cohort dominated by one reason cannot support a rate for the
   others, and an aggregate over a lopsided mix is not a measurement.
3. **Matured under this manifest's exact retry/TTL clock** — 3 attempts,
   14-day TTL, `[1, 6, 24]` h backoff, 48 h grace. `MANIFEST-V1.json` already
   records that changing any of those values invalidates M4 and M5 outright
   and requires a new manifest version rather than an edit.
4. **Still-pending candidates reported separately** and excluded from both
   denominators until mature, per §19.1's own instruction.

Until all four hold, M5 has no number and the acceptance bar cannot be met.
This is the most consequential of the remaining gaps, not the smallest.

### M6 · `end_to_end_candidate_recall` — **HARD FLOOR**

| | |
|---|---|
| Status | No exact implementation; `post_gate_recall` stands in and is **equal** to it only while every survivor reaches review. |
| Measured (dev) | 0.2087, one-sided lower **0.1590** |
| **PROPOSED floor** | **0.15**, per class, one-sided 95% lower bound |
| Freezable | **Yes**, with the precondition test named below |

This is the number the user actually experiences: memories that reach a review
card. It is deliberately **derived** rather than independently guessed, so the
three hard numbers cannot silently contradict each other:

```
floor_e2e  ≈  floor_generator × (1 − ceiling_false_reject)
           =  0.20 × 0.85  =  0.17   →  proposed 0.15
```

The 0.02 between the arithmetic and the proposal is a stated allowance for
known incompleteness in the labels, not slack: the 230-item denominator
contains at minimum 9 items the product cannot reach and 25 whose term pairs
never resolved to a sentence ID even with the prefix fallback. Burying that
allowance inside a rounder number would hide it.

**Precondition.** The stand-in is only valid while every gauntlet survivor
reaches human review. That is true in V1 — acceptance item 17 is PASSING, all
proposals are quarantined and stored with application `NotApplicable` — and it
must be re-asserted as a named test beside this threshold, so the day someone
adds an auto-apply path this floor stops silently measuring the wrong thing.

---

## Summary

| # | Metric | Class | Measured (dev, strongest arm) | PROPOSED | Graded on | Freezable now |
|---|---|---|---|---|---|---|
| M1 | `generator_candidate_recall` | **HARD** floor | 0.2913 · 1s-lo 0.2437 | **≥ 0.20** | one-sided 95% lower | yes, on a blind set |
| M2 | `verifier_false_reject_rate` | **HARD** ceiling | 0.2857 · 1s-hi 0.3944 | **≤ 0.15** | one-sided 95% upper | **no** — proxy |
| M3 | `verifier_over_escalation_rate` | monitored | 0.0429 · 1s-hi 0.0847 | alert **> 0.20** or **> 1.0/unit** | band, reviewed | **no** — proxy² |
| M4 | `defer_recovery_rate` | monitored | — | alert **< 0.90** | band, reviewed | **no** — no cohort |
| M5 | `defer_expiry_rate` | **HARD** ceiling | — | **≤ 0.05** | one-sided 95% upper | **no** — no cohort |
| M6 | `end_to_end_candidate_recall` | **HARD** floor | 0.2087 · 1s-lo 0.1590 | **≥ 0.15** | one-sided 95% lower | yes, with precondition |

**Applied to today's strongest arm, this set does not pass.** M1 fails on
`fact`, M2 fails on all three classes, M5 and M6 cannot be graded. That is the
proposal working as intended: a threshold set that the current build clears on
the first try was set to the current build.

### The power rule

A class is graded **INSUFFICIENT EVIDENCE** — which blocks acceptance exactly
as a failure does — when its denominator is too small to bound. Proposed
minima: **≥ 50 gold items** for a recall floor, **≥ 30 admissible candidates**
for a verifier ceiling.

On today's per-class counts that means:

| Class | gold items | admissible | M1/M6 gradable | M2 gradable |
|---|---|---|---|---|
| fact | 116 | 23 | yes | **insufficient** |
| preference | 41 | 15 | **insufficient** | **insufficient** |
| decision | 73 | 32 | yes | yes |

`preference` cannot be graded on either axis today. Reporting it as a pass
because its point estimate happens to be the highest of the three (0.3659)
would be exactly the error this rule exists to prevent.

---

## Caveats that travel with every number above

These are properties of the labels, not of any model, and they belong beside
any figure derived from them.

- **Gold-negative n = 5.** Abstention correctness cannot carry a confidence
  interval and the harness correctly refuses to compute one. It is a
  directional smell test — and it is the *only* current evidence against the
  fail-empty degeneration §20 names explicitly. Five units is not enough to
  defend that claim, and no threshold in this document rests on it.
- **58 paraphrase hints unmapped.** Only 162 / 230 gold items resolve to a
  sentence ID under `gold_sid/`; 205 / 230 with the prefix fallback, leaving
  25 unresolved. Any SID-contract recall figure is capped there and the cap
  must be printed beside it. Three gold files additionally record items the
  labeler *deliberately omitted* because no term pair could be built that a
  correct paraphrase would reliably contain — so the gold set is knowingly
  under-complete for paraphrase-fragile claims. That is a ceiling in the
  labels; reporting it as a model failure would be wrong.
- **9 `TOOL_RESULT` gold items are unreachable under `PARSER_V1`,** and
  ungradable for `source_role` besides — the schema offers two roles, so there
  is no correct answer to grade a tool-sourced claim against. They must be
  excluded from the recall denominator **by name, not silently**, which is
  where the corrected 221 above comes from. Note the direction of the error:
  the harness still shows the model the tool text, so harness recall
  over-states product recall.
- **`SEG_H1 ≠ SEG_V1`.** The two segmenters disagree on the shared parity
  fixture — 10 sentences against 12 — and the gap is entirely the redaction
  rule. A `gold_sid` ID is comparable to a product run's ID only for a unit
  with no redaction, no CJK and no short-segment boundary case. One credential
  in a unit shifts every subsequent ID by two. Both tables are now pinned
  (`test_seg_parity.py`, `curator_seg_parity.rs`), so the mapping rule is at
  least *known*; it is not *closed*.
- **The 58-unit set is the dev set.** Its own README says so. Every number in
  this document is calibration. Acceptance needs the blind set that does not
  exist yet, and no threshold here may be graded against the dev set.

---

## What must happen before any of this can be ratified as frozen

1. A **blind test set** — the 58-unit set cannot measure generalization.
2. **Per-item gold dispositions** (`ProposalReady` / `ReviewRequired`), without
   which M2 and M3 remain proxies and M2 cannot be frozen.
3. A **frozen, stratified, matured deferral cohort** for M4 and M5.
4. **Run provenance** in `run_meta.json` — full model digest, prompt and schema
   content hashes, git SHA, scorer version.
5. The **corrected recall denominator published by name**, listing the 9
   excluded `TOOL_RESULT` items.
6. The **owner's ratification** of the six numbers, after which they are
   pre-registered and may not be edited in light of any result.
