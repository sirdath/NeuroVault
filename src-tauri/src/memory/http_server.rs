//! Loopback HTTP server on 127.0.0.1:8765 — same port the Python
//! FastAPI sidecar used. Path + response shapes match what
//! `mcp_proxy.py` already sends. That's the contract: the MCP
//! proxy is the external-facing piece and doesn't need to know
//! which runtime answers.
//!
//! This module is the **trust-the-machine** path: zero auth,
//! permissive CORS, loopback bind only. The Tauri webview and
//! the local Python MCP proxy both talk to it. Anything
//! external-facing (auth, scopes, rate limits) lives in
//! `super::api_gateway` (the optional external API gateway),
//! which mounts the same handler functions with its own
//! middleware stack on a separate port.
//!
//! All endpoint logic lives in `super::handlers`. This file is
//! just the runtime + router-construction shell — kept narrow so
//! the loopback contract (port, paths, lack of auth) stays easy
//! to audit at a glance.

use std::net::SocketAddr;

use axum::routing::{get, post};
use axum::Router;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tower_http::cors::{AllowOrigin, Any, CorsLayer};

use super::handlers::*;

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
    let listener = match TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            // Self-heal: if a stale neurovault* process is still
            // holding the port, kill it and retry once. Anything
            // else (a foreign process, kernel-held socket) is left
            // alone and surfaces as a clear error.
            if super::port_recovery::try_clear_stale_neurovault(port).is_some() {
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                TcpListener::bind(addr)
                    .await
                    .map_err(|e2| format!("could not bind {} after clearing stale: {}", addr, e2))?
            } else {
                return Err(format!(
                    "could not bind {}: {} (port held by another process — \
                     check what's listening with `netstat -ano | findstr :{}`)",
                    addr, e, port,
                ));
            }
        }
        Err(e) => return Err(format!("could not bind {}: {}", addr, e)),
    };

    // The AI Employees feature is excluded from the public base build, so its
    // background scheduler is NOT started here (nothing wakes employees). The
    // employee module + loopback routes stay compiled but inert. Re-enable
    // this alongside the employee UI (App.tsx EMPLOYEES_ENABLED) for a future
    // build.
    // super::employee::start_scheduler();

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
/// it in-process without binding to a real port. Mounts every
/// handler from `super::handlers` under its `/api/*` path.
fn router() -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/version", get(version))
        .route("/api/status", get(status))
        .route("/api/brains", get(brains_list))
        .route("/api/brains/active", get(brains_active))
        .route("/api/brains/:brain_id/activate", post(brains_activate))
        .route("/api/brains/:brain_id/stats", get(brains_stats))
        .route("/api/brains/:brain_id/reset", post(brains_reset))
        .route(
            "/api/brains/:brain_id/sources",
            get(brain_sources_list).put(brain_sources_set),
        )
        .route(
            "/api/brains/:brain_id/sources/sync",
            post(brain_sources_sync),
        )
        .route(
            "/api/brains/:brain_id/sources/preview",
            get(brain_sources_preview),
        )
        .route("/api/observations", post(observations))
        .route("/api/audit/recent", get(audit_recent))
        .route("/api/notes", get(notes_list))
        .route("/api/notes/:engram_id", get(notes_detail))
        .route("/api/graph", get(graph))
        .route("/api/recall", get(recall))
        .route("/api/query_signal", get(query_signal))
        .route("/api/recall/multi", post(recall_multi))
        .route("/api/recall_across_brains", get(recall_across_brains))
        .route("/api/recall/chunks", get(recall_chunks))
        .route("/api/facts", post(record_fact))
        .route("/api/facts", get(facts_list))
        .route("/api/consolidate", get(consolidate_queue))
        .route("/api/related/:engram_id", get(related))
        .route("/api/code/graphify", post(code_graphify))
        .route("/api/code/where_defined", get(code_where_defined))
        .route("/api/code/who_calls", get(code_who_calls))
        .route("/api/code/whats_in_file", get(code_whats_in_file))
        .route("/api/code/blast_radius", get(code_blast_radius))
        .route("/api/code/fuse", post(code_fuse))
        .route("/api/notes", post(remember))
        .route("/api/notes", axum::routing::put(notes_save))
        .route("/api/notes", axum::routing::delete(notes_delete))
        .route("/api/notes/supersede", post(notes_supersede))
        .route("/api/update", post(update_brain))
        .route("/api/diagnostic", get(diagnostic_get))
        .route("/api/conflicts", get(conflicts_find))
        .route("/api/inbox", get(inbox_list))
        .route("/api/inbox/file", get(inbox_read))
        .route("/api/inbox/done", post(inbox_done))
        .route("/api/import_folder", post(import_folder))
        .route("/api/reindex_embeddings", post(reindex_embeddings))
        .route("/api/rebuild_wikilinks", post(rebuild_wikilinks))
        .route("/api/list_images", get(list_images))
        .route("/api/clutter", get(clutter_report))
        .route("/api/engrams/delete", post(engrams_delete))
        .route("/api/engrams/bulk_set_kind", post(bulk_set_kind))
        .route("/api/engrams/bulk_add_tag", post(bulk_add_tag))
        .route(
            "/api/engrams/:engram_id/versions",
            get(engram_versions_list),
        )
        .route(
            "/api/engrams/:engram_id/versions/:version",
            get(engram_version_get),
        )
        .route("/api/contradictions", get(contradictions_list))
        .route(
            "/api/contradictions/:id/resolve",
            post(contradictions_resolve),
        )
        .route("/api/links", post(links_add))
        .route("/api/links", axum::routing::delete(links_remove))
        .route("/api/orphan_links", get(orphan_links))
        .route("/api/temporal_recall", get(temporal_recall))
        .route("/api/optimize_disk", post(optimize_disk))
        .route("/api/mcp_tier", get(mcp_tier_get).put(mcp_tier_set))
        .route("/api/rerank", get(rerank_get).put(rerank_set))
        // The Curator (AI employee): loopback-only, like everything here.
        .route(
            "/api/employee/status",
            get(super::employee::employee_status),
        )
        .route(
            "/api/employee/config",
            axum::routing::put(super::employee::employee_config),
        )
        .route("/api/employee/run", post(super::employee::employee_run))
        .route("/api/employee/stop", post(super::employee::employee_stop))
        .route("/api/employee/tick", post(super::employee::employee_tick))
        .route(
            "/api/employee/activity",
            get(super::employee::employee_activity),
        )
        .route("/api/employee/runs", get(super::employee::employee_runs))
        .route(
            "/api/employee/proposals",
            get(super::employee::employee_proposals),
        )
        .route(
            "/api/employee/proposals/:id/approve",
            post(super::employee::employee_proposal_approve),
        )
        .route(
            "/api/employee/proposals/:id/reject",
            post(super::employee::employee_proposal_reject),
        )
        .route(
            "/api/employee/meetings",
            get(super::employee::employee_meetings),
        )
        // The fleet: roster of hireable AI employees (the Curator + the
        // rest of the catalog). Legacy /api/employee/* above is the
        // Curator's alias; these are the per-employee routes the "+"
        // hire menu and Employee Manager consume.
        .route(
            "/api/employees",
            get(super::employee::employees_index).post(super::employee::employees_hire),
        )
        .route(
            "/api/employees/:id",
            axum::routing::delete(super::employee::employees_fire),
        )
        .route(
            "/api/employees/:id/status",
            get(super::employee::employees_status),
        )
        .route(
            "/api/employees/:id/config",
            axum::routing::put(super::employee::employees_config),
        )
        .route(
            "/api/employees/:id/tick",
            post(super::employee::employees_tick),
        )
        .route(
            "/api/employees/:id/run",
            post(super::employee::employees_run),
        )
        .route(
            "/api/employees/:id/stop",
            post(super::employee::employees_stop),
        )
        .route(
            "/api/employees/:id/activity",
            get(super::employee::employees_activity),
        )
        .route(
            "/api/employees/:id/runs",
            get(super::employee::employees_runs),
        )
        .route(
            "/api/employees/:id/proposals",
            get(super::employee::employees_proposals),
        )
        .route(
            "/api/employees/:id/proposals/:pid/approve",
            post(super::employee::employees_proposal_approve),
        )
        .route(
            "/api/employees/:id/proposals/:pid/reject",
            post(super::employee::employees_proposal_reject),
        )
        .route(
            "/api/employees/:id/meetings",
            get(super::employee::employees_meetings),
        )
        // API key management — loopback-mounted ONLY. The gateway
        // does NOT mount these (deliberate: external clients must
        // not manage their own keys).
        .route("/api/api_keys", get(api_keys_list).post(api_keys_create))
        .route("/api/api_keys/:id", axum::routing::delete(api_keys_revoke))
        .route(
            "/api/api_gateway_config",
            get(api_gateway_config_get).put(api_gateway_config_set),
        )
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
        .route(
            "/api/core_memory/:label",
            axum::routing::put(core_memory_set),
        )
        .route("/api/core_memory/:label/append", post(core_memory_append))
        .route("/api/core_memory/:label/replace", post(core_memory_replace))
        .route("/api/todos", get(todos_list))
        .route("/api/todos", post(todos_add))
        .route("/api/todos/:id", get(todos_get))
        .route("/api/todos/:id/claim", post(todos_claim))
        .route("/api/todos/:id/complete", post(todos_complete))
        .route("/api/handoff", post(handoff))
        .route("/api/agent_inbox", get(agent_inbox))
        .route("/api/clusters", get(clusters_list))
        .route("/api/clusters/names", post(clusters_set_names))
        // CORS. The server binds to 127.0.0.1 only, but "loopback-only" is
        // NOT the same as "safe": a malicious page in the user's browser can
        // still `fetch('http://127.0.0.1:8765/...')`, and DNS-rebinding can
        // spoof the Host. The Origin is the axis that actually protects a
        // brain's contents — so we only emit `Access-Control-Allow-Origin`
        // for the surfaces NeuroVault ships:
        //   - Tauri webview: tauri://localhost (macOS),
        //     https://tauri.localhost (Windows), http://tauri.localhost (Linux)
        //   - Vite dev server: http://localhost:1420
        //   - VS Code extension webview: vscode-webview://<dynamic-id>
        // An arbitrary web origin gets no ACAO header and so can't read a
        // response. Non-browser clients (the MCP forwarder, curl, agents you
        // build) send no Origin and bypass CORS entirely — unaffected.
        // Methods/headers stay permissive; the origin is what matters.
        .layer(
            CorsLayer::new()
                .allow_origin(AllowOrigin::predicate(|origin, _req| {
                    let o = origin.as_bytes();
                    o == b"tauri://localhost"
                        || o == b"https://tauri.localhost"
                        || o == b"http://tauri.localhost"
                        || o == b"http://localhost:1420"
                        || o.starts_with(b"vscode-webview://")
                }))
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(ServerState {})
}
