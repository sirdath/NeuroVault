//! The Curator — NeuroVault's first AI employee (knowledge ops).
//!
//! NeuroVault's core stays a coordination/memory SUBSTRATE: the brain
//! never runs agents on its own. This module is the deliberate, opt-in
//! exception the product grew: a thin scheduler + runner that WAKES an
//! external agent (Claude Code in headless `-p` mode) with a runbook,
//! and lets it work against the brain over MCP like any other agent.
//! The agent process is still external; this module only schedules,
//! observes, and gates it.
//!
//! Safety model (v0 = autonomy level 0, "propose-only"):
//! - The tool whitelist per autonomy level is passed to Claude Code as
//!   `--allowedTools`, so enforcement lives in the agent runtime's
//!   permission layer, not in prompt trust. Level 0 can read, add
//!   notes (additive, reversible), and hand off — never supersede,
//!   delete, or bulk-edit.
//! - Destructive intents are emitted by the agent as `PROPOSAL: {json}`
//!   lines on stdout; the runner parses them into an approval queue
//!   (`~/.neurovault/employee/proposals.jsonl`). Approving executes the
//!   action server-side against a hard-coded action whitelist below.
//! - Every run is capped (`--max-turns`, wall-clock timeout) and
//!   journaled to `~/.neurovault/employee/runs.jsonl`.
//!
//! Meetings pathway: transcripts dropped into
//! `~/.neurovault/brains/<active>/inbox/meetings/` are archived
//! verbatim (evidence; never edited) under `archive/meetings/`, then a
//! meetings run distills them into context-aware notes via the normal
//! MCP surface. "NeuroVault holds conclusions, the archive holds
//! evidence."

use std::collections::VecDeque;
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
use super::types::MemoryError;

type Result<T> = std::result::Result<T, MemoryError>;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmployeeConfig {
    /// Master switch. Off by default: an employee is opt-in.
    #[serde(default)]
    pub enabled: bool,
    /// Hours between scheduled hygiene runs.
    #[serde(default = "default_interval")]
    pub interval_hours: u32,
    /// Autonomy level. v0 supports only 0 (propose-only); the field
    /// exists so the trust ladder has a place to live.
    #[serde(default)]
    pub autonomy: u8,
    /// Override path to the `claude` binary; empty = search PATH.
    #[serde(default)]
    pub claude_path: String,
    /// Cap on agent turns per run (passed as --max-turns).
    #[serde(default = "default_max_turns")]
    pub max_turns: u32,
    /// Wall-clock cap per run, minutes.
    #[serde(default = "default_timeout_min")]
    pub timeout_minutes: u64,
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

impl Default for EmployeeConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            interval_hours: default_interval(),
            autonomy: 0,
            claude_path: String::new(),
            max_turns: default_max_turns(),
            timeout_minutes: default_timeout_min(),
        }
    }
}

fn employee_dir() -> PathBuf {
    nv_home().join("employee")
}
fn config_path() -> PathBuf {
    nv_home().join("employee.json")
}
fn proposals_path() -> PathBuf {
    employee_dir().join("proposals.jsonl")
}
fn runs_path() -> PathBuf {
    employee_dir().join("runs.jsonl")
}

pub fn load_config() -> EmployeeConfig {
    std::fs::read_to_string(config_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_config(cfg: &EmployeeConfig) -> Result<()> {
    let _ = std::fs::create_dir_all(nv_home());
    std::fs::write(
        config_path(),
        serde_json::to_string_pretty(cfg).unwrap_or_default(),
    )
    .map_err(|e| MemoryError::Other(format!("write employee.json: {e}")))
}

// ---------------------------------------------------------------------------
// Live state: activity ring + run flag
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct ActivityEvent {
    pub seq: u64,
    pub ts: String,
    pub kind: String, // info | tool | proposal | result | error
    pub line: String,
}

struct LiveState {
    running: bool,
    current_task: Option<String>,
    seq: u64,
    events: VecDeque<ActivityEvent>,
    kill: Option<tokio::sync::oneshot::Sender<()>>,
}

static LIVE: Lazy<Mutex<LiveState>> = Lazy::new(|| {
    Mutex::new(LiveState {
        running: false,
        current_task: None,
        seq: 0,
        events: VecDeque::with_capacity(512),
        kill: None,
    })
});

static SCHEDULER_STARTED: AtomicBool = AtomicBool::new(false);

fn now_iso() -> String {
    // Seconds precision is plenty for an activity feed.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Manual ISO-8601 (UTC) to avoid pulling chrono in here.
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

fn push_event(kind: &str, line: impl Into<String>) {
    let mut st = LIVE.lock();
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
}

// ---------------------------------------------------------------------------
// Proposals (approval queue)
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

/// Actions the approve endpoint will execute. Anything else a runbook
/// emits is stored but can only be rejected — the whitelist is the
/// contract, not the prompt.
const EXECUTABLE_ACTIONS: &[&str] = &[
    "supersede_note",
    "set_kind",
    "add_tag",
    "add_link",
    "archive_engram",
];

fn append_jsonl(path: &PathBuf, v: &impl Serialize) -> Result<()> {
    let _ = std::fs::create_dir_all(employee_dir());
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

/// Effective proposal list: last status wins per id (append-only file;
/// approve/reject append a tombstone row with the new status).
pub fn list_proposals(status: Option<&str>) -> Vec<Proposal> {
    let all: Vec<Proposal> = read_jsonl(&proposals_path());
    let mut latest: std::collections::HashMap<String, Proposal> = Default::default();
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

/// Parse a `PROPOSAL: {...}` stdout line into a queued proposal.
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
            // tags live as comma-separated text; append if absent.
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
// Meetings inbox
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

/// Scan the inbox: anything with a known extension not yet indexed is
/// pending. Archives happen at processing time, not scan time.
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

/// Copy dropped transcript files into the meetings inbox. Runs in Rust
/// (same pattern as inbox::add_files) so the webview needs no fs scope.
/// Returns the filenames actually added; non-transcript extensions are
/// skipped rather than erroring so a mixed drop still succeeds.
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

/// Move a pending transcript into the immutable archive (verbatim copy;
/// the inbox copy is removed) and index it. Returns the archive path
/// the distillation prompt will cite.
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
// Runbooks + tool whitelists
// ---------------------------------------------------------------------------

/// Level-0 whitelist: read + additive only. Enforced by Claude Code's
/// permission layer via --allowedTools; the agent cannot call anything
/// destructive even if the prompt asks it to.
fn allowed_tools(_autonomy: u8) -> String {
    [
        "mcp__neurovault__session_start",
        "mcp__neurovault__recall",
        "mcp__neurovault__recall_chunks",
        "mcp__neurovault__related",
        "mcp__neurovault__status",
        "mcp__neurovault__check_duplicate",
        "mcp__neurovault__find_clutter",
        "mcp__neurovault__find_contradictions",
        "mcp__neurovault__find_orphan_links",
        "mcp__neurovault__engram_history",
        "mcp__neurovault__temporal_recall",
        "mcp__neurovault__remember",
        "mcp__neurovault__handoff",
        "Read",
    ]
    .join(",")
}

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
        r#"You are the Curator, NeuroVault's knowledge-ops employee, working on brain '{brain}'. Process these meeting transcripts (raw files are archived verbatim; NEVER edit them):
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

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

fn find_claude(cfg: &EmployeeConfig) -> Option<PathBuf> {
    if !cfg.claude_path.trim().is_empty() {
        let p = PathBuf::from(cfg.claude_path.trim());
        return p.exists().then_some(p);
    }
    // PATH search without extra deps.
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let cand = dir.join("claude");
        if cand.exists() {
            return Some(cand);
        }
    }
    None
}

/// Kick off a run. Returns Err with a human reason if it can't start.
pub fn start_run(task: &str) -> std::result::Result<(), String> {
    let cfg = load_config();
    let claude = find_claude(&cfg).ok_or("claude CLI not found (PATH or claude_path)")?;
    let brain = super::read_ops::resolve_brain_id(None).map_err(|e| e.to_string())?;

    {
        let mut st = LIVE.lock();
        if st.running {
            return Err("a run is already in progress".into());
        }
        st.running = true;
        st.current_task = Some(task.to_string());
    }

    // Meetings task archives pending transcripts BEFORE the agent runs,
    // so the prompt can cite immutable paths.
    let prompt = match task {
        "meetings" => {
            let pending: Vec<String> = list_meetings(&brain)
                .into_iter()
                .filter(|m| m.status == "pending")
                .map(|m| m.file)
                .collect();
            if pending.is_empty() {
                let mut st = LIVE.lock();
                st.running = false;
                st.current_task = None;
                return Err("no pending meeting transcripts".into());
            }
            let mut archived = Vec::new();
            for f in pending {
                match archive_meeting(&brain, &f) {
                    Ok(p) => archived.push((f, p)),
                    Err(e) => push_event("error", format!("archive {f}: {e}")),
                }
            }
            if archived.is_empty() {
                let mut st = LIVE.lock();
                st.running = false;
                st.current_task = None;
                return Err("archiving failed for all transcripts".into());
            }
            meetings_prompt(&brain, &archived)
        }
        _ => hygiene_prompt(&brain),
    };

    let (kill_tx, kill_rx) = tokio::sync::oneshot::channel::<()>();
    LIVE.lock().kill = Some(kill_tx);

    let task_name = task.to_string();
    let run_id = uuid::Uuid::new_v4().to_string();
    push_event("info", format!("run {run_id} started: {task_name}"));

    tokio::spawn(async move {
        let started = std::time::Instant::now();
        let ok = run_agent(&claude, &cfg, &prompt, &brain, kill_rx).await;
        let dur = started.elapsed().as_secs();
        let summary = {
            let st = LIVE.lock();
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
        };
        let proposals_open = list_proposals(Some("open")).len();
        let _ = append_jsonl(
            &runs_path(),
            &json!({
                "id": run_id, "ts": now_iso(), "task": task_name, "ok": ok,
                "summary": summary, "duration_s": dur, "proposals": proposals_open,
            }),
        );
        let mut st = LIVE.lock();
        st.running = false;
        st.current_task = None;
        st.kill = None;
    });
    Ok(())
}

async fn run_agent(
    claude: &PathBuf,
    cfg: &EmployeeConfig,
    prompt: &str,
    brain: &str,
    kill_rx: tokio::sync::oneshot::Receiver<()>,
) -> bool {
    use tokio::io::AsyncBufReadExt;

    let mut cmd = tokio::process::Command::new(claude);
    cmd.arg("-p")
        .arg(prompt)
        .arg("--allowedTools")
        .arg(allowed_tools(cfg.autonomy))
        .arg("--max-turns")
        .arg(cfg.max_turns.to_string())
        .env("NEUROVAULT_MCP_TIER", "full")
        .current_dir(nv_home())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            push_event("error", format!("spawn claude: {e}"));
            return false;
        }
    };

    let stdout = child.stdout.take();
    let brain_owned = brain.to_string();
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
                            push_event("proposal", format!("{}: {}", p.action, p.title));
                            let _ = append_jsonl(&proposals_path(), &p);
                        }
                        Some(p) => {
                            push_event("error", format!("unknown proposal action '{}'", p.action));
                        }
                        None => push_event("error", "unparseable PROPOSAL line".to_string()),
                    }
                } else if let Some(s) = l.strip_prefix("SUMMARY:") {
                    push_event("result", s.trim().to_string());
                } else {
                    // Claude -p prints the assistant text; each line is
                    // narration worth showing.
                    let kind = if l.contains("mcp__neurovault__") {
                        "tool"
                    } else {
                        "info"
                    };
                    push_event(kind, l.chars().take(300).collect::<String>());
                }
            }
        }
    });

    let timeout = tokio::time::Duration::from_secs(cfg.timeout_minutes * 60);
    let result = tokio::select! {
        status = child.wait() => match status {
            Ok(s) if s.success() => true,
            Ok(s) => { push_event("error", format!("claude exited: {s}")); false }
            Err(e) => { push_event("error", format!("wait: {e}")); false }
        },
        _ = tokio::time::sleep(timeout) => {
            push_event("error", format!("timeout after {} min; killing run", cfg.timeout_minutes));
            let _ = child.kill().await;
            false
        },
        _ = kill_rx => {
            push_event("info", "stopped by user");
            let _ = child.kill().await;
            false
        },
    };
    let _ = reader.await;
    result
}

/// Ask a running agent to stop. No-op when idle.
pub fn stop_run() -> bool {
    let mut st = LIVE.lock();
    if let Some(tx) = st.kill.take() {
        let _ = tx.send(());
        true
    } else {
        false
    }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/// Start the background scheduler once. Checks every minute; when the
/// employee is enabled and a full interval has passed since the last
/// run, kicks a hygiene run (which also reports pending meetings).
pub fn start_scheduler() {
    if SCHEDULER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(60)).await;
            let cfg = load_config();
            if !cfg.enabled {
                continue;
            }
            let due = {
                let st = LIVE.lock();
                !st.running && last_journaled_run_is_older_than(cfg.interval_hours)
            };
            if due {
                push_event("info", "scheduled wake");
                let _ = start_run("hygiene");
            }
        }
    });
}

fn last_journaled_run_is_older_than(hours: u32) -> bool {
    let runs: Vec<Value> = read_jsonl(&runs_path());
    let Some(last) = runs
        .last()
        .and_then(|r| r.get("ts"))
        .and_then(|t| t.as_str())
    else {
        return true; // never ran
    };
    // Lexicographic compare works for ISO-8601 UTC: compute the cutoff.
    let cutoff_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .saturating_sub(hours as u64 * 3600);
    let days = cutoff_secs / 86_400;
    let (y, mo, d) = civil_from_days(days as i64);
    let secs = cutoff_secs % 86_400;
    let cutoff = format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y,
        mo,
        d,
        secs / 3600,
        (secs % 3600) / 60,
        secs % 60
    );
    last < cutoff.as_str()
}

// ---------------------------------------------------------------------------
// HTTP endpoints (mounted by http_server)
// ---------------------------------------------------------------------------

use axum::extract::{Path as AxPath, Query as AxQuery, State};
use axum::Json;

use super::handlers::{ApiError, ServerState};
use axum::http::StatusCode;

#[derive(Serialize)]
pub struct StatusResponse {
    enabled: bool,
    state: String,
    autonomy: u8,
    interval_hours: u32,
    last_run: Option<Value>,
    next_run_ts: Option<String>,
    claude_found: bool,
    meetings_pending: usize,
    proposals_open: usize,
}

fn status_snapshot() -> StatusResponse {
    let cfg = load_config();
    let runs: Vec<Value> = read_jsonl(&runs_path());
    let last_run = runs.last().cloned();
    let brain = super::read_ops::resolve_brain_id(None).unwrap_or_default();
    let meetings_pending = if brain.is_empty() {
        0
    } else {
        list_meetings(&brain)
            .iter()
            .filter(|m| m.status == "pending")
            .count()
    };
    let (running, _) = {
        let st = LIVE.lock();
        (st.running, st.seq)
    };
    StatusResponse {
        enabled: cfg.enabled,
        state: if running { "running" } else { "idle" }.into(),
        autonomy: cfg.autonomy,
        interval_hours: cfg.interval_hours,
        next_run_ts: None, // v0: schedule is interval-based; UI shows interval
        claude_found: find_claude(&cfg).is_some(),
        meetings_pending,
        proposals_open: list_proposals(Some("open")).len(),
        last_run,
    }
}

pub async fn employee_status(_s: State<ServerState>) -> Json<StatusResponse> {
    Json(status_snapshot())
}

#[derive(Deserialize)]
pub struct ConfigBody {
    enabled: Option<bool>,
    interval_hours: Option<u32>,
}

pub async fn employee_config(
    _s: State<ServerState>,
    Json(body): Json<ConfigBody>,
) -> std::result::Result<Json<StatusResponse>, ApiError> {
    let mut cfg = load_config();
    if let Some(e) = body.enabled {
        cfg.enabled = e;
    }
    if let Some(h) = body.interval_hours {
        cfg.interval_hours = h.clamp(1, 168);
    }
    save_config(&cfg).map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(status_snapshot()))
}

#[derive(Deserialize)]
pub struct RunBody {
    task: Option<String>,
}

pub async fn employee_run(_s: State<ServerState>, Json(body): Json<RunBody>) -> Json<Value> {
    let task = body.task.unwrap_or_else(|| "hygiene".into());
    match start_run(&task) {
        Ok(()) => Json(json!({"started": true})),
        Err(reason) => Json(json!({"started": false, "reason": reason})),
    }
}

pub async fn employee_stop(_s: State<ServerState>) -> Json<Value> {
    Json(json!({"stopped": stop_run()}))
}

#[derive(Deserialize)]
pub struct ActivityQuery {
    since: Option<u64>,
}

pub async fn employee_activity(
    _s: State<ServerState>,
    AxQuery(q): AxQuery<ActivityQuery>,
) -> Json<Value> {
    let since = q.since.unwrap_or(0);
    let st = LIVE.lock();
    let events: Vec<&ActivityEvent> = st.events.iter().filter(|e| e.seq > since).collect();
    Json(json!({
        "events": events,
        "state": if st.running { "running" } else { "idle" },
    }))
}

#[derive(Deserialize)]
pub struct RunsQuery {
    limit: Option<usize>,
}

pub async fn employee_runs(_s: State<ServerState>, AxQuery(q): AxQuery<RunsQuery>) -> Json<Value> {
    let mut runs: Vec<Value> = read_jsonl(&runs_path());
    runs.reverse();
    runs.truncate(q.limit.unwrap_or(20));
    Json(json!({ "runs": runs }))
}

pub async fn employee_proposals(_s: State<ServerState>) -> Json<Value> {
    Json(json!({ "proposals": list_proposals(Some("open")) }))
}

pub async fn employee_proposal_approve(
    _s: State<ServerState>,
    AxPath(id): AxPath<String>,
) -> std::result::Result<Json<Value>, ApiError> {
    let open = list_proposals(Some("open"));
    let Some(p) = open.into_iter().find(|p| p.id == id) else {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            format!("no open proposal {id}"),
        ));
    };
    let applied = tokio::task::spawn_blocking(move || {
        let outcome = execute_proposal(&p);
        let mut done = p.clone();
        done.status = if outcome.is_ok() { "approved" } else { "open" }.into();
        if outcome.is_ok() {
            let _ = append_jsonl(&proposals_path(), &done);
        }
        outcome
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    match applied {
        Ok(msg) => Ok(Json(json!({"ok": true, "applied": msg}))),
        Err(e) => Ok(Json(json!({"ok": false, "error": e.to_string()}))),
    }
}

pub async fn employee_proposal_reject(
    _s: State<ServerState>,
    AxPath(id): AxPath<String>,
) -> std::result::Result<Json<Value>, ApiError> {
    let open = list_proposals(Some("open"));
    let Some(mut p) = open.into_iter().find(|p| p.id == id) else {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            format!("no open proposal {id}"),
        ));
    };
    p.status = "rejected".into();
    append_jsonl(&proposals_path(), &p)
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({"ok": true})))
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

        // unknown actions still parse but are not executable
        let l2 = r#"PROPOSAL: {"action":"rm_rf","title":"nope","args":{}}"#;
        let p2 = parse_proposal_line(l2, "brain-x").unwrap();
        assert!(!EXECUTABLE_ACTIONS.contains(&p2.action.as_str()));

        // garbage does not parse
        assert!(parse_proposal_line("PROPOSAL: not json", "b").is_none());
        assert!(parse_proposal_line("no prefix", "b").is_none());
    }

    #[test]
    fn level0_whitelist_has_no_destructive_tools() {
        let allow = allowed_tools(0);
        for banned in [
            "delete_engrams",
            "supersede_note",
            "bulk_set_kind",
            "bulk_add_tag",
            "update",
            "core_memory_set",
            "core_memory_replace",
            "remove_link",
            "optimize_disk",
        ] {
            assert!(
                !allow.contains(banned),
                "level-0 whitelist must not contain {banned}"
            );
        }
        assert!(allow.contains("mcp__neurovault__recall"));
        assert!(allow.contains("mcp__neurovault__remember"));
    }

    #[test]
    fn config_roundtrip_defaults() {
        let cfg = EmployeeConfig::default();
        assert!(!cfg.enabled);
        assert_eq!(cfg.interval_hours, 24);
        assert_eq!(cfg.autonomy, 0);
        let s = serde_json::to_string(&cfg).unwrap();
        let back: EmployeeConfig = serde_json::from_str(&s).unwrap();
        assert_eq!(back.interval_hours, cfg.interval_hours);
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
