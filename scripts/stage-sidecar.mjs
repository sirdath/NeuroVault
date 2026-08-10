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
// It ALSO runs in `beforeDevCommand`: without it a fresh clone can't even
// `cargo check`, because the default `gui` feature makes build.rs run the same
// externalBin validation. `tauri dev` therefore died with "resource path
// binaries/neurovault-server-<triple> doesn't exist" on every clean checkout,
// and the only cure anyone had was to run a full `tauri build` first.
//
// Because `tauri dev` restarts run this on every rebuild, the release-profile
// build below (lto = "fat", codegen-units = 1 — minutes, not seconds) is
// SKIPPED when the staged binary is already newer than every input that could
// change it. Delete src-tauri/binaries/ to force a rebuild.
//
// All our release builds are native (target == host), so the host triple from
// `rustc` is the triple Tauri bundles for.

import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
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

const outDir = join(srcTauri, 'binaries');
const dest = join(outDir, `neurovault-server-${triple}${exe}`);

/** Newest mtime (ms) under a file or directory. Missing paths count as 0. */
function newestMtimeMs(path) {
  let st;
  try {
    st = statSync(path);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.mtimeMs;
  let newest = st.mtimeMs;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    newest = Math.max(newest, newestMtimeMs(join(path, entry.name)));
  }
  return newest;
}

// Everything that can change the bytes of the sidecar: the Rust sources, the
// manifest/lockfile, build.rs, and the Tauri config baked in by tauri_build.
const inputs = ['src', 'build.rs', 'Cargo.toml', 'Cargo.lock', 'tauri.conf.json'];
const newestInput = Math.max(...inputs.map((p) => newestMtimeMs(join(srcTauri, p))));

if (existsSync(dest) && statSync(dest).mtimeMs >= newestInput) {
  console.log(`[stage-sidecar] reused ${dest} (up to date with src-tauri sources)`);
  process.exit(0);
}

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

mkdirSync(outDir, { recursive: true });
copyFileSync(built, dest);
console.log(`[stage-sidecar] staged ${built} -> ${dest}`);
