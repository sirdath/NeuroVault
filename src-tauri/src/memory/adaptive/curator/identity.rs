//! Stable keys and tombstones (guide §2.5, slice A5).
//!
//! Will own: `IDENTITY_VERSION`, `evidence_key` (span fingerprints, not
//! event ids, so identity survives a model upgrade), `claim_key`,
//! `proposal_id`, and the append-only tombstone store
//! (`brains/<id>/curator_tombstones.jsonl`, reduce-on-read like
//! `todos.jsonl`) that makes a user-rejected memory unresurrectable
//! from the same evidence.
//!
//! Byte-stability is the whole point: sorted/BTree inputs only, never a
//! `HashMap` iteration order, anywhere near a key.
//!
//! Wave 0 stub: declared in `mod.rs` up front so no later wave has to
//! edit that shared file. Filling this in is slice A5 (Wave 1B).
