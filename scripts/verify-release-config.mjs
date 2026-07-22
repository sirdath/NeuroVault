#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function fail(message) {
  throw new Error(`[release-config] ${message}`);
}

function packageVersionFromCargo(toml) {
  const packageStart = toml.indexOf("[package]");
  if (packageStart < 0) fail("src-tauri/Cargo.toml has no [package] section");
  const afterHeader = toml.slice(packageStart + "[package]".length);
  const nextSection = afterHeader.search(/^\[/m);
  const packageBlock = nextSection >= 0 ? afterHeader.slice(0, nextSection) : afterHeader;
  const version = packageBlock.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  if (!version) fail("src-tauri/Cargo.toml has no [package] version");
  return version;
}

function assertSemver(version, label) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`${label} is not a supported semantic version: ${version}`);
  }
}

export async function verifyReleaseConfig({ refType = "", refName = "" } = {}) {
  const [pkgText, lockText, tauriText, cargoText, macText, windowsText, linuxText] = await Promise.all([
    readFile(resolve(root, "package.json"), "utf8"),
    readFile(resolve(root, "package-lock.json"), "utf8"),
    readFile(resolve(root, "src-tauri/tauri.conf.json"), "utf8"),
    readFile(resolve(root, "src-tauri/Cargo.toml"), "utf8"),
    readFile(resolve(root, "src-tauri/tauri.macos.conf.json"), "utf8"),
    readFile(resolve(root, "src-tauri/tauri.windows.conf.json"), "utf8"),
    readFile(resolve(root, "src-tauri/tauri.linux.conf.json"), "utf8"),
  ]);

  const pkg = JSON.parse(pkgText);
  const lock = JSON.parse(lockText);
  const tauri = JSON.parse(tauriText);
  const platformConfigs = {
    macOS: { config: JSON.parse(macText), source: "resources/vec0.dylib" },
    Windows: { config: JSON.parse(windowsText), source: "resources/vec0.dll" },
    Linux: { config: JSON.parse(linuxText), source: "resources/vec0.so" },
  };
  const cargoVersion = packageVersionFromCargo(cargoText);
  const versions = {
    "package.json": pkg.version,
    "package-lock.json": lock.version,
    "package-lock root": lock.packages?.[""]?.version,
    "tauri.conf.json": tauri.version,
    "Cargo.toml": cargoVersion,
  };

  for (const [label, version] of Object.entries(versions)) {
    if (typeof version !== "string") fail(`${label} has no version`);
    assertSemver(version, label);
    if (version !== pkg.version) {
      fail(`version mismatch: package.json=${pkg.version}, ${label}=${version}`);
    }
  }

  if (refType === "tag" && refName !== `v${pkg.version}`) {
    fail(`release tag ${refName || "<empty>"} must equal v${pkg.version}`);
  }

  if (tauri.$schema !== "https://schema.tauri.app/config/2") {
    fail("tauri.conf.json must use the official Tauri v2 schema");
  }
  if (tauri.identifier !== "com.neurovault.app") {
    fail(`unexpected bundle identifier: ${tauri.identifier ?? "<missing>"}`);
  }
  if (tauri.bundle?.macOS?.minimumSystemVersion !== "14.0") {
    fail("the declared macOS floor must remain aligned with bundled vec0 at 14.0");
  }

  const updater = tauri.plugins?.updater;
  if (!updater?.pubkey?.trim()) fail("updater public key is missing");
  const endpoint = updater.endpoints?.[0];
  if (endpoint !== "https://github.com/sirdath/NeuroVault/releases/latest/download/latest.json") {
    fail(`unexpected updater endpoint: ${endpoint ?? "<missing>"}`);
  }

  const bundle = tauri.bundle ?? {};
  for (const key of ["publisher", "homepage", "copyright", "license", "licenseFile", "category", "shortDescription", "longDescription"]) {
    if (!String(bundle[key] ?? "").trim()) fail(`bundle.${key} is missing`);
  }
  if (bundle.license !== "MIT" || bundle.licenseFile !== "../LICENSE") {
    fail("bundle license metadata must point to the repository MIT license");
  }

  const resources = bundle.resources;
  if (!resources || Array.isArray(resources) || typeof resources !== "object") {
    fail("bundle.resources must use a destination map");
  }
  const requiredResources = {
    "../LICENSE": "legal/LICENSE",
    "../PRIVACY.md": "legal/PRIVACY.md",
    "../THIRD-PARTY-NOTICES.md": "legal/THIRD-PARTY-NOTICES.md",
    "../LICENSES/MPL-2.0-COVERED-SOURCE.md": "legal/LICENSES/MPL-2.0-COVERED-SOURCE.md",
    "../LICENSES/NATIVE-NOTICE-SOURCES.json": "legal/LICENSES/NATIVE-NOTICE-SOURCES.json",
    "../LICENSES/THIRD-PARTY-LICENSES.txt": "legal/LICENSES/THIRD-PARTY-LICENSES.txt",
    "../LICENSES/models/DOWNLOADED-MODELS.md": "legal/LICENSES/models/DOWNLOADED-MODELS.md",
    "../LICENSES/native/bge-small-en-v1.5-LICENSE-MIT": "legal/LICENSES/native/bge-small-en-v1.5-LICENSE-MIT",
    "../LICENSES/native/onnxruntime-1.20.0-LICENSE": "legal/LICENSES/native/onnxruntime-1.20.0-LICENSE",
    "../LICENSES/native/onnxruntime-1.20.0-ThirdPartyNotices.txt": "legal/LICENSES/native/onnxruntime-1.20.0-ThirdPartyNotices.txt",
    "../LICENSES/native/sqlite-vec-v0.1.9-LICENSE-APACHE": "legal/LICENSES/native/sqlite-vec-v0.1.9-LICENSE-APACHE",
    "../LICENSES/native/sqlite-vec-v0.1.9-LICENSE-MIT": "legal/LICENSES/native/sqlite-vec-v0.1.9-LICENSE-MIT",
  };
  for (const [source, destination] of Object.entries(requiredResources)) {
    if (resources[source] !== destination) {
      fail(`bundle resource ${source} must map to ${destination}`);
    }
  }
  for (const [platform, { config, source }] of Object.entries(platformConfigs)) {
    const nativeResources = config.bundle?.resources;
    if (!nativeResources || Object.keys(nativeResources).length !== 1 || nativeResources[source] !== source) {
      fail(`${platform} bundle must contain only its target sqlite-vec resource (${source})`);
    }
  }
  await Promise.all(
    Object.keys(requiredResources).map((file) =>
      readFile(resolve(root, "src-tauri", file), "utf8"),
    ),
  );

  return { version: pkg.version, identifier: tauri.identifier };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyReleaseConfig({
    refType: process.env.GITHUB_REF_TYPE ?? "",
    refName: process.env.GITHUB_REF_NAME ?? "",
  })
    .then(({ version, identifier }) => {
      console.log(`[release-config] v${version} ready (${identifier})`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
