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

use neurovault_lib::memory::http_server::start_server;
use tokio::signal;

const HELP: &str = "\
neurovault-server: standalone HTTP server for the NeuroVault memory layer.

USAGE:
    neurovault-server [--http-only] [--port N]

OPTIONS:
    --http-only        Informational. The standalone binary is always
                       HTTP-only; this flag is accepted for parity with
                       the way the desktop app spawns the server so the
                       VS Code extension can pass it without branching.
    --port <N>         Bind to 127.0.0.1:N. Defaults to 8765 (matching
                       the desktop app and the MCP proxy).
    -h, --help         Print this help and exit 0.

ENVIRONMENT:
    NEUROVAULT_HOME    Override ~/.neurovault as the data root.
";

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    let mut port: Option<u16> = None;
    let mut iter = args.iter();

    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--http-only" => {}
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

    if signal::ctrl_c().await.is_err() {
        eprintln!("[neurovault-server] could not install signal handler; running until killed");
        // Fall through and block on the join handle anyway. Without
        // ctrl-c the only way out will be SIGTERM / SIGKILL, which
        // bypasses graceful shutdown — acceptable on the sidecar.
        std::future::pending::<()>().await;
    }

    eprintln!("[neurovault-server] shutting down");
    handle.stop().await;
    ExitCode::SUCCESS
}
