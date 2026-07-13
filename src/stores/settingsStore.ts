import { create } from "zustand";

export interface Theme {
  id: string;
  name: string;
  description: string;
  bg: string;
  surface: string;
  border: string;
  text: string;
  textMuted: string;
  textDim: string;
  accent: string;
  accentGlow: string;
  positive: string;
  negative: string;
}

export const THEMES: Theme[] = [
  {
    id: "neurovault",
    name: "NeuroVault",
    description: "The brand: icon blue on deep indigo-black",
    bg: "#05070e",
    surface: "rgba(120,160,255,0.045)",
    border: "rgba(120,160,255,0.10)",
    text: "rgba(235,240,255,0.92)",
    textMuted: "rgba(200,214,245,0.64)",
    textDim: "rgba(200,214,245,0.72)",
    accent: "#568cfa",
    accentGlow: "rgba(86,140,250,0.16)",
    positive: "#4ade80",
    negative: "#ff6b6b",
  },
  {
    id: "midnight",
    name: "Midnight",
    description: "Deep dark with violet accents",
    bg: "#08080f",
    surface: "rgba(255,255,255,0.03)",
    border: "rgba(255,255,255,0.06)",
    text: "rgba(255,255,255,0.9)",
    textMuted: "rgba(255,255,255,0.62)",
    textDim: "rgba(255,255,255,0.68)",
    accent: "#b592ff",
    accentGlow: "rgba(181,146,255,0.15)",
    positive: "#4ade80",
    negative: "#ff6b6b",
  },
  {
    id: "claude",
    name: "Claude",
    description: "Warm cream tones inspired by Anthropic",
    bg: "#1a1714",
    surface: "rgba(255,245,230,0.04)",
    border: "rgba(255,245,230,0.08)",
    text: "rgba(255,245,230,0.9)",
    textMuted: "rgba(255,245,230,0.62)",
    textDim: "rgba(255,245,230,0.68)",
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
    textMuted: "rgba(255,255,255,0.62)",
    textDim: "rgba(255,255,255,0.68)",
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
    textMuted: "rgba(200,220,255,0.62)",
    textDim: "rgba(200,220,255,0.68)",
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
    textMuted: "rgba(170,165,200,0.78)",
    textDim: "rgba(190,184,220,0.82)",
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
    textMuted: "rgba(216,222,233,0.62)",
    textDim: "rgba(216,222,233,0.68)",
    accent: "#88c0d0",
    accentGlow: "rgba(136,192,208,0.15)",
    positive: "#a3be8c",
    negative: "#bf616a",
  },
  {
    id: "obsidian",
    name: "Obsidian",
    description: "Warm dark grey — matches Obsidian's default dark theme",
    bg: "#1e1e1e",
    surface: "rgba(255,255,255,0.04)",
    border: "rgba(255,255,255,0.12)",
    text: "rgba(220,221,222,0.95)",
    textMuted: "rgba(153,153,153,0.9)",
    textDim: "rgba(190,190,190,0.9)",
    accent: "#7f6df2",
    accentGlow: "rgba(127,109,242,0.15)",
    positive: "#4ade80",
    negative: "#ff6b6b",
  },
];

interface AppSettings {
  themeId: string;
  fontSize: "small" | "medium" | "large";
  showPreviewSnippets: boolean;
  showTimestamps: boolean;
  editorMaxWidth: number;
  reduceMotion: boolean;
  checkForUpdatesAutomatically: boolean;
}

const DEFAULTS: AppSettings = {
  themeId: "neurovault",
  fontSize: "medium",
  showPreviewSnippets: true,
  showTimestamps: true,
  editorMaxWidth: 720,
  reduceMotion: false,
  // Launching the app should not create an unexpected network request.
  checkForUpdatesAutomatically: false,
};

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem("nv.settings");
    if (raw) {
      const saved = { ...DEFAULTS, ...JSON.parse(raw) } as AppSettings;
      // One-time brand migration (2026-07-12): the app identity moved
      // to the icon's blue. Flip everyone to the NeuroVault theme ONCE;
      // any theme picked afterwards is respected forever.
      if (!localStorage.getItem("nv.theme-migrated-blue")) {
        localStorage.setItem("nv.theme-migrated-blue", "1");
        saved.themeId = "neurovault";
      }
      return saved;
    }
  } catch { /* corrupt */ }
  return DEFAULTS;
}

interface SettingsStore extends AppSettings {
  theme: Theme;
  update: (partial: Partial<AppSettings>) => void;
  syncFromStorage: () => void;
}

function withTheme(settings: AppSettings) {
  return {
    ...settings,
    theme: THEMES.find((theme) => theme.id === settings.themeId) ?? THEMES[0]!,
  };
}

export const useSettingsStore = create<SettingsStore>((set) => {
  const initial = loadSettings();
  return {
    ...withTheme(initial),
    update: (partial) =>
      set((state) => {
        const next = { ...state, ...partial };
        const theme = THEMES.find((t) => t.id === next.themeId) ?? THEMES[0]!;
        localStorage.setItem("nv.settings", JSON.stringify({
          themeId: next.themeId,
          fontSize: next.fontSize,
          showPreviewSnippets: next.showPreviewSnippets,
          showTimestamps: next.showTimestamps,
          editorMaxWidth: next.editorMaxWidth,
          reduceMotion: next.reduceMotion,
          checkForUpdatesAutomatically: next.checkForUpdatesAutomatically,
        }));
        return { ...next, theme };
      }),
    syncFromStorage: () => set(withTheme(loadSettings())),
  };
});
