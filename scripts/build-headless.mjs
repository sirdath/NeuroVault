#!/usr/bin/env node
// Build the headless `neurovault-server` for a target triple and stage it (with
// its `vec0` sqlite-vec extension) into the matching dist-npm platform
// subpackage's bin/.
//
//   node scripts/build-headless.mjs                      # host triple
//   node scripts/build-headless.mjs aarch64-apple-darwin # explicit triple (CI)
//
// The binary is built with `--no-default-features`, so it links NO Tauri (no
// WebKit/GTK) — see the `gui` cargo feature. That is what lets it run on a
// headless server/Docker box; the GUI build links those frameworks.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src-tauri');

// triple -> { subpkg, vec, bin }. Release CI builds and smokes each advertised
// target with its exact sqlite-vec artifact before packaging it.
const TARGETS = {
  'aarch64-apple-darwin': { subpkg: 'mcp-darwin-arm64', vec: 'vec0.dylib', bin: 'neurovault-server' },
  // NO x86_64-apple-darwin row. It used to point at the SAME vec0.dylib as the
  // arm64 row above — and that file is arm64-only (`lipo -archs` → arm64).
  // There is no x64 or universal vec0 in the pipeline, and sqlite_vec::load is
  // fatal in db.rs::open_new, so an Intel package built from this map would
  // have failed to open any brain. It never actually shipped: the macos-13 job
  // never got a runner. Re-adding needs BOTH an x64 vec0 and a reliable Intel
  // runner — see the note in .github/workflows/npm-release.yml.
  // vec0.so is NOT committed (a glibc-built .so can't be vendored portably) —
  // CI builds it from sqlite-vec source into src-tauri/resources/ before this runs.
  'x86_64-unknown-linux-gnu': { subpkg: 'mcp-linux-x64', vec: 'vec0.so', bin: 'neurovault-server' },
  // vec0.dll IS committed in src-tauri/resources/, so Windows needs no download.
  'x86_64-pc-windows-msvc': { subpkg: 'mcp-win32-x64', vec: 'vec0.dll', bin: 'neurovault-server.exe' },
};

function hostTriple() {
  const { platform, arch } = process;
  if (platform === 'darwin') return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  if (platform === 'linux') return 'x86_64-unknown-linux-gnu';
  if (platform === 'win32') return 'x86_64-pc-windows-msvc';
  throw new Error(`unsupported host ${platform}-${arch}`);
}

const triple = process.argv[2] || hostTriple();
const t = TARGETS[triple];
if (!t) {
  console.error(`build-headless: no packaging target for "${triple}" yet.`);
  console.error(`  known: ${Object.keys(TARGETS).join(', ')}`);
  process.exit(1);
}

const isHost = triple === hostTriple();
const cargoArgs = ['build', '--release', '--no-default-features', '--bin', 'neurovault-server'];
if (!isHost) cargoArgs.push('--target', triple);

console.error(`[build-headless] cargo ${cargoArgs.join(' ')}`);
execFileSync('cargo', cargoArgs, { cwd: SRC, stdio: 'inherit' });

const outDir = isHost ? join(SRC, 'target/release') : join(SRC, 'target', triple, 'release');
const builtBin = join(outDir, t.bin);
if (!existsSync(builtBin)) throw new Error(`built binary not found: ${builtBin}`);
const vecSrc = join(SRC, 'resources', t.vec);
if (!existsSync(vecSrc)) throw new Error(`vec0 extension missing for ${triple}: ${vecSrc}`);

const binDir = join(ROOT, 'dist-npm/packages', t.subpkg, 'bin');
mkdirSync(binDir, { recursive: true });
copyFileSync(builtBin, join(binDir, t.bin));
chmodSync(join(binDir, t.bin), 0o755);
copyFileSync(vecSrc, join(binDir, t.vec));
console.error(`[build-headless] staged ${t.bin} + ${t.vec} -> dist-npm/packages/${t.subpkg}/bin/`);
