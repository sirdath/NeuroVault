import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("production CSP restricts the webview to declared local and update hosts", async () => {
  const config = JSON.parse(await read("src-tauri/tauri.conf.json"));
  const csp = config.app?.security?.csp;
  assert.equal(typeof csp, "string");
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /http:\/\/127\.0\.0\.1:8765/);
  assert.match(csp, /https:\/\/api\.github\.com/);
  assert.match(csp, /object-src 'none'/);
  assert.doesNotMatch(csp, /default-src \*/);
});

test("packaged CSS has no remote font or stylesheet imports", async () => {
  const css = await read("src/index.css");
  assert.doesNotMatch(css, /@import\s+url\(["']?https?:\/\//i);
  assert.doesNotMatch(css, /fonts\.googleapis\.com|cdn\.jsdelivr\.net/i);
});

test("the main webview has no generic file or process execution capability", async () => {
  const capability = JSON.parse(await read("src-tauri/capabilities/default.json"));
  const identifiers = capability.permissions.map((permission) =>
    typeof permission === "string" ? permission : permission.identifier,
  );
  const forbidden = [
    "fs:default",
    "fs:allow-read",
    "fs:allow-write",
    "shell:allow-execute",
    "shell:allow-spawn",
    "shell:allow-kill",
    "global-shortcut:default",
    "deep-link:default",
  ];
  for (const identifier of forbidden) {
    assert.equal(identifiers.includes(identifier), false, `${identifier} must stay denied`);
  }
});

test("release artifacts remain draft until manual verification", async () => {
  const workflow = await read(".github/workflows/release.yml");
  assert.match(workflow, /releaseDraft:\s*true/);
  assert.match(workflow, /verify-macos-release\.sh/);
  assert.match(workflow, /actions\/attest@[0-9a-f]{40}/);
  assert.match(workflow, /spdx-json/);
});

test("third-party workflow actions are pinned to immutable commits", async () => {
  const directory = new URL("../.github/workflows/", import.meta.url);
  const names = (await readdir(directory)).filter((name) => /\.ya?ml$/.test(name));
  for (const name of names) {
    const workflow = await read(`.github/workflows/${name}`);
    for (const line of workflow.split("\n").filter((candidate) => /\buses:\s*/.test(candidate))) {
      const ref = line.match(/\buses:\s*[^@\s]+@([^\s#]+)/)?.[1];
      assert.match(ref ?? "", /^[0-9a-f]{40}$/, `${name}: floating action reference in ${line.trim()}`);
    }
  }
});

test("public install guidance never tells users to bypass OS verification", async () => {
  const publicCopy = [
    await read("README.md"),
    await read("docs/TROUBLESHOOTING.md"),
    await read(".github/workflows/release.yml"),
  ].join("\n");
  assert.doesNotMatch(publicCopy, /xattr\s+[^\n]*(quarantine|\/Applications\/NeuroVault)/i);
  assert.doesNotMatch(publicCopy, /click\s+[“\"']?more info[^\n]*run anyway/i);
});

test("packaged Settings stays inside the main app and native Cmd+, routes to it", async () => {
  const config = JSON.parse(await read("src-tauri/tauri.conf.json"));
  const settings = config.app?.windows?.find((window) => window.label === "settings");
  assert.equal(settings, undefined, "Settings must not create a second webview");

  const app = await read("src-tauri/src/app.rs");
  const frontend = await read("src/App.tsx");
  const entrypoint = await read("src/main.tsx");
  assert.match(app, /fn open_settings_in_main/);
  assert.match(app, /emit\("open-settings-requested", \(\)\)/);
  assert.match(app, /accelerator\("CmdOrCtrl\+,"\)/);
  assert.doesNotMatch(app, /index\.html\?view=settings/);
  assert.doesNotMatch(app, /window\.label\(\) == "settings"/);
  assert.doesNotMatch(entrypoint, /view=settings/);
  assert.match(frontend, /listen<null>\("open-settings-requested"/);
  assert.match(frontend, /setView\("settings"\)/);
});

test("all eight palettes reach Settings, native chrome, portals, and the editor", async () => {
  const store = await read("src/stores/settingsStore.ts");
  const settings = await read("src/components/SettingsView.tsx");
  const frontend = await read("src/App.tsx");
  const editor = await read("src/components/editor/theme.ts");

  for (const id of ["light", "dark", "glacier", "parchment", "sage", "abyss", "graphite", "synapse"]) {
    assert.match(store, new RegExp(`id: ["']${id}["']`), `${id} must remain selectable`);
  }
  assert.match(store, /root\.dataset\.theme = theme\.mode/);
  assert.match(store, /root\.dataset\.themeId = theme\.id/);
  assert.match(frontend, /setTheme\(theme\.mode\)/);
  assert.match(settings, /THEME_GROUPS/);
  assert.match(settings, /aria-pressed=\{selected\}/);
  assert.match(editor, /var\(--nv-capture\)/);
  assert.doesNotMatch(editor, /#3c9fa0|#7767df/i);
});

test("release navigation has one owner for vaults, settings, review, trust, and context history", async () => {
  const navigation = await read("src/components/ConsumerNavigation.tsx");
  const sidebar = await read("src/components/Sidebar.tsx");
  const settings = await read("src/components/SettingsView.tsx");
  const trust = await read("src/components/TrustCenter.tsx");
  const frontend = await read("src/App.tsx");

  assert.match(navigation, /const PRIMARY_NAV_ITEMS[\s\S]*?id: "memories"[\s\S]*?id: "graph"[\s\S]*?id: "today"/);
  assert.match(navigation, /vault-mark-transparent\.png/);
  const transparentMark = await stat(new URL("../src/assets/vault-mark-transparent.png", import.meta.url));
  assert.ok(transparentMark.isFile() && transparentMark.size > 0, "transparent app mark must ship in clean builds");
  assert.doesNotMatch(navigation, /mixBlendMode/);
  assert.doesNotMatch(sidebar, /BrainSelector|onSettingsOpen|title="Settings"/);
  assert.doesNotMatch(frontend, /<ActivityBar|from "\.\/components\/ActivityBar"/);
  assert.doesNotMatch(settings, /\["memory", "Memory"\]|\["privacy", "Privacy & Trust"\]/);
  assert.doesNotMatch(settings, /<MemoryInspector|<InspectorSection|<PrivacySettings/);
  assert.match(settings, /<DirectConnectionsCenter\b/);
  assert.doesNotMatch(settings, /<AutoRecallSection|<McpSection|<ClaudeCodeMcpSection|nv_auto_recall/);
  assert.match(trust, /setAutomaticRecall/);
  assert.match(trust, /<ActivityPanel[\s\S]*?presentation="embedded"/);
  assert.match(frontend, /view === "trust" \|\| view === "activity"/);
});

test("note-browser collapse and window minimize remain direct, independent actions", async () => {
  const frontend = await read("src/App.tsx");
  assert.match(frontend, /if \(viewRef\.current !== "memories"\) return;/);
  assert.match(frontend, /collapsed=\{navigationCollapsed\}/);
  assert.match(frontend, /!sidebarCollapsed && \(\s*<Sidebar/s);
  assert.match(frontend, /const \[sidebarCollapsed, setSidebarCollapsed\] = useState\(false\)/);
  assert.doesNotMatch(frontend, /nv\.sidebar\.collapsed/);
  assert.match(frontend, /initializeConsumerVault\(loadBrains, initVault\)/);
  assert.match(frontend, /winInvoke\("minimize_main"\)[\s\S]*?aria-label="Minimize window"/);
  assert.match(frontend, /aria-label="More window options"/);
});

test("automatic context has an always-reachable native app-menu control", async () => {
  const app = await read("src-tauri/src/app.rs");
  assert.match(app, /"automatic-context",\s*"Automatic Context"/);
  assert.match(app, /nv_auto_recall_set\(app\.clone\(\), enabled\)/);
  assert.match(app, /set_automatic_context_menu_state/);
});

test("CI compiles both the headless engine and the desktop GUI", async () => {
  const workflow = await read(".github/workflows/ci.yml");
  assert.match(workflow, /cargo clippy --all-targets --no-default-features --features model-download -- -D warnings/);
  assert.match(workflow, /cargo clippy --all-targets -- -D warnings/);

  const gate = await read("scripts/gates.sh");
  assert.match(gate, /cargo clippy --all-targets --no-default-features --features model-download -- -D warnings/);
  assert.match(gate, /cargo clippy --all-targets -- -D warnings/);
});

test("the App Store flavor cannot inherit direct-distribution capabilities", async () => {
  const cargo = await read("src-tauri/Cargo.toml");
  const appStoreBuilder = await read("scripts/build-app-store.mjs");
  const appStoreModel = await read("scripts/app-store-model.mjs");
  const appStoreFetcher = await read("scripts/fetch-app-store-model.mjs");
  const appStoreWorkflow = await read(".github/workflows/app-store-check.yml");
  const lib = await read("src-tauri/src/lib.rs");
  const app = await read("src-tauri/src/app.rs");
  const frontend = await read("src/App.tsx");
  const frontendEntry = await read("src/main.tsx");
  const brainSelector = await read("src/components/BrainSelector.tsx");
  const memoryModules = await read("src-tauri/src/memory/mod.rs");
  const httpServer = await read("src-tauri/src/memory/http_server.rs");
  const direct = JSON.parse(await read("src-tauri/tauri.conf.json"));
  const store = JSON.parse(await read("src-tauri/tauri.appstore.conf.json"));
  const storeCapability = JSON.parse(await read("src-tauri/capabilities/app-store.json"));

  assert.match(cargo, /default\s*=\s*\["gui",\s*"direct-distribution"\]/);
  assert.match(cargo, /direct-distribution\s*=\s*\[[\s\S]*?dep:tauri-plugin-shell[\s\S]*?dep:tauri-plugin-global-shortcut[\s\S]*?dep:tauri-plugin-updater[\s\S]*?dep:tauri-plugin-process[\s\S]*?\]/);
  assert.match(cargo, /direct-distribution\s*=\s*\[[\s\S]*?"model-download"[\s\S]*?\]/);
  assert.match(cargo, /model-download\s*=\s*\["fastembed\/hf-hub-rustls-tls"\]/);
  assert.match(cargo, /app-store\s*=\s*\[\s*"dep:sqlite-vec"\s*\]/);
  assert.match(appStoreBuilder, /--no-default-features/);
  assert.match(appStoreBuilder, /"--bin",\s*\n\s*"neurovault"/);
  assert.match(appStoreBuilder, /neurovault-app-store-/);
  assert.match(appStoreBuilder, /Store Rust unit suite against the isolated feature graph/);
  assert.match(appStoreBuilder, /Tauri did not remove macos-private-api/);
  assert.match(appStoreBuilder, /default\.json[\s\S]*minitab\.json[\s\S]*employee-manager\.json/);
  assert.match(appStoreBuilder, /stagedBaseConfig\.bundle\.externalBin = \[\]/);
  assert.match(appStoreBuilder, /src-tauri", "binaries/);
  assert.match(appStoreBuilder, /src-tauri", "src", "bin/);
  assert.match(appStoreBuilder, /await rm\(appBundle, \{ recursive: true, force: true \}\)/);
  assert.match(appStoreBuilder, /unexpected executable in Store app/);
  assert.match(appStoreBuilder, /forbidden native library or sidecar/);
  assert.match(appStoreBuilder, /executable resource/);
  assert.match(appStoreBuilder, /verifyRequiredResources/);
  assert.match(appStoreBuilder, /--verify-bundle/);
  assert.match(appStoreBuilder, /Contents\/Resources\/_up_\/LICENSES\/THIRD-PARTY-LICENSES\.txt/);
  assert.match(appStoreBuilder, /bundled PrivacyInfo\.xcprivacy differs from the audited source/);
  assert.match(appStoreBuilder, /plistJsonFromFile/);
  assert.match(appStoreBuilder, /effective Info\.plist and PrivacyInfo\.xcprivacy with plutil/);
  assert.match(appStoreBuilder, /verifySystemLinkedLibraries/);
  assert.match(appStoreBuilder, /Store executable links a non-system library/);
  assert.match(appStoreBuilder, /build-path or relocatable library leak/);
  assert.match(appStoreBuilder, /"--verify", "--deep", "--strict"/);
  assert.match(appStoreBuilder, /"--display", "--entitlements", ":-"/);
  assert.match(appStoreBuilder, /verifySignedEntitlements/);
  assert.match(appStoreBuilder, /Store bundle is unsigned: accepted as a technical build only/);
  assert.match(appStoreBuilder, /repairIncompleteAdHocResourceSeal/);
  assert.match(
    appStoreBuilder,
    /code has no resources but signature indicates they must be present/,
  );
  assert.match(
    appStoreBuilder,
    /repairIncompleteAdHocResourceSeal\([\s\S]*?await verifyStoreBundle/,
  );
  assert.match(
    appStoreBuilder,
    /async function verifyStoreBundle[\s\S]*?await verifyRequiredResources[\s\S]*?await verifyEffectivePlists[\s\S]*?verifySystemLinkedLibraries[\s\S]*?await verifyBundleSignature/,
  );
  assert.match(appStoreBuilder, /model-download dependency leaked/);
  assert.match(appStoreBuilder, /!verified \|\| canonicalChanged/);
  assert.match(appStoreBuilder, /copyCanonicalModelDirectory/);
  assert.match(appStoreModel, /ea104dacec62c0de699686887e3f920caeb4f3e3/);
  assert.match(appStoreModel, /neurovault-model\.json/);
  assert.match(appStoreModel, /unexpected contents/);
  assert.match(appStoreFetcher, /mkdtemp/);
  assert.match(appStoreFetcher, /backupMoved/);
  assert.match(appStoreWorkflow, /fetch-app-store-model\.mjs/);
  assert.match(appStoreWorkflow, /verify-app-store-model\.mjs/);
  assert.match(appStoreWorkflow, /npm run appstore:build/);
  assert.match(appStoreWorkflow, /NEUROVAULT_APPSTORE_MODEL_DIR/);
  assert.match(lib, /all\(feature = "app-store", feature = "direct-distribution"\)/);
  assert.match(lib, /compile_error!/);

  assert.deepEqual(direct.build?.features, ["direct-distribution"]);
  assert.deepEqual(store.build?.features, ["gui", "app-store"]);
  assert.equal(store.app?.macOSPrivateApi, false);
  assert.deepEqual(store.app?.security?.capabilities, ["app-store"]);
  assert.deepEqual(store.app?.windows?.map((window) => window.label), ["main"]);
  assert.equal(store.app?.windows?.some((window) => window.transparent === true), false);
  assert.deepEqual(store.bundle?.externalBin, []);
  assert.deepEqual(store.plugins?.updater?.endpoints, []);
  assert.doesNotMatch(store.build?.beforeBuildCommand ?? "", /stage-sidecar/);
  assert.doesNotMatch(store.app?.security?.csp ?? "", /github\.com|api\.github\.com/);
  assert.equal(
    storeCapability.permissions.some((permission) => /^(shell|updater|process):/.test(permission)),
    false,
  );
  assert.match(app, /app_data_dir\(\)/);
  assert.match(app, /set_var\("NEUROVAULT_HOME"/);
  assert.doesNotMatch(app, /memory::employee|nv_meetings_add|open_employee_manager/);
  assert.doesNotMatch(frontend, /EmployeePanel|meetingsDropClaim|EMPLOYEES_ENABLED|setView\("employee"\)/);
  assert.doesNotMatch(frontendEntry, /EmployeeManager|window=employees|isEmployeeWindow/);
  assert.match(brainSelector, /IS_APP_STORE[\s\S]*?openDialog\(\{[\s\S]*?directory:\s*true/);
  assert.match(app, /Build beside the destination and publish only after ZIP finalisation/);
  assert.doesNotMatch(memoryModules, /pub mod employee;/);
  assert.doesNotMatch(memoryModules, /pub mod roles;/);
  assert.doesNotMatch(httpServer, /\/api\/employees?\b/);
});

test("privacy copy agrees that launch update checks are opt-in", async () => {
  const privacy = await read("PRIVACY.md");
  assert.match(privacy, /Phone-home on startup \| \*\*None by default\./);
  assert.match(privacy, /Launch checks are off by default\./);
  assert.doesNotMatch(privacy, /Four seconds after launch/i);

  const readme = await read("README.md");
  assert.doesNotMatch(readme, /100% local and open source/i);
});

test("release bundles preserve mixed-license and third-party notices", async () => {
  const direct = JSON.parse(await read("src-tauri/tauri.conf.json"));
  const store = JSON.parse(await read("src-tauri/tauri.appstore.conf.json"));
  const settings = await read("src/components/SettingsView.tsx");
  const notices = await read("THIRD-PARTY-NOTICES.md");
  const licenseTexts = await read("LICENSES/THIRD-PARTY-LICENSES.txt");
  const coveredSource = await read("LICENSES/MPL-2.0-COVERED-SOURCE.md");
  const gate = await read("scripts/gates.sh");
  const release = await read(".github/workflows/release.yml");

  const required = [
    "../LICENSE",
    "../THIRD-PARTY-NOTICES.md",
    "../LICENSES/NeuroVault-v0.6.0-MIT.txt",
    "../LICENSES/THIRD-PARTY-LICENSES.txt",
    "../LICENSES/MPL-2.0-COVERED-SOURCE.md",
    "../LICENSES/NATIVE-NOTICE-SOURCES.json",
    "../LICENSES/native/*",
    "../LICENSES/models/*",
  ];
  for (const resource of required) {
    assert.equal(direct.bundle?.resources?.includes(resource), true, `direct bundle omits ${resource}`);
    assert.equal(store.bundle?.resources?.includes(resource), true, `Store bundle omits ${resource}`);
  }

  assert.match(settings, /THIRD-PARTY-NOTICES\.md\?raw/);
  assert.match(settings, /Open-source licenses and notices/);
  for (const crate of ["option-ext", "cssparser", "cssparser-macros", "dtoa-short", "selectors"]) {
    const row = new RegExp(`\\| ${crate.replaceAll("-", "\\-")} \\|`);
    assert.match(notices, row, `${crate} missing from notice inventory`);
    assert.match(coveredSource, row, `${crate} missing from MPL source access map`);
  }
  assert.match(licenseTexts, /Mozilla Public License Version 2\.0/);
  assert.match(notices, /ONNX Runtime 1\.20\.0/);
  assert.match(notices, /sqlite-vec v0\.1\.9/);
  assert.match(gate, /generate-third-party-notices\.mjs --check/);
  assert.match(release, /name: Verify third-party notices[\s\S]*generate-third-party-notices\.mjs --check/);
});
