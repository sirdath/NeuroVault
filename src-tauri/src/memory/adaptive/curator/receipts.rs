//! Receipts that attach to a proposal (guide §2.4/§3.4, slice A4).
//!
//! Will own: `VerifiedSpan`, `SpanIdentity`, `GateRecord`,
//! `GenerationReceipt`, `VerificationReceipt`, and `CuratorExtension` —
//! the single additive, optional field on `StoredProposal`.
//!
//! Rule inherited from `journal::EvidenceCaptureReceipt`: codes,
//! coordinates and hashes only. No paths, no transcript bytes, no
//! prompts, ever.
//!
//! Wave 0 stub: declared in `mod.rs` up front so no later wave has to
//! edit that shared file. Filling this in is slice A4 (Wave 1B).
