# NeuroVault docs

NeuroVault is a persistent, local-first memory layer for AI agents. It sits between your markdown notes and any MCP-compatible agent (Claude Code, Claude Desktop, Cursor, Codex), giving that agent a callable `recall()` + `remember()` surface that survives across sessions.

These docs explain how the whole system works — every part, from the storage layer up through the MCP boundary the agent talks to. They're written for someone who wants to either *use* NeuroVault confidently or *modify* it without breaking things.

## Pick a starting point

- **New to NeuroVault?** Read [Architecture](#architecture) first. It's the longest doc but covers everything in one pass — storage, ingest, retrieval, MCP, UI, build pipeline. You can skim and come back.
- **Building something against the HTTP API?** Jump to [HTTP API](#http-api). Endpoint-by-endpoint reference with request/response shapes.
- **Curious about the graph view?** [Graph Analytics](#graph-analytics) walks through what the structural overlays mean and how to read them.
- **Thinking about extending the system?** Read the design docs: [API Gateway](#api-gateway-design) and [Sync Architecture](#sync-architecture). These describe surfaces that are partially implemented or planned — what shape they'll take, and why.

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

Three processes total: the desktop app, the MCP proxy, and the agent itself. The desktop app owns the storage and embeddings. The MCP proxy is a thin shim that translates between the agent's stdio JSON-RPC and the desktop app's loopback HTTP. The agent talks to the proxy and never sees NeuroVault directly.

## What's on disk

- `~/.neurovault/brains/<brain_id>/brain.db` — one SQLite file per brain, with tables for engrams, chunks, vec_chunks (sqlite-vec), entities, links, BM25 indexes.
- `~/.neurovault/brains/<brain_id>/vault/` — the markdown source-of-truth. Every engram is also a `.md` file you can read or edit outside the app.
- `~/.cache/fastembed/` — ONNX model cache for BGE embeddings + reranker. Downloaded once on first run.

If NeuroVault is broken, you can read your data with any markdown viewer. The SQLite database is a cache layer over the markdown files.

## License + status

NeuroVault is open source under the [MIT license](https://github.com/sirdath/NeuroVault/blob/main/LICENSE). It's actively developed; the `main` branch is the source of truth. See the [changelog](https://github.com/sirdath/NeuroVault/blob/main/CHANGELOG.md) for what's shipped per release.
