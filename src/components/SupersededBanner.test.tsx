import axe from "axe-core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBrainStore } from "../stores/brainStore";
import { SupersededBanner, SupersededNotice } from "./SupersededBanner";

const supersession = {
  id: "new-1",
  title: "Pricing v2",
  filename: "pricing-v2.md",
  reason: "Prices changed in July",
};

describe("SupersededNotice", () => {
  it("stays out of the way when the note is current", () => {
    render(<SupersededNotice supersession={null} onOpen={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("names the newer note and its reason, and opens it on click", async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <SupersededNotice supersession={supersession} onOpen={onOpen} onDismiss={vi.fn()} />,
    );

    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("Superseded");
    expect(notice).toHaveTextContent("Replaced by Pricing v2 — Prices changed in July");

    await user.click(screen.getByRole("button", { name: "Pricing v2" }));
    expect(onOpen).toHaveBeenCalledWith("pricing-v2.md");

    expect(
      await axe.run(container, { rules: { "color-contrast": { enabled: false } } }),
    ).toMatchObject({ violations: [] });
  });

  it("states the fact without a dead click-through when the newer note is unlisted", () => {
    render(
      <SupersededNotice
        supersession={{ id: "gone-9", title: "a newer note", filename: null, reason: null }}
        onOpen={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Replaced by a newer note");
    expect(screen.queryByRole("button", { name: "a newer note" })).not.toBeInTheDocument();
  });
});

/** `/api/notes` list + `/api/notes/{id}` detail, the two reads the banner makes. */
function stubVault(detail: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (/\/api\/notes\/[^?]/.test(url)) {
      return { ok: true, json: async () => detail };
    }
    return {
      ok: true,
      json: async () => [
        { id: "old-1", filename: "pricing.md", title: "Pricing" },
        { id: "new-1", filename: "pricing-v2.md", title: "Pricing v2" },
      ],
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("SupersededBanner", () => {
  beforeEach(() => {
    useBrainStore.setState({ activeBrainId: "alpha", activeBrainName: "Alpha" });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("warns the reader when the open note carries superseded_by", async () => {
    stubVault({
      id: "old-1",
      filename: "pricing.md",
      title: "Pricing",
      content: "old prices",
      superseded_by: "new-1",
      superseded_reason: "Prices changed in July",
    });

    render(<SupersededBanner filename="pricing.md" onOpen={vi.fn()} />);

    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent("Replaced by Pricing v2 — Prices changed in July");
  });

  it("shows nothing for a current note", async () => {
    stubVault({
      id: "old-1",
      filename: "pricing.md",
      title: "Pricing",
      content: "current prices",
      superseded_by: null,
      superseded_reason: null,
    });

    render(<SupersededBanner filename="pricing.md" onOpen={vi.fn()} />);

    // The reads resolve, then nothing renders — waitFor the fetches so this
    // cannot pass merely because the assertion ran first.
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("scopes the reads to the active brain", async () => {
    const fetchMock = stubVault({ id: "old-1", superseded_by: null });
    render(<SupersededBanner filename="pricing.md" onOpen={vi.fn()} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toContain("brain=alpha");
    }
  });

  it("dismisses for this view only, and comes back with the note", async () => {
    stubVault({
      id: "old-1",
      filename: "pricing.md",
      title: "Pricing",
      superseded_by: "new-1",
      superseded_reason: null,
    });
    const user = userEvent.setup();
    const { rerender } = render(<SupersededBanner filename="pricing.md" onOpen={vi.fn()} />);

    await screen.findByRole("status");
    await user.click(screen.getByRole("button", { name: "Dismiss superseded notice" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    // Reopening the same stale note must warn again — dismissal is per view.
    rerender(<SupersededBanner filename="other.md" onOpen={vi.fn()} />);
    rerender(<SupersededBanner filename="pricing.md" onOpen={vi.fn()} />);
    expect(await screen.findByRole("status")).toHaveTextContent("Replaced by Pricing v2");
  });

  it("stays silent when the backend is unreachable", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("offline");
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SupersededBanner filename="pricing.md" onOpen={vi.fn()} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
