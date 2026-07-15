import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBrainStore } from "../stores/brainStore";
import MemoryReview, { type Proposal } from "./MemoryReview";

const proposal: Proposal = {
  proposal_id: "proposal-alpha",
  brain_id: "alpha",
  action: "memory_strengthened",
  memory_type: "note",
  object_id: "memory-1",
  title: "Useful memory",
  reason: "This memory helped complete a task.",
  band: "high",
  fields: [],
  evidence: [],
  review_status: "unreviewed",
  application_status: "pending",
  proposed_at: "2026-07-14T08:00:00Z",
};

describe("MemoryReview vault scoping", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/journal_events")) {
        return { ok: true, json: async () => ({ events: [] }) };
      }
      if (init?.method === "POST") {
        return { ok: true, text: async () => "", json: async () => ({ changed: true }) };
      }
      const brainId = new URL(url).searchParams.get("brain_id");
      return {
        ok: true,
        json: async () => ({
          brain: brainId,
          proposals: brainId === "alpha" ? [proposal] : [],
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    useBrainStore.setState({ activeBrainId: "alpha", activeBrainName: "Alpha" });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("sends a decision with the vault that produced the card", async () => {
    const user = userEvent.setup();
    render(<MemoryReview tab="pending" />);

    await user.click(await screen.findByRole("button", { name: "Apply change" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/proposals/proposal-alpha/approve"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ brain_id: "alpha", reviewer: "user" }),
        }),
      );
    });
  });

  it("removes the old card immediately when the active vault changes", async () => {
    render(<MemoryReview tab="pending" />);
    expect(await screen.findByRole("button", { name: "Apply change" })).toBeInTheDocument();

    act(() => {
      useBrainStore.setState({ activeBrainId: "beta", activeBrainName: "Beta" });
    });

    await waitFor(() => expect(screen.queryByRole("button", { name: "Apply change" })).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("brain_id=beta"),
      expect.any(Object),
    );
  });
});
