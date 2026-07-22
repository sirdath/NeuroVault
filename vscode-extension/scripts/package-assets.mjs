/* Pre-package step. Copies the parent repo's React build and legal files into
 * the extension, then validates bundled server + sqlite-vec pairs.
 *
 * The vscode-extension folder is otherwise self-contained, so once
 * this script has run, `vsce package` produces a working .vsix that
 * does not need the parent repo at install time.
 *
 * Usage:
 *   node scripts/package-assets.mjs
 *
 * CI passes --all-platforms after populating server-bin/<platform>/ from
 * per-OS GitHub Actions runners. Local development may stage only the host.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extRoot = resolve(here, "..");
const repoRoot = resolve(extRoot, "..");

execFileSync(
  process.execPath,
  [join(repoRoot, "scripts", "generate-third-party-notices.mjs"), "--check"],
  { cwd: repoRoot, stdio: "inherit" },
);

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

for (const file of ["LICENSE", "PRIVACY.md", "THIRD-PARTY-NOTICES.md"]) {
  const source = join(repoRoot, file);
  if (!existsSync(source)) {
    console.error(`[package-assets] missing required legal file ${source}`);
    process.exit(1);
  }
  cpSync(source, join(extRoot, file));
}

const licenseBundle = join(repoRoot, "LICENSES");
const stagedLicenseBundle = join(extRoot, "LICENSES");
const requiredLicenseBundleFiles = [
  "LICENSES/MPL-2.0-COVERED-SOURCE.md",
  "LICENSES/NATIVE-NOTICE-SOURCES.json",
  "LICENSES/THIRD-PARTY-LICENSES.txt",
  "LICENSES/models/DOWNLOADED-MODELS.md",
  "LICENSES/native/bge-small-en-v1.5-LICENSE-MIT",
  "LICENSES/native/onnxruntime-1.20.0-LICENSE",
  "LICENSES/native/onnxruntime-1.20.0-ThirdPartyNotices.txt",
  "LICENSES/native/sqlite-vec-v0.1.9-LICENSE-APACHE",
  "LICENSES/native/sqlite-vec-v0.1.9-LICENSE-MIT",
];
for (const file of requiredLicenseBundleFiles) {
  const source = join(repoRoot, file);
  if (!existsSync(source) || !statSync(source).isFile() || statSync(source).size === 0) {
    console.error(`[package-assets] missing or empty required notice ${source}`);
    process.exit(1);
  }
}
rmSync(stagedLicenseBundle, { recursive: true, force: true });
cpSync(licenseBundle, stagedLicenseBundle, { recursive: true });

// Optional: pull a host-platform sidecar binary if the user has built
// one locally. CI populates this directory per-platform from a fresh
// build per matrix entry; here we just try the conventional Tauri
// output path for the host platform.
const platformKey = `${process.platform}-${process.arch}`;
const hostBin = pickHostSidecar(repoRoot, platformKey);
if (hostBin) {
  const destination = join(extRoot, "server-bin", hostBin.platformDir);
  mkdirSync(destination, { recursive: true });
  cpSync(hostBin.path, join(destination, hostBin.name));
  if (existsSync(hostBin.vecPath)) {
    cpSync(hostBin.vecPath, join(destination, hostBin.vecName));
  }
  console.log(`[package-assets] server: ${hostBin.path} -> ${destination}`);
} else {
  console.warn(
    `[package-assets] no host sidecar found for ${platformKey}. ` +
    `The extension will load but the server will not start until ` +
    `server-bin/<platform>/ is populated (CI does this per matrix entry).`,
  );
}

if (process.argv.includes("--all-platforms")) {
  const required = [
    { dir: "win32-x64", files: ["neurovault-server.exe", "vec0.dll"] },
    { dir: "darwin-arm64", files: ["neurovault-server", "vec0.dylib"] },
    { dir: "linux-x64", files: ["neurovault-server", "vec0.so"] },
  ];
  for (const platform of required) {
    for (const file of platform.files) {
      const asset = join(extRoot, "server-bin", platform.dir, file);
      if (!existsSync(asset) || !statSync(asset).isFile() || statSync(asset).size === 0) {
        console.error(`[package-assets] missing or empty required asset ${asset}`);
        process.exit(1);
      }
    }
  }
  if (existsSync(join(extRoot, "server-bin", "darwin-x64"))) {
    console.error("[package-assets] unsupported darwin-x64 directory must not be packaged");
    process.exit(1);
  }
  console.log("[package-assets] all supported server + sqlite-vec pairs verified");
}

console.log(`[package-assets] done`);

function pickHostSidecar(repoRoot, platformKey) {
  // Tauri release builds end up at src-tauri/target/release/<bin>.
  const candidates = [
    {
      platformDir: "win32-x64",
      name: "neurovault-server.exe",
      path: join(repoRoot, "src-tauri", "target", "release", "neurovault-server.exe"),
      vecName: "vec0.dll",
      vecPath: join(repoRoot, "src-tauri", "resources", "vec0.dll"),
      key: "win32-x64",
    },
    {
      platformDir: "darwin-arm64",
      name: "neurovault-server",
      path: join(repoRoot, "src-tauri", "target", "release", "neurovault-server"),
      vecName: "vec0.dylib",
      vecPath: join(repoRoot, "src-tauri", "resources", "vec0.dylib"),
      key: "darwin-arm64",
    },
    {
      platformDir: "linux-x64",
      name: "neurovault-server",
      path: join(repoRoot, "src-tauri", "target", "release", "neurovault-server"),
      vecName: "vec0.so",
      vecPath: join(repoRoot, "src-tauri", "resources", "vec0.so"),
      key: "linux-x64",
    },
  ];
  return candidates.find((c) => c.key === platformKey && existsSync(c.path));
}
