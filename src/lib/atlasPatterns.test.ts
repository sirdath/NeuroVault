/**
 * Executable specification for safe Atlas pattern parsing and transforms.
 *
 * Run manually with:
 *
 *     npx tsx src/lib/atlasPatterns.test.ts
 */

import {
  ATLAS_BUILT_IN_PATTERNS,
  atlasBuiltInPattern,
  transformAtlasPositions,
  type AtlasPositions,
} from "./atlasPatterns";
import type { AtlasVisualNode } from "./atlasVisualModel";

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

const node = (
  id: string,
  created_at?: string,
  communityId: number | null = 0,
): AtlasVisualNode => ({
  id,
  title: id,
  state: "active",
  strength: 1,
  access_count: 0,
  created_at,
  degree: 1,
  essentialDegree: 0,
  importance: 1,
  labelRank: 0,
  communityId,
  orphan: false,
});

function sortedPositions(positions: AtlasPositions): [string, number, number][] {
  return Object.entries(positions)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, point]) => [id, point.x, point.y]);
}

function finitePositions(positions: AtlasPositions): boolean {
  return Object.values(positions).every(
    (point) => Number.isFinite(point.x) && Number.isFinite(point.y),
  );
}

/**
 * Translation/rotation/scale-independent shape descriptor. Sorted pairwise
 * distances describe the silhouette without depending on which note happens
 * to occupy which point. This catches a style accidentally becoming another
 * light parameter warp of the same composition.
 */
function silhouetteDescriptor(positions: AtlasPositions): number[] {
  const points = Object.values(positions);
  const distances: number[] = [];
  for (let left = 0; left < points.length; left += 1) {
    for (let right = left + 1; right < points.length; right += 1) {
      const a = points[left]!;
      const b = points[right]!;
      distances.push(Math.hypot(a.x - b.x, a.y - b.y));
    }
  }
  const scale = Math.max(1e-12, ...distances);
  return distances.map((distance) => distance / scale).sort((a, b) => a - b);
}

function descriptorDistance(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length === 0) return Number.POSITIVE_INFINITY;
  const squared = left.reduce((sum, value, index) => {
    const delta = value - right[index]!;
    return sum + delta * delta;
  }, 0);
  return Math.sqrt(squared / left.length);
}

const basePositions: AtlasPositions = {
  a: { x: -3, y: 2 },
  b: { x: 0.5, y: -1 },
  c: { x: 4, y: 3 },
};

// ---------- built-ins ----------

eq(
  "built-ins — ids remain a stable public vocabulary",
  ATLAS_BUILT_IN_PATTERNS.map((item) => item.id),
  ["timeline", "constellation", "dendrite", "halo", "flow", "globe"],
);
eq("built-ins — unknown id safely falls back to Time Rings", atlasBuiltInPattern("not-a-pattern").id, "timeline");
eq("built-ins — lookup is deterministic", atlasBuiltInPattern("constellation"), atlasBuiltInPattern("constellation"));

// ---------- deterministic transforms ----------

// Exercise every public built-in over enough notes and communities for its
// intended geometry to be visible. The fixture deliberately has nontrivial
// ranks, timestamps, and base coordinates; a three-node fixture can make very
// different compositions look accidentally equivalent.
{
  const nodes = Array.from({ length: 24 }, (_, index) => {
    const id = `note-${index.toString().padStart(2, "0")}`;
    return {
      ...node(
        id,
        new Date(Date.UTC(2026, 0, 1 + index * 3)).toISOString(),
        Math.floor(index / 6),
      ),
      labelRank: (index * 11) % 24,
      degree: 1 + (index % 7),
    };
  });
  const base = Object.fromEntries(nodes.map((item, index) => {
    const angle = index * 1.713;
    const radius = 0.35 + Math.sqrt(index + 1) * 0.42;
    return [item.id, {
      x: Math.cos(angle) * radius + (index % 3) * 0.07,
      y: Math.sin(angle) * radius - (index % 5) * 0.04,
    }];
  })) satisfies AtlasPositions;
  const reversedBase = Object.fromEntries(Object.entries(base).reverse()) as AtlasPositions;
  const expectedIds = nodes.map((item) => item.id).sort();
  const descriptors = new Map<string, number[]>();

  for (const pattern of ATLAS_BUILT_IN_PATTERNS) {
    const first = transformAtlasPositions(pattern, nodes, base);
    const replay = transformAtlasPositions(pattern, nodes, base);
    const reordered = transformAtlasPositions(pattern, [...nodes].reverse(), reversedBase);
    const emittedIds = Object.keys(first).sort();

    eq(`${pattern.name} — emits every node exactly once`, emittedIds, expectedIds);
    ok(
      `${pattern.name} — emits only finite coordinates`,
      finitePositions(first),
      `non-finite output: ${JSON.stringify(sortedPositions(first))}`,
    );
    eq(
      `${pattern.name} — exact replay is deterministic`,
      sortedPositions(replay),
      sortedPositions(first),
    );
    eq(
      `${pattern.name} — input and base-map order do not affect geometry`,
      sortedPositions(reordered),
      sortedPositions(first),
    );
    descriptors.set(pattern.id, silhouetteDescriptor(first));
  }

  const patternIds = ATLAS_BUILT_IN_PATTERNS.map((pattern) => pattern.id);
  for (let left = 0; left < patternIds.length; left += 1) {
    for (let right = left + 1; right < patternIds.length; right += 1) {
      const leftId = patternIds[left]!;
      const rightId = patternIds[right]!;
      const distance = descriptorDistance(descriptors.get(leftId)!, descriptors.get(rightId)!);
      ok(
        `silhouette — ${leftId} and ${rightId} are structurally distinct`,
        distance > 0.015,
        `normalized pairwise-distance RMS was only ${distance.toFixed(6)}`,
      );
    }
  }
}

{
  const nodes = [node("a"), node("b"), node("c")];
  const pattern = atlasBuiltInPattern("constellation");
  const first = transformAtlasPositions(pattern, nodes, basePositions);
  const replay = transformAtlasPositions(pattern, nodes, basePositions);
  const shuffled = transformAtlasPositions(pattern, [...nodes].reverse(), basePositions);

  eq("transform — same custom/base inputs replay exactly", sortedPositions(replay), sortedPositions(first));
  eq("transform — coordinate values do not depend on node order", sortedPositions(shuffled), sortedPositions(first));
  ok(
    "transform — every generated coordinate is finite",
    Object.values(first).every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)),
    "a transform generated a non-finite coordinate",
  );
}

// Timeline intentionally ignores the force layout and orders equal/invalid
// timestamps by id. That makes replay independent of graph insertion order.
{
  const nodes = [
    node("late", "2026-07-12T12:00:00Z"),
    node("early", "2026-07-10T12:00:00Z"),
    node("unknown-b", "not-a-date"),
    node("unknown-a"),
  ];
  const pattern = atlasBuiltInPattern("timeline");
  const first = transformAtlasPositions(pattern, nodes, basePositions);
  const replay = transformAtlasPositions(pattern, [...nodes].reverse(), {
    late: { x: 999, y: -999 },
  });
  const radialOrder = Object.keys(first);
  const radii = radialOrder.map((id) => Math.hypot(first[id]!.x, first[id]!.y));

  eq("timeline — chronological order with stable id fallback", radialOrder, ["early", "late", "unknown-a", "unknown-b"]);
  eq("timeline — replay is independent of input and base-layout order", sortedPositions(replay), sortedPositions(first));
  ok(
    "timeline — later entries occupy monotonically larger rings",
    radii.every((radius, index) => index === 0 || radius > radii[index - 1]!),
    `radii were not increasing: ${JSON.stringify(radii)}`,
  );
}

// A composition is safe to execute even when its seed layout has missing or
// corrupt points: the output stays finite for every requested node.
// (This used to run through a hand-parsed "brain-warp" pattern. That legacy
// transform and the JSON parser died with pattern import/export, so the same
// invariant now runs against a shipped built-in.)
{
  const positions = transformAtlasPositions(atlasBuiltInPattern("globe"), [node("a"), node("missing")], {
    a: { x: Number.POSITIVE_INFINITY, y: 0 },
  });
  ok(
    "transform — corrupt or absent cached points degrade to finite origin positions",
    ["a", "missing"].every((id) => Number.isFinite(positions[id]?.x) && Number.isFinite(positions[id]?.y)),
    `unsafe positions: ${JSON.stringify(positions)}`,
  );
}

console.log("");
if (failures > 0) {
  console.log(`${failures} failure(s)`);
  throw new Error(`${failures} test failure(s)`);
}
console.log("all green");
