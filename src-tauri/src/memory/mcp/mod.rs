//! Native MCP stdio server for `neurovault-server --mcp-only`.
//!
//! Replaces the Python `server/mcp_proxy.py`: a thin stdio MCP server
//! (via the official `rmcp` SDK) that forwards every tool call over HTTP
//! to the already-running desktop app on `127.0.0.1:8765`. It loads no
//! model and opens no database, so the handshake is instant and it never
//! competes with the app for port 8765 or the brain.db write lock.
//!
//! stdout is the MCP JSON-RPC channel — this module logs only to stderr.

pub mod forward;
pub mod registry;
pub mod server;

use std::process::ExitCode;

use rmcp::transport::stdio;
use rmcp::ServiceExt;

use server::NeuroVaultMcp;

/// Run the MCP server over stdio until the client disconnects.
/// Returns the process exit code.
pub async fn run_stdio() -> ExitCode {
    let handler = NeuroVaultMcp::new();
    let service = match handler.serve(stdio()).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[neurovault-mcp] failed to start stdio MCP server: {e}");
            return ExitCode::FAILURE;
        }
    };
    let base = std::env::var("NEUROVAULT_API_URL")
        .ok()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "http://127.0.0.1:8765".to_string());
    eprintln!("[neurovault-mcp] stdio MCP server ready (forwarding tool calls to {base})");
    match service.waiting().await {
        Ok(reason) => {
            eprintln!("[neurovault-mcp] client disconnected: {reason:?}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("[neurovault-mcp] service error: {e}");
            ExitCode::FAILURE
        }
    }
}