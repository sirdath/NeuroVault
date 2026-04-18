import { useState, useEffect, useCallback } from "react";
import { useSettingsStore, THEMES } from "../stores/settingsStore";

const FONT_SIZES = [
  { label: "Small", value: "small" as const },
  { label: "Medium", value: "medium" as const },
  { label: "Large", value: "large" as const },
];

const SERVER_URL = "http://127.0.0.1:8765";

function useServerStatus() {
  const [online, setOnline] = useState(false);
  const [checking, setChecking] = useState(false);
  const check = useCallback(async () => {
    setChecking(true);
    try {
      const r = await fetch(`${SERVER_URL}/api/brains/active`, { signal: AbortSignal.timeout(3000) });
      setOnline(r.ok);
    } catch { setOnline(false); }
    setChecking(false);
  }, []);
  useEffect(() => { check(); }, [check]);
  return { online, checking, check };
}

export function SettingsView() {
  const { themeId, fontSize, update } = useSettingsStore();
  const { online, checking, check: recheckServer } = useServerStatus();
  const [serverInfo, setServerInfo] = useState<{ notes: number; connections: number; brain: string } | null>(null);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    if (!online) { setServerInfo(null); return; }
    Promise.all([
      fetch(`${SERVER_URL}/api/brains/active`).then((r) => r.json()),
      fetch(`${SERVER_URL}/api/status`).then((r) => r.json()),
    ])
      .then(([brain, status]) => setServerInfo({ notes: status.memories, connections: status.connections, brain: brain.name }))
      .catch(() => setServerInfo(null));
  }, [online]);

  const [starting, setStarting] = useState(false);

  const handleStartServer = async () => {
    setStarting(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke<string>("start_server");
    } catch (e) {
      alert(`Failed to start server: ${e}`);
      setStarting(false);
      return;
    }
    // Poll for up to 60s — first boot takes 10-30s (ONNX model load + vault
    // ingest of all existing notes). Re-check every 2s until it responds.
    const deadline = Date.now() + 60_000;
    const poll = async () => {
      try {
        const r = await fetch(`${SERVER_URL}/api/brains/active`, { signal: AbortSignal.timeout(1500) });
        if (r.ok) {
          recheckServer();
          setStarting(false);
          return;
        }
      } catch { /* not ready yet */ }
      if (Date.now() < deadline) {
        setTimeout(poll, 2000);
      } else {
        setStarting(false);
        alert("Server didn't start within 60 seconds. Check the log or try again.");
      }
    };
    setTimeout(poll, 1000);
  };

  const handleStopServer = async () => {
    setStopping(true);
    // Try BOTH methods — Tauri kills the child we spawned (works for
    // sidecars we started). HTTP /api/shutdown works regardless of who
    // started the server (terminal, external, Tauri-spawned after the
    // app was reopened with a stale state). Running both is safe:
    // whichever actually killed the process wins, the other no-ops.
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke<string>("stop_server").catch(() => null);
    } catch { /* ignore */ }
    try {
      await fetch(`${SERVER_URL}/api/shutdown`, { method: "POST", signal: AbortSignal.timeout(2000) });
    } catch { /* server already down or closed the connection — both fine */ }

    // Poll until the port is actually closed (up to 10s — usually <2s)
    const deadline = Date.now() + 10_000;
    const poll = async () => {
      try {
        await fetch(`${SERVER_URL}/api/brains/active`, { signal: AbortSignal.timeout(500) });
        // Still responding — keep polling
        if (Date.now() < deadline) setTimeout(poll, 500);
        else { recheckServer(); setStopping(false); }
      } catch {
        // Connection refused = server is down
        recheckServer();
        setStopping(false);
      }
    };
    setTimeout(poll, 500);
  };

  return (
    <div className="flex-1 overflow-y-auto" style={{ background: "var(--nv-bg)" }}>
      <div className="mx-auto max-w-[580px] px-8 py-12">
        <h1 className="text-[20px] font-semibold font-[Geist,sans-serif] mb-8" style={{ color: "var(--nv-text)" }}>
          Settings
        </h1>

        {/* Theme */}
        <Section title="Theme">
          <div className="grid grid-cols-2 gap-3">
            {THEMES.map((t) => (
              <button
                key={t.id}
                onClick={() => update({ themeId: t.id })}
                className="relative text-left rounded-xl p-3 transition-all border"
                style={{
                  background: t.bg,
                  borderColor: themeId === t.id ? t.accent : t.border,
                  boxShadow: themeId === t.id ? `0 0 20px ${t.accentGlow}` : undefined,
                }}
              >
                <div className="flex gap-1.5 mb-2.5">
                  <div className="w-4 h-4 rounded-full" style={{ backgroundColor: t.accent }} />
                  <div className="w-4 h-4 rounded-full" style={{ backgroundColor: t.positive }} />
                  <div className="w-4 h-4 rounded-full" style={{ backgroundColor: t.negative }} />
                  <div className="w-4 h-4 rounded-full border" style={{ background: t.surface, borderColor: t.border }} />
                </div>
                <p className="text-[13px] font-medium font-[Geist,sans-serif]" style={{ color: t.text }}>{t.name}</p>
                <p className="text-[11px] font-[Geist,sans-serif] mt-0.5" style={{ color: t.textDim }}>{t.description}</p>
                {themeId === t.id && (
                  <div className="absolute top-2.5 right-2.5 w-2 h-2 rounded-full" style={{ backgroundColor: t.accent }} />
                )}
              </button>
            ))}
          </div>
        </Section>

        {/* Reading */}
        <Section title="Reading">
          <SettingRow label="Font size" description="Body text size in the note preview">
            <div className="flex gap-1 rounded-xl p-1" style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)" }}>
              {FONT_SIZES.map((f) => (
                <button
                  key={f.value}
                  onClick={() => update({ fontSize: f.value })}
                  className="px-3 py-1.5 text-[12px] font-medium font-[Geist,sans-serif] rounded-lg transition-all"
                  style={fontSize === f.value ? {
                    background: "var(--nv-surface)",
                    color: "var(--nv-text)",
                    border: "1px solid var(--nv-border)",
                    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08)",
                  } : { color: "var(--nv-text-dim)" }}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </SettingRow>

        </Section>

        {/* Server */}
        <Section title="Server">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2.5">
              <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: online ? "var(--nv-positive)" : "var(--nv-negative)" }} />
              <span className="text-[13px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>
                {checking ? "Checking..." : online ? "Server running" : "Server offline"}
              </span>
            </div>
            <div className="flex gap-2">
              <button onClick={recheckServer} disabled={checking}
                className="text-[11px] font-medium font-[Geist,sans-serif] px-3 py-1.5 rounded-lg transition-all disabled:opacity-30"
                style={{ border: "1px solid var(--nv-border)", color: "var(--nv-text-muted)" }}>
                Refresh
              </button>
              {!online && (
                <button onClick={handleStartServer} disabled={starting}
                  className="text-[11px] font-medium font-[Geist,sans-serif] px-3 py-1.5 rounded-lg transition-all disabled:opacity-30"
                  style={{ background: "var(--nv-accent)", color: "var(--nv-bg)" }}>
                  {starting ? "Starting..." : "Start Server"}
                </button>
              )}
              {online && (
                <button onClick={handleStopServer} disabled={stopping}
                  className="text-[11px] font-medium font-[Geist,sans-serif] px-3 py-1.5 rounded-lg transition-all disabled:opacity-30"
                  style={{ border: "1px solid var(--nv-negative)", color: "var(--nv-negative)" }}>
                  {stopping ? "Stopping..." : "Stop Server"}
                </button>
              )}
            </div>
          </div>

          {serverInfo && (
            <div className="grid grid-cols-3 gap-3 mb-4">
              <InfoCard label="Brain" value={serverInfo.brain} />
              <InfoCard label="Notes" value={String(serverInfo.notes)} />
              <InfoCard label="Connections" value={String(serverInfo.connections)} />
            </div>
          )}

          <SettingRow label="Address" description="Python backend address">
            <span className="text-[13px] font-mono font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>127.0.0.1:8765</span>
          </SettingRow>
          <SettingRow label="Data" description="Notes and database location">
            <span className="text-[12px] font-mono font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>~/.neurovault/</span>
          </SettingRow>
        </Section>

        <McpSection />

        {/* Shortcuts */}
        <Section title="Keyboard Shortcuts">
          <div className="space-y-2">
            <ShortcutRow keys="Ctrl+K" action="Command palette" />
            <ShortcutRow keys="Ctrl+N" action="New note" />
            <ShortcutRow keys="Ctrl+P" action="Cycle views" />
            <ShortcutRow keys="Ctrl+S" action="Save note" />
            <ShortcutRow keys="Ctrl+/" action="Focus search" />
            <ShortcutRow keys="Ctrl+Shift+K" action="Compilations" />
            <ShortcutRow keys="Ctrl+Shift+Space" action="Quick capture" />
            <ShortcutRow keys="Escape" action="Exit edit mode" />
            <ShortcutRow keys="?" action="Show all shortcuts" />
          </div>
        </Section>

        <Section title="About">
          <p className="text-[13px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>NeuroVault v0.1.0</p>
          <p className="text-[12px] font-[Geist,sans-serif] mt-1" style={{ color: "var(--nv-text-dim)" }}>
            Local-first AI memory system. Your data never leaves your machine.
          </p>
        </Section>
      </div>
    </div>
  );
}

/**
 * MCP setup card — shows the user how to wire NeuroVault into Claude
 * Desktop / Cursor as an MCP server. Auto-detects the sidecar path and
 * the OS-specific Claude config location. The JSON block is kept
 * minimal (just `command`) since more keys are optional and would
 * distract from the copy-paste target.
 */
function McpSection() {
  const [sidecarPath, setSidecarPath] = useState<string>("");
  const [configPath, setConfigPath] = useState<string>("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const [s, c] = await Promise.all([
          invoke<string>("mcp_sidecar_path"),
          invoke<string>("mcp_config_path"),
        ]);
        setSidecarPath(s || "");
        setConfigPath(c || "");
      } catch {
        // Web fallback — nothing to detect
      }
    })();
  }, []);

  const configJson = sidecarPath
    ? JSON.stringify(
        { mcpServers: { neurovault: { command: sidecarPath } } },
        null, 2,
      )
    : "";

  const handleCopy = async () => {
    if (!configJson) return;
    try {
      await navigator.clipboard.writeText(configJson);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

  const handleReveal = async () => {
    if (!configPath) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("reveal_in_file_manager", { path: configPath });
    } catch {
      /* ignore — some platforms don't support reveal */
    }
  };

  return (
    <Section title="Connect Claude Desktop (MCP)">
      {!sidecarPath ? (
        <p className="text-[13px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>
          Sidecar binary not found next to the app. Rebuild and reinstall NeuroVault, then reopen this dialog.
        </p>
      ) : (
        <>
          <div>
            <p className="text-[13px] font-[Geist,sans-serif] mb-1" style={{ color: "var(--nv-text-muted)" }}>
              Paste the snippet below into your Claude Desktop config so Claude can call <span className="font-mono">remember</span> and <span className="font-mono">recall</span> against this vault.
            </p>
            <p className="text-[11px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
              Restart Claude Desktop after saving. If the key <span className="font-mono">mcpServers</span> already exists, merge the <span className="font-mono">neurovault</span> entry into it instead of replacing the whole block.
            </p>
          </div>

          <div className="relative">
            <pre
              className="text-[11.5px] font-mono p-3 rounded-lg overflow-x-auto leading-relaxed"
              style={{ background: "var(--nv-bg)", color: "var(--nv-text)", border: "1px solid var(--nv-border)" }}
            >{configJson}</pre>
            <button
              onClick={handleCopy}
              className="absolute top-2 right-2 text-[10px] uppercase tracking-wider font-[Geist,sans-serif] px-2 py-1 rounded-md transition-colors"
              style={{
                background: copied ? "var(--nv-positive)" : "var(--nv-surface)",
                color: copied ? "var(--nv-bg)" : "var(--nv-text-muted)",
                border: "1px solid var(--nv-border)",
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>

          <SettingRow
            label="Config file"
            description={
              configPath
                ? `Claude Desktop reads this on startup — create it if missing`
                : "Open Claude Desktop once so it creates the config file"
            }
          >
            <button
              onClick={handleReveal}
              disabled={!configPath}
              className="text-[11px] font-medium font-[Geist,sans-serif] px-3 py-1.5 rounded-lg transition-all disabled:opacity-30"
              style={{ border: "1px solid var(--nv-border)", color: "var(--nv-text-muted)" }}
            >
              Show in folder
            </button>
          </SettingRow>
          {configPath && (
            <p
              className="text-[11px] font-mono truncate -mt-2"
              style={{ color: "var(--nv-text-dim)", direction: "rtl", textAlign: "left" }}
              title={configPath}
            >
              {configPath}
            </p>
          )}
        </>
      )}
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-10">
      <h2 className="text-[11px] uppercase tracking-wider font-semibold font-[Geist,sans-serif] mb-4" style={{ color: "var(--nv-text-dim)" }}>{title}</h2>
      <div className="rounded-2xl p-5 space-y-5" style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)", boxShadow: "inset 0 1px 1px rgba(255,255,255,0.04)" }}>
        {children}
      </div>
    </div>
  );
}

function SettingRow({ label, description, children }: { label: string; description: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-[13px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>{label}</p>
        <p className="text-[11px] font-[Geist,sans-serif] mt-0.5" style={{ color: "var(--nv-text-dim)" }}>{description}</p>
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl px-3 py-2.5" style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)" }}>
      <p className="text-[15px] font-semibold font-[Geist,sans-serif] truncate" style={{ color: "var(--nv-text)" }}>{value}</p>
      <p className="text-[10px] font-[Geist,sans-serif] mt-0.5" style={{ color: "var(--nv-text-dim)" }}>{label}</p>
    </div>
  );
}

function ShortcutRow({ keys, action }: { keys: string; action: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[13px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>{action}</span>
      <kbd className="text-[11px] font-mono px-2 py-0.5 rounded-md" style={{ background: "var(--nv-surface)", color: "var(--nv-text-dim)", border: "1px solid var(--nv-border)" }}>{keys}</kbd>
    </div>
  );
}
