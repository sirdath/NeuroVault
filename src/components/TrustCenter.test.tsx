import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveConsumerHealth, type ConsumerHealthSignals } from "../lib/consumerHealth";
import { useBrainStore } from "../stores/brainStore";
import { useConsumerHealthStore } from "../stores/consumerHealthStore";
import { useNoteStore } from "../stores/noteStore";
import { TrustCenter } from "./TrustCenter";

describe("TrustCenter privacy contract", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ records: [], count: 0 }),
    }));

    const signals: ConsumerHealthSignals = {
      service: "online",
      brainCount: 1,
      activeBrainId: "primary",
      activeBrainName: "Primary vault",
      memories: 12,
      automaticRecall: "on",
      lastCheckedAt: Date.now(),
    };
    useConsumerHealthStore.setState({ signals, health: deriveConsumerHealth(signals), refreshing: false });
    useBrainStore.setState({
      brains: [{
        id: "primary",
        name: "Primary vault",
        description: "",
        created_at: "",
        is_active: true,
        vault_path: "/vaults/primary",
      }],
      activeBrainId: "primary",
      activeBrainName: "Primary vault",
    });
    useNoteStore.setState({ vaultPath: "/vaults/primary" });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("keeps the complete outbound-data contract in its canonical view", () => {
    render(
      <TrustCenter
        onOpenActivity={vi.fn()}
        onOpenTrash={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByText("Optional model features")).toBeInTheDocument();
    expect(screen.getByText(/deliberately enable a provider-backed compile feature/i)).toBeInTheDocument();
    expect(screen.getByText("Fonts & interface")).toBeInTheDocument();
    expect(screen.getByText(/uses local system fonts and does not fetch fonts from a CDN/i)).toBeInTheDocument();
  });
});
