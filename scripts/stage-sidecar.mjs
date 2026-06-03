// Stage the `neurovault-server` MCP binary as a Tauri sidecar (externalBin)
// so it ships next to the app on EVERY platform.
//
// Why this is fiddly: `neurovault-server` is a second binary in the *same*
// crate as the app, and that crate's build.rs (tauri_build) validates that
// the `externalBin` files exist — on EVERY compile of the crate, including
// the compile of `neurovault-server` itself. So a normal build is circular:
// you can't build the sidecar without the sidecar already existing. (It also
// can't be split into its own crate — the sidecar depends on `neurovault_lib`,
// whose build.rs runs the same check.)
//
// The escape hatch: build `neurovault-server` with `TAURI_CONFIG` overriding
// `externalBin` to `[]` (tauri_build json-merge-patches TAURI_CONFIG over the
// file config), so the sidecar compiles with the check disabled. We then stage
// the binary into `src-tauri/binaries/neurovault-server-<triple>[.exe]` — the
// path Tauri's `externalBin` expects — so the *later* app build (which uses the
// real config) validates successfully and bundles it next to the app binary,
// exactly where `mcp_sidecar_path()` looks.
//
// This MUST run in `build.beforeBuildCommand` (before the app's compile), not
// `beforeBundleCommand` (after), or the app's build.rs check fails first.
//
// All our release builds are native (target == host), so the host triple from
// `rustc` is the triple Tauri bundles for.

import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url)); // <repo>/scripts
const srcTauri = resolve(scriptDir, '..', 'src-tauri');

// Host target triple, e.g. "x86_64-pc-windows-msvc" / "aarch64-apple-darwin".
const hostLine = execSync('rustc -vV', { encoding: 'utf8' })
  .split('\n')
  .find((l) => l.startsWith('host:'));
if (!hostLine) throw new Error('[stage-sidecar] could not determine host triple from `rustc -vV`');
const triple = hostLine.slice('host:'.length).trim();
const exe = triple.includes('windows') ? '.exe' : '';
const bin = `neurovault-server${exe}`;

console.log(`[stage-sidecar] building sidecar for ${triple} (externalBin check disabled for this build)`);

// Build the sidecar with externalBin removed from the effective config so its
// build.rs doesn't require the very binary we're producing.
execSync(`cargo build --release --bin neurovault-server --target ${triple}`, {
  cwd: srcTauri,
  stdio: 'inherit',
  env: { ...process.env, TAURI_CONFIG: '{"bundle":{"externalBin":[]}}' },
});

const built = join(srcTauri, 'target', triple, 'release', bin);
if (!existsSync(built)) {
  throw new Error(`[stage-sidecar] built sidecar not found at ${built}`);
}

const outDir = join(srcTauri, 'binaries');
mkdirSync(outDir, { recursive: true });
const dest = join(outDir, `neurovault-server-${triple}${exe}`);
copyFileSync(built, dest);
console.log(`[stage-sidecar] staged ${built} -> ${dest}`);
