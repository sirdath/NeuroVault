//! HTTP forwarder: turns an MCP tool call into a request against the
//! running app's `/api/*` surface on `127.0.0.1:8765` and returns the
//! parsed JSON. This is a thin shim — it loads no model and opens no
//! database; all intelligence lives in the app it forwards to.
//!
//! Faithful to `mcp_proxy.py`'s contract:
//!   * `NEUROVAULT_API_URL` overrides the base (trailing slash stripped);
//!     `NEUROVAULT_PROXY_TIMEOUT` overrides the 30s timeout.
//!   * FastMCP injects signature defaults for omitted args — we replicate
//!     that with `apply_defaults` from the tool's input schema, so the
//!     backend sees the same params the Python proxy sent.
//!   * GET: drop `None` params, stringify bools to `"true"`/`"false"`.
//!   * POST/PUT/DELETE: JSON body, conditional inclusion per `omit` rule.
//!   * Connection failure → the structured "sidecar is not running" dict
//!     (so the MCP handshake still completes and the agent sees a legible
//!     error). HTTP 4xx/5xx bodies are tunnelled through unchanged.

use std::time::Duration;

use serde_json::{json, Map, Value};

use super::registry::{CallSpec, ParamSpec, ToolDef};

const DEFAULT_BASE: &str = "http://127.0.0.1:8765";
const DEFAULT_TIMEOUT_SECS: f64 = 30.0;

pub struct Forwarder {
    client: reqwest::Client,
    base: String,
    /// When set (opt-in per-folder brain), this brain id is injected as the
    /// default `brain` on every tool call that accepts one and didn't get an
    /// explicit brain from the agent — so a session is scoped to its project
    /// brain without touching the global active brain.
    session_brain: Option<String>,
}

/// Resolve the backend base URL: `NEUROVAULT_API_URL` (trailing slash
/// stripped) or the default loopback `http://127.0.0.1:8765`.
pub fn resolve_base() -> String {
    std::env::var("NEUROVAULT_API_URL")
        .ok()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_BASE.to_string())
}

/// Quick liveness probe: is a NeuroVault backend answering on `base`?
pub async fn backend_healthy(base: &str) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    else {
        return false;
    };
    matches!(
        client.get(format!("{base}/api/health")).send().await,
        Ok(r) if r.status().is_success()
    )
}

/// Idempotently ensure a brain named `name` exists, returning its id.
/// Looks up an existing brain by name first (so we don't create
/// `project`, `project-2`, `project-3`, … across sessions), then creates
/// it if absent. Returns `None` if the backend is unreachable.
pub async fn ensure_brain(base: &str, name: &str) -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .pool_max_idle_per_host(0)
        .build()
        .ok()?;

    // 1) Existing brain with this name?
    if let Ok(resp) = client.get(format!("{base}/api/brains")).send().await {
        if let Ok(Value::Array(arr)) = resp.json::<Value>().await {
            for b in &arr {
                if b.get("name").and_then(|v| v.as_str()) == Some(name) {
                    if let Some(id) = b.get("id").and_then(|v| v.as_str()) {
                        return Some(id.to_string());
                    }
                }
            }
        }
    }

    // 2) Create it.
    if let Ok(resp) = client
        .post(format!("{base}/api/brains"))
        .json(&json!({ "name": name }))
        .send()
        .await
    {
        if let Ok(v) = resp.json::<Value>().await {
            if let Some(id) = v.get("id").and_then(|val| val.as_str()) {
                return Some(id.to_string());
            }
        }
    }
    None
}

impl Forwarder {
    pub fn new(session_brain: Option<String>) -> Self {
        let base = resolve_base();

        let timeout = std::env::var("NEUROVAULT_PROXY_TIMEOUT")
            .ok()
            .and_then(|s| s.trim().parse::<f64>().ok())
            .filter(|v| *v > 0.0)
            .unwrap_or(DEFAULT_TIMEOUT_SECS);

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs_f64(timeout))
            // Disable idle-connection pooling. We forward to a loopback
            // server where opening a connection is essentially free, and a
            // pooled keep-alive connection that the server has since closed
            // can make the *next* forwarded request hang until the timeout
            // fires — an intermittent multi-second stall observed on the
            // multi-query recall path (visible only through this client, never
            // via a fresh-connection-per-call tool like curl). A new
            // connection per request removes that failure mode entirely.
            .pool_max_idle_per_host(0)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        Self { client, base, session_brain }
    }

    /// Forward one tool call. Always returns a JSON `Value` — backend
    /// errors and "app not running" both come back as structured JSON
    /// rather than failing the MCP call.
    pub async fn call(&self, tool: &ToolDef, args: &Map<String, Value>) -> Value {
        let mut a = args.clone();
        apply_defaults(&mut a, &tool.input_schema);

        // Per-folder brain scoping: default `brain` to the session brain for
        // tools that accept one, unless the agent named a brain explicitly.
        if let Some(sb) = &self.session_brain {
            let accepts_brain = tool
                .input_schema
                .get("properties")
                .and_then(|p| p.as_object())
                .map(|p| p.contains_key("brain"))
                .unwrap_or(false);
            let has_brain = a.get("brain").map(|v| !v.is_null()).unwrap_or(false);
            if accepts_brain && !has_brain {
                a.insert("brain".to_string(), Value::String(sb.clone()));
            }
        }

        match tool.call.special.as_deref() {
            Some("recall") => self.special_recall(&a).await,
            Some("remember_image") => self.special_remember_image(&a).await,
            Some("engram_history") => self.special_engram_history(&a).await,
            Some("core_memory_read") => self.special_core_memory_read(&a).await,
            // The extractor used the kebab form "compile-submit"; accept both.
            Some("compile-submit") | Some("compile_submit") => self.special_compile_submit(&a).await,
            _ => self.generic(&tool.call, &a).await,
        }
    }

    // --- generic forward -------------------------------------------------

    async fn generic(&self, spec: &CallSpec, args: &Map<String, Value>) -> Value {
        let path = subst_path(&spec.path, &spec.path_params, args);
        let method = spec.method.to_ascii_uppercase();
        if method == "GET" {
            self.get(&path, build_query(&spec.query, args)).await
        } else {
            self.send(&method, &path, build_body(&spec.body, args)).await
        }
    }

    // --- HTTP primitives -------------------------------------------------

    async fn get(&self, path: &str, query: Vec<(String, String)>) -> Value {
        let url = format!("{}{}", self.base, path);
        match self.client.get(&url).query(&query).send().await {
            Ok(resp) => read_response(resp).await,
            Err(e) => sidecar_down(&e),
        }
    }

    async fn send(&self, method: &str, path: &str, body: Value) -> Value {
        let url = format!("{}{}", self.base, path);
        let m = reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::POST);
        match self.client.request(m, &url).json(&body).send().await {
            Ok(resp) => read_response(resp).await,
            Err(e) => sidecar_down(&e),
        }
    }

    // --- specials (1:1 with mcp_proxy.py) --------------------------------

    /// `recall`: GET /api/recall normally; if `additional_queries` has any
    /// non-blank entry, POST /api/recall/multi instead (brain→brain_id,
    /// bools as raw JSON, mode/agent_id dropped, extras capped at 4).
    async fn special_recall(&self, args: &Map<String, Value>) -> Value {
        let query = args.get("query").cloned().unwrap_or(Value::Null);
        let extras: Vec<Value> = args
            .get("additional_queries")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter(|q| q.as_str().map(|s| !s.trim().is_empty()).unwrap_or(false))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();

        if !extras.is_empty() {
            let extras4: Vec<Value> = extras.into_iter().take(4).collect();
            let body = json!({
                "q": query,
                "additional_queries": extras4,
                "limit": args.get("limit").cloned().unwrap_or(json!(20)),
                "brain_id": args.get("brain").cloned().unwrap_or(Value::Null),
                "include_observations": args.get("include_observations").cloned().unwrap_or(json!(false)),
                "rerank": args.get("rerank").cloned().unwrap_or(json!(false)),
                "spread_hops": args.get("spread_hops").cloned().unwrap_or(json!(0)),
                "as_of": args.get("as_of").cloned().unwrap_or(Value::Null),
            });
            return self.send("POST", "/api/recall/multi", body).await;
        }

        let mut q: Vec<(String, String)> = Vec::new();
        q.push(("q".into(), plain_string(&query)));
        push_if_present(&mut q, "mode", args.get("mode"), Transform::None);
        push_if_present(&mut q, "limit", args.get("limit"), Transform::None);
        push_if_truthy_none(&mut q, "brain", args.get("brain"));
        push_if_truthy_none(&mut q, "agent_id", args.get("agent_id"));
        q.push((
            "include_observations".into(),
            bool_str(args.get("include_observations").unwrap_or(&json!(false))),
        ));
        q.push(("rerank".into(), bool_str(args.get("rerank").unwrap_or(&json!(false)))));
        push_if_present(&mut q, "spread_hops", args.get("spread_hops"), Transform::None);
        push_if_truthy_none(&mut q, "as_of", args.get("as_of"));
        self.get("/api/recall", q).await
    }

    /// `remember_image`: write the caption as a note, then best-effort
    /// stamp kind=source + tag=image, then inject `image_path` back.
    async fn special_remember_image(&self, args: &Map<String, Value>) -> Value {
        let image_path = str_arg(args, "image_path");
        let caption = str_arg(args, "caption");
        let title = str_arg(args, "title");
        let title = title.trim();

        let basename = image_path
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(&image_path)
            .to_string();
        let stem = basename
            .rsplit_once('.')
            .map(|(s, _)| s.to_string())
            .unwrap_or_else(|| basename.clone());
        let display_title = if title.is_empty() { stem } else { title.to_string() };
        let content = format!("![{}]({})\n\n{}", display_title, image_path, caption);
        let brain = args.get("brain").cloned().unwrap_or(Value::Null);

        let mut written = self
            .send(
                "POST",
                "/api/notes",
                json!({
                    "content": content,
                    "title": display_title,
                    "folder": "images",
                    "deduplicate": 0.92,
                    "brain": brain.clone(),
                }),
            )
            .await;

        let eid = written
            .get("engram_id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        if let Some(eid) = eid {
            let _ = self
                .send(
                    "POST",
                    "/api/engrams/bulk_set_kind",
                    json!({"engram_ids": [eid], "kind": "source", "brain": brain.clone()}),
                )
                .await;
            let _ = self
                .send(
                    "POST",
                    "/api/engrams/bulk_add_tag",
                    json!({"engram_ids": [eid], "tag": "image", "brain": brain.clone()}),
                )
                .await;
        }

        if let Some(obj) = written.as_object_mut() {
            obj.insert("image_path".into(), json!(image_path));
        }
        written
    }

    /// `engram_history`: list snapshots, or fetch one by `version`
    /// (the version int is interpolated raw into the path).
    async fn special_engram_history(&self, args: &Map<String, Value>) -> Value {
        let engram_id = str_arg(args, "engram_id");
        let brain = args.get("brain");
        match args.get("version") {
            Some(v) if !v.is_null() => {
                let path = format!(
                    "/api/engrams/{}/versions/{}",
                    pct_encode(&engram_id),
                    plain_string(v)
                );
                let mut q = Vec::new();
                push_if_truthy_none(&mut q, "brain", brain);
                self.get(&path, q).await
            }
            _ => {
                let path = format!("/api/engrams/{}/versions", pct_encode(&engram_id));
                let mut q = vec![("limit".into(), plain_string(args.get("limit").unwrap_or(&json!(50))))];
                push_if_truthy_none(&mut q, "brain", brain);
                self.get(&path, q).await
            }
        }
    }

    /// `core_memory_read`: read one block by `label`, or list all.
    /// `brain` is included only when truthy (matches the proxy).
    async fn special_core_memory_read(&self, args: &Map<String, Value>) -> Value {
        let mut q = Vec::new();
        if let Some(b) = args.get("brain") {
            if is_truthy(b) {
                q.push(("brain".into(), plain_string(b)));
            }
        }
        match args.get("label").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            Some(label) => self.get(&format!("/api/core_memory/{}", pct_encode(label)), q).await,
            None => self.get("/api/core_memory", q).await,
        }
    }

    /// `compile_submit`: POST; `source_engram_ids` coerces None/empty → [];
    /// `brain` included only when truthy.
    async fn special_compile_submit(&self, args: &Map<String, Value>) -> Value {
        let sids = match args.get("source_engram_ids") {
            Some(v) if !is_falsy(v) => v.clone(),
            _ => json!([]),
        };
        let mut m = Map::new();
        m.insert("topic".into(), args.get("topic").cloned().unwrap_or(Value::Null));
        m.insert(
            "wiki_markdown".into(),
            args.get("wiki_markdown").cloned().unwrap_or(Value::Null),
        );
        m.insert("source_engram_ids".into(), sids);
        m.insert(
            "auto_approve".into(),
            args.get("auto_approve").cloned().unwrap_or(json!(false)),
        );
        if let Some(b) = args.get("brain") {
            if is_truthy(b) {
                m.insert("brain".into(), b.clone());
            }
        }
        self.send("POST", "/api/compilations/submit", Value::Object(m)).await
    }
}

// --- request-building helpers -------------------------------------------

#[derive(Clone, Copy)]
enum Transform {
    None,
    LowerBool,
}

/// Fill in any input-schema `default` for args the client omitted —
/// FastMCP does this server-side, so we must too for byte-identical
/// backend requests.
fn apply_defaults(args: &mut Map<String, Value>, schema: &Map<String, Value>) {
    if let Some(props) = schema.get("properties").and_then(|v| v.as_object()) {
        for (k, spec) in props {
            if !args.contains_key(k) {
                if let Some(def) = spec.get("default") {
                    args.insert(k.clone(), def.clone());
                }
            }
        }
    }
}

fn subst_path(path: &str, path_params: &[String], args: &Map<String, Value>) -> String {
    let mut out = path.to_string();
    for name in path_params {
        let raw = args.get(name).map(plain_string).unwrap_or_default();
        out = out.replace(&format!("{{{}}}", name), &pct_encode(&raw));
    }
    out
}

fn build_query(specs: &[ParamSpec], args: &Map<String, Value>) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for s in specs {
        let Some(v) = args.get(&s.from) else { continue };
        // GET always drops nulls (mirrors _http_get's `v is not None`).
        if v.is_null() || should_omit(&s.omit, v) {
            continue;
        }
        let t = match s.transform.as_str() {
            "lower_bool" => Transform::LowerBool,
            _ => Transform::None,
        };
        out.push((s.param.clone(), transform_string(v, t)));
    }
    out
}

fn build_body(specs: &[ParamSpec], args: &Map<String, Value>) -> Value {
    let mut m = Map::new();
    for s in specs {
        match args.get(&s.from) {
            Some(v) => {
                if should_omit(&s.omit, v) {
                    continue;
                }
                m.insert(s.param.clone(), v.clone());
            }
            None => {
                // The proxy always includes never-omit body fields; mirror
                // that with an explicit null when the arg is absent.
                if s.omit == "never" {
                    m.insert(s.param.clone(), Value::Null);
                }
            }
        }
    }
    Value::Object(m)
}

fn should_omit(rule: &str, v: &Value) -> bool {
    match rule {
        "if_none" => v.is_null(),
        "if_falsy" => is_falsy(v),
        _ => false, // "never"
    }
}

fn push_if_present(out: &mut Vec<(String, String)>, key: &str, v: Option<&Value>, t: Transform) {
    if let Some(v) = v {
        if !v.is_null() {
            out.push((key.to_string(), transform_string(v, t)));
        }
    }
}

/// Push only when the value is present and truthy-or-numeric — used for
/// args the proxy gates with `if x:` but that may legitimately be 0.
/// Here we match `_http_get`'s None-drop: include unless null.
fn push_if_truthy_none(out: &mut Vec<(String, String)>, key: &str, v: Option<&Value>) {
    if let Some(v) = v {
        if !v.is_null() {
            out.push((key.to_string(), plain_string(v)));
        }
    }
}

fn transform_string(v: &Value, t: Transform) -> String {
    match t {
        Transform::LowerBool => bool_str(v),
        Transform::None => plain_string(v),
    }
}

/// Scalar → query string. Strings keep their value (no JSON quotes);
/// numbers/bools use their natural form.
fn plain_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Bool → `"true"`/`"false"` (matches Python `str(x).lower()`); anything
/// else falls back to its plain string, lowercased.
fn bool_str(v: &Value) -> String {
    match v.as_bool() {
        Some(b) => b.to_string(),
        None => plain_string(v).to_lowercase(),
    }
}

fn str_arg(args: &Map<String, Value>, key: &str) -> String {
    args.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

/// Python truthiness: null / false / 0 / "" / [] / {} are falsy.
fn is_falsy(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::Bool(b) => !b,
        Value::Number(n) => n.as_f64().map(|f| f == 0.0).unwrap_or(false),
        Value::String(s) => s.is_empty(),
        Value::Array(a) => a.is_empty(),
        Value::Object(o) => o.is_empty(),
    }
}

fn is_truthy(v: &Value) -> bool {
    !is_falsy(v)
}

/// Percent-encode a path segment (everything outside RFC 3986 unreserved).
fn pct_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        let unreserved = b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~');
        if unreserved {
            out.push(b as char);
        } else {
            out.push('%');
            out.push_str(&format!("{:02X}", b));
        }
    }
    out
}

async fn read_response(resp: reqwest::Response) -> Value {
    match resp.bytes().await {
        Ok(b) if b.is_empty() => Value::Null,
        Ok(b) => serde_json::from_slice::<Value>(&b)
            .unwrap_or_else(|_| json!({ "error": String::from_utf8_lossy(&b).to_string() })),
        Err(e) => json!({ "error": format!("failed to read backend response: {e}") }),
    }
}

fn sidecar_down(e: &reqwest::Error) -> Value {
    json!({
        "error": "NeuroVault sidecar is not running",
        "hint": "Open the NeuroVault desktop app — the MCP server talks to its HTTP API on 127.0.0.1:8765.",
        "detail": e.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(pairs: &[(&str, Value)]) -> Map<String, Value> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    #[test]
    fn defaults_are_applied_from_schema() {
        let schema: Map<String, Value> = serde_json::from_value(json!({
            "type": "object",
            "properties": {
                "mode": {"type": "string", "default": "preview"},
                "limit": {"type": "integer", "default": 20},
                "query": {"type": "string"}
            }
        }))
        .unwrap();
        let mut a = args(&[("query", json!("hi"))]);
        apply_defaults(&mut a, &schema);
        assert_eq!(a.get("mode").unwrap(), &json!("preview"));
        assert_eq!(a.get("limit").unwrap(), &json!(20));
        assert_eq!(a.get("query").unwrap(), &json!("hi"));
    }

    #[test]
    fn get_query_drops_null_and_lowercases_bools() {
        let specs = vec![
            ParamSpec { param: "q".into(), from: "query".into(), transform: "none".into(), omit: "never".into() },
            ParamSpec { param: "brain".into(), from: "brain".into(), transform: "none".into(), omit: "if_none".into() },
            ParamSpec { param: "rerank".into(), from: "rerank".into(), transform: "lower_bool".into(), omit: "never".into() },
        ];
        let a = args(&[("query", json!("auth")), ("brain", Value::Null), ("rerank", json!(true))]);
        let q = build_query(&specs, &a);
        assert!(q.contains(&("q".into(), "auth".into())));
        assert!(q.contains(&("rerank".into(), "true".into())));
        assert!(!q.iter().any(|(k, _)| k == "brain"), "null brain must be dropped");
    }

    #[test]
    fn body_respects_omit_and_keeps_native_types() {
        let specs = vec![
            ParamSpec { param: "content".into(), from: "content".into(), transform: "none".into(), omit: "never".into() },
            ParamSpec { param: "title".into(), from: "title".into(), transform: "none".into(), omit: "if_falsy".into() },
            ParamSpec { param: "deduplicate".into(), from: "deduplicate".into(), transform: "none".into(), omit: "if_none".into() },
        ];
        let a = args(&[
            ("content", json!("hello")),
            ("title", json!("")), // falsy -> dropped
            ("deduplicate", json!(0.92)),
        ]);
        let body = build_body(&specs, &a);
        assert_eq!(body.get("content").unwrap(), &json!("hello"));
        assert!(body.get("title").is_none(), "empty title must be dropped (if_falsy)");
        assert_eq!(body.get("deduplicate").unwrap(), &json!(0.92));
    }

    #[test]
    fn path_substitution_percent_encodes() {
        let a = args(&[("engram_id", json!("a b/c"))]);
        let p = subst_path("/api/related/{engram_id}", &["engram_id".to_string()], &a);
        assert_eq!(p, "/api/related/a%20b%2Fc");
    }

    #[test]
    fn falsy_matches_python() {
        assert!(is_falsy(&json!(0)));
        assert!(is_falsy(&json!("")));
        assert!(is_falsy(&json!([])));
        assert!(is_falsy(&json!(false)));
        assert!(is_falsy(&Value::Null));
        assert!(is_truthy(&json!("x")));
        assert!(is_truthy(&json!(1)));
    }
}
