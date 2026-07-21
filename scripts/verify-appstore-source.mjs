#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const json = async (path) => JSON.parse(await read(path));

const cargo = await read("src-tauri/Cargo.toml");
const appStoreBuilder = await read("scripts/build-app-store.mjs");
const appStoreModel = await read("scripts/app-store-model.mjs");
const appStoreFetcher = await read("scripts/fetch-app-store-model.mjs");
const appStoreModelVerifier = await read("scripts/verify-app-store-model.mjs");
const appStoreWorkflow = await read(".github/workflows/app-store-check.yml");
const lib = await read("src-tauri/src/lib.rs");
const app = await read("src-tauri/src/app.rs");
const frontend = await read("src/App.tsx");
const frontendEntry = await read("src/main.tsx");
const settings = await read("src/components/SettingsView.tsx");
const embedder = await read("src-tauri/src/memory/embedder.rs");
const reranker = await read("src-tauri/src/memory/reranker.rs");
const memoryModules = await read("src-tauri/src/memory/mod.rs");
const httpServer = await read("src-tauri/src/memory/http_server.rs");
const direct = await json("src-tauri/tauri.conf.json");
const store = await json("src-tauri/tauri.appstore.conf.json");
const storeCapability = await json("src-tauri/capabilities/app-store.json");
const entitlements = await read("src-tauri/Entitlements.appstore.plist");
const info = await read("src-tauri/Info.appstore.plist");
const privacy = await read("src-tauri/PrivacyInfo.xcprivacy");
const thirdPartyNotices = await read("THIRD-PARTY-NOTICES.md");
const thirdPartyLicenses = await read("LICENSES/THIRD-PARTY-LICENSES.txt");
const mplCoveredSource = await read("LICENSES/MPL-2.0-COVERED-SOURCE.md");

function balancedBlock(source, open, label) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(open, index + 1);
  }
  assert.fail(`unterminated Rust block: ${label}`);
}

function rustFunction(source, name) {
  const declaration = new RegExp(`(?:async\\s+)?fn\\s+${name}\\s*\\(`);
  const match = declaration.exec(source);
  assert.ok(match, `missing Rust function: ${name}`);

  const open = source.indexOf("{", match.index);
  assert.notEqual(open, -1, `missing body for Rust function: ${name}`);
  return source.slice(match.index, open) + balancedBlock(source, open, name);
}

function rustFeatureBlock(source, feature, label) {
  const marker = new RegExp(`#\\[cfg\\(feature\\s*=\\s*"${feature}"\\)\\]`);
  const match = marker.exec(source);
  assert.ok(match, `${label} is missing its ${feature} branch`);

  const open = source.indexOf("{", match.index + match[0].length);
  assert.notEqual(open, -1, `${label} is missing its ${feature} branch body`);
  return balancedBlock(source, open, `${label}:${feature}`);
}

function assertStoreBranchRejects(functionName) {
  const body = rustFeatureBlock(rustFunction(app, functionName), "app-store", functionName);
  assert.match(
    body,
    /return\s+Err\s*\(/,
    `${functionName} must reject the operation in the Store feature`,
  );
}

assert.match(cargo, /default\s*=\s*\["gui",\s*"direct-distribution"\]/);
assert.match(cargo, /direct-distribution\s*=\s*\[[\s\S]*?dep:tauri-plugin-shell[\s\S]*?dep:tauri-plugin-global-shortcut[\s\S]*?dep:tauri-plugin-updater[\s\S]*?dep:tauri-plugin-process[\s\S]*?\]/);
assert.match(cargo, /direct-distribution\s*=\s*\[[\s\S]*?"model-download"[\s\S]*?\]/);
assert.match(cargo, /model-download\s*=\s*\["fastembed\/hf-hub-rustls-tls"\]/);
assert.match(cargo, /app-store\s*=\s*\[\s*"dep:sqlite-vec"\s*\]/);
const fastembedDependency = cargo.match(/fastembed\s*=\s*\{[\s\S]*?\n\s*\]\s*\}/)?.[0];
assert.ok(fastembedDependency, "fastembed dependency declaration is missing");
assert.doesNotMatch(fastembedDependency, /hf-hub/);
assert.match(cargo, /direct-distribution\s*=\s*\[[\s\S]*?"tauri\/macos-private-api"/);
assert.doesNotMatch(cargo, /tauri\s*=\s*\{[^\n]*features\s*=\s*\[[^\]]*macos-private-api/);
assert.match(appStoreBuilder, /--no-default-features/);
assert.match(appStoreBuilder, /"--bin",\s*\n\s*"neurovault"/);
assert.match(appStoreBuilder, /neurovault-app-store-/);
assert.match(appStoreBuilder, /Tauri did not remove macos-private-api/);
assert.match(appStoreBuilder, /copyCanonicalModelDirectory/);
assert.match(appStoreBuilder, /verifyStoreBundle/);
assert.match(appStoreBuilder, /verifyStoreFrontend/);
assert.match(appStoreBuilder, /Store frontend contains a direct-only plugin command/);
assert.match(appStoreBuilder, /forbidden native library or sidecar/);
assert.match(appStoreBuilder, /executable resource/);
assert.match(appStoreBuilder, /model-download dependency leaked/);
assert.match(appStoreBuilder, /Store Rust unit suite against the isolated feature graph/);
assert.match(appStoreBuilder, /"cargo",[\s\S]*?"test",[\s\S]*?"gui,app-store"/);
assert.match(appStoreBuilder, /!verified \|\| canonicalChanged/);
assert.match(appStoreModel, /ea104dacec62c0de699686887e3f920caeb4f3e3/);
assert.match(appStoreModel, /828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35/);
assert.match(appStoreModel, /neurovault-model\.json/);
assert.match(appStoreModel, /unexpected contents/);
assert.match(appStoreModel, /size mismatch/);
assert.match(appStoreModel, /must not be executable/);
assert.match(appStoreFetcher, /mkdtemp/);
assert.match(appStoreFetcher, /backupMoved/);
assert.match(appStoreFetcher, /verifyCanonicalModelDirectory/);
assert.match(appStoreModelVerifier, /verifyCanonicalModelDirectory/);
assert.match(appStoreWorkflow, /fetch-app-store-model\.mjs/);
assert.match(appStoreWorkflow, /verify-app-store-model\.mjs/);
assert.match(appStoreWorkflow, /NEUROVAULT_APPSTORE_MODEL_DIR/);
assert.match(appStoreWorkflow, /npm run appstore:build/);
assert.match(appStoreBuilder, /default\.json[\s\S]*minitab\.json[\s\S]*employee-manager\.json/);
assert.match(appStoreBuilder, /stagedBaseConfig\.bundle\.externalBin = \[\]/);
assert.match(appStoreBuilder, /src-tauri", "binaries/);
assert.match(appStoreBuilder, /src-tauri", "src", "bin/);
assert.match(appStoreBuilder, /await rm\(appBundle, \{ recursive: true, force: true \}\)/);
assert.match(appStoreBuilder, /unexpected executable in Store app/);
assert.match(appStoreBuilder, /Verified canonical offline embedding model/);
assert.match(lib, /all\(feature = "app-store", feature = "direct-distribution"\)/);
assert.match(lib, /compile_error!/);
assert.match(app, /app_data_dir\(\)/);
assert.match(app, /set_var\("NEUROVAULT_HOME"/);
assert.match(app, /set_var\("NEUROVAULT_BUNDLED_MODEL_DIR"/);
assert.match(embedder, /try_new_from_user_defined/);
assert.match(embedder, /NEUROVAULT_BUNDLED_MODEL_DIR/);
assert.match(reranker, /cross-encoder reranking is not included in the Mac App Store edition/);
assertStoreBranchRejects("start_server");
assertStoreBranchRejects("nv_start_rust_server");
assertStoreBranchRejects("nv_auto_recall_set");
assertStoreBranchRejects("nv_start_vault_watcher");
assert.doesNotMatch(app, /Connect the optional NeuroVault Core bridge/);
assert.doesNotMatch(app, /memory::employee|nv_meetings_add|open_employee_manager/);
assert.doesNotMatch(frontend, /EmployeePanel|meetingsDropClaim|EMPLOYEES_ENABLED|setView\("employee"\)/);
assert.doesNotMatch(frontendEntry, /EmployeeManager|window=employees|isEmployeeWindow/);
assert.doesNotMatch(memoryModules, /pub mod employee;/);
assert.doesNotMatch(memoryModules, /pub mod roles;/);
assert.doesNotMatch(httpServer, /\/api\/employees?\b/);

assert.deepEqual(direct.build?.features, ["direct-distribution"]);
assert.equal(direct.app?.macOSPrivateApi, true);

assert.equal(store.$schema, "https://schema.tauri.app/config/2");
assert.deepEqual(store.build?.features, ["gui", "app-store"]);
assert.equal(store.build?.beforeBuildCommand, "npm run build");
assert.doesNotMatch(store.build?.beforeBuildCommand ?? "", /stage-sidecar/);
assert.equal(store.app?.macOSPrivateApi, false);
assert.deepEqual(store.app?.security?.capabilities, ["app-store"]);
assert.deepEqual(store.bundle?.externalBin, []);
assert.deepEqual(store.plugins?.updater?.endpoints, []);
assert.equal(store.bundle?.category, "Productivity");
assert.equal(store.bundle?.macOS?.entitlements, "Entitlements.appstore.plist");
assert.equal(store.bundle?.macOS?.infoPlist, "Info.appstore.plist");
assert.doesNotMatch(store.app?.security?.csp ?? "", /github\.com|api\.github\.com/);
assert.doesNotMatch(store.app?.security?.csp ?? "", /127\.0\.0\.1|localhost:8765/);

const requiredNoticeResources = [
  "../LICENSE",
  "../THIRD-PARTY-NOTICES.md",
  "../LICENSES/NeuroVault-v0.6.0-MIT.txt",
  "../LICENSES/THIRD-PARTY-LICENSES.txt",
  "../LICENSES/MPL-2.0-COVERED-SOURCE.md",
  "../LICENSES/NATIVE-NOTICE-SOURCES.json",
  "../LICENSES/native/*",
  "../LICENSES/models/*",
];
assert.ok(
  store.bundle?.resources?.includes("PrivacyInfo.xcprivacy"),
  "Store privacy manifest must be bundled at Contents/Resources/PrivacyInfo.xcprivacy",
);
assert.ok(
  store.bundle?.resources?.includes("appstore-model/bge-small-en-v1.5/**/*"),
  "Store must bundle the pinned offline embedding model",
);
for (const resource of requiredNoticeResources) {
  assert.ok(store.bundle?.resources?.includes(resource), `Store bundle must include ${resource}`);
  assert.ok(direct.bundle?.resources?.includes(resource), `direct bundle must include ${resource}`);
}
assert.ok(store.bundle?.resources?.includes("appstore-model/bge-small-en-v1.5/**/*"));
assert.match(settings, /THIRD-PARTY-NOTICES\.md\?raw/);
assert.match(settings, /Open-source licenses and notices/);
for (const crate of ["option-ext", "cssparser", "cssparser-macros", "dtoa-short", "selectors"]) {
  assert.match(thirdPartyNotices, new RegExp(`\\| ${crate.replaceAll("-", "\\-")} \\|`));
  assert.match(mplCoveredSource, new RegExp(`\\| ${crate.replaceAll("-", "\\-")} \\|`));
}
assert.match(thirdPartyLicenses, /Mozilla Public License Version 2\.0/);
assert.match(thirdPartyNotices, /ONNX Runtime 1\.20\.0/);
assert.match(thirdPartyNotices, /sqlite-vec v0\.1\.9/);

const windows = store.app?.windows ?? [];
assert.deepEqual(windows.map((window) => window.label), ["main"]);
assert.equal(windows.some((window) => window.transparent === true), false);

assert.deepEqual(storeCapability.windows, ["main"]);
for (const forbiddenPermission of ["shell:", "updater:", "process:"]) {
  assert.equal(
    storeCapability.permissions.some((permission) => permission.startsWith(forbiddenPermission)),
    false,
  );
}

for (const entitlement of [
  "com.apple.security.app-sandbox",
  "com.apple.security.files.user-selected.read-write",
]) {
  assert.match(entitlements, new RegExp(`<key>${entitlement.replaceAll(".", "\\.")}</key>\\s*<true/>`));
}
assert.doesNotMatch(entitlements, /com\.apple\.security\.network\.server/);
assert.doesNotMatch(entitlements, /com\.apple\.security\.network\.client/);
assert.doesNotMatch(entitlements, /com\.apple\.security\.files\.bookmarks/);
assert.doesNotMatch(entitlements, /com\.apple\.security\.temporary-exception/);
assert.doesNotMatch(entitlements, /\$(?:TEAM_ID|IDENTIFIER)/);
const hasApplicationIdentifier = entitlements.includes("com.apple.application-identifier");
const hasTeamIdentifier = entitlements.includes("com.apple.developer.team-identifier");
assert.equal(
  hasApplicationIdentifier,
  hasTeamIdentifier,
  "Store signing entitlements must add application and team identifiers together",
);

// Do not encode an export-compliance answer until the complete binary and all
// linked libraries have been audited. Omitting the key makes App Store Connect
// ask the questionnaire instead of silently asserting an exemption.
assert.doesNotMatch(info, /ITSAppUsesNonExemptEncryption/);
assert.match(info, /public\.app-category\.productivity/);

const privacyKeys = [...privacy.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]);
assert.deepEqual(privacyKeys, ["NSPrivacyTracking"]);
assert.match(privacy, /<key>NSPrivacyTracking<\/key>\s*<false\/>/);
for (const omittedEmptyKey of [
  "NSPrivacyTrackingDomains",
  "NSPrivacyCollectedDataTypes",
  "NSPrivacyAccessedAPITypes",
]) {
  assert.doesNotMatch(
    privacy,
    new RegExp(`<key>${omittedEmptyKey}</key>`),
    `${omittedEmptyKey} must be omitted rather than declared as an invalid empty array`,
  );
}

console.log("App Store flavor boundary: valid");
console.log("Submission readiness: blocked until docs/APP-STORE-READINESS.md is green");
