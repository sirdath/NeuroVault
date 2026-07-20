# Building the sidecar binary (historical)

> **This describes a build process that no longer exists.** It is kept
> only so links from `CHANGELOG.md` still resolve. Nothing here applies
> to NeuroVault today — do not follow these steps. Earlier revisions of
> this file gave a `cd server && uv sync` recipe against a directory
> that has since been deleted.

## What this used to be

NeuroVault v0.0.x shipped as a Tauri desktop app talking to a **Python**
MCP server on `127.0.0.1:8765`. To get a one-click install, that server
was packaged with PyInstaller into a standalone executable and bundled
into the installer as a Tauri "sidecar" (~275 MB on Windows, thanks to
torch + sentence-transformers). This document was the guide to producing
that bundle.

## Why it's gone

Every piece of that has been removed:

- The Rust HTTP backend moved **in-process** inside the Tauri binary, so
  `127.0.0.1:8765` is served the moment NeuroVault launches. There is no
  separate server process left to package.
- The MCP server was rewritten as a native Rust binary
  (`neurovault-server --mcp-only`, built on `rmcp`) from the same crate
  as the app — no PyInstaller, no Python runtime, no `.spec` file.
- The Python-subprocess bridge (`run_python_job`) was deleted in
  2026-05, and the `server/` tree itself in 2026-07. The "advanced
  helpers" this doc referenced (PDF / Zotero ingest) were never wired to
  any UI.
- Embeddings and reranking are on-device ONNX via `fastembed-rs`, so the
  torch dependency that made the old bundle enormous is gone too.

## What to read instead

The MCP binary is built and staged by the normal build:

```bash
npm run tauri build     # or: make build
```

`scripts/stage-sidecar.mjs` places `neurovault-server` next to the app
binary (declared as `externalBin` in `src-tauri/tauri.conf.json`). For
architecture, see [HOW-NEUROVAULT-WORKS.md](HOW-NEUROVAULT-WORKS.md);
for contributor setup, see [../CONTRIBUTING.md](../CONTRIBUTING.md).
