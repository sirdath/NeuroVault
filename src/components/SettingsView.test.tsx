import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THEMES, useSettingsStore, type ThemeId } from "../stores/settingsStore";
import { SettingsView } from "./SettingsView";

function savedSettings(themeId: ThemeId) {
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
    for (const label of ["General", "Sources", "Connections", "Vaults"]) {
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

    await user.click(screen.getByRole("button", { name: "Open Sources" }));
    expect(screen.getByRole("heading", { name: "Sources", level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage source folders" })).toBeInTheDocument();
  });

  it("lands contextual settings links on the requested section", () => {
    render(<SettingsView initialSection="connections" />);
    expect(screen.getByRole("heading", { name: "Connections", level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connections" })).toHaveAttribute("aria-current", "page");
  });

  it("shows all eight live theme previews and persists same-mode palette changes", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    const cards = THEMES.map((theme) => screen.getByRole("button", { name: new RegExp(`^${theme.name}:`) }));
    expect(cards).toHaveLength(8);

    const light = screen.getByRole("button", { name: /^Light:/ });
    const abyss = screen.getByRole("button", { name: /^Abyss:/ });
    const synapse = screen.getByRole("button", { name: /^Synapse:/ });
    expect(light).toHaveAttribute("aria-pressed", "true");
    expect(abyss).toHaveAttribute("aria-pressed", "false");

    await user.click(abyss);
    expect(light).toHaveAttribute("aria-pressed", "false");
    expect(abyss).toHaveAttribute("aria-pressed", "true");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement).toHaveAttribute("data-theme-id", "abyss");

    await user.click(synapse);
    expect(abyss).toHaveAttribute("aria-pressed", "false");
    expect(synapse).toHaveAttribute("aria-pressed", "true");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement).toHaveAttribute("data-theme-id", "synapse");
    expect(JSON.parse(localStorage.getItem("nv.settings") ?? "null")).toMatchObject({ themeId: "synapse" });
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
