//! Prompt template, output schema, token budget (guide §5, slice C2).
//!
//! Will own: `CURATOR_OUTPUT_SCHEMA` (= 2, the sentence-ID era), the
//! one-line system message, the three-example few-shot user template
//! whose `{{UNIT_TEXT}}` receives RENDER_V1 output, `OUTPUT_SCHEMA`
//! (byte-for-byte `eval/curator/schema_sid.json`, restricted to the
//! llama.cpp-grammar-solid subset), and the conservative client-side
//! token estimate.
//!
//! The eval harness holds the same prompt and schema as loose files
//! (`eval/curator/prompts/extract_sid.txt`, `eval/curator/schema_sid.json`)
//! so a benchmark result and a shipped run mean the same thing. Keep
//! them byte-identical; a test should assert it.
//!
//! Wave 0 stub: declared in `mod.rs` up front so no later wave has to
//! edit that shared file. Filling this in is slice C2 (Wave 2C).
