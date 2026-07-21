#!/usr/bin/env node

/**
 * Build the notices that are distributed with NeuroVault Desktop.
 *
 * The inventory is deliberately derived from every current Desktop release
 * target, including both macOS architectures. Cargo metadata without target
 * filtering also includes mobile-only packages, while a host-only inventory
 * can silently omit dependencies from another distributed build.
 *
 * Usage:
 *   node scripts/generate-third-party-notices.mjs --write
 *   node scripts/generate-third-party-notices.mjs --check
 *
 * This is an engineering aid, not a license-policy engine. A changed or novel
 * license still needs human review before a release.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
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
const NATIVE_NOTICE_MANIFEST = join(ROOT, "LICENSES", "NATIVE-NOTICE-SOURCES.json");
const DISTRIBUTION_TARGETS = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "x86_64-unknown-linux-gnu",
];
const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:$|[._-])/i;

function cargoLockChecksums() {
  const lock = readFileSync(join(ROOT, "src-tauri", "Cargo.lock"), "utf8");
  const checksums = new Map();
  for (const block of lock.split("[[package]]").slice(1)) {
    const name = block.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
    const version = block.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];
    const checksum = block.match(/^\s*checksum\s*=\s*"([a-f0-9]+)"/m)?.[1];
    if (name && version && checksum) checksums.set(`${name}@${version}`, checksum);
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
      throw new Error(`${entry.component}: bundled notice is missing (${relative(ROOT, file)})`);
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
      // Cargo represents normal dependencies with a null kind. Build and dev
      // dependencies are tooling and are not linked into the distributed app.
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

function macCompatible(entry) {
  const os = entry.os ?? [];
  if (os.includes("!darwin")) return false;
  if (os.some((value) => !value.startsWith("!")) && !os.includes("darwin")) return false;

  const cpu = entry.cpu ?? [];
  if (cpu.includes("!arm64") && cpu.includes("!x64")) return false;
  if (
    cpu.some((value) => !value.startsWith("!")) &&
    !cpu.includes("arm64") &&
    !cpu.includes("x64")
  ) return false;
  return true;
}

function npmNameFromLockPath(lockPath) {
  return lockPath.split("node_modules/").at(-1);
}

function productionNpmPackages() {
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
  return Object.entries(lock.packages ?? {})
    .filter(([lockPath, entry]) =>
      lockPath.startsWith("node_modules/") && !entry.dev && macCompatible(entry),
    )
    .map(([lockPath, entry]) => ({
      ecosystem: "npm",
      name: npmNameFromLockPath(lockPath),
      version: entry.version,
      license: entry.license ?? "NOASSERTION",
      repository: entry.resolved?.startsWith("http") ? entry.resolved : null,
      packageDir: join(ROOT, lockPath),
    }));
}

function normaliseCargoPackage(pkg) {
  return {
    ecosystem: "Rust",
    name: pkg.name,
    version: pkg.version,
    license: pkg.license ?? (pkg.license_file ? `LicenseRef-${pkg.license_file}` : "NOASSERTION"),
    repository: pkg.repository ?? pkg.homepage ?? `https://crates.io/crates/${pkg.name}/${pkg.version}`,
    sourceArchive: pkg.source?.startsWith("registry+")
      ? `https://crates.io/api/v1/crates/${pkg.name}/${pkg.version}/download`
      : pkg.repository ?? pkg.homepage ?? null,
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
  const npm = new Map(productionNpmPackages().map((pkg) => [packageKey(pkg), pkg]));
  const sort = (a, b) =>
    a.name.localeCompare(b.name) || a.version.localeCompare(b.version);
  return {
    rust: [...rust.values()].sort(sort),
    npm: [...npm.values()].sort(sort),
  };
}

function groupByLicense(packages) {
  const counts = new Map();
  for (const pkg of packages) counts.set(pkg.license, (counts.get(pkg.license) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => a.localeCompare(b));
}

function tableRows(packages, urlFor) {
  return packages
    .map((pkg) => `| ${pkg.name} | ${pkg.version} | \`${pkg.license}\` | ${urlFor(pkg)} |`)
    .join("\n");
}

function renderNotices({ rust, npm }) {
  const mpl = rust.filter((pkg) => pkg.license.split(/\s+(?:OR|AND)\s+/).includes("MPL-2.0"));
  const rustSummary = groupByLicense(rust)
    .map(([license, count]) => `| \`${license}\` | ${count} |`)
    .join("\n");
  const npmSummary = groupByLicense(npm)
    .map(([license, count]) => `| \`${license}\` | ${count} |`)
    .join("\n");

  return `# Third-Party Notices

NeuroVault Desktop is a mixed-license application. Original Desktop material
added after the v0.6.0 boundary is proprietary, while the code and assets at
tag \`v0.6.0\` remain available under MIT. Third-party components retain their
own licenses. See \`LICENSE\` and \`LICENSES/NeuroVault-v0.6.0-MIT.txt\`.

This inventory is generated from the locked production dependency graphs by
\`scripts/generate-third-party-notices.mjs\`. It covers normal Rust dependencies
for the current macOS, Windows, and Linux release targets, plus production npm
dependencies that can participate in the packaged webview. Build-only and
development-only tools are excluded. Platform filtering may still make the
inventory conservatively broader than the bytes in any one app build.

The accompanying \`LICENSES/THIRD-PARTY-LICENSES.txt\` preserves the license and
notice files found in the installed package sources. Exact notices for linked
native components are preserved under \`LICENSES/native/\` and pinned by SHA-256
in \`LICENSES/NATIVE-NOTICE-SOURCES.json\`. A manifest-only section identifies
packages that do not publish a standalone license file in their archive. This
inventory assists compliance review; it is not a legal opinion.

## Material requiring explicit attention

### MPL-2.0 covered components (${mpl.length})

The following unmodified Rust crates declare MPL-2.0. MPL-2.0 is weak copyleft
at the covered-file level; it does not relicense NeuroVault's own files. The
full MPL text is preserved in the bundled license collection. Exact source
archive links and Cargo checksums are in
\`LICENSES/MPL-2.0-COVERED-SOURCE.md\`.

| Crate | Version | License | Source |
|---|---:|---|---|
${tableRows(mpl, (pkg) => `[crates.io](https://crates.io/crates/${pkg.name}/${pkg.version})`)}

### Historical NeuroVault MIT material

NeuroVault source and assets at tag \`v0.6.0\` were released under MIT. That
permission is not withdrawn by the later commercial boundary. The original
license is preserved at \`LICENSES/NeuroVault-v0.6.0-MIT.txt\` and is included
in application resources.

### Native libraries and downloaded models

| Component | Distribution | Declared license | Source |
|---|---|---|---|
| sqlite-vec v0.1.9 | loadable \`vec0.dylib\` in direct builds; statically linked into the Store executable | MIT OR Apache-2.0; exact texts bundled | https://github.com/asg017/sqlite-vec/tree/v0.1.9 |
| SQLite | linked through the \`rusqlite\` bundled feature | Public Domain | https://www.sqlite.org/copyright.html |
| ONNX Runtime 1.20.0 | statically linked by \`ort-sys 2.0.0-rc.9\` as configured by \`fastembed\` | MIT plus upstream third-party notices; exact files bundled | https://github.com/microsoft/onnxruntime/tree/v1.20.0 |
| BAAI/bge-small-en-v1.5, ONNX conversion by Xenova | exact ONNX/tokenizer payload is bundled in the Store app; direct builds download it on first embedding use | MIT (upstream model card); revision and checksums bundled under \`LICENSES/models/\` | https://huggingface.co/BAAI/bge-small-en-v1.5 |
| BAAI/bge-reranker-base | excluded from Store v1; direct builds download it only if local reranking is enabled | MIT (model card) | https://huggingface.co/BAAI/bge-reranker-base |

Model files are governed by the terms published with those files. The Store
payload is pinned by revision and SHA-256; direct-build downloads must still be
audited at release time. These entries are not a legal opinion.

## Rust production dependency inventory (${rust.length})

License expression summary:

| SPDX expression declared by package | Count |
|---|---:|
${rustSummary}

| Crate | Version | Declared license | Package |
|---|---:|---|---|
${tableRows(rust, (pkg) => `[crates.io](https://crates.io/crates/${pkg.name}/${pkg.version})`)}

## npm production dependency inventory (${npm.length})

The npm inventory follows \`package-lock.json\` production entries and filters
packages whose declared OS/CPU constraints cannot run on either supported Mac
architecture. Vite may tree-shake additional packages from a particular build.

| SPDX expression declared by package | Count |
|---|---:|
${npmSummary}

| Package | Version | Declared license | Registry artifact |
|---|---:|---|---|
${tableRows(npm, (pkg) => pkg.repository ? `[npm](${pkg.repository})` : "npm lockfile")}

## Release maintenance

Run \`node scripts/generate-third-party-notices.mjs --write\` after any dependency
change, and \`--check\` in the release gate. Treat a new copyleft, source-available,
non-commercial, custom, or \`NOASSERTION\` entry as a release blocker until a
person reviews its terms. Generated output does not decide license compatibility.
`;
}

function packageLicenseFiles(pkg) {
  const files = [];
  try {
    accessSync(pkg.packageDir, constants.R_OK);
  } catch {
    throw new Error(`Package source is unavailable for ${pkg.ecosystem} ${pkg.name}@${pkg.version}: ${pkg.packageDir}`);
  }

  const candidates = new Set();
  if (pkg.declaredLicenseFile) candidates.add(pkg.declaredLicenseFile);
  for (const name of readdirSync(pkg.packageDir)) {
    if (LICENSE_FILE.test(name)) candidates.add(name);
  }

  for (const name of [...candidates].sort()) {
    const file = join(pkg.packageDir, name);
    try {
      if (!statSync(file).isFile()) continue;
      const text = readFileSync(file, "utf8").replaceAll("\r\n", "\n").trim();
      if (text) files.push({ name, text });
    } catch {
      // A broken optional filename is reported in the manifest-only section.
    }
  }
  return files;
}

function renderLicenseCollection({ rust, npm }) {
  const packages = [...rust, ...npm];
  const texts = new Map();
  const missing = [];

  for (const pkg of packages) {
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
    .map(([digest, entry], index) => `${"=".repeat(78)}
LICENSE TEXT ${index + 1}
SHA-256: ${digest}

Used by:
${entry.uses.sort().map((use) => `  - ${use}`).join("\n")}

${entry.text}
`)
    .join("\n");

  const manifestOnly = missing
    .sort((a, b) => a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
    .map((pkg) => {
      const details = [
        `${pkg.ecosystem}: ${pkg.name}@${pkg.version}`,
        `  Declared license: ${pkg.license}`,
      ];
      if (pkg.authors?.length) details.push(`  Package authors: ${pkg.authors.join(", ")}`);
      if (pkg.repository) details.push(`  Upstream/package source: ${pkg.repository}`);
      return details.join("\n");
    })
    .join("\n\n");

  return `NEUROVAULT DESKTOP THIRD-PARTY LICENSE COLLECTION
Generated from Cargo.lock and package-lock.json for the supported Desktop targets.

This file reproduces the license and notice files present in dependency package
archives. Identical texts are stored once and list every package that supplied
that text. License expressions in the inventory are package metadata, not a
legal conclusion by NeuroVault.

The preserved license for historical NeuroVault v0.6.0 material is distributed
separately as LICENSES/NeuroVault-v0.6.0-MIT.txt.

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
  const mpl = rust.filter((pkg) => pkg.license.split(/\s+(?:OR|AND)\s+/).includes("MPL-2.0"));
  const rows = mpl.map((pkg) =>
    `| ${pkg.name} | ${pkg.version} | [source archive](${pkg.sourceArchive}) | \`${pkg.checksum ?? "not reported"}\` | ${pkg.repository ? `[upstream](${pkg.repository})` : "—"} |`,
  ).join("\n");

  return `# MPL-2.0 covered source

The distributed Desktop dependency graph contains the unmodified MPL-2.0 Rust
crate releases below. Their complete corresponding Source Code form is
available from the versioned crates.io archive links. The Cargo
checksums are recorded so a recipient can verify the exact archives used by
this lockfile.

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
const rendered = new Map([
  [OUTPUTS.notices, normaliseOutput(renderNotices(inventory))],
  [OUTPUTS.licenses, normaliseOutput(renderLicenseCollection(inventory))],
  [OUTPUTS.mplSource, normaliseOutput(renderMplSource(inventory))],
]);

const mode = process.argv[2];
if (mode === "--write") {
  for (const [file, text] of rendered) writeFileSync(file, text, "utf8");
  console.log(`Wrote ${rendered.size} notice files for ${inventory.rust.length} Rust, ${inventory.npm.length} npm, and ${nativeNotices.length} native notice artifacts.`);
} else if (mode === "--check") {
  const stale = [];
  for (const [file, expected] of rendered) {
    let actual = null;
    try {
      actual = readFileSync(file, "utf8");
    } catch {
      // Report the missing file through the same actionable failure path.
    }
    if (actual !== expected) stale.push(relative(ROOT, file));
  }
  if (stale.length > 0) {
    console.error(`Third-party notices are stale: ${stale.join(", ")}`);
    console.error("Run: node scripts/generate-third-party-notices.mjs --write");
    process.exit(1);
  }
  console.log(`Third-party notices are current (${inventory.rust.length} Rust, ${inventory.npm.length} npm, ${nativeNotices.length} native notice artifacts).`);
} else {
  console.error("Usage: node scripts/generate-third-party-notices.mjs --write|--check");
  process.exit(2);
}
