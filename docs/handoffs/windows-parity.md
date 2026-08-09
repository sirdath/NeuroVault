> **Status:** working brief for the Windows parity session (written 2026-08-06, from a
> read-only audit performed on macOS — every CONFIRMED item was verified by reading the
> code; every SUSPECTED item still needs runtime verification on real Windows hardware).

# NeuroVault — Windows Work Brief

**Written for a future Claude Code session running on a Windows machine.**
Repo: `NeuroVault` (Tauri 2 + Rust + React, MIT, v0.6.1). Researched 2026-08-10 against
commit `4bdd1e0` on `main` from a macOS checkout at
`/Users/dath/Documents/Dath Serious Projects /NeuroVault`.

Everything below is evidence-based and cites `file:line`. Where a claim could not be
verified without actually running Windows it is marked **SUSPECTED** — go verify it,
don't assume it.

---

## TL;DR — the eleven things that matter

1. **The lore is wrong: the historic vec0 path bug was a *macOS* bug, not a Windows one.**
   Windows was the platform the loader was written for. Current Windows vec0 handling is
   correct, and `npm-release.yml` already proves `vec0.dll` loads at runtime on a real
   Windows CI runner. → §2.0
2. **Windows Rust tests have never run. Anywhere. Ever.** `ci.yml` is 100 % Ubuntu; the
   Windows job in `release.yml` only builds. The single most valuable output of the
   Windows session is the first real `cargo test`. → §3.4
3. **Claude Code hook installation is impossible on Windows** — `hooks.rs:859` rejects any
   path containing `\`, which is every Windows path. Three independent blockers in one
   feature. → §2 C1
4. **Every release ships two Windows installers that put the MCP binary in two different
   places** (`%LOCALAPPDATA%\NeuroVault\` for NSIS, `C:\Program Files\NeuroVault\` for MSI),
   and **not one markdown file in the repo contains a Windows install path.** → §3.3
5. **There is a privacy leak**: `looks_like_absolute_path` (`handlers/mod.rs:1813`) misses
   bare POSIX paths on Windows because `Path::is_absolute()` is false without a drive
   prefix, so raw paths land in the journal unscrubbed. One-line fix. → §2 C1.5
6. **6 tests will fail, 2 will false-pass, 4 clippy `dead_code` warnings will break the
   `-D warnings` gate.** Five of the six failures trace to a single line (C1a).
   Zero compile errors. → §3.2
7. **There is no `.gitattributes`.** A default Windows clone gets CRLF everywhere →
   `cargo fmt --check` fails on every file and `scripts/gates.sh` won't run at all. → §2 C6
8. **Do not buy an EV certificate.** Microsoft's own docs (updated 2026-05-09) say EV no
   longer bypasses SmartScreen. Tauri's own signing page still claims otherwise and is
   stale. → §4.1
9. **Azure Trusted Signing is out for a UK sole trader** — the individual path is US/Canada
   only. Recommendation is **SignPath Foundation** (free, OSS), with a real strategic
   caveat about open-core monetisation. Fallback: SSL.com IV + eSigner, ~$309/yr. → §4.3
10. **13 tests silently vanish on Windows**, and the entire curator evidence-capture
    implementation is a `PlatformUnsupported` stub. That is deliberate and documented — say
    "unimplemented on Windows", not "untested". → §3.2
11. **Check `$env:PROCESSOR_ARCHITECTURE` before anything else.** There is no ARM64
    `vec0.dll` and no ARM64 build target; on Windows-on-ARM the app would start and then
    fail every brain open. → §2.0

---

## Section 0 — Orientation

### What NeuroVault is

A local-first, open-source, AI-native memory system for Claude and other LLMs. One
sentence: *Claude forgets you after every conversation; NeuroVault doesn't.* Markdown
notes in a vault are canonical; a SQLite database is a rebuildable index over them.

### Architecture in 10 lines

1. **Tauri 2 desktop app** — React + TypeScript UI (markdown editor + neural graph),
   Rust host process. Entry: `src-tauri/src/app.rs` (`run()` at line 1576).
2. **In-process Rust backend** — an `axum` HTTP server on `127.0.0.1:8765` lives
   *inside* the Tauri process. No Python, no sidecar daemon.
   (`src-tauri/src/memory/http_server.rs:113` `start_server`.)
3. **Hybrid retriever** — `sqlite-vec` ANN + BM25 + entity graph → RRF → cross-encoder
   rerank (`src-tauri/src/memory/retriever.rs`).
4. **Embeddings** — `fastembed-rs` (BGE-small-en-v1.5 ONNX), model cached at
   `~/.neurovault/.fastembed_cache/` (`src-tauri/src/memory/embedder.rs:130`).
5. **Storage** — `rusqlite` (bundled SQLite) + the `sqlite-vec` loadable extension
   `vec0.{dll,dylib,so}` (`src-tauri/src/memory/db.rs`, `.../sqlite_vec.rs`).
6. **File watcher** — `notify` v6 watches the vault; 500 ms per-file debounce
   (`src-tauri/src/memory/watcher.rs`).
7. **MCP server** — `neurovault-server --mcp-only`, a native Rust stdio server built on
   `rmcp`, bundled next to the app as a Tauri `externalBin` sidecar. It loads no model
   and opens no DB — it forwards every tool call over loopback HTTP to `:8765`
   (`src-tauri/src/memory/mcp/`, `src-tauri/src/bin/neurovault-server.rs`).
8. **55 MCP tools** behind a tier gate (`minimal`/`lite`/`standard`/`full`), selected by
   `NEUROVAULT_MCP_TIER` or `~/.neurovault/mcp_tier.txt`
   (`src-tauri/src/memory/mcp/registry.rs`).
9. **Data root** — `~/.neurovault/` (`%USERPROFILE%\.neurovault\` on Windows), overridable
   with `$NEUROVAULT_HOME` (`src-tauri/src/memory/paths.rs:26`).
10. **Also shipped**: an npm package `@neurovault/mcp` that installs the *same* headless
    binary without the desktop app (`dist-npm/`, `.github/workflows/npm-release.yml`).

### Where things live

| Path | What |
|---|---|
| `src-tauri/src/app.rs` | Every `#[tauri::command]`, window/tray/shortcut/deep-link setup, `run()` |
| `src-tauri/src/memory/` | The whole engine: 49 modules |
| `src-tauri/src/memory/paths.rs` | **The path registry.** All canonical dirs resolve here |
| `src-tauri/src/memory/sqlite_vec.rs` | vec0 extension discovery + `load_extension` |
| `src-tauri/src/memory/handlers/mod.rs` | ~6.6k lines: every `/api/*` axum handler |
| `src-tauri/src/memory/write_ops.rs` | `save_note` / `create_note` / trash / restore |
| `src-tauri/src/memory/ingest.rs` | File → engram pipeline; the `filename` key is built here |
| `src-tauri/src/memory/hooks.rs` | Claude Code hook install (writes `~/.claude/settings.json`) |
| `src-tauri/src/memory/employee.rs` | "AI Employees" — spawns the `claude` CLI (disabled in base build) |
| `src-tauri/src/memory/adaptive/curator/evidence.rs` | Transcript evidence capture — **`#[cfg(unix)]` only** |
| `src-tauri/tests/` | 4 integration tests: `adaptive_scenario`, `graphify_integration`, `notes_scope`, `retrieval_integration` |
| `src-tauri/resources/vec0.dll`, `vec0.dylib` | Committed sqlite-vec v0.1.9 binaries |
| `scripts/stage-sidecar.mjs` | Builds + stages `neurovault-server` as the Tauri sidecar |
| `scripts/gates.sh` | The full local verification gate (bash) |
| `.github/workflows/ci.yml` | **Ubuntu only.** No Windows job |
| `.github/workflows/release.yml` | 3-way matrix incl. `windows-latest` — build + upload only |
| `dist-npm/WINDOWS-TEST.md` | An existing (branch-stale) Windows runbook for the npm MCP path |

### The honest state of Windows support

The codebase is **more Windows-aware than you'd expect** — someone clearly did a pass.
`paths.rs` uses `dirs::home_dir()`, every `strip_prefix` result is normalised with
`.replace('\\', "/")`, `sqlite_vec.rs` branches on `target_os`, `port_recovery` has a
Windows path, the MCP autostart uses `CREATE_NEW_PROCESS_GROUP`, and `stage-sidecar.mjs`
handles the `.exe` suffix and target triple.

What's missing is **execution**: no Windows machine has ever run the test suite, no
Windows CI job runs tests, and a cluster of "spawn a helper binary" call sites forgot the
`.exe` suffix. Those are Section 2.

---

## Section 1 — Get building in 15 minutes

### 1.1 Prerequisites (elevated PowerShell)

```powershell
# 1. MSVC C++ build tools — MANDATORY.
#    rusqlite is `features = ["bundled"]` (vendors SQLite via cc) and there are
#    7 tree-sitter C grammars. Nothing compiles without cl.exe + the Windows SDK.
winget install --id Microsoft.VisualStudio.2022.BuildTools --source winget --force --override `
  "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --add Microsoft.VisualStudio.Component.Windows11SDK.26100 --addProductLang En-us"

# 2. Rust (MSVC host)
winget install --id Rustlang.Rustup
rustup default stable-msvc
#    src-tauri/rust-toolchain.toml pins channel = "1.97.0"; rustup auto-installs it
#    on the first cargo invocation under src-tauri/. Do not fight it.

# 3. Node — CI uses 22 everywhere except npm-release.yml (20). Match CI.
winget install --id OpenJS.NodeJS.LTS

# 4. WebView2 — preinstalled on Win11; NOT guaranteed on every Win10 box.
winget install --id Microsoft.EdgeWebView2Runtime

# 5. Git (for Git Bash — required to run scripts/gates.sh and the Makefile)
winget install --id Git.Git
```

Component IDs, if you prefer the VS Installer GUI: workload
`Microsoft.VisualStudio.Workload.VCTools`, plus
`Microsoft.VisualStudio.Component.VC.Tools.x86.x64` and
`Microsoft.VisualStudio.Component.Windows11SDK.26100`.

**LLVM/libclang is NOT needed.** The Cargo.toml comment mentions `buildtime_bindgen`, but
the actual feature list at `src-tauri/Cargo.toml:124` is `["bundled", "load_extension"]` —
no bindgen, no `clang-sys` in `Cargo.lock`.

**Optional but do it:** enable Windows long-path support
(`git config --system core.longpaths true` + the `LongPathsEnabled` registry flag). The
cargo target dir here is deep and enormous.

**Only if you want the `.msi`:** enable the **VBSCRIPT** optional Windows feature
(Settings → Apps → Optional features → More Windows features). `tauri.conf.json` sets
`bundle.targets: "all"` (line 65), so `tauri build` *will* attempt MSI. Skip it with
`npx tauri build --bundles nsis`.

### 1.2 First run

```powershell
git clone https://github.com/sirdath/NeuroVault.git
cd NeuroVault
npm install
```

Nothing else to fetch: `src-tauri/resources/vec0.dll` (289 KB, sqlite-vec v0.1.9,
PE32+ x86-64 — verified) is **committed to git**. There is no Windows download step.

### 1.3 Dev

```powershell
npm run tauri dev
```

`beforeDevCommand` starts Vite on `http://localhost:1420`; the axum backend boots
in-process on `127.0.0.1:8765`. DevTools: `Ctrl+Shift+I`.

**vec0 in dev works.** `tauri-build` copies `bundle.resources` into
`src-tauri\target\debug\resources\vec0.dll`, which is candidate #4 in
`src-tauri/src/memory/sqlite_vec.rs:71` (`<exe_dir>\resources\vec0.<ext>`). Expected
startup log includes a `vec_version` string. If you get
*"sqlite-vec extension 'vec0.dll' not found in any candidate location"*, set
`$env:NEUROVAULT_VEC_EXTENSION` to the absolute path of `src-tauri\resources\vec0.dll`
(`sqlite_vec.rs:57`).

> Dead-code note, not a blocker: the "cargo run" fallback candidate at
> `sqlite_vec.rs:92-98` computes `<exe_dir>\..\..\src-tauri\resources\` which, with no
> workspace root `Cargo.toml`, resolves to `src-tauri\src-tauri\resources\` and can never
> hit. Candidate #4 fires first, so it's harmless.

### 1.4 Test

```powershell
cd src-tauri
cargo test --no-default-features       # ← expect failures; see Section 3.2
```

**Why `--no-default-features`** (`src-tauri/Cargo.toml:69-85`): `default = ["gui"]` pulls
in Tauri; with `gui` on, `tauri-build`'s `build.rs` validates that the `externalBin`
sidecar exists on *every* compile, so a clean checkout dies in `build.rs` before tests
run. The escape hatch, if you need a GUI-feature compile:

```powershell
# PowerShell — inline `VAR=value cmd` is bash-only and silently does nothing here
$env:TAURI_CONFIG = '{"bundle":{"externalBin":[]}}'
cargo clippy --all-targets -- -D warnings
Remove-Item Env:\TAURI_CONFIG
```

Frontend:

```powershell
npx tsc --noEmit
npm run test:ui          # vitest
npm run test:hardening   # node --test
npm run test:lib
npm run test:e2e         # needs: npx playwright install chromium
```

There is no `npm run test`. There is no `engines` field in `package.json`.

### 1.5 Release build

```powershell
npm run tauri build -- --target x86_64-pc-windows-msvc
```

**Always pass `--target` on Windows.** `scripts/stage-sidecar.mjs` builds the sidecar with
an explicit `--target`, forcing `target\x86_64-pc-windows-msvc\release\`. If you then run
`tauri build` *without* `--target`, the app compiles into `target\release\` — a **second
full release build** of the same crate, and with `lto = "fat"` + `codegen-units = 1`
(`Cargo.toml:64-67`) that's another 4–6 minute link plus double the disk. CI already
passes `--target` (`release.yml:349`).

Expected outputs:

```
src-tauri\binaries\neurovault-server-x86_64-pc-windows-msvc.exe   (staged pre-build)
src-tauri\target\x86_64-pc-windows-msvc\release\neurovault.exe
src-tauri\target\x86_64-pc-windows-msvc\release\neurovault-server.exe
src-tauri\target\x86_64-pc-windows-msvc\release\resources\vec0.dll
src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis\NeuroVault_0.6.1_x64-setup.exe
src-tauri\target\x86_64-pc-windows-msvc\release\bundle\msi\NeuroVault_0.6.1_x64_en-US.msi
```

Installed layout — `tauri.conf.json` has **no `bundle.windows` block**, so Tauri defaults
apply: `nsis.installMode = "currentUser"` (no admin, `HKCU`) and
`webviewInstallMode = downloadBootstrapper` (silent, needs internet at install):

```
%LOCALAPPDATA%\NeuroVault\
  ├─ NeuroVault.exe
  ├─ neurovault-server.exe        ← sidecar, triple suffix stripped on install
  └─ resources\vec0.dll           ← $RESOURCE == the exe's own dir on Windows
```

That is exactly what the code expects (`app.rs:725-755`, `sqlite_vec.rs:71`).
**No path in the app needs elevated permissions** — install is per-user, data is under
`%USERPROFILE%\.neurovault\`, the hook snapshot goes to `%USERPROFILE%\.neurovault\bin\`,
and deep-link registration writes `HKCU\Software\Classes`.

First recall downloads the ~130 MB BGE-small model to
`%USERPROFILE%\.neurovault\.fastembed_cache\`. Expect Defender real-time scanning to make
that first run slow.

---

## Section 2 — The Windows bug list

Ranked. **CONFIRMED** = I read the code and it is wrong on Windows.
**SUSPECTED** = needs runtime verification on a real Windows box.

### 2.0 First, kill a myth: the vec0 path bug was NOT a Windows bug

Project lore says there was a *"sqlite-vec / vec0 path bug that only manifested on
Windows and passed on Windows CI."* I read the history. It is the **inverse**:

- `CHANGELOG.md:488-490` — *"Resolved 'sqlite-vec extension not found' on macOS — the
  loader now also looks in the `.app`'s `Contents/Resources/resources/` location, **not
  just next to the executable (the Windows layout)**."* The loader was written to the
  **Windows** layout; **macOS** was the broken platform.
- `CHANGELOG.md:493-494` — *"`retrieval_integration` test resolves the platform-correct
  sqlite-vec filename … instead of hardcoding `vec0.dll`."* The *test* hardcoded the
  Windows filename. That is the "passed on Windows while being wrong" part.

**Current Windows handling is CORRECT.** Verified end to end:

| Link in the chain | Evidence |
|---|---|
| Windows DLL is committed to git | `src-tauri/resources/vec0.dll`, 289 KB, `PE32+ executable (DLL) x86-64`, sqlite-vec **v0.1.9** (I ran `file` + `strings`) |
| It is bundled into the installer | `src-tauri/tauri.conf.json:69-71` — `"resources": ["resources/vec0.*"]` (a glob; on Windows it matches `vec0.dll` **and** `vec0.dylib` — harmless 162 KB of dead weight) |
| CI re-downloads + checksum-verifies it | `.github/workflows/release.yml:48-58` (matrix `vec_os: windows`, `vec_sha256: 5158…5983`, `tar.gz`), extraction at `release.yml:203-207` |
| Runtime finds it after install | `src-tauri/src/memory/sqlite_vec.rs:71` — candidate `<exe_dir>\resources\vec0.dll`, which is where Tauri puts `$RESOURCE` on Windows |
| Runtime finds it in dev | same candidate; `tauri-build` copies resources to `target\<profile>\resources\` |
| The suffix is chosen per-OS | `sqlite_vec.rs:38-43` — `#[cfg(target_os = "windows")] const EXTENSION_SUFFIX: &str = "dll"` |
| Tests pick the right file | `src-tauri/src/memory/retriever.rs:3002-3007` branches on `cfg!(target_os = "windows")` |
| SQLite can load extensions at all | `src-tauri/Cargo.toml:124` — `rusqlite = { features = ["bundled", "load_extension"] }` |

**And it is not just static analysis — `vec0.dll` loading is already proven at runtime on
a real Windows CI runner.** `.github/workflows/npm-release.yml:107-121` runs, on
`windows-latest`, for `x86_64-pc-windows-msvc`:

```bash
"$BIN" --help >/dev/null                     # neurovault-server.exe starts
"$BIN" --port 8799 &                         # axum binds 127.0.0.1:8799
curl -fsS http://127.0.0.1:8799/api/version | grep -q '"version"'
curl -fsS -X POST .../api/brains -d '{"name":"smoke"}'
curl -fsS http://127.0.0.1:8799/api/brains/smoke/stats | grep -q '"brain_id"'
#  ^ opening brain.db is exactly the path that calls load_extension(vec0)
```

That single job is the strongest Windows evidence in the repo. It proves, on Windows:
the binary starts, the axum server binds loopback, HTTP round-trips, SQLite opens, and
**`vec0.dll` loads via `LoadLibraryW`**. It also implies loopback binds on Windows do not
need a firewall exception (no prompt could be answered on a headless runner).

The gap: this covers the **npm/headless** distribution, not the **desktop installer**.
Nothing verifies that `resources\vec0.dll` and `neurovault-server.exe` actually make it
inside the NSIS installer — which is precisely the regression recorded at
`CHANGELOG.md:438-440`.

**Residual risks (SUSPECTED, verify at runtime):**
- **Windows-on-ARM is unsupported.** Only an x86-64 `vec0.dll` exists and there is no
  `aarch64-pc-windows-msvc` matrix entry. An ARM64 build would start and then fail every
  brain open — the exact failure mode already documented for Intel Mac
  (`release.yml:66-71`). If Dath's Windows box is ARM (Surface/Snapdragon X), the app runs
  under x64 emulation or not at all. **Check `$env:PROCESSOR_ARCHITECTURE` first.**
- `sqlite3_load_extension` on Windows calls `LoadLibraryW`. If Defender/AppLocker/WDAC
  blocks a DLL load from `%LOCALAPPDATA%`, every brain open fails with a cryptic
  `rusqlite` error. Watch for it on a managed/enterprise machine.

---

### 2.1 CONFIRMED defects

Ordered by user impact.

---

#### C1 — Claude Code hook installation is **impossible** on Windows (three independent blockers)

This is the single biggest functional gap. The ambient-recall / auto-recall feature
(`docs/specs/ambient-recall.md`) cannot be turned on at all on Windows.

**C1a — the shell-safety guard rejects every Windows path.**
`src-tauri/src/memory/hooks.rs:858-863`:

```rust
let bin_str = binary.display().to_string();
if bin_str.contains(['"', '$', '`', '\\']) {          // ← '\\' is EVERY Windows path
    return Err(MemoryError::Other(format!(
        "binary path contains shell-special characters and cannot be installed safely: {bin_str}"
    )));
}
```

The snapshot path is always `nv_home().join("bin")` (`hooks.rs:838-840`) =
`C:\Users\dath\.neurovault\bin\neurovault-hook`. It contains `\`, so
`install_hooks_at` returns `Err` **100 % of the time on Windows**. Fails closed with a
confusing message — no lockout risk, but no feature either.

**C1b — the snapshot has no `.exe` suffix.** `hooks.rs:813`:

```rust
let dest = snapshot_dir.join("neurovault-hook");   // ← no .exe on Windows
```

Even if C1a were fixed, Windows `CreateProcess` will not execute an extensionless file
(and `PATHEXT` resolution does not apply to absolute paths).

**C1c — no fail-open on Windows.** `hooks.rs:790`:

```rust
let fail_open = if cfg!(windows) { "" } else { " || true" };
```

`UserPromptSubmit` is the hook that can **block a prompt**. On Unix the ` || true` suffix
guarantees exit 0 even from a stale/missing binary — the mitigation added after the
2026-07-07 lockout incident. Windows has no equivalent. **Do not enable Windows hooks
until a Windows fail-open exists**, or you reintroduce that incident on a new platform.

**Fix sketch (all three together):**

```rust
// C1b
let dest = snapshot_dir.join(if cfg!(windows) { "neurovault-hook.exe" } else { "neurovault-hook" });

// C1a — validate the LEAF, not the whole path; the path is already quoted in the command.
let leaf = binary.file_name().and_then(|s| s.to_str()).unwrap_or("");
if leaf.contains(['"', '$', '`']) || (cfg!(unix) && leaf.contains('\\')) { /* reject */ }

// C1c — cmd.exe fail-open, or (better) guarantee the hook binary itself exits 0.
let fail_open = if cfg!(windows) { " & exit /b 0" } else { " || true" };
```

**Fourth, Windows-only hazard in the same function** (`hooks.rs:816-819`): the copy is
`tmp` → `fs::rename(&tmp, &dest)`. On Windows that is `MoveFileEx` with
`MOVEFILE_REPLACE_EXISTING`, which **fails with a sharing violation if the destination
`.exe` is running or memory-mapped**. Reinstalling hooks while a Claude Code session has
the hook mid-flight will error. Retry-with-backoff, or rename-old-aside-first.

**Do not touch `~/.claude/settings.json` on the Windows box without asking Dath first** —
that is a documented hard rule (global/cross-session state), and this is precisely the
file the 2026-07-07 incident involved.

---

#### C1.5 — Privacy leak: POSIX absolute paths are not scrubbed from the journal on Windows

**`src-tauri/src/memory/handlers/mod.rs:1813-1826`**

```rust
fn looks_like_absolute_path(value: &str) -> bool {
    let windows_drive_absolute = /* C:\ or C:/ */;
    std::path::Path::new(value).is_absolute()          // ← FALSE for "/Users/..." on Windows
        || /* file:// */
        || value.starts_with("\\\\")
        || value.starts_with("//")
        || windows_drive_absolute
}
```

`sanitize_legacy_outcome_fields` (`handlers/mod.rs:1831`) uses this to strip raw
filesystem paths out of journal `source_refs` before they are persisted. On Windows,
`Path::new("/Users/alex/secret-client/notes").is_absolute()` is **false** (a Windows
absolute path needs a drive prefix or UNC root), and none of the other arms match — so a
bare POSIX path **is written to the journal verbatim**.

This is not hypothetical on a Windows box: WSL paths, mounted-share paths, and
journal entries synced or imported from a Mac all take this shape. It is a direct
violation of the guarantee the function exists to provide.

The existing test `legacy_outcomes_drop_raw_paths_but_keep_causal_references`
(`handlers/mod.rs:2117`, fixture at `:2125`, assert at `:2138`) **will fail on Windows** —
which is exactly right; it is catching a real bug.

**Fix (one line):**

```rust
std::path::Path::new(value).is_absolute()
    || value.starts_with('/')          // ← POSIX absolute, regardless of host OS
    || /* … */
```

---

#### C2 — "Reveal in file manager" opens the wrong folder on Windows

**`src-tauri/src/app.rs:892-898`**

```rust
Command::new("explorer")
    .args(["/select,", &path])      // ← two separate argv entries
```

**Failure:** `explorer.exe` requires `/select,<path>` as **one** token. Split into two, and
with Rust's standard MSVC argv quoting applied on top, Explorer sees a bare `/select,`,
ignores it, and opens the default folder (usually Documents). The user clicks
"reveal my MCP config" and lands somewhere unrelated.

**Fix** — one argument, and prefer `raw_arg` because Explorer does not use the standard
CRT command-line parser:

```rust
#[cfg(target_os = "windows")]
{
    use std::os::windows::process::CommandExt;
    Command::new("explorer")
        .raw_arg(format!("/select,\"{}\"", path.replace('/', "\\")))
        .spawn()
        .map_err(|e| format!("explorer failed: {e}"))?;
    Ok(())
}
```

Note the `/` → `\` normalisation: Explorer's `/select` **will not** accept forward
slashes even though the rest of Windows does.

---

#### C3 — The Settings → Connections "copy this command" is broken on Windows

**`src/lib/mcpConfig.ts:61-67`**

```ts
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;        // POSIX quoting, unconditionally
}
export function claudeCodeMcpCommand(sidecarPath: string): string {
  return `claude mcp add --scope user neurovault ${shellQuote(sidecarPath)} -- --mcp-only`;
}
```

There is **no platform branch**, and the unit test at `src/lib/mcpConfig.test.tsx:30`
locks in the POSIX form.

**Failure:** the generated command is
`claude mcp add --scope user neurovault 'C:\Program Files\NeuroVault\neurovault-server.exe' -- --mcp-only`.
In **cmd.exe** single quotes are not quote characters at all, so the argument becomes the
literal `'C:\Program` and the command fails. In **PowerShell** single quotes do quote, but
the `'\''` escape sequence is POSIX and wrong (PowerShell escapes an inner `'` as `''`).

**Fix:** branch on platform and emit `"C:\\..."` double-quoted for Windows, or side-step
quoting entirely by writing the JSON config (which *is* correct — see below) and telling
the user to paste that instead.

**Good news, verified:** `standardMcpJson` / `claudeCodeMcpJson` / `vscodeMcpJson`
(`mcpConfig.ts:13-49`) all go through `JSON.stringify`, so Windows backslashes **are**
correctly escaped to `\\` in the emitted JSON. The classic "unescaped backslash in
mcpServers JSON" bug is **not** present. `continueMcpYaml` (`mcpConfig.ts:51-59`) also
uses `JSON.stringify` for the path — fine. `vscodeMcpJson` correctly emits `servers`
rather than `mcpServers`. Only the shell-command variant is broken.

**Related test gap:** `src/lib/mcpConfig.test.tsx:11` uses only the fixture
`"/Applications/Neuro Vault's.app/Contents/neurovault-server"` — there is no
`C:\Program Files\…` case anywhere. Add one when you fix `shellQuote`.

**Related UI gap:** `ConnectionsCenter.tsx:149` prints "`~/.claude.json`" and `:181` prints
"`~/.cursor/mcp.json`" as literal strings on every platform. (By contrast `:166` resolves
the Claude Desktop path natively from the backend — do that for the other two.)

---

#### C4 — Four binary lookups omit the `.exe` suffix, so they never resolve on Windows

| Site | Code | Consequence |
|---|---|---|
| `employee.rs:722` | `dir.join("claude")` | The Claude CLI on Windows `PATH` is `claude.cmd` (npm shim) or `claude.exe`. `find_claude` returns `None` → every AI-Employee run logs `"claude CLI not found"` |
| `employee.rs:737` | `exe_dir.join("neurovault-server")` | `neurovault_server_path` returns `None` → deep runs silently lose their `--mcp-config` (`employee.rs:1032-1042`) |
| `employee.rs:745` | PATH scan, same string | same |
| **`hooks.rs:1008`** | `exe_dir.join("neurovault-server")` | `server_binary_path()` fails for any caller that is not itself the server |
| **`hooks.rs:1016`** | PATH scan, same string | same |

`hooks.rs` partially survives by luck: the self-detection branch at `hooks.rs:1000-1006`
uses `exe.file_stem()`, which strips `.exe`, so `neurovault-server hook install`
self-registers correctly. Every *other* caller of `server_binary_path()` fails. The
Settings toggle is unaffected — `app.rs:703` routes through `mcp_sidecar_path()`, which
*does* handle `.exe` (`app.rs:734-738`).

Even once the lookup is fixed there is a second Windows trap: since Rust 1.77,
`Command::new("something.cmd")` will not launch a batch file. Any fix must route `.cmd`
through `Command::new("cmd").args(["/C", …])`.

**Severity note:** the Employees feature is **excluded from the public base build** —
`http_server.rs:143-147` has the scheduler call commented out and `App.tsx` gates it
behind `EMPLOYEES_ENABLED`. The `employee.rs` half is dormant; the `hooks.rs` half is not.

**Fix:** one shared helper.

```rust
fn exe_names(stem: &str) -> Vec<String> {
    if cfg!(windows) { vec![format!("{stem}.exe"), format!("{stem}.cmd"), format!("{stem}.bat")] }
    else { vec![stem.to_string()] }
}
```

---

#### C4.5 — A blocked port reports the wrong diagnosis on Windows

**`src-tauri/src/memory/http_server.rs:118-138`**

The bind-failure self-heal branches only on `ErrorKind::AddrInUse`. Anything else falls
through to the generic error at `:137`, whose message tells the user to run
`netstat -ano | findstr :8765`.

**Failure:** on Windows, Hyper-V / WSL2 / Docker Desktop reserve TCP port blocks through
HNS. Binding inside a reserved block fails with **WSAEACCES (10013)** — mapped to
`ErrorKind::PermissionDenied`, not `AddrInUse` — **and `netstat` shows nothing listening.**
The user follows the app's own advice, sees an empty result, and has no next step.
Reservations cluster around 2000–7000 and 49000+, so 8765 sits in a quiet band, but the
blocks are machine- and boot-dependent.

**Fix:** add a `PermissionDenied` arm pointing at the right command, and consider a port
fallback:

```rust
Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
    return Err(format!(
        "could not bind {addr}: {e}. On Windows this usually means Hyper-V/WSL2/Docker \
         reserved the port. Check: netsh interface ipv4 show excludedportrange protocol=tcp"
    ));
}
```

A port fallback would also need a handshake file (e.g. `~/.neurovault/port`) that the MCP
shim reads, since `forward.rs:24` hardcodes `http://127.0.0.1:8765` as `DEFAULT_BASE`.

---

#### C5 — Windows-reserved device names break brain creation and wiki compilation

**`src-tauri/src/memory/handlers/mod.rs:7132-7141`** (brain id) and
**`handlers/mod.rs:6514` / `6597`** (`wiki/{slug}.md`).

The brain-id generator keeps only `[a-z0-9]` plus `-`/`_`, so it correctly strips
`: * ? " < > |`. But it happily produces the Windows **reserved device names**:

| User types | Generated id | Windows result |
|---|---|---|
| `Con` / `CON` | `con` | `create_dir_all(...\brains\con)` → `ERROR_INVALID_NAME` |
| `Aux`, `Nul`, `Prn` | `aux`, `nul`, `prn` | same |
| `COM1`…`COM9`, `LPT1`…`LPT9` | `com1`… | same |

Same for compilation: `compile_submit` writes `wiki/{slug}.md` with a **bare** slug
(`handlers/mod.rs:6597`), so a topic of "aux" produces `wiki\aux.md`, which cannot be
created on Windows (reserved names apply regardless of extension).

Note this does **not** affect ordinary notes: `create_note`
(`write_ops.rs:324-327`) and MCP `remember` (`handlers/mod.rs:3756-3758`) always append
`-{uuid8}.md`, so `con` becomes `con-a1b2c3d4.md` — safe.

**Fix:** one shared guard used by both call sites.

```rust
const WIN_RESERVED: &[&str] = &["con","prn","aux","nul",
    "com1","com2","com3","com4","com5","com6","com7","com8","com9",
    "lpt1","lpt2","lpt3","lpt4","lpt5","lpt6","lpt7","lpt8","lpt9"];
fn windows_safe_stem(s: &str) -> String {
    let base = s.trim_end_matches([' ', '.']);            // Windows also strips these
    if WIN_RESERVED.iter().any(|r| base.eq_ignore_ascii_case(r)) { format!("{base}_") } else { base.to_string() }
}
```

`read_ops::is_safe_brain_id` (`read_ops.rs:133-144`) is the natural place to *reject*
them on input; the generator is the place to *rename* them.

---

#### C6 — `scripts/gates.sh` will not run: no `.gitattributes`

**Repo root has no `.gitattributes`** (verified). With Git for Windows' default
`core.autocrlf=true`, every text file is checked out with CRLF — including
`scripts/gates.sh` and `scripts/verify-macos-release.sh`.

**Failure:** `bash scripts/gates.sh` → `$'\r': command not found`, `set -euo pipefail`
fails, the gate dies on line 1.

**Fix (repo-level, benefits every platform):** add a `.gitattributes`:

```
* text=auto eol=lf
*.sh   text eol=lf
*.png  binary
*.ico  binary
*.icns binary
*.dll  binary
*.dylib binary
*.so   binary
```

**Immediate workaround on the Windows box:** `git config core.autocrlf input` **before**
cloning, or `git config core.eol lf` then `git rm --cached -r . && git reset --hard`.

Also note `make gate` and `make clean` are Git-Bash-only (`rm -rf`, `#!/usr/bin/env bash`,
and the inline `TAURI_CONFIG='…' cargo clippy` bash assignment). `make` itself is not
installed on Windows by default.

---

### 2.2 SUSPECTED defects — verify at runtime on Windows

---

#### S1 — WSL breaks the whole MCP story (highest-probability real-world failure)

The MCP server forwards to `http://127.0.0.1:8765` on the machine it runs on
(`src-tauri/src/memory/mcp/forward.rs`, autostart at `mcp/mod.rs:105-145`).

If Dath runs the **desktop app on Windows** but **Claude Code inside WSL2**, the WSL
guest's `127.0.0.1` is *not* the Windows host's. WSL2 → Windows-host loopback only works
with **mirrored networking mode** (Windows 11 22H2+, `networkingMode=mirrored` in
`.wslconfig`); otherwise the guest must dial the host IP from
`/etc/resolv.conf` or `$(hostname).local`. Meanwhile `mcp/mod.rs` would see no backend and
**autostart a second, Linux-side headless backend** with a *separate*
`~/.neurovault` — two brains, silently diverging.

**Verify:** decide up front whether the Windows session is native or WSL, and state it in
every MCP instruction. Native Windows Claude Code is the supported path.

---

#### S2 — Long note titles produce unopenable files

`remember` truncates an **auto-derived** title to 60 chars (`handlers/mod.rs:3727`), but a
**caller-supplied** `title` is not truncated at all (`handlers/mod.rs:3722-3724`), and
`slug::slugify` does not truncate. A 400-char title → a ~410-char single filename
component.

Windows' per-component limit is 255 chars (same as APFS/ext4, so this is only *worse* on
Windows, not unique to it) — but Windows adds the 260-char **total** `MAX_PATH` ceiling.
Rust's std does prepend `\\?\` for long absolute paths, which relieves `MAX_PATH` but not
the component limit. A Windows user with a long profile name plus a nested vault folder is
closer to the edge than a Mac user.

**Fix:** clamp the slug in both `write_ops.rs:324` and `handlers/mod.rs:3756`:
`let slug: String = slug::slugify(&title).chars().take(80).collect();`

---

#### S3 — Filename case-collision on a case-insensitive filesystem

`engrams.filename` is a plain SQLite `TEXT` primary lookup key, and SQLite `=` on TEXT is
case-**sensitive**. NTFS is case-**insensitive**. So `Notes/Foo.md` and `notes/foo.md`
are one file on disk but potentially two rows in the DB.

The realistic trigger: a note is created as `agent/Foo-abc12345.md`, the user renames the
folder's case in Explorer, and the watcher re-ingests under the new casing. Result:
duplicate engrams, an orphaned row whose file "no longer exists" per the pass-2
reconciliation at `handlers/mod.rs:4079-4083`.

**Verify:** create `A.md`, rename to `a.md` in Explorer, check `SELECT filename FROM engrams`.
**Fix if real:** normalise the stored key with `to_lowercase()` on Windows, or add
`COLLATE NOCASE` to the filename index — but that changes the schema, so measure first.

---

#### S4 — `notify` v6 behaviour differences on Windows

`watcher.rs:96-124` uses `RecommendedWatcher` + `RecursiveMode::Recursive` with a 500 ms
per-file debounce. On Windows the backend is `ReadDirectoryChangesW`, which differs from
FSEvents/inotify in ways that matter here:

- **Atomic saves.** VS Code / Obsidian on Windows write `file.tmp` then `MoveFileEx` over
  the target. That surfaces as `Modify(Name(From))` + `Modify(Name(To))`, not the
  `Create`/`Modify` the vault worker expects. The source-folder worker
  (`watcher.rs:236-268`) explicitly acknowledges rename ambiguity; the **vault** worker
  may miss the event entirely → an external edit that never gets ingested.
- **File locking.** Windows can report the change before the writer releases the handle;
  `ingest_file`'s `read_to_string` (`ingest.rs:161`) then fails with a sharing violation.
  The 500 ms debounce probably covers it, but not under load.
- **Buffer overflow.** `ReadDirectoryChangesW` drops events if the kernel buffer fills
  during a bulk operation (unzipping a vault, a git checkout). `notify` surfaces this as
  an error the callback at `watcher.rs:98-108` silently discards
  (`if let Ok(event) = res`). A bulk import can be partially indexed with no diagnostic.

**Verify:** save from Notepad, from VS Code, and drop 200 `.md` files at once; then
compare `SELECT count(*) FROM engrams` against the file count.
**Mitigation to consider:** a periodic full reconcile (the machinery already exists at
`handlers/mod.rs:4060-4095`).

---

#### S5 — `mmap_size=268435456` + Windows file locking

`db.rs:207` sets `PRAGMA mmap_size=268435456` (256 MB). On Windows a memory-mapped file
cannot be deleted or renamed while mapped. `db.rs:137` already does
`PRAGMA mmap_size=0; PRAGMA wal_checkpoint(TRUNCATE);` before some operations, which
suggests this was hit before. Watch for "brain delete" / "optimize disk" / "reindex"
failing with a sharing violation on Windows.

---

#### S6 — `ort`/ONNX Runtime static linking on Windows (probability now LOW, but unproven)

`Cargo.toml:137-140` uses `fastembed` with `ort-download-binaries`. The comment claims
static linking, but the verification cited is `otool` — **macOS only**. If ORT resolves to
a dynamic `onnxruntime.dll` on MSVC, that DLL is **not** in `bundle.resources` and the
installed app would fail with a missing-DLL error.

**Evidence that lowers the probability:** `npm-release.yml:107-121` successfully runs
`neurovault-server.exe --help` on `windows-latest` from a `bin/` directory containing only
the exe and `vec0.dll`. A dynamically-imported `onnxruntime.dll` would be resolved from
the import table at process load and the process would fail to start.

**Evidence that keeps it open:** the "forbidden dynamic dependency" check in that same
workflow is **explicitly skipped on Windows** (`npm-release.yml:95` —
`if: runner.os != 'Windows'`, with the comment *"No otool/ldd on Windows"*). Nobody has
ever inspected the Windows binary's imports. And the smoke test runs from the *source
tree*, where a stray DLL could sit adjacent.

**Verify — this is a 30-second check and it gates everything:**
```powershell
dumpbin /dependents src-tauri\target\x86_64-pc-windows-msvc\release\neurovault.exe | Select-String -Pattern "onnx"
# no match = statically linked = fine.
# a match = you must add onnxruntime.dll to bundle.resources.
```

---

#### S6.5 — The MCP shim can blow the client's spawn budget (cross-platform, bites hardest on Windows)

**`src-tauri/src/memory/mcp/mod.rs:35-60`**

```rust
pub async fn run_stdio() -> ExitCode {
    let base = forward::resolve_base();
    ensure_backend(&base).await;               // ← can block ~30 s (mod.rs:117-138)
    …
    let service = handler.serve(stdio()).await // ← the MCP handshake only starts HERE
```

`ensure_backend` polls for backend health for up to 30 seconds (60 × 500 ms,
`mcp/mod.rs:133-138`) **before** the stdio transport is even created. During that window
the process is alive but answers no `initialize`.

Meanwhile: Claude Code's stdio connect timeout defaults to **5 s** (`MCP_TIMEOUT` raises
it), Claude Desktop reportedly has a hardcoded ~5 s spawn budget with no override, and
**neither restarts a failed stdio server automatically.** On Windows, process creation is
slower (~1.8 s per server, serialised), so a cold start with the desktop app closed is the
likeliest place this fires.

This is architecturally cross-platform, but the Windows session will meet it first.

**Fix:** serve stdio **first**, then warm the backend in a background task. The handler
already returns a clean tool-level error when the backend is down
(`forward.rs:609` — *"Open the NeuroVault desktop app…"*), so completing `initialize`
early costs nothing and is strictly better than failing the connection.

**Also check while you're in there:** `rmcp`'s stdio transport is tokio-based, and
`tokio::io::Stdout` does **not** inherit `std::io::Stdout`'s unconditional `LineWriter`
guarantee. Confirm the transport flushes after each message. (Rust's *std* stdout is
line-buffered even when piped, which is why this works today on Unix — don't assume tokio
matches it.) Cheapest high-value check on the list.

---

#### S7 — Cosmetic, but it's the Settings screen

The UI hardcodes POSIX display paths regardless of platform:
`src/components/SettingsView.tsx:430`, `:493`, `:753`, `:846` all render `~/.neurovault/…`;
`src/components/EmployeePanel.tsx:1264` renders `~/.neurovault/employee.json`;
`src/lib/tauri.ts:120` falls back to the literal string
`"~/.neurovault/brains/default/vault"`. A Windows user reading "put a file in
`~/.neurovault/`" has to translate. Add a platform-aware `dataRootLabel()` returning
`%USERPROFILE%\.neurovault\` on Windows.

Same class: `notify_hidden_once` (`app.rs:915-933`) writes the "memory keeps running in
the background" flag file on all platforms but only shows the notification on macOS
(`#[cfg(target_os = "macos")]` at `app.rs:927`). On Windows the window vanishes with no
explanation and the flag is consumed, so the user never gets told — even later.

---

### 2.3 Things I checked that are FINE on Windows (don't waste time re-auditing)

| Area | Evidence |
|---|---|
| Home-dir resolution | `paths.rs:37` uses `dirs::home_dir()` (→ `FOLDERID_Profile`, i.e. `%USERPROFILE%`), never `$HOME`. `$NEUROVAULT_HOME` / `$ENGRAM_HOME` overrides work identically (`paths.rs:26-44`). **Not** OneDrive-redirected. |
| Separator normalisation | Every `strip_prefix`→string conversion appends `.replace('\\', "/")`: `ingest.rs:169`, `app.rs:349-352`, `handlers/mod.rs:4081`, `handlers/mod.rs:4201`, `graphify.rs:238-241`, `source_mirror.rs:293-295`. The DB's `filename` key is consistently POSIX-style. |
| UNC `\\?\` from `canonicalize()` | `ingest.rs:163-167` canonicalizes **both** sides before `strip_prefix`, so the verbatim prefixes cancel. This is the one place it matters and it is done right. |
| Vault path traversal guard | `write_ops.rs:105-112` `safe_markdown_relative_path` rejects absolute paths and any non-`Normal` component — including a Windows `Prefix` (`C:`, `\\server\share`). |
| Brain id guard | `read_ops.rs:133-144` rejects `\` **explicitly**, with a comment naming this exact platform-split hazard. Genuinely good code. |
| Curator evidence capture | `adaptive/curator/evidence.rs:244-257` — the whole module is `#[cfg(unix)]` and Windows **fails closed** with `PlatformUnsupported` rather than shipping a check-then-open reparse-point race. Correct, and it means the curator feature is simply **absent** on Windows (a gap, not a bug). |
| Detached MCP autostart | `mcp/mod.rs:182-190` — `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` on Windows, `process_group(0)` on Unix. |
| Port self-heal | `port_recovery.rs:23-107` compiles on Windows (`netstat2` + `sysinfo` are gated `cfg(not(target_os = "linux"))`), and the kill guard `name_lc.starts_with("neurovault")` matches `neurovault.exe`. |
| Sidecar staging | `scripts/stage-sidecar.mjs` derives the host triple from `rustc -vV`, appends `.exe` on Windows, and passes `TAURI_CONFIG` via the `env:` option (no shell quoting involved). |
| Sidecar lookup at runtime | `app.rs:734-753` `mcp_sidecar_path()` tries `neurovault-server.exe` then `neurovault-server-x86_64-pc-windows-msvc.exe`. Tauri strips the triple on install, so candidate 1 hits. |
| Claude Desktop config path | `app.rs:765-772` uses `dirs::config_dir()` → `%APPDATA%\Claude\claude_desktop_config.json`. Correct. |
| MCP JSON generation | `src/lib/mcpConfig.ts` uses `JSON.stringify` throughout → backslashes escaped correctly. |
| CRLF content handling | Every `split('\n')` site immediately `.trim()`s the line, which eats the stray `\r`: `chunker.rs:75,88,157`, `ingest.rs:69-72`. Titles, chunks and sentences survive CRLF markdown. |
| No elevation needed | NSIS defaults to `installMode: currentUser` → `%LOCALAPPDATA%`; data at `%USERPROFILE%\.neurovault`; deep link registers under `HKCU\Software\Classes`. |
| Single-instance ordering | `app.rs:1602` registers `single_instance` **before** `deep_link` (`app.rs:1619`) — required by the plugin docs, and it's the plugin that makes `neurovault://` work on Windows at all. |
| Path equality in tests | `PathBuf`/`Path` `PartialEq` compares `components()`, and Windows treats `/` and `\` as equivalent separators — so tests like `write_ops.rs:491-494` that compare a `/`-literal against a `with_file_name()` result still pass. |
| Updater | `docs/UPDATER-SETUP.md:34-36` is right: the Tauri updater signs with minisign (`TAURI_SIGNING_PRIVATE_KEY`) and does **not** need Authenticode. Windows `installMode` defaults to `passive`. |


---

## Section 3 — The Windows test plan

### 3.1 Manual verification checklist

Run in order. Record pass/fail for each — this list is the Windows parity evidence.

**Pre-flight**
- [ ] `$env:PROCESSOR_ARCHITECTURE` — must be `AMD64`. If `ARM64`, **stop and read §2.0**: there is no ARM64 `vec0.dll` and no ARM64 build target.
- [ ] `winver` — note Windows 10 vs 11 (WebView2 is only guaranteed on 11).
- [ ] Decide and record: **native Windows or WSL?** Everything MCP-related depends on this (§2 S1). Native is the supported path.

**Install**
- [ ] Download `NeuroVault_0.6.1_x64-setup.exe` from the GitHub release. Confirm the SmartScreen "Windows protected your PC" prompt appears (expected today) and that **More info → Run anyway** works.
- [ ] Verify the SHA-256 against the release, and `gh attestation verify` the Sigstore provenance.
- [ ] Installer completes **without a UAC prompt** (NSIS defaults to `installMode: currentUser`). If UAC appears, the default changed — investigate.
- [ ] Confirm the installed layout: `%LOCALAPPDATA%\NeuroVault\NeuroVault.exe`, `…\neurovault-server.exe`, `…\resources\vec0.dll`. **If `vec0.dll` is missing, everything below fails** — that is the single highest-value check in this list.
- [ ] `dumpbin /dependents "%LOCALAPPDATA%\NeuroVault\NeuroVault.exe" | findstr /i onnx` → expect **no match** (§2 S6).
- [ ] Also install the `.msi` on a clean VM if you want MSI parity; note whether VBSCRIPT was needed.

**First run**
- [ ] App window opens; no missing-DLL dialog.
- [ ] Note whether **Windows Firewall prompts** for the `127.0.0.1:8765` bind. It should not (loopback-only listeners are not filtered), but record what actually happens — a prompt here would be a first-run blocker for every user.
- [ ] `Invoke-RestMethod http://127.0.0.1:8765/api/health` returns OK.
- [ ] `%USERPROFILE%\.neurovault\` is created, with `brains.json` and `brains\<id>\`. Confirm it is **not** inside a OneDrive-redirected folder.
- [ ] Watch stderr / the log for a `vec_version` line — proves `vec0.dll` loaded via `LoadLibraryW`.
- [ ] First recall downloads the ~130 MB BGE model to `%USERPROFILE%\.neurovault\.fastembed_cache\`. Time it; note Defender impact.

**Notes and the vault**
- [ ] Create a note from the UI. Confirm the file appears in `…\brains\<id>\vault\` with a `slug-<uuid8>.md` name.
- [ ] Create a note titled with Windows-illegal characters: `a : b * c ? d " e < f > g | h`. Expect the slug to strip them (`slug::slugify` is ASCII-only). **Verify the file actually exists on disk.**
- [ ] Create a note with a very long title (300+ chars). Expect either a clamp or a clear error — **not** a silent failure (§2 S2).
- [ ] **Create a brain named `Aux`** (and `Con`). Expect failure today (§2 C5). Record the error message the user sees.
- [ ] Edit a note in **Notepad** (writes CRLF), save, confirm re-ingest picks it up and the title is right.
- [ ] Edit the same note in **VS Code** (atomic rename save) — confirm the watcher fires (§2 S4).
- [ ] Drop 200 `.md` files into the vault at once; compare the file count against `SELECT count(*) FROM engrams`.
- [ ] Create a note in a subfolder (`agent\foo.md`). Confirm the DB stores `agent/foo.md` with a **forward** slash, and that the folder tree renders in the UI.
- [ ] Rename a note's case in Explorer (`A.md` → `a.md`); check for duplicate engrams (§2 S3).
- [ ] Delete a note → trash → restore. Confirm the round-trip.

**Recall / graph**
- [ ] `recall` returns hits with sensible scores.
- [ ] Open the graph view; nodes and edges render.
- [ ] Quick capture: **Ctrl+Shift+Space** (`app.rs:1587` selects `CONTROL` on non-macOS). Confirm registration succeeded in the log, and that it works when the window is unfocused.
- [ ] `neurovault://engram/<id>` from `Start-Process` — deep link should focus the running app, not spawn a second one (`app.rs:1602`). Note: deep links only work for the **installed** app, never in `tauri dev`.
- [ ] Close the window (not quit) — confirm memory keeps running, and note that **no notification is shown on Windows** (§2 S7).
- [ ] Kill the app with Task Manager, relaunch — port self-heal should reclaim `:8765` (`port_recovery.rs`).

**MCP**
- [ ] See §3.3 below.

**Uninstall**
- [ ] Uninstall via Settings → Apps. Confirm `%LOCALAPPDATA%\NeuroVault\` is removed.
- [ ] Confirm `%USERPROFILE%\.neurovault\` is **preserved** (user data must survive uninstall).
- [ ] Confirm the `neurovault://` registry entry under `HKCU\Software\Classes` is removed (or note if it leaks).
- [ ] Reinstall and confirm the existing brain is picked back up.

### 3.2 Automated tests: what to run and what will fail

```powershell
cd src-tauri
cargo test --no-default-features
```

**Counts** (from a static audit of all 326 `#[test]`/`#[tokio::test]` functions):

| | Linux CI today | Windows |
|---|---|---|
| Compiled | 321 | **313** |
| Executed | 321 | **310** (3 are `#[ignore]`d) |
| `#[cfg(unix)]`-gated off | 0 | **13** |
| Newly enabled (never run in CI before) | — | **2** |
| **Predicted failures** | 0 | **6** |
| **Predicted false passes** | — | **2** |
| **Clippy `-D warnings` blockers** | 0 | **4** |

**Good news first: there are ZERO compile errors.** Every `use std::os::unix::*` is inside
a `#[cfg(unix)]` block, and although `libc = "0.2"` is an unconditional dependency
(`Cargo.toml:164`), all five `libc::` call sites are `cfg(unix)`-gated. The test binary
builds on `x86_64-pc-windows-msvc`.

**Blocker before anything else: `cargo clippy --all-targets -- -D warnings` fails on 4
`dead_code` warnings.** This is the CI gate at `ci.yml:105-109`, so it is effectively a
build break for the pipeline:

| Item | file:line | Warning |
|---|---|---|
| `open_turn` helper | `handlers/mod.rs:1992` | `dead_code` — all 7 call sites are in `cfg(unix)` tests |
| `journal_text` helper | `handlers/mod.rs:2006` | `dead_code` — all 6 call sites are in `cfg(unix)` tests |
| `CapturePolicy.configured_claude_projects_root` | `curator/evidence.rs:66` | field never read (reads at `:282`, `:291` are `cfg(unix)`) |
| `CapturePolicy.resolved_claude_projects_root` | `curator/evidence.rs:70` | field never read (reads at `:295`, `:315` are `cfg(unix)`) |

Fix the helpers with `#[cfg(unix)]`; fix the fields with the `let _ = _policy.field;` trick
already used at `evidence.rs:255`.

**Predicted runtime failures (6)** — all real bugs, not test artifacts:

| Test | file:line | Why it fails | Root cause |
|---|---|---|---|
| `install_is_idempotent_and_preserves_existing_hooks` | `hooks.rs:1056` | `.unwrap()` panic | **C1a** — `hooks.rs:859` rejects `\` |
| `uninstall_removes_only_ours` | `hooks.rs:1089` | panic | C1a |
| `install_replaces_stale_binary_path` | `hooks.rs:1111` | panic | C1a |
| `uninstall_sweeps_every_event_not_a_hardcoded_list` | `hooks.rs:1258` | panic | C1a |
| `install_rejects_shell_special_binary_paths` | `hooks.rs:1468` | asserts `is_ok()` | C1a |
| `legacy_outcomes_drop_raw_paths_but_keep_causal_references` | `handlers/mod.rs:2117` | assert at `:2138` | **C1.5** — the privacy leak |

Five of six trace to a single line. **Fix `hooks.rs:859` and `handlers/mod.rs:1820` and the
suite goes green.**

**Predicted false passes (2)** — these pass on Windows for the *wrong reason*; tighten them:

| Test | file:line | Why it's hollow |
|---|---|---|
| `corrupt_settings_is_an_error_not_a_clobber` | `hooks.rs:1135` | asserts `is_err()`, but on Windows it errors on the backslash check and never reaches the JSON parse it is meant to test. Assert on the message. |
| `restore_paths_must_stay_inside_the_vault` | `write_ops.rs:485` | `!path.is_absolute()` is **true** for `/tmp/note.md` on Windows; only the `Component::Normal` check at `:109-111` saves it. Add a `has_root()` assertion. |

**13 tests silently vanish on Windows** — this is the real coverage hole, and it is worse
than the count suggests:

- `curator/evidence.rs`: `:567`, `:595`, `:632`, `:656`, `:723`, `:738`, `:793` (symlink), `:825` (symlink), `:859` (**mkfifo**) — 9 tests
- `handlers/mod.rs`: `:2157`, `:2255`, `:2339` (symlink), `:2432` — 4 tests
- Plus a hidden inner skip: `wrong_host_event_or_missing_turn_never_reads_evidence` (`evidence.rs:879`) *runs* on Windows, but its relative-path `InvalidPath` case is behind `#[cfg(unix)]` at `:903`.

On Windows the entire `capture_transcript` implementation (`evidence.rs:259-506` —
`O_NOFOLLOW` `openat` traversal, symlink rejection, FIFO rejection, two-pass hash
stability, private-path filtering) is replaced by a 13-line stub returning
`PlatformUnsupported`. **State it plainly: curator evidence capture is unimplemented on
Windows, not merely untested.** That is documented and deliberate
(`evidence.rs:252-254`), not an oversight.

**2 tests execute on Windows for the first time ever** — neither has run in any CI:
`evidence.rs:931` (`cfg(not(unix))`, should pass) and `port_recovery.rs:126`
(`cfg(all(test, not(target_os = "linux")))`, uses `GetExtendedTcpTable`; treat the first
run as unvalidated and watch for flake).

**Latent UNC hazard, not yet live.** Five sites canonicalize a fresh temp dir —
`evidence.rs:522` (the `fixture()` helper) and `handlers/mod.rs:2172`, `:2270`, `:2356`,
`:2447` — which on Windows returns `\\?\C:\…`. Today the four handler sites are inside
`cfg(unix)` tests, and the two Windows-running tests that call `fixture()`
(`evidence.rs:617`, `:879`) never compare the canonical path. **The moment anyone lifts a
`cfg(unix)` gate, `strip_prefix` and `components()` will hit
`Component::Prefix(VerbatimDisk)` and break.** Treat this as a porting prerequisite for
any Windows curator work.

**Frontend tests:** 40 vitest/tsx suites, all platform-clean. One runner break:
`scripts/run-lib-tests.mjs:76` calls `execFileSync("npx", …)` — on Windows `npx` is
`npx.cmd` and there is no `shell: true`, so `npm run test:lib` dies with ENOENT. Fix:
`shell: process.platform === "win32"`. `scripts/gates.sh:59` invokes it, so the gate
inherits the failure (on top of the CRLF shebang problem, §2 C6).

**Also expect `cargo fmt --check` to fail on every file** if you cloned with the default
`core.autocrlf=true` — rustfmt normalizes to LF. See §2 C6.

**Environment risk, not a Unix assumption:** `retrieval_integration.rs:268`,
`adaptive_scenario.rs:35` and `notes_scope.rs:12` need the fastembed ONNX model and ORT
libraries. Cache them the way `npm-release.yml:90` already does, or first run is slow and
network-dependent.

### 3.3 The MCP verification sequence

**First, decide native vs WSL and write it down.** If Claude Code runs in WSL and the app
runs on Windows, they cannot see each other's `127.0.0.1:8765` and you will silently end
up with two brains (§2 S1). The supported path is **native Windows Claude Code**.

**Where the binary actually is — and it depends on which installer you ran.**
`tauri.conf.json:66-68` declares `"externalBin": ["binaries/neurovault-server"]`. Tauri
stages it as `neurovault-server-x86_64-pc-windows-msvc.exe` at build time
(`scripts/stage-sidecar.mjs`) and **strips the triple on install**
(verified in tauri-bundler: `nsis/mod.rs:857-870` and `msi/mod.rs:924-932` both do
`.replace(&format!("-{}", settings.target()), "")`).

Because `bundle.targets` is `"all"`, **every release ships two installers that put the
binary in two different places**:

| Installer | Install root | Evidence |
|---|---|---|
| **NSIS** `.exe` (default, per-user, no admin) | `%LOCALAPPDATA%\NeuroVault\neurovault-server.exe` | `nsis/installer.nsi:513-514` — `currentUser` ⇒ `$INSTDIR = $LOCALAPPDATA\${PRODUCTNAME}`; the repo sets no `bundle.windows.nsis` override |
| **MSI/WiX** `.msi` | `C:\Program Files\NeuroVault\neurovault-server.exe` | `msi/main.wxs:121-122` — `INSTALLDIR` under `ProgramFiles64Folder\{{product_name}}` |

**Any hard-coded path in a doc will be wrong for half of users.** Always tell users to copy
the path from Settings → Connections, which calls `mcp_sidecar_path()`
(`app.rs:734-753`) — it resolves `current_exe().parent()` and tries
`neurovault-server.exe` first, then the triple-suffixed name, so it is correct under both.

**Config file locations on Windows** (the app computes the first two itself):

| Client | Path | Confidence |
|---|---|---|
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` | ✅ confirmed verbatim in the [official MCP user quickstart](https://modelcontextprotocol.io/quickstart/user); matches `app.rs:765-772` (`dirs::config_dir()` → `FOLDERID_RoamingAppData`). Reachable via *Settings → Developer → Edit Config* |
| Claude Code (user scope) | `%USERPROFILE%\.claude.json` — the file at the home-dir **root**, not inside `.claude\` | ✅ Claude Code docs state verbatim: *"On Windows, `~/.claude.json` resolves to `%USERPROFILE%\.claude.json`"*. Matches `app.rs:788-793` |
| Claude Code (project scope) | `.mcp.json` at the repo root | ✅ documented |
| Cursor | `%USERPROFILE%\.cursor\mcp.json` (global) or `.cursor\mcp.json` (project) | ⚠️ Cursor's docs only ever write `~/.cursor/mcp.json`; the `%USERPROFILE%` expansion is convention, not documented |
| VS Code / Copilot | `.vscode\mcp.json` (workspace); user file via *MCP: Open User Configuration*. Top key is **`servers`**, not `mcpServers` — `vscodeMcpJson()` (`mcpConfig.ts:36`) already gets this right | ✅ / ⚠️ user path secondary-sourced |

Paths Claude Code will **not** read (worth knowing, `docs/TROUBLESHOOTING.md:36-40` is right
about this): `~/.claude/.mcp.json`, `~/.claude/mcp.json`, `%APPDATA%\Claude\mcp.json`, and
an `mcpServers` key inside `~/.claude/settings.json`.

**The JSON to paste.** Backslashes must be doubled in JSON. The app's generator already
does this correctly (`mcpConfig.ts` runs everything through `JSON.stringify`), so **copy
from Settings rather than hand-typing**. For reference, the correct shape:

```json
{
  "mcpServers": {
    "neurovault": {
      "type": "stdio",
      "command": "C:\\Users\\dath\\AppData\\Local\\NeuroVault\\neurovault-server.exe",
      "args": ["--mcp-only"]
    }
  }
}
```

Forward slashes also work if you prefer them
(`"C:/Users/dath/AppData/Local/NeuroVault/neurovault-server.exe"`) — Windows accepts both
and it sidesteps the escaping question entirely.

**Do NOT use the "copy this command" button** — it is broken on Windows (§2 C3). The
correct PowerShell form is double-quoted:

```powershell
claude mcp add --scope user neurovault "C:\Users\dath\AppData\Local\NeuroVault\neurovault-server.exe" -- --mcp-only
```

Note the `cmd /c` wrapper that `dist-npm/README.md:31` and `dist-npm/WINDOWS-TEST.md:76`
describe applies to the **npm** entry point only. It exists because Windows cannot
`CreateProcess` a `.bat`/`.cmd` shim, and `npx`/`npm`/`uvx` all resolve to `.cmd`. It is
**not** needed for the bundled `neurovault-server.exe`, which is a real PE executable
spawned directly — which also means there is **no cmd.exe quoting or code-page surface at
all**, a genuine advantage over every `cmd /c npx` MCP server.

**Windows client gotchas to pre-empt** (ranked by how likely they are to eat an hour):

- 🔴 **Claude Desktop MSIX config-path trap.** On the MSIX build, the *Edit Config* button opens `%APPDATA%\Claude\claude_desktop_config.json`, but the app actually reads the virtualized `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json`. Symptom: edits look saved, the server never loads, logs are empty. Open issue, unacknowledged. NeuroVault's `mcp_config_path()` returns the documented `%APPDATA%` form, which may be the wrong one on MSIX. **Check both paths before debugging anything else.**
- 🔴 **Claude Code does not restart failed stdio servers.** Default connect timeout is 5 s; raise it with `$env:MCP_TIMEOUT="10000"; claude`. See §2 S6.5 — the shim currently waits up to 30 s *before* answering `initialize`.
- 🟠 **Never run `claude mcp add … -- cmd /c …` from Git Bash.** MSYS rewrites `/c` into `C:/` and saves a broken entry. Use PowerShell or cmd, or prefix `MSYS_NO_PATHCONV=1`.
- 🟠 **Console-window flash.** `neurovault-server.exe` is console-subsystem — and it must be: `main.rs:2` sets `windows_subsystem = "windows"` for the *GUI* app only, and a GUI-subsystem MCP server would get a null stdout handle whose writes **silently succeed**, hanging the handshake. The cost is that clients which don't pass `windowsHide` flash a console window per spawn. `"windowsHide": true` in the server entry is reported as a workaround — test before documenting.
- 🟠 **`claude mcp add-from-claude-desktop` does not work on native Windows** (macOS and WSL only, per the docs).
- 🟠 Relative paths in `command`/`args` resolve against the launch CWD, not the config file. Always absolute.

**Verification steps:**
- [ ] `& "$env:LOCALAPPDATA\NeuroVault\neurovault-server.exe" --help` → exits 0
- [ ] With the desktop app **running**, register the server and check the client reports "connected"
- [ ] The raw stdio chain (this is the thing that breaks on Windows) — adapted from `dist-npm/WINDOWS-TEST.md` §3:

```powershell
$env:NEUROVAULT_AUTOSTART = "0"
$lines = @(
  '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
  '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
)
$out = $lines | & "$env:LOCALAPPDATA\NeuroVault\neurovault-server.exe" --mcp-only 2>$null
$out   # EXPECT the 9 lite-tier tools. EMPTY output = the stdin/stdout chain is broken.
```

- [ ] In a Claude Code chat: `remember("windows smoke test")` then `recall("windows")`
- [ ] Tier switching: write `full` to `%USERPROFILE%\.neurovault\mcp_tier.txt` (resolved via `nv_home()` at `registry.rs:166-172` — Windows-correct), restart the client, confirm 55 tools
- [ ] **Autostart path**: quit the desktop app entirely, then invoke a tool. `mcp/mod.rs:105-145` should spawn a detached headless backend (`DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`, `mcp/mod.rs:187-190`) and become healthy within 30 s. Check `%USERPROFILE%\.neurovault\autostart.log`.
- [ ] Confirm **no Windows Firewall prompt** for the loopback bind (see below).

**Windows Firewall / loopback — researched answer: binding `127.0.0.1:8765` does NOT
prompt.** No single Microsoft sentence says so, but it assembles cleanly: the
"Windows Security Alert" dialog is a *listen-time* classification event; WFP classifies
binds at the `ALE_RESOURCE_ASSIGNMENT` / `ALE_AUTH_LISTEN` layers; WFP exposes
`FWP_CONDITION_FLAG_IS_NON_APPCONTAINER_LOOPBACK`, and there is a built-in permit filter
keyed on it. Microsoft scopes the loopback restriction explicitly to sandboxed apps:
*"By default, UWP applications aren't allowed to receive loopback traffic"* — NeuroVault is
an unpackaged Win32 app, so the permit filter applies.

Caveats that actually matter:
- 🔴 **`0.0.0.0` DOES prompt**, even if you only ever connect over loopback — classification happens at bind, before any peer connects. `http_server.rs:115` binds `([127,0,0,1], port)`, which is correct. **Never add a `0.0.0.0` fallback.**
- 🟠 Third-party firewalls (simplewall, Kaspersky, ESET) *can* filter loopback. Diagnostic tell: *connection refused* = app not running; *timeout* on loopback = third-party WFP filtering.
- 🟠 Unresolved: whether a user-created **block** rule for `neurovault-server.exe` overrides the loopback permit (WFP sublayer arbitration moved between Win10 and Win11). This matters because dismissing a firewall prompt auto-creates a block rule.
- 🟢 Port 8765 is safely **below** the Windows dynamic range (default start 49152). Verify per-machine with `netsh int ipv4 show dynamicport tcp`.
- 🟢 KB5066835 (Oct 2025) broke HTTP.sys loopback HTTP/2 — **axum/hyper binds a raw Winsock socket and never touches HTTP.sys**, so NeuroVault is structurally immune. Worth saying out loud.
- 🔴 But see §2 C4.5: Hyper-V/WSL2/Docker HNS port *reservations* fail with WSAEACCES, and the app currently misdiagnoses that.

**Alternative distribution worth testing separately:** `@neurovault/mcp` on npm gives the
same headless binary without the desktop app. `dist-npm/WINDOWS-TEST.md` is a complete
PowerShell runbook for it — genuinely useful, but **branch-stale**: it checks out
`feat/headless-mcp` (already merged), says "Node 18+" where the rest of the repo says 20/22,
and says "8 lite-tier tools" where the count is 9.


### 3.4 What CI does today, and what it doesn't

Read from `.github/workflows/`.

| Workflow | Windows job? | What it does on Windows |
|---|---|---|
| `ci.yml` | ❌ **None.** Every job is `runs-on: ubuntu-latest` (lines 12, 38, 59, 70) | Nothing |
| `release.yml` | ✅ `windows-latest`, `x86_64-pc-windows-msvc` (`release.yml:48-58`) | **Builds only.** Downloads + SHA-256-verifies `vec0` (`:154-208`), runs `tauri-action` (`:322-349`), uploads `.exe`/`.msi` to a draft release (`:513-518`). **No tests. No signing.** |
| `npm-release.yml` | ✅ `windows-latest` / `x86_64-pc-windows-msvc` → `mcp-win32-x64` (`:54-58`) | Builds the headless `neurovault-server.exe` + `vec0.dll`, **and runs a real runtime smoke test** (`:107-121`): starts the server, binds `127.0.0.1:8799`, creates a brain, reads stats — which forces `load_extension(vec0)`. **This is the only Windows runtime verification that exists anywhere in the repo.** Note the dynamic-dependency check at `:95` is skipped on Windows |
| `release-vscode.yml` | ✅ (line ~45) | VS Code extension packaging |
| `security.yml` | ❌ | — |

**So: Windows Rust tests have never run, anywhere, ever.** Everything in §3.2 is a static
prediction. The Windows session's most valuable single output is the first real
`cargo test` run.

The macOS leg of `release.yml` has hard verification gates (Developer ID authority,
notarization, staple, Gatekeeper, a Team-ID-signed `vec0.dylib` —
`release.yml:389-500`). **The Windows leg has none.** No smoke test, no
"does `vec0.dll` load", no "does the installer install". Adding even one would have caught
the historical "MCP binary wasn't bundled on Windows" regression
(`CHANGELOG.md:438-440`).

**The minimum CI change worth making:** add `windows-latest` to a test job in `ci.yml`.

```yaml
  rust-windows:
    name: Rust tests (Windows)
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@… # v4
      - uses: dtolnay/rust-toolchain@… # stable (rust-toolchain.toml pins 1.97.0)
      - uses: Swatinem/rust-cache@… # v2
        with: { workspaces: src-tauri }
      # vec0.dll is committed — no download step needed, unlike Linux
      - name: Tests
        working-directory: src-tauri
        run: cargo test --no-default-features
      - name: Clippy
        working-directory: src-tauri
        run: cargo clippy --all-targets --no-default-features -- -D warnings
```

Land the §3.2 fixes first, or this job is red from day one.

---

## Section 4 — Code signing

Researched 2026-08-10. **Two findings invalidate most of what you think you know about
this**, including the advice in Tauri's own docs. Read 4.1 before anything else.

### 4.1 The two facts that change the decision

**Fact 1 — EV certificates no longer bypass SmartScreen.** Microsoft, in
[Learn: SmartScreen reputation for Windows app developers](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
(page updated 2026-05-09), verbatim:

> *"EV certificates no longer bypass SmartScreen. Years ago, signing files with an
> Extended Validation (EV) code signing certificate would result in positive SmartScreen
> reputation by default, but this behavior no longer exists. EV certificates may matter
> for enterprise procurement, but they no longer impact SmartScreen behavior. **Paying a
> premium for EV solely to avoid SmartScreen warnings is no longer justified.**"*

Microsoft's own table now lists *"Valid Certificate (OV/EV) → Warning: app flagged as
unrecognized until reputation accumulates."* The companion page dates the change to 2024.

Two sources you will hit while researching this are **stale and wrong**:
- **[Tauri v2's own Windows signing page](https://v2.tauri.app/distribute/sign/windows/)** still says an EV cert *"will receive an immediate reputation with Microsoft SmartScreen and won't show any warnings."* Not true in 2026.
- **SignPath's knowledge base** says EV certs *"have full reputation when they are issued."* Also stale.

**Implication: do not buy EV.** You would pay 2–3× for identical SmartScreen behaviour,
and the sole-proprietor EV path additionally requires a *notarised* identity form.

**Fact 2 — the CA/Browser Forum hardware rule kills the "PFX in a GitHub secret" pattern.**
Since 2023-06-01, *every* code-signing certificate (OV and EV alike) must have its private
key in a FIPS 140-2 L2 / CC EAL4+ hardware module, non-exportable — now codified in
Baseline Requirements v3.11.0 (effective 2026-06-16). New for 2026: certificates issued
on/after 2026-03-01 **must not exceed 460 days** validity, which is why Sectigo, DigiCert
and GlobalSign all dropped multi-year issuance in Feb 2026.

Tauri's GitHub Actions signing recipe carries its own danger notice:
*"This guide only applies to OV code signing certificates acquired before June 1st 2023."*
It is a dead path. Only three patterns work now:

| Pattern | Hosted `windows-latest` runner? |
|---|---|
| USB token in a self-hosted runner | ❌ / ✅ self-hosted only |
| Cloud HSM / remote signing API (eSigner, KeyLocker, SignPath) | ✅ |
| Pipeline-native managed service (Azure Artifact Signing) | ✅ |

### 4.2 Options table (2026 prices)

| Option | Cert type | 2026 price | UK sole trader eligible? | CI on hosted runners? | SmartScreen effect | Effort |
|---|---|---|---|---|---|---|
| **SignPath Foundation** | OV (issued to *SignPath Foundation*) | **Free** | ✅ No company, no ID docs — project-based | ✅ Official GH Action, origin-verified | Reputation builds; the shared cert is already warm across 700+ projects | Medium |
| **SSL.com IV + eSigner** | IV — **your own verified name** | $129/yr cert + $180/yr eSigner Tier 1 = **~$309/yr** | ✅ Individuals explicitly; non-US supported (UK Companies House is an accepted registry) | ✅ Official GH Action / CodeSignTool | Builds from zero | Medium |
| **Azure Artifact Signing** (ex-Trusted Signing, GA Jan 2026) | OV-equivalent, short-lived (~24–72 h leaf) | **$9.99/mo** Basic, 5 000 sigs/mo | ❌ **No** as an individual (US/Canada only). ✅ if you incorporate a UK Ltd | ✅ Best ergonomics, first-class Tauri support | Builds — **and there is a live 2026 regression**, see below | Low-medium |
| **Certum Open Source** (cloud/SimplySign) | Individual, CN = "Open Source Developer &lt;name&gt;" | from **$58**; real UK purchase Oct 2025 was €104 first year, €29 renewal | ✅ Individual-only product | ❌ **No official CI/CD** — Certum: *"Not at the moment"* | Builds from zero | High (TOTP/GUI-automation hacks, self-hosted only) |
| Sectigo OV | OV | ~$211–226/yr | ⚠️ Needs a verifiable business listing | ⚠️ Only via existing HSM | Builds | High |
| DigiCert OV + KeyLocker | OV | ~$369–438/yr + KeyLocker (per-signature price not public) | ⚠️ Business validation | ✅ | Builds | Medium |
| GlobalSign | OV/EV | ~$434/yr, 1-year only | ⚠️ Business validation | ✅ via Atlas/ACS (price not public) | Builds | Medium |
| Any EV | EV | $249–625/yr | ⚠️ Notarised sole-proprietor path | Varies | **Identical to OV** | High |
| GitHub artifact attestations | Sigstore provenance | Free | ✅ | ✅ **already in `release.yml`** | ❌ **Zero effect on SmartScreen** | Done |
| Status quo (unsigned) | — | Free | — | — | ❌ Hard warning + Smart App Control blocks | — |

### 4.3 Recommendation

**Primary: apply to SignPath Foundation.** NeuroVault fits the profile almost exactly —
MIT, public repo, already released, actively maintained, builds in GitHub Actions.
It is the only option that costs nothing, needs no company registration, no ID documents,
no hardware, and no cloud subscription. Its GitHub origin-verification model exists
precisely for projects of this shape, and the shared Foundation certificate already
carries warm publisher reputation, which a brand-new personal certificate does not.
Apply at [signpath.org/apply](https://signpath.org/apply).

Eligibility (from [signpath.org/terms.html](https://signpath.org/terms.html)): OSI-approved
license, no malware, actively maintained, already released, documented on the download
page. **There is no published stars/downloads/age threshold** — they do a manual
reputation review instead.

**🚩 Strategic conflict — flag this to Dath before applying.** The terms require an OSI
license *"without commercial dual-licensing for all components"* and forbid *"any
proprietary, non open-source component (especially code published by a maintainer or an
affiliated person/organization)."* NeuroVault's recorded strategy is open-core with a
monetised tier. **The moment a closed-source paid component ships in the same binary,
Foundation eligibility ends — and SignPath reserves the right to revoke retroactively.**
Treat SignPath as a runway option with a costed exit, not a permanent foundation.

Other costs to accept: the Windows publisher string is likely *SignPath Foundation* rather
than Dath's name; **every release needs manual approval** (no fully unattended releases);
you must publish a "Code signing policy" page containing the exact string *"Free code
signing provided by SignPath.io, certificate by SignPath Foundation"*; MFA is mandatory
on SignPath and GitHub.

**Fallback A — SSL.com IV + eSigner, ~$309/yr.** The right answer if the open-core
conflict is real, or if you want *your own verified name* as the Windows publisher. It is
the only mainstream CA path that issues to an individual with no registered company,
accepts non-US applicants, and works on hosted GitHub runners. Validation is a
passport/licence scan, a selfie, and a phone callback. **At checkout you must tick
"Enable certificate issuance for remote signing"** or no eSigner credentials are created.

**Fallback B — Azure Artifact Signing, $9.99/mo, only if you incorporate.** The individual
path is **United States and Canada only**; a UK sole trader is blocked. The good news:
the old 3-year-business-history requirement is gone (replaced by Microsoft Verified ID +
AU10TIX). If Dath incorporates a UK Ltd for other reasons, this becomes the default:
cheapest ongoing cost, best CI ergonomics, official Tauri support, `neu`/`weu` endpoints
available (there is no UK Azure region for it). **But:** there is a live, unresolved
regression — since late March 2026 Microsoft has been silently rotating customers across
intermediate CAs (`EOC CA 02` → `AOC CA 03` → `EOC CA 03/04` → `AOC CA 04`), and
reputation is tracked per issuing CA, so builds that were clean started tripping
SmartScreen with no config change
([Azure/artifact-signing-action#128](https://github.com/Azure/artifact-signing-action/issues/128)).

**Set expectations either way.** No 2026 option removes the SmartScreen prompt on day one.
Microsoft: *"There is no exact threshold, but it can take several weeks and hundreds of
clean installs from a wide audience."* Keep the same signing identity permanently
(changing it resets the publisher signal), always timestamp, never modify a binary after
signing.

### 4.4 CI changes each option requires

The repo has **no `bundle.windows` block at all** in `src-tauri/tauri.conf.json` today, so
`certificateThumbprint` and `signCommand` are both null. `tauri-apps/tauri-action` has no
Windows signing inputs — signing is driven entirely by `tauri.conf.json` plus env secrets.

**Tauri gotchas that apply to every `signCommand` option:**
- Use **forward slashes** in Windows paths — Tauri spawns a raw process, not a shell, and backslashes break argument parsing.
- Use the **object form** of `signCommand` whenever any argument contains whitespace:
  `{"cmd": "C:/path/signer.exe", "args": ["sign", "--file", "%1"]}`.
- Tauri invokes the sign command for **every binary** — the app exe, `neurovault-server.exe`, NSIS plugins, *and* the installer. With a per-signature quota (SSL.com Tier 1 = 20/month), **wrap it in a script that whitelists only `neurovault.exe` and the NSIS installer**, or you will burn the quota in one release.
- Open Tauri issues to be aware of: [#11754](https://github.com/tauri-apps/tauri/issues/11754) (`%1` substitution), [#13991](https://github.com/tauri-apps/tauri/issues/13991) (tauri-action + trusted-signing-cli), [#11778](https://github.com/tauri-apps/tauri/issues/11778) (sidecar signing under Trusted Signing — **directly relevant: NeuroVault ships a sidecar**).

**(a) SignPath** — no `signCommand`. Signing happens *after* `tauri-action` as a separate
job step, so `release.yml` gains ~2 steps in the Windows leg only:

```yaml
- uses: actions/upload-artifact@v7
  id: upload-unsigned
  if: matrix.os-label == 'windows'
  with: { path: src-tauri/target/${{ matrix.rust-target }}/release/bundle/nsis/ }

- uses: signpath/github-action-submit-signing-request@v2
  if: matrix.os-label == 'windows'
  with:
    api-token: ${{ secrets.SIGNPATH_API_TOKEN }}
    organization-id: '<org id>'
    project-slug: 'neurovault'
    signing-policy-slug: 'release-signing'
    github-artifact-id: ${{ steps.upload-unsigned.outputs.artifact-id }}
    wait-for-completion: true
    output-artifact-directory: 'signed/'
```

Then re-upload `signed/` to the draft release instead of the tauri-action output.
Configure SignPath's artifact configuration for **nested packages** so both the inner
`neurovault.exe` *and* the outer NSIS installer get signed. Policies live in
`.signpath/policies/<project-slug>/<policy-slug>.yml`.
Note the interaction with `release.yml`'s existing Sigstore attestation step
(`release.yml:503-518`): **attest after signing**, or you attest a file that no longer
exists.

**(b) SSL.com eSigner** — add to `tauri.conf.json`:

```jsonc
"bundle": { "windows": {
  "digestAlgorithm": "sha256",
  "timestampUrl": "http://ts.ssl.com",
  "signCommand": { "cmd": "python", "args": ["scripts/sign_windows.py", "%1"] }
}}
```

with `scripts/sign_windows.py` whitelisting files and calling jsign (`choco install jsign
temurin`). Secrets: `SSL_COM_USERNAME`, `SSL_COM_PASSWORD`, `SSL_COM_CREDENTIAL_ID`,
`SSL_COM_TOTP_SECRET`. Working reference:
[thewh1teagle's Tauri+SSL.com gist](https://gist.github.com/thewh1teagle/a89d1bc44353c9da1d1198b265da8806).

**(c) Azure Artifact Signing** — the officially documented Tauri path:

```bash
cargo install artifact-signing-cli
```
```jsonc
"bundle": { "windows": {
  "signCommand": "artifact-signing-cli -e https://neu.codesigning.azure.net -a <Account> -c <Profile> -d NeuroVault %1"
}}
```
Secrets: `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` / `AZURE_TENANT_ID` for a service
principal holding the **Artifact Signing Certificate Profile Signer** role.
Budget ~5–8 s per file with no parallelisation.

**(d) DigiCert KeyLocker** — `smctl sign --keypair-alias <alias> --input %1` as the
`signCommand`, with `SM_HOST` / `SM_API_KEY` / `SM_CLIENT_CERT_FILE` / `SM_CLIENT_CERT_PASSWORD`.
Watch the **1 000-signature-per-certificate** cap against Tauri's per-binary behaviour.

**Also update when signing lands:** `README.md:60` and `:75`, and
`release.yml:16-19`, `:364-365`, `:375-379` all currently promise "not code-signed".
`SECURITY.md:130` says "No Windows/macOS code signing" and is already half-stale (macOS
*is* signed and notarized).

---

## Section 5 — Definition of done for Windows parity

Four tiers. **Tier 0 is the honest bar for "Windows is supported."** Tiers 1–3 are polish,
trust, and permanence.

### Tier 0 — It works (blocks any claim of Windows support)

- [ ] `cargo test --no-default-features` passes on Windows — **0 failures**
      *(requires fixing `hooks.rs:859` and `handlers/mod.rs:1820`; see §3.2)*
- [ ] `cargo clippy --all-targets --no-default-features -- -D warnings` passes on Windows
      *(4 `dead_code` blockers, §3.2)*
- [ ] `cargo clippy --all-targets -- -D warnings` (GUI features) passes on Windows
- [ ] `cargo fmt --check` passes on a fresh Windows clone — **requires `.gitattributes`** (§2 C6)
- [ ] `npm run tauri build -- --target x86_64-pc-windows-msvc` produces an NSIS `.exe`
- [ ] Installed app opens a brain: `vec0.dll` loads, `vec_version` logs, no missing-DLL dialog
- [ ] `dumpbin /dependents` confirms ONNX Runtime is statically linked, **or** `onnxruntime.dll` is added to `bundle.resources` (§2 S6)
- [ ] The full §3.1 manual checklist is run and recorded — install → note → recall → graph → MCP → uninstall
- [ ] **CONFIRMED bugs C1 (a/b/c), C1.5, C2, C3, C4.5, C5, C6 are fixed.** C4's `hooks.rs` half must be fixed; C4's `employee.rs` half may be deferred (the Employees feature is disabled in the base build)
- [ ] `%USERPROFILE%\.neurovault\` survives uninstall; `%LOCALAPPDATA%\NeuroVault\` is removed

### Tier 1 — It stays working (regression protection)

- [ ] `ci.yml` runs `cargo test --no-default-features` on `windows-latest` on every PR (§3.4)
- [ ] `ci.yml` runs Windows clippy on every PR
- [ ] `.gitattributes` with `* text=auto eol=lf` + `*.sh text eol=lf` is committed
- [ ] `release.yml`'s Windows leg gains at least one **post-build smoke gate** — launch `neurovault-server.exe --port <n>`, `POST /api/brains`, `GET /api/brains/<id>/stats` (which forces a `vec0.dll` load), assert 200. Mirror what `dist-npm/WINDOWS-TEST.md` §2 already scripts. Today the macOS leg has 5 hard gates and Windows has zero.
- [ ] A CI assertion that `neurovault-server.exe` **and** `resources\vec0.dll` are inside the NSIS installer — the exact regression recorded at `CHANGELOG.md:438-440`
- [ ] Every remaining `#[cfg(unix)]` test has either a Windows counterpart or an explicit, documented "unimplemented on Windows" note (13 tests, §3.2)
- [ ] The 2 false-pass tests (`hooks.rs:1135`, `write_ops.rs:485`) are tightened

### Tier 2 — It's trusted (distribution)

- [ ] A signing decision is made and recorded (§4). Default recommendation: **apply to SignPath Foundation**, with the open-core licensing conflict explicitly acknowledged
- [ ] `tauri.conf.json` gains a `bundle.windows` block with `digestAlgorithm`, `timestampUrl`, and the chosen `signCommand`
- [ ] The `signCommand` wrapper whitelists files so per-signature quotas aren't burned on sidecars and NSIS plugins
- [ ] `release.yml` signs the Windows artifacts, and the Sigstore attestation step runs **after** signing (`release.yml:503-518`)
- [ ] A published release installs on a clean Windows VM; the SmartScreen behaviour is recorded (expect a warning at first — reputation takes weeks)
- [ ] The unsigned-artifact warnings are removed/updated: `README.md:60`, `README.md:75`, `release.yml:16-19`, `:364-365`, `:375-379`, `SECURITY.md:130`
- [ ] The in-app updater is verified end to end on Windows: install `v0.6.1`, publish `v0.6.2`, confirm `passive` install mode replaces the exe and relaunches

### Tier 3 — It's equal (feature parity)

- [ ] Claude Code hooks / ambient recall work on Windows **with a fail-open path** (C1c). Until then, the Settings toggle should be disabled on Windows with an honest explanatory string rather than throwing an opaque error
- [ ] Curator evidence capture: either implement the Windows path (handle-relative traversal + file-ID comparison, per `evidence.rs:252-254`) or surface "unavailable on Windows" in the UI
- [ ] **A Windows MCP setup section exists somewhere.** `grep -rn "LOCALAPPDATA\|Program Files\|AppData" --include="*.md"` over the whole repo currently returns **zero hits** — there is not one Windows install path in any markdown file. Specifically: `README.md:105-118` and `docs/HOW-NEUROVAULT-WORKS.md:292-301` show macOS-only JSON; `CONTRIBUTING.md:170-174` gives a POSIX line-continuation command with no `.exe`; `docs/TROUBLESHOOTING.md:34-49` uses POSIX tildes. The website has the same gap (`neurovault-website/docs/content/quickstart.md:36-52`, `architecture.md:285-303`), plus `architecture.md:82` claims the Windows exe is `neurovault.exe` (Tauri renames to `productName`, so it is `NeuroVault.exe`). `dist-npm/README.md:31-39` is currently **the only correct Windows MCP guidance in the repo** — promote it.
- [ ] Docs say the right thing on Windows: `README.md:221` and `CONTRIBUTING.md:~57` currently claim prerequisites are "just Node + Rust" — on Windows that omits **MSVC Build Tools (mandatory)**, WebView2, and the pinned Rust 1.97.0
- [ ] `docs/HOW-NEUROVAULT-WORKS.md:35` vs `:85` contradict each other on installer size ("~26 MB" vs "9 MB"); `:85` also overstates WebView2's Windows 10 guarantee
- [ ] `dist-npm/WINDOWS-TEST.md` is de-staled (it checks out the merged `feat/headless-mcp` branch and says "8 lite-tier tools" where the count is 9)
- [ ] `README.md:60` mentions the `.msi` alongside the NSIS `.exe` (both are built and uploaded)
- [ ] UI strings are platform-aware: `SettingsView.tsx:430`, `:493`, `:753`, `:846`, `EmployeePanel.tsx:1264`, `src/lib/tauri.ts:120` all hardcode `~/.neurovault/` (§2 S7)
- [ ] The "closing the window doesn't stop memory" notification has a Windows implementation (`app.rs:927` is macOS-only)
- [ ] A decision is recorded on **Windows-on-ARM**: either ship an `aarch64-pc-windows-msvc` target with an ARM64 `vec0.dll`, or document it as unsupported the way Intel Mac already is (`release.yml:66-71`)
- [ ] `Makefile` gains Windows-usable equivalents for `gate` and `clean`, or a `scripts/gates.ps1`

---

## Appendix — the 60-second triage if something breaks

| Symptom | First thing to check |
|---|---|
| "sqlite-vec extension 'vec0.dll' not found" | The error lists every candidate path it tried (`sqlite_vec.rs:117-128`). Set `$env:NEUROVAULT_VEC_EXTENSION` to `src-tauri\resources\vec0.dll` |
| App starts, every brain operation fails | `vec0.dll` present but not loadable — Defender/AppLocker blocking a `LoadLibraryW` from `%LOCALAPPDATA%`, or an ARM64 machine |
| Missing-DLL dialog at launch | `onnxruntime.dll` — run the `dumpbin` check (§2 S6) |
| MCP client says "failed to connect" | Is the desktop app running? The stdio server only forwards to `:8765`; it will autostart a headless backend, which takes up to 30 s (`mcp/mod.rs:133-145`). Check `%USERPROFILE%\.neurovault\autostart.log` |
| Two different sets of memories | You are running the app on Windows and Claude Code in WSL — two separate `~/.neurovault` roots (§2 S1) |
| `bash: $'\r': command not found` | CRLF checkout (§2 C6) |
| `cargo fmt --check` fails on every file | Same |
| Hook install errors about "shell-special characters" | C1a — expected today, not a misconfiguration |
| Build takes 10+ minutes and eats 20 GB | You ran `tauri build` without `--target`; two separate release builds (§1.5) |
| `npm run test:lib` → ENOENT | `run-lib-tests.mjs:76` needs `shell: true` on Windows (§3.2) |
| Port 8765 held | `netstat -ano \| findstr :8765` — the self-heal only kills processes named `neurovault*` (`port_recovery.rs:72`) |
| Bind fails but `netstat` shows **nothing** listening | Hyper-V/WSL2/Docker reserved the port block (WSAEACCES 10013). Run `netsh interface ipv4 show excludedportrange protocol=tcp`. The app's error message is misleading here — §2 C4.5 |
| MCP client connects but every tool errors "Open the NeuroVault desktop app" | The backend isn't on `:8765`. Expected message from `forward.rs:609`; start the app or check `autostart.log` |
| Claude Desktop edits "save" but the server never appears | The MSIX config-path trap — check `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude_desktop_config.json` too (§3.3) |
