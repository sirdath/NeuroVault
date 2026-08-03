/**
 * Edge-legend row builder. Run by scripts/run-lib-tests.mjs (npm run test:lib),
 * or standalone:
 *
 *     npx tsx src/lib/graphEdgeLegend.test.ts
 *
 * These cases guard the one rule the legend exists to keep: a row must decode
 * something the painter actually draws. Absent link types get no row, and two
 * types the painter gives the same colour get ONE row, not two.
 */

import {
  atlasEdgeTheme,
  buildEdgeLegendRows,
  edgeThemeColor,
  edgeTypeLabel,
} from "./graphEdgeLegend";

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

const edge = (link_type: string) => ({ link_type });

/** Stand-in for NeuralGraph's `edgeColor` — one hue per type. */
const distinctColor = (type: string) => `color:${type}`;

// ---------- labels ----------

eq("known types get a reader-facing label", edgeTypeLabel("manual"), "Wikilink");
eq("unknown types degrade to their raw name", edgeTypeLabel("some_new_kind"), "some new kind");

// ---------- only what is on screen ----------

eq(
  "a type with no edge in view gets no row",
  buildEdgeLegendRows([edge("manual"), edge("manual")], distinctColor).map((r) => r.types),
  [["manual"]],
);
eq("no edges, no rows", buildEdgeLegendRows([], distinctColor), []);

// ---------- ordering + labelling ----------

const mixed = [
  edge("semantic"), edge("semantic"), edge("semantic"),
  edge("manual"), edge("manual"),
  edge("entity"),
];
eq(
  "rows run busiest colour first",
  buildEdgeLegendRows(mixed, distinctColor).map((r) => r.label),
  ["Semantic similarity", "Wikilink", "Shared entity"],
);
eq(
  "the row cap keeps the card small",
  buildEdgeLegendRows(mixed, distinctColor, { max: 2 }).map((r) => r.label),
  ["Semantic similarity", "Wikilink"],
);

// ---------- types that share a colour share a row ----------

// NeuralGraph's palette paints `manual` and `defines` the same purple, and puts
// everything it does not name (semantic, references, …) on one neutral grey.
const forceGraphish = (type: string) =>
  type === "manual" || type === "defines" ? "rgba(139, 124, 248, 0.95)" : "rgba(122, 119, 154, 0.95)";
eq(
  "same colour, one row",
  buildEdgeLegendRows(
    [edge("manual"), edge("defines"), edge("semantic"), edge("references")],
    forceGraphish,
  ).map((r) => ({ label: r.label, types: r.types })),
  [
    { label: "Code: references · Semantic similarity", types: ["references", "semantic"] },
    { label: "Defines · Wikilink", types: ["defines", "manual"] },
  ],
);
eq(
  "a crowded row names two types and counts the rest",
  buildEdgeLegendRows(
    [edge("manual"), edge("defines"), edge("part_of"), edge("extends")],
    () => "one-colour",
  ).map((r) => r.label),
  ["Defines · Extends +2"],
);

// ---------- the Atlas painter's real collapses ----------

const atlas = atlasEdgeTheme({ accent: "#8b7cf8", negative: "#ff6464", textDim: "#78809a" });
const atlasColor = (type: string) => edgeThemeColor(type, atlas);

// This is the case a hand-written legend would get wrong: AtlasGraph maps its
// `warning` slot to the accent colour, so `supersedes` is painted with the same
// pixels as a wikilink. One row, or the legend claims a distinction the canvas
// never draws.
eq(
  "Atlas paints supersedes and wikilinks alike, so they share one row",
  buildEdgeLegendRows([edge("manual"), edge("supersedes")], atlasColor).map((r) => ({
    color: r.color,
    types: r.types,
  })),
  [{ color: "#8b7cf8", types: ["manual", "supersedes"] }],
);
eq(
  "Atlas keeps contradictions distinct",
  buildEdgeLegendRows([edge("contradicts")], atlasColor).map((r) => r.color),
  ["#ff6464"],
);
eq(
  "the untyped bucket is flagged, not given a false hue",
  buildEdgeLegendRows([edge("semantic"), edge("entity")], atlasColor, {
    inheritColor: atlas.dim,
  }).map((r) => ({ types: r.types, inherits: r.inheritsNodeColor })),
  [{ types: ["entity", "semantic"], inherits: true }],
);
eq(
  "without an inheritColor nothing claims to inherit",
  buildEdgeLegendRows([edge("semantic")], atlasColor).map((r) => r.inheritsNodeColor),
  [false],
);

console.log("");
if (failures > 0) {
  // Non-zero exit via throw — keeps the file environment-agnostic (no
  // @types/node needed for `process`), matching the sibling lib suites.
  throw new Error(`${failures} test failure(s)`);
}
console.log("graphEdgeLegend: all green");
