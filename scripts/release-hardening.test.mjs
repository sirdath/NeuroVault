import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { verifyReleaseConfig } from "./verify-release-config.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

async function filesUnder(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await filesUnder(new URL(`${entry.name}/`, directory), relative));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files.sort();
}

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

test("manual desktop runs are build-only while tag pushes stay draft-only", async () => {
  const workflow = await read(".github/workflows/release.yml");
  const manualStart = workflow.indexOf("- name: Build manual rehearsal (no GitHub Release)");
  const tagStart = workflow.indexOf("- name: Build + upload to draft release");
  const verifyStart = workflow.indexOf("- name: Verify Developer ID signature and notarization");
  assert.ok(manualStart > 0 && tagStart > manualStart && verifyStart > tagStart);

  const manualBuild = workflow.slice(manualStart, tagStart);
  assert.match(manualBuild, /if: github\.event_name == 'workflow_dispatch'/);
  assert.match(manualBuild, /npx tauri build --target/);
  assert.doesNotMatch(manualBuild, /GITHUB_TOKEN|gh release|tauri-apps\/tauri-action/);

  const tagBuild = workflow.slice(tagStart, verifyStart);
  assert.match(tagBuild, /if: github\.event_name == 'push' && github\.ref_type == 'tag'/);
  assert.match(tagBuild, /tauri-apps\/tauri-action@[0-9a-f]{40}/);
  assert.match(tagBuild, /releaseDraft:\s*true/);

  for (const stepName of [
    "Re-upload the stapled DMG",
    "Attest installer provenance",
    "Generate source and bundle SPDX SBOM",
  ]) {
    const start = workflow.indexOf(`- name: ${stepName}`);
    assert.ok(start > 0, `${stepName} must exist`);
    const block = workflow.slice(start, workflow.indexOf("\n      - name:", start + 1));
    assert.match(
      block,
      /if: github\.event_name == 'push' && github\.ref_type == 'tag'/,
      `${stepName} must never run during workflow_dispatch`,
    );
  }
  assert.match(
    workflow,
    /finalize:\n[\s\S]*?if: github\.event_name == 'push' && github\.ref_type == 'tag'/,
  );
});

test("macOS release gates nested Team IDs and a parseable vec0 minimum OS", async () => {
  const workflow = await read(".github/workflows/release.yml");
  assert.match(workflow, /DYLIB_TEAM_ID=/);
  assert.match(workflow, /DYLIB_TEAM_ID" != "\$APPLE_TEAM_ID/);
  assert.match(workflow, /APP_TEAM_ID=/);
  assert.match(workflow, /VEC_TEAM_ID=/);
  assert.match(workflow, /APP_TEAM_ID" != "\$APPLE_TEAM_ID/);
  assert.match(workflow, /VEC_TEAM_ID" != "\$APPLE_TEAM_ID/);
  assert.match(workflow, /VEC_TEAM_ID" != "\$APP_TEAM_ID/);
  assert.match(workflow, /-z "\$DYLIB_TEAM_ID"[\s\S]*?NORMALIZED_TEAM_ID" = "notset"/);
  assert.match(workflow, /-z "\$APP_TEAM_ID"[\s\S]*?APP_TEAM_NORMALIZED" = "notset"/);
  assert.match(workflow, /-z "\$VEC_TEAM_ID"[\s\S]*?VEC_TEAM_NORMALIZED" = "notset"/);
  assert.match(workflow, /if \[ -z "\$VEC_MINOS" \]; then[\s\S]*?could not parse vec0\.dylib minimum macOS version/);
});

test("release identity, legal resources, updater endpoint, and versions align", async () => {
  const result = await verifyReleaseConfig();
  assert.match(result.version, /^\d+\.\d+\.\d+/);
  assert.equal(result.identifier, "com.neurovault.app");
  await assert.rejects(
    verifyReleaseConfig({ refType: "tag", refName: "v999.0.0" }),
    /must equal v/,
  );
});

test("release workflow runs the full preflight and publishes only verified final bytes", async () => {
  const workflow = await read(".github/workflows/release.yml");
  assert.match(workflow, /verify:\n[\s\S]*?name: Release preflight/);
  assert.match(workflow, /build:\n[\s\S]*?needs: verify/);
  for (const command of [
    "verify-release-config.mjs",
    "npm run test:hardening",
    "npm run test:lib",
    "npm run test:ui",
    "npm run test:e2e",
    "cargo clippy --all-targets --no-default-features -- -D warnings",
    "cargo test --no-default-features",
  ]) {
    assert.match(workflow, new RegExp(escapeRegExp(command)), `${command} must gate release builds`);
  }
  assert.match(workflow, /missing release signing credentials/);
  assert.match(workflow, /rm -f src-tauri\/resources\/vec0\.dll src-tauri\/resources\/vec0\.dylib src-tauri\/resources\/vec0\.so/);

  const bestEffortStart = workflow.indexOf("- name: Notarize and staple a DMG copy (best-effort)");
  const reuploadStart = workflow.indexOf("- name: Re-upload the stapled DMG");
  const attestStart = workflow.indexOf("- name: Attest installer provenance");
  assert.ok(bestEffortStart > 0 && reuploadStart > bestEffortStart && attestStart > reuploadStart);
  const bestEffort = workflow.slice(bestEffortStart, reuploadStart);
  const reupload = workflow.slice(reuploadStart, attestStart);
  assert.match(bestEffort, /continue-on-error:\s*true/);
  assert.match(bestEffort, /set -euo pipefail/);
  assert.match(bestEffort, /STAPLED_DMG=/);
  assert.doesNotMatch(bestEffort, /gh release upload/);
  assert.doesNotMatch(reupload, /continue-on-error/);
  assert.match(reupload, /gh release upload[\s\S]*--clobber/);

  assert.match(workflow, /finalize:\n[\s\S]*?needs: build/);
  assert.match(workflow, /verify-release-assets\.mjs/);
  assert.match(workflow, /SHA256SUMS\.txt/);
  assert.match(workflow, /Attest checksum manifest provenance/);
  assert.match(workflow, /Generate source and bundle SPDX SBOM[\s\S]*?path: \./);

  for (const [platform, nativeResource] of [
    ["macos", "vec0.dylib"],
    ["windows", "vec0.dll"],
    ["linux", "vec0.so"],
  ]) {
    const config = JSON.parse(await read(`src-tauri/tauri.${platform}.conf.json`));
    assert.deepEqual(config.bundle?.resources, {
      [`resources/${nativeResource}`]: `resources/${nativeResource}`,
    });
  }
});

test("npm and desktop releases must use one version from the same commit", async () => {
  const workflow = await read(".github/workflows/npm-release.yml");
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /DESKTOP_TAG="\$\{GITHUB_REF_NAME#npm-\}"/);
  assert.match(workflow, /git rev-parse "\$\{GITHUB_REF_NAME\}\^\{commit\}"/);
  assert.match(workflow, /git rev-parse "\$\{DESKTOP_TAG\}\^\{commit\}"/);
  assert.match(workflow, /backend version \$\{got\} does not match package \$\{want\}/);

  const verifier = await read("dist-npm/scripts/verify-release.mjs");
  for (const versionSource of [
    "root package.json",
    "root package-lock.json",
    "src-tauri/Cargo.toml",
    "src-tauri/tauri.conf.json",
  ]) {
    assert.match(verifier, new RegExp(escapeRegExp(versionSource)));
  }
});

test("portable vault export excludes live databases and fails closed", async () => {
  const app = await read("src-tauri/src/app.rs");
  const settings = await read("src/components/SettingsView.tsx");
  const selector = await read("src/components/BrainSelector.tsx");

  assert.match(app, /"includes_database": false/);
  assert.match(app, /Some\("brain\.db" \| "brain\.db-wal" \| "brain\.db-shm"\)/);
  assert.match(app, /if ft\.is_symlink\(\) \{\s*continue;/);
  assert.match(app, /read_to_end\(&mut buf\)\s*\.map_err/);
  assert.match(app, /EXPORT-INFO\.json/);
  assert.match(app, /previous export could not be restored/);
  assert.doesNotMatch(app, /"brain": brain_record/);
  assert.match(settings, /portable ZIP of Markdown and other file-owned content/i);
  assert.match(selector, /Database-only history is not included/);
});

test("headless lifecycle never trusts a pid without a per-process identity", async () => {
  const mcp = await read("src-tauri/src/memory/mcp/mod.rs");
  const forward = await read("src-tauri/src/memory/mcp/forward.rs");
  const lifecycle = await read("dist-npm/lib/lifecycle.js");
  const launcher = await read("dist-npm/bin/neurovault-mcp.js");

  assert.match(mcp, /instance_id: &'a str/);
  assert.doesNotMatch(mcp, /clear_managed_backend_marker/);
  assert.match(mcp, /identity\.pid == spawned_pid/);
  assert.match(forward, /pub instance_id: String/);
  assert.match(lifecycle, /marker\.instance_id === identity\.instance_id/);
  assert.match(lifecycle, /error\.code = 'NOT_MANAGED'/);
  assert.match(lifecycle, /error\.code = 'REMOTE_ENDPOINT'/);
  assert.match(mcp, /host\.eq_ignore_ascii_case\("localhost"\)/);
  assert.doesNotMatch(mcp, /base\.contains\("localhost"\)/);
  assert.match(launcher, /\['status', 'stop'\]/);
  assert.match(launcher, /argv\[0\] === 'config'/);
  assert.match(launcher, /command: process\.execPath/);
  assert.match(launcher, /path\.resolve\(__filename\)/);
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
  assert.doesNotMatch(publicCopy, /more info[^\n]{0,100}run anyway/i);
});

test("first-use model downloads and external gateway risk are disclosed before use", async () => {
  const privacy = await read("PRIVACY.md");
  for (const file of ["api_gateway.json", "api_keys.json", "api_audit.jsonl"]) {
    assert.match(privacy, new RegExp(escapeRegExp(file)));
  }
  assert.match(privacy, /plain HTTP, not HTTPS/i);
  assert.match(privacy, /130 MB/);
  assert.match(privacy, /1 GB/);

  const onboarding = await read("src/components/Onboarding.tsx");
  assert.match(onboarding, /about 130 MB/);
  assert.match(onboarding, /about 1 GB/);
  assert.match(onboarding, /Hugging Face/);

  const settings = await read("src/components/SettingsView.tsx");
  assert.match(settings, /No transport encryption/);
  assert.match(settings, /plain HTTP/);
  assert.match(settings, /draft\.bind_kind !== "loopback"/);

  const headlessLauncher = await read("dist-npm/bin/neurovault-mcp.js");
  assert.match(headlessLauncher, /process\.env\.NEUROVAULT_HOME/);
  assert.match(headlessLauncher, /process\.env\.FASTEMBED_CACHE_DIR/);
  assert.match(headlessLauncher, /bge-reranker-base/);
  assert.match(headlessLauncher, /~1 GB/);
  assert.match(headlessLauncher, /rerank\.txt/);
});

test("generated legal inventory is current, complete, and product-neutral", async () => {
  assert.doesNotThrow(() =>
    execFileSync(process.execPath, ["scripts/generate-third-party-notices.mjs", "--check"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
    }),
  );
  const notice = await read("THIRD-PARTY-NOTICES.md");
  assert.match(notice, /Rust production dependency inventory/);
  assert.match(notice, /npm production dependency inventory/);
  assert.match(notice, /LICENSES\/NATIVE-NOTICE-SOURCES\.json/);
  assert.doesNotMatch(notice, /NeuroVault Core/);

  const release = await read(".github/workflows/release.yml");
  const npmRelease = await read(".github/workflows/npm-release.yml");
  const gate = await read("scripts/gates.sh");
  const tauri = JSON.parse(await read("src-tauri/tauri.conf.json"));
  assert.match(release, /npm run legal:check/);
  assert.match(npmRelease, /npm run legal:check/);
  assert.match(gate, /npm run legal:check/);
  assert.match(tauri.build?.beforeBuildCommand ?? "", /npm run legal:check/);
});

test("every canonical legal-bundle file reaches desktop, npm, and VS Code packages", async () => {
  const files = await filesUnder(new URL("../LICENSES/", import.meta.url));
  assert.ok(files.length >= 9, "the canonical LICENSES bundle is unexpectedly incomplete");

  const tauri = JSON.parse(await read("src-tauri/tauri.conf.json"));
  const npmVerifier = await read("dist-npm/scripts/verify-release.mjs");
  const vscodePackager = await read("vscode-extension/scripts/package-assets.mjs");
  const vscodeWorkflow = await read(".github/workflows/release-vscode.yml");
  for (const file of files) {
    const packaged = `LICENSES/${file}`;
    assert.equal(
      tauri.bundle?.resources?.[`../${packaged}`],
      `legal/${packaged}`,
      `${packaged} must be mapped into the desktop bundle`,
    );
    assert.match(npmVerifier, new RegExp(escapeRegExp(`'${packaged}'`)));
    assert.match(vscodePackager, new RegExp(escapeRegExp(`"${packaged}"`)));
    assert.match(vscodeWorkflow, new RegExp(escapeRegExp(`extension/${packaged}`)));
  }

  for (const manifestPath of [
    "dist-npm/package.json",
    "dist-npm/packages/mcp-darwin-arm64/package.json",
    "dist-npm/packages/mcp-linux-x64/package.json",
    "dist-npm/packages/mcp-win32-x64/package.json",
  ]) {
    const manifest = JSON.parse(await read(manifestPath));
    assert.ok(manifest.files?.includes("LICENSES/"), `${manifestPath} must include LICENSES/`);
  }
});

test("VS Code packages complete server, sqlite-vec, and legal asset pairs", async () => {
  const workflow = await read(".github/workflows/release-vscode.yml");
  const packager = await read("vscode-extension/scripts/package-assets.mjs");
  const extension = await read("vscode-extension/src/extension.ts");
  const manifest = JSON.parse(await read("vscode-extension/package.json"));

  for (const asset of ["vec0.dll", "vec0.dylib", "vec0.so"]) {
    assert.match(workflow, new RegExp(escapeRegExp(asset)));
    assert.match(packager, new RegExp(escapeRegExp(asset)));
  }
  for (const digest of [
    "51581189d52066b4dfc6631f6d7a3eab7dedc2260656ab09ca97ab3fb8165983",
    "8282126333399ddfe98bbbcc7a1936e7252625aac49df056a98be602e46bfd29",
    "b959baa1d8dc88861b1edb337b8587178cdcb12d60b4998f9d10b6a82052d5d7",
  ]) {
    assert.match(workflow, new RegExp(digest));
  }
  assert.match(workflow, /--all-platforms/);
  assert.match(workflow, /cargo build --release --no-default-features --bin neurovault-server/);
  assert.match(workflow, /Smoke server and sqlite-vec before packaging/);
  assert.match(workflow, /api\/brains\/smoke\/stats/);
  assert.doesNotMatch(workflow, /libwebkit2gtk|libgtk-3-dev|libayatana-appindicator/);
  assert.doesNotMatch(workflow, /skip: .*binary missing/);
  assert.match(extension, /NEUROVAULT_VEC_EXTENSION/);
  assert.doesNotMatch(extension, /"darwin-x64"/);
  assert.match(manifest.scripts.package, /--all-platforms/);
  assert.match(manifest.scripts.publish, /--all-platforms/);
  assert.match(packager, /generate-third-party-notices\.mjs/);
  for (const file of [
    "LICENSE",
    "PRIVACY.md",
    "THIRD-PARTY-NOTICES.md",
    "LICENSES/THIRD-PARTY-LICENSES.txt",
    "LICENSES/native/onnxruntime-1.20.0-ThirdPartyNotices.txt",
  ]) {
    assert.match(packager, new RegExp(escapeRegExp(file)));
    assert.match(workflow, new RegExp(`extension/${escapeRegExp(file)}`));
  }
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
  assert.match(settings, /<ConnectionsCenter\b/);
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
  assert.match(workflow, /cargo clippy --all-targets --no-default-features -- -D warnings/);
  assert.match(workflow, /cargo clippy --all-targets -- -D warnings/);

  const gate = await read("scripts/gates.sh");
  assert.match(gate, /cargo clippy --all-targets --no-default-features -- -D warnings/);
  assert.match(gate, /cargo clippy --all-targets -- -D warnings/);
});

test("privacy copy agrees that launch update checks are opt-in", async () => {
  const privacy = await read("PRIVACY.md");
  assert.match(privacy, /Phone-home on startup \| \*\*None by default\./);
  assert.match(privacy, /Launch checks are off by default\./);
  assert.doesNotMatch(privacy, /Four seconds after launch/i);

  const readme = await read("README.md");
  assert.doesNotMatch(readme, /100% local and open source/i);
});
