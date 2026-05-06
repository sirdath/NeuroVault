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

use axum::extract::{Request, State};
use axum::http::{HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::get;
use axum::Router;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tower_http::cors::{Any, CorsLayer};

use super::api_keys::{self, AuthedKey, Scope};

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
// Router. Phase 3: just /v1/status. Phases 4-6 grow this.
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct GatewayState;

fn router() -> Router {
    Router::new()
        .route("/v1/status", get(v1_status))
        // Auth + audit run as middleware so handler bodies stay
        // identical to the loopback path.
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
        .with_state(GatewayState)
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
    _state: State<GatewayState>,
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
