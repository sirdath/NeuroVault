//! Sentence enumeration, `RENDER_V1`, span resolution (guide §2.3, slice A2/A3).
//!
//! Will own: `Sentence` / `SentenceTable`, `SEGMENTER_VERSION`, the
//! SEG_V1 algorithm (block pass → UAX#29 prose pass → trim/merge →
//! contiguous one-based IDs capped at 150 per unit), `render_unit`
//! (the exact bytes the model sees: `S{sid} [{role}]: {text}`), and
//! `resolve` — a table lookup plus a slice, never a text search.
//!
//! Wave 0 stub: declared in `mod.rs` up front so no later wave has to
//! edit that shared file. Filling this in is slice A2/A3 (Wave 1A).
