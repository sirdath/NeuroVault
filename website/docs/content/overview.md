# Introduction

NeuroVault is a persistent, local-first memory layer for AI agents. It sits between your markdown notes and any MCP-compatible agent (Claude Code, Claude Desktop, Cursor, Codex) and gives that agent a callable `recall()` + `remember()` surface that survives across sessions — so the things you tell it once don't evaporate when the conversation ends.

Everything runs on your machine. Your notes are plain `.md` files on disk; the database is a local cache over them. Nothing is sent to a server you don't control.

> [!TIP]
> In a hurry? The [Quickstart](#quickstart) gets you from download to your first `recall()` in about a minute.

## Pick your path

**I just want to use it.** Install the desktop app, point your agent at it, and start dropping in notes. Start with the [Quickstart](#quickstart), then skim [The graph view](#graph-view) to see your knowledge as a living map.

**I'm wiring it into an agent / tool.** NeuroVault speaks MCP out of the box and also exposes a plain loopback HTTP API. See the [HTTP API](#http-api) reference for endpoint-by-endpoint shapes, and the [Quickstart](#quickstart) for the MCP connection snippet.

**I want to understand or modify the internals.** Read [Architecture](#architecture) — one pass through storage, ingest, retrieval, the MCP boundary, the UI, and the build pipeline. The [design docs](#api-gateway-design) describe surfaces that are planned or partially built.

## Core concepts

A few terms show up everywhere in these docs. Worth ten seconds each:

- **Engram** — one unit of memory, backed by a single markdown file in your vault and a row in the database. "Note" and "engram" are used interchangeably.
- **Brain** — an isolated vault + database. Keep separate brains (e.g. *work*, *personal*, *a client project*) and switch the active one; recall never crosses brains unless you ask it to.
- **Recall** — hybrid retrieval. A query runs through vector search (sqlite-vec over BGE embeddings), keyword search (BM25), and the entity graph, then the results are fused (RRF) and reranked by a cross-encoder. One call, ranked answers.
- **Remember** — the write path. New content is chunked, embedded, scanned for entities and `[[wikilinks]]`, and indexed — so it's recall-able immediately.
- **MCP** — the [Model Context Protocol](https://modelcontextprotocol.io). The standard your agent uses to call `recall` / `remember` and the other tools NeuroVault exposes.

## How the pieces fit

```
You ──▶ NeuroVault desktop app (Tauri, ~35 MB resident)
              │
              │ - React UI for browsing notes, graph, settings
              │ - Rust memory layer (sqlite + sqlite-vec + BGE embeddings)
              │ - axum HTTP server on 127.0.0.1:8765
              ▼
        mcp_proxy.py (~30 MB, stdio JSON-RPC ↔ loopback HTTP)
              │
              ▼
        Claude Code / Cursor / Desktop / Codex (any MCP client)
```

Three processes: the desktop app, the MCP proxy, and the agent. The desktop app owns storage and embeddings. The proxy is a thin shim translating the agent's stdio JSON-RPC into loopback HTTP. The agent talks to the proxy and never sees NeuroVault directly.

## What's on disk

- `~/.neurovault/brains/<brain_id>/brain.db` — one SQLite file per brain: engrams, chunks, `vec_chunks` (sqlite-vec), entities, links, BM25 indexes.
- `~/.neurovault/brains/<brain_id>/vault/` — the markdown source of truth. Every engram is also a `.md` file you can read or edit outside the app.
- `~/.neurovault/brains/<brain_id>/_inbox/` — the [drop-folder](#drop-folder): raw files you've dropped in, waiting for the agent to turn them into notes.
- `~/.cache/fastembed/` — ONNX model cache for the BGE embedder + reranker. Downloaded once on first run.

> [!NOTE]
> If the app ever breaks, your data is fine — open the vault in any markdown editor. The SQLite database is a rebuildable cache over the `.md` files, not the source of truth.

## License + status

NeuroVault is open source under the [MIT license](https://github.com/sirdath/NeuroVault/blob/main/LICENSE). It's actively developed; `main` is the source of truth. See the [changelog](https://github.com/sirdath/NeuroVault/blob/main/CHANGELOG.md) for what shipped per release.
