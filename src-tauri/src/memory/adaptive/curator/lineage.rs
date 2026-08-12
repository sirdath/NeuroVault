//! Unit-eligibility allowlist — feedback-loop isolation (guide §2.7, slice A7).
//!
//! Will own: `event_eligible` — an ALLOWLIST over (event_type,
//! capture_method) plus the privacy label, never a blacklist of bad
//! event names. Curator output, review decisions, consolidation output
//! and unknown emitters are ineligible *by construction*, so a future
//! event type cannot accidentally become curator input.
//!
//! Wave 0 stub: declared in `mod.rs` up front so no later wave has to
//! edit that shared file. Filling this in is slice A7 (Wave 1C); its
//! gate is red-team family #19 (curator output recycled as evidence
//! must yield zero units).
