/* Standalone NeuroVault server binary.
 *
 * Cargo auto-detects this as a `neurovault-server` binary target
 * alongside the existing Tauri main (src/main.rs). It exposes the
 * same `memory::http_server` axum router, but without the Tauri
 * window / plugin machinery on top, so it can be embedded in the
 * VS Code extension as a sidecar.
 *
 * Usage:
 *   neurovault-server                        bind 127.0.0.1:8765
 *   neurovault-server --http-only            same; flag is informational
 *   neurovault-server --mcp-only             run as a stdio MCP server that
 *                                            forwards to the app on :8765
 *   neurovault-server --port 8770            bind a different port
 *   neurovault-server --help                 print this and exit
 *
 * Reads the same environment variables as the desktop app:
 *   NEUROVAULT_HOME      override ~/.neurovault as the data root
 *
 * Lifecycle: starts the axum server, blocks on SIGINT (ctrl-C on
 * Unix, console close handler on Windows), then shuts the server
 * down gracefully. Exit code 0 on clean shutdown, 1 on bind /
 * runtime failure, 2 on bad argv.
 */

use std::env;
use std::process::ExitCode;

use neurovault_lib::memory::api_gateway::{start_gateway, GatewayHandle};
use neurovault_lib::memory::api_keys::{self, Scope};
use neurovault_lib::memory::http_server::start_server;
use tokio::signal;

const HELP: &str = "\
neurovault-server: standalone HTTP server for the NeuroVault memory layer.

USAGE:
    neurovault-server [--http-only | --mcp-only] [--port N]

OPTIONS:
    --http-only        Informational. The standalone binary is always
                       HTTP-only; this flag is accepted for parity with
                       the way the desktop app spawns the server so the
                       VS Code extension can pass it without branching.
    --mcp-only         Run as a stdio MCP server (Model Context Protocol)
                       instead of binding HTTP. Every tool call is
                       forwarded over HTTP to the already-running desktop
                       app on 127.0.0.1:8765, so this mode loads no model,
                       opens no database, and never binds port 8765. This
                       is what Claude Desktop / Claude Code spawn.
    --port <N>         Bind to 127.0.0.1:N. Defaults to 8765 (matching
                       the desktop app and the MCP proxy).
    --mint-key <LABEL> Generate a new API key with the given label,
                       print the plaintext (ONCE), and exit. Scope
                       defaults to admin so the dev can hit any
                       endpoint while iterating; tighten via the
                       Settings UI once Phase 7 lands.
    -h, --help         Print this help and exit 0.

ENVIRONMENT:
    NEUROVAULT_HOME    Override ~/.neurovault as the data root.
";

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    let mut port: Option<u16> = None;
    let mut mint_label: Option<String> = None;
    let mut mcp_only = false;
    let mut iter = args.iter();

    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--http-only" => {}
            "--mcp-only" => mcp_only = true,
            "--port" => match iter.next() {
                Some(p) => match p.parse::<u16>() {
                    Ok(v) => port = Some(v),
                    Err(e) => {
                        eprintln!("invalid --port value '{}': {}", p, e);
                        return ExitCode::from(2);
                    }
                },
                None => {
                    eprintln!("--port requires a value");
                    return ExitCode::from(2);
                }
            },
            "--mint-key" => match iter.next() {
                Some(label) => mint_label = Some(label.clone()),
                None => {
                    eprintln!("--mint-key requires a label");
                    return ExitCode::from(2);
                }
            },
            "-h" | "--help" => {
                println!("{}", HELP);
                return ExitCode::SUCCESS;
            }
            other => {
                eprintln!("unknown argument: {}\n\n{}", other, HELP);
                return ExitCode::from(2);
            }
        }
    }

    // --mcp-only: run the native stdio MCP server and nothing else. It
    // forwards every tool call over HTTP to the already-running desktop
    // app on 127.0.0.1:8765, so it loads no model and opens no DB. Must
    // branch BEFORE start_server — we never bind 8765 in this mode, and
    // stdout is reserved for the MCP JSON-RPC channel (no "ready" line).
    if mcp_only {
        return neurovault_lib::memory::mcp::run_stdio().await;
    }

    // --mint-key short-circuits the server lifecycle: mint, print,
    // exit. Useful for bootstrapping the gateway before the
    // Settings UI exists.
    if let Some(label) = mint_label {
        match api_keys::create_key(&label, Scope::Admin, vec![]) {
            Ok(minted) => {
                eprintln!(
                    "Created API key id={} label={:?} scope=admin (no brain restriction)",
                    minted.record.id, minted.record.label,
                );
                eprintln!("Save this — it will NOT be shown again:");
                println!("{}", minted.plaintext);
                return ExitCode::SUCCESS;
            }
            Err(e) => {
                eprintln!("[neurovault-server] mint failed: {}", e);
                return ExitCode::FAILURE;
            }
        }
    }

    let mut handle = match start_server(port).await {
        Ok(h) => h,
        Err(e) => {
            eprintln!("[neurovault-server] failed to start: {}", e);
            return ExitCode::FAILURE;
        }
    };

    eprintln!(
        "[neurovault-server] listening on 127.0.0.1:{} (Ctrl-C to stop)",
        handle.port,
    );
    // The extension scrapes stdout for the "ready" line so it can mark
    // the side-panel status indicator green only after a successful
    // bind. Keep this format stable.
    println!("ready 127.0.0.1:{}", handle.port);

    // Optional API gateway. Two ways to enable:
    //   1. Persisted config at ~/.neurovault/api_gateway.json
    //      with `enabled: true`. Set via Settings → API Access.
    //   2. NEUROVAULT_API_GATEWAY=1 env override. Forces enable
    //      with default config (loopback + 8767). Useful for
    //      smoke-testing without persisting state.
    // The persisted config wins if both are set; env override is
    // the fallback when there's no config file yet.
    let mut gateway_handle: Option<GatewayHandle> = None;
    let env_force = env::var("NEUROVAULT_API_GATEWAY").as_deref() == Ok("1");
    let cfg = neurovault_lib::memory::api_gateway::load_config();
    if cfg.enabled || env_force {
        let resolved = if cfg.enabled { cfg } else { Default::default() };
        match start_gateway(resolved).await {
            Ok(h) => {
                eprintln!("[neurovault-server] api gateway up on {}", h.addr);
                gateway_handle = Some(h);
            }
            Err(e) => {
                eprintln!("[neurovault-server] api gateway failed to start: {}", e);
                // Don't bail — the loopback server is still running.
            }
        }
    }

    if signal::ctrl_c().await.is_err() {
        eprintln!("[neurovault-server] could not install signal handler; running until killed");
        // Fall through and block on the join handle anyway. Without
        // ctrl-c the only way out will be SIGTERM / SIGKILL, which
        // bypasses graceful shutdown — acceptable on the sidecar.
        std::future::pending::<()>().await;
    }

    eprintln!("[neurovault-server] shutting down");
    if let Some(mut g) = gateway_handle {
        g.stop().await;
    }
    handle.stop().await;
    ExitCode::SUCCESS
}
