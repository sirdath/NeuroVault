import { useState, useEffect, useCallback } from "react";
import { useSettingsStore, THEMES } from "../stores/settingsStore";
import { useDensityStore, type Density } from "../stores/densityStore";
import {
  useGraphSettingsStore,
  PALETTES,
  type GraphPalette,
  type GraphNodeShape,
} from "../stores/graphSettingsStore";
import { activityApi, type AuditEntry } from "../lib/api";
import { API_HOST, API_DISPLAY } from "../lib/config";

const FONT_SIZES = [
  { label: "Small", value: "small" as const },
  { label: "Medium", value: "medium" as const },
  { label: "Large", value: "large" as const },
];

// Sidebar + command-palette row density. Drives `html[data-density]`
// which the CSS uses to pick `--row-h`, `--gap`, `--pad-x`, `--pad-y`.
// Compact fits ~30% more notes in the sidebar at the cost of breathing
// room; comfortable is the default we recommend for daily use.
const DENSITIES: { label: string; value: Density; hint: string }[] = [
  { label: "Comfortable", value: "comfortable", hint: "Default — roomy" },
  { label: "Cozy",        value: "cozy",        hint: "A bit tighter" },
  { label: "Compact",     value: "compact",     hint: "Max rows" },
];

const SERVER_URL = API_HOST;

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
  const density = useDensityStore((s) => s.density);
  const setDensity = useDensityStore((s) => s.setDensity);
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

          <SettingRow label="Interface density" description="Row height + padding for the sidebar and command palette">
            <div className="flex gap-1 rounded-xl p-1" style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)" }}>
              {DENSITIES.map((d) => (
                <button
                  key={d.value}
                  onClick={() => setDensity(d.value)}
                  title={d.hint}
                  className="px-3 py-1.5 text-[12px] font-medium font-[Geist,sans-serif] rounded-lg transition-all"
                  style={density === d.value ? {
                    background: "var(--nv-surface)",
                    color: "var(--nv-text)",
                    border: "1px solid var(--nv-border)",
                    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08)",
                  } : { color: "var(--nv-text-dim)" }}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </SettingRow>

        </Section>

        <GraphSection />

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
            <span className="text-[13px] font-mono font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>{API_DISPLAY}</span>
          </SettingRow>
          <SettingRow label="Data" description="Notes and database location">
            <span className="text-[12px] font-mono font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>~/.neurovault/</span>
          </SettingRow>
        </Section>

        <McpSection />
        <ClaudeCodeMcpSection />

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
 * Settings section for the graph view's user-pickable visual options.
 * Three controls: palette (4 presets), node shape (3 options), and
 * "show all folder labels" toggle. All persist to localStorage via
 * useGraphSettingsStore. Changes apply live — the graph rerenders as
 * the user clicks because it subscribes to the same store.
 */
function GraphSection() {
  const palette = useGraphSettingsStore((s) => s.palette);
  const setPalette = useGraphSettingsStore((s) => s.setPalette);
  const nodeShape = useGraphSettingsStore((s) => s.nodeShape);
  const setNodeShape = useGraphSettingsStore((s) => s.setNodeShape);
  const showClusterLabels = useGraphSettingsStore((s) => s.showClusterLabels);
  const setShowClusterLabels = useGraphSettingsStore((s) => s.setShowClusterLabels);
  // Per-layer Analytics defaults — control which overlays light up
  // when the user flips the in-graph Analytics toggle.
  const analyticsResizeByImportance = useGraphSettingsStore((s) => s.analyticsResizeByImportance);
  const setAnalyticsResizeByImportance = useGraphSettingsStore((s) => s.setAnalyticsResizeByImportance);
  const analyticsGroupByCommunity = useGraphSettingsStore((s) => s.analyticsGroupByCommunity);
  const setAnalyticsGroupByCommunity = useGraphSettingsStore((s) => s.setAnalyticsGroupByCommunity);

  const PALETTE_LABELS: { value: GraphPalette; label: string; hint: string }[] = [
    { value: "warm",  label: "Warm",  hint: "Peach + cohesive cools (default)" },
    { value: "cool",  label: "Cool",  hint: "Blues, teals, violets" },
    { value: "mono",  label: "Mono",  hint: "Single hue gradient" },
    { value: "vivid", label: "Vivid", hint: "High-saturation, demo-ready" },
  ];

  const SHAPE_LABELS: { value: GraphNodeShape; label: string }[] = [
    { value: "circle", label: "Circle" },
    { value: "square", label: "Square" },
    { value: "hex",    label: "Hex" },
  ];

  return (
    <Section title="Graph">
      <SettingRow label="Palette" description="Folder colors in the graph view">
        <div className="grid grid-cols-2 gap-2 w-full">
          {PALETTE_LABELS.map((p) => {
            const colors = PALETTES[p.value];
            const selected = palette === p.value;
            return (
              <button
                key={p.value}
                onClick={() => setPalette(p.value)}
                title={p.hint}
                className="text-left rounded-lg p-2.5 transition-all border"
                style={{
                  background: "var(--nv-surface)",
                  borderColor: selected ? "var(--nv-accent)" : "var(--nv-border)",
                  boxShadow: selected ? "0 0 14px var(--nv-accent-glow)" : undefined,
                }}
              >
                <div className="flex gap-1 mb-2">
                  {colors.slice(0, 6).map((c, i) => (
                    <span
                      key={i}
                      className="w-3.5 h-3.5 rounded-full"
                      style={{ background: c }}
                    />
                  ))}
                </div>
                <p className="text-[12px] font-medium font-[Geist,sans-serif]" style={{ color: "var(--nv-text)" }}>
                  {p.label}
                </p>
                <p className="text-[10px] font-[Geist,sans-serif] mt-0.5" style={{ color: "var(--nv-text-muted)" }}>
                  {p.hint}
                </p>
              </button>
            );
          })}
        </div>
      </SettingRow>

      <SettingRow label="Node shape" description="Geometry of each node on the canvas">
        <div className="flex gap-1 rounded-xl p-1" style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)" }}>
          {SHAPE_LABELS.map((s) => (
            <button
              key={s.value}
              onClick={() => setNodeShape(s.value)}
              className="px-3 py-1.5 text-[12px] font-medium font-[Geist,sans-serif] rounded-lg transition-all"
              style={nodeShape === s.value ? {
                background: "var(--nv-surface)",
                color: "var(--nv-text)",
                border: "1px solid var(--nv-border)",
                boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08)",
              } : { color: "var(--nv-text-muted)" }}
            >
              {s.label}
            </button>
          ))}
        </div>
      </SettingRow>

      <SettingRow
        label="Show all folder labels"
        description="By default, only the cluster you hover gets labelled. Turn on to label every cluster permanently."
      >
        <ToggleSwitch
          on={showClusterLabels}
          onChange={() => setShowClusterLabels(!showClusterLabels)}
          ariaLabel="Toggle folder labels"
        />
      </SettingRow>

      {/* Analytics defaults — control which Analytics-mode overlays
          light up when the user flips the in-graph Analytics pill.
          Both default ON; users who only want one half (e.g. node
          sizing without the tints) opt the other off here. */}
      <div
        className="text-[11px] uppercase tracking-wider mt-6 mb-2 font-[Geist,sans-serif]"
        style={{ color: "var(--nv-text-muted)" }}
      >
        Analytics defaults
      </div>
      <SettingRow
        label="Resize nodes by importance"
        description="Bigger nodes for notes that other notes link to more often (PageRank). Only shows in Analytics mode."
      >
        <ToggleSwitch
          on={analyticsResizeByImportance}
          onChange={() => setAnalyticsResizeByImportance(!analyticsResizeByImportance)}
          ariaLabel="Toggle node-size by importance"
        />
      </SettingRow>
      <SettingRow
        label="Group notes by community"
        description="Soft background tints behind notes that link to each other a lot. Only shows in Analytics mode."
      >
        <ToggleSwitch
          on={analyticsGroupByCommunity}
          onChange={() => setAnalyticsGroupByCommunity(!analyticsGroupByCommunity)}
          ariaLabel="Toggle community grouping"
        />
      </SettingRow>
    </Section>
  );
}

/** Small reusable iOS-style toggle. Extracted so the three toggles
 *  in this section don't repeat their own DOM. */
function ToggleSwitch({
  on,
  onChange,
  ariaLabel,
}: {
  on: boolean;
  onChange: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      onClick={onChange}
      className="relative w-10 h-6 rounded-full transition-colors"
      style={{
        background: on ? "var(--nv-accent)" : "var(--nv-surface)",
        border: "1px solid var(--nv-border)",
      }}
      aria-label={ariaLabel}
      aria-pressed={on}
    >
      <span
        className="absolute top-0.5 left-0.5 w-[18px] h-[18px] rounded-full transition-transform"
        style={{
          background: on ? "var(--nv-bg)" : "var(--nv-text-muted)",
          transform: on ? "translateX(16px)" : "translateX(0)",
        }}
      />
    </button>
  );
}

/**
 * Live indicator of whether an MCP client (Claude Desktop, Cursor, …)
 * is actually talking to the server right now. Reads the audit log —
 * any entry whose tool does not start with "http:" is an MCP call,
 * because HTTP routes are prefixed by the audit middleware and MCP
 * tool calls land bare ("remember", "recall", etc).
 *
 * Three visual states tell a clear story in a demo:
 *   • green pulse + "Connected · last call Ns ago"   (<= 60s)
 *   • amber dot   + "Idle · last call Nm ago"        (between 60s and 30min)
 *   • gray dot    + "Not connected yet"              (no MCP call ever seen)
 */
function McpConnectionBadge() {
  const [lastMcp, setLastMcp] = useState<AuditEntry | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const entries = await activityApi.recent(50);
        const mcp = entries.find((e) => !e.tool.startsWith("http:"));
        if (!cancelled) setLastMcp(mcp ?? null);
      } catch { /* server down — handled by the parent banner */ }
    };
    load();
    const poll = setInterval(load, 3000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { cancelled = true; clearInterval(poll); clearInterval(tick); };
  }, []);

  const ageMs = lastMcp ? now - Date.parse(lastMcp.ts) : Number.POSITIVE_INFINITY;
  const state: "live" | "idle" | "never" = !lastMcp
    ? "never"
    : ageMs <= 60_000 ? "live" : "idle";

  const color = state === "live"
    ? "var(--nv-positive)"
    : state === "idle" ? "var(--nv-accent)" : "var(--nv-text-dim)";
  const pulse = state === "live";

  let label: string;
  if (state === "never") {
    label = "Not connected yet — finish the setup below and restart Claude Desktop";
  } else if (state === "live") {
    const s = Math.max(0, Math.round(ageMs / 1000));
    label = `Connected · last call ${s}s ago (${lastMcp!.tool})`;
  } else {
    const m = Math.round(ageMs / 60_000);
    label = `Idle · last call ${m} min ago (${lastMcp!.tool})`;
  }

  return (
    <div
      className="flex items-center gap-2.5 px-3 py-2 rounded-lg"
      style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)" }}
    >
      <span
        className={`w-2 h-2 rounded-full ${pulse ? "animate-pulse" : ""}`}
        style={{
          backgroundColor: color,
          boxShadow: pulse ? `0 0 6px ${color}` : undefined,
        }}
      />
      <span className="text-[12px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text)" }}>
        {label}
      </span>
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
      <McpConnectionBadge />
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

/**
 * MCP setup for Claude Code — the terminal CLI, not Claude Desktop.
 * Claude Code stores user-scope MCP servers in ~/.claude.json (not
 * ~/.claude/settings.json) and the canonical registration path is
 * ``claude mcp add --scope user <name> <cmd> -- <args...>``. The UI
 * shows both the one-line CLI command (to copy into a terminal) and
 * the raw JSON snippet (for users who prefer to edit the file).
 *
 * The server is invoked in --mcp-only mode (no HTTP) so it doesn't
 * race the Tauri sidecar for port 8765 and so the stdio handshake
 * lands fast without waiting for embedder warmup.
 */
function ClaudeCodeMcpSection() {
  const [sidecarPath, setSidecarPath] = useState<string>("");
  const [copiedCli, setCopiedCli] = useState(false);
  const [copiedJson, setCopiedJson] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const s = await invoke<string>("mcp_sidecar_path");
        setSidecarPath(s || "");
      } catch {
        /* web fallback */
      }
    })();
  }, []);

  const cliCommand = sidecarPath
    ? `claude mcp add --scope user neurovault "${sidecarPath}" -- --mcp-only`
    : "";

  const jsonSnippet = sidecarPath
    ? JSON.stringify(
        {
          mcpServers: {
            neurovault: {
              type: "stdio",
              command: sidecarPath,
              args: ["--mcp-only"],
            },
          },
        },
        null,
        2,
      )
    : "";

  const copy = async (text: string, setFlag: (v: boolean) => void) => {
    try {
      await navigator.clipboard.writeText(text);
      setFlag(true);
      setTimeout(() => setFlag(false), 2000);
    } catch {
      /* ignore */
    }
  };

  return (
    <Section title="Connect Claude Code (MCP)">
      {!sidecarPath ? (
        <p className="text-[13px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>
          Sidecar binary not found next to the app. Rebuild and reinstall NeuroVault.
        </p>
      ) : (
        <>
          <div>
            <p className="text-[13px] font-[Geist,sans-serif] mb-1" style={{ color: "var(--nv-text-muted)" }}>
              Run the one-line command below so Claude Code (the terminal CLI) can call <span className="font-mono">remember</span> and <span className="font-mono">recall</span> against this vault in every project you open.
            </p>
            <p className="text-[11px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
              Requires the <span className="font-mono">claude</span> CLI on your <span className="font-mono">PATH</span>. The registration lives in <span className="font-mono">~/.claude.json</span>. Restart your Claude Code session after registering.
            </p>
          </div>

          <div className="relative">
            <pre
              className="text-[11.5px] font-mono p-3 rounded-lg overflow-x-auto leading-relaxed"
              style={{ background: "var(--nv-bg)", color: "var(--nv-text)", border: "1px solid var(--nv-border)" }}
            >{cliCommand}</pre>
            <button
              onClick={() => copy(cliCommand, setCopiedCli)}
              className="absolute top-2 right-2 text-[10px] uppercase tracking-wider font-[Geist,sans-serif] px-2 py-1 rounded-md transition-colors"
              style={{
                background: copiedCli ? "var(--nv-positive)" : "var(--nv-surface)",
                color: copiedCli ? "var(--nv-bg)" : "var(--nv-text-muted)",
                border: "1px solid var(--nv-border)",
              }}
            >
              {copiedCli ? "Copied" : "Copy command"}
            </button>
          </div>

          <details className="group">
            <summary className="text-[11px] font-[Geist,sans-serif] cursor-pointer select-none" style={{ color: "var(--nv-text-dim)" }}>
              Prefer to edit <span className="font-mono">~/.claude.json</span> by hand? Show the raw JSON snippet →
            </summary>
            <div className="relative mt-2">
              <pre
                className="text-[11.5px] font-mono p-3 rounded-lg overflow-x-auto leading-relaxed"
                style={{ background: "var(--nv-bg)", color: "var(--nv-text)", border: "1px solid var(--nv-border)" }}
              >{jsonSnippet}</pre>
              <button
                onClick={() => copy(jsonSnippet, setCopiedJson)}
                className="absolute top-2 right-2 text-[10px] uppercase tracking-wider font-[Geist,sans-serif] px-2 py-1 rounded-md transition-colors"
                style={{
                  background: copiedJson ? "var(--nv-positive)" : "var(--nv-surface)",
                  color: copiedJson ? "var(--nv-bg)" : "var(--nv-text-muted)",
                  border: "1px solid var(--nv-border)",
                }}
              >
                {copiedJson ? "Copied" : "Copy JSON"}
              </button>
            </div>
          </details>
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
