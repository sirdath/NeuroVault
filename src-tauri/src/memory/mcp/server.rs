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
        // FastMCP serializes a dict return as JSON text content; match that.
        let text = serde_json::to_string(&value).unwrap_or_else(|_| "null".to_string());
        Ok(CallToolResult::success(vec![Content::text(text)]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_tier_shows_all_tools() {
        std::env::set_var("NEUROVAULT_MCP_TIER", "full");
        let s = NeuroVaultMcp::new(None);
        assert_eq!(s.visible_tools().len(), 54);
        std::env::remove_var("NEUROVAULT_MCP_TIER");
    }

    #[test]
    fn lite_tier_shows_eight_tools() {
        std::env::set_var("NEUROVAULT_MCP_TIER", "lite");
        let s = NeuroVaultMcp::new(None);
        let tools = s.visible_tools();
        assert_eq!(tools.len(), 8);
        let names: HashSet<String> = tools.iter().map(|t| t.name.to_string()).collect();
        assert!(names.contains("recall"));
        assert!(names.contains("remember"));
        assert!(!names.contains("optimize_disk"));
        std::env::remove_var("NEUROVAULT_MCP_TIER");
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
