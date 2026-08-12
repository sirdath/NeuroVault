//! Nightly clock (guide §2.8, slice C5).
//!
//! Will own: the `consolidation_schedule.rs` pattern with curator
//! numbers — 24 h interval, 30 min poll, 180 s startup delay, per-brain
//! `curator_last_run.txt` stamp written atomically (corrupt stamp ⇒
//! fail toward running) — plus the four-part tick gate: consent,
//! provider preflight, debounce, and the toggle.
//!
//! Unlike `consolidation_auto`, this defaults **OFF**: a curator run
//! loads a 30B model, and fans/RAM/battery are the user's to spend.
//!
//! Wave 0 stub: declared in `mod.rs` up front so no later wave has to
//! edit that shared file. Filling this in is slice C5 (Wave 3A).
