//! Ollama client, preflight, canary, error taxonomy (guide §4, slice C1).
//!
//! Will own: `ProviderConfig` (the `provider` block of
//! `~/.neurovault/local_curator.json`), a hand-rolled typed `reqwest`
//! client against the **native** `/api/chat` (never `/openai/v1`),
//! `think:false` as a top-level field, JSON-schema-constrained decoding,
//! per-request timeouts, the 503/timeout/truncation/malformed error
//! taxonomy with its unit-vs-run dispositions, four-step preflight
//! (version floor, model present, `/api/show` capabilities + digest pin,
//! and a real canary request), and batch discipline: one request in
//! flight, `keep_alive` across the batch, verified unload via `/api/ps`.
//!
//! Never auto-pull a model. A missing model is a Settings prompt with a
//! size, not a surprise 18 GB download.
//!
//! Wave 0 stub: declared in `mod.rs` up front so no later wave has to
//! edit that shared file. Filling this in is slice C1 (Wave 2B).
