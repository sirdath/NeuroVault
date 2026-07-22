#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function fail(message) {
  throw new Error(`[release-assets] ${message}`);
}

async function requireNonempty(directory, name, files) {
  if (!files.has(name)) fail(`missing ${name}`);
  const info = await stat(resolve(directory, name));
  if (!info.isFile() || info.size === 0) fail(`${name} is empty or not a file`);
}

export async function verifyReleaseAssets(directory, version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`invalid version: ${version || "<empty>"}`);
  }

  const names = await readdir(directory);
  const files = new Set(names);
  const required = [
    "latest.json",
    `NeuroVault_${version}_aarch64.dmg`,
    `NeuroVault_${version}_amd64.AppImage`,
    `NeuroVault_${version}_amd64.AppImage.sig`,
    `NeuroVault_${version}_amd64.deb`,
    `NeuroVault_${version}_amd64.deb.sig`,
    `NeuroVault-${version}-1.x86_64.rpm`,
    `NeuroVault-${version}-1.x86_64.rpm.sig`,
    `NeuroVault_${version}_x64-setup.exe`,
    `NeuroVault_${version}_x64-setup.exe.sig`,
    `NeuroVault_${version}_x64_en-US.msi`,
    `NeuroVault_${version}_x64_en-US.msi.sig`,
    "NeuroVault_aarch64.app.tar.gz",
    "NeuroVault_aarch64.app.tar.gz.sig",
    "neurovault-linux-x64.spdx.json",
    "neurovault-macos-arm64.spdx.json",
    "neurovault-windows.spdx.json",
  ];
  await Promise.all(required.map((name) => requireNonempty(directory, name, files)));

  const manifest = JSON.parse(await readFile(resolve(directory, "latest.json"), "utf8"));
  if (manifest.version !== version) {
    fail(`latest.json version ${manifest.version ?? "<missing>"} does not match ${version}`);
  }
  const expectedPrefix = `https://github.com/sirdath/NeuroVault/releases/download/v${version}/`;
  const platforms = manifest.platforms ?? {};
  const requiredPlatforms = [
    "darwin-aarch64",
    "linux-x86_64",
    "linux-x86_64-deb",
    "linux-x86_64-rpm",
    "windows-x86_64",
    "windows-x86_64-nsis",
  ];
  for (const platform of requiredPlatforms) {
    const entry = platforms[platform];
    if (!entry) fail(`latest.json is missing ${platform}`);
    if (typeof entry.signature !== "string" || entry.signature.length < 100) {
      fail(`latest.json has no usable signature for ${platform}`);
    }
    if (typeof entry.url !== "string" || !entry.url.startsWith(expectedPrefix)) {
      fail(`latest.json has an unexpected URL for ${platform}: ${entry.url ?? "<missing>"}`);
    }
    const asset = basename(new URL(entry.url).pathname);
    if (!files.has(asset)) fail(`latest.json points to missing asset ${asset}`);
  }

  const installers = required.filter((name) =>
    !name.endsWith(".sig")
    && !name.endsWith(".json")
    && name !== "latest.json",
  );
  if (installers.length !== 7) fail(`expected 7 installer/update artifacts, found ${installers.length}`);

  return { files: names.length, installers: installers.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = resolve(process.argv[2] ?? "");
  const version = process.argv[3] ?? "";
  verifyReleaseAssets(directory, version)
    .then(({ files, installers }) => {
      console.log(`[release-assets] verified ${files} files (${installers} installer/update artifacts) for v${version}`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
