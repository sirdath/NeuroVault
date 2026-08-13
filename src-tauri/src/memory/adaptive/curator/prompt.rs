//! Prompt template, output schema, token budget (guide §5, slice C2).
//!
//! Owns the entire model-facing text surface: [`CURATOR_OUTPUT_SCHEMA`]
//! (= 2, the sentence-ID era), the one-line [`SYSTEM_MESSAGE`], the
//! three-example few-shot [`USER_TEMPLATE`] whose `{{UNIT_TEXT}}`
//! receives RENDER_V1 output, [`OUTPUT_SCHEMA`] (byte-for-byte
//! `eval/curator/schema_sid.json`, restricted to the
//! llama.cpp-grammar-solid subset), and the conservative client-side
//! token estimate the provider's budget guard calls.
//!
//! The eval harness holds the same prompt and the same schema as loose
//! files (`eval/curator/prompts/extract_sid.txt`,
//! `eval/curator/schema_sid.json`) so that a benchmark number and a
//! shipped run mean the same thing. They are byte-identical, and two
//! tests here assert it against the files on disk — the product can
//! never ship a prompt the benchmark did not measure.
//!
//! **The evidence contract is a type, not an instruction.** The model
//! selects request-local sentence IDs; it never serializes quote text,
//! byte offsets, or any other span coordinate (spec §7). Nothing in this
//! template asks for them, no property in the schema can carry them, and
//! `deny_unknown_fields` at G00 rejects an envelope that invents one.
//!
//! Why this exact few-shot set — every item is a measured requirement,
//! not a style preference:
//!
//! * **All three `type` branches are demonstrated.** In our own 58-unit
//!   benchmark a model never emitted an enum branch the examples did not
//!   show, so an undemonstrated branch is a dead branch.
//! * **The abstain branch is a full example, not a rule** — and the unit
//!   in it deliberately *looks* extractable (transient debugging state,
//!   speculation, options being weighed). Moving from the quote contract
//!   to the sentence-ID contract raised precision and recall but dropped
//!   abstention on gold negatives from 0.80 to 0.40: pointing is cheaper
//!   than quoting, so the model over-proposes. The `NOT DURABLE` rubric
//!   block and Example 2 are the counterweight, and the example carries
//!   its reason in its own header line rather than in prose after the
//!   JSON (nothing may ever follow the output object).
//! * **A near-miss negative lives inside a positive example** (S4/S5 of
//!   Example 3: a one-off instruction plus the work done to carry it
//!   out). Abstention is a per-sentence judgement, not a per-unit mood.
//! * Cardinality varies 2/0/1, `source_role:"assistant"` appears once,
//!   multi-ID adjacent evidence appears once with single-ID dominant,
//!   and cited sentences sit mid-transcript to defeat position
//!   anchoring.
//! * Three examples total — the ALCE-lineage sweet spot for a 30B at
//!   ~87 s/unit.
//!
//! The `{{UNIT_TEXT}}` block is filled from [`segment::render_unit`] and
//! from nothing else: a second renderer would be a second contract, and
//! format skew between the few-shots and the real unit costs small
//! models disproportionately.

use once_cell::sync::Lazy;
use serde_json::Value;

use super::segment::{self, SentenceTable};
use super::transcript::ParsedRecord;

/// Wire-schema generation: 1 = byte-pointer spans (retired), 2 =
/// sentence IDs. Stamped into every `GenerationReceipt`.
pub const CURATOR_OUTPUT_SCHEMA: u32 = 2;

/// Prompt-text generation. Bump on ANY change to [`SYSTEM_MESSAGE`] or
/// [`USER_TEMPLATE`]: a prompt edit invalidates the measurement behind
/// it, so the audit must be able to tell two runs apart.
pub const PROMPT_VERSION: u32 = 1;

/// The only token the render step substitutes. Identical in the shipped
/// template and in the harness's copy, which is what lets those two
/// files stay byte-identical.
pub const UNIT_PLACEHOLDER: &str = "{{UNIT_TEXT}}";

/// One line. The instruction block is the *user* message body, matching
/// the eval-harness layout exactly.
pub const SYSTEM_MESSAGE: &str = "You extract durable memories as JSON. You only point at sentence IDs; you never quote the transcript.";

/// The user message body. Byte-identical to
/// `eval/curator/prompts/extract_sid.txt` (asserted by a test).
pub const USER_TEMPLATE: &str = r#"Extract durable memories from the numbered transcript below. Output JSON only.

Every sentence in the transcript has an ID like S7 and a speaker tag. You never
copy transcript text. You point at sentence IDs. The system holds the transcript
and reads every sentence you point at itself.

DEFINITIONS
- fact       = something true about the user, project, or environment that a later,
               unrelated session needs. NOT: things true only right now.
- preference = how the user wants things done, stated or clearly implied by them.
               NOT: a one-off instruction for the current task.
- decision   = a choice that was made and will be built on. NOT: an option discussed.

NOT DURABLE — these produce no proposal, however concrete they sound:
- transient state: what is failing, running, installed, or open right now.
- speculation: "maybe", "might", "I think", "let's see" — a guess is not a fact.
- options being weighed: "we could X", "or Y instead" — until one is chosen.
- one-off instructions for the current task, and the work done to carry them out.
- greetings, small talk, questions, restatements, progress reports.
Extracting nothing is a correct answer, not a failure.

RULES
1. Durable = still matters in a LATER, unrelated session. Extract nothing else.
2. If you cannot name the later session that would need it, do not extract it.
3. evidence = 1 to 3 sentence IDs that prove the statement, exactly as printed
   (e.g. ["S12"] or ["S12","S13"]). Prefer ONE ID. Multiple IDs must be adjacent
   sentences. Every ID must appear in the transcript below. Never write the
   sentence text — only its ID.
4. statement = one standalone sentence. Every name, number, and version in it must
   appear in the sentences your evidence points at.
5. source_role = the speaker tag printed on the evidence sentence ("user" or
   "assistant"). If the IDs span both speakers, use the sentence that states the
   fact itself.
6. Max 5 proposals. When unsure, omit.
7. nothing_durable=true ONLY when proposals is empty. Any proposal => false.

EXAMPLE 1
TRANSCRIPT:
S1 [user]: Ship it after the migration.
S2 [user]: We're standardizing on PostgreSQL 16 for every new service.
S3 [assistant]: Understood. Want me to open the tickets?
S4 [user]: Yes.
S5 [user]: And always run migrations behind a feature flag, I don't want another Tuesday.
OUTPUT:
{"proposals":[{"type":"decision","statement":"New services standardize on PostgreSQL 16.","subject":"infrastructure","evidence":["S2"],"source_role":"user"},{"type":"preference","statement":"Migrations should always run behind a feature flag.","subject":"deployment","evidence":["S5"],"source_role":"user"}],"nothing_durable":false}

EXAMPLE 2 (every line looks extractable; none of it survives the test)
TRANSCRIPT:
S1 [user]: The auth suite is failing on my branch again.
S2 [user]: I'm on Node 22 locally — maybe that's the cause, I might drop to 20 to check.
S3 [assistant]: Could be. We could also pin the CI image, or move the runner to Node 20.
S4 [user]: Try the downgrade first and see if the suite goes green.
S5 [assistant]: Reinstalling now; the suite is running on Node 20.
OUTPUT:
{"proposals":[],"nothing_durable":true}

EXAMPLE 3
TRANSCRIPT:
S1 [user]: what timezone does the cron run in?
S2 [assistant]: The nightly sync runs at 02:00 UTC.
S3 [assistant]: That was set in March because the EU replica lags until 01:30.
S4 [user]: ok run it now for me
S5 [assistant]: Done, sync completed.
OUTPUT:
{"proposals":[{"type":"fact","statement":"The nightly sync runs at 02:00 UTC.","subject":"operations","evidence":["S2","S3"],"source_role":"assistant"}],"nothing_durable":false}

TRANSCRIPT:
{{UNIT_TEXT}}
OUTPUT:
"#;

/// The JSON schema served to Ollama as `format`, verbatim. Byte-identical
/// to `eval/curator/schema_sid.json` (asserted by a test).
///
/// Only the llama.cpp-grammar-solid keyword subset appears here — `type`,
/// `properties`, `required`, `enum`, `items`, `minItems`, `maxItems`, and
/// one anchored `pattern`. Everything else the converter skips *silently*,
/// so nothing else may be load-bearing: `maxLength` is decoration that
/// G00/G03 re-enforce server-side, and `additionalProperties` is absent
/// because `deny_unknown_fields` in Rust is the authority on extra keys.
pub const OUTPUT_SCHEMA_JSON: &str = r#"{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "CuratorProposalsSid",
  "type": "object",
  "properties": {
    "proposals": {
      "type": "array",
      "maxItems": 5,
      "items": {
        "type": "object",
        "properties": {
          "type": { "type": "string", "enum": ["fact", "preference", "decision"] },
          "statement": { "type": "string", "maxLength": 300 },
          "subject": { "type": "string", "maxLength": 40 },
          "evidence": {
            "type": "array",
            "minItems": 1,
            "maxItems": 3,
            "items": { "type": "string", "pattern": "^S[1-9][0-9]{0,3}$" }
          },
          "source_role": { "type": "string", "enum": ["user", "assistant"] }
        },
        "required": ["type", "statement", "subject", "evidence", "source_role"]
      }
    },
    "nothing_durable": { "type": "boolean" }
  },
  "required": ["proposals", "nothing_durable"]
}
"#;

/// The parsed schema, ready to hand the provider as the `format` field.
///
/// Parsed once from [`OUTPUT_SCHEMA_JSON`], so the served bytes and the
/// benchmarked file cannot drift apart through a hand-built `json!`
/// literal.
pub static OUTPUT_SCHEMA: Lazy<Value> = Lazy::new(|| {
    serde_json::from_str(OUTPUT_SCHEMA_JSON).expect("OUTPUT_SCHEMA_JSON is a compile-time literal")
});

/// Bytes per token in the client-side budget estimate.
///
/// English prose runs closer to 4 bytes/token, and the usual
/// back-of-envelope heuristic is `chars / 4`. We divide by 3 on purpose:
/// the estimate exists to keep Ollama from **silently front-truncating**
/// an over-long prompt (it does not error, and it eats the system
/// message first), grammar tokens never show up in `prompt_eval_count`,
/// and unit text is full of code, paths, and IDs that tokenize far worse
/// than prose. A pessimistic estimate costs at most a visibly skipped
/// unit; an optimistic one costs a silently mutilated prompt.
pub const BUDGET_BYTES_PER_TOKEN: u32 = 3;

/// Slack reserved on top of `num_predict`, for the chat template, the
/// grammar's invisible tokens, and estimator error.
pub const BUDGET_MARGIN_TOKENS: u32 = 512;

/// Conservative token estimate for one string: bytes / 3, rounded **up**.
///
/// Monotone in the input length by construction, and pessimistic against
/// any real BPE tokenizer on realistic transcript text.
pub fn estimate_tokens(text: &str) -> u32 {
    u32::try_from(text.len())
        .unwrap_or(u32::MAX)
        .div_ceil(BUDGET_BYTES_PER_TOKEN)
}

/// Estimated prompt tokens for one `/api/chat` request (system + user).
pub fn estimate_request_tokens(system: &str, user: &str) -> u32 {
    estimate_tokens(system).saturating_add(estimate_tokens(user))
}

/// The provider's budget guard: does this request leave room for the
/// answer inside `num_ctx`?
///
/// `false` means the unit is skipped **visibly** (`UnitOverBudget`) —
/// never retried, always audited. It is not an error condition; it is the
/// one case where sending the request would corrupt it.
pub fn fits_context_budget(system: &str, user: &str, num_predict: u32, num_ctx: u32) -> bool {
    estimate_request_tokens(system, user)
        .saturating_add(num_predict)
        .saturating_add(BUDGET_MARGIN_TOKENS)
        <= num_ctx
}

/// The user message for one unit: RENDER_V1 of the sentence table,
/// slotted into [`USER_TEMPLATE`].
///
/// The unit text comes from [`segment::render_unit`] and only from
/// there. This is the sole supported way to build a curator request.
pub fn render_user_message(records: &[ParsedRecord], table: &SentenceTable) -> String {
    fill_template(&segment::render_unit(records, table))
}

/// Slot already-rendered RENDER_V1 bytes into the template.
///
/// The caller must pass [`segment::render_unit`] output — it is public
/// only so a canary or a replay can reuse a stored rendering instead of
/// re-deriving one. [`segment::render_unit`] terminates every line,
/// including the last; the template supplies the newline before
/// `OUTPUT:`, so the trailing one is dropped here. That single byte is
/// what keeps the real unit shaped exactly like the few-shot
/// transcripts, with no blank line the examples never showed.
pub fn fill_template(unit_render: &str) -> String {
    let body = unit_render.strip_suffix('\n').unwrap_or(unit_render);
    USER_TEMPLATE.replace(UNIT_PLACEHOLDER, body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::adaptive::curator::transcript::parse_bytes;
    use regex::Regex;
    use std::collections::BTreeSet;
    use std::path::PathBuf;

    const ATLAS_JSONL: &str =
        include_str!("../../../../tests/fixtures/curator/unit_atlas_tuesday/transcript.jsonl");
    const ATLAS_RENDER: &str =
        include_str!("../../../../tests/fixtures/curator/unit_atlas_tuesday/expected_render.txt");

    /// Read a repo-root-relative file at test time. The eval harness is
    /// not part of the crate, so this is a deliberate on-disk read: the
    /// drift guard has to fail when the *file* changes, which an
    /// `include_str!` would silently absorb into the binary instead.
    fn repo_file(relative: &str) -> String {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(relative);
        std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("eval harness file {} unreadable: {e}", path.display()))
    }

    // ── few-shot parsing ────────────────────────────────────────────

    struct Example {
        header: String,
        transcript: String,
        output_raw: String,
        output: Value,
    }

    impl Example {
        /// `sid -> (role, text)` for this example's own transcript.
        fn sentences(&self) -> Vec<(u32, String, String)> {
            let line = Regex::new(r"^S(\d+) \[(user|assistant)\]: (.+)$").unwrap();
            self.transcript
                .lines()
                .map(|l| {
                    let caps = line
                        .captures(l)
                        .unwrap_or_else(|| panic!("not RENDER_V1 shaped: {l:?}"));
                    (
                        caps[1].parse().unwrap(),
                        caps[2].to_string(),
                        caps[3].to_string(),
                    )
                })
                .collect()
        }
    }

    /// Split the template into its few-shot examples. The trailing live
    /// `TRANSCRIPT:` block carries no `EXAMPLE` header, so it is excluded.
    fn few_shot_examples() -> Vec<Example> {
        let examples: Vec<Example> = USER_TEMPLATE
            .split("\nEXAMPLE ")
            .skip(1)
            .map(|chunk| {
                let (header, rest) = chunk.split_once('\n').expect("header line");
                let rest = rest
                    .strip_prefix("TRANSCRIPT:\n")
                    .expect("TRANSCRIPT: block");
                let (transcript, rest) = rest.split_once("OUTPUT:\n").expect("OUTPUT: marker");
                let output_raw = rest.lines().next().expect("output line").to_string();
                Example {
                    header: header.to_string(),
                    transcript: transcript.to_string(),
                    output: serde_json::from_str(&output_raw)
                        .unwrap_or_else(|e| panic!("example output is not JSON: {e}")),
                    output_raw,
                }
            })
            .collect();
        assert_eq!(examples.len(), 3, "the ALCE-lineage sweet spot is 3");
        examples
    }

    // ── a validator driven BY the schema, not by a second copy of it ──

    fn required_of(schema: &Value) -> Vec<&str> {
        schema["required"]
            .as_array()
            .expect("required list")
            .iter()
            .map(|v| v.as_str().expect("required entry is a string"))
            .collect()
    }

    fn enum_of<'a>(schema: &'a Value, property: &str) -> Vec<&'a str> {
        schema["properties"][property]["enum"]
            .as_array()
            .unwrap_or_else(|| panic!("{property} has no enum"))
            .iter()
            .map(|v| v.as_str().expect("enum entry is a string"))
            .collect()
    }

    /// Validate a model output against [`OUTPUT_SCHEMA`] itself, reading
    /// the enums, cardinalities, and the evidence pattern out of the
    /// schema value rather than restating them.
    fn validate_output(value: &Value) -> Result<(), String> {
        let schema = &*OUTPUT_SCHEMA;
        let object = value.as_object().ok_or("output is not an object")?;
        let properties = schema["properties"]
            .as_object()
            .ok_or("schema has no properties")?;
        for key in required_of(schema) {
            if !object.contains_key(key) {
                return Err(format!("missing required key {key}"));
            }
        }
        for key in object.keys() {
            if !properties.contains_key(key) {
                return Err(format!("unknown key {key}"));
            }
        }
        if !object["nothing_durable"].is_boolean() {
            return Err("nothing_durable is not a boolean".into());
        }
        let proposals = object["proposals"]
            .as_array()
            .ok_or("proposals is not an array")?;
        let max_proposals = schema["properties"]["proposals"]["maxItems"]
            .as_u64()
            .ok_or("proposals has no maxItems")? as usize;
        if proposals.len() > max_proposals {
            return Err(format!("{} proposals > {max_proposals}", proposals.len()));
        }
        // G00's coherence rule: the abstain flag is authoritative only
        // when the list is empty.
        if object["nothing_durable"] == Value::Bool(true) && !proposals.is_empty() {
            return Err("nothing_durable:true with a non-empty list".into());
        }

        let item = &schema["properties"]["proposals"]["items"];
        let item_properties = item["properties"]
            .as_object()
            .ok_or("proposal schema has no properties")?;
        let evidence = &item["properties"]["evidence"];
        let min_ids = evidence["minItems"].as_u64().ok_or("evidence minItems")? as usize;
        let max_ids = evidence["maxItems"].as_u64().ok_or("evidence maxItems")? as usize;
        let sid_pattern = Regex::new(
            evidence["items"]["pattern"]
                .as_str()
                .ok_or("evidence pattern")?,
        )
        .map_err(|e| e.to_string())?;

        for proposal in proposals {
            let fields = proposal.as_object().ok_or("proposal is not an object")?;
            for key in required_of(item) {
                if !fields.contains_key(key) {
                    return Err(format!("proposal missing {key}"));
                }
            }
            for key in fields.keys() {
                if !item_properties.contains_key(key) {
                    return Err(format!("proposal has unknown key {key}"));
                }
            }
            for property in ["type", "source_role"] {
                let got = fields[property]
                    .as_str()
                    .ok_or_else(|| format!("{property} is not a string"))?;
                if !enum_of(item, property).contains(&got) {
                    return Err(format!("{property}={got} is outside the enum"));
                }
            }
            for property in ["statement", "subject"] {
                let got = fields[property]
                    .as_str()
                    .ok_or_else(|| format!("{property} is not a string"))?;
                let cap = item["properties"][property]["maxLength"]
                    .as_u64()
                    .ok_or_else(|| format!("{property} has no maxLength"))?
                    as usize;
                if got.len() > cap {
                    return Err(format!("{property} is {} > {cap} bytes", got.len()));
                }
            }
            let ids = fields["evidence"]
                .as_array()
                .ok_or("evidence is not an array")?;
            if ids.len() < min_ids || ids.len() > max_ids {
                return Err(format!(
                    "{} evidence IDs outside [{min_ids},{max_ids}]",
                    ids.len()
                ));
            }
            for id in ids {
                let id = id.as_str().ok_or("evidence ID is not a string")?;
                if !sid_pattern.is_match(id) {
                    return Err(format!("evidence ID {id} fails the anchored pattern"));
                }
            }
        }
        Ok(())
    }

    // ── drift guards: the harness measured exactly what we ship ──────

    #[test]
    fn schema_matches_the_eval_harness_byte_for_byte() {
        assert_eq!(
            OUTPUT_SCHEMA_JSON,
            repo_file("eval/curator/schema_sid.json"),
            "prompt.rs and eval/curator/schema_sid.json have drifted"
        );
    }

    #[test]
    fn template_matches_the_eval_harness_byte_for_byte() {
        assert_eq!(
            USER_TEMPLATE,
            repo_file("eval/curator/prompts/extract_sid.txt"),
            "prompt.rs and eval/curator/prompts/extract_sid.txt have drifted"
        );
    }

    // ── the schema ──────────────────────────────────────────────────

    #[test]
    fn schema_uses_only_the_grammar_solid_keyword_subset() {
        // Anything outside this set is skipped SILENTLY by llama.cpp's
        // converter, so a load-bearing keyword outside it is a bug that
        // shows up as a wrong-shaped generation, never as an error.
        const SOLID: &[&str] = &[
            "type",
            "properties",
            "required",
            "enum",
            "items",
            "minItems",
            "maxItems",
            "pattern",
        ];
        // Decoration we tolerate: re-enforced server-side by G00/G03.
        const DECORATION: &[&str] = &["$schema", "title", "maxLength"];

        fn walk(value: &Value, solid: &[&str], decoration: &[&str], seen: &mut BTreeSet<String>) {
            let Some(object) = value.as_object() else {
                return;
            };
            for (key, child) in object {
                // Inside `properties`, keys are field names, not keywords.
                seen.insert(key.clone());
                if key == "properties" {
                    for grandchild in child.as_object().into_iter().flatten().map(|(_, v)| v) {
                        walk(grandchild, solid, decoration, seen);
                    }
                    continue;
                }
                if key == "items" {
                    walk(child, solid, decoration, seen);
                }
            }
            let keywords: Vec<&String> = object
                .keys()
                .filter(|k| !solid.contains(&k.as_str()) && !decoration.contains(&k.as_str()))
                .collect();
            assert!(
                keywords.is_empty(),
                "non-grammar-solid keywords in the schema: {keywords:?}"
            );
        }

        // Field names live under `properties`; keyword checking skips
        // them by construction above.
        let mut seen = BTreeSet::new();
        walk(&OUTPUT_SCHEMA, SOLID, DECORATION, &mut seen);
        assert!(seen.contains("pattern"), "the sid pattern must survive");
        // `additionalProperties` is outside the subset: its absence is
        // intentional, and Rust's deny_unknown_fields is the authority.
        assert!(!OUTPUT_SCHEMA_JSON.contains("additionalProperties"));
        assert_eq!(CURATOR_OUTPUT_SCHEMA, 2);
    }

    #[test]
    fn schema_forbids_every_field_the_model_must_not_emit() {
        // spec §7: no quote text, no hashes, no byte offsets, no span
        // coordinates, no authority IDs, no provenance, no confidence.
        const FORBIDDEN: &[&str] = &[
            "quote",
            "text",
            "anchor",
            "span",
            "start",
            "end",
            "byte",
            "offset",
            "range",
            "sha",
            "hash",
            "confidence",
            "band",
            "brain",
            "proposal_id",
            "session",
            "path",
            "actor",
            "timestamp",
        ];
        let names: Vec<&str> = OUTPUT_SCHEMA["properties"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .chain(
                OUTPUT_SCHEMA["properties"]["proposals"]["items"]["properties"]
                    .as_object()
                    .unwrap()
                    .keys()
                    .map(String::as_str),
            )
            .collect();
        for name in &names {
            for bad in FORBIDDEN {
                assert!(
                    !name.contains(bad),
                    "schema property {name} carries forbidden concept {bad}"
                );
            }
        }
        // The closed field set, order-independent (serde_json's map is
        // sorted; the wire order is the file's).
        let names: BTreeSet<&str> = names.into_iter().collect();
        assert_eq!(
            names,
            BTreeSet::from([
                "proposals",
                "nothing_durable",
                "type",
                "statement",
                "subject",
                "evidence",
                "source_role",
            ])
        );
    }

    #[test]
    fn sid_pattern_is_anchored_and_range_bounded() {
        let pattern = OUTPUT_SCHEMA["properties"]["proposals"]["items"]["properties"]["evidence"]
            ["items"]["pattern"]
            .as_str()
            .unwrap();
        assert_eq!(pattern, "^S[1-9][0-9]{0,3}$");
        let sid = Regex::new(pattern).unwrap();
        for good in ["S1", "S9", "S12", "S150", "S9999"] {
            assert!(sid.is_match(good), "{good} should match");
        }
        // S0 has no sentence; bare numbers would collide with content
        // numerals; trailing junk is how a "quote" would sneak in.
        for bad in ["S0", "S01", "12", "S12345", "S12 ", " S12", "S12:hello", ""] {
            assert!(!sid.is_match(bad), "{bad} should not match");
        }
    }

    // ── the few-shots ───────────────────────────────────────────────

    #[test]
    fn every_enum_branch_is_demonstrated() {
        // Measured: a model never emits a branch the few-shots did not
        // show. An undemonstrated enum value is a dead enum value.
        let item = &OUTPUT_SCHEMA["properties"]["proposals"]["items"];
        let mut shown: BTreeSet<String> = BTreeSet::new();
        let mut abstained = false;
        for example in few_shot_examples() {
            let proposals = example.output["proposals"].as_array().unwrap();
            abstained |= proposals.is_empty() && example.output["nothing_durable"] == true;
            for proposal in proposals {
                shown.insert(proposal["type"].as_str().unwrap().to_string());
                shown.insert(proposal["source_role"].as_str().unwrap().to_string());
            }
        }
        for property in ["type", "source_role"] {
            for value in enum_of(item, property) {
                assert!(
                    shown.contains(value),
                    "{property} branch {value} is never shown"
                );
            }
        }
        assert!(abstained, "the abstain branch must be a full example");
    }

    #[test]
    fn every_few_shot_output_validates_against_the_output_schema() {
        for example in few_shot_examples() {
            validate_output(&example.output)
                .unwrap_or_else(|e| panic!("EXAMPLE {}: {e}", example.header));
            // The examples are stricter than G00: the flag and the list
            // agree in both directions, so neither is ever modelled as
            // optional decoration.
            let empty = example.output["proposals"].as_array().unwrap().is_empty();
            assert_eq!(
                example.output["nothing_durable"],
                Value::Bool(empty),
                "EXAMPLE {} desynchronizes the abstain flag",
                example.header
            );
            // One line, no prose, no trailing commentary.
            assert!(!example.output_raw.contains('\n'));
        }
    }

    #[test]
    fn abstention_example_is_a_unit_that_looks_extractable() {
        let examples = few_shot_examples();
        let abstain: Vec<&Example> = examples
            .iter()
            .filter(|e| e.output["nothing_durable"] == true)
            .collect();
        assert_eq!(abstain.len(), 1, "exactly one abstention example");
        let example = abstain[0];
        validate_output(&example.output).unwrap();
        assert!(example.output["proposals"].as_array().unwrap().is_empty());

        // The whole point of the strengthened example: the transcript
        // must be TEMPTING, not obviously empty. It carries a version
        // number, a preference-shaped imperative and a decision-shaped
        // verb, and every one of them is transient, speculative, or an
        // option still being weighed.
        let sentences = example.sentences();
        assert!(
            sentences.len() >= 5,
            "a one-line greeting is not a hard negative"
        );
        let body: String = sentences
            .iter()
            .map(|(_, _, text)| text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(
            body.contains("Node 22") && body.contains("Node 20"),
            "the hard negative needs a concrete, citable-looking literal"
        );
        for tempting in ["maybe", "might", "We could", "or move"] {
            assert!(
                body.contains(tempting),
                "the hard negative must contain the marker {tempting:?}"
            );
        }
        // Reason visible in the example itself — on the header line, so
        // it can never teach the model to emit prose after the JSON.
        assert!(
            example.header.contains("looks extractable"),
            "the abstention example must say why it abstains: {}",
            example.header
        );
        assert!(
            USER_TEMPLATE.contains("NOT DURABLE"),
            "the rubric block backing the abstention example is missing"
        );
        for rubric in [
            "transient state",
            "speculation",
            "options being weighed",
            "one-off instructions",
            "Extracting nothing is a correct answer",
        ] {
            assert!(
                USER_TEMPLATE.contains(rubric),
                "rubric line {rubric:?} missing"
            );
        }
    }

    #[test]
    fn a_near_miss_negative_lives_inside_a_positive_example() {
        // Abstention has to read as a per-sentence judgement, not a
        // per-unit mood: at least one example proposes something AND
        // leaves durable-looking sentences uncited.
        let mut found = false;
        for example in few_shot_examples() {
            let proposals = example.output["proposals"].as_array().unwrap();
            if proposals.is_empty() {
                continue;
            }
            let cited: BTreeSet<String> = proposals
                .iter()
                .flat_map(|p| p["evidence"].as_array().unwrap())
                .map(|v| v.as_str().unwrap().to_string())
                .collect();
            let uncited: Vec<u32> = example
                .sentences()
                .iter()
                .map(|(sid, _, _)| *sid)
                .filter(|sid| !cited.contains(&format!("S{sid}")))
                .collect();
            if uncited.len() >= 2 {
                found = true;
            }
        }
        assert!(found, "no near-miss negative inside a positive example");

        // The specific one from guide §5: the task chatter closing
        // Example 3 ("run it now" / "sync completed") stays uncited even
        // though the example does propose a memory.
        let example = few_shot_examples()
            .into_iter()
            .find(|e| e.transcript.contains("ok run it now for me"))
            .expect("the guide §5 near-miss negative is gone");
        assert!(example
            .transcript
            .contains("S5 [assistant]: Done, sync completed."));
        let cited: BTreeSet<String> = example.output["proposals"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|p| p["evidence"].as_array().unwrap())
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        assert!(
            !cited.is_empty(),
            "the near-miss must sit in a POSITIVE example"
        );
        assert!(!cited.contains("S4") && !cited.contains("S5"));
    }

    #[test]
    fn few_shot_evidence_is_present_adjacent_and_correctly_attributed() {
        for example in few_shot_examples() {
            let sentences = example.sentences();
            for proposal in example.output["proposals"].as_array().unwrap() {
                let ids: Vec<u32> = proposal["evidence"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_str().unwrap()[1..].parse().unwrap())
                    .collect();
                for id in &ids {
                    assert!(
                        sentences.iter().any(|(sid, _, _)| sid == id),
                        "S{id} is not in EXAMPLE {}'s transcript",
                        example.header
                    );
                }
                for pair in ids.windows(2) {
                    assert_eq!(pair[1], pair[0] + 1, "multi-ID evidence must be adjacent");
                }
                // source_role is a read-off of the printed speaker tag,
                // never an inference (measured 0.978 under this rule).
                let roles: BTreeSet<&str> = sentences
                    .iter()
                    .filter(|(sid, _, _)| ids.contains(sid))
                    .map(|(_, role, _)| role.as_str())
                    .collect();
                let claimed = proposal["source_role"].as_str().unwrap();
                assert!(
                    roles.contains(claimed),
                    "source_role {claimed} matches no cited speaker tag in EXAMPLE {}",
                    example.header
                );
            }
        }
    }

    #[test]
    fn few_shot_cardinality_and_position_vary() {
        let counts: Vec<usize> = few_shot_examples()
            .iter()
            .map(|e| e.output["proposals"].as_array().unwrap().len())
            .collect();
        assert_eq!(counts, vec![2, 0, 1], "cardinality must vary 2/0/1");
        // Single-ID dominant, multi-ID shown exactly once.
        let multi = few_shot_examples()
            .iter()
            .flat_map(|e| e.output["proposals"].as_array().unwrap().clone())
            .filter(|p| p["evidence"].as_array().unwrap().len() > 1)
            .count();
        assert_eq!(multi, 1, "adjacent multi-ID evidence shown exactly once");
        // No example cites S1 only: position anchoring on the first
        // sentence is a measured failure mode.
        for example in few_shot_examples() {
            for proposal in example.output["proposals"].as_array().unwrap() {
                let ids = proposal["evidence"].as_array().unwrap();
                assert!(
                    ids.iter().any(|v| v != "S1"),
                    "every cited window starts at S1 — position anchoring"
                );
            }
        }
    }

    #[test]
    fn the_template_never_asks_for_quotes_offsets_or_span_coordinates() {
        // spec §7 / guide §9.8. The contract is enforced by the type
        // system; the prompt must not reintroduce it as a request.
        const FORBIDDEN: &[&str] = &[
            "byte",
            "offset",
            "character",
            "position",
            "start_byte",
            "end_byte",
            "substring",
            "index",
            "verbatim",
            "word-for-word",
        ];
        let lowered = USER_TEMPLATE.to_lowercase();
        for bad in FORBIDDEN {
            assert!(
                !lowered.contains(bad),
                "the template mentions {bad:?} — the model must never emit coordinates"
            );
        }
        // "span" survives only as the English verb in rule 5 ("if the
        // IDs span both speakers"), never as a coordinate noun.
        assert_eq!(
            lowered.matches("span").count(),
            lowered.matches("span both speakers").count()
        );
        // "quote" may appear only as a prohibition, and only in the
        // system line.
        assert!(!lowered.contains("quote"));
        assert!(SYSTEM_MESSAGE.contains("never quote the transcript"));
        // The positive statement of the contract must survive edits.
        assert!(USER_TEMPLATE.contains("You never\ncopy transcript text."));
        assert!(USER_TEMPLATE.contains("Never write the\n   sentence text — only its ID."));
    }

    #[test]
    fn system_message_is_one_line_and_states_the_contract() {
        assert!(!SYSTEM_MESSAGE.contains('\n'));
        assert!(SYSTEM_MESSAGE.contains("JSON"));
        assert!(SYSTEM_MESSAGE.contains("sentence IDs"));
        assert_eq!(PROMPT_VERSION, 1);
    }

    // ── rendering ───────────────────────────────────────────────────

    #[test]
    fn worked_unit_renders_verbatim_into_the_template() {
        let outcome = parse_bytes(ATLAS_JSONL.as_bytes());
        let table = segment::enumerate(&outcome.records);
        let user = render_user_message(&outcome.records, &table);

        // Golden: guide §6.3's rendering, unmodified, in the live slot.
        assert!(
            user.ends_with(&format!("TRANSCRIPT:\n{ATLAS_RENDER}OUTPUT:\n")),
            "the §6.3 unit did not slot in verbatim:\n{user}"
        );
        for line in ATLAS_RENDER.lines() {
            assert!(user.contains(line), "missing rendered line: {line}");
        }
        // The instruction block above the slot is untouched.
        let (head, _) = USER_TEMPLATE.rsplit_once("TRANSCRIPT:\n").unwrap();
        assert!(user.starts_with(head));
        assert_eq!(user.matches(UNIT_PLACEHOLDER).count(), 0);
        assert_eq!(user.matches("\nTRANSCRIPT:\n").count(), 4);
    }

    #[test]
    fn the_live_unit_is_shaped_exactly_like_the_few_shot_transcripts() {
        // Format skew between the examples and the real unit costs small
        // models disproportionately: no blank line, no trailing newline
        // duplication, same `S{n} [{role}]: ` framing.
        let outcome = parse_bytes(ATLAS_JSONL.as_bytes());
        let table = segment::enumerate(&outcome.records);
        let user = render_user_message(&outcome.records, &table);
        assert!(!user.contains("\n\nOUTPUT:\n"), "blank line before OUTPUT:");
        assert!(user.ends_with("OUTPUT:\n"));
        let line = Regex::new(r"^S\d+ \[(user|assistant)\]: ").unwrap();
        let (_, live) = user.rsplit_once("TRANSCRIPT:\n").unwrap();
        for text in live.lines().filter(|l| *l != "OUTPUT:") {
            assert!(line.is_match(text), "live line off RENDER_V1: {text:?}");
        }
    }

    #[test]
    fn fill_template_drops_exactly_one_trailing_newline() {
        assert!(fill_template("S1 [user]: hi.\n").ends_with("S1 [user]: hi.\nOUTPUT:\n"));
        // Defensive: an already-trimmed rendering renders identically.
        assert_eq!(
            fill_template("S1 [user]: hi."),
            fill_template("S1 [user]: hi.\n")
        );
    }

    // ── the budget guard ────────────────────────────────────────────

    #[test]
    fn token_estimate_is_monotone() {
        let outcome = parse_bytes(ATLAS_JSONL.as_bytes());
        let table = segment::enumerate(&outcome.records);
        let user = render_user_message(&outcome.records, &table);
        let mut previous = 0;
        for (offset, _) in user.char_indices() {
            let estimate = estimate_tokens(&user[..offset]);
            assert!(estimate >= previous, "estimate dipped at byte {offset}");
            previous = estimate;
        }
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("abc"), 1);
        assert_eq!(estimate_tokens("abcd"), 2, "partial tokens round UP");
    }

    #[test]
    fn token_estimate_is_pessimistic_on_the_worked_unit() {
        let outcome = parse_bytes(ATLAS_JSONL.as_bytes());
        let table = segment::enumerate(&outcome.records);
        let user = render_user_message(&outcome.records, &table);
        let estimate = estimate_request_tokens(SYSTEM_MESSAGE, &user);
        let bytes = (SYSTEM_MESSAGE.len() + user.len()) as u32;
        // Strictly above the chars/4 rule of thumb …
        assert!(estimate > bytes / 4);
        // … and above one token per whitespace word, which no BPE
        // tokenizer beats on prose this punctuated.
        let words =
            (SYSTEM_MESSAGE.split_whitespace().count() + user.split_whitespace().count()) as u32;
        assert!(estimate > words, "{estimate} tokens for {words} words");
    }

    #[test]
    fn budget_guard_matches_the_provider_contract() {
        let outcome = parse_bytes(ATLAS_JSONL.as_bytes());
        let table = segment::enumerate(&outcome.records);
        let user = render_user_message(&outcome.records, &table);
        // The shipped default: 8192 ctx, 2048 predict.
        assert!(fits_context_budget(SYSTEM_MESSAGE, &user, 2048, 8192));
        // A 1K window cannot hold prompt + answer + margin.
        assert!(!fits_context_budget(SYSTEM_MESSAGE, &user, 2048, 1024));
        // Exactly at the boundary counts as fitting; one byte over does not.
        let estimate = estimate_request_tokens(SYSTEM_MESSAGE, &user);
        let exact = estimate + 2048 + BUDGET_MARGIN_TOKENS;
        assert!(fits_context_budget(SYSTEM_MESSAGE, &user, 2048, exact));
        assert!(!fits_context_budget(SYSTEM_MESSAGE, &user, 2048, exact - 1));
        // Saturating arithmetic: no overflow panic at the extremes.
        assert!(!fits_context_budget(
            SYSTEM_MESSAGE,
            &user,
            u32::MAX,
            u32::MAX - 1
        ));
    }
}
