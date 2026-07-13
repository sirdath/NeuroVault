/**
 * Executable specification for the deterministic Atlas scene builder.
 *
 * This project does not currently have a test runner configured. Run with:
 *
 *     npx tsx src/lib/atlasVisualModel.test.ts
 */

import type { GraphData, GraphEdge, GraphNode } from "./api";
import {
  atlasLayoutEdges,
  buildAtlasVisualModel,
  type AtlasVisualEdge,
} from "./atlasVisualModel";

let failures = 0;

function fail(label: string, detail: string): void {
  failures += 1;
  console.log(`FAIL  ${label}\n   ${detail}`);
}

function eq(label: string, actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson === expectedJson) console.log(`ok    ${label}`);
  else fail(label, `actual: ${actualJson}\n   expected: ${expectedJson}`);
}

function ok(label: string, condition: boolean, detail: string): void {
  if (condition) console.log(`ok    ${label}`);
  else fail(label, detail);
}

const node = (id: string, overrides: Partial<GraphNode> = {}): GraphNode => ({
  id,
  title: id,
  state: "active",
  strength: 1,
  access_count: 0,
  ...overrides,
});

const edge = (
  from: string,
  to: string,
  similarity = 0.7,
  link_type = "semantic",
): GraphEdge => ({ from, to, similarity, link_type });

const edgeByPair = (
  edges: readonly AtlasVisualEdge[],
  source: string,
  target: string,
): AtlasVisualEdge | undefined => edges.find(
  (item) => item.source === source && item.target === target,
);

// ---------- pair collapse, relation preservation, and essential tier ----------

{
  const graph: GraphData = {
    nodes: [node("a"), node("b")],
    edges: [
      edge("a", "b", 0.62, "manual"),
      edge("b", "a", 0.8, "manual"),
      edge("a", "b", 0.91, "semantic"),
      edge("a", "b", 0.72, "manual"),
    ],
  };
  const model = buildAtlasVisualModel(graph);
  const visual = model.edges[0]!;

  eq("collapse — all rows for a pair become one visual edge", model.edges.length, 1);
  eq("collapse — canonical endpoints", [visual.source, visual.target], ["a", "b"]);
  eq("collapse — all relation types survive", visual.relations.map((item) => item.type), ["manual", "semantic"]);
  eq(
    "collapse — direction flags are merged per relation type",
    visual.relations.map((item) => [item.type, item.forward, item.reverse]),
    [["manual", true, true], ["semantic", true, false]],
  );
  eq("collapse — duplicate same-direction rows keep maximum similarity", visual.relations[0]?.similarity, 0.8);
  eq("collapse — reciprocal pair recorded", visual.reciprocal, true);
  eq("essential — an asserted relation controls the primary type", visual.primaryType, "manual");
  eq("essential — asserted relation never becomes inferred detail", [visual.tier, visual.reasons], ["essential", ["asserted"]]);
  eq("diagnostics — duplicate relation row is visible", model.diagnostics.duplicateEdges, 1);
}

// ---------- malformed input is quarantined rather than leaked ----------

{
  const model = buildAtlasVisualModel({
    nodes: [node("a"), node("b"), node("orphan")],
    edges: [
      edge("a", "a", 0.9, "manual"),
      edge("a", "missing", 0.9, "manual"),
      edge("a", "b", Number.NaN, "semantic"),
    ],
  });

  eq("validation — self links are dropped", model.diagnostics.selfEdges, 1);
  eq("validation — dangling links are dropped", model.diagnostics.danglingEdges, 1);
  eq("validation — invalid similarities are counted", model.diagnostics.invalidSimilarities, 1);
  eq("validation — only the valid-endpoint pair reaches the scene", model.edges.map((item) => [item.source, item.target]), [["a", "b"]]);
  eq("validation — non-finite similarity is clamped to zero", model.edges[0]?.maxSimilarity, 0);
  eq("validation — isolated node is explicitly marked orphan", model.nodes.find((item) => item.id === "orphan")?.orphan, true);
  ok(
    "validation — output contains no dangling or self edge",
    model.edges.every((item) => item.source !== item.target && model.nodes.some((n) => n.id === item.source) && model.nodes.some((n) => n.id === item.target)),
    "an invalid edge survived normalization",
  );
}

// ---------- sparse inferred overview: mutual top-K plus connectivity ----------

{
  const model = buildAtlasVisualModel({
    nodes: ["a", "b", "c", "d"].map((id) => node(id)),
    edges: [
      edge("a", "b", 0.99),
      edge("a", "c", 0.9),
      edge("a", "d", 0.1),
      edge("b", "c", 0.8),
      edge("b", "d", 0.7),
      edge("c", "d", 0.6),
    ],
  }, { inferredTopK: 1 });
  const layout = atlasLayoutEdges(model);
  const mutual = layout.filter((item) => item.reasons.includes("mutual-top-k"));
  const connectivity = layout.filter((item) => item.reasons.includes("connectivity"));

  eq("tiering — connected four-node semantic graph gets a three-edge layout tree", layout.length, 3);
  eq("tiering — strongest mutual top-1 edge enters the backbone", mutual.map((item) => [item.source, item.target]), [["a", "b"]]);
  ok("tiering — connectivity edges join the remaining components", connectivity.length === 2, `expected 2 connectivity edges, got ${connectivity.length}`);
  eq("tiering — excess inferred relations remain detail", model.edges.filter((item) => item.tier === "detail").length, 3);

  const reached = new Set(["a"]);
  while (true) {
    const before = reached.size;
    for (const item of layout) {
      if (reached.has(item.source)) reached.add(item.target);
      if (reached.has(item.target)) reached.add(item.source);
    }
    if (reached.size === before) break;
  }
  eq("tiering — layout backbone spans every connected node", [...reached].sort(), ["a", "b", "c", "d"]);
}

// Authored links are essential independently of similarity, top-K, or the
// connectivity pass.
{
  const model = buildAtlasVisualModel({
    nodes: [node("a"), node("b"), node("c")],
    edges: [
      edge("a", "b", 0.01, "manual"),
      edge("a", "c", 0.99, "semantic"),
      edge("b", "c", 0.98, "semantic"),
    ],
  }, { inferredTopK: 0 });
  const asserted = edgeByPair(model.edges, "a", "b");
  eq("essential — weak authored edge stays essential with top-K disabled", [asserted?.tier, asserted?.reasons], ["essential", ["asserted"]]);
  eq("essential — layout includes authored edge", atlasLayoutEdges(model).some((item) => item.id === asserted?.id), true);
}

// ---------- stable identity and fingerprint ----------

{
  const nodes = [
    node("a", { title: "A", folder: "alpha" }),
    node("b", { title: "B", folder: "beta" }),
    node("c", { title: "C", folder: "alpha" }),
  ];
  const edges = [
    edge("a", "b", 0.75, "manual"),
    edge("b", "a", 0.7, "semantic"),
    edge("b", "c", 0.65, "semantic"),
    edge("a", "c", 0.6, "entity"),
  ];
  const first = buildAtlasVisualModel({ nodes, edges }, { inferredTopK: 2 });
  const replay = buildAtlasVisualModel(
    { nodes: [...nodes].reverse(), edges: [...edges].reverse() },
    { inferredTopK: 2 },
  );

  eq("identity — fingerprint is independent of input ordering", replay.fingerprint, first.fingerprint);
  eq("identity — visual edge ids are independent of input ordering", replay.edges.map((item) => item.id), first.edges.map((item) => item.id));
  eq(
    "identity — tier decisions are independent of input ordering",
    replay.edges.map((item) => [item.id, item.tier, item.reasons]),
    first.edges.map((item) => [item.id, item.tier, item.reasons]),
  );

  const changed = buildAtlasVisualModel({
    nodes,
    edges: edges.map((item, index) => index === 0 ? { ...item, similarity: 0.76 } : item),
  }, { inferredTopK: 2 });
  ok("identity — fingerprint changes when relation evidence changes", changed.fingerprint !== first.fingerprint, "fingerprint ignored an edge similarity change");
}

console.log("");
if (failures > 0) {
  console.log(`${failures} failure(s)`);
  throw new Error(`${failures} test failure(s)`);
}
console.log("all green");
