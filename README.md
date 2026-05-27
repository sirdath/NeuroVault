<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/neurovault-logo-dark.png">
  <img alt="NeuroVault" src="assets/brand/neurovault-logo.png" width="440">
</picture>

### Local-first AI memory for Claude and any MCP agent

Claude forgets you after every conversation. **NeuroVault doesn't.**

[![License: MIT](https://img.shields.io/badge/License-MIT-2f7bf6.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/sirdath/NeuroVault?color=2f7bf6)](https://github.com/sirdath/NeuroVault/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/sirdath/NeuroVault/total?color=2f7bf6)](https://github.com/sirdath/NeuroVault/releases)
[![Stars](https://img.shields.io/github/stars/sirdath/NeuroVault?style=flat&color=2f7bf6)](https://github.com/sirdath/NeuroVault/stargazers)
![Platforms](https://img.shields.io/badge/platform-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-lightgrey)
![Built with Tauri + Rust](https://img.shields.io/badge/built%20with-Tauri%202%20%2B%20Rust-24C8DB)

**[Download](#download--install) · [Documentation](https://neurovault.dathproject.com/docs) · [Website](https://neurovault.dathproject.com) · [Connect your agent](#connect-your-agent-mcp)**

</div>

<br>

<div align="center">
  <img alt="NeuroVault graph view" src="docs/screenshots/neural-graph.png" width="820">
</div>

<br>

NeuroVault is a **local-first memory layer for AI agents**. It sits between your markdown notes and any MCP-compatible agent (Claude Code, Claude Desktop, Cursor, Codex) and gives it a callable `recall()` + `remember()` surface that survives across sessions. Everything runs on your machine — your notes are plain `.md` files, the database is a rebuildable cache over them, and nothing is sent to a server you don't control.

> Not RAG-in-a-trenchcoat. A structured, updatable, inspectable knowledge base an AI can read, write, and challenge. [Why this is not RAG ↓](#why-this-is-not-rag)

---

## Download & install

Latest release: **[github.com/sirdath/NeuroVault/releases/latest](https://github.com/sirdath/NeuroVault/releases/latest)**

| Platform | Asset |
|---|---|
| **Windows x64** | `NeuroVault_*_x64-setup.exe` (NSIS installer) |
| **macOS Apple Silicon** | `NeuroVault_*_aarch64.dmg` |
| **macOS Intel** | `NeuroVault_*_x64.dmg` |
| **Linux x64** | `neurovault_*_amd64.AppImage` / `*.deb` |

1. Download the installer for your platform and run it.
2. Notes are saved as plain markdown in `~/.neurovault/`.

### First-launch warnings

The macOS and Windows builds aren't code-signed, so the first launch warns you. This is expected for an open-source app without a paid signing certificate — it's not a real detection.

- **Windows SmartScreen** ("Windows protected your PC"): click **More info → Run anyway**.
- **macOS Gatekeeper** ("damaged, move to trash"): right-click NeuroVault.app → **Open** → **Open Anyway**, or run once: `xattr -cr /Applications/NeuroVault.app`.

Linux AppImage runs without warnings; `chmod +x neurovault_*.AppImage` if needed.

> **Updates** — NeuroVault checks for a newer release on launch and surfaces an **Update** button in the top bar (and in Settings → Updates). Your data lives in `~/.neurovault/` and is never touched by an update.

## What you get

- **Knowledge graph view** — your notes as a living, force-directed map. Node **fill = category** (folder), a **ring = health** (teal active · amber fresh · grey dormant), and **size = importance** (PageRank) in Analytics mode. Spread/zoom controls, animations toggle, Venn-style category grouping, time-lapse playback, and a click-to-frame cluster legend.
- **Hybrid retrieval, always on** — semantic + BM25 keywords + knowledge graph, fused via RRF, optional cross-encoder rerank. In-process Rust.
- **Markdown editor** with live preview, auto-save, drag-to-reorder tabs, and `[[wikilinks]]`.
- **Drop-folder ingest** — drag any file onto the window; your connected agent reads it and turns it into a clean, indexed note. [How it works →](https://neurovault.dathproject.com/docs#drop-folder)
- **Silent fact capture** — casually-dropped facts ("I prefer Rust over Go") get promoted to first-class memories with provenance back to where you said them.
- **Multiple brains** — separate vaults/databases per project; switch via the dropdown or `Ctrl+K`.
- **Open a folder as a vault** — point NeuroVault at an existing Obsidian vault; the folder stays in place.
- **Notes-tree + graph share colours**, themes, resizable panels, and an in-app updater.
- **100% local. No telemetry, no account, no cloud.** Loopback-only server on `127.0.0.1:8765`.

## Connect your agent (MCP)

**Installed app:** open **Settings → Connect Claude Code** (or **Connect Claude Desktop**). It generates the exact snippet for your machine — copy it, restart the agent, done. Full walkthrough in the [Quickstart](https://neurovault.dathproject.com/docs#quickstart).

**From source**, point your MCP client at the stdio↔HTTP bridge:

```json
{
  "mcpServers": {
    "neurovault": {
      "command": "uv",
      "args": ["--directory", "/path/to/NeuroVault/server", "run", "python", "mcp_proxy.py"]
    }
  }
}
```

The proxy bridges to the Rust HTTP server bundled in the app on `127.0.0.1:8765` — open NeuroVault first, then start your agent session. Now say *"remember that I prefer Tauri over Electron"*; weeks later, ask *"what desktop framework do I like?"* and it recalls instantly.

## Screenshots

| | |
|---|---|
| ![Filters panel](docs/screenshots/02-filter-panel.png) | ![Command palette](docs/screenshots/07-palette.png) |
| **Filters panel.** Every graph knob in one place — spread, edge-type filters, node size, layout, animations, grouping, time-lapse. Live, no re-render. | **Cmd+K palette.** One prompt, three sections — *Commands* (fuzzy), *Notes* (title search), *Memory* (semantic recall after 3+ chars). |
| ![Semantic edges](docs/screenshots/04-graph-semantic-on.png) | ![Settings — About](docs/screenshots/09-settings-about.png) |
| **Semantic edges.** Toggle the inferred-similarity layer; `manual`, `entity`, and `semantic` links each get their own colour. | **Settings.** Theme, density, server controls, MCP connection diagnostics, and the update checker. |

---

## How it works

```
You write a note in the editor
  -> Auto-saved as markdown in your vault
  -> File watcher triggers the ingest pipeline
  -> Text chunked, embedded locally, entities extracted, knowledge graph updated

You drop a fact in conversation ("I prefer Tauri 2.0 over Electron")
  -> A UserPromptSubmit hook runs it through a regex extractor
  -> 8 patterns catch preferences, decisions, deadlines, identities, stacks
  -> Each fact becomes a first-class kind='insight' engram
  -> With a wiki-link back to the original observation for provenance

You ask the agent a question
  -> Agent calls recall() via MCP
  -> Hybrid search: semantic + BM25 + knowledge graph, fused via RRF
  -> Recent / contested decisions get a score bonus; dormant ones fade
  -> Top memories returned at a flat ~275 tokens regardless of vault size

After meaningful exchanges
  -> Write-back extracts durable facts and saves them as new notes
  -> Strength decay reinforces what you keep using; unused notes fade
```

## Why this is not RAG

RAG is an answer-pipeline: chunk, embed, retrieve K chunks, stuff the context, generate, repeat. The corpus is dead data, retrieval has no memory of past retrievals, contradictions are invisible, provenance is a prayer.

NeuroVault is a **knowledge layer**. It differs in five ways that map to what a living internal wiki needs:

| What a wiki needs | RAG's answer | NeuroVault's answer |
|---|---|---|
| **Accumulate over time** | re-chunk, re-embed | Ebbinghaus strength decay + access reinforcement. Used facts stay strong; unused fade. |
| **Structure** | flat chunks | Karpathy's 3-layer raw/wiki/schema pattern; engrams typed `note`/`source`/`quote`/`insight`/`observation`. |
| **Link** | none | Three automatic link types (semantic, shared-entity, explicit `[[wikilinks]]`) + a force-directed graph. |
| **Provenance** | cite the chunk | Silent fact capture stores `**Source:** [[observation-...]]` links back to the exact prompt where a fact was said. |
| **Challenge / update** | none | Temporal fact tracking — a contradicting fact supersedes the old one, which then takes a recency penalty in retrieval. |

## Features

**Multiple brains** — separate memory spaces, each with its own vault, database, and graph. Switch instantly via the dropdown or MCP.

**Hybrid retrieval** — three signals merged via Reciprocal Rank Fusion: semantic vector similarity (50%), BM25 keywords (30%), knowledge-graph traversal (20%). Optional cross-encoder reranking for maximum precision.

**Memory strength** — Ebbinghaus forgetting curve with access reinforcement. Frequently retrieved memories stay strong; unused ones fade.

**Graph view** — force-directed visualization. Fill encodes category, a ring encodes health/strength, size encodes importance (Analytics mode). Click a node to open, drag to pin, click a cluster in the legend to frame it.

**Drop-folder ingest** — a per-brain `_inbox/`; dropped files wait there for the connected agent to convert into clean notes (no bundled converters — the agent is the converter).

**Silent fact capture** — a UserPromptSubmit hook pipes prompts through a regex extractor recognising 8 patterns (preferences, decisions, stacks, deadlines, identity, anti-preferences, deploy targets, explicit "remember that…"). Microseconds, no LLM call, bounded to 3 extractions/message, `<private>` blocks stripped.

**Session wake-up** — `session_start` returns layered context: L0 (~100 tokens, identity), L1 (~300 tokens, top active memories), L2 (on demand via `recall()`).

**Brain diagnostic** — a one-click health scorecard for your vault. Distils the graph into five graded categories + a headline grade and a worst-first list of fixes. "Copy report" emits a plain-text scorecard you can paste to your agent, so it acts on the issues — the maintenance loop the agent is meant to own.

```
NeuroVault brain diagnostic — work
Overall: B  (84/100, 412 notes)

Connectivity  ██████████████████████░░  88%
Interlinking  ███████████████░░░░░░░░░  63%
Cohesion      ███████████████████████░  94%
Freshness     ██████████████████░░░░░░  74%
Organization  ████████████░░░░░░░░░░░░  51%

Top fixes:
  - 49 orphan notes with no links — connect or merge them
  - 201 unfiled notes in the root — sort into folders
```

---

## Quick start (developers)

**Prerequisites:** [Node.js](https://nodejs.org/) 20+, [Rust](https://rustup.rs/). [Python](https://www.python.org/) 3.13+ and [uv](https://docs.astral.sh/uv/) only if you want the opt-in advanced helpers (PDF ingest, Zotero sync).

```bash
git clone https://github.com/sirdath/NeuroVault.git
cd NeuroVault
npm install

# One terminal — the Tauri shell hosts the React frontend AND the
# in-process Rust HTTP server on 127.0.0.1:8765. Nothing else to start.
npx tauri dev

# Release build (installer at src-tauri/target/release/bundle/):
npx tauri build
```

## MCP tools

Exposed to any MCP-speaking agent. Every tool takes an optional `brain` parameter to target a specific brain.

| Tool | What it does |
|------|-------------|
| `recall(q, mode, limit, rerank?)` | Hybrid search — semantic + BM25 + graph via RRF, optional rerank. PageRank prior in Analytics mode. |
| `recall_chunks(q, limit)` | Same retrieval, returns matching paragraphs instead of whole notes. Cheaper. |
| `related(engram_id, hops, link_types?)` | Direct graph neighbours of an engram. ~50× cheaper than a fresh recall. |
| `remember(content, title?, dedupe?)` | Save a memory (chunk + embed + entities + graph link). |
| `list_inbox` / `read_inbox_file` / `mark_inbox_done` | Drop-folder workflow — read raw dropped files and turn them into notes. |
| `session_start(agent_id?, since?)` | Wake-up: brain stats + L0 identity + top memories + open todos in one call. |
| `core_memory_set` / `_append` / `_replace` / `_read` | Persona-style always-included blocks (Letta pattern). |
| `list_brains` / `switch_brain` / `create_brain` | Multi-brain navigation. |
| `check_duplicate(content, threshold)` | Pure cosine pre-check before `remember()`. |
| `list_unnamed_clusters` / `set_cluster_names` | Agent-driven cluster naming for the graph's Analytics mode. |
| `add_todo` / `claim_todo` / `complete_todo` / `list_todos` | Multi-agent coordination via append-only `todos.jsonl`. |

---

## Architecture

```
+-------------------------------------------------+
|  Tauri 2 desktop app (React 19 + TypeScript)    |
|  Editor / Graph / Sidebar / Command palette     |
+-----------------------+-------------------------+
                        | Tauri commands  +  HTTP :8765
+-----------------------v-------------------------+
|  In-process Rust backend                        |
|  - axum HTTP server (the MCP proxy talks here)  |
|  - hybrid retriever (semantic + BM25 + graph)   |
|  - fastembed-rs (BGE-small ONNX, local)         |
|  - notify file watcher                          |
+-----------------------+-------------------------+
                        | SQL + vec0
+-----------------------v-------------------------+
|  SQLite + sqlite-vec  (~/.neurovault/...)       |
|  brain.db, vault/*.md, _inbox/, assets/, cache/ |
+-------------------------------------------------+

External:
  + Python lives in server/ but is OPT-IN — spawned as a one-shot
    subprocess for advanced helpers (PDF ingest, Zotero, code-graph).
    Never runs at app boot.
  + mcp_proxy.py is a tiny stdio->HTTP bridge for MCP clients.
```

Markdown in `vault/` and inputs in `raw/` are **canonical**; everything in `cache/` and `brain.db` is **rebuildable**. If the index breaks, rebuild from the files. You own your brain. Full layout + privacy details: [PRIVACY.md](PRIVACY.md).

## Tech stack

| Layer | Technology |
|-------|-----------|
| Desktop | Tauri 2 (~30 MB installed, no Electron) |
| Frontend | React 19, TypeScript (strict), Tailwind v4, Zustand |
| Editor | CodeMirror 6 |
| Graph | `react-force-graph-2d/3d` (lazy-loaded), d3-force, canvas painting |
| **Backend (in-process)** | **Rust + axum, fastembed-rs ONNX embeddings, rusqlite + sqlite-vec, notify, parking_lot, tokio** |
| Vector search | sqlite-vec (KNN in pure SQL) |
| Embeddings | BAAI/bge-small-en-v1.5 (384 dims, local, free) |
| Keywords | BM25 (Rust port of Okapi) |
| Graph metrics | Vanilla TS PageRank + Louvain |
| MCP bridge | `server/mcp_proxy.py` — FastMCP, forwards stdio to HTTP |

## Performance

| Operation | Time |
|-----------|------|
| Embed a note | ~20 ms |
| Recall (no reranker) | ~73 ms median |
| Recall (with reranker) | ~133 ms median |
| Full vault ingest (25 notes) | ~4 s cold start |

**Retrieval quality** (25 hand-crafted notes, 25 queries):

| Mode | Top-1 | Top-3 | Top-5 | MRR | Median latency |
|------|-------|-------|-------|-----|----------------|
| Hybrid (default) | **92%** | **96%** | 96% | 0.94 | 73 ms |
| Hybrid + cross-encoder rerank | **92%** | **100%** | 100% | 0.96 | 133 ms |

**Cost** — roughly **$0.55/yr** for 1000 notes (local embeddings, your own machine), vs. hosted memory services at $300–3000/yr. 100% local and open source.

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+N` | New note |
| `Ctrl+S` | Save |
| `Ctrl+1` / `Ctrl+2` | Editor / Graph |
| `Ctrl+P` | Cycle views |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+K` | Command palette |
| `?` | All shortcuts |

---

## Documentation

Full docs — quickstart, the graph view, drop-folder ingest, architecture, the HTTP API, and design docs — live at **[neurovault.dathproject.com/docs](https://neurovault.dathproject.com/docs)**.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Security reports: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © NeuroVault contributors.

<div align="center"><sub>Built with Claude. Remembers everything.</sub></div>
