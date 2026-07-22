#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedTag, PACKAGES, verifyReleaseMetadata } from './verify-release.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function npm(args, options = {}) {
  return execFileSync('npm', args, {
    encoding: options.encoding ?? 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
}

function registryIntegrity(name, version) {
  try {
    const output = npm(['view', `${name}@${version}`, 'dist.integrity', '--json']).trim();
    if (!output || output === 'null') return null;
    return JSON.parse(output);
  } catch (error) {
    const detail = `${error.stderr ?? ''}\n${error.stdout ?? ''}`;
    if (/E404|404 Not Found|is not in this registry/i.test(detail)) return null;
    throw new Error(`could not query ${name}@${version}: ${detail.trim() || error.message}`);
  }
}

function latestVersion(name) {
  try {
    const output = npm(['view', name, 'dist-tags.latest', '--json']).trim();
    return output && output !== 'null' ? JSON.parse(output) : null;
  } catch (error) {
    const detail = `${error.stderr ?? ''}\n${error.stdout ?? ''}`;
    if (/E404|404 Not Found|is not in this registry/i.test(detail)) return null;
    throw new Error(`could not verify latest tag for ${name}: ${detail.trim() || error.message}`);
  }
}

function parseSemver(version) {
  assert(typeof version === 'string', `invalid semantic version: ${String(version)}`);
  const match = version.match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );
  assert(match, `invalid semantic version: ${version}`);
  const prerelease = match[4]?.split('.') ?? [];
  for (const identifier of prerelease) {
    assert(!/^\d+$/.test(identifier) || /^(0|[1-9]\d*)$/.test(identifier), `invalid semantic version: ${version}`);
  }
  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease,
  };
}

export function compareSemver(leftVersion, rightVersion) {
  const left = parseSemver(leftVersion);
  const right = parseSemver(rightVersion);
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === undefined ? -1 : 1;
    }
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return BigInt(leftIdentifier) < BigInt(rightIdentifier) ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

const EMERGENCY_OVERRIDE_ENV = 'NEUROVAULT_NPM_EMERGENCY_LATEST_OVERRIDE';

export function assertLatestPromotionAllowed({
  version,
  packageNames,
  latestByPackage,
  env = process.env,
  logger = console,
}) {
  parseSemver(version);
  assert(Array.isArray(packageNames), 'latest guard requires a package list');
  assert(
    packageNames.length === Object.keys(PACKAGES).length
      && new Set(packageNames).size === Object.keys(PACKAGES).length
      && packageNames.every((name) => Object.hasOwn(PACKAGES, name)),
    'latest guard requires the complete four-package release set',
  );
  assert(latestByPackage && typeof latestByPackage === 'object', 'latest guard requires a registry snapshot');

  const downgrades = [];
  for (const name of packageNames) {
    assert(Object.hasOwn(latestByPackage, name), `${name}: latest guard has no registry result`);
    const current = latestByPackage[name];
    assert(current === null || typeof current === 'string', `${name}: invalid registry latest value`);
    if (current !== null && compareSemver(version, current) < 0) {
      downgrades.push({ name, current });
    }
  }

  const tag = expectedTag(version);
  const requiredOverride = `allow-latest-downgrade:${tag}`;
  const suppliedOverride = env[EMERGENCY_OVERRIDE_ENV];
  if (suppliedOverride) {
    assert(
      suppliedOverride === requiredOverride,
      `${EMERGENCY_OVERRIDE_ENV} must equal ${requiredOverride}; set ${EMERGENCY_OVERRIDE_ENV}=${requiredOverride}`,
    );
    assert(
      env.GITHUB_ACTIONS === 'true'
        && env.GITHUB_REF_TYPE === 'tag'
        && env.GITHUB_REF_NAME === tag,
      'an npm latest downgrade override is valid only in the exact GitHub tag run',
    );
  }
  if (downgrades.length === 0) {
    // During an emergency run, a snapshot becomes downgrade-free as soon as
    // the last affected package is repaired. The exact tag-bound token is then
    // harmless and must not block promotion of the remaining package set.
    return { emergencyOverride: false, downgrades: [] };
  }
  assert(
    suppliedOverride,
    `refusing to move npm latest backwards: ${downgrades.map(({ name, current }) => `${name} is ${current}`).join(', ')}; emergency override requires ${EMERGENCY_OVERRIDE_ENV}=${requiredOverride}`,
  );
  logger.warn(
    `::warning title=Emergency npm latest downgrade::${tag} is explicitly overriding latest for ${downgrades.map(({ name, current }) => `${name} (${current} -> ${version})`).join(', ')}`,
  );
  return { emergencyOverride: true, downgrades };
}

function latestSnapshot(packageNames) {
  return Object.fromEntries(packageNames.map((name) => [name, latestVersion(name)]));
}

function waitForIntegrity(name, version, attempts = 6) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const integrity = registryIntegrity(name, version);
    if (integrity) return integrity;
    if (attempt < attempts) {
      // npm's read API can trail a successful write briefly. This is a bounded
      // synchronous wait in a dedicated release process, not application code.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000);
    }
  }
  return null;
}

function waitForLatest(name, version, attempts = 6) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (latestVersion(name) === version) return true;
    if (attempt < attempts) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000);
    }
  }
  return false;
}

export function validatePublishContext({ manifest, env = process.env }) {
  const metadata = verifyReleaseMetadata({ tag: env.GITHUB_REF_NAME });
  assert(env.GITHUB_ACTIONS === 'true', 'refusing to publish outside GitHub Actions');
  assert(env.GITHUB_REF_TYPE === 'tag', 'refusing to publish outside a tag run');
  assert(env.GITHUB_REF_NAME === expectedTag(metadata.version), `unexpected tag ${env.GITHUB_REF_NAME}`);
  assert(env.NODE_AUTH_TOKEN, 'NODE_AUTH_TOKEN is required');
  assert(manifest.version === metadata.version, 'inspected tarball manifest version does not match package metadata');
  assert(Array.isArray(manifest.packages), 'inspected tarball manifest has no package list');
  assert(manifest.packages.length === Object.keys(PACKAGES).length, 'inspected tarball manifest must contain four packages');
  assert(
    JSON.stringify(manifest.packages.map(({ name }) => name).sort()) === JSON.stringify(Object.keys(PACKAGES).sort()),
    'inspected tarball manifest package names do not match the release set',
  );
  for (const entry of manifest.packages) {
    assert(entry.version === metadata.version, `${entry.name}: manifest version does not match package metadata`);
    assert(typeof entry.tarball === 'string' && entry.tarball.endsWith('.tgz'), `${entry.name}: invalid tarball path`);
    assert(/^sha512-[A-Za-z0-9+/]+=*$/.test(entry.integrity), `${entry.name}: invalid tarball integrity`);
  }
  assert(manifest.packages.at(-1)?.name === '@neurovault/mcp', 'root package must be promoted last');
  return { version: metadata.version, stagingTag: `staging-${metadata.version.replaceAll('.', '-')}` };
}

export function publishRelease(manifestPath) {
  const manifest = JSON.parse(readFileSync(resolve(manifestPath), 'utf8'));
  const { version, stagingTag } = validatePublishContext({ manifest });
  const packageNames = manifest.packages.map(({ name }) => name);

  // Check every package before creating any registry object. Null latest values
  // are expected on the first publication; equal versions make retries after a
  // partial promotion safe. The complete snapshot prevents the root package
  // from masking a stale or newer platform package.
  assertLatestPromotionAllowed({
    version,
    packageNames,
    latestByPackage: latestSnapshot(packageNames),
  });

  // First make every immutable version available under a version-specific staging
  // tag. A retry accepts an already-published version only when its registry
  // integrity is byte-identical to the tarball inspected in this run.
  for (const entry of manifest.packages) {
    const localIntegrity = `sha512-${createHash('sha512').update(readFileSync(entry.tarball)).digest('base64')}`;
    assert(localIntegrity === entry.integrity, `${entry.name}: tarball changed after inspection`);
    const existingIntegrity = registryIntegrity(entry.name, version);
    if (existingIntegrity) {
      assert(
        existingIntegrity === entry.integrity,
        `${entry.name}@${version} already exists with different bytes; refusing to continue`,
      );
      console.log(`[npm-release] ${entry.name}@${version} already exists with matching integrity`);
      npm(['dist-tag', 'add', `${entry.name}@${version}`, stagingTag], { stdio: 'inherit' });
    } else {
      console.log(`[npm-release] publishing ${entry.name}@${version} under ${stagingTag}`);
      npm(
        ['publish', entry.tarball, '--access', 'public', '--provenance', '--tag', stagingTag],
        { stdio: 'inherit' },
      );
    }
  }

  // Refuse promotion unless all four registry objects match the inspected
  // tarballs. Platform packages go first; the user-facing root moves last.
  for (const entry of manifest.packages) {
    assert(
      waitForIntegrity(entry.name, version) === entry.integrity,
      `${entry.name}@${version} failed the post-publish integrity check`,
    );
  }
  for (const entry of manifest.packages) {
    // Re-read the complete snapshot immediately before every mutable dist-tag
    // operation. This catches a newer release that landed while tarballs were
    // being staged or verified.
    assertLatestPromotionAllowed({
      version,
      packageNames,
      latestByPackage: latestSnapshot(packageNames),
    });
    console.log(`[npm-release] promoting ${entry.name}@${version} to latest`);
    npm(['dist-tag', 'add', `${entry.name}@${version}`, 'latest'], { stdio: 'inherit' });
    assert(waitForLatest(entry.name, version), `${entry.name}: latest did not move to ${version}`);
  }

  // Cleanup is intentionally last. If a transient failure occurs here, the
  // release is already coherent and a rerun is safe and idempotent.
  for (const entry of manifest.packages) {
    npm(['dist-tag', 'rm', entry.name, stagingTag], { stdio: 'inherit' });
  }
  console.log(`[npm-release] ${version} published coherently; root package promoted last`);
}

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  try {
    const [manifestPath, confirmation] = process.argv.slice(2);
    assert(manifestPath && confirmation === '--confirm-publish', 'usage: publish-release.mjs <manifest.json> --confirm-publish');
    publishRelease(manifestPath);
  } catch (error) {
    console.error(`[npm-release] ${error.message}`);
    process.exit(1);
  }
}
