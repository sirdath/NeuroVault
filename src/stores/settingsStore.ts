import { create } from "zustand";

export type ThemeMode = "light" | "dark";

export interface Theme {
  id: ThemeMode;
  mode: ThemeMode;
  name: string;
  description: string;
  bg: string;
  surface: string;
  surface2: string;
  surfaceElevated: string;
  border: string;
  borderStrong: string;
  text: string;
  textMuted: string;
  textDim: string;
  accent: string;
  accentGlow: string;
  capture: string;
  captureGlow: string;
  onAccent: string;
  positive: string;
  warning: string;
  negative: string;
  navBg: string;
  navSurface: string;
  navBorder: string;
  navText: string;
  navMuted: string;
  navDim: string;
  navActive: string;
  shadow: string;
  overlay: string;
}

/**
 * NeuroVault deliberately has one visual identity and two appearances.
 * The old palette gallery made every part of the app feel unrelated; these
 * two modes share the same Cortex Ink identity: cobalt marks recall and
 * context, copper marks capture and change, and teal marks verified state.
 */
export const THEMES: Theme[] = [
  {
    id: "light",
    mode: "light",
    name: "Light",
    description: "Warm paper, ink navigation, cobalt recall, copper capture",
    bg: "#f7f6f2",
    surface: "#f0f2f5",
    surface2: "#e7eaf0",
    surfaceElevated: "#ffffff",
    border: "#d9dee6",
    borderStrong: "#bfc7d3",
    text: "#171c25",
    textMuted: "#475365",
    textDim: "#5e697b",
    accent: "#3457d5",
    accentGlow: "rgba(52, 87, 213, 0.10)",
    capture: "#a84f2a",
    captureGlow: "rgba(168, 79, 42, 0.09)",
    onAccent: "#ffffff",
    positive: "#17745f",
    warning: "#8b5a00",
    negative: "#b83b4b",
    navBg: "linear-gradient(165deg, #121720 0%, #0d121a 100%)",
    navSurface: "rgba(255, 255, 255, 0.055)",
    navBorder: "rgba(255, 255, 255, 0.085)",
    navText: "#f5f7fb",
    navMuted: "#c1c7d2",
    navDim: "#8d96a5",
    navActive: "linear-gradient(90deg, rgba(52, 87, 213, 0.18), rgba(168, 79, 42, 0.07))",
    shadow: "0 12px 32px rgba(21, 29, 41, 0.10)",
    overlay: "rgba(13, 18, 26, 0.46)",
  },
  {
    id: "dark",
    mode: "dark",
    name: "Dark",
    description: "Deep ink, quiet surfaces, cobalt recall, copper capture",
    bg: "#0b1017",
    surface: "#111821",
    surface2: "#17212d",
    surfaceElevated: "#1b2632",
    border: "#273443",
    borderStrong: "#3a485a",
    text: "#eef2f8",
    textMuted: "#abb6c5",
    textDim: "#8d99aa",
    accent: "#8da6ff",
    accentGlow: "rgba(141, 166, 255, 0.12)",
    capture: "#f0a06c",
    captureGlow: "rgba(240, 160, 108, 0.10)",
    onAccent: "#0a1222",
    positive: "#54c9a7",
    warning: "#f1c56b",
    negative: "#ff7a88",
    navBg: "linear-gradient(165deg, #0a0e14 0%, #0c1118 100%)",
    navSurface: "rgba(255, 255, 255, 0.05)",
    navBorder: "rgba(255, 255, 255, 0.08)",
    navText: "#f5f7fb",
    navMuted: "#c1c7d2",
    navDim: "#8d96a5",
    navActive: "linear-gradient(90deg, rgba(141, 166, 255, 0.17), rgba(240, 160, 108, 0.06))",
    shadow: "0 18px 48px rgba(0, 0, 0, 0.34)",
    overlay: "rgba(2, 7, 14, 0.68)",
  },
];

export function themeCssVars(theme: Theme): Record<string, string> {
  return {
    "--nv-bg": theme.bg,
    "--nv-surface": theme.surface,
    "--nv-surface-2": theme.surface2,
    "--nv-surface-elevated": theme.surfaceElevated,
    "--nv-border": theme.border,
    "--nv-border-strong": theme.borderStrong,
    "--nv-text": theme.text,
    "--nv-text-muted": theme.textMuted,
    "--nv-text-dim": theme.textDim,
    "--nv-accent": theme.accent,
    "--nv-accent-glow": theme.accentGlow,
    "--nv-capture": theme.capture,
    "--nv-capture-glow": theme.captureGlow,
    "--nv-on-accent": theme.onAccent,
    "--nv-positive": theme.positive,
    "--nv-warning": theme.warning,
    "--nv-negative": theme.negative,
    "--nv-nav-bg": theme.navBg,
    "--nv-nav-surface": theme.navSurface,
    "--nv-nav-border": theme.navBorder,
    "--nv-nav-text": theme.navText,
    "--nv-nav-muted": theme.navMuted,
    "--nv-nav-dim": theme.navDim,
    "--nv-nav-active": theme.navActive,
    "--nv-shadow": theme.shadow,
    "--nv-overlay": theme.overlay,
  };
}

export function applyThemeToDocument(theme: Theme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = theme.mode;
  root.style.colorScheme = theme.mode;
  for (const [key, value] of Object.entries(themeCssVars(theme))) {
    root.style.setProperty(key, value);
  }
}

interface AppSettings {
  themeId: ThemeMode;
  fontSize: "small" | "medium" | "large";
  showPreviewSnippets: boolean;
  showTimestamps: boolean;
  editorMaxWidth: number;
  reduceMotion: boolean;
  checkForUpdatesAutomatically: boolean;
}

const DEFAULTS: AppSettings = {
  themeId: "light",
  fontSize: "medium",
  showPreviewSnippets: true,
  showTimestamps: true,
  editorMaxWidth: 720,
  reduceMotion: false,
  // Launching the app should not create an unexpected network request.
  checkForUpdatesAutomatically: false,
};

function normalizeThemeId(value: unknown): ThemeMode {
  return value === "dark" ? "dark" : "light";
}

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem("nv.settings");
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AppSettings> & { themeId?: unknown };
      return {
        ...DEFAULTS,
        ...parsed,
        // Every legacy theme was dark-only. Start the new visual system in
        // the reference-inspired light mode; subsequent Light/Dark choices
        // are persisted exactly.
        themeId: normalizeThemeId(parsed.themeId),
      };
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
  const themeId = normalizeThemeId(settings.themeId);
  return {
    ...settings,
    themeId,
    theme: THEMES.find((theme) => theme.id === themeId) ?? THEMES[0]!,
  };
}

export const useSettingsStore = create<SettingsStore>((set) => {
  const initial = loadSettings();
  const themed = withTheme(initial);
  applyThemeToDocument(themed.theme);
  return {
    ...themed,
    update: (partial) =>
      set((state) => {
        const next = withTheme({ ...state, ...partial });
        localStorage.setItem("nv.settings", JSON.stringify({
          themeId: next.themeId,
          fontSize: next.fontSize,
          showPreviewSnippets: next.showPreviewSnippets,
          showTimestamps: next.showTimestamps,
          editorMaxWidth: next.editorMaxWidth,
          reduceMotion: next.reduceMotion,
          checkForUpdatesAutomatically: next.checkForUpdatesAutomatically,
        }));
        applyThemeToDocument(next.theme);
        return next;
      }),
    syncFromStorage: () => set(() => {
      const next = withTheme(loadSettings());
      applyThemeToDocument(next.theme);
      return next;
    }),
  };
});
