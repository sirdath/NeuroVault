# Stage 3 admission criteria — FROZEN before observation

> Status: FROZEN 2026-07-10, before the first dogfooding label exists.
> These bars are deliberately chosen in advance; the observation
> period's measurements INFORM whether a class clears them — the bar
> itself does not move during a window. Changing any bar or any
> consolidation rule RESETS the evaluation window for that class.
> Origin: Dath's stage-3 governance (2026-07-10): "the system cannot
> unconsciously move the goalposts."

## Observation window 1

- **RESTART (2026-07-11):** no labels were recorded under the original
  review UI, and the Memory Review redesign (8991163) replaced the
  labeling instrument. Dath approved via screenshots; installed
  2026-07-11 15:18. The criteria below are unchanged.
- **Period:** 2026-07-11 → 2026-07-25 (two working weeks).
- **No rule or threshold changes midstream.** Errors are reviewed in
  batches; a rule changes only when a PATTERN emerges, and any
  material change resets the window.
- **Held-out audit set:** every proposal whose `proposal_id` first hex
  digit is `0` or `1` (deterministic, ~12.5%) is the audit set. It is
  reviewed like everything else but EXCLUDED from any analysis used to
  adjust rules — otherwise we measure how well consolidation matches
  the examples that taught it.
- **Routine:** use NeuroVault normally; run consolidation once or
  twice daily (`Run consolidation` in the Inspector, or
  `neurovault-server consolidate`); review every surfaced proposal (or
  the predetermined sample if volume forbids); record false negatives
  while the experience is fresh.

## Per-class bars (all conditions required; measured on non-audit labels)

Legend: LCB = one-sided 95% Wilson lower confidence bound on the
untouched-approval rate — the raw percentage is not sufficient.

### memory_strengthened (deterministic outcome transition; band High)
- reviewed sample ≥ 20 · review coverage ≥ 80%
- untouched-approval ≥ 95% with LCB ≥ 85%
- field-edit rate ≤ 5% · rejection rate ≤ 5%
- zero severe unsupported proposals (severe = evidence does not
  support the claim, or the object is wrong)
- observed in ≥ 3 rooms / ≥ 2 work types
- no degradation in the later half of the window
- executor reversible: YES with caveat — `last_confirmed_at` overwrite
  does not retain the prior value today. Stage 3 for this class
  ADDITIONALLY requires journaling the prior value on apply
  (reversibility precondition).

### supersession_suggestion (band Medium)
- reviewed sample ≥ 15 · coverage ≥ 80%
- untouched-approval ≥ 90% with LCB ≥ 75%
- field-edit rate ≤ 15% · rejection rate ≤ 10%
- zero severe unsupported (wrong-pair supersession is SEVERE: it hides
  a live memory)
- ≥ 3 rooms · no later-half degradation
- executor reversible: YES (`superseded_by` is nullable metadata; the
  note never moves) — but because the failure mode hides knowledge,
  this class stays proposal-only for at least TWO clean windows.

### working_state_refresh (band Medium)
- REVIEW-ONLY INDEFINITELY in current form: the proposal carries only
  `needs_refresh` (contents await the hardened transcript reader).
  Re-evaluate as a class only after the reader ships in proposal-only
  mode and its own privacy/provenance audit passes.

### room_summary_refresh (band Low)
- REVIEW-ONLY INDEFINITELY until a summariser executor exists; then
  starts its own two-window observation from zero. Inferred summaries
  may remain review-only permanently — automation is not owed.

## User-burden metrics (tracked alongside precision)

A technically accurate system that demands constant review is not
automatic. Alongside precision we track:
- median seconds per reviewed proposal (proposed_at → decided_at,
  `median_review_seconds`)
- queue backlog growth (unreviewed count across consolidation
  reports over time)
- proposals per working session
- share of decisions whose reason marks them "obvious/annoying"
  (free-text `decision_reason`; batched pattern review)
- false negatives recorded per week (reporting burden itself counts)

Target for the window: review burden trending DOWN in the second week
without precision loss. The end state is high precision with a very
small trust-maintenance burden.

## What Stage 3 promotion looks like (per class)

A class that clears every bar above MAY be promoted by an explicit,
recorded decision (a journal event `stage3_promoted` naming the class,
the window, and the numbers). Promotion requirements beyond the bars:
- the executor is reversible IN PRACTICE (tested rollback);
- automatic writes remain visible in the Inspector exactly like
  proposals (with `capture_method: "auto"`);
- a kill switch exists (config flag per class);
- one clean follow-up window in auto mode with spot audits.

Classes never promoted by default. Some may remain review-only
indefinitely; that is a valid end state, not a failure.
