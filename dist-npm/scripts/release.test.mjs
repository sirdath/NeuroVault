import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';

import { inspectTarballs } from './inspect-tarballs.mjs';
import { stageLegal } from './stage-legal.mjs';
import {
  expectedTag,
  LEGAL_FILES,
  LICENSE_BUNDLE_FILES,
  PACKAGES,
  REPO_ROOT,
  verifyReleaseMetadata,
} from './verify-release.mjs';
import {
  assertLatestPromotionAllowed,
  compareSemver,
  validatePublishContext,
} from './publish-release.mjs';

const require = createRequire(import.meta.url);
const lifecycle = require('../lib/lifecycle.js');

test('npm package versions, pins, legal files and Node floor are aligned', () => {
  const metadata = verifyReleaseMetadata();
  assert.equal(metadata.tag, expectedTag(metadata.version));
  assert.equal(metadata.packageNames.length, 4);
});

test('an npm release tag must exactly match package metadata', () => {
  assert.throws(
    () => verifyReleaseMetadata({ tag: 'npm-v999.0.0' }),
    /must equal npm-v/,
  );
});

test('the first npm release cannot drift from the desktop product version', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'neurovault-npm-version-test-'));
  const npmVersion = JSON.parse(readFileSync(join(REPO_ROOT, 'dist-npm/package.json'), 'utf8')).version;
  const driftVersion = npmVersion === '9.9.9' ? '9.9.8' : '9.9.9';
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'dist-npm'), { recursive: true });
  mkdirSync(join(root, 'src-tauri'), { recursive: true });
  copyFileSync(join(REPO_ROOT, 'dist-npm/package.json'), join(root, 'dist-npm/package.json'));
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ version: driftVersion })}\n`);
  writeFileSync(
    join(root, 'package-lock.json'),
    `${JSON.stringify({ version: driftVersion, packages: { '': { version: driftVersion } } })}\n`,
  );
  writeFileSync(join(root, 'src-tauri/Cargo.toml'), `[package]\nversion = "${driftVersion}"\n`);
  writeFileSync(join(root, 'src-tauri/tauri.conf.json'), `${JSON.stringify({ version: driftVersion })}\n`);

  assert.throws(
    () => verifyReleaseMetadata({ repoRoot: root }),
    new RegExp(`root package\\.json version ${driftVersion} does not match @neurovault/mcp ${npmVersion}`),
  );
});

test('lifecycle ownership requires both the live pid and per-process identity', () => {
  const marker = { pid: 42, instance_id: 'alpha' };
  assert.equal(lifecycle.markerOwns(marker, { pid: 42, instance_id: 'alpha' }), true);
  assert.equal(lifecycle.markerOwns(marker, { pid: 42, instance_id: 'beta' }), false);
  assert.equal(lifecycle.markerOwns(marker, { pid: 7, instance_id: 'alpha' }), false);
});

test('lifecycle stop accepts exact loopback endpoints only', async () => {
  assert.equal(
    lifecycle.isLoopbackEndpoint({ NEUROVAULT_API_URL: 'http://127.0.0.1:8765' }),
    true,
  );
  assert.equal(
    lifecycle.isLoopbackEndpoint({ NEUROVAULT_API_URL: 'http://localhost:8765' }),
    true,
  );
  assert.equal(
    lifecycle.isLoopbackEndpoint({ NEUROVAULT_API_URL: 'http://localhost.example.com:8765' }),
    false,
  );
  await assert.rejects(
    () => lifecycle.stop({ NEUROVAULT_API_URL: 'https://memory.example.com' }),
    (error) => error.code === 'REMOTE_ENDPOINT',
  );
});

test('config command prints a stable absolute-path MCP entry without resolving a binary', () => {
  const launcher = join(REPO_ROOT, 'dist-npm/bin/neurovault-mcp.js');
  const output = execFileSync(process.execPath, [launcher, 'config'], { encoding: 'utf8' });
  const config = JSON.parse(output);
  assert.equal(config.mcpServers.neurovault.command, process.execPath);
  assert.deepEqual(config.mcpServers.neurovault.args, [launcher]);
});

test('status recognizes an npm-managed backend and stop refuses a foreign one', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'neurovault-lifecycle-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const identity = { version: '0.6.0', pid: process.pid, instance_id: 'test-instance' };
  const server = createServer((request, response) => {
    if (request.url === '/api/version') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(identity));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  const env = {
    NEUROVAULT_HOME: root,
    NEUROVAULT_API_URL: `http://127.0.0.1:${address.port}`,
  };

  writeFileSync(
    join(root, 'managed-backend.json'),
    JSON.stringify({
      schema_version: 1,
      managed_by: '@neurovault/mcp',
      port: address.port,
      ...identity,
    }),
  );
  const owned = await lifecycle.status(env);
  assert.equal(owned.running, true);
  assert.equal(owned.managed, true);

  writeFileSync(
    join(root, 'managed-backend.json'),
    JSON.stringify({
      schema_version: 1,
      managed_by: '@neurovault/mcp',
      port: address.port,
      ...identity,
      instance_id: 'different-process',
    }),
  );
  const foreign = await lifecycle.status(env);
  assert.equal(foreign.running, true);
  assert.equal(foreign.managed, false);
  await assert.rejects(() => lifecycle.stop(env), (error) => error.code === 'NOT_MANAGED');
});

test('legal staging copies the canonical files byte-for-byte', () => {
  const root = mkdtempSync(join(tmpdir(), 'neurovault-npm-stage-test-'));
  const npmRoot = join(root, 'dist-npm');
  const target = join(npmRoot, 'package-under-test');
  mkdirSync(target, { recursive: true });
  for (const filename of [...LEGAL_FILES, ...LICENSE_BUNDLE_FILES]) {
    mkdirSync(join(root, filename, '..'), { recursive: true });
    writeFileSync(join(root, filename), `${filename} canonical\n`);
  }

  stageLegal(target, { repoRoot: root, npmRoot });
  for (const filename of [...LEGAL_FILES, ...LICENSE_BUNDLE_FILES]) {
    assert.deepEqual(readFileSync(join(target, filename)), readFileSync(join(root, filename)));
  }
});

test('publisher refuses local or non-tag execution before contacting npm', () => {
  const metadata = verifyReleaseMetadata();
  const manifest = {
    version: metadata.version,
    packages: [
      { name: '@neurovault/mcp-darwin-arm64' },
      { name: '@neurovault/mcp-linux-x64' },
      { name: '@neurovault/mcp-win32-x64' },
      { name: '@neurovault/mcp' },
    ],
  };
  assert.throws(
    () => validatePublishContext({ manifest, env: { GITHUB_REF_NAME: metadata.tag } }),
    /outside GitHub Actions/,
  );
});

test('publisher accepts only the complete inspected set with root last', () => {
  const metadata = verifyReleaseMetadata();
  const packages = [
    '@neurovault/mcp-darwin-arm64',
    '@neurovault/mcp-linux-x64',
    '@neurovault/mcp-win32-x64',
    '@neurovault/mcp',
  ].map((name) => ({
    name,
    version: metadata.version,
    tarball: `/tmp/${name.replaceAll('/', '-')}.tgz`,
    integrity: 'sha512-Zml4dHVyZQ==',
  }));
  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REF_TYPE: 'tag',
    GITHUB_REF_NAME: metadata.tag,
    NODE_AUTH_TOKEN: 'test-only',
  };
  assert.deepEqual(
    validatePublishContext({ manifest: { version: metadata.version, packages }, env }),
    { version: metadata.version, stagingTag: `staging-${metadata.version.replaceAll('.', '-')}` },
  );
  assert.throws(
    () => validatePublishContext({ manifest: { version: metadata.version, packages: [...packages].reverse() }, env }),
    /root package must be promoted last/,
  );
});

test('npm latest ordering follows SemVer, including prereleases', () => {
  assert.equal(compareSemver('1.0.0', '1.0.0-rc.99'), 1);
  assert.equal(compareSemver('1.0.0-beta.11', '1.0.0-beta.2'), 1);
  assert.equal(compareSemver('1.0.0-beta', '1.0.0-beta.0'), -1);
  assert.equal(compareSemver('1.1.0-rc.1', '1.0.99'), 1);
  assert.equal(compareSemver('2.0.0+build.2', '2.0.0+build.1'), 0);
  assert.throws(() => compareSemver('1.0.0-01', '1.0.0'), /invalid semantic version/);
});

test('latest guard accepts first publication and coherent partial retries', () => {
  const packageNames = Object.keys(PACKAGES);
  const firstPublication = Object.fromEntries(packageNames.map((name) => [name, null]));
  assert.deepEqual(
    assertLatestPromotionAllowed({ version: '1.0.0', packageNames, latestByPackage: firstPublication, env: {} }),
    { emergencyOverride: false, downgrades: [] },
  );

  const partialRetry = {
    '@neurovault/mcp': '0.9.0',
    '@neurovault/mcp-darwin-arm64': '1.0.0',
    '@neurovault/mcp-linux-x64': '0.9.0',
    '@neurovault/mcp-win32-x64': null,
  };
  assert.deepEqual(
    assertLatestPromotionAllowed({ version: '1.0.0', packageNames, latestByPackage: partialRetry, env: {} }),
    { emergencyOverride: false, downgrades: [] },
  );
});

test('latest guard checks all four packages and fails closed on a downgrade', () => {
  const packageNames = Object.keys(PACKAGES);
  const latestByPackage = Object.fromEntries(packageNames.map((name) => [name, '1.0.0']));
  latestByPackage['@neurovault/mcp-win32-x64'] = '1.1.0-rc.1';
  assert.throws(
    () => assertLatestPromotionAllowed({ version: '1.0.1', packageNames, latestByPackage, env: {} }),
    /refusing to move npm latest backwards: @neurovault\/mcp-win32-x64 is 1\.1\.0-rc\.1/,
  );
  assert.throws(
    () => assertLatestPromotionAllowed({
      version: '1.0.1',
      packageNames: packageNames.slice(1),
      latestByPackage,
      env: {},
    }),
    /complete four-package release set/,
  );
});

test('emergency downgrade override is exact, tag-bound and visible', () => {
  const version = '1.0.0-rc.1';
  const tag = expectedTag(version);
  const packageNames = Object.keys(PACKAGES);
  const latestByPackage = Object.fromEntries(packageNames.map((name) => [name, '1.0.0']));
  const variable = 'NEUROVAULT_NPM_EMERGENCY_LATEST_OVERRIDE';

  assert.throws(
    () => assertLatestPromotionAllowed({
      version,
      packageNames,
      latestByPackage,
      env: { [variable]: `allow-latest-downgrade:${tag}` },
    }),
    /only in the exact GitHub tag run/,
  );
  assert.throws(
    () => assertLatestPromotionAllowed({
      version,
      packageNames,
      latestByPackage,
      env: {
        GITHUB_ACTIONS: 'true',
        GITHUB_REF_TYPE: 'tag',
        GITHUB_REF_NAME: tag,
        [variable]: 'yes',
      },
    }),
    new RegExp(`${variable}=allow-latest-downgrade:${tag.replaceAll('.', '\\.')}`),
  );

  const warnings = [];
  const result = assertLatestPromotionAllowed({
    version,
    packageNames,
    latestByPackage,
    env: {
      GITHUB_ACTIONS: 'true',
      GITHUB_REF_TYPE: 'tag',
      GITHUB_REF_NAME: tag,
      [variable]: `allow-latest-downgrade:${tag}`,
    },
    logger: { warn: (message) => warnings.push(message) },
  });
  assert.equal(result.emergencyOverride, true);
  assert.equal(result.downgrades.length, 4);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /::warning title=Emergency npm latest downgrade::/);
  assert.match(warnings[0], /1\.0\.0 -> 1\.0\.0-rc\.1/);
});

test('an exact emergency token becomes harmless after the downgrade is repaired', () => {
  const version = '1.0.0';
  const tag = expectedTag(version);
  const packageNames = Object.keys(PACKAGES);
  const latestByPackage = Object.fromEntries(packageNames.map((name) => [name, '0.9.0']));
  assert.deepEqual(
    assertLatestPromotionAllowed({
      version,
      packageNames,
      latestByPackage,
      env: {
        GITHUB_ACTIONS: 'true',
        GITHUB_REF_TYPE: 'tag',
        GITHUB_REF_NAME: tag,
        NEUROVAULT_NPM_EMERGENCY_LATEST_OVERRIDE: `allow-latest-downgrade:${tag}`,
      },
    }),
    { emergencyOverride: false, downgrades: [] },
  );
  assert.throws(
    () => assertLatestPromotionAllowed({
      version,
      packageNames,
      latestByPackage,
      env: { NEUROVAULT_NPM_EMERGENCY_LATEST_OVERRIDE: 'stale-token' },
    }),
    /must equal allow-latest-downgrade:npm-v1\.0\.0/,
  );
});

function buildFixtureTarballs(root) {
  const artifacts = join(root, 'artifacts');
  const fixture = join(root, 'fixture');
  mkdirSync(artifacts, { recursive: true });

  const createTarball = (name, { omit } = {}) => {
    rmSync(fixture, { recursive: true, force: true });
    const packageRoot = join(fixture, 'package');
    mkdirSync(packageRoot, { recursive: true });
    copyFileSync(join(PACKAGES[name].directory, 'package.json'), join(packageRoot, 'package.json'));
    for (const legalFile of [...LEGAL_FILES, ...LICENSE_BUNDLE_FILES]) {
      mkdirSync(join(packageRoot, legalFile, '..'), { recursive: true });
      copyFileSync(join(REPO_ROOT, legalFile), join(packageRoot, legalFile));
    }

    if (name === '@neurovault/mcp') {
      mkdirSync(join(packageRoot, 'bin'), { recursive: true });
      mkdirSync(join(packageRoot, 'lib'), { recursive: true });
      for (const file of [
        'README.md',
        'bin/neurovault-mcp.js',
        'lib/resolve.js',
        'lib/lifecycle.js',
      ]) {
        copyFileSync(join(PACKAGES[name].directory, file), join(packageRoot, file));
      }
    }
    for (const file of PACKAGES[name].nativeFiles) {
      if (file === omit) continue;
      mkdirSync(join(packageRoot, file, '..'), { recursive: true });
      writeFileSync(join(packageRoot, file), `fixture for ${name} ${file}\n`);
      if (file.endsWith('neurovault-server')) chmodSync(join(packageRoot, file), 0o755);
    }

    const packed = JSON.parse(execFileSync(
      'npm',
      ['pack', packageRoot, '--pack-destination', artifacts, '--json'],
      {
        encoding: 'utf8',
        env: { ...process.env, NPM_CONFIG_CACHE: join(root, 'npm-cache') },
      },
    ));
    assert.equal(packed.length, 1);
    return join(artifacts, packed[0].filename);
  };

  for (const name of Object.keys(PACKAGES)) createTarball(name);
  return { artifacts, createTarball };
}

test('tarball inspector accepts one complete, legally attributed package per target', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'neurovault-npm-tarballs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { artifacts } = buildFixtureTarballs(root);
  const inspected = inspectTarballs(artifacts);
  assert.equal(inspected.length, 4);
  assert.equal(inspected.at(-1).name, '@neurovault/mcp');
});

test('tarball inspector fails closed when a native extension is omitted', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'neurovault-npm-tarballs-missing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { artifacts, createTarball } = buildFixtureTarballs(root);
  createTarball('@neurovault/mcp-linux-x64', { omit: 'bin/vec0.so' });
  assert.throws(() => inspectTarballs(artifacts), /required file is missing: bin\/vec0\.so/);
});
