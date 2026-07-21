#!/usr/bin/env node

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  modelRepository,
  modelRevision,
  verifyCanonicalModelDirectory,
} from "./app-store-model.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultDirectory = join(
  root,
  "src-tauri",
  "target",
  "app-store-model",
  modelRevision,
);
const directory = resolve(process.argv[2] || defaultDirectory);

await verifyCanonicalModelDirectory(directory);
console.log(`Canonical Store model verified: ${modelRepository}@${modelRevision}`);
console.log(directory);
