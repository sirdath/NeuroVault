import { buildAtlasVisualModel } from "./atlasVisualModel";
import {
  graphSnapshot2D,
  graphSnapshot3D,
  type SnapshotPositions2D,
  type SnapshotPositions3D,
} from "./graphSnapshots";
import type { GraphData, GraphNode } from "./api";

let failures = 0;
const ok = (label: string, condition: boolean, detail: string): void => {
  if (condition) console.log(`ok    ${label}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}\n   ${detail}`);
  }
};

const eq = (label: string, actual: unknown, expected: unknown): void => {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  ok(label, actualJson === expectedJson, `actual: ${actualJson}\n   expected: ${expectedJson}`);
};

function sorted2D(positions: SnapshotPositions2D): [string, number, number][] {
  return Object.entries(positions)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, point]) => [id, point.x, point.y]);
}

function sorted3D(positions: SnapshotPositions3D): [string, number, number, number][] {
  return Object.entries(positions)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, point]) => [id, point.x, point.y, point.z]);
}

function every2DFinite(positions: SnapshotPositions2D): boolean {
  return Object.values(positions).every(
    (point) => Number.isFinite(point.x) && Number.isFinite(point.y),
  );
}

function every3DFinite(positions: SnapshotPositions3D): boolean {
  return Object.values(positions).every(
    (point) => Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z),
  );
}

function unique2D(positions: SnapshotPositions2D): boolean {
  const keys = Object.values(positions).map((point) => `${point.x.toFixed(9)}:${point.y.toFixed(9)}`);
  return new Set(keys).size === keys.length;
}

function unique3D(positions: SnapshotPositions3D): boolean {
  const keys = Object.values(positions).map(
    (point) => `${point.x.toFixed(9)}:${point.y.toFixed(9)}:${point.z.toFixed(9)}`,
  );
  return new Set(keys).size === keys.length;
}

const fixture: GraphData = {
  nodes: [
    { id: "a", title: "A", state: "active", strength: 1, access_count: 2, folder: "one" },
    { id: "b", title: "B", state: "active", strength: 0.8, access_count: 1, folder: "one" },
    { id: "c", title: "C", state: "connected", strength: 0.7, access_count: 1, folder: "two" },
    { id: "d", title: "D", state: "fading", strength: 0.4, access_count: 0, folder: "two" },
    { id: "orphan", title: "Orphan", state: "fading", strength: 0.2, access_count: 0 },
  ],
  edges: [
    { from: "a", to: "b", link_type: "manual", similarity: 1 },
    { from: "c", to: "d", link_type: "manual", similarity: 1 },
    { from: "b", to: "c", link_type: "semantic", similarity: 0.7 },
  ],
};

const model = buildAtlasVisualModel(fixture);
const twoD = graphSnapshot2D(model);
const threeD = graphSnapshot3D(model);
const replay2D = graphSnapshot2D(model);
const replay3D = graphSnapshot3D(model);

const expectedIds = fixture.nodes.map((node) => node.id).sort();
eq("snapshot — 2D emits every node exactly once", Object.keys(twoD).sort(), expectedIds);
eq("snapshot — 3D emits every node exactly once", Object.keys(threeD).sort(), expectedIds);
ok("snapshot — every 2D coordinate is finite", every2DFinite(twoD), JSON.stringify(twoD));
ok("snapshot — every 3D coordinate is finite", every3DFinite(threeD), JSON.stringify(threeD));
eq("snapshot — 2D replay is byte-stable", sorted2D(replay2D), sorted2D(twoD));
eq("snapshot — 3D replay is byte-stable", sorted3D(replay3D), sorted3D(threeD));
ok("snapshot — 2D gives every node a distinct seat", unique2D(twoD), JSON.stringify(sorted2D(twoD)));
ok("snapshot — 3D gives every node a distinct seat", unique3D(threeD), JSON.stringify(sorted3D(threeD)));
ok(
  "snapshot — 3D has real depth",
  new Set(Object.values(threeD).map((point) => point.z.toFixed(3))).size > 2,
  "all 3D nodes landed on one plane",
);

// Graph row order is not meaningful. Replaying the same topology from a
// differently ordered API response must not move a single snapshot point.
{
  const reorderedModel = buildAtlasVisualModel({
    nodes: [...fixture.nodes].reverse(),
    edges: [...fixture.edges].reverse(),
  });
  eq(
    "snapshot — 2D coordinates ignore API row order",
    sorted2D(graphSnapshot2D(reorderedModel)),
    sorted2D(twoD),
  );
  eq(
    "snapshot — 3D coordinates ignore API row order",
    sorted3D(graphSnapshot3D(reorderedModel)),
    sorted3D(threeD),
  );
}

// A snapshot is topology-driven. Ordinary memory metadata can repaint a node
// without silently re-seating the whole graph.
{
  const metadataOnlyNodes: GraphNode[] = fixture.nodes.map((node, index) => ({
    ...node,
    title: `${node.title} renamed`,
    state: index % 2 === 0 ? "fresh" : "dormant",
    strength: 0.05 + index * 0.1,
    access_count: 100 + index,
    created_at: new Date(Date.UTC(2030, index, index + 1)).toISOString(),
  }));
  const metadataModel = buildAtlasVisualModel({ nodes: metadataOnlyNodes, edges: fixture.edges });
  eq("snapshot — metadata-only updates keep the topology fingerprint", metadataModel.fingerprint, model.fingerprint);
  eq(
    "snapshot — metadata-only updates do not move 2D coordinates",
    sorted2D(graphSnapshot2D(metadataModel)),
    sorted2D(twoD),
  );
  eq(
    "snapshot — metadata-only updates do not move 3D coordinates",
    sorted3D(graphSnapshot3D(metadataModel)),
    sorted3D(threeD),
  );
}

// Returned records are owned by the caller, not shared mutable caches. A
// renderer mutating its local copy must not contaminate the next snapshot.
{
  const disposable2D = graphSnapshot2D(model);
  const disposable3D = graphSnapshot3D(model);
  disposable2D.a!.x = 999_999;
  disposable3D.a!.z = -999_999;
  eq("snapshot — 2D output mutation cannot poison replay", sorted2D(graphSnapshot2D(model)), sorted2D(twoD));
  eq("snapshot — 3D output mutation cannot poison replay", sorted3D(graphSnapshot3D(model)), sorted3D(threeD));
}

// Empty and singleton brains are first-class states for a downloadable app.
{
  const empty = buildAtlasVisualModel({ nodes: [], edges: [] });
  eq("snapshot — empty 2D brain is an empty record", graphSnapshot2D(empty), {});
  eq("snapshot — empty 3D brain is an empty record", graphSnapshot3D(empty), {});

  const singleton = buildAtlasVisualModel({
    nodes: [{ id: "only", title: "Only", state: "fresh", strength: 1, access_count: 0 }],
    edges: [],
  });
  const singleton2D = graphSnapshot2D(singleton);
  const singleton3D = graphSnapshot3D(singleton);
  eq("snapshot — singleton 2D emits its one note", Object.keys(singleton2D), ["only"]);
  eq("snapshot — singleton 3D emits its one note", Object.keys(singleton3D), ["only"]);
  ok("snapshot — singleton 2D coordinate is finite", every2DFinite(singleton2D), JSON.stringify(singleton2D));
  ok("snapshot — singleton 3D coordinate is finite", every3DFinite(singleton3D), JSON.stringify(singleton3D));
}

console.log("");
if (failures > 0) throw new Error(`${failures} snapshot test failure(s)`);
console.log("all green");
