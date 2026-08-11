import axe from "axe-core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveConsumerHealth, type ConsumerHealthSignals } from "../lib/consumerHealth";
import { useBrainStore } from "../stores/brainStore";
import { useConsumerHealthStore } from "../stores/consumerHealthStore";
import { Onboarding } from "./Onboarding";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue(null) }));

const SIDECAR = "/Applications/NeuroVault.app/Contents/MacOS/neurovault-server";

function signalsWith(overrides: Partial<ConsumerHealthSignals> = {}): ConsumerHealthSignals {
  return {
    service: "online",
    brainCount: 1,
    activeBrainId: "main",
    activeBrainName: "Main",
    memories: 0,
    automaticRecall: "off",
    lastCheckedAt: Date.now(),
    ...overrides,
  };
}

function seed(overrides: Partial<ConsumerHealthSignals> = {}) {
  const signals = signalsWith(overrides);
  useConsumerHealthStore.setState({
    signals,
    health: deriveConsumerHealth(signals),
    refreshing: false,
    refresh: vi.fn().mockResolvedValue(undefined),
    setAutomaticRecall: vi.fn().mockResolvedValue(undefined),
  });
  useBrainStore.setState({
    brains: signals.activeBrainId
      ? [{
        id: signals.activeBrainId,
        name: signals.activeBrainName ?? "Main",
        description: "",
        created_at: "",
        is_active: true,
        vault_path: "/Users/test/.neurovault/brains/main/vault",
      }]
      : [],
    activeBrainId: signals.activeBrainId,
    activeBrainName: signals.activeBrainName ?? "Default",
    createBrain: vi.fn().mockResolvedValue({ brain_id: "created", name: "Fresh" }),
    switchBrain: vi.fn().mockResolvedValue(true),
    updateBrain: vi.fn().mockResolvedValue(true),
  });
}

/** Walk from the welcome screen to the connect step. */
function gotoConnectStep() {
  fireEvent.click(screen.getByRole("button", { name: /Start setup|Choose my files/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

describe("Onboarding — connecting an AI is a real step", () => {
  beforeEach(() => {
    localStorage.clear();
    invoke.mockReset();
    invoke.mockImplementation(async (command: string) => {
      if (command === "mcp_sidecar_path") return SIDECAR;
      if (command === "register_claude_code_mcp") return { created: true, updated: false };
      throw new Error(`unexpected command ${command}`);
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    seed();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("reaches a first-class Connect your AI step from the welcome screen", async () => {
    render(<Onboarding onOpenSettings={vi.fn()} />);

    gotoConnectStep();

    expect(screen.getByText("Step 2 · Connect your AI")).toBeInTheDocument();
    expect(
      screen.getByText(/NeuroVault is a memory for your AI — connect one so it can read and write your notes\./),
    ).toBeInTheDocument();
    // Every client is offered by name, not hidden behind a text link.
    for (const label of ["Claude Code", "Claude Desktop", "Cursor", "VS Code", "Other"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("mcp_sidecar_path"));
  });

  it("runs the one-click Claude Code register and then explains what success looks like", async () => {
    render(<Onboarding onOpenSettings={vi.fn()} />);
    gotoConnectStep();
    // Let the step's sidecar-path lookup settle first: vitest's module mocker
    // hands back an undefined namespace for a second dynamic import of the
    // same specifier while the first one is still in flight.
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("mcp_sidecar_path"));

    fireEvent.click(screen.getByRole("button", { name: "Connect Claude Code" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("register_claude_code_mcp"));
    expect(await screen.findByText(/Claude Code is connected\. Restart Claude Code/)).toBeInTheDocument();
    expect(screen.getByText(/it answers from this vault/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verify connection" })).toBeInTheDocument();
  });

  it("offers a copyable config for a non-Claude-Code client", async () => {
    render(<Onboarding onOpenSettings={vi.fn()} />);
    gotoConnectStep();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("mcp_sidecar_path"));

    fireEvent.click(screen.getByRole("button", { name: "Cursor" }));

    expect(screen.getByText(/~\/\.cursor\/mcp\.json/)).toBeInTheDocument();
    expect(await screen.findByText(new RegExp(SIDECAR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
  });

  it("recognises an AI client that has already used this vault", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => [{ ts: new Date().toISOString(), tool: "recall", args: {} }],
    } as Response);
    render(<Onboarding onOpenSettings={vi.fn()} />);
    gotoConnectStep();

    expect(await screen.findByText("An AI client has already used this vault.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect Claude Code" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
  });

  it("has no axe violations on the connect step", async () => {
    const { container } = render(<Onboarding onOpenSettings={vi.fn()} />);
    gotoConnectStep();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("mcp_sidecar_path"));

    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it("opens the full Connections panel on request", () => {
    const onOpenSettings = vi.fn();
    render(<Onboarding onOpenSettings={onOpenSettings} />);
    gotoConnectStep();

    fireEvent.click(screen.getByRole("button", { name: "All connection options" }));
    expect(onOpenSettings).toHaveBeenCalledWith("connections");
  });

  it("lets the user skip, but records the skip instead of pretending setup is done", () => {
    render(<Onboarding onOpenSettings={vi.fn()} />);
    gotoConnectStep();

    fireEvent.click(screen.getByRole("button", { name: /I'll do this later/ }));

    expect(screen.getByText("Step 3 · Automatic context")).toBeInTheDocument();
    expect(screen.getByText("No AI client connected yet")).toBeInTheDocument();
    expect(screen.getByText(/You skipped connecting an AI/)).toBeInTheDocument();
    // Skipping is recoverable without hunting through Settings.
    fireEvent.click(screen.getByRole("button", { name: "Connect an AI" }));
    expect(screen.getByText("Step 2 · Connect your AI")).toBeInTheDocument();
  });
});

describe("Onboarding — vault step under the auto-created Main brain", () => {
  beforeEach(() => {
    localStorage.clear();
    invoke.mockReset();
    invoke.mockResolvedValue(SIDECAR);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
    seed();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("offers rename/continue rather than a blind second vault when a brain exists", () => {
    render(<Onboarding onOpenSettings={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Start setup" }));

    expect(screen.getByText("Your vault is ready")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create vault" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("Main");
    expect(screen.getByText("/Users/test/.neurovault/brains/main/vault")).toBeInTheDocument();
  });

  it("renames the existing brain instead of creating a duplicate", async () => {
    render(<Onboarding onOpenSettings={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Start setup" }));

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Client work" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename and continue" }));

    await waitFor(() =>
      expect(useBrainStore.getState().updateBrain).toHaveBeenCalledWith("main", { name: "Client work" }),
    );
    expect(useBrainStore.getState().createBrain).not.toHaveBeenCalled();
    expect(await screen.findByText("Step 2 · Connect your AI")).toBeInTheDocument();
  });

  it("continues without a write when the name is unchanged", () => {
    render(<Onboarding onOpenSettings={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Start setup" }));

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(useBrainStore.getState().updateBrain).not.toHaveBeenCalled();
    expect(screen.getByText("Step 2 · Connect your AI")).toBeInTheDocument();
  });

  it("still creates a vault from scratch when no brain exists", async () => {
    seed({ activeBrainId: null, activeBrainName: null, brainCount: 0 });
    render(<Onboarding onOpenSettings={vi.fn()} />);

    // No vault at all is `setup_required`, so setup lands straight on step 1.
    expect(screen.getByText("Keep each project in its own boundary")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Fresh" } });
    fireEvent.click(screen.getByRole("button", { name: "Create vault" }));

    await waitFor(() =>
      expect(useBrainStore.getState().createBrain).toHaveBeenCalledWith("Fresh", "", undefined),
    );
  });

  it("reaches the create form explicitly when the user wants a separate vault", () => {
    render(<Onboarding onOpenSettings={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Start setup" }));

    fireEvent.click(screen.getByRole("button", { name: "Create a separate vault" }));
    expect(screen.getByRole("button", { name: "Create vault" })).toBeInTheDocument();
  });
});
