#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SCRIPT_DIR, '../..');
export const NPM_ROOT = join(REPO_ROOT, 'dist-npm');

export const PACKAGES = Object.freeze({
  '@neurovault/mcp': {
    directory: NPM_ROOT,
    nativeFiles: [],
  },
  '@neurovault/mcp-darwin-arm64': {
    directory: join(NPM_ROOT, 'packages/mcp-darwin-arm64'),
    nativeFiles: ['bin/neurovault-server', 'bin/vec0.dylib'],
  },
  '@neurovault/mcp-linux-x64': {
    directory: join(NPM_ROOT, 'packages/mcp-linux-x64'),
    nativeFiles: ['bin/neurovault-server', 'bin/vec0.so'],
  },
  '@neurovault/mcp-win32-x64': {
    directory: join(NPM_ROOT, 'packages/mcp-win32-x64'),
    nativeFiles: ['bin/neurovault-server.exe', 'bin/vec0.dll'],
  },
});

export const LEGAL_FILES = Object.freeze([
  'LICENSE',
  'PRIVACY.md',
  'THIRD-PARTY-NOTICES.md',
]);
export const LICENSE_BUNDLE_FILES = Object.freeze([
  'LICENSES/MPL-2.0-COVERED-SOURCE.md',
  'LICENSES/NATIVE-NOTICE-SOURCES.json',
  'LICENSES/THIRD-PARTY-LICENSES.txt',
  'LICENSES/models/DOWNLOADED-MODELS.md',
  'LICENSES/native/bge-small-en-v1.5-LICENSE-MIT',
  'LICENSES/native/onnxruntime-1.20.0-LICENSE',
  'LICENSES/native/onnxruntime-1.20.0-ThirdPartyNotices.txt',
  'LICENSES/native/sqlite-vec-v0.1.9-LICENSE-APACHE',
  'LICENSES/native/sqlite-vec-v0.1.9-LICENSE-MIT',
]);
export const PACKAGE_LEGAL_ENTRIES = Object.freeze([...LEGAL_FILES, 'LICENSES/']);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function cargoPackageVersion(toml) {
  const packageStart = toml.indexOf('[package]');
  assert(packageStart >= 0, 'src-tauri/Cargo.toml has no [package] section');
  const afterHeader = toml.slice(packageStart + '[package]'.length);
  const nextSection = afterHeader.search(/^\[/m);
  const packageSection = nextSection >= 0 ? afterHeader.slice(0, nextSection) : afterHeader;
  const version = packageSection.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  assert(version, 'src-tauri/Cargo.toml has no [package] version');
  return version;
}

export function expectedTag(version) {
  return `npm-v${version}`;
}

export function verifyReleaseMetadata({ tag, repoRoot = REPO_ROOT } = {}) {
  const npmRoot = join(repoRoot, 'dist-npm');
  const packageDefinitions = {
    '@neurovault/mcp': {
      directory: npmRoot,
      nativeFiles: [],
    },
    '@neurovault/mcp-darwin-arm64': {
      directory: join(npmRoot, 'packages/mcp-darwin-arm64'),
      nativeFiles: ['bin/neurovault-server', 'bin/vec0.dylib'],
    },
    '@neurovault/mcp-linux-x64': {
      directory: join(npmRoot, 'packages/mcp-linux-x64'),
      nativeFiles: ['bin/neurovault-server', 'bin/vec0.so'],
    },
    '@neurovault/mcp-win32-x64': {
      directory: join(npmRoot, 'packages/mcp-win32-x64'),
      nativeFiles: ['bin/neurovault-server.exe', 'bin/vec0.dll'],
    },
  };

  const rootManifest = readJson(join(npmRoot, 'package.json'));
  const version = rootManifest.version;
  assert(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version), `invalid npm version: ${version}`);
  assert(rootManifest.name === '@neurovault/mcp', 'root package name must be @neurovault/mcp');
  assert(rootManifest.engines?.node === '>=22', 'root package must require Node >=22');

  const desktopManifest = readJson(join(repoRoot, 'package.json'));
  const desktopLock = readJson(join(repoRoot, 'package-lock.json'));
  const tauriConfig = readJson(join(repoRoot, 'src-tauri/tauri.conf.json'));
  const cargoVersion = cargoPackageVersion(
    readFileSync(join(repoRoot, 'src-tauri/Cargo.toml'), 'utf8'),
  );
  const versionSources = {
    'root package.json': desktopManifest.version,
    'root package-lock.json': desktopLock.version,
    'root package-lock.json packages[""]': desktopLock.packages?.['']?.version,
    'src-tauri/Cargo.toml': cargoVersion,
    'src-tauri/tauri.conf.json': tauriConfig.version,
  };
  for (const [source, declaredVersion] of Object.entries(versionSources)) {
    assert(
      declaredVersion === version,
      `${source} version ${declaredVersion ?? '(missing)'} does not match @neurovault/mcp ${version}`,
    );
  }

  const expectedOptionalDependencies = Object.keys(packageDefinitions)
    .filter((name) => name !== rootManifest.name)
    .sort();
  const actualOptionalDependencies = Object.keys(rootManifest.optionalDependencies ?? {}).sort();
  assert(
    JSON.stringify(actualOptionalDependencies) === JSON.stringify(expectedOptionalDependencies),
    `optionalDependencies must be exactly: ${expectedOptionalDependencies.join(', ')}`,
  );

  for (const [name, definition] of Object.entries(packageDefinitions)) {
    const manifest = readJson(join(definition.directory, 'package.json'));
    assert(manifest.name === name, `${definition.directory}: package name must be ${name}`);
    assert(manifest.version === version, `${name}: version ${manifest.version} does not match ${version}`);
    assert(manifest.license === 'MIT', `${name}: license must be MIT`);

    const files = new Set(manifest.files ?? []);
    for (const file of [...definition.nativeFiles, ...PACKAGE_LEGAL_ENTRIES]) {
      assert(files.has(file), `${name}: package files omit ${file}`);
    }

    if (name !== rootManifest.name) {
      assert(
        rootManifest.optionalDependencies[name] === version,
        `${name}: optional dependency must be pinned exactly to ${version}`,
      );
    }
  }

  if (tag !== undefined) {
    assert(tag === expectedTag(version), `release tag ${tag || '(empty)'} must equal ${expectedTag(version)}`);
  }

  for (const legalFile of [...LEGAL_FILES, ...LICENSE_BUNDLE_FILES]) {
    const content = readFileSync(join(repoRoot, legalFile));
    assert(content.length > 0, `${legalFile} is missing or empty`);
  }

  return { version, tag: expectedTag(version), packageNames: Object.keys(packageDefinitions) };
}

function cliTag(argv, env) {
  const index = argv.indexOf('--tag');
  if (index !== -1) {
    assert(index + 1 < argv.length, '--tag requires a value');
    return argv[index + 1];
  }
  if (env.GITHUB_REF_TYPE === 'tag' || env.GITHUB_REF?.startsWith('refs/tags/')) {
    return env.GITHUB_REF_NAME || env.GITHUB_REF?.replace(/^refs\/tags\//, '');
  }
  return undefined;
}

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  try {
    const result = verifyReleaseMetadata({ tag: cliTag(process.argv.slice(2), process.env) });
    console.log(`[npm-release] metadata ready: ${result.tag} (${result.packageNames.length} packages)`);
  } catch (error) {
    console.error(`[npm-release] ${error.message}`);
    process.exit(1);
  }
}
