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
    neurovault-server hook <install|uninstall|status>
    neurovault-server hook <user-prompt-submit|session-start>   (called by Claude Code)
    neurovault-server ambient test \"<prompt>\" [--cwd <path>] [--brain <id>]

OPTIONS:
    --http-only        Informational. The standalone binary is always
                       HTTP-only; this flag is accepted for parity with
                       the way the desktop app spawns the server so the
                       VS Code extension can pass it without branching.
    --mcp-only         Run as a stdio MCP server (Model Context Protocol)
                       instead of binding HTTP. Every tool call is forwarded
                       over HTTP to a NeuroVault backend on 127.0.0.1:8765.
                       If nothing is answering there, it AUTO-STARTS a
                       headless backend (this binary, no --mcp-only) in the
                       background and forwards to that — so an agent can
                       bring NeuroVault up itself, with no desktop app and no
                       user action. This is what Claude Desktop / Claude Code
                       spawn.
    --port <N>         Bind to 127.0.0.1:N. Defaults to 8765 (matching
                       the desktop app and the MCP proxy).
    --mint-key <LABEL> Generate a new API key with the given label,
                       print the plaintext (ONCE), and exit. Scope
                       defaults to admin so the dev can hit any
                       endpoint while iterating; tighten via the
                       Settings UI once Phase 7 lands.
    -h, --help         Print this help and exit 0.

ENVIRONMENT:
    NEUROVAULT_HOME      Override ~/.neurovault as the data root.
    NEUROVAULT_API_URL   Backend base URL the --mcp-only shim forwards to.
                         Default http://127.0.0.1:8765.
    NEUROVAULT_AUTOSTART Set to 0/false/off to DISABLE the --mcp-only
                         auto-start of a headless backend.
    NEUROVAULT_BRAIN     Opt-in per-folder brain: scope an --mcp-only session
                         to this brain (created if missing) so every tool call
                         defaults to it. A `.neurovault` file in the working
                         folder naming a brain does the same.
    NEUROVAULT_MCP_TIER  Tool tier exposed by --mcp-only: minimal | lite
                         (default) | standard | full. Also read from
                         ~/.neurovault/mcp_tier.txt.
";

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();

    // `ambient` subcommand: debug window into Ambient Recall. Talks to
    // the running app on :8765 like the hook does, but with debug=true
    // so the full candidate table + gate reasoning come back. The one
    // place in the ambient stack where failing LOUDLY is correct.
    if args.first().map(String::as_str) == Some("ambient") {
        return ambient_cli(&args[1..]).await;
    }

    // `hook` subcommand: automatic memory for Claude Code. Dispatched
    // before flag parsing — these modes never bind a port or load a
    // model; the event modes forward to the running app on :8765 and
    // FAIL OPEN (print nothing, exit 0) when it isn't up.
    if args.first().map(String::as_str) == Some("hook") {
        use neurovault_lib::memory::hooks;
        return match args.get(1).map(String::as_str) {
            Some("user-prompt-submit") | Some("session-start") => {
                ExitCode::from(hooks::run_hook_event(args[1].as_str()).await)
            }
            Some("install") => {
                let Ok(exe) = env::current_exe() else {
                    eprintln!("cannot resolve own binary path");
                    return ExitCode::from(1);
                };
                match hooks::install_hooks_at(&hooks::claude_settings_path(), &exe) {
                    Ok(msg) => {
                        println!("{msg}");
                        ExitCode::SUCCESS
                    }
                    Err(e) => {
                        eprintln!("install failed: {e}");
                        ExitCode::from(1)
                    }
                }
            }
            Some("uninstall") => match hooks::uninstall_hooks_at(&hooks::claude_settings_path()) {
                Ok(msg) => {
                    println!("{msg}");
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("uninstall failed: {e}");
                    ExitCode::from(1)
                }
            },
            Some("status") => {
                let installed = hooks::hooks_installed_at(&hooks::claude_settings_path());
                println!(
                    "auto-recall hooks: {}",
                    if installed {
                        "installed"
                    } else {
                        "not installed"
                    }
                );
                ExitCode::SUCCESS
            }
            other => {
                eprintln!(
                    "usage: neurovault-server hook <install|uninstall|status|user-prompt-submit|session-start>{}",
                    other.map(|o| format!("  (got '{o}')")).unwrap_or_default()
                );
                ExitCode::from(2)
            }
        };
    }

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

/// `ambient test "<prompt>" [--cwd <path>] [--brain <id>]` — run one
/// prompt through /api/ambient_recall with debug=true and pretty-print
/// the packet, the candidate table, the gate decision, and the final
/// block. See docs/specs/ambient-recall.md ("Debug CLI").
async fn ambient_cli(args: &[String]) -> ExitCode {
    use neurovault_lib::memory::hooks::resolve_repo_branch;
    use serde_json::{json, Value};

    let usage = "usage: neurovault-server ambient test \"<prompt>\" [--cwd <path>] [--brain <id>]";
    if args.first().map(String::as_str) != Some("test") {
        eprintln!("{usage}");
        return ExitCode::from(2);
    }
    let Some(prompt) = args.get(1).filter(|p| !p.trim().is_empty()) else {
        eprintln!("{usage}");
        return ExitCode::from(2);
    };
    let mut cwd: Option<String> = None;
    let mut brain: Option<String> = None;
    let mut i = 2;
    while i < args.len() {
        match (args.get(i).map(String::as_str), args.get(i + 1)) {
            (Some("--cwd"), Some(v)) => {
                cwd = Some(v.clone());
                i += 2;
            }
            (Some("--brain"), Some(v)) => {
                brain = Some(v.clone());
                i += 2;
            }
            (Some(other), _) => {
                eprintln!("unknown argument: {other}\n{usage}");
                return ExitCode::from(2);
            }
            (None, _) => break,
        }
    }
    let cwd = cwd.or_else(|| {
        env::current_dir()
            .ok()
            .map(|p| p.to_string_lossy().into_owned())
    });
    let (repo, branch) = resolve_repo_branch(cwd.as_deref());

    let packet = json!({
        "prompt": prompt,
        "cwd": cwd,
        "session_id": "ambient-cli",
        "host": "cli",
        "event": "AmbientTest",
        "brain": brain,
        "repo": repo,
        "branch": branch,
        "debug": true,
    });
    println!("── packet ──────────────────────────────────────────────");
    println!(
        "{}",
        serde_json::to_string_pretty(&packet).unwrap_or_default()
    );

    let base =
        env::var("NEUROVAULT_API_URL").unwrap_or_else(|_| "http://127.0.0.1:8765".to_string());
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .no_proxy()
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("http client: {e}");
            return ExitCode::from(1);
        }
    };
    let resp = match client
        .post(format!("{base}/api/ambient_recall"))
        .json(&packet)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!(
                "cannot reach NeuroVault on {base} — is the app (or `neurovault-server --http-only`) running?\n  {e}"
            );
            return ExitCode::from(1);
        }
    };
    if !resp.status().is_success() {
        eprintln!("server error: HTTP {}", resp.status());
        if let Ok(body) = resp.text().await {
            eprintln!("{body}");
        }
        return ExitCode::from(1);
    }
    let v: Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => {
            eprintln!("malformed response: {e}");
            return ExitCode::from(1);
        }
    };

    println!("── candidates ──────────────────────────────────────────");
    let empty = Vec::new();
    let cands = v["candidates"].as_array().unwrap_or(&empty);
    if cands.is_empty() {
        println!("(none)");
    } else {
        println!(
            "{:<7} {:<8} {:>4} {:>5} {:>6}  {:<24} title",
            "ce", "rrf", "sem", "bm25", "graph", "signals"
        );
        for c in cands {
            let s = &c["scores"];
            let fmt_rank = |x: &Value| {
                x.as_u64()
                    .map(|r| r.to_string())
                    .unwrap_or_else(|| "-".into())
            };
            println!(
                "{:<7} {:<8} {:>4} {:>5} {:>6}  {:<24} {}{}",
                s["ce_prob"]
                    .as_f64()
                    .map(|p| format!("{p:.2}"))
                    .unwrap_or_else(|| "-".into()),
                s["rrf"]
                    .as_f64()
                    .map(|p| format!("{p:.4}"))
                    .unwrap_or_else(|| "-".into()),
                fmt_rank(&s["semantic_rank"]),
                fmt_rank(&s["bm25_rank"]),
                fmt_rank(&s["graph_rank"]),
                c["signals"]
                    .as_array()
                    .map(|a| a
                        .iter()
                        .filter_map(|x| x.as_str())
                        .collect::<Vec<_>>()
                        .join(","))
                    .unwrap_or_default(),
                c["title"].as_str().unwrap_or("?"),
                if c["excluded"].as_bool() == Some(true) {
                    "  [excluded]"
                } else {
                    ""
                },
            );
        }
    }

    println!("── decision ────────────────────────────────────────────");
    println!(
        "{} — {}",
        v["decision"].as_str().unwrap_or("?"),
        v["reason"].as_str().unwrap_or("?")
    );
    println!(
        "brain: {} · quality: {} contentful token(s){}{} · tokens: {}",
        v["brain"].as_str().unwrap_or("?"),
        v["quality"]["contentful_tokens"].as_u64().unwrap_or(0),
        if v["quality"]["vague"].as_bool() == Some(true) {
            " · VAGUE"
        } else {
            ""
        },
        v["quality"]["signals"]
            .as_array()
            .filter(|a| !a.is_empty())
            .map(|a| format!(
                " · signals: {}",
                a.iter()
                    .filter_map(|x| x.as_str())
                    .collect::<Vec<_>>()
                    .join(",")
            ))
            .unwrap_or_default(),
        v["tokens"].as_u64().unwrap_or(0),
    );

    println!("── context block ───────────────────────────────────────");
    match v["context_block"].as_str() {
        Some(block) => println!("{block}"),
        None => println!("no injection"),
    }
    ExitCode::SUCCESS
}
