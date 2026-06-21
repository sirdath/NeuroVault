'use strict';
// Maps the running platform to the per-platform npm subpackage that ships the
// prebuilt `neurovault-server` binary + its `vec0` sqlite extension side by
// side. The subpackages are installed by npm itself (via the root package's
// optionalDependencies, gated by each subpackage's own `os`/`cpu` fields), so
// resolution survives `--ignore-scripts` — there is no postinstall download.
//
// Ships macOS (arm64 + x64), Linux x64 **glibc**, and Windows x64. Linux
// **musl** (Alpine) is not shipped: npm's os/cpu fields cannot distinguish
// glibc from musl, and a glibc binary + glibc-built vec0.so will not run on
// musl — so we detect libc at runtime and fail with a clear message rather than
// hand a musl user a binary that segfaults.
const PLATFORM_PACKAGES = {
  'darwin-arm64': '@neurovault/mcp-darwin-arm64',
  'darwin-x64': '@neurovault/mcp-darwin-x64',
  'linux-x64': '@neurovault/mcp-linux-x64',
  'win32-x64': '@neurovault/mcp-win32-x64',
};

function binName() {
  return process.platform === 'win32' ? 'neurovault-server.exe' : 'neurovault-server';
}

// True on a musl libc (Alpine etc.). glibc builds expose `glibcVersionRuntime`
// in the Node process report header; musl does not. Uses only built-in Node —
// no detect-libc dependency.
function isMuslLinux() {
  if (process.platform !== 'linux') return false;
  try {
    const header = process.report.getReport().header;
    return !header.glibcVersionRuntime;
  } catch (_e) {
    return false; // can't tell → assume glibc and let the loader speak
  }
}

// Resolve the absolute path to the platform binary, or throw a typed error the
// shim turns into a clear, actionable stderr message.
function resolveBinary() {
  const key = `${process.platform}-${process.arch}`;
  if (isMuslLinux()) {
    const e = new Error(
      'NeuroVault: musl libc (e.g. Alpine) is not supported yet — only glibc Linux x64. ' +
        'Use a glibc-based image (debian/ubuntu) or the desktop app.',
    );
    e.code = 'UNSUPPORTED_LIBC';
    e.key = key;
    throw e;
  }
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

module.exports = { resolveBinary, PLATFORM_PACKAGES, binName, isMuslLinux };
