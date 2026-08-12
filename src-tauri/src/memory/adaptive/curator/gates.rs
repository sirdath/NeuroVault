//! The deterministic gauntlet, G00–G12 (guide §3, slice B1).
//!
//! Will own: `GateName`, the closed code enums (`RejectCode`,
//! `DeferCode`, `ReviewCode`, `NoOpCode`), `GateEffect` + the strict
//! monotonic lattice `aggregate`, `Disposition`, `Candidate`
//! (`deny_unknown_fields`), `VerificationContext`, `VerifiedDraft`, and
//! `verify_candidate`.
//!
//! `verify_candidate` is **pure**: no filesystem, no HTTP, no DB, no
//! model. Everything it needs — resolved sentences, policy tables,
//! existing state — is pre-materialized by the (impure) runner. That is
//! what makes "the server materializes the cited span" compatible with
//! a gate function that only ever looks things up.
//!
//! Wave 0 stub: declared in `mod.rs` up front so no later wave has to
//! edit that shared file. Filling this in is slice B1 (Wave 2A).
