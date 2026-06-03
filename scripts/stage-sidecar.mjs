// Stage the `neurovault-server` MCP binary as a Tauri sidecar (externalBin)
// so it ships next to the app on EVERY platform.
//
// Why this exists: `neurovault-server` is a second binary in the same Rust
// crate as the app. Without an explicit `externalBin` entry, Tauri's
// bundler picked it up only by accident (it landed in the macOS .app but
// NOT the Windows installer — which silently broke `--mcp-only` on Windows,
// since `mcp_sidecar_path()` couldn't find `neurovault-server.exe`).
//
// Tauri's `externalBin` looks for `src-tauri/binaries/<name>-<target-triple>[.exe]`
// at bundle time and copies it next to the main executable (Contents/MacOS
// on macOS, the install dir on Windows/Linux) — exactly where
// `mcp_sidecar_path()` looks. This script produces that file.
//
// `cargo build` (run by `tauri build`) already builds `neurovault-server`
// into the target dir, so we just locate and copy it — no recompile in the
// common case. All our release builds are native (target == host), so the
// host triple from `rustc` is the triple Tauri bundles for.
//
// Run automatically via `build.beforeBundleCommand` in tauri.conf.json.

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

console.log(`[stage-sidecar] target triple: ${triple}`);

// `tauri build --target <triple>` (CI) emits to target/<triple>/release/;
// a plain local `tauri build` emits to target/release/. Check both.
const candidates = [
  join(srcTauri, 'target', triple, 'release', bin),
  join(srcTauri, 'target', 'release', bin),
];

let built = candidates.find(existsSync);
if (!built) {
  // The app build should already have produced it, but build defensively.
  console.log('[stage-sidecar] sidecar not found yet — building it');
  execSync(`cargo build --release --bin neurovault-server --target ${triple}`, {
    cwd: srcTauri,
    stdio: 'inherit',
  });
  built = candidates.find(existsSync);
}
if (!built) {
  throw new Error(`[stage-sidecar] neurovault-server binary not found in: ${candidates.join(', ')}`);
}

const outDir = join(srcTauri, 'binaries');
mkdirSync(outDir, { recursive: true });
const dest = join(outDir, `neurovault-server-${triple}${exe}`);
copyFileSync(built, dest);
console.log(`[stage-sidecar] staged ${built} -> ${dest}`);
