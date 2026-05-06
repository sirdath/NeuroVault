//! Axum HTTP server on 127.0.0.1:8765 — same port the Python
//! FastAPI sidecar used. Path + response shapes match what
//! `mcp_proxy.py` already sends. That's the contract: the MCP
//! proxy is the external-facing piece and doesn't need to know
//! which runtime answers.
//!
//! Endpoints implemented in Phase 6:
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
//!
//! The server binds to 127.0.0.1 only — never exposes outside the
//! loopback. Same invariant the Python server held; the MCP proxy
//! connects to loopback so this keeps working without config
//! changes.

use std::net::SocketAddr;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json};
use axum::routing::{get, post};
use axum::Router;
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tower_http::cors::{Any, CorsLayer};

use super::db::open_brain;
use super::ingest;
use super::read_ops::{
    brain_stats, get_graph, get_note, list_brains_with_stats, list_notes, resolve_brain_id,
    BrainStats, BrainSummary, FullNote, NoteListRow,
};
use super::core_memory::{self, CoreBlock};
use super::related::{get_related_checked, RelatedHit, RelatedOpts};
use super::retriever::{hybrid_retrieve_throttled, RecallHit, RecallOpts};
use super::todos::{self, AddTodoArgs, Todo};
use super::types::{GraphData, MemoryError};

/// Default bind port. Matches Python's `SERVER_PORT` default. Kept as
/// a const rather than reading the env at bind time so stopping +
/// restarting doesn't accidentally hop ports.
pub const DEFAULT_PORT: u16 = 8765;

/// Handle returned by `start_server` — holds the shutdown trigger +
/// the join handle for the tokio task. `stop()` sends the shutdown
/// signal, awaits the task, and frees the port.
pub struct ServerHandle {
    pub port: u16,
    shutdown: Option<oneshot::Sender<()>>,
    join: Option<tokio::task::JoinHandle<()>>,
}

impl ServerHandle {
    /// Gracefully stop the server. Idempotent — second call is a no-op.
    pub async fn stop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(join) = self.join.take() {
            let _ = join.await;
        }
    }
}

/// Spin up the server on `port` (or `DEFAULT_PORT` when `None`).
/// Must be called from inside a tokio runtime. Returns once the
/// listener is bound; the accept loop runs as a background task.
pub async fn start_server(port: Option<u16>) -> Result<ServerHandle, String> {
    let port = port.unwrap_or(DEFAULT_PORT);
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();

    let app = router();
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|e| format!("could not bind {}: {}", addr, e))?;

    let (tx, rx) = oneshot::channel::<()>();
    let join = tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = rx.await;
            })
            .await;
    });

    Ok(ServerHandle {
        port,
        shutdown: Some(tx),
        join: Some(join),
    })
}

/// Router factory — separated from `start_server` so tests can hit
/// it in-process without binding to a real port.
fn router() -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/status", get(status))
        .route("/api/brains", get(brains_list))
        .route("/api/brains/active", get(brains_active))
        .route("/api/brains/:brain_id/activate", post(brains_activate))
        .route("/api/brains/:brain_id/stats", get(brains_stats))
        .route("/api/notes", get(notes_list))
        .route("/api/notes/:engram_id", get(notes_detail))
        .route("/api/graph", get(graph))
        .route("/api/recall", get(recall))
        .route("/api/recall/chunks", get(recall_chunks))
        .route("/api/related/:engram_id", get(related))
        .route("/api/notes", post(remember))
        .route("/api/notes", axum::routing::put(notes_save))
        .route("/api/notes", axum::routing::delete(notes_delete))
        .route("/api/update", post(update_brain))
        .route("/api/clutter", get(clutter_report))
        .route("/api/engrams/delete", post(engrams_delete))
        .route("/api/compilations/prepare", post(compile_prepare))
        .route("/api/compilations/submit", post(compile_submit))
        .route("/api/compilations", get(compilations_list))
        .route("/api/compilations/pending", get(compilations_pending))
        .route("/api/compilations/:id", get(compilations_get))
        .route("/api/compilations/:id/approve", post(compilations_approve))
        .route("/api/compilations/:id/reject", post(compilations_reject))
        .route("/api/brains", post(brains_create))
        .route("/api/check_duplicate", post(check_duplicate))
        .route("/api/session_start", get(session_start))
        .route("/api/changes", get(changes_feed))
        .route("/api/core_memory", get(core_memory_list))
        .route("/api/core_memory/:label", get(core_memory_read))
        .route("/api/core_memory/:label", axum::routing::put(core_memory_set))
        .route("/api/core_memory/:label/append", post(core_memory_append))
        .route("/api/core_memory/:label/replace", post(core_memory_replace))
        .route("/api/todos", get(todos_list))
        .route("/api/todos", post(todos_add))
        .route("/api/todos/:id", get(todos_get))
        .route("/api/todos/:id/claim", post(todos_claim))
        .route("/api/todos/:id/complete", post(todos_complete))
        .route("/api/clusters", get(clusters_list))
        .route("/api/clusters/names", post(clusters_set_names))
        // The Tauri webview's origin (`tauri://localhost` in production,
        // `http://localhost:1420` in dev) is cross-origin to this server,
        // so plain `fetch()` from the React side fails the preflight
        // without these headers. Permissive CORS is safe here because
        // the listener binds to 127.0.0.1 only — there is no LAN
        // exposure, so the only origins that can ever reach this port
        // are running on the same machine as the user.
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(ServerState {})
}

#[derive(Clone)]
struct ServerState {}

// ---- Error handling ------------------------------------------------------

/// Wrap `MemoryError` so axum can render it as JSON with a status
/// code the frontend + MCP proxy already understand (404 for
/// not-found, 500 for everything else).
struct ApiError(StatusCode, String);

impl From<MemoryError> for ApiError {
    fn from(e: MemoryError) -> Self {
        match e {
            MemoryError::BrainNotFound(id) => {
                ApiError(StatusCode::NOT_FOUND, format!("brain not found: {}", id))
            }
            MemoryError::EngramNotFound(id) => ApiError(
                StatusCode::NOT_FOUND,
                format!("engram not found: {}", id),
            ),
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

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({"status": "ok", "service": "neurovault-rust"}))
}

#[derive(Serialize)]
struct FreshnessBreakdown {
    fresh: i64,
    active: i64,
    dormant: i64,
    total: i64,
}

#[derive(Serialize)]
struct LinkBreakdown {
    manual: i64,
    entity: i64,
    semantic: i64,
    other: i64,
    total: i64,
}

#[derive(Serialize)]
struct StatusBody {
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

async fn status(_s: State<ServerState>) -> Result<Json<StatusBody>, ApiError> {
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

async fn brains_list(_s: State<ServerState>) -> Result<Json<Vec<BrainSummary>>, ApiError> {
    Ok(Json(list_brains_with_stats()?))
}

#[derive(Serialize)]
struct ActiveBrainBody {
    id: String,
}

async fn brains_active(_s: State<ServerState>) -> Result<Json<ActiveBrainBody>, ApiError> {
    Ok(Json(ActiveBrainBody {
        id: resolve_brain_id(None)?,
    }))
}

async fn brains_activate(
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

async fn brains_stats(
    Path(brain_id): Path<String>,
    _s: State<ServerState>,
) -> Result<Json<BrainStats>, ApiError> {
    Ok(Json(brain_stats(&brain_id)?))
}

async fn notes_list(_s: State<ServerState>) -> Result<Json<Vec<NoteListRow>>, ApiError> {
    let id = resolve_brain_id(None)?;
    let db = open_brain(&id)?;
    Ok(Json(list_notes(&db)?))
}

async fn notes_detail(
    Path(engram_id): Path<String>,
    _s: State<ServerState>,
) -> Result<Json<FullNote>, ApiError> {
    let id = resolve_brain_id(None)?;
    let db = open_brain(&id)?;
    Ok(Json(get_note(&db, &engram_id)?))
}

#[derive(Deserialize)]
struct GraphQuery {
    #[serde(default)]
    include_observations: Option<bool>,
    #[serde(default)]
    min_similarity: Option<f64>,
}

async fn graph(
    Query(q): Query<GraphQuery>,
    _s: State<ServerState>,
) -> Result<Json<GraphData>, ApiError> {
    let id = resolve_brain_id(None)?;
    let db = open_brain(&id)?;
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
    )?))
}

#[derive(Deserialize)]
struct RecallQuery {
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
    #[serde(default)]
    brain_id: Option<String>,
    /// Comma-separated list of scoring features to disable. Used by
    /// the eval harness to A/B-test which signals earn their weight.
    /// Production callers never set this; the retriever defaults to
    /// the full pipeline.
    #[serde(default)]
    ablate: Option<String>,
    /// Enable cross-encoder reranker on top-20. Adds ~50-100 ms
    /// per call; improves top-1 precision. Off by default.
    #[serde(default)]
    rerank: Option<bool>,
}

async fn recall(
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
        use_reranker: q.rerank.unwrap_or(false),
        ablate: ablate_list,
    };
    let query_str = q.q.clone();

    let result = tokio::task::spawn_blocking(move || -> Result<Vec<RecallHit>, MemoryError> {
        let id = resolve_brain_id(brain_id.as_deref())?;
        let db = open_brain(&id)?;
        hybrid_retrieve_throttled(&db, &query_str, &opts)
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
struct RelatedQuery {
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

async fn related(
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
struct RememberBody {
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
}

#[derive(Serialize)]
struct RememberResult {
    status: String, // "created" | "updated" | "unchanged" | "merged"
    engram_id: String,
    /// Only populated on `status == "merged"` — the cosine similarity
    /// that triggered the merge. Lets agents decide whether to retry
    /// with a higher threshold if they wanted the note created anyway.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    similarity: Option<f64>,
}

/// Hard ceiling on `remember` content size. Agents occasionally send
/// an entire wiki page or multi-KB transcript; running the full
/// chunk+embed+link pipeline on content that large compounds badly
/// with the vault watcher's re-ingest (which also fires on the
/// newly-written file). We reject anything larger with a clear
/// error telling the caller to chunk their content upstream. 32 KB
/// comfortably covers multi-paragraph insights; anything beyond is
/// almost always "I should have written multiple notes."
const REMEMBER_MAX_BYTES: usize = 32 * 1024;

async fn remember(
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
                if truncated.is_empty() { "Untitled".to_string() } else { truncated }
            });
        let seed = format!("# {}\n\n{}", title, content);

        // Dedupe short-circuit: compare the fully-formed note (what
        // would be written) against existing engrams. If a close
        // match exists, skip the write and return the match.
        if let Some(threshold) = dedupe {
            if let Some((matched_id, sim)) = ingest::dedupe_check(&db, &seed, threshold, None)? {
                return Ok(RememberResult {
                    status: "merged".to_string(),
                    engram_id: matched_id,
                    similarity: Some(sim),
                });
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
        Ok(RememberResult {
            status: write.status,
            engram_id: write.engram_id,
            similarity: None,
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
struct SaveBody {
    filename: String,
    content: String,
    #[serde(default)]
    brain: Option<String>,
}

#[derive(serde::Deserialize)]
struct DeleteBody {
    filename: String,
    #[serde(default)]
    brain: Option<String>,
}

#[derive(serde::Serialize)]
struct WriteResponse {
    status: String,
    engram_id: String,
    filename: String,
    brain_id: String,
}

async fn notes_save(
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

async fn notes_delete(
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
struct UpdateBody {
    #[serde(default)]
    brain: Option<String>,
}

#[derive(serde::Serialize)]
struct UpdateResult {
    brain_id: String,
    scanned: u32,
    ingested: u32,
    unchanged: u32,
    deleted: u32,
    elapsed_ms: u64,
}

fn collect_md_files(root: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
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

async fn update_brain(
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
            let mut stmt = conn
                .prepare("SELECT id, filename FROM engrams WHERE state != 'dormant'")?;
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
struct ClutterQuery {
    #[serde(default)]
    brain: Option<String>,
    #[serde(default)]
    limit: Option<u32>,
}

#[derive(serde::Serialize)]
struct ClutterEntry {
    id: String,
    title: String,
    reason: String,
}

#[derive(serde::Serialize)]
struct ClutterReport {
    brain_id: String,
    stubs: Vec<ClutterEntry>,
    test_data: Vec<ClutterEntry>,
    forgotten_observations: Vec<ClutterEntry>,
    duplicate_titles: Vec<ClutterEntry>,
    total: usize,
}

async fn clutter_report(
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

        let total = stubs.len() + test_data.len() + forgotten_observations.len() + duplicate_titles.len();
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
struct EngramsDeleteBody {
    engram_ids: Vec<String>,
    #[serde(default)]
    brain: Option<String>,
}

#[derive(serde::Serialize)]
struct EngramsDeleteResult {
    brain_id: String,
    deleted: u32,
    not_found: u32,
    failed: Vec<String>,
}

async fn engrams_delete(
    _s: State<ServerState>,
    Json(body): Json<EngramsDeleteBody>,
) -> Result<Json<EngramsDeleteResult>, ApiError> {
    let result = tokio::task::spawn_blocking(move || -> Result<EngramsDeleteResult, MemoryError> {
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
struct CompilePrepareBody {
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
struct CompileSourceItem {
    id: String,
    short_id: String,
    title: String,
    kind: String,
    content: String,
}

#[derive(serde::Serialize)]
struct CompileExistingWiki {
    id: String,
    content: String,
}

#[derive(serde::Serialize)]
struct CompilePreparePack {
    topic: String,
    brain_id: String,
    sources: Vec<CompileSourceItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    existing_wiki: Option<CompileExistingWiki>,
    schema: String,
}

async fn compile_prepare(
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
struct CompileSubmitBody {
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
struct CompileSubmitResult {
    compilation_id: String,
    wiki_engram_id: String,
    wiki_filename: String,
    brain_id: String,
    status: String,
}

async fn compile_submit(
    _s: State<ServerState>,
    Json(body): Json<CompileSubmitBody>,
) -> Result<Json<CompileSubmitResult>, ApiError> {
    if body.topic.trim().is_empty() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "topic is required".into()));
    }
    if body.wiki_markdown.trim().is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "wiki_markdown is required".into(),
        ));
    }
    let result = tokio::task::spawn_blocking(move || -> Result<CompileSubmitResult, MemoryError> {
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
        let sources_json = serde_json::to_string(&body.source_engram_ids)
            .map_err(MemoryError::Json)?;
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
struct CompilationSummary {
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
struct CompilationDetail {
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
struct CompilationsListQuery {
    status: Option<String>,
    limit: Option<i64>,
}

fn read_summary_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<CompilationSummary> {
    let changelog_json: String = r.get::<_, Option<String>>(8)?.unwrap_or_else(|| "[]".into());
    let sources_json: String = r.get::<_, Option<String>>(9)?.unwrap_or_else(|| "[]".into());
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

async fn compilations_list(
    Query(q): Query<CompilationsListQuery>,
    _s: State<ServerState>,
) -> Result<Json<Vec<CompilationSummary>>, ApiError> {
    let result = tokio::task::spawn_blocking(move || -> Result<Vec<CompilationSummary>, MemoryError> {
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

async fn compilations_pending(
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

async fn compilations_get(
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
            let changelog_json: String =
                r.get::<_, Option<String>>(8)?.unwrap_or_else(|| "[]".into());
            let sources_json: String =
                r.get::<_, Option<String>>(9)?.unwrap_or_else(|| "[]".into());
            let changelog = serde_json::from_str(&changelog_json)
                .unwrap_or(serde_json::Value::Array(vec![]));
            let sources = serde_json::from_str(&sources_json)
                .unwrap_or(serde_json::Value::Array(vec![]));
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
        MemoryError::Database(db_err) if matches!(db_err, rusqlite::Error::QueryReturnedNoRows) => {
            ApiError(StatusCode::NOT_FOUND, "compilation not found".into())
        }
        _ => ApiError::from(e),
    })?;
    Ok(Json(result))
}

#[derive(serde::Deserialize, Default)]
struct ReviewBody {
    #[serde(default)]
    review_comment: Option<String>,
}

#[derive(serde::Serialize)]
struct ReviewResult {
    status: String,
    id: String,
}

async fn compilations_approve(
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
        Ok(ReviewResult { status: "approved".to_string(), id })
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(result))
}

async fn compilations_reject(
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
        Ok(ReviewResult { status: "rejected".to_string(), id })
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
struct ClustersQuery {
    brain_id: Option<String>,
    /// When true, only return clusters that don't already have a name
    /// in cluster_names.json. Default true so the agent can run
    /// `/name-clusters` repeatedly without re-naming what was named
    /// already.
    only_unnamed: Option<bool>,
}

#[derive(serde::Serialize)]
struct ClusterListItem {
    id: u32,
    size: usize,
    top_titles: Vec<String>,
    sample_links: Vec<String>,
    /// Already-saved name, if any. Agent uses this to skip clusters
    /// the user has hand-edited.
    name: Option<String>,
}

#[derive(serde::Serialize)]
struct ClusterListResponse {
    clusters: Vec<ClusterListItem>,
    /// True when no Analytics-mode push has happened yet this session.
    /// Agents see this and tell the user "open the app and enable
    /// Analytics mode first."
    needs_analytics: bool,
}

async fn clusters_list(
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
        Ok(ClusterListResponse { clusters, needs_analytics })
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;

    Ok(Json(resp))
}

#[derive(serde::Deserialize)]
struct SetClusterNamesBody {
    /// Map from cluster id (string for JSON ergonomics) to user/agent
    /// label. Empty string clears that cluster's name.
    names: std::collections::HashMap<String, String>,
    brain_id: Option<String>,
}

#[derive(serde::Serialize)]
struct SetClusterNamesResponse {
    saved: usize,
    total_named: usize,
}

async fn clusters_set_names(
    _s: State<ServerState>,
    Json(body): Json<SetClusterNamesBody>,
) -> Result<Json<SetClusterNamesResponse>, ApiError> {
    let brain_id = body.brain_id.clone();
    let incoming_str = body.names;

    let resp = tokio::task::spawn_blocking(move || -> Result<SetClusterNamesResponse, MemoryError> {
        let id = resolve_brain_id(brain_id.as_deref())?;
        let mut parsed: std::collections::HashMap<u32, String> = std::collections::HashMap::new();
        let saved = incoming_str.len();
        for (k, v) in incoming_str {
            if let Ok(cid) = k.parse::<u32>() {
                parsed.insert(cid, v);
            }
        }
        let merged = super::cluster_state::merge_names(&id, parsed)
            .map_err(MemoryError::Other)?;
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
struct CreateBrainBody {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    vault_path: Option<String>,
}

#[derive(Serialize)]
struct CreateBrainResponse {
    id: String,
    name: String,
}

async fn brains_create(
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
        while brains_arr.iter().any(|b| b.get("id").and_then(|v| v.as_str()) == Some(&final_id)) {
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
        fs::write(&tmp, serde_json::to_string_pretty(&json).map_err(MemoryError::Json)?)
            .map_err(MemoryError::Io)?;
        std::fs::rename(&tmp, &registry_path).map_err(MemoryError::Io)?;

        let _db = open_brain(&final_id)?;
        Ok(CreateBrainResponse {
            id: final_id,
            name,
        })
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;

    Ok(Json(resp))
}

// --- POST /api/check_duplicate -------------------------------------------

#[derive(Deserialize)]
struct CheckDuplicateBody {
    content: String,
    #[serde(default = "default_dupe_threshold")]
    threshold: f64,
    brain: Option<String>,
}

fn default_dupe_threshold() -> f64 { 0.85 }

#[derive(Serialize)]
struct CheckDuplicateResponse {
    found: bool,
    engram_id: Option<String>,
    similarity: Option<f64>,
    title: Option<String>,
}

async fn check_duplicate(
    _s: State<ServerState>,
    Json(body): Json<CheckDuplicateBody>,
) -> Result<Json<CheckDuplicateResponse>, ApiError> {
    let resp = tokio::task::spawn_blocking(
        move || -> Result<CheckDuplicateResponse, MemoryError> {
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
        },
    )
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
struct RecallChunksQuery {
    q: String,
    #[serde(default = "default_chunks_limit")]
    limit: usize,
    brain: Option<String>,
}

fn default_chunks_limit() -> usize { 10 }

#[derive(Serialize)]
struct ChunkHit {
    engram_id: String,
    title: String,
    chunk_text: String,
    granularity: String,
    similarity: f64,
}

#[derive(Serialize)]
struct RecallChunksResponse {
    hits: Vec<ChunkHit>,
}

async fn recall_chunks(
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
                if rows.len() >= limit { break; }
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
struct SessionStartQuery {
    brain: Option<String>,
}

#[derive(Serialize)]
struct TopMemorySummary {
    engram_id: String,
    title: String,
    strength: f64,
    state: String,
    access_count: i64,
}

#[derive(Serialize)]
struct SessionStartResponse {
    brain: Option<BrainSummary>,
    stats: Option<BrainStats>,
    core_memory: Vec<CoreBlock>,
    top_memories: Vec<TopMemorySummary>,
    open_todos: Vec<Todo>,
}

async fn session_start(
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
        let open_todos = todos::list_todos(&id, Some("open")).unwrap_or_default();

        let db = open_brain(&id)?;
        let conn = db.lock();
        let mut stmt = conn.prepare(
            "SELECT id, title, strength, state, access_count \
             FROM engrams \
             WHERE state != 'dormant' \
             ORDER BY strength DESC, access_count DESC LIMIT 5",
        )?;
        let top = stmt
            .query_map([], |r| {
                Ok(TopMemorySummary {
                    engram_id: r.get(0)?,
                    title: r.get(1)?,
                    strength: r.get(2)?,
                    state: r.get(3)?,
                    access_count: r.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

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
struct ChangesQuery {
    since: Option<String>,
    brain: Option<String>,
    #[serde(default = "default_changes_limit")]
    limit: usize,
}

fn default_changes_limit() -> usize { 50 }

#[derive(Serialize)]
struct ChangeRow {
    engram_id: String,
    title: String,
    updated_at: String,
    state: String,
    kind: String,
}

#[derive(Serialize)]
struct ChangesResponse {
    changes: Vec<ChangeRow>,
}

async fn changes_feed(
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
            for row in it { rows.push(row?); }
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
            for row in it { rows.push(row?); }
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
struct CoreMemoryQuery {
    brain: Option<String>,
}

async fn core_memory_list(
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

async fn core_memory_read(
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
struct CoreMemorySetBody {
    value: String,
    brain: Option<String>,
}

async fn core_memory_set(
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
struct CoreMemoryAppendBody {
    text: String,
    brain: Option<String>,
}

async fn core_memory_append(
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
struct CoreMemoryReplaceBody {
    old: String,
    new: String,
    brain: Option<String>,
}

async fn core_memory_replace(
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
struct TodosListQuery {
    status: Option<String>,
    brain: Option<String>,
}

async fn todos_list(
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
struct TodosAddBody {
    text: String,
    agent_match: Option<String>,
    priority: Option<String>,
    created_by: Option<String>,
    note: Option<String>,
    brain: Option<String>,
}

async fn todos_add(
    _s: State<ServerState>,
    Json(body): Json<TodosAddBody>,
) -> Result<Json<Todo>, ApiError> {
    let result = tokio::task::spawn_blocking(move || -> Result<Todo, MemoryError> {
        let id = resolve_brain_id(body.brain.as_deref())?;
        todos::add_todo(&id, AddTodoArgs {
            text: body.text,
            agent_match: body.agent_match,
            priority: body.priority,
            created_by: body.created_by,
            note: body.note,
        })
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(result))
}

async fn todos_get(
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
struct TodosClaimBody {
    agent_id: String,
    brain: Option<String>,
}

async fn todos_claim(
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
struct TodosCompleteBody {
    brain: Option<String>,
}

async fn todos_complete(
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
