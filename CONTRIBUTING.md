# Contributing to NeuroVault

Thanks for the interest. This document covers the practical stuff:
what the code is organized as, how to get a dev loop running, how to
send a PR that gets merged quickly.

If you're here to file a bug, look at [the issue templates](.github/ISSUE_TEMPLATE/).
For anything security-related, see [SECURITY.md](SECURITY.md).

---

## What lives where

```
engram/
├── server/                  # Python MCP server (FastMCP)
│   ├── neurovault_server/   # Module — tools, retrieval, ingest, intelligence
│   ├── tests/               # pytest — 257 tests as of v0.1.0
│   └── neurovault_server.spec  # PyInstaller spec for the sidecar binary
├── src/                     # Frontend — React 19 + TypeScript + Vite
│   ├── components/
│   └── stores/              # Zustand state
├── src-tauri/               # Tauri 2 desktop shell (Rust)
│   ├── src/lib.rs           # Sidecar spawn, FS commands, hotkeys
│   └── binaries/            # Where the sidecar .exe lives after build
├── CHANGELOG.md             # Keep-a-Changelog
├── CLAUDE.md                # Project spec + Claude-as-agent usage rules
├── PRIVACY.md               # What we do/don't send off your machine
├── SECURITY.md              # How to report a vuln + response SLA
└── Makefile                 # dev / test / build targets
```

Markdown vaults are the **source of truth** for user data; the SQLite
DB is a rebuildable index. That's the core invariant — features that
break it (e.g. data that only exists in the DB, never in a markdown
file) probably don't fit.

## Setup

Prerequisites:
- **Python 3.13+** with [uv](https://docs.astral.sh/uv/)
- **Node.js 20+**
- **Rust** (for desktop builds only — `rustup default stable`)

Clone + install once:

```bash
git clone https://github.com/sirdath/NeuroVault.git
cd NeuroVault
make install
```

That runs `npm install` + `uv sync --extra dev` inside `server/`.

## Dev loop

You'll typically want two terminals open.

**Terminal 1 — server:**

```bash
make dev-server
```

Starts the MCP + HTTP server (FastMCP + uvicorn) on `127.0.0.1:8765`
via `uv run python -m neurovault_server`. Source-mode, so edits to
`server/neurovault_server/*.py` take effect on restart.

Add `--http-only` to skip MCP stdio if you're just hitting the HTTP
API for testing. The app and tests both use HTTP.

**Terminal 2 — desktop app:**

```bash
make dev-app
```

Shorthand for `cargo tauri dev`. Vite HMR handles frontend code;
Tauri hot-restarts the Rust layer on save.

**Tests**

```bash
make test       # full suite, ~60 sec (includes reranker tests that load a model)
make test-fast  # ~6 sec, skips reranker
make typecheck  # tsc --noEmit
```

Per-file: `cd server && uv run pytest tests/test_todos.py -v`.

## PR flow

1. Fork, branch off `main`. Please don't PR from `main` itself.
2. Keep the diff small. A 200-line PR gets merged; a 2000-line PR
   gets a redesign request. Split into multiple PRs if the scope
   grew.
3. Tests are part of every deliverable. If you change an MCP tool,
   add a test that exercises the new shape. If you change the UI,
   at minimum verify the build (`npm run build`) and typecheck pass.
4. Fill out the [PR template](.github/PULL_REQUEST_TEMPLATE.md) —
   the checklist prompts are the things a reviewer would otherwise
   ask you to fix.
5. CI must be green. GitHub Actions runs `pytest`, `tsc`,
   `cargo check`, and the full Tauri build on the three release
   targets. A red build blocks merge.
6. If your PR is user-visible, add an `Added / Changed / Fixed`
   line under `[Unreleased]` in `CHANGELOG.md`. The release pipeline
   extracts this into GitHub Release notes automatically.
7. Squash or keep commits — we squash on merge either way, but if
   your history tells a useful story, keep it.

## Commit message style

Loose conventional-commits, plus a body that says WHY. Subject in
imperative mood, no trailing period, under 72 chars.

```
feat(mcp): add check_duplicate tool for semantic dedup

Mem0's conflict detector pattern. Pure read-only similarity check
so agents can decide update-vs-create BEFORE writing a duplicate.
```

Skip `chore(ci)` and similar prefixes if they don't help — honesty
beats taxonomy.

## What we'll merge quickly

- Bug fixes with a failing-test-that-now-passes
- Documentation corrections
- Small UX polish that keeps the theme-variable conventions
- New MCP tools that fit the core / power / code / research tier
  taxonomy (see `@tiered` in `server.py`)
- Performance improvements with a before/after measurement

## What we'll push back on

- Changes that break the "markdown is source of truth, DB is an
  index" invariant
- Telemetry of any kind without an opt-in story agreed in the issue
  first
- New heavyweight dependencies (adds > 10 MB to the installer or > 5
  transitive crates) without a strong case
- Large refactors without a prior issue to align scope

## Running from source (for contributors who don't want to install the app)

If you want to test without running the Tauri app at all, point
Claude Desktop at the source-mode server via your `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "neurovault": {
      "command": "uv",
      "args": ["--directory", "/path/to/NeuroVault/server", "run", "python", "-m", "neurovault_server"]
    }
  }
}
```

Restart Claude Desktop. You'll see the full MCP tool surface within
a few seconds (core tier by default — set `NEUROVAULT_MCP_TIER=power`
in the env block for the wider set).

## Code of Conduct

By participating, you agree to uphold the [Contributor Covenant](CODE_OF_CONDUCT.md).
Short version: be kind, assume good faith, criticize ideas not
people.

## Questions

Open a discussion thread, a draft PR with `[WIP]` in the title, or
ask in an existing issue. No formal office hours yet.
