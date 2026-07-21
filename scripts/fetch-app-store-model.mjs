#!/usr/bin/env node

import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  fileSha256,
  modelFiles,
  modelRepository,
  modelRevision,
  verifyCanonicalModelDirectory,
  writeModelManifest,
} from "./app-store-model.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultDestination = join(
  root,
  "src-tauri",
  "target",
  "app-store-model",
  modelRevision,
);
const destination = resolve(process.argv[2] || defaultDestination);
const parent = dirname(destination);
await mkdir(parent, { recursive: true });

// A previously verified package is immutable and can be reused without any
// network access. An invalid package is never repaired in place: a complete
// replacement is assembled and verified beside it first.
try {
  await verifyCanonicalModelDirectory(destination);
  console.log(`Pinned Store model already verified: ${destination}`);
  process.exit(0);
} catch {
  // Continue to a clean, all-or-nothing download below.
}

const incoming = await mkdtemp(join(parent, ".neurovault-model-incoming-"));
const backup = `${destination}.previous-${process.pid}`;
let published = false;
let backupMoved = false;

try {
  for (const file of modelFiles) {
    const url = `https://huggingface.co/${modelRepository}/resolve/${modelRevision}/${file.source}`;
    const output = join(incoming, file.destination);
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": "NeuroVault-App-Store-model-fetcher/1" },
    });
    if (!response.ok || !response.body) {
      throw new Error(`model download failed (${response.status}) for ${url}`);
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(output, { flags: "wx", mode: 0o644 }));

    const actual = await fileSha256(output);
    if (actual !== file.sha256) {
      throw new Error(
        `model checksum mismatch for ${file.source}: expected ${file.sha256}, got ${actual}`,
      );
    }
    console.log(`Verified ${file.destination}: ${actual}`);
  }

  await writeModelManifest(incoming);
  await verifyCanonicalModelDirectory(incoming);

  await rm(backup, { recursive: true, force: true });
  try {
    await rename(destination, backup);
    backupMoved = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  try {
    await rename(incoming, destination);
    published = true;
  } catch (error) {
    if (backupMoved) await rename(backup, destination);
    throw error;
  }

  if (backupMoved) await rm(backup, { recursive: true, force: true });
  console.log(`Pinned Store model ready: ${modelRepository}@${modelRevision}`);
  console.log(`Canonical package: ${destination}`);
} finally {
  if (!published) await rm(incoming, { recursive: true, force: true });
}
