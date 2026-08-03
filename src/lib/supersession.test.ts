/**
 * Supersession resolver. Run by scripts/run-lib-tests.mjs (npm run test:lib),
 * or standalone:
 *
 *     npx tsx src/lib/supersession.test.ts
 *
 * The cases here ARE the contract the editor banner renders against: what
 * counts as superseded, what the reader is told when the newer note is not in
 * the vault listing, and what must never produce a banner.
 */

import {
  findEngramIdByFilename,
  resolveSupersession,
  type NoteIndexRow,
} from "./supersession";

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

const notes: NoteIndexRow[] = [
  { id: "old-1", filename: "pricing.md", title: "Pricing" },
  { id: "new-1", filename: "pricing-v2.md", title: "Pricing v2" },
];

// ---------- findEngramIdByFilename ----------

eq("finds the engram id for a filename", findEngramIdByFilename(notes, "pricing.md"), "old-1");
eq("unknown filename resolves to null", findEngramIdByFilename(notes, "ghost.md"), null);
eq("no active note resolves to null", findEngramIdByFilename(notes, null), null);

// ---------- resolveSupersession ----------

eq(
  "a current note has no supersession",
  resolveSupersession({ superseded_by: null, superseded_reason: null }, notes),
  null,
);
eq("a missing detail has no supersession", resolveSupersession(null, notes), null);
eq(
  "an empty superseded_by is not a supersession",
  resolveSupersession({ superseded_by: "   ", superseded_reason: "x" }, notes),
  null,
);

eq(
  "resolves the newer note's title, filename and reason",
  resolveSupersession({ superseded_by: "new-1", superseded_reason: "Prices changed" }, notes),
  { id: "new-1", title: "Pricing v2", filename: "pricing-v2.md", reason: "Prices changed" },
);

eq(
  "a supersession without a reason still banners",
  resolveSupersession({ superseded_by: "new-1", superseded_reason: null }, notes),
  { id: "new-1", title: "Pricing v2", filename: "pricing-v2.md", reason: null },
);

// The newer note can be missing from the listing (dormant, deleted, or another
// brain). The fact is still true, so it is still reported — but with no
// filename, so the banner offers no click-through that would 404.
eq(
  "an unlisted newer note reports the fact without a target",
  resolveSupersession({ superseded_by: "gone-9", superseded_reason: null }, notes),
  { id: "gone-9", title: "a newer note", filename: null, reason: null },
);

eq(
  "a listed-but-untitled newer note falls back to neutral wording",
  resolveSupersession({ superseded_by: "blank-1" }, [
    ...notes,
    { id: "blank-1", filename: "blank.md", title: "  " },
  ]),
  { id: "blank-1", title: "a newer note", filename: "blank.md", reason: null },
);

console.log("");
if (failures > 0) {
  // Non-zero exit via throw — keeps the file environment-agnostic (no
  // @types/node needed for `process`), matching the sibling lib suites.
  throw new Error(`${failures} test failure(s)`);
}
console.log("supersession: all green");
