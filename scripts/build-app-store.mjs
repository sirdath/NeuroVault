#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  copyCanonicalModelDirectory,
  modelBundleDirectory,
  modelRevision,
  verifyCanonicalModelDirectory,
} from "./app-store-model.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const canonicalManifest = join(root, "src-tauri", "Cargo.toml");
const nodeModules = join(root, "node_modules");
const targetDir = join(root, "src-tauri", "target", "app-store");
const appBundle = join(targetDir, "release", "bundle", "macos", "NeuroVault.app");
const compileOnly = process.argv.includes("--compile");
const defaultModelSource = join(
  root,
  "src-tauri",
  "target",
  "app-store-model",
  modelRevision,
);
const modelSource = resolve(process.env.NEUROVAULT_APPSTORE_MODEL_DIR || defaultModelSource);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonicalBefore = await readFile(canonicalManifest);
const plutil = "/usr/bin/plutil";
const codesign = "/usr/bin/codesign";
const otool = "/usr/bin/otool";

function toolOutput(result) {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

function runTool(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function requireToolSuccess(result, label) {
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${toolOutput(result) || `status ${result.status}`}`);
  }
  return result;
}

function plistJsonFromFile(path, label) {
  requireToolSuccess(runTool(plutil, ["-lint", "--", path]), `${label} plist lint`);
  const parsed = requireToolSuccess(
    runTool(plutil, ["-convert", "json", "-o", "-", "--", path]),
    `${label} plist parse`,
  );
  try {
    return JSON.parse(parsed.stdout);
  } catch (error) {
    throw new Error(`${label} did not parse as a plist dictionary: ${error.message}`);
  }
}

function plistJsonFromXml(xml, label) {
  const parsed = requireToolSuccess(
    runTool(plutil, ["-convert", "json", "-o", "-", "--", "-"], { input: xml }),
    `${label} plist parse`,
  );
  try {
    return JSON.parse(parsed.stdout);
  } catch (error) {
    throw new Error(`${label} did not parse as a plist dictionary: ${error.message}`);
  }
}

async function licenseResourceMappings() {
  const mappings = [
    [join(root, "LICENSE"), "Contents/Resources/_up_/LICENSE"],
    [
      join(root, "THIRD-PARTY-NOTICES.md"),
      "Contents/Resources/_up_/THIRD-PARTY-NOTICES.md",
    ],
    [
      join(root, "LICENSES", "NeuroVault-v0.6.0-MIT.txt"),
      "Contents/Resources/_up_/LICENSES/NeuroVault-v0.6.0-MIT.txt",
    ],
    [
      join(root, "LICENSES", "THIRD-PARTY-LICENSES.txt"),
      "Contents/Resources/_up_/LICENSES/THIRD-PARTY-LICENSES.txt",
    ],
    [
      join(root, "LICENSES", "MPL-2.0-COVERED-SOURCE.md"),
      "Contents/Resources/_up_/LICENSES/MPL-2.0-COVERED-SOURCE.md",
    ],
    [
      join(root, "LICENSES", "NATIVE-NOTICE-SOURCES.json"),
      "Contents/Resources/_up_/LICENSES/NATIVE-NOTICE-SOURCES.json",
    ],
  ];

  for (const directory of ["native", "models"]) {
    const sourceRoot = join(root, "LICENSES", directory);
    for (const file of await collectBundleFiles(sourceRoot)) {
      mappings.push([
        file.path,
        `Contents/Resources/_up_/LICENSES/${directory}/${file.rel}`,
      ]);
    }
  }
  return mappings;
}

async function verifyRequiredResources(bundle, byRelativePath) {
  const privacyRelative = "Contents/Resources/PrivacyInfo.xcprivacy";
  const privacy = byRelativePath.get(privacyRelative);
  if (!privacy) throw new Error(`Store bundle is missing ${privacyRelative}`);
  const privacySource = join(root, "src-tauri", "PrivacyInfo.xcprivacy");
  if (sha256(await readFile(privacy.path)) !== sha256(await readFile(privacySource))) {
    throw new Error("bundled PrivacyInfo.xcprivacy differs from the audited source manifest");
  }

  const mappings = await licenseResourceMappings();
  for (const [source, relativeDestination] of mappings) {
    const destination = byRelativePath.get(relativeDestination);
    if (!destination) {
      throw new Error(`Store bundle is missing required legal resource: ${relativeDestination}`);
    }
    const sourceBytes = await readFile(source);
    const destinationBytes = await readFile(destination.path);
    if (sourceBytes.length === 0 || destinationBytes.length === 0) {
      throw new Error(`Store legal resource is empty: ${relativeDestination}`);
    }
    if (sha256(sourceBytes) !== sha256(destinationBytes)) {
      throw new Error(`Store legal resource differs from its audited source: ${relativeDestination}`);
    }
  }
  console.log(
    `Verified Store resources: PrivacyInfo.xcprivacy and ${mappings.length} legal files landed byte-identically`,
  );
}

async function verifyEffectivePlists(bundle) {
  const infoPath = join(bundle, "Contents", "Info.plist");
  const privacyPath = join(bundle, "Contents", "Resources", "PrivacyInfo.xcprivacy");
  const info = plistJsonFromFile(infoPath, "effective Info.plist");
  const privacy = plistJsonFromFile(privacyPath, "effective PrivacyInfo.xcprivacy");
  const baseConfig = JSON.parse(
    await readFile(join(root, "src-tauri", "tauri.conf.json"), "utf8"),
  );

  if (info.CFBundleIdentifier !== baseConfig.identifier) {
    throw new Error(
      `effective Info.plist identifier is ${info.CFBundleIdentifier || "missing"}; expected ${baseConfig.identifier}`,
    );
  }
  if (info.CFBundleExecutable !== "neurovault" || info.CFBundlePackageType !== "APPL") {
    throw new Error("effective Info.plist does not describe the expected NeuroVault app executable");
  }
  if (info.LSApplicationCategoryType !== "public.app-category.productivity") {
    throw new Error("effective Info.plist is missing the Productivity category");
  }
  if (info.LSMinimumSystemVersion !== "14.0") {
    throw new Error(
      `effective Info.plist minimum macOS version is ${info.LSMinimumSystemVersion || "missing"}; expected 14.0`,
    );
  }
  if (privacy.NSPrivacyTracking !== false) {
    throw new Error("effective privacy manifest must declare NSPrivacyTracking=false");
  }
  console.log("Verified effective Info.plist and PrivacyInfo.xcprivacy with plutil");
}

function verifySystemLinkedLibraries(main) {
  const result = requireToolSuccess(runTool(otool, ["-L", main]), "otool -L");
  const lines = result.stdout.split("\n").slice(1).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error("otool -L reported no linked libraries");

  for (const line of lines) {
    const dependency = line.replace(/\s+\(compatibility version.*$/, "");
    if (dependency.startsWith("/System/Library/") || dependency.startsWith("/usr/lib/")) {
      continue;
    }
    if (
      dependency.startsWith("@") ||
      /(?:^|\/)(?:Users|private\/var\/folders|target|neurovault-app-store-)(?:\/|$)/i.test(
        dependency,
      )
    ) {
      throw new Error(`Store executable contains a build-path or relocatable library leak: ${dependency}`);
    }
    throw new Error(`Store executable links a non-system library: ${dependency}`);
  }
  console.log(`Verified Store linkage: ${lines.length} dependencies, all system-provided`);
}

function verifySignedEntitlements(entitlements, expectedIdentifier) {
  for (const required of [
    "com.apple.security.app-sandbox",
    "com.apple.security.files.user-selected.read-write",
  ]) {
    if (entitlements[required] !== true) {
      throw new Error(`effective code signature is missing required entitlement: ${required}`);
    }
  }
  for (const forbidden of [
    "com.apple.security.network.client",
    "com.apple.security.network.server",
    "com.apple.security.files.bookmarks.app-scope",
    "com.apple.security.files.bookmarks.document-scope",
  ]) {
    if (forbidden in entitlements) {
      throw new Error(`effective code signature contains forbidden entitlement: ${forbidden}`);
    }
  }
  const temporary = Object.keys(entitlements).find((key) =>
    key.startsWith("com.apple.security.temporary-exception"),
  );
  if (temporary) {
    throw new Error(`effective code signature contains a temporary exception: ${temporary}`);
  }

  const applicationIdentifier = entitlements["com.apple.application-identifier"];
  const teamIdentifier = entitlements["com.apple.developer.team-identifier"];
  if (Boolean(applicationIdentifier) !== Boolean(teamIdentifier)) {
    throw new Error("effective signature must carry application and team identifiers together");
  }
  if (applicationIdentifier && !applicationIdentifier.endsWith(`.${expectedIdentifier}`)) {
    throw new Error(
      `effective application identifier ${applicationIdentifier} does not match ${expectedIdentifier}`,
    );
  }
  if (applicationIdentifier && !applicationIdentifier.startsWith(`${teamIdentifier}.`)) {
    throw new Error("effective application identifier does not use the effective team identifier");
  }
}

async function verifyBundleSignature(bundle) {
  const display = runTool(codesign, ["--display", "--verbose=4", bundle]);
  const displayText = toolOutput(display);
  if (display.status !== 0) {
    if (/code object is not signed at all|not signed/i.test(displayText)) {
      console.warn(
        "Store bundle is unsigned: accepted as a technical build only; sign with an App Store distribution identity before submission",
      );
      return;
    }
    throw new Error(`codesign inspection failed: ${displayText || `status ${display.status}`}`);
  }

  requireToolSuccess(
    runTool(codesign, ["--verify", "--deep", "--strict", "--verbose=4", bundle]),
    "codesign verification",
  );
  const entitlementResult = requireToolSuccess(
    runTool(codesign, ["--display", "--entitlements", ":-", bundle]),
    "codesign entitlement inspection",
  );
  const entitlementOutput = toolOutput(entitlementResult);
  const plistStart = entitlementOutput.search(/<\?xml\b|<plist\b/);
  if (plistStart < 0) {
    throw new Error("signed Store bundle exposes no inspectable entitlement plist");
  }
  const plistEnd = entitlementOutput.indexOf("</plist>", plistStart);
  if (plistEnd < 0) {
    throw new Error("signed Store bundle exposes a truncated entitlement plist");
  }
  const entitlements = plistJsonFromXml(
    entitlementOutput.slice(plistStart, plistEnd + "</plist>".length),
    "effective code-signing entitlements",
  );
  const baseConfig = JSON.parse(
    await readFile(join(root, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  verifySignedEntitlements(entitlements, baseConfig.identifier);

  const authorities = [...displayText.matchAll(/^Authority=(.+)$/gm)].map((match) => match[1]);
  const team = displayText.match(/^TeamIdentifier=(.+)$/m)?.[1] || "not set";
  if (/Signature=adhoc|\badhoc\b/i.test(displayText)) {
    console.warn(
      `Verified ad hoc Store signature and effective sandbox entitlements (TeamIdentifier=${team}); an App Store distribution signature is still required for submission`,
    );
  } else {
    console.log(
      `Verified Store signature and effective sandbox entitlements (Authority=${authorities.join(" → ") || "not reported"}, TeamIdentifier=${team})`,
    );
  }
}

function repairIncompleteAdHocResourceSeal(bundle, entitlementsPath) {
  const display = runTool(codesign, ["--display", "--verbose=4", bundle]);
  const displayText = toolOutput(display);
  if (display.status !== 0 || !/Signature=adhoc|\badhoc\b/i.test(displayText)) return;

  const verification = runTool(codesign, ["--verify", "--deep", "--strict", "--verbose=4", bundle]);
  if (verification.status === 0) return;
  const verificationText = toolOutput(verification);
  if (!/code has no resources but signature indicates they must be present/i.test(verificationText)) {
    return;
  }

  // Tauri can leave a technically ad-hoc-signed executable inside an app
  // bundle without sealing the bundle's resources. Repair only that exact
  // development-signature condition. Real distribution signatures and every
  // other verification failure remain immutable failures, and the complete
  // strict verifier runs again immediately afterwards.
  requireToolSuccess(
    runTool(codesign, [
      "--force",
      "--deep",
      "--sign",
      "-",
      "--timestamp=none",
      "--entitlements",
      entitlementsPath,
      bundle,
    ]),
    "ad hoc Store resource-seal repair",
  );
  requireToolSuccess(
    runTool(codesign, ["--verify", "--deep", "--strict", "--verbose=4", bundle]),
    "repaired ad hoc Store signature verification",
  );
  console.log("Re-sealed incomplete ad hoc Store bundle resources with the audited entitlements");
}

async function collectBundleFiles(directory, bundleRoot = directory, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const rel = relative(bundleRoot, path).split(sep).join("/");
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      throw new Error(`Store bundle contains a symbolic link: ${rel}`);
    }
    if (stat.isDirectory()) {
      if (/\.(?:app|framework|plugin|xpc)$/i.test(entry.name)) {
        throw new Error(`Store bundle contains a nested executable container: ${rel}`);
      }
      await collectBundleFiles(path, bundleRoot, files);
    } else if (stat.isFile()) {
      files.push({ path, rel, stat });
    } else {
      throw new Error(`Store bundle contains a non-file entry: ${rel}`);
    }
  }
  return files;
}

async function executableKind(path) {
  const handle = await open(path, "r");
  try {
    const bytes = Buffer.alloc(4);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead < 2) return null;
    const magic = bytes.subarray(0, bytesRead).toString("hex");
    const machOMagic = new Set([
      "feedface",
      "feedfacf",
      "cefaedfe",
      "cffaedfe",
      "cafebabe",
      "bebafeca",
      "cafebabf",
      "bfbafeca",
    ]);
    if (machOMagic.has(magic)) return "Mach-O";
    if (magic === "7f454c46") return "ELF";
    if (magic.startsWith("4d5a")) return "PE";
    return null;
  } finally {
    await handle.close();
  }
}

async function verifyStoreFrontend(directory) {
  const files = await collectBundleFiles(directory);
  for (const file of files.filter((candidate) => candidate.rel.endsWith(".js"))) {
    const source = await readFile(file.path, "utf8");
    if (/plugin:(?:shell|updater|process)\|/i.test(source)) {
      throw new Error(`Store frontend contains a direct-only plugin command: ${file.rel}`);
    }
    if (/https:\/\/(?:api\.)?github\.com\/sirdath\/NeuroVault/i.test(source)) {
      throw new Error(`Store frontend contains a direct-update network target: ${file.rel}`);
    }
  }
  console.log("Verified Store frontend: no shell, updater, process, or direct-update commands");
}

async function verifyStoreBundle(bundle) {
  const mainRelative = "Contents/MacOS/neurovault";
  const files = await collectBundleFiles(bundle);
  const byRelativePath = new Map(files.map((file) => [file.rel, file]));
  const main = byRelativePath.get(mainRelative);
  if (!main) throw new Error(`Store bundle is missing ${mainRelative}`);

  const macOSFiles = files.filter((file) => file.rel.startsWith("Contents/MacOS/"));
  if (macOSFiles.length !== 1 || macOSFiles[0].rel !== mainRelative) {
    throw new Error(
      `unexpected executable in Store app: ${macOSFiles.map((file) => file.rel).join(", ")}`,
    );
  }

  for (const file of files) {
    const lower = file.rel.toLowerCase();
    if (/\.(?:dylib|so(?:\.\d+)*|dll|exe)$/i.test(lower)) {
      throw new Error(`Store bundle contains a forbidden native library or sidecar: ${file.rel}`);
    }
    if (
      /(?:^|\/)(?:latest\.json|updater(?:\.json|\.sig)?|[^/]+\.(?:appimage|deb|msi|msix|rpm|sig))$/i.test(
        lower,
      )
    ) {
      throw new Error(`Store bundle contains updater material: ${file.rel}`);
    }
    if (file.rel !== mainRelative && (file.stat.mode & 0o111) !== 0) {
      throw new Error(`Store bundle contains an executable resource: ${file.rel}`);
    }

    const kind = await executableKind(file.path);
    if (file.rel === mainRelative) {
      if (kind !== "Mach-O" || (file.stat.mode & 0o111) === 0) {
        throw new Error("Store main executable is not an executable Mach-O file");
      }
    } else if (kind) {
      throw new Error(`Store bundle contains an unexpected ${kind} payload: ${file.rel}`);
    }
  }

  await verifyRequiredResources(bundle, byRelativePath);
  await verifyEffectivePlists(bundle);
  verifySystemLinkedLibraries(main.path);

  const strings = spawnSync("strings", ["-a", main.path], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (strings.error) throw strings.error;
  if (strings.status !== 0) throw new Error(strings.stderr || "strings inspection failed");
  if (/huggingface\.co|\bhf[_-]hub\b|BAAI\/bge-reranker/i.test(strings.stdout)) {
    throw new Error("Store executable still contains model-download or reranker capability");
  }

  const bundledModel = join(
    bundle,
    "Contents",
    "Resources",
    "appstore-model",
    modelBundleDirectory,
  );
  await verifyCanonicalModelDirectory(bundledModel);
  await verifyBundleSignature(bundle);
  console.log("Verified Store bundle: one Mach-O executable, no sidecars, dylibs, updater, or executable resources");
  console.log("Verified Store bundle: pinned model package is complete and byte-identical");
}

const verifyBundleIndex = process.argv.indexOf("--verify-bundle");
if (verifyBundleIndex >= 0) {
  const requestedBundle = process.argv[verifyBundleIndex + 1];
  if (!requestedBundle || process.argv.includes("--compile")) {
    throw new Error("Usage: node scripts/build-app-store.mjs --verify-bundle /path/to/NeuroVault.app");
  }
  await verifyStoreBundle(resolve(requestedBundle));
  process.exit(0);
}

try {
  const modulesStat = await lstat(nodeModules);
  if (!modulesStat.isDirectory() && !modulesStat.isSymbolicLink()) {
    throw new Error("node_modules exists but is not a directory");
  }
} catch (error) {
  if (error?.code === "ENOENT") {
    throw new Error("node_modules is missing; run npm ci before the App Store build");
  }
  throw error;
}

// A failed release attempt must never leave a previous or partial .app at the
// path later signing/notarization steps consume.
if (!compileOnly) await rm(appBundle, { recursive: true, force: true });

const stage = await mkdtemp(join(tmpdir(), "neurovault-app-store-"));
const excludedRoots = new Set([".git", "dist", "node_modules"]);
let verified = false;

try {
  await cp(root, stage, {
    recursive: true,
    filter(source) {
      const rel = relative(root, source);
      if (!rel) return true;
      const parts = rel.split(sep);
      if (excludedRoots.has(parts[0])) return false;
      if (parts[0] === "src-tauri" && parts[1] === "target") return false;
      return true;
    },
  });
  await symlink(nodeModules, join(stage, "node_modules"), "dir");

  // Model acquisition is a separate, explicit network step. The builder only
  // accepts one canonical package shape, including its pinned manifest, and
  // copies its allowlisted regular files into the isolated staging tree.
  const stagedModel = join(
    stage,
    "src-tauri",
    "appstore-model",
    modelBundleDirectory,
  );
  await copyCanonicalModelDirectory(modelSource, stagedModel);
  console.log(`Verified canonical offline embedding model (${modelRevision})`);

  // The Store config is merged over tauri.conf.json. Make the staged base
  // incapable of contributing direct-distribution binaries or resources even
  // if a future merge rule changes or an overlay field is omitted.
  const stagedBaseConfigPath = join(stage, "src-tauri", "tauri.conf.json");
  const stagedBaseConfig = JSON.parse(await readFile(stagedBaseConfigPath, "utf8"));
  stagedBaseConfig.bundle ??= {};
  stagedBaseConfig.bundle.externalBin = [];
  stagedBaseConfig.bundle.resources = [];
  await writeFile(stagedBaseConfigPath, `${JSON.stringify(stagedBaseConfig, null, 2)}\n`);
  await rm(join(stage, "src-tauri", "binaries"), { recursive: true, force: true });
  await rm(join(stage, "src-tauri", "src", "bin"), { recursive: true, force: true });

  // tauri-build validates all visible capability files, so direct-only files
  // are absent rather than merely unselected in the Store staging tree.
  for (const directCapability of ["default.json", "minitab.json", "employee-manager.json"]) {
    await rm(join(stage, "src-tauri", "capabilities", directCapability), { force: true });
  }

  const tauri = join(stage, "node_modules", ".bin", "tauri");
  const args = [
    "build",
    "--config",
    "src-tauri/tauri.appstore.conf.json",
    ...(compileOnly ? ["--debug", "--no-bundle"] : ["--bundles", "app"]),
    "--",
    "--locked",
    "--no-default-features",
    "--bin",
    "neurovault",
  ];

  console.log(`Building isolated App Store flavor in ${stage}`);
  const result = spawnSync(tauri, args, {
    cwd: stage,
    env: {
      ...process.env,
      CARGO_TARGET_DIR: targetDir,
      HF_HUB_OFFLINE: "1",
      NEUROVAULT_DISTRIBUTION: "app-store",
      VITE_DISTRIBUTION: "app-store",
    },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`isolated App Store build failed with status ${result.status ?? "unknown"}`);
  }
  await verifyStoreFrontend(join(stage, "dist"));

  const stagedManifest = await readFile(join(stage, "src-tauri", "Cargo.toml"), "utf8");
  if (/tauri\s*=\s*\{[^\n]*features\s*=\s*\[[^\]]*macos-private-api/.test(stagedManifest)) {
    throw new Error(
      "Tauri did not remove macos-private-api from the isolated Store manifest; refusing the artifact",
    );
  }

  const tree = spawnSync(
    "cargo",
    [
      "tree",
      "--locked",
      "--manifest-path",
      join(stage, "src-tauri", "Cargo.toml"),
      "-e",
      "features",
      "--no-default-features",
      "--features",
      "gui,app-store",
    ],
    {
      cwd: stage,
      env: { ...process.env, CARGO_TARGET_DIR: targetDir },
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (tree.error) throw tree.error;
  if (tree.status !== 0) throw new Error(tree.stderr || "cargo tree failed");
  if (
    /tauri feature "macos-private-api"|tauri-plugin-(?:shell|global-shortcut|updater|process|deep-link|single-instance)|\bhf-hub v|\bhf-hub feature/i.test(
      tree.stdout,
    )
  ) {
    throw new Error("direct-distribution or model-download dependency leaked into the Store feature graph");
  }
  console.log("Verified Store feature graph: no private API, direct plugins, hf-hub, or model downloader");

  // Compile and execute the Rust unit suite against the *effective* Store
  // manifest. The feature graph above proves the direct-only private macOS
  // API flag did not enter this build.
  const storeTestConfig = await readFile(
    join(stage, "src-tauri", "tauri.appstore.conf.json"),
    "utf8",
  );
  const storeTests = spawnSync(
    "cargo",
    [
      "test",
      "--locked",
      "--manifest-path",
      join(stage, "src-tauri", "Cargo.toml"),
      "--no-default-features",
      "--features",
      "gui,app-store",
      "--lib",
      "--",
      "--test-threads=1",
    ],
    {
      cwd: stage,
      env: {
        ...process.env,
        CARGO_TARGET_DIR: targetDir,
        HF_HUB_OFFLINE: "1",
        NEUROVAULT_DISTRIBUTION: "app-store",
        TAURI_CONFIG: storeTestConfig,
        VITE_DISTRIBUTION: "app-store",
      },
      stdio: "inherit",
    },
  );
  if (storeTests.error) throw storeTests.error;
  if (storeTests.status !== 0) {
    throw new Error(`Store Rust tests failed with status ${storeTests.status ?? "unknown"}`);
  }
  console.log("Verified Store Rust unit suite against the isolated feature graph");

  if (!compileOnly) {
    repairIncompleteAdHocResourceSeal(
      appBundle,
      join(stage, "src-tauri", "Entitlements.appstore.plist"),
    );
    await verifyStoreBundle(appBundle);
  }
  verified = true;
} finally {
  let canonicalChanged = false;
  try {
    const canonicalAfter = await readFile(canonicalManifest);
    canonicalChanged = sha256(canonicalAfter) !== sha256(canonicalBefore);
  } finally {
    await rm(stage, { recursive: true, force: true });
    if (!compileOnly && (!verified || canonicalChanged)) {
      await rm(appBundle, { recursive: true, force: true });
    }
  }
  if (canonicalChanged) {
    throw new Error("canonical src-tauri/Cargo.toml changed during the isolated Store build");
  }
}
