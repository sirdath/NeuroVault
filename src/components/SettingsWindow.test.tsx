import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../stores/settingsStore";
import { SettingsView } from "./SettingsView";
import { SettingsWindow } from "./SettingsWindow";

function savedSettings(themeId: "light" | "dark") {
  return JSON.stringify({
    themeId,
    fontSize: "medium",
    showPreviewSnippets: true,
    showTimestamps: true,
    editorMaxWidth: 720,
    reduceMotion: false,
    checkForUpdatesAutomatically: false,
  });
}

describe("Settings theme controls", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("nv.settings", savedSettings("light"));
    useSettingsStore.getState().syncFromStorage();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline in test")));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("exposes the selected Light/Dark appearance as a pressed toggle", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    const light = screen.getByRole("button", { name: /^Light/ });
    const dark = screen.getByRole("button", { name: /^Dark/ });
    expect(light).toHaveAttribute("aria-pressed", "true");
    expect(dark).toHaveAttribute("aria-pressed", "false");

    await user.click(dark);
    expect(light).toHaveAttribute("aria-pressed", "false");
    expect(dark).toHaveAttribute("aria-pressed", "true");
  });

  it("syncs a theme change from another window and removes the listener on unmount", async () => {
    const { unmount } = render(<SettingsWindow />);

    localStorage.setItem("nv.settings", savedSettings("dark"));
    window.dispatchEvent(new StorageEvent("storage", {
      key: "nv.settings",
      newValue: savedSettings("dark"),
      storageArea: localStorage,
    }));

    await waitFor(() => expect(useSettingsStore.getState().themeId).toBe("dark"));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");

    unmount();
    localStorage.setItem("nv.settings", savedSettings("light"));
    window.dispatchEvent(new StorageEvent("storage", {
      key: "nv.settings",
      newValue: savedSettings("light"),
      storageArea: localStorage,
    }));
    expect(useSettingsStore.getState().themeId).toBe("dark");
  });
});
