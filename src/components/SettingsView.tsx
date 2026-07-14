import { useState, useEffect, useCallback } from "react";
import { useSettingsStore, THEMES } from "../stores/settingsStore";
import { useDensityStore, type Density } from "../stores/densityStore";
import { activityApi, type AuditEntry } from "../lib/api";
import { API_HOST, API_DISPLAY } from "../lib/config";
import { useUpdateStore } from "../stores/updateStore";
import MemoryInspector from "./MemoryInspector";
import { BrainSelector } from "./BrainSelector";
import { toast } from "../stores/toastStore";
import { useConsumerHealthStore } from "../stores/consumerHealthStore";
import { ConfirmDialog } from "./ConfirmDialog";
import vaultMark from "../assets/vault-mark.png";


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

export function SettingsView() {
  const [settingsTab, setSettingsTab] = useState<"general" | "connections" | "memory" | "vaults" | "privacy" | "advanced">("general");
  const { themeId, fontSize, checkForUpdatesAutomatically, update } = useSettingsStore();
  const density = useDensityStore((s) => s.density);
  const setDensity = useDensityStore((s) => s.setDensity);
  const healthSignals = useConsumerHealthStore((state) => state.signals);
  const checking = useConsumerHealthStore((state) => state.refreshing) || healthSignals.service === "checking";
  const recheckServer = useConsumerHealthStore((state) => state.refresh);
  const online = healthSignals.service === "online";
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
      // In-process Rust backend (the Python sidecar was retired).
      // `port: null` lets the Rust side default to 8765.
      await invoke<string>("nv_start_rust_server", { port: null });
    } catch (e) {
      // "already running" means the in-process server was started by
      // the boot-time auto-start and the panel just hadn't caught up
      // yet. That's exactly the state the user wanted, so we treat it
      // as success: re-check, drop the starting spinner, no alert.
      const msg = String(e);
      if (msg.toLowerCase().includes("already running")) {
        recheckServer();
        setStarting(false);
        return;
      }
      toast.error(`Failed to start the local memory service: ${String(e)}`);
      setStarting(false);
      return;
    }
    // Poll for up to 60s — first boot takes 10-30s (ONNX model load +
    // vault ingest of all existing notes). Subsequent restarts are
    // typically <2s but the longer deadline is harmless.
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
        toast.error("The local memory service did not start within 60 seconds. Restart NeuroVault or open Advanced diagnostics.");
      }
    };
    setTimeout(poll, 1000);
  };

  const handleStopServer = async () => {
    setStopping(true);
    // Drop the in-process Rust HTTP server. The Tauri command takes
    // the live ServerHandle from RustServerState and `.stop()`s it,
    // so the Settings toggle stays consistent with the actual state.
    // The `/api/shutdown` HTTP path is kept as a belt-and-braces
    // fallback for the case where the user is running an older app
    // version where RustServerState wasn't tracking the handle.
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("nv_stop_rust_server").catch(() => null);
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
    <div className="flex min-h-full" style={{ background: "var(--nv-bg)" }}>
      <aside className="nv-main-navigation sticky top-0 h-full min-h-[80vh] w-[210px] shrink-0 px-4 py-10" aria-label="Settings sections">
        <div className="mb-6 flex items-center gap-2.5 px-2">
          <img src={vaultMark} alt="" className="h-8 w-8 object-contain" style={{ mixBlendMode: "lighten" }} />
          <h1 className="font-[Georgia,serif] text-[19px] font-semibold" style={{ color: "var(--nv-nav-text)" }}>Settings</h1>
        </div>
        <nav className="space-y-1">
          {([
            ["general", "General"],
            ["connections", "Connections"],
            ["memory", "Memory"],
            ["vaults", "Vaults"],
            ["privacy", "Privacy & Trust"],
            ["advanced", "Advanced"],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setSettingsTab(id)}
              aria-current={settingsTab === id ? "page" : undefined}
              className="nv-nav-item w-full rounded-lg px-3 py-2 text-left text-[12px] font-medium"
              style={{ color: settingsTab === id ? "var(--nv-nav-text)" : "var(--nv-nav-muted)", background: settingsTab === id ? "var(--nv-nav-active)" : "transparent" }}
            >
              {label}
            </button>
          ))}
        </nav>
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[760px] px-10 py-12">
        <h2 className="mb-8 font-[Georgia,serif] text-[28px] font-semibold tracking-[-0.02em]" style={{ color: "var(--nv-text)" }}>
          {settingsTab === "general" ? "General" : settingsTab === "connections" ? "Connections" : settingsTab === "memory" ? "Memory" : settingsTab === "vaults" ? "Vaults" : settingsTab === "privacy" ? "Privacy & Trust" : "Advanced"}
        </h2>

        {/* Theme */}
        {settingsTab === "general" && <>
        <Section title="Theme">
          <div className="grid grid-cols-2 gap-3">
            {THEMES.map((t) => (
              <button
                key={t.id}
                onClick={() => update({ themeId: t.id })}
                className="relative min-h-[132px] text-left rounded-2xl p-4 transition-all border"
                style={{
                  background: t.bg,
                  borderColor: themeId === t.id ? t.accent : t.border,
                  boxShadow: themeId === t.id ? `0 0 0 2px ${t.accentGlow}, ${t.shadow}` : undefined,
                }}
              >
                <div className="mb-3 flex h-8 overflow-hidden rounded-lg" style={{ border: `1px solid ${t.border}` }}>
                  <div className="w-[28%]" style={{ background: t.navBg }} />
                  <div className="flex-1" style={{ background: t.bg }} />
                  <div className="w-[22%]" style={{ background: t.surface }} />
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
                    background: "var(--nv-surface-elevated)",
                    color: "var(--nv-text)",
                    border: "1px solid var(--nv-border)",
                    boxShadow: "0 1px 2px color-mix(in srgb, var(--nv-text) 8%, transparent)",
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
                    background: "var(--nv-surface-elevated)",
                    color: "var(--nv-text)",
                    border: "1px solid var(--nv-border)",
                    boxShadow: "0 1px 2px color-mix(in srgb, var(--nv-text) 8%, transparent)",
                  } : { color: "var(--nv-text-dim)" }}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </SettingRow>

          <SettingRow
            label="Automatic update checks"
            description="Off by default. When enabled, NeuroVault asks GitHub Releases for the latest version after launch; no vault content or install identifier is sent."
          >
            <button
              type="button"
              role="switch"
              aria-checked={checkForUpdatesAutomatically}
              onClick={() => update({ checkForUpdatesAutomatically: !checkForUpdatesAutomatically })}
              className="relative h-6 w-11 rounded-full transition-colors"
              style={{ background: checkForUpdatesAutomatically ? "var(--nv-accent)" : "var(--nv-border)" }}
            >
              <span
                className="absolute top-1 h-4 w-4 rounded-full transition-transform"
                style={{
                  left: 4,
                  background: checkForUpdatesAutomatically ? "var(--nv-bg)" : "var(--nv-text-muted)",
                  transform: checkForUpdatesAutomatically ? "translateX(20px)" : "translateX(0)",
                }}
              />
              <span className="sr-only">Automatically check GitHub for new releases</span>
            </button>
          </SettingRow>

        </Section>
        </>}

        {/* Graph appearance settings (palette, node shape, analytics
            overlay layers) moved to the in-graph Filters panel in
            v0.1.8 — open the graph view and click the Filters pill in
            the top-right toolbar. */}

        {settingsTab === "advanced" && <>
        {/* Local service */}
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
              <InfoCard label="Vault" value={serverInfo.brain} />
              <InfoCard label="Notes" value={String(serverInfo.notes)} />
              <InfoCard label="Connections" value={String(serverInfo.connections)} />
            </div>
          )}

          <SettingRow label="Address" description="In-process Rust backend address">
            <span className="text-[13px] font-mono font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>{API_DISPLAY}</span>
          </SettingRow>
          <SettingRow label="Data" description="Notes and database location">
            <span className="text-[12px] font-mono font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>~/.neurovault/</span>
          </SettingRow>
        </Section>
        </>}

        {settingsTab === "connections" && <><AutoRecallSection /><McpSection /><ClaudeCodeMcpSection /></>}
        {settingsTab === "memory" && <><AutoRecallSection /><InspectorSection /></>}
        {settingsTab === "vaults" && <VaultSettings />}
        {settingsTab === "privacy" && <PrivacySettings />}
        {settingsTab === "advanced" && <><MCPTierSection /><RerankSection /><APIGatewaySection /><APIAccessSection /></>}

        {/* Shortcuts */}
        {settingsTab === "general" && <>
        <Section title="Keyboard Shortcuts">
          <div className="space-y-2">
            <ShortcutRow keys="⌘K" action="Command palette" />
            <ShortcutRow keys="⌘N" action="New note" />
            <ShortcutRow keys="⌘P" action="Cycle Memories and Graph" />
            <ShortcutRow keys="⌘S" action="Save note" />
            <ShortcutRow keys="⌘/" action="Search memory" />
            <ShortcutRow keys="⌘⇧Space" action="Quick capture" />
            <ShortcutRow keys="Escape" action="Exit edit mode" />
            <ShortcutRow keys="?" action="Show all shortcuts" />
          </div>
        </Section>

        <UpdatesSection />

        <Section title="About">
          <div className="flex items-center gap-3">
            <svg
              viewBox="0 0 24 24"
              className="w-10 h-10 flex-shrink-0"
              style={{ color: "var(--nv-accent)" }}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.4}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-label="NeuroVault"
            >
              <circle cx="12" cy="12" r="9.5" />
              <line x1="12"   y1="8.4"  x2="12"   y2="11.6" />
              <line x1="7.5"  y1="15.6" x2="10.7" y2="13.8" />
              <line x1="16.5" y1="15.6" x2="13.3" y2="13.8" />
              <circle cx="12"   cy="6.9"  r="1.5" fill="currentColor" stroke="none" />
              <circle cx="6.4"  cy="16"   r="1.5" fill="currentColor" stroke="none" />
              <circle cx="17.6" cy="16"   r="1.5" fill="currentColor" stroke="none" />
              <circle cx="12"   cy="12.8" r="1.4" />
              <line   x1="12"   y1="14.2" x2="12" y2="15.7" />
            </svg>
            <div>
              <p className="text-[13px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>NeuroVault <AppVersion /></p>
              <p className="text-[12px] font-[Geist,sans-serif] mt-1" style={{ color: "var(--nv-text-dim)" }}>
                Your vault and index stay on this Mac. Selected context is shared only with AI providers you connect.
              </p>
            </div>
          </div>
        </Section>
        </>}
      </div>
      </div>
    </div>
  );
}

function VaultSettings() {
  return (
    <>
      <Section title="Active vault">
        <p className="mb-4 text-[12px] leading-relaxed" style={{ color: "var(--nv-text-muted)" }}>
          Vaults are hard project boundaries. NeuroVault saves, searches, and shares context only from the active vault unless you explicitly switch.
        </p>
        <div className="rounded-xl p-4" style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)" }}>
          <BrainSelector />
        </div>
      </Section>
      <Section title="Ownership & backup">
        <div className="space-y-3 text-[12px] leading-relaxed" style={{ color: "var(--nv-text-muted)" }}>
          <p>Your notes are ordinary Markdown. Internal vaults, their index, and supporting memory data live under <span className="font-mono">~/.neurovault/</span>.</p>
          <p>Use the vault menu above to export a complete ZIP snapshot. Test important backups by opening the Markdown on another account before relying on them.</p>
          <p>Deleting a note moves its Markdown to NeuroVault Trash. Restore it from Memories or Privacy & Trust; restoring rebuilds its search index.</p>
        </div>
      </Section>
    </>
  );
}

function PrivacySettings() {
  return (
    <>
      <Section title="The exact privacy contract">
        <div className="rounded-xl p-4" style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)" }}>
          <p className="text-[13px] font-medium leading-relaxed" style={{ color: "var(--nv-text)" }}>
            Your vault and index stay on this Mac. NeuroVault shares selected context only with AI providers you connect.
          </p>
          <p className="mt-2 text-[11px] leading-relaxed" style={{ color: "var(--nv-text-dim)" }}>
            Local storage is plaintext unless the volume is encrypted. Enable FileVault in macOS Settings if other people could access this Mac or its drive.
          </p>
        </div>
      </Section>
      <Section title="Possible outbound connections">
        <div className="space-y-2">
          <PrivacyFlow name="Connected AI provider" condition="Only while you use that connection" detail="Receives the small set of memories chosen for context, plus the prompt handled by the AI client itself." />
          <PrivacyFlow name="GitHub Releases" condition="Only when you check, or opt in to launch checks" detail="Receives an ordinary update request; it does not receive vault contents or a stable install identifier." />
          <PrivacyFlow name="Optional model provider" condition="Only when you deliberately enable a provider-backed compile feature" detail="May receive the content shown in that feature's confirmation." />
          <PrivacyFlow name="Fonts and interface" condition="Never" detail="The interface uses local system fonts; opening NeuroVault does not fetch fonts from a CDN." />
        </div>
      </Section>
      <Section title="Controls">
        <p className="text-[12px] leading-relaxed" style={{ color: "var(--nv-text-muted)" }}>
          Pause automatic context under Connections. Review every delivery in Activity. Revoke external API keys under Advanced. Trash, export, and correction remain available without an account.
        </p>
      </Section>
    </>
  );
}

function PrivacyFlow({ name, condition, detail }: { name: string; condition: string; detail: string }) {
  return (
    <div className="rounded-xl px-4 py-3" style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)" }}>
      <div className="flex items-baseline gap-3">
        <p className="text-[12px] font-medium" style={{ color: "var(--nv-text)" }}>{name}</p>
        <p className="ml-auto text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--nv-accent)" }}>{condition}</p>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed" style={{ color: "var(--nv-text-dim)" }}>{detail}</p>
    </div>
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
/** Live app version (from tauri.conf via getVersion). Falls back to a
 *  dash in browser/dev mode where the Tauri API isn't present. */
function AppVersion() {
  const [v, setV] = useState<string>("");
  useEffect(() => {
    let alive = true;
    import("@tauri-apps/api/app")
      .then((m) => m.getVersion())
      .then((ver) => { if (alive) setV(ver); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  return <>v{v || "—"}</>;
}

/** Updates section. Shares the global update store with the top-bar
 *  Update pill, so a check here lights up the pill (and vice-versa).
 *  "Update" downloads + installs via the native updater when configured,
 *  else opens the GitHub release page (current unsigned-installer state). */
function InspectorSection() {
  const [open, setOpen] = useState(false);
  return (
    <Section title="Memory Inspector">
      <SettingRow
        label="See what your memory is doing"
        description="Two views: Recall activity shows what NeuroVault quietly added to your Claude conversations (and when it chose to stay out of the way). Suggestions shows things it thinks it learned from your sessions - each one waits for your yes or no."
      >
        <button
          onClick={() => setOpen(true)}
          className="text-xs px-3 py-1.5 rounded-lg hover:opacity-80"
          style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)", color: "var(--nv-accent, #568cfa)" }}
        >
          Open Inspector
        </button>
      </SettingRow>
      {open && <MemoryInspector onClose={() => setOpen(false)} />}
    </Section>
  );
}

function UpdatesSection() {
  const info = useUpdateStore((s) => s.info);
  const checking = useUpdateStore((s) => s.checking);
  const installing = useUpdateStore((s) => s.installing);
  const progress = useUpdateStore((s) => s.progress);
  const restartPending = useUpdateStore((s) => s.restartPending);
  const check = useUpdateStore((s) => s.check);
  const install = useUpdateStore((s) => s.install);
  const restart = useUpdateStore((s) => s.restart);

  const subtitle = restartPending
    ? "Update installed — restart to apply."
    : info
    ? info.updateAvailable
      ? `Update available: v${info.latest}`
      : "You're on the latest version."
    : "Check GitHub for a newer release.";

  const pct = progress != null ? Math.round(progress * 100) : null;

  return (
    <Section title="Updates">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[13px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text)" }}>
            Current version <AppVersion />
          </p>
          <p className="text-[12px] font-[Geist,sans-serif] mt-1" style={{ color: "var(--nv-text-dim)" }}>
            {subtitle}
          </p>
        </div>
        {restartPending ? (
          <button
            onClick={() => restart()}
            className="flex-shrink-0 px-3 py-1.5 text-[12px] font-medium font-[Geist,sans-serif] rounded-lg transition-colors"
            style={{ background: "var(--nv-accent)", color: "var(--nv-bg)" }}
          >
            Restart now
          </button>
        ) : info?.updateAvailable ? (
          <button
            onClick={() => install()}
            disabled={installing}
            className="flex-shrink-0 px-3 py-1.5 text-[12px] font-medium font-[Geist,sans-serif] rounded-lg transition-colors disabled:opacity-70"
            style={{ background: "var(--nv-accent)", color: "var(--nv-bg)" }}
          >
            {installing ? (pct != null ? `Updating… ${pct}%` : "Updating…") : `Update to v${info.latest}`}
          </button>
        ) : (
          <button
            onClick={() => check(false)}
            disabled={checking}
            className="flex-shrink-0 px-3 py-1.5 text-[12px] font-medium font-[Geist,sans-serif] rounded-lg transition-colors disabled:opacity-50"
            style={{ background: "var(--nv-surface)", color: "var(--nv-text)", border: "1px solid var(--nv-border)" }}
          >
            {checking ? "Checking…" : "Check for updates"}
          </button>
        )}
      </div>
    </Section>
  );
}

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
        { mcpServers: { neurovault: { command: sidecarPath, args: ["--mcp-only"] } } },
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
  const [registering, setRegistering] = useState(false);
  const [registerMsg, setRegisterMsg] = useState<string>("");
  const [registerOk, setRegisterOk] = useState(false);

  // One-click: merge the neurovault server into ~/.claude.json (NOT
  // ~/.claude/.mcp.json — Claude Code reads user-scope servers from the
  // home-root file). The Rust command merges + writes atomically, so the
  // user's existing auth tokens and other config are preserved.
  const doRegister = async () => {
    setRegistering(true);
    setRegisterMsg("");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const res = await invoke<{ path: string; created: boolean; updated: boolean }>(
        "register_claude_code_mcp",
      );
      setRegisterOk(true);
      setRegisterMsg(
        `${res.updated ? "Updated" : "Added"} neurovault in ~/.claude.json${
          res.created ? " (created the file)" : ""
        }. Restart your Claude Code session to load it.`,
      );
    } catch (e) {
      setRegisterOk(false);
      setRegisterMsg(`Couldn't register automatically: ${String(e)}`);
    } finally {
      setRegistering(false);
    }
  };

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
              Connect Claude Code (the terminal CLI) so it can <span className="font-mono">remember</span> and <span className="font-mono">recall</span> against this vault in every project. One click registers it in <span className="font-mono">~/.claude.json</span> — your existing login and config are preserved.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={doRegister}
              disabled={registering}
              className="text-[12px] font-medium font-[Geist,sans-serif] px-3.5 py-1.5 rounded-lg transition-all disabled:opacity-50"
              style={{ background: "var(--nv-accent)", color: "var(--nv-bg)", border: "1px solid var(--nv-accent)" }}
            >
              {registering ? "Registering…" : "Register automatically"}
            </button>
            {registerMsg && (
              <span
                className="text-[11px] font-[Geist,sans-serif]"
                style={{ color: registerOk ? "var(--nv-positive)" : "var(--nv-negative)" }}
              >
                {registerMsg}
              </span>
            )}
          </div>

          <details className="group">
            <summary className="text-[11px] font-[Geist,sans-serif] cursor-pointer select-none" style={{ color: "var(--nv-text-dim)" }}>
              Prefer the terminal? Show the <span className="font-mono">claude mcp add</span> command →
            </summary>
            <div className="relative mt-2">
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
          </details>

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


/**
 *  MCP tier picker. Every MCP tool's name + description + JSON schema
 *  is loaded into the agent's context at session start; for ~30
 *  NeuroVault tools that's 5-9 k tokens before the user types
 *  anything. Lite (~1.5 k) drops everything except the daily-use
 *  surface; Standard (~3.5 k) trims admin tools the user rarely
 *  invokes. Full is the default.
 *
 *  Persists `~/.neurovault/mcp_tier.txt`; the native MCP server
 *  (`neurovault-server --mcp-only`) reads it at startup, so changes
 *  take effect after restarting the MCP host (Claude Code / Desktop).
 */
type McpTier = "lite" | "standard" | "full";
const TIER_INFO: { value: McpTier; label: string; tokens: string; description: string }[] = [
  { value: "lite", label: "Lite", tokens: "~1.5k tok",
    description: "8 essentials only — recall, remember, related, session_start, status, list/switch_brain, update." },
  { value: "standard", label: "Standard", tokens: "~3.5k tok",
    description: "17 tools — Lite + chunks, temporal_recall, dedupe, core_memory, delete, find_clutter." },
  { value: "full", label: "Full", tokens: "~6-8k tok",
    description: "All 30 tools — adds link editing, contradictions, orphan links, bulk metadata, optimize_disk, compile, brain creation." },
];

function MCPTierSection() {
  const [tier, setTier] = useState<McpTier | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${SERVER_URL}/api/mcp_tier`);
        if (!r.ok) return;
        const j = await r.json();
        if (!cancelled && j?.tier) setTier(j.tier as McpTier);
      } catch {
        /* sidecar offline — handled by global status pill */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const onPick = useCallback(async (next: McpTier) => {
    if (next === tier || saving) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`${SERVER_URL}/api/mcp_tier`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: next }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error ?? `HTTP ${r.status}`);
      }
      const j = await r.json();
      setTier(j.tier as McpTier);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [tier, saving]);

  return (
    <Section title="MCP Tool Tier">
      <p className="text-[12px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>
        Each MCP tool the agent can see costs tokens at session start. Pick the smallest tier that covers your workflow.
      </p>
      <div className="space-y-2">
        {TIER_INFO.map((t) => {
          const selected = tier === t.value;
          return (
            <button
              key={t.value}
              onClick={() => onPick(t.value)}
              disabled={saving || tier === null}
              className="w-full text-left rounded-lg p-3 transition-colors disabled:opacity-50"
              style={{
                background: selected ? "var(--nv-surface-2, var(--nv-surface))" : "var(--nv-bg)",
                border: selected
                  ? "1px solid var(--nv-accent)"
                  : "1px solid var(--nv-border)",
              }}
              aria-pressed={selected}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-[13px] font-semibold font-[Geist,sans-serif]" style={{ color: "var(--nv-text)" }}>
                  {t.label}
                </span>
                <span className="text-[10px] uppercase tracking-wider font-[Geist,sans-serif] font-medium px-1.5 py-0.5 rounded" style={{
                  background: selected ? "var(--nv-accent)" : "var(--nv-surface)",
                  color: selected ? "var(--nv-bg)" : "var(--nv-text-dim)",
                }}>
                  {t.tokens}
                </span>
              </div>
              <p className="text-[11.5px] leading-snug font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>
                {t.description}
              </p>
            </button>
          );
        })}
      </div>
      <p className="text-[11px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
        {error
          ? <span style={{ color: "var(--nv-negative, #ef4444)" }}>Couldn't save: {error}</span>
          : savedAt
          ? <>Saved. Restart Claude Code / Desktop for the new tier to take effect.</>
          : <>The MCP server reads <span className="font-mono">~/.neurovault/mcp_tier.txt</span> at startup.</>}
      </p>
    </Section>
  );
}

/**
 *  Recall reranking — the cross-encoder second stage. ON by default
 *  (lifts LongMemEval hit@5 ~94% -> ~97%); a toggle writes
 *  ~/.neurovault/rerank.txt = "off" for a lighter, faster app at a
 *  small recall cost. Backend reads it as the default for the recall
 *  path's `rerank` param.
 */
/**
 * Automatic memory for Claude Code. Installs UserPromptSubmit +
 * SessionStart hooks (via the bundled sidecar's `hook` subcommand) so
 * relevant memories are injected into every prompt automatically — the
 * agent no longer has to decide to call recall. The hooks fail open:
 * when NeuroVault isn't running they print nothing and Claude Code is
 * unaffected.
 */
function AutoRecallSection() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const installed = await invoke<boolean>("nv_auto_recall_status");
        if (!cancelled) setEnabled(installed);
      } catch {
        if (!cancelled) setEnabled(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const onToggle = useCallback(async () => {
    if (enabled === null || saving) return;
    const next = !enabled;
    setSaving(true);
    setError(null);
    setMsg(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke<string>("nv_auto_recall_set", { enabled: next });
      setEnabled(next);
      setMsg(
        next
          ? "Installed. Takes effect in new Claude Code sessions."
          : "Removed from Claude Code settings.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [enabled, saving]);

  const on = enabled === true;
  return (
    <Section title="Automatic Memory (Claude Code)">
      <p className="text-[12px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>
        Injects relevant memories into every Claude Code prompt automatically — no recall tool call needed. A session brief loads at startup, and each prompt is matched against this vault in the background. If NeuroVault isn&apos;t running, the hooks stay silent and Claude Code is unaffected.
      </p>
      <button
        onClick={onToggle}
        disabled={saving || enabled === null}
        className="w-full text-left rounded-lg p-3 transition-colors disabled:opacity-50 flex items-center justify-between gap-3"
        style={{
          background: on ? "var(--nv-surface-2, var(--nv-surface))" : "var(--nv-bg)",
          border: on ? "1px solid var(--nv-accent)" : "1px solid var(--nv-border)",
        }}
        aria-pressed={on}
      >
        <div>
          <span className="text-[13px] font-semibold font-[Geist,sans-serif]" style={{ color: "var(--nv-text)" }}>
            Automatic recall {enabled === null ? "…" : on ? "On" : "Off"}
          </span>
          <p className="text-[11.5px] leading-snug font-[Geist,sans-serif] mt-0.5" style={{ color: "var(--nv-text-muted)" }}>
            {on
              ? "Memories surface on their own in every Claude Code session."
              : "Claude Code only remembers when it explicitly calls the recall tool."}
          </p>
        </div>
        <span className="text-[10px] uppercase tracking-wider font-[Geist,sans-serif] font-medium px-2 py-1 rounded shrink-0" style={{
          background: on ? "var(--nv-accent)" : "var(--nv-surface)",
          color: on ? "var(--nv-bg)" : "var(--nv-text-dim)",
        }}>
          {enabled === null ? "…" : on ? "On" : "Off"}
        </span>
      </button>
      {msg && (
        <p className="text-[11px] font-[Geist,sans-serif]" style={{ color: "var(--nv-positive)" }}>{msg}</p>
      )}
      {error && (
        <p className="text-[11px] font-[Geist,sans-serif]" style={{ color: "var(--nv-negative)" }}>{error}</p>
      )}
    </Section>
  );
}

function RerankSection() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${SERVER_URL}/api/rerank`);
        if (!r.ok) return;
        const j = await r.json();
        if (!cancelled && typeof j?.enabled === "boolean") setEnabled(j.enabled);
      } catch {
        /* sidecar offline — handled by global status pill */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const onToggle = useCallback(async () => {
    if (enabled === null || saving) return;
    const next = !enabled;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`${SERVER_URL}/api/rerank`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error ?? `HTTP ${r.status}`);
      }
      const j = await r.json();
      setEnabled(!!j.enabled);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [enabled, saving]);

  const on = enabled === true;
  return (
    <Section title="Recall Reranking">
      <p className="text-[12px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>
        A cross-encoder re-scores the top candidates so the most relevant memory ranks first. It lifts retrieval quality (LongMemEval hit@5 from ~94% to ~97%) at the cost of loading a ~1&nbsp;GB model and adding roughly 50-100&nbsp;ms per recall.
      </p>
      <button
        onClick={onToggle}
        disabled={saving || enabled === null}
        className="w-full text-left rounded-lg p-3 transition-colors disabled:opacity-50 flex items-center justify-between gap-3"
        style={{
          background: on ? "var(--nv-surface-2, var(--nv-surface))" : "var(--nv-bg)",
          border: on ? "1px solid var(--nv-accent)" : "1px solid var(--nv-border)",
        }}
        aria-pressed={on}
      >
        <div>
          <span className="text-[13px] font-semibold font-[Geist,sans-serif]" style={{ color: "var(--nv-text)" }}>
            Reranking {enabled === null ? "…" : on ? "On" : "Off"}
          </span>
          <p className="text-[11.5px] leading-snug font-[Geist,sans-serif] mt-0.5" style={{ color: "var(--nv-text-muted)" }}>
            {on
              ? "Best recall accuracy. Recommended."
              : "Lighter and faster, with a very small decrease in recall accuracy."}
          </p>
        </div>
        <span className="text-[10px] uppercase tracking-wider font-[Geist,sans-serif] font-medium px-2 py-1 rounded shrink-0" style={{
          background: on ? "var(--nv-accent)" : "var(--nv-surface)",
          color: on ? "var(--nv-bg)" : "var(--nv-text-dim)",
        }}>
          {enabled === null ? "…" : on ? "On" : "Off"}
        </span>
      </button>
      <p className="text-[11px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
        {error
          ? <span style={{ color: "var(--nv-negative, #ef4444)" }}>Couldn't save: {error}</span>
          : <>Turning reranking off trades a very small drop in recall for a lighter, faster app. Persisted to <span className="font-mono">~/.neurovault/rerank.txt</span>.</>}
      </p>
    </Section>
  );
}

/**
 *  API Gateway — toggle the external HTTP gateway on/off and
 *  configure its bind.
 *
 *  Default OFF. The gateway only binds a port when this is
 *  enabled. Loopback binding is the safe default; LAN exposure
 *  requires deliberate opt-in with a clear warning.
 *
 *  Changes apply at next NeuroVault restart — the gateway runtime
 *  is bound at app startup and we don't hot-restart it. The UI
 *  surfaces this with a "Restart to apply" hint after a save.
 */
type GatewayBindKind = "loopback" | "lan" | "specific";
type GatewayConfig = {
  enabled: boolean;
  bind_kind: GatewayBindKind;
  bind_ip: string | null;
  port: number;
};

function APIGatewaySection() {
  const [cfg, setCfg] = useState<GatewayConfig | null>(null);
  const [draft, setDraft] = useState<GatewayConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${SERVER_URL}/api/api_gateway_config`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as GatewayConfig;
        if (cancelled) return;
        setCfg(j);
        setDraft(j);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const dirty = !!draft && !!cfg && (
    draft.enabled !== cfg.enabled ||
    draft.bind_kind !== cfg.bind_kind ||
    (draft.bind_ip ?? "") !== (cfg.bind_ip ?? "") ||
    draft.port !== cfg.port
  );

  const onSave = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`${SERVER_URL}/api/api_gateway_config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error ?? `HTTP ${r.status}`);
      }
      const j = (await r.json()) as GatewayConfig;
      setCfg(j);
      setDraft(j);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [draft]);

  if (!draft) {
    return (
      <Section title="API Gateway">
        {error ? (
          <p className="text-[12px] font-[Geist,sans-serif]" style={{ color: "var(--nv-negative, #ef4444)" }}>
            Couldn't load: {error}
          </p>
        ) : (
          <p className="text-[12px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>Loading…</p>
        )}
      </Section>
    );
  }

  return (
    <Section title="API Gateway (External HTTP)">
      <p className="text-[12px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>
        Off by default. When enabled, NeuroVault binds a separate HTTP port for external agents authenticated via API keys. The local Tauri app and MCP proxy keep using the loopback port (8765) regardless of this setting.
      </p>

      <SettingRow label="Status" description={cfg?.enabled ? "Gateway is enabled (active after next restart)" : "Gateway is OFF — no external port bound"}>
        <button
          onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}
          className="text-[11px] font-medium font-[Geist,sans-serif] px-3 py-1.5 rounded-lg transition-all"
          style={{
            background: draft.enabled ? "var(--nv-positive, #10b981)" : "var(--nv-surface)",
            color: draft.enabled ? "var(--nv-bg)" : "var(--nv-text-muted)",
            border: "1px solid var(--nv-border)",
          }}
        >
          {draft.enabled ? "Enabled" : "Disabled"}
        </button>
      </SettingRow>

      <div>
        <span className="text-[11px] uppercase tracking-wider font-[Geist,sans-serif] font-medium" style={{ color: "var(--nv-text-dim)" }}>Bind</span>
        <div className="mt-1 space-y-1">
          {([
            { v: "loopback" as const, label: "Loopback only (127.0.0.1)", hint: "Safe — only this machine can connect." },
            { v: "lan"      as const, label: "LAN (0.0.0.0)",            hint: "Anyone on your local network can reach the gateway. Don't enable on untrusted WiFi." },
            { v: "specific" as const, label: "Specific IP",              hint: "Bind to a single network interface (e.g. WireGuard, Tailscale)." },
          ]).map((opt) => (
            <label key={opt.v} className="flex items-start gap-2 cursor-pointer p-2 rounded hover:[background:var(--nv-surface-2)]">
              <input
                type="radio"
                name="api-gateway-bind"
                checked={draft.bind_kind === opt.v}
                onChange={() => setDraft({ ...draft, bind_kind: opt.v })}
                className="mt-0.5"
              />
              <div className="flex-1">
                <div className="text-[13px] font-[Geist,sans-serif] font-medium" style={{ color: "var(--nv-text)" }}>{opt.label}</div>
                <div className="text-[11px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>{opt.hint}</div>
                {opt.v === "specific" && draft.bind_kind === "specific" && (
                  <input
                    value={draft.bind_ip ?? ""}
                    onChange={(e) => setDraft({ ...draft, bind_ip: e.target.value })}
                    placeholder="192.168.1.42"
                    className="mt-1 w-full px-2 py-1 rounded text-[12px] font-mono outline-none"
                    style={{ background: "var(--nv-bg)", color: "var(--nv-text)", border: "1px solid var(--nv-border)" }}
                  />
                )}
              </div>
            </label>
          ))}
        </div>
        {draft.bind_kind === "lan" && draft.enabled && (
          <p
            className="text-[11px] font-[Geist,sans-serif] mt-2 p-2 rounded"
            style={{ background: "rgba(239,68,68,0.1)", color: "var(--nv-negative, #ef4444)", border: "1px solid var(--nv-negative, #ef4444)" }}
          >
            ⚠ LAN bind: anyone on your network with a valid API key can read or write your vault. Use API keys with tight scopes and vault allowlists.
          </p>
        )}
      </div>

      <SettingRow label="Port" description="Default 8767 — must not collide with the loopback server (8765).">
        <input
          type="number"
          value={draft.port}
          onChange={(e) => setDraft({ ...draft, port: parseInt(e.target.value, 10) || 8767 })}
          min={1024}
          max={65535}
          className="w-24 px-2 py-1 rounded text-[12px] font-mono outline-none"
          style={{ background: "var(--nv-bg)", color: "var(--nv-text)", border: "1px solid var(--nv-border)" }}
        />
      </SettingRow>

      {error && <p className="text-[12px] font-[Geist,sans-serif]" style={{ color: "var(--nv-negative, #ef4444)" }}>{error}</p>}

      <div className="flex items-center justify-between">
        <span className="text-[11px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
          {savedAt
            ? <>Saved. Restart NeuroVault for the new bind to take effect.</>
            : dirty
            ? <>Unsaved changes — review the warning above if any.</>
            : <>Changes apply at next app restart.</>}
        </span>
        <button
          onClick={onSave}
          disabled={!dirty || saving}
          className="text-[11px] font-medium font-[Geist,sans-serif] px-3 py-1.5 rounded-lg transition-all disabled:opacity-30"
          style={{ background: "var(--nv-accent)", color: "var(--nv-bg)" }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </Section>
  );
}

/**
 *  API Access — manage external-facing API keys for agents that
 *  call NeuroVault over HTTP (LangChain, n8n, custom Python scripts,
 *  future hosted teams).
 *
 *  Security contract: plaintext keys are shown EXACTLY ONCE at
 *  creation. Storage holds blake3 hashes only. Revocation is
 *  reversible-into-audit-trail (revoked rows stay for accounting).
 *
 *  This section drives the loopback-only endpoints
 *  /api/api_keys (GET, POST) and /api/api_keys/:id (DELETE). It
 *  does NOT contact the gateway directly — the gateway has no
 *  endpoints for managing its own keys, on purpose.
 */
type ApiKeyScope = "read" | "write" | "admin";
type ApiKeyPublic = {
  id: string;
  label: string;
  scope: ApiKeyScope;
  brain_allowlist: string[];
  created_at: string;
  last_used_at: string | null;
  use_count: number;
  revoked_at: string | null;
};

const SCOPE_LABELS: { value: ApiKeyScope; label: string; description: string }[] = [
  { value: "read", label: "Read", description: "recall, list, view — no writes." },
  { value: "write", label: "Write", description: "Read + create, update, or delete memories + edit links and metadata." },
  { value: "admin", label: "Admin", description: "Write access plus indexing, storage maintenance, and vault creation." },
];

function APIAccessSection() {
  const [keys, setKeys] = useState<ApiKeyPublic[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newPlaintext, setNewPlaintext] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<string | null>(null);

  const loadKeys = useCallback(async () => {
    try {
      const r = await fetch(`${SERVER_URL}/api/api_keys`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setKeys(j.keys ?? []);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { loadKeys(); }, [loadKeys]);

  const confirmRevoke = useCallback(async () => {
    const id = pendingRevoke;
    if (!id) return;
    setPendingRevoke(null);
    setRevoking(id);
    try {
      const r = await fetch(`${SERVER_URL}/api/api_keys/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await loadKeys();
    } catch (e) {
      toast.error(`Couldn't revoke API key: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRevoking(null);
    }
  }, [loadKeys, pendingRevoke]);

  const activeKeys = (keys ?? []).filter((k) => !k.revoked_at);
  const revokedKeys = (keys ?? []).filter((k) => !!k.revoked_at);

  return (
    <Section title="API Access (External Agents)">
      <p className="text-[12px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>
        Generate API keys for external agents (LangChain, n8n, custom scripts) that call NeuroVault over HTTP. Each key has a scope and an optional vault allowlist. <strong>Plaintext is shown exactly once at creation</strong> — copy it then; you can't recover it later.
      </p>

      {loadError && (
        <p className="text-[12px] font-[Geist,sans-serif]" style={{ color: "var(--nv-negative, #ef4444)" }}>
          Couldn't load keys: {loadError}
        </p>
      )}

      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wider font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
          {activeKeys.length} active{revokedKeys.length > 0 ? ` • ${revokedKeys.length} revoked` : ""}
        </span>
        <button
          onClick={() => setShowCreate(true)}
          className="text-[11px] font-medium font-[Geist,sans-serif] px-3 py-1.5 rounded-lg transition-all"
          style={{ background: "var(--nv-accent)", color: "var(--nv-bg)" }}
        >
          + New key
        </button>
      </div>

      {keys === null ? (
        <p className="text-[12px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>Loading…</p>
      ) : activeKeys.length === 0 && revokedKeys.length === 0 ? (
        <p className="text-[12px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
          No API keys yet. Create one to let an external agent call this vault.
        </p>
      ) : (
        <div className="space-y-2">
          {activeKeys.map((k) => (
            <APIKeyRow key={k.id} k={k} revoking={revoking === k.id} onRevoke={() => setPendingRevoke(k.id)} />
          ))}
          {revokedKeys.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-[11px] uppercase tracking-wider font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
                Show {revokedKeys.length} revoked
              </summary>
              <div className="mt-2 space-y-2">
                {revokedKeys.map((k) => (
                  <APIKeyRow key={k.id} k={k} revoking={false} onRevoke={() => {}} />
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {showCreate && (
        <APIKeyCreateModal
          onClose={() => setShowCreate(false)}
          onCreated={(plaintext) => {
            setShowCreate(false);
            setNewPlaintext(plaintext);
            loadKeys();
          }}
        />
      )}

      {newPlaintext && (
        <APIKeyPlaintextModal
          plaintext={newPlaintext}
          onClose={() => setNewPlaintext(null)}
        />
      )}
      <ConfirmDialog
        open={pendingRevoke !== null}
        title="Revoke this API key?"
        message={`Existing requests using ${pendingRevoke ?? "this key"} will fail immediately. The revocation is retained in the local audit history.`}
        confirmLabel="Revoke key"
        cancelLabel="Keep key"
        destructive
        onConfirm={() => { void confirmRevoke(); }}
        onCancel={() => setPendingRevoke(null)}
      />
    </Section>
  );
}

function APIKeyRow({ k, revoking, onRevoke }: { k: ApiKeyPublic; revoking: boolean; onRevoke: () => void }) {
  const isRevoked = !!k.revoked_at;
  return (
    <div
      className="rounded-lg p-3"
      style={{
        background: "var(--nv-bg)",
        border: "1px solid var(--nv-border)",
        opacity: isRevoked ? 0.5 : 1,
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="font-mono text-[11px]" style={{ color: "var(--nv-text-dim)" }}>{k.id}</span>
            <span className="text-[10px] uppercase tracking-wider font-[Geist,sans-serif] font-medium px-1.5 py-0.5 rounded"
                  style={{ background: "var(--nv-surface)", color: "var(--nv-text-muted)" }}>
              {k.scope}
            </span>
            {isRevoked && (
              <span className="text-[10px] uppercase tracking-wider font-[Geist,sans-serif] font-medium px-1.5 py-0.5 rounded"
                    style={{ background: "var(--nv-negative, #ef4444)", color: "var(--nv-bg)" }}>
                revoked
              </span>
            )}
          </div>
          <p className="text-[13px] font-[Geist,sans-serif] truncate" style={{ color: "var(--nv-text)" }}>{k.label}</p>
          <p className="text-[11px] font-[Geist,sans-serif] mt-0.5" style={{ color: "var(--nv-text-dim)" }}>
            Vaults: {k.brain_allowlist.length === 0 ? "all" : k.brain_allowlist.join(", ")}
            {" · "}
            Last used: {k.last_used_at ? formatRelative(k.last_used_at) : "never"}
            {" · "}
            {k.use_count} call{k.use_count === 1 ? "" : "s"}
          </p>
        </div>
        {!isRevoked && (
          <button
            onClick={onRevoke}
            disabled={revoking}
            className="text-[11px] font-medium font-[Geist,sans-serif] px-2 py-1 rounded transition-all disabled:opacity-30 flex-shrink-0"
            style={{ border: "1px solid var(--nv-border)", color: "var(--nv-text-muted)" }}
          >
            {revoking ? "..." : "Revoke"}
          </button>
        )}
      </div>
    </div>
  );
}

function APIKeyCreateModal({ onClose, onCreated }: { onClose: () => void; onCreated: (plaintext: string) => void }) {
  const [label, setLabel] = useState("");
  const [scope, setScope] = useState<ApiKeyScope>("read");
  const [allowlistText, setAllowlistText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async () => {
    if (!label.trim()) {
      setError("Label is required");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const brain_allowlist = allowlistText
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const r = await fetch(`${SERVER_URL}/api/api_keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label.trim(), scope, brain_allowlist }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error ?? `HTTP ${r.status}`);
      }
      const j = await r.json();
      onCreated(j.plaintext);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50 pointer-events-auto"
      style={{ background: "var(--nv-overlay)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="rounded-2xl p-6 w-[440px] max-w-[90vw]" style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)" }}>
        <h3 className="text-[15px] font-semibold font-[Geist,sans-serif] mb-4" style={{ color: "var(--nv-text)" }}>Create API key</h3>

        <label className="block mb-3">
          <span className="text-[11px] uppercase tracking-wider font-[Geist,sans-serif] font-medium" style={{ color: "var(--nv-text-dim)" }}>Label</span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. n8n workflow on Linode"
            autoFocus
            className="mt-1 w-full px-3 py-2 rounded-lg text-[13px] font-[Geist,sans-serif] outline-none"
            style={{ background: "var(--nv-bg)", color: "var(--nv-text)", border: "1px solid var(--nv-border)" }}
          />
        </label>

        <div className="mb-3">
          <span className="text-[11px] uppercase tracking-wider font-[Geist,sans-serif] font-medium" style={{ color: "var(--nv-text-dim)" }}>Scope</span>
          <div className="mt-1 space-y-1">
            {SCOPE_LABELS.map((s) => (
              <label key={s.value} className="flex items-start gap-2 cursor-pointer p-2 rounded hover:[background:var(--nv-surface-2)]">
                <input
                  type="radio"
                  name="api-scope"
                  checked={scope === s.value}
                  onChange={() => setScope(s.value)}
                  className="mt-0.5"
                />
                <div>
                  <div className="text-[13px] font-[Geist,sans-serif] font-medium" style={{ color: "var(--nv-text)" }}>{s.label}</div>
                  <div className="text-[11px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>{s.description}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        <label className="block mb-4">
          <span className="text-[11px] uppercase tracking-wider font-[Geist,sans-serif] font-medium" style={{ color: "var(--nv-text-dim)" }}>Vault allowlist (optional)</span>
          <input
            value={allowlistText}
            onChange={(e) => setAllowlistText(e.target.value)}
            placeholder="Empty = all vaults. Enter comma-separated vault IDs to restrict access."
            className="mt-1 w-full px-3 py-2 rounded-lg text-[13px] font-[Geist,sans-serif] outline-none"
            style={{ background: "var(--nv-bg)", color: "var(--nv-text)", border: "1px solid var(--nv-border)" }}
          />
        </label>

        {error && <p className="text-[12px] font-[Geist,sans-serif] mb-3" style={{ color: "var(--nv-negative, #ef4444)" }}>{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={submitting}
            className="text-[12px] font-medium font-[Geist,sans-serif] px-3 py-2 rounded-lg"
            style={{ color: "var(--nv-text-muted)" }}
          >
            Cancel
          </button>
          <button
            onClick={onSubmit}
            disabled={submitting}
            className="text-[12px] font-medium font-[Geist,sans-serif] px-3 py-2 rounded-lg disabled:opacity-50"
            style={{ background: "var(--nv-accent)", color: "var(--nv-bg)" }}
          >
            {submitting ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

function APIKeyPlaintextModal({ plaintext, onClose }: { plaintext: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(plaintext);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — user can still copy manually */
    }
  };
  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50 pointer-events-auto"
      style={{ background: "var(--nv-overlay)" }}
    >
      <div className="rounded-2xl p-6 w-[480px] max-w-[90vw]" style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)" }}>
        <h3 className="text-[15px] font-semibold font-[Geist,sans-serif] mb-2" style={{ color: "var(--nv-text)" }}>Save your API key</h3>
        <p className="text-[12px] font-[Geist,sans-serif] mb-4" style={{ color: "var(--nv-text-muted)" }}>
          This is the only time the key will be shown. Copy it now — there's no way to recover it later. If you lose it, revoke and create a new one.
        </p>
        <div className="rounded-lg p-3 mb-4 font-mono text-[12px] break-all"
             style={{ background: "var(--nv-bg)", color: "var(--nv-text)", border: "1px solid var(--nv-border)" }}>
          {plaintext}
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCopy}
            className="text-[12px] font-medium font-[Geist,sans-serif] px-3 py-2 rounded-lg"
            style={{
              background: copied ? "var(--nv-positive, #10b981)" : "var(--nv-surface)",
              color: copied ? "var(--nv-bg)" : "var(--nv-text-muted)",
              border: "1px solid var(--nv-border)",
            }}
          >
            {copied ? "Copied!" : "Copy"}
          </button>
          <button
            onClick={onClose}
            className="text-[12px] font-medium font-[Geist,sans-serif] px-3 py-2 rounded-lg"
            style={{ background: "var(--nv-accent)", color: "var(--nv-bg)" }}
          >
            I've copied it — close
          </button>
        </div>
      </div>
    </div>
  );
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const ageMs = Date.now() - t;
  const sec = Math.floor(ageMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return iso.slice(0, 10);
}

/** Per-folder colour override editor. Lists every folder currently in
 *  the active brain's graph (derived from the live node set), with an
 *  inline native colour picker + reset. Empty list = no graph loaded
 *  yet, so we render a hint instead of nothing. */

/** One row of [swatch | label | reset]. The swatch is also the click
 *  target for the native `<input type="color">` — overlaid invisibly
 *  so the swatch itself looks like the button. The native picker is
 *  ugly on Windows but zero-dep and works everywhere. */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-10">
      <h2 className="text-[11px] uppercase tracking-wider font-semibold font-[Geist,sans-serif] mb-4" style={{ color: "var(--nv-text-dim)" }}>{title}</h2>
      <div className="rounded-2xl p-5 space-y-5" style={{ background: "var(--nv-surface-elevated)", border: "1px solid var(--nv-border)", boxShadow: "0 1px 2px color-mix(in srgb, var(--nv-text) 4%, transparent)" }}>
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

/** Stacked variant of SettingRow — label/description on top, control
 *  full-width below. Use for controls that don't fit alongside a label
 *  in the ~520-px-wide Settings card (e.g. the Palette swatch grid,
 *  per-folder colour pickers). Avoids the overflow that plain
 *  SettingRow's `flex-shrink-0` produces when the right side is wide.
 *
 *  The header sits in its OWN wrapping div with an explicit bottom
 *  margin — without that wrapper the parent Section's `space-y-5`
 *  treats label/description/children as siblings of the wrong scope
 *  and the header visually overlaps the first child of the control. */

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
