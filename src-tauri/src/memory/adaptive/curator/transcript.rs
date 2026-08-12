//! Versioned transcript parser + pre-model redaction (guide §2.2, slice A2).
//!
//! Will own: `VerifiedPrefix` and `reopen_verified` (read-time rebind
//! through the slice-1 hardened open path, re-hashing exactly
//! `observed_prefix_len` bytes), `ParsedRecord` / `ParseOutcome`,
//! `SourceRole`, `PARSER_VERSION`, `REDACTION_POLICY_VERSION`, and the
//! deterministic redaction pass that runs before any model sees a byte.
//!
//! Wave 0 stub: declared in `mod.rs` up front so no later wave has to
//! edit that shared file. Filling this in is slice A2 (Wave 1A).
