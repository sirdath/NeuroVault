//! Run orchestration (guide §3.5/§2.6, slice C2/C3).
//!
//! Will own: unit assembly under the lineage allowlist, prefix
//! re-verification, the impure materialization that feeds the pure
//! gauntlet, the envelope, G00 (envelope-level validation, including
//! the abstain-coherence rule), the `VerifiedDraft` → `StoredProposal`
//! converter, and the durable write ordering.
//!
//! Runs under [`crate::memory::adaptive::lock::try_with_brain_run_lock`]
//! — the same per-brain single-flight lock deterministic consolidation
//! takes, because both write the same proposal store.
//!
//! Wave 0 stub: declared in `mod.rs` up front so no later wave has to
//! edit that shared file. Filling this in is slice C2/C3 (Wave 3A).
