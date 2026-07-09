//! Automatic memory for Claude Code — ambient recall via hooks.
//!
//! MCP memory is pull-based: the agent only remembers if it decides to
//! call `recall`, and models routinely don't. This module makes memory
//! AMBIENT instead. Claude Code hooks run a command on every prompt
//! (`UserPromptSubmit`) and at session open (`SessionStart`), and inject
//! the command's stdout into the model's context. So:
//!
//!   user types a prompt
//!     -> Claude Code runs `neurovault-server hook user-prompt-submit`
//!     -> we POST an AmbientQueryPacket to the running app on :8765
//!     -> /api/ambient_recall runs retrieval + the precision gate and
//!        returns a ready-made, sanitized context_block (or "silent")
//!     -> on inject we print ONE Claude Code hook JSON line and the
//!        server's block is injected alongside the prompt
//!     -> zero tool calls, memory just shows up
//!
//! This hook is a THIN CLIENT: the server owns the model, the index, the
//! relevance gate, and the block format. The hook pre-gates cheaply,
//! resolves repo/branch from the filesystem, ships the session seen-list
//! as `exclude_ids`, and prints exactly what the server decides — it
//! never assembles memory text or scores hits itself anymore.
//!
//! Design rules (each one is load-bearing):
//! - FAIL OPEN. If the app is down, the prompt is trivial, the response
//!   is malformed, or anything errors, print nothing and exit 0. A
//!   memory hook must never break or slow the user's Claude. Hard HTTP
//!   timeout well under the hook timeout. Exit code 2 is forbidden on
//!   every path — for UserPromptSubmit it BLOCKS the prompt (incident
//!   2026-07-07, where a stale binary locked every session).
//! - INJECT ONLY SIGNAL. Trivial prompts ("yes", "continue", slash
//!   commands) never even reach HTTP (`worth_recalling`). The server's
//!   gate decides the rest; the hook injects ONLY on decision=="inject"
//!   with a non-empty context_block. Memories already injected earlier
//!   in the session are excluded via a per-session seen-file in the OS
//!   temp dir (`exclude_ids`, newest 200).
//! - THIN + SAFE. The single stdout line is built with serde, never
//!   hand-assembled, so a block full of quotes/newlines/backslashes is
//!   escaped and can neither break the line nor smuggle structure.
//!
//! `hook install` wires `~/.claude/settings.json` (or
//! `$CLAUDE_CONFIG_DIR/settings.json`) with entries pointing at this
//! binary; install is idempotent and replaces stale entries (e.g. a dev
//! path) so re-running it always converges. A one-time backup of
//! settings.json is written next to it before the first modification.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::types::MemoryError;

type Result<T> = std::result::Result<T, MemoryError>;

/// Loopback base — the running desktop app (or `--http-only` server).
fn api_base() -> String {
    format!("http://127.0.0.1:{}", super::http_server::DEFAULT_PORT)
}

/// HTTP budget. Claude Code's own hook timeout (we install 10s) is the
/// backstop; this keeps the happy path snappy and the sad path silent.
const HTTP_TIMEOUT_MS: u64 = 3_500;

/// Do not inject for prompts shorter than this (acks, "continue", ...).
const MIN_PROMPT_LEN: usize = 12;

/// Newest session seen-ids sent as `exclude_ids`. The server owns the
/// dedup decision, but bounding the payload keeps the packet small.
const EXCLUDE_IDS_CAP: usize = 200;

/// Conversational filler that must not count as recall signal.
/// Empirical note (2026-07-07): we A/B'd a corpus-IDF gate against
/// this list using /api/query_signal — in a NOTES corpus, chat glue
/// ("continue", "sure") is RARE (df 20/33k => idf 7.4, higher than
/// "reranking" at 5.5), so document-frequency rates glue as highly
/// informative. The signal is inverted for this purpose; a curated
/// list is the correct tool. Any 4+ letter word not listed counts as
/// contentful, so non-English prompts pass open.
const STOPWORDS: &[&str] = &[
    "this",
    "that",
    "these",
    "those",
    "then",
    "than",
    "there",
    "here",
    "where",
    "when",
    "what",
    "which",
    "with",
    "without",
    "will",
    "would",
    "should",
    "could",
    "shall",
    "must",
    "have",
    "having",
    "been",
    "being",
    "were",
    "your",
    "yours",
    "mine",
    "ours",
    "them",
    "they",
    "their",
    "theirs",
    "some",
    "same",
    "such",
    "just",
    "very",
    "much",
    "more",
    "most",
    "many",
    "each",
    "every",
    "also",
    "into",
    "onto",
    "from",
    "over",
    "under",
    "about",
    "after",
    "before",
    "again",
    "still",
    "only",
    "even",
    "ever",
    "never",
    "always",
    "once",
    "make",
    "makes",
    "made",
    "making",
    "sure",
    "work",
    "works",
    "worked",
    "working",
    "well",
    "good",
    "great",
    "nice",
    "okay",
    "continue",
    "continues",
    "continued",
    "keep",
    "keeps",
    "going",
    "lets",
    "please",
    "thanks",
    "thank",
    "want",
    "wants",
    "wanted",
    "need",
    "needs",
    "needed",
    "like",
    "liked",
    "look",
    "looks",
    "looked",
    "looking",
    "check",
    "checks",
    "checked",
    "take",
    "takes",
    "taken",
    "give",
    "gives",
    "given",
    "help",
    "helps",
    "done",
    "doing",
    "know",
    "knows",
    "think",
    "thinks",
    "thing",
    "things",
    "stuff",
    "ways",
    "come",
    "comes",
    "came",
    "start",
    "starts",
    "started",
    "finish",
    "finished",
    "right",
    "wrong",
    "yeah",
    "back",
    "next",
    "last",
    "first",
    "second",
    "time",
    "times",
    "later",
    "soon",
    "little",
    "really",
    "actually",
    "maybe",
    "probably",
    "possibly",
    "everything",
    "something",
    "anything",
    "nothing",
    "someone",
    "anyone",
    "everyone",
];

// ---------------------------------------------------------------------------
// Hook execution (stdin JSON in, context block on stdout)
// ---------------------------------------------------------------------------

/// Entry point for `neurovault-server hook <event>`. Returns the
/// process exit code. Never returns non-zero for "no context": silence
/// is a valid, common outcome.
pub async fn run_hook_event(event: &str) -> u8 {
    // Read the hook payload Claude Code pipes on stdin. Cap at 1 MiB —
    // prompts are small; anything bigger is not something we recall on.
    let mut raw = String::new();
    {
        let stdin = std::io::stdin();
        let mut handle = stdin.lock().take(1_048_576);
        if handle.read_to_string(&mut raw).is_err() {
            return 0;
        }
    }
    let payload: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return 0,
    };

    match event {
        "user-prompt-submit" => {
            // `prompt_context` returns the COMPLETE stdout line (the
            // hookSpecificOutput JSON), or None for silence.
            if let Some(line) = prompt_context(&payload).await {
                println!("{line}");
            }
            0
        }
        "session-start" => {
            if let Some(block) = session_context(&payload).await {
                println!("{block}");
            }
            0
        }
        _ => {
            // Never exit 2 from the hook path: for UserPromptSubmit,
            // exit 2 BLOCKS the user's prompt. A version-skewed binary
            // must degrade to silence, not lock Claude Code (incident
            // 2026-07-07).
            eprintln!("unknown hook event '{event}' (ignored)");
            0
        }
    }
}

fn http_client() -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(HTTP_TIMEOUT_MS))
        // Loopback only — never route ambient prompt text through an
        // HTTP(S)_PROXY from the environment.
        .no_proxy()
        .build()
        .ok()
}

/// UserPromptSubmit: the ambient-recall flow. A thin client — build the
/// packet, POST it, and print exactly the one hook JSON line the server
/// decides (or nothing). Returns the FINAL stdout line already rendered,
/// or None for silence (the common, successful outcome).
async fn prompt_context(payload: &Value) -> Option<String> {
    let prompt = payload.get("prompt")?.as_str()?.trim();
    // Cheap pre-gate first: trivial prompts never touch HTTP. This is the
    // one gate that stays client-side (glue like "then lets continue and
    // make sure it works" injected ML noise live, 2026-07-07).
    if !worth_recalling(prompt) {
        return None;
    }
    let session_id = payload
        .get("session_id")
        .and_then(|s| s.as_str())
        .unwrap_or("nosession");
    // Claude Code passes the working directory on the packet; we resolve
    // repo/branch from it (pure filesystem — never spawn git).
    let cwd = payload.get("cwd").and_then(|s| s.as_str());
    let (repo, branch) = resolve_repo_branch(cwd);
    let exclude_ids = read_seen_recent(session_id, EXCLUDE_IDS_CAP);

    // The prompt is UNCAPPED here — the server owns the query budget now,
    // so one place decides how much of it to use. repo/branch/exclude_ids
    // are weak signals + the truthful dedup view for the decision log.
    let packet = json!({
        "prompt": prompt,
        "cwd": cwd,
        "session_id": session_id,
        "host": "claude_code",
        "event": "UserPromptSubmit",
        "repo": repo,
        "branch": branch,
        "exclude_ids": exclude_ids,
        "debug": false,
    });

    let client = http_client()?;
    let resp: Value = client
        .post(format!("{}/api/ambient_recall", api_base()))
        .json(&packet)
        .send()
        .await
        .ok()?
        // 4xx/5xx bodies are {"error": ...} JSON that would otherwise
        // parse fine and be mistaken for a decision; reject non-2xx.
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;

    let (line, injected_ids) = interpret_ambient_response(&resp)?;
    // Record the full ids we just injected so the next prompt in this
    // session excludes them (dedup stays client-owned).
    append_seen(session_id, &injected_ids);
    Some(line)
}

/// Resolve `(repo, branch)` from `cwd` by walking up the filesystem for a
/// `.git` entry — NEVER spawn `git` (a hook must not fork a subprocess:
/// cost, and a hung git would stall the prompt). Bounded to 12 levels.
///
/// - `.git` is a DIR: repo = that directory's basename; branch = the
///   local branch iff `.git/HEAD` is a symbolic ref (`ref: refs/heads/…`).
///   Detached HEAD (a raw SHA) → branch None.
/// - `.git` is a FILE (linked worktree / submodule): repo = basename,
///   branch None (HEAD lives elsewhere; we don't chase it in v1).
/// - No `.git` within range / cwd missing → both None.
pub fn resolve_repo_branch(cwd: Option<&str>) -> (Option<String>, Option<String>) {
    let Some(cwd) = cwd else {
        return (None, None);
    };
    let mut dir: Option<&Path> = Some(Path::new(cwd));
    for _ in 0..12 {
        let Some(d) = dir else { break };
        let git = d.join(".git");
        if git.exists() {
            let repo = d.file_name().map(|s| s.to_string_lossy().into_owned());
            let branch = if git.is_dir() {
                std::fs::read_to_string(git.join("HEAD"))
                    .ok()
                    .and_then(|head| {
                        head.trim()
                            .strip_prefix("ref: refs/heads/")
                            .map(|b| b.trim().to_string())
                    })
            } else {
                None
            };
            return (repo, branch);
        }
        dir = d.parent();
    }
    (None, None)
}

/// Interpret the server response. Pure: no HTTP, no file writes (the
/// caller appends the ids), so the whole decision path is unit-testable.
/// Inject ONLY on an explicit decision=="inject" with a non-empty
/// context_block; EVERYTHING else — a silent decision, a missing or
/// mistyped field, a wrong-shaped body — is silence (fail open), never
/// an error. Returns `(stdout line, engram ids to remember)`.
fn interpret_ambient_response(resp: &Value) -> Option<(String, Vec<String>)> {
    if resp.get("decision").and_then(|d| d.as_str()) != Some("inject") {
        return None;
    }
    let block = resp.get("context_block").and_then(|c| c.as_str())?;
    if block.is_empty() {
        return None;
    }
    let injected_ids: Vec<String> = resp
        .get("memories")
        .and_then(|m| m.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("engram_id").and_then(|s| s.as_str()))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    Some((inject_line(block), injected_ids))
}

/// The exact single stdout line for an inject: the Claude Code
/// UserPromptSubmit hook JSON. Built with serde, NEVER hand-assembled —
/// so a `block` containing quotes, newlines, backslashes, or angle
/// brackets is escaped and can neither break the one-line contract nor
/// smuggle structure into the transcript.
fn inject_line(block: &str) -> String {
    json!({
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": block,
        }
    })
    .to_string()
}

/// SessionStart: one compact brain bootstrap — core memory, top
/// memories, open todos. Injected once, before the first prompt.
async fn session_context(_payload: &Value) -> Option<String> {
    let client = http_client()?;
    let resp: Value = client
        .get(format!("{}/api/session_start", api_base()))
        .send()
        .await
        .ok()?
        // 4xx/5xx bodies are {"error": ...} JSON that would otherwise
        // parse fine and produce a misleading "memory is active" block.
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;

    // No identifiable brain => something is off server-side; stay
    // silent rather than claim memory is active.
    let brain = sanitize(
        resp.get("brain")
            .and_then(|b| b.get("name").or_else(|| b.get("id")))
            .and_then(|s| s.as_str())?,
        60,
    );

    let mut out = format!(
        "<neurovault-session>\nNeuroVault memory is active (brain: {brain}). \
         Auto-recall will surface relevant memories on each prompt.\n"
    );

    if let Some(core) = resp.get("core_memory").and_then(|c| c.as_array()) {
        for block in core.iter().take(4) {
            let label = sanitize(
                block
                    .get("label")
                    .and_then(|s| s.as_str())
                    .unwrap_or("core"),
                40,
            );
            // CoreBlock serializes the text as `value`; accept `content`
            // as a forward-compat alias.
            let content = sanitize(
                block
                    .get("value")
                    .or_else(|| block.get("content"))
                    .and_then(|s| s.as_str())
                    .unwrap_or(""),
                200,
            );
            if !content.is_empty() {
                out.push_str(&format!("Core[{label}]: {content}\n"));
            }
        }
    }
    if let Some(top) = resp.get("top_memories").and_then(|t| t.as_array()) {
        let titles: Vec<String> = top
            .iter()
            .take(5)
            .filter_map(|m| m.get("title").and_then(|s| s.as_str()))
            .map(|t| sanitize(t, 70))
            .collect();
        if !titles.is_empty() {
            out.push_str(&format!("Top memories: {}\n", titles.join("; ")));
        }
    }
    if let Some(todos) = resp.get("open_todos").and_then(|t| t.as_array()) {
        if !todos.is_empty() {
            let first: Vec<String> = todos
                .iter()
                .take(3)
                .filter_map(|t| t.get("text").and_then(|s| s.as_str()))
                .map(|t| sanitize(t, 60))
                .collect();
            out.push_str(&format!(
                "Open todos: {} ({})\n",
                todos.len(),
                first.join("; ")
            ));
        }
    }
    out.push_str(
        "Save durable facts with remember(content); recall(query) anytime.\n</neurovault-session>",
    );
    Some(out)
}

/// The contentful tokens themselves (lowercased): 4+ chars and not
/// conversational filler. Shared with the server-side ambient engine
/// (`ambient.rs`), which needs the tokens for entity matching against
/// candidate titles — not just their count.
pub(crate) fn contentful_tokens(prompt: &str) -> Vec<String> {
    prompt
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.chars().count() >= 4)
        .map(|w| w.to_lowercase())
        .filter(|w| !STOPWORDS.contains(&w.as_str()))
        .collect()
}

/// A token is contentful when it's 4+ chars and not conversational
/// filler. One such token justifies a recall round-trip. Shared with
/// the server-side ambient engine (`ambient.rs`) so client pre-gate and
/// server quality scoring agree on what "contentful" means.
pub(crate) fn contentful_token_count(prompt: &str) -> usize {
    contentful_tokens(prompt).len()
}

/// Trivial-prompt guard: short acks, slash commands, memory shortcuts,
/// and pure conversational glue don't deserve a recall round-trip.
/// Vector search always has SOME nearest neighbor, so a vague prompt
/// would otherwise inject plausible-but-useless memories (observed
/// live with "then lets continue and make sure that it works well").
fn worth_recalling(prompt: &str) -> bool {
    let p = prompt.trim();
    p.len() >= MIN_PROMPT_LEN
        && !p.starts_with('/')
        && !p.starts_with('#')
        && contentful_token_count(p) >= 1
}

/// One line, bounded length, and no angle brackets so injected content
/// can't imitate our wrapper tags (memories are data, not markup).
/// Shared with the server-side ambient block formatter.
pub(crate) fn sanitize(s: &str, max: usize) -> String {
    let collapsed: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned: String = collapsed
        .chars()
        .map(|c| match c {
            '<' => '(',
            '>' => ')',
            c => c,
        })
        .take(max)
        .collect();
    cleaned
}

// ---------------------------------------------------------------------------
// Per-session dedupe (don't re-inject what's already in context)
// ---------------------------------------------------------------------------

fn seen_path(session_id: &str) -> PathBuf {
    // session_id is a UUID from Claude Code; sanitize anyway.
    let safe: String = session_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(64)
        .collect();
    std::env::temp_dir().join(format!("nv-hook-{safe}.seen"))
}

/// Newest `cap` seen-ids for this session, sent to the server as
/// `exclude_ids`. The seen-file is append-only (newest last), so we take
/// the tail, preserve order, and dedupe (keeping the first occurrence in
/// the window). Missing/unreadable file → empty (fail open).
fn read_seen_recent(session_id: &str, cap: usize) -> Vec<String> {
    let Ok(contents) = std::fs::read_to_string(seen_path(session_id)) else {
        return Vec::new();
    };
    let mut lines: Vec<String> = contents
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    // Keep only the newest `cap` (the tail), then dedupe in place.
    if lines.len() > cap {
        lines = lines.split_off(lines.len() - cap);
    }
    let mut seen = HashSet::new();
    lines.retain(|id| seen.insert(id.clone()));
    lines
}

/// Append newly injected ids, preserving order (the file is the dedupe
/// history, newest last). When it grows past 2000 lines, keep the most
/// recent 1000 — old entries age out; the NEWEST are never dropped.
fn append_seen(session_id: &str, new_ids: &[String]) {
    if new_ids.is_empty() {
        return;
    }
    let path = seen_path(session_id);
    let mut lines: Vec<String> = std::fs::read_to_string(&path)
        .map(|s| s.lines().map(str::to_string).collect())
        .unwrap_or_default();
    lines.extend(new_ids.iter().cloned());
    if lines.len() > 2000 {
        lines = lines.split_off(lines.len() - 1000);
    }
    let _ = std::fs::write(&path, lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Install / uninstall / status (settings.json wiring)
// ---------------------------------------------------------------------------

/// `$CLAUDE_CONFIG_DIR/settings.json`, default `~/.claude/settings.json`.
pub fn claude_settings_path() -> PathBuf {
    let dir = std::env::var("CLAUDE_CONFIG_DIR")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".claude")
        });
    dir.join("settings.json")
}

/// Markers used to recognize our entries in settings.json. We match on
/// the hook SUBCOMMAND arguments, not the binary path — the path varies
/// (dev target/, /Applications, target-triple-suffixed sidecar names)
/// but `<binary> hook user-prompt-submit` is uniquely ours.
const HOOK_ARG_MARKERS: [&str; 2] = [" hook user-prompt-submit", " hook session-start"];

fn is_our_entry(entry: &Value) -> bool {
    entry
        .get("hooks")
        .and_then(|h| h.as_array())
        .map(|arr| {
            arr.iter().any(|h| {
                h.get("command")
                    .and_then(|c| c.as_str())
                    .map(|c| HOOK_ARG_MARKERS.iter().any(|m| c.contains(m)))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn our_entry(binary: &Path, event_arg: &str, matcher: Option<&str>) -> Value {
    // `|| true`: shell-level fail-open. If the binary is missing, or is
    // an older build without the `hook` subcommand (whose arg parser
    // exits 2 — the code that BLOCKS a UserPromptSubmit), the command
    // still exits 0. No NeuroVault failure may ever block a prompt.
    let fail_open = if cfg!(windows) { "" } else { " || true" };
    let mut entry = json!({
        "hooks": [{
            "type": "command",
            "command": format!("\"{}\" hook {}{}", binary.display(), event_arg, fail_open),
            "timeout": 10
        }]
    });
    if let Some(m) = matcher {
        entry["matcher"] = json!(m);
    }
    entry
}

/// Copy `binary` to a stable location no build system touches. Global
/// hooks must NEVER point into a repo's target/ directory: builds and
/// checkouts from other sessions replace those binaries, and a stale
/// binary without the `hook` subcommand blocked every prompt in every
/// session (incident 2026-07-07). The snapshot under ~/.neurovault/bin
/// changes only when install runs again.
fn snapshot_binary(binary: &Path, snapshot_dir: &Path) -> Result<PathBuf> {
    std::fs::create_dir_all(snapshot_dir)
        .map_err(|e| MemoryError::Other(format!("create {}: {e}", snapshot_dir.display())))?;
    let dest = snapshot_dir.join("neurovault-hook");
    // Copy via temp + rename so a concurrent hook invocation never sees
    // a half-written executable.
    let tmp = snapshot_dir.join(".neurovault-hook.tmp");
    std::fs::copy(binary, &tmp).map_err(|e| MemoryError::Other(format!("snapshot copy: {e}")))?;
    std::fs::rename(&tmp, &dest)
        .map_err(|e| MemoryError::Other(format!("snapshot rename: {e}")))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755));
    }
    Ok(dest)
}

/// Install (or refresh) the auto-recall hooks in `settings_path`,
/// pointing them at a stable SNAPSHOT of `binary` (see
/// `snapshot_binary`). Idempotent: existing NeuroVault entries are
/// replaced, everything else in the file is preserved byte-for-byte at
/// the JSON level.
pub fn install_hooks_at(settings_path: &Path, binary: &Path) -> Result<String> {
    install_hooks_snapshot(settings_path, binary, &nv_bin_dir())
}

/// Default stable directory for hook binaries: ~/.neurovault/bin.
fn nv_bin_dir() -> PathBuf {
    super::paths::nv_home().join("bin")
}

/// Testable core of install: `snapshot_dir` is where the binary copy
/// lives (production: ~/.neurovault/bin).
pub fn install_hooks_snapshot(
    settings_path: &Path,
    binary: &Path,
    snapshot_dir: &Path,
) -> Result<String> {
    if !binary.exists() {
        return Err(MemoryError::Other(format!(
            "hook binary not found at {}",
            binary.display()
        )));
    }
    let binary = &snapshot_binary(binary, snapshot_dir)?;
    // The command string is parsed by a shell: refuse binary paths with
    // shell-active characters rather than trying to escape them.
    let bin_str = binary.display().to_string();
    if bin_str.contains(['"', '$', '`', '\\']) {
        return Err(MemoryError::Other(format!(
            "binary path contains shell-special characters and cannot be installed safely: {bin_str}"
        )));
    }
    let mut root: Value = match std::fs::read_to_string(settings_path) {
        Ok(s) => serde_json::from_str(&s)
            .map_err(|e| MemoryError::Other(format!("settings.json is not valid JSON: {e}")))?,
        // ONLY a genuinely missing file starts from empty. Any other
        // read failure (permissions, invalid UTF-8, I/O) must not
        // rebuild the user's settings from scratch.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => {
            return Err(MemoryError::Other(format!(
                "cannot read settings.json ({e}); refusing to overwrite it"
            )))
        }
    };
    if !root.is_object() {
        return Err(MemoryError::Other(
            "settings.json root is not a JSON object".into(),
        ));
    }

    // One-time backup before the first write we ever make.
    let backup = settings_path.with_extension("json.nv-backup");
    if settings_path.exists() && !backup.exists() {
        let _ = std::fs::copy(settings_path, &backup);
    }

    let hooks = root
        .as_object_mut()
        .expect("checked is_object above")
        .entry("hooks")
        .or_insert_with(|| json!({}));
    if !hooks.is_object() {
        return Err(MemoryError::Other(
            "settings.json 'hooks' is not an object".into(),
        ));
    }

    for (event, arg, matcher) in [
        ("UserPromptSubmit", "user-prompt-submit", None),
        (
            "SessionStart",
            "session-start",
            Some("startup|resume|clear"),
        ),
    ] {
        let arr = hooks
            .as_object_mut()
            .expect("checked above")
            .entry(event)
            .or_insert_with(|| json!([]));
        if !arr.is_array() {
            return Err(MemoryError::Other(format!(
                "settings.json hooks.{event} is not an array"
            )));
        }
        let list = arr.as_array_mut().expect("checked above");
        list.retain(|e| !is_our_entry(e));
        list.push(our_entry(binary, arg, matcher));
    }

    if let Some(parent) = settings_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    write_atomic(settings_path, &serde_json::to_string_pretty(&root).unwrap())?;
    Ok(format!(
        "auto-recall hooks installed in {} (backup: {})",
        settings_path.display(),
        backup.display()
    ))
}

/// Remove our entries; leaves everything else untouched.
pub fn uninstall_hooks_at(settings_path: &Path) -> Result<String> {
    let Ok(s) = std::fs::read_to_string(settings_path) else {
        return Ok("nothing installed (no settings.json)".into());
    };
    let mut root: Value = serde_json::from_str(&s)
        .map_err(|e| MemoryError::Other(format!("settings.json is not valid JSON: {e}")))?;
    let mut removed = 0usize;
    if let Some(hooks) = root.get_mut("hooks").and_then(|h| h.as_object_mut()) {
        for event in ["UserPromptSubmit", "SessionStart"] {
            if let Some(list) = hooks.get_mut(event).and_then(|a| a.as_array_mut()) {
                let before = list.len();
                list.retain(|e| !is_our_entry(e));
                removed += before - list.len();
            }
        }
    }
    if removed > 0 {
        write_atomic(settings_path, &serde_json::to_string_pretty(&root).unwrap())?;
    }
    Ok(format!("removed {removed} NeuroVault hook entr(y/ies)"))
}

/// Temp-file-plus-rename so a crash mid-write can never leave the
/// user's Claude Code settings truncated (same pattern app.rs uses for
/// ~/.claude.json).
fn write_atomic(path: &Path, contents: &str) -> Result<()> {
    let tmp = path.with_extension("json.nv-tmp");
    std::fs::write(&tmp, contents)
        .map_err(|e| MemoryError::Other(format!("write {}: {e}", tmp.display())))?;
    std::fs::rename(&tmp, path)
        .map_err(|e| MemoryError::Other(format!("rename over {}: {e}", path.display())))?;
    Ok(())
}

/// True when ANY of our entries is present. `any` (not `all`) so a
/// partial install still reports installed — the toggle then offers
/// "off", and uninstall removes whatever residue exists. `all` would
/// show Off while a leftover prompt hook keeps injecting.
pub fn hooks_installed_at(settings_path: &Path) -> bool {
    let Ok(s) = std::fs::read_to_string(settings_path) else {
        return false;
    };
    let Ok(root) = serde_json::from_str::<Value>(&s) else {
        return false;
    };
    ["UserPromptSubmit", "SessionStart"].iter().any(|event| {
        root.get("hooks")
            .and_then(|h| h.get(*event))
            .and_then(|a| a.as_array())
            .map(|list| list.iter().any(is_our_entry))
            .unwrap_or(false)
    })
}

/// Locate the bundled `neurovault-server` binary: next to the current
/// executable first (app bundle and dev target/ both), then PATH.
pub fn server_binary_path() -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        // If we ARE neurovault-server, use ourselves.
        if exe
            .file_stem()
            .map(|s| s.to_string_lossy().contains("neurovault-server"))
            .unwrap_or(false)
        {
            return Some(exe);
        }
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_settings(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nv-hooks-test-{name}-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        dir.join("settings.json")
    }

    /// Tests must never write into the real ~/.neurovault/bin.
    fn tmp_snapshot_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nv-hooks-snap-{name}-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    fn install_for_test(settings: &Path, binary: &Path, name: &str) -> Result<String> {
        install_hooks_snapshot(settings, binary, &tmp_snapshot_dir(name))
    }

    fn fake_binary() -> PathBuf {
        // current_exe always exists and contains no spaces-with-quotes
        // issues for the command string in tests.
        std::env::current_exe().unwrap()
    }

    #[test]
    fn install_is_idempotent_and_preserves_existing_hooks() {
        let path = tmp_settings("idem");
        // Pre-existing foreign hook must survive.
        std::fs::write(
            &path,
            r#"{"model":"opus","hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"node /x/gatekeeper.mjs"}]}]}}"#,
        )
        .unwrap();
        let bin = fake_binary();
        install_for_test(&path, &bin, "idem").unwrap();
        install_for_test(&path, &bin, "idem").unwrap(); // twice on purpose

        let root: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        // top-level keys preserved
        assert_eq!(root["model"], "opus");
        let ups = root["hooks"]["UserPromptSubmit"].as_array().unwrap();
        // foreign + exactly ONE of ours despite double install
        assert_eq!(ups.len(), 2, "{ups:?}");
        assert!(ups.iter().filter(|e| is_our_entry(e)).count() == 1);
        assert!(ups.iter().any(|e| {
            e["hooks"][0]["command"]
                .as_str()
                .map(|c| c.contains("gatekeeper"))
                .unwrap_or(false)
        }));
        // SessionStart got its matcher
        let ss = root["hooks"]["SessionStart"].as_array().unwrap();
        assert!(ss.iter().any(is_our_entry));
        assert_eq!(ss[0]["matcher"], "startup|resume|clear");
        assert!(hooks_installed_at(&path));
    }

    #[test]
    fn uninstall_removes_only_ours() {
        let path = tmp_settings("uninst");
        std::fs::write(
            &path,
            r#"{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"node /x/other.mjs"}]}]}}"#,
        )
        .unwrap();
        let bin = fake_binary();
        install_for_test(&path, &bin, "uninst").unwrap();
        assert!(hooks_installed_at(&path));
        uninstall_hooks_at(&path).unwrap();
        assert!(!hooks_installed_at(&path));
        let root: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let ups = root["hooks"]["UserPromptSubmit"].as_array().unwrap();
        assert_eq!(ups.len(), 1);
        assert!(ups[0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains("other.mjs"));
    }

    #[test]
    fn install_replaces_stale_binary_path() {
        let path = tmp_settings("stale");
        // Simulate an old install pointing at a dev path.
        std::fs::write(
            &path,
            r#"{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"\"/old/target/debug/neurovault-server\" hook user-prompt-submit","timeout":10}]}]}}"#,
        )
        .unwrap();
        let bin = fake_binary();
        install_for_test(&path, &bin, "stale").unwrap();
        let root: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let ups = root["hooks"]["UserPromptSubmit"].as_array().unwrap();
        assert_eq!(ups.len(), 1, "stale entry must be replaced, not duplicated");
        let cmd = ups[0]["hooks"][0]["command"].as_str().unwrap();
        // Points at the stable SNAPSHOT, never a repo target/ path, and
        // carries the shell-level fail-open so a version-skewed binary
        // can never block a prompt (incident 2026-07-07).
        assert!(cmd.contains("neurovault-hook"), "{cmd}");
        assert!(!cmd.contains("/old/target"));
        #[cfg(not(windows))]
        assert!(cmd.ends_with("|| true"), "{cmd}");
    }

    #[test]
    fn corrupt_settings_is_an_error_not_a_clobber() {
        let path = tmp_settings("corrupt");
        std::fs::write(&path, "{ not json").unwrap();
        let before = std::fs::read_to_string(&path).unwrap();
        assert!(install_for_test(&path, &fake_binary(), "corrupt").is_err());
        // file untouched
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
    }

    #[test]
    fn conversational_glue_is_skipped_topical_passes() {
        // The exact prompt that injected ML noise in live use 2026-07-07.
        assert!(!worth_recalling(
            "then lets continue and make sure that it works well"
        ));
        assert!(!worth_recalling("ok great lets keep going with this"));
        assert!(!worth_recalling("please make sure everything looks good"));
        // One substantive token is enough.
        assert!(worth_recalling("fix the reranker"));
        assert!(worth_recalling("lets continue with the supabase migration"));
        assert!(worth_recalling("make sure the throttle bypass works"));
        // Non-English content passes open (the stoplist is English-only).
        assert!(worth_recalling("erklaere mir die architektur bitte"));
    }

    #[test]
    fn trivial_prompts_are_skipped() {
        assert!(!worth_recalling("yes"));
        assert!(!worth_recalling("continue"));
        assert!(!worth_recalling("/model opus"));
        assert!(!worth_recalling("# remember this")); // memory shortcut
        assert!(!worth_recalling("   ok   "));
        assert!(worth_recalling(
            "what do we know about the reranker benchmark"
        ));
    }

    #[test]
    fn sanitize_bounds_and_neutralizes_markup() {
        let s = sanitize("hello\n\n  <script>world</script>  \t tail", 200);
        assert_eq!(s, "hello (script)world(/script) tail");
        assert!(sanitize(&"x".repeat(500), 100).len() == 100);
    }

    #[test]
    fn seen_roundtrip_dedupes_and_truncation_keeps_newest() {
        let sid = format!("test-{}", std::process::id());
        let _ = std::fs::remove_file(seen_path(&sid));
        append_seen(&sid, &["abc".to_string()]);
        assert_eq!(read_seen_recent(&sid, 200), vec!["abc".to_string()]);
        // Push past the 2000 append cap; the NEWEST ids must survive.
        for i in 0..2005 {
            append_seen(&sid, &[format!("id-{i}")]);
        }
        let loaded = read_seen_recent(&sid, 200);
        assert!(
            loaded.contains(&"id-2004".to_string()),
            "newest id must never be dropped"
        );
        assert!(
            !loaded.contains(&"abc".to_string()),
            "oldest ids age out of the exclude window"
        );
        let _ = std::fs::remove_file(seen_path(&sid));
    }

    #[test]
    fn read_seen_recent_bounds_order_and_dedupe() {
        let sid = format!("test-recent-{}", std::process::id());
        let path = seen_path(&sid);
        let _ = std::fs::remove_file(&path);
        // Missing file → empty, never an error (fail open).
        assert!(read_seen_recent(&sid, 5).is_empty());
        // Append-only file, newest LAST; includes a duplicate and a
        // blank line (a partial write must not become an empty id).
        std::fs::write(&path, "a\nb\n\nc\nb\nd\n").unwrap();
        // Under the cap: order preserved, duplicate b collapsed.
        assert_eq!(read_seen_recent(&sid, 100), vec!["a", "b", "c", "d"]);
        // Cap keeps the TAIL (newest): the last 3 non-empty lines.
        assert_eq!(read_seen_recent(&sid, 3), vec!["c", "b", "d"]);
        let _ = std::fs::remove_file(&path);
    }

    /// Temp fixture `<root>/myrepo/sub/dir` with a `.git` at the repo
    /// level; `head` controls `.git/HEAD` contents; `git_is_file`
    /// simulates a linked worktree (`.git` is a FILE, not a dir).
    /// Returns the nested cwd the hook would resolve from.
    fn git_fixture(name: &str, head: Option<&str>, git_is_file: bool) -> PathBuf {
        let root = std::env::temp_dir().join(format!("nv-hooks-git-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let repo = root.join("myrepo");
        let cwd = repo.join("sub").join("dir");
        std::fs::create_dir_all(&cwd).unwrap();
        if git_is_file {
            std::fs::write(repo.join(".git"), "gitdir: /elsewhere/worktrees/x\n").unwrap();
        } else {
            let git = repo.join(".git");
            std::fs::create_dir_all(&git).unwrap();
            if let Some(h) = head {
                std::fs::write(git.join("HEAD"), h).unwrap();
            }
        }
        cwd
    }

    #[test]
    fn repo_branch_resolves_from_git_head() {
        let cwd = git_fixture("branch", Some("ref: refs/heads/feat/x\n"), false);
        let (repo, branch) = resolve_repo_branch(Some(cwd.to_str().unwrap()));
        assert_eq!(repo.as_deref(), Some("myrepo"));
        assert_eq!(branch.as_deref(), Some("feat/x"));
    }

    #[test]
    fn detached_head_gives_repo_but_no_branch() {
        // Detached HEAD is a raw SHA, not a symbolic ref.
        let cwd = git_fixture(
            "detached",
            Some("5ff696a0000000000000000000000000deadbeef\n"),
            false,
        );
        let (repo, branch) = resolve_repo_branch(Some(cwd.to_str().unwrap()));
        assert_eq!(repo.as_deref(), Some("myrepo"));
        assert_eq!(branch, None);
    }

    #[test]
    fn worktree_git_file_gives_repo_but_no_branch() {
        let cwd = git_fixture("worktree", None, true);
        let (repo, branch) = resolve_repo_branch(Some(cwd.to_str().unwrap()));
        assert_eq!(repo.as_deref(), Some("myrepo"));
        assert_eq!(branch, None);
    }

    #[test]
    fn no_git_or_no_cwd_gives_neither() {
        // Missing / nonexistent cwd → both None, never an error.
        assert_eq!(resolve_repo_branch(None), (None, None));
        assert_eq!(
            resolve_repo_branch(Some("/nonexistent/nv/xyz")),
            (None, None)
        );
        // A real dir with no .git within the 12-level walk: use a deep
        // fixture WITHOUT creating .git (temp_dir itself could in theory
        // sit under a repo, so the depth guarantees the walk stops).
        let root = std::env::temp_dir().join(format!("nv-hooks-nogit-{}", std::process::id()));
        let mut deep = root.clone();
        for i in 0..13 {
            deep = deep.join(format!("d{i}"));
        }
        std::fs::create_dir_all(&deep).unwrap();
        assert_eq!(
            resolve_repo_branch(Some(deep.to_str().unwrap())),
            (None, None)
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn inject_line_is_valid_hook_json_and_roundtrips() {
        // Hostile block: quotes, newlines, backslashes, angle brackets —
        // everything that would break a hand-assembled line.
        let block = "<neurovault_context mode=\"ambient_recall\">\nline \"two\" \\ end\n</neurovault_context>";
        let line = inject_line(block);
        // ONE line on stdout: serde escapes newlines, never emits one.
        assert!(!line.contains('\n'), "stdout must be a single line: {line}");
        let parsed: Value = serde_json::from_str(&line).expect("hook stdout must be valid JSON");
        assert_eq!(
            parsed["hookSpecificOutput"]["hookEventName"],
            "UserPromptSubmit"
        );
        // additionalContext round-trips EXACTLY, hostile chars intact.
        assert_eq!(
            parsed["hookSpecificOutput"]["additionalContext"]
                .as_str()
                .unwrap(),
            block
        );
    }

    #[test]
    fn ambient_response_silent_or_malformed_means_silence() {
        // decision "silent" → None even if a block is (wrongly) present.
        assert!(interpret_ambient_response(&json!({
            "decision": "silent", "reason": "below_min_score",
            "memories": [], "context_block": "stale"
        }))
        .is_none());
        // inject without a context_block → None (the hook NEVER builds
        // its own block; the server owns the format).
        assert!(interpret_ambient_response(&json!({
            "decision": "inject", "memories": [{"engram_id": "x"}]
        }))
        .is_none());
        // inject with an EMPTY block → None.
        assert!(
            interpret_ambient_response(&json!({"decision": "inject", "context_block": ""}))
                .is_none()
        );
        // Wrong types / wrong shapes → None, never a panic (a
        // version-skewed server must degrade to silence, incident
        // 2026-07-07 doctrine).
        assert!(interpret_ambient_response(&json!({"decision": 42})).is_none());
        assert!(
            interpret_ambient_response(&json!({"decision": "inject", "context_block": 7}))
                .is_none()
        );
        assert!(interpret_ambient_response(&json!([1, 2, 3])).is_none());
        assert!(interpret_ambient_response(&json!(null)).is_none());
    }

    #[test]
    fn ambient_response_inject_yields_line_and_ids() {
        let resp = json!({
            "decision": "inject",
            "reason": "top ce_prob 0.82",
            "context_block": "<neurovault_context mode=\"ambient_recall\">…</neurovault_context>",
            "memories": [
                {"engram_id": "d79fb40f-1111", "title": "t1"},
                {"engram_id": "4607dacc-2222", "title": "t2"},
                {"title": "no id — skipped, not a panic"}
            ],
            "tokens": 412
        });
        let (line, ids) = interpret_ambient_response(&resp).expect("must inject");
        let parsed: Value = serde_json::from_str(&line).unwrap();
        assert!(parsed["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap()
            .contains("ambient_recall"));
        // FULL engram ids recorded for the seen-file, order preserved.
        assert_eq!(ids, vec!["d79fb40f-1111", "4607dacc-2222"]);
    }

    #[test]
    fn install_rejects_shell_special_binary_paths() {
        let path = tmp_settings("shellchars");
        let dir = std::env::temp_dir().join(format!("nv-hooks-evil-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let evil = dir.join("nv$(rm)server");
        std::fs::write(&evil, "x").unwrap();
        // The snapshot destination is safe, so a shell-special SOURCE
        // path is fine now — but the snapshot itself must succeed and
        // the resulting command must reference the safe copy.
        let out = install_for_test(&path, &evil, "shellchars");
        assert!(out.is_ok(), "{out:?}");
        let root: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let cmd = root["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap();
        assert!(!cmd.contains("rm)server"), "{cmd}");
        assert!(cmd.contains("neurovault-hook"));
        let _ = std::fs::remove_file(&evil);
    }

    #[test]
    fn partial_install_reports_installed() {
        let path = tmp_settings("partial");
        // Only the prompt hook present (e.g. user hand-deleted the other).
        std::fs::write(
            &path,
            r#"{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"\"/x/nv\" hook user-prompt-submit"}]}]}}"#,
        )
        .unwrap();
        assert!(
            hooks_installed_at(&path),
            "partial residue must report installed so the toggle can remove it"
        );
    }
}
