//! The rmcp `ServerHandler` implementation.
//!
//! Dynamic tool list (not the `#[tool]` macro) because the surface is
//! tier-gated at runtime and ported from data (`tools.json`). We override
//! exactly three methods — `get_info`, `list_tools`, `call_tool` — and let
//! rmcp's defaults handle the rest (prompts/resources list as empty, never
//! method-not-found). Only the `tools` capability is advertised, so a
//! conformant client never calls the others.

use std::collections::HashSet;
use std::future::Future;
use std::sync::Arc;

use rmcp::model::{
    CallToolRequestParams, CallToolResult, Content, Implementation, InitializeResult, JsonObject,
    ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool, ToolAnnotations,
};
use rmcp::service::{MaybeSendFuture, RequestContext, RoleServer};
use rmcp::{ErrorData as McpError, ServerHandler};
use serde_json::{json, Value};

use super::forward::Forwarder;
use super::registry::{self, ToolDef};

pub struct NeuroVaultMcp {
    forwarder: Forwarder,
    tools: Vec<ToolDef>,
    /// `None` = full tier (no filtering).
    allowed: Option<HashSet<String>>,
    tier_name: String,
}

impl NeuroVaultMcp {
    /// `session_brain` (opt-in per-folder brain) is the resolved brain id
    /// every tool call is scoped to by default; `None` keeps today's
    /// behaviour (the global active brain).
    pub fn new(session_brain: Option<String>) -> Self {
        let tier_name = registry::resolve_tier();
        let allowed = registry::allowed_for_tier(&tier_name);
        Self {
            forwarder: Forwarder::new(session_brain),
            tools: registry::load_tools(),
            allowed,
            tier_name,
        }
    }

    fn is_allowed(&self, name: &str) -> bool {
        match &self.allowed {
            None => true,
            Some(set) => set.contains(name),
        }
    }

    fn visible_tools(&self) -> Vec<Tool> {
        self.tools
            .iter()
            .filter(|t| self.is_allowed(&t.name))
            .map(to_rmcp_tool)
            .collect()
    }
}

fn to_rmcp_tool(def: &ToolDef) -> Tool {
    let schema: Arc<JsonObject> = Arc::new(def.input_schema.clone());
    let mut tool = Tool::new(def.name.clone(), def.description.clone(), schema);
    tool.title = def.title.clone();

    let a = &def.annotations;
    if a.read_only.is_some()
        || a.destructive.is_some()
        || a.idempotent.is_some()
        || a.open_world.is_some()
    {
        tool.annotations = Some(ToolAnnotations::from_raw(
            def.title.clone(),
            a.read_only,
            a.destructive,
            a.idempotent,
            a.open_world,
        ));
    }
    tool
}

impl ServerHandler for NeuroVaultMcp {
    fn get_info(&self) -> ServerInfo {
        let name = if self.tier_name == "full" {
            "NeuroVault".to_string()
        } else {
            format!("NeuroVault [{}]", self.tier_name)
        };
        let capabilities = ServerCapabilities::builder().enable_tools().build();
        InitializeResult::new(capabilities)
            .with_server_info(Implementation::new(name, env!("CARGO_PKG_VERSION")))
            .with_instructions(registry::INSTRUCTIONS)
    }

    fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<ListToolsResult, McpError>> + MaybeSendFuture + '_ {
        let tools = self.visible_tools();
        async move {
            Ok(ListToolsResult {
                tools,
                ..Default::default()
            })
        }
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        let name = request.name.to_string();
        let def = self.tools.iter().find(|t| t.name == name);
        let def = match def {
            Some(t) if self.is_allowed(&t.name) => t,
            Some(_) => {
                return Err(McpError::invalid_params(
                    format!(
                        "tool '{name}' exists but is not enabled in the '{}' tier",
                        self.tier_name
                    ),
                    None,
                ));
            }
            None => {
                return Err(McpError::invalid_params(
                    format!("unknown tool '{name}'"),
                    None,
                ));
            }
        };

        let args = request.arguments.clone().unwrap_or_default();
        let value = self.forwarder.call(def, &args).await;
        Ok(tool_result(value))
    }
}

/// What to tell an agent whose brain doesn't exist yet. The raw
/// `os error 2` underneath means nothing to a user.
const NO_BRAIN_HINT: &str = "no vault exists yet — open NeuroVault and create one, \
                             or it will be created automatically on next start";

/// Turn one forwarded payload into an MCP tool result.
///
/// The forwarder returns plain JSON whether the call worked or not, so
/// this is the one place that decides success vs failure. It used to
/// answer `CallToolResult::success` unconditionally: a backend error came
/// back as `isError: false` with `{"error":"…os error 2"}` as its text, so
/// the agent believed it had an answer and relayed a filesystem error to
/// the user. Failures must be structurally distinguishable from answers.
fn tool_result(value: Value) -> CallToolResult {
    match error_message(&value) {
        Some(msg) => CallToolResult::error(vec![Content::text(with_hint(value, &msg))]),
        // FastMCP serializes a dict return as JSON text content; match that.
        None => {
            let text = serde_json::to_string(&value).unwrap_or_else(|_| "null".to_string());
            CallToolResult::success(vec![Content::text(text)])
        }
    }
}

/// Is this payload a failure? Both sources of failure share one shape —
/// the backend's `ApiError` body is `{"error": "…"}` and the forwarder's
/// own "sidecar is not running" dict matches it — so one probe covers
/// both. Deliberately exact on the key: successful payloads carry
/// `errors` (plural) lists and `error: null`, neither of which is a
/// failure.
fn error_message(value: &Value) -> Option<String> {
    match value.as_object()?.get("error")? {
        Value::Null => None,
        Value::String(s) if s.trim().is_empty() => None,
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

/// Re-emit the failure payload with an actionable `hint` when we can name
/// the fix. Never overwrites a hint the backend or forwarder already set.
fn with_hint(value: Value, msg: &str) -> String {
    let mut obj = match value {
        Value::Object(o) => o,
        other => return other.to_string(),
    };
    let lower = msg.to_ascii_lowercase();
    let missing_brain = lower.contains("brains.json") || lower.contains("no active brain");
    if missing_brain && !obj.contains_key("hint") {
        obj.insert("hint".into(), json!(NO_BRAIN_HINT));
    }
    Value::Object(obj).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_tier_shows_all_tools() {
        std::env::set_var("NEUROVAULT_MCP_TIER", "full");
        let s = NeuroVaultMcp::new(None);
        assert_eq!(s.visible_tools().len(), 55);
        std::env::remove_var("NEUROVAULT_MCP_TIER");
    }

    #[test]
    fn lite_tier_shows_nine_tools() {
        std::env::set_var("NEUROVAULT_MCP_TIER", "lite");
        let s = NeuroVaultMcp::new(None);
        let tools = s.visible_tools();
        // 8 → 9: recall_chunks was promoted into the default tier
        // (see TIER_LITE_ADD in registry.rs).
        assert_eq!(tools.len(), 9);
        let names: HashSet<String> = tools.iter().map(|t| t.name.to_string()).collect();
        assert!(names.contains("recall"));
        assert!(names.contains("recall_chunks"));
        assert!(names.contains("remember"));
        assert!(!names.contains("optimize_disk"));
        std::env::remove_var("NEUROVAULT_MCP_TIER");
    }

    /// The text an agent actually reads back from a tool result.
    fn body(result: &CallToolResult) -> String {
        result
            .content
            .first()
            .and_then(|c| c.as_text().map(|t| t.text.clone()))
            .unwrap_or_default()
    }

    /// THE HONESTY RULE. A backend failure wrapped as a success is worse
    /// than no answer: the agent reports the raw error to the user as if
    /// it were the memory it asked for.
    #[test]
    fn backend_error_is_flagged_as_an_error() {
        let r = tool_result(json!({"error": "engram not found: abc123"}));
        assert_eq!(
            r.is_error,
            Some(true),
            "an error payload must not be isError:false"
        );
        assert!(
            body(&r).contains("engram not found: abc123"),
            "the cause must survive: {}",
            body(&r)
        );
    }

    /// The exact fresh-machine failure. `os error 2` alone tells a user
    /// nothing, so the result has to say what to do about it.
    #[test]
    fn missing_registry_error_tells_the_agent_what_to_do() {
        let r = tool_result(json!({
            "error": "brains.json unreadable: No such file or directory (os error 2)"
        }));
        assert_eq!(r.is_error, Some(true));
        let text = body(&r);
        assert!(
            text.contains("no vault exists yet"),
            "must explain the cause in human terms: {text}"
        );
        assert!(
            text.contains("open NeuroVault"),
            "must give the user an action: {text}"
        );
    }

    /// "No active brain" is the same situation with a different message.
    #[test]
    fn no_active_brain_error_gets_the_same_hint() {
        let r = tool_result(json!({"error": "brains.json has no active brain"}));
        assert_eq!(r.is_error, Some(true));
        assert!(body(&r).contains("no vault exists yet"), "{}", body(&r));
    }

    /// A backend that isn't running is a failure too.
    #[test]
    fn sidecar_down_is_flagged_as_an_error() {
        let r = tool_result(json!({
            "error": "NeuroVault sidecar is not running",
            "hint": "Open the NeuroVault desktop app — the MCP server talks to its HTTP API on 127.0.0.1:8765.",
            "detail": "connection refused",
        }));
        assert_eq!(r.is_error, Some(true));
        let text = body(&r);
        assert!(text.contains("connection refused"), "{text}");
        assert!(
            text.contains("Open the NeuroVault desktop app"),
            "an existing hint must not be overwritten: {text}"
        );
    }

    /// Successes must stay successes — and stay byte-identical to what the
    /// FastMCP proxy sent, so no tool's parsing changes.
    #[test]
    fn successful_payloads_are_untouched() {
        for ok in [
            json!({"hits": [], "brain": "main"}),
            json!({"ok": true, "error": null}),
            json!({"errors": ["not the error key"]}),
            json!([1, 2, 3]),
            Value::Null,
        ] {
            let r = tool_result(ok.clone());
            assert_ne!(r.is_error, Some(true), "false positive on {ok}");
            assert_eq!(body(&r), serde_json::to_string(&ok).unwrap());
        }
    }

    #[test]
    fn get_info_advertises_tools_and_instructions() {
        let s = NeuroVaultMcp::new(None);
        let info = s.get_info();
        assert!(info.capabilities.tools.is_some());
        assert!(info
            .instructions
            .as_deref()
            .unwrap_or("")
            .contains("NeuroVault is a persistent"));
    }
}
