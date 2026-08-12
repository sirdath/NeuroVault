//! Local memory curator.
//!
//! A local 30B-class model (the user's own Ollama) *proposes* durable
//! memories from a bounded slice of an agent session; a deterministic
//! Rust gauntlet *verifies* every candidate; survivors land in the
//! existing MemoryReview queue. Nothing auto-applies, and no generative
//! model ever runs in the read path.
//!
//! The evidence contract is **sentence IDs**: the server enumerates the
//! sentences of the sanitized transcript, the model points at IDs
//! (`["S12"]`), and the server materializes the cited text itself.
//! Model-authored quotes are a type error, not a validation failure.
//!
//! Module map (implementation guide §2). Every declaration is made HERE,
//! in Wave 0, so that parallel build waves never have to edit this
//! shared file. Modules that are still stubs say so in their own doc
//! comment; filling one in requires no change to this file.
//!
//! | module | owns |
//! |---|---|
//! | [`evidence`] | slice-1 capture: consent, hardened open, prefix hashing (SHIPPED) |
//! | [`transcript`] | versioned jsonl parser + pre-model redaction |
//! | [`segment`] | sentence enumeration, `RENDER_V1`, span resolution |
//! | [`receipts`] | `VerifiedSpan` / `SpanIdentity` / gate + generation receipts |
//! | [`identity`] | `evidence_key` / `claim_key` / `proposal_id`, tombstones |
//! | [`state`] | run ledger, watermark, retry, `CuratorRunAudit` |
//! | [`lineage`] | unit-eligibility ALLOWLIST (feedback-loop isolation) |
//! | [`policy`] | versioned data: class matrix, templates, aliases, token extractor |
//! | [`gates`] | G00–G12, the effect lattice, `VerificationContext` |
//! | [`provider`] | Ollama client, preflight, canary, error taxonomy |
//! | [`prompt`] | few-shot template, output schema, token budget |
//! | [`runner`] | run orchestration, envelope, `StoredProposal` converter |
//! | [`schedule`] | nightly clock (consolidation_schedule pattern) |
//!
//! The per-brain run lock is deliberately NOT here: deterministic
//! consolidation and the curator share one lock, so it lives a level up
//! in [`super::lock`].

pub mod evidence;
pub mod gates;
pub mod identity;
pub mod lineage;
pub mod policy;
pub mod prompt;
pub mod provider;
pub mod receipts;
pub mod runner;
pub mod schedule;
pub mod segment;
pub mod state;
pub mod transcript;
