import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../stores/settingsStore";
import { SettingsView } from "./SettingsView";

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

describe("in-app Settings", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("nv.settings", savedSettings("light"));
    useSettingsStore.getState().syncFromStorage();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline in test")));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("keeps one canonical home for settings without duplicate review or trust sections", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    const sections = screen.getByRole("navigation", { name: "Settings sections" });
    for (const label of ["General", "Connections", "Vaults", "Advanced"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "Memory" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Privacy & Trust" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Connections" }));
    expect(screen.getByRole("heading", { name: "Connections", level: 2 })).toBeInTheDocument();
    expect(sections).toContainElement(screen.getByRole("button", { name: "Connections" }));
  });

  it("lands contextual settings links on the requested section", () => {
    render(<SettingsView initialSection="connections" />);
    expect(screen.getByRole("heading", { name: "Connections", level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connections" })).toHaveAttribute("aria-current", "page");
  });

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
});
