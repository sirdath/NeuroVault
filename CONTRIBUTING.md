# Contributing to NeuroVault

Thanks for the interest. NeuroVault Desktop is now a private, commercially
licensed product. Until counsel-approved inbound contribution terms exist,
we do **not** accept pull requests or unsolicited code for the proprietary
Desktop repository. This avoids implying that a third party's new work can be
placed under NeuroVault's commercial license without a valid agreement.

Public contributions belong in the MIT-licensed
[NeuroVault Core](https://github.com/sirdath/neurovault-core). Use its public
[issues](https://github.com/sirdath/neurovault-core/issues) and contribution
instructions for bugs, documentation, and engine changes. The material below
is retained as a maintainer guide for people who already have authorized
access to this private repository.

For a public bug report, use
[NeuroVault Core issues](https://github.com/sirdath/neurovault-core/issues).
For anything security-related, see [SECURITY.md](SECURITY.md); do not publish a
potential vulnerability in a normal issue.

> **You do NOT need Python.** NeuroVault's backend and MCP server are
> native **Rust**. The Direct backend runs in-process inside Tauri; connected
> MCP clients spawn the separate thin Rust bridge. The original
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
├── CHANGELOG.md             # Keep-a-Changelog
├── CLAUDE.md                # project spec + Claude-as-agent usage rules
├── PRIVACY.md  · SECURITY.md
└── Makefile                 # dev / test / build targets
```

Markdown vaults (`~/.neurovault/brains/<id>/vault/*.md`) are canonical for
note/engram content. `brain.db` contains derived retrieval indexes **and**
structured operational records that do not all have Markdown mirrors,
including core-memory blocks, version history, and drafts. Note content can be
re-indexed from Markdown; a complete brain cannot be reconstructed from the
vault alone. Back up/export the whole brain when those records matter.

## Setup

Prerequisites — **just two**:

- **Node.js 20+**
- **Rust** (`rustup default stable`)

(Python is *not* required to build or run anything. It's only used by the
offline `eval/` harness and a couple of build scripts.)

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

In the Direct development flavor, first ingest downloads the embedding model
(BGE-small-en-v1.5, ~130 MB) and the first reranked recall can download the
separate ~1 GB reranker; both are cached locally. The Store flavor instead
bundles its embedding model and does not include the reranker.

## Tests

```bash
cd src-tauri && cargo test --no-default-features --features model-download    # Rust unit + integration
npx tsc --noEmit                                     # TypeScript typecheck
npm run test:ui                                      # component + accessibility tests
npm run test:hardening                               # CSP/capability/release invariants
npm run test:e2e                                     # Chromium consumer-shell smoke test
npm run build                                        # frontend build (catches more)
```

> Note: a few `recall_cache` tests share global state and can flake under
> parallel execution; `cargo test --no-default-features --features model-download -- --test-threads=1`
> is the deterministic run.

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

## Maintainer change flow

This flow is for authorized maintainers. Proprietary Desktop PRs from external
contributors are not accepted until appropriate inbound terms are published.

1. Branch off `main`. Please don't work directly on `main` itself.
2. Keep the diff small. A 200-line PR gets merged; a 2000-line PR gets a
   redesign request. Split if scope grew.
3. Tests pass (Rust + tsc). PR CI runs `cargo fmt --check`, `clippy`
   (warnings are errors), `cargo test --no-default-features --features model-download`, and `tsc`
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

## Suitable changes for NeuroVault Core

- Bug fixes with a failing-test-that-now-passes.
- Documentation corrections.
- Small UX polish that keeps the theme-variable conventions.
- New MCP tools that fit the tier taxonomy (`tools.json` + `registry.rs`).
- Performance improvements with a before/after measurement.

## Changes to discuss in NeuroVault Core first

- Changes that make note/engram content database-only without an explicit
  ownership, backup, and export contract.
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

Open a public issue in
[NeuroVault Core](https://github.com/sirdath/neurovault-core/issues). Do not
send proprietary Desktop code as a PR unless the maintainer has provided
approved contribution terms first.
