#!/usr/bin/env node

import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LEGAL_FILES,
  LICENSE_BUNDLE_FILES,
  NPM_ROOT,
  PACKAGES,
  REPO_ROOT,
} from './verify-release.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function stageLegal(packageDirectory, { repoRoot = REPO_ROOT, npmRoot = NPM_ROOT } = {}) {
  const target = resolve(packageDirectory);
  assert(isInside(resolve(npmRoot), target), `refusing to stage outside ${npmRoot}: ${target}`);

  const knownDirectories = new Set(Object.values(PACKAGES).map(({ directory }) => resolve(directory)));
  if (resolve(repoRoot) === REPO_ROOT) {
    assert(knownDirectories.has(target), `unknown npm package directory: ${target}`);
  }

  for (const filename of LEGAL_FILES) {
    const source = join(repoRoot, filename);
    assert(readFileSync(source).length > 0, `${source} is missing or empty`);
    copyFileSync(source, join(target, filename));
    assert(
      readFileSync(source).equals(readFileSync(join(target, filename))),
      `${filename} was not staged byte-for-byte`,
    );
  }

  const sourceLicenses = join(repoRoot, 'LICENSES');
  const targetLicenses = join(target, 'LICENSES');
  for (const filename of LICENSE_BUNDLE_FILES) {
    assert(readFileSync(join(repoRoot, filename)).length > 0, `${filename} is missing or empty`);
  }
  rmSync(targetLicenses, { recursive: true, force: true });
  mkdirSync(targetLicenses, { recursive: true });
  cpSync(sourceLicenses, targetLicenses, { recursive: true });
  for (const filename of LICENSE_BUNDLE_FILES) {
    assert(
      readFileSync(join(repoRoot, filename)).equals(readFileSync(join(target, filename))),
      `${filename} was not staged byte-for-byte`,
    );
  }
  return { target, files: [...LEGAL_FILES, ...LICENSE_BUNDLE_FILES] };
}

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  try {
    const directories = process.argv.slice(2);
    assert(directories.length > 0, 'usage: stage-legal.mjs <package-directory> [...]');
    for (const directory of directories) {
      const result = stageLegal(directory);
      console.log(`[npm-release] staged legal files into ${relative(REPO_ROOT, result.target) || basename(result.target)}`);
    }
  } catch (error) {
    console.error(`[npm-release] ${error.message}`);
    process.exit(1);
  }
}
