//! Data-driven MCP tool registry.
//!
//! The full 55-tool surface (46 ported 1:1 from the Python
//! `server/mcp_proxy.py`, plus graphify + agent-coordination) lives in
//! `tools.json` (embedded via
//! `include_str!`) so it can be audited as data rather than code. Each
//! tool is either a generic forward (a single HTTP method + path +
//! query/body mapping) or a `special` handled by hand in `forward.rs`.
//!
//! Tier membership and the server `instructions` block are defined here
//! in Rust as the single source of truth — they gate which slice of the
//! surface a connected agent sees (matches the proxy's tier knob).

use std::collections::HashSet;

use serde::Deserialize;
use serde_json::{Map, Value};

/// One MCP tool, deserialized from `tools.json`.
#[derive(Debug, Clone, Deserialize)]
pub struct ToolDef {
    pub name: String,
    #[serde(default)]
    pub title: Option<String>,
    pub description: String,
    #[serde(default)]
    pub annotations: Annotations,
    /// Full JSON Schema object for the tool's arguments.
    pub input_schema: Map<String, Value>,
    pub call: CallSpec,
}

/// Tool annotation hints (read-only / destructive / idempotent /
/// open-world). All optional — only the keys present in the proxy's
/// `@mcp.tool(annotations=...)` are set.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Annotations {
    #[serde(default)]
    pub read_only: Option<bool>,
    #[serde(default)]
    pub destructive: Option<bool>,
    #[serde(default)]
    pub idempotent: Option<bool>,
    #[serde(default)]
    pub open_world: Option<bool>,
}

/// How a tool forwards to the HTTP backend.
#[derive(Debug, Clone, Deserialize)]
pub struct CallSpec {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub path_params: Vec<String>,
    #[serde(default)]
    pub query: Vec<ParamSpec>,
    #[serde(default)]
    pub body: Vec<ParamSpec>,
    /// `null` for generic forwards; a key (`recall`, `remember_image`,
    /// `engram_history`, `core_memory_read`, `compile_submit`) when the
    /// tool branches on an arg or makes multiple HTTP calls. Handled in
    /// `forward.rs`.
    #[serde(default)]
    pub special: Option<String>,
}

/// One argument → request-param mapping.
#[derive(Debug, Clone, Deserialize)]
pub struct ParamSpec {
    /// Output key sent to the API.
    pub param: String,
    /// Input argument name.
    pub from: String,
    /// `none` | `int` | `float` | `lower_bool` (GET bools are
    /// stringified `"true"`/`"false"` to match the proxy's `str(x).lower()`).
    #[serde(default = "default_transform")]
    pub transform: String,
    /// `never` | `if_none` | `if_falsy` — when to drop the param.
    #[serde(default = "default_omit")]
    pub omit: String,
}

fn default_transform() -> String {
    "none".to_string()
}
fn default_omit() -> String {
    "if_none".to_string()
}

const TOOLS_JSON: &str = include_str!("tools.json");

/// The server `instructions` block, verbatim from the proxy.
pub const INSTRUCTIONS: &str = include_str!("instructions.txt");

/// Parse the embedded registry. Panics at startup if `tools.json` is
/// malformed — that is a build-time invariant, not a runtime condition.
pub fn load_tools() -> Vec<ToolDef> {
    serde_json::from_str(TOOLS_JSON).expect("embedded mcp tools.json must be valid")
}

// --- Tiers ---------------------------------------------------------------
//
// Mirrors mcp_proxy.py's TIER_* sets exactly. Default is `lite` (changed
// upstream 2026-05-16 from `full`): shipping all 55 tools to every agent
// inflates the system prompt and dilutes attention on the load-bearing
// memory tools. `full` opts back into the entire surface.

const TIER_MINIMAL: &[&str] = &["recall", "related", "session_start"];
const TIER_LITE_ADD: &[&str] = &[
    "remember",
    "status",
    "list_brains",
    "switch_brain",
    "update",
];
const TIER_STANDARD_ADD: &[&str] = &[
    "recall_chunks",
    "temporal_recall",
    "check_duplicate",
    "core_memory_read",
    "core_memory_set",
    "core_memory_append",
    "core_memory_replace",
    "delete_engrams",
    "find_clutter",
    "engram_history",
    "handoff",
    "agent_inbox",
    "get_relevant_context",
];

/// Allow-set of tool names for a tier. `None` means "full" (no filter).
pub fn allowed_for_tier(tier: &str) -> Option<HashSet<String>> {
    let mut set = HashSet::new();
    let extend = |set: &mut HashSet<String>, names: &[&str]| {
        for n in names {
            set.insert((*n).to_string());
        }
    };
    match tier {
        "full" => return None,
        "minimal" => extend(&mut set, TIER_MINIMAL),
        "standard" => {
            extend(&mut set, TIER_MINIMAL);
            extend(&mut set, TIER_LITE_ADD);
            extend(&mut set, TIER_STANDARD_ADD);
        }
        // "lite" + empty/unknown all fall through to the default tier.
        _ => {
            extend(&mut set, TIER_MINIMAL);
            extend(&mut set, TIER_LITE_ADD);
        }
    }
    Some(set)
}

/// Resolve the active tier: `NEUROVAULT_MCP_TIER` env, then
/// `~/.neurovault/mcp_tier.txt`, else `lite`.
pub fn resolve_tier() -> String {
    let raw = std::env::var("NEUROVAULT_MCP_TIER")
        .ok()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            let p = crate::memory::paths::nv_home().join("mcp_tier.txt");
            std::fs::read_to_string(p)
                .ok()
                .map(|s| s.trim().to_lowercase())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_default();

    match raw.as_str() {
        "minimal" => "minimal",
        "standard" => "standard",
        "full" => "full",
        _ => "lite",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_parses_and_has_55_tools() {
        let tools = load_tools();
        assert_eq!(
            tools.len(),
            55,
            "expected 55 tools (46 ported + 6 graphify + handoff + agent_inbox + get_relevant_context)"
        );
        // names unique
        let mut seen = HashSet::new();
        for t in &tools {
            assert!(seen.insert(t.name.clone()), "duplicate tool: {}", t.name);
            assert!(
                !t.description.is_empty(),
                "{} has empty description",
                t.name
            );
            let m = t.call.method.to_uppercase();
            assert!(
                matches!(m.as_str(), "GET" | "POST" | "PUT" | "DELETE"),
                "{} has bad method {}",
                t.name,
                m
            );
        }
    }

    #[test]
    fn tier_sets_match_proxy_counts() {
        assert_eq!(allowed_for_tier("minimal").unwrap().len(), 3);
        assert_eq!(allowed_for_tier("lite").unwrap().len(), 8);
        assert_eq!(allowed_for_tier("standard").unwrap().len(), 21);
        assert!(allowed_for_tier("full").is_none());
        // unknown -> lite
        assert_eq!(allowed_for_tier("bogus").unwrap().len(), 8);
    }

    /// Every argument an agent can pass must explain itself: a schema
    /// property without a description is a parameter the agent has to
    /// guess at. This locked in the 2026-07-05 docs pass (19 gaps fixed).
    #[test]
    fn every_param_has_a_description() {
        for t in load_tools() {
            if let Some(props) = t.input_schema.get("properties").and_then(|v| v.as_object()) {
                for (pname, p) in props {
                    let desc = p.get("description").and_then(|d| d.as_str()).unwrap_or("");
                    assert!(
                        !desc.trim().is_empty(),
                        "{}.{} has no description",
                        t.name,
                        pname
                    );
                }
            }
        }
    }

    /// Every tool must carry at least one annotation hint (read_only /
    /// destructive / idempotent / open_world) — MCP clients use these
    /// for permission UX.
    #[test]
    fn every_tool_has_annotations() {
        for t in load_tools() {
            let a = &t.annotations;
            assert!(
                a.read_only.is_some()
                    || a.destructive.is_some()
                    || a.idempotent.is_some()
                    || a.open_world.is_some(),
                "{} has no annotation hints",
                t.name
            );
        }
    }

    /// The SERVER owns the reranker default (Settings toggle +
    /// ~/.neurovault/rerank.txt). A schema-level `default` on a rerank
    /// param gets injected by apply_defaults and silently overrides the
    /// user's preference on every MCP call — the exact bug fixed
    /// 2026-07-05. Never reintroduce it.
    #[test]
    fn rerank_params_have_no_schema_default() {
        for t in load_tools() {
            if let Some(props) = t.input_schema.get("properties").and_then(|v| v.as_object()) {
                if let Some(p) = props.get("rerank") {
                    assert!(
                        p.get("default").is_none(),
                        "{}.rerank declares a schema default; the server preference must win",
                        t.name
                    );
                }
            }
        }
    }

    /// Every param mapping must reference a real schema property, so a
    /// schema rename can't silently orphan the forwarding. `<computed>`
    /// and `<constant:...>` markers are special-cased in forward.rs.
    #[test]
    fn param_mappings_reference_schema_properties() {
        for t in load_tools() {
            let props: HashSet<String> = t
                .input_schema
                .get("properties")
                .and_then(|v| v.as_object())
                .map(|m| m.keys().cloned().collect())
                .unwrap_or_default();
            for spec in t.call.query.iter().chain(t.call.body.iter()) {
                if spec.from.starts_with('<') {
                    continue;
                }
                assert!(
                    props.contains(&spec.from),
                    "{} maps arg '{}' that is not in its input schema",
                    t.name,
                    spec.from
                );
            }
            for pp in &t.call.path_params {
                assert!(
                    props.contains(pp),
                    "{} path param '{}' is not in its input schema",
                    t.name,
                    pp
                );
            }
        }
    }

    #[test]
    fn every_tier_tool_exists_in_registry() {
        let names: HashSet<String> = load_tools().into_iter().map(|t| t.name).collect();
        for tier in ["minimal", "lite", "standard"] {
            for t in allowed_for_tier(tier).unwrap() {
                assert!(
                    names.contains(&t),
                    "tier {tier} references unknown tool {t}"
                );
            }
        }
    }
}
