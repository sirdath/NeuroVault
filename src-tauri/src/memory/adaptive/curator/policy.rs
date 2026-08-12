//! Versioned verification policy data (guide §2/§3.3, slice B1).
//!
//! Will own: `POLICY_EPOCH`, the class-from-provenance matrix
//! (CLASS_POLICY_V1), the G07/G08 template registry, the alias table
//! (exact entries only — an alias is a review flag, never proof), the
//! deterministic protected-token extractor (`extract_protected`), and
//! the anchor-entity helpers G04 uses for correlated evidence.
//!
//! Data, not logic: every table here is versioned by `POLICY_EPOCH` and
//! covered by regression tests, so a policy edit is a visible,
//! replayable change rather than a silent behavioural drift.
//!
//! Wave 0 stub: declared in `mod.rs` up front so no later wave has to
//! edit that shared file. Filling this in is slice B1 (Wave 2A).
