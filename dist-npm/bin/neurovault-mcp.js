#!/usr/bin/env node
'use strict';
// `neurovault-mcp` — the headless NeuroVault entry point a developer wires into
// an MCP client (Claude Code / Cursor / Codex). With no arguments it launches
// the native `neurovault-server --mcp-only` stdio MCP bridge, which auto-starts
// a headless backend on 127.0.0.1:8765 if none is already running.
//
// CONTRACT (do not break):
//   - stdout is the MCP JSON-RPC channel. This shim must NEVER write to stdout.
//     All notices/errors go to stderr.
//   - empty argv defaults to `--mcp-only` (the MCP-client path). Any explicit
//     args (--port N, --http-only, --help) are passed straight through.
//   - the child inherits stdio so the JSON-RPC stream flows untouched, and we
//     forward exit code + termination signals (this is a thin launcher, not a
//     proxy — we never sit in the data path).
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { resolveBinary } = require('../lib/resolve');
const lifecycle = require('../lib/lifecycle');

function die(msg, code) {
  process.stderr.write(msg.endsWith('\n') ? msg : msg + '\n');
  process.exit(code == null ? 1 : code);
}

async function runLifecycleCommand(command) {
  try {
    if (command === 'status') {
      const result = await lifecycle.status();
      if (!result.running) {
        process.stdout.write(`NeuroVault backend: stopped (${result.endpoint})\n`);
        return;
      }
      process.stdout.write(
        `NeuroVault backend: running v${result.version} (pid ${result.pid})\n` +
          `Endpoint: ${result.endpoint}\n` +
          `Managed by @neurovault/mcp: ${result.managed ? 'yes' : 'no'}\n`,
      );
      return;
    }
    const result = await lifecycle.stop();
    process.stdout.write(
      result.alreadyStopped
        ? `NeuroVault backend: already stopped (${result.endpoint})\n`
        : `NeuroVault backend: stopped pid ${result.pid}\n`,
    );
  } catch (error) {
    die(`NeuroVault: ${command} failed: ${error.message}`);
  }
}

function printStableClientConfig() {
  const config = {
    mcpServers: {
      neurovault: {
        command: process.execPath,
        args: [path.resolve(__filename)],
      },
    },
  };
  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
}

const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === 'config') {
  printStableClientConfig();
  return;
}
if (argv.length === 1 && ['status', 'stop'].includes(argv[0])) {
  runLifecycleCommand(argv[0]);
  return;
}

// macOS floor: 14.0 (Sonoma). The server binary itself bakes a minos of 11.0,
// but that is NOT the binding constraint — the bundled `vec0` sqlite extension
// is built with `minos 14.0` (verify: `xcrun vtool -show-build vec0.dylib`) and
// is dlopen'd on EVERY brain open. So on macOS 11-13 the process starts happily
// and then fails to open any database at all.
//
// Check the REAL floor here, or the user gets a cryptic extension-load error at
// their first recall instead of a sentence telling them what is wrong.
// Darwin kernel 23 = macOS 14.
if (process.platform === 'darwin') {
  const major = parseInt(String(os.release()).split('.')[0] || '0', 10);
  if (major && major < 23) {
    die(
      'NeuroVault requires macOS 14 (Sonoma) or newer.\n' +
        'The bundled sqlite-vec extension is built for macOS 14+; on older ' +
        'systems the server starts but cannot open any brain database.',
    );
  }
}

let binPath;
try {
  ({ binPath } = resolveBinary());
} catch (err) {
  let msg = err.message;
  if (err.code === 'MISSING_PACKAGE') {
    msg +=
      `\nThe optional platform package did not install (a known npm lockfile bug can drop it).` +
      `\nFix: remove package-lock.json + node_modules and reinstall, or: npm install ${err.pkg}`;
  } else if (err.code === 'UNSUPPORTED_PLATFORM') {
    msg +=
        '\nNeuroVault ships prebuilt binaries for macOS 14+ (Apple Silicon), ' +
        'Linux x64 (glibc), and Windows x64.';
  }
  die(msg);
}

// npm/pnpm can drop the execute bit on non-`bin` files during extract (the
// binary is a `files` entry, not a declared bin). Restore it defensively on
// Unix so a fresh install always runs. Best-effort: a read-only store throws,
// and the binary is usually already +x.
if (process.platform !== 'win32') {
  try {
    fs.chmodSync(binPath, 0o755);
  } catch (_e) {
    /* ignore — already executable, or store is read-only */
  }
}

// Respect the same data-root and cache overrides as the native server. Notices
// go to STDERR so the MCP JSON-RPC channel on stdout stays clean.
const nvHome =
  process.env.NEUROVAULT_HOME ||
  process.env.ENGRAM_HOME ||
  path.join(os.homedir(), '.neurovault');
const cacheDir =
  process.env.FASTEMBED_CACHE_DIR || path.join(nvHome, '.fastembed_cache');
const modelDir = path.join(cacheDir, 'models--Xenova--bge-small-en-v1.5');
if (!fs.existsSync(modelDir)) {
  process.stderr.write(
    'NeuroVault: first recall downloads the on-device embedding model (~130 MB) ' +
      `to ${cacheDir}. This happens once.\n`,
  );
}

const rerankPreference = path.join(nvHome, 'rerank.txt');
let rerankingEnabled = true;
try {
  rerankingEnabled = !['off', 'false', '0'].includes(
    fs.readFileSync(rerankPreference, 'utf8').trim().toLowerCase(),
  );
} catch (_e) {
  // Missing preference is the shipped ON default.
}
const rerankerDir = path.join(cacheDir, 'models--BAAI--bge-reranker-base');
if (rerankingEnabled && !fs.existsSync(rerankerDir)) {
  process.stderr.write(
    'NeuroVault: reranking is enabled by default. The first qualifying ' +
      'reranked recall may download an additional model (~1 GB) and retain ' +
      'about 1 GB of memory while the server runs. To opt out, write "off" ' +
      `to ${rerankPreference} before recall.\n`,
  );
}

const args = argv.length ? argv : ['--mcp-only'];

// Async spawn (not spawnSync): keep the event loop free, get crash detection,
// and forward signals. stdio:'inherit' wires the child's stdin/stdout straight
// to ours, so the JSON-RPC stream is untouched and we never buffer it.
const child = spawn(binPath, args, {
  stdio: 'inherit',
  env: { ...process.env, FASTEMBED_CACHE_DIR: cacheDir },
});

child.on('error', (e) => die(`NeuroVault: failed to launch ${binPath}: ${e.message}`));

// Forward termination so an MCP client stopping us also stops the server.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  try {
    process.on(sig, () => {
      try {
        child.kill(sig);
      } catch (_e) {
        /* child already gone */
      }
    });
  } catch (_e) {
    /* signal not supported on this platform */
  }
}

child.on('exit', (code, signal) => {
  if (signal) {
    // Re-raise the signal so our exit status reflects how the child died.
    try {
      process.kill(process.pid, signal);
      return;
    } catch (_e) {
      process.exit(1);
    }
  }
  process.exit(code == null ? 0 : code);
});
