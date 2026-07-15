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
import { useSettingsStore } from "../stores/settingsStore";
import logo from "../assets/vault-mark-transparent.png";

type State = "on" | "off" | "busy";

export function Minitab() {
  const [state, setState] = useState<State>("off");
  const [collapsed, setCollapsed] = useState(false);
  const busyRef = useRef(false);
  const theme = useSettingsStore((settings) => settings.theme);
  const syncThemeFromStorage = useSettingsStore((settings) => settings.syncFromStorage);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === "nv.settings") syncThemeFromStorage();
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [syncThemeFromStorage]);

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
  const dot = busy ? theme.warning : on ? theme.positive : theme.textDim;
  const label = busy ? "Switching…" : on ? "Memory on" : "Paused";
  const translucentCard = `color-mix(in srgb, ${theme.surfaceElevated} 92%, transparent)`;

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
            border: `1px solid ${theme.border}`,
            borderRadius: 14,
            background: translucentCard,
            backdropFilter: "blur(18px)",
            WebkitBackdropFilter: "blur(18px)",
            boxShadow: theme.shadow,
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
            style={{ display: "block", filter: `drop-shadow(0 3px 8px ${theme.accent}55)` }}
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
              border: `2px solid ${theme.surfaceElevated}`,
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
          background: translucentCard,
          backdropFilter: "blur(18px)",
          WebkitBackdropFilter: "blur(18px)",
          border: `1px solid ${theme.border}`,
          boxShadow: theme.shadow,
          color: theme.text,
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
            style={{ flexShrink: 0, filter: `drop-shadow(0 3px 10px ${theme.accent}44)` }}
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
              <span style={{ fontSize: 11, color: theme.textMuted }}>{label}</span>
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
              color: on ? theme.text : theme.onAccent,
              background: on ? theme.surface2 : theme.accent,
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
              border: `1px solid ${theme.border}`,
              background: "transparent",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
              color: theme.textMuted,
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
        background: hover ? "var(--nv-surface-2)" : "transparent",
        color: hover ? "var(--nv-text)" : "var(--nv-text-muted)",
        transition: "background 0.12s, color 0.12s",
      }}
    >
      {children}
    </button>
  );
}
