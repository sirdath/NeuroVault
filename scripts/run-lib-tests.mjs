#!/usr/bin/env node
/**
 * Runs every custom-harness test under src/lib/.
 *
 * Why this exists (2026-07-16): three suites — graphExport, consumerHealth and
 * noteDrafts — were run by NOTHING. No npm script named them, no aggregator
 * imported them, and vitest's include is "src/**\/*.test.tsx", so their .ts
 * extension kept them out of `npm run test:ui` too. They had been silently
 * dead. Meanwhile test:graph and test:durability existed but gates.sh never
 * called them, so ~2,100 lines of graph deletions were verified against a gate
 * that never once ran the replay guarantee.
 *
 * The lesson is gates.sh's own: a suite that does not run looks exactly like a
 * suite with no failures. So this runner DISCOVERS its work instead of listing
 * it — add a src/lib/*.test.ts and it runs, with no wiring to forget.
 *
 * These tests are standalone tsx scripts (console.log "ok"/"FAIL", non-zero
 * exit on failure), not vitest. That is why vitest cannot simply glob them:
 * they would be collected as suite-less files and error. Component and store
 * tests use vitest and the .test.tsx extension; src/lib/ uses this harness.
 * Keep that split, or teach both runners about the change.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LIB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "lib");

const testFiles = readdirSync(LIB_DIR)
  .filter((f) => f.endsWith(".test.ts"))
  .sort();

if (testFiles.length === 0) {
  console.error("GATE FAILED: found 0 test files in src/lib — the glob is broken, not the suite");
  process.exit(1);
}

// An aggregator (graph.test.ts) imports sibling suites so they share one tsx
// process. Running those siblings again standalone would double-report, so
// only entrypoints — files nobody imports — are executed. Parsed from source
// rather than hardcoded: a hardcoded list is how orphans appear in the first
// place.
const importedByAnother = new Set();
for (const file of testFiles) {
  const src = readFileSync(join(LIB_DIR, file), "utf8");
  for (const m of src.matchAll(/(?:^|\n)\s*import\s+["']\.\/([\w.-]+\.test)["']/g)) {
    importedByAnother.add(`${m[1]}.ts`);
  }
}

const entrypoints = testFiles.filter((f) => !importedByAnother.has(f));

// A vitest-style test with a .ts extension would be collected by neither
// runner — the exact trap that hid the three orphans. Fail loudly instead.
const misfiled = entrypoints.filter((f) =>
  /from\s+["']vitest["']/.test(readFileSync(join(LIB_DIR, f), "utf8")),
);
if (misfiled.length > 0) {
  console.error(
    `GATE FAILED: ${misfiled.join(", ")} import vitest but end in .test.ts, so no runner ` +
    `collects them. Rename to .test.tsx (vitest) or port to the tsx harness.`,
  );
  process.exit(1);
}

console.log(
  `lib tests: ${entrypoints.length} entrypoint(s), ` +
  `${importedByAnother.size} aggregated by another suite`,
);

let failed = 0;
for (const file of entrypoints) {
  process.stdout.write(`\n── ${file}\n`);
  try {
    const out = execFileSync("npx", ["tsx", join("src", "lib", file)], {
      cwd: resolve(LIB_DIR, "..", ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Empty output is failure, not success — the rule this whole gate is built on.
    if (out.trim() === "") {
      console.error(`   FAILED: ${file} printed nothing — it did not actually run`);
      failed += 1;
      continue;
    }
    process.stdout.write(out);
  } catch (err) {
    process.stdout.write(err.stdout ?? "");
    process.stderr.write(err.stderr ?? "");
    console.error(`   FAILED: ${file}`);
    failed += 1;
  }
}

if (failed > 0) {
  console.error(`\nGATE FAILED: ${failed} lib suite(s) failed`);
  process.exit(1);
}
console.log(`\nall lib suites green (${entrypoints.length} entrypoints)`);
