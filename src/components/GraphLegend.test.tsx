import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { EdgeLegendRow } from "../lib/graphEdgeLegend";
import { GraphLegend } from "./GraphLegend";

const wikilinks: EdgeLegendRow = {
  color: "rgba(139, 124, 248, 0.95)",
  label: "Wikilink",
  types: ["manual"],
  inheritsNodeColor: false,
};
const untyped: EdgeLegendRow = {
  color: "#78809a",
  label: "Semantic similarity · Shared entity",
  types: ["semantic", "entity"],
  inheritsNodeColor: true,
};

describe("GraphLegend edge key", () => {
  it("decodes the link colours the renderer handed it", () => {
    render(
      <GraphLegend
        visible
        clusters={[]}
        edges={[wikilinks, untyped]}
        edgeIntensityLabel="Thicker + brighter = higher confidence"
        onFocusCluster={vi.fn()}
      />,
    );

    expect(screen.getByText("Links")).toBeInTheDocument();
    expect(screen.getByText("Wikilink")).toBeInTheDocument();
    expect(screen.getByText("Semantic similarity · Shared entity")).toBeInTheDocument();
    expect(screen.getByText("Thicker + brighter = higher confidence")).toBeInTheDocument();
  });

  it("says so when a bucket takes the note's colour instead of its own", () => {
    render(<GraphLegend visible clusters={[]} edges={[untyped]} onFocusCluster={vi.fn()} />);
    expect(screen.getByText(/takes the note’s colour/)).toBeInTheDocument();
  });

  // The whole point of the section: no rows means no edge key. A legend that
  // keeps explaining colours nothing is drawing is the failure mode this card's
  // header warns about.
  it("drops the edge key entirely when the view has no edges", () => {
    render(
      <GraphLegend
        visible
        clusters={[]}
        edges={[]}
        edgeIntensityLabel="Thicker = higher confidence"
        onFocusCluster={vi.fn()}
      />,
    );
    expect(screen.queryByText("Links")).not.toBeInTheDocument();
    expect(screen.queryByText("Thicker = higher confidence")).not.toBeInTheDocument();
  });

  it("keeps the node key and cluster navigation intact", async () => {
    const onFocusCluster = vi.fn();
    const user = userEvent.setup();
    render(
      <GraphLegend
        visible
        clusters={[{ id: 3, size: 12, color: "#6ea8ff", name: "pricing", topTitle: "Pricing" }]}
        edges={[wikilinks]}
        onFocusCluster={onFocusCluster}
      />,
    );

    expect(screen.getByText("Size = how often referenced")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /pricing/ }));
    expect(onFocusCluster).toHaveBeenCalledWith(3);
  });

  it("renders nothing when analytics mode is off", () => {
    const { container } = render(
      <GraphLegend visible={false} clusters={[]} edges={[wikilinks]} onFocusCluster={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
