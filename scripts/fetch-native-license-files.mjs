#!/usr/bin/env node

/**
 * Refresh large native-component notices from immutable version tags.
 *
 * URLs and expected SHA-256 digests live in
 * LICENSES/NATIVE-NOTICE-SOURCES.json. A digest mismatch aborts before a file
 * is written, so an upstream or transport change cannot silently alter the
 * attribution shipped in a signed app.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(ROOT, "LICENSES", "NATIVE-NOTICE-SOURCES.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

for (const entry of manifest) {
  const response = await fetch(entry.url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${entry.component}: download failed (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== entry.sha256) {
    throw new Error(`${entry.component}: SHA-256 mismatch (expected ${entry.sha256}, got ${actual})`);
  }
  const destination = join(ROOT, "LICENSES", entry.file);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  console.log(`Verified and wrote ${entry.file}`);
}
