import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBrainStore } from "../stores/brainStore";
import { ConsumerNavigation, type ConsumerDestination } from "./ConsumerNavigation";

const NAVIGATION_LABELS = [
  "Today",
  "Search",
  "Memories",
  "Activity",
  "Graph",
  "Needs attention",
  "Privacy & Trust",
] as const;

describe("ConsumerNavigation", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ proposals: [] }),
    }));
    useBrainStore.setState({
      brains: [
        {
          id: "primary",
          name: "Primary vault",
          description: "",
          created_at: "",
          is_active: true,
          vault_path: "/vaults/primary",
        },
      ],
      activeBrainId: "primary",
      activeBrainName: "Primary vault",
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("keeps the consumer menu labels and order stable", () => {
    render(
      <ConsumerNavigation
        active="today"
        onNavigate={vi.fn()}
        onOpenSettings={vi.fn()}
        onToggleCollapsed={vi.fn()}
      />,
    );

    const navigation = screen.getByRole("navigation", { name: "NeuroVault" });
    expect(within(navigation).getAllByRole("button").map((button) => button.textContent?.trim())).toEqual(
      NAVIGATION_LABELS,
    );
    expect(screen.getByRole("button", { name: "Open settings" })).toHaveTextContent("Settings");
  });

  it.each([
    ["Today", "today"],
    ["Search", "search"],
    ["Memories", "memories"],
    ["Activity", "activity"],
    ["Graph", "graph"],
    ["Needs attention", "attention"],
    ["Privacy & Trust", "trust"],
  ] as const)("maps %s to the %s destination", async (label, destination) => {
    const user = userEvent.setup();
    const onNavigate = vi.fn<(destination: ConsumerDestination) => void>();
    render(
      <ConsumerNavigation
        active="today"
        onNavigate={onNavigate}
        onOpenSettings={vi.fn()}
        onToggleCollapsed={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: label }));
    expect(onNavigate).toHaveBeenCalledOnce();
    expect(onNavigate).toHaveBeenCalledWith(destination);
  });

  it("keeps Settings separate from destination routing", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const onOpenSettings = vi.fn();
    render(
      <ConsumerNavigation
        active="today"
        onNavigate={onNavigate}
        onOpenSettings={onOpenSettings}
        onToggleCollapsed={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Open settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("preserves accessible menu names when the rail is collapsed", () => {
    render(
      <ConsumerNavigation
        active="graph"
        onNavigate={vi.fn()}
        onOpenSettings={vi.fn()}
        onToggleCollapsed={vi.fn()}
        collapsed
      />,
    );

    for (const label of NAVIGATION_LABELS) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Open settings" })).toBeInTheDocument();
  });

  it("marks the footer Settings destination active without adding it to the primary menu", () => {
    render(
      <ConsumerNavigation
        active="settings"
        onNavigate={vi.fn()}
        onOpenSettings={vi.fn()}
        onToggleCollapsed={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Open settings" })).toHaveAttribute("aria-current", "page");
    const navigation = screen.getByRole("navigation", { name: "NeuroVault" });
    expect(within(navigation).getAllByRole("button").map((button) => button.textContent?.trim())).toEqual(
      NAVIGATION_LABELS,
    );
  });

  it("keeps global-rail collapse separate from destination routing", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const onToggleCollapsed = vi.fn();
    render(
      <ConsumerNavigation
        active="today"
        onNavigate={onNavigate}
        onOpenSettings={vi.fn()}
        onToggleCollapsed={onToggleCollapsed}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Collapse navigation" }));
    expect(onToggleCollapsed).toHaveBeenCalledOnce();
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
