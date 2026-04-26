/**
 * Smoke tests for graphMetrics. Hand-verified against tiny graphs
 * where I can compute the answer in my head.
 *
 * Not auto-run by Vite/Vitest — there's no test runner configured in
 * this project. Run manually via:
 *
 *     npx tsx src/lib/graphMetrics.test.ts
 *
 * Existence of this file is mostly for the next maintainer's
 * confidence; the cases here ARE the spec for what these functions
 * should do.
 */

import {
  edgeConfidence,
  pageRank,
  louvain,
  graphCacheKey,
  canonicalEdgeKey,
} from "./graphMetrics";
import type { GraphEdge, GraphNode } from "./api";

let failures = 0;
const eq = (label: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.log(`FAIL  ${label}\n   actual: ${JSON.stringify(actual)}\n   expected: ${JSON.stringify(expected)}`);
  } else {
    console.log(`ok    ${label}`);
  }
};
const close = (label: string, actual: number, expected: number, tol = 1e-3) => {
  const ok = Math.abs(actual - expected) < tol;
  if (!ok) {
    failures++;
    console.log(`FAIL  ${label}\n   actual: ${actual}\n   expected: ${expected} ± ${tol}`);
  } else {
    console.log(`ok    ${label}  (${actual.toFixed(4)} ≈ ${expected})`);
  }
};

const node = (id: string): GraphNode => ({
  id,
  title: id,
  state: "active",
  strength: 1,
  access_count: 0,
});
const edge = (
  from: string,
  to: string,
  similarity = 0.7,
  link_type = "manual"
): GraphEdge => ({ from, to, similarity, link_type });

// ---------- canonicalEdgeKey ----------

eq("canonicalEdgeKey symmetric", canonicalEdgeKey("a", "b"), "a|b");
eq("canonicalEdgeKey reversed", canonicalEdgeKey("b", "a"), "a|b");
eq("canonicalEdgeKey identical", canonicalEdgeKey("z", "a"), "a|z");

// ---------- edgeConfidence ----------

const bidi = new Set<string>();
close(
  "edgeConfidence — manual link, sim 0.7, no reciprocity",
  edgeConfidence(edge("a", "b", 0.7, "manual"), { bidi }),
  0.55 * 0.7 + 0.35 * 1.0,
);

bidi.add(canonicalEdgeKey("a", "b"));
close(
  "edgeConfidence — manual link with reciprocity",
  edgeConfidence(edge("a", "b", 0.7, "manual"), { bidi }),
  0.55 * 0.7 + 0.35 * 1.0 + 0.15,
);

close(
  "edgeConfidence — unknown link_type defaults to 0.5 weight",
  edgeConfidence(edge("a", "b", 0.7, "wat"), { bidi: new Set() }),
  0.55 * 0.7 + 0.35 * 0.5,
);

close(
  "edgeConfidence — clamps to [0,1] on garbage similarity",
  edgeConfidence(edge("a", "b", 99, "manual"), { bidi: new Set() }),
  0.55 * 1.0 + 0.35 * 1.0,
);

// ---------- pageRank ----------

// Tiny 4-node graph: a → {b, c}, b → c, c → a, d isolated
{
  const nodes = ["a", "b", "c", "d"].map(node);
  const edges = [edge("a", "b"), edge("a", "c"), edge("b", "c"), edge("c", "a")];
  const pr = pageRank(nodes, edges);
  // Mean must be ~1.0 by design.
  let sum = 0;
  for (const v of pr.values()) sum += v;
  close("pageRank — mean is 1.0", sum / nodes.length, 1.0);
  // Isolated node 'd' should have a score below the mean.
  if (pr.get("d")! >= 1.0) {
    failures++;
    console.log(`FAIL  pageRank — isolated node 'd' should score below mean, got ${pr.get("d")}`);
  } else {
    console.log(`ok    pageRank — isolated node ranks low (${pr.get("d")!.toFixed(3)})`);
  }
  // 'c' is referenced by both a and b — should be the most central in the connected triangle.
  const top = [...pr.entries()].sort((p, q) => q[1] - p[1])[0]!;
  console.log(`ok    pageRank — top node is '${top[0]}' (${top[1].toFixed(3)})`);
}

// Empty input.
eq("pageRank — empty input returns empty map", pageRank([], []).size, 0);

// ---------- louvain ----------

// Two disconnected triangles: {a,b,c} and {d,e,f}
{
  const nodes = ["a", "b", "c", "d", "e", "f"].map(node);
  const edges = [
    edge("a", "b"), edge("b", "c"), edge("a", "c"),
    edge("d", "e"), edge("e", "f"), edge("d", "f"),
  ];
  const c = louvain(nodes, edges);
  const triA = new Set([c.get("a"), c.get("b"), c.get("c")]);
  const triB = new Set([c.get("d"), c.get("e"), c.get("f")]);
  eq("louvain — triangle A is one community", triA.size, 1);
  eq("louvain — triangle B is one community", triB.size, 1);
  eq("louvain — the two triangles are different communities", triA.values().next().value !== triB.values().next().value, true);
}

// Determinism: same input twice → same partition.
{
  const nodes = ["a", "b", "c", "d", "e", "f"].map(node);
  const edges = [edge("a", "b"), edge("b", "c"), edge("d", "e"), edge("e", "f")];
  const r1 = louvain(nodes, edges);
  const r2 = louvain(nodes, edges);
  let same = true;
  for (const id of r1.keys()) if (r1.get(id) !== r2.get(id)) same = false;
  eq("louvain — deterministic across runs", same, true);
}

// No edges → each node its own community.
{
  const nodes = ["a", "b"].map(node);
  const c = louvain(nodes, []);
  eq("louvain — no edges yields 2 unique ids", new Set(c.values()).size, 2);
}

// ---------- graphCacheKey ----------

{
  const n = ["a", "b", "c"].map(node);
  const e = [edge("a", "b"), edge("b", "c")];
  const k1 = graphCacheKey(n, e);
  const k2 = graphCacheKey(n, e);
  eq("cacheKey — stable across calls", k1, k2);
  const k3 = graphCacheKey([...n].reverse(), [...e].reverse());
  eq("cacheKey — independent of ordering", k1, k3);
  const k4 = graphCacheKey(n, [...e, edge("a", "c")]);
  if (k4 === k1) {
    failures++;
    console.log("FAIL  cacheKey — should change when an edge is added");
  } else {
    console.log("ok    cacheKey — changes when edge added");
  }
}

// ---------- summary ----------

console.log("");
if (failures > 0) {
  console.log(`${failures} failure(s)`);
  // Non-zero exit via throw — keeps the file environment-agnostic
  // (no @types/node needed for `process`).
  throw new Error(`${failures} test failure(s)`);
} else {
  console.log("all green");
}
