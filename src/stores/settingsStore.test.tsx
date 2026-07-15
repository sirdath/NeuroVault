import { beforeEach, describe, expect, it } from "vitest";
import { THEMES, themeCssVars, useSettingsStore, type ThemeId } from "./settingsStore";

const persistedSettings = (themeId: string) => ({
  themeId,
  fontSize: "large",
  showPreviewSnippets: false,
  showTimestamps: false,
  editorMaxWidth: 860,
  reduceMotion: true,
  checkForUpdatesAutomatically: true,
});

const EXPECTED_THEME_IDS: ThemeId[] = [
  "light",
  "dark",
  "glacier",
  "parchment",
  "sage",
  "abyss",
  "graphite",
  "synapse",
];

function relativeLuminance(hex: string): number {
  const channels = hex.slice(1).match(/.{2}/g)?.map((value) => Number.parseInt(value, 16) / 255) ?? [];
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return (linear[0] ?? 0) * 0.2126 + (linear[1] ?? 0) * 0.7152 + (linear[2] ?? 0) * 0.0722;
}

function contrast(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("settingsStore themes", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.getState().syncFromStorage();
  });

  it("exposes eight unique palettes while resolving each to a native light or dark appearance", () => {
    expect(THEMES.map(({ id }) => id)).toEqual(EXPECTED_THEME_IDS);
    expect(new Set(THEMES.map(({ id }) => id)).size).toBe(THEMES.length);
    expect(new Set(THEMES.map(({ name }) => name)).size).toBe(THEMES.length);
    expect(THEMES.every(({ mode }) => mode === "light" || mode === "dark")).toBe(true);
    expect(THEMES.filter(({ mode }) => mode === "light")).toHaveLength(4);
    expect(THEMES.filter(({ mode }) => mode === "dark")).toHaveLength(4);
  });

  it("keeps recall and capture as distinct semantic colors in both modes", () => {
    for (const theme of THEMES) {
      expect(theme.accent).not.toBe(theme.capture);
      expect(theme.accentGlow).not.toBe(theme.captureGlow);
      expect(themeCssVars(theme)).toMatchObject({
        "--nv-accent": theme.accent,
        "--nv-capture": theme.capture,
        "--nv-capture-glow": theme.captureGlow,
      });
    }
  });

  it("keeps ordinary text and action labels readable in every palette", () => {
    for (const theme of THEMES) {
      for (const background of [theme.bg, theme.surfaceElevated]) {
        expect(contrast(theme.text, background), `${theme.name} text`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(theme.textMuted, background), `${theme.name} muted text`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(theme.textDim, background), `${theme.name} dim text`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(theme.onAccent, theme.accent), `${theme.name} accent label`).toBeGreaterThanOrEqual(4.5);
      expect(Object.keys(themeCssVars(theme))).toHaveLength(26);
      expect(Object.values(themeCssVars(theme)).every(Boolean)).toBe(true);
    }
  });

  it.each(THEMES)("persists and reapplies the $name palette", (theme) => {
    useSettingsStore.getState().update({ themeId: theme.id });

    const persisted = JSON.parse(localStorage.getItem("nv.settings") ?? "null") as {
      themeId: string;
    };
    expect(persisted.themeId).toBe(theme.id);
    expect(useSettingsStore.getState().theme).toMatchObject({ id: theme.id, mode: theme.mode });
    expect(document.documentElement).toHaveAttribute("data-theme", theme.mode);
    expect(document.documentElement).toHaveAttribute("data-theme-id", theme.id);
    expect(document.documentElement.style.colorScheme).toBe(theme.mode);
    for (const [property, value] of Object.entries(themeCssVars(theme))) {
      expect(document.documentElement.style.getPropertyValue(property)).toBe(value);
    }

    useSettingsStore.setState({ themeId: theme.id === "light" ? "dark" : "light" });
    useSettingsStore.getState().syncFromStorage();
    expect(useSettingsStore.getState()).toMatchObject({
      themeId: theme.id,
      theme: { id: theme.id, mode: theme.mode },
    });
  });

  it.each([
    "neurovault",
    "midnight",
    "claude",
    "chatgpt",
    "github",
    "rosepine",
    "nord",
    "obsidian",
    "unknown-theme",
  ])("migrates the legacy %s palette to Light without losing other settings", (legacyThemeId) => {
    localStorage.setItem("nv.settings", JSON.stringify(persistedSettings(legacyThemeId)));

    useSettingsStore.getState().syncFromStorage();

    expect(useSettingsStore.getState()).toMatchObject({
      themeId: "light",
      theme: { id: "light", mode: "light" },
      fontSize: "large",
      showPreviewSnippets: false,
      showTimestamps: false,
      editorMaxWidth: 860,
      reduceMotion: true,
      checkForUpdatesAutomatically: true,
    });
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });

  it("falls back to the complete Light defaults when saved settings are corrupt", () => {
    localStorage.setItem("nv.settings", "{not-json");

    useSettingsStore.getState().syncFromStorage();

    expect(useSettingsStore.getState()).toMatchObject({
      themeId: "light",
      theme: { id: "light", mode: "light" },
      fontSize: "medium",
      showPreviewSnippets: true,
      showTimestamps: true,
      editorMaxWidth: 720,
      reduceMotion: false,
      checkForUpdatesAutomatically: false,
    });
  });
});
