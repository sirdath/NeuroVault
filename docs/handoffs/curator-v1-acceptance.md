# Local memory curator — the V1 acceptance walk

*Written 2026-08-13 by Wave 4a (proof & freeze, the no-model half) and brought
current through Wave 4b (the G09 fixture, the composite no-write-path proof,
the segmenter parity pin, the ledger metrics reader, the executable grammar
corpus) and Wave 4c (the spec owner's conformance rulings, applied).*

Spec §20 lists 24 conditions the curator must meet before it may enter a
developer-only build. This is every one of them, walked, with the evidence
named. There is no partial credit and nothing is rounded up: an item is
**PASSING** only if a test I can name asserts it, **DOC** if the guarantee is
structural and its statement is the artifact, and **PENDING** otherwise —
with the exact missing work spelled out.

**Score: 22 PASSING · 0 DOC · 2 PENDING.** Both remaining items are the same
blockage seen twice: no thresholds are pre-registered and the scoring run is
approval-gated. Nothing else on the list is waiting on work.

*(Bookkeeping, since a score nobody can re-derive is not a score: Wave 4a's
header read "19 PASSING · 1 DOC · 4 PENDING" over a table that actually held 20
PASSING · 1 DOC · 3 PENDING. The arithmetic was wrong, not the rows. Wave 4b
closed item 7 (grammar) and item 18 (write path), which is how 20 becomes 22.)*

Test paths: Rust unit tests live beside their module in
`src-tauri/src/memory/adaptive/curator/<module>.rs::tests`; the integration
suites are `src-tauri/tests/curator_redteam_e2e.rs` (the corpus),
`curator_no_write_path.rs`, `curator_seg_parity.rs`; TS tests are under `src/`.

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
| 7 | the exact served schema-v2 object **and its generated llama.cpp grammar** pass the same accepted/rejected fixture corpus using only the allowed schema subset | **PASSING** | Schema half: `prompt.rs`: `schema_matches_the_eval_harness_byte_for_byte`, `schema_uses_only_the_grammar_solid_keyword_subset`, `sid_pattern_is_anchored_and_range_bounded`. Grammar half (**new**, Wave 4b): `eval/curator/grammar_corpus/` — 24 committed cases run through **both** halves by `eval/curator/grammar_check.py`, which converts the served schema with llama.cpp's own vendored `json_schema_to_grammar.py` (`c5760701…bf3a`, hash-verified by `--verify-vendor`) and matches the real GBNF against a stdlib recognizer guarded by 11 micro-grammar self-tests. Every verdict is as recorded: 5 accepted by both, 13 rejected by both, 6 divergent-by-design. See CLOSED-1 for the two findings that matter |
| 8 | native Ollama preflight, qwen3-class top-level `think: false`, per-model canary, batch `keep_alive`, verified `/api/ps` unload pass integration tests | **PASSING** (against a mock, by design) | `provider.rs`: `preflight_succeeds_and_reports_what_actually_ran`, `preflight_warms_up_before_it_canaries`, `a_unit_request_carries_the_whole_native_contract`, `opting_out_of_think_control_omits_the_field_entirely`, `keep_alive_spans_the_batch`, `the_batch_ends_with_a_verified_unload`, `a_model_that_stays_resident_is_a_reported_fault`, plus five canary-failure tests · **new**: three `family_20_*` provider tests drive a real `ProviderSession` against an in-process axum Ollama. **Caveat, not a gap:** every one runs against a mock. CI must never need a 20 GB model. Real-hardware confirmation is Wave 3's manual dev run, recorded there. |
| 9 | every proposed field cites one to three adjacent, server-resolved sentence IDs | **PASSING** | `gates.rs`: `g00_bounds_counts_sizes_and_ids`, `g00_rejects_duplicate_and_over_cardinality_evidence`, `family_03_non_adjacent_splice_dies_at_g02`, `family_13_unknown_and_malformed_ids_die_at_g02` · `segment.rs::resolve_is_a_table_lookup_and_refuses_unknown_ids` · **new**: `wire_cases_reach_their_expected_terminal_gate` (25 corpus cases) |
| 10 | every extractive candidate has one complete-proposition Primary sentence, and every multi-source class matches its closed support-group contract | **PASSING**, with one flag | Primary designation: `gates.rs::family_03_adjacent_splice_is_synthesis_review`, `golden_p1_passes_twelve_gates_to_proposal_ready`, and — since Wave 4c reworded family 3's Primary sentence — the corpus line `f03/quote_splicing_adjacent`, which now genuinely exercises the union-coverage branch. Multi-source classes **do not exist in V1** — the contiguous-span rule collapses to one sentence (guide §9.6), so the support-group contract is vacuously met. **Flag, unchanged:** "complete proposition" is implemented as *protected-token* coverage, which is narrower than the phrase suggests, and a sentence-initial name is not a protected token at all (`policy.rs::extract_protected`) — that is a documented V1 limitation, not a bug, and it is why the old fixture proved nothing |
| 11 | invalid, cross-scope, changed, private, or secret evidence fails closed | **PASSING** | invalid: `gates.rs::family_13_unknown_and_malformed_ids_die_at_g02` · cross-scope: `family_11_a_cross_brain_object_dies_at_g01` + **new** `post_g00_cross_brain_object_dies_at_g01` · changed: `transcript.rs::mutated_truncated_and_missing_sources_never_read_newer_bytes` + **new** `family_14_mutated_prefix_defers_without_a_model_call` · private: `gates.rs::a_private_room_refuses_the_whole_unit` · secret: `family_16_a_redacted_sentence_is_readable_but_not_citable`, `family_16_a_private_path_in_the_statement_dies_at_g09`, and (**new**, Wave 4b) the corpus line `f16/secrets_kv_leak_reaches_g09` driven by `curator_redteam_e2e::family_16_a_key_value_secret_in_the_statement_reaches_g09` — G04, G05, G06 and G08 all asserted `Pass` so the reject is genuinely G09's, the receipt carries the class and not the value, and the transcript is asserted clean under G09's own screen so the hit can only have come from what the model *wrote*. The flag Wave 4a raised here is closed: G09 now has a corpus line, not just a unit test |
| 12 | different field values over identical evidence cannot collide | **PASSING** | `identity.rs`: `the_three_recipes_never_collide_on_identical_inputs`, `field_order_cannot_move_a_proposal_id`, `a_different_sentence_is_different_evidence`, `evidence_key_is_byte_stable`, `claim_key_is_byte_stable`, `proposal_id_is_byte_stable`, `canonical_span_encoding_is_frozen` |
| 13 | rejected evidence cannot be rephrased into repeated review spam | **PASSING**, with a known ceiling | `identity.rs`: `a_rejected_memory_cannot_come_back_reworded`, `a_verifier_rejection_does_not_tombstone` · `gates.rs::family_18_a_tombstoned_evidence_key_can_never_be_resurrected`. **Ceiling** (guide §10.8, accepted for V1): `claim_key` normalization is trim + whitespace-collapse only, so "Atlas deploys only on Tuesdays." and "Atlas deploys on Tuesdays only." mint different keys and G11 misses that near-duplicate. Worst case is a second review card, never a wrong memory. |
| 14 | a timed-out complete unit is retried after watermark advance | **PASSING** | `state.rs`: `deferral_is_retryable_and_exhaustion_is_visible_not_a_rejection`, `deferred_unit_is_not_due_until_its_backoff_elapses`, `oldest_unprocessed_extends_the_read_window`, `ttl_expiry_is_visible_never_a_silent_skip` · `runner.rs::provider_failure_defers_the_unit_without_advancing_past_it` · `provider.rs::a_hung_inference_hits_the_per_request_ceiling` · **new**: `family_20_server_busy_backs_off_then_defers`, `family_20_truncated_response_defers` |
| 15 | concurrent runs are serialized by a per-brain consolidation lock | **PASSING** | `adaptive/lock.rs`: `two_threads_one_winner`, `different_brains_never_block_each_other`, `a_panicking_run_still_releases_the_slot` · `runner.rs::a_second_caller_loses_the_lock_cleanly` · `schedule.rs::a_busy_manual_run_does_not_stamp_the_clock` |
| 16 | deterministic proposals remain byte-for-byte stable | **PASSING** | `identity.rs`: seven byte-stability tests plus `a_model_upgrade_does_not_duplicate_a_proposal` and `a_segmenter_upgrade_mints_new_identities_rather_than_colliding` · `gates.rs::verification_is_deterministic_and_side_effect_free` · `state.rs`: `replaying_the_same_journal_produces_zero_new_units`, `a_crash_before_the_audit_replays_the_unit_exactly_once` · `runner.rs::replay_and_crash_recovery_process_each_unit_exactly_once` · **new**: `family_20_crash_mid_run_replays_to_an_unchanged_store` |
| 17 | all curator proposals are quarantined, review-only, stored with application `NotApplicable` | **PASSING** | `runner.rs::worked_example_stores_p1_and_rejects_p2_at_g06` asserts `application_status == NotApplicable` on the stored record · `MemoryReview.curator.test.tsx` (12 assertions) covers the card surface · `inspectorCopy.curator.test.tsx` (7) covers the copy |
| 18 | no curator path calls an immediate-write fact endpoint | **PASSING** | **new**, Wave 4b: `curator_no_write_path.rs::curator_has_no_semantic_write_path` — one composite test with two halves, because either alone is weak. **Structural:** every `.rs` under `adaptive/curator/` is read, comments stripped, and any reference to a canonical-memory writer fails the test — this catches the dead `use` today that becomes a live call next quarter. **Runtime:** the real runner is driven end to end against a real brain (real vault, real SQLite, real `engrams`/`facts` rows) with a mock Ollama, then *every* proposal it produced is approved through the real HTTP handler, and the canonical-memory snapshot plus the whole `NEUROVAULT_HOME` tree are asserted byte-unchanged apart from named curator artifacts — this catches the write no source scan can see. The structural half proves the module cannot write; the runtime half proves that saying yes to everything moves nothing. |
| 19 | curator-derived journal events carry durable lineage and cannot feed later curator extraction | **PASSING** | `lineage.rs`: `family_19_curator_output_recycled_as_evidence_yields_zero_units`, `a_derived_from_curator_marker_beats_an_allowlisted_shape`, `an_unknown_future_emitter_fails_closed`, `consolidation_output_is_ineligible_by_lineage_not_by_name_list` (11 tests total) · `runner.rs::family_19_curator_output_never_becomes_a_unit` · **new**: `family_19_curator_output_never_forms_a_unit` asserts the manifest's per-event reason map, not just the unit count |
| 20 | all twenty red-team families have regression fixtures | **PASSING**, zero divergences | `curator_redteam_e2e::every_manifest_line_is_claimed` asserts families == 1..=20 and that each of the 37 manifest lines has a named driver — a new fixture fails the build until somebody claims it. All 37 execute and, since Wave 4c, **every one exact-matches** its `(gate, effect, code, disposition, terminal)` expectation. `KNOWN_DIVERGENCES` is an empty table and `no_divergence_is_less_strict_than_the_corpus_expects` passes vacuously; the mechanism is kept so the next disagreement has a home that is not "edit whichever side is easier". See "The five corpus divergences, resolved". |
| 21 | a committed benchmark manifest before the frozen corpus is scored | **PENDING** | `eval/curator/MANIFEST-V1.json` (now manifest_version 3) is committed and records corpus hash, gold hashes, prompt/schema fingerprints, verifier/policy versions, retry/TTL policy, claim classes and measured baselines. Its `manifest_status` still reads **PARTIAL** — the metric gap is down from four to two and both remaining ones are implemented in Rust, but the *thresholds* gap is untouched and it is the one §20 actually names — see PENDING-2 |
| 22 | every included claim class meets those pre-registered thresholds; "fail closed" must not degenerate into "fail empty" | **PENDING** | No thresholds exist to meet and the scoring run is approval-gated and has not happened. All six §19.1 metrics now have an implementation (`score.py` for four, `curator_metrics` for the ledger pair), but two of the four Python ones are proxies that no threshold may be frozen against, and the ledger pair has no matured deferral cohort to run over — see PENDING-3. A threshold proposal, written under the spec's ruling-6 framework, is parked at `docs/handoffs/curator-thresholds-proposal.md`; it is a proposal, not a pre-registration |
| 23 | model, prompt, schema, evidence, policy and NLI fingerprints appear in safe local receipts | **PASSING** | `receipts.rs`: `a_realistic_receipt_carries_no_path_prompt_or_transcript_text`, `extension_key_set_never_changes_silently`, `identity_changes_when_a_transform_version_changes`, `nli_record_round_trips_when_present`, `gate_records_reject_prose_paths_and_quotes` · `runner.rs::worked_example_stores_p1_and_rejects_p2_at_g06` asserts `generation.{model_id,model_digest,output_schema_version}` and `verification.policy_epoch` on the stored record. NLI's V1 fingerprint is its absence (`verification.nli.is_none()`), which is the honest value while no scorer ships. |
| 24 | a global curator kill switch is test-locked | **PASSING** | `runner.rs`: `consent_off_records_a_skip_and_reads_no_transcript` (asserts the model is never contacted), `consent_views_cannot_drift` (the two readers of `local_curator.json` can never disagree about "off") · `evidence.rs`: `local_consent_config_defaults_closed_and_requires_both_switches`, `disabled_policy_touches_no_transcript_path` · `transcript.rs`: `consent_requires_both_switches`, `consent_is_checked_before_any_filesystem_access` · `CuratorSettings.test.tsx` (15 assertions) |

---

## The PENDING list, in full

### CLOSED-1 — the llama.cpp grammar corpus (item 7) · *closed in Wave 4b*

24 committed cases in `eval/curator/grammar_corpus/`, every one run through the
schema **and** through the GBNF that llama.cpp's own converter generates from
the served schema. `grammar_check.py` exits 0 only when every verdict matches
the one the corpus recorded. The original worry — llama.cpp silently skipping
keywords, leaving a grammar strictly weaker than its schema — was measured
rather than assumed, and the answer is the opposite of the fear: **the grammar
is stricter than the schema**, in two ways worth carrying forward.

1. **Schema-alone would readmit the quote channel.** draft-07 defaults
   `additionalProperties` to `true` and the served schema deliberately omits
   it, so JSON Schema *accepts* a proposal carrying a `quote` field — the exact
   model-authored-quote fabrication channel the sentence-ID contract was
   designed to remove — and also accepts invented byte-offset fields and any
   unknown key. The generated grammar emits a closed object and refuses all
   three (`quote_field`, `byte_offset_fields`, `unknown_key`). The operative
   contract agrees with the grammar because Rust's `deny_unknown_fields` at G00
   is the authority, so nothing is exposed today — but the schema is *not* the
   contract, and anything that reads it as one (a second provider, a
   non-constrained decode path) reopens the channel.
2. **An incoherent abstention is catchable only by G00.** `nothing_durable:
   true` alongside a populated `proposals` array is a self-contradiction that
   no JSON Schema keyword and no GBNF production can express; both halves
   accept it, and only `gates.rs` G00's coherence check rejects it. Same for an
   empty `statement` (no `minLength` in either half; G00's `bounded_text`
   catches it). Two cases where a green corpus must never be read as "the
   schema is the contract".

*(A third finding, smaller: `maxLength` **is** honoured by the converter at
this commit — `statement` becomes `char{0,300}` and `subject` `char{0,40}` —
so it is enforced twice rather than being the decoration `prompt.rs` used to
call it. That stale comment is corrected in this wave.)*

**Still not proven:** that llama.cpp's own C++ GBNF engine agrees with the
stdlib recognizer this harness uses. Closing that needs a `llama-gbnf-validator`
binary the harness deliberately does not download.

### PENDING-2 — the frozen manifest (item 21)

`eval/curator/MANIFEST-V1.json` exists but is not a valid pre-registration yet.
Six blocking gaps, from its `frozen_at_next_run` (which also carries two
non-blocking ones: peak-RSS and the human-facing review metrics, neither
observable without a real run and a real human):

*One correction to read alongside the JSON: gap 4 there still says the ledger
metrics "have no implementation anywhere in the repo". That sentence predates
`src/bin/curator_metrics.rs` by one wave-half — it was written by the eval side
of Wave 4b before the Rust side landed the reader. The implementation exists;
what is missing is the run that feeds it. The JSON's revision log carries the
correction (manifest_version 3), and this list is the current reading.*

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
4. **~~Four of six metrics do not exist.~~ Two of six are not yet
   measurable.** *(Narrowed in Wave 4b, and the residue is not a Python
   problem.)* `generator_candidate_recall` and `verifier_over_escalation_rate`
   are now implemented in `score.py` (scorer v2), and the ledger pair —
   `defer_recovery_rate`, `defer_expiry_rate` — is implemented in the Rust
   reader `src-tauri/src/bin/curator_metrics.rs`, which is read-only by
   construction (opens no database, loads no model, creates no file) and emits
   one JSON object for `score.py` to merge. So all six exist as code. What is
   still missing for the pair is not an implementation, it is **inputs and
   plumbing**: no scoring run has ever merged the reader's output, and a
   defer-rate needs a deferral cohort matured under this manifest's exact
   retry/TTL clock, which no dev run has produced. Score them
   *implemented-but-unwired*, not done. `defer_expiry_rate` is the
   terminal-loss counterweight §19.1 names, which makes it the most
   consequential of the six, not the least.
5. **No gold dispositions.** Two of the six metrics are defined against a gold
   `ProposalReady`/`ReviewRequired` label that has never been annotated.
6. **No blind test set.** The 58-unit set is the dev set by its own README.

### PENDING-3 — the scored run (item 22)

**Approval-gated. Has not run.** Waves 4a–4c are the no-model half and touched
no Ollama, no `~/.neurovault`, and no port 8765.

Blocked on the threshold half of PENDING-2. Once unblocked, the run must report
per claim class, and it must report the counterweight metrics beside the
precision ones: a verifier that rejects everything scores perfectly on
precision, which is the exact degeneration §19.1 calls out.

Two things the next run inherits and must state, not discover:

- **The epoch moved.** Every measured number below was produced under
  `POLICY_EPOCH = 2026-08-vp1`. The shipped verifier is `vp2` /
  `VERIFIER_VERSION 2`, and the epoch is an input to `UnitKey` and to every
  `proposal_id` — so `vp1` and `vp2` results neither collide nor compare. A
  `vp2` re-run is a new baseline, not a continuation.
- **The verifier destroys real memories.** See the caveats below.

The evidence that exists today, as a starting point and not as a verdict — the
strongest measured arm is `qwen3-coder:30b` on the SID contract: generator
recall 0.291, post-gate recall 0.209, verifier false-reject 0.286, source-role
0.984, abstention 0.40 (n=5), pre-gate unsupported 0.20. Its quote-contract
predecessor scored abstention 0.80, recall 0.170, false-reject 0.241,
source-role 0.978.

### CLOSED-4 — a mechanical guard for "no write path" (item 18) · *closed in Wave 4b*

`curator_no_write_path.rs::curator_has_no_semantic_write_path` — the structural
scan **and** the end-to-end approve-everything run, in one test. See item 18.

---

## The five corpus divergences, resolved

Wave 4a ran the committed red-team corpus against the shipped gauntlet for the
first time, found five disagreements, and **edited neither side**: each was
pinned in `curator_redteam_e2e.rs::KNOWN_DIVERGENCES` with the observed
behaviour asserted exactly, so it could not drift further unnoticed. That was
the right call for a wave whose brief was to report, not to adjudicate. The
spec owner then ruled on all five and amended §10 G04 and §10 G08 accordingly
(spec commit `7cf7b0a`), and Wave 4c converged the implementation to the
committed spec text.

Two of the five were the gauntlet's fault; three were the corpus's. That split
is the interesting part: a fixture that encodes a plausible-but-wrong
expectation about which gate fires first is not evidence of a gate bug, and
three of these five were exactly that.

| # | Case | Wave 4a said | Ruling | Now |
|---|---|---|---|---|
| 1 | `f03/quote_splicing_adjacent` | corpus wanted G05 `Synthesis`; got G07 `ComplexSemantics` | **fixture.** The old S2 read "Postgres is still the primary store." — sentence-initial, and a sentence-initial capital is grammar, not a name, so the claim's only protected token was carried whole by one sentence and G05's union condition was vacuous | S2 reads "Our primary store is Postgres." and the claim needs `Postgres` (S2) **and** `June` (S3). Neither sentence covers both, the union does: G05 `RequireReview(Synthesis)`, for real this time |
| 2 | `f06/planned_to_completed` | corpus wanted G08 `SemanticStateMismatch`; got G04 `InvalidEvidence` | **gate.** Correlation anchors dropped tokens under three bytes, so a shared `DB` was invisible and the tense change that *is* the attack made the citation look unrelated | `policy::correlation_anchors` = anchor entities **+** exact ASCII all-uppercase acronym tokens, stopwords excluded, used on both sides of G04's test. The candidate now reaches G08 and dies there: `Reject(SemanticStateMismatch)` |
| 3 | `f09/forwarded_speech` | corpus wanted a surviving G07 `AmbiguousAttribution` review; G08 rejected it outright | **gate.** "Tabs are used *instead of* spaces" is a comparison. The polarity rule only asks whether a negation marker is present on each side, so the source's `never` against the statement's silence read as an inversion — a false reject in §19.1 terms | `COMPARISON_MARKERS` (`instead of`, `rather than`, `as opposed to`, `versus`) route to `RequireReview(ComplexSemantics)` **before** the one-sided-negation path. The card survives carrying both codes — G07 `AmbiguousAttribution` and G08 `ComplexSemantics` — asserted by `family_09_forwarded_speech_reaches_review_carrying_both_codes` |
| 4 | `f15/prompt_injection_role_forged` | corpus wanted `ProvenanceViolation`; got `AttributionMismatch` | **fixture.** The amended §10 G04 names `AttributionMismatch` for an asserted role absent from the server-derived role set, and reserves `ProvenanceViolation` for a role that *is* present but inadmissible for the class | Manifest expectation flipped. The sibling `prompt_injection_assistant_role`, which claims its role honestly, still reaches the matrix and is the `ProvenanceViolation` of the pair |
| 5 | `f16/secrets_leak_in_statement` | corpus wanted G09 `SensitiveOutput`; got G07 `AttributionMismatch` | **fixture, and worse than mis-attributed: unprovable.** Wave 4b built the replacement (`secrets_kv_leak_reaches_g09`, which actually reaches the gate and trips it) | The old line is **re-annotated** to what it really is — G07 `Reject(AttributionMismatch)` — with a note recording that it would also have *passed* G09: its credential is 26 chars, under the 32-char high-entropy floor, and `passphrase` is not a `key_value_secret` keyword. It never could have proved what its name claimed. Deviation flagged below |

**Deviation, flagged for the next review.** The ruling on divergence 5 was to
replace the fixture. Wave 4b already added the correct G09-reaching sibling, so
Wave 4c did **not** duplicate that candidate: it re-annotated the old line to
its true behaviour and recorded why, rather than deleting a line that still
exercises a real G07 binding-order path over secret-bearing text. The ruling's
intent — G09 coverage exists in the corpus — is satisfied by
`secrets_kv_leak_reaches_g09`. The deviation is the mechanism, not the outcome,
and it goes back to the spec owner.

`KNOWN_DIVERGENCES` is now an **empty table**, kept rather than deleted:
`no_divergence_is_less_strict_than_the_corpus_expects` still compiles and still
passes (vacuously), so the next disagreement between a fixture and a gate has a
home that is not "edit whichever side is easier".

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
- **`SEG_H1 ≠ SEG_V1`, and now we know exactly where.** The gold re-annotation
  ran under the Python harness segmenter (`regold_report.json:
  segmenter_harness_version 1`), a different implementation from the shipped
  Rust `SEG_V1`. Wave 4a could only say "no fixture pins them together"; Wave
  4b built one. `src-tauri/tests/curator_seg_parity.rs` runs both segmenters
  over one committed transcript and asserts that they see the *same sanitized
  bytes* (`both_segmenters_see_the_same_sanitized_bytes`), that the two tables
  **do not agree** (`the_two_tables_do_not_agree_and_the_gap_is_pinned`), and
  that the disagreements are exactly the enumerated set
  (`the_documented_divergences_are_exactly_these`) — with `SEG_V1`'s own table
  and render pinned besides. So the flag is unchanged in substance and no
  longer unbounded: a SID-level comparison across the two is still unverified
  in general, but the gap is now a committed, executable list rather than a
  suspicion, and a change to either segmenter fails a test instead of silently
  re-pointing the gold set. Reading `valid-sentence-ID and evidence-resolution
  rate` (§19.1) as a real number still needs the mapping rule.
- **The gauntlet destroys real memories — 19 of 67 on the strongest measured
  arm.** `qwen3-coder:30b` on the SID contract scored `generator_candidate_recall`
  0.2913 against `post_gate_recall` 0.2087. That difference is not noise and it
  is not the model: over 230 gold items it is 67 correct memories found by the
  generator and 48 surviving the verifier, i.e. **19 correct memories the gates
  killed**. Spec §20's "fail closed must not degenerate into fail empty" is
  exactly this arithmetic, and `generator_candidate_recall − post_gate_recall`
  is the number that measures it. Two caveats on the caveat: it is measured
  under `POLICY_EPOCH vp1`, before the two Wave 4c rulings (both of which
  *reduce* false rejection, so the figure is an upper bound on today's damage,
  unverified until a `vp2` run); and `verifier_false_reject_rate`'s own
  denominator is a proxy, which is why this subtraction — not that rate — is
  the honest headline.

---

## What each wave changed

### Wave 4a — make the corpus executable, report what it finds

- **Added** `src-tauri/tests/curator_redteam_e2e.rs` — 17 tests, every one of
  the 36 manifest lines driven, coverage invariant enforced.
- **Added** `eval/curator/MANIFEST-V1.json` + `MANIFEST-V1.md`.
- **Added** this file.
- **Extended** `PRIVACY.md` (a "Local memory curator (opt-in)" section, the
  background-work table, the on-disk file map) and
  `docs/HOW-NEUROVAULT-WORKS.md` §4.

No Wave 0–3 module was touched. No fixture was touched.

### Wave 4b — close the two closable acceptance items

- **Added** `curator_no_write_path.rs` (item 18), `curator_seg_parity.rs` + its
  fixtures (the `SEG_H1 ≠ SEG_V1` flag), `src/bin/curator_metrics.rs` (the
  ledger metric pair), the `f16` G09-reaching fixture, and
  `eval/curator/grammar_corpus/` + `grammar_check.py` + the vendored llama.cpp
  converter (item 7).
- **Implemented** `generator_candidate_recall` and
  `verifier_over_escalation_rate` in `score.py` (scorer v2); measured
  read-only, so no committed result file changed.

### Wave 4c — converge on the spec owner's rulings

- **Changed two gates**: G04 correlates on `policy::correlation_anchors`
  (acronyms included); G08 routes a comparison marker to review before the
  one-sided-negation path. Red-first, with positive, role-reversal and
  near-miss regression tests on both, as spec §10 requires of a policy-data
  change.
- **Bumped** `POLICY_EPOCH` to `2026-08-vp2` and `VERIFIER_VERSION` to `2` —
  one bump covering both rulings — and recorded it in `MANIFEST-V1.json`'s
  revision log (manifest_version 3).
- **Rewrote** the family-3 fixture so its Primary sentence carries a real
  protected token, and **re-annotated** three manifest expectations
  (families 15 and 16, plus notes on 3, 6 and 9).
- **Emptied** `KNOWN_DIVERGENCES` — the corpus and the gauntlet now agree on
  every line — while keeping the mechanism.
- **Corrected** the stale `maxLength`-is-decoration comment in `prompt.rs`.

No model was loaded, no Ollama contacted, no `~/.neurovault` read or written,
and port 8765 was never opened in any of the three.

`cargo test --no-default-features`: **all suites green** — 624 lib tests, 19/19
in the corpus binary, plus `curator_no_write_path`, `curator_seg_parity` and
the rest. `cargo fmt` and `cargo clippy --no-default-features --tests` clean.
