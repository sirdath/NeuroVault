import { create } from "zustand";

export type ThemeMode = "light" | "dark";

export type ThemeId =
  | "light"
  | "dark"
  | "glacier"
  | "parchment"
  | "sage"
  | "abyss"
  | "graphite"
  | "synapse";

export interface Theme {
  id: ThemeId;
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
 * Every NeuroVault palette shares one semantic visual language: the primary
 * accent marks recall and context, copper marks capture and change, and green
 * marks verified state. Theme identity stays separate from light/dark mode so
 * native chrome and CodeMirror receive the correct system appearance.
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
  {
    id: "glacier",
    mode: "light",
    name: "Glacier",
    description: "Cool paper, arctic recall, warm capture",
    bg: "#F4F7FB",
    surface: "#EAF0F7",
    surface2: "#DDE7F2",
    surfaceElevated: "#FFFFFF",
    border: "#CDD8E6",
    borderStrong: "#AAB9CC",
    text: "#152033",
    textMuted: "#42526A",
    textDim: "#5B687A",
    accent: "#3157C8",
    accentGlow: "rgba(49, 87, 200, 0.12)",
    capture: "#974323",
    captureGlow: "rgba(151, 67, 35, 0.10)",
    onAccent: "#FFFFFF",
    positive: "#126B57",
    warning: "#7B5000",
    negative: "#AE344A",
    navBg: "linear-gradient(165deg, #111D2D 0%, #0C1624 100%)",
    navSurface: "rgba(255, 255, 255, 0.060)",
    navBorder: "rgba(255, 255, 255, 0.095)",
    navText: "#F6F9FF",
    navMuted: "#C3CDDA",
    navDim: "#96A4B6",
    navActive: "linear-gradient(90deg, rgba(83, 119, 232, 0.24), rgba(240, 148, 96, 0.08))",
    shadow: "0 14px 36px rgba(24, 45, 74, 0.12)",
    overlay: "rgba(8, 18, 32, 0.48)",
  },
  {
    id: "parchment",
    mode: "light",
    name: "Parchment",
    description: "Warm editorial paper and restrained ink",
    bg: "#F8F1E5",
    surface: "#EFE6D8",
    surface2: "#E4D9C9",
    surfaceElevated: "#FFFDF8",
    border: "#D8CCBA",
    borderStrong: "#BBAA92",
    text: "#29231D",
    textMuted: "#554B40",
    textDim: "#6A5E50",
    accent: "#304FAF",
    accentGlow: "rgba(48, 79, 175, 0.11)",
    capture: "#93401F",
    captureGlow: "rgba(147, 64, 31, 0.10)",
    onAccent: "#FFFFFF",
    positive: "#176953",
    warning: "#795000",
    negative: "#A83448",
    navBg: "linear-gradient(165deg, #211D1B 0%, #171514 100%)",
    navSurface: "rgba(255, 250, 242, 0.060)",
    navBorder: "rgba(255, 250, 242, 0.095)",
    navText: "#FBF6EE",
    navMuted: "#D5C9BA",
    navDim: "#AA9C8D",
    navActive: "linear-gradient(90deg, rgba(79, 105, 206, 0.22), rgba(194, 97, 54, 0.09))",
    shadow: "0 14px 34px rgba(70, 52, 33, 0.13)",
    overlay: "rgba(37, 29, 22, 0.46)",
  },
  {
    id: "sage",
    mode: "light",
    name: "Sage",
    description: "Soft mineral green with cobalt intelligence",
    bg: "#F1F5F0",
    surface: "#E7EEE7",
    surface2: "#DCE7DE",
    surfaceElevated: "#FBFDFB",
    border: "#CAD8CD",
    borderStrong: "#A7BAAD",
    text: "#18231D",
    textMuted: "#43534A",
    textDim: "#596960",
    accent: "#2D53B5",
    accentGlow: "rgba(45, 83, 181, 0.11)",
    capture: "#914426",
    captureGlow: "rgba(145, 68, 38, 0.10)",
    onAccent: "#FFFFFF",
    positive: "#126B51",
    warning: "#775000",
    negative: "#A93649",
    navBg: "linear-gradient(165deg, #111B18 0%, #0C1512 100%)",
    navSurface: "rgba(245, 255, 248, 0.055)",
    navBorder: "rgba(245, 255, 248, 0.090)",
    navText: "#F3FAF5",
    navMuted: "#C2D1C6",
    navDim: "#92A59A",
    navActive: "linear-gradient(90deg, rgba(73, 106, 210, 0.21), rgba(184, 90, 54, 0.08))",
    shadow: "0 14px 36px rgba(30, 58, 42, 0.12)",
    overlay: "rgba(10, 25, 18, 0.47)",
  },
  {
    id: "abyss",
    mode: "dark",
    name: "Abyss",
    description: "Deep ocean ink with luminous blue recall",
    bg: "#07131E",
    surface: "#0C1C29",
    surface2: "#102434",
    surfaceElevated: "#122638",
    border: "#21394B",
    borderStrong: "#345267",
    text: "#ECF5FC",
    textMuted: "#B2C2CF",
    textDim: "#91A4B4",
    accent: "#8FB4FF",
    accentGlow: "rgba(143, 180, 255, 0.14)",
    capture: "#F4A574",
    captureGlow: "rgba(244, 165, 116, 0.11)",
    onAccent: "#071426",
    positive: "#62D2AC",
    warning: "#F1C46E",
    negative: "#FF8292",
    navBg: "linear-gradient(165deg, #030B12 0%, #06111A 100%)",
    navSurface: "rgba(225, 244, 255, 0.050)",
    navBorder: "rgba(225, 244, 255, 0.085)",
    navText: "#F1F7FC",
    navMuted: "#B8C8D5",
    navDim: "#8296A7",
    navActive: "linear-gradient(90deg, rgba(113, 163, 255, 0.22), rgba(244, 165, 116, 0.07))",
    shadow: "0 20px 56px rgba(0, 5, 10, 0.50)",
    overlay: "rgba(0, 6, 12, 0.74)",
  },
  {
    id: "graphite",
    mode: "dark",
    name: "Graphite",
    description: "Neutral charcoal and precise luminous marks",
    bg: "#101214",
    surface: "#171A1E",
    surface2: "#1D2126",
    surfaceElevated: "#22262B",
    border: "#30353C",
    borderStrong: "#474E58",
    text: "#F2F4F7",
    textMuted: "#BAC0C9",
    textDim: "#969EA9",
    accent: "#9BADFF",
    accentGlow: "rgba(155, 173, 255, 0.13)",
    capture: "#F0A06C",
    captureGlow: "rgba(240, 160, 108, 0.10)",
    onAccent: "#0A1020",
    positive: "#65CDAE",
    warning: "#EEC36D",
    negative: "#FF7F8D",
    navBg: "linear-gradient(165deg, #090A0C 0%, #0D0F11 100%)",
    navSurface: "rgba(255, 255, 255, 0.050)",
    navBorder: "rgba(255, 255, 255, 0.082)",
    navText: "#F4F5F7",
    navMuted: "#C2C5CB",
    navDim: "#8E949D",
    navActive: "linear-gradient(90deg, rgba(155, 173, 255, 0.18), rgba(240, 160, 108, 0.06))",
    shadow: "0 20px 52px rgba(0, 0, 0, 0.42)",
    overlay: "rgba(0, 0, 0, 0.70)",
  },
  {
    id: "synapse",
    mode: "dark",
    name: "Synapse",
    description: "Midnight violet with warm neural signals",
    bg: "#120E1B",
    surface: "#1B1527",
    surface2: "#231B31",
    surfaceElevated: "#292038",
    border: "#3B2E4D",
    borderStrong: "#58446F",
    text: "#F5F1FA",
    textMuted: "#C6BCD2",
    textDim: "#A398B2",
    accent: "#B2A1FF",
    accentGlow: "rgba(178, 161, 255, 0.15)",
    capture: "#F3A778",
    captureGlow: "rgba(243, 167, 120, 0.11)",
    onAccent: "#100C20",
    positive: "#68D2B0",
    warning: "#EFC66F",
    negative: "#FF8299",
    navBg: "linear-gradient(165deg, #090711 0%, #100B19 100%)",
    navSurface: "rgba(250, 241, 255, 0.052)",
    navBorder: "rgba(250, 241, 255, 0.088)",
    navText: "#F8F4FC",
    navMuted: "#CBBFD6",
    navDim: "#9689A5",
    navActive: "linear-gradient(90deg, rgba(178, 161, 255, 0.22), rgba(243, 167, 120, 0.07))",
    shadow: "0 20px 56px rgba(5, 2, 12, 0.52)",
    overlay: "rgba(6, 3, 13, 0.72)",
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
  root.dataset.themeId = theme.id;
  root.style.colorScheme = theme.mode;
  for (const [key, value] of Object.entries(themeCssVars(theme))) {
    root.style.setProperty(key, value);
  }
}

interface AppSettings {
  themeId: ThemeId;
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

function normalizeThemeId(value: unknown): ThemeId {
  return typeof value === "string" && THEMES.some((theme) => theme.id === value)
    ? value as ThemeId
    : "light";
}

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem("nv.settings");
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AppSettings> & { themeId?: unknown };
      return {
        ...DEFAULTS,
        ...parsed,
        // Unknown and retired palette IDs migrate to the reference-inspired
        // Light appearance; every current palette is persisted exactly.
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
