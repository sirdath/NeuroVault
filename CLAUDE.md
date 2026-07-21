# CLAUDE.md — NeuroVault Build Specification

> You are Claude, operating as the primary developer of the NeuroVault project.
> Read this file before writing code. This is the source of truth.

## What is NeuroVault?

A **local-first, open source, AI-native memory system** for Claude and other LLMs.

**One sentence:** Claude forgets you after every conversation. NeuroVault doesn't.

Components:
1. **Tauri 2.0 desktop app** (React + TypeScript) — markdown note editor + neural graph view.
2. **In-process Rust backend** — the memory engine runs *inside* the Tauri process (no Python sidecar): an `axum` HTTP server on `127.0.0.1:8765`, hybrid retrieval, the ingestion pipeline, write-back, `fastembed-rs` (BGE-small-en-v1.5 ONNX embeddings + cross-encoder reranker), `rusqlite` + `sqlite-vec`, and a `notify` file watcher.
3. **Native Rust MCP server** — `neurovault-server --mcp-only` (built on the official [`rmcp`](https://github.com/modelcontextprotocol/rust-sdk) SDK). A tiny stdio MCP server agents spawn per session; it loads no model and opens no DB, forwarding every tool call over loopback HTTP to the running app on `:8765`. Built from the same Rust crate and bundled next to the app binary. (The legacy Python `server/mcp_proxy.py` it replaced is deprecated.)
4. **SQLite + sqlite-vec** (`~/.neurovault/brains/<id>/brain.db`) — vectors + the knowledge graph; a rebuildable index over the markdown vault.

## Architecture

```
Tauri app (React + TS)
  ├─ React UI: editor · neural graph · settings
  └─ in-process Rust backend
       ├─ axum HTTP server on 127.0.0.1:8765  (recall, remember, status, graph, …)
       ├─ hybrid retriever (sqlite-vec + BM25 + entity graph → RRF → rerank)
       ├─ fastembed-rs (BGE-small ONNX)  +  notify file watcher
       └─ SQLite + sqlite-vec  →  ~/.neurovault/brains/<id>/brain.db

Agent (Claude Code / Desktop / Cursor / Codex)
  └─ spawns  neurovault-server --mcp-only   (native Rust, rmcp; stdio JSON-RPC)
       └─ forwards tool calls over loopback HTTP to the app on :8765
```

Markdown in `~/.neurovault/brains/<id>/vault/*.md` is **canonical**; `brain.db` is a **rebuildable** index. (The SQL table for a memory unit is named `engrams` — the biologically-correct noun — intentionally.)

## MCP tools

The MCP server exposes **55 tools** via a data-driven registry, gated by a **tier** system so an agent only loads the slice it needs:

- **`minimal`** (3): `recall`, `related`, `session_start`
- **`lite`** (8, the default): minimal + `remember`, `status`, `list_brains`, `switch_brain`, `update`
- **`standard`** (21): lite + `recall_chunks`, `temporal_recall`, `check_duplicate`, `core_memory_read/set/append/replace`, `delete_engrams`, `find_clutter`, `engram_history`, `get_relevant_context`, and the multi-agent coordination pair `handoff` (route a directed, inert message to another agent through the shared brain) / `agent_inbox` (read the open handoffs addressed to an agent)
- **`full`** (55): the whole surface — maintenance (`diagnose_brain`, `optimize_disk`, `reindex_embeddings`, `bulk_set_kind`/`bulk_add_tag`), graph editing (`add_link`/`remove_link`, `find_orphan_links`), contradictions (`find_contradictions`, `supersede_note`, `resolve_contradiction`), images (`list_images`, `remember_image`), compilation (`compile_prepare`/`compile_submit`), the drop-folder inbox, and the **graphify code tools** (`graphify`, `where_defined`, `whats_in_file`, `who_calls`, `blast_radius`, `fuse` — codebase → on-device knowledge graph).

Set the tier via the `NEUROVAULT_MCP_TIER` env var or `~/.neurovault/mcp_tier.txt`. Every tool takes an optional `brain` parameter to target a specific brain.

`handoff` / `agent_inbox` give NeuroVault **multi-agent coordination — agents hand off work and read their own inbox through one shared, local, zero-LLM brain.** Handoffs are pull-based and inert (they reuse the append-only `todos.jsonl` queue; nothing auto-runs), and `session_start(agent=X)` is now optionally agent-scoped — it returns X's own recent engrams + X's inbox instead of the brain-wide view (omitting `agent` is unchanged). NeuroVault is a coordination substrate, **not** an orchestrator — it never runs or schedules agents.

## Development

```bash
# Install — Node + Rust only (no Python needed for the app or MCP)
npm install

# Dev — the Tauri shell hosts the React UI AND the in-process Rust
# backend (HTTP server on 127.0.0.1:8765). Nothing else to start.
npm run tauri dev          # or: cargo tauri dev

# Test — Rust unit + integration tests
cd src-tauri && cargo test --no-default-features --features model-download

# Build — installers under src-tauri/target/release/bundle/
npm run tauri build        # or: make build

# MCP server: the `neurovault-server` binary, built from the same crate
# and bundled next to the app. Run it standalone for an MCP client:
#   neurovault-server --mcp-only
```

> No Python in the product: the app, the MCP server, and the Claude Code hooks are
> all native Rust. (The archived `server/` prototype was removed in 2026-07.) The
> only Python left is offline tooling the app never invokes: the `eval/` retrieval
> harness, the `docs/benchmarks/` report mergers, and two icon generators in
> `scripts/`.

## Rules

1. One phase at a time. Complete before moving on.
2. Tests are part of every deliverable.
3. TypeScript strict mode, no `any`.
4. Markdown files are source of truth; the DB is a rebuildable index.
5. Small commits: `feat(mcp): add recall tool with hybrid search`

## NeuroVault usage (for Claude)

You have NeuroVault itself available as an MCP server — use it. The
active brain for this project is `NeuroVaultBrain1` (the meta-brain
that documents NeuroVault's own architecture). The MCP defaults to the
`lite` tier (8 tools); set `full` in `~/.neurovault/mcp_tier.txt` for
the whole surface. **Default behavior:**

- **Before answering a project question** → call `session_start(agent_id="claude-code")` once per session, then `recall(query)` for specifics. Do not answer from pre-training alone when the brain has context.
- **When the user asks "what do we know about X?" or "how does Y work here?"** → call `recall("X")` first.
- **For long wiki pages** → prefer `recall_chunks(query)` over `recall` — returns the matching passages at 200-400 tokens each instead of the whole engram. (Standard tier.)
- **When the user shares a decision, preference, or learning** → call `remember(content=...)` immediately. Title is auto-derived; pass `deduplicate=0.92` to merge near-duplicates instead of creating clutter.
- **Before saving a fact that might already exist** → call `check_duplicate(content)` (standard tier) and update the existing engram instead of creating a near-duplicate.
- **When the user says "save this" / "remember this" / "write this down"** → always use `remember`, never a raw file write.
- **To explore around a hit** → `related(engram_id)` is ~50-100× cheaper than a second `recall`. Use it after a recall hit instead of re-querying.

The default (`lite`) tools: `session_start`, `recall`, `related`, `remember`, `status`, `list_brains`, `switch_brain`, `update`. The `standard` and `full` tiers add chunk/temporal recall, duplicate detection, core-memory blocks, brain maintenance, graph editing, and the rest of the surface — switch tiers via Settings → MCP or `~/.neurovault/mcp_tier.txt`.
