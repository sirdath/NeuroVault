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
//   - the child inherits stdio so the JSON-RPC stream flows untouched.
const { spawnSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { resolveBinary } = require('../lib/resolve');

function die(msg, code) {
  process.stderr.write(msg.endsWith('\n') ? msg : msg + '\n');
  process.exit(code == null ? 1 : code);
}

// macOS floor: the binary bakes a minos of 11.0 (Big Sur). Fail with a clear
// message instead of a cryptic dyld abort on older systems. Darwin kernel 20 =
// macOS 11.
if (process.platform === 'darwin') {
  const major = parseInt(String(os.release()).split('.')[0] || '0', 10);
  if (major && major < 20) {
    die('NeuroVault requires macOS 11 (Big Sur) or newer.');
  }
}

let binPath;
try {
  ({ binPath } = resolveBinary());
} catch (err) {
  let msg = err.message;
  if (err.code === 'MISSING_PACKAGE') {
    msg += `\nThe optional platform package did not install. Try:\n  npm install ${err.pkg}`;
  } else if (err.code === 'UNSUPPORTED_PLATFORM') {
    msg += '\nNeuroVault currently ships prebuilt binaries for macOS (arm64, x64).';
  }
  die(msg);
}

// The embedder + reranker cache the on-device ONNX models under
// ~/.neurovault/.fastembed_cache. Export it as a belt (the binary also resolves
// this from its home dir) and tell the user about the one-time first-run
// download — on STDERR, so the MCP channel stays clean.
const cacheDir = path.join(os.homedir(), '.neurovault', '.fastembed_cache');
const modelDir = path.join(cacheDir, 'models--Xenova--bge-small-en-v1.5');
if (!fs.existsSync(modelDir)) {
  process.stderr.write(
    'NeuroVault: first recall downloads the on-device embedding model (~130 MB) ' +
      'to ~/.neurovault/.fastembed_cache. This happens once.\n',
  );
}

const argv = process.argv.slice(2);
const args = argv.length ? argv : ['--mcp-only'];

const res = spawnSync(binPath, args, {
  stdio: 'inherit',
  env: { ...process.env, FASTEMBED_CACHE_DIR: cacheDir },
});
if (res.error) {
  die(`NeuroVault: failed to launch ${binPath}: ${res.error.message}`);
}
process.exit(res.status == null ? 1 : res.status);
