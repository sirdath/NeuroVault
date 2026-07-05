/* Headless NeuroVault API gateway binary.
 *
 * Same code as the desktop app — same handlers, same axum router,
 * same auth + scope middleware — minus the Tauri shell + loopback
 * server. Built for VPS / Docker / `systemd` deployment where the
 * use case is "memory backend for hosted agents," not "user
 * sitting in front of a window."
 *
 * Differences from `neurovault-server` (the standalone with the
 * loopback server):
 *
 *   1. NO loopback server — only the external gateway binds.
 *      On a server box the loopback is dead weight (no Tauri
 *      webview, no MCP proxy).
 *   2. Gateway is REQUIRED to start. If api_gateway.json is
 *      disabled or missing, this binary exits non-zero with
 *      "enable the gateway in Settings or pass --bind/--port".
 *      No silent degradation to "started but does nothing."
 *   3. CLI flags override the config file for ad-hoc testing
 *      (e.g. `neurovault-api --bind 0.0.0.0 --port 80`).
 *
 * Usage:
 *   neurovault-api                              respect api_gateway.json
 *   neurovault-api --port 8080                  override port
 *   neurovault-api --bind 0.0.0.0               override bind to LAN
 *   neurovault-api --bind 192.168.1.42          bind to a specific IP
 *   neurovault-api --mint-key <LABEL>           mint a key, print, exit
 *   neurovault-api --help                       print this and exit 0
 *
 * Reads the same data root + config as the desktop app:
 *   ~/.neurovault/                              brain data root
 *   ~/.neurovault/api_keys.json                 hashed API keys
 *   ~/.neurovault/api_gateway.json              gateway config
 *   ~/.neurovault/api_audit.jsonl               audit log
 *
 * Exit codes:
 *   0  clean shutdown
 *   1  bind / runtime failure
 *   2  bad argv
 *   3  gateway not configured (api_gateway.json disabled or missing)
 */

use std::env;
use std::process::ExitCode;

use neurovault_lib::memory::api_gateway::{self, start_gateway, GatewayConfig};
use neurovault_lib::memory::api_keys::{self, Scope};
use tokio::signal;

const HELP: &str = "\
neurovault-api: headless NeuroVault HTTP API gateway.

USAGE:
    neurovault-api [--bind IP] [--port N]
    neurovault-api --mint-key <LABEL>

OPTIONS:
    --bind <IP>          Override the persisted bind. Use 0.0.0.0 to
                         expose on all interfaces, 127.0.0.1 for
                         loopback only, or a specific IP.
    --port <N>           Override the persisted port.
    --mint-key <LABEL>   Generate a new admin-scope API key, print
                         the plaintext (ONCE), and exit. Use this on
                         a fresh server to bootstrap.
    -h, --help           Print this help and exit 0.

ENVIRONMENT:
    NEUROVAULT_HOME      Override ~/.neurovault as the data root.

CONFIG:
    The gateway reads ~/.neurovault/api_gateway.json. If `enabled`
    is false there AND no --bind / --port are passed, this binary
    exits non-zero — there's nothing meaningful to serve. To enable:
    edit the file or run `neurovault-api --bind 127.0.0.1 --port 8767`.
";

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    let mut bind_override: Option<String> = None;
    let mut port_override: Option<u16> = None;
    let mut mint_label: Option<String> = None;
    let mut iter = args.iter();

    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--bind" => match iter.next() {
                Some(v) => bind_override = Some(v.clone()),
                None => {
                    eprintln!("--bind requires an IP address");
                    return ExitCode::from(2);
                }
            },
            "--port" => match iter.next() {
                Some(p) => match p.parse::<u16>() {
                    Ok(v) => port_override = Some(v),
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

    // --mint-key short-circuits the lifecycle. Useful for fresh
    // server bootstrap: ssh in, run this, copy the plaintext, use
    // it from your client, exit. No need to start the server.
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
                eprintln!("[neurovault-api] mint failed: {}", e);
                return ExitCode::FAILURE;
            }
        }
    }

    // Load persisted config; merge CLI overrides on top. If neither
    // the config nor the CLI gives us a real bind, refuse to start
    // — silent failure is worse than loud refusal.
    let mut cfg = api_gateway::load_config();

    // CLI overrides force the gateway "enabled" — passing --bind
    // is itself the opt-in.
    if bind_override.is_some() || port_override.is_some() {
        cfg.enabled = true;
        if let Some(b) = bind_override {
            // "0.0.0.0" → lan; "127.0.0.1" → loopback; anything
            // else → specific.
            if b == "0.0.0.0" {
                cfg.bind_kind = "lan".to_string();
                cfg.bind_ip = None;
            } else if b == "127.0.0.1" {
                cfg.bind_kind = "loopback".to_string();
                cfg.bind_ip = None;
            } else {
                cfg.bind_kind = "specific".to_string();
                cfg.bind_ip = Some(b);
            }
        }
        if let Some(p) = port_override {
            cfg.port = p;
        }
    }

    if !cfg.enabled {
        eprintln!(
            "[neurovault-api] gateway is not enabled (no flags passed and \
             ~/.neurovault/api_gateway.json has enabled: false). \
             Pass --bind/--port to override, or enable the gateway in \
             the desktop Settings UI."
        );
        return ExitCode::from(3);
    }

    // Validate the resolved bind before binding so a typo'd IP
    // surfaces with a useful error rather than a generic socket
    // error.
    if let Err(e) = cfg.resolve_bind() {
        eprintln!("[neurovault-api] invalid bind: {}", e);
        return ExitCode::from(2);
    }

    let mut handle = match start_gateway(cfg).await {
        Ok(h) => h,
        Err(e) => {
            eprintln!("[neurovault-api] failed to start: {}", e);
            return ExitCode::FAILURE;
        }
    };

    eprintln!(
        "[neurovault-api] listening on {} (Ctrl-C to stop)",
        handle.addr,
    );
    // Stable line stdout consumers (init systems, supervisor
    // scripts) can grep for "ready"; mirrors the convention the
    // standalone server uses.
    println!("ready {}", handle.addr);

    if signal::ctrl_c().await.is_err() {
        eprintln!("[neurovault-api] could not install signal handler; running until killed");
        std::future::pending::<()>().await;
    }

    eprintln!("[neurovault-api] shutting down");
    handle.stop().await;
    ExitCode::SUCCESS
}

// Cargo expects each src/bin/*.rs to compile as its own crate;
// shared code in `src/lib.rs` is reached via the `neurovault_lib`
// import name (set by Cargo's auto-detection from package name).
// Nothing else lives in this file — keep the entrypoint narrow.

#[allow(dead_code)]
struct _ConfigSentinel(GatewayConfig);
