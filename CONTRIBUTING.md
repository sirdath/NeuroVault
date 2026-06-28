# Contributing to NeuroVault

Thanks for the interest. This document covers the practical stuff:
how the code is organized, how to get a dev loop running, and how to
send a PR that gets merged quickly.

If you're here to file a bug, see [the issue templates](.github/ISSUE_TEMPLATE/).
For anything security-related, see [SECURITY.md](SECURITY.md).

> **You do NOT need Python.** NeuroVault's backend and MCP server are
> native **Rust**, running in-process inside the Tauri app. The `server/`
> Python tree is archived (it was the original prototype) and is not part
> of the build, the app, or the MCP path.

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
│           ├── tools.json   #       the 54 tools (name, schema, /api/* mapping)
│           ├── registry.rs  #       loads tools.json + the tier allow-lists
│           └── forward.rs   #       forwards each MCP call over loopback HTTP
├── server/                  # ARCHIVED Python prototype (not built, not shipped)
├── scripts/                 # build helpers (stage-sidecar, make-app-icon, …)
├── eval/                    # retrieval eval set + baselines (run_eval.py)
├── docs/                    # in-repo docs (HOW-NEUROVAULT-WORKS, api, troubleshooting…)
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

- **Node.js 20+**
- **Rust** (`rustup default stable`)

(Python is *not* required. It's only relevant if you specifically work on the
archived helpers in `server/`.)

```bash
git clone https://github.com/sirdath/NeuroVault.git
cd NeuroVault
npm install
```

## Dev loop

**One** terminal — the Tauri shell hosts the React frontend **and** the
in-process Rust backend (the axum HTTP server on `127.0.0.1:8765`). There is
no separate server process to start.

```bash
npx tauri dev          # or: make dev
```

- Vite HMR handles frontend code (instant).
- Tauri recompiles + restarts the Rust layer on save (a few seconds).

First run downloads the embedding model (BGE-small-en-v1.5, ~90 MB) to
`~/.neurovault/.fastembed_cache/` — once, then cached.

## Tests

```bash
cd src-tauri && cargo test --no-default-features    # Rust unit + integration
npx tsc --noEmit                                     # TypeScript typecheck
npm run build                                        # frontend build (catches more)
```

> Note: a few `recall_cache` tests share global state and can flake under
> parallel execution; `cargo test --no-default-features -- --test-threads=1`
> is the deterministic run.

Tests are part of every deliverable. If you change an MCP tool, add/adjust a
test for the new shape (the tool count is asserted in
`src-tauri/src/memory/mcp/registry.rs`). If you change the UI, at minimum make
`npm run build` and `tsc` pass.

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
3. Tests pass (Rust + tsc + build). CI runs `cargo check`/test, `tsc`, and the
   full Tauri build on the release targets — a red build blocks merge.
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
cd src-tauri && cargo build --bin neurovault-server
# binary at: src-tauri/target/debug/neurovault-server
```

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
