//! The nightly clock (guide §2.8, slice C5).
//!
//! `consolidation_schedule.rs`'s pattern with curator numbers: a 24 h
//! interval, a 30 min poll, a 180 s startup delay, and a per-brain
//! last-run stamp written atomically (a corrupt stamp fails *toward*
//! running). It adds no rules of its own — it decides *when*
//! [`runner::run_brain`] is called and nothing else.
//!
//! ## Why this defaults OFF
//!
//! Deterministic consolidation may default ON because a proposal run is
//! inert CPU. A curator run loads a 30B model: fans, RAM, battery. So
//! the gate is the user's own consent file, both switches, and there is
//! no second toggle to drift out of sync with it — [`is_enabled`] reads
//! the same [`evidence::consent`] the capture path and the read path
//! use. Until the user opts in, the only triggers are Settings and
//! `POST /api/curator/run`.
//!
//! ## The tick gate
//!
//! 1. **consent** — `local_curator.json`: `enabled && transcript_access`;
//! 2. **provider configured** — a `provider` block with a usable
//!    endpoint. Full preflight (version, digest, canary) belongs to the
//!    run itself, not to a poll that fires every 30 minutes;
//! 3. **debounce** — the per-brain stamp;
//! 4. **single-flight** — [`lock::is_run_in_flight`], the only "is this
//!    brain busy right now" signal the codebase exposes. There is no
//!    recall-burst counter to consult; if one is ever added, this is the
//!    function that should consult it.
//!
//! ## Quiet hours
//!
//! A *preferred* window, not a hard gate: a run that is merely due waits
//! for the window, and a run that is [`OVERDUE_FACTOR`]× overdue goes
//! ahead anyway, so a laptop that is only ever awake at noon still gets
//! curated. The window is expressed in **UTC** and read from
//! `NEUROVAULT_CURATOR_QUIET_HOURS` (`"22-06"`), defaulting to
//! unrestricted. It is deliberately not a local-clock window: this crate
//! builds `time` without the `local-offset` feature, so the process
//! cannot learn its own UTC offset, and a *guessed* local window would
//! be worse than an honest UTC one. When the Settings UI can send the
//! user's offset, that becomes the input to [`QuietHours::allows`]
//! without changing its logic.
//!
//! V1 runs the **active brain only** — the same limitation the
//! consolidation clock has (guide §2.8; multi-brain is §10 Q6).

use std::sync::atomic::{AtomicBool, Ordering};

use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use super::super::lock;
use super::runner::{self, CuratorRunReport, RunError};
use super::{evidence, provider};
use crate::memory::types::{MemoryError, Result};

/// Minimum gap between two automatic curator runs for one brain.
pub const RUN_INTERVAL_HOURS: i64 = 24;

/// How often the loop wakes to *ask* whether a run is due. Short
/// relative to the interval so a laptop that slept through its boundary
/// picks the run up at the next poll instead of drifting.
pub const CHECK_INTERVAL_SECS: u64 = 30 * 60;

/// Grace period before the first check after launch: longer than
/// consolidation's, because the curator's first act is to load a model
/// and startup already competes for IO.
pub const STARTUP_DELAY_SECS: u64 = 180;

/// How overdue a run must be before it ignores the quiet-hours
/// preference. Two missed nights is enough evidence that this machine is
/// never awake inside the window.
pub const OVERDUE_FACTOR: i64 = 2;

/// Env override for the preferred window, `"<start>-<end>"` in UTC hours.
pub const QUIET_HOURS_ENV: &str = "NEUROVAULT_CURATOR_QUIET_HOURS";

static STARTED: AtomicBool = AtomicBool::new(false);

// ---------------------------------------------------------------------
// quiet hours
// ---------------------------------------------------------------------

/// A preferred UTC window: inclusive of `start`, exclusive of `end`, and
/// allowed to wrap midnight (`22-06`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QuietHours {
    pub start: u8,
    pub end: u8,
}

impl QuietHours {
    /// Parse `"22-06"`. `None` for anything else — including an empty
    /// string — so a typo means "no preference" rather than a window
    /// nobody intended.
    pub fn parse(raw: &str) -> Option<Self> {
        let (start, end) = raw.trim().split_once('-')?;
        let start: u8 = start.trim().parse().ok()?;
        let end: u8 = end.trim().parse().ok()?;
        (start < 24 && end < 24 && start != end).then_some(Self { start, end })
    }

    /// The configured window, if any.
    pub fn from_env() -> Option<Self> {
        std::env::var(QUIET_HOURS_ENV)
            .ok()
            .as_deref()
            .and_then(Self::parse)
    }

    /// Is `hour` inside the window?
    pub fn contains(&self, hour: u8) -> bool {
        if self.start < self.end {
            hour >= self.start && hour < self.end
        } else {
            // wraps midnight
            hour >= self.start || hour < self.end
        }
    }

    /// The preference, applied. A run already `OVERDUE_FACTOR`× past its
    /// interval ignores the window: a preference must never become a way
    /// to never run.
    pub fn allows(&self, now: OffsetDateTime, last_run: Option<OffsetDateTime>) -> bool {
        if self.contains(now.hour()) {
            return true;
        }
        match last_run {
            None => false,
            Some(prev) => now - prev >= time::Duration::hours(RUN_INTERVAL_HOURS * OVERDUE_FACTOR),
        }
    }
}

// ---------------------------------------------------------------------
// debounce stamp
// ---------------------------------------------------------------------

/// `~/.neurovault/brains/<id>/curator_last_run.txt` — one RFC-3339 line,
/// next to the `curator_state.json` watermark it debounces.
pub fn last_run_path(brain_id: &str) -> std::path::PathBuf {
    crate::memory::paths::brain_dir(brain_id).join("curator_last_run.txt")
}

/// Last automatic run for this brain. An unreadable or unparseable stamp
/// reads as `None`, which makes a corrupt file fail *towards* running
/// rather than silently disabling the clock.
pub fn read_last_run(brain_id: &str) -> Option<OffsetDateTime> {
    let raw = std::fs::read_to_string(last_run_path(brain_id)).ok()?;
    OffsetDateTime::parse(raw.trim(), &Rfc3339).ok()
}

/// Stamp an attempt (atomic temp + rename). Recorded whether the run
/// succeeded or failed, so a brain that errors every time retries at the
/// normal cadence instead of hammering the poll interval.
pub fn record_run(brain_id: &str, now: OffsetDateTime) -> Result<()> {
    let path = last_run_path(brain_id);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| MemoryError::Other(format!("curator last-run dir: {e}")))?;
    }
    let tmp = path.with_extension("txt.tmp");
    std::fs::write(&tmp, now.format(&Rfc3339).unwrap_or_default())
        .map_err(|e| MemoryError::Other(format!("curator last-run write: {e}")))?;
    std::fs::rename(&tmp, &path)
        .map_err(|e| MemoryError::Other(format!("curator last-run rename: {e}")))?;
    Ok(())
}

/// The debounce decision, isolated from the timer so it is testable.
///
/// A stamp in the future (clock moved backwards, or a hand-edited file)
/// counts as due: the run rewrites the stamp with `now`, so the anomaly
/// self-corrects after exactly one run.
pub fn is_due(last_run: Option<OffsetDateTime>, now: OffsetDateTime) -> bool {
    match last_run {
        None => true,
        Some(prev) if prev > now => true,
        Some(prev) => now - prev >= time::Duration::hours(RUN_INTERVAL_HOURS),
    }
}

// ---------------------------------------------------------------------
// the gate
// ---------------------------------------------------------------------

/// Why a tick did or did not run. Every "no" is a named reason, so
/// Settings can say which switch is holding the clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TickDecision {
    Run,
    /// `local_curator.json` does not grant both switches.
    ConsentOff,
    /// No usable `provider` block (missing, no model, bad endpoint).
    ProviderNotConfigured,
    /// The last run is too recent.
    NotDue,
    /// Due, but outside the preferred window and not yet overdue enough.
    OutsideQuietHours,
    /// Another proposal run holds this brain right now.
    Busy,
}

/// Consent, decided by the one loader the whole curator uses.
pub fn is_enabled() -> bool {
    evidence::consent().both_switches()
}

/// Is a provider block present and minimally sane? Full preflight is the
/// run's job — a poll must not open a socket every 30 minutes.
pub fn provider_configured() -> bool {
    provider::LocalCuratorFile::load()
        .provider()
        .is_ok_and(|cfg| cfg.base_url().is_ok())
}

/// The full four-part gate for one tick.
pub fn tick_decision(brain_id: &str, now: OffsetDateTime) -> TickDecision {
    if !is_enabled() {
        return TickDecision::ConsentOff;
    }
    if !provider_configured() {
        return TickDecision::ProviderNotConfigured;
    }
    let last_run = read_last_run(brain_id);
    if !is_due(last_run, now) {
        return TickDecision::NotDue;
    }
    if let Some(window) = QuietHours::from_env() {
        if !window.allows(now, last_run) {
            return TickDecision::OutsideQuietHours;
        }
    }
    if lock::is_run_in_flight(brain_id) {
        return TickDecision::Busy;
    }
    TickDecision::Run
}

// ---------------------------------------------------------------------
// triggers
// ---------------------------------------------------------------------

/// The manual trigger behind `POST /api/curator/run`.
///
/// Deliberately skips the debounce and the quiet-hours preference — the
/// user asked — but not consent: a manual run with the switches off
/// still records the skip rather than reading a transcript. It stamps
/// the last-run file, so an explicit run also debounces tonight's
/// automatic one.
pub async fn run_now(
    brain_id: &str,
    run_id: &str,
) -> std::result::Result<CuratorRunReport, RunError> {
    let outcome = runner::run_brain_with_id(brain_id, run_id).await;
    // `Busy` means somebody else is running *now*, and that run will
    // write the stamp. Stamping here would debounce a run that this
    // process never performed.
    if !matches!(outcome, Err(RunError::Busy(_))) {
        let _ = record_run(brain_id, OffsetDateTime::now_utc());
    }
    outcome
}

/// [`run_now`] on a thread of its own, behind a `Send` future.
///
/// A run future is deliberately **not** `Send`: the provider's
/// `UnitRequest` carries the caller's token estimator as a `&dyn Fn`,
/// which is not `Sync`, which is exactly the "one request in flight per
/// run, on one thread" property the batch wants. Callers that need a
/// `Send` future anyway — `tokio::spawn` here, and axum's handlers —
/// go through this: one blocking thread, one current-thread runtime,
/// one run.
pub async fn run_now_detached(
    brain_id: &str,
    run_id: &str,
) -> std::result::Result<CuratorRunReport, RunError> {
    let brain = brain_id.to_string();
    let run_id = run_id.to_string();
    tokio::task::spawn_blocking(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| MemoryError::Other(format!("curator runtime: {e}")))?;
        rt.block_on(run_now(&brain, &run_id))
    })
    .await
    .map_err(|e| RunError::Memory(MemoryError::Other(format!("curator run panicked: {e}"))))?
}

/// A fresh run id, for a caller that wants to hand one out before the
/// run starts.
pub fn new_run_id() -> String {
    super::state::new_run_id()
}

/// One poll: gate, run, log. Every failure path is silent-safe — it logs
/// and returns so the next tick still happens.
async fn tick() {
    let Ok(brain) = crate::memory::read_ops::resolve_brain_id(None) else {
        return; // no active brain yet (fresh install) — nothing to do
    };
    if brain.is_empty() || tick_decision(&brain, OffsetDateTime::now_utc()) != TickDecision::Run {
        return;
    }
    match run_now_detached(&brain, &new_run_id()).await {
        Ok(report) => eprintln!(
            "[curator] auto run: brain={brain} status={:?} units={} proposals={}",
            report.status, report.units_processed, report.proposals_created
        ),
        Err(e) => eprintln!("[curator] auto run failed for {brain}: {e}"),
    }
}

/// Start the curator clock once per process. Returns immediately; the
/// work happens on a detached task, so this never blocks startup. Must
/// be called from inside a Tokio runtime.
pub fn start() {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    tokio::spawn(async move {
        tokio::time::sleep(tokio::time::Duration::from_secs(STARTUP_DELAY_SECS)).await;
        loop {
            tick().await;
            tokio::time::sleep(tokio::time::Duration::from_secs(CHECK_INTERVAL_SECS)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A private home under the shared lock. The env vars this touches
    /// are process-global, so every test that redirects one holds
    /// `TEST_HOME_LOCK` (bitten three times before).
    struct Env {
        home: std::path::PathBuf,
        prev_home: Option<std::ffi::OsString>,
        prev_quiet: Option<std::ffi::OsString>,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl Env {
        fn new(name: &str) -> Self {
            let guard = crate::memory::journal::TEST_HOME_LOCK
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            let home = std::env::temp_dir().join(format!(
                "nv-curator-sched-{name}-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&home).unwrap();
            let prev_home = std::env::var_os("NEUROVAULT_HOME");
            let prev_quiet = std::env::var_os(QUIET_HOURS_ENV);
            std::env::set_var("NEUROVAULT_HOME", &home);
            std::env::remove_var(QUIET_HOURS_ENV);
            Env {
                home,
                prev_home,
                prev_quiet,
                _guard: guard,
            }
        }

        fn config(&self, body: &str) {
            std::fs::write(self.home.join("local_curator.json"), body).unwrap();
        }
    }

    impl Drop for Env {
        fn drop(&mut self) {
            match &self.prev_home {
                Some(v) => std::env::set_var("NEUROVAULT_HOME", v),
                None => std::env::remove_var("NEUROVAULT_HOME"),
            }
            match &self.prev_quiet {
                Some(v) => std::env::set_var(QUIET_HOURS_ENV, v),
                None => std::env::remove_var(QUIET_HOURS_ENV),
            }
            let _ = std::fs::remove_dir_all(&self.home);
        }
    }

    const PROVIDER: &str = r#"{"enabled":true,"transcript_access":true,
        "provider":{"endpoint":"http://127.0.0.1:11434","model":"qwen3:30b"}}"#;

    #[test]
    fn interval_is_nightly_and_a_future_stamp_does_not_stall_the_clock() {
        let now = OffsetDateTime::now_utc();
        assert_eq!(RUN_INTERVAL_HOURS, 24);
        assert!(is_due(None, now));
        assert!(!is_due(Some(now - time::Duration::hours(6)), now));
        assert!(!is_due(
            Some(now - time::Duration::hours(RUN_INTERVAL_HOURS) + time::Duration::minutes(1)),
            now
        ));
        assert!(is_due(
            Some(now - time::Duration::hours(RUN_INTERVAL_HOURS)),
            now
        ));
        // Clock moved backwards: run once and self-correct.
        assert!(is_due(Some(now + time::Duration::hours(48)), now));
    }

    #[test]
    fn stamp_round_trips_and_a_corrupt_one_fails_toward_running() {
        let env = Env::new("stamp");
        let brain = "sched-brain";
        assert!(read_last_run(brain).is_none());

        let stamped = OffsetDateTime::now_utc();
        record_run(brain, stamped).unwrap();
        let back = read_last_run(brain).expect("round-trips");
        assert!((back - stamped).abs() < time::Duration::seconds(2));
        assert!(!is_due(read_last_run(brain), OffsetDateTime::now_utc()));

        std::fs::write(last_run_path(brain), "not-a-timestamp").unwrap();
        assert!(read_last_run(brain).is_none());
        assert!(is_due(read_last_run(brain), OffsetDateTime::now_utc()));
        drop(env);
    }

    #[test]
    fn quiet_hours_parse_and_wrap_midnight() {
        assert_eq!(
            QuietHours::parse("22-06"),
            Some(QuietHours { start: 22, end: 6 })
        );
        assert_eq!(
            QuietHours::parse("1-5"),
            Some(QuietHours { start: 1, end: 5 })
        );
        for bad in ["", "22", "22-24", "3-3", "x-y", "-", "22-06-01"] {
            assert!(QuietHours::parse(bad).is_none(), "{bad:?}");
        }
        let wrap = QuietHours { start: 22, end: 6 };
        assert!(wrap.contains(23) && wrap.contains(0) && wrap.contains(5));
        assert!(!wrap.contains(6) && !wrap.contains(12));
        let plain = QuietHours { start: 1, end: 5 };
        assert!(plain.contains(1) && plain.contains(4));
        assert!(!plain.contains(5) && !plain.contains(0));
    }

    #[test]
    fn quiet_hours_are_a_preference_an_overdue_run_ignores() {
        let window = QuietHours { start: 1, end: 5 };
        let inside = time::OffsetDateTime::from_unix_timestamp(1_786_000_000).unwrap();
        let noon = inside.replace_hour(12).unwrap();
        let small_hours = inside.replace_hour(2).unwrap();

        assert!(window.allows(small_hours, None), "inside the window");
        assert!(!window.allows(noon, Some(noon - time::Duration::hours(25))));
        // Two nights missed: the preference stops being a veto.
        assert!(window.allows(
            noon,
            Some(noon - time::Duration::hours(RUN_INTERVAL_HOURS * OVERDUE_FACTOR))
        ));
        // Never run, outside the window: wait for tonight.
        assert!(!window.allows(noon, None));
    }

    #[test]
    fn the_tick_gate_names_every_reason_it_declined() {
        let env = Env::new("gate");
        let brain = "sched-gate";
        let now = OffsetDateTime::now_utc();

        // No consent file at all: OFF by default, unlike consolidation.
        assert_eq!(tick_decision(brain, now), TickDecision::ConsentOff);
        // One switch is not consent.
        env.config(r#"{"enabled":true}"#);
        assert_eq!(tick_decision(brain, now), TickDecision::ConsentOff);
        // Both switches, no provider block.
        env.config(r#"{"enabled":true,"transcript_access":true}"#);
        assert_eq!(
            tick_decision(brain, now),
            TickDecision::ProviderNotConfigured
        );
        // A non-loopback endpoint is not a provider either.
        env.config(
            r#"{"enabled":true,"transcript_access":true,
                "provider":{"endpoint":"http://evil.example.com","model":"m"}}"#,
        );
        assert_eq!(
            tick_decision(brain, now),
            TickDecision::ProviderNotConfigured
        );
        // Fully configured and never run: go.
        env.config(PROVIDER);
        assert_eq!(tick_decision(brain, now), TickDecision::Run);
        // Debounced by a fresh stamp.
        record_run(brain, now).unwrap();
        assert_eq!(tick_decision(brain, now), TickDecision::NotDue);
        // Due again a day later, but outside a configured window.
        let tomorrow = now + time::Duration::hours(25);
        std::env::set_var(
            QUIET_HOURS_ENV,
            format!(
                "{}-{}",
                (tomorrow.hour() + 1) % 24,
                (tomorrow.hour() + 2) % 24
            ),
        );
        assert_eq!(
            tick_decision(brain, tomorrow),
            TickDecision::OutsideQuietHours
        );
        std::env::remove_var(QUIET_HOURS_ENV);
        assert_eq!(tick_decision(brain, tomorrow), TickDecision::Run);
        // Somebody else holds the brain right now.
        let held = crate::memory::adaptive::lock::try_acquire_brain_run(brain).unwrap();
        assert_eq!(tick_decision(brain, tomorrow), TickDecision::Busy);
        drop(held);
        assert_eq!(tick_decision(brain, tomorrow), TickDecision::Run);
        drop(env);
    }

    /// A manual run with consent off still runs (and records its skip);
    /// it must not silently do nothing, and it must stamp the clock.
    #[tokio::test]
    async fn manual_run_stamps_the_clock_even_when_consent_is_off() {
        let env = Env::new("manual");
        let brain = "sched-manual";
        env.config(r#"{"enabled":false,"transcript_access":false}"#);
        assert!(read_last_run(brain).is_none());

        let report = run_now(brain, &new_run_id()).await.expect("manual run");
        assert_eq!(report.status, super::runner::RunStatus::SkippedDisabled);
        assert!(
            read_last_run(brain).is_some(),
            "manual run debounces the clock"
        );
        drop(env);
    }

    /// Losing the lock leaves the debounce stamp alone: the run this
    /// process did not perform must not suppress tonight's.
    #[tokio::test]
    async fn a_busy_manual_run_does_not_stamp_the_clock() {
        let env = Env::new("manual-busy");
        let brain = "sched-busy";
        env.config(r#"{"enabled":false,"transcript_access":false}"#);
        let held = crate::memory::adaptive::lock::try_acquire_brain_run(brain).unwrap();
        assert!(matches!(
            run_now(brain, &new_run_id()).await,
            Err(super::runner::RunError::Busy(_))
        ));
        assert!(read_last_run(brain).is_none());
        drop(held);
        drop(env);
    }
}
