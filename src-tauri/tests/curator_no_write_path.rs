//! Acceptance item 18 — "no curator path calls an immediate-write fact
//! endpoint" — as a **test** instead of a code-review invariant.
//!
//! WHY THIS EXISTS
//! ---------------
//! Of the 24 conditions in spec §20, this was the only one scored
//! **DOC**: structurally true, verifiable by inspection, and asserted by
//! nothing. The acceptance walk said so plainly — the `Disposition` enum
//! has no `AutoWrite` variant, the only write in the module is
//! `proposals::append`, and a grep comes back clean — but a grep is not
//! a test and a doc comment is not a guard. PENDING-4 asked for "a test
//! that asserts the curator module's source contains no call into the
//! ingest/remember write entry points, or a module-boundary lint that
//! makes the dependency impossible rather than merely absent", and noted
//! that it is "worth doing precisely because it is the one guarantee
//! everything else rests on".
//!
//! This file is both halves of that, deliberately, because either alone
//! is weak:
//!
//! * [`curator_has_no_semantic_write_path`]'s **structural** half reads
//!   every `.rs` file under `adaptive/curator/`, strips comments, and
//!   fails on a reference to any canonical-memory writer. It catches the
//!   write that is added but never exercised — the dead `use` today that
//!   becomes a live call next quarter.
//! * its **runtime** half drives the real runner end to end and then
//!   approves every proposal it produced through the real HTTP handler,
//!   against a real brain with a real vault and a real SQLite database
//!   holding real `engrams` and `facts` rows. It catches the write that
//!   no source scan can see: one that happens through an intermediary,
//!   a trait object, or a path this file did not think to name.
//!
//! The structural half proves the module *cannot* write. The runtime
//! half proves that when you run the whole thing and say yes to
//! everything it proposes, nothing moves.
//!
//! ISOLATION
//! ---------
//! A private, canonicalized `NEUROVAULT_HOME` + `CLAUDE_CONFIG_DIR` per
//! test (macOS `/var` is a symlink and the hardened evidence reader
//! refuses symlinked roots). No model is loaded: the provider talks to
//! an in-process mock Ollama. `~/.neurovault` is never read or written
//! and port 8765 is never opened.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use neurovault_lib::memory::adaptive::curator::policy::CURATOR_ACTIONS;
use neurovault_lib::memory::adaptive::curator::{runner, state};
use neurovault_lib::memory::adaptive::proposals::{
    self, ApplicationStatus, ReviewStatus, StoredProposal,
};
use neurovault_lib::memory::journal::Event;
use neurovault_lib::memory::{db, paths};

// =====================================================================
// PART A — the structural half
// =====================================================================

/// Every canonical-memory writer the curator must never reach.
///
/// Matched as whole identifiers, not substrings: `curator_remember_fact`
/// is a *different* identifier from `record_fact`, and the three
/// `curator_remember_*` action NAME strings are exactly what the
/// acceptance walk's grep already found and correctly dismissed. A
/// substring scan that flagged them would be noise, and noise is how a
/// guard gets deleted.
const FORBIDDEN_SYMBOLS: &[(&str, &str)] = &[
    ("upsert_fact", "facts.rs — writes a row into `facts`"),
    (
        "record_fact",
        "the immediate-write fact entry point spec §20 names",
    ),
    ("extract_facts", "facts.rs — mines a note into fact rows"),
    (
        "ingest_content",
        "ingest.rs — the canonical markdown→DB path",
    ),
    ("ingest_content_opts", "ingest.rs — same, with options"),
    ("ingest_file", "ingest.rs — same, from disk"),
    ("save_note", "write_ops.rs mutator — writes vault markdown"),
    (
        "create_note",
        "write_ops.rs mutator — creates vault markdown",
    ),
    ("delete_note", "write_ops.rs mutator"),
    ("restore_note", "write_ops.rs mutator"),
    (
        "supersede_note",
        "write_ops.rs mutator — the one 'safe' executor arm",
    ),
    ("set_source_folders", "write_ops.rs mutator"),
    ("open_brain", "db.rs — opens the canonical SQLite handle"),
    ("remember", "the MCP write tool"),
];

/// Module paths and shapes that would make a write *possible*, whether
/// or not one is performed today. This is the "module-boundary lint that
/// makes the dependency impossible rather than merely absent" half: the
/// curator opens no database, so it should not be able to name one.
const FORBIDDEN_FRAGMENTS: &[(&str, &str)] = &[
    ("/api/facts", "the immediate-write fact HTTP endpoint"),
    ("write_ops", "the canonical vault/DB mutator module"),
    ("memory::ingest", "the ingestion module"),
    ("memory::facts", "the facts module"),
    (
        "rusqlite",
        "a SQL handle in the curator is a write waiting to happen",
    ),
    ("BrainDb", "the canonical database handle"),
    ("vault_dir", "the canonical markdown root"),
    ("INSERT INTO", "direct canonical-memory SQL"),
    ("DELETE FROM", "direct canonical-memory SQL"),
    ("UPDATE engrams", "direct canonical-memory SQL"),
    ("UPDATE facts", "direct canonical-memory SQL"),
];

/// The only places in the module that may touch the filesystem, as
/// `(file, enclosing fn)`. Everything here is a curator-owned store:
/// the append-only tombstone log, the retry ledger, the run-audit
/// segments, and the scheduler's last-run stamp. Not one of them is
/// canonical memory — the vault is markdown and the index is
/// `brain.db`, and neither appears.
///
/// `proposals::append` is deliberately absent: it lives OUTSIDE this
/// module (`adaptive/proposals.rs`) and the runner calls it. That is the
/// single write path the curator has, it produces a quarantined
/// `NotApplicable` record, and Part B is what proves it stays inert.
const ALLOWED_WRITE_SITES: &[(&str, &str)] = &[
    ("identity.rs", "append_tombstone"),
    ("schedule.rs", "record_run"),
    ("state.rs", "append_audit"),
    ("state.rs", "save"),
];

fn curator_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src/memory/adaptive/curator")
}

/// Every `.rs` file in the module, sorted.
fn curator_sources() -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = std::fs::read_dir(curator_dir())
        .expect("the curator module is on disk")
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "rs"))
        .map(|p| {
            let name = p
                .file_name()
                .and_then(|n| n.to_str())
                .expect("utf8 filename")
                .to_string();
            (name, std::fs::read_to_string(&p).expect("readable source"))
        })
        .collect();
    out.sort();
    out
}

/// Strip `//` line comments and `/* */` block comments, leaving string
/// literals intact.
///
/// Comments are stripped because the module *documents* what it must not
/// do — `runner.rs` and `gates.rs` both name the write endpoints in
/// prose, on purpose, and a scan that could not tell prose from code
/// would be unmaintainable. String literals are KEPT: an action name or
/// an endpoint path smuggled in as data is exactly as dangerous as a
/// call, and `curator_remember_*` survives the identifier rule below on
/// its own merits rather than by being hidden here.
fn strip_comments(src: &str) -> String {
    let bytes: Vec<char> = src.chars().collect();
    let mut out = String::with_capacity(src.len());
    let mut i = 0usize;
    let (mut in_str, mut in_char, mut escaped) = (false, false, false);
    while i < bytes.len() {
        let c = bytes[i];
        let next = bytes.get(i + 1).copied();
        if in_str || in_char {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if in_str && c == '"' {
                in_str = false;
            } else if in_char && c == '\'' {
                in_char = false;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            in_str = true;
            out.push(c);
            i += 1;
            continue;
        }
        // A lifetime (`'a`) is not a char literal; only treat `'x'` as one.
        if c == '\'' && bytes.get(i + 2) == Some(&'\'') {
            in_char = true;
            out.push(c);
            i += 1;
            continue;
        }
        if c == '/' && next == Some('/') {
            while i < bytes.len() && bytes[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && next == Some('*') {
            let mut depth = 1usize;
            i += 2;
            while i < bytes.len() && depth > 0 {
                if bytes[i] == '/' && bytes.get(i + 1) == Some(&'*') {
                    depth += 1;
                    i += 2;
                } else if bytes[i] == '*' && bytes.get(i + 1) == Some(&'/') {
                    depth -= 1;
                    i += 2;
                } else {
                    if bytes[i] == '\n' {
                        out.push('\n');
                    }
                    i += 1;
                }
            }
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

/// `true` iff `needle` occurs in `haystack` as a whole identifier —
/// neither preceded nor followed by a Rust identifier character.
fn contains_identifier(haystack: &str, needle: &str) -> bool {
    let ident = |c: char| c.is_alphanumeric() || c == '_';
    let mut from = 0usize;
    while let Some(offset) = haystack[from..].find(needle) {
        let start = from + offset;
        let end = start + needle.len();
        let before_ok = haystack[..start]
            .chars()
            .next_back()
            .is_none_or(|c| !ident(c));
        let after_ok = haystack[end..].chars().next().is_none_or(|c| !ident(c));
        if before_ok && after_ok {
            return true;
        }
        from = start + 1;
    }
    false
}

/// `(file, line number, line)` for every line performing a filesystem
/// write, paired with the `fn` it sits in. Test modules are excluded:
/// a test that writes a fixture transcript is not the module writing
/// memory, and there is no way to write a hardened-reader test without
/// creating a file to harden against.
fn write_sites(name: &str, code: &str) -> Vec<(String, String, String)> {
    const WRITE_SHAPES: &[&str] = &[
        "fs::write(",
        "OpenOptions",
        "File::create(",
        "fs::create_dir",
        "fs::remove_",
        "fs::rename(",
        "fs::copy(",
    ];
    let mut out = Vec::new();
    let mut enclosing = String::from("<none>");
    let mut in_tests = false;
    for line in code.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("mod tests") || trimmed.starts_with("#[cfg(test)]") {
            in_tests = true;
        }
        if let Some(rest) = trimmed
            .strip_prefix("pub fn ")
            .or_else(|| trimmed.strip_prefix("fn "))
            .or_else(|| trimmed.strip_prefix("pub(crate) fn "))
            .or_else(|| trimmed.strip_prefix("pub async fn "))
        {
            enclosing = rest
                .split(|c: char| c == '(' || c == '<' || c.is_whitespace())
                .next()
                .unwrap_or("?")
                .to_string();
        }
        if in_tests {
            continue;
        }
        if WRITE_SHAPES.iter().any(|shape| line.contains(shape)) {
            out.push((name.to_string(), enclosing.clone(), line.trim().to_string()));
        }
    }
    out
}

// =====================================================================
// PART B — the runtime harness
// =====================================================================

const BRAIN: &str = "NoWriteBrain";
const PROJECT: &str = "-Users-dath-code-nowrite";
const SESSION: &str = "9c2f7a10-4e6b-4d51-9f38-71b0c4ea52d6";
const MODEL: &str = "qwen3:30b-a3b-instruct-2507-q4_K_M";
const DIGEST: &str = "sha256:3333333333333333333333333333333333333333333333333333333333333333";
const CANARY_GOLD: &str = r#"{"proposals":[{"type":"decision","statement":"Deploys move to Tuesday.","subject":"deploys","evidence":["S3"],"source_role":"user"}],"nothing_durable":false}"#;

static HOME_LOCK: Mutex<()> = Mutex::new(());

struct Env {
    root: PathBuf,
    home: PathBuf,
    projects: PathBuf,
    prev_home: Option<std::ffi::OsString>,
    prev_claude: Option<std::ffi::OsString>,
    _guard: MutexGuard<'static, ()>,
}

impl Env {
    fn new(name: &str) -> Self {
        let guard = HOME_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        // Shared model cache only, exactly as the other integration
        // tests do: the temp home below would otherwise miss it. Nothing
        // in this file loads a model; this is belt and braces against a
        // dependency deciding to.
        std::env::set_var(
            "FASTEMBED_CACHE_DIR",
            paths::nv_home().join(".fastembed_cache"),
        );
        let requested = std::env::temp_dir().join(format!(
            "nv-nowrite-{name}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&requested).unwrap();
        let root = std::fs::canonicalize(requested).unwrap();
        let home = root.join("nv-home");
        let claude = root.join("claude");
        let projects = claude.join("projects").join(PROJECT);
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&projects).unwrap();
        let prev_home = std::env::var_os("NEUROVAULT_HOME");
        let prev_claude = std::env::var_os("CLAUDE_CONFIG_DIR");
        std::env::set_var("NEUROVAULT_HOME", &home);
        std::env::set_var("CLAUDE_CONFIG_DIR", &claude);

        // `open_brain` load_extension()s sqlite-vec. Running from
        // target/<profile>/deps/ none of the default candidate paths
        // resolve, so point at the shipped extension explicitly — same
        // approach and same reason as retrieval_integration.rs.
        let vec0_file = if cfg!(target_os = "windows") {
            "vec0.dll"
        } else if cfg!(target_os = "macos") {
            "vec0.dylib"
        } else {
            "vec0.so"
        };
        let vec0 = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(vec0_file);
        assert!(vec0.exists(), "{vec0_file} missing at {vec0:?}");
        std::env::set_var("NEUROVAULT_VEC_EXTENSION", &vec0);

        Env {
            root,
            home,
            projects,
            prev_home,
            prev_claude,
            _guard: guard,
        }
    }

    fn transcript(&self, body: &[u8]) -> (String, u64, String) {
        let path = self.projects.join(format!("{SESSION}.jsonl"));
        std::fs::write(&path, body).unwrap();
        (
            format!("{PROJECT}/{SESSION}.jsonl"),
            body.len() as u64,
            sha256_hex(body),
        )
    }

    fn config(&self, endpoint: &str) {
        let cfg = serde_json::json!({
            "enabled": true,
            "transcript_access": true,
            "provider": {
                "endpoint": endpoint,
                "model": MODEL,
                "num_ctx": 8192,
                "num_predict": 512,
                "timeout_warmup_secs": 10,
                "timeout_first_unit_secs": 10,
                "timeout_unit_secs": 10,
                "timeout_control_secs": 5,
            },
        });
        std::fs::write(
            self.home.join("local_curator.json"),
            serde_json::to_string(&cfg).unwrap(),
        )
        .unwrap();
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        match &self.prev_claude {
            Some(v) => std::env::set_var("CLAUDE_CONFIG_DIR", v),
            None => std::env::remove_var("CLAUDE_CONFIG_DIR"),
        }
        match &self.prev_home {
            Some(v) => std::env::set_var("NEUROVAULT_HOME", v),
            None => std::env::remove_var("NEUROVAULT_HOME"),
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

/// The two journal events one captured turn writes.
fn journal_turn(relative: &str, len: u64, sha: &str) -> String {
    use neurovault_lib::memory::journal::{
        append, ApprovedTranscriptRoot, EvidenceCaptureReceipt, EvidenceCaptureStatus,
        EvidenceReference,
    };

    let mut ctx = Event::now(BRAIN, "context_decision", "prompt", "sha256:prompt");
    ctx.capture_method = "ambient".into();
    ctx.turn_id = Some(ctx.event_id.clone());
    ctx.session_id = Some(SESSION.into());
    ctx.host = Some("claude_code".into());
    ctx.title = Some("nowrite".into());
    append(&ctx).unwrap();

    let mut stop = Event::now(BRAIN, "assistant_response_completed", "session", SESSION);
    stop.capture_method = "hook".into();
    stop.turn_id = Some(ctx.event_id.clone());
    stop.session_id = Some(SESSION.into());
    stop.host = Some("claude_code".into());
    stop.title = Some("nowrite".into());
    stop.evidence_refs = vec![EvidenceReference::Transcript {
        root: ApprovedTranscriptRoot::ClaudeProjects,
        relative_path: relative.to_string(),
        observed_prefix_len: len,
        source_prefix_sha256: sha.to_string(),
    }];
    stop.evidence_capture = Some(EvidenceCaptureReceipt {
        status: EvidenceCaptureStatus::Captured,
        code: None,
    });
    append(&stop).unwrap();
    ctx.event_id
}

// ── the mock provider ────────────────────────────────────────────────

#[derive(Default)]
struct MockState {
    chat: Mutex<std::collections::VecDeque<(u16, String)>>,
}

impl MockState {
    fn script(self: &Arc<Self>, status: u16, body: String) -> &Arc<Self> {
        self.chat.lock().unwrap().push_back((status, body));
        self
    }

    fn preflight_ok(self: &Arc<Self>) -> &Arc<Self> {
        self.script(200, ok_chat(r#"{"proposals":[],"nothing_durable":true}"#));
        self.script(200, ok_chat(CANARY_GOLD))
    }
}

fn ok_chat(content: &str) -> String {
    serde_json::json!({
        "model": MODEL,
        "message": { "role": "assistant", "content": content },
        "done": true,
        "done_reason": "stop",
        "prompt_eval_count": 900,
        "eval_count": 64,
    })
    .to_string()
}

struct MockOllama {
    base: String,
    handle: tokio::task::JoinHandle<()>,
}

impl Drop for MockOllama {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

async fn mock_ollama(state: Arc<MockState>) -> MockOllama {
    use axum::extract::State as AxState;
    use axum::response::IntoResponse;
    use axum::routing::{get, post};
    use axum::{Json, Router};

    async fn h_chat(
        AxState(st): AxState<Arc<MockState>>,
        body: String,
    ) -> axum::response::Response {
        if body.contains("\"keep_alive\":\"0\"") {
            return Json(serde_json::json!({ "done": true })).into_response();
        }
        let script = {
            let mut q = st.chat.lock().unwrap();
            if q.len() > 1 {
                q.pop_front().unwrap()
            } else {
                q.front()
                    .cloned()
                    .unwrap_or((200, ok_chat(r#"{"proposals":[],"nothing_durable":true}"#)))
            }
        };
        (
            axum::http::StatusCode::from_u16(script.0).unwrap(),
            script.1,
        )
            .into_response()
    }

    let app = Router::new()
        .route(
            "/api/version",
            get(|| async { Json(serde_json::json!({ "version": "0.9.3" })) }),
        )
        .route(
            "/api/tags",
            get(|| async {
                Json(serde_json::json!({
                    "models": [{ "name": MODEL, "model": MODEL, "digest": DIGEST }]
                }))
            }),
        )
        .route(
            "/api/show",
            post(|| async {
                Json(serde_json::json!({
                    "capabilities": ["completion", "thinking"],
                    "model_info": { "qwen3.context_length": 32768 },
                }))
            }),
        )
        .route("/api/chat", post(h_chat))
        .route(
            "/api/ps",
            get(|| async { Json(serde_json::json!({ "models": [] })) }),
        )
        .with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    MockOllama {
        base: format!("http://127.0.0.1:{port}"),
        handle,
    }
}

// ── the snapshot ─────────────────────────────────────────────────────

/// Everything canonical memory consists of, in one comparable value:
/// the vault's markdown bytes, and the `engrams` and `facts` rows.
///
/// The vault is hashed per file rather than as a directory digest so a
/// failure names the file that moved. The two tables are read as sorted
/// row tuples so a failure names the row.
#[derive(Debug, PartialEq, Eq)]
struct CanonicalMemory {
    /// `relative path -> sha256 of the bytes`
    vault: BTreeMap<String, String>,
    engrams: Vec<String>,
    facts: Vec<String>,
}

fn snapshot_canonical(brain_id: &str) -> CanonicalMemory {
    let vault_root = paths::vault_dir(brain_id);
    let mut vault = BTreeMap::new();
    fn walk(dir: &Path, root: &Path, out: &mut BTreeMap<String, String>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, root, out);
            } else if let Ok(bytes) = std::fs::read(&path) {
                out.insert(
                    path.strip_prefix(root)
                        .unwrap_or(&path)
                        .to_string_lossy()
                        .into_owned(),
                    sha256_hex(&bytes),
                );
            }
        }
    }
    walk(&vault_root, &vault_root, &mut vault);

    let brain = db::open_brain(brain_id).expect("open brain");
    let conn = brain.lock();
    let rows = |sql: &str| -> Vec<String> {
        let mut stmt = conn.prepare(sql).expect("prepare");
        let out: Vec<String> = stmt
            .query_map([], |row| {
                let mut cells = Vec::new();
                for i in 0..row.as_ref().column_count() {
                    cells.push(format!("{:?}", row.get_ref(i).unwrap()));
                }
                Ok(cells.join("|"))
            })
            .expect("query")
            .flatten()
            .collect();
        out
    };
    CanonicalMemory {
        engrams: rows("SELECT * FROM engrams ORDER BY id"),
        facts: rows("SELECT * FROM facts ORDER BY id"),
        vault,
    }
}

/// Sorted `(path relative to the home, sha256)` for every file under a
/// NEUROVAULT_HOME. Used to name which artifacts a run touched.
fn home_tree(home: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    fn walk(dir: &Path, root: &Path, out: &mut BTreeMap<String, String>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, root, out);
            } else if let Ok(bytes) = std::fs::read(&path) {
                out.insert(
                    path.strip_prefix(root)
                        .unwrap_or(&path)
                        .to_string_lossy()
                        .replace('\\', "/"),
                    sha256_hex(&bytes),
                );
            }
        }
    }
    walk(home, home, &mut out);
    out
}

/// Which files a run is allowed to create or change: the curator's own
/// quarantined stores, the journal (a review decision IS an experience),
/// and SQLite's own write-ahead sidecars — which move whenever a
/// connection opens, carry no committed content of their own, and are
/// checked instead by comparing the TABLES either side.
fn is_allowed_artifact(relative: &str) -> bool {
    let base = relative.rsplit('/').next().unwrap_or(relative);
    base == "proposals.jsonl"
        || base == "curator_state.json"
        || base == "curator_tombstones.jsonl"
        || base == "curator_last_run.txt"
        || base.starts_with("curator_runs-")
        // The append-only event journal. A review decision IS an
        // experience and is recorded as one (`proposals::decide`), and
        // the collector's own loop guard — `capture_method == "review"`
        // — is what stops the curator consuming its own review events as
        // evidence. An event line is not canonical memory: no engram, no
        // fact, no markdown.
        || relative.contains("/journal/")
        || relative.starts_with("journal/")
        || base.ends_with(".db-wal")
        || base.ends_with(".db-shm")
}

// =====================================================================
// the test
// =====================================================================

/// The transcript: one user turn carrying one candidate of each of the
/// three claim classes, so every `CURATOR_ACTIONS` entry is minted by
/// the real pipeline rather than hand-assembled.
const TRANSCRIPT: &str = r#"{"type":"user","uuid":"d1f0c3d2-1111-4a11-9c11-000000000011","timestamp":"2026-08-12T11:02:00Z","sessionId":"9c2f7a10-4e6b-4d51-9f38-71b0c4ea52d6","message":{"role":"user","content":"We deploy Atlas only on Tuesdays. I prefer tabs over spaces in every repo. The staging mirror runs Postgres 16."}}
"#;

/// One proposal per claim class, each citing its own sentence verbatim
/// so the gauntlet has no reason to reject any of them.
const REPLY: &str = r#"{"proposals":[{"type":"decision","statement":"We deploy Atlas only on Tuesdays.","subject":"deployment","evidence":["S1"],"source_role":"user"},{"type":"preference","statement":"I prefer tabs over spaces in every repo.","subject":"formatting","evidence":["S2"],"source_role":"user"},{"type":"fact","statement":"The staging mirror runs Postgres 16.","subject":"infrastructure","evidence":["S3"],"source_role":"user"}],"nothing_durable":false}"#;

/// Seed canonical memory with something worth losing: a real vault note
/// and the `engrams` + `facts` rows that index it. An "unchanged"
/// assertion over an empty brain proves nothing.
fn seed_canonical_memory(brain_id: &str) {
    let vault = paths::vault_dir(brain_id);
    std::fs::create_dir_all(&vault).unwrap();
    let note = "# Deploy runbook\n\nAtlas ships on Tuesdays. Do not edit by hand.\n";
    std::fs::write(vault.join("deploy-runbook.md"), note).unwrap();

    let brain = db::open_brain(brain_id).expect("open brain");
    let conn = brain.lock();
    conn.execute(
        "INSERT INTO engrams (id, filename, title, content, content_hash) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![
            "e-seed-1",
            "deploy-runbook.md",
            "Deploy runbook",
            note,
            sha256_hex(note.as_bytes())
        ],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO facts (id, subject, attribute, value, source_engram) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params!["f-seed-1", "atlas", "deploy day", "Tuesday", "e-seed-1"],
    )
    .unwrap();
}

#[tokio::test]
async fn curator_has_no_semantic_write_path() {
    // =================================================================
    // (a) STRUCTURAL — the module cannot reach a canonical-memory writer
    // =================================================================
    let sources = curator_sources();
    assert!(
        sources.len() >= 12,
        "only {} curator sources found — the scan is pointed at the wrong \
         directory and would pass vacuously",
        sources.len()
    );

    let mut findings: Vec<String> = Vec::new();
    let mut observed_write_sites: BTreeSet<(String, String)> = BTreeSet::new();
    for (name, raw) in &sources {
        let code = strip_comments(raw);
        for (symbol, why) in FORBIDDEN_SYMBOLS {
            if contains_identifier(&code, symbol) {
                findings.push(format!("{name}: calls `{symbol}` — {why}"));
            }
        }
        for (fragment, why) in FORBIDDEN_FRAGMENTS {
            if code.contains(fragment) {
                findings.push(format!("{name}: references `{fragment}` — {why}"));
            }
        }
        for (file, function, line) in write_sites(name, &code) {
            if !ALLOWED_WRITE_SITES.contains(&(file.as_str(), function.as_str())) {
                findings.push(format!(
                    "{file}: undeclared filesystem write in `{function}`: {line}"
                ));
            }
            observed_write_sites.insert((file, function));
        }
    }
    assert!(
        findings.is_empty(),
        "the curator gained a write path:\n  {}",
        findings.join("\n  ")
    );
    // The allowlist must not rot in the other direction either: a
    // declared site that no longer exists is a stale permission, and a
    // stale permission is how the next one gets waved through.
    let declared: BTreeSet<(String, String)> = ALLOWED_WRITE_SITES
        .iter()
        .map(|(f, n)| (f.to_string(), n.to_string()))
        .collect();
    assert_eq!(
        declared, observed_write_sites,
        "ALLOWED_WRITE_SITES no longer describes the module"
    );

    // The scan must be able to fail. A guard that cannot go red is
    // decoration, so prove both matchers on synthetic input.
    assert!(contains_identifier(
        "let x = upsert_fact(&db);",
        "upsert_fact"
    ));
    assert!(
        !contains_identifier("\"curator_record_fact\"", "record_fact"),
        "the three curator_remember_* / curator_record_* action NAMES must not \
         be confused with a call to the endpoint they are named after"
    );
    assert!(!strip_comments("a // ingest_content\nb").contains("ingest_content"));
    assert!(!strip_comments("a /* ingest_content */ b").contains("ingest_content"));
    assert!(strip_comments("let s = \"ingest_content\";").contains("ingest_content"));

    // =================================================================
    // (b) RUNTIME — say yes to everything, and watch nothing move
    // =================================================================
    let env = Env::new("composite");
    seed_canonical_memory(BRAIN);

    let state = Arc::new(MockState::default());
    state.preflight_ok().script(200, ok_chat(REPLY));
    let ollama = mock_ollama(state).await;
    env.config(&ollama.base);
    let (relative, len, sha) = env.transcript(TRANSCRIPT.as_bytes());
    journal_turn(&relative, len, &sha);

    let before = snapshot_canonical(BRAIN);
    assert_eq!(before.engrams.len(), 1, "the seed engram is there to lose");
    assert_eq!(before.facts.len(), 1, "the seed fact is there to lose");
    assert_eq!(before.vault.len(), 1, "the seed note is there to lose");
    let tree_before = home_tree(&env.home);

    // --- the real runner, end to end ---
    let report = runner::run_brain(BRAIN).await.expect("run");
    assert_eq!(report.candidates_seen, 3, "{report:#?}");
    assert!(
        report.proposals_created > 0,
        "the run must actually PROPOSE something, or the rest of this test \
         is a tautology: {report:#?}"
    );

    let store = proposals::load_all(BRAIN);
    assert!(!store.is_empty());
    let minted: BTreeSet<&str> = store.values().map(|r| r.action.as_str()).collect();
    assert_eq!(
        minted,
        CURATOR_ACTIONS.iter().copied().collect::<BTreeSet<&str>>(),
        "all three CURATOR_ACTIONS must be exercised: {minted:?}"
    );
    for rec in store.values() {
        assert_eq!(
            rec.application_status,
            ApplicationStatus::NotApplicable,
            "{} was created applicable",
            rec.proposal_id
        );
        assert_eq!(rec.review_status, ReviewStatus::Unreviewed);
    }

    // --- approve every one through the REAL handler ---
    approve_all(&store).await;

    let after_store = proposals::load_all(BRAIN);
    for rec in after_store.values() {
        assert_eq!(
            rec.review_status,
            ReviewStatus::Approved,
            "{} was not approved",
            rec.proposal_id
        );
        assert_eq!(
            rec.application_status,
            ApplicationStatus::NotApplicable,
            "{} ({}) gained an executor arm — item 18 is broken",
            rec.proposal_id,
            rec.action
        );
        assert!(rec.application_error.is_none());
    }

    // --- and the assertion the whole file exists for ---
    let after = snapshot_canonical(BRAIN);
    assert_eq!(
        before.vault, after.vault,
        "the canonical markdown vault changed"
    );
    assert_eq!(before.engrams, after.engrams, "the engrams table changed");
    assert_eq!(before.facts, after.facts, "the facts table changed");
    assert_eq!(before, after, "canonical memory moved");

    // Nothing outside the quarantined stores was created or changed.
    let tree_after = home_tree(&env.home);
    let mut moved: Vec<String> = Vec::new();
    for (path, digest) in &tree_after {
        if tree_before.get(path) != Some(digest) && !is_allowed_artifact(path) {
            moved.push(format!("{path} (created or changed)"));
        }
    }
    for path in tree_before.keys() {
        if !tree_after.contains_key(path) {
            moved.push(format!("{path} (deleted)"));
        }
    }
    assert!(
        moved.is_empty(),
        "a curator run touched files outside proposals/audit/ledger:\n  {}",
        moved.join("\n  ")
    );
    // Positive control: the run really did write its OWN stores, so the
    // comparison above is over a run that happened.
    assert!(
        tree_after.contains_key("brains/NoWriteBrain/proposals.jsonl"),
        "{:?}",
        tree_after.keys().collect::<Vec<_>>()
    );
    assert!(tree_after
        .keys()
        .any(|p| p.contains("curator_runs-") || p.contains("curator_state.json")));
    assert!(!state::read_audit(BRAIN).is_empty(), "the run was audited");

    drop(ollama);
    drop(env);
}

/// Approve every stored proposal through `proposal_approve` — the same
/// axum handler `POST /api/proposals/:id/approve` mounts. Going through
/// the handler rather than `proposals::decide` is the point: the
/// executor match arm that would apply a curator action, if one ever
/// existed, lives in the handler.
async fn approve_all(store: &std::collections::HashMap<String, StoredProposal>) {
    use neurovault_lib::memory::handlers::{proposal_approve, ProposalDecisionBody, ServerState};
    for pid in store.keys() {
        let body: ProposalDecisionBody =
            serde_json::from_value(serde_json::json!({ "brain": BRAIN, "reviewer": "dath" }))
                .unwrap();
        let out = proposal_approve(
            axum::extract::Path(pid.clone()),
            axum::extract::State(ServerState {}),
            axum::Json(body),
        )
        .await
        .unwrap_or_else(|e| panic!("approve {pid}: {}", e.1));
        assert_eq!(out.0["apply"], "NotApplicable", "{pid} executed something");
    }
}
