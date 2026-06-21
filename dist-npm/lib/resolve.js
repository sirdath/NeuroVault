'use strict';
// Maps the running platform to the per-platform npm subpackage that ships the
// prebuilt `neurovault-server` binary + its `vec0` sqlite extension side by
// side. The subpackages are installed by npm itself (via the root package's
// optionalDependencies, gated by each subpackage's own `os`/`cpu` fields), so
// resolution survives `--ignore-scripts` — there is no postinstall download.
//
// v0 ships macOS only. Linux/Windows subpackages are added once the headless
// binary is decoupled from the Tauri GUI stack (the `gui` cargo feature) and
// a per-libc `vec0.so` is built — until then they would be dead on arrival on
// a headless box, so we deliberately do not advertise them.
const PLATFORM_PACKAGES = {
  'darwin-arm64': '@neurovault/mcp-darwin-arm64',
  'darwin-x64': '@neurovault/mcp-darwin-x64',
  // 'linux-x64':  '@neurovault/mcp-linux-x64',   // after gui-feature gate + vec0.so
  // 'win32-x64':  '@neurovault/mcp-win32-x64',
};

function binName() {
  return process.platform === 'win32' ? 'neurovault-server.exe' : 'neurovault-server';
}

// Resolve the absolute path to the platform binary, or throw a typed error the
// shim turns into a clear, actionable stderr message.
function resolveBinary() {
  const key = `${process.platform}-${process.arch}`;
  const pkg = PLATFORM_PACKAGES[key];
  if (!pkg) {
    const e = new Error(`NeuroVault: no prebuilt binary for platform "${key}".`);
    e.code = 'UNSUPPORTED_PLATFORM';
    e.key = key;
    throw e;
  }
  try {
    // require.resolve finds the binary inside the npm-installed subpackage,
    // wherever npm placed it (local, global, or npx cache).
    const binPath = require.resolve(`${pkg}/bin/${binName()}`);
    return { pkg, key, binPath };
  } catch (_err) {
    const e = new Error(`NeuroVault: platform package "${pkg}" is not installed.`);
    e.code = 'MISSING_PACKAGE';
    e.key = key;
    e.pkg = pkg;
    throw e;
  }
}

module.exports = { resolveBinary, PLATFORM_PACKAGES, binName };
