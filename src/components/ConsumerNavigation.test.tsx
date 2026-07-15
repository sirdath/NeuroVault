import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBrainStore } from "../stores/brainStore";
import { ConsumerNavigation, type ConsumerDestination } from "./ConsumerNavigation";

const NAVIGATION_LABELS = [
  "Memories",
  "Graph",
  "Today",
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
      switchBrain: vi.fn().mockResolvedValue(true),
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
    ["Memories", "memories"],
    ["Graph", "graph"],
    ["Today", "today"],
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

  it("hides Review when nothing actionable is waiting", () => {
    render(
      <ConsumerNavigation
        active="today"
        onNavigate={vi.fn()}
        onOpenSettings={vi.fn()}
        onToggleCollapsed={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Review" })).not.toBeInTheDocument();
  });

  it("shows Review with a badge when an actionable proposal is waiting", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ proposals: [{ action: "memory_strengthened" }] }),
    } as Response);
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(
      <ConsumerNavigation
        active="today"
        onNavigate={onNavigate}
        onOpenSettings={vi.fn()}
        onToggleCollapsed={vi.fn()}
      />,
    );

    const review = await screen.findByRole("button", { name: /Review/ });
    expect(review).toHaveTextContent("1");
    await user.click(review);
    expect(onNavigate).toHaveBeenCalledWith("attention");
  });

  it("keeps Review visible while its destination is active", () => {
    render(
      <ConsumerNavigation
        active="attention"
        onNavigate={vi.fn()}
        onOpenSettings={vi.fn()}
        onToggleCollapsed={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Review" })).toHaveAttribute("aria-current", "page");
  });

  it("clears a prior vault's Review item when the next scoped count cannot load", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ proposals: [{ action: "memory_strengthened" }] }),
      } as Response)
      .mockRejectedValueOnce(new Error("offline"));
    render(
      <ConsumerNavigation
        active="today"
        onNavigate={vi.fn()}
        onOpenSettings={vi.fn()}
        onToggleCollapsed={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Review/ })).toHaveTextContent("1");
    });
    act(() => {
      useBrainStore.setState({
        brains: [
          { id: "second", name: "Second vault", description: "", created_at: "", is_active: true },
        ],
        activeBrainId: "second",
        activeBrainName: "Second vault",
      });
    });

    await waitFor(() => expect(screen.queryByRole("button", { name: "Review" })).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining("brain_id=second"),
      expect.any(Object),
    );
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

  it("does not duplicate vault controls when only one vault exists", () => {
    render(
      <ConsumerNavigation
        active="memories"
        onNavigate={vi.fn()}
        onOpenSettings={vi.fn()}
        onToggleCollapsed={vi.fn()}
      />,
    );

    expect(screen.queryByRole("combobox", { name: "Active vault" })).not.toBeInTheDocument();
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

  it("moves to Memories and locks the vault control while switching", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    let finishSwitch: (() => void) | undefined;
    const switchBrain = vi.fn(() => new Promise<void>((resolve) => { finishSwitch = resolve; }));
    useBrainStore.setState({
      brains: [
        { id: "primary", name: "Primary vault", description: "", created_at: "", is_active: true, vault_path: "/vaults/primary" },
        { id: "second", name: "Second vault", description: "", created_at: "", is_active: false, vault_path: "/vaults/second" },
      ],
      activeBrainId: "primary",
      activeBrainName: "Primary vault",
      switchBrain,
    });
    render(
      <ConsumerNavigation
        active="graph"
        onNavigate={onNavigate}
        onOpenSettings={vi.fn()}
        onToggleCollapsed={vi.fn()}
      />,
    );

    await user.selectOptions(screen.getByRole("combobox", { name: "Active vault" }), "second");
    expect(switchBrain).toHaveBeenCalledWith("second");
    expect(onNavigate).toHaveBeenCalledWith("memories");
    expect(screen.getByRole("combobox", { name: "Active vault" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Switching to Second vault");

    finishSwitch?.();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Active vault" })).toBeEnabled());
  });

  it("reports a failed vault switch without leaving the scoped destination active", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const switchBrain = vi.fn().mockRejectedValue(new Error("activation failed"));
    useBrainStore.setState({
      brains: [
        { id: "primary", name: "Primary vault", description: "", created_at: "", is_active: true, vault_path: "/vaults/primary" },
        { id: "second", name: "Second vault", description: "", created_at: "", is_active: false, vault_path: "/vaults/second" },
      ],
      activeBrainId: "primary",
      activeBrainName: "Primary vault",
      switchBrain,
    });
    render(
      <ConsumerNavigation
        active="graph"
        onNavigate={onNavigate}
        onOpenSettings={vi.fn()}
        onToggleCollapsed={vi.fn()}
      />,
    );

    await user.selectOptions(screen.getByRole("combobox", { name: "Active vault" }), "second");

    expect(onNavigate).toHaveBeenCalledWith("memories");
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't switch vault");
    expect(screen.getByRole("combobox", { name: "Active vault" })).toBeEnabled();
  });
});
