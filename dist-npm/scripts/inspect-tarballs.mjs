#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  LEGAL_FILES,
  LICENSE_BUNDLE_FILES,
  PACKAGES,
  REPO_ROOT,
  verifyReleaseMetadata,
} from './verify-release.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

function safeTarEntries(tarball) {
  const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
  assert(entries.length > 0, `${basename(tarball)} is empty`);
  for (const entry of entries) {
    assert(entry === 'package' || entry.startsWith('package/'), `${basename(tarball)}: unexpected path ${entry}`);
    assert(!entry.split('/').includes('..'), `${basename(tarball)}: unsafe path ${entry}`);
  }
  return entries;
}

function assertRegularNonempty(root, path, packageName) {
  const fullPath = join(root, path);
  assert(existsSync(fullPath), `${packageName}: required file is missing: ${path}`);
  const stat = lstatSync(fullPath);
  assert(stat.isFile(), `${packageName}: ${path} is not a regular file`);
  assert(stat.size > 0, `${packageName}: ${path} is empty`);
  return { fullPath, stat };
}

function packageDefinition(name) {
  const definition = PACKAGES[name];
  assert(definition, `unexpected npm package in tarballs: ${name}`);
  return definition;
}

function nativeLike(path) {
  const name = basename(path);
  return (
    /^neurovault-server(?:\.exe)?$/.test(name) ||
    /^vec0\.(?:dylib|so|dll)$/.test(name) ||
    /\.(?:node|dylib|so|dll)$/.test(name)
  );
}

export function inspectTarballs(artifactDirectory, {
  version,
  manifestPath,
  repoRoot = REPO_ROOT,
} = {}) {
  const metadata = verifyReleaseMetadata({ repoRoot });
  const expectedVersion = version ?? metadata.version;
  assert(expectedVersion === metadata.version, `requested ${expectedVersion}, package metadata is ${metadata.version}`);

  const tarballs = walk(resolve(artifactDirectory)).filter((path) => path.endsWith('.tgz')).sort();
  assert(tarballs.length === Object.keys(PACKAGES).length, `expected 4 tarballs, found ${tarballs.length}`);

  const seen = new Set();
  const results = [];

  for (const tarball of tarballs) {
    safeTarEntries(tarball);
    const extractionRoot = mkdtempSync(join(tmpdir(), 'neurovault-npm-inspect-'));
    try {
      execFileSync('tar', ['-xzf', tarball, '-C', extractionRoot], { stdio: 'pipe' });
      const root = join(extractionRoot, 'package');
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      const definition = packageDefinition(manifest.name);
      assert(!seen.has(manifest.name), `duplicate tarball for ${manifest.name}`);
      seen.add(manifest.name);
      assert(manifest.version === expectedVersion, `${manifest.name}: tarball version ${manifest.version} != ${expectedVersion}`);

      for (const filename of [...LEGAL_FILES, ...LICENSE_BUNDLE_FILES]) {
        const { fullPath } = assertRegularNonempty(root, filename, manifest.name);
        assert(
          readFileSync(fullPath).equals(readFileSync(join(repoRoot, filename))),
          `${manifest.name}: ${filename} is not byte-identical to the repository source`,
        );
      }

      const expectedNative = new Set(definition.nativeFiles);
      for (const path of definition.nativeFiles) {
        const { stat } = assertRegularNonempty(root, path, manifest.name);
        if (path.endsWith('neurovault-server')) {
          assert((stat.mode & 0o111) !== 0, `${manifest.name}: ${path} is not executable`);
        }
      }

      const packagedFiles = walk(root).map((path) => relative(root, path));
      const nativeFiles = packagedFiles.filter(nativeLike);
      assert(
        JSON.stringify(nativeFiles.sort()) === JSON.stringify([...expectedNative].sort()),
        `${manifest.name}: native files are ${nativeFiles.join(', ') || '(none)'}, expected ${[...expectedNative].join(', ') || '(none)'}`,
      );

      if (manifest.name === '@neurovault/mcp') {
        for (const required of [
          'README.md',
          'bin/neurovault-mcp.js',
          'lib/resolve.js',
          'lib/lifecycle.js',
        ]) {
          assertRegularNonempty(root, required, manifest.name);
        }
      }

      const bytes = readFileSync(tarball);
      results.push({
        name: manifest.name,
        version: manifest.version,
        tarball: resolve(tarball),
        integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
        size: bytes.length,
      });
    } finally {
      rmSync(extractionRoot, { recursive: true, force: true });
    }
  }

  for (const packageName of Object.keys(PACKAGES)) {
    assert(seen.has(packageName), `missing tarball for ${packageName}`);
  }

  results.sort((a, b) => {
    if (a.name === '@neurovault/mcp') return 1;
    if (b.name === '@neurovault/mcp') return -1;
    return a.name.localeCompare(b.name);
  });

  if (manifestPath) {
    writeFileSync(resolve(manifestPath), `${JSON.stringify({ version: expectedVersion, packages: results }, null, 2)}\n`);
  }
  return results;
}

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  try {
    const args = process.argv.slice(2);
    const artifactDirectory = args.shift();
    assert(artifactDirectory, 'usage: inspect-tarballs.mjs <artifact-directory> [--version X] [--manifest path]');
    const option = (name) => {
      const index = args.indexOf(name);
      if (index === -1) return undefined;
      assert(index + 1 < args.length, `${name} requires a value`);
      return args[index + 1];
    };
    const result = inspectTarballs(artifactDirectory, {
      version: option('--version'),
      manifestPath: option('--manifest'),
    });
    for (const entry of result) {
      console.log(`[npm-release] inspected ${entry.name}@${entry.version} (${entry.size} bytes)`);
    }
  } catch (error) {
    console.error(`[npm-release] ${error.message}`);
    process.exit(1);
  }
}
