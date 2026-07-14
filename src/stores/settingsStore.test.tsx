import { beforeEach, describe, expect, it } from "vitest";
import { THEMES, themeCssVars, useSettingsStore } from "./settingsStore";

const persistedSettings = (themeId: string) => ({
  themeId,
  fontSize: "large",
  showPreviewSnippets: false,
  showTimestamps: false,
  editorMaxWidth: 860,
  reduceMotion: true,
  checkForUpdatesAutomatically: true,
});

describe("settingsStore themes", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.getState().syncFromStorage();
  });

  it("exposes one Light and one Dark appearance for the same product identity", () => {
    expect(THEMES.map(({ id, mode, name }) => ({ id, mode, name }))).toEqual([
      { id: "light", mode: "light", name: "Light" },
      { id: "dark", mode: "dark", name: "Dark" },
    ]);
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

  it.each(["light", "dark"] as const)("persists and reapplies %s mode", (themeId) => {
    useSettingsStore.getState().update({ themeId });

    const persisted = JSON.parse(localStorage.getItem("nv.settings") ?? "null") as {
      themeId: string;
    };
    expect(persisted.themeId).toBe(themeId);
    expect(useSettingsStore.getState().theme).toMatchObject({ id: themeId, mode: themeId });
    expect(document.documentElement).toHaveAttribute("data-theme", themeId);
    expect(document.documentElement.style.colorScheme).toBe(themeId);

    useSettingsStore.setState({ themeId: themeId === "light" ? "dark" : "light" });
    useSettingsStore.getState().syncFromStorage();
    expect(useSettingsStore.getState()).toMatchObject({
      themeId,
      theme: { id: themeId, mode: themeId },
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
