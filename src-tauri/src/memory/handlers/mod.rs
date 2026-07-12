//! HTTP handler functions and their request/response types.
//!
//! Every endpoint's logic lives here. Two routers mount these:
//!
//!   • `super::http_server::router` — loopback-only, zero auth.
//!     Serves the Tauri webview and the local Python MCP proxy.
//!     Same `/api/*` paths the original Python FastAPI sidecar used.
//!
//!   • `super::api_gateway::router` (planned) — external bind,
//!     bearer auth, scope check. Mounts the same handlers under a
//!     `/v1/*` prefix.
//!
//! Handlers are router-agnostic: they take their extractors, do
//! the work, return their result. Knowing which router invoked
//! them is none of their business.
//!
//! Endpoints exposed today:
//!   GET  /api/health                — liveness probe
//!   GET  /api/status                — brain stats summary
//!   GET  /api/brains                — list brains + active marker
//!   GET  /api/brains/active         — just the active id + name
//!   POST /api/brains/{id}/activate  — switch active brain
//!   GET  /api/brains/{id}/stats     — disk/note counts
//!   GET  /api/notes                 — sidebar list
//!   GET  /api/notes/{engram_id}     — single note + connections
//!   GET  /api/graph                 — knowledge graph payload
//!   GET  /api/recall                — hybrid retrieval
//!   …and ~40 more (see super::http_server::router for the full mount).

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json};
use serde::{Deserialize, Serialize};

use super::core_memory::{self, CoreBlock};
use super::db::open_brain;
use super::ingest;
use super::read_ops::{
    brain_stats, get_graph, get_note, list_brains_with_stats, list_notes, resolve_brain_id,
    BrainStats, BrainSummary, FullNote, NoteListRow,
};
use super::related::{get_related_checked, RelatedHit, RelatedOpts};
use super::retriever::{hybrid_retrieve_throttled, RecallHit, RecallOpts};
use super::todos::{self, AddTodoArgs, Todo};
use super::types::{GraphData, MemoryError};

/// Shared state extracted by every handler. Empty today — kept as a
/// type so axum's `State<ServerState>` extractor pattern is uniform
/// and we can attach things like a request-id generator or a metrics
/// handle later without changing every handler signature.
#[derive(Clone)]
pub struct ServerState {}

// ---- Error handling ------------------------------------------------------

/// Wrap `MemoryError` so axum can render it as JSON with a status
/// code the frontend + MCP proxy already understand (404 for
/// not-found, 500 for everything else).
pub struct ApiError(pub StatusCode, pub String);

impl From<MemoryError> for ApiError {
    fn from(e: MemoryError) -> Self {
        match e {
            MemoryError::BrainNotFound(id) => {
                ApiError(StatusCode::NOT_FOUND, format!("brain not found: {}", id))
            }
            MemoryError::EngramNotFound(id) => {
                ApiError(StatusCode::NOT_FOUND, format!("engram not found: {}", id))
            }
            other => ApiError(StatusCode::INTERNAL_SERVER_ERROR, other.to_string()),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        #[derive(Serialize)]
        struct ErrorBody {
            error: String,
        }
        (self.0, Json(ErrorBody { error: self.1 })).into_response()
    }
}

// ---- Handlers -----------------------------------------------------------

pub async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({"status": "ok", "service": "neurovault-rust"}))
}

#[derive(Serialize)]
pub struct FreshnessBreakdown {
    fresh: i64,
    active: i64,
    dormant: i64,
    total: i64,
}

#[derive(Serialize)]
pub struct LinkBreakdown {
    manual: i64,
    entity: i64,
    semantic: i64,
    other: i64,
    total: i64,
}

#[derive(Serialize)]
pub struct StatusBody {
    brain: String,
    // Existing fields — kept stable for older consumers (SettingsView,
    // session_start). Do not rename or remove without bumping the
    // shape version.
    memories: i64,
    chunks: i64,
    entities: i64,
    connections: i64,
    // New in v0.1.6+: brain-health snapshot. Backs the MCP `status`
    // tool so an agent can probe "is this brain healthy?" in one call
    // without scraping multiple endpoints.
    freshness: FreshnessBreakdown,
    links: LinkBreakdown,
}

/// GET /api/version — the running backend's version + pid. No auth, no DB
/// access (answers before any brain exists). Lets a launcher / MCP shim detect
/// version skew against a backend already listening on :8765 — the shared
/// singleton port that the desktop app, a prior `npx` session, or a curl-
/// installed binary all bind (first wins) — and gives a "kill PID N" target
/// when the live backend is older than the caller.
pub async fn version(_s: State<ServerState>) -> Result<Json<serde_json::Value>, ApiError> {
    Ok(Json(serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "pid": std::process::id(),
    })))
}

pub async fn status(_s: State<ServerState>) -> Result<Json<StatusBody>, ApiError> {
    let id = resolve_brain_id(None)?;
    let db = open_brain(&id)?;
    let conn = db.lock();
    let memories: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM engrams WHERE state != 'dormant'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let chunks: i64 = conn
        .query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get(0))
        .unwrap_or(0);
    let entities: i64 = conn
        .query_row("SELECT COUNT(*) FROM entities", [], |r| r.get(0))
        .unwrap_or(0);
    let connections: i64 = conn
        .query_row("SELECT COUNT(*) FROM engram_links", [], |r| r.get(0))
        .unwrap_or(0);
    // Freshness breakdown — single GROUP BY query, three buckets +
    // total. "fresh" = recently created or accessed (Ebbinghaus prior
    // is high); "active" = stable in circulation; "dormant" = decayed
    // past the threshold and excluded from default recall results.
    let count_state = |state: &str| -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM engrams WHERE state = ?1",
            [state],
            |r| r.get(0),
        )
        .unwrap_or(0)
    };
    let f_fresh = count_state("fresh");
    let f_active = count_state("active");
    let f_dormant = count_state("dormant");
    let f_total: i64 = conn
        .query_row("SELECT COUNT(*) FROM engrams", [], |r| r.get(0))
        .unwrap_or(0);
    let count_link = |kind: &str| -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM engram_links WHERE link_type = ?1",
            [kind],
            |r| r.get(0),
        )
        .unwrap_or(0)
    };
    let l_manual = count_link("manual");
    let l_entity = count_link("entity");
    let l_semantic = count_link("semantic");
    let l_other = (connections - l_manual - l_entity - l_semantic).max(0);
    Ok(Json(StatusBody {
        brain: id,
        memories,
        chunks,
        entities,
        connections,
        freshness: FreshnessBreakdown {
            fresh: f_fresh,
            active: f_active,
            dormant: f_dormant,
            total: f_total,
        },
        links: LinkBreakdown {
            manual: l_manual,
            entity: l_entity,
            semantic: l_semantic,
            other: l_other,
            total: connections,
        },
    }))
}

pub async fn brains_list(_s: State<ServerState>) -> Result<Json<Vec<BrainSummary>>, ApiError> {
    Ok(Json(list_brains_with_stats()?))
}

#[derive(Serialize)]
pub struct ActiveBrainBody {
    id: String,
}

pub async fn brains_active(_s: State<ServerState>) -> Result<Json<ActiveBrainBody>, ApiError> {
    Ok(Json(ActiveBrainBody {
        id: resolve_brain_id(None)?,
    }))
}

pub async fn brains_activate(
    Path(brain_id): Path<String>,
    _s: State<ServerState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // Rewrite brains.json → active=brain_id. Same operation the
    // existing Tauri command `set_active_brain_offline` does.
    use std::fs;

    use super::paths::registry_path;
    let data = fs::read_to_string(registry_path())
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let mut parsed: serde_json::Value = serde_json::from_str(&data)
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let exists = parsed
        .get("brains")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .any(|b| b.get("id").and_then(|v| v.as_str()) == Some(&brain_id))
        })
        .unwrap_or(false);
    if !exists {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            format!("brain not found: {}", brain_id),
        ));
    }
    parsed["active"] = serde_json::Value::String(brain_id.clone());
    let serialised = serde_json::to_string_pretty(&parsed)
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    fs::write(registry_path(), serialised)
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(
        serde_json::json!({"status": "ok", "active": brain_id}),
    ))
}

pub async fn brains_stats(
    Path(brain_id): Path<String>,
    _s: State<ServerState>,
) -> Result<Json<BrainStats>, ApiError> {
    Ok(Json(brain_stats(&brain_id)?))
}

// ---------------------------------------------------------------------------
// GET /api/audit/recent?limit=N — recent tool-call activity for the
// active brain. Drives the UI's Activity panel + the audit log view
// in Settings. Reads the last N entries from `<brain>/audit.jsonl`
// (newest first). Missing file = empty list.
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
pub struct AuditRecentQuery {
    /// How many entries to return. Defaults to 50 to match the
    /// frontend's `activityApi.recent(limit = 50)` default.
    #[serde(default)]
    pub limit: Option<usize>,
    /// Brain to read from. Defaults to the active brain when absent —
    /// matches the rest of the read-side API.
    #[serde(default)]
    pub brain: Option<String>,
}

pub async fn audit_recent(
    Query(q): Query<AuditRecentQuery>,
    _s: State<ServerState>,
) -> Result<Json<Vec<super::tool_audit::AuditEntry>>, ApiError> {
    let limit = q.limit.unwrap_or(50).clamp(1, 500);
    let brain_id = resolve_brain_id(q.brain.as_deref())?;
    let entries = super::tool_audit::recent(&brain_id, limit)?;
    Ok(Json(entries))
}

// ---------------------------------------------------------------------------
// POST /api/observations — Claude Code lifecycle-hook capture.
//
// Called by `scripts/neurovault_hook.py` (the shim wired into the user's
// Claude Code settings.json) on every SessionStart, UserPromptSubmit,
// PostToolUse, and SessionEnd event. Each event becomes an observation
// engram tagged with the session id so the whole session can later be
// retrieved as a unit.
//
// Body shape: { "event": "PostToolUse", "payload": {...} }
//   (`hook_event_name` is accepted as an alias for `event` to match
//   Claude Code's native hook payload shape.)
//
// PostToolUse policy via NEUROVAULT_HOOKS_POSTTOOLUSE env var:
//   "mutations" (default) — only Edit / Write / NotebookEdit / MultiEdit
//   "all"                 — every tool
//   "off"                 — skip PostToolUse entirely
// Mutations-only is the right default — read-only tools (Read, Grep,
// Bash, Glob) fire dozens per minute during a coding session and drown
// the vault in noise.
//
// Privacy: any text inside `<private>...</private>` tags is stripped
// before persistence, matching claude-mem's convention for users who
// migrate from there.
//
// Filename convention: `obs-{short_session}-{event_lower}-{short_uuid}.md`
// inside the vault dir so the markdown round-trips through the normal
// ingest pipeline. After ingest, the engram is tagged
// `kind='observation', agent_id='claude-code'` so it stays filterable.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ObservationBody {
    #[serde(default)]
    pub event: Option<String>,
    /// Claude Code's hook envelope uses this field name. We accept both
    /// so the same handler works whether the caller posts the wrapper
    /// shape or a raw hook payload.
    #[serde(default)]
    pub hook_event_name: Option<String>,
    #[serde(default)]
    pub payload: Option<serde_json::Value>,
    /// Brain to ingest into. Optional — falls back to the active brain
    /// from the registry. Hooks normally don't set this.
    #[serde(default)]
    pub brain: Option<String>,
    /// Pass-through fields when the hook posts a flat (un-wrapped)
    /// payload directly. We catch them via `flatten` so the handler
    /// can still find session_id, tool_name, prompt, etc.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Serialize)]
pub struct ObservationResult {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engram_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    pub event: String,
}

/// Hook events we ingest. `Stop` exists in the Claude Code hook surface
/// but is a no-op pause — skipping it keeps the observation stream
/// focused on signal-bearing events.
const OBSERVATION_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PostToolUse",
    "SessionEnd",
];

/// Tools considered "mutations" — the default PostToolUse policy
/// captures only these. Read/Grep/Bash/Glob fire too often to be
/// useful and would dominate the vault.
const MUTATION_TOOLS: &[&str] = &["edit", "write", "notebookedit", "multiedit"];

pub async fn observations(
    _s: State<ServerState>,
    Json(body): Json<ObservationBody>,
) -> Result<Json<ObservationResult>, ApiError> {
    // Normalize the body. Hook callers vary: the Python proxy used to
    // wrap as {event, payload}; raw Claude Code hooks post flat shape
    // with hook_event_name + session_id + tool_name at the top level.
    let event = body
        .event
        .clone()
        .or(body.hook_event_name.clone())
        .unwrap_or_else(|| "Unknown".to_string());

    // Merge `payload` (when wrapped) with the flat top-level fields
    // (when raw) so downstream lookups see a single object regardless
    // of caller shape.
    let mut payload = serde_json::Map::new();
    if let Some(serde_json::Value::Object(m)) = body.payload.clone() {
        payload.extend(m);
    }
    for (k, v) in body.extra.iter() {
        payload.entry(k.clone()).or_insert_with(|| v.clone());
    }

    // Filter — known events only. Unknowns are tolerated (returns
    // skipped) rather than rejected so a future Claude Code version
    // adding new hook types doesn't break us.
    if !OBSERVATION_EVENTS.iter().any(|e| *e == event) {
        return Ok(Json(ObservationResult {
            status: "skipped_unknown_event".to_string(),
            engram_id: None,
            filename: None,
            event,
        }));
    }

    // PostToolUse policy. Default "mutations" keeps the vault clean —
    // override per-environment with NEUROVAULT_HOOKS_POSTTOOLUSE=all
    // when debugging or with =off to silence entirely.
    if event == "PostToolUse" {
        let mode = std::env::var("NEUROVAULT_HOOKS_POSTTOOLUSE")
            .unwrap_or_else(|_| "mutations".to_string())
            .to_lowercase();
        if mode == "off" {
            return Ok(Json(ObservationResult {
                status: "skipped_posttooluse_off".to_string(),
                engram_id: None,
                filename: None,
                event,
            }));
        }
        if mode == "mutations" {
            let tool = payload
                .get("tool_name")
                .or_else(|| payload.get("tool"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_lowercase();
            if !MUTATION_TOOLS.iter().any(|m| *m == tool) {
                return Ok(Json(ObservationResult {
                    status: "skipped_non_mutation".to_string(),
                    engram_id: None,
                    filename: None,
                    event,
                }));
            }
        }
    }

    let (title, markdown) = format_observation(&event, &payload);

    // Brain resolution precedence:
    //   1. Explicit `brain` in the request body (rare — callers normally
    //      don't set this).
    //   2. `NEUROVAULT_OBSERVATIONS_BRAIN` env var on the server. Set
    //      this in production deployments to keep hook-captured noise
    //      out of whatever brain the user is actively recalling from.
    //      Critical for bench runs: without it, the bench's active
    //      brain (e.g. `longmemeval-bench`) ends up polluted with the
    //      operator's own Claude Code lifecycle events while the bench
    //      is in flight, contaminating recall results.
    //   3. The currently active brain (legacy default — fine for
    //      single-user single-task setups where the active brain IS
    //      the place to log activity).
    let brain_override = body.brain.clone().or_else(|| {
        std::env::var("NEUROVAULT_OBSERVATIONS_BRAIN")
            .ok()
            .filter(|s| !s.trim().is_empty())
    });

    let result = tokio::task::spawn_blocking(move || -> Result<ObservationResult, MemoryError> {
        let id = resolve_brain_id(brain_override.as_deref())?;
        let _ = super::db::open_brain(&id)?;

        // Filename pattern matches the legacy Python convention so
        // existing vaults stay queryable: obs-{short_session}-{event}-{uuid6}.md
        let session_id = payload
            .get("session_id")
            .or_else(|| payload.get("sessionId"))
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        let short_session: String = session_id.chars().take(8).collect();
        let short_uuid: String = uuid::Uuid::new_v4()
            .simple()
            .to_string()
            .chars()
            .take(6)
            .collect();
        let filename = format!(
            "obs-{}-{}-{}.md",
            short_session,
            event.to_lowercase(),
            short_uuid,
        );

        let body_text = format!("# {}\n\n{}", title, markdown);

        // Write through the normal save_note path so the ingest
        // pipeline (chunking, embedding, BM25, entities, links) runs
        // exactly the same way it does for user-authored markdown.
        // Going through the filesystem also preserves the
        // markdown-as-source-of-truth invariant.
        let vault = super::read_ops::resolve_vault_path(&id)?;
        let ctx = super::write_ops::BrainContext::resolve(Some(&id), vault)?;
        let written = super::write_ops::save_note(&ctx, &filename, &body_text)?;

        // Tag as observation so callers can filter for the hook stream
        // with `kind:observation`. Stamping agent_id='claude-code' lets
        // multi-agent setups distinguish auto-captured hook events from
        // user `remember()` calls. Failure here isn't fatal — the
        // engram is already persisted, just untagged.
        {
            let db = super::db::open_brain(&id)?;
            let conn = db.lock();
            if let Err(e) = conn.execute(
                "UPDATE engrams SET kind = 'observation', agent_id = 'claude-code' WHERE id = ?1",
                [&written.engram_id],
            ) {
                eprintln!("[observations] tag failed for {}: {}", written.engram_id, e);
            }
        }

        // Audit the observation capture so it shows up in the
        // Activity panel. Args are kept small (just event + tool)
        // because the full payload can be large (file diffs, etc.).
        let mut audit_args = serde_json::Map::new();
        audit_args.insert(
            "event".to_string(),
            serde_json::Value::String(event.clone()),
        );
        if let Some(tool) = payload
            .get("tool_name")
            .or_else(|| payload.get("tool"))
            .and_then(|v| v.as_str())
        {
            audit_args.insert(
                "tool".to_string(),
                serde_json::Value::String(tool.to_string()),
            );
        }
        let mut audit_entry = super::tool_audit::AuditEntry::new("observations")
            .with_args(serde_json::Value::Object(audit_args))
            .with_modified_ids(vec![written.engram_id.clone()])
            .with_session_id(session_id.clone())
            .with_status(200);
        if let Some(s) = payload
            .get("session_id")
            .or_else(|| payload.get("sessionId"))
            .and_then(|v| v.as_str())
        {
            audit_entry = audit_entry.with_session_id(s.to_string());
        }
        let _ = super::tool_audit::append(&id, &audit_entry);

        Ok(ObservationResult {
            status: written.status,
            engram_id: Some(written.engram_id),
            filename: Some(filename),
            event: event.clone(),
        })
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;

    Ok(Json(result))
}

/// Convert a hook payload to `(title, markdown_body)`. Each event type
/// gets a tailored shape so observations read cleanly in the UI later.
/// Mirrors the legacy Python formatter so existing markdown files in
/// users' vaults stay structurally compatible with newly-written ones.
fn format_observation(
    event: &str,
    payload: &serde_json::Map<String, serde_json::Value>,
) -> (String, String) {
    let session_id = payload
        .get("session_id")
        .or_else(|| payload.get("sessionId"))
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    let short_session: String = session_id.chars().take(8).collect();
    let timestamp = payload
        .get("timestamp")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| {
            // ISO 8601 / RFC 3339 in UTC. Matches the legacy Python
            // format so observations from old + new servers sort
            // consistently in a vault that has both.
            use time::format_description::well_known::Iso8601;
            use time::OffsetDateTime;
            OffsetDateTime::now_utc()
                .format(&Iso8601::DEFAULT)
                .unwrap_or_else(|_| "unknown".to_string())
        });

    match event {
        "SessionStart" => {
            let cwd = payload.get("cwd").and_then(|v| v.as_str()).unwrap_or("?");
            (
                format!("Session start · {}", short_session),
                format!(
                    "**Event:** SessionStart\n**Session:** `{}`\n**Started:** {}\n**Cwd:** `{}`\n",
                    session_id, timestamp, cwd
                ),
            )
        }
        "UserPromptSubmit" => {
            let prompt_raw = payload.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
            let prompt = strip_private(prompt_raw);
            let short_prompt = short_summary(&prompt, 60);
            (
                format!("User prompt · {}", short_prompt),
                format!(
                    "**Event:** UserPromptSubmit\n**Session:** `{}`\n**Time:** {}\n\n## Prompt\n\n{}\n",
                    session_id, timestamp, prompt
                ),
            )
        }
        "PostToolUse" => {
            let tool = payload
                .get("tool_name")
                .or_else(|| payload.get("tool"))
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            let tool_input = payload
                .get("tool_input")
                .map(|v| serde_json::to_string_pretty(v).unwrap_or_default())
                .unwrap_or_default();
            let tool_input = truncate(&tool_input, 1500);
            let tool_output_raw = payload
                .get("tool_response")
                .or_else(|| payload.get("output"))
                .map(|v| {
                    v.as_str()
                        .map(String::from)
                        .unwrap_or_else(|| v.to_string())
                })
                .unwrap_or_default();
            let tool_output = truncate(&strip_private(&tool_output_raw), 2000);
            (
                format!("{} · {}", tool, short_session),
                format!(
                    "**Event:** PostToolUse\n**Session:** `{}`\n**Tool:** `{}`\n**Time:** {}\n\n\
                     ## Input\n\n```json\n{}\n```\n\n## Output\n\n```\n{}\n```\n",
                    session_id, tool, timestamp, tool_input, tool_output
                ),
            )
        }
        "SessionEnd" => {
            let summary_raw = payload
                .get("summary")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let summary = strip_private(summary_raw);
            let mut body = format!(
                "**Event:** SessionEnd\n**Session:** `{}`\n**Ended:** {}\n",
                session_id, timestamp
            );
            if !summary.is_empty() {
                body.push_str(&format!("\n## Summary\n\n{}\n", summary));
            }
            (format!("Session end · {}", short_session), body)
        }
        other => {
            let dump = serde_json::Value::Object(payload.clone()).to_string();
            let dump = truncate(&dump, 2000);
            (
                format!("{} · {}", other, short_session),
                format!(
                    "**Event:** {}\n**Session:** `{}`\n**Time:** {}\n\n```json\n{}\n```\n",
                    other, session_id, timestamp, dump
                ),
            )
        }
    }
}

/// Strip `<private>...</private>` blocks. Matches claude-mem's
/// convention so migrating users get the same UX. Case-insensitive
/// and DOTALL so the tag can wrap multi-line content.
fn strip_private(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    // Simple state-machine replace — avoids pulling in the `regex`
    // crate just for one pattern. Walks the string once, emits chunks
    // between/outside `<private>`/`</private>` markers, drops the
    // wrapped content. Tag matching is case-insensitive.
    const OPEN: &str = "<private>";
    const CLOSE: &str = "</private>";
    let lower = text.to_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    while cursor < text.len() {
        if let Some(start_rel) = lower[cursor..].find(OPEN) {
            let start = cursor + start_rel;
            out.push_str(&text[cursor..start]);
            let after_open = start + OPEN.len();
            if let Some(end_rel) = lower[after_open..].find(CLOSE) {
                out.push_str("[private content removed]");
                cursor = after_open + end_rel + CLOSE.len();
            } else {
                // Unclosed tag — keep the original suffix verbatim
                // rather than swallowing the rest of the message.
                out.push_str(&text[start..]);
                break;
            }
        } else {
            out.push_str(&text[cursor..]);
            break;
        }
    }
    out
}

/// One-line summary for titles. Replaces newlines with spaces and caps
/// to `n` chars + an ellipsis. Char-aware so multibyte input doesn't
/// panic at byte boundaries.
fn short_summary(text: &str, n: usize) -> String {
    let collapsed: String = text
        .trim()
        .chars()
        .map(|c| if c == '\n' { ' ' } else { c })
        .collect();
    if collapsed.chars().count() <= n {
        return collapsed;
    }
    let truncated: String = collapsed.chars().take(n).collect();
    format!("{}…", truncated)
}

/// Char-aware truncate with `... [truncated]` suffix when cut.
fn truncate(text: &str, n: usize) -> String {
    if text.chars().count() <= n {
        return text.to_string();
    }
    let truncated: String = text.chars().take(n).collect();
    format!("{}\n... [truncated]", truncated)
}

// ---------------------------------------------------------------------------
// POST /api/brains/:brain_id/reset — wipe a brain to a clean slate.
//
// Use cases:
//   • Bench harness clearing state between questions (the original
//     reason this exists — see `bench/longmemeval/smoke_one.py`).
//   • A user choosing "start over" in the UI without rebuilding their
//     vault from scratch.
//   • Recovering from a corrupted brain by truncating + re-creating
//     the vec0 virtual table.
//
// What gets cleared:
//   • Every row in every engram-derived table (engrams, chunks, links,
//     entities, themes, episodic_facts, retrieval_feedback, …).
//   • The `vec_chunks` virtual table is DROPPED and re-created. This
//     is the load-bearing step: a naive `DELETE FROM vec_chunks_chunks`
//     from a Python sqlite3 connection (no vec0 extension loaded)
//     leaves the rowids/info shadow tables out of sync with each
//     other, and recall starts returning garbage. We do the drop +
//     recreate from inside the server, where the vec0 extension is
//     loaded, so the shadow tables are managed correctly.
//   • Optional: `?vault=true` also deletes every `.md` file under the
//     brain's vault dir. Off by default — most callers want a DB
//     reset without nuking the markdown source-of-truth.
//
// What is preserved:
//   • The brain's registry entry (id, name, description, vault_path
//     override). The brain stays in the brains list; it's just empty.
//   • `cluster_names.json` and other per-brain config files.
//   • `vec_chunks_info` schema metadata — recreated to match the
//     fresh table.
//
// Atomicity: the drop + truncate + recreate run inside a single
// transaction. If any step fails, the brain is rolled back to its
// pre-reset state. VACUUM runs after commit (SQLite forbids it
// inside a transaction); a VACUUM failure leaves the file slightly
// fatter than necessary but is not a correctness issue.
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
pub struct ResetQuery {
    /// When `true`, also delete `*.md` files under the brain's vault
    /// directory. Default `false` — most callers want a DB reset that
    /// preserves the markdown source-of-truth.
    #[serde(default)]
    vault: Option<bool>,
}

#[derive(Serialize)]
pub struct ResetResponse {
    pub brain_id: String,
    /// Number of engram rows that existed before the reset. Useful
    /// for log lines and for the bench harness to confirm something
    /// actually got cleared.
    pub engrams_purged: i64,
    /// Whether the vault dir's markdown files were deleted too.
    pub vault_purged: bool,
}

/// Tables created by either `migrations::run_all` or `SCHEMA_SQL`
/// that hold engram-derived rows. Listed explicitly (rather than
/// discovered via `sqlite_master`) so we never accidentally truncate
/// a future schema table we shouldn't touch. Keep this in sync with
/// `schema.sql`'s `CREATE TABLE` list.
///
/// Order: engram-derived rows first, then `engrams` itself last so
/// any future FK constraints fire in the right direction. We use
/// `DELETE FROM` rather than `TRUNCATE` (which SQLite doesn't have)
/// — `DELETE` without a WHERE clause is the SQLite-idiomatic full
/// wipe and gets the same fast-path under the hood.
const RESETTABLE_TABLES: &[&str] = &[
    "chunks",
    "engram_links",
    "entity_mentions",
    "entities",
    "episodic_facts",
    "temporal_facts",
    "retrieval_feedback",
    "query_affinity",
    "edge_activity",
    "theme_members",
    "themes",
    "core_memory_blocks",
    "contradictions",
    "engram_versions",
    "compilations",
    "drafts",
    "draft_sections",
    "function_calls",
    "variable_references",
    "variable_renames",
    "variables",
    "working_memory",
    "memory_types",
    // `engrams` last — any future FK on engram_id cascades cleanly.
    "engrams",
];

// ---------------------------------------------------------------------------
// Structured facts (Option D / Layer 2). The connected agent extracts a
// fact from a note and records it via POST /api/facts; recall surfaces it
// by EXACT subject-token match (retriever.rs), sidestepping the embedder
// for fact-shaped queries ("what's my X / who owns Y"). Facts are a DERIVED
// index over engrams (source_engram FK) — the markdown note stays the
// source of truth and is never overwritten. Supersession: recording a new
// value for an existing (subject, attribute) marks the prior one
// superseded_by the new id, so "current value" stays unambiguous.
// ---------------------------------------------------------------------------
#[derive(Deserialize)]
pub struct RecordFactBody {
    pub subject: String,
    #[serde(default)]
    pub attribute: String,
    pub value: String,
    pub source_engram: String,
    #[serde(default)]
    pub brain_id: Option<String>,
}

pub async fn record_fact(
    _s: State<ServerState>,
    Json(body): Json<RecordFactBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let out = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, MemoryError> {
        let id = resolve_brain_id(body.brain_id.as_deref())?;
        let db = open_brain(&id)?;
        let subject = body.subject.trim().to_lowercase();
        let attribute = body.attribute.trim().to_lowercase();
        let value = body.value.trim().to_string();
        if subject.is_empty() || value.is_empty() {
            return Ok(serde_json::json!({"ok": false, "error": "subject and value required"}));
        }
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(format!("{subject}\u{0}{attribute}\u{0}{value}").as_bytes());
        let fid: String = format!("{:x}", hasher.finalize())
            .chars()
            .take(16)
            .collect();
        let conn = db.lock();
        conn.execute(
            "UPDATE facts SET superseded_by = ?1 \
             WHERE subject = ?2 AND attribute = ?3 AND value != ?4 AND superseded_by IS NULL",
            rusqlite::params![fid, subject, attribute, value],
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO facts (id, subject, attribute, value, source_engram) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![fid, subject, attribute, value, body.source_engram],
        )?;
        Ok(serde_json::json!({"ok": true, "id": fid, "subject": subject, "value": value}))
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(out))
}

#[derive(Deserialize)]
pub struct FactsQuery {
    #[serde(default)]
    pub subject: Option<String>,
    #[serde(default)]
    pub brain_id: Option<String>,
    #[serde(default)]
    pub include_superseded: Option<bool>,
}

pub async fn facts_list(
    Query(q): Query<FactsQuery>,
    _s: State<ServerState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let out = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, MemoryError> {
        let id = resolve_brain_id(q.brain_id.as_deref())?;
        let db = open_brain(&id)?;
        let include_sup = q.include_superseded.unwrap_or(false);
        let subj = q.subject.as_deref().map(|s| s.trim().to_lowercase());
        let conn = db.lock();
        let mut sql = String::from(
            "SELECT subject, attribute, value, source_engram, (superseded_by IS NULL) FROM facts",
        );
        let mut clauses: Vec<&str> = Vec::new();
        if !include_sup {
            clauses.push("superseded_by IS NULL");
        }
        if subj.is_some() {
            clauses.push("subject = ?1");
        }
        if !clauses.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&clauses.join(" AND "));
        }
        let mut stmt = conn.prepare(&sql)?;
        let to_json = |r: &rusqlite::Row| -> rusqlite::Result<serde_json::Value> {
            Ok(serde_json::json!({
                "subject": r.get::<_, String>(0)?,
                "attribute": r.get::<_, String>(1)?,
                "value": r.get::<_, String>(2)?,
                "source_engram": r.get::<_, String>(3)?,
                "current": r.get::<_, i64>(4)? == 1,
            }))
        };
        let rows: Vec<serde_json::Value> = match &subj {
            Some(s) => stmt
                .query_map(rusqlite::params![s], to_json)?
                .filter_map(Result::ok)
                .collect(),
            None => stmt
                .query_map([], to_json)?
                .filter_map(Result::ok)
                .collect(),
        };
        Ok(serde_json::json!({"count": rows.len(), "facts": rows}))
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(out))
}

// GET /api/consolidate?limit=N — the write-time consolidation queue
// (Option D). Returns engrams the agent hasn't fact-extracted yet
// (derived: not the source_engram of any fact). The connected agent reads
// these, extracts durable facts, and POSTs each via /api/facts. A note
// that legitimately has no facts will reappear until a mark step is added
// (MVP: every processed note gets >=1 fact, so the derive suffices).
#[derive(Deserialize)]
pub struct ConsolidateQuery {
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub brain_id: Option<String>,
}

pub async fn consolidate_queue(
    Query(q): Query<ConsolidateQuery>,
    _s: State<ServerState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let out = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, MemoryError> {
        let id = resolve_brain_id(q.brain_id.as_deref())?;
        let db = open_brain(&id)?;
        let limit = q.limit.unwrap_or(10).min(50) as i64;
        let conn = db.lock();
        let mut stmt = conn.prepare(
            "SELECT id, title, content FROM engrams \
             WHERE state != 'dormant' \
               AND COALESCE(kind, 'note') NOT IN ('preference') \
               AND id NOT IN (SELECT DISTINCT source_engram FROM facts) \
             ORDER BY COALESCE(created_at, '') DESC LIMIT ?1",
        )?;
        let rows: Vec<serde_json::Value> = stmt
            .query_map(rusqlite::params![limit], |r| {
                let content: String = r.get::<_, String>(2)?;
                Ok(serde_json::json!({
                    "engram_id": r.get::<_, String>(0)?,
                    "title": r.get::<_, String>(1)?,
                    "content": content.chars().take(2000).collect::<String>(),
                }))
            })?
            .filter_map(Result::ok)
            .collect();
        Ok(serde_json::json!({"count": rows.len(), "notes": rows}))
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(out))
}

pub async fn brains_reset(
    Path(brain_id): Path<String>,
    Query(q): Query<ResetQuery>,
    _s: State<ServerState>,
) -> Result<Json<ResetResponse>, ApiError> {
    let purge_vault = q.vault.unwrap_or(false);
    let result = tokio::task::spawn_blocking(move || -> Result<ResetResponse, MemoryError> {
        let id = resolve_brain_id(Some(&brain_id))?;
        let db = open_brain(&id)?;

        // Count engrams before the wipe so the response is informative.
        // Cheap O(1) query (SQLite has the table size in pragma data).
        let count_before: i64 = {
            let conn = db.lock();
            conn.query_row("SELECT COUNT(*) FROM engrams", [], |r| r.get(0))
                .unwrap_or(0)
        };

        // Drop+truncate+recreate happens inside one transaction. If
        // any step fails the whole thing rolls back, leaving the
        // brain in its pre-reset state. VACUUM has to run after the
        // commit (SQLite forbids it inside a transaction).
        {
            let conn = db.lock();
            conn.execute_batch("BEGIN IMMEDIATE")?;

            // 1. Drop vec_chunks. With the vec0 extension loaded
            //    (it is — db::open_new calls sqlite_vec::load), DROP
            //    TABLE invokes vec0's xDestroy hook, which cleans up
            //    the shadow tables (vec_chunks_chunks, _rowids,
            //    _vector_chunks00, _info) atomically.
            if let Err(e) = conn.execute("DROP TABLE IF EXISTS vec_chunks", []) {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(MemoryError::Other(format!(
                    "failed to drop vec_chunks: {}",
                    e
                )));
            }

            // 2. Truncate engram-derived rowsets. Missing tables are
            //    tolerated (older brains may lack tables that newer
            //    migrations would have added).
            for table in RESETTABLE_TABLES {
                if let Err(e) = conn.execute(&format!("DELETE FROM {}", table), []) {
                    // Table not existing isn't an error — older brains
                    // may not have every table. Anything else is.
                    let msg = e.to_string().to_lowercase();
                    if !msg.contains("no such table") {
                        let _ = conn.execute_batch("ROLLBACK");
                        return Err(MemoryError::Other(format!(
                            "failed to truncate {}: {}",
                            table, e
                        )));
                    }
                }
            }

            // 3. Recreate vec_chunks fresh, with the exact same
            //    schema `db::ensure_vec_chunks` would create for a
            //    new brain. Hardcoding the embedding dim here (384)
            //    rather than re-importing `EMBEDDING_DIM` would
            //    break the day someone bumps the model; pull from
            //    the constant.
            let create_stmt = format!(
                "CREATE VIRTUAL TABLE vec_chunks USING vec0(chunk_id TEXT PRIMARY KEY, embedding float[{}])",
                super::embedder::EMBEDDING_DIM,
            );
            if let Err(e) = conn.execute(&create_stmt, []) {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(MemoryError::Other(format!(
                    "failed to recreate vec_chunks: {}",
                    e
                )));
            }

            conn.execute_batch("COMMIT")?;
        }

        // VACUUM reclaims pages freed by the truncate so the file
        // doesn't keep its pre-reset size on disk. Outside the
        // transaction (SQLite requirement). Failure here isn't
        // fatal — the brain is correct, just slightly fatter than
        // necessary; log and continue.
        {
            let conn = db.lock();
            if let Err(e) = conn.execute("VACUUM", []) {
                eprintln!("[brains_reset] VACUUM failed on {}: {} — continuing", id, e);
            }
        }

        // Optional vault wipe — delete every `*.md` under the vault
        // directory but leave the directory structure intact. We use
        // the resolved vault path (which may be a user-configured
        // external dir), not just `brain_dir/vault`.
        let mut vault_purged = false;
        if purge_vault {
            let vault = super::read_ops::resolve_vault_path(&id)?;
            if vault.exists() {
                match walk_and_delete_md(&vault) {
                    Ok(_) => vault_purged = true,
                    Err(e) => {
                        eprintln!(
                            "[brains_reset] vault wipe failed on {}: {} — DB reset still succeeded",
                            id, e
                        );
                    }
                }
            }
        }

        Ok(ResetResponse {
            brain_id: id,
            engrams_purged: count_before,
            vault_purged,
        })
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;

    Ok(Json(result))
}

/// Recursively delete every `*.md` file under `dir`, leaving the
/// directory structure intact. Symlinks are not followed so a
/// misconfigured vault_path can't escape into the user's home.
fn walk_and_delete_md(dir: &std::path::Path) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let path = entry.path();
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            walk_and_delete_md(&path)?;
        } else if path.extension().and_then(|s| s.to_str()) == Some("md") {
            // Best-effort delete — log and continue if one file is
            // locked. The reset is still useful even if a couple of
            // files survive.
            if let Err(e) = std::fs::remove_file(&path) {
                eprintln!("[brains_reset] could not delete {}: {}", path.display(), e);
            }
        }
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct NotesListQuery {
    /// Optional brain to scope to; None = active brain. Without this,
    /// `?brain=` was silently ignored and every caller got the active
    /// brain's notes — a scope leak the Home gallery's per-card
    /// most-used hover tripped on (2026-07-12).
    #[serde(default, alias = "brain")]
    brain_id: Option<String>,
}

pub async fn notes_list(
    Query(q): Query<NotesListQuery>,
    _s: State<ServerState>,
) -> Result<Json<Vec<NoteListRow>>, ApiError> {
    let id = resolve_brain_id(q.brain_id.as_deref())?;
    let db = open_brain(&id)?;
    Ok(Json(list_notes(&db)?))
}

pub async fn notes_detail(
    Path(engram_id): Path<String>,
    _s: State<ServerState>,
) -> Result<Json<FullNote>, ApiError> {
    let id = resolve_brain_id(None)?;
    let db = open_brain(&id)?;
    Ok(Json(get_note(&db, &engram_id)?))
}

#[derive(Deserialize)]
pub struct GraphQuery {
    #[serde(default)]
    include_observations: Option<bool>,
    #[serde(default)]
    min_similarity: Option<f64>,
    /// CSV of link_types to drop server-side (e.g. "semantic"). Missing /
    /// empty = no filter. Lets a low-power view skip the semantic hairball.
    #[serde(default)]
    exclude_types: Option<String>,
}

pub async fn graph(
    Query(q): Query<GraphQuery>,
    _s: State<ServerState>,
) -> Result<Json<GraphData>, ApiError> {
    let id = resolve_brain_id(None)?;
    let db = open_brain(&id)?;
    let exclude_types: Vec<String> = q
        .exclude_types
        .as_deref()
        .unwrap_or("")
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    Ok(Json(get_graph(
        &db,
        q.include_observations.unwrap_or(false),
        // Bumped from 0.75 to 0.85 in v0.1.7. At 0.75 a typical brain
        // ends up with 80+ edges per node (hairball) because most notes
        // share enough vocabulary to score weakly similar to most other
        // notes. 0.85 keeps the real semantic links and drops the
        // noise — measured on NeuroVaultBrain1, edges drop from 11758
        // to 2202 (avg 15/node, which actually reads as a graph).
        q.min_similarity.unwrap_or(0.85),
        &exclude_types,
    )?))
}

#[derive(Deserialize)]
pub struct RecallQuery {
    q: String,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    #[allow(dead_code)]
    mode: Option<String>,
    #[serde(default)]
    spread_hops: Option<u8>,
    #[serde(default)]
    as_of: Option<String>,
    #[serde(default)]
    include_observations: Option<bool>,
    // Accept `brain` as well as `brain_id`: the MCP proxy/forwarder sends
    // `brain` on GET /api/recall, so without this alias a per-call brain
    // override was silently ignored (recall always used the active brain).
    #[serde(default, alias = "brain")]
    brain_id: Option<String>,
    /// Comma-separated list of scoring features to disable. Used by
    /// the eval harness to A/B-test which signals earn their weight.
    /// Production callers never set this; the retriever defaults to
    /// the full pipeline.
    #[serde(default)]
    ablate: Option<String>,
    /// Cross-encoder reranker override for this call. Adds ~50-100 ms;
    /// improves top-rank precision. When absent, the app preference
    /// applies (`rerank_enabled()`: ON unless toggled off in Settings,
    /// persisted at ~/.neurovault/rerank.txt).
    #[serde(default)]
    rerank: Option<bool>,
    /// Skip the per-brain recall rate limiter for this call. Used by
    /// AMBIENT consumers (the Claude Code auto-recall hook fires on
    /// every prompt) so background recalls neither receive the
    /// throttle-hint pseudo-hit nor consume the budget that teaches
    /// AGENTS to pace their tool calls. Deliberately NOT exposed in
    /// the MCP tools.json — agents keep the throttle.
    #[serde(default)]
    throttle: Option<bool>,
}

#[derive(Deserialize)]
pub struct QuerySignalQuery {
    q: String,
    #[serde(default, alias = "brain")]
    brain_id: Option<String>,
}

/// GET /api/query_signal — corpus-driven "is this query worth a
/// retrieval?" statistics. For each query token (BM25 tokenizer, so
/// index stopwords already dropped) returns its document frequency in
/// the active brain plus the BM25-style IDF; `max_idf` is the single
/// number ambient consumers gate on. Cheap: one in-memory map lookup
/// per token, no embedding, no vector search.
pub async fn query_signal(
    Query(q): Query<QuerySignalQuery>,
    _s: State<ServerState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let out = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, MemoryError> {
        let id = resolve_brain_id(q.brain_id.as_deref())?;
        let db = open_brain(&id)?;
        let idx = super::bm25::index_for(&id);
        if idx.size() == 0 {
            idx.build(&db)?;
        }
        let (n, stats) = idx.query_signal(&q.q);
        let nf = n as f64;
        let idf = |df: u64| -> f64 {
            if n == 0 {
                return 0.0;
            }
            // Same shape as the BM25 scorer: ln((N - df + 0.5)/(df + 0.5) + 1).
            ((nf - df as f64 + 0.5) / (df as f64 + 0.5) + 1.0).ln()
        };
        let tokens: Vec<serde_json::Value> = stats
            .iter()
            .map(|(t, df)| serde_json::json!({"token": t, "df": df, "idf": idf(*df)}))
            .collect();
        let max_idf = stats.iter().map(|(_, df)| idf(*df)).fold(0.0_f64, f64::max);
        Ok(serde_json::json!({
            "brain": id,
            "n_docs": n,
            "tokens": tokens,
            "max_idf": max_idf,
        }))
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(out))
}

#[derive(Deserialize)]
pub struct JournalEventsQuery {
    #[serde(default, alias = "brain")]
    brain_id: Option<String>,
    /// Comma-separated event ids (bounded 50) — the Inspector's
    /// experience-unit timeline fetch.
    ids: String,
    /// Days back to search (default 60).
    #[serde(default)]
    days: Option<i64>,
}

/// GET /api/journal_events?ids=a,b,c — resolve evidence ids into full
/// events so the Proposal Inspector can render the unit timeline:
/// intention → injected context → outcome.
pub async fn journal_events_by_id(
    Query(q): Query<JournalEventsQuery>,
    _s: State<ServerState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let out = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, MemoryError> {
        let id = resolve_brain_id(q.brain_id.as_deref())?;
        let wanted: std::collections::HashSet<&str> = q
            .ids
            .split(',')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .take(50)
            .collect();
        let now = time::OffsetDateTime::now_utc();
        let start = now - time::Duration::days(q.days.unwrap_or(60).clamp(1, 365));
        let events: Vec<_> = super::journal::read_window(&id, start, now, None)
            .into_iter()
            .filter(|e| wanted.contains(e.event_id.as_str()))
            .collect();
        Ok(serde_json::json!({ "brain": id, "count": events.len(), "events": events }))
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(out))
}

#[derive(Deserialize)]
pub struct FalseNegativeBody {
    #[serde(default, alias = "brain")]
    brain_id: Option<String>,
    description: String,
    #[serde(default)]
    evidence: Vec<String>,
    #[serde(default)]
    reviewer: Option<String>,
}

/// POST /api/consolidation_false_negative — the human marks something
/// consolidation SHOULD have proposed and didn't. Counted in metrics:
/// impressive precision by proposing almost nothing is not success.
pub async fn consolidation_false_negative(
    _s: State<ServerState>,
    Json(body): Json<FalseNegativeBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let out = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, MemoryError> {
        if body.description.trim().len() < 4 {
            return Err(MemoryError::Other("description required".into()));
        }
        let id = resolve_brain_id(body.brain_id.as_deref())?;
        let mut ev =
            super::journal::Event::now(&id, "consolidation_false_negative", "audit", "manual");
        ev.actor = format!("user:{}", body.reviewer.as_deref().unwrap_or("user"));
        ev.after = Some(body.description.trim().chars().take(300).collect());
        ev.source_refs = body.evidence.clone();
        ev.capture_method = "review".into();
        crate::memory::journal::append(&ev)?;
        Ok(serde_json::json!({ "brain": id, "event_id": ev.event_id }))
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(out))
}

#[derive(Deserialize)]
pub struct ProposalDecisionBody {
    #[serde(default, alias = "brain")]
    brain_id: Option<String>,
    #[serde(default)]
    reviewer: Option<String>,
    #[serde(default)]
    reason: Option<String>,
    /// Field edits (name -> approved value); both values are retained.
    #[serde(default)]
    edits: std::collections::HashMap<String, String>,
}

/// POST /api/proposals/:id/approve — review decision as a journal
/// event; idempotent under concurrent approvals; applies only the
/// demonstrably safe classes (memory_strengthened, approved
/// supersessions) and acknowledges the rest.
pub async fn proposal_approve(
    Path(pid): Path<String>,
    _s: State<ServerState>,
    Json(body): Json<ProposalDecisionBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let out = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, MemoryError> {
        let id = resolve_brain_id(body.brain_id.as_deref())?;
        let reviewer = body.reviewer.as_deref().unwrap_or("user");
        let (mut rec, changed) = super::adaptive::proposals::decide(
            &id,
            &pid,
            true,
            &body.edits,
            reviewer,
            body.reason.as_deref(),
        )?;
        // APPLICATION is a separate axis from REVIEW: an executor
        // failure lands in application_status/Failed and never rewrites
        // the human's verdict. Only demonstrably safe classes execute;
        // the rest stay Pending until their executor (or evidence)
        // exists.
        use super::adaptive::proposals::{set_application, ApplicationStatus};
        if changed {
            let outcome: std::result::Result<Option<&str>, String> = match rec.action.as_str() {
                "memory_strengthened" => {
                    let db = open_brain(&id)?;
                    let conn = db.lock();
                    match conn.execute(
                        "UPDATE engrams SET last_confirmed_at = datetime('now') WHERE id = ?1",
                        rusqlite::params![rec.object_id],
                    ) {
                        Ok(n) if n > 0 => Ok(Some("last_confirmed_at refreshed")),
                        Ok(_) => Err("engram not found to strengthen".into()),
                        Err(e) => Err(e.to_string()),
                    }
                }
                "supersession_suggestion" => {
                    let field = |name: &str| {
                        rec.fields
                            .iter()
                            .find(|f| f.name == name)
                            .map(|f| f.approved_value.clone().unwrap_or(f.proposed_value.clone()))
                    };
                    match (field("superseded_engram"), field("superseded_by")) {
                        (Some(older), Some(newer)) => {
                            let db = open_brain(&id)?;
                            let reason =
                                format!("approved consolidation proposal {}", rec.proposal_id);
                            match super::write_ops::supersede_note(
                                &db,
                                &older,
                                &newer,
                                Some(&reason),
                            ) {
                                Ok(true) => Ok(Some("note superseded")),
                                Ok(false) => Err("engram not found to supersede".into()),
                                Err(e) => Err(e.to_string()),
                            }
                        }
                        _ => Err("missing supersession fields".into()),
                    }
                }
                // No executor yet: approved but application stays
                // Pending (working_state_refresh awaits the hardened
                // transcript reader; room summaries await their
                // summariser).
                _ => Ok(None),
            };
            rec = match outcome {
                Ok(Some(_)) => {
                    set_application(&id, &rec.proposal_id, ApplicationStatus::Applied, None)?
                }
                Ok(None) => rec, // stays Pending
                Err(e) => {
                    set_application(&id, &rec.proposal_id, ApplicationStatus::Failed, Some(&e))?
                }
            };
        }
        let applied_note = format!(
            "{:?}{}",
            rec.application_status,
            rec.application_error
                .as_deref()
                .map(|e| format!(": {e}"))
                .unwrap_or_default()
        );
        Ok(serde_json::json!({
            "brain": id,
            "proposal": rec,
            "changed": changed,
            "apply": applied_note,
        }))
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(out))
}

/// POST /api/proposals/:id/reject
pub async fn proposal_reject(
    Path(pid): Path<String>,
    _s: State<ServerState>,
    Json(body): Json<ProposalDecisionBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let out = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, MemoryError> {
        let id = resolve_brain_id(body.brain_id.as_deref())?;
        let reviewer = body.reviewer.as_deref().unwrap_or("user");
        let (rec, changed) = super::adaptive::proposals::decide(
            &id,
            &pid,
            false,
            &std::collections::HashMap::new(),
            reviewer,
            body.reason.as_deref(),
        )?;
        Ok(serde_json::json!({ "brain": id, "proposal": rec, "changed": changed }))
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(out))
}

/// GET /api/proposals?brain=&status= — the Inspector's review queue.
pub async fn proposals_list(
    Query(q): Query<AmbientLogQuery>,
    _s: State<ServerState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let out = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, MemoryError> {
        let id = resolve_brain_id(q.brain_id.as_deref())?;
        let all = super::adaptive::proposals::load_all(&id);
        let mut list: Vec<_> = all
            .into_values()
            .filter(|p| {
                q.decision.as_deref().is_none_or(|want| {
                    format!("{:?}", p.review_status).eq_ignore_ascii_case(&want.replace('_', ""))
                })
            })
            .collect();
        list.sort_by(|a, b| b.proposed_at.cmp(&a.proposed_at));
        list.truncate(q.limit.unwrap_or(100).min(500));
        Ok(serde_json::json!({ "brain": id, "count": list.len(), "proposals": list }))
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(out))
}

/// GET /api/consolidation_metrics — review quality beyond approval
/// rate (untouched vs edited approvals, field edit rate, per-type and
/// per-band precision, unreviewed backlog, audited false negatives).
pub async fn consolidation_metrics(
    Query(q): Query<AmbientLogQuery>,
    _s: State<ServerState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let out = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, MemoryError> {
        let id = resolve_brain_id(q.brain_id.as_deref())?;
        let m = super::adaptive::proposals::metrics(&id);
        serde_json::to_value(&m).map_err(|e| MemoryError::Other(e.to_string()))
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(out))
}

#[derive(Deserialize)]
pub struct ConsolidateBody {
    #[serde(default, alias = "brain")]
    brain_id: Option<String>,
    #[serde(default)]
    room: Option<String>,
    /// Window to consolidate, in hours back from now (default 24).
    #[serde(default)]
    window_hours: Option<i64>,
    /// "shadow" (default) or "proposal" (stage 2: proposals enter the
    /// review store; watermark advances).
    #[serde(default)]
    mode: Option<String>,
}

/// POST /api/consolidate — SHADOW mode (stage 1): reads experience
/// units from the journal, returns a deterministic report with
/// evidence-cited proposals, writes NOTHING to memories. The report
/// also lands in logs/consolidation_reports.jsonl for the Inspector.
pub async fn consolidate_shadow(
    _s: State<ServerState>,
    Json(body): Json<ConsolidateBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let out = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, MemoryError> {
        let id = resolve_brain_id(body.brain_id.as_deref())?;
        let scope = scope_for(&id, body.room.as_deref());
        let now = time::OffsetDateTime::now_utc();
        let hours = body.window_hours.unwrap_or(24).clamp(1, 24 * 90);
        let report = if body.mode.as_deref() == Some("proposal") {
            super::adaptive::consolidate::run_proposal(&scope)?
        } else {
            super::adaptive::consolidate::run_shadow(
                &scope,
                now - time::Duration::hours(hours),
                now,
            )?
        };
        serde_json::to_value(&report).map_err(|e| MemoryError::Other(e.to_string()))
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(out))
}

/// GET /api/consolidation_reports — the Inspector's consolidation feed.
pub async fn consolidation_reports(
    Query(q): Query<AmbientLogQuery>,
    _s: State<ServerState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let out = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, MemoryError> {
        let limit = q.limit.unwrap_or(20).min(200);
        let path = super::paths::nv_home()
            .join("logs")
            .join("consolidation_reports.jsonl");
        let raw = std::fs::read_to_string(&path).unwrap_or_default();
        let records: Vec<serde_json::Value> = raw
            .lines()
            .rev()
            .filter_map(|l| serde_json::from_str(l).ok())
            .filter(|r: &serde_json::Value| {
                q.brain_id
                    .as_deref()
                    .is_none_or(|b| r["brain"].as_str() == Some(b))
            })
            .take(limit)
            .collect();
        Ok(serde_json::json!({ "count": records.len(), "records": records }))
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(out))
}

#[derive(Deserialize)]
pub struct JournalEventBody {
    #[serde(default, alias = "brain")]
    brain_id: Option<String>,
    event_type: String,
    #[serde(default)]
    object_type: Option<String>,
    #[serde(default)]
    object_id: Option<String>,
    #[serde(default)]
    room: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    host: Option<String>,
    #[serde(default)]
    actor: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    before: Option<String>,
    #[serde(default)]
    after: Option<String>,
    #[serde(default)]
    source_refs: Vec<String>,
    #[serde(default)]
    idempotency_key: Option<String>,
    #[serde(default)]
    capture_method: Option<String>,
}

/// POST /api/journal_event — the outcome-capture channel (adaptive
/// spec §12b). Thin hosts (hooks, IDE adapters) report normalized
/// experience events; the server stamps identity and appends to the
/// immutable journal. Idempotent when the caller supplies a key
/// (repeated hook deliveries are one occurrence).
pub async fn journal_event(
    _s: State<ServerState>,
    Json(body): Json<JournalEventBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let out = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, MemoryError> {
        if body.event_type.trim().is_empty() {
            return Err(MemoryError::Other("event_type required".into()));
        }
        let id = resolve_brain_id(body.brain_id.as_deref())?;
        let mut ev = super::journal::Event::now(
            &id,
            body.event_type.trim(),
            body.object_type.as_deref().unwrap_or("session"),
            body.object_id
                .as_deref()
                .or(body.session_id.as_deref())
                .unwrap_or("unknown"),
        );
        ev.room = body.room.clone();
        ev.session_id = body.session_id.clone();
        ev.host = body.host.clone();
        if let Some(a) = &body.actor {
            ev.actor = a.clone();
        }
        ev.title = body.title.clone();
        ev.before = body.before.clone();
        ev.after = body.after.clone();
        ev.source_refs = body.source_refs.clone();
        ev.idempotency_key = body.idempotency_key.clone();
        ev.capture_method = body
            .capture_method
            .clone()
            .unwrap_or_else(|| "endpoint".into());
        // Causal turn stamping: outcome events reference the
        // context_decision that opened their turn — resolved by
        // explicit session identity, never wall-clock adjacency
        // (interleaved sessions destroy timestamp grouping).
        if ev.turn_id.is_none() && ev.event_type != "context_decision" {
            if let Some(sid) = ev.session_id.clone() {
                if let Some(opened) =
                    super::journal::latest_for_session(&id, &sid, "context_decision")
                {
                    ev.turn_id = opened.turn_id.clone();
                    ev.source_refs
                        .push(format!("caused_by:{}", opened.event_id));
                }
            }
        }
        let written = super::journal::append_idempotent(&ev)?;
        Ok(serde_json::json!({
            "brain": id,
            "event_id": ev.event_id,
            "written": written,
        }))
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(out))
}

#[derive(Deserialize)]
pub struct AmbientLogQuery {
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default, alias = "brain")]
    brain_id: Option<String>,
    /// "inject" | "silent" — omit for both.
    #[serde(default)]
    decision: Option<String>,
    #[serde(default)]
    intent: Option<String>,
}

/// GET /api/ambient_log — the Memory Inspector's feed (adaptive-memory
/// spec V1c-1). Returns the newest decision-log records, newest first,
/// with optional brain/decision/intent filters. Reads the JSONL tail;
/// the log rotates at 8MB so a full read stays cheap.
pub async fn ambient_log(
    Query(q): Query<AmbientLogQuery>,
    _s: State<ServerState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let out = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, MemoryError> {
        let limit = q.limit.unwrap_or(50).min(500);
        let path = super::ambient::log_path();
        let raw = std::fs::read_to_string(&path).unwrap_or_default();
        let mut records: Vec<serde_json::Value> = raw
            .lines()
            .rev()
            .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
            .filter(|r| {
                q.brain_id
                    .as_deref()
                    .is_none_or(|b| r["brain"].as_str() == Some(b))
                    && q.decision
                        .as_deref()
                        .is_none_or(|d| r["decision"].as_str() == Some(d))
                    && q.intent
                        .as_deref()
                        .is_none_or(|i| r["intent"].as_str() == Some(i))
            })
            .take(limit)
            .collect();
        // rev() above walks newest-last files backwards, so records are
        // already newest-first; keep them that way.
        let total = records.len();
        records.shrink_to_fit();
        Ok(serde_json::json!({ "records": records, "count": total }))
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(out))
}

/// GET /api/home_brief — the living-memory briefing for the Home
/// screen (read-only). Assembles, across ALL brains: the freshest
/// "continue where you left off" candidate (from each brain's
/// WorkingState), the total review backlog, how many sessions were
/// observed today, and a short "since you were away" digest of
/// meaningful recent changes. One call so Home stays snappy; touches
/// no memory semantics (pure read of state the system already keeps).
pub async fn home_brief(_s: State<ServerState>) -> Result<Json<serde_json::Value>, ApiError> {
    let out = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, MemoryError> {
        use time::OffsetDateTime;
        let now = OffsetDateTime::now_utc();
        let day_ago = now - time::Duration::hours(24);
        let midnight = now.replace_time(time::Time::MIDNIGHT);

        let brains = super::read_ops::list_brains_with_stats()?;
        let mut needs_review = 0usize;
        let mut sessions_today = 0usize;
        let mut best_continue: Option<serde_json::Value> = None;
        let mut best_updated = String::new();
        let mut since: Vec<serde_json::Value> = Vec::new();

        for b in &brains {
            let scope = super::adaptive::Scope {
                brain_id: b.id.clone(),
                room: None,
            };
            // Continue candidate: freshest non-empty working state.
            let ws = super::adaptive::types::load_working_state(&scope);
            if !ws.is_empty() {
                if let Some(ts) = &ws.updated_at {
                    if ts.as_str() > best_updated.as_str() {
                        best_updated = ts.clone();
                        best_continue = Some(serde_json::json!({
                            "brain": b.id,
                            "brain_name": b.name,
                            "current_task": ws.current_task,
                            "next_step": ws.next_step,
                            "last_files": ws.last_files,
                            "updated_at": ws.updated_at,
                            "stale": ws.is_stale(now),
                        }));
                    }
                }
            }
            // Review backlog (unreviewed proposals) across brains.
            needs_review += super::adaptive::proposals::load_all(&b.id)
                .values()
                .filter(|p| {
                    matches!(
                        p.review_status,
                        super::adaptive::proposals::ReviewStatus::Unreviewed
                    )
                })
                .count();
            // Recent journal → sessions today + a change digest.
            let events = super::journal::read_window(&b.id, day_ago, now, None);
            let mut seen_sessions = std::collections::HashSet::new();
            for e in &events {
                if let (Some(sid), Ok(ts)) = (
                    e.session_id.as_deref(),
                    time::OffsetDateTime::parse(
                        &e.ts,
                        &time::format_description::well_known::Rfc3339,
                    ),
                ) {
                    if ts >= midnight {
                        seen_sessions.insert(sid.to_string());
                    }
                }
                let text = match e.event_type.as_str() {
                    "playbook_rule_added" => {
                        Some(format!("A correction became a rule in {}", b.name))
                    }
                    "note_superseded" => Some(format!("A note was replaced in {}", b.name)),
                    "task_completed" => Some(format!("A task was completed in {}", b.name)),
                    "working_state_updated" => Some(format!("Working state moved in {}", b.name)),
                    _ => None,
                };
                if let Some(t) = text {
                    since.push(serde_json::json!({ "brain": b.id, "text": t, "ts": e.ts }));
                }
            }
            sessions_today += seen_sessions.len();
        }
        // newest changes first, capped
        since.sort_by(|a, b| {
            b["ts"]
                .as_str()
                .unwrap_or("")
                .cmp(a["ts"].as_str().unwrap_or(""))
        });
        since.truncate(5);

        Ok(serde_json::json!({
            "needs_review": needs_review,
            "sessions_today": sessions_today,
            "continue": best_continue,
            "since": since,
        }))
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(out))
}

/// GET /api/working_state — the per-scope hot buffer behind the/// GET /api/working_state — the per-scope hot buffer behind the
/// `continue_work` intent (docs/specs/adaptive-memory.md §3.2.3).
pub async fn working_state_get(
    Query(q): Query<WorkingStateQuery>,
    _s: State<ServerState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let out = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, MemoryError> {
        let id = resolve_brain_id(q.brain_id.as_deref())?;
        let scope = scope_for(&id, q.room.as_deref());
        let ws = super::adaptive::types::load_working_state(&scope);
        let stale = ws.is_stale(time::OffsetDateTime::now_utc());
        Ok(serde_json::json!({ "brain": id, "room": scope.room, "stale": stale, "state": ws }))
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(out))
}

#[derive(Deserialize)]
pub struct WorkingStateQuery {
    #[serde(default, alias = "brain")]
    brain_id: Option<String>,
    #[serde(default)]
    room: Option<String>,
}

#[derive(Deserialize)]
pub struct WorkingStateSetBody {
    #[serde(default, alias = "brain")]
    brain_id: Option<String>,
    #[serde(default)]
    room: Option<String>,
    #[serde(flatten)]
    update: super::adaptive::types::WorkingState,
}

/// POST /api/working_state — merge a partial update into the buffer
/// (Some/non-empty fields overwrite; the rest survive). Agents report
/// what they're doing; "continue" replays it for free.
pub async fn working_state_set(
    _s: State<ServerState>,
    Json(body): Json<WorkingStateSetBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let out = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, MemoryError> {
        let id = resolve_brain_id(body.brain_id.as_deref())?;
        let scope = scope_for(&id, body.room.as_deref());
        let mut ws = super::adaptive::types::load_working_state(&scope);
        let before = ws.current_task.clone().unwrap_or_else(|| "(empty)".into());
        ws.apply(body.update, time::OffsetDateTime::now_utc());
        super::adaptive::types::save_working_state(&scope, &ws)?;
        {
            let mut ev = super::journal::Event::now(
                &id,
                "working_state_updated",
                "working_state",
                &scope.room_slug(),
            );
            ev.room = scope.room.clone();
            ev.actor = ws
                .updated_by
                .clone()
                .map(|a| format!("agent:{a}"))
                .unwrap_or_else(|| "user".into());
            ev.before = Some(before.chars().take(120).collect());
            ev.after = ws
                .current_task
                .clone()
                .map(|t| t.chars().take(120).collect());
            ev.capture_method = "endpoint".into();
            super::journal::record(ev);
        }
        Ok(serde_json::json!({ "brain": id, "room": scope.room, "status": "updated", "state": ws }))
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(out))
}

#[derive(Deserialize)]
pub struct PlaybookRuleBody {
    #[serde(default, alias = "brain")]
    brain_id: Option<String>,
    #[serde(default)]
    room: Option<String>,
    /// The rule itself ("Avoid cost-cutting framing; use operational
    /// resilience framing.").
    rule: String,
    #[serde(default)]
    title: Option<String>,
}

/// POST /api/playbook_rule — capture a user correction as a typed
/// PlaybookRule note (importance=high, confidence=high; the single
/// highest-value capture in the system, spec §3.2.6). Written through
/// the NORMAL note path (markdown canonical), then kind-tagged
/// `preference` so the PlaybookRules recipe sections retrieve it.
pub async fn playbook_rule_create(
    _s: State<ServerState>,
    Json(body): Json<PlaybookRuleBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let out = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, MemoryError> {
        if body.rule.trim().len() < 8 {
            return Err(MemoryError::Other("rule text too short".into()));
        }
        let id = resolve_brain_id(body.brain_id.as_deref())?;
        let scope = scope_for(&id, body.room.as_deref());
        let now = time::OffsetDateTime::now_utc();
        let rule = super::adaptive::types::PlaybookRule::from_correction(
            body.rule.trim(),
            scope.room.clone(),
            now,
        );
        let title = body.title.clone().unwrap_or_else(|| {
            let t: String = body.rule.trim().chars().take(60).collect();
            format!("Rule: {t}")
        });
        let md = rule.to_markdown(&title);
        // playbook/ folder inside the room (or brain-wide playbook/).
        let slug: String = title
            .chars()
            .map(|c| {
                if c.is_alphanumeric() {
                    c.to_ascii_lowercase()
                } else {
                    '-'
                }
            })
            .collect::<String>()
            .split('-')
            .filter(|p| !p.is_empty())
            .collect::<Vec<_>>()
            .join("-");
        let short = &uuid::Uuid::new_v4().simple().to_string()[..8];
        let prefix = scope
            .room
            .as_ref()
            .map(|r| format!("{r}/playbook"))
            .unwrap_or_else(|| "playbook".to_string());
        let filename = format!("{prefix}/{}-{short}.md", &slug[..slug.len().min(48)]);
        let ctx = super::write_ops::BrainContext::resolve(Some(&id), super::paths::vault_dir(&id))?;
        let res = super::write_ops::save_note(&ctx, &filename, &md)?;
        {
            // Direct kind tag — deterministic, no reliance on the
            // preference-extraction heuristics.
            let conn = ctx.db.lock();
            let _ = conn.execute(
                "UPDATE engrams SET kind = 'preference', importance = 'high', \
                 last_confirmed_at = datetime('now') WHERE id = ?1",
                rusqlite::params![res.engram_id],
            );
        }
        {
            // Explicit user correction — the highest-confidence
            // experience the system can capture.
            let mut ev =
                super::journal::Event::now(&id, "playbook_rule_added", "engram", &res.engram_id);
            ev.title = Some(title.clone());
            ev.kind = Some("preference".into());
            ev.room = scope.room.clone();
            ev.after = Some(body.rule.trim().chars().take(160).collect());
            ev.capture_method = "explicit_correction".into();
            ev.confidence = 0.95;
            super::journal::record(ev);
        }
        Ok(serde_json::json!({
            "brain": id,
            "engram_id": res.engram_id,
            "filename": res.filename,
            "status": res.status,
        }))
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(out))
}

/// Shared scope builder for the adaptive endpoints.
fn scope_for(brain_id: &str, room: Option<&str>) -> super::adaptive::Scope {
    super::adaptive::Scope {
        brain_id: brain_id.to_string(),
        room: room
            .map(super::adaptive::normalize_room)
            .filter(|r| !r.is_empty()),
    }
}

/// POST /api/ambient_recall — the Ambient Recall engine (see
/// docs/specs/ambient-recall.md). Body: AmbientQueryPacket. Ambient
/// traffic never touches the recall throttle: it is machine-paced, and
/// its own gate is the rate control ("prefer silence over weak
/// context"). Runs on the blocking pool: retrieval + the reranker are
/// CPU-bound.
pub async fn ambient_recall(
    _s: State<ServerState>,
    Json(packet): Json<super::ambient::AmbientQueryPacket>,
) -> Result<Json<super::ambient::AmbientResponse>, ApiError> {
    let out = tokio::task::spawn_blocking(
        move || -> Result<super::ambient::AmbientResponse, MemoryError> {
            let id = resolve_brain_id(packet.brain.as_deref())?;
            let db = open_brain(&id)?;
            super::ambient::run(&db, &id, &packet)
        },
    )
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(out))
}

pub async fn recall(
    Query(q): Query<RecallQuery>,
    _s: State<ServerState>,
) -> Result<Json<Vec<RecallHit>>, ApiError> {
    // tokio::task::spawn_blocking because the retriever is sync and
    // holds SQLite locks — keeping it off the async executor means
    // a long retrieval doesn't stall the HTTP server for other
    // inflight requests.
    let brain_id = q.brain_id.clone();
    let ablate_list: Vec<String> = q
        .ablate
        .as_deref()
        .unwrap_or("")
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let opts = RecallOpts {
        top_k: q.limit.unwrap_or(10),
        spread_hops: q.spread_hops.unwrap_or(0),
        exclude_kinds: if q.include_observations.unwrap_or(false) {
            Vec::new()
        } else {
            vec!["observation".to_string()]
        },
        as_of: q.as_of.clone(),
        use_reranker: q.rerank.unwrap_or(rerank_enabled()),
        ablate: ablate_list,
    };
    let query_str = q.q.clone();
    // Copy these out before the closure moves `opts` + `q.q`. Both are
    // small (a usize and a String) so cloning is free.
    let top_k_for_audit = opts.top_k;
    let q_for_audit = q.q.clone();

    // Wrap the work so we can audit duration + result count.
    let started = std::time::Instant::now();
    let skip_throttle = q.throttle == Some(false);
    let (id, result) =
        tokio::task::spawn_blocking(move || -> Result<(String, Vec<RecallHit>), MemoryError> {
            let id = resolve_brain_id(brain_id.as_deref())?;
            let db = open_brain(&id)?;
            let hits = if skip_throttle {
                super::retriever::hybrid_retrieve(&db, &query_str, &opts)?
            } else {
                hybrid_retrieve_throttled(&db, &query_str, &opts)?
            };
            Ok((id, hits))
        })
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(ApiError::from)?;

    // Best-effort audit — never blocks the response. Args carry just
    // the query string + limit so the activity panel can show a
    // useful one-liner; the result_ids let the user click through
    // to engrams from the audit row.
    let duration_ms = started.elapsed().as_millis() as u64;
    let ids: Vec<String> = result.iter().map(|h| h.engram_id.clone()).take(5).collect();
    let entry = super::tool_audit::AuditEntry::new("recall")
        .with_args(serde_json::json!({ "q": q_for_audit, "limit": top_k_for_audit }))
        .with_result_ids(ids)
        .with_duration(duration_ms)
        .with_status(200);
    let _ = super::tool_audit::append(&id, &entry);

    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// Multi-query recall (POST /api/recall/multi).
//
// HyDE / query-expansion entry point. The agent supplies a primary
// `q` plus 0-4 `additional_queries` — paraphrases, synonyms, or
// "imagined answer passage" rewrites (HyDE). Each query is run
// through the full hybrid pipeline (vec + BM25 + graph + RRF +
// temporal-disambig + optional rerank). Results are then RRF-merged
// across queries: an engram that ranks well under multiple phrasings
// rises above one that only matches a single phrasing strongly.
//
// Why this lives in the server, not the agent: paraphrase mismatch
// is a fundamental retrieval problem (BGE has a 384-dim vec; "tops"
// and "shirts" can land far apart even though they're semantically
// equivalent). The agent already pays for the LLM tokens to phrase
// alternatives; the server provides the "merge multiple retrieval
// passes" primitive so the agent doesn't have to re-implement RRF.
//
// Architecture is local-first: zero network calls. The LLM cost
// stays in whatever process is calling MCP (Claude Code, Codex,
// custom agent) — NeuroVault doesn't reach for cloud APIs.
//
// Cap: 5 queries total (1 primary + 4 additional). Each adds ~one
// pipeline pass of latency. With reranker on, that's roughly N×
// (50-100 ms) plus the per-query vec+BM25+graph cost. Caller opts in
// via the MCP `additional_queries` parameter — single-query callers
// see no change.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct RecallMultiBody {
    /// Primary query — required. Used for BM25, graph signal, and
    /// also embedded for vec search (so a multi-query call with
    /// empty additional_queries behaves identically to single-query).
    pub q: String,
    /// Up to 4 additional phrasings or HyDE rewrites. Each is run
    /// through the full pipeline; results are RRF-merged across all
    /// queries.
    #[serde(default)]
    pub additional_queries: Vec<String>,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub spread_hops: Option<u8>,
    #[serde(default)]
    pub as_of: Option<String>,
    #[serde(default)]
    pub include_observations: Option<bool>,
    #[serde(default)]
    pub brain_id: Option<String>,
    #[serde(default)]
    pub rerank: Option<bool>,
    /// Same ablation surface as single-query recall — applied to
    /// each per-query pipeline run.
    #[serde(default)]
    pub ablate: Option<String>,
}

pub async fn recall_multi(
    _s: State<ServerState>,
    Json(body): Json<RecallMultiBody>,
) -> Result<Json<Vec<RecallHit>>, ApiError> {
    // Compose the query list: primary first, then trimmed-and-deduped
    // additional. Cap at 5 total. Empty/whitespace-only rewrites are
    // silently dropped (a recall with `additional_queries=[""]` is
    // still valid; the server treats it as "primary only").
    let mut queries: Vec<String> = Vec::with_capacity(5);
    let primary = body.q.trim().to_string();
    if primary.is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "empty primary query".into(),
        ));
    }
    queries.push(primary.clone());
    for q in body.additional_queries.into_iter().take(4) {
        let trimmed = q.trim().to_string();
        if !trimmed.is_empty() && !queries.iter().any(|p| p.eq_ignore_ascii_case(&trimmed)) {
            queries.push(trimmed);
        }
    }

    let top_k = body.limit.unwrap_or(10).clamp(1, 50);
    let ablate_list: Vec<String> = body
        .ablate
        .as_deref()
        .unwrap_or("")
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    // Each per-query call oversamples 2× so RRF merge has signal
    // beyond the final top_k. Cap per-query top_k at 50 to bound
    // memory regardless of caller-supplied limit.
    let per_query_top_k = (top_k * 2).clamp(top_k, 50);
    // Force reranker off on per-query passes regardless of what the
    // caller asked for. Reasoning: the per-query pipeline runs the
    // cross-encoder over top-20 candidates, which is ~50-100 ms. With
    // 5 queries that's ~500 ms of cross-encoder alone, dwarfing the
    // ~50 ms vec+BM25+graph cost per pass and making multi-query
    // ~10× more expensive than necessary. Cross-query RRF merge is
    // itself a form of reranking — an engram that ranks top in
    // multiple phrasings is intrinsically more reliable than the
    // cross-encoder's verdict on a single phrasing. We trade single-
    // pass cross-encoder precision for consensus-across-phrasings,
    // which empirically maps better to "the right answer" on
    // paraphrase-heavy queries (the use case for multi-query in the
    // first place). Caller's `rerank` flag is preserved for the
    // single-query fast path below.
    let opts = RecallOpts {
        top_k: per_query_top_k,
        spread_hops: body.spread_hops.unwrap_or(0),
        exclude_kinds: if body.include_observations.unwrap_or(false) {
            Vec::new()
        } else {
            vec!["observation".to_string()]
        },
        as_of: body.as_of.clone(),
        use_reranker: false,
        ablate: ablate_list,
    };
    let brain_id = body.brain_id.clone();

    let result = tokio::task::spawn_blocking(move || -> Result<Vec<RecallHit>, MemoryError> {
        let id = resolve_brain_id(brain_id.as_deref())?;
        let db = open_brain(&id)?;

        // One-line audit so the bench harness / debug sessions can see
        // how often the agent is escalating to multi-query.
        eprintln!(
            "[recall_multi] brain={} q_count={} primary={:?}",
            id,
            queries.len(),
            queries.first().map(|s| &s[..s.len().min(60)]).unwrap_or("")
        );

        // Run each query through the full pipeline. Per-query failures
        // (e.g. rate-limit hint, disk error mid-batch) are logged and
        // skipped — a partial fan-out still produces a usable merge.
        let mut per_query_hits: Vec<Vec<RecallHit>> = Vec::with_capacity(queries.len());
        for q in &queries {
            match hybrid_retrieve_throttled(&db, q, &opts) {
                Ok(hs) => per_query_hits.push(hs),
                Err(e) => {
                    eprintln!("[recall_multi] query {:?} failed: {}", q, e);
                }
            }
        }
        if per_query_hits.is_empty() {
            return Ok(Vec::new());
        }

        // Fast path — only the primary survived; return its results
        // unchanged so the response is byte-for-byte equivalent to
        // GET /api/recall.
        if per_query_hits.len() == 1 {
            return Ok(per_query_hits.into_iter().next().unwrap_or_default());
        }

        // Cross-query RRF. Standard formula: score += 1 / (k + rank).
        // k=60 matches the existing rrf::rrf_score() constant so the
        // magnitudes are comparable to the in-pipeline RRF.
        const K: f64 = 60.0;
        let mut rrf: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
        let mut keep: std::collections::HashMap<String, RecallHit> =
            std::collections::HashMap::new();
        for hits in &per_query_hits {
            for (rank0, h) in hits.iter().enumerate() {
                if h.engram_id == super::retriever::THROTTLE_HINT_ID {
                    // Don't merge throttle hints into the result set —
                    // they're advisory. If every per-query call got
                    // throttled, the caller will see an empty result
                    // and re-issue.
                    continue;
                }
                *rrf.entry(h.engram_id.clone()).or_insert(0.0) += 1.0 / (K + (rank0 + 1) as f64);
                // Keep the highest-scoring representative (earliest
                // rank wins by definition since RRF accumulates).
                keep.entry(h.engram_id.clone()).or_insert_with(|| h.clone());
            }
        }

        let mut sorted: Vec<(String, f64)> = rrf.into_iter().collect();
        sorted.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        let merged: Vec<RecallHit> = sorted
            .into_iter()
            .take(top_k)
            .filter_map(|(eid, fused)| {
                keep.remove(&eid).map(|mut h| {
                    // Overwrite `score` with the cross-query RRF score
                    // (rounded for display) so the caller can see
                    // multi-query consensus, not a single-pass score.
                    h.score = (fused * 10000.0).round() / 10000.0;
                    h
                })
            })
            .collect();

        Ok(merged)
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;

    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// Federated recall — run hybrid_retrieve across every brain in the
// registry (or a caller-provided subset) and merge by score. Useful
// when the user has multiple brains and doesn't remember which one
// holds a fact: "search everywhere for X".
//
// Cost: linear in the number of brains. Each per-brain retrieval
// runs through the throttled path (so spamming this from an agent
// won't melt the box) and is capped at `per_brain` hits before
// merging. With 6 brains and per_brain=5 you fan out to 30 hits and
// truncate to top_k.
//
// Score merge: RRF scores are unitless and brain-relative — a 0.85
// in a small brain isn't directly comparable to a 0.85 in a large
// one. We normalize each brain's hits to a z-score before merging, so
// the merge key is "best relative to its own brain" rather than raw
// scale (with a small-sample guard for brains returning <2 hits). The
// brain_id annotation still lets the caller re-weight by brain.
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
pub struct CrossBrainQuery {
    q: String,
    /// Total hits returned. Default 10, max 50.
    #[serde(default)]
    top_k: Option<usize>,
    /// Per-brain cap before merge. Default 5, max 20. Lower = faster
    /// fan-out, higher = better recall on a brain with the right
    /// answer that gets crowded out by others.
    #[serde(default)]
    per_brain: Option<usize>,
    /// CSV of brain ids to search. Empty / missing = every brain in
    /// the registry. Used by callers who want to scope to a curated
    /// subset ("all my work brains, none of the personal ones").
    #[serde(default)]
    brains: Option<String>,
    #[serde(default)]
    include_observations: Option<bool>,
    #[serde(default)]
    rerank: Option<bool>,
}

#[derive(Serialize)]
pub struct CrossBrainHit {
    brain_id: String,
    brain_name: String,
    engram_id: String,
    title: String,
    content: String,
    score: f64,
    strength: f64,
    state: String,
}

#[derive(Serialize)]
pub struct CrossBrainResponse {
    query: String,
    brains_searched: Vec<String>,
    total: usize,
    hits: Vec<CrossBrainHit>,
}

pub async fn recall_across_brains(
    Query(q): Query<CrossBrainQuery>,
    _s: State<ServerState>,
) -> Result<Json<CrossBrainResponse>, ApiError> {
    let top_k = q.top_k.unwrap_or(10).clamp(1, 50);
    let per_brain = q.per_brain.unwrap_or(5).clamp(1, 20);
    let scoped: Vec<String> = q
        .brains
        .as_deref()
        .unwrap_or("")
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let opts = RecallOpts {
        top_k: per_brain,
        spread_hops: 0,
        exclude_kinds: if q.include_observations.unwrap_or(false) {
            Vec::new()
        } else {
            vec!["observation".to_string()]
        },
        as_of: None,
        use_reranker: q.rerank.unwrap_or(rerank_enabled()),
        ablate: Vec::new(),
    };
    let query_str = q.q.clone();

    let result = tokio::task::spawn_blocking(move || -> Result<CrossBrainResponse, MemoryError> {
        let summaries = list_brains_with_stats()?;
        let candidates: Vec<(String, String)> = if scoped.is_empty() {
            summaries.into_iter().map(|b| (b.id, b.name)).collect()
        } else {
            // Filter to the requested subset, but preserve registry order
            // and use the registry's `name` so the response reads right
            // even if the caller passed bare ids.
            let by_id: std::collections::HashMap<String, String> = summaries
                .into_iter()
                .map(|b| (b.id.clone(), b.name))
                .collect();
            scoped
                .into_iter()
                .filter_map(|id| by_id.get(&id).map(|n| (id.clone(), n.clone())))
                .collect()
        };

        let mut all_hits: Vec<CrossBrainHit> = Vec::new();
        let mut searched: Vec<String> = Vec::with_capacity(candidates.len());
        for (id, name) in &candidates {
            // Skip-on-error per brain: one broken brain shouldn't fail
            // the whole federated query. Caller sees a shorter
            // brains_searched list and infers the rest.
            let db = match open_brain(id) {
                Ok(d) => d,
                Err(e) => {
                    eprintln!("[recall_across_brains] open {} failed: {}", id, e);
                    continue;
                }
            };
            searched.push(id.clone());
            match hybrid_retrieve_throttled(&db, &query_str, &opts) {
                Ok(hits) => {
                    for h in hits {
                        all_hits.push(CrossBrainHit {
                            brain_id: id.clone(),
                            brain_name: name.clone(),
                            engram_id: h.engram_id,
                            title: h.title,
                            content: h.content,
                            score: h.score,
                            strength: h.strength,
                            state: h.state,
                        });
                    }
                }
                Err(e) => {
                    eprintln!("[recall_across_brains] retrieve {} failed: {}", id, e);
                    continue;
                }
            }
        }

        // Per-brain score normalization (z-score) before the global merge.
        // RRF scores are brain-relative — a 0.85 in a small brain isn't
        // comparable to a 0.85 in a large one — so a raw-score merge lets a
        // big brain's scale crowd out another brain's genuinely-better hit.
        // Centering each brain's hits to mean 0 / std 1 makes "best relative
        // to its own brain" the merge key.
        //
        // Small-sample guard (per_brain caps at 20, often 5): a brain with
        // <2 hits or ~zero spread can't tell us whether its lone hit is
        // relatively strong, so it gets a neutral z of 0.0 — this deliberately
        // avoids the naive min-max trap where one weak lone hit normalizes to
        // the very top.
        let mut score_by_brain: std::collections::HashMap<String, Vec<f64>> =
            std::collections::HashMap::new();
        for h in &all_hits {
            score_by_brain
                .entry(h.brain_id.clone())
                .or_default()
                .push(h.score);
        }
        let brain_stats: std::collections::HashMap<String, (f64, f64)> = score_by_brain
            .into_iter()
            .map(|(brain, scores)| {
                let n = scores.len() as f64;
                let mean = scores.iter().sum::<f64>() / n;
                let std = if scores.len() >= 2 {
                    (scores.iter().map(|s| (s - mean).powi(2)).sum::<f64>() / (n - 1.0)).sqrt()
                } else {
                    0.0
                };
                (brain, (mean, std))
            })
            .collect();
        let znorm = |h: &CrossBrainHit| -> f64 {
            match brain_stats.get(&h.brain_id) {
                Some(&(mean, std)) if std > 1e-9 => (h.score - mean) / std,
                _ => 0.0, // single-hit / zero-spread brain → neutral
            }
        };
        // Sort by normalized score desc; partial_cmp is fine — z-scores are
        // finite. Unwrap_or keeps things sane in any degenerate case.
        all_hits.sort_by(|a, b| {
            znorm(b)
                .partial_cmp(&znorm(a))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        all_hits.truncate(top_k);
        let total = all_hits.len();
        Ok(CrossBrainResponse {
            query: query_str,
            brains_searched: searched,
            total,
            hits: all_hits,
        })
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;

    Ok(Json(result))
}

// Allow unused — the `mode` field exists for Python-compat; we don't
// act on it yet. (The Python server accepts it; dropping it would
// break clients that set it.)
#[allow(dead_code)]
fn _consume_mode(_: &str) {}

// --- Tier-A agent-efficiency endpoints --------------------------------
//
// 1) GET  /api/related/:engram_id       — cheap neighbour lookup,
//    replaces follow-up recall calls.
// 2) POST /api/notes                    — remember, with optional
//    `deduplicate` threshold that short-circuits near-duplicate
//    writes + returns the matched engram id instead.

#[derive(Deserialize)]
pub struct RelatedQuery {
    #[serde(default)]
    hops: Option<u8>,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    min_similarity: Option<f64>,
    #[serde(default)]
    link_types: Option<String>, // comma-separated
    #[serde(default)]
    include_observations: Option<bool>,
    #[serde(default)]
    brain_id: Option<String>,
}

pub async fn related(
    axum::extract::Path(engram_id): axum::extract::Path<String>,
    Query(q): Query<RelatedQuery>,
    _s: State<ServerState>,
) -> Result<Json<Vec<RelatedHit>>, ApiError> {
    let brain_id = q.brain_id.clone();
    let opts = RelatedOpts {
        hops: q.hops.unwrap_or(1),
        limit: q.limit.unwrap_or(20),
        min_similarity: q.min_similarity.unwrap_or(0.55),
        link_types: q.link_types.as_ref().map(|s| {
            s.split(',')
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
                .collect()
        }),
        exclude_kinds: if q.include_observations.unwrap_or(false) {
            Vec::new()
        } else {
            vec!["observation".to_string()]
        },
    };
    let eid = engram_id.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<Vec<RelatedHit>, MemoryError> {
        let id = resolve_brain_id(brain_id.as_deref())?;
        let db = super::db::open_brain(&id)?;
        get_related_checked(&db, &eid, &opts)
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(result))
}

#[derive(Deserialize)]
pub struct RememberBody {
    title: Option<String>,
    content: String,
    #[serde(default)]
    brain: Option<String>,
    /// Cosine-similarity threshold (0..=1). When present and a
    /// non-dormant engram matches above the threshold, skip the
    /// ingest and return the matched engram id with status="merged".
    /// Agents pass ~0.92 to merge only near-identical content; the
    /// default keeps the legacy behaviour (no dedupe) for clients
    /// that don't know about the parameter.
    #[serde(default)]
    deduplicate: Option<f64>,
    /// Optional folder under the vault. `projects/` places the new
    /// note under that subdirectory. Defaults to the vault root.
    #[serde(default)]
    folder: Option<String>,
    /// Optional engram ids this new note replaces. Each is marked
    /// superseded by the new note so recall stops serving the stale
    /// ones. Lets an agent write the new truth and retire the old in a
    /// single call. Ignored on a dedupe "merged" result (nothing new
    /// was written to supersede with).
    #[serde(default)]
    supersedes: Vec<String>,
}

#[derive(Serialize)]
pub struct ConflictCandidate {
    pub id: String,
    pub title: String,
    pub similarity: f64,
}

#[derive(Serialize)]
pub struct RememberResult {
    status: String, // "created" | "updated" | "unchanged" | "merged"
    engram_id: String,
    /// Only populated on `status == "merged"` — the cosine similarity
    /// that triggered the merge. Lets agents decide whether to retry
    /// with a higher threshold if they wanted the note created anyway.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    similarity: Option<f64>,
    /// Existing notes in the mid-similarity band (same topic, likely a
    /// different claim) that the new note MAY contradict. Detection only
    /// — nothing is auto-superseded. The agent decides whether to call
    /// `supersede_note` (or pass `supersedes`) to retire the stale one.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    potential_conflicts: Vec<ConflictCandidate>,
}

/// Write-time conflict band. Below the floor = unrelated; at/above the
/// ceiling = near-duplicate (handled by dedupe, not a contradiction).
/// In between = "same topic, probably a different claim" → worth a heads-up.
const CONFLICT_FLOOR: f64 = 0.82;
const CONFLICT_CEIL: f64 = 0.92;

/// Hard ceiling on `remember` content size. Agents occasionally send
/// an entire wiki page or multi-KB transcript; running the full
/// chunk+embed+link pipeline on content that large compounds badly
/// with the vault watcher's re-ingest (which also fires on the
/// newly-written file). We reject anything larger with a clear
/// error telling the caller to chunk their content upstream. 32 KB
/// comfortably covers multi-paragraph insights; anything beyond is
/// almost always "I should have written multiple notes."
pub const REMEMBER_MAX_BYTES: usize = 32 * 1024;

pub async fn remember(
    _s: State<ServerState>,
    Json(body): Json<RememberBody>,
) -> Result<Json<RememberResult>, ApiError> {
    if body.content.len() > REMEMBER_MAX_BYTES {
        return Err(ApiError(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!(
                "content is {} bytes; remember() accepts up to {} bytes. \
                 Split into multiple engrams or use file-level ingest instead.",
                body.content.len(),
                REMEMBER_MAX_BYTES
            ),
        ));
    }
    let brain_id = body.brain.clone();
    let title_hint = body.title.clone();
    let content = body.content.clone();
    let dedupe = body.deduplicate;
    let folder = body.folder.clone();
    let supersedes = body.supersedes.clone();

    let result = tokio::task::spawn_blocking(move || -> Result<RememberResult, MemoryError> {
        let id = resolve_brain_id(brain_id.as_deref())?;
        let db = super::db::open_brain(&id)?;

        // Derive title FIRST so dedupe can compare apples-to-apples
        // against what's stored. The stored embedding is built from
        // the full markdown (`# {title}\n\n{content}`) with a
        // chunker title-prefix on top, so dedupe has to see the
        // same shape.
        let title = title_hint
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| {
                let first = content.lines().next().unwrap_or("").trim();
                let stripped = first.trim_start_matches('#').trim();
                let truncated: String = stripped.chars().take(60).collect();
                if truncated.is_empty() {
                    "Untitled".to_string()
                } else {
                    truncated
                }
            });
        let seed = format!("# {}\n\n{}", title, content);

        // One similarity scan powers both decisions below: the dedupe
        // merge AND the write-time conflict heads-up.
        let nearest = ingest::nearest_doc_match(&db, &seed, None)?;

        // Dedupe short-circuit: a near-identical existing note means we
        // skip the write and return the match as "merged".
        if let Some(threshold) = dedupe {
            if let Some((matched_id, sim)) = &nearest {
                if *sim >= threshold {
                    return Ok(RememberResult {
                        status: "merged".to_string(),
                        engram_id: matched_id.clone(),
                        similarity: Some(*sim),
                        potential_conflicts: vec![],
                    });
                }
            }
        }

        // Slug + filename — same pattern write_ops::create_note uses.
        let slug = slug::slugify(&title);
        let short = &uuid::Uuid::new_v4().to_string()[..8];
        let base = format!("{}-{}.md", slug, short);
        let filename = match folder.as_ref() {
            Some(f) if !f.is_empty() => format!("{}/{}", f.trim_end_matches('/'), base),
            _ => base,
        };

        // Write the markdown file into the active vault so the
        // watcher + ingest pipeline see it. We round-trip through
        // the filesystem to keep MCP writes symmetric with Tauri UI
        // writes + preserve the markdown-as-source-of-truth invariant.
        let vault = super::read_ops::resolve_vault_path(&id)?;
        let ctx = super::write_ops::BrainContext::resolve(Some(&id), vault)?;
        let write = super::write_ops::save_note(&ctx, &filename, &seed)?;

        // Audit the write. `args` carries title + a short preview of
        // the content so the activity panel can render a meaningful
        // one-liner without storing the full body in the audit log.
        let preview: String = content.chars().take(120).collect();
        let entry = super::tool_audit::AuditEntry::new("remember")
            .with_args(serde_json::json!({ "title": title, "preview": preview }))
            .with_modified_ids(vec![write.engram_id.clone()])
            .with_status(200);
        let _ = super::tool_audit::append(&id, &entry);

        // Retire any notes this one explicitly replaces. Best-effort:
        // a missing/typo'd old id is skipped (supersede_note returns
        // false), and we never let a supersede failure undo the write
        // that already succeeded.
        for old_id in &supersedes {
            if old_id == &write.engram_id {
                continue;
            }
            let _ = super::write_ops::supersede_note(
                &db,
                old_id,
                &write.engram_id,
                Some("replaced by a newer note (remember supersedes)"),
            );
        }

        // Write-time conflict heads-up: if the nearest existing note sits
        // in the mid-similarity band, it's likely the same topic with a
        // different claim. Surface it (detection only — the agent decides
        // whether to supersede). Skip anything already superseded here.
        let mut potential_conflicts = Vec::new();
        if let Some((mid, sim)) = &nearest {
            if *sim >= CONFLICT_FLOOR
                && *sim < CONFLICT_CEIL
                && mid != &write.engram_id
                && !supersedes.iter().any(|s| s == mid)
            {
                let title: String = {
                    let conn = db.lock();
                    conn.query_row(
                        "SELECT title FROM engrams WHERE id = ?1 AND superseded_by IS NULL",
                        [mid],
                        |r| r.get::<_, String>(0),
                    )
                    .unwrap_or_default()
                };
                if !title.is_empty() {
                    potential_conflicts.push(ConflictCandidate {
                        id: mid.clone(),
                        title,
                        similarity: (*sim * 1000.0).round() / 1000.0,
                    });
                }
            }
        }

        Ok(RememberResult {
            status: write.status,
            engram_id: write.engram_id,
            similarity: None,
            potential_conflicts,
        })
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;

    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// Save / delete by filename. POST /api/notes (the `remember` endpoint
// above) always creates a new note with an auto-generated filename;
// these two are the symmetric write paths the desktop UI's save and
// delete buttons need, exposed over HTTP so the VS Code extension
// webview can drive them when the Tauri-only invoke() path is not
// available.
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
pub struct SaveBody {
    filename: String,
    content: String,
    #[serde(default)]
    brain: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct DeleteBody {
    filename: String,
    #[serde(default)]
    brain: Option<String>,
}

#[derive(serde::Serialize)]
pub struct WriteResponse {
    status: String,
    engram_id: String,
    filename: String,
    brain_id: String,
}

pub async fn notes_save(
    _s: State<ServerState>,
    Json(body): Json<SaveBody>,
) -> Result<Json<WriteResponse>, ApiError> {
    if body.content.len() > REMEMBER_MAX_BYTES {
        return Err(ApiError(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!(
                "content is {} bytes; save accepts up to {} bytes.",
                body.content.len(),
                REMEMBER_MAX_BYTES
            ),
        ));
    }
    let result = tokio::task::spawn_blocking(move || -> Result<WriteResponse, MemoryError> {
        let id = resolve_brain_id(body.brain.as_deref())?;
        let vault = super::read_ops::resolve_vault_path(&id)?;
        let ctx = super::write_ops::BrainContext::resolve(Some(&id), vault)?;
        let res = super::write_ops::save_note(&ctx, &body.filename, &body.content)?;
        Ok(WriteResponse {
            status: res.status,
            engram_id: res.engram_id,
            filename: body.filename,
            brain_id: id,
        })
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(result))
}

#[derive(Deserialize)]
pub struct SupersedeBody {
    /// The stale note being retired.
    pub old_id: String,
    /// The note that replaces it (the new truth).
    pub new_id: String,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub brain: Option<String>,
}

/// POST /api/notes/supersede — mark `old_id` superseded by `new_id` so
/// recall stops serving the stale note. Backs the `supersede_note` MCP
/// tool. Caller-driven; reversible (note stays on disk + in the DB).
pub async fn notes_supersede(
    _s: State<ServerState>,
    Json(body): Json<SupersedeBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let out = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, MemoryError> {
        let id = resolve_brain_id(body.brain.as_deref())?;
        let db = open_brain(&id)?;
        let updated = super::write_ops::supersede_note(
            &db,
            &body.old_id,
            &body.new_id,
            body.reason.as_deref(),
        )?;
        Ok(serde_json::json!({
            "ok": updated,
            "old_id": body.old_id,
            "new_id": body.new_id,
            "status": if updated { "superseded" } else { "old_id not found" },
        }))
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(out))
}

pub async fn notes_delete(
    _s: State<ServerState>,
    Json(body): Json<DeleteBody>,
) -> Result<Json<WriteResponse>, ApiError> {
    let result = tokio::task::spawn_blocking(move || -> Result<WriteResponse, MemoryError> {
        let id = resolve_brain_id(body.brain.as_deref())?;
        let vault = super::read_ops::resolve_vault_path(&id)?;
        let ctx = super::write_ops::BrainContext::resolve(Some(&id), vault)?;
        let res = super::write_ops::delete_note(&ctx, &body.filename)?;
        Ok(WriteResponse {
            status: res.status,
            engram_id: res.engram_id,
            filename: body.filename,
            brain_id: id,
        })
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// Full-brain update: re-scan the vault, re-ingest anything whose content
// hash has changed, soft-delete engrams whose markdown file no longer
// exists on disk. Idempotent and cheap when nothing changed (the
// content_hash short-circuit in ingest::ingest_file means each file
// reads its bytes once and exits without touching the DB).
//
// Backs the `/update` MCP command. Useful when the user has edited
// markdown files outside the desktop app (Obsidian, vim, Drive sync)
// and wants the index to catch up without restarting the app.
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize, Default)]
pub struct UpdateBody {
    #[serde(default)]
    brain: Option<String>,
}

#[derive(serde::Serialize)]
pub struct UpdateResult {
    brain_id: String,
    scanned: u32,
    ingested: u32,
    unchanged: u32,
    deleted: u32,
    elapsed_ms: u64,
}

pub fn collect_md_files(root: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };
        // Skip dotfile dirs / files (.git, .obsidian, .DS_Store, …).
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            // Skip the trash subdirectory — those are soft-deleted notes
            // we do NOT want to re-ingest. Anything else recurses.
            if name == "trash" {
                continue;
            }
            collect_md_files(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
            out.push(path);
        }
    }
}

pub async fn update_brain(
    _s: State<ServerState>,
    body: Option<Json<UpdateBody>>,
) -> Result<Json<UpdateResult>, ApiError> {
    let body = body.map(|j| j.0).unwrap_or_default();
    let result = tokio::task::spawn_blocking(move || -> Result<UpdateResult, MemoryError> {
        let started = std::time::Instant::now();
        let id = resolve_brain_id(body.brain.as_deref())?;
        let vault = super::read_ops::resolve_vault_path(&id)?;
        let db = super::db::open_brain(&id)?;

        // Pass 1 — walk the vault and re-ingest anything that changed.
        let mut files = Vec::new();
        collect_md_files(&vault, &mut files);
        let scanned = files.len() as u32;
        let mut ingested = 0u32;
        let mut unchanged = 0u32;
        for path in &files {
            match super::ingest::ingest_file(path, Some(&vault), &db) {
                Ok(Some(_)) => ingested += 1,
                Ok(None) => unchanged += 1,
                Err(e) => eprintln!("[update] ingest failed for {}: {}", path.display(), e),
            }
        }

        // Pass 2 — find engrams whose file no longer exists on disk and
        // soft-delete them. Cheap: one query, one HashSet build, then a
        // membership check per engram.
        let mut on_disk: std::collections::HashSet<String> = std::collections::HashSet::new();
        for p in &files {
            if let Ok(rel) = p.strip_prefix(&vault) {
                on_disk.insert(rel.to_string_lossy().replace('\\', "/"));
            }
        }
        let rows: Vec<(String, String)> = {
            let conn = db.lock();
            let mut stmt =
                conn.prepare("SELECT id, filename FROM engrams WHERE state != 'dormant'")?;
            let mapped = stmt.query_map([], |r| {
                let id: String = r.get(0)?;
                let fname: String = r.get(1)?;
                Ok((id, fname))
            })?;
            mapped.filter_map(std::result::Result::ok).collect()
        };
        let mut deleted = 0u32;
        for (engram_id, filename) in rows {
            if !on_disk.contains(&filename)
                && super::ingest::soft_delete_engram(&db, &engram_id).is_ok()
            {
                deleted += 1;
            }
        }

        Ok(UpdateResult {
            brain_id: id,
            scanned,
            ingested,
            unchanged,
            deleted,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// Folder import (cold-start onboarding) — point at any directory of
// markdown files (Obsidian vault, Notion export, Bear export, past
// chat transcripts) and bulk-ingest them into the brain. Filenames
// are namespaced by the source folder name so two imports with
// overlapping basenames (two READMEs, etc.) don't collide.
//
// What this is NOT: it doesn't copy or symlink the source files. The
// content goes into engrams.content; the original markdown stays
// where it lives. If the source files later change, this won't
// notice — re-run the import to refresh.
//
// Best-effort per file: a single bad UTF-8 file or permission error
// is logged + counted, the rest of the import keeps going.
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
pub struct ImportFolderBody {
    /// Absolute path to the folder to walk.
    path: String,
    #[serde(default)]
    brain: Option<String>,
    /// Optional namespace prefix override. Default = source folder
    /// basename. Pass "" to disable namespacing entirely (imports
    /// land directly under their relative path).
    #[serde(default)]
    prefix: Option<String>,
}

#[derive(serde::Serialize, Default)]
pub struct ImportFolderResult {
    brain_id: String,
    source_path: String,
    prefix: String,
    scanned: u32,
    ingested: u32,
    unchanged: u32,
    errors: Vec<String>,
    elapsed_ms: u64,
}

pub async fn import_folder(
    _s: State<ServerState>,
    Json(body): Json<ImportFolderBody>,
) -> Result<Json<ImportFolderResult>, ApiError> {
    let result = tokio::task::spawn_blocking(move || -> Result<ImportFolderResult, MemoryError> {
        let started = std::time::Instant::now();
        let root = std::path::PathBuf::from(&body.path);
        if !root.is_dir() {
            return Err(MemoryError::Other(format!(
                "import path is not a directory: {}",
                body.path
            )));
        }
        let id = resolve_brain_id(body.brain.as_deref())?;
        let db = super::db::open_brain(&id)?;

        // Default prefix: the source folder's basename. Caller can
        // pass "" to suppress namespacing if they're confident their
        // filenames won't collide with existing engrams.
        let derived_prefix = root
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("import")
            .to_string();
        let prefix = body
            .prefix
            .clone()
            .unwrap_or(derived_prefix)
            .trim_matches('/')
            .to_string();

        let mut files = Vec::new();
        collect_md_files(&root, &mut files);
        let scanned = files.len() as u32;

        let mut ingested = 0u32;
        let mut unchanged = 0u32;
        let mut errors: Vec<String> = Vec::new();

        for path in &files {
            let rel = match path.strip_prefix(&root) {
                Ok(r) => r.to_string_lossy().replace('\\', "/"),
                Err(_) => path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default(),
            };
            let ingest_filename = if prefix.is_empty() {
                rel
            } else {
                format!("{}/{}", prefix, rel)
            };
            let content = match std::fs::read_to_string(path) {
                Ok(c) => c,
                Err(e) => {
                    errors.push(format!("{}: {}", path.display(), e));
                    continue;
                }
            };
            match super::ingest::ingest_content(&ingest_filename, &content, &db) {
                Ok(Some(_)) => ingested += 1,
                Ok(None) => unchanged += 1,
                Err(e) => errors.push(format!("{}: {}", path.display(), e)),
            }
        }

        Ok(ImportFolderResult {
            brain_id: id,
            source_path: body.path,
            prefix,
            scanned,
            ingested,
            unchanged,
            errors,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// Graphify: codebase → on-device knowledge graph (see memory::graphify).
// Parse a repo with tree-sitter, populate the code tables, then query the
// symbol/call graph. Nothing leaves the machine.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct GraphifyBody {
    pub path: String,
    #[serde(default)]
    pub brain: Option<String>,
}

/// POST /api/code/graphify — parse a repo into the brain's code graph.
pub async fn code_graphify(
    _s: State<ServerState>,
    Json(body): Json<GraphifyBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let out = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, MemoryError> {
        let root = std::path::PathBuf::from(&body.path);
        if !root.is_dir() {
            return Err(MemoryError::Other(format!(
                "graphify path is not a directory: {}",
                body.path
            )));
        }
        let id = resolve_brain_id(body.brain.as_deref())?;
        let db = open_brain(&id)?;
        let started = std::time::Instant::now();
        let stats = super::graphify::graphify_into_brain(&root, &db);
        Ok(serde_json::json!({
            "brain_id": id,
            "path": body.path,
            "files": stats.files,
            "symbols": stats.symbols,
            "calls": stats.calls,
            "edges": stats.edges,
            "elapsed_ms": started.elapsed().as_millis() as u64,
        }))
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(out))
}

#[derive(Deserialize)]
pub struct CodeSymbolQuery {
    pub symbol: String,
    #[serde(default)]
    pub brain_id: Option<String>,
}

/// GET /api/code/where_defined?symbol=&brain_id=
pub async fn code_where_defined(
    Query(q): Query<CodeSymbolQuery>,
    _s: State<ServerState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let out = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, MemoryError> {
        let id = resolve_brain_id(q.brain_id.as_deref())?;
        let db = open_brain(&id)?;
        let conn = db.lock();
        let defs = super::graphify::where_defined(&conn, &q.symbol)?;
        let rows: Vec<_> = defs
            .into_iter()
            .map(|(file, line)| serde_json::json!({ "file": file, "line": line }))
            .collect();
        Ok(serde_json::json!({ "symbol": q.symbol, "count": rows.len(), "definitions": rows }))
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(out))
}

/// GET /api/code/who_calls?symbol=&brain_id=
pub async fn code_who_calls(
    Query(q): Query<CodeSymbolQuery>,
    _s: State<ServerState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let out = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, MemoryError> {
        let id = resolve_brain_id(q.brain_id.as_deref())?;
        let db = open_brain(&id)?;
        let conn = db.lock();
        let callers = super::graphify::who_calls(&conn, &q.symbol)?;
        let rows: Vec<_> = callers
            .into_iter()
            .map(|(caller, file, line)| {
                serde_json::json!({ "caller": caller, "file": file, "line": line })
            })
            .collect();
        Ok(serde_json::json!({ "symbol": q.symbol, "count": rows.len(), "callers": rows }))
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(out))
}

#[derive(Deserialize)]
pub struct CodeFileQuery {
    pub path: String,
    #[serde(default)]
    pub brain_id: Option<String>,
}

/// GET /api/code/whats_in_file?path=&brain_id=
pub async fn code_whats_in_file(
    Query(q): Query<CodeFileQuery>,
    _s: State<ServerState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let out = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, MemoryError> {
        let id = resolve_brain_id(q.brain_id.as_deref())?;
        let db = open_brain(&id)?;
        let conn = db.lock();
        let syms = super::graphify::whats_in_file(&conn, &q.path)?;
        let rows: Vec<_> = syms
            .into_iter()
            .map(|(name, kind, signature)| {
                serde_json::json!({ "name": name, "kind": kind, "signature": signature })
            })
            .collect();
        Ok(serde_json::json!({ "path": q.path, "count": rows.len(), "symbols": rows }))
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(out))
}

/// GET /api/code/blast_radius?symbol=&brain_id= — transitive callers (impact).
pub async fn code_blast_radius(
    Query(q): Query<CodeSymbolQuery>,
    _s: State<ServerState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let out = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, MemoryError> {
        let id = resolve_brain_id(q.brain_id.as_deref())?;
        let db = open_brain(&id)?;
        let conn = db.lock();
        let impacted = super::graphify::blast_radius(&conn, &q.symbol)?;
        let rows: Vec<_> = impacted
            .into_iter()
            .map(|(name, file, line)| {
                serde_json::json!({ "name": name, "file": file, "line": line })
            })
            .collect();
        Ok(serde_json::json!({ "symbol": q.symbol, "count": rows.len(), "impacted": rows }))
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(out))
}

#[derive(Deserialize)]
pub struct FuseBody {
    #[serde(default)]
    pub brain: Option<String>,
}

/// POST /api/code/fuse — link notes to the code symbols they reference.
pub async fn code_fuse(
    _s: State<ServerState>,
    Json(body): Json<FuseBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let out = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, MemoryError> {
        let id = resolve_brain_id(body.brain.as_deref())?;
        let db = open_brain(&id)?;
        let conn = db.lock();
        let links = super::graphify::fuse_notes_to_code(&conn)?;
        Ok(serde_json::json!({ "brain_id": id, "links": links }))
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(out))
}

// ---------------------------------------------------------------------------
// Image listing for caption-at-ingest workflow.
//
// MCP can't do its own multimodal — the model behind the proxy is
// the user's Claude Code / Desktop session, which IS multimodal.
// So the captioning division of labour:
//
//   • This endpoint  — surface images the agent could caption.
//   • The agent      — opens each image in its own context, writes
//                      a caption, calls remember_image() (a thin
//                      wrapper around remember) to persist it.
//
// No CV models, no API calls leaving the box. The agent is the
// captioning model; the MCP server is the index + transport.
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize, Default)]
pub struct ListImagesQuery {
    folder_path: String,
    #[serde(default = "default_true")]
    recursive: bool,
    #[serde(default)]
    limit: Option<u32>,
}

#[derive(serde::Serialize)]
pub struct ImageEntry {
    path: String,
    basename: String,
    extension: String,
    size_bytes: u64,
    last_modified: Option<String>,
}

#[derive(serde::Serialize)]
pub struct ListImagesResponse {
    folder_path: String,
    recursive: bool,
    total: usize,
    images: Vec<ImageEntry>,
}

pub const IMAGE_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "webp", "gif", "bmp", "svg", "heic", "tiff",
];

pub fn collect_image_files(
    root: &std::path::Path,
    recursive: bool,
    out: &mut Vec<std::path::PathBuf>,
    limit: usize,
) {
    if out.len() >= limit {
        return;
    }
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if out.len() >= limit {
            return;
        }
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            if recursive && name != "trash" {
                collect_image_files(&path, true, out, limit);
            }
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_lowercase());
        if let Some(ext) = ext {
            if IMAGE_EXTS.contains(&ext.as_str()) {
                out.push(path);
            }
        }
    }
}

pub async fn list_images(
    Query(q): Query<ListImagesQuery>,
    _s: State<ServerState>,
) -> Result<Json<ListImagesResponse>, ApiError> {
    let root = std::path::PathBuf::from(&q.folder_path);
    if !root.is_dir() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            format!("not a directory: {}", q.folder_path),
        ));
    }
    let limit = q.limit.unwrap_or(500).min(5000) as usize;
    let result = tokio::task::spawn_blocking(move || -> Result<ListImagesResponse, MemoryError> {
        let mut paths = Vec::new();
        collect_image_files(&root, q.recursive, &mut paths, limit);
        let mut images: Vec<ImageEntry> = Vec::with_capacity(paths.len());
        for p in &paths {
            let basename = p
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            let extension = p
                .extension()
                .and_then(|e| e.to_str())
                .map(|s| s.to_lowercase())
                .unwrap_or_default();
            let meta = std::fs::metadata(p);
            let size_bytes = meta.as_ref().map(|m| m.len()).unwrap_or(0);
            let last_modified = meta
                .as_ref()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| {
                    // ISO-ish; the agent only needs ordering / coarse age.
                    let secs = d.as_secs();
                    format!("{}", secs)
                });
            images.push(ImageEntry {
                path: p.to_string_lossy().to_string(),
                basename,
                extension,
                size_bytes,
                last_modified,
            });
        }
        let total = images.len();
        Ok(ListImagesResponse {
            folder_path: q.folder_path,
            recursive: q.recursive,
            total,
            images,
        })
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// Reindex embeddings — walk every active engram, re-chunk, re-embed
// under the current model, replace chunks + vec_chunks rows. The
// embedding upgrade path: when the user (or a future release) swaps
// the BGE model for something larger, this is what reconciles the
// vector store with the new model.
//
// Cost: roughly the same as the original ingest of every engram —
// 5-10 ms per chunk on the BGE-small-en-v1.5 path. A 500-engram
// brain with ~3 chunks each ≈ 7-15 seconds wall-clock.
//
// Idempotent under a stable model: encoding the same text twice
// produces identical vectors, so a no-op re-run still rewrites the
// same bytes. The work is the encode, not the disk IO.
//
// Per-engram failures are captured + counted; one bad engram
// doesn't abort the rest. Run optimize_disk afterward if you want
// the freed pages back.
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize, Default)]
pub struct ReindexBody {
    #[serde(default)]
    brain: Option<String>,
    /// Only count engrams that would be touched; skip the actual
    /// re-embed work. Useful for sizing the wall-clock cost ahead
    /// of time.
    #[serde(default)]
    dry_run: bool,
}

#[derive(serde::Serialize)]
pub struct ReindexResult {
    brain_id: String,
    dry_run: bool,
    engrams_total: u32,
    engrams_reembedded: u32,
    chunks_written: u32,
    failed: Vec<String>,
    elapsed_ms: u64,
}

pub async fn reindex_embeddings(
    _s: State<ServerState>,
    body: Option<Json<ReindexBody>>,
) -> Result<Json<ReindexResult>, ApiError> {
    let body = body.map(|j| j.0).unwrap_or_default();
    let result = tokio::task::spawn_blocking(move || -> Result<ReindexResult, MemoryError> {
        let started = std::time::Instant::now();
        let id = resolve_brain_id(body.brain.as_deref())?;
        let db = super::db::open_brain(&id)?;

        let engram_ids: Vec<String> = {
            let conn = db.lock();
            let mut stmt =
                conn.prepare("SELECT id FROM engrams WHERE state != 'dormant' ORDER BY id")?;
            let mapped = stmt.query_map([], |r| r.get::<_, String>(0))?;
            mapped.filter_map(std::result::Result::ok).collect()
        };
        let total = engram_ids.len() as u32;

        if body.dry_run {
            return Ok(ReindexResult {
                brain_id: id,
                dry_run: true,
                engrams_total: total,
                engrams_reembedded: 0,
                chunks_written: 0,
                failed: Vec::new(),
                elapsed_ms: started.elapsed().as_millis() as u64,
            });
        }

        let mut reembedded = 0u32;
        let mut chunks_written = 0u32;
        let mut failed: Vec<String> = Vec::new();
        for eid in &engram_ids {
            match super::ingest::reembed_engram(&db, eid) {
                Ok(n) => {
                    if n > 0 {
                        reembedded += 1;
                        chunks_written += n;
                    }
                }
                Err(e) => failed.push(format!("{}: {}", eid, e)),
            }
        }

        // Reset recall caches — old vectors are gone, any cached
        // ranking is stale.
        super::recall_cache::invalidate_brain(&id);
        let _ = super::bm25::index_for(&id).flush(&db);

        Ok(ReindexResult {
            brain_id: id,
            dry_run: false,
            engrams_total: total,
            engrams_reembedded: reembedded,
            chunks_written,
            failed,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(result))
}

#[derive(serde::Deserialize, Default)]
pub struct RebuildWikilinksBody {
    #[serde(default)]
    brain: Option<String>,
}

#[derive(serde::Serialize)]
pub struct RebuildWikilinksResult {
    brain_id: String,
    engrams_processed: u32,
    links_resolved: u32,
    elapsed_ms: u64,
}

/// Re-resolve every `[[wikilink]]` in the brain in one pass. Fixes links
/// that couldn't connect at write time — forward references (target written
/// later) and titles with a parenthetical suffix the short link omits.
pub async fn rebuild_wikilinks(
    _s: State<ServerState>,
    body: Option<Json<RebuildWikilinksBody>>,
) -> Result<Json<RebuildWikilinksResult>, ApiError> {
    let body = body.map(|j| j.0).unwrap_or_default();
    let result =
        tokio::task::spawn_blocking(move || -> Result<RebuildWikilinksResult, MemoryError> {
            let started = std::time::Instant::now();
            let id = resolve_brain_id(body.brain.as_deref())?;
            let db = super::db::open_brain(&id)?;
            let (engrams_processed, links_resolved) = super::ingest::rebuild_wikilinks(&db)?;
            super::recall_cache::invalidate_brain(&id);
            Ok(RebuildWikilinksResult {
                brain_id: id,
                engrams_processed,
                links_resolved,
                elapsed_ms: started.elapsed().as_millis() as u64,
            })
        })
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(ApiError::from)?;
    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// Clutter report — surfaces engrams that look like noise so an agent
// can review and remove. Four categories, one SQL query each:
//
//   stubs                  short content + low access count
//   test_data              title pattern matches test/smoke/verify/debug
//   forgotten_observations kind='observation' never accessed, >7 days old
//   duplicate_titles       multiple non-dormant engrams sharing a title
//
// Returns categorised lists with reason hints so the caller can decide
// per-engram. The matching `engrams_delete` endpoint takes an explicit
// list of ids and soft-deletes them — no automatic deletion based on
// the heuristics; an agent + human always confirms.
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize, Default)]
pub struct ClutterQuery {
    #[serde(default)]
    brain: Option<String>,
    #[serde(default)]
    limit: Option<u32>,
}

#[derive(serde::Serialize)]
pub struct ClutterEntry {
    id: String,
    title: String,
    reason: String,
}

#[derive(serde::Serialize)]
pub struct ClutterReport {
    brain_id: String,
    stubs: Vec<ClutterEntry>,
    test_data: Vec<ClutterEntry>,
    forgotten_observations: Vec<ClutterEntry>,
    duplicate_titles: Vec<ClutterEntry>,
    total: usize,
}

pub async fn clutter_report(
    Query(q): Query<ClutterQuery>,
    _s: State<ServerState>,
) -> Result<Json<ClutterReport>, ApiError> {
    let limit = q.limit.unwrap_or(50).min(500) as i64;
    let result = tokio::task::spawn_blocking(move || -> Result<ClutterReport, MemoryError> {
        let id = resolve_brain_id(q.brain.as_deref())?;
        let db = open_brain(&id)?;
        let conn = db.lock();

        // Stubs: very short, never (or barely) accessed.
        let stubs: Vec<ClutterEntry> = {
            let mut stmt = conn.prepare(
                "SELECT id, title, length(content) AS len \
                 FROM engrams \
                 WHERE state != 'dormant' \
                   AND length(content) < 100 \
                   AND access_count <= 1 \
                 ORDER BY length(content) ASC \
                 LIMIT ?1",
            )?;
            let mapped = stmt.query_map([limit], |r| {
                let id: String = r.get(0)?;
                let title: String = r.get(1)?;
                let len: i64 = r.get(2)?;
                Ok(ClutterEntry {
                    id,
                    title,
                    reason: format!("stub: {} chars of content", len),
                })
            })?;
            mapped.filter_map(std::result::Result::ok).collect()
        };

        // Test data: title patterns suggesting throwaway content.
        let test_data: Vec<ClutterEntry> = {
            let mut stmt = conn.prepare(
                "SELECT id, title \
                 FROM engrams \
                 WHERE state != 'dormant' \
                   AND ( lower(title) LIKE '%test%' \
                      OR lower(title) LIKE '%smoke%' \
                      OR lower(title) LIKE '%verify%' \
                      OR lower(title) LIKE '%debug%' ) \
                   AND access_count <= 1 \
                 ORDER BY access_count ASC, created_at ASC \
                 LIMIT ?1",
            )?;
            let mapped = stmt.query_map([limit], |r| {
                let id: String = r.get(0)?;
                let title: String = r.get(1)?;
                Ok(ClutterEntry {
                    id,
                    title,
                    reason: "test/verify/debug-titled, barely accessed".to_string(),
                })
            })?;
            mapped.filter_map(std::result::Result::ok).collect()
        };

        // Forgotten observations: auto-extracted but never promoted.
        let forgotten_observations: Vec<ClutterEntry> = {
            let mut stmt = conn.prepare(
                "SELECT id, title, created_at \
                 FROM engrams \
                 WHERE state != 'dormant' \
                   AND kind = 'observation' \
                   AND access_count = 0 \
                   AND created_at < datetime('now', '-7 days') \
                 ORDER BY created_at ASC \
                 LIMIT ?1",
            )?;
            let mapped = stmt.query_map([limit], |r| {
                let id: String = r.get(0)?;
                let title: String = r.get(1)?;
                let created: String = r.get(2)?;
                Ok(ClutterEntry {
                    id,
                    title,
                    reason: format!("observation, never accessed, created {}", created),
                })
            })?;
            mapped.filter_map(std::result::Result::ok).collect()
        };

        // Duplicate titles: any title that appears more than once.
        let duplicate_titles: Vec<ClutterEntry> = {
            let mut stmt = conn.prepare(
                "SELECT id, title \
                 FROM engrams \
                 WHERE state != 'dormant' \
                   AND lower(title) IN ( \
                     SELECT lower(title) FROM engrams \
                     WHERE state != 'dormant' \
                     GROUP BY lower(title) \
                     HAVING count(*) > 1 ) \
                 ORDER BY lower(title), created_at ASC \
                 LIMIT ?1",
            )?;
            let mapped = stmt.query_map([limit], |r| {
                let id: String = r.get(0)?;
                let title: String = r.get(1)?;
                Ok(ClutterEntry {
                    id,
                    title,
                    reason: "duplicate title (one of multiple engrams)".to_string(),
                })
            })?;
            mapped.filter_map(std::result::Result::ok).collect()
        };

        let total =
            stubs.len() + test_data.len() + forgotten_observations.len() + duplicate_titles.len();
        Ok(ClutterReport {
            brain_id: id,
            stubs,
            test_data,
            forgotten_observations,
            duplicate_titles,
            total,
        })
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(result))
}

#[derive(serde::Deserialize)]
pub struct EngramsDeleteBody {
    engram_ids: Vec<String>,
    #[serde(default)]
    brain: Option<String>,
}

#[derive(serde::Serialize)]
pub struct EngramsDeleteResult {
    brain_id: String,
    deleted: u32,
    not_found: u32,
    failed: Vec<String>,
}

pub async fn engrams_delete(
    _s: State<ServerState>,
    Json(body): Json<EngramsDeleteBody>,
) -> Result<Json<EngramsDeleteResult>, ApiError> {
    let result =
        tokio::task::spawn_blocking(move || -> Result<EngramsDeleteResult, MemoryError> {
            let id = resolve_brain_id(body.brain.as_deref())?;
            let vault = super::read_ops::resolve_vault_path(&id)?;
            let ctx = super::write_ops::BrainContext::resolve(Some(&id), vault)?;

            // Look up filename for each engram id, then call delete_note
            // which also moves the markdown to trash/. The filename lookup
            // and the delete are separate transactions; collecting the
            // filenames first keeps the per-engram delete loop straight.
            let mut filenames: Vec<(String, Option<String>)> = Vec::new();
            {
                let conn = ctx.db.lock();
                for engram_id in &body.engram_ids {
                    let row: Option<String> = conn
                        .query_row(
                            "SELECT filename FROM engrams WHERE id = ?1",
                            [engram_id],
                            |r| r.get(0),
                        )
                        .ok();
                    filenames.push((engram_id.clone(), row));
                }
            }

            let mut deleted = 0u32;
            let mut not_found = 0u32;
            let mut failed: Vec<String> = Vec::new();
            for (engram_id, fname_opt) in filenames {
                match fname_opt {
                    None => not_found += 1,
                    Some(fname) => match super::write_ops::delete_note(&ctx, &fname) {
                        Ok(_) => deleted += 1,
                        Err(e) => {
                            eprintln!("[engrams_delete] {} ({}): {}", engram_id, fname, e);
                            failed.push(engram_id);
                        }
                    },
                }
            }

            Ok(EngramsDeleteResult {
                brain_id: id,
                deleted,
                not_found,
                failed,
            })
        })
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(ApiError::from)?;
    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// Bulk metadata edits — set `kind` or append a tag across many
// engrams in one round-trip. The single-row path goes through the
// markdown ingest (which re-runs frontmatter / chunk / embed), but
// for kind/tag flips that's wasteful: nothing about the embedding
// changes, so we update the engrams row directly + invalidate the
// recall cache so the next query sees fresh metadata.
//
// Tags are stored as a JSON array string in `engrams.tags` (matches
// the Python `dissertation.add_tag` convention). Tag input is
// normalised: lowercase, trimmed, leading '#' stripped.
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
pub struct BulkSetKindBody {
    engram_ids: Vec<String>,
    kind: String,
    #[serde(default)]
    brain: Option<String>,
}

#[derive(serde::Serialize)]
pub struct BulkUpdateResult {
    brain_id: String,
    updated: u32,
    unchanged: u32,
    not_found: Vec<String>,
}

pub async fn bulk_set_kind(
    _s: State<ServerState>,
    Json(body): Json<BulkSetKindBody>,
) -> Result<Json<BulkUpdateResult>, ApiError> {
    // Schema comment lists the canonical values. We don't reject
    // unknown ones at the SQL level (the column is plain TEXT) but
    // the API guards against typos.
    const ALLOWED: &[&str] = &[
        "note",
        "source",
        "quote",
        "draft",
        "question",
        "decision",
        "observation",
        "insight",
    ];
    let kind = body.kind.trim().to_lowercase();
    if !ALLOWED.contains(&kind.as_str()) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            format!("kind must be one of {:?}, got {:?}", ALLOWED, body.kind),
        ));
    }
    if body.engram_ids.is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "engram_ids is empty".into(),
        ));
    }

    let result = tokio::task::spawn_blocking(move || -> Result<BulkUpdateResult, MemoryError> {
        let id = resolve_brain_id(body.brain.as_deref())?;
        let db = open_brain(&id)?;
        let conn = db.lock();

        let mut updated: u32 = 0;
        let mut unchanged: u32 = 0;
        let mut not_found: Vec<String> = Vec::new();
        for eid in &body.engram_ids {
            let existing: Option<String> = conn
                .query_row("SELECT kind FROM engrams WHERE id = ?1", [eid], |r| {
                    r.get(0)
                })
                .ok();
            match existing {
                None => not_found.push(eid.clone()),
                Some(prev) if prev == kind => unchanged += 1,
                Some(_) => {
                    let n = conn.execute(
                        "UPDATE engrams SET kind = ?1, updated_at = datetime('now') WHERE id = ?2",
                        rusqlite::params![kind, eid],
                    )?;
                    if n > 0 {
                        updated += 1;
                    }
                }
            }
        }
        drop(conn);
        super::recall_cache::invalidate_brain(&id);
        Ok(BulkUpdateResult {
            brain_id: id,
            updated,
            unchanged,
            not_found,
        })
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(result))
}

#[derive(serde::Deserialize)]
pub struct BulkAddTagBody {
    engram_ids: Vec<String>,
    tag: String,
    #[serde(default)]
    brain: Option<String>,
}

pub async fn bulk_add_tag(
    _s: State<ServerState>,
    Json(body): Json<BulkAddTagBody>,
) -> Result<Json<BulkUpdateResult>, ApiError> {
    let tag = body.tag.trim().trim_start_matches('#').to_lowercase();
    if tag.is_empty() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "tag is empty".into()));
    }
    if body.engram_ids.is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "engram_ids is empty".into(),
        ));
    }

    let result = tokio::task::spawn_blocking(move || -> Result<BulkUpdateResult, MemoryError> {
        let id = resolve_brain_id(body.brain.as_deref())?;
        let db = open_brain(&id)?;
        let conn = db.lock();

        let mut updated: u32 = 0;
        let mut unchanged: u32 = 0;
        let mut not_found: Vec<String> = Vec::new();
        for eid in &body.engram_ids {
            let existing: Option<Option<String>> = conn
                .query_row("SELECT tags FROM engrams WHERE id = ?1", [eid], |r| {
                    r.get(0)
                })
                .ok();
            match existing {
                None => not_found.push(eid.clone()),
                Some(tags_json) => {
                    let mut current: Vec<String> = tags_json
                        .as_deref()
                        .filter(|s| !s.is_empty())
                        .and_then(|s| serde_json::from_str(s).ok())
                        .unwrap_or_default();
                    if current.iter().any(|t| t == &tag) {
                        unchanged += 1;
                        continue;
                    }
                    current.push(tag.clone());
                    let new_json = serde_json::to_string(&current)
                        .map_err(|e| MemoryError::Other(format!("tag serialise: {e}")))?;
                    conn.execute(
                        "UPDATE engrams SET tags = ?1, updated_at = datetime('now') WHERE id = ?2",
                        rusqlite::params![new_json, eid],
                    )?;
                    updated += 1;
                }
            }
        }
        drop(conn);
        super::recall_cache::invalidate_brain(&id);
        Ok(BulkUpdateResult {
            brain_id: id,
            updated,
            unchanged,
            not_found,
        })
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// Engram version history — list past content snapshots for an engram
// and fetch any individual version's content. Snapshots are written
// by the ingest pipeline whenever `content_hash` changes, so the
// list is sparse (no entry for no-op re-ingests) and only as deep as
// the engram has actually been edited.
//
// version is a per-engram counter (1, 2, 3...). The CURRENT row
// lives in `engrams`, not in `engram_versions` — version N here
// means "N edits ago, this is what the engram said before being
// replaced." Listing returns most-recent-first.
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize, Default)]
pub struct EngramVersionsQuery {
    #[serde(default)]
    brain: Option<String>,
    #[serde(default)]
    limit: Option<u32>,
}

#[derive(serde::Serialize)]
pub struct EngramVersionRow {
    version: i64,
    title: String,
    content_hash: String,
    /// Content prefix for list view; full content fetched via the
    /// per-version endpoint. Caps the list payload on a long
    /// editing history.
    content_preview: String,
    content_bytes: i64,
    created_at: String,
}

#[derive(serde::Serialize)]
pub struct EngramVersionsResponse {
    brain_id: String,
    engram_id: String,
    current_title: String,
    current_content_hash: String,
    total: usize,
    versions: Vec<EngramVersionRow>,
}

pub async fn engram_versions_list(
    Path(engram_id): Path<String>,
    Query(q): Query<EngramVersionsQuery>,
    _s: State<ServerState>,
) -> Result<Json<EngramVersionsResponse>, ApiError> {
    let limit = q.limit.unwrap_or(50).min(500) as i64;
    let result =
        tokio::task::spawn_blocking(move || -> Result<EngramVersionsResponse, MemoryError> {
            let id = resolve_brain_id(q.brain.as_deref())?;
            let db = open_brain(&id)?;
            let conn = db.lock();

            let current: (String, String) = conn
                .query_row(
                    "SELECT title, content_hash FROM engrams WHERE id = ?1",
                    [&engram_id],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                )
                .map_err(|_| MemoryError::EngramNotFound(engram_id.clone()))?;

            let mut stmt = conn.prepare(
                "SELECT version, title, content, content_hash, created_at \
             FROM engram_versions \
             WHERE engram_id = ?1 \
             ORDER BY version DESC \
             LIMIT ?2",
            )?;
            let mapped = stmt.query_map(rusqlite::params![&engram_id, limit], |r| {
                let content: String = r.get(2)?;
                // Preview keeps the response cheap for long edit
                // histories; callers fetch full content per-version.
                let preview = content.chars().take(280).collect::<String>();
                Ok(EngramVersionRow {
                    version: r.get(0)?,
                    title: r.get(1)?,
                    content_hash: r.get(3)?,
                    content_preview: preview,
                    content_bytes: content.len() as i64,
                    created_at: r.get(4)?,
                })
            })?;
            let versions: Vec<EngramVersionRow> =
                mapped.filter_map(std::result::Result::ok).collect();
            let total = versions.len();
            Ok(EngramVersionsResponse {
                brain_id: id,
                engram_id,
                current_title: current.0,
                current_content_hash: current.1,
                total,
                versions,
            })
        })
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(ApiError::from)?;
    Ok(Json(result))
}

#[derive(serde::Serialize)]
pub struct EngramVersionDetail {
    brain_id: String,
    engram_id: String,
    version: i64,
    title: String,
    content: String,
    content_hash: String,
    created_at: String,
}

pub async fn engram_version_get(
    Path((engram_id, version)): Path<(String, i64)>,
    Query(q): Query<EngramVersionsQuery>,
    _s: State<ServerState>,
) -> Result<Json<EngramVersionDetail>, ApiError> {
    let result =
        tokio::task::spawn_blocking(move || -> Result<EngramVersionDetail, MemoryError> {
            let id = resolve_brain_id(q.brain.as_deref())?;
            let db = open_brain(&id)?;
            let conn = db.lock();
            let row: (String, String, String, String) = conn
                .query_row(
                    "SELECT title, content, content_hash, created_at \
                 FROM engram_versions \
                 WHERE engram_id = ?1 AND version = ?2",
                    rusqlite::params![&engram_id, version],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                            r.get::<_, String>(3)?,
                        ))
                    },
                )
                .map_err(|_| {
                    MemoryError::Other(format!(
                        "version {} not found for engram {}",
                        version, engram_id
                    ))
                })?;
            Ok(EngramVersionDetail {
                brain_id: id,
                engram_id,
                version,
                title: row.0,
                content: row.1,
                content_hash: row.2,
                created_at: row.3,
            })
        })
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(ApiError::from)?;
    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// Contradictions endpoint — surfaces fact-level conflicts that the
// ingest pipeline has already auto-detected and stored in the
// `contradictions` table. Until v0.1.9 these were silently
// accumulating with no read path; agents now query this to audit
// the brain. Each row carries both contradicting facts and pointers
// back to their source engrams so the caller can show provenance
// when proposing a resolution.
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize, Default)]
pub struct ContradictionsQuery {
    /// Filter by resolution state. None → all rows. Some(false) →
    /// only unresolved (the common case for "show me what to fix").
    /// Some(true) → only resolved.
    #[serde(default)]
    resolved: Option<bool>,
    #[serde(default)]
    brain: Option<String>,
    #[serde(default)]
    limit: Option<u32>,
}

#[derive(serde::Serialize)]
pub struct ContradictionEntry {
    id: String,
    fact_a: String,
    fact_b: String,
    engram_a_id: String,
    engram_a_title: String,
    engram_b_id: String,
    engram_b_title: String,
    detected_at: String,
    resolved: bool,
    resolution: Option<String>,
}

#[derive(serde::Serialize)]
pub struct ContradictionsResponse {
    brain_id: String,
    total: usize,
    contradictions: Vec<ContradictionEntry>,
}

pub async fn contradictions_list(
    Query(q): Query<ContradictionsQuery>,
    _s: State<ServerState>,
) -> Result<Json<ContradictionsResponse>, ApiError> {
    let limit = q.limit.unwrap_or(50).min(500) as i64;
    let result =
        tokio::task::spawn_blocking(move || -> Result<ContradictionsResponse, MemoryError> {
            let id = resolve_brain_id(q.brain.as_deref())?;
            let db = open_brain(&id)?;
            let conn = db.lock();

            let where_clause = match q.resolved {
                None => "",
                Some(true) => " WHERE c.resolved = 1",
                Some(false) => " WHERE c.resolved = 0",
            };
            let sql = format!(
                "SELECT c.id, c.fact_a, c.fact_b, \
                    c.engram_a, ea.title, \
                    c.engram_b, eb.title, \
                    c.detected_at, c.resolved, c.resolution \
             FROM contradictions c \
             JOIN engrams ea ON ea.id = c.engram_a \
             JOIN engrams eb ON eb.id = c.engram_b \
             {} \
             ORDER BY c.detected_at DESC \
             LIMIT ?1",
                where_clause,
            );
            let mut stmt = conn.prepare(&sql)?;
            let mapped = stmt.query_map([limit], |r| {
                Ok(ContradictionEntry {
                    id: r.get(0)?,
                    fact_a: r.get(1)?,
                    fact_b: r.get(2)?,
                    engram_a_id: r.get(3)?,
                    engram_a_title: r.get(4)?,
                    engram_b_id: r.get(5)?,
                    engram_b_title: r.get(6)?,
                    detected_at: r.get(7)?,
                    resolved: r.get::<_, i64>(8)? != 0,
                    resolution: r.get(9)?,
                })
            })?;
            let contradictions: Vec<ContradictionEntry> =
                mapped.filter_map(std::result::Result::ok).collect();
            let total = contradictions.len();
            Ok(ContradictionsResponse {
                brain_id: id,
                total,
                contradictions,
            })
        })
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(ApiError::from)?;
    Ok(Json(result))
}

#[derive(serde::Deserialize)]
pub struct ContradictionResolveBody {
    /// Optional human-readable note about why one fact wins or how
    /// the conflict is reconciled. Stored verbatim. The endpoint just
    /// flips the resolved flag — it does NOT delete or modify the
    /// underlying engrams. Resolution is annotation, not action.
    #[serde(default)]
    resolution: Option<String>,
    #[serde(default)]
    brain: Option<String>,
}

#[derive(serde::Serialize)]
pub struct ContradictionResolveResult {
    id: String,
    resolved: bool,
}

pub async fn contradictions_resolve(
    axum::extract::Path(id): axum::extract::Path<String>,
    _s: State<ServerState>,
    body: Option<Json<ContradictionResolveBody>>,
) -> Result<Json<ContradictionResolveResult>, ApiError> {
    let body = body.map(|j| j.0).unwrap_or(ContradictionResolveBody {
        resolution: None,
        brain: None,
    });
    let result =
        tokio::task::spawn_blocking(move || -> Result<ContradictionResolveResult, MemoryError> {
            let brain_id = resolve_brain_id(body.brain.as_deref())?;
            let db = open_brain(&brain_id)?;
            let conn = db.lock();
            let updated = conn.execute(
                "UPDATE contradictions SET resolved = 1, resolution = ?2 WHERE id = ?1",
                rusqlite::params![&id, &body.resolution],
            )?;
            if updated == 0 {
                return Err(MemoryError::Other(format!(
                    "contradiction {} not found",
                    id
                )));
            }
            Ok(ContradictionResolveResult { id, resolved: true })
        })
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(ApiError::from)?;
    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// Manual link management — lets agents wire engrams together AFTER
// the initial save. The ingest pipeline auto-creates links from
// embedded [[wikilinks]] and entity co-mentions, but until v0.1.9
// there was no MCP-accessible way to add a link without rewriting
// the markdown body. Two endpoints: POST adds (with bidirectional
// flag, default true), DELETE removes.
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
pub struct LinkBody {
    from_engram: String,
    to_engram: String,
    /// "manual" by default — matches what wikilinks resolve to.
    /// Other valid values: "uses", "extends", "depends_on",
    /// "contradicts", "supersedes", or any string the agent wants
    /// to use (the `link_type` column is free-form TEXT).
    #[serde(default)]
    link_type: Option<String>,
    /// 1.0 by default for manual edges (matches wikilink convention).
    /// Lower values (0.7-0.9) make sense for weaker manual links.
    #[serde(default)]
    similarity: Option<f64>,
    /// True by default. When true, also inserts the reverse edge so
    /// adjacency / hover-focus / `related()` see the connection from
    /// both sides. Matches what the wikilink pipeline does. Set
    /// false for asymmetric relationships ("A supersedes B" → not
    /// "B supersedes A").
    #[serde(default)]
    bidirectional: Option<bool>,
    #[serde(default)]
    brain: Option<String>,
}

#[derive(serde::Serialize)]
pub struct LinkResult {
    brain_id: String,
    from_engram: String,
    to_engram: String,
    link_type: String,
    similarity: f64,
    bidirectional: bool,
    /// 1 when only the forward edge was inserted (or replaced),
    /// 2 when the reverse was inserted as well.
    rows_written: u32,
}

pub async fn links_add(
    _s: State<ServerState>,
    Json(body): Json<LinkBody>,
) -> Result<Json<LinkResult>, ApiError> {
    let result = tokio::task::spawn_blocking(move || -> Result<LinkResult, MemoryError> {
        let id = resolve_brain_id(body.brain.as_deref())?;
        let db = open_brain(&id)?;
        let link_type = body.link_type.unwrap_or_else(|| "manual".to_string());
        let similarity = body.similarity.unwrap_or(1.0).clamp(0.0, 1.0);
        let bidirectional = body.bidirectional.unwrap_or(true);

        let conn = db.lock();

        // Validate both engrams exist before writing — INSERT OR
        // REPLACE without a ref check would silently create dangling
        // edges if the agent typo'd an id.
        let exists_a: i64 = conn.query_row(
            "SELECT COUNT(*) FROM engrams WHERE id = ?1",
            [&body.from_engram],
            |r| r.get(0),
        )?;
        let exists_b: i64 = conn.query_row(
            "SELECT COUNT(*) FROM engrams WHERE id = ?1",
            [&body.to_engram],
            |r| r.get(0),
        )?;
        if exists_a == 0 {
            return Err(MemoryError::EngramNotFound(body.from_engram.clone()));
        }
        if exists_b == 0 {
            return Err(MemoryError::EngramNotFound(body.to_engram.clone()));
        }

        conn.execute(
            "INSERT OR REPLACE INTO engram_links \
             (from_engram, to_engram, similarity, link_type) \
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![&body.from_engram, &body.to_engram, similarity, &link_type],
        )?;
        let mut rows_written = 1u32;
        if bidirectional && body.from_engram != body.to_engram {
            conn.execute(
                "INSERT OR REPLACE INTO engram_links \
                 (from_engram, to_engram, similarity, link_type) \
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![&body.to_engram, &body.from_engram, similarity, &link_type],
            )?;
            rows_written = 2;
        }

        Ok(LinkResult {
            brain_id: id,
            from_engram: body.from_engram,
            to_engram: body.to_engram,
            link_type,
            similarity,
            bidirectional,
            rows_written,
        })
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(result))
}

#[derive(serde::Deserialize)]
pub struct LinkRemoveBody {
    from_engram: String,
    to_engram: String,
    /// True by default — also removes the reverse edge if present,
    /// matching the bidirectional add flow.
    #[serde(default)]
    bidirectional: Option<bool>,
    #[serde(default)]
    brain: Option<String>,
}

#[derive(serde::Serialize)]
pub struct LinkRemoveResult {
    brain_id: String,
    rows_deleted: u32,
}

pub async fn links_remove(
    _s: State<ServerState>,
    Json(body): Json<LinkRemoveBody>,
) -> Result<Json<LinkRemoveResult>, ApiError> {
    let result = tokio::task::spawn_blocking(move || -> Result<LinkRemoveResult, MemoryError> {
        let id = resolve_brain_id(body.brain.as_deref())?;
        let db = open_brain(&id)?;
        let bidirectional = body.bidirectional.unwrap_or(true);
        let conn = db.lock();
        let mut rows_deleted = conn.execute(
            "DELETE FROM engram_links WHERE from_engram = ?1 AND to_engram = ?2",
            rusqlite::params![&body.from_engram, &body.to_engram],
        )? as u32;
        if bidirectional && body.from_engram != body.to_engram {
            rows_deleted += conn.execute(
                "DELETE FROM engram_links WHERE from_engram = ?1 AND to_engram = ?2",
                rusqlite::params![&body.to_engram, &body.from_engram],
            )? as u32;
        }
        Ok(LinkRemoveResult {
            brain_id: id,
            rows_deleted,
        })
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// Orphan links — pairs the system knows are semantically related
// (cosine ≥ threshold from the auto-similarity pass) but the user
// has never explicitly wikilinked. Surface them so an agent can
// propose: "these two notes are very similar, want to connect them
// with `add_link()`?" Reuses the existing engram_links table — no
// new computation, just a NOT EXISTS subquery.
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize, Default)]
pub struct OrphanLinksQuery {
    /// Minimum semantic similarity to consider. Default 0.85 (matches
    /// the graph view's default min_similarity). Lowering surfaces
    /// noisier candidates; raising tightens to "almost certainly
    /// related."
    #[serde(default)]
    threshold: Option<f64>,
    #[serde(default)]
    limit: Option<u32>,
    #[serde(default)]
    brain: Option<String>,
}

#[derive(serde::Serialize)]
pub struct OrphanLinkEntry {
    engram_a_id: String,
    engram_a_title: String,
    engram_b_id: String,
    engram_b_title: String,
    similarity: f64,
}

#[derive(serde::Serialize)]
pub struct OrphanLinksResponse {
    brain_id: String,
    threshold: f64,
    total: usize,
    pairs: Vec<OrphanLinkEntry>,
}

pub async fn orphan_links(
    Query(q): Query<OrphanLinksQuery>,
    _s: State<ServerState>,
) -> Result<Json<OrphanLinksResponse>, ApiError> {
    let threshold = q.threshold.unwrap_or(0.85).clamp(0.0, 1.0);
    let limit = q.limit.unwrap_or(50).min(500) as i64;
    let result = tokio::task::spawn_blocking(move || -> Result<OrphanLinksResponse, MemoryError> {
        let id = resolve_brain_id(q.brain.as_deref())?;
        let db = open_brain(&id)?;
        let conn = db.lock();

        // Each unordered pair appears twice in engram_links
        // (A→B + B→A from the bidirectional insert). De-dup with
        // `s.from_engram < s.to_engram` so the response only carries
        // each pair once.
        //
        // The NOT EXISTS subquery rules out pairs that already have
        // any manually-asserted relationship in EITHER direction:
        // manual / uses / extends / depends_on / supersedes /
        // contradicts. Those aren't orphans — they're done.
        let mut stmt = conn.prepare(
            "SELECT s.from_engram, ea.title, s.to_engram, eb.title, s.similarity \
             FROM engram_links s \
             JOIN engrams ea ON ea.id = s.from_engram \
             JOIN engrams eb ON eb.id = s.to_engram \
             WHERE s.link_type = 'semantic' \
               AND s.similarity >= ?1 \
               AND s.from_engram < s.to_engram \
               AND ea.state != 'dormant' AND eb.state != 'dormant' \
               AND NOT EXISTS ( \
                 SELECT 1 FROM engram_links m \
                 WHERE ((m.from_engram = s.from_engram AND m.to_engram = s.to_engram) \
                     OR (m.from_engram = s.to_engram AND m.to_engram = s.from_engram)) \
                   AND m.link_type IN ('manual','uses','extends','depends_on','supersedes','contradicts') \
               ) \
             ORDER BY s.similarity DESC \
             LIMIT ?2",
        )?;
        let mapped = stmt.query_map(rusqlite::params![threshold, limit], |r| {
            Ok(OrphanLinkEntry {
                engram_a_id: r.get(0)?,
                engram_a_title: r.get(1)?,
                engram_b_id: r.get(2)?,
                engram_b_title: r.get(3)?,
                similarity: r.get(4)?,
            })
        })?;
        let pairs: Vec<OrphanLinkEntry> = mapped.filter_map(std::result::Result::ok).collect();
        let total = pairs.len();
        Ok(OrphanLinksResponse {
            brain_id: id,
            threshold,
            total,
            pairs,
        })
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// Temporal recall — surface rows from `temporal_facts`, optionally as
// of a past instant. The retriever already biases live recall against
// superseded facts; this endpoint lets an agent ask the bitemporal
// table directly: "what did I believe about X" or "what did I believe
// about X on date Y?". Two time axes:
//
//   • valid time   — the period the fact described reality
//                    [valid_from, valid_until)
//   • system time  — when we knew the fact; `expired_at` is set when
//                    we *retracted* the row (vs. simply ending its
//                    valid interval).
//
// `as_of` filters on valid time + system time together: the fact's
// valid interval must contain `as_of`, AND the row must not have been
// retracted before `as_of`. So the response is exactly the set of
// facts the system would have asserted at that moment.
//
// `include_superseded=true` drops the validity filter and returns
// every matching row, current or not — useful when the agent is
// auditing the history of a topic ("show me the full timeline for
// the database choice").
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize, Default)]
pub struct TemporalRecallQuery {
    /// Free-text substring matched against `fact`. Case-insensitive.
    /// Empty / missing returns the most recent facts in the brain.
    #[serde(default)]
    query: Option<String>,
    /// ISO timestamp ("2026-01-15" or "2026-01-15T12:00:00") to time-
    /// travel to. Default = now (only currently-valid facts).
    #[serde(default)]
    as_of: Option<String>,
    /// If set, scope to facts attached to this engram only.
    #[serde(default)]
    engram_id: Option<String>,
    /// When true, ignore the validity filter and return every match —
    /// current, ended, and retracted alike.
    #[serde(default)]
    include_superseded: bool,
    #[serde(default)]
    limit: Option<u32>,
    #[serde(default)]
    brain: Option<String>,
}

#[derive(serde::Serialize)]
pub struct TemporalFactEntry {
    id: String,
    engram_id: String,
    engram_title: String,
    fact: String,
    valid_from: Option<String>,
    valid_until: Option<String>,
    is_current: bool,
    superseded_by: Option<String>,
    expired_at: Option<String>,
}

#[derive(serde::Serialize)]
pub struct TemporalRecallResponse {
    brain_id: String,
    query: String,
    as_of: Option<String>,
    include_superseded: bool,
    total: usize,
    facts: Vec<TemporalFactEntry>,
}

pub async fn temporal_recall(
    Query(q): Query<TemporalRecallQuery>,
    _s: State<ServerState>,
) -> Result<Json<TemporalRecallResponse>, ApiError> {
    let limit = q.limit.unwrap_or(50).min(500) as i64;
    let result =
        tokio::task::spawn_blocking(move || -> Result<TemporalRecallResponse, MemoryError> {
            let id = resolve_brain_id(q.brain.as_deref())?;
            let db = open_brain(&id)?;
            let conn = db.lock();

            let query_text = q.query.unwrap_or_default();
            let like_pat = format!("%{}%", query_text);
            let has_query = !query_text.is_empty();
            let has_engram = q.engram_id.is_some();

            // Two SQL shapes: time-travel vs. live. The bitemporal filter
            // matches on validity AND system-time (`expired_at` either NULL
            // or in the future relative to `as_of`). When the caller passes
            // `include_superseded`, we drop both filters and return raw
            // history.
            let mut sql = String::from(
                "SELECT t.id, t.engram_id, e.title, t.fact, t.valid_from, t.valid_until, \
                    t.is_current, t.superseded_by, t.expired_at \
             FROM temporal_facts t \
             JOIN engrams e ON e.id = t.engram_id \
             WHERE e.state != 'dormant'",
            );
            let mut binds: Vec<rusqlite::types::Value> = Vec::new();

            if !q.include_superseded {
                if let Some(ref cutoff) = q.as_of {
                    sql.push_str(
                        " AND (t.valid_from IS NULL OR t.valid_from <= ?) \
                       AND (t.valid_until IS NULL OR t.valid_until > ?) \
                       AND (t.expired_at IS NULL OR t.expired_at > ?)",
                    );
                    binds.push(rusqlite::types::Value::Text(cutoff.clone()));
                    binds.push(rusqlite::types::Value::Text(cutoff.clone()));
                    binds.push(rusqlite::types::Value::Text(cutoff.clone()));
                } else {
                    sql.push_str(" AND t.is_current = 1 AND t.expired_at IS NULL");
                }
            }

            if has_query {
                sql.push_str(" AND t.fact LIKE ? COLLATE NOCASE");
                binds.push(rusqlite::types::Value::Text(like_pat));
            }
            if has_engram {
                sql.push_str(" AND t.engram_id = ?");
                binds.push(rusqlite::types::Value::Text(
                    q.engram_id.clone().unwrap_or_default(),
                ));
            }

            // Most-recent first by valid_from; ties broken by id for
            // stable pagination.
            sql.push_str(" ORDER BY COALESCE(t.valid_from, '') DESC, t.id ASC LIMIT ?");
            binds.push(rusqlite::types::Value::Integer(limit));

            let mut stmt = conn.prepare(&sql)?;
            let mapped = stmt.query_map(rusqlite::params_from_iter(binds.iter()), |r| {
                let is_current_int: i64 = r.get(6)?;
                Ok(TemporalFactEntry {
                    id: r.get(0)?,
                    engram_id: r.get(1)?,
                    engram_title: r.get(2)?,
                    fact: r.get(3)?,
                    valid_from: r.get(4)?,
                    valid_until: r.get(5)?,
                    is_current: is_current_int != 0,
                    superseded_by: r.get(7)?,
                    expired_at: r.get(8)?,
                })
            })?;
            let facts: Vec<TemporalFactEntry> =
                mapped.filter_map(std::result::Result::ok).collect();
            let total = facts.len();
            Ok(TemporalRecallResponse {
                brain_id: id,
                query: query_text,
                as_of: q.as_of,
                include_superseded: q.include_superseded,
                total,
                facts,
            })
        })
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(ApiError::from)?;
    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// Disk optimization — reclaim brain.db space. Three composable
// operations:
//
//   1. purge_dormant  — hard-delete every engram with state='dormant'.
//                       Soft delete already strips chunks + vec rows
//                       and link rows; cascade FKs handle the rest.
//                       Off by default (destructive).
//   2. wal_checkpoint — flush the WAL into the main DB and truncate
//                       the WAL file to zero. Recovers space the WAL
//                       was holding for crash safety.
//   3. vacuum         — rebuild the DB file removing free pages from
//                       prior deletes. Most expensive op (rewrites
//                       the whole file) but biggest reclaim on a
//                       brain that has churned through deletes.
//
// On the user's 90 MB brain, ~10-25 MB are typically reclaimable:
// soft-deleted engrams sit as free pages until VACUUM runs, and the
// WAL accumulates without a checkpoint trigger if writes are sparse.
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize, Default)]
pub struct OptimizeDiskBody {
    #[serde(default)]
    brain: Option<String>,
    /// Hard-delete every dormant engram. Default false because this
    /// is irreversible — the soft-delete trail is gone after this.
    #[serde(default)]
    purge_dormant: bool,
    /// Default true — cheap, almost always wanted.
    #[serde(default = "default_true")]
    wal_checkpoint: bool,
    /// Default true — the actual disk reclaim. Rewrite cost is linear
    /// in brain size; on a 90 MB brain ≈ 1-3s.
    #[serde(default = "default_true")]
    vacuum: bool,
}

pub fn default_true() -> bool {
    true
}

#[derive(serde::Serialize)]
pub struct DiskMeasurement {
    db_bytes: u64,
    wal_bytes: u64,
    shm_bytes: u64,
    total_bytes: u64,
    free_pages: i64,
    page_size: i64,
}

#[derive(serde::Serialize)]
pub struct OptimizeRan {
    purge_dormant: bool,
    wal_checkpoint: bool,
    vacuum: bool,
}

#[derive(serde::Serialize)]
pub struct OptimizeDiskResponse {
    brain_id: String,
    before: DiskMeasurement,
    after: DiskMeasurement,
    reclaimed_bytes: i64,
    purged_engrams: u32,
    ran: OptimizeRan,
}

pub async fn optimize_disk(
    _s: State<ServerState>,
    Json(body): Json<OptimizeDiskBody>,
) -> Result<Json<OptimizeDiskResponse>, ApiError> {
    let result =
        tokio::task::spawn_blocking(move || -> Result<OptimizeDiskResponse, MemoryError> {
            let id = resolve_brain_id(body.brain.as_deref())?;
            let dir = super::paths::brain_dir(&id);

            let measure = |conn: &rusqlite::Connection| -> Result<DiskMeasurement, MemoryError> {
                let db_bytes = std::fs::metadata(dir.join("brain.db"))
                    .map(|m| m.len())
                    .unwrap_or(0);
                let wal_bytes = std::fs::metadata(dir.join("brain.db-wal"))
                    .map(|m| m.len())
                    .unwrap_or(0);
                let shm_bytes = std::fs::metadata(dir.join("brain.db-shm"))
                    .map(|m| m.len())
                    .unwrap_or(0);
                let free_pages: i64 = conn
                    .query_row("PRAGMA freelist_count", [], |r| r.get(0))
                    .unwrap_or(0);
                let page_size: i64 = conn
                    .query_row("PRAGMA page_size", [], |r| r.get(0))
                    .unwrap_or(4096);
                Ok(DiskMeasurement {
                    db_bytes,
                    wal_bytes,
                    shm_bytes,
                    total_bytes: db_bytes + wal_bytes + shm_bytes,
                    free_pages,
                    page_size,
                })
            };

            let db = open_brain(&id)?;
            let before = {
                let conn = db.lock();
                measure(&conn)?
            };

            // Step 1: hard-delete dormant rows. CASCADE FKs reap chunks /
            // links / entity_mentions / contradictions / temporal_facts
            // automatically. vec_chunks were already cleared at soft-
            // delete time, so no orphan rows remain.
            let mut purged: u32 = 0;
            if body.purge_dormant {
                let conn = db.lock();
                // Returning rowcount from execute would conflate the
                // engram delete with cascaded child deletes; query the
                // count first so the response is meaningful.
                let dormant: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM engrams WHERE state = 'dormant'",
                    [],
                    |r| r.get(0),
                )?;
                conn.execute("DELETE FROM engrams WHERE state = 'dormant'", [])?;
                purged = dormant as u32;
            }

            // Step 2: VACUUM first. Cannot run inside a transaction;
            // execute_batch doesn't open one. Clearing the statement
            // cache avoids any prepared-statement contention with the
            // file rewrite.
            //
            // VACUUM has to come BEFORE the checkpoint because VACUUM
            // itself writes the entire rebuilt DB through the WAL. If
            // we checkpoint first and VACUUM second, the WAL ends up
            // bigger than the DB. Inverting the order so checkpoint
            // truncates VACUUM's WAL output too.
            if body.vacuum {
                let conn = db.lock();
                conn.flush_prepared_statement_cache();
                conn.execute_batch("VACUUM;")?;
            }

            // Step 3: WAL truncate. PASSIVE would just flush; TRUNCATE
            // also shrinks the file back to zero bytes. Safe — we hold
            // the only writer lock and there are no in-flight readers
            // because the connection is mutex-guarded.
            if body.wal_checkpoint {
                let conn = db.lock();
                conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
            }

            let after = {
                let conn = db.lock();
                measure(&conn)?
            };

            // Invalidate the recall cache + bm25 index — purged dormants
            // were already excluded from those, but a VACUUM reorders
            // pages and we want fresh handles next call.
            super::recall_cache::invalidate_brain(&id);
            let _ = super::bm25::index_for(&id).flush(&db);

            let reclaimed = before.total_bytes as i64 - after.total_bytes as i64;
            Ok(OptimizeDiskResponse {
                brain_id: id,
                before,
                after,
                reclaimed_bytes: reclaimed,
                purged_engrams: purged,
                ran: OptimizeRan {
                    purge_dormant: body.purge_dormant,
                    wal_checkpoint: body.wal_checkpoint,
                    vacuum: body.vacuum,
                },
            })
        })
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(ApiError::from)?;
    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// MCP tier — read/write `~/.neurovault/mcp_tier.txt`. The Python MCP
// proxy reads this at startup to decide which tools to register, so
// changing the tier here only takes effect after the proxy restarts
// (the desktop app surfaces this with a "restart MCP" hint after a
// PUT). Stored as a plain text file rather than a row in any DB so
// the proxy can read it before importing anything heavy.
//
// Allowed: "lite" | "standard" | "full". Anything else (including
// missing file) is treated as "full" by the proxy.
// ---------------------------------------------------------------------------

pub fn mcp_tier_path() -> std::path::PathBuf {
    super::paths::nv_home().join("mcp_tier.txt")
}

#[derive(serde::Serialize)]
pub struct McpTierResponse {
    tier: String,
}

#[derive(serde::Deserialize)]
pub struct McpTierBody {
    tier: String,
}

pub async fn mcp_tier_get(_s: State<ServerState>) -> Result<Json<McpTierResponse>, ApiError> {
    let raw = std::fs::read_to_string(mcp_tier_path()).unwrap_or_default();
    let trimmed = raw.trim().to_lowercase();
    let tier = match trimmed.as_str() {
        "lite" => "lite",
        "standard" => "standard",
        _ => "full",
    };
    Ok(Json(McpTierResponse {
        tier: tier.to_string(),
    }))
}

pub async fn mcp_tier_set(
    _s: State<ServerState>,
    Json(body): Json<McpTierBody>,
) -> Result<Json<McpTierResponse>, ApiError> {
    let trimmed = body.tier.trim().to_lowercase();
    if !matches!(trimmed.as_str(), "lite" | "standard" | "full") {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            format!(
                "tier must be 'lite' | 'standard' | 'full', got {:?}",
                body.tier
            ),
        ));
    }
    let path = mcp_tier_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&path, &trimmed).map_err(|e| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("write tier: {e}"),
        )
    })?;
    Ok(Json(McpTierResponse { tier: trimmed }))
}

// ---------------------------------------------------------------------------
// Reranker default — ~/.neurovault/rerank.txt. The cross-encoder reranker
// lifts LongMemEval hit@5 from ~94% (retrieval only) to ~97%, but it loads a
// ~1 GB model and adds ~50-100 ms per recall. ON by default; the Settings
// toggle writes "off" for a lighter, faster app at a small recall cost. Read
// as the default for the recall path's `rerank` param (an explicit per-call
// `rerank` still wins).
// ---------------------------------------------------------------------------

pub fn rerank_pref_path() -> std::path::PathBuf {
    super::paths::nv_home().join("rerank.txt")
}

/// Default reranker state for recall. ON unless the user wrote "off".
pub fn rerank_enabled() -> bool {
    match std::fs::read_to_string(rerank_pref_path()) {
        Ok(s) => !matches!(s.trim().to_lowercase().as_str(), "off" | "false" | "0"),
        Err(_) => true,
    }
}

#[derive(serde::Serialize)]
pub struct RerankResponse {
    enabled: bool,
}

#[derive(serde::Deserialize)]
pub struct RerankBody {
    enabled: bool,
}

pub async fn rerank_get(_s: State<ServerState>) -> Result<Json<RerankResponse>, ApiError> {
    Ok(Json(RerankResponse {
        enabled: rerank_enabled(),
    }))
}

pub async fn rerank_set(
    _s: State<ServerState>,
    Json(body): Json<RerankBody>,
) -> Result<Json<RerankResponse>, ApiError> {
    let path = rerank_pref_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&path, if body.enabled { "on" } else { "off" }).map_err(|e| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("write rerank: {e}"),
        )
    })?;
    Ok(Json(RerankResponse {
        enabled: body.enabled,
    }))
}

// ---------------------------------------------------------------------------
// API key management — loopback-mounted ONLY. The gateway must
// never expose these; an external client managing its own keys
// is a footgun (and a privilege-escalation pathway).
//
// The Settings UI calls these from the Tauri webview over the
// loopback port. Three endpoints:
//
//   GET    /api/api_keys              list public metadata (no hashes)
//   POST   /api/api_keys              create + return plaintext ONCE
//   DELETE /api/api_keys/:id          revoke (sets revoked_at)
//
// API gateway: plaintext is shown once at
// creation, never recoverable; revocation keeps the row for audit.
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
pub struct ApiKeyListResponse {
    pub keys: Vec<super::api_keys::ApiKeyPublic>,
}

pub async fn api_keys_list(_s: State<ServerState>) -> Result<Json<ApiKeyListResponse>, ApiError> {
    let store = super::api_keys::current();
    let keys = store
        .keys
        .iter()
        .map(super::api_keys::ApiKeyPublic::from)
        .collect();
    Ok(Json(ApiKeyListResponse { keys }))
}

#[derive(serde::Deserialize)]
pub struct ApiKeyCreateBody {
    pub label: String,
    /// "read" | "write" | "admin". Case-insensitive.
    pub scope: String,
    /// Optional. Empty = all brains permitted.
    #[serde(default)]
    pub brain_allowlist: Vec<String>,
}

#[derive(serde::Serialize)]
pub struct ApiKeyCreateResponse {
    /// Plaintext key. Shown to the UI ONCE, never stored or
    /// retrievable again. UI is responsible for the "copy this
    /// now" modal and never logging this string.
    pub plaintext: String,
    pub key: super::api_keys::ApiKeyPublic,
}

pub async fn api_keys_create(
    _s: State<ServerState>,
    Json(body): Json<ApiKeyCreateBody>,
) -> Result<Json<ApiKeyCreateResponse>, ApiError> {
    let label = body.label.trim();
    if label.is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "label is required".into(),
        ));
    }
    let scope = match body.scope.trim().to_lowercase().as_str() {
        "read" => super::api_keys::Scope::Read,
        "write" => super::api_keys::Scope::Write,
        "admin" => super::api_keys::Scope::Admin,
        other => {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                format!("scope must be 'read' | 'write' | 'admin', got {:?}", other),
            ))
        }
    };
    let minted =
        super::api_keys::create_key(label, scope, body.brain_allowlist).map_err(ApiError::from)?;
    let key = super::api_keys::ApiKeyPublic::from(&minted.record);
    Ok(Json(ApiKeyCreateResponse {
        plaintext: minted.plaintext,
        key,
    }))
}

#[derive(serde::Serialize)]
pub struct ApiKeyRevokeResponse {
    pub revoked: bool,
}

pub async fn api_keys_revoke(
    Path(id): Path<String>,
    _s: State<ServerState>,
) -> Result<Json<ApiKeyRevokeResponse>, ApiError> {
    let revoked = super::api_keys::revoke_key(&id).map_err(ApiError::from)?;
    if !revoked {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            format!("api key not found: {}", id),
        ));
    }
    Ok(Json(ApiKeyRevokeResponse { revoked: true }))
}

// ---------------------------------------------------------------------------
// Gateway config — read/write `~/.neurovault/api_gateway.json`.
// Loopback-only (the gateway never manages its own config). The
// Settings UI calls these to flip `enabled`, change the bind, etc.
// Changes apply at next NeuroVault restart.
// ---------------------------------------------------------------------------

pub async fn api_gateway_config_get(
    _s: State<ServerState>,
) -> Result<Json<super::api_gateway::GatewayConfig>, ApiError> {
    Ok(Json(super::api_gateway::load_config()))
}

pub async fn api_gateway_config_set(
    _s: State<ServerState>,
    Json(body): Json<super::api_gateway::GatewayConfig>,
) -> Result<Json<super::api_gateway::GatewayConfig>, ApiError> {
    // Validate the bind shape BEFORE writing to disk so a typo'd
    // bind_ip doesn't brick the next restart.
    if let Err(e) = body.resolve_bind() {
        return Err(ApiError(StatusCode::BAD_REQUEST, e));
    }
    super::api_gateway::save_config(&body)
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(body))
}

// ---------------------------------------------------------------------------
// Compilations: agent-driven wiki compile flow.
//
// Two endpoints, designed for an agent (Claude Code, Cursor) to drive
// end-to-end without the desktop UI in the loop:
//
//   POST /api/compilations/prepare  body: {topic, brain?}
//     → {topic, sources[], existing_wiki?, schema?}
//   POST /api/compilations/submit   body: {topic, wiki_markdown,
//                                          source_engram_ids?, brain?}
//     → {compilation_id, wiki_engram_id, status}
//
// Agent flow:
//   1. Call prepare with a topic. We run hybrid_retrieve to find the
//      most relevant engrams, return them as "sources" plus any
//      existing wiki page on the topic.
//   2. Agent generates the wiki page from the pack with its own LLM.
//   3. Call submit with the markdown. We write the wiki engram into
//      vault/wiki/<slug>.md, INSERT a `compilations` row with status
//      `pending` so the UI's review panel picks it up the same way an
//      LLM-driven compile would.
//
// Approve / reject endpoints stay UI-only for now — agents shouldn't
// finalise their own work.
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
pub struct CompilePrepareBody {
    topic: String,
    #[serde(default)]
    brain: Option<String>,
    /// Optional override for the source pack size. Default 12 — enough
    /// context for a wiki page, not so much we drown the agent in
    /// duplicates.
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(serde::Serialize)]
pub struct CompileSourceItem {
    id: String,
    short_id: String,
    title: String,
    kind: String,
    content: String,
}

#[derive(serde::Serialize)]
pub struct CompileExistingWiki {
    id: String,
    content: String,
}

#[derive(serde::Serialize)]
pub struct CompilePreparePack {
    topic: String,
    brain_id: String,
    sources: Vec<CompileSourceItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    existing_wiki: Option<CompileExistingWiki>,
    schema: String,
}

pub async fn compile_prepare(
    _s: State<ServerState>,
    Json(body): Json<CompilePrepareBody>,
) -> Result<Json<CompilePreparePack>, ApiError> {
    let topic = body.topic.trim().to_string();
    if topic.is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "topic is required".into(),
        ));
    }
    let result = tokio::task::spawn_blocking(move || -> Result<CompilePreparePack, MemoryError> {
        let id = resolve_brain_id(body.brain.as_deref())?;
        let db = super::db::open_brain(&id)?;
        // Find sources via hybrid retrieve. Same pipeline the recall
        // tool uses, just at a slightly larger top_k so the agent has
        // headroom to pick what is relevant.
        let opts = super::retriever::RecallOpts {
            top_k: body.limit.unwrap_or(12),
            spread_hops: 1,
            exclude_kinds: vec!["observation".to_string()],
            as_of: None,
            use_reranker: false,
            ablate: Vec::new(),
        };
        let hits = super::retriever::hybrid_retrieve(&db, &topic, &opts)?;
        let sources: Vec<CompileSourceItem> = {
            let conn = db.lock();
            let mut out = Vec::with_capacity(hits.len());
            for h in &hits {
                let kind: String = conn
                    .query_row(
                        "SELECT COALESCE(kind, 'note') FROM engrams WHERE id = ?1",
                        [&h.engram_id],
                        |r| r.get(0),
                    )
                    .unwrap_or_else(|_| "note".to_string());
                let short_id: String = h.engram_id.chars().take(8).collect();
                out.push(CompileSourceItem {
                    id: h.engram_id.clone(),
                    short_id,
                    title: h.title.clone(),
                    kind,
                    content: h.content.clone(),
                });
            }
            out
        };
        // Existing wiki engram for this topic, if any. Match by slug
        // of the topic in the filename — same naming convention the
        // submit handler will use to write a new one.
        let slug = slug::slugify(&topic);
        let wiki_filename = format!("wiki/{}.md", slug);
        let existing_wiki: Option<CompileExistingWiki> = {
            let conn = db.lock();
            conn.query_row(
                "SELECT id, COALESCE(content, '') FROM engrams \
                 WHERE filename = ?1 AND state != 'dormant'",
                [&wiki_filename],
                |r| {
                    Ok(CompileExistingWiki {
                        id: r.get::<_, String>(0)?,
                        content: r.get::<_, String>(1)?,
                    })
                },
            )
            .ok()
        };
        // Optional CLAUDE.md / brain schema. Best-effort; missing file
        // is fine, just return empty.
        let vault = super::read_ops::resolve_vault_path(&id)?;
        let schema = std::fs::read_to_string(vault.join("CLAUDE.md"))
            .or_else(|_| std::fs::read_to_string(vault.join("schema.md")))
            .unwrap_or_default();
        Ok(CompilePreparePack {
            topic,
            brain_id: id,
            sources,
            existing_wiki,
            schema,
        })
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(result))
}

#[derive(serde::Deserialize)]
pub struct CompileSubmitBody {
    topic: String,
    wiki_markdown: String,
    #[serde(default)]
    source_engram_ids: Vec<String>,
    #[serde(default)]
    brain: Option<String>,
    /// When true, the new row is created with status='approved' and a
    /// review_comment of 'auto-approved'. Used by the UI's
    /// auto-approve toggle and by trusted MCP flows where a human is
    /// not in the loop.
    #[serde(default)]
    auto_approve: Option<bool>,
}

#[derive(serde::Serialize)]
pub struct CompileSubmitResult {
    compilation_id: String,
    wiki_engram_id: String,
    wiki_filename: String,
    brain_id: String,
    status: String,
}

pub async fn compile_submit(
    _s: State<ServerState>,
    Json(body): Json<CompileSubmitBody>,
) -> Result<Json<CompileSubmitResult>, ApiError> {
    if body.topic.trim().is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "topic is required".into(),
        ));
    }
    if body.wiki_markdown.trim().is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "wiki_markdown is required".into(),
        ));
    }
    let result =
        tokio::task::spawn_blocking(move || -> Result<CompileSubmitResult, MemoryError> {
            let id = resolve_brain_id(body.brain.as_deref())?;
            let vault = super::read_ops::resolve_vault_path(&id)?;
            let ctx = super::write_ops::BrainContext::resolve(Some(&id), vault)?;
            let slug = slug::slugify(&body.topic);
            let wiki_filename = format!("wiki/{}.md", slug);
            // Look up the existing wiki engram (if any) to capture old
            // content for the compilations row.
            let old_content: Option<String> = {
                let conn = ctx.db.lock();
                conn.query_row(
                    "SELECT COALESCE(content, '') FROM engrams WHERE filename = ?1",
                    [&wiki_filename],
                    |r| r.get(0),
                )
                .ok()
            };
            // Write through the standard save_note path so the file lands
            // on disk + the engram is re-ingested with correct chunks /
            // embeddings / kind.
            let write = super::write_ops::save_note(&ctx, &wiki_filename, &body.wiki_markdown)?;
            // Mark the engram kind as wiki so it shows up correctly in
            // the graph + retrieval.
            {
                let conn = ctx.db.lock();
                conn.execute(
                    "UPDATE engrams SET kind = 'wiki' WHERE id = ?1",
                    [&write.engram_id],
                )?;
            }
            // Persist a compilations row. Status depends on the
            // auto_approve flag: pending (the default — user reviews in
            // the Compile tab) or approved (auto-approved on submit).
            let compilation_id = uuid::Uuid::new_v4().to_string();
            let sources_json =
                serde_json::to_string(&body.source_engram_ids).map_err(MemoryError::Json)?;
            let auto = body.auto_approve.unwrap_or(false);
            let initial_status = if auto { "approved" } else { "pending" };
            {
                let conn = ctx.db.lock();
                if auto {
                    conn.execute(
                        "INSERT INTO compilations \
                     (id, topic, wiki_engram_id, old_content, new_content, \
                      changelog_json, sources_json, model, input_tokens, \
                      output_tokens, status, created_at, reviewed_at, \
                      review_comment) \
                     VALUES (?1, ?2, ?3, ?4, ?5, '[]', ?6, 'agent-driven', \
                      0, 0, 'approved', \
                      strftime('%Y-%m-%d %H:%M:%f', 'now'), \
                      strftime('%Y-%m-%d %H:%M:%f', 'now'), \
                      'auto-approved')",
                        rusqlite::params![
                            compilation_id,
                            body.topic,
                            write.engram_id,
                            old_content,
                            body.wiki_markdown,
                            sources_json,
                        ],
                    )?;
                } else {
                    conn.execute(
                        "INSERT INTO compilations \
                     (id, topic, wiki_engram_id, old_content, new_content, \
                      changelog_json, sources_json, model, input_tokens, \
                      output_tokens, status, created_at) \
                     VALUES (?1, ?2, ?3, ?4, ?5, '[]', ?6, 'agent-driven', \
                      0, 0, 'pending', strftime('%Y-%m-%d %H:%M:%f', 'now'))",
                        rusqlite::params![
                            compilation_id,
                            body.topic,
                            write.engram_id,
                            old_content,
                            body.wiki_markdown,
                            sources_json,
                        ],
                    )?;
                }
            }
            Ok(CompileSubmitResult {
                compilation_id,
                wiki_engram_id: write.engram_id,
                wiki_filename,
                brain_id: id,
                status: initial_status.to_string(),
            })
        })
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(ApiError::from)?;
    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// Compilations review queue — endpoints the desktop UI's Compile tab
// loads on open. Without these the tab errors with 404 the moment it
// mounts. Mirrors the shape `src/lib/api.ts` expects for
// CompilationSummary / CompilationDetail.
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
pub struct CompilationSummary {
    id: String,
    topic: String,
    status: String,
    model: String,
    change_count: i64,
    source_count: i64,
    input_tokens: i64,
    output_tokens: i64,
    created_at: String,
    reviewed_at: Option<String>,
}

#[derive(serde::Serialize)]
pub struct CompilationDetail {
    id: String,
    topic: String,
    status: String,
    model: String,
    change_count: i64,
    source_count: i64,
    input_tokens: i64,
    output_tokens: i64,
    created_at: String,
    reviewed_at: Option<String>,
    wiki_engram_id: Option<String>,
    old_content: String,
    new_content: String,
    changelog: serde_json::Value,
    sources: serde_json::Value,
    review_comment: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct CompilationsListQuery {
    status: Option<String>,
    limit: Option<i64>,
}

fn read_summary_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<CompilationSummary> {
    let changelog_json: String = r
        .get::<_, Option<String>>(8)?
        .unwrap_or_else(|| "[]".into());
    let sources_json: String = r
        .get::<_, Option<String>>(9)?
        .unwrap_or_else(|| "[]".into());
    let change_count = serde_json::from_str::<serde_json::Value>(&changelog_json)
        .ok()
        .and_then(|v| v.as_array().map(|a| a.len() as i64))
        .unwrap_or(0);
    let source_count = serde_json::from_str::<serde_json::Value>(&sources_json)
        .ok()
        .and_then(|v| v.as_array().map(|a| a.len() as i64))
        .unwrap_or(0);
    Ok(CompilationSummary {
        id: r.get(0)?,
        topic: r.get(1)?,
        status: r.get(2)?,
        model: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
        input_tokens: r.get::<_, Option<i64>>(4)?.unwrap_or(0),
        output_tokens: r.get::<_, Option<i64>>(5)?.unwrap_or(0),
        created_at: r.get(6)?,
        reviewed_at: r.get(7)?,
        change_count,
        source_count,
    })
}

pub async fn compilations_list(
    Query(q): Query<CompilationsListQuery>,
    _s: State<ServerState>,
) -> Result<Json<Vec<CompilationSummary>>, ApiError> {
    let result =
        tokio::task::spawn_blocking(move || -> Result<Vec<CompilationSummary>, MemoryError> {
            let id = resolve_brain_id(None)?;
            let db = open_brain(&id)?;
            let conn = db.lock();
            let limit = q.limit.unwrap_or(50).clamp(1, 500);
            let rows: Vec<CompilationSummary> = if let Some(st) = q.status.as_deref() {
                let mut stmt = conn.prepare(
                    "SELECT id, topic, status, model, input_tokens, output_tokens, \
                 created_at, reviewed_at, changelog_json, sources_json \
                 FROM compilations WHERE status = ?1 \
                 ORDER BY created_at DESC LIMIT ?2",
                )?;
                let mapped = stmt.query_map(rusqlite::params![st, limit], read_summary_row)?;
                mapped.filter_map(std::result::Result::ok).collect()
            } else {
                let mut stmt = conn.prepare(
                    "SELECT id, topic, status, model, input_tokens, output_tokens, \
                 created_at, reviewed_at, changelog_json, sources_json \
                 FROM compilations \
                 ORDER BY created_at DESC LIMIT ?1",
                )?;
                let mapped = stmt.query_map(rusqlite::params![limit], read_summary_row)?;
                mapped.filter_map(std::result::Result::ok).collect()
            };
            Ok(rows)
        })
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(ApiError::from)?;
    Ok(Json(result))
}

pub async fn compilations_pending(
    s: State<ServerState>,
) -> Result<Json<Vec<CompilationSummary>>, ApiError> {
    compilations_list(
        Query(CompilationsListQuery {
            status: Some("pending".to_string()),
            limit: Some(50),
        }),
        s,
    )
    .await
}

pub async fn compilations_get(
    _s: State<ServerState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<CompilationDetail>, ApiError> {
    let result = tokio::task::spawn_blocking(move || -> Result<CompilationDetail, MemoryError> {
        let bid = resolve_brain_id(None)?;
        let db = open_brain(&bid)?;
        let conn = db.lock();
        let mut stmt = conn.prepare(
            "SELECT id, topic, status, model, input_tokens, output_tokens, \
             created_at, reviewed_at, changelog_json, sources_json, \
             wiki_engram_id, old_content, new_content, review_comment \
             FROM compilations WHERE id = ?1",
        )?;
        stmt.query_row([&id], |r| {
            let changelog_json: String = r
                .get::<_, Option<String>>(8)?
                .unwrap_or_else(|| "[]".into());
            let sources_json: String = r
                .get::<_, Option<String>>(9)?
                .unwrap_or_else(|| "[]".into());
            let changelog =
                serde_json::from_str(&changelog_json).unwrap_or(serde_json::Value::Array(vec![]));
            let sources =
                serde_json::from_str(&sources_json).unwrap_or(serde_json::Value::Array(vec![]));
            let change_count = changelog.as_array().map(|a| a.len() as i64).unwrap_or(0);
            let source_count = sources.as_array().map(|a| a.len() as i64).unwrap_or(0);
            Ok(CompilationDetail {
                id: r.get(0)?,
                topic: r.get(1)?,
                status: r.get(2)?,
                model: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                input_tokens: r.get::<_, Option<i64>>(4)?.unwrap_or(0),
                output_tokens: r.get::<_, Option<i64>>(5)?.unwrap_or(0),
                created_at: r.get(6)?,
                reviewed_at: r.get(7)?,
                wiki_engram_id: r.get(10)?,
                old_content: r.get::<_, Option<String>>(11)?.unwrap_or_default(),
                new_content: r.get::<_, Option<String>>(12)?.unwrap_or_default(),
                review_comment: r.get(13)?,
                changelog,
                sources,
                change_count,
                source_count,
            })
        })
        .map_err(MemoryError::from)
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(|e: MemoryError| match &e {
        MemoryError::Database(rusqlite::Error::QueryReturnedNoRows) => {
            ApiError(StatusCode::NOT_FOUND, "compilation not found".into())
        }
        _ => ApiError::from(e),
    })?;
    Ok(Json(result))
}

#[derive(serde::Deserialize, Default)]
pub struct ReviewBody {
    #[serde(default)]
    review_comment: Option<String>,
}

#[derive(serde::Serialize)]
pub struct ReviewResult {
    status: String,
    id: String,
}

pub async fn compilations_approve(
    _s: State<ServerState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    body: Option<Json<ReviewBody>>,
) -> Result<Json<ReviewResult>, ApiError> {
    let body = body.map(|j| j.0).unwrap_or_default();
    let result = tokio::task::spawn_blocking(move || -> Result<ReviewResult, MemoryError> {
        let bid = resolve_brain_id(None)?;
        let db = open_brain(&bid)?;
        let conn = db.lock();
        let n = conn.execute(
            "UPDATE compilations SET status = 'approved', \
             reviewed_at = strftime('%Y-%m-%d %H:%M:%f', 'now'), \
             review_comment = ?1 WHERE id = ?2",
            rusqlite::params![body.review_comment, id],
        )?;
        if n == 0 {
            return Err(MemoryError::Other(format!("compilation not found: {}", id)));
        }
        Ok(ReviewResult {
            status: "approved".to_string(),
            id,
        })
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(result))
}

pub async fn compilations_reject(
    _s: State<ServerState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    body: Option<Json<ReviewBody>>,
) -> Result<Json<ReviewResult>, ApiError> {
    let body = body.map(|j| j.0).unwrap_or_default();
    let result = tokio::task::spawn_blocking(move || -> Result<ReviewResult, MemoryError> {
        let bid = resolve_brain_id(None)?;
        let db = open_brain(&bid)?;
        let conn = db.lock();
        // Revert: read old_content, write it back to the wiki engram, then
        // mark rejected. If old_content is empty (this was a brand-new
        // wiki page), we leave the wiki engram in place — the user can
        // delete it manually if they want.
        let row: Option<(Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT wiki_engram_id, old_content FROM compilations WHERE id = ?1",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();
        if let Some((Some(eid), Some(old))) = row {
            if !old.is_empty() {
                let _ = conn.execute(
                    "UPDATE engrams SET content = ?1, \
                     updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?2",
                    rusqlite::params![old, eid],
                );
            }
        }
        let n = conn.execute(
            "UPDATE compilations SET status = 'rejected', \
             reviewed_at = strftime('%Y-%m-%d %H:%M:%f', 'now'), \
             review_comment = ?1 WHERE id = ?2",
            rusqlite::params![body.review_comment, id],
        )?;
        if n == 0 {
            return Err(MemoryError::Other(format!("compilation not found: {}", id)));
        }
        Ok(ReviewResult {
            status: "rejected".to_string(),
            id,
        })
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// Cluster naming endpoints — backs the `/name-clusters` skill.
//
// GET /api/clusters returns the latest Louvain partition's clusters
// with sample titles + wikilinks. POST /api/clusters/names merges
// incoming names into ~/.neurovault/brains/{id}/cluster_names.json.
// State is populated by the frontend via nv_set_clusters whenever
// Analytics mode runs Louvain (i.e. on graph data change).
//
// Why HTTP instead of just a Tauri command: agents (Claude Code,
// Cursor) reach the brain via the MCP proxy, which forwards to this
// HTTP server. So agent-driven cluster naming MUST go through HTTP.
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
pub struct ClustersQuery {
    brain_id: Option<String>,
    /// When true, only return clusters that don't already have a name
    /// in cluster_names.json. Default true so the agent can run
    /// `/name-clusters` repeatedly without re-naming what was named
    /// already.
    only_unnamed: Option<bool>,
}

#[derive(serde::Serialize)]
pub struct ClusterListItem {
    id: u32,
    size: usize,
    top_titles: Vec<String>,
    sample_links: Vec<String>,
    /// Already-saved name, if any. Agent uses this to skip clusters
    /// the user has hand-edited.
    name: Option<String>,
}

#[derive(serde::Serialize)]
pub struct ClusterListResponse {
    clusters: Vec<ClusterListItem>,
    /// True when no Analytics-mode push has happened yet this session.
    /// Agents see this and tell the user "open the app and enable
    /// Analytics mode first."
    needs_analytics: bool,
}

pub async fn clusters_list(
    Query(q): Query<ClustersQuery>,
    _s: State<ServerState>,
) -> Result<Json<ClusterListResponse>, ApiError> {
    let only_unnamed = q.only_unnamed.unwrap_or(true);
    let brain_id = q.brain_id.clone();

    let resp = tokio::task::spawn_blocking(move || -> Result<ClusterListResponse, MemoryError> {
        let id = resolve_brain_id(brain_id.as_deref())?;
        let summaries = super::cluster_state::get_summaries(&id);
        let names = super::cluster_state::read_names(&id);
        let needs_analytics = summaries.is_empty();
        let clusters = summaries
            .into_iter()
            .filter_map(|c| {
                let existing = names.get(&c.id).cloned();
                if only_unnamed && existing.is_some() {
                    return None;
                }
                Some(ClusterListItem {
                    id: c.id,
                    size: c.size,
                    top_titles: c.top_titles,
                    sample_links: c.sample_links,
                    name: existing,
                })
            })
            .collect();
        Ok(ClusterListResponse {
            clusters,
            needs_analytics,
        })
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;

    Ok(Json(resp))
}

#[derive(serde::Deserialize)]
pub struct SetClusterNamesBody {
    /// Map from cluster id (string for JSON ergonomics) to user/agent
    /// label. Empty string clears that cluster's name.
    names: std::collections::HashMap<String, String>,
    brain_id: Option<String>,
}

#[derive(serde::Serialize)]
pub struct SetClusterNamesResponse {
    saved: usize,
    total_named: usize,
}

pub async fn clusters_set_names(
    _s: State<ServerState>,
    Json(body): Json<SetClusterNamesBody>,
) -> Result<Json<SetClusterNamesResponse>, ApiError> {
    let brain_id = body.brain_id.clone();
    let incoming_str = body.names;

    let resp =
        tokio::task::spawn_blocking(move || -> Result<SetClusterNamesResponse, MemoryError> {
            let id = resolve_brain_id(brain_id.as_deref())?;
            let mut parsed: std::collections::HashMap<u32, String> =
                std::collections::HashMap::new();
            let saved = incoming_str.len();
            for (k, v) in incoming_str {
                if let Ok(cid) = k.parse::<u32>() {
                    parsed.insert(cid, v);
                }
            }
            let merged =
                super::cluster_state::merge_names(&id, parsed).map_err(MemoryError::Other)?;
            Ok(SetClusterNamesResponse {
                saved,
                total_named: merged.len(),
            })
        })
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(ApiError::from)?;

    Ok(Json(resp))
}

// ===========================================================================
// Endpoints ported from the Python sidecar in v0.1.1.1.
// ===========================================================================
//
// The Python `api.py` had these routes; the Rust HTTP server initially
// shipped without them, so MCP tools that the proxy still advertised
// (session_start, recall_chunks, check_duplicate, core_memory_*, todos,
// changes, POST /api/brains) returned 404. This block restores them.
// ===========================================================================

// --- POST /api/brains  (create_brain bug fix) ----------------------------

#[derive(Deserialize)]
pub struct CreateBrainBody {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    vault_path: Option<String>,
}

#[derive(Serialize)]
pub struct CreateBrainResponse {
    id: String,
    name: String,
}

pub async fn brains_create(
    _s: State<ServerState>,
    Json(body): Json<CreateBrainBody>,
) -> Result<Json<CreateBrainResponse>, ApiError> {
    use std::fs;

    let name = body.name.trim().to_string();
    if name.is_empty() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "name required".into()));
    }

    let resp = tokio::task::spawn_blocking(move || -> Result<CreateBrainResponse, MemoryError> {
        let mut id = String::new();
        for ch in name.chars() {
            if ch.is_ascii_alphanumeric() {
                id.push(ch.to_ascii_lowercase());
            } else if ch == ' ' || ch == '-' || ch == '_' {
                id.push('-');
            }
        }
        if id.is_empty() {
            return Err(MemoryError::Other("name had no usable chars".into()));
        }

        let registry_path = super::paths::registry_path();
        let raw = fs::read_to_string(&registry_path).unwrap_or_else(|_| "{\"brains\":[]}".into());
        let mut json: serde_json::Value = serde_json::from_str(&raw).map_err(MemoryError::Json)?;

        let brains_arr = json
            .get_mut("brains")
            .and_then(|v| v.as_array_mut())
            .ok_or_else(|| MemoryError::Other("brains.json malformed".into()))?;

        let mut final_id = id.clone();
        let mut n = 2;
        while brains_arr
            .iter()
            .any(|b| b.get("id").and_then(|v| v.as_str()) == Some(&final_id))
        {
            final_id = format!("{}-{}", id, n);
            n += 1;
        }

        let now = time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_default();
        let mut entry = serde_json::json!({
            "id": final_id,
            "name": name,
            "description": body.description,
            "created_at": now,
        });
        if let Some(vp) = body.vault_path {
            if !vp.is_empty() {
                entry["vault_path"] = serde_json::Value::String(vp);
            }
        }
        brains_arr.push(entry);

        let tmp = registry_path.with_extension("json.tmp");
        fs::write(
            &tmp,
            serde_json::to_string_pretty(&json).map_err(MemoryError::Json)?,
        )
        .map_err(MemoryError::Io)?;
        std::fs::rename(&tmp, &registry_path).map_err(MemoryError::Io)?;

        let _db = open_brain(&final_id)?;
        Ok(CreateBrainResponse { id: final_id, name })
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;

    Ok(Json(resp))
}

// --- POST /api/check_duplicate -------------------------------------------

#[derive(Deserialize)]
pub struct CheckDuplicateBody {
    content: String,
    #[serde(default = "default_dupe_threshold")]
    threshold: f64,
    brain: Option<String>,
}

fn default_dupe_threshold() -> f64 {
    0.85
}

#[derive(Serialize)]
pub struct CheckDuplicateResponse {
    found: bool,
    engram_id: Option<String>,
    similarity: Option<f64>,
    title: Option<String>,
}

pub async fn check_duplicate(
    _s: State<ServerState>,
    Json(body): Json<CheckDuplicateBody>,
) -> Result<Json<CheckDuplicateResponse>, ApiError> {
    let resp =
        tokio::task::spawn_blocking(move || -> Result<CheckDuplicateResponse, MemoryError> {
            let id = resolve_brain_id(body.brain.as_deref())?;
            let db = open_brain(&id)?;
            let trimmed = body.content.trim();
            if trimmed.is_empty() {
                return Ok(CheckDuplicateResponse {
                    found: false,
                    engram_id: None,
                    similarity: None,
                    title: None,
                });
            }
            let vec = super::embedder::encode(trimmed)?;
            let conn = db.lock();
            // vec0 KNN pattern: MATCH operator + k = ?. Returns
            // chunk_id + distance from the virtual table, then we
            // join chunks + engrams to get the human-readable bits.
            let mut stmt = conn.prepare(
                "SELECT c.engram_id, e.title, v.distance \
                 FROM vec_chunks v \
                 JOIN chunks c ON c.id = v.chunk_id \
                 JOIN engrams e ON e.id = c.engram_id \
                 WHERE v.embedding MATCH ?1 AND k = 5 \
                 ORDER BY v.distance ASC",
            )?;
            let bytes = embedder_bytes(&vec);
            let hit = stmt
                .query_row(rusqlite::params![bytes], |r| {
                    let eid: String = r.get(0)?;
                    let title: String = r.get(1)?;
                    let dist: f64 = r.get(2)?;
                    Ok((eid, title, dist))
                })
                .ok();
            match hit {
                Some((eid, title, dist)) => {
                    let sim = 1.0 - dist;
                    if sim >= body.threshold {
                        Ok(CheckDuplicateResponse {
                            found: true,
                            engram_id: Some(eid),
                            similarity: Some(sim),
                            title: Some(title),
                        })
                    } else {
                        Ok(CheckDuplicateResponse {
                            found: false,
                            engram_id: None,
                            similarity: Some(sim),
                            title: None,
                        })
                    }
                }
                None => Ok(CheckDuplicateResponse {
                    found: false,
                    engram_id: None,
                    similarity: None,
                    title: None,
                }),
            }
        })
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(ApiError::from)?;

    Ok(Json(resp))
}

fn embedder_bytes(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for f in v {
        out.extend_from_slice(&f.to_le_bytes());
    }
    out
}

// --- GET /api/recall/chunks ----------------------------------------------

#[derive(Deserialize)]
pub struct RecallChunksQuery {
    q: String,
    #[serde(default = "default_chunks_limit")]
    limit: usize,
    brain: Option<String>,
}

fn default_chunks_limit() -> usize {
    10
}

#[derive(Serialize)]
pub struct ChunkHit {
    engram_id: String,
    title: String,
    chunk_text: String,
    granularity: String,
    similarity: f64,
}

#[derive(Serialize)]
pub struct RecallChunksResponse {
    hits: Vec<ChunkHit>,
}

pub async fn recall_chunks(
    Query(q): Query<RecallChunksQuery>,
    _s: State<ServerState>,
) -> Result<Json<RecallChunksResponse>, ApiError> {
    let resp = tokio::task::spawn_blocking(move || -> Result<RecallChunksResponse, MemoryError> {
        let id = resolve_brain_id(q.brain.as_deref())?;
        let db = open_brain(&id)?;
        let qvec = super::embedder::encode(&q.q)?;
        let conn = db.lock();
        // Over-fetch (limit*5) so we can dedup by engram in Rust
        // afterwards. vec0's MATCH operator doesn't compose with
        // window functions cleanly, so a two-stage approach is
        // both simpler and more reliable.
        let bytes = embedder_bytes(&qvec);
        let limit = q.limit.min(50);
        let overfetch = (limit * 5).max(20) as i64;
        let mut stmt = conn.prepare(
            "SELECT c.engram_id, e.title, c.content, c.granularity, v.distance \
             FROM vec_chunks v \
             JOIN chunks c ON c.id = v.chunk_id \
             JOIN engrams e ON e.id = c.engram_id \
             WHERE v.embedding MATCH ?1 AND k = ?2 \
                   AND e.state != 'dormant' \
             ORDER BY v.distance ASC",
        )?;
        let raw = stmt
            .query_map(rusqlite::params![bytes, overfetch], |r| {
                let eid: String = r.get(0)?;
                let title: String = r.get(1)?;
                let text: String = r.get(2)?;
                let gran: String = r.get(3)?;
                let dist: f64 = r.get(4)?;
                Ok(ChunkHit {
                    engram_id: eid,
                    title,
                    chunk_text: text,
                    granularity: gran,
                    similarity: 1.0 - dist,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        // Keep only the best-ranked chunk per engram_id, in order.
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut rows: Vec<ChunkHit> = Vec::with_capacity(limit);
        for hit in raw {
            if seen.insert(hit.engram_id.clone()) {
                rows.push(hit);
                if rows.len() >= limit {
                    break;
                }
            }
        }
        Ok(RecallChunksResponse { hits: rows })
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;

    Ok(Json(resp))
}

// --- GET /api/session_start ----------------------------------------------

#[derive(Deserialize)]
pub struct SessionStartQuery {
    brain: Option<String>,
    /// Optional: scope the bootstrap to one agent — return THAT agent's own
    /// recent engrams + its inbox instead of the brain-wide view. Absent =>
    /// unchanged (back-compat).
    agent: Option<String>,
}

#[derive(Serialize)]
pub struct TopMemorySummary {
    engram_id: String,
    title: String,
    strength: f64,
    state: String,
    access_count: i64,
}

#[derive(Serialize)]
pub struct SessionStartResponse {
    brain: Option<BrainSummary>,
    stats: Option<BrainStats>,
    core_memory: Vec<CoreBlock>,
    top_memories: Vec<TopMemorySummary>,
    open_todos: Vec<Todo>,
}

pub async fn session_start(
    Query(q): Query<SessionStartQuery>,
    _s: State<ServerState>,
) -> Result<Json<SessionStartResponse>, ApiError> {
    let resp = tokio::task::spawn_blocking(move || -> Result<SessionStartResponse, MemoryError> {
        let id = resolve_brain_id(q.brain.as_deref())?;
        let stats = brain_stats(&id).ok();
        let brain = list_brains_with_stats()
            .ok()
            .and_then(|all| all.into_iter().find(|b| b.id == id));
        let core_memory = core_memory::list_blocks(&id).unwrap_or_default();
        // Agent-scoped (optional): `agent` set => that agent's own recent
        // engrams + its inbox; absent => brain-wide (unchanged).
        let agent = q.agent.as_deref().filter(|a| !a.is_empty());
        let open_todos = match agent {
            Some(a) => todos::inbox_for_agent(&id, a, false).unwrap_or_default(),
            None => todos::list_todos(&id, Some("open")).unwrap_or_default(),
        };

        let db = open_brain(&id)?;
        let conn = db.lock();
        let row_to_summary = |r: &rusqlite::Row| {
            Ok(TopMemorySummary {
                engram_id: r.get(0)?,
                title: r.get(1)?,
                strength: r.get(2)?,
                state: r.get(3)?,
                access_count: r.get(4)?,
            })
        };
        let top = match agent {
            Some(a) => {
                let mut stmt = conn.prepare(
                    "SELECT id, title, strength, state, access_count \
                     FROM engrams \
                     WHERE state != 'dormant' AND agent_id = ?1 \
                     ORDER BY updated_at DESC, strength DESC LIMIT 5",
                )?;
                let rows = stmt
                    .query_map([a], row_to_summary)?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                rows
            }
            None => {
                let mut stmt = conn.prepare(
                    "SELECT id, title, strength, state, access_count \
                     FROM engrams \
                     WHERE state != 'dormant' \
                     ORDER BY strength DESC, access_count DESC LIMIT 5",
                )?;
                let rows = stmt
                    .query_map([], row_to_summary)?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                rows
            }
        };

        Ok(SessionStartResponse {
            brain,
            stats,
            core_memory,
            top_memories: top,
            open_todos,
        })
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;

    Ok(Json(resp))
}

// --- GET /api/changes (diff feed) ----------------------------------------

#[derive(Deserialize)]
pub struct ChangesQuery {
    since: Option<String>,
    brain: Option<String>,
    #[serde(default = "default_changes_limit")]
    limit: usize,
}

fn default_changes_limit() -> usize {
    50
}

#[derive(Serialize)]
pub struct ChangeRow {
    engram_id: String,
    title: String,
    updated_at: String,
    state: String,
    kind: String,
}

#[derive(Serialize)]
pub struct ChangesResponse {
    changes: Vec<ChangeRow>,
}

pub async fn changes_feed(
    Query(q): Query<ChangesQuery>,
    _s: State<ServerState>,
) -> Result<Json<ChangesResponse>, ApiError> {
    let resp = tokio::task::spawn_blocking(move || -> Result<ChangesResponse, MemoryError> {
        let id = resolve_brain_id(q.brain.as_deref())?;
        let db = open_brain(&id)?;
        let conn = db.lock();
        let limit = q.limit.min(500) as i64;
        let since = q.since.unwrap_or_default();
        let mut rows: Vec<ChangeRow> = Vec::new();
        if since.is_empty() {
            let mut stmt = conn.prepare(
                "SELECT id, title, COALESCE(updated_at, ''), state, COALESCE(kind, '') \
                 FROM engrams ORDER BY updated_at DESC LIMIT ?1",
            )?;
            let it = stmt.query_map(rusqlite::params![limit], |r| {
                Ok(ChangeRow {
                    engram_id: r.get(0)?,
                    title: r.get(1)?,
                    updated_at: r.get(2)?,
                    state: r.get(3)?,
                    kind: r.get(4)?,
                })
            })?;
            for row in it {
                rows.push(row?);
            }
        } else {
            let mut stmt = conn.prepare(
                "SELECT id, title, COALESCE(updated_at, ''), state, COALESCE(kind, '') \
                 FROM engrams WHERE updated_at > ?1 ORDER BY updated_at DESC LIMIT ?2",
            )?;
            let it = stmt.query_map(rusqlite::params![since, limit], |r| {
                Ok(ChangeRow {
                    engram_id: r.get(0)?,
                    title: r.get(1)?,
                    updated_at: r.get(2)?,
                    state: r.get(3)?,
                    kind: r.get(4)?,
                })
            })?;
            for row in it {
                rows.push(row?);
            }
        }
        Ok(ChangesResponse { changes: rows })
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;

    Ok(Json(resp))
}

// --- /api/core_memory ----------------------------------------------------

#[derive(Deserialize)]
pub struct CoreMemoryQuery {
    brain: Option<String>,
}

pub async fn core_memory_list(
    Query(q): Query<CoreMemoryQuery>,
    _s: State<ServerState>,
) -> Result<Json<Vec<CoreBlock>>, ApiError> {
    let blocks = tokio::task::spawn_blocking(move || -> Result<Vec<CoreBlock>, MemoryError> {
        let id = resolve_brain_id(q.brain.as_deref())?;
        core_memory::list_blocks(&id)
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(blocks))
}

pub async fn core_memory_read(
    Path(label): Path<String>,
    Query(q): Query<CoreMemoryQuery>,
    _s: State<ServerState>,
) -> Result<Json<Option<CoreBlock>>, ApiError> {
    let block = tokio::task::spawn_blocking(move || -> Result<Option<CoreBlock>, MemoryError> {
        let id = resolve_brain_id(q.brain.as_deref())?;
        core_memory::read_block(&id, &label)
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(block))
}

#[derive(Deserialize)]
pub struct CoreMemorySetBody {
    value: String,
    brain: Option<String>,
}

pub async fn core_memory_set(
    Path(label): Path<String>,
    _s: State<ServerState>,
    Json(body): Json<CoreMemorySetBody>,
) -> Result<Json<CoreBlock>, ApiError> {
    let block = tokio::task::spawn_blocking(move || -> Result<CoreBlock, MemoryError> {
        let id = resolve_brain_id(body.brain.as_deref())?;
        core_memory::set_block(&id, &label, body.value)
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(block))
}

#[derive(Deserialize)]
pub struct CoreMemoryAppendBody {
    text: String,
    brain: Option<String>,
}

pub async fn core_memory_append(
    Path(label): Path<String>,
    _s: State<ServerState>,
    Json(body): Json<CoreMemoryAppendBody>,
) -> Result<Json<CoreBlock>, ApiError> {
    let block = tokio::task::spawn_blocking(move || -> Result<CoreBlock, MemoryError> {
        let id = resolve_brain_id(body.brain.as_deref())?;
        core_memory::append_block(&id, &label, &body.text)
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(block))
}

#[derive(Deserialize)]
pub struct CoreMemoryReplaceBody {
    old: String,
    new: String,
    brain: Option<String>,
}

pub async fn core_memory_replace(
    Path(label): Path<String>,
    _s: State<ServerState>,
    Json(body): Json<CoreMemoryReplaceBody>,
) -> Result<Json<Option<CoreBlock>>, ApiError> {
    let block = tokio::task::spawn_blocking(move || -> Result<Option<CoreBlock>, MemoryError> {
        let id = resolve_brain_id(body.brain.as_deref())?;
        core_memory::replace_in_block(&id, &label, &body.old, &body.new)
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(block))
}

// --- /api/todos ----------------------------------------------------------

#[derive(Deserialize)]
pub struct TodosListQuery {
    status: Option<String>,
    brain: Option<String>,
}

pub async fn todos_list(
    Query(q): Query<TodosListQuery>,
    _s: State<ServerState>,
) -> Result<Json<Vec<Todo>>, ApiError> {
    let result = tokio::task::spawn_blocking(move || -> Result<Vec<Todo>, MemoryError> {
        let id = resolve_brain_id(q.brain.as_deref())?;
        todos::list_todos(&id, q.status.as_deref())
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(result))
}

#[derive(Deserialize)]
pub struct TodosAddBody {
    text: String,
    agent_match: Option<String>,
    priority: Option<String>,
    created_by: Option<String>,
    note: Option<String>,
    brain: Option<String>,
}

pub async fn todos_add(
    _s: State<ServerState>,
    Json(body): Json<TodosAddBody>,
) -> Result<Json<Todo>, ApiError> {
    let result = tokio::task::spawn_blocking(move || -> Result<Todo, MemoryError> {
        let id = resolve_brain_id(body.brain.as_deref())?;
        todos::add_todo(
            &id,
            AddTodoArgs {
                text: body.text,
                agent_match: body.agent_match,
                priority: body.priority,
                created_by: body.created_by,
                note: body.note,
                kind: None,
                payload: None,
                source_engram: None,
            },
        )
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(result))
}

// --- Multi-agent coordination: handoff + agent inbox -----------------------
// A handoff is a directed todo (kind set) addressed to another agent via
// agent_match. Inert: it just sits in the inbox until that agent polls and
// acts. No scheduler, no auto-run — NeuroVault is the shared brain, not a
// runtime. See docs/specs/agent-coordination.md.

#[derive(Deserialize)]
pub struct HandoffBody {
    to_agent: String,
    #[serde(rename = "type")]
    kind: String,
    payload: Option<serde_json::Value>,
    source_engram: Option<String>,
    note: Option<String>,
    from_agent: Option<String>,
    priority: Option<String>,
    brain: Option<String>,
}

pub async fn handoff(
    _s: State<ServerState>,
    Json(body): Json<HandoffBody>,
) -> Result<Json<Todo>, ApiError> {
    let result = tokio::task::spawn_blocking(move || -> Result<Todo, MemoryError> {
        let id = resolve_brain_id(body.brain.as_deref())?;
        let text = format!("handoff:{}", body.kind);
        todos::add_todo(
            &id,
            AddTodoArgs {
                text,
                agent_match: Some(body.to_agent),
                priority: body.priority,
                created_by: body.from_agent,
                note: body.note,
                kind: Some(body.kind),
                payload: body.payload,
                source_engram: body.source_engram,
            },
        )
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(result))
}

#[derive(Deserialize)]
pub struct AgentInboxQuery {
    agent: String,
    brain: Option<String>,
}

pub async fn agent_inbox(
    Query(q): Query<AgentInboxQuery>,
    _s: State<ServerState>,
) -> Result<Json<Vec<Todo>>, ApiError> {
    let result = tokio::task::spawn_blocking(move || -> Result<Vec<Todo>, MemoryError> {
        let id = resolve_brain_id(q.brain.as_deref())?;
        // handoffs_only=true: an inbox is inter-agent handoffs, not plain todos.
        todos::inbox_for_agent(&id, &q.agent, true)
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(result))
}

pub async fn todos_get(
    Path(id): Path<String>,
    Query(q): Query<TodosListQuery>,
    _s: State<ServerState>,
) -> Result<Json<Option<Todo>>, ApiError> {
    let result = tokio::task::spawn_blocking(move || -> Result<Option<Todo>, MemoryError> {
        let bid = resolve_brain_id(q.brain.as_deref())?;
        todos::get_todo(&bid, &id)
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(result))
}

#[derive(Deserialize)]
pub struct TodosClaimBody {
    agent_id: String,
    brain: Option<String>,
}

pub async fn todos_claim(
    Path(id): Path<String>,
    _s: State<ServerState>,
    Json(body): Json<TodosClaimBody>,
) -> Result<Json<Option<Todo>>, ApiError> {
    let result = tokio::task::spawn_blocking(move || -> Result<Option<Todo>, MemoryError> {
        let bid = resolve_brain_id(body.brain.as_deref())?;
        todos::claim_todo(&bid, &id, &body.agent_id)
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(result))
}

#[derive(Deserialize)]
pub struct TodosCompleteBody {
    brain: Option<String>,
}

pub async fn todos_complete(
    Path(id): Path<String>,
    _s: State<ServerState>,
    Json(body): Json<TodosCompleteBody>,
) -> Result<Json<Todo>, ApiError> {
    let result = tokio::task::spawn_blocking(move || -> Result<Todo, MemoryError> {
        let bid = resolve_brain_id(body.brain.as_deref())?;
        todos::complete_todo(&bid, &id)
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// Drop-folder inbox. Backs the MCP `list_inbox` / `read_inbox_file` /
// `mark_inbox_done` tools. The inbox is a staging area for raw dropped
// files; the agent reads them here, writes a clean note into the vault
// (via the normal remember/save path), then marks the raw file done.
// See super::inbox for the on-disk semantics.
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
pub struct ConflictsQuery2 {
    #[serde(default)]
    brain: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

/// GET /api/conflicts — on-demand sweep for potential contradictions
/// (mid-similarity note pairs). Backs the `find_conflicts` MCP tool.
pub async fn conflicts_find(
    _s: State<ServerState>,
    Query(q): Query<ConflictsQuery2>,
) -> Result<Json<Vec<super::ingest::ConflictPair>>, ApiError> {
    let limit = q.limit.unwrap_or(20).clamp(1, 200);
    let pairs = tokio::task::spawn_blocking(move || -> Result<_, MemoryError> {
        let id = resolve_brain_id(q.brain.as_deref())?;
        let db = open_brain(&id)?;
        super::ingest::find_conflicts(&db, limit)
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(pairs))
}

#[derive(Deserialize, Default)]
pub struct DiagnosticQuery {
    #[serde(default)]
    brain: Option<String>,
}

/// GET /api/diagnostic — brain health scorecard. Backs the MCP
/// `diagnose_brain` tool and the in-app Diagnostic panel.
pub async fn diagnostic_get(
    _s: State<ServerState>,
    Query(q): Query<DiagnosticQuery>,
) -> Result<Json<super::diagnostic::DiagnosticReport>, ApiError> {
    let report = tokio::task::spawn_blocking(move || -> Result<_, MemoryError> {
        let id = resolve_brain_id(q.brain.as_deref())?;
        let db = open_brain(&id)?;
        super::diagnostic::diagnose(&db)
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(report))
}

#[derive(Deserialize, Default)]
pub struct InboxListQuery {
    #[serde(default)]
    brain: Option<String>,
}

pub async fn inbox_list(
    _s: State<ServerState>,
    Query(q): Query<InboxListQuery>,
) -> Result<Json<Vec<super::inbox::InboxFile>>, ApiError> {
    let brain_id = resolve_brain_id(q.brain.as_deref())?;
    let files = super::inbox::list_inbox(&brain_id)?;
    Ok(Json(files))
}

#[derive(Deserialize)]
pub struct InboxReadQuery {
    name: String,
    #[serde(default)]
    brain: Option<String>,
}

pub async fn inbox_read(
    _s: State<ServerState>,
    Query(q): Query<InboxReadQuery>,
) -> Result<Json<super::inbox::InboxFileContent>, ApiError> {
    let brain_id = resolve_brain_id(q.brain.as_deref())?;
    let content = super::inbox::read_inbox_file(&brain_id, &q.name)?;
    Ok(Json(content))
}

#[derive(Deserialize)]
pub struct InboxDoneBody {
    name: String,
    #[serde(default)]
    brain: Option<String>,
}

pub async fn inbox_done(
    _s: State<ServerState>,
    Json(body): Json<InboxDoneBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let brain_id = resolve_brain_id(body.brain.as_deref())?;
    super::inbox::mark_done(&brain_id, &body.name)?;
    Ok(Json(
        serde_json::json!({ "status": "ok", "name": body.name }),
    ))
}

// ---------------------------------------------------------------------------
// Per-brain source folders.
//
//   GET  /api/brains/:brain_id/sources         — list configured sources,
//        each enriched with manifest-derived file_count + last_synced.
//   PUT  /api/brains/:brain_id/sources         — replace the source list
//        (validates each path is a directory), persist, and if the brain
//        is active (re)start its mirror watchers + run an initial sync.
//   POST /api/brains/:brain_id/sources/sync    — force a full re-mirror now
//        (works whether or not the brain is active).
//   GET  /api/brains/:brain_id/sources/preview — read-only dry run.
//
// Source-folder CONFIG lives in brains.json (canonical config, never only
// in the rebuildable brain.db). file_count + last_synced are NOT stored in
// the brain record — they're computed from the per-brain
// `sources_manifest.json` at response time.
// ---------------------------------------------------------------------------

/// One source folder in a GET response — config plus manifest-derived
/// status. Matches the frontend contract exactly.
#[derive(Serialize)]
pub struct SourceOut {
    pub path: String,
    pub enabled: bool,
    /// RFC3339 of the most recent sync that touched any file from this
    /// folder, or null if it has never produced a mirrored note.
    pub last_synced: Option<String>,
    /// Number of files this folder currently contributes to the vault.
    pub file_count: u32,
}

#[derive(Serialize)]
pub struct SourcesListResponse {
    pub sources: Vec<SourceOut>,
}

/// One source folder in a PUT body — config only (status is derived, never
/// accepted from the client).
#[derive(Deserialize)]
pub struct SourceIn {
    pub path: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_enabled() -> bool {
    true
}

#[derive(Deserialize)]
pub struct SourcesPutBody {
    pub sources: Vec<SourceIn>,
}

/// Build the GET response shape for a brain from its registry config +
/// manifest-derived status. Shared by GET and PUT (which returns the same
/// shape on success).
fn sources_response(brain_id: &str) -> Result<SourcesListResponse, ApiError> {
    let folders = super::read_ops::registry_source_folders(brain_id)?;
    let sources = folders
        .into_iter()
        .map(|f| {
            let status = super::source_mirror::source_status(brain_id, &f.path);
            SourceOut {
                path: f.path,
                enabled: f.enabled,
                last_synced: status.last_synced,
                file_count: status.file_count,
            }
        })
        .collect();
    Ok(SourcesListResponse { sources })
}

pub async fn brain_sources_list(
    Path(brain_id): Path<String>,
    _s: State<ServerState>,
) -> Result<Json<SourcesListResponse>, ApiError> {
    let out = tokio::task::spawn_blocking(move || sources_response(&brain_id))
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))??;
    Ok(Json(out))
}

pub async fn brain_sources_set(
    Path(brain_id): Path<String>,
    _s: State<ServerState>,
    Json(body): Json<SourcesPutBody>,
) -> Result<Json<SourcesListResponse>, ApiError> {
    let out = tokio::task::spawn_blocking(move || -> Result<SourcesListResponse, ApiError> {
        // Validate the brain exists (clean 404 rather than a write error).
        let _ = super::read_ops::registry_source_folders(&brain_id)?;

        // Validate every path is an existing directory FIRST — persist
        // nothing if any is invalid.
        for s in &body.sources {
            if !std::path::Path::new(&s.path).is_dir() {
                return Err(ApiError(
                    StatusCode::BAD_REQUEST,
                    format!("{} is not a directory", s.path),
                ));
            }
        }

        let folders: Vec<super::types::SourceFolder> = body
            .sources
            .iter()
            .map(|s| super::types::SourceFolder {
                path: s.path.clone(),
                enabled: s.enabled,
            })
            .collect();

        // Persist config to brains.json.
        super::write_ops::set_source_folders(&brain_id, &folders)?;

        // If this is the active brain, (re)start its mirror watchers and run
        // an initial sync so the new config takes effect now.
        // restart_for_brain re-reads source_folders + syncs.
        let active = resolve_brain_id(None).ok();
        if active.as_deref() == Some(brain_id.as_str()) {
            let vault = super::read_ops::resolve_vault_path(&brain_id)?;
            if let Err(e) = super::watcher::restart_for_brain(&brain_id, vault) {
                eprintln!(
                    "[brain_sources_set] watcher restart for {} failed: {}",
                    brain_id, e
                );
            }
        }

        sources_response(&brain_id)
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))??;
    Ok(Json(out))
}

#[derive(Serialize)]
pub struct SourcesSyncResponse {
    pub synced: u32,
    pub removed: u32,
    pub skipped_duplicates: u32,
}

pub async fn brain_sources_sync(
    Path(brain_id): Path<String>,
    _s: State<ServerState>,
) -> Result<Json<SourcesSyncResponse>, ApiError> {
    let report = tokio::task::spawn_blocking(move || super::source_mirror::sync(&brain_id))
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(ApiError::from)?;
    Ok(Json(SourcesSyncResponse {
        synced: report.synced,
        removed: report.removed,
        skipped_duplicates: report.skipped_duplicates,
    }))
}

/// GET /api/brains/:brain_id/sources/preview — a read-only dry run: what a
/// sync WOULD add / update / remove / skip, with no changes to the brain.
pub async fn brain_sources_preview(
    Path(brain_id): Path<String>,
    _s: State<ServerState>,
) -> Result<Json<super::source_mirror::SyncPlan>, ApiError> {
    let plan = tokio::task::spawn_blocking(move || super::source_mirror::plan(&brain_id))
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(ApiError::from)?;
    Ok(Json(plan))
}
