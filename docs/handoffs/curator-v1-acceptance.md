# Local memory curator — the V1 acceptance walk

*Wave 4a (proof & freeze, the no-model half). Written 2026-08-13 against the
working tree at `4308575`, with the corpus test added. Re-verified green after
Wave 3's runner/scheduler/HTTP commits landed mid-wave.*

Spec §20 lists 24 conditions the curator must meet before it may enter a
developer-only build. This is every one of them, walked, with the evidence
named. There is no partial credit and nothing is rounded up: an item is
**PASSING** only if a test I can name asserts it, **DOC** if the guarantee is
structural and its statement is the artifact, and **PENDING** otherwise —
with the exact missing work spelled out.

**Score: 19 PASSING · 1 DOC · 4 PENDING.** Three of the four PENDING items are
blocked on the approval-gated re-benchmark; the fourth is the llama.cpp grammar
corpus, which needs no model and no approval, only work.

Test paths: Rust unit tests live beside their module in
`src-tauri/src/memory/adaptive/curator/<module>.rs::tests`; the corpus test is
`src-tauri/tests/curator_redteam_e2e.rs`; TS tests are under `src/`.

---

## The walk

| # | §20 acceptance item | Status | Evidence |
|---|---|---|---|
| 1 | hardened transcript/evidence reader tests pass | **PASSING** | `evidence.rs`: `descendant_symlinks_are_rejected`, `symlinked_approved_root_resolves_once_and_captures`, `special_files_are_rejected_without_blocking`, `invalid_path_byte_cases_fail_before_source_access`, `unsupported_platform_fails_closed_before_source_access`, `prefix_bounds_and_short_sources_fail_closed`, `same_length_prefix_mutation_between_hash_passes_is_rejected` · `transcript.rs`: `symlinks_and_malformed_locators_are_refused`, `mutated_truncated_and_missing_sources_never_read_newer_bytes`, `consent_is_checked_before_any_filesystem_access` |
| 2 | enabled outcome capture stores a typed, capture-time prefix digest | **PASSING** | `evidence.rs::captures_exact_prefix_and_never_persists_absolute_path`, `unavailable_source_is_visible_without_a_reference` · `receipts.rs::identity_survives_a_longer_observed_prefix` |
| 3 | versioned host parser emits per-record roles, coordinate ranges, sanitized segments with reproducible hashes | **PASSING** | `transcript.rs`: `parses_role_tagged_records_from_host_structure`, `sanitization_performs_no_unicode_normalization_and_no_crlf_rewriting`, `redaction_replaces_every_class_and_records_sanitized_ranges`, `parse_prefix_and_parse_bytes_agree` · `segment.rs`: `replay_is_byte_identical_twice`, `segmenter_version_pins_the_crate_and_unicode_data_version` · `state.rs::evidence_digest_is_order_free_and_stable` · **new**: `curator_redteam_e2e::every_fixture_render_matches_seg_v1` pins RENDER_V1 over all 19 committed transcript fixtures |
| 4 | model envelope contains no journal, brain, session, path, or real object identifiers | **PASSING** | `prompt.rs`: `schema_forbids_every_field_the_model_must_not_emit`, `the_template_never_asks_for_quotes_offsets_or_span_coordinates`, `the_live_unit_is_shaped_exactly_like_the_few_shot_transcripts` · `segment.rs::atlas_tuesday_render_v1_is_exact` pins the exact bytes — RENDER_V1 emits only `S{n} [role]: text`, so there is no field an identifier could ride in on |
| 5 | model disabled/unavailable leaves current behavior unchanged | **PASSING** | `runner.rs`: `consent_off_records_a_skip_and_reads_no_transcript`, `a_pre_curator_proposal_line_still_decodes_and_round_trips` (a pre-curator `proposals.jsonl` line round-trips without gaining the key) · `provider.rs`: `a_model_that_is_not_installed_aborts_the_run`, `an_unreachable_runtime_aborts_the_run` · `schedule.rs::the_tick_gate_names_every_reason_it_declined` |
| 6 | raw provider responses are capped before deserialization | **PASSING** | `provider.rs::an_oversized_response_never_reaches_the_json_parser` · `gates.rs::g00_rejects_an_oversized_response_without_parsing_it` · **new**: `curator_redteam_e2e::family_20_oversized_response_is_capped_before_any_parse` synthesizes the manifest's 300 KiB body against the 256 KiB cap |
| 7 | the exact served schema-v2 object **and its generated llama.cpp grammar** pass the same accepted/rejected fixture corpus using only the allowed schema subset | **PENDING** | Schema half done: `prompt.rs`: `schema_matches_the_eval_harness_byte_for_byte`, `schema_uses_only_the_grammar_solid_keyword_subset`, `sid_pattern_is_anchored_and_range_bounded`. **Grammar half missing entirely** — see PENDING-1 |
| 8 | native Ollama preflight, qwen3-class top-level `think: false`, per-model canary, batch `keep_alive`, verified `/api/ps` unload pass integration tests | **PASSING** (against a mock, by design) | `provider.rs`: `preflight_succeeds_and_reports_what_actually_ran`, `preflight_warms_up_before_it_canaries`, `a_unit_request_carries_the_whole_native_contract`, `opting_out_of_think_control_omits_the_field_entirely`, `keep_alive_spans_the_batch`, `the_batch_ends_with_a_verified_unload`, `a_model_that_stays_resident_is_a_reported_fault`, plus five canary-failure tests · **new**: three `family_20_*` provider tests drive a real `ProviderSession` against an in-process axum Ollama. **Caveat, not a gap:** every one runs against a mock. CI must never need a 20 GB model. Real-hardware confirmation is Wave 3's manual dev run, recorded there. |
| 9 | every proposed field cites one to three adjacent, server-resolved sentence IDs | **PASSING** | `gates.rs`: `g00_bounds_counts_sizes_and_ids`, `g00_rejects_duplicate_and_over_cardinality_evidence`, `family_03_non_adjacent_splice_dies_at_g02`, `family_13_unknown_and_malformed_ids_die_at_g02` · `segment.rs::resolve_is_a_table_lookup_and_refuses_unknown_ids` · **new**: `wire_cases_reach_their_expected_terminal_gate` (25 corpus cases) |
| 10 | every extractive candidate has one complete-proposition Primary sentence, and every multi-source class matches its closed support-group contract | **PASSING**, with one flag | Primary designation: `gates.rs::family_03_adjacent_splice_is_synthesis_review`, `golden_p1_passes_twelve_gates_to_proposal_ready`. Multi-source classes **do not exist in V1** — the contiguous-span rule collapses to one sentence (guide §9.6), so the support-group contract is vacuously met. **Flag:** "complete proposition" is implemented as *protected-token* coverage, which is narrower than the phrase suggests — see DIVERGENCE-1 |
| 11 | invalid, cross-scope, changed, private, or secret evidence fails closed | **PASSING**, with one flag | invalid: `gates.rs::family_13_unknown_and_malformed_ids_die_at_g02` · cross-scope: `family_11_a_cross_brain_object_dies_at_g01` + **new** `post_g00_cross_brain_object_dies_at_g01` · changed: `transcript.rs::mutated_truncated_and_missing_sources_never_read_newer_bytes` + **new** `family_14_mutated_prefix_defers_without_a_model_call` · private: `gates.rs::a_private_room_refuses_the_whole_unit` · secret: `family_16_a_redacted_sentence_is_readable_but_not_citable`, `family_16_a_private_path_in_the_statement_dies_at_g09`. **Flag:** the corpus's own secret-leak fixture never reaches G09 — see DIVERGENCE-5 |
| 12 | different field values over identical evidence cannot collide | **PASSING** | `identity.rs`: `the_three_recipes_never_collide_on_identical_inputs`, `field_order_cannot_move_a_proposal_id`, `a_different_sentence_is_different_evidence`, `evidence_key_is_byte_stable`, `claim_key_is_byte_stable`, `proposal_id_is_byte_stable`, `canonical_span_encoding_is_frozen` |
| 13 | rejected evidence cannot be rephrased into repeated review spam | **PASSING**, with a known ceiling | `identity.rs`: `a_rejected_memory_cannot_come_back_reworded`, `a_verifier_rejection_does_not_tombstone` · `gates.rs::family_18_a_tombstoned_evidence_key_can_never_be_resurrected`. **Ceiling** (guide §10.8, accepted for V1): `claim_key` normalization is trim + whitespace-collapse only, so "Atlas deploys only on Tuesdays." and "Atlas deploys on Tuesdays only." mint different keys and G11 misses that near-duplicate. Worst case is a second review card, never a wrong memory. |
| 14 | a timed-out complete unit is retried after watermark advance | **PASSING** | `state.rs`: `deferral_is_retryable_and_exhaustion_is_visible_not_a_rejection`, `deferred_unit_is_not_due_until_its_backoff_elapses`, `oldest_unprocessed_extends_the_read_window`, `ttl_expiry_is_visible_never_a_silent_skip` · `runner.rs::provider_failure_defers_the_unit_without_advancing_past_it` · `provider.rs::a_hung_inference_hits_the_per_request_ceiling` · **new**: `family_20_server_busy_backs_off_then_defers`, `family_20_truncated_response_defers` |
| 15 | concurrent runs are serialized by a per-brain consolidation lock | **PASSING** | `adaptive/lock.rs`: `two_threads_one_winner`, `different_brains_never_block_each_other`, `a_panicking_run_still_releases_the_slot` · `runner.rs::a_second_caller_loses_the_lock_cleanly` · `schedule.rs::a_busy_manual_run_does_not_stamp_the_clock` |
| 16 | deterministic proposals remain byte-for-byte stable | **PASSING** | `identity.rs`: seven byte-stability tests plus `a_model_upgrade_does_not_duplicate_a_proposal` and `a_segmenter_upgrade_mints_new_identities_rather_than_colliding` · `gates.rs::verification_is_deterministic_and_side_effect_free` · `state.rs`: `replaying_the_same_journal_produces_zero_new_units`, `a_crash_before_the_audit_replays_the_unit_exactly_once` · `runner.rs::replay_and_crash_recovery_process_each_unit_exactly_once` · **new**: `family_20_crash_mid_run_replays_to_an_unchanged_store` |
| 17 | all curator proposals are quarantined, review-only, stored with application `NotApplicable` | **PASSING** | `runner.rs::worked_example_stores_p1_and_rejects_p2_at_g06` asserts `application_status == NotApplicable` on the stored record · `MemoryReview.curator.test.tsx` (12 assertions) covers the card surface · `inspectorCopy.curator.test.tsx` (7) covers the copy |
| 18 | no curator path calls an immediate-write fact endpoint | **DOC** | Structurally true and verifiable by inspection, but **nothing asserts the negative**. The `Disposition` enum has five variants and no `AutoWrite` (`gates.rs:296-325`, whose doc comment states the invariant); the only write in the whole module is `proposals::append` at `runner.rs:1021`; a grep of `curator/` for `ingest_content`, `ingest::`, `create_note` or a `remember` *call* returns only the three `curator_remember_*` action **name** strings. See PENDING-4 for the mechanical guard that would upgrade this to PASSING. |
| 19 | curator-derived journal events carry durable lineage and cannot feed later curator extraction | **PASSING** | `lineage.rs`: `family_19_curator_output_recycled_as_evidence_yields_zero_units`, `a_derived_from_curator_marker_beats_an_allowlisted_shape`, `an_unknown_future_emitter_fails_closed`, `consolidation_output_is_ineligible_by_lineage_not_by_name_list` (11 tests total) · `runner.rs::family_19_curator_output_never_becomes_a_unit` · **new**: `family_19_curator_output_never_forms_a_unit` asserts the manifest's per-event reason map, not just the unit count |
| 20 | all twenty red-team families have regression fixtures | **PASSING**, with five divergences | **new**: `curator_redteam_e2e::every_manifest_line_is_claimed` asserts families == 1..=20 and that each of the 36 manifest lines has a named driver — a new fixture fails the build until somebody claims it. All 36 execute. Five land on a different gate than the corpus predicted; all five are recorded below and none is less strict. |
| 21 | a committed benchmark manifest before the frozen corpus is scored | **PENDING** | `eval/curator/MANIFEST-V1.json` is committed and records corpus hash, gold hashes, prompt/schema fingerprints, verifier/policy versions, retry/TTL policy, claim classes and measured baselines. Its `manifest_status` reads **PARTIAL** with six blocking gaps — see PENDING-2 |
| 22 | every included claim class meets those pre-registered thresholds; "fail closed" must not degenerate into "fail empty" | **PENDING** | No thresholds exist to meet, four of the six metrics are unimplemented, and the scoring run is approval-gated and did not happen in this wave — see PENDING-3 |
| 23 | model, prompt, schema, evidence, policy and NLI fingerprints appear in safe local receipts | **PASSING** | `receipts.rs`: `a_realistic_receipt_carries_no_path_prompt_or_transcript_text`, `extension_key_set_never_changes_silently`, `identity_changes_when_a_transform_version_changes`, `nli_record_round_trips_when_present`, `gate_records_reject_prose_paths_and_quotes` · `runner.rs::worked_example_stores_p1_and_rejects_p2_at_g06` asserts `generation.{model_id,model_digest,output_schema_version}` and `verification.policy_epoch` on the stored record. NLI's V1 fingerprint is its absence (`verification.nli.is_none()`), which is the honest value while no scorer ships. |
| 24 | a global curator kill switch is test-locked | **PASSING** | `runner.rs`: `consent_off_records_a_skip_and_reads_no_transcript` (asserts the model is never contacted), `consent_views_cannot_drift` (the two readers of `local_curator.json` can never disagree about "off") · `evidence.rs`: `local_consent_config_defaults_closed_and_requires_both_switches`, `disabled_policy_touches_no_transcript_path` · `transcript.rs`: `consent_requires_both_switches`, `consent_is_checked_before_any_filesystem_access` · `CuratorSettings.test.tsx` (15 assertions) |

---

## The PENDING list, in full

### PENDING-1 — the llama.cpp grammar corpus (item 7)

**What exists:** the served schema is byte-identical to `eval/curator/schema_sid.json`
(asserted in CI) and uses only the keyword subset llama.cpp converts reliably —
`type`, `properties`, `required`, `enum`, `items`, `minItems`/`maxItems`,
`maxLength`, and an anchored `pattern`.

**What is missing:** the spec asks for the *generated grammar* to pass the same
accepted/rejected fixture corpus as the schema object. Nothing in the repo runs
llama.cpp's `json-schema-to-grammar` over `schema_sid.json`, and no
accepted/rejected corpus is committed for either half. This matters because
llama.cpp silently skips keywords it does not support — a grammar can be
strictly weaker than the schema it came from, and the failure is invisible.

**Cost:** one script that emits the GBNF, one committed corpus of accepted and
rejected JSON strings, one test that runs both. Needs no model and no approval.

### PENDING-2 — the frozen manifest (item 21)

`eval/curator/MANIFEST-V1.json` exists but is not a valid pre-registration yet.
Six blocking gaps, verbatim from its `frozen_at_next_run`:

1. **No thresholds.** The spec requires pre-registered thresholds and supplies
   none — §19.1 names the six metrics, §20 demands every class meet "those
   pre-registered thresholds", and no number appears in either. Wave 4a will not
   invent an acceptance bar and present it as normative. A human sets these, per
   metric per class, before the run.
2. **No model digest.** No `run_meta.json` records one as a first-class field;
   the only digests recoverable are 12-hex short forms scraped from embedded
   `ollama ps` rows, and one results dir has none at all.
3. **No run provenance.** `run_meta.json` identifies prompt and schema by path
   string — no content hash, no git SHA, no scorer version.
4. **Four of six metrics do not exist.** `generator_candidate_recall`,
   `verifier_over_escalation_rate`, `defer_recovery_rate` and
   `defer_expiry_rate` appear nowhere outside the spec. The first two are
   `score.py` changes; the last two need a reader over the Rust ledger
   (`state.rs::CuratorLedger`) and cannot come from the Python harness at all.
5. **No gold dispositions.** Two of the six metrics are defined against a gold
   `ProposalReady`/`ReviewRequired` label that has never been annotated.
6. **No blind test set.** The 58-unit set is the dev set by its own README.

### PENDING-3 — the scored run (item 22)

**Approval-gated. Did not run in this wave** — Wave 4a is the no-model half and
touched no Ollama, no `~/.neurovault`, and no port 8765.

Blocked on all of PENDING-2. Once unblocked, the run must report per claim
class, and it must report the counterweight metrics beside the precision ones:
a verifier that rejects everything scores perfectly on precision, which is the
exact degeneration §19.1 calls out.

The evidence that exists today, as a starting point and not as a verdict — the
strongest measured arm is `qwen3-coder:30b` on the SID contract: recall 0.209,
verifier false-reject 0.286, source-role 0.984, abstention 0.40 (n=5),
pre-gate unsupported 0.20. Its quote-contract predecessor scored abstention
0.80, recall 0.170, false-reject 0.241, source-role 0.978.

### PENDING-4 — a mechanical guard for "no write path" (item 18)

Currently a code-review invariant with a doc comment behind it. The upgrade is
cheap: a test that asserts the curator module's source contains no call into
the ingest/remember write entry points, or a module-boundary lint that makes
the dependency impossible rather than merely absent. Worth doing precisely
because it is the one guarantee everything else rests on.

---

## The five corpus divergences

Found by running the committed red-team corpus against the shipped gauntlet for
the first time. **Neither side was edited.** Wave 4a's brief was to make the
corpus executable and report what it finds — not to move a gate so a fixture
goes green, and not to move a fixture so a gate does. Each is pinned in
`curator_redteam_e2e.rs::KNOWN_DIVERGENCES` with the observed behaviour asserted
exactly, so none can drift further unnoticed.

Every one is an **attribution** error, not a containment failure: all five
attacks are still refused or still routed to a human.
`no_divergence_is_less_strict_than_the_corpus_expects` proves that on the effect
lattice — a row may re-attribute a refusal, never soften one.

They matter because spec §19.1 requires every reject and every escalation to be
attributed to a `GateName` and a code, and four of the five would be attributed
to the wrong gate.

| # | Case | Corpus expected | Actually | Why |
|---|---|---|---|---|
| 1 | `f03/quote_splicing_adjacent` | G05 `RequireReview(Synthesis)` | G07 `RequireReview(ComplexSemantics)` | G05 designates a Primary by **protected-token** coverage. The only protected token in "Postgres is the primary store for the queue." is the name `Postgres`, which S2 carries alone; `queue` is a common noun and therefore not protected. So S2 reads as total coverage and G05 passes. The splice is caught one gate later, as the wrong code. |
| 2 | `f06/planned_to_completed` | G08 `Reject(SemanticStateMismatch)` | G04 `Reject(InvalidEvidence)` | G04's correlated-evidence check compares anchors by exact lowercased token, with no stemmer. The statement's only anchor is `migrated`; S1's are `migrate`/`tomorrow`/`morning`. The tense change that *is* the attack makes the evidence look unrelated, so it dies two gates early. |
| 3 | `f09/forwarded_speech` | G07 `RequireReview(AmbiguousAttribution)`, non-terminal | G07 flags it, then **G08 rejects** — terminal | The only divergence that moves the verdict, and it moves toward strictness. S2 reads `we use tabs, never spaces, in every repo`; the statement drops `never`, which the polarity marker list reads as a flip. Consequence: the corpus does not actually demonstrate a surviving `AmbiguousAttribution` review card, and this is a false reject in §19.1 terms. |
| 4 | `f15/prompt_injection_role_forged` | G04 `Reject(ProvenanceViolation)` | G04 `Reject(AttributionMismatch)` | Right gate, more specific code. G04 checks the claimed `source_role` against the cited sentences' real roles *before* consulting the class matrix, so the forgery is caught as a mismatch and the matrix never runs. The sibling case `prompt_injection_assistant_role`, which claims its role honestly, does reach the matrix and does produce `ProvenanceViolation`. |
| 5 | `f16/secrets_leak_in_statement` | G09 `Reject(SensitiveOutput)` | G07 `Reject(AttributionMismatch)` | **The one worth reading twice.** G07 rejects first: the statement reorders the anchors it shares with S7 (`sandbox` moves ahead of the passphrase), which the binding-order test reads as a moved binding. The secret never lands in a proposal, so there is no leak — but **this fixture does not exercise G09**, so the corpus does not prove the secret-screening path on its own. G09 is covered instead by `gates.rs::family_16_a_private_path_in_the_statement_dies_at_g09`. |

**Recommended disposition** (a Wave 5 decision, not mine): divergences 1, 4 and
5 look like the fixtures encoding a plausible-but-wrong expectation about which
gate fires first — the fix is probably to the fixtures, plus a *new* fixture for
divergence 5 whose statement preserves binding order so it actually reaches G09.
Divergence 2 is a real gap in G04 (no stemming), and its right fix is arguable
in both directions. Divergence 3 is a genuine false-reject and the only one that
should influence a threshold.

---

## Standing flags

Carried forward and true regardless of any test result. Each belongs beside any
number derived from the gold set.

- **Gold-negative n = 5.** Abstention correctness cannot support a confidence
  interval, and the harness correctly refuses to compute one. It is a
  directional smell test, not a measurement — and it is the *only* current
  evidence against the "fail closed becomes fail empty" degeneration that §20
  names explicitly. Five units is not enough to defend that claim.
- **58 paraphrase hints unmapped.** Only 162 / 230 gold items resolve to a
  sentence ID under `gold_sid/`; 205 / 230 with the prefix fallback in
  `gold_sid_prefix/`, leaving 25 still unresolved. Any SID-contract recall
  figure is capped there and must be printed with the cap. Three gold files
  additionally record items the labeler *deliberately omitted* because no term
  pair could be built that a correct paraphrase would reliably contain — so the
  gold set is knowingly under-complete for paraphrase-fragile claims. That is a
  ceiling in the labels; reporting it as a model failure would be wrong.
- **9 TOOL_RESULT gold items are unreachable under Parser V1.** PARSER_V1 emits
  records for `user` and `assistant` only, and skips tool records visibly
  (`transcript.rs::tool_records_are_skipped_visibly_and_counted`). Those nine
  items can never be proposed, and they are ungradable for `source_role` besides
  — the schema offers only two roles, so there is no correct answer to grade a
  tool-sourced claim against. They must be excluded from the recall denominator
  by name, not silently.
- **`SEG_H1 ≠ SEG_V1`.** The gold re-annotation ran under the Python harness
  segmenter (`regold_report.json: segmenter_harness_version 1`), which is a
  different implementation from the shipped Rust `SEG_V1`. Sentence IDs in
  `gold_sid/` are only comparable to a Rust run's IDs where the two segmenters
  agree, and **no fixture pins them together**. Until one does, treat any
  SID-level comparison across the two as unverified — this is the mapping rule
  the next wave owes the benchmark, and it is a precondition for reading
  `valid-sentence-ID and evidence-resolution rate` (§19.1) as a real number.

---

## What Wave 4a changed

- **Added** `src-tauri/tests/curator_redteam_e2e.rs` — 17 tests, every one of
  the 36 manifest lines driven, coverage invariant enforced.
- **Added** `eval/curator/MANIFEST-V1.json` + `MANIFEST-V1.md`.
- **Added** this file.
- **Extended** `PRIVACY.md` (a "Local memory curator (opt-in)" section, the
  background-work table, the on-disk file map) and
  `docs/HOW-NEUROVAULT-WORKS.md` §4.

No Wave 0–3 module was touched. No fixture was touched. No model was loaded, no
Ollama contacted, no `~/.neurovault` read or written, and port 8765 was never
opened.

`cargo test --no-default-features`: **all suites green**, 17/17 in the new
corpus binary. `cargo fmt` and `cargo clippy --no-default-features --tests`
clean on the added file.
