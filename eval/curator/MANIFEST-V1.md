# MANIFEST-V1 — the curator benchmark pre-registration

`MANIFEST-V1.json` is the file spec §20 asks for:

> before the frozen labeled corpus is scored, a committed benchmark manifest
> records the corpus hash, generator/verifier/policy fingerprints, retry/TTL
> policy, included claim classes, and pre-registered thresholds for
> `generator_candidate_recall`, `verifier_false_reject_rate`,
> `verifier_over_escalation_rate`, `defer_recovery_rate`, `defer_expiry_rate`,
> and `end_to_end_candidate_recall`.

**It is not finished, and it says so.** `manifest_status` reads `PARTIAL`.
Six blocking items sit under `frozen_at_next_run`. Until that list is empty,
no scoring run may be reported against this manifest.

## Why a manifest at all

A benchmark you can tune after seeing the numbers is not a benchmark. The
manifest exists so that the corpus, the model, the prompt, the schema, the
verifier, the retry policy and the pass marks are all nailed down *before*
the run — and so that a later reader can tell whether the thing that was
scored is the thing that shipped.

Everything under `frozen` is a fact you can re-derive today. Every entry
carries either a `verify_with` command or a `file:line`-grade source. Nothing
in it is a judgement call.

## What is frozen

| Section | Identity |
|---|---|
| `corpus` | 80 units, 1,068,539 bytes, `b1e3684b…3adc` |
| `gold` | 58 units / 230 items / 5 negatives, `07ad5eb8…1f99` |
| `prompt` | `extract_sid.txt`, `8de0e665…9a11`, 3,699 bytes |
| `schema` | `schema_sid.json`, `a6346fbc…d749`, output schema v2 |
| `verifier_fingerprint` | parser 1 · redaction 1 · segmenter 1 · identity 2 · verifier 2 |
| `policy_fingerprint` | `POLICY_EPOCH = 2026-08-vp2`, three claim classes, no destructive actions |
| `retry_and_ttl_policy` | 3 attempts · 14-day TTL · [1, 6, 24] h backoff · 48 h grace |
| `redteam_corpus` | 20 families / 37 cases / 0 divergences, executed by `curator_redteam_e2e.rs` |
| `grammar_corpus` | 24 cases (5 accept / 13 reject / 6 divergent), executed by `grammar_check.py` against the vendored llama.cpp converter `c5760701…bf3a` |
| `measured_baselines` | the last SID and quote-contract runs, as evidence to anchor thresholds against |

The corpus and gold hashes are directory digests, not file lists, because the
data itself is private and uncommittable (`eval/curator/.gitignore`). The hash
is the committable identity: it proves two runs saw the same bytes without
those bytes ever entering git.

## What is not frozen, and why

Six blocking gaps. None of them is a rounding error.

**1. There are no thresholds.** The spec requires pre-registered thresholds and
supplies none — §19.1 names the six metrics, §20 demands each class meet "those
pre-registered thresholds", and no number appears in either. Wave 4a will not
invent an acceptance bar and dress it as normative. A human sets these, per
metric per class, before the run. The strongest measured arm to anchor against
is `qwen3-coder:30b` on the SID contract: recall 0.209, false-reject 0.286,
source-role 0.984.

The one constraint the spec *does* impose on the shape: a threshold set is
invalid unless it puts a floor under recall **and** a ceiling on false
rejection for every included class. "Fail closed" must not degenerate into
"fail empty", and a verifier that rejects everything scores perfectly on
precision.

**2. No model digest is recorded.** `run_meta.json` has no digest field. The
only digests recoverable are 12-hex short forms scraped out of embedded
`ollama ps` rows, and one results dir has none at all. A generator fingerprint
that cannot survive an `ollama pull` of the same tag is not a fingerprint. The
Rust provider already pins the full digest and aborts on mismatch; the harness
should record what the Rust side already knows how to demand.

**3. `run_meta.json` identifies the prompt and schema by path string.** No
content hash, no git SHA, no scorer version. Reproducibility currently rests on
nobody having edited a file underneath a result.

**4. Two of the six metrics do not exist.** *(Four, at manifest version 1.)*
`defer_recovery_rate` and `defer_expiry_rate` appear nowhere in the repo
outside the spec, and cannot come from the Python harness at all — defer and
retry live in the Rust ledger, so measuring them needs a reader over
`state.rs::CuratorLedger` **and** a deferral cohort matured under this
manifest's exact retry/TTL clock. `defer_expiry_rate` is the terminal-loss
counterweight §19.1 names, so this is the most consequential remaining gap,
not the smallest.

`generator_candidate_recall` and `verifier_over_escalation_rate` were
implemented in `score.py` at manifest version 2. Implementing the second one
did not remove a blocker; it removed an excuse for not looking.

Of the four that now exist, exactly one is the spec's metric:

| metric | status |
|---|---|
| `generator_candidate_recall` | **exact.** The same one-to-one assignment `post_gate_recall` uses, run over every pre-gate proposal; denominator is the 230 gold items. |
| `verifier_false_reject_rate` | **proxy.** Shares the spec's name, not its denominator: score.py's admissible set is "statement matches a gold item", because the gold set carries no disposition labels. |
| `verifier_over_escalation_rate` | **proxy, twice over.** The same admissible stand-in, *plus* an assumption that every gold item is a gold `ProposalReady` — the gold set records memories a human judged durable, never memories a human wanted reviewed. |
| `end_to_end_candidate_recall` | **no equivalent.** `post_gate_recall` stands in, and only stays equivalent while every survivor reaches review. |

No threshold may be frozen against a proxy row. `generator_candidate_recall −
post_gate_recall` is the one piece of arithmetic §20 asks for directly: what
the generator found, minus what survived, is what the verifier destroyed. On
the strongest measured arm that is 0.291 → 0.209, i.e. **19 of the 67 gold
memories the model actually found were killed by the gauntlet**.

**5. The gold set has no dispositions.** Two of the six metrics are defined
against a gold `ProposalReady` / `ReviewRequired` label that has never been
annotated.

**6. The 58-unit set is the dev set.** Its own README says so: it has been
argued with and scored against many times and can no longer measure
generalization. Acceptance needs a held-out set that does not exist yet.

## Standing caveats on the gold set

These are properties of the labels, not of any model, and they belong beside
every number derived from them:

- **n=5 gold-negative units.** Abstention correctness is a directional smell
  test. It cannot carry a confidence interval and the harness correctly refuses
  to give it one.
- **162 / 230 gold items resolve to a sentence ID** (205 with prefix fallback).
  Any SID-contract recall figure is capped there, and the cap must be printed
  next to it.
- **9 gold items live in `TOOL_RESULT` blocks.** PARSER_V1 emits no record for
  those, so they are unreachable by construction and ungradable for
  `source_role` — the schema offers only `user` and `assistant`, so there is no
  right answer to grade against.
- **Some items were deliberately omitted.** Three gold files record, in
  `labeler_notes`, items the labeler dropped because no term pair could be
  built that a correct paraphrase would reliably contain. The gold set is
  knowingly under-complete for paraphrase-fragile claims. That is a recall
  ceiling in the labels, and reporting it as a model failure would be wrong.
- **`SEG_H1 ≠ SEG_V1`.** The re-annotation ran under the harness segmenter
  (`segmenter_harness_version: 1`), which is not the shipped Rust `SEG_V1`.
  Sentence IDs in `gold_sid/` are only comparable to a Rust run's IDs where the
  two segmenters agree; the mapping rule between them is unproven and untested.
  Treat a SID-level comparison across the two as unverified until a fixture
  pins them together.

## Version 3 — the epoch moved

`POLICY_EPOCH` is `2026-08-vp2` and `VERIFIER_VERSION` is `2` as of Wave 4c,
which applied the spec owner's conformance rulings: G04 correlates evidence on
ASCII acronyms as well as content words, and G08 reads a comparison marker as
review rather than as a polarity inversion. `revision_log` in the JSON carries
the detail.

**Nothing below was measured under `vp2`.** The epoch is an input to `UnitKey`
and to every `proposal_id`, so it partitions identity as well as meaning: two
runs under different epochs neither collide nor compare. Every number in
`measured_baselines` was produced under `vp1` and must be labelled as such the
moment a `vp2` number sits beside it.

## Updating this manifest

Bump `manifest_version` for any change to a `frozen` value. Moving an item out
of `frozen_at_next_run` and into `frozen` is what the next wave does; deleting
one without freezing it is not.

Changing any field of `retry_and_ttl_policy` invalidates `defer_recovery_rate`
and `defer_expiry_rate` outright — both are defined against that exact policy —
and requires a new manifest version rather than an edit.
