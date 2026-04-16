import { useState, useEffect } from "react";

/** Persisted settings — stored in localStorage so they survive app restarts. */
interface AppSettings {
  accentColor: string;
  fontSize: "small" | "medium" | "large";
  sidebarPosition: "left" | "right";
  showPreviewSnippets: boolean;
  showTimestamps: boolean;
  editorMaxWidth: number;
  reduceMotion: boolean;
}

const DEFAULTS: AppSettings = {
  accentColor: "#b592ff",
  fontSize: "medium",
  sidebarPosition: "left",
  showPreviewSnippets: true,
  showTimestamps: true,
  editorMaxWidth: 720,
  reduceMotion: false,
};

const ACCENT_PRESETS = [
  { label: "Violet", value: "#b592ff" },
  { label: "Blue", value: "#60a5fa" },
  { label: "Teal", value: "#2dd4bf" },
  { label: "Green", value: "#4ade80" },
  { label: "Gold", value: "#f0a500" },
  { label: "Rose", value: "#f472b6" },
  { label: "White", value: "#e8e6f0" },
];

const FONT_SIZES = [
  { label: "Small", value: "small" as const, px: 14 },
  { label: "Medium", value: "medium" as const, px: 16 },
  { label: "Large", value: "large" as const, px: 18 },
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

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);

  const update = (partial: Partial<AppSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...partial };
      saveSettings(next);
      return next;
    });
  };

  return { settings, update };
}

export function SettingsView() {
  const { settings, update } = useSettings();
  const [serverInfo, setServerInfo] = useState<{ notes: number; connections: number; brain: string } | null>(null);

  useEffect(() => {
    fetch("http://127.0.0.1:8765/api/brains/active")
      .then((r) => r.json())
      .then((d) => {
        fetch("http://127.0.0.1:8765/api/status")
          .then((r) => r.json())
          .then((s) => setServerInfo({ notes: s.memories, connections: s.connections, brain: d.name }))
          .catch(() => null);
      })
      .catch(() => null);
  }, []);

  return (
    <div className="flex-1 overflow-y-auto bg-[#08080f]">
      <div className="mx-auto max-w-[560px] px-8 py-12">
        <h1 className="text-[20px] font-semibold text-white/90 font-[Geist,sans-serif] mb-8">
          Settings
        </h1>

        {/* Appearance */}
        <Section title="Appearance">
          {/* Accent color */}
          <SettingRow label="Accent color" description="Used for active states, highlights, and buttons">
            <div className="flex gap-2">
              {ACCENT_PRESETS.map((p) => (
                <button
                  key={p.value}
                  onClick={() => update({ accentColor: p.value })}
                  className={`w-7 h-7 rounded-full transition-all ${
                    settings.accentColor === p.value
                      ? "ring-2 ring-white/30 ring-offset-2 ring-offset-[#08080f] scale-110"
                      : "hover:scale-110"
                  }`}
                  style={{ backgroundColor: p.value }}
                  title={p.label}
                />
              ))}
            </div>
          </SettingRow>

          {/* Font size */}
          <SettingRow label="Reading font size" description="Body text size in the note preview">
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

          {/* Editor width */}
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

          {/* Reduce motion */}
          <SettingRow label="Reduce motion" description="Disable transitions and animations">
            <Toggle checked={settings.reduceMotion} onChange={(v) => update({ reduceMotion: v })} />
          </SettingRow>
        </Section>

        {/* Note list */}
        <Section title="Note List">
          <SettingRow label="Show preview snippets" description="Display the first lines of each note in the sidebar">
            <Toggle checked={settings.showPreviewSnippets} onChange={(v) => update({ showPreviewSnippets: v })} />
          </SettingRow>

          <SettingRow label="Show timestamps" description="Show relative time (e.g. '2h ago') on each note">
            <Toggle checked={settings.showTimestamps} onChange={(v) => update({ showTimestamps: v })} />
          </SettingRow>
        </Section>

        {/* Server */}
        <Section title="Server">
          {serverInfo ? (
            <div className="grid grid-cols-3 gap-3">
              <InfoCard label="Brain" value={serverInfo.brain} />
              <InfoCard label="Notes" value={String(serverInfo.notes)} />
              <InfoCard label="Connections" value={String(serverInfo.connections)} />
            </div>
          ) : (
            <p className="text-white/20 text-[13px] font-[Geist,sans-serif]">
              Server not connected
            </p>
          )}
          <div className="mt-4">
            <SettingRow label="Server address" description="The Python backend address">
              <span className="text-[13px] text-white/30 font-mono font-[Geist,sans-serif]">
                127.0.0.1:8765
              </span>
            </SettingRow>
            <SettingRow label="Data directory" description="Where your notes and database are stored">
              <span className="text-[13px] text-white/30 font-mono font-[Geist,sans-serif] truncate max-w-[200px] block">
                ~/.neurovault/
              </span>
            </SettingRow>
          </div>
        </Section>

        {/* Keyboard shortcuts */}
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
          <div className="space-y-1">
            <p className="text-[13px] text-white/40 font-[Geist,sans-serif]">
              NeuroVault v0.1.0
            </p>
            <p className="text-[12px] text-white/20 font-[Geist,sans-serif]">
              Local-first AI memory system. Your data never leaves your machine.
            </p>
          </div>
        </Section>
      </div>
    </div>
  );
}

// --- Sub-components ---

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
      <p className="text-[15px] font-semibold text-white/80 font-[Geist,sans-serif]">{value}</p>
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
