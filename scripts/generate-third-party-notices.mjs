#!/usr/bin/env node

/**
 * Generate the third-party notices distributed with NeuroVault desktop and
 * headless binaries.
 *
 * The inventory is the union of normal/runtime Rust dependencies for every
 * supported release target plus production npm dependencies that can ship in
 * the webview. Build and development dependencies are deliberately excluded.
 *
 * Usage:
 *   node scripts/generate-third-party-notices.mjs --write
 *   node scripts/generate-third-party-notices.mjs --check
 *
 * This is an engineering aid, not a license-policy engine. New or changed
 * license terms still require human review before a release.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CARGO_MANIFEST = join(ROOT, "src-tauri", "Cargo.toml");
const OUTPUTS = {
  notices: join(ROOT, "THIRD-PARTY-NOTICES.md"),
  licenses: join(ROOT, "LICENSES", "THIRD-PARTY-LICENSES.txt"),
  mplSource: join(ROOT, "LICENSES", "MPL-2.0-COVERED-SOURCE.md"),
};
const NATIVE_NOTICE_MANIFEST = join(
  ROOT,
  "LICENSES",
  "NATIVE-NOTICE-SOURCES.json",
);
const DISTRIBUTION_TARGETS = [
  "aarch64-apple-darwin",
  "x86_64-unknown-linux-gnu",
  "x86_64-pc-windows-msvc",
];
const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:$|[._-])/i;

function cargoLockChecksums() {
  const lock = readFileSync(join(ROOT, "src-tauri", "Cargo.lock"), "utf8");
  const checksums = new Map();
  for (const block of lock.split("[[package]]").slice(1)) {
    const name = block.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
    const version = block.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];
    const checksum = block.match(/^\s*checksum\s*=\s*"([a-f0-9]+)"/m)?.[1];
    if (name && version && checksum) {
      checksums.set(`${name}@${version}`, checksum);
    }
  }
  return checksums;
}

const CARGO_LOCK_CHECKSUMS = cargoLockChecksums();

function verifyNativeNotices() {
  const manifest = JSON.parse(readFileSync(NATIVE_NOTICE_MANIFEST, "utf8"));
  for (const entry of manifest) {
    const file = join(ROOT, "LICENSES", entry.file);
    let bytes;
    try {
      bytes = readFileSync(file);
    } catch {
      throw new Error(
        `${entry.component}: bundled notice is missing (${relative(ROOT, file)})`,
      );
    }
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== entry.sha256) {
      throw new Error(`${entry.component}: bundled notice SHA-256 mismatch`);
    }
  }
  return manifest;
}

function cargoMetadata(target) {
  const stdout = execFileSync(
    "cargo",
    [
      "metadata",
      "--manifest-path",
      CARGO_MANIFEST,
      "--format-version",
      "1",
      "--locked",
      "--all-features",
      "--filter-platform",
      target,
    ],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

function runtimeCargoPackages(metadata) {
  const rootPackage = metadata.packages.find(
    (pkg) => resolve(pkg.manifest_path) === CARGO_MANIFEST,
  );
  if (!rootPackage) throw new Error("Could not find the NeuroVault Cargo package");

  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const seen = new Set([rootPackage.id]);
  const queue = [rootPackage.id];

  while (queue.length > 0) {
    const node = nodes.get(queue.shift());
    for (const dependency of node?.deps ?? []) {
      // A null Cargo dependency kind is a normal/runtime dependency. Build and
      // dev dependencies are tooling and do not ship in the server binary.
      if (!dependency.dep_kinds.some((kind) => kind.kind === null)) continue;
      if (seen.has(dependency.pkg)) continue;
      seen.add(dependency.pkg);
      queue.push(dependency.pkg);
    }
  }

  return metadata.packages.filter(
    (pkg) => pkg.id !== rootPackage.id && seen.has(pkg.id),
  );
}

function packageKey(pkg) {
  return `${pkg.name}@${pkg.version}`;
}

const NPM_TARGETS = [
  { os: "darwin", cpu: "arm64" },
  { os: "linux", cpu: "x64" },
  { os: "win32", cpu: "x64" },
];

function packageSupportsTarget(entry, target) {
  const os = entry.os ?? [];
  if (os.includes(`!${target.os}`)) return false;
  if (os.some((value) => !value.startsWith("!")) && !os.includes(target.os)) {
    return false;
  }

  const cpu = entry.cpu ?? [];
  if (cpu.includes(`!${target.cpu}`)) return false;
  if (cpu.some((value) => !value.startsWith("!")) && !cpu.includes(target.cpu)) {
    return false;
  }
  return true;
}

function npmNameFromLockPath(lockPath) {
  return lockPath.split("node_modules/").at(-1);
}

function productionNpmPackages() {
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
  return Object.entries(lock.packages ?? {})
    .filter(
      ([lockPath, entry]) =>
        lockPath.startsWith("node_modules/") &&
        !entry.dev &&
        NPM_TARGETS.some((target) => packageSupportsTarget(entry, target)),
    )
    .map(([lockPath, entry]) => ({
      ecosystem: "npm",
      name: npmNameFromLockPath(lockPath),
      version: entry.version,
      license: entry.license ?? "NOASSERTION",
      repository: `https://www.npmjs.com/package/${npmNameFromLockPath(lockPath)}/v/${entry.version}`,
      packageDir: join(ROOT, lockPath),
    }));
}

function normaliseCargoPackage(pkg) {
  return {
    ecosystem: "Rust",
    name: pkg.name,
    version: pkg.version,
    license:
      pkg.license ??
      (pkg.license_file ? `LicenseRef-${pkg.license_file}` : "NOASSERTION"),
    repository:
      pkg.repository ??
      pkg.homepage ??
      `https://crates.io/crates/${pkg.name}/${pkg.version}`,
    sourceArchive: pkg.source?.startsWith("registry+")
      ? `https://crates.io/api/v1/crates/${pkg.name}/${pkg.version}/download`
      : (pkg.repository ?? pkg.homepage ?? null),
    checksum: pkg.checksum ?? CARGO_LOCK_CHECKSUMS.get(packageKey(pkg)) ?? null,
    authors: pkg.authors ?? [],
    packageDir: dirname(pkg.manifest_path),
    declaredLicenseFile: pkg.license_file,
  };
}

function collectInventory() {
  const rust = new Map();
  for (const target of DISTRIBUTION_TARGETS) {
    for (const pkg of runtimeCargoPackages(cargoMetadata(target))) {
      rust.set(packageKey(pkg), normaliseCargoPackage(pkg));
    }
  }
  const sort = (a, b) =>
    a.name.localeCompare(b.name) || a.version.localeCompare(b.version);
  const npm = new Map(productionNpmPackages().map((pkg) => [packageKey(pkg), pkg]));
  return {
    rust: [...rust.values()].sort(sort),
    npm: [...npm.values()].sort(sort),
  };
}

function verifyPinnedNativeGraph({ rust }) {
  // These versions explain the exact native notices copied into LICENSES/.
  // Fail closed when the locked graph changes so a dependency upgrade cannot
  // silently keep publishing an obsolete ONNX Runtime notice.
  const required = new Map([
    ["fastembed", "4.9.1"],
    ["ort", "2.0.0-rc.9"],
    ["ort-sys", "2.0.0-rc.9"],
  ]);
  for (const [name, expectedVersion] of required) {
    const matches = rust.filter(
      (pkg) => pkg.name === name && pkg.version === expectedVersion,
    );
    if (matches.length !== 1) {
      const actual = rust
        .filter((pkg) => pkg.name === name)
        .map((pkg) => pkg.version)
        .join(", ");
      throw new Error(
        `${name}: native notice expects ${expectedVersion}, locked runtime graph has ${actual || "no matching package"}. Re-audit LICENSES/native and update the generator.`,
      );
    }
  }
}

function isMpl(pkg) {
  return /(?:^|[^A-Za-z0-9.-])MPL-2\.0(?:$|[^A-Za-z0-9.-])/.test(pkg.license);
}

function groupByLicense(packages) {
  const counts = new Map();
  for (const pkg of packages) {
    counts.set(pkg.license, (counts.get(pkg.license) ?? 0) + 1);
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b));
}

function tableRows(packages) {
  return packages
    .map(
      (pkg) =>
        `| ${pkg.name} | ${pkg.version} | \`${pkg.license}\` | [package](${pkg.repository}) |`,
    )
    .join("\n");
}

function renderNotices({ rust, npm }) {
  const mpl = rust.filter(isMpl);
  const rustSummary = groupByLicense(rust)
    .map(([license, count]) => `| \`${license}\` | ${count} |`)
    .join("\n");
  const npmSummary = groupByLicense(npm)
    .map(([license, count]) => `| \`${license}\` | ${count} |`)
    .join("\n");

  return `# Third-Party Notices

NeuroVault is licensed under MIT. Third-party components retain their own
licenses. This inventory is generated from the locked production dependency
graphs used by the desktop app and headless MCP distribution: normal/runtime
Rust dependencies for the current macOS Apple Silicon, Linux x64 glibc, and
Windows x64 binary targets, plus production npm dependencies from the root
webview application. Build-only and development-only tools are excluded.
Platform filtering can still make this union broader than the bytes in any one
platform build.

The accompanying \`LICENSES/THIRD-PARTY-LICENSES.txt\` preserves license and
notice files found in the dependency package sources. Exact notices for linked
native components are preserved under \`LICENSES/native/\` and pinned by
SHA-256 in \`LICENSES/NATIVE-NOTICE-SOURCES.json\`. A manifest-only section
identifies packages whose archives do not expose a standalone top-level
license file. This inventory assists release compliance review; it is not a
legal opinion.

## Material requiring explicit attention

### MPL-2.0 covered components (${mpl.length})

The following unmodified Rust crate releases declare MPL-2.0. MPL-2.0 is weak
copyleft at the covered-file level; it does not relicense NeuroVault's own
files. Exact versioned source archive links and Cargo checksums are provided in
\`LICENSES/MPL-2.0-COVERED-SOURCE.md\`, and the full license text shipped by
the crate is included in the license collection.

| Crate | Version | License | Source |
|---|---:|---|---|
${tableRows(mpl)}

### Native libraries and runtime-downloaded models

| Component | Distribution | Declared license | Source |
|---|---|---|---|
| sqlite-vec v0.1.9 | loadable extension included in each platform binary package | MIT OR Apache-2.0; exact texts bundled | https://github.com/asg017/sqlite-vec/tree/v0.1.9 |
| SQLite | linked through the \`rusqlite\` bundled feature | Public Domain | https://www.sqlite.org/copyright.html |
| ONNX Runtime 1.20.0 | statically linked by \`ort-sys 2.0.0-rc.9\` as configured by \`fastembed 4.9.1\` | MIT plus upstream third-party notices; exact files bundled | https://github.com/microsoft/onnxruntime/tree/v1.20.0 |
| BAAI/bge-small-en-v1.5, ONNX conversion by Xenova | downloaded on first embedding use; not included in installers or npm packages | MIT (upstream model card); see conversion-repository caveat in the downloaded-model notice | https://huggingface.co/BAAI/bge-small-en-v1.5 |
| BAAI/bge-reranker-base | downloaded on the first qualifying reranked recall while reranking is enabled; not included in installers or npm packages | MIT (upstream model card) | https://huggingface.co/BAAI/bge-reranker-base |

Downloaded model files remain governed by the terms published with those
files. See \`LICENSES/models/DOWNLOADED-MODELS.md\` for the runtime behavior and
source links. Audit the exact artifacts again for every release candidate.

## Rust production dependency inventory (${rust.length})

License expression summary:

| SPDX expression declared by package | Count |
|---|---:|
${rustSummary}

| Crate | Version | Declared license | Package |
|---|---:|---|---|
${tableRows(rust)}

## npm production dependency inventory (${npm.length})

This is the transitive production graph selected from the root
\`package-lock.json\` for the supported release operating systems and CPU
architectures. It covers code that can ship in the desktop webview. Tooling and
test-only packages are excluded.

License expression summary:

| License declared by package | Count |
|---|---:|
${npmSummary}

| Package | Version | Declared license | Package |
|---|---:|---|---|
${tableRows(npm)}

## Release maintenance

Run \`node scripts/generate-third-party-notices.mjs --write\` after any Cargo or
root npm dependency change, and \`--check\` in the release gate. Treat a new
copyleft, source-available, non-commercial, custom, or \`NOASSERTION\` entry as a
release blocker until a person reviews its terms. Generated output does not
decide license compatibility.
`;
}

function packageLicenseFiles(pkg) {
  try {
    accessSync(pkg.packageDir, constants.R_OK);
  } catch {
    throw new Error(
      `Package source is unavailable for ${pkg.ecosystem} ${pkg.name}@${pkg.version}: ${pkg.packageDir}`,
    );
  }

  const candidates = new Set();
  if (pkg.declaredLicenseFile) candidates.add(pkg.declaredLicenseFile);
  for (const name of readdirSync(pkg.packageDir)) {
    if (LICENSE_FILE.test(name)) candidates.add(name);
  }

  const files = [];
  for (const name of [...candidates].sort()) {
    const file = join(pkg.packageDir, name);
    try {
      if (!statSync(file).isFile()) continue;
      const text = readFileSync(file, "utf8")
        .replaceAll("\r\n", "\n")
        .trim();
      if (text) files.push({ name, text });
    } catch {
      // A missing optional filename is represented in the manifest-only list.
    }
  }
  return files;
}

function renderLicenseCollection({ rust, npm }) {
  const texts = new Map();
  const missing = [];

  for (const pkg of [...rust, ...npm]) {
    const files = packageLicenseFiles(pkg);
    if (files.length === 0) {
      missing.push(pkg);
      continue;
    }
    for (const file of files) {
      const digest = createHash("sha256").update(file.text).digest("hex");
      const entry = texts.get(digest) ?? { text: file.text, uses: [] };
      entry.uses.push(`${pkg.ecosystem}: ${pkg.name}@${pkg.version} (${file.name})`);
      texts.set(digest, entry);
    }
  }

  const blocks = [...texts.entries()]
    .sort(([, a], [, b]) => a.uses[0].localeCompare(b.uses[0]))
    .map(
      ([digest, entry], index) => `${"=".repeat(78)}
LICENSE TEXT ${index + 1}
SHA-256: ${digest}

Used by:
${entry.uses
  .sort()
  .map((use) => `  - ${use}`)
  .join("\n")}

${entry.text}
`,
    )
    .join("\n");

  const manifestOnly = missing
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
    )
    .map((pkg) => {
      const details = [
        `${pkg.ecosystem}: ${pkg.name}@${pkg.version}`,
        `  Declared license: ${pkg.license}`,
      ];
      if (pkg.authors?.length) {
        details.push(`  Package authors: ${pkg.authors.join(", ")}`);
      }
      if (pkg.repository) details.push(`  Upstream/package source: ${pkg.repository}`);
      return details.join("\n");
    })
    .join("\n\n");

  return `NEUROVAULT THIRD-PARTY LICENSE COLLECTION
Generated from Cargo.lock and package-lock.json for the supported desktop and
headless distribution targets.

This file reproduces the license and notice files present in dependency package
archives. Identical texts are stored once and list every package that supplied
that text. License expressions in the inventory are package metadata, not a
legal conclusion by NeuroVault.

${blocks}
${"=".repeat(78)}
PACKAGES WITH MANIFEST-ONLY LICENSE DECLARATIONS

The following package archives did not contain a standalone top-level LICENSE,
COPYING, or NOTICE file. Their manifest declarations and upstream locations are
preserved here for manual release review. An entry in this section is not proof
that no notice obligation exists elsewhere in the package source.

${manifestOnly || "  (none)"}
`;
}

function renderMplSource({ rust }) {
  const mpl = rust.filter(isMpl);
  const rows = mpl
    .map(
      (pkg) =>
        `| ${pkg.name} | ${pkg.version} | [source archive](${pkg.sourceArchive}) | \`${pkg.checksum ?? "not reported"}\` | ${pkg.repository ? `[upstream](${pkg.repository})` : "—"} |`,
    )
    .join("\n");

  return `# MPL-2.0 covered source

The distributed NeuroVault dependency graph contains the unmodified
MPL-2.0 Rust crate releases below. Their complete corresponding Source Code
form is available from the versioned crates.io archive links. Cargo checksums
are recorded so recipients can verify the exact archives used by this lockfile.

| Crate | Version | Corresponding source | Cargo SHA-256 | Upstream |
|---|---:|---|---|---|
${rows}

NeuroVault does not modify these registry crate sources. If that changes, the
modified covered files and build-relevant changes must be made available under
MPL-2.0 with the distributed executable. The full MPL-2.0 text shipped by the
crates is reproduced in \`THIRD-PARTY-LICENSES.txt\`.

This file is a source-access notice, not legal advice. Verify the archive links,
checksums, and modification status again for every release candidate.
`;
}

function normaliseOutput(text) {
  return `${text.trimEnd()}\n`;
}

const nativeNotices = verifyNativeNotices();
const inventory = collectInventory();
verifyPinnedNativeGraph(inventory);
const rendered = new Map([
  [OUTPUTS.notices, normaliseOutput(renderNotices(inventory))],
  [OUTPUTS.licenses, normaliseOutput(renderLicenseCollection(inventory))],
  [OUTPUTS.mplSource, normaliseOutput(renderMplSource(inventory))],
]);

const mode = process.argv[2];
if (mode === "--write") {
  for (const [file, contents] of rendered) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents, "utf8");
  }
  console.log(
    `Wrote ${rendered.size} notice files for ${inventory.rust.length} Rust dependencies, ${inventory.npm.length} npm dependencies, and ${nativeNotices.length} audited native/model notice artifacts.`,
  );
} else if (mode === "--check") {
  const stale = [];
  for (const [file, expected] of rendered) {
    let actual = null;
    try {
      actual = readFileSync(file, "utf8");
    } catch {
      // Report missing files through the same actionable failure path.
    }
    if (actual !== expected) stale.push(relative(ROOT, file));
  }
  if (stale.length > 0) {
    console.error(`Third-party notices are stale: ${stale.join(", ")}`);
    console.error("Run: node scripts/generate-third-party-notices.mjs --write");
    process.exit(1);
  }
  console.log(
    `Third-party notices are current (${inventory.rust.length} Rust dependencies, ${inventory.npm.length} npm dependencies, and ${nativeNotices.length} audited native/model notice artifacts).`,
  );
} else {
  console.error(
    "Usage: node scripts/generate-third-party-notices.mjs --write|--check",
  );
  process.exit(2);
}
