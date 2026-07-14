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
 * two modes keep the same quiet blue undertone while adapting contrast.
 */
export const THEMES: Theme[] = [
  {
    id: "light",
    mode: "light",
    name: "Light",
    description: "Warm paper, slate navigation, quiet blue details",
    bg: "#f8f7f5",
    surface: "#f3f6fa",
    surface2: "#ecf1f7",
    surfaceElevated: "#ffffff",
    border: "#dde3ea",
    borderStrong: "#c9d3df",
    text: "#20242d",
    textMuted: "#4f5a69",
    textDim: "#5f6875",
    accent: "#4058c9",
    accentGlow: "rgba(64, 88, 201, 0.10)",
    onAccent: "#ffffff",
    positive: "#237a57",
    warning: "#8a5c00",
    negative: "#c24151",
    navBg: "linear-gradient(160deg, #3a4654 0%, #2b3947 58%, #25384a 100%)",
    navSurface: "rgba(255, 255, 255, 0.075)",
    navBorder: "rgba(255, 255, 255, 0.11)",
    navText: "#f4f7fa",
    navMuted: "#ccd4de",
    navDim: "#9aa7b7",
    navActive: "rgba(255, 255, 255, 0.14)",
    shadow: "0 18px 55px rgba(36, 52, 73, 0.13)",
    overlay: "rgba(20, 29, 42, 0.44)",
  },
  {
    id: "dark",
    mode: "dark",
    name: "Dark",
    description: "Deep ink, softened contrast, luminous blue details",
    bg: "#101720",
    surface: "#17212c",
    surface2: "#1b2734",
    surfaceElevated: "#1e2a37",
    border: "#2a3948",
    borderStrong: "#3b4b5d",
    text: "#edf2f7",
    textMuted: "#aab6c5",
    textDim: "#78879b",
    accent: "#7b91ff",
    accentGlow: "rgba(123, 145, 255, 0.16)",
    onAccent: "#0c1420",
    positive: "#55d6a0",
    warning: "#f3c969",
    negative: "#ff7b86",
    navBg: "linear-gradient(160deg, #182432 0%, #0f1924 100%)",
    navSurface: "rgba(255, 255, 255, 0.065)",
    navBorder: "rgba(255, 255, 255, 0.09)",
    navText: "#f4f7fa",
    navMuted: "#c7d1dd",
    navDim: "#8f9dad",
    navActive: "rgba(123, 145, 255, 0.17)",
    shadow: "0 20px 64px rgba(0, 0, 0, 0.34)",
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
