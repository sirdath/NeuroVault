import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
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

test("packaged Settings is a dedicated, reopenable native window", async () => {
  const config = JSON.parse(await read("src-tauri/tauri.conf.json"));
  const settings = config.app?.windows?.find((window) => window.label === "settings");
  assert.equal(settings, undefined, "Settings should be lazy, not another webview at every launch");

  const app = await read("src-tauri/src/app.rs");
  assert.match(app, /fn open_settings_window/);
  assert.match(app, /WebviewWindowBuilder::new/);
  assert.match(app, /index\.html\?view=settings/);
  assert.match(app, /window\.label\(\) == "settings"/);
  assert.match(app, /accelerator\("CmdOrCtrl\+,"\)/);
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
