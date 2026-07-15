import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBrainStore } from "../stores/brainStore";
import { useConsumerHealthStore } from "../stores/consumerHealthStore";
import Home from "./Home";

function brief(overrides: Record<string, unknown> = {}) {
  return {
    needs_review: 7,
    needs_review_by_brain: { primary: 2, another: 5 },
    sessions_today: 12,
    activity: {
      context_added: 3,
      context_quiet: 9,
      memories_surfaced: 7,
      notes_changed: 4,
    },
    continue: null,
    since: [],
    ...overrides,
  };
}

describe("Today", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => brief(),
    }));
    useBrainStore.setState({
      brains: [{ id: "primary", name: "Primary", description: "", created_at: "", is_active: true }],
      activeBrainId: "primary",
      activeBrainName: "Primary",
      loading: false,
      switchBrain: vi.fn().mockResolvedValue(true),
    });
    useConsumerHealthStore.setState({
      signals: {
        service: "online",
        brainCount: 1,
        activeBrainId: "primary",
        activeBrainName: "Primary",
        memories: 42,
        automaticRecall: "on",
        lastCheckedAt: Date.now(),
      },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("shows a useful memory pulse and routes its canonical actions", async () => {
    const onEnter = vi.fn();
    const onOpenGraph = vi.fn();
    const onOpenReview = vi.fn();
    render(<Home onEnter={onEnter} onOpenGraph={onOpenGraph} onOpenReview={onOpenReview} />);

    expect(await screen.findByText("12 sessions observed across your vaults today")).toBeInTheDocument();
    expect(screen.getByText("42 memories")).toBeInTheDocument();
    expect(screen.getByText("3 times")).toBeInTheDocument();
    expect(within(screen.getByLabelText("Memory today")).getByText("7")).toBeInTheDocument();
    expect(screen.getByText("2 waiting")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Review 2 waiting/i }));
    fireEvent.click(screen.getByRole("button", { name: "Explore graph" }));
    expect(onOpenReview).toHaveBeenCalledOnce();
    expect(onOpenGraph).toHaveBeenCalledOnce();
  });

  it("keeps an old continuation from dominating Today", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => brief({
        continue: {
          brain: "old-work",
          brain_name: "Old work",
          current_task: "A five-day-old task",
          next_step: "Do the stale thing",
          updated_at: new Date(Date.now() - 5 * 86400_000).toISOString(),
          stale: false,
        },
      }),
    } as Response);

    render(<Home onEnter={vi.fn()} onOpenGraph={vi.fn()} onOpenReview={vi.fn()} />);
    expect(await screen.findByText("No recent thread needs resuming")).toBeInTheDocument();
    expect(screen.queryByText("A five-day-old task")).not.toBeInTheDocument();
  });

  it("offers a genuinely recent continuation", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => brief({
        continue: {
          brain: "primary",
          brain_name: "Primary",
          current_task: "Finish the release notes",
          next_step: "Run the final gate",
          last_files: ["release.md"],
          updated_at: new Date(Date.now() - 3600_000).toISOString(),
          stale: false,
        },
      }),
    } as Response);
    const onEnter = vi.fn();
    render(<Home onEnter={onEnter} onOpenGraph={vi.fn()} onOpenReview={vi.fn()} />);

    expect(await screen.findByText("Finish the release notes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue in Primary" }));
    expect(onEnter).toHaveBeenCalledWith("release.md");
  });
});
