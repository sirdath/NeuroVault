/* The "minitab" — a small, frameless, always-on-top floating control for the
 * NeuroVault backend. Lets you see at a glance whether memory is on, toggle it
 * (start / pause), and open the full app — without the full window.
 *
 * Two ways to get it out of the way:
 *   • Shrink to logo  → collapses the card down to a tiny logo "puck" (just the
 *                       brand + a status dot). Click the puck to expand again.
 *   • Hide            → hides the window entirely. Bring it back with the
 *                       global shortcut (Ctrl/Cmd+Shift+Space) or from the app.
 *
 * Rendered into a separate Tauri window that loads the bundle with
 * `?view=minitab` (see main.tsx). The window itself is transparent; this card
 * floats inside it. The top strip is a drag region so you can reposition it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { API_HOST } from "../lib/config";
import logo from "../assets/vault-mark.png";

type State = "on" | "off" | "busy";

const ACCENT = "#2D7FF9";

export function Minitab() {
  const [state, setState] = useState<State>("off");
  const [collapsed, setCollapsed] = useState(false);
  const busyRef = useRef(false);

  const probe = useCallback(async () => {
    if (busyRef.current) return;
    try {
      const r = await fetch(`${API_HOST}/api/health`, {
        signal: AbortSignal.timeout(1500),
      });
      setState(r.ok ? "on" : "off");
    } catch {
      setState("off");
    }
  }, []);

  useEffect(() => {
    probe();
    const id = setInterval(probe, 2500);
    return () => clearInterval(id);
  }, [probe]);

  const toggle = useCallback(async () => {
    busyRef.current = true;
    setState("busy");
    try {
      if (state === "on") {
        await invoke("nv_stop_rust_server");
        setState("off");
      } else {
        await invoke("nv_start_rust_server", { port: null }).catch((e: unknown) => {
          // "already running" just means it's on.
          if (!String(e).toLowerCase().includes("already running")) throw e;
        });
        setState("on");
      }
    } catch {
      // leave state for the next probe to correct
    } finally {
      busyRef.current = false;
      setTimeout(probe, 400);
    }
  }, [state, probe]);

  const openApp = useCallback(() => {
    invoke("open_main_window").catch(() => {});
  }, []);

  // Resize the OS window to match the layout, then flip the React view.
  const setCollapsedBoth = useCallback((next: boolean) => {
    invoke("set_minitab_collapsed", { collapsed: next }).catch(() => {});
    setCollapsed(next);
  }, []);

  const hide = useCallback(() => {
    invoke("hide_minitab").catch(() => {});
  }, []);

  const on = state === "on";
  const busy = state === "busy";
  const dot = busy ? "#f4b942" : on ? "#34d399" : "#6b7280";
  const label = busy ? "Switching…" : on ? "Memory on" : "Paused";

  // ── Collapsed: a tiny logo "puck". Click to expand. The status dot rides
  //    the corner so you still see at a glance whether memory is on. ──
  if (collapsed) {
    return (
      <div
        style={{
          height: "100vh",
          width: "100vw",
          background: "transparent",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 6,
          boxSizing: "border-box",
          userSelect: "none",
        }}
      >
        <button
          onClick={() => setCollapsedBoth(false)}
          title="Expand NeuroVault"
          style={{
            position: "relative",
            width: 48,
            height: 48,
            padding: 0,
            border: "1px solid rgba(255,255,255,0.10)",
            borderRadius: 14,
            background: "rgba(17, 19, 24, 0.86)",
            backdropFilter: "blur(18px)",
            WebkitBackdropFilter: "blur(18px)",
            boxShadow: "0 6px 22px rgba(0,0,0,0.45)",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <img
            src={logo}
            alt="NeuroVault"
            width={32}
            height={32}
            draggable={false}
            style={{ borderRadius: 9, display: "block" }}
          />
          <span
            style={{
              position: "absolute",
              right: -2,
              bottom: -2,
              width: 11,
              height: 11,
              borderRadius: "50%",
              background: dot,
              border: "2px solid rgba(17,19,24,0.95)",
              boxShadow: on ? `0 0 6px ${dot}` : "none",
              transition: "background 0.2s",
            }}
          />
        </button>
      </div>
    );
  }

  // ── Expanded: the full control card. ──
  return (
    <div
      style={{
        height: "100vh",
        width: "100vw",
        background: "transparent",
        display: "flex",
        padding: 8,
        boxSizing: "border-box",
        fontFamily:
          "Geist, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        userSelect: "none",
        cursor: "default",
      }}
    >
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          padding: "10px 12px",
          borderRadius: 16,
          background: "rgba(17, 19, 24, 0.86)",
          backdropFilter: "blur(18px)",
          WebkitBackdropFilter: "blur(18px)",
          border: "1px solid rgba(255,255,255,0.08)",
          boxShadow: "0 8px 30px rgba(0,0,0,0.45)",
          color: "#e8eaed",
        }}
      >
        {/* header / drag strip */}
        <div
          data-tauri-drag-region
          style={{ display: "flex", alignItems: "center", gap: 11 }}
        >
          <img
            src={logo}
            alt=""
            width={40}
            height={40}
            draggable={false}
            style={{ borderRadius: 11, flexShrink: 0 }}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: 15, fontWeight: 650, letterSpacing: 0.2 }}>NeuroVault</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: dot,
                  boxShadow: on ? `0 0 6px ${dot}` : "none",
                  transition: "background 0.2s",
                  flexShrink: 0,
                }}
              />
              <span style={{ fontSize: 11, color: "#9aa0aa" }}>{label}</span>
            </span>
          </div>

          {/* window controls: shrink-to-logo + hide */}
          <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
            <IconButton onClick={() => setCollapsedBoth(true)} title="Shrink to logo">
              {/* minimize-2: arrows pulling inward */}
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 14 10 14 10 20" />
                <polyline points="20 10 14 10 14 4" />
                <line x1="14" y1="10" x2="21" y2="3" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            </IconButton>
            <IconButton onClick={hide} title="Hide (Ctrl/Cmd+Shift+Space to bring back)">
              {/* eye-off */}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                <line x1="2" y1="2" x2="22" y2="22" />
              </svg>
            </IconButton>
          </div>
        </div>

        {/* controls */}
        <div style={{ display: "flex", gap: 6 }}>
          <button
            onClick={toggle}
            disabled={busy}
            style={{
              flex: 1,
              height: 30,
              borderRadius: 9,
              border: "none",
              cursor: busy ? "default" : "pointer",
              fontSize: 12,
              fontWeight: 600,
              color: on ? "#e8eaed" : "#fff",
              background: on ? "rgba(255,255,255,0.08)" : ACCENT,
              transition: "background 0.15s, opacity 0.15s",
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? "…" : on ? "Pause" : "Start"}
          </button>
          <button
            onClick={openApp}
            title="Open the full NeuroVault app"
            style={{
              flex: 1,
              height: 30,
              borderRadius: 9,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "transparent",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
              color: "#cdd2da",
            }}
          >
            Open app
          </button>
        </div>
      </div>
    </div>
  );
}

/* Small square icon button for the header (shrink / hide). Subtle until
 * hovered, so the card stays clean. */
function IconButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 24,
        height: 24,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        borderRadius: 7,
        border: "none",
        cursor: "pointer",
        background: hover ? "rgba(255,255,255,0.10)" : "transparent",
        color: hover ? "#e8eaed" : "#9aa0aa",
        transition: "background 0.12s, color 0.12s",
      }}
    >
      {children}
    </button>
  );
}
