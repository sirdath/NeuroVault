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
    for (const label of ["General", "Connections", "Vaults"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "Developer" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Memory" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Privacy & Trust" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Connections" }));
    expect(screen.getByRole("heading", { name: "Connections", level: 2 })).toBeInTheDocument();
    expect(sections).toContainElement(screen.getByRole("button", { name: "Connections" }));
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("Claude Desktop")).toBeInTheDocument();
    expect(screen.getByText("Cursor")).toBeInTheDocument();
    expect(screen.getByText("VS Code / Continue")).toBeInTheDocument();
    expect(screen.getByText("Other MCP client")).toBeInTheDocument();
    expect(screen.queryByText(/Automatic Memory \(Claude Code\)/i)).not.toBeInTheDocument();
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

  it("keeps technical controls behind an explicit developer-options switch", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    const developerSwitch = screen.getByRole("switch", { name: "Show developer options" });
    expect(developerSwitch).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("button", { name: "Developer" })).not.toBeInTheDocument();

    await user.click(developerSwitch);

    expect(developerSwitch).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: "Developer" })).toBeInTheDocument();
  });
});
