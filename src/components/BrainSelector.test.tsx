import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBrainStore } from "../stores/brainStore";
import { BrainSelector } from "./BrainSelector";

describe("BrainSelector manager mode", () => {
  const switchBrain = vi.fn().mockResolvedValue(true);

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ note_count: 0, total_bytes: 0, last_modified_secs: 0 }),
    }));
    switchBrain.mockClear();
    useBrainStore.setState({
      brains: [
        { id: "primary", name: "Primary vault", description: "", created_at: "", is_active: true },
        { id: "archive", name: "Archive vault", description: "", created_at: "", is_active: false },
      ],
      activeBrainId: "primary",
      activeBrainName: "Primary vault",
      loading: false,
      switchBrain,
      loadBrains: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("lists and manages vaults without duplicating the active-vault switcher", async () => {
    const user = userEvent.setup();
    render(<BrainSelector triggerLabel="Open vault manager" placement="down" mode="manage" />);

    await user.click(screen.getByRole("button", { name: "Open vault manager" }));
    expect(screen.getByRole("group", { name: "Primary vault, active vault" })).toBeInTheDocument();

    const archive = screen.getByRole("group", { name: "Archive vault" });
    fireEvent.click(archive);
    expect(switchBrain).not.toHaveBeenCalled();
  });
});
