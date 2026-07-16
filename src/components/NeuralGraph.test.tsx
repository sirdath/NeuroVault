import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The first component test NeuralGraph has ever had.
 *
 * It exists because of a specific bug that shipped: the 3D view drew links that
 * connected nothing. One snapshotLinks array was handed to BOTH force-graph
 * surfaces, while each built its own fresh node objects. d3-force resolves
 * link.source from the "id" string into a 2D node object and writes it back
 * into the shared array; d3-force-3d then sees an object, skips re-resolution,
 * and draws 3D links bound to 2D nodes at 2D coordinates flattened to z=0.
 *
 * Nothing could have caught it. graphSnapshot3D returns positions and never
 * links, so the lib suite could not see it, and no component test existed at
 * all. The gate was green the entire time.
 *
 * So these tests assert the invariant at the seam where the bug lived: what
 * NeuralGraph actually hands each renderer. The fix is not "the code says
 * .map(...)" -- it is that the two surfaces never share a link object.
 */

interface CapturedGraphData {
  nodes: { id: string }[];
  links: Record<string, unknown>[];
}
interface Captured {
  graphData: CapturedGraphData;
  linkSource?: string;
  linkTarget?: string;
}

const captured2D: Captured[] = [];
const captured3D: Captured[] = [];

vi.mock("react-force-graph-2d", () => ({
  default: (props: Captured) => {
    captured2D.push(props);
    return <div data-testid="fg2d" />;
  },
}));
vi.mock("react-force-graph-3d", () => ({
  default: (props: Captured) => {
    captured3D.push(props);
    return <div data-testid="fg3d" />;
  },
}));

// AtlasGraph drags in Sigma/WebGL, which jsdom has no business running. The
// composition presets are covered by the lib suite and GraphPresetBar tests.
vi.mock("./AtlasGraph", () => ({
  AtlasGraph: () => <div data-testid="atlas" />,
}));

vi.mock("../lib/tauri", () => ({
  nvSetPagerank: vi.fn().mockResolvedValue(undefined),
  nvSetClusters: vi.fn().mockResolvedValue(undefined),
  nvGetClusterNames: vi.fn().mockResolvedValue([]),
  readNote: vi.fn().mockResolvedValue(""),
}));

import { NeuralGraph } from "./NeuralGraph";
import { useGraphStore, type SimNode } from "../stores/graphStore";
import { useGraphSettingsStore } from "../stores/graphSettingsStore";
import type { GraphEdge } from "../lib/api";

/**
 * A brain with real structure: a hub, its spokes, and a detached pair — so
 * there are links to get wrong.
 *
 * The edge shape matters. GraphEdge is {from, to, similarity, link_type}, NOT
 * {source, target}. The first draft of this fixture used source/target, every
 * edge was dropped as dangling, and the suite went green against ZERO links —
 * including a "both surfaces get the same edges" assertion that was comparing
 * two empty arrays. seedBrain is asserted below so that cannot recur.
 */
const SPOKES = ["a", "b", "c", "d"] as const;

function seedBrain() {
  const nodes: SimNode[] = [
    mkNode("hub", "Hub", "active", "2026-01-01T00:00:00Z"),
    ...SPOKES.map((id, i) => mkNode(id, id.toUpperCase(), "active", `2026-01-0${i + 2}T00:00:00Z`)),
    mkNode("x", "X", "dormant", "2026-02-01T00:00:00Z", "sub"),
    mkNode("y", "Y", "dormant", "2026-02-02T00:00:00Z", "sub"),
  ];
  const edges: GraphEdge[] = [
    ...SPOKES.map((to) => ({ from: "hub", to, similarity: 0.8, link_type: "manual" })),
    { from: "x", to: "y", similarity: 0.75, link_type: "manual" },
  ];
  useGraphStore.setState({ nodes, edges });
  return { nodes, edges };
}

function mkNode(
  id: string,
  title: string,
  state: string,
  created_at: string,
  folder = "",
): SimNode {
  return {
    id, title, state, created_at, folder,
    strength: 1, access_count: 1, kind: "note",
    x: 0, y: 0, vx: 0, vy: 0, pinned: false,
  };
}

beforeEach(() => {
  captured2D.length = 0;
  captured3D.length = 0;
  localStorage.clear();
  useGraphSettingsStore.setState({ preset: "2d", connectionMode: "all", labelMode: "off" });
  seedBrain();
});

describe("the fixture itself", () => {
  it("produces a brain the renderer will actually draw links for", () => {
    // Guard against the failure that made the first draft of this file green
    // for the wrong reason: a fixture whose edges are silently all dropped
    // turns every link assertion below into a no-op.
    const { nodes, edges } = seedBrain();
    expect(nodes.length).toBe(7);
    expect(edges.length).toBe(5);
    const ids = new Set(nodes.map((n) => n.id));
    for (const e of edges) {
      expect(ids.has(e.from), `edge from "${e.from}" dangles`).toBe(true);
      expect(ids.has(e.to), `edge to "${e.to}" dangles`).toBe(true);
    }
  });
});

const last = <T,>(arr: T[]): T => arr[arr.length - 1]!;

describe("3D links bind to 3D nodes — the bug that shipped", () => {
  it("never hands the same link object to both surfaces", async () => {
    // THE regression test. If 2D and 3D share link objects, d3-force's
    // string->object resolution in one leaks into the other.
    const user = userEvent.setup();
    render(<NeuralGraph />);
    await waitFor(() => expect(captured2D.length).toBeGreaterThan(0));

    await user.click(screen.getByRole("button", { name: /^3D —/ }));
    await waitFor(() => expect(captured3D.length).toBeGreaterThan(0));

    const links2D = last(captured2D).graphData.links;
    const links3D = last(captured3D).graphData.links;
    expect(links2D.length).toBeGreaterThan(0);
    expect(links3D).toHaveLength(links2D.length);

    for (const link of links3D) {
      expect(links2D).not.toContain(link);
    }
  });

  it("survives the exact 2D -> 3D path, not just a direct 3D load", async () => {
    // Loading straight into 3D always worked; only 2D-first-then-switch was
    // broken, because 2D had to run first to poison the shared array.
    const user = userEvent.setup();
    render(<NeuralGraph />);
    await waitFor(() => expect(captured2D.length).toBeGreaterThan(0));

    // Let 2D mutate its own copies the way d3-force would.
    for (const link of last(captured2D).graphData.links) {
      link.source = { id: link.source, x: 999, y: 999 };
      link.target = { id: link.target, x: 999, y: 999 };
    }

    await user.click(screen.getByRole("button", { name: /^3D —/ }));
    await waitFor(() => expect(captured3D.length).toBeGreaterThan(0));

    // 3D must still see resolvable ids, not 2D's node objects at 2D coords.
    for (const link of last(captured3D).graphData.links) {
      expect(typeof link.from).toBe("string");
      expect(typeof link.to).toBe("string");
    }
  });

  it("tells both libraries to re-resolve from the id fields every bind", async () => {
    // linkSource/linkTarget="from"/"to" make force-graph's own reset line
    // (link.source = link[state.linkSource]) restore the id on every bind --
    // the belt to the copies' braces.
    const user = userEvent.setup();
    render(<NeuralGraph />);
    await waitFor(() => expect(captured2D.length).toBeGreaterThan(0));
    expect(last(captured2D).linkSource).toBe("from");
    expect(last(captured2D).linkTarget).toBe("to");

    await user.click(screen.getByRole("button", { name: /^3D —/ }));
    await waitFor(() => expect(captured3D.length).toBeGreaterThan(0));
    expect(last(captured3D).linkSource).toBe("from");
    expect(last(captured3D).linkTarget).toBe("to");
  });

  it("gives both surfaces the same edges, so 3D is not quietly emptier", async () => {
    const user = userEvent.setup();
    render(<NeuralGraph />);
    await waitFor(() => expect(captured2D.length).toBeGreaterThan(0));
    const key = (l: Record<string, unknown>) => `${l.from}->${l.to}`;
    const in2D = last(captured2D).graphData.links.map(key).sort();
    // Non-empty, or this whole comparison is two empty arrays agreeing.
    expect(in2D.length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: /^3D —/ }));
    await waitFor(() => expect(captured3D.length).toBeGreaterThan(0));
    expect(last(captured3D).graphData.links.map(key).sort()).toEqual(in2D);
  });
});

describe("the preset bar drives the renderer", () => {
  it("starts on the 2D snapshot", async () => {
    render(<NeuralGraph />);
    expect(await screen.findByTestId("fg2d")).toBeInTheDocument();
    expect(screen.queryByTestId("fg3d")).toBeNull();
  });

  it("switches renderer per preset, and persists the choice", async () => {
    const user = userEvent.setup();
    render(<NeuralGraph />);
    await screen.findByTestId("fg2d");

    await user.click(screen.getByRole("button", { name: /^3D —/ }));
    expect(await screen.findByTestId("fg3d")).toBeInTheDocument();
    expect(useGraphSettingsStore.getState().preset).toBe("3d");

    await user.click(screen.getByRole("button", { name: /^Halo —/ }));
    expect(await screen.findByTestId("atlas")).toBeInTheDocument();
    expect(useGraphSettingsStore.getState().preset).toBe("halo");

    await user.click(screen.getByRole("button", { name: /^2D —/ }));
    expect(await screen.findByTestId("fg2d")).toBeInTheDocument();
    expect(useGraphSettingsStore.getState().preset).toBe("2d");
  });

  it("routes all six compositions to AtlasGraph", async () => {
    const user = userEvent.setup();
    render(<NeuralGraph />);
    await screen.findByTestId("fg2d");
    for (const name of ["Time Rings", "Islands", "Arbor", "Halo", "Flow", "Globe"]) {
      await user.click(screen.getByRole("button", { name: new RegExp(`^${name} —`) }));
      expect(await screen.findByTestId("atlas"), `${name} did not render`).toBeInTheDocument();
    }
  });
});
