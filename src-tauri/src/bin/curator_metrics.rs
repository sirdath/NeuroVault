/* curator_metrics: the two spec §19.1 metrics that live in the Rust ledger.
 *
 * WHY THIS EXISTS
 * ---------------
 * MANIFEST-V1.json blocks the scoring run on six gaps. Gap 4 is "four
 * of the six metrics do not exist", and it splits in two:
 *
 *   generator_candidate_recall    } score.py changes — the Python
 *   verifier_over_escalation_rate }  harness has the data
 *
 *   defer_recovery_rate           } NOT measurable by the Python
 *   defer_expiry_rate             }  harness at all
 *
 * The second pair cannot come from `eval/curator` because defer and
 * retry are not harness concepts. A deferral is a *product* event: it
 * lives in `curator_state.json` (the ledger) and in the
 * `curator_runs-YYYY-MM.jsonl` audit segments, both written by
 * `state.rs`, neither of which the harness ever sees. MANIFEST-V1.md
 * says so in as many words: "needs a reader over the Rust curator
 * ledger (state.rs CuratorLedger) and cannot come from the Python
 * harness at all."
 *
 * This is that reader. It emits ONE JSON object on stdout, shaped so
 * `eval/curator/score.py` can merge it into a run report without
 * knowing anything about Rust.
 *
 * WHAT IT IS NOT
 * --------------
 * Read-only, and aggressively so. It opens no database, loads no model,
 * contacts no network, touches no port, and creates no file or
 * directory — including under the home it is pointed at. It reads two
 * kinds of file through `state.rs`'s own API and prints a summary. A
 * metrics tool that could perturb what it measures would be worse than
 * no metrics tool.
 *
 * It is also not a scorer. It computes no threshold and passes no
 * judgement: MANIFEST-V1's `pre_registered_thresholds` is still an open
 * blocking item and a human sets those numbers, per metric per class,
 * before the run.
 *
 * USAGE
 * -----
 *   curator_metrics --brain-home ~/.neurovault [--brain <id>]... [--pretty]
 *
 * `--brain-home` is a NEUROVAULT_HOME root (the directory containing
 * `brains/`), not a brain directory. With no `--brain`, every brain
 * under it is read and the top-level numbers are the pooled totals.
 */

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use neurovault_lib::memory::adaptive::curator::state::{
    CuratorLedger, CuratorUnitStatus, PendingCuratorUnit, UnitKey,
};

// =====================================================================
// the metric definitions, spec §19.1
// =====================================================================
//
// > defer_recovery_rate: deferred candidates that reach a non-deferred
// >   terminal outcome within the frozen retry/TTL policy, divided by
// >   all deferred candidates old enough to evaluate;
// > defer_expiry_rate: deferred candidates that reach ExpiredVisible
// >   without recovery, divided by all deferred candidates old enough
// >   to evaluate. Still-pending candidates are reported separately and
// >   excluded from both denominators until mature.
//
// Three decisions the spec leaves to the implementation, made here and
// stated in the output's `definitions` block so a reader never has to
// reverse-engineer them from this file:
//
// 1. WHAT COUNTS AS "DEFERRED". A unit is in the population iff it was
//    deferred at least ONCE, not iff it is deferred now. The ledger
//    signal is `attempts > 0` — `mark_deferred` is the only function
//    that increments it. The audit signal is any line for that unit key
//    whose `unit_status` is `deferred`. The union is used, so a ledger
//    lost to a crash still yields a population from the audit segments
//    and vice versa.
//
// 2. WHAT COUNTS AS "MATURE". A unit is mature once its status is
//    terminal. `Pending` and `Deferred` are retryable, so they are the
//    spec's "still-pending", reported as `immature` and excluded from
//    both denominators.
//
// 3. WHAT COUNTS AS "RECOVERY". `Completed` and `PermanentlyRejected`
//    both reach "a non-deferred terminal outcome", so both are
//    recoveries — a policy-terminal reject is a decision, not a loss,
//    and `state.rs` is explicit that retry exhaustion must never be
//    reclassified as a rejection. `SkippedDisabled` is neither: the
//    curator was switched off, which is a property of the kill switch
//    and not of the retry policy, so it is excluded from both
//    denominators and reported on its own line.
//
// Consequence worth stating plainly: recovery + expiry = 1.0 over the
// mature population, by construction. Within the frozen retry/TTL
// policy a matured deferred unit either came back or expired visibly.
// The two rates are one number reported from both ends because §19.1
// asks for the counterweight beside the headline — and `defer_expiry_rate`
// is named as one of the two metrics that keep "fail closed" from
// degenerating into "fail empty".

/// The bucket one ever-deferred unit lands in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Bucket {
    /// Reached `Completed` or `PermanentlyRejected`.
    Recovered,
    /// Reached `ExpiredVisible`.
    Expired,
    /// Still `Pending` or `Deferred` — the spec's "still-pending".
    Immature,
    /// `SkippedDisabled`: the kill switch, not the retry policy.
    SkippedDisabled,
}

impl Bucket {
    fn of(status: CuratorUnitStatus) -> Self {
        match status {
            CuratorUnitStatus::Completed | CuratorUnitStatus::PermanentlyRejected => {
                Bucket::Recovered
            }
            CuratorUnitStatus::ExpiredVisible => Bucket::Expired,
            CuratorUnitStatus::Pending | CuratorUnitStatus::Deferred => Bucket::Immature,
            CuratorUnitStatus::SkippedDisabled => Bucket::SkippedDisabled,
        }
    }
}

#[derive(Debug, Default, Clone)]
struct Counts {
    ever_deferred: usize,
    recovered: usize,
    expired: usize,
    immature: usize,
    skipped_disabled: usize,
    /// Currently `Deferred` — §19.1's "deferred backlog".
    backlog: usize,
    ledger_units: usize,
    audit_lines: usize,
    /// Ever-deferred units known only from an audit segment, with no
    /// ledger entry. Non-zero means a ledger was lost or rotated.
    audit_only: usize,
}

impl Counts {
    fn mature(&self) -> usize {
        self.recovered + self.expired
    }

    fn absorb(&mut self, other: &Counts) {
        self.ever_deferred += other.ever_deferred;
        self.recovered += other.recovered;
        self.expired += other.expired;
        self.immature += other.immature;
        self.skipped_disabled += other.skipped_disabled;
        self.backlog += other.backlog;
        self.ledger_units += other.ledger_units;
        self.audit_lines += other.audit_lines;
        self.audit_only += other.audit_only;
    }

    fn counts_json(&self) -> serde_json::Value {
        serde_json::json!({
            "deferred_units_ever": self.ever_deferred,
            "deferred_units_mature": self.mature(),
            "deferred_units_recovered": self.recovered,
            "deferred_units_expired": self.expired,
            "deferred_units_immature": self.immature,
            "deferred_units_skipped_disabled": self.skipped_disabled,
            "deferred_backlog_now": self.backlog,
            "ledger_units_read": self.ledger_units,
            "audit_lines_read": self.audit_lines,
            "deferred_units_audit_only": self.audit_only,
        })
    }

    /// `null`, never `0.0`, when nothing matured. A rate over an empty
    /// denominator is not zero — it is absent, and the harness's own
    /// discipline is to refuse to compute a number it cannot support.
    fn metrics_json(&self) -> serde_json::Value {
        let mature = self.mature();
        let rate = |n: usize| -> serde_json::Value {
            if mature == 0 {
                serde_json::Value::Null
            } else {
                serde_json::json!(n as f64 / mature as f64)
            }
        };
        serde_json::json!({
            "defer_recovery_rate": rate(self.recovered),
            "defer_expiry_rate": rate(self.expired),
        })
    }
}

/// The retry/TTL policy the data was actually produced under.
///
/// MANIFEST-V1.md: "Changing any field of `retry_and_ttl_policy`
/// invalidates `defer_recovery_rate` and `defer_expiry_rate` outright —
/// both are defined against that exact policy." So the numbers are
/// worthless without the policy beside them, and reading it off the
/// ledger rather than off a config file is what makes it a fact about
/// the run instead of a fact about the machine that scored it.
#[derive(Debug, Default)]
struct ObservedPolicy {
    max_attempts: BTreeSet<u16>,
}

impl ObservedPolicy {
    fn observe(&mut self, unit: &PendingCuratorUnit) {
        self.max_attempts.insert(unit.max_attempts);
    }

    fn json(&self) -> serde_json::Value {
        serde_json::json!({
            "max_attempts_observed": self.max_attempts.iter().collect::<Vec<_>>(),
            "note": "Read off the ledger's own units, not off a config file. \
                     More than one value means the corpus spans a policy change \
                     and the two rates are not defined over it.",
        })
    }
}

// =====================================================================
// the read
// =====================================================================

/// Everything one brain contributes. Pure over the two file kinds; the
/// only I/O is `state.rs`'s own corruption-tolerant readers.
fn read_brain(brain_id: &str) -> (Counts, ObservedPolicy) {
    let mut counts = Counts::default();
    let mut policy = ObservedPolicy::default();

    let ledger = CuratorLedger::load(brain_id);
    counts.ledger_units = ledger.units.len();

    // 1. Ledger side: `attempts > 0` is the deferral signal, since
    //    `mark_deferred` is the only writer of that field.
    let mut ever_deferred: BTreeMap<String, CuratorUnitStatus> = BTreeMap::new();
    for (storage_key, unit) in &ledger.units {
        policy.observe(unit);
        if unit.status == CuratorUnitStatus::Deferred {
            counts.backlog += 1;
        }
        if unit.attempts > 0 {
            ever_deferred.insert(storage_key.clone(), unit.status);
        }
    }

    // 2. Audit side: a unit deferred in some earlier run whose ledger
    //    entry has since been lost still counts. `read_audit` is
    //    oldest-segment-first, so the LAST line for a key is its latest
    //    known status.
    let audits = neurovault_lib::memory::adaptive::curator::state::read_audit(brain_id);
    counts.audit_lines = audits.len();
    let mut audit_deferred: BTreeMap<String, CuratorUnitStatus> = BTreeMap::new();
    let mut audit_latest: BTreeMap<String, CuratorUnitStatus> = BTreeMap::new();
    for audit in &audits {
        let key =
            UnitKey::new(&audit.unit_id, &audit.evidence_digest, &audit.policy_epoch).storage_key();
        audit_latest.insert(key.clone(), audit.unit_status);
        if audit.unit_status == CuratorUnitStatus::Deferred {
            audit_deferred.insert(key, audit.unit_status);
        }
    }
    for key in audit_deferred.keys() {
        if ever_deferred.contains_key(key) {
            continue;
        }
        counts.audit_only += 1;
        // No ledger entry: the latest audit line is the best status
        // available, and it is a fact that was durably written.
        let status = audit_latest
            .get(key)
            .copied()
            .unwrap_or(CuratorUnitStatus::Deferred);
        ever_deferred.insert(key.clone(), status);
    }

    counts.ever_deferred = ever_deferred.len();
    for status in ever_deferred.values() {
        match Bucket::of(*status) {
            Bucket::Recovered => counts.recovered += 1,
            Bucket::Expired => counts.expired += 1,
            Bucket::Immature => counts.immature += 1,
            Bucket::SkippedDisabled => counts.skipped_disabled += 1,
        }
    }
    (counts, policy)
}

/// Brain ids under `<home>/brains`, sorted. Read-only: a missing or
/// unreadable `brains/` yields an empty list rather than creating one.
fn discover_brains(home: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(home.join("brains")) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    ids.sort();
    ids
}

fn definitions_json() -> serde_json::Value {
    serde_json::json!({
        "defer_recovery_rate": {
            "spec": "deferred candidates that reach a non-deferred terminal outcome \
                     within the frozen retry/TTL policy, divided by all deferred \
                     candidates old enough to evaluate",
            "numerator": "ever-deferred units whose ledger status is Completed or PermanentlyRejected",
            "denominator": "deferred_units_mature = recovered + expired"
        },
        "defer_expiry_rate": {
            "spec": "deferred candidates that reach ExpiredVisible without recovery, \
                     divided by all deferred candidates old enough to evaluate; \
                     still-pending candidates reported separately and excluded from \
                     both denominators until mature",
            "numerator": "ever-deferred units whose ledger status is ExpiredVisible",
            "denominator": "deferred_units_mature = recovered + expired"
        },
        "population": "a unit is counted iff it was deferred at least ONCE — ledger \
                       `attempts > 0`, or an audit line with unit_status=deferred. \
                       Not iff it is deferred now.",
        "maturity": "terminal ledger status. Pending and Deferred are retryable and \
                     are reported as deferred_units_immature, excluded from both \
                     denominators.",
        "skipped_disabled": "excluded from both denominators and reported separately: \
                             the curator being switched off is a property of the kill \
                             switch, not of the retry policy.",
        "identity": "recovery + expiry = 1.0 over the mature population, by \
                     construction. Both are reported because §19.1 asks for the \
                     counterweight beside the headline."
    })
}

fn caveats_json(counts: &Counts, brains: &[String]) -> Vec<String> {
    let mut out = vec![
        "Read-only over curator_state.json + curator_runs-*.jsonl. No database, \
         no model, no network."
            .to_string(),
        "Not a scorer: MANIFEST-V1's pre_registered_thresholds is still an open \
         blocking item and no judgement is passed here."
            .to_string(),
    ];
    if counts.mature() == 0 {
        out.push(
            "Both rates are null: no ever-deferred unit has reached a terminal \
             status, so there is no denominator. This is absence, not zero."
                .to_string(),
        );
    }
    if counts.audit_only > 0 {
        out.push(format!(
            "{} ever-deferred unit(s) were recovered from audit segments with no \
             ledger entry — a ledger was lost, rotated, or deleted. Their status \
             is the latest durably audited one.",
            counts.audit_only
        ));
    }
    if brains.len() > 1 {
        out.push(format!(
            "Pooled over {} brains. Per-brain figures are in `per_brain`; the \
             top-level rates are computed on the pooled counts, not averaged.",
            brains.len()
        ));
    }
    out
}

// =====================================================================
// CLI
// =====================================================================

struct Args {
    home: PathBuf,
    brains: Vec<String>,
    pretty: bool,
}

const USAGE: &str = "\
curator_metrics — the two spec §19.1 defer metrics, read from the Rust ledger

USAGE:
    curator_metrics --brain-home <NEUROVAULT_HOME> [--brain <id>]... [--pretty]

    --brain-home <path>   a NEUROVAULT_HOME root (the directory holding brains/),
                          NOT a brain directory
    --brain <id>          restrict to this brain; repeatable; default is every
                          brain under <path>/brains
    --pretty              indent the JSON

Emits one JSON object on stdout with defer_recovery_rate and
defer_expiry_rate, shaped for eval/curator/score.py to merge. Read-only:
opens no database, loads no model, creates no file.
";

fn parse_args() -> Result<Args, String> {
    let mut home: Option<PathBuf> = None;
    let mut brains: Vec<String> = Vec::new();
    let mut pretty = false;
    let mut argv = std::env::args().skip(1);
    while let Some(arg) = argv.next() {
        match arg.as_str() {
            "--brain-home" => {
                home = Some(PathBuf::from(
                    argv.next().ok_or("--brain-home needs a path")?,
                ))
            }
            "--brain" => brains.push(argv.next().ok_or("--brain needs an id")?),
            "--pretty" => pretty = true,
            "-h" | "--help" => {
                print!("{USAGE}");
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    Ok(Args {
        home: home.ok_or("--brain-home is required")?,
        brains,
        pretty,
    })
}

/// The whole report for one home. Separated from `main` so the tests can
/// drive it against a synthetic ledger without a subprocess.
fn report(home: &Path, requested: &[String]) -> serde_json::Value {
    // `state.rs` resolves every path through `paths::nv_home()`, which
    // reads NEUROVAULT_HOME. Setting it here is what makes this the REAL
    // reader rather than a parallel re-implementation of the file layout.
    std::env::set_var("NEUROVAULT_HOME", home);

    let brains = if requested.is_empty() {
        discover_brains(home)
    } else {
        requested.to_vec()
    };

    let mut pooled = Counts::default();
    let mut pooled_policy = ObservedPolicy::default();
    let mut per_brain = serde_json::Map::new();
    for brain in &brains {
        let (counts, policy) = read_brain(brain);
        pooled.absorb(&counts);
        pooled_policy.max_attempts.extend(&policy.max_attempts);
        per_brain.insert(
            brain.clone(),
            serde_json::json!({
                "metrics": counts.metrics_json(),
                "counts": counts.counts_json(),
                "retry_and_ttl_policy_observed": policy.json(),
            }),
        );
    }

    serde_json::json!({
        "schema": "curator_ledger_metrics_v1",
        "source": ["curator_state.json", "curator_runs-*.jsonl"],
        "brains": brains,
        "metrics": pooled.metrics_json(),
        "counts": pooled.counts_json(),
        "retry_and_ttl_policy_observed": pooled_policy.json(),
        "definitions": definitions_json(),
        "caveats": caveats_json(&pooled, &brains),
        "per_brain": per_brain,
    })
}

fn main() {
    let args = match parse_args() {
        Ok(args) => args,
        Err(why) => {
            eprintln!("curator_metrics: {why}\n\n{USAGE}");
            std::process::exit(2);
        }
    };
    if !args.home.is_dir() {
        eprintln!(
            "curator_metrics: --brain-home {} is not a directory",
            args.home.display()
        );
        std::process::exit(2);
    }
    let out = report(&args.home, &args.brains);
    let rendered = if args.pretty {
        serde_json::to_string_pretty(&out)
    } else {
        serde_json::to_string(&out)
    };
    match rendered {
        Ok(text) => println!("{text}"),
        Err(e) => {
            eprintln!("curator_metrics: serialize: {e}");
            std::process::exit(1);
        }
    }
}

// =====================================================================
// tests — against a synthetic ledger written through state.rs's own API
// =====================================================================
//
// The point of writing the fixture through `CuratorLedger`/`commit_unit`
// rather than by hand: if this bin agreed with a hand-rolled JSON blob,
// it would only prove the test agrees with itself. Driving the real
// transitions means a `state.rs` change that alters what a deferral
// looks like on disk breaks these numbers, which is the whole reason to
// read the ledger through its own types.

#[cfg(test)]
mod tests {
    use super::*;
    use neurovault_lib::memory::adaptive::curator::state::{
        commit_unit, CandidateAuditOutcome, CuratorErrorCode, CuratorRunAudit, JournalCursor,
        RetryPolicy, UnitOutcome,
    };
    use std::sync::Mutex;
    use time::{Duration, OffsetDateTime};

    /// This binary's own test process, but `report()` sets a process-wide
    /// env var, so serialize anyway.
    static HOME_LOCK: Mutex<()> = Mutex::new(());

    const BRAIN: &str = "MetricsBrain";
    const EPOCH: &str = "2026-08-vp1";

    struct Home {
        root: PathBuf,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl Home {
        fn new(name: &str) -> Self {
            let guard = HOME_LOCK.lock().unwrap_or_else(|p| p.into_inner());
            let root = std::env::temp_dir().join(format!(
                "nv-curator-metrics-{name}-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(root.join("brains").join(BRAIN)).unwrap();
            std::env::set_var("NEUROVAULT_HOME", &root);
            Home {
                root,
                _guard: guard,
            }
        }
    }

    impl Drop for Home {
        fn drop(&mut self) {
            std::env::remove_var("NEUROVAULT_HOME");
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn key(unit: &str) -> UnitKey {
        UnitKey::new(unit, &format!("dig_{unit}"), EPOCH)
    }

    fn audit(unit: &str, now: OffsetDateTime) -> CuratorRunAudit {
        let k = key(unit);
        CuratorRunAudit::new("cr_test", BRAIN, &k, now).with_outcome(
            CandidateAuditOutcome::new(
                b"{}",
                neurovault_lib::memory::adaptive::curator::state::AuditOutcomeKind::Rejected,
                &serde_json::json!({}),
            )
            .unwrap(),
        )
    }

    /// Observe a unit, then drive it through `n` deferrals and finally
    /// `finish` — every transition through the real API.
    fn drive(
        ledger: &mut CuratorLedger,
        unit: &str,
        defers: usize,
        finish: Option<UnitOutcome>,
        policy: &RetryPolicy,
        now: OffsetDateTime,
    ) {
        let k = key(unit);
        let stamp = now
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap();
        ledger.observe(
            &k,
            BRAIN,
            JournalCursor {
                ts: stamp.clone(),
                seq: 1,
                event_id: format!("ev_{unit}"),
            },
            &stamp,
            policy,
            now,
        );
        for attempt in 0..defers {
            // A deferral advances the clock so the backoff is realistic.
            let at = now + Duration::minutes(attempt as i64);
            commit_unit(
                BRAIN,
                ledger,
                &k,
                audit(unit, at),
                UnitOutcome::Deferred(CuratorErrorCode::ProviderTimeout),
                policy,
                at,
            )
            .expect("deferral commits");
        }
        if let Some(outcome) = finish {
            let at = now + Duration::hours(2);
            commit_unit(BRAIN, ledger, &k, audit(unit, at), outcome, policy, at)
                .expect("terminal commit");
        }
    }

    fn metrics(value: &serde_json::Value) -> (Option<f64>, Option<f64>) {
        (
            value["metrics"]["defer_recovery_rate"].as_f64(),
            value["metrics"]["defer_expiry_rate"].as_f64(),
        )
    }

    /// The headline: five ever-deferred units across every terminal
    /// shape, and the two rates over exactly the mature ones.
    #[test]
    fn the_two_rates_are_computed_over_the_mature_population_only() {
        let home = Home::new("mature");
        let now = OffsetDateTime::now_utc();
        let policy = RetryPolicy::default();
        let mut ledger = CuratorLedger::load(BRAIN);

        // recovered: deferred once, then completed
        drive(
            &mut ledger,
            "u-completed",
            1,
            Some(UnitOutcome::Completed),
            &policy,
            now,
        );
        // recovered: deferred once, then a POLICY-terminal reject. Not a
        // loss — a decision — so it counts as recovery.
        drive(
            &mut ledger,
            "u-rejected",
            1,
            Some(UnitOutcome::PermanentlyRejected),
            &policy,
            now,
        );
        // expired: deferred until attempts ran out. `mark_deferred`
        // flips it to ExpiredVisible on the last attempt itself.
        drive(
            &mut ledger,
            "u-exhausted",
            usize::from(policy.max_attempts),
            None,
            &policy,
            now,
        );
        // immature: deferred once, still waiting on its backoff
        drive(&mut ledger, "u-waiting", 1, None, &policy, now);
        // excluded: deferred once, then the kill switch went off
        drive(
            &mut ledger,
            "u-disabled",
            1,
            Some(UnitOutcome::SkippedDisabled),
            &policy,
            now,
        );
        // NOT in the population at all: never deferred.
        drive(
            &mut ledger,
            "u-clean",
            0,
            Some(UnitOutcome::Completed),
            &policy,
            now,
        );

        let out = report(&home.root, &[BRAIN.to_string()]);
        let counts = &out["counts"];
        assert_eq!(counts["ledger_units_read"], 6);
        assert_eq!(
            counts["deferred_units_ever"], 5,
            "u-clean was never deferred: {out:#}"
        );
        assert_eq!(counts["deferred_units_recovered"], 2);
        assert_eq!(counts["deferred_units_expired"], 1);
        assert_eq!(counts["deferred_units_immature"], 1);
        assert_eq!(counts["deferred_units_skipped_disabled"], 1);
        assert_eq!(counts["deferred_units_mature"], 3);
        assert_eq!(counts["deferred_backlog_now"], 1, "u-waiting");
        assert_eq!(counts["deferred_units_audit_only"], 0);

        let (recovery, expiry) = metrics(&out);
        assert_eq!(recovery, Some(2.0 / 3.0));
        assert_eq!(expiry, Some(1.0 / 3.0));
        // The identity, asserted: within the frozen policy a matured
        // deferred unit either came back or expired visibly.
        assert!((recovery.unwrap() + expiry.unwrap() - 1.0).abs() < 1e-12);

        // And the policy the numbers are only valid against.
        assert_eq!(
            out["retry_and_ttl_policy_observed"]["max_attempts_observed"],
            serde_json::json!([policy.max_attempts])
        );
        drop(home);
    }

    /// An empty denominator is `null`, never `0.0`. A rate over nothing
    /// is absent, and printing zero would read as "nothing ever
    /// recovered" — the opposite of the truth.
    #[test]
    fn an_empty_denominator_is_null_not_zero() {
        let home = Home::new("empty");
        let now = OffsetDateTime::now_utc();
        let policy = RetryPolicy::default();
        let mut ledger = CuratorLedger::load(BRAIN);
        drive(&mut ledger, "u-waiting", 1, None, &policy, now);

        let out = report(&home.root, &[BRAIN.to_string()]);
        assert_eq!(out["counts"]["deferred_units_ever"], 1);
        assert_eq!(out["counts"]["deferred_units_mature"], 0);
        assert!(out["metrics"]["defer_recovery_rate"].is_null());
        assert!(out["metrics"]["defer_expiry_rate"].is_null());
        assert!(out["caveats"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c.as_str().unwrap().contains("absence, not zero")));
        drop(home);
    }

    /// A brain with no curator activity at all reads clean: no rates, no
    /// counts, no panic, and — the part that matters — no files created.
    #[test]
    fn an_untouched_home_yields_nulls_and_writes_nothing() {
        let home = Home::new("untouched");
        let before = tree(&home.root);

        let out = report(&home.root, &[]);
        assert_eq!(out["brains"], serde_json::json!([BRAIN]));
        assert_eq!(out["counts"]["ledger_units_read"], 0);
        assert_eq!(out["counts"]["audit_lines_read"], 0);
        assert!(out["metrics"]["defer_recovery_rate"].is_null());

        assert_eq!(
            tree(&home.root),
            before,
            "a metrics reader that perturbs what it measures is worse than none"
        );
        drop(home);
    }

    /// The audit fallback: a ledger lost to a crash still yields a
    /// population, because `commit_unit` writes the audit line FIRST.
    #[test]
    fn a_lost_ledger_still_yields_a_population_from_the_audit_segments() {
        let home = Home::new("auditonly");
        let now = OffsetDateTime::now_utc();
        let policy = RetryPolicy::default();
        let mut ledger = CuratorLedger::load(BRAIN);
        drive(
            &mut ledger,
            "u-completed",
            1,
            Some(UnitOutcome::Completed),
            &policy,
            now,
        );

        // The crash: the ledger is gone, the audit segments are not.
        std::fs::remove_file(neurovault_lib::memory::adaptive::curator::state::state_path(BRAIN))
            .unwrap();

        let out = report(&home.root, &[BRAIN.to_string()]);
        assert_eq!(out["counts"]["ledger_units_read"], 0);
        assert!(out["counts"]["audit_lines_read"].as_u64().unwrap() >= 2);
        assert_eq!(out["counts"]["deferred_units_ever"], 1);
        assert_eq!(out["counts"]["deferred_units_audit_only"], 1);
        assert_eq!(
            out["counts"]["deferred_units_recovered"], 1,
            "the latest durably audited status is Completed: {out:#}"
        );
        assert_eq!(metrics(&out).0, Some(1.0));
        assert!(out["caveats"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c.as_str().unwrap().contains("ledger was lost")));
        drop(home);
    }

    /// Shape contract for `score.py`: the merge target is stable, the
    /// two metric names are the spec's, and both definitions travel with
    /// the numbers so a later reader never has to guess the denominator.
    #[test]
    fn the_emitted_object_is_shaped_for_the_scorer_to_merge() {
        let home = Home::new("shape");
        let out = report(&home.root, &[BRAIN.to_string()]);
        assert_eq!(out["schema"], "curator_ledger_metrics_v1");
        assert_eq!(
            out["source"],
            serde_json::json!(["curator_state.json", "curator_runs-*.jsonl"])
        );
        let metrics = out["metrics"].as_object().expect("metrics object");
        assert_eq!(
            metrics.keys().collect::<Vec<_>>(),
            vec!["defer_expiry_rate", "defer_recovery_rate"],
            "exactly the two §19.1 metrics the Python harness cannot compute"
        );
        for name in ["defer_recovery_rate", "defer_expiry_rate"] {
            assert!(
                out["definitions"][name]["spec"].is_string(),
                "{name} must travel with its spec text"
            );
            assert!(out["definitions"][name]["denominator"].is_string());
        }
        assert!(out["per_brain"][BRAIN]["counts"].is_object());
        drop(home);
    }

    /// Sorted `(relative path, len)` for every file under `root`.
    fn tree(root: &Path) -> Vec<(String, u64)> {
        fn walk(dir: &Path, root: &Path, out: &mut Vec<(String, u64)>) {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, root, out);
                } else if let Ok(meta) = entry.metadata() {
                    out.push((
                        path.strip_prefix(root)
                            .unwrap_or(&path)
                            .to_string_lossy()
                            .into_owned(),
                        meta.len(),
                    ));
                }
            }
        }
        let mut out = Vec::new();
        walk(root, root, &mut out);
        out.sort();
        out
    }
}
