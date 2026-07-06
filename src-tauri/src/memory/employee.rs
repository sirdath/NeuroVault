//! AI employees — the fleet engine (roster, per-employee loops, guardrails).
//!
//! NeuroVault's core stays a coordination/memory SUBSTRATE: the brain
//! never runs agents on its own. This module is the deliberate, opt-in
//! workforce built ON that substrate: a roster of hireable employees
//! (see `roles.rs` for the catalog), each an always-on loop that WAKES
//! cheap model calls or an external agent (Claude Code headless) and
//! works against the brain like any other client.
//!
//! Economy model (why this can run 24/7 for cents):
//! - Rust does the WATCHING for free: duplicate/contradiction/orphan
//!   detection, inbox and meetings pending counts, todo staleness are
//!   all local algorithms. No LLM burns while nothing changed.
//! - The model is consulted only for JUDGMENT or WRITING, in small
//!   batched, mostly toolless `claude -p` calls on the cheap tier
//!   (`--model haiku`), with `--strict-mcp-config` so the user's other
//!   MCP servers never boot into context. Subscription-backed via the
//!   user's own Claude Code login — no API keys.
//! - Hard daily call budget per employee; the watchers keep queueing
//!   when it's spent, judgment resumes tomorrow.
//!
//! Safety model (autonomy level 0 = propose-only):
//! - Deep runs get a per-role tool whitelist enforced by Claude Code's
//!   permission layer (`--allowedTools`) — destructive tools are
//!   physically unavailable, not merely discouraged.
//! - Destructive intents surface as `PROPOSAL: {json}` stdout lines,
//!   parsed into a per-employee approval queue; approving executes
//!   server-side against the hard-coded action whitelist below.
//! - Every run is capped (turns + wall clock) and journaled.
//!
//! Storage: per-instance state lives under
//! `~/.neurovault/employee/instances/<id>/` (queue, proposals, runs,
//! budget, state). The roster is `~/.neurovault/employee/employees.json`.
//! Legacy singleton files from the first Curator release migrate on
//! first load.

use std::collections::{HashMap, VecDeque};
use std::io::Write as _;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::db::open_brain;
use super::paths::nv_home;
use super::roles::{role, ROLES};
use super::types::MemoryError;

type Result<T> = std::result::Result<T, MemoryError>;

// ---------------------------------------------------------------------------
// Config (per employee instance)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmployeeConfig {
    /// On the clock? Off by default: an employee is opt-in.
    #[serde(default)]
    pub enabled: bool,
    /// Hours between manual-style deep runs (legacy knob, kept for the
    /// UI's deep-run controls).
    #[serde(default = "default_interval")]
    pub interval_hours: u32,
    /// Autonomy level. v0 supports only 0 (propose-only).
    #[serde(default)]
    pub autonomy: u8,
    /// Override path to the `claude` binary; empty = search PATH.
    #[serde(default)]
    pub claude_path: String,
    /// Cap on agent turns per deep run (passed as --max-turns).
    #[serde(default = "default_max_turns")]
    pub max_turns: u32,
    /// Wall-clock cap per deep run, minutes.
    #[serde(default = "default_timeout_min")]
    pub timeout_minutes: u64,
    /// Minutes between wakes of this employee's loop.
    #[serde(default = "default_wake_minutes")]
    pub wake_minutes: u32,
    /// Model for judge/digest micro-calls (cheap tier by default).
    #[serde(default = "default_judge_model")]
    pub model: String,
    /// Model for deep runs (meetings distillation, ingest, hygiene).
    #[serde(default = "default_deep_model")]
    pub deep_model: String,
    /// Max work items judged per batch call.
    #[serde(default = "default_batch_items")]
    pub max_items_per_run: usize,
    /// Hard daily cap on model calls for this employee.
    #[serde(default = "default_daily_budget")]
    pub daily_call_budget: u32,
}

fn default_interval() -> u32 {
    24
}
fn default_max_turns() -> u32 {
    30
}
fn default_timeout_min() -> u64 {
    15
}
fn default_wake_minutes() -> u32 {
    20
}
fn default_judge_model() -> String {
    "haiku".to_string()
}
fn default_deep_model() -> String {
    "sonnet".to_string()
}
fn default_batch_items() -> usize {
    8
}
fn default_daily_budget() -> u32 {
    100
}

impl Default for EmployeeConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            interval_hours: default_interval(),
            autonomy: 0,
            claude_path: String::new(),
            max_turns: default_max_turns(),
            timeout_minutes: default_timeout_min(),
            wake_minutes: default_wake_minutes(),
            model: default_judge_model(),
            deep_model: default_deep_model(),
            max_items_per_run: default_batch_items(),
            daily_call_budget: default_daily_budget(),
        }
    }
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hire {
    /// Instance id ("curator", "scribe", "scribe-2", ...).
    pub id: String,
    /// Role id from the catalog.
    pub role: String,
    pub hired_at: String,
    #[serde(default)]
    pub config: EmployeeConfig,
}

fn employee_dir() -> PathBuf {
    nv_home().join("employee")
}
fn roster_path() -> PathBuf {
    employee_dir().join("employees.json")
}
fn instance_dir(id: &str) -> PathBuf {
    employee_dir().join("instances").join(id)
}
fn proposals_path(id: &str) -> PathBuf {
    instance_dir(id).join("proposals.jsonl")
}
fn runs_path(id: &str) -> PathBuf {
    instance_dir(id).join("runs.jsonl")
}
fn queue_path(id: &str) -> PathBuf {
    instance_dir(id).join("queue.jsonl")
}
fn budget_path(id: &str) -> PathBuf {
    instance_dir(id).join("budget.json")
}
fn state_path(id: &str) -> PathBuf {
    instance_dir(id).join("state.json")
}

/// Load the roster, seeding + migrating on first run: the original
/// singleton Curator release kept its files at employee/ top level and
/// its config at ~/.neurovault/employee.json; move them under
/// instances/curator/ and fold the config into the roster entry.
pub fn load_roster() -> Vec<Hire> {
    if let Ok(s) = std::fs::read_to_string(roster_path()) {
        if let Ok(r) = serde_json::from_str::<Vec<Hire>>(&s) {
            return r;
        }
    }
    // Seed: the Curator is employee #1, hired by default (still
    // disabled until the user flips the switch).
    let legacy_cfg: EmployeeConfig = std::fs::read_to_string(nv_home().join("employee.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let roster = vec![Hire {
        id: "curator".to_string(),
        role: "curator".to_string(),
        hired_at: now_iso(),
        config: legacy_cfg,
    }];
    let _ = std::fs::create_dir_all(instance_dir("curator"));
    // migrate legacy singleton files if present
    for (old, newp) in [
        (
            employee_dir().join("proposals.jsonl"),
            proposals_path("curator"),
        ),
        (employee_dir().join("runs.jsonl"), runs_path("curator")),
        (employee_dir().join("queue.jsonl"), queue_path("curator")),
        (employee_dir().join("budget.json"), budget_path("curator")),
    ] {
        if old.exists() && !newp.exists() {
            let _ = std::fs::rename(&old, &newp);
        }
    }
    let _ = save_roster(&roster);
    roster
}

pub fn save_roster(roster: &[Hire]) -> Result<()> {
    let _ = std::fs::create_dir_all(employee_dir());
    std::fs::write(
        roster_path(),
        serde_json::to_string_pretty(roster).unwrap_or_default(),
    )
    .map_err(|e| MemoryError::Other(format!("write roster: {e}")))
}

pub fn get_hire(id: &str) -> Option<Hire> {
    load_roster().into_iter().find(|h| h.id == id)
}

/// Allocate an instance id for a new hire of `role_id`: the bare role
/// id if free, else role-2, role-3, ...
fn next_instance_id(role_id: &str, existing: &[String]) -> String {
    if !existing.iter().any(|e| e == role_id) {
        return role_id.to_string();
    }
    let mut n = 2usize;
    loop {
        let cand = format!("{role_id}-{n}");
        if !existing.iter().any(|e| e == &cand) {
            return cand;
        }
        n += 1;
    }
}

pub fn hire(role_id: &str) -> Result<Hire> {
    let def =
        role(role_id).ok_or_else(|| MemoryError::Other(format!("unknown role '{role_id}'")))?;
    if !def.available {
        return Err(MemoryError::Other(format!(
            "role '{role_id}' is not hireable yet"
        )));
    }
    let mut roster = load_roster();
    let ids: Vec<String> = roster.iter().map(|h| h.id.clone()).collect();
    let id = next_instance_id(role_id, &ids);
    let hire = Hire {
        id: id.clone(),
        role: role_id.to_string(),
        hired_at: now_iso(),
        config: EmployeeConfig {
            wake_minutes: def.default_wake_minutes,
            ..Default::default()
        },
    };
    let _ = std::fs::create_dir_all(instance_dir(&id));
    roster.push(hire.clone());
    save_roster(&roster)?;
    Ok(hire)
}

pub fn fire(id: &str) -> Result<()> {
    if id == "curator" {
        return Err(MemoryError::Other(
            "the Curator is the built-in first employee; disable it instead of firing".into(),
        ));
    }
    let mut roster = load_roster();
    let before = roster.len();
    roster.retain(|h| h.id != id);
    if roster.len() == before {
        return Err(MemoryError::Other(format!("no employee '{id}'")));
    }
    save_roster(&roster)
    // instance files are kept on disk: firing is reversible by rehiring
    // with the same id (history intact).
}

fn update_config(id: &str, f: impl FnOnce(&mut EmployeeConfig)) -> Result<Hire> {
    let mut roster = load_roster();
    let h = roster
        .iter_mut()
        .find(|h| h.id == id)
        .ok_or_else(|| MemoryError::Other(format!("no employee '{id}'")))?;
    f(&mut h.config);
    let out = h.clone();
    save_roster(&roster)?;
    Ok(out)
}

// ---------------------------------------------------------------------------
// Live state per instance: activity ring + run flag
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct ActivityEvent {
    pub seq: u64,
    pub ts: String,
    pub kind: String, // info | tool | proposal | result | error
    pub line: String,
}

#[derive(Default)]
struct LiveState {
    running: bool,
    seq: u64,
    events: VecDeque<ActivityEvent>,
    kill: Option<tokio::sync::oneshot::Sender<()>>,
    last_tick: u64,
}

static LIVE: Lazy<Mutex<HashMap<String, LiveState>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static SCHEDULER_STARTED: AtomicBool = AtomicBool::new(false);

fn with_live<T>(id: &str, f: impl FnOnce(&mut LiveState) -> T) -> T {
    let mut map = LIVE.lock();
    f(map.entry(id.to_string()).or_default())
}

fn push_event(id: &str, kind: &str, line: impl Into<String>) {
    with_live(id, |st| {
        st.seq += 1;
        let ev = ActivityEvent {
            seq: st.seq,
            ts: now_iso(),
            kind: kind.to_string(),
            line: line.into(),
        };
        if st.events.len() >= 500 {
            st.events.pop_front();
        }
        st.events.push_back(ev);
    });
}

fn now_iso() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    iso_from_secs(now)
}

fn iso_from_secs(now: u64) -> String {
    let days = now / 86_400;
    let (y, mo, d) = civil_from_days(days as i64);
    let secs = now % 86_400;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y,
        mo,
        d,
        secs / 3600,
        (secs % 3600) / 60,
        secs % 60
    )
}

/// Days-since-epoch to (y, m, d). Howard Hinnant's civil_from_days.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

// ---------------------------------------------------------------------------
// JSONL helpers
// ---------------------------------------------------------------------------

fn append_jsonl(path: &PathBuf, v: &impl Serialize) -> Result<()> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| MemoryError::Other(format!("open {}: {e}", path.display())))?;
    writeln!(f, "{}", serde_json::to_string(v).unwrap_or_default())
        .map_err(|e| MemoryError::Other(format!("append {}: {e}", path.display())))?;
    Ok(())
}

fn read_jsonl<T: serde::de::DeserializeOwned>(path: &PathBuf) -> Vec<T> {
    std::fs::read_to_string(path)
        .map(|s| {
            s.lines()
                .filter_map(|l| serde_json::from_str(l).ok())
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Proposals (approval queue, per instance)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Proposal {
    pub id: String,
    pub ts: String,
    pub action: String,
    pub title: String,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub args: Value,
    pub status: String, // open | approved | rejected
    #[serde(default)]
    pub brain: String,
}

/// Actions the approve endpoint will execute. The whitelist is the
/// contract, not the prompt.
const EXECUTABLE_ACTIONS: &[&str] = &[
    "supersede_note",
    "set_kind",
    "add_tag",
    "add_link",
    "archive_engram",
];

pub fn list_proposals(id: &str, status: Option<&str>) -> Vec<Proposal> {
    let all: Vec<Proposal> = read_jsonl(&proposals_path(id));
    let mut latest: HashMap<String, Proposal> = Default::default();
    for p in all {
        latest.insert(p.id.clone(), p);
    }
    let mut out: Vec<Proposal> = latest
        .into_values()
        .filter(|p| status.is_none_or(|s| p.status == s))
        .collect();
    out.sort_by(|a, b| b.ts.cmp(&a.ts));
    out
}

fn parse_proposal_line(line: &str, brain: &str) -> Option<Proposal> {
    let raw = line.trim().strip_prefix("PROPOSAL:")?.trim();
    let v: Value = serde_json::from_str(raw).ok()?;
    let action = v.get("action")?.as_str()?.to_string();
    Some(Proposal {
        id: uuid::Uuid::new_v4().to_string(),
        ts: now_iso(),
        title: v
            .get("title")
            .and_then(|t| t.as_str())
            .unwrap_or(&action)
            .to_string(),
        reason: v
            .get("reason")
            .and_then(|t| t.as_str())
            .unwrap_or_default()
            .to_string(),
        args: v.get("args").cloned().unwrap_or(json!({})),
        action,
        status: "open".to_string(),
        brain: brain.to_string(),
    })
}

/// Execute an approved proposal against the brain. Whitelist-gated.
fn execute_proposal(p: &Proposal) -> Result<String> {
    if !EXECUTABLE_ACTIONS.contains(&p.action.as_str()) {
        return Err(MemoryError::Other(format!(
            "action '{}' is not executable in v0",
            p.action
        )));
    }
    let db = open_brain(&p.brain)?;
    let a = &p.args;
    let get = |k: &str| -> Result<String> {
        a.get(k)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| MemoryError::Other(format!("proposal args missing '{k}'")))
    };
    match p.action.as_str() {
        "supersede_note" => {
            let old = get("old_id")?;
            let new = get("new_id")?;
            let reason = a.get("reason").and_then(|v| v.as_str());
            super::write_ops::supersede_note(&db, &old, &new, reason)?;
            Ok(format!("superseded {old} -> {new}"))
        }
        "set_kind" => {
            let id = get("engram_id")?;
            let kind = get("kind")?;
            let conn = db.lock();
            let n = conn.execute(
                "UPDATE engrams SET kind = ?1 WHERE id = ?2",
                rusqlite::params![kind, id],
            )?;
            Ok(format!("kind={kind} on {n} engram"))
        }
        "add_tag" => {
            let id = get("engram_id")?;
            let tag = get("tag")?;
            let conn = db.lock();
            let cur: Option<String> = conn
                .query_row("SELECT tags FROM engrams WHERE id = ?1", [&id], |r| {
                    r.get(0)
                })
                .ok();
            let cur = cur.unwrap_or_default();
            if !cur.split(',').any(|t| t.trim() == tag) {
                let newtags = if cur.trim().is_empty() {
                    tag.clone()
                } else {
                    format!("{cur},{tag}")
                };
                conn.execute(
                    "UPDATE engrams SET tags = ?1 WHERE id = ?2",
                    rusqlite::params![newtags, id],
                )?;
            }
            Ok(format!("tag '{tag}' on {id}"))
        }
        "add_link" => {
            let from = get("from_id")?;
            let to = get("to_id")?;
            let conn = db.lock();
            conn.execute(
                "INSERT OR REPLACE INTO engram_links (from_engram, to_engram, similarity, link_type)
                 VALUES (?1, ?2, 1.0, 'curator')",
                rusqlite::params![from, to],
            )?;
            Ok(format!("linked {from} -> {to}"))
        }
        "archive_engram" => {
            let id = get("engram_id")?;
            let conn = db.lock();
            let n = conn.execute(
                "UPDATE engrams SET state = 'dormant' WHERE id = ?1",
                rusqlite::params![id],
            )?;
            Ok(format!("archived (dormant) {n} engram"))
        }
        _ => unreachable!("gated by EXECUTABLE_ACTIONS"),
    }
}

// ---------------------------------------------------------------------------
// Budget per instance
// ---------------------------------------------------------------------------

fn budget_today(id: &str) -> (String, u32) {
    let today = now_iso().split('T').next().unwrap_or("").to_string();
    let v: Value = std::fs::read_to_string(budget_path(id))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(json!({}));
    if v.get("date").and_then(|d| d.as_str()) == Some(today.as_str()) {
        (
            today,
            v.get("calls").and_then(|c| c.as_u64()).unwrap_or(0) as u32,
        )
    } else {
        (today, 0)
    }
}

fn budget_bump(id: &str) {
    let (date, calls) = budget_today(id);
    let _ = std::fs::create_dir_all(instance_dir(id));
    let _ = std::fs::write(
        budget_path(id),
        json!({"date": date, "calls": calls + 1}).to_string(),
    );
}

fn budget_left(id: &str, cfg: &EmployeeConfig) -> bool {
    budget_today(id).1 < cfg.daily_call_budget
}

// ---------------------------------------------------------------------------
// Meetings inbox (brain-scoped; Scribe's desk, also reachable manually)
// ---------------------------------------------------------------------------

const MEETING_EXTS: &[&str] = &["md", "txt", "vtt", "srt"];

fn meetings_inbox(brain: &str) -> PathBuf {
    super::paths::brain_dir(brain)
        .join("inbox")
        .join("meetings")
}
fn meetings_archive(brain: &str) -> PathBuf {
    super::paths::brain_dir(brain)
        .join("archive")
        .join("meetings")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingRecord {
    pub file: String,
    pub status: String, // pending | processed
    #[serde(default)]
    pub processed_at: Option<String>,
    #[serde(default)]
    pub archive_path: Option<String>,
}

fn meetings_index_path(brain: &str) -> PathBuf {
    meetings_archive(brain).join("index.jsonl")
}

pub fn list_meetings(brain: &str) -> Vec<MeetingRecord> {
    let idx: Vec<MeetingRecord> = read_jsonl(&meetings_index_path(brain));
    let processed: std::collections::HashSet<String> = idx.iter().map(|m| m.file.clone()).collect();
    let mut out: Vec<MeetingRecord> = idx;
    if let Ok(rd) = std::fs::read_dir(meetings_inbox(brain)) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let ext_ok = name
                .rsplit('.')
                .next()
                .map(|x| MEETING_EXTS.contains(&x.to_lowercase().as_str()))
                .unwrap_or(false);
            if ext_ok && !processed.contains(&name) {
                out.push(MeetingRecord {
                    file: name,
                    status: "pending".into(),
                    processed_at: None,
                    archive_path: None,
                });
            }
        }
    }
    out.sort_by(|a, b| b.processed_at.cmp(&a.processed_at));
    out
}

fn count_pending_meetings(brain: &str) -> usize {
    list_meetings(brain)
        .iter()
        .filter(|m| m.status == "pending")
        .count()
}

/// Copy dropped transcript files into the meetings inbox (Rust-side,
/// so the webview needs no fs scope). Skips non-transcript extensions.
pub fn add_meeting_files(brain: &str, paths: &[String]) -> Result<Vec<String>> {
    let dir = meetings_inbox(brain);
    std::fs::create_dir_all(&dir)
        .map_err(|e| MemoryError::Other(format!("create meetings inbox: {e}")))?;
    let mut added = Vec::new();
    for p in paths {
        let src = PathBuf::from(p);
        if !src.is_file() {
            continue;
        }
        let Some(name) = src.file_name().map(|n| n.to_string_lossy().to_string()) else {
            continue;
        };
        let ext_ok = name
            .rsplit('.')
            .next()
            .map(|x| MEETING_EXTS.contains(&x.to_lowercase().as_str()))
            .unwrap_or(false);
        if !ext_ok {
            continue;
        }
        std::fs::copy(&src, dir.join(&name))
            .map_err(|e| MemoryError::Other(format!("copy {name}: {e}")))?;
        added.push(name);
    }
    Ok(added)
}

/// Move a pending transcript into the immutable archive (verbatim; the
/// evidence layer is never edited) and index it.
fn archive_meeting(brain: &str, file: &str) -> Result<PathBuf> {
    let src = meetings_inbox(brain).join(file);
    let dir = meetings_archive(brain);
    std::fs::create_dir_all(&dir)
        .map_err(|e| MemoryError::Other(format!("create archive dir: {e}")))?;
    let stamped = format!("{}-{}", now_iso().replace(':', ""), file);
    let dst = dir.join(&stamped);
    std::fs::copy(&src, &dst).map_err(|e| MemoryError::Other(format!("archive copy: {e}")))?;
    let _ = std::fs::remove_file(&src);
    append_jsonl(
        &meetings_index_path(brain),
        &MeetingRecord {
            file: file.to_string(),
            status: "processed".into(),
            processed_at: Some(now_iso()),
            archive_path: Some(dst.display().to_string()),
        },
    )?;
    Ok(dst)
}

// ---------------------------------------------------------------------------
// Claude invocation helpers
// ---------------------------------------------------------------------------

fn find_claude(cfg: &EmployeeConfig) -> Option<PathBuf> {
    if !cfg.claude_path.trim().is_empty() {
        let p = PathBuf::from(cfg.claude_path.trim());
        return p.exists().then_some(p);
    }
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let cand = dir.join("claude");
        if cand.exists() {
            return Some(cand);
        }
    }
    None
}

/// Locate our own headless MCP server binary: bundled next to the app
/// executable in production, PATH as fallback.
fn neurovault_server_path() -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let cand = dir.join("neurovault-server");
            if cand.exists() {
                return Some(cand);
            }
        }
    }
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let cand = dir.join("neurovault-server");
        if cand.exists() {
            return Some(cand);
        }
    }
    None
}

/// One toolless model call on the cheap tier. Empty strict MCP config:
/// the user's other servers never boot into context, keeping the call
/// at a few hundred tokens. Returns stdout on success.
async fn toolless_call(id: &str, cfg: &EmployeeConfig, prompt: String) -> Option<String> {
    let claude = match find_claude(cfg) {
        Some(c) => c,
        None => {
            push_event(id, "error", "claude CLI not found");
            return None;
        }
    };
    budget_bump(id);
    let out = tokio::process::Command::new(&claude)
        .arg("-p")
        .arg(prompt)
        .arg("--model")
        .arg(&cfg.model)
        .arg("--max-turns")
        .arg("1")
        .arg("--mcp-config")
        .arg(r#"{"mcpServers":{}}"#)
        .arg("--strict-mcp-config")
        .current_dir(nv_home())
        .output()
        .await;
    match out {
        Ok(o) if o.status.success() => Some(String::from_utf8_lossy(&o.stdout).to_string()),
        Ok(o) => {
            push_event(
                id,
                "error",
                format!(
                    "model call exited {}: {}",
                    o.status,
                    truncate_chars(&String::from_utf8_lossy(&o.stderr), 160)
                ),
            );
            None
        }
        Err(e) => {
            push_event(id, "error", format!("model spawn: {e}"));
            None
        }
    }
}

fn truncate_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Per-role tool whitelist for DEEP runs. Enforced by Claude Code's
/// permission layer; level 0 never includes destructive tools.
fn allowed_tools(role_id: &str) -> String {
    let base = [
        "mcp__neurovault__session_start",
        "mcp__neurovault__recall",
        "mcp__neurovault__recall_chunks",
        "mcp__neurovault__related",
        "mcp__neurovault__status",
        "mcp__neurovault__check_duplicate",
        "mcp__neurovault__remember",
    ];
    let extra: &[&str] = match role_id {
        "curator" => &[
            "mcp__neurovault__find_clutter",
            "mcp__neurovault__find_contradictions",
            "mcp__neurovault__find_orphan_links",
            "mcp__neurovault__engram_history",
            "mcp__neurovault__temporal_recall",
            "mcp__neurovault__handoff",
            "Read",
        ],
        "scribe" => &["mcp__neurovault__handoff", "Read"],
        "librarian" => &[
            "mcp__neurovault__list_inbox",
            "mcp__neurovault__read_inbox_file",
            "mcp__neurovault__mark_inbox_done",
        ],
        _ => &[],
    };
    base.iter()
        .chain(extra.iter())
        .cloned()
        .collect::<Vec<_>>()
        .join(",")
}

// ---------------------------------------------------------------------------
// Deep-run prompts
// ---------------------------------------------------------------------------

fn hygiene_prompt(brain: &str) -> String {
    format!(
        r#"You are the Curator, NeuroVault's knowledge-ops employee, working on brain '{brain}'. Propose-only mode: you may read anything and add notes, but every destructive change must be emitted as a proposal line, never performed.

Do this, in order, and narrate each step in one short line:
1. session_start, then find_clutter (limit 20), find_contradictions (limit 10), find_orphan_links (limit 20).
2. For each REAL issue found (skip trivia), emit exactly one line:
PROPOSAL: {{"action":"<supersede_note|set_kind|add_tag|add_link|archive_engram>","title":"<8 words max>","reason":"<one sentence>","args":{{...}}}}
   - supersede_note args: old_id, new_id (write the replacement note FIRST via remember, then propose), reason.
   - archive_engram args: engram_id. set_kind args: engram_id, kind. add_tag args: engram_id, tag. add_link args: from_id, to_id.
   Emit at most 10 proposals; pick the highest-value ones.
3. Write a short digest note via remember: title 'Curator digest {date}', folder 'curator', content = what you checked, counts, and what you proposed. Do not duplicate an existing digest for today (check_duplicate first).
4. End with one line: SUMMARY: <what you did in under 25 words>.

Rules: never invent engram ids (only ids you saw in tool results); at most 3 recalls beyond the listed steps; no other output formats."#,
        brain = brain,
        date = now_iso().split('T').next().unwrap_or("today")
    )
}

fn meetings_prompt(brain: &str, archived: &[(String, PathBuf)]) -> String {
    let files = archived
        .iter()
        .map(|(orig, p)| format!("- {} (archived at {})", orig, p.display()))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        r#"You are the Scribe, NeuroVault's meetings-desk employee, working on brain '{brain}'. Process these meeting transcripts (raw files are archived verbatim; NEVER edit them):
{files}

For each transcript, in order:
1. Read the archived file.
2. recall 2-4 times for context: prior meetings on the same topics, the entities involved, related decisions.
3. Write ONE distilled note via remember (folder 'meetings', deduplicate 0.92): title '<date> - <meeting topic>'; content sections: Decisions (with the why), Action items (owner - task), Open questions, Context links ([[wikilinks]] to related notes you found), and a 'Source' line citing the archive path.
4. If a decision in this meeting REPLACES an earlier decision you found in recall, emit:
PROPOSAL: {{"action":"supersede_note","title":"<8 words>","reason":"<one sentence>","args":{{"old_id":"<id from recall>","new_id":"<id returned by your remember call>"}}}}
5. For each action item with a clear owner, call handoff (to_agent = the owner's name, lowercased; content = the task + meeting context).
Then end with one line: SUMMARY: <n> transcripts distilled, <n> proposals, <n> handoffs.

Rules: never invent engram ids; keep each distilled note under 500 words; no other output formats."#
    )
}

fn librarian_prompt(brain: &str, pending: usize) -> String {
    format!(
        r#"You are the Librarian, NeuroVault's ingest-desk employee, working on brain '{brain}'. The raw drop inbox has {pending} unprocessed file(s).

Do this:
1. session_start, then list_inbox.
2. For up to 5 files: read_inbox_file, then write ONE clean note via remember (deduplicate 0.92): a faithful, well-structured distillation with a clear title, [[wikilinks]] to related notes you find via recall (max 2 recalls per file), and a 'Source' line naming the original file. Then mark_inbox_done for that file.
3. End with one line: SUMMARY: <n> files ingested, <n> skipped.

Rules: never delete anything; if a file is unreadable or binary, skip it and say so; keep each note under 400 words; no other output formats."#
    )
}

// ---------------------------------------------------------------------------
// Deep runner (MCP-connected agent session, per instance)
// ---------------------------------------------------------------------------

pub fn start_run(id: &str, task: &str) -> std::result::Result<(), String> {
    let hire = get_hire(id).ok_or_else(|| format!("no employee '{id}'"))?;
    let cfg = hire.config.clone();
    let claude = find_claude(&cfg).ok_or("claude CLI not found (PATH or claude_path)")?;
    let brain = super::read_ops::resolve_brain_id(None).map_err(|e| e.to_string())?;

    let already = with_live(id, |st| {
        if st.running {
            true
        } else {
            st.running = true;
            false
        }
    });
    if already {
        return Err("a run is already in progress".into());
    }

    let prompt = match task {
        "meetings" => {
            let pending: Vec<String> = list_meetings(&brain)
                .into_iter()
                .filter(|m| m.status == "pending")
                .map(|m| m.file)
                .collect();
            if pending.is_empty() {
                with_live(id, |st| st.running = false);
                return Err("no pending meeting transcripts".into());
            }
            let mut archived = Vec::new();
            for f in pending {
                match archive_meeting(&brain, &f) {
                    Ok(p) => archived.push((f, p)),
                    Err(e) => push_event(id, "error", format!("archive {f}: {e}")),
                }
            }
            if archived.is_empty() {
                with_live(id, |st| st.running = false);
                return Err("archiving failed for all transcripts".into());
            }
            meetings_prompt(&brain, &archived)
        }
        "ingest" => {
            let pending = super::inbox::list_inbox(&brain)
                .map(|v| v.len())
                .unwrap_or(0);
            if pending == 0 {
                with_live(id, |st| st.running = false);
                return Err("raw inbox is empty".into());
            }
            librarian_prompt(&brain, pending)
        }
        _ => hygiene_prompt(&brain),
    };

    let (kill_tx, kill_rx) = tokio::sync::oneshot::channel::<()>();
    with_live(id, |st| st.kill = Some(kill_tx));

    let task_name = task.to_string();
    let run_id = uuid::Uuid::new_v4().to_string();
    let role_id = hire.role.clone();
    let id_owned = id.to_string();
    push_event(id, "info", format!("run {run_id} started: {task_name}"));

    tokio::spawn(async move {
        let started = std::time::Instant::now();
        let ok = run_agent(&id_owned, &role_id, &claude, &cfg, &prompt, &brain, kill_rx).await;
        let dur = started.elapsed().as_secs();
        let summary = with_live(&id_owned, |st| {
            st.events
                .iter()
                .rev()
                .find(|e| e.kind == "result")
                .map(|e| e.line.clone())
                .unwrap_or_else(|| {
                    if ok {
                        "run completed".into()
                    } else {
                        "run failed".into()
                    }
                })
        });
        let proposals_open = list_proposals(&id_owned, Some("open")).len();
        let _ = append_jsonl(
            &runs_path(&id_owned),
            &json!({
                "id": run_id, "ts": now_iso(), "task": task_name, "ok": ok,
                "summary": summary, "duration_s": dur, "proposals": proposals_open,
            }),
        );
        with_live(&id_owned, |st| {
            st.running = false;
            st.kill = None;
        });
    });
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn run_agent(
    id: &str,
    role_id: &str,
    claude: &PathBuf,
    cfg: &EmployeeConfig,
    prompt: &str,
    brain: &str,
    kill_rx: tokio::sync::oneshot::Receiver<()>,
) -> bool {
    use tokio::io::AsyncBufReadExt;

    budget_bump(id);
    let mut cmd = tokio::process::Command::new(claude);
    cmd.arg("-p")
        .arg(prompt)
        .arg("--model")
        .arg(&cfg.deep_model)
        .arg("--allowedTools")
        .arg(allowed_tools(role_id))
        .arg("--max-turns")
        .arg(cfg.max_turns.to_string())
        .env("NEUROVAULT_MCP_TIER", "full")
        .current_dir(nv_home())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    // Deep runs need exactly ONE MCP server: ours. A strict config keeps
    // the user's other servers out of the context (token cost) and works
    // even if they never registered neurovault with Claude Code.
    if let Some(server) = neurovault_server_path() {
        cmd.arg("--mcp-config")
            .arg(
                json!({"mcpServers": {"neurovault": {
                    "command": server.display().to_string(),
                    "args": ["--mcp-only"],
                    "env": {"NEUROVAULT_MCP_TIER": "full"},
                }}})
                .to_string(),
            )
            .arg("--strict-mcp-config");
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            push_event(id, "error", format!("spawn claude: {e}"));
            return false;
        }
    };

    let stdout = child.stdout.take();
    let brain_owned = brain.to_string();
    let id_owned = id.to_string();
    let reader = tokio::spawn(async move {
        if let Some(out) = stdout {
            let mut lines = tokio::io::BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let l = line.trim();
                if l.is_empty() {
                    continue;
                }
                if l.starts_with("PROPOSAL:") {
                    match parse_proposal_line(l, &brain_owned) {
                        Some(p) if EXECUTABLE_ACTIONS.contains(&p.action.as_str()) => {
                            push_event(&id_owned, "proposal", format!("{}: {}", p.action, p.title));
                            let _ = append_jsonl(&proposals_path(&id_owned), &p);
                        }
                        Some(p) => {
                            push_event(
                                &id_owned,
                                "error",
                                format!("unknown proposal action '{}'", p.action),
                            );
                        }
                        None => {
                            push_event(&id_owned, "error", "unparseable PROPOSAL line".to_string())
                        }
                    }
                } else if let Some(s) = l.strip_prefix("SUMMARY:") {
                    push_event(&id_owned, "result", s.trim().to_string());
                } else {
                    let kind = if l.contains("mcp__neurovault__") {
                        "tool"
                    } else {
                        "info"
                    };
                    push_event(&id_owned, kind, l.chars().take(300).collect::<String>());
                }
            }
        }
    });

    let timeout = tokio::time::Duration::from_secs(cfg.timeout_minutes * 60);
    let result = tokio::select! {
        status = child.wait() => match status {
            Ok(s) if s.success() => true,
            Ok(s) => { push_event(id, "error", format!("claude exited: {s}")); false }
            Err(e) => { push_event(id, "error", format!("wait: {e}")); false }
        },
        _ = tokio::time::sleep(timeout) => {
            push_event(id, "error", format!("timeout after {} min; killing run", cfg.timeout_minutes));
            let _ = child.kill().await;
            false
        },
        _ = kill_rx => {
            push_event(id, "info", "stopped by user");
            let _ = child.kill().await;
            false
        },
    };
    let _ = reader.await;
    result
}

pub fn stop_run(id: &str) -> bool {
    with_live(id, |st| {
        if let Some(tx) = st.kill.take() {
            let _ = tx.send(());
            true
        } else {
            false
        }
    })
}

// ---------------------------------------------------------------------------
// Curator's sentinel + judge (the economy loop)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkItem {
    pub id: String,
    pub key: String,
    pub ts: String,
    pub kind: String, // duplicate | contradiction | orphan
    pub payload: Value,
    pub status: String, // open | judged
}

fn list_queue(id: &str, status: Option<&str>) -> Vec<WorkItem> {
    let all: Vec<WorkItem> = read_jsonl(&queue_path(id));
    let mut latest: HashMap<String, WorkItem> = Default::default();
    for w in all {
        latest.insert(w.key.clone(), w);
    }
    let mut out: Vec<WorkItem> = latest
        .into_values()
        .filter(|w| status.is_none_or(|s| w.status == s))
        .collect();
    out.sort_by(|a, b| a.ts.cmp(&b.ts));
    out
}

async fn sentinel_fetch(client: &reqwest::Client, path: &str) -> Option<Value> {
    let url = format!(
        "http://127.0.0.1:{}{path}",
        super::http_server::DEFAULT_PORT
    );
    client
        .get(url)
        .send()
        .await
        .ok()?
        .json::<Value>()
        .await
        .ok()
}

/// One free sentinel sweep for the Curator: local detectors via
/// loopback, dedupe-keyed into the queue.
pub async fn sentinel_scan(id: &str) -> usize {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
    {
        Ok(c) => c,
        Err(_) => return 0,
    };
    let known: std::collections::HashSet<String> =
        list_queue(id, None).into_iter().map(|w| w.key).collect();
    let mut fresh = 0usize;
    let qp = queue_path(id);
    let mut enqueue = |kind: &str, key: String, payload: Value| {
        if known.contains(&key) {
            return;
        }
        let item = WorkItem {
            id: uuid::Uuid::new_v4().to_string(),
            key,
            ts: now_iso(),
            kind: kind.to_string(),
            payload,
            status: "open".to_string(),
        };
        if append_jsonl(&qp, &item).is_ok() {
            fresh += 1;
        }
    };

    if let Some(v) = sentinel_fetch(&client, "/api/clutter").await {
        if let Some(dups) = v.get("duplicate_titles").and_then(|d| d.as_array()) {
            for d in dups.iter().take(20) {
                let eid = d.get("id").and_then(|x| x.as_str()).unwrap_or_default();
                if eid.is_empty() {
                    continue;
                }
                enqueue(
                    "duplicate",
                    format!("dup:{eid}"),
                    json!({
                        "id": eid,
                        "title": d.get("title").and_then(|x| x.as_str()).unwrap_or(""),
                        "detail": truncate_chars(
                            d.get("reason").and_then(|x| x.as_str()).unwrap_or(""), 200),
                    }),
                );
            }
        }
    }
    if let Some(v) = sentinel_fetch(&client, "/api/contradictions?resolved=false").await {
        if let Some(rows) = v.as_array().or_else(|| {
            v.get("contradictions")
                .and_then(|c| c.as_array())
                .or_else(|| v.get("items").and_then(|c| c.as_array()))
        }) {
            for c in rows.iter().take(20) {
                let cid = c.get("id").and_then(|x| x.as_str()).unwrap_or_default();
                if cid.is_empty() {
                    continue;
                }
                enqueue(
                    "contradiction",
                    format!("contra:{cid}"),
                    json!({
                        "a_id": c.get("engram_a_id").and_then(|x| x.as_str()).unwrap_or(""),
                        "a": truncate_chars(c.get("fact_a").and_then(|x| x.as_str()).unwrap_or(""), 200),
                        "b_id": c.get("engram_b_id").and_then(|x| x.as_str()).unwrap_or(""),
                        "b": truncate_chars(c.get("fact_b").and_then(|x| x.as_str()).unwrap_or(""), 200),
                    }),
                );
            }
        }
    }
    if let Some(v) = sentinel_fetch(&client, "/api/orphan_links").await {
        if let Some(rows) = v.get("orphans").and_then(|o| o.as_array()).or_else(|| {
            v.get("orphan_links")
                .and_then(|o| o.as_array())
                .or_else(|| v.as_array())
        }) {
            for o in rows.iter().take(20) {
                let from = o
                    .get("engram_id")
                    .or_else(|| o.get("from_id"))
                    .and_then(|x| x.as_str())
                    .unwrap_or_default();
                let target = o
                    .get("target")
                    .or_else(|| o.get("link"))
                    .and_then(|x| x.as_str())
                    .unwrap_or_default();
                if from.is_empty() || target.is_empty() {
                    continue;
                }
                enqueue(
                    "orphan",
                    format!("orphan:{from}:{target}"),
                    json!({
                        "from_id": from,
                        "from_title": o.get("title").and_then(|x| x.as_str()).unwrap_or(""),
                        "target": target,
                    }),
                );
            }
        }
    }
    fresh
}

fn judge_prompt(items: &[WorkItem]) -> String {
    let mut body = String::from(
        "You are the Curator's judge for a personal knowledge base. For each numbered \
         item output EXACTLY one JSON line, nothing else. Be conservative: when unsure, \
         choose the keep/skip verdict.\n\n",
    );
    for (n, w) in items.iter().enumerate() {
        let i = n + 1;
        match w.kind.as_str() {
            "duplicate" => body.push_str(&format!(
                "Item {i} (duplicate title cluster): note id={} title={:?} detail={:?}\n\
                 Verdicts: {{\"i\":{i},\"verdict\":\"archive\"}} if it is redundant clutter, \
                 or {{\"i\":{i},\"verdict\":\"keep\"}}.\n\n",
                w.payload.get("id").and_then(|x| x.as_str()).unwrap_or(""),
                w.payload
                    .get("title")
                    .and_then(|x| x.as_str())
                    .unwrap_or(""),
                w.payload
                    .get("detail")
                    .and_then(|x| x.as_str())
                    .unwrap_or(""),
            )),
            "contradiction" => body.push_str(&format!(
                "Item {i} (contradiction): A(id={}): {:?}  B(id={}): {:?}\n\
                 Verdicts: {{\"i\":{i},\"verdict\":\"supersede\",\"winner\":\"a\"}} (or \"b\") \
                 when one clearly replaces the other (newer decision, corrected fact), or \
                 {{\"i\":{i},\"verdict\":\"coexist\"}} when both can be true.\n\n",
                w.payload.get("a_id").and_then(|x| x.as_str()).unwrap_or(""),
                w.payload.get("a").and_then(|x| x.as_str()).unwrap_or(""),
                w.payload.get("b_id").and_then(|x| x.as_str()).unwrap_or(""),
                w.payload.get("b").and_then(|x| x.as_str()).unwrap_or(""),
            )),
            _ => body.push_str(&format!(
                "Item {i} (broken wikilink): note {:?} links to missing note {:?}.\n\
                 Verdicts: {{\"i\":{i},\"verdict\":\"drop_link\"}} if the target looks like \
                 a typo or abandoned stub, or {{\"i\":{i},\"verdict\":\"keep\"}} if a note \
                 with that name should plausibly exist later.\n\n",
                w.payload
                    .get("from_title")
                    .and_then(|x| x.as_str())
                    .unwrap_or(""),
                w.payload
                    .get("target")
                    .and_then(|x| x.as_str())
                    .unwrap_or(""),
            )),
        }
    }
    body
}

fn verdict_to_proposal(w: &WorkItem, verdict: &Value, brain: &str) -> Option<Proposal> {
    let v = verdict.get("verdict")?.as_str()?;
    let (action, title, args) = match (w.kind.as_str(), v) {
        ("duplicate", "archive") => (
            "archive_engram",
            format!(
                "Archive redundant: {}",
                w.payload
                    .get("title")
                    .and_then(|x| x.as_str())
                    .unwrap_or("note")
            ),
            json!({"engram_id": w.payload.get("id")}),
        ),
        ("contradiction", "supersede") => {
            let winner = verdict
                .get("winner")
                .and_then(|x| x.as_str())
                .unwrap_or("a");
            let (win, lose) = if winner == "b" {
                ("b_id", "a_id")
            } else {
                ("a_id", "b_id")
            };
            (
                "supersede_note",
                "Supersede contradicted fact".to_string(),
                json!({
                    "old_id": w.payload.get(lose),
                    "new_id": w.payload.get(win),
                    "reason": "curator: newer/winning fact supersedes the contradicted one",
                }),
            )
        }
        // Orphan wikilinks live inside note CONTENT; "fixing" one means
        // editing content, which stays above v0's pay grade. Verdicts
        // on orphans surface in the feed only.
        _ => return None,
    };
    Some(Proposal {
        id: uuid::Uuid::new_v4().to_string(),
        ts: now_iso(),
        action: action.to_string(),
        title,
        reason: format!("judge verdict on {} item", w.kind),
        args,
        status: "open".to_string(),
        brain: brain.to_string(),
    })
}

/// One judge batch for the Curator: N open items, one toolless call,
/// verdicts -> proposals. Returns (judged, proposals).
pub async fn judge_batch(id: &str) -> (usize, usize) {
    let Some(hire) = get_hire(id) else {
        return (0, 0);
    };
    let cfg = hire.config;
    if !budget_left(id, &cfg) {
        push_event(
            id,
            "info",
            "daily budget reached; queue holds until tomorrow",
        );
        return (0, 0);
    }
    let open = list_queue(id, Some("open"));
    if open.is_empty() {
        return (0, 0);
    }
    let batch: Vec<WorkItem> = open.into_iter().take(cfg.max_items_per_run).collect();
    let brain = super::read_ops::resolve_brain_id(None).unwrap_or_default();
    push_event(
        id,
        "info",
        format!("judge batch: {} item(s) on {}", batch.len(), cfg.model),
    );
    let Some(stdout) = toolless_call(id, &cfg, judge_prompt(&batch)).await else {
        return (0, 0);
    };

    let mut verdicts: HashMap<usize, Value> = Default::default();
    for line in stdout.lines() {
        let l = line.trim();
        if !l.starts_with('{') {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(l) {
            if let Some(i) = v.get("i").and_then(|x| x.as_u64()) {
                verdicts.insert(i as usize, v);
            }
        }
    }

    let mut proposals = 0usize;
    let mut judged = 0usize;
    for (n, w) in batch.iter().enumerate() {
        let Some(v) = verdicts.get(&(n + 1)) else {
            continue;
        };
        judged += 1;
        if let Some(p) = verdict_to_proposal(w, v, &brain) {
            push_event(id, "proposal", format!("{}: {}", p.action, p.title));
            let _ = append_jsonl(&proposals_path(id), &p);
            proposals += 1;
        } else {
            push_event(
                id,
                "result",
                format!(
                    "{}: {}",
                    w.kind,
                    v.get("verdict").and_then(|x| x.as_str()).unwrap_or("skip")
                ),
            );
        }
        let mut done = w.clone();
        done.status = "judged".to_string();
        let _ = append_jsonl(&queue_path(id), &done);
    }
    (judged, proposals)
}

// ---------------------------------------------------------------------------
// Chronicler + Quartermaster (toolless roles: model writes, Rust files)
// ---------------------------------------------------------------------------

fn instance_state(id: &str) -> Value {
    std::fs::read_to_string(state_path(id))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(json!({}))
}

fn save_instance_state(id: &str, v: &Value) {
    let _ = std::fs::create_dir_all(instance_dir(id));
    let _ = std::fs::write(state_path(id), v.to_string());
}

/// Server-side note write: the model produced text; Rust files it into
/// the vault through the normal indexed write path. Zero MCP.
fn write_note(brain: &str, rel_filename: &str, content: &str) -> Result<()> {
    let ctx = super::write_ops::BrainContext::resolve(Some(brain), super::paths::vault_dir(brain))?;
    super::write_ops::save_note(&ctx, rel_filename, content)?;
    Ok(())
}

/// Chronicler: summarize what entered the brain since the last wake
/// into a daily digest note. One toolless call; skips quiet periods.
async fn chronicler_tick(id: &str) -> Value {
    let Some(hire) = get_hire(id) else {
        return json!({});
    };
    let cfg = hire.config;
    let brain = super::read_ops::resolve_brain_id(None).unwrap_or_default();
    let state = instance_state(id);
    let since = state
        .get("last_seen")
        .and_then(|v| v.as_str())
        .unwrap_or("1970-01-01T00:00:00Z")
        .to_string();

    // Free: new engrams since last wake, straight from SQL. Both sides
    // normalized through datetime() because created_at is stored
    // space-separated ("2026-07-06 12:00:00") while our cutoff is
    // ISO-8601 with T/Z — a raw lexicographic compare would be wrong.
    let rows: Vec<(String, String)> = match open_brain(&brain) {
        Ok(db) => {
            let conn = db.lock();
            let mut stmt = match conn.prepare(
                "SELECT title, created_at FROM engrams
                 WHERE state != 'dormant' AND datetime(created_at) > datetime(?1)
                 ORDER BY created_at ASC LIMIT 40",
            ) {
                Ok(s) => s,
                Err(_) => return json!({}),
            };
            stmt.query_map([&since], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map(|it| it.flatten().collect())
            .unwrap_or_default()
        }
        Err(_) => return json!({}),
    };
    if rows.len() < 3 {
        return json!({"skipped": "quiet period"}); // not worth a call
    }
    if !budget_left(id, &cfg) {
        push_event(id, "info", "daily budget reached");
        return json!({});
    }
    let titles = rows
        .iter()
        .map(|(t, ts)| format!("- {} ({})", t, ts))
        .collect::<Vec<_>>()
        .join("\n");
    let prompt = format!(
        "You are the Chronicler for a personal knowledge base. These notes were added \
         since the last digest:\n{titles}\n\nWrite a compact daily-digest in markdown \
         (max 180 words): a 2-sentence overview, then grouped bullets by theme. \
         Plain markdown only, no preamble."
    );
    push_event(
        id,
        "info",
        format!("chronicling {} new note(s)", rows.len()),
    );
    let Some(text) = toolless_call(id, &cfg, prompt).await else {
        return json!({});
    };
    let date = now_iso().split('T').next().unwrap_or("today").to_string();
    let fname = format!("chronicle/{date}-digest.md");
    match write_note(&brain, &fname, &text) {
        Ok(()) => {
            push_event(id, "result", format!("digest written: {fname}"));
            save_instance_state(id, &json!({"last_seen": now_iso()}));
            json!({"digest": fname, "notes": rows.len()})
        }
        Err(e) => {
            push_event(id, "error", format!("digest write: {e}"));
            json!({})
        }
    }
}

/// Quartermaster: audit todos/handoffs for staleness; one toolless
/// call turns findings into a nudge report note.
async fn quartermaster_tick(id: &str) -> Value {
    let Some(hire) = get_hire(id) else {
        return json!({});
    };
    let cfg = hire.config;
    let brain = super::read_ops::resolve_brain_id(None).unwrap_or_default();
    let todos = super::todos::list_todos(&brain, None).unwrap_or_default();
    let week_ago = iso_from_secs(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
            .saturating_sub(7 * 86_400),
    );
    let stale: Vec<String> = todos
        .iter()
        .filter(|t| {
            (t.status == "open" || t.status == "in_progress")
                && t.claimed_at
                    .as_deref()
                    .map(|c| c < week_ago.as_str())
                    .unwrap_or(t.status == "open")
        })
        .take(15)
        .map(|t| {
            format!(
                "- [{}] {} (for: {}, status: {})",
                t.priority,
                truncate_chars(&t.text, 120),
                if t.agent_match.is_empty() {
                    "anyone"
                } else {
                    &t.agent_match
                },
                t.status
            )
        })
        .collect();
    if stale.is_empty() {
        return json!({"skipped": "queue healthy"});
    }
    if !budget_left(id, &cfg) {
        push_event(id, "info", "daily budget reached");
        return json!({});
    }
    let prompt = format!(
        "You are the Quartermaster for a team's work queue. These items look stale:\n{}\n\n\
         Write a short queue report in markdown (max 150 words): which items look \
         abandoned vs merely slow, and one suggested next step each. Plain markdown, \
         no preamble.",
        stale.join("\n")
    );
    push_event(
        id,
        "info",
        format!("auditing {} stale item(s)", stale.len()),
    );
    let Some(text) = toolless_call(id, &cfg, prompt).await else {
        return json!({});
    };
    let date = now_iso().split('T').next().unwrap_or("today").to_string();
    let fname = format!("quartermaster/{date}-queue-report.md");
    match write_note(&brain, &fname, &text) {
        Ok(()) => {
            push_event(id, "result", format!("queue report written: {fname}"));
            json!({"report": fname, "stale": stale.len()})
        }
        Err(e) => {
            push_event(id, "error", format!("report write: {e}"));
            json!({})
        }
    }
}

// ---------------------------------------------------------------------------
// The tick dispatcher + scheduler
// ---------------------------------------------------------------------------

/// One wake of employee `id`, dispatched by role. Free watching first;
/// the model only runs when there is actual work and budget.
pub async fn dispatch_tick(id: &str) -> Value {
    let Some(hire) = get_hire(id) else {
        return json!({"error": "no such employee"});
    };
    with_live(id, |st| {
        st.last_tick = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    });
    let brain = super::read_ops::resolve_brain_id(None).unwrap_or_default();
    match hire.role.as_str() {
        "curator" => {
            let queued = sentinel_scan(id).await;
            if queued > 0 {
                push_event(id, "info", format!("sentinel queued {queued} new item(s)"));
            }
            let (judged, proposals) = judge_batch(id).await;
            json!({"queued": queued, "judged": judged, "proposals": proposals})
        }
        "scribe" => {
            let pending = count_pending_meetings(&brain);
            if pending == 0 {
                return json!({"skipped": "no pending transcripts"});
            }
            match start_run(id, "meetings") {
                Ok(()) => json!({"started": "meetings", "pending": pending}),
                Err(e) => json!({"error": e}),
            }
        }
        "librarian" => {
            let pending = super::inbox::list_inbox(&brain)
                .map(|v| v.len())
                .unwrap_or(0);
            if pending == 0 {
                return json!({"skipped": "inbox empty"});
            }
            match start_run(id, "ingest") {
                Ok(()) => json!({"started": "ingest", "pending": pending}),
                Err(e) => json!({"error": e}),
            }
        }
        "chronicler" => chronicler_tick(id).await,
        "quartermaster" => quartermaster_tick(id).await,
        other => json!({"error": format!("role '{other}' has no loop yet")}),
    }
}

/// Start the fleet scheduler once. Every minute it walks the roster and
/// wakes each enabled employee whose cadence has elapsed.
pub fn start_scheduler() {
    if SCHEDULER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(60)).await;
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let roster = load_roster();
            for h in roster {
                if !h.config.enabled {
                    continue;
                }
                let (due, busy) = with_live(&h.id, |st| {
                    (
                        now.saturating_sub(st.last_tick) >= (h.config.wake_minutes as u64) * 60,
                        st.running,
                    )
                });
                if due && !busy {
                    let _ = dispatch_tick(&h.id).await;
                }
            }
        }
    });
}

// ---------------------------------------------------------------------------
// HTTP endpoints
// ---------------------------------------------------------------------------

use axum::extract::{Path as AxPath, Query as AxQuery, State};
use axum::http::StatusCode;
use axum::Json;

use super::handlers::{ApiError, ServerState};

#[derive(Serialize)]
pub struct StatusResponse {
    id: String,
    role: String,
    name: String,
    title: String,
    palette: String,
    palette_soft: String,
    glyph_seed: u32,
    enabled: bool,
    state: String,
    autonomy: u8,
    interval_hours: u32,
    last_run: Option<Value>,
    next_run_ts: Option<String>,
    claude_found: bool,
    meetings_pending: usize,
    proposals_open: usize,
    model: String,
    deep_model: String,
    wake_minutes: u32,
    queue_depth: usize,
    judged_total: usize,
    calls_today: u32,
    daily_call_budget: u32,
    last_tick_ts: Option<String>,
}

fn status_snapshot(id: &str) -> Option<StatusResponse> {
    let hire = get_hire(id)?;
    let def = role(&hire.role)?;
    let cfg = &hire.config;
    let runs: Vec<Value> = read_jsonl(&runs_path(id));
    let last_run = runs.last().cloned();
    let brain = super::read_ops::resolve_brain_id(None).unwrap_or_default();
    let show_meetings = hire.role == "scribe" || hire.role == "curator";
    let pending_meetings = if brain.is_empty() || !show_meetings {
        0
    } else {
        count_pending_meetings(&brain)
    };
    let (running, last_tick) = with_live(id, |st| (st.running, st.last_tick));
    let (_, calls_today) = budget_today(id);
    Some(StatusResponse {
        id: hire.id.clone(),
        role: hire.role.clone(),
        name: def.name.to_string(),
        title: def.title.to_string(),
        palette: def.palette.to_string(),
        palette_soft: def.palette_soft.to_string(),
        glyph_seed: def.glyph_seed,
        enabled: cfg.enabled,
        state: if running { "running" } else { "idle" }.into(),
        autonomy: cfg.autonomy,
        interval_hours: cfg.interval_hours,
        next_run_ts: None,
        claude_found: find_claude(cfg).is_some(),
        meetings_pending: pending_meetings,
        proposals_open: list_proposals(id, Some("open")).len(),
        last_run,
        model: cfg.model.clone(),
        deep_model: cfg.deep_model.clone(),
        wake_minutes: cfg.wake_minutes,
        queue_depth: list_queue(id, Some("open")).len(),
        judged_total: list_queue(id, Some("judged")).len(),
        calls_today,
        daily_call_budget: cfg.daily_call_budget,
        last_tick_ts: if last_tick == 0 {
            None
        } else {
            Some(iso_from_secs(last_tick))
        },
    })
}

fn snapshot_or_404(id: &str) -> std::result::Result<Json<StatusResponse>, ApiError> {
    status_snapshot(id)
        .map(Json)
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, format!("no employee '{id}'")))
}

#[derive(Deserialize)]
pub struct ConfigBody {
    enabled: Option<bool>,
    interval_hours: Option<u32>,
    wake_minutes: Option<u32>,
    model: Option<String>,
    daily_call_budget: Option<u32>,
}

fn apply_config(id: &str, body: ConfigBody) -> std::result::Result<Json<StatusResponse>, ApiError> {
    update_config(id, |cfg| {
        if let Some(e) = body.enabled {
            cfg.enabled = e;
        }
        if let Some(h) = body.interval_hours {
            cfg.interval_hours = h.clamp(1, 168);
        }
        if let Some(m) = body.wake_minutes {
            cfg.wake_minutes = m.clamp(5, 720);
        }
        if let Some(m) = body.model {
            let m = m.trim().to_string();
            if !m.is_empty() {
                cfg.model = m;
            }
        }
        if let Some(b) = body.daily_call_budget {
            cfg.daily_call_budget = b.clamp(1, 5000);
        }
    })
    .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e.to_string()))?;
    snapshot_or_404(id)
}

#[derive(Deserialize)]
pub struct RunBody {
    task: Option<String>,
}

#[derive(Deserialize)]
pub struct ActivityQuery {
    since: Option<u64>,
}

#[derive(Deserialize)]
pub struct RunsQuery {
    limit: Option<usize>,
}

fn activity_json(id: &str, since: u64) -> Json<Value> {
    let (events, running) = with_live(id, |st| {
        (
            st.events
                .iter()
                .filter(|e| e.seq > since)
                .cloned()
                .collect::<Vec<_>>(),
            st.running,
        )
    });
    Json(json!({
        "events": events,
        "state": if running { "running" } else { "idle" },
    }))
}

fn runs_json(id: &str, limit: usize) -> Json<Value> {
    let mut runs: Vec<Value> = read_jsonl(&runs_path(id));
    runs.reverse();
    runs.truncate(limit);
    Json(json!({ "runs": runs }))
}

fn approve_impl(id: &str, pid: &str) -> std::result::Result<Json<Value>, ApiError> {
    let open = list_proposals(id, Some("open"));
    let Some(p) = open.into_iter().find(|p| p.id == pid) else {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            format!("no open proposal {pid}"),
        ));
    };
    let outcome = execute_proposal(&p);
    if outcome.is_ok() {
        let mut done = p.clone();
        done.status = "approved".into();
        let _ = append_jsonl(&proposals_path(id), &done);
    }
    match outcome {
        Ok(msg) => Ok(Json(json!({"ok": true, "applied": msg}))),
        Err(e) => Ok(Json(json!({"ok": false, "error": e.to_string()}))),
    }
}

fn reject_impl(id: &str, pid: &str) -> std::result::Result<Json<Value>, ApiError> {
    let open = list_proposals(id, Some("open"));
    let Some(mut p) = open.into_iter().find(|p| p.id == pid) else {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            format!("no open proposal {pid}"),
        ));
    };
    p.status = "rejected".into();
    append_jsonl(&proposals_path(id), &p)
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({"ok": true})))
}

// ---- Fleet endpoints ------------------------------------------------------

/// GET /api/employees — the hire catalog + current roster.
pub async fn employees_index(_s: State<ServerState>) -> Json<Value> {
    let roster: Vec<Value> = load_roster()
        .iter()
        .filter_map(|h| status_snapshot(&h.id).map(|s| serde_json::to_value(s).unwrap_or_default()))
        .collect();
    Json(json!({ "catalog": ROLES, "roster": roster }))
}

#[derive(Deserialize)]
pub struct HireBody {
    role: String,
}

/// POST /api/employees — hire from the catalog.
pub async fn employees_hire(
    _s: State<ServerState>,
    Json(body): Json<HireBody>,
) -> std::result::Result<Json<Value>, ApiError> {
    let h = hire(&body.role).map_err(|e| ApiError(StatusCode::BAD_REQUEST, e.to_string()))?;
    push_event(&h.id, "info", format!("{} hired", h.id));
    Ok(Json(json!({ "hired": h })))
}

/// DELETE /api/employees/:id — fire (files kept; rehire restores).
pub async fn employees_fire(
    _s: State<ServerState>,
    AxPath(id): AxPath<String>,
) -> std::result::Result<Json<Value>, ApiError> {
    fire(&id).map_err(|e| ApiError(StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok(Json(json!({ "fired": id })))
}

pub async fn employees_status(
    _s: State<ServerState>,
    AxPath(id): AxPath<String>,
) -> std::result::Result<Json<StatusResponse>, ApiError> {
    snapshot_or_404(&id)
}

pub async fn employees_config(
    _s: State<ServerState>,
    AxPath(id): AxPath<String>,
    Json(body): Json<ConfigBody>,
) -> std::result::Result<Json<StatusResponse>, ApiError> {
    apply_config(&id, body)
}

pub async fn employees_tick(_s: State<ServerState>, AxPath(id): AxPath<String>) -> Json<Value> {
    Json(dispatch_tick(&id).await)
}

pub async fn employees_run(
    _s: State<ServerState>,
    AxPath(id): AxPath<String>,
    Json(body): Json<RunBody>,
) -> Json<Value> {
    let task = body.task.unwrap_or_else(|| "hygiene".into());
    match start_run(&id, &task) {
        Ok(()) => Json(json!({"started": true})),
        Err(reason) => Json(json!({"started": false, "reason": reason})),
    }
}

pub async fn employees_stop(_s: State<ServerState>, AxPath(id): AxPath<String>) -> Json<Value> {
    Json(json!({"stopped": stop_run(&id)}))
}

pub async fn employees_activity(
    _s: State<ServerState>,
    AxPath(id): AxPath<String>,
    AxQuery(q): AxQuery<ActivityQuery>,
) -> Json<Value> {
    activity_json(&id, q.since.unwrap_or(0))
}

pub async fn employees_runs(
    _s: State<ServerState>,
    AxPath(id): AxPath<String>,
    AxQuery(q): AxQuery<RunsQuery>,
) -> Json<Value> {
    runs_json(&id, q.limit.unwrap_or(20))
}

pub async fn employees_proposals(
    _s: State<ServerState>,
    AxPath(id): AxPath<String>,
) -> Json<Value> {
    Json(json!({ "proposals": list_proposals(&id, Some("open")) }))
}

pub async fn employees_proposal_approve(
    _s: State<ServerState>,
    AxPath((id, pid)): AxPath<(String, String)>,
) -> std::result::Result<Json<Value>, ApiError> {
    tokio::task::spawn_blocking(move || approve_impl(&id, &pid))
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
}

pub async fn employees_proposal_reject(
    _s: State<ServerState>,
    AxPath((id, pid)): AxPath<(String, String)>,
) -> std::result::Result<Json<Value>, ApiError> {
    reject_impl(&id, &pid)
}

/// GET /api/employees/:id/meetings — Scribe's desk (brain-scoped).
pub async fn employees_meetings(
    _s: State<ServerState>,
    AxPath(_id): AxPath<String>,
) -> Json<Value> {
    let brain = super::read_ops::resolve_brain_id(None).unwrap_or_default();
    let inbox = meetings_inbox(&brain);
    let _ = std::fs::create_dir_all(&inbox);
    Json(json!({
        "meetings": list_meetings(&brain),
        "inbox_dir": inbox.display().to_string(),
    }))
}

// ---- Legacy singleton endpoints (the Curator's alias) ---------------------

pub async fn employee_status(
    _s: State<ServerState>,
) -> std::result::Result<Json<StatusResponse>, ApiError> {
    snapshot_or_404("curator")
}

pub async fn employee_config(
    _s: State<ServerState>,
    Json(body): Json<ConfigBody>,
) -> std::result::Result<Json<StatusResponse>, ApiError> {
    apply_config("curator", body)
}

pub async fn employee_run(_s: State<ServerState>, Json(body): Json<RunBody>) -> Json<Value> {
    let task = body.task.unwrap_or_else(|| "hygiene".into());
    match start_run("curator", &task) {
        Ok(()) => Json(json!({"started": true})),
        Err(reason) => Json(json!({"started": false, "reason": reason})),
    }
}

pub async fn employee_stop(_s: State<ServerState>) -> Json<Value> {
    Json(json!({"stopped": stop_run("curator")}))
}

pub async fn employee_tick(_s: State<ServerState>) -> Json<Value> {
    Json(dispatch_tick("curator").await)
}

pub async fn employee_activity(
    _s: State<ServerState>,
    AxQuery(q): AxQuery<ActivityQuery>,
) -> Json<Value> {
    activity_json("curator", q.since.unwrap_or(0))
}

pub async fn employee_runs(_s: State<ServerState>, AxQuery(q): AxQuery<RunsQuery>) -> Json<Value> {
    runs_json("curator", q.limit.unwrap_or(20))
}

pub async fn employee_proposals(_s: State<ServerState>) -> Json<Value> {
    Json(json!({ "proposals": list_proposals("curator", Some("open")) }))
}

pub async fn employee_proposal_approve(
    _s: State<ServerState>,
    AxPath(pid): AxPath<String>,
) -> std::result::Result<Json<Value>, ApiError> {
    tokio::task::spawn_blocking(move || approve_impl("curator", &pid))
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
}

pub async fn employee_proposal_reject(
    _s: State<ServerState>,
    AxPath(pid): AxPath<String>,
) -> std::result::Result<Json<Value>, ApiError> {
    reject_impl("curator", &pid)
}

pub async fn employee_meetings(_s: State<ServerState>) -> Json<Value> {
    let brain = super::read_ops::resolve_brain_id(None).unwrap_or_default();
    let inbox = meetings_inbox(&brain);
    let _ = std::fs::create_dir_all(&inbox);
    Json(json!({
        "meetings": list_meetings(&brain),
        "inbox_dir": inbox.display().to_string(),
    }))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proposal_line_parses_and_gates_actions() {
        let l = r#"PROPOSAL: {"action":"supersede_note","title":"merge dup decision","reason":"newer note replaces it","args":{"old_id":"a","new_id":"b"}}"#;
        let p = parse_proposal_line(l, "brain-x").expect("parses");
        assert_eq!(p.action, "supersede_note");
        assert_eq!(p.brain, "brain-x");
        assert_eq!(p.status, "open");
        assert!(EXECUTABLE_ACTIONS.contains(&p.action.as_str()));

        let l2 = r#"PROPOSAL: {"action":"rm_rf","title":"nope","args":{}}"#;
        let p2 = parse_proposal_line(l2, "brain-x").unwrap();
        assert!(!EXECUTABLE_ACTIONS.contains(&p2.action.as_str()));

        assert!(parse_proposal_line("PROPOSAL: not json", "b").is_none());
        assert!(parse_proposal_line("no prefix", "b").is_none());
    }

    #[test]
    fn per_role_whitelists_have_no_destructive_tools() {
        for role_id in ["curator", "scribe", "librarian"] {
            let allow = allowed_tools(role_id);
            for banned in [
                "delete_engrams",
                "supersede_note",
                "bulk_set_kind",
                "bulk_add_tag",
                "mcp__neurovault__update",
                "core_memory_set",
                "core_memory_replace",
                "remove_link",
                "optimize_disk",
            ] {
                assert!(
                    !allow.contains(banned),
                    "{role_id} whitelist must not contain {banned}"
                );
            }
            assert!(allow.contains("mcp__neurovault__recall"));
            assert!(allow.contains("mcp__neurovault__remember"));
        }
        // role-specific surface
        assert!(allowed_tools("librarian").contains("mcp__neurovault__mark_inbox_done"));
        assert!(!allowed_tools("scribe").contains("mark_inbox_done"));
        assert!(allowed_tools("curator").contains("find_contradictions"));
    }

    #[test]
    fn config_roundtrip_defaults() {
        let cfg = EmployeeConfig::default();
        assert!(!cfg.enabled);
        assert_eq!(cfg.interval_hours, 24);
        assert_eq!(cfg.autonomy, 0);
        assert_eq!(cfg.model, "haiku");
        assert_eq!(cfg.daily_call_budget, 100);
        let s = serde_json::to_string(&cfg).unwrap();
        let back: EmployeeConfig = serde_json::from_str(&s).unwrap();
        assert_eq!(back.wake_minutes, cfg.wake_minutes);
    }

    #[test]
    fn instance_id_allocation() {
        let existing = vec!["curator".to_string(), "scribe".to_string()];
        assert_eq!(next_instance_id("librarian", &existing), "librarian");
        assert_eq!(next_instance_id("scribe", &existing), "scribe-2");
        let more = vec![
            "scribe".to_string(),
            "scribe-2".to_string(),
            "scribe-3".to_string(),
        ];
        assert_eq!(next_instance_id("scribe", &more), "scribe-4");
    }

    #[test]
    fn iso_timestamp_shape() {
        let ts = now_iso();
        assert_eq!(ts.len(), 20);
        assert!(ts.ends_with('Z'));
        assert_eq!(&ts[4..5], "-");
        assert_eq!(&ts[10..11], "T");
    }
}
