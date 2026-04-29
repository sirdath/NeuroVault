/* Pre-package step. Copies the parent repo's React build into ./ui/ and
 * any locally built sidecar binaries into ./server-bin/<platform>/.
 *
 * The vscode-extension folder is otherwise self-contained, so once
 * this script has run, `vsce package` produces a working .vsix that
 * does not need the parent repo at install time.
 *
 * Usage:
 *   node scripts/package-assets.mjs
 *
 * In CI we will populate server-bin/<platform>/ from per-OS GitHub
 * Actions runners; for local dev only the host-platform binary needs
 * to exist for the extension to boot.
 */

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extRoot = resolve(here, "..");
const repoRoot = resolve(extRoot, "..");

const distSrc = join(repoRoot, "dist");
const distDest = join(extRoot, "ui");

if (!existsSync(distSrc)) {
  console.error(
    `[package-assets] missing ${distSrc}. ` +
    `Run \`npm run build\` in the repo root first.`,
  );
  process.exit(1);
}

console.log(`[package-assets] copying React build`);
console.log(`  src:  ${distSrc}`);
console.log(`  dest: ${distDest}`);
rmSync(distDest, { recursive: true, force: true });
mkdirSync(distDest, { recursive: true });
cpSync(distSrc, distDest, { recursive: true });

// Optional: pull a host-platform sidecar binary if the user has built
// one locally. CI populates this directory per-platform from a fresh
// build per matrix entry; here we just try the conventional Tauri
// output path for the host platform.
const platformKey = `${process.platform}-${process.arch}`;
const hostBin = pickHostSidecar(repoRoot, platformKey);
if (hostBin) {
  const dest = join(extRoot, "server-bin", hostBin.platformDir, hostBin.name);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(hostBin.path, dest);
  console.log(`[package-assets] sidecar: ${hostBin.path} -> ${dest}`);
} else {
  console.warn(
    `[package-assets] no host sidecar found for ${platformKey}. ` +
    `The extension will load but the server will not start until ` +
    `server-bin/<platform>/ is populated (CI does this per matrix entry).`,
  );
}

console.log(`[package-assets] done`);

function pickHostSidecar(repoRoot, platformKey) {
  // Tauri release builds end up at src-tauri/target/release/<bin>.
  // The bin name is the Cargo package name; for NeuroVault that is
  // currently the desktop app itself, not a separate server. The
  // dedicated `neurovault-server` sidecar is built by a separate
  // crate. Until that crate exists, this script just emits the
  // warning above and continues; CI will need to wire the actual
  // bundle. Stub kept so the directory layout is documented.
  const candidates = [
    {
      platformDir: "win32-x64",
      name: "neurovault-server.exe",
      path: join(repoRoot, "src-tauri", "target", "release", "neurovault-server.exe"),
      key: "win32-x64",
    },
    {
      platformDir: "darwin-arm64",
      name: "neurovault-server",
      path: join(repoRoot, "src-tauri", "target", "release", "neurovault-server"),
      key: "darwin-arm64",
    },
    {
      platformDir: "darwin-x64",
      name: "neurovault-server",
      path: join(repoRoot, "src-tauri", "target", "release", "neurovault-server"),
      key: "darwin-x64",
    },
    {
      platformDir: "linux-x64",
      name: "neurovault-server",
      path: join(repoRoot, "src-tauri", "target", "release", "neurovault-server"),
      key: "linux-x64",
    },
  ];
  return candidates.find((c) => c.key === platformKey && existsSync(c.path));
}
