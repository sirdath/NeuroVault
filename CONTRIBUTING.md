# Contributing to NeuroVault

Thanks for the interest. This document covers the practical stuff:
how the code is organized, how to get a dev loop running, and how to
send a PR that gets merged quickly.

If you're here to file a bug, see [the issue templates](.github/ISSUE_TEMPLATE/).
For anything security-related, see [SECURITY.md](SECURITY.md).

> **You do NOT need Python.** NeuroVault's backend and MCP server are
> native **Rust**, running in-process inside the Tauri app. The original
> `server/` Python prototype was deleted in 2026-07; the only Python
> left in the repo is offline tooling the app never invokes (`eval/`,
> the `docs/benchmarks/` mergers, and two icon scripts).

---

## What lives where

```
NeuroVault/
├── src/                     # Frontend — React 19 + TypeScript + Vite
│   ├── components/          #   editor · graph · sidebar · settings · minitab
│   ├── stores/              #   Zustand state
│   └── lib/                 #   API client, config, wikilink resolver, updater
├── src-tauri/               # Tauri 2 desktop shell + the whole backend (Rust)
│   ├── src/lib.rs           #   Tauri commands, windows, hotkeys, server lifecycle
│   ├── src/bin/             #   neurovault-server (the MCP stdio binary)
│   └── src/memory/          #   the memory engine:
│       ├── ingest.rs        #     chunk → embed → entities → links → BM25
│       ├── retriever.rs     #     hybrid recall (vec + BM25 + graph → RRF → rerank)
│       ├── http_server.rs   #     axum server on 127.0.0.1:8765 (the /api/* surface)
│       └── mcp/             #     the rmcp MCP server + data-driven tool registry
│           ├── tools.json   #       the 55 tools (name, schema, /api/* mapping)
│           ├── registry.rs  #       loads tools.json + the tier allow-lists
│           └── forward.rs   #       forwards each MCP call over loopback HTTP
├── scripts/                 # build helpers (stage-sidecar, make-app-icon, …)
├── eval/                    # retrieval eval set + baselines (run_eval.py)
├── docs/                    # in-repo docs (HOW-NEUROVAULT-WORKS, api, troubleshooting…)
├── vscode-extension/        # the VS Code / Cursor extension — spawns the same server
│                            #   on :8765 and opens the NeuroVault UI as an editor tab
│                            #   (its own npm project; not on the Marketplace yet)
├── dist-npm/                # the npm distribution of the headless MCP server:
│                            #   `@neurovault/mcp` + per-platform binary packages
│                            #   (NOT published to npm yet — built by npm-release.yml)
├── CHANGELOG.md             # Keep-a-Changelog
├── CLAUDE.md                # project spec + Claude-as-agent usage rules
├── PRIVACY.md  · SECURITY.md
└── Makefile                 # dev / test / build targets
```

Markdown vaults (`~/.neurovault/brains/<id>/vault/*.md`) are the **source of
truth** for user data; `brain.db` is a rebuildable index. That's the core
invariant — features that break it (data that only exists in the DB, never
in a markdown file) probably don't fit.

## Setup

Prerequisites — **just two**:

- **Node.js 20+** (CI runs 22; `.nvmrc` pins it, so `nvm use` picks it up)
- **Rust** — the version is pinned in `src-tauri/rust-toolchain.toml`
  (currently 1.97.0 + rustfmt + clippy). rustup installs it on the first
  `cargo` invocation; don't override it, or your clippy stops matching CI's.

(Python is *not* required to build or run anything. It's only used by the
offline `eval/` harness and a couple of build scripts.)

```bash
git clone https://github.com/sirdath/NeuroVault.git
cd NeuroVault
npm install
```

**Linux only — one extra step.** The tests and the app load the sqlite-vec
extension from `src-tauri/resources/`. `vec0.dll` and `vec0.dylib` are
committed for Windows and macOS; **`vec0.so` is not** (it's fetched at build
time by the workflows), so a fresh Linux checkout fails with
`sqlite-vec extension 'vec0' not found`. `./scripts/gates.sh` now fetches and
checksum-verifies it for you, or do it by hand:

```bash
curl -fL -o /tmp/vec.tgz \
  https://github.com/asg017/sqlite-vec/releases/download/v0.1.9/sqlite-vec-0.1.9-loadable-linux-x86_64.tar.gz
echo "b959baa1d8dc88861b1edb337b8587178cdcb12d60b4998f9d10b6a82052d5d7  /tmp/vec.tgz" | sha256sum -c
tar -xzf /tmp/vec.tgz -C src-tauri/resources/    # → src-tauri/resources/vec0.so
```

Verify the checksum — vec0 is `dlopen`ed into the process on every brain open.
The pinned version and hash are the same ones `.github/workflows/release.yml`
uses; bump them together.

## Dev loop

**One** terminal — the Tauri shell hosts the React frontend **and** the
in-process Rust backend (the axum HTTP server on `127.0.0.1:8765`). There is
no separate server process to start.

```bash
npx tauri dev          # or: make dev
```

- Vite HMR handles frontend code (instant).
- Tauri recompiles + restarts the Rust layer on save (a few seconds).

First run downloads the embedding model (BGE-small-en-v1.5, ~130 MB) to
`~/.neurovault/.fastembed_cache/` — once, then cached.

### The sidecar, and why `tauri dev` runs a build script first

`neurovault-server` (the MCP binary) is declared in `tauri.conf.json` as an
`externalBin` — a *sidecar*, shipped next to the app binary so the installed
app can spawn it. Tauri expects sidecars at a fixed, triple-suffixed path:
`src-tauri/binaries/neurovault-server-<host-triple>[.exe]`. That directory is
gitignored; the file is produced by **`scripts/stage-sidecar.mjs`**.

The awkward part: `neurovault-server` lives in the *same crate* as the app, and
that crate's `build.rs` (`tauri_build`) asserts every `externalBin` file exists
on **every** compile of the crate — including the compile that would produce
the sidecar. So on a fresh clone the build is circular, and `cargo build` /
`tauri dev` die before compiling a line:

```
error: resource path `binaries/neurovault-server-aarch64-apple-darwin` doesn't exist
```

`stage-sidecar.mjs` breaks the cycle by building the sidecar with
`TAURI_CONFIG='{"bundle":{"externalBin":[]}}'` (which `tauri_build`
merge-patches over the file config, disabling the check for that one build),
then copying the result into `src-tauri/binaries/`. It runs in **both**
`beforeDevCommand` and `beforeBuildCommand`, and it's idempotent: if the staged
binary is already newer than everything under `src-tauri/`, it prints
`reused …` and skips the (release-profile, minutes-long) rebuild, so
`tauri dev` restarts stay fast. Delete `src-tauri/binaries/` to force one.

Two consequences worth knowing:

- Anything that compiles the crate **without** running the app — linting,
  `cargo check` — either needs the sidecar staged or needs the same escape
  hatch. `scripts/gates.sh` and CI use `TAURI_CONFIG` for exactly this.
- Dropping the `gui` feature skips the check entirely, which is why the
  build command under "Running the MCP server from source" below passes
  `--no-default-features`.

## Tests

```bash
cd src-tauri && cargo test --no-default-features    # Rust unit + integration
npx tsc --noEmit                                     # TypeScript typecheck
npm run test:ui                                      # component + accessibility tests
npm run test:hardening                               # CSP/capability/release invariants
npm run test:e2e                                     # Chromium consumer-shell smoke test
npm run build                                        # frontend build (catches more)
```

> Note: a few `recall_cache` tests share global state and can flake under
> parallel execution; `cargo test --no-default-features -- --test-threads=1`
> is the deterministic run.

The **first** `cargo test` downloads the embedding model (~130 MB) — the
integration suites embed for real. They pin `FASTEMBED_CACHE_DIR` at
`~/.neurovault/.fastembed_cache/`, the same cache the app uses, so it's
downloaded once per machine and every later run is offline. (Each suite still
gets its own throwaway `NEUROVAULT_HOME`; only the model cache is shared.) If
you've already run the app, you've already paid for it.

Install the Playwright browser once before the first local e2e run with
`npx playwright install chromium`. Tests are part of every deliverable. If you change an MCP tool, add/adjust a
test for the new shape (the tool count is asserted in
`src-tauri/src/memory/mcp/registry.rs`). If you change the UI, at minimum make
`npm run test:ui`, `npm run build`, and `tsc` pass.

## Adding an MCP tool

Tools are **data-driven** — you usually don't write a new handler from
scratch:

1. Add an HTTP endpoint + handler in `src-tauri/src/memory/handlers/` and a
   route in `http_server.rs` (mirror an existing one, e.g. `reindex_embeddings`).
2. Add a tool entry to `src-tauri/src/memory/mcp/tools.json` (name, description,
   `input_schema`, and a `call` block mapping it to your `/api/*` route).
3. New tools are `full`-tier by default. To put a tool in a lower tier, add its
   name to the allow-list in `registry.rs`.
4. Update the tool-count assertions in `registry.rs` / `mcp/server.rs`.

## PR flow

1. Fork, branch off `main`. Please don't PR from `main` itself.
2. Keep the diff small. A 200-line PR gets merged; a 2000-line PR gets a
   redesign request. Split if scope grew.
3. Tests pass (Rust + tsc). PR CI runs `cargo fmt --check`, `clippy`
   (warnings are errors), `cargo test --no-default-features`, and `tsc`
   — a red check blocks merge. The full multi-platform Tauri build runs
   on release tags, not on PRs.
4. Fill out the [PR template](.github/PULL_REQUEST_TEMPLATE.md).
5. If your change is user-visible, add an `Added / Changed / Fixed` line to
   `CHANGELOG.md`. The release pipeline extracts it into the GitHub Release notes.

## Commit message style

Loose conventional-commits, plus a body that says WHY. Subject in imperative
mood, no trailing period, under 72 chars.

```
feat(mcp): add check_duplicate tool for semantic dedup

Pure read-only similarity check so agents can decide update-vs-create
BEFORE writing a duplicate.
```

Skip `chore(ci)`-style prefixes if they don't help — honesty beats taxonomy.

## What we'll merge quickly

- Bug fixes with a failing-test-that-now-passes.
- Documentation corrections.
- Small UX polish that keeps the theme-variable conventions.
- New MCP tools that fit the tier taxonomy (`tools.json` + `registry.rs`).
- Performance improvements with a before/after measurement.

## What we'll push back on

- Changes that break the "markdown is source of truth, DB is an index" invariant.
- Telemetry of any kind without an opt-in story agreed in the issue first.
- New heavyweight dependencies (adds > 10 MB to the installer or several
  transitive crates) without a strong case.
- Large refactors without a prior issue to align scope.

## Running the MCP server from source

To test the MCP surface without installing the app, build the server binary
and point your agent at it (native Rust — no Python):

```bash
cd src-tauri && cargo build --no-default-features --bin neurovault-server
# binary at: src-tauri/target/debug/neurovault-server
```

`--no-default-features` is load-bearing on a fresh clone, not an optimisation.
It drops the `gui` feature, which is what makes `build.rs` run the sidecar
`externalBin` check described above — without it this command fails with
`resource path binaries/neurovault-server-… doesn't exist` until something has
staged the sidecar. Dropping `gui` also links no Tauri/WebKit/GTK, which is
exactly what the headless server wants.

Register it with Claude Code (writes `~/.claude.json`):

```bash
claude mcp add --scope user neurovault \
  /absolute/path/to/src-tauri/target/debug/neurovault-server -- --mcp-only
```

It forwards to the HTTP server on `127.0.0.1:8765` and auto-starts the backend
if it isn't running. Set `NEUROVAULT_MCP_TIER=full` in the env for the whole
tool surface.

## Code of Conduct

By participating, you agree to uphold the [Contributor Covenant](CODE_OF_CONDUCT.md).
Short version: be kind, assume good faith, criticize ideas not people.

## Questions

Open a discussion thread, a draft PR with `[WIP]` in the title, or ask in an
existing issue.
