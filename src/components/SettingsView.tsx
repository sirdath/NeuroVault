import { useState, useEffect, useCallback } from "react";

// --- Theme system -----------------------------------------------------------

export interface Theme {
  id: string;
  name: string;
  description: string;
  bg: string;           // deepest background
  surface: string;      // glass surface tint (rgba)
  border: string;       // border color (rgba)
  text: string;         // primary text (rgba)
  textMuted: string;    // secondary text (rgba)
  textDim: string;      // tertiary text (rgba)
  accent: string;       // accent color (hex)
  accentGlow: string;   // accent shadow color (rgba)
  positive: string;
  negative: string;
}

const THEMES: Theme[] = [
  {
    id: "midnight",
    name: "Midnight",
    description: "Deep dark with violet accents — the default",
    bg: "#08080f",
    surface: "rgba(255,255,255,0.03)",
    border: "rgba(255,255,255,0.06)",
    text: "rgba(255,255,255,0.9)",
    textMuted: "rgba(255,255,255,0.4)",
    textDim: "rgba(255,255,255,0.2)",
    accent: "#b592ff",
    accentGlow: "rgba(181,146,255,0.15)",
    positive: "#4ade80",
    negative: "#ff6b6b",
  },
  {
    id: "claude",
    name: "Claude",
    description: "Warm cream tones inspired by Anthropic's Claude",
    bg: "#1a1714",
    surface: "rgba(255,245,230,0.04)",
    border: "rgba(255,245,230,0.08)",
    text: "rgba(255,245,230,0.9)",
    textMuted: "rgba(255,245,230,0.45)",
    textDim: "rgba(255,245,230,0.2)",
    accent: "#d4a574",
    accentGlow: "rgba(212,165,116,0.15)",
    positive: "#7dcea0",
    negative: "#e57373",
  },
  {
    id: "chatgpt",
    name: "OpenAI",
    description: "Clean dark with teal-green accents",
    bg: "#0d0d0d",
    surface: "rgba(255,255,255,0.04)",
    border: "rgba(255,255,255,0.07)",
    text: "rgba(255,255,255,0.88)",
    textMuted: "rgba(255,255,255,0.42)",
    textDim: "rgba(255,255,255,0.2)",
    accent: "#10a37f",
    accentGlow: "rgba(16,163,127,0.15)",
    positive: "#10a37f",
    negative: "#ef4444",
  },
  {
    id: "github",
    name: "GitHub Dark",
    description: "Neutral dark with blue accents",
    bg: "#0d1117",
    surface: "rgba(200,220,255,0.03)",
    border: "rgba(200,220,255,0.08)",
    text: "rgba(230,237,243,0.9)",
    textMuted: "rgba(200,220,255,0.4)",
    textDim: "rgba(200,220,255,0.2)",
    accent: "#58a6ff",
    accentGlow: "rgba(88,166,255,0.15)",
    positive: "#3fb950",
    negative: "#f85149",
  },
  {
    id: "rosepine",
    name: "Rosé Pine",
    description: "Soft muted palette with rose and gold",
    bg: "#191724",
    surface: "rgba(224,206,235,0.04)",
    border: "rgba(224,206,235,0.08)",
    text: "rgba(224,222,244,0.9)",
    textMuted: "rgba(144,140,170,0.7)",
    textDim: "rgba(110,106,134,0.5)",
    accent: "#c4a7e7",
    accentGlow: "rgba(196,167,231,0.15)",
    positive: "#9ccfd8",
    negative: "#eb6f92",
  },
  {
    id: "nord",
    name: "Nord",
    description: "Arctic blue-grey Scandinavian palette",
    bg: "#1a1e26",
    surface: "rgba(180,200,230,0.04)",
    border: "rgba(180,200,230,0.08)",
    text: "rgba(216,222,233,0.9)",
    textMuted: "rgba(216,222,233,0.45)",
    textDim: "rgba(216,222,233,0.22)",
    accent: "#88c0d0",
    accentGlow: "rgba(136,192,208,0.15)",
    positive: "#a3be8c",
    negative: "#bf616a",
  },
];

// --- Settings ---------------------------------------------------------------

interface AppSettings {
  themeId: string;
  fontSize: "small" | "medium" | "large";
  showPreviewSnippets: boolean;
  showTimestamps: boolean;
  editorMaxWidth: number;
  reduceMotion: boolean;
}

const DEFAULTS: AppSettings = {
  themeId: "midnight",
  fontSize: "medium",
  showPreviewSnippets: true,
  showTimestamps: true,
  editorMaxWidth: 720,
  reduceMotion: false,
};

const FONT_SIZES = [
  { label: "Small", value: "small" as const },
  { label: "Medium", value: "medium" as const },
  { label: "Large", value: "large" as const },
];

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem("nv.settings");
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { /* corrupt */ }
  return DEFAULTS;
}

function saveSettings(s: AppSettings) {
  localStorage.setItem("nv.settings", JSON.stringify(s));
}

export function getTheme(id?: string): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]!;
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const update = (partial: Partial<AppSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...partial };
      saveSettings(next);
      return next;
    });
  };
  const theme = getTheme(settings.themeId);
  return { settings, update, theme };
}

// --- Server controls --------------------------------------------------------

const SERVER_URL = "http://127.0.0.1:8765";

function useServerStatus() {
  const [online, setOnline] = useState(false);
  const [checking, setChecking] = useState(false);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const r = await fetch(`${SERVER_URL}/api/brains/active`, { signal: AbortSignal.timeout(3000) });
      setOnline(r.ok);
    } catch {
      setOnline(false);
    }
    setChecking(false);
  }, []);

  useEffect(() => { check(); }, [check]);

  return { online, checking, check };
}

// --- Component --------------------------------------------------------------

export function SettingsView() {
  const { settings, update } = useSettings();
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

  const handleStopServer = async () => {
    setStopping(true);
    try {
      await fetch(`${SERVER_URL}/api/shutdown`, { method: "POST" }).catch(() => null);
    } catch { /* expected — server closes the connection */ }
    setTimeout(() => { recheckServer(); setStopping(false); }, 1500);
  };

  return (
    <div className="flex-1 overflow-y-auto" style={{ background: "var(--nv-bg)" }}>
      <div className="mx-auto max-w-[580px] px-8 py-12">
        <h1 className="text-[20px] font-semibold text-white/90 font-[Geist,sans-serif] mb-8">
          Settings
        </h1>

        {/* Theme */}
        <Section title="Theme">
          <div className="grid grid-cols-2 gap-3">
            {THEMES.map((t) => (
              <button
                key={t.id}
                onClick={() => update({ themeId: t.id })}
                className={`relative text-left rounded-xl p-3 transition-all border ${
                  settings.themeId === t.id
                    ? "border-white/20 ring-1 ring-white/10"
                    : "border-white/[0.06] hover:border-white/[0.12]"
                }`}
                style={{
                  background: t.bg,
                  boxShadow: settings.themeId === t.id ? `0 0 20px ${t.accentGlow}` : undefined,
                }}
              >
                {/* Color preview strip */}
                <div className="flex gap-1.5 mb-2.5">
                  <div className="w-4 h-4 rounded-full" style={{ backgroundColor: t.accent }} />
                  <div className="w-4 h-4 rounded-full" style={{ backgroundColor: t.positive }} />
                  <div className="w-4 h-4 rounded-full" style={{ backgroundColor: t.negative }} />
                  <div className="w-4 h-4 rounded-full border border-white/10" style={{ background: t.surface }} />
                </div>
                <p className="text-[13px] font-medium font-[Geist,sans-serif]" style={{ color: t.text }}>
                  {t.name}
                </p>
                <p className="text-[11px] font-[Geist,sans-serif] mt-0.5" style={{ color: t.textDim }}>
                  {t.description}
                </p>
                {settings.themeId === t.id && (
                  <div className="absolute top-2.5 right-2.5 w-2 h-2 rounded-full" style={{ backgroundColor: t.accent }} />
                )}
              </button>
            ))}
          </div>
        </Section>

        {/* Reading */}
        <Section title="Reading">
          <SettingRow label="Font size" description="Body text size in the note preview">
            <div
              className="flex gap-1 bg-white/[0.05] rounded-xl p-1 border border-white/[0.08]"
              style={{ boxShadow: "inset 0 1px 1px rgba(255,255,255,0.05)" }}
            >
              {FONT_SIZES.map((f) => (
                <button
                  key={f.value}
                  onClick={() => update({ fontSize: f.value })}
                  className={`px-3 py-1.5 text-[12px] font-medium font-[Geist,sans-serif] rounded-lg transition-all ${
                    settings.fontSize === f.value
                      ? "bg-white/[0.12] text-white/90"
                      : "text-white/30 hover:text-white/50"
                  }`}
                  style={settings.fontSize === f.value ? {
                    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.1), 0 1px 3px rgba(0,0,0,0.3)",
                    border: "1px solid rgba(255,255,255,0.1)",
                  } : undefined}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </SettingRow>

          <SettingRow label="Editor width" description="Maximum width of the reading area">
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={520}
                max={960}
                step={20}
                value={settings.editorMaxWidth}
                onChange={(e) => update({ editorMaxWidth: Number(e.target.value) })}
                className="w-32 accent-white/40"
              />
              <span className="text-[12px] text-white/30 font-mono font-[Geist,sans-serif] w-12 text-right">
                {settings.editorMaxWidth}px
              </span>
            </div>
          </SettingRow>

          <SettingRow label="Reduce motion" description="Disable transitions and animations">
            <Toggle checked={settings.reduceMotion} onChange={(v) => update({ reduceMotion: v })} />
          </SettingRow>
        </Section>

        {/* Note list */}
        <Section title="Note List">
          <SettingRow label="Preview snippets" description="Show first lines of each note">
            <Toggle checked={settings.showPreviewSnippets} onChange={(v) => update({ showPreviewSnippets: v })} />
          </SettingRow>
          <SettingRow label="Timestamps" description="Show relative time on each note">
            <Toggle checked={settings.showTimestamps} onChange={(v) => update({ showTimestamps: v })} />
          </SettingRow>
        </Section>

        {/* Server */}
        <Section title="Server">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2.5">
              <span className={`w-2.5 h-2.5 rounded-full ${online ? "bg-[#4ade80] shadow-sm shadow-[#4ade80]/40" : "bg-[#ff6b6b]/50"}`} />
              <span className="text-[13px] text-white/70 font-[Geist,sans-serif]">
                {checking ? "Checking..." : online ? "Server running" : "Server offline"}
              </span>
            </div>
            <div className="flex gap-2">
              <button
                onClick={recheckServer}
                disabled={checking}
                className="text-[11px] font-medium font-[Geist,sans-serif] px-3 py-1.5 rounded-lg border border-white/[0.08] text-white/30 hover:text-white/60 hover:bg-white/[0.04] transition-all disabled:opacity-30"
              >
                Refresh
              </button>
              {online && (
                <button
                  onClick={handleStopServer}
                  disabled={stopping}
                  className="text-[11px] font-medium font-[Geist,sans-serif] px-3 py-1.5 rounded-lg border border-[#ff6b6b]/20 text-[#ff6b6b]/60 hover:text-[#ff6b6b] hover:bg-[#ff6b6b]/[0.06] transition-all disabled:opacity-30"
                >
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
            <span className="text-[13px] text-white/30 font-mono font-[Geist,sans-serif]">
              127.0.0.1:8765
            </span>
          </SettingRow>
          <SettingRow label="Data" description="Notes and database location">
            <span className="text-[12px] text-white/30 font-mono font-[Geist,sans-serif]">
              ~/.neurovault/
            </span>
          </SettingRow>
        </Section>

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

        {/* About */}
        <Section title="About">
          <p className="text-[13px] text-white/40 font-[Geist,sans-serif]">
            NeuroVault v0.1.0
          </p>
          <p className="text-[12px] text-white/20 font-[Geist,sans-serif] mt-1">
            Local-first AI memory system. Your data never leaves your machine.
          </p>
        </Section>
      </div>
    </div>
  );
}

// --- Sub-components ---------------------------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-10">
      <h2 className="text-[11px] uppercase tracking-wider text-white/25 font-semibold font-[Geist,sans-serif] mb-4">
        {title}
      </h2>
      <div
        className="bg-white/[0.03] rounded-2xl border border-white/[0.06] p-5 space-y-5"
        style={{ boxShadow: "inset 0 1px 1px rgba(255,255,255,0.04)" }}
      >
        {children}
      </div>
    </div>
  );
}

function SettingRow({ label, description, children }: { label: string; description: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-[13px] text-white/70 font-[Geist,sans-serif]">{label}</p>
        <p className="text-[11px] text-white/20 font-[Geist,sans-serif] mt-0.5">{description}</p>
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`w-10 h-6 rounded-full transition-all relative ${
        checked ? "bg-white/[0.2]" : "bg-white/[0.06]"
      } border ${checked ? "border-white/[0.15]" : "border-white/[0.08]"}`}
      style={checked ? { boxShadow: "inset 0 1px 1px rgba(255,255,255,0.1)" } : undefined}
    >
      <div
        className={`w-4 h-4 rounded-full bg-white/80 absolute top-1 transition-all ${
          checked ? "left-5" : "left-1"
        }`}
        style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.3)" }}
      />
    </button>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="bg-white/[0.04] rounded-xl px-3 py-2.5 border border-white/[0.06]"
      style={{ boxShadow: "inset 0 1px 1px rgba(255,255,255,0.03)" }}
    >
      <p className="text-[15px] font-semibold text-white/80 font-[Geist,sans-serif] truncate">{value}</p>
      <p className="text-[10px] text-white/25 font-[Geist,sans-serif] mt-0.5">{label}</p>
    </div>
  );
}

function ShortcutRow({ keys, action }: { keys: string; action: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[13px] text-white/40 font-[Geist,sans-serif]">{action}</span>
      <kbd className="text-[11px] text-white/30 font-mono bg-white/[0.04] px-2 py-0.5 rounded-md border border-white/[0.06]">
        {keys}
      </kbd>
    </div>
  );
}
