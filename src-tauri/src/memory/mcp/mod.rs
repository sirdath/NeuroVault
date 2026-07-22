//! Native MCP stdio server for `neurovault-server --mcp-only`.
//!
//! A thin stdio MCP server (via the official `rmcp` SDK) that forwards
//! every tool call over HTTP to a NeuroVault backend on `127.0.0.1:8765`.
//! It loads no model and opens no database itself.
//!
//! Two conveniences make it usable with **zero user setup**:
//!   * **Auto-start** — if no backend is answering on the target port, the
//!     shim spawns a headless `neurovault-server` (this same binary, no
//!     `--mcp-only`) in the background and forwards to it. So an agent can
//!     bring NeuroVault up on its own; the desktop app is optional. Opt out
//!     with `NEUROVAULT_AUTOSTART=0`.
//!   * **Opt-in per-folder brain** — if `NEUROVAULT_BRAIN` is set, or a
//!     `.neurovault` file names a brain in the working folder, the session is
//!     scoped to that brain (created on first use); every tool call defaults
//!     to it without touching the global active brain.
//!
//! stdout is the MCP JSON-RPC channel — this module logs only to stderr.

pub mod forward;
pub mod registry;
pub mod server;

use std::process::{Command, ExitCode, Stdio};
use std::time::Duration;

use rmcp::transport::stdio;
use rmcp::ServiceExt;
use serde::Serialize;

use super::paths::nv_home;
use server::NeuroVaultMcp;

#[derive(Serialize)]
struct ManagedBackendMarker<'a> {
    schema_version: u8,
    managed_by: &'static str,
    version: &'a str,
    pid: u32,
    port: u16,
    instance_id: &'a str,
}

fn managed_backend_marker_path() -> std::path::PathBuf {
    nv_home().join("managed-backend.json")
}

fn record_managed_backend(identity: &forward::BackendIdentity, port: u16) -> std::io::Result<()> {
    let home = nv_home();
    std::fs::create_dir_all(&home)?;
    let destination = managed_backend_marker_path();
    let temporary = home.join(format!("managed-backend.{}.tmp", std::process::id()));
    let marker = ManagedBackendMarker {
        schema_version: 1,
        managed_by: "@neurovault/mcp",
        version: &identity.version,
        pid: identity.pid,
        port,
        instance_id: &identity.instance_id,
    };
    let bytes = serde_json::to_vec_pretty(&marker).map_err(std::io::Error::other)?;
    std::fs::write(&temporary, bytes)?;
    // Unix rename replaces atomically. Windows rename does not replace an
    // existing file, so remove only the stale marker immediately before the
    // rename. Ownership is still established by the live pid + instance_id,
    // never by the marker alone.
    #[cfg(windows)]
    if destination.exists() {
        std::fs::remove_file(&destination)?;
    }
    std::fs::rename(temporary, destination)
}

/// Run the MCP server over stdio until the client disconnects.
/// Returns the process exit code.
pub async fn run_stdio() -> ExitCode {
    let base = forward::resolve_base();

    // 1) Make sure a backend is reachable — auto-start a headless one if not.
    ensure_backend(&base).await;

    // 2) Opt-in per-folder brain: resolve the configured brain name to an id
    //    (creating the brain if needed) so every tool call defaults to it.
    let session_brain = match detect_session_brain_name() {
        Some(name) => match forward::ensure_brain(&base, &name).await {
            Some(id) => {
                eprintln!("[neurovault-mcp] session scoped to brain '{name}' (id={id})");
                Some(id)
            }
            None => {
                eprintln!(
                    "[neurovault-mcp] could not resolve/create brain '{name}'; using the active brain"
                );
                None
            }
        },
        None => None,
    };

    let handler = NeuroVaultMcp::new(session_brain);
    let service = match handler.serve(stdio()).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[neurovault-mcp] failed to start stdio MCP server: {e}");
            return ExitCode::FAILURE;
        }
    };
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

/// Ensure a NeuroVault backend is answering on `base`; auto-start a headless
/// one if not. Critically, this only spawns when the port is confirmed DOWN —
/// the backend's own port-recovery would otherwise kill a running instance on
/// bind-conflict, so we must never spawn a second one over a live backend.
async fn ensure_backend(base: &str) {
    if matches!(
        std::env::var("NEUROVAULT_AUTOSTART").as_deref(),
        Ok("0") | Ok("false") | Ok("off")
    ) {
        return;
    }
    // Already up (desktop app, or a backend a previous session started)?
    if forward::backend_healthy(base).await {
        // The :8765 port is a shared singleton — the desktop app, a prior npx
        // session, or a curl install all bind it and the first wins. If the
        // running backend is a DIFFERENT version than this server, warn loudly:
        // otherwise we'd silently forward every tool call to a stale engine with
        // a possibly-incompatible schema/contract.
        if let Some(live) = forward::backend_version(base).await {
            let mine = env!("CARGO_PKG_VERSION");
            if live != mine {
                eprintln!(
                    "[neurovault-mcp] WARNING: a NeuroVault backend v{live} already owns {base}, \
                     but this server is v{mine}. Tool calls go to the RUNNING v{live} engine — if \
                     that's stale, quit the NeuroVault app or kill the old process, then retry."
                );
            }
        }
        return;
    }
    // Only auto-start a LOCAL backend. A custom remote NEUROVAULT_API_URL means
    // someone else owns the server — we just forward (and surface "down" if so).
    if !is_loopback_backend(base) {
        eprintln!("[neurovault-mcp] {base} unreachable and not local — not auto-starting");
        return;
    }
    let exe = match std::env::current_exe() {
        Ok(e) => e,
        Err(e) => {
            eprintln!("[neurovault-mcp] autostart: cannot locate own executable: {e}");
            return;
        }
    };
    eprintln!(
        "[neurovault-mcp] no backend on {base} — auto-starting a headless one \
         (set NEUROVAULT_AUTOSTART=0 to disable)"
    );
    let requested_port = port_from_base(base).unwrap_or(8765);
    let spawned_pid = match spawn_backend_detached(&exe, Some(requested_port)) {
        Ok(pid) => pid,
        Err(e) => {
            eprintln!("[neurovault-mcp] autostart spawn failed: {e}");
            return;
        }
    };
    // Health comes up quickly (the embedder loads lazily on first recall, not
    // at bind). Give it ~30s. Concurrent sessions that lose the spawn race just
    // wait here for the winner — the loser's backend exits on bind-conflict.
    for _ in 0..60 {
        if let Some(identity) = forward::backend_identity(base).await {
            if identity.pid == spawned_pid {
                if let Err(error) = record_managed_backend(&identity, requested_port) {
                    eprintln!(
                        "[neurovault-mcp] could not record managed backend ownership: {error}"
                    );
                }
            }
            eprintln!("[neurovault-mcp] backend is up");
            return;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    eprintln!(
        "[neurovault-mcp] auto-started backend not healthy within 30s (may still be loading)"
    );
}

/// Spawn `neurovault-server` (HTTP backend) fully detached so it outlives this
/// stdio session and isn't killed when the agent closes the MCP connection.
/// stdout/stderr go to `~/.neurovault/autostart.log` for debugging.
fn spawn_backend_detached(exe: &std::path::Path, port: Option<u16>) -> std::io::Result<u32> {
    let mut cmd = Command::new(exe);
    if let Some(p) = port {
        cmd.arg("--port").arg(p.to_string());
    }
    cmd.stdin(Stdio::null());

    let log_path = nv_home().join("autostart.log");
    let _ = std::fs::create_dir_all(nv_home());
    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        Ok(f) => {
            let err = f.try_clone();
            cmd.stdout(Stdio::from(f));
            match err {
                Ok(e) => {
                    cmd.stderr(Stdio::from(e));
                }
                Err(_) => {
                    cmd.stderr(Stdio::null());
                }
            }
        }
        Err(_) => {
            cmd.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }

    // Detach from this process's group/session so terminating the MCP shim
    // (e.g. the client closing stdin) doesn't take the backend down with it.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }

    let child = cmd.spawn()?; // don't wait — it's a daemon
    Ok(child.id())
}

/// True only for the exact plain-HTTP loopback hosts that a process spawned on
/// this machine can own. Substring checks are unsafe here: a host such as
/// `localhost.example.com` is remote despite containing `localhost`.
fn is_loopback_backend(base: &str) -> bool {
    reqwest::Url::parse(base).is_ok_and(|url| {
        url.scheme() == "http"
            && matches!(
                url.host_str(),
                Some(host)
                    if host.eq_ignore_ascii_case("localhost")
                        || host == "127.0.0.1"
                        || host == "::1"
                        || host == "[::1]"
            )
    })
}

/// Parse the port from a backend URL, using HTTP's default when omitted.
fn port_from_base(base: &str) -> Option<u16> {
    let url = reqwest::Url::parse(base).ok()?;
    url.port_or_known_default()
}

/// Resolve the opt-in per-folder brain *name* (not yet the id). Order:
/// `NEUROVAULT_BRAIN` env, then a `.neurovault` file in the working folder
/// (first non-blank, non-`#` line). `None` → no per-folder scoping.
fn detect_session_brain_name() -> Option<String> {
    if let Ok(v) = std::env::var("NEUROVAULT_BRAIN") {
        let v = v.trim();
        if !v.is_empty() {
            return Some(v.to_string());
        }
    }
    let cwd = std::env::current_dir().ok()?;
    let content = std::fs::read_to_string(cwd.join(".neurovault")).ok()?;
    for line in content.lines() {
        let line = line.trim();
        if !line.is_empty() && !line.starts_with('#') {
            return Some(line.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_parsing() {
        assert_eq!(port_from_base("http://127.0.0.1:8765"), Some(8765));
        assert_eq!(port_from_base("http://127.0.0.1:8801/"), Some(8801));
        assert_eq!(port_from_base("http://localhost"), Some(80));
        assert_eq!(port_from_base("not a url"), None);
    }

    #[test]
    fn autostart_accepts_exact_loopback_hosts_only() {
        assert!(is_loopback_backend("http://127.0.0.1:8765"));
        assert!(is_loopback_backend("http://localhost:8765"));
        assert!(is_loopback_backend("http://[::1]:8765"));
        assert!(!is_loopback_backend("https://127.0.0.1:8765"));
        assert!(!is_loopback_backend("http://localhost.example.com:8765"));
        assert!(!is_loopback_backend("http://127.0.0.1.example.com:8765"));
    }

    #[test]
    fn brain_name_from_env_takes_precedence() {
        std::env::set_var("NEUROVAULT_BRAIN", "  my-project  ");
        assert_eq!(detect_session_brain_name().as_deref(), Some("my-project"));
        std::env::remove_var("NEUROVAULT_BRAIN");
    }
}
