# Observation window 1 — review notes (NOT rule changes)

> Process log for the 2026-07-11 → 2026-07-25 window. Batch-review
> material only; the frozen criteria (stage3-admission.md) and the
> consolidation rules are untouched until the window closes.

## Wilson-bound arithmetic (verified 2026-07-11, prompted by Dath)

The frozen bars require BOTH a raw untouched-approval rate AND a
one-sided 95% Wilson lower confidence bound (z = 1.645):

- memory_strengthened: raw ≥ 95% AND LCB ≥ 85%, n ≥ 20.
  - 20/20 clean → LCB 93.7% → PASSES.
  - 19/20 → raw exactly 95% but LCB 80.4% → FAILS.
  - Effective meaning: 20 consecutive clean reviews, or materially
    more reviews to absorb any failure.
- With a TWO-sided 95% interval (z = 1.96), 20/20 → 83.9% (fails an
  85% bar); reaching an LCB of 95% with zero failures needs ~73 clean
  reviews. The doc's one-sided choice is intentional; never quote
  "20 reviews" without the LCB context.

## Rule-defect candidates for the window-end batch review

1. working_state_refresh fires without checking that a working-state
   note EXISTS for the relevant scope ("stale" implies existence).
2. No real-activity bar: trivial/synthetic sessions (one prompt, no
   outcomes) trigger the class.
3. CROSS-SCOPE OBJECT MODEL: hooks do not send a room/project, so
   every session journals into the ACTIVE brain and the class
   implicates the brain-wide working-state buffer. A DreamBug session
   proposing a refresh of ml-ai's shared state fails Dath's scoping
   test ("would it update only DreamBug's state?"). No executor exists
   for this class, so nothing can mis-apply today — but the class must
   become scope-aware (session → project/room mapping) before any
   Stage-3 consideration. Candidate fixes: hook sends repo/cwd-derived
   room; proposals carry an explicit Scope; executor refuses scope
   mismatches.
4. Identical headlines are indistinguishable in a list; the project
   name now renders in the card context row (addressed in the Memory
   Review redesign).

## Review-semantics reminders (from Dath, 2026-07-11)

- Decisions label the OBSERVATION for observation-only classes and the
  CHANGE for executable classes; the UI now uses two action models
  ("Accurate / Not accurate" vs "Apply change / Reject").
- Clicks do not cause online learning; analysis happens in aggregate
  at the window boundary. Possible outcomes per class: removed,
  improved, kept review-only, limited automatic execution, observed
  for another window.
- Do not reject a proposal for being about another project; reject it
  if its evidence and its target scope disagree. Do not approve on
  Claude's recommendation; approve on the evidence.
