//! External API gateway — sibling to `super::http_server`.
//!
//! Per `docs/api-gateway-design.md`. The boundary contract:
//!
//!   • Loopback path (`http_server`) is **untouched** — same port,
//!     same routes, same zero-auth trust model.
//!   • This gateway runs on a separate port, bind configurable,
//!     bearer auth required for every request, scope check per
//!     route, audit log per call.
//!   • Both routers call the same `super::handlers::*` functions.
//!
//! Phase 3 ship: scaffold + auth middleware + a single `/v1/status`
//! endpoint to smoke-test end-to-end. Phases 4-6 add the rest of
//! the read/write/admin surface.
//!
//! The gateway is **default off**. `start_gateway` only fires when
//! the user explicitly enables it via Settings (Phase 8) or the
//! `NEUROVAULT_API_GATEWAY=1` env var (developer override for
//! testing without UI plumbing).

use std::net::SocketAddr;

use axum::extract::{MatchedPath, Request, State};
use axum::http::{HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use axum::Router;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tower_http::cors::{Any, CorsLayer};

use super::api_keys::{self, AuthedKey, Scope};
use super::handlers;

// ---------------------------------------------------------------------------
// Defaults — separate port from the loopback server (8765) so the
// two can run side-by-side without colliding. User can override via
// the gateway config file once Phase 8 lands the Settings UI.
// ---------------------------------------------------------------------------

pub const DEFAULT_GATEWAY_PORT: u16 = 8767;

// ---------------------------------------------------------------------------
// Lifecycle handle. Mirrors the loopback ServerHandle so the call
// site (lib.rs / Tauri main / future neurovault-api binary) can
// stop the gateway the same way it stops the loopback server.
// ---------------------------------------------------------------------------

pub struct GatewayHandle {
    pub addr: SocketAddr,
    shutdown: Option<oneshot::Sender<()>>,
    join: Option<tokio::task::JoinHandle<()>>,
}

impl GatewayHandle {
    pub async fn stop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(join) = self.join.take() {
            let _ = join.await;
        }
    }
}

// ---------------------------------------------------------------------------
// Bind + lifecycle. `start_gateway` opts the user in explicitly —
// no surprise network exposure. Caller chooses bind addr + port.
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct GatewayConfig {
    pub bind: std::net::IpAddr,
    pub port: u16,
}

impl Default for GatewayConfig {
    fn default() -> Self {
        Self {
            // Default bind: loopback only, even when explicitly
            // started. Flipping to 0.0.0.0 is a deliberate choice
            // the user makes in Settings (Phase 8) with a warning.
            bind: std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
            port: DEFAULT_GATEWAY_PORT,
        }
    }
}

pub async fn start_gateway(cfg: GatewayConfig) -> Result<GatewayHandle, String> {
    let addr = SocketAddr::new(cfg.bind, cfg.port);

    let app = router();
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|e| format!("could not bind {}: {}", addr, e))?;

    let bound = listener.local_addr().unwrap_or(addr);
    let (tx, rx) = oneshot::channel::<()>();
    let join = tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = rx.await;
            })
            .await;
    });

    eprintln!("[api_gateway] listening on {} (bearer auth required)", bound);
    Ok(GatewayHandle {
        addr: bound,
        shutdown: Some(tx),
        join: Some(join),
    })
}

// ---------------------------------------------------------------------------
// Router. Phase 4 mounts the read endpoints from super::handlers.
// Per-route scope requirements live in `required_scope_for` below;
// the scope-check middleware reads the matched path and rejects
// requests whose AuthedKey doesn't satisfy the requirement.
// ---------------------------------------------------------------------------

fn router() -> Router {
    Router::new()
        // Phase 3 — gateway smoke endpoint, any active key
        .route("/v1/status", get(v1_status))
        // Phase 4 — READ endpoints. Mirror super::http_server's
        // mounts but under /v1/ and with auth + scope middleware
        // applied below.
        .route("/v1/recall", get(handlers::recall))
        .route("/v1/recall/chunks", get(handlers::recall_chunks))
        .route("/v1/recall_across_brains", get(handlers::recall_across_brains))
        .route("/v1/related/:engram_id", get(handlers::related))
        .route("/v1/notes", get(handlers::notes_list))
        .route("/v1/notes/:engram_id", get(handlers::notes_detail))
        .route("/v1/notes/:engram_id/versions", get(handlers::engram_versions_list))
        .route("/v1/notes/:engram_id/versions/:version", get(handlers::engram_version_get))
        .route("/v1/temporal_recall", get(handlers::temporal_recall))
        .route("/v1/contradictions", get(handlers::contradictions_list))
        .route("/v1/orphan_links", get(handlers::orphan_links))
        .route("/v1/clutter", get(handlers::clutter_report))
        .route("/v1/list_images", get(handlers::list_images))
        .route("/v1/brains", get(handlers::brains_list))
        .route("/v1/brains/:brain_id/stats", get(handlers::brains_stats))
        .route("/v1/session_start", get(handlers::session_start))
        .route("/v1/changes", get(handlers::changes_feed))
        .route("/v1/core_memory", get(handlers::core_memory_list))
        .route("/v1/core_memory/:label", get(handlers::core_memory_read))
        // POST that's still read-scope: dedupe check is a query, not
        // a write — body just carries the candidate content.
        .route("/v1/check_duplicate", post(handlers::check_duplicate))
        // Phase 5 — WRITE endpoints. Same handlers as the loopback
        // path, mounted under /v1/. Scope: write (which implies
        // read via Scope::satisfies).
        .route("/v1/notes", post(handlers::remember))
        .route("/v1/notes", axum::routing::put(handlers::notes_save))
        .route("/v1/notes", axum::routing::delete(handlers::notes_delete))
        .route("/v1/engrams/delete", post(handlers::engrams_delete))
        .route("/v1/engrams/bulk_set_kind", post(handlers::bulk_set_kind))
        .route("/v1/engrams/bulk_add_tag", post(handlers::bulk_add_tag))
        .route("/v1/contradictions/:id/resolve", post(handlers::contradictions_resolve))
        .route("/v1/links", post(handlers::links_add))
        .route("/v1/links", axum::routing::delete(handlers::links_remove))
        .route("/v1/import_folder", post(handlers::import_folder))
        .route("/v1/update", post(handlers::update_brain))
        .route("/v1/core_memory/:label", axum::routing::put(handlers::core_memory_set))
        .route("/v1/core_memory/:label/append", post(handlers::core_memory_append))
        .route("/v1/core_memory/:label/replace", post(handlers::core_memory_replace))
        // Auth runs FIRST (outermost), then scope check. Both fire
        // before any handler. Order matters: scope_middleware reads
        // the AuthedKey that auth_middleware just inserted.
        .layer(middleware::from_fn(scope_middleware))
        .layer(middleware::from_fn(brain_allowlist_middleware))
        .layer(middleware::from_fn(auth_middleware))
        // CORS: permissive — auth is mandatory regardless of origin,
        // so the bearer header is the gate, not the page. Tighten
        // per-key in a future iteration if needed.
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(handlers::ServerState {})
}

// ---------------------------------------------------------------------------
// Auth middleware — extract Bearer, look up key, attach AuthedKey
// to request extensions. Reject malformed / missing / unknown /
// revoked with 401.
//
// Per-route scope checks happen DOWNSTREAM of this — handlers (or
// route-specific layers) read AuthedKey from extensions and decide.
// Phase 3 ships only /v1/status which any active key may call;
// Phase 4+ adds per-route scope enforcement.
// ---------------------------------------------------------------------------

async fn auth_middleware(mut req: Request, next: Next) -> Response {
    let bearer = match req.headers().get(axum::http::header::AUTHORIZATION) {
        Some(v) => match v.to_str() {
            Ok(s) => s,
            Err(_) => return unauthorized("malformed_authorization", "Authorization header is not valid UTF-8"),
        },
        None => return unauthorized("missing_authorization", "Authorization header required"),
    };
    let Some(token) = bearer.strip_prefix("Bearer ") else {
        return unauthorized(
            "invalid_scheme",
            "Authorization scheme must be Bearer",
        );
    };
    let Some(key) = api_keys::authenticate(token.trim()) else {
        return unauthorized("invalid_key", "API key not recognised or revoked");
    };

    req.extensions_mut().insert(key);
    next.run(req).await
}

// ---------------------------------------------------------------------------
// Scope check — runs AFTER auth_middleware, so AuthedKey is
// guaranteed present. Reads the matched route's RequiredScope from
// the static table; rejects with 403 if the key's scope is too low.
//
// The matched-path lookup is what makes this O(1) per request even
// as the route table grows. Path-templates (e.g. /v1/notes/:id)
// resolve to their template string, not the concrete URL.
// ---------------------------------------------------------------------------

/// Look up the required scope for a (method, path) pair. Path is the
/// matched route template (e.g. "/v1/notes/:engram_id"), method is
/// the HTTP verb. Method-aware because the same path serves
/// different scopes at different verbs — GET /v1/notes is read,
/// POST /v1/notes is write, DELETE /v1/notes is write.
///
/// Returns None when no policy is registered. The middleware fails
/// closed on None — refuse rather than accidentally allow.
fn required_scope_for(method: &axum::http::Method, path: &str) -> Option<Scope> {
    use axum::http::Method;
    // Read scope — GET endpoints + the one POST that's a query
    // (check_duplicate returns whether content matches existing
    // engrams; reads no permanent state).
    if method == Method::GET {
        if matches!(
            path,
            "/v1/status"
                | "/v1/recall"
                | "/v1/recall/chunks"
                | "/v1/recall_across_brains"
                | "/v1/related/:engram_id"
                | "/v1/notes"
                | "/v1/notes/:engram_id"
                | "/v1/notes/:engram_id/versions"
                | "/v1/notes/:engram_id/versions/:version"
                | "/v1/temporal_recall"
                | "/v1/contradictions"
                | "/v1/orphan_links"
                | "/v1/clutter"
                | "/v1/list_images"
                | "/v1/brains"
                | "/v1/brains/:brain_id/stats"
                | "/v1/session_start"
                | "/v1/changes"
                | "/v1/core_memory"
                | "/v1/core_memory/:label"
        ) {
            return Some(Scope::Read);
        }
    }
    if method == Method::POST && path == "/v1/check_duplicate" {
        return Some(Scope::Read);
    }
    // Write scope — mutating endpoints. POST/PUT/DELETE on
    // engram-affecting paths.
    let is_write_method = matches!(*method, Method::POST | Method::PUT | Method::DELETE);
    if is_write_method
        && matches!(
            path,
            "/v1/notes"
                | "/v1/engrams/delete"
                | "/v1/engrams/bulk_set_kind"
                | "/v1/engrams/bulk_add_tag"
                | "/v1/contradictions/:id/resolve"
                | "/v1/links"
                | "/v1/import_folder"
                | "/v1/update"
                | "/v1/core_memory/:label"
                | "/v1/core_memory/:label/append"
                | "/v1/core_memory/:label/replace"
        )
    {
        return Some(Scope::Write);
    }
    None
}

async fn scope_middleware(req: Request, next: Next) -> Response {
    // Phase 3's /v1/status was inside the auth gate but had no scope
    // table entry — it accepted any active key. Now we treat it as
    // Read scope explicitly so the table is exhaustive.
    let path = req
        .extensions()
        .get::<MatchedPath>()
        .map(|m| m.as_str().to_string());
    let Some(path) = path else {
        // Unmatched route — let axum's 404 handler deal with it
        // rather than 403. We don't want auth-aware error leakage.
        return next.run(req).await;
    };
    let method = req.method().clone();
    let Some(required) = required_scope_for(&method, &path) else {
        // Route exists in the router but no scope policy declared.
        // Fail closed: refuse rather than accidentally exposing.
        return forbidden(
            "no_scope_policy",
            "no scope policy registered for this route",
        );
    };
    let Some(key) = req.extensions().get::<AuthedKey>() else {
        // auth_middleware should have populated this. Belt-and-
        // braces fallback so a misordered layer stack can't bypass.
        return unauthorized(
            "auth_missing",
            "auth middleware did not run before scope check",
        );
    };
    if !key.scope.satisfies(required) {
        return forbidden(
            "insufficient_scope",
            &format!(
                "this key has {:?} scope; {:?} requires {:?}",
                key.scope, path, required
            ),
        );
    }
    next.run(req).await
}

// ---------------------------------------------------------------------------
// Brain allowlist — reads ?brain= from the query string and rejects
// if the AuthedKey's allowlist excludes it. Empty allowlist means
// all brains permitted; that's the default for new keys.
//
// Path-param brains (e.g. /v1/brains/:brain_id/stats) are NOT
// covered here — those need per-route extraction. For Phase 4 the
// only path-param brain endpoint is /v1/brains/:brain_id/stats; we
// guard it with an inline check there as a follow-up if needed.
// ---------------------------------------------------------------------------

async fn brain_allowlist_middleware(req: Request, next: Next) -> Response {
    // Only inspect ?brain= when present. No brain param = no
    // restriction to enforce here (the handler may default to the
    // active brain, which is a separate concern).
    let query = req.uri().query().unwrap_or("");
    let brain_id = query
        .split('&')
        .filter_map(|kv| kv.split_once('='))
        .find(|(k, _)| *k == "brain")
        .map(|(_, v)| urlencoding_decode(v));
    let Some(brain_id) = brain_id else {
        return next.run(req).await;
    };
    let Some(key) = req.extensions().get::<AuthedKey>() else {
        return next.run(req).await; // auth_middleware will handle this
    };
    if !key.may_use_brain(&brain_id) {
        return forbidden(
            "brain_not_allowed",
            &format!(
                "this key's allowlist does not include brain {:?}",
                brain_id,
            ),
        );
    }
    next.run(req).await
}

/// Minimal `+`-and-`%XX` decoder. We only need it for the `brain`
/// query value, which in practice is a UUID-style id with no
/// percent-escaping. Keeps us from pulling in `urlencoding` or
/// `serde_urlencoded` as a direct dep.
fn urlencoding_decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'+' {
            out.push(' ');
            i += 1;
        } else if b == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            match (hi, lo) {
                (Some(h), Some(l)) => {
                    out.push(((h * 16 + l) as u8) as char);
                    i += 3;
                }
                _ => {
                    out.push(b as char);
                    i += 1;
                }
            }
        } else {
            out.push(b as char);
            i += 1;
        }
    }
    out
}

fn forbidden(error: &'static str, message: &str) -> Response {
    let body = serde_json::json!({
        "error": error,
        "message": message,
    });
    (StatusCode::FORBIDDEN, Json(body)).into_response()
}

fn unauthorized(error: &'static str, message: &str) -> Response {
    let body = serde_json::json!({
        "error": error,
        "message": message,
    });
    let mut resp = (StatusCode::UNAUTHORIZED, Json(body)).into_response();
    // RFC 6750 — clients learn how to authenticate from this header.
    resp.headers_mut().insert(
        axum::http::header::WWW_AUTHENTICATE,
        HeaderValue::from_static("Bearer realm=\"neurovault\""),
    );
    resp
}

// ---------------------------------------------------------------------------
// /v1/status — smoke endpoint. Returns the AuthedKey id + scope so
// the client can confirm the auth path works end-to-end. No data
// from the brain leaks here; just "yes, your key was accepted."
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
struct V1StatusResponse {
    service: &'static str,
    version: &'static str,
    authenticated_as: AuthInfo,
}

#[derive(serde::Serialize)]
struct AuthInfo {
    key_id: String,
    scope: Scope,
    brain_allowlist: Vec<String>,
}

async fn v1_status(
    _state: State<handlers::ServerState>,
    req: Request,
) -> Json<V1StatusResponse> {
    // Auth middleware guarantees this is present.
    let key = req
        .extensions()
        .get::<AuthedKey>()
        .cloned()
        .expect("auth_middleware should have inserted AuthedKey");
    Json(V1StatusResponse {
        service: "neurovault-api-gateway",
        version: env!("CARGO_PKG_VERSION"),
        authenticated_as: AuthInfo {
            key_id: key.id,
            scope: key.scope,
            brain_allowlist: key.brain_allowlist,
        },
    })
}
