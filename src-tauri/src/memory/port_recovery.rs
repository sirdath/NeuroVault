//! Self-heal on bind-failure when the port is held by a stale
//! NeuroVault instance.
//!
//! The bug this exists to fix: a previous `neurovault.exe` (Tauri
//! app) or `neurovault-server.exe` crashed without releasing its
//! socket, OR is still running but unresponsive. The next launch
//! tries to bind 127.0.0.1:8765, fails with AddrInUse, and exits
//! silently from the user's POV — they double-click the icon and
//! nothing happens.
//!
//! Fix: on bind failure, look up the port's holder PID, resolve
//! its name, and kill it ONLY IF the name matches a known
//! NeuroVault binary (`neurovault*`). Anything else gets reported
//! to the caller untouched — we never kill arbitrary processes.
//!
//! Platform note: the lookup uses `netstat2` + `sysinfo`. `netstat2`
//! 0.9 doesn't compile on Linux (libc `tcp_info` mismatch), so on
//! Linux this module degrades to a no-op — the caller just surfaces
//! the original bind error. Windows (the primary target) and macOS
//! keep the auto-recovery. Gated on `target_os` rather than `windows`
//! so macOS is unaffected.

#[cfg(not(target_os = "linux"))]
mod imp {
    use netstat2::{
        get_sockets_info, AddressFamilyFlags, ProtocolFlags, ProtocolSocketInfo, TcpState,
    };
    use sysinfo::{Pid, System};

    /// Names we'll terminate. Match-prefix, case-insensitive — covers
    /// `neurovault.exe`, `neurovault-server.exe`, `neurovault-api.exe`,
    /// `neurovault` on Unix, etc. Anything that doesn't start with
    /// "neurovault" is considered "not ours" and left alone.
    const KILL_PREFIX: &str = "neurovault";

    /// Inspect `port` on loopback + IPv6, find the holder's PID, look
    /// up its name. Returns `Some(pid)` if a `neurovault*` is holding
    /// it; `None` if the port is free OR held by a non-NeuroVault
    /// process (left alone).
    pub fn try_clear_stale_neurovault(port: u16) -> Option<u32> {
        let pids = match find_listener_pids(port) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[port_recovery] netstat lookup failed: {}", e);
                return None;
            }
        };
        if pids.is_empty() {
            // Port is bindable but bind() still failed for some reason
            // — let the caller surface the original error.
            return None;
        }

        // Resolve names. We only need a single sysinfo refresh for all
        // candidate PIDs.
        let mut sys = System::new();
        sys.refresh_processes();

        let our_pid = std::process::id();
        for pid in pids {
            if pid == our_pid {
                // Shouldn't happen — we wouldn't be calling this if we
                // were already bound — but never kill ourselves.
                continue;
            }
            let Some(proc) = sys.process(Pid::from(pid as usize)) else {
                // PID listed by netstat but gone by the time sysinfo
                // refreshed. Race; nothing to do.
                continue;
            };
            let name_lc = proc.name().to_lowercase();
            if !name_lc.starts_with(KILL_PREFIX) {
                eprintln!(
                    "[port_recovery] port {} held by {:?} (pid {}) — not a neurovault process, leaving alone",
                    port, name_lc, pid,
                );
                continue;
            }
            eprintln!(
                "[port_recovery] killing stale {:?} (pid {}) holding port {}",
                name_lc, pid, port,
            );
            if proc.kill() {
                return Some(pid);
            } else {
                eprintln!("[port_recovery] kill failed for pid {}", pid);
            }
        }
        None
    }

    /// Listener-PID lookup. Walks every TCP socket in LISTEN state on
    /// loopback + IPv6 and collects the PIDs whose `local_port` matches.
    pub(super) fn find_listener_pids(port: u16) -> Result<Vec<u32>, String> {
        let af = AddressFamilyFlags::IPV4 | AddressFamilyFlags::IPV6;
        let proto = ProtocolFlags::TCP;
        let sockets = get_sockets_info(af, proto).map_err(|e| e.to_string())?;
        let mut pids = Vec::new();
        for s in sockets {
            if let ProtocolSocketInfo::Tcp(tcp) = &s.protocol_socket_info {
                if tcp.local_port == port && tcp.state == TcpState::Listen {
                    pids.extend(s.associated_pids.iter().copied());
                }
            }
        }
        Ok(pids)
    }
}

/// Linux build: `netstat2` 0.9 won't compile, so auto-recovery is a
/// no-op. The caller falls back to surfacing the original bind error.
#[cfg(target_os = "linux")]
mod imp {
    pub fn try_clear_stale_neurovault(_port: u16) -> Option<u32> {
        None
    }
}

pub use imp::try_clear_stale_neurovault;

// ---------------------------------------------------------------------------
// Tests — sanity only; the kill path is too system-specific to
// exercise in unit tests without spawning real subprocesses.
// ---------------------------------------------------------------------------

#[cfg(all(test, not(target_os = "linux")))]
mod tests {
    #[test]
    fn empty_when_port_unbound() {
        // 1 is reserved (port 1 → tcpmux). On any normal dev box
        // nothing is listening here. find_listener_pids should
        // return Ok(vec![]).
        let pids = super::imp::find_listener_pids(1).unwrap_or_default();
        assert!(
            pids.is_empty(),
            "expected port 1 to be unbound, got pids: {:?}",
            pids
        );
    }
}
