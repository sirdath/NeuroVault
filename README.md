```
███╗   ██╗███████╗██╗   ██╗██████╗  ██████╗ ██╗   ██╗ █████╗ ██╗   ██╗██╗  ████████╗
████╗  ██║██╔════╝██║   ██║██╔══██╗██╔═══██╗██║   ██║██╔══██╗██║   ██║██║  ╚══██╔══╝
██╔██╗ ██║█████╗  ██║   ██║██████╔╝██║   ██║██║   ██║███████║██║   ██║██║     ██║
██║╚██╗██║██╔══╝  ██║   ██║██╔══██╗██║   ██║╚██╗ ██╔╝██╔══██║██║   ██║██║     ██║
██║ ╚████║███████╗╚██████╔╝██║  ██║╚██████╔╝ ╚████╔╝ ██║  ██║╚██████╔╝███████╗██║
╚═╝  ╚═══╝╚══════╝ ╚═════╝ ╚═╝  ╚═╝ ╚═════╝   ╚═══╝  ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝

                     local-first AI memory for Claude
```

# NeuroVault

A local-first AI memory system. Claude forgets you after every conversation. NeuroVault does not.

---

## Download and install

Latest release: **[github.com/sirdath/NeuroVault/releases/latest](https://github.com/sirdath/NeuroVault/releases/latest)**

| Platform | Asset | Status |
|---|---|---|
| **Windows x64** | `NeuroVault_*_x64-setup.exe` | Always built |
| **macOS Apple Silicon** | `NeuroVault_*_aarch64.dmg` | Built via CI (v0.1.2+) |
| **macOS Intel** | `NeuroVault_*_x64.dmg` | Built via CI (v0.1.2+) |
| **Linux x64** | `neurovault_*_amd64.AppImage` / `*.deb` | Built via CI (v0.1.2+) |

1. Download the installer for your platform from the release page.
2. Run it. Notes are saved as plain markdown files in `~/.neurovault/`.

### First-launch warnings

The macOS and Windows builds aren't code-signed yet. First open will warn you. Steps:

- **Windows SmartScreen** ("Windows protected your PC"): click **More info**, then **Run anyway**.
- **macOS Gatekeeper** ("damaged, move to trash"): right-click NeuroVault.app, choose **Open**, then **Open Anyway**. Or run once: `xattr -cr /Applications/NeuroVault.app`.

Linux AppImage runs without warnings; `chmod +x neurovault_*.AppImage` if needed.

## Data safety

NeuroVault is local-first by design. The short version:

- **No telemetry.** No analytics, no crash reporter, no phone-home on startup.
- **No account.** There is no NeuroVault login.
- **No cloud sync.** The vault is a folder of markdown files on your machine. Back it up, sync it, or delete it however you want.
- **Loopback-only server** (`127.0.0.1:8765`). It refuses connections from other machines.
- **Network is used only when you explicitly ask for it**, such as downloading embedding models on first run, checking for app updates, or calling the Claude API for compile pages (which requires your own API key).

Full details, including what lives in `~/.neurovault/`, how to delete data, and what the MCP server logs, are in [PRIVACY.md](PRIVACY.md).

## What you get

- **Markdown editor** with live preview, auto-save, drag-to-reorder tabs, and `[[wikilinks]]`.
- **Seven themes.** Midnight, Claude, OpenAI, GitHub Dark, Rosé Pine, Nord, Obsidian.
- **Knowledge graph view** showing how your notes connect — with an opt-in **Analytics mode** that sizes nodes by importance and groups them into communities. See [docs/graph-analytics.md](docs/graph-analytics.md).
- **Hybrid search.** Semantic plus keyword plus knowledge graph, always on, in-process Rust. Analytics mode also boosts recall by note importance (PageRank).
- **Agent-driven brain maintenance.** Cluster names, future deduplication and folder suggestions all run via your existing Claude / Cursor session. No API keys, no second bill.
- **Compilation loop.** AI maintains canonical wiki pages from your raw notes. Drives Claude Code directly via the copy-pack flow, no API key needed.
- **Multi-vault support.** Switch, rename, delete via the dropdown (bottom-left).
- **Open a folder as vault.** Point NeuroVault at an existing Obsidian vault. The folder stays in place. Deleting the brain never touches the folder.
- **Folders in the sidebar.** Rename a note to `projects/foo.md` and it moves into a folder tree. Right-click any note for the rename / reveal / copy-link / delete menu.
- **Fast-switch.** Ctrl+K, type a brain name, Enter. Per-brain entries in the palette.
- **100 percent local.** Notes never leave your machine.
- **Resizable panels.** Drag to customize layout.

## For AI agents (MCP setup)

**If you installed NeuroVault from the release:**
Open the app, go to **Settings**, and click **Connect Claude Desktop**. It generates the exact JSON for your install path with a one-click copy button, plus a **Show in folder** button for `claude_desktop_config.json`. Restart Claude Desktop after saving.

**If you are running from source**, paste this into Claude Desktop's config (`%APPDATA%\Claude\claude_desktop_config.json` on Windows, `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "neurovault": {
      "command": "uv",
      "args": ["--directory", "C:\\path\\to\\NeuroVault\\server", "run", "python", "mcp_proxy.py"]
    }
  }
}
```

The `mcp_proxy.py` is a tiny stdio-to-HTTP bridge. The real backend (recall, remember, the graph, everything) is the Rust HTTP server bundled inside the Tauri app on `127.0.0.1:8765` — open NeuroVault first, then start your Claude session.

Claude now has persistent memory across conversations. Say things like "remember that I prefer Rust over Go" and NeuroVault saves it. Weeks later, ask "what do I prefer for backend work?" and Claude recalls it instantly.

---

## For developers

A local-first knowledge layer for AI agents. Not RAG. A living internal wiki.

Most "agent memory" products today are retrieval pipelines in a trench coat: chunk, embed, retrieve, hallucinate, repeat. NeuroVault is what you get when you stop treating memory as search over a pile of chunks and start treating it as a structured, updatable, inspectable, human-editable knowledge base that an AI can read, write, and challenge.

Concretely, NeuroVault is:

- A **local markdown vault** you own forever (`~/.neurovault/brains/{name}/vault/*.md`).
- A **Tauri desktop app** for humans to explore what the agent knows. Neural graph view, wikilinks, hover previews, backlinks with paragraph context, Cmd+K command palette.
- An **MCP server** agents connect to directly (Claude Desktop, Claude Code, any MCP client).
- A **hybrid retrieval engine** (semantic plus BM25 plus knowledge graph, RRF fusion, Ebbinghaus strength decay).
- A **silent fact-capture pipeline** that listens to conversation and quietly promotes casually-dropped facts to first-class memories with wiki-link provenance back to where you said them.

Every memory is a plain `.md` file. The database is an index. If the index breaks, rebuild from files. You own your brain.

![NeuroVault graph view with the Filters panel open](website/assets/screenshots/02-filter-panel.png)

*The graph view with the Filters panel open. Force-directed brain in the centre, orphan halo around it. The right-side panel groups every customisation knob — search, edge-type filters, node-size slider, layout shape, force tuning, time-lapse playback. Live: drag any slider and the graph updates without a re-render.*

### More views

| | |
|---|---|
| ![Semantic edges enabled](website/assets/screenshots/04-graph-semantic-on.png) | ![Cmd+K command palette](website/assets/screenshots/07-palette.png) |
| **Semantic edges enabled.** Toggle the inferred-similarity layer. `manual` wikilinks, `entity` co-mentions, `semantic` embedding matches each have their own colour. | **Cmd+K command palette.** Three sections in one prompt — *Commands* (fuzzy), *Notes* (title search), *Memory* (semantic recall after 3+ characters). |
| ![Compile review queue + agent compile flow](website/assets/screenshots/08-compile-agent.png) | ![Note tabs](website/assets/screenshots/05-tabs-context-menu.png) |
| **Compile review queue.** Pending compiles wait in the left rail; clicking one shows the wiki page and a changelog with paragraph-level provenance back to the sources. Approve or reject. The `auto-approve` toggle skips the queue for trusted agent runs. | **VS Code-style tabs.** Drag to reorder, middle-click to close, right-click for Close / Close others / Close all. Always visible when any note is open. |
| ![Sidebar collapsed](website/assets/screenshots/06-sidebar-collapsed.png) | ![Settings — About](website/assets/screenshots/09-settings-about.png) |
| **Sidebar collapse (Ctrl+B).** Hide the left sidebar so the editor or graph fills the full width. Persists across sessions. | **Settings — About.** Brand mark + version. Theme, density, server controls, MCP connection diagnostics live above this section. |

---

## How it works

```
You write a note in the editor
  -> Auto-saved as markdown in your vault
  -> File watcher triggers ingestion pipeline
  -> Text chunked, embedded locally, entities extracted, knowledge graph updated

You drop a fact in conversation ("I prefer Tauri 2.0 over Electron")
  -> UserPromptSubmit hook silently runs it through a regex extractor
  -> 8 patterns catch preferences, decisions, deadlines, identities, stacks
  -> Each fact becomes a first-class kind='insight' engram
  -> With a wiki-link back to the original observation for provenance

You ask the agent a question
  -> Agent calls recall() via MCP
  -> Hybrid search: semantic plus BM25 plus knowledge graph, fused via RRF
  -> Recent or contested decisions get a score bonus; dormant ones fade
  -> Top memories returned at a flat ~275 tokens regardless of vault size
  -> Agent answers with context it could not have had before

After meaningful exchanges
  -> Write-back extracts durable facts and saves them as new notes
  -> Strength decay reinforces what you keep using; lets unused notes fade
  -> Brain grows from every conversation, decays what you stop touching

(Heavy maintenance — consolidation, theme rollups, code-graph analysis —
 lives in opt-in Python tools the user invokes on demand. Nothing runs in
 the background by default after v0.1.1.)
```

---

## Why this is not RAG

RAG is an answer-pipeline. You have a question, chunk and embed a corpus, retrieve K chunks, stuff them in the context window, generate, repeat. The corpus is dead data. The retrieval step has no memory of past retrievals. Contradictions are invisible. Provenance is a prayer.

NeuroVault is a knowledge layer. It differs from RAG in five specific ways that map directly to what a living internal wiki needs:

| What a wiki needs | RAG's answer | NeuroVault's answer |
|---|---|---|
| **Accumulate over time** | re-chunk, re-embed | Ebbinghaus strength decay plus access reinforcement. Used facts stay strong; unused ones fade. |
| **Structure** | flat chunks | Karpathy's 3-layer raw/wiki/schema pattern, engrams typed as `note`/`source`/`quote`/`draft`/`insight`/`observation`. |
| **Link** | none | Three automatic connection types (semantic similarity, shared entities, explicit `[[wikilinks]]`) plus a force-directed graph view. |
| **Provenance** | cite the chunk | Silent fact capture that promotes casually-dropped facts and stores `**Source:** [[observation-...]]` wiki-links back to the exact prompt where they were said. |
| **Challenge or update** | none | Temporal fact tracking. When a new fact contradicts an existing one, the old fact is marked superseded and takes a recency penalty in retrieval so it stops polluting answers. |

Reproducible benchmark on the fact-capture pipeline ([`server/benchmarks/bench_usefulness.py`](server/benchmarks/bench_usefulness.py)): 15 casual factual statements seeded via the `UserPromptSubmit` hook, probed with 15 paraphrased questions that never use the original wording.

| Metric | Score |
|---|---|
| Hit@1 (correct fact is the #1 result) | **80%** |
| Hit@3 (correct fact in top 3) | **100%** |
| Hit@5 (correct fact in top 5) | **100%** |
| MRR (mean reciprocal rank) | **0.878** |
| Tokens per answer | **~275** (flat regardless of vault size) |
| Paste-whole-vault baseline | ~93,000 tokens, grows linearly |

237 Python tests green. Every claim on this page is reproducible locally.

## Features

### Multiple brains

Separate memory spaces for different projects. Each brain has its own vault, database, and knowledge graph. Switch instantly via the dropdown or MCP.

### Hybrid retrieval

Three signals merged via Reciprocal Rank Fusion:

- **Semantic search** (50%): vector similarity across multi-granularity chunks.
- **BM25 keywords** (30%): term matching for exact phrases.
- **Knowledge graph** (20%): entity resolution plus 2-hop traversal.

Optional cross-encoder reranking for maximum precision.

### Memory strength

Ebbinghaus forgetting curve with access reinforcement. Frequently retrieved memories stay strong. Unused ones naturally fade. The system prioritizes what matters.

### Neural graph view

Force-directed visualization of your knowledge graph. Nodes sized by usage, colored by strength (amber is active, teal is connected, gray is dormant). Click to open, drag to pin.

### Auto write-back

After every meaningful exchange, Claude extracts durable facts and saves them as new notes. Decisions, preferences, technical choices, all captured without any effort from you.

### Silent fact capture

Drop a fact casually in conversation and NeuroVault picks it up without you saying "remember this".

```
You:   I prefer Tauri 2.0 over Electron for desktop apps.
You:   We decided to use sqlite-vec for embeddings.
You:   Remember that Sarah runs the weekly check-ins.

...later, in a fresh session...

You:   what desktop framework do I like?
Claude: You prefer Tauri 2.0 over Electron (noted Apr 14, 2026).
```

A UserPromptSubmit lifecycle hook pipes every prompt through a regex-based extractor that recognises 8 patterns: preferences, decisions, stack choices, deadlines, identity, anti-preferences, deployment targets, and explicit "remember that..." callouts. Each extracted fact becomes a first-class `kind='insight'` engram with a wiki-link back to the original observation for provenance.

Guarantees:

- Runs in microseconds (regex only, no LLM call, no API key).
- Questions, commands, and weak pronominal phrases ("the API", "a thing") are rejected.
- Bounded to 3 extractions per message. No vault flooding.
- Deterministic filenames upsert duplicates instead of multiplying them.
- `<private>...</private>` blocks are stripped before extraction.

See the bench numbers below.

### Note interconnection

Three types of links computed automatically:

- **Semantic:** cosine similarity between note embeddings.
- **Entity:** shared people, concepts, technologies.
- **Wikilinks:** explicit `[[references]]` in your markdown.

### Session wake-up

On session start, NeuroVault provides layered context:

- **L0** (~100 tokens): core identity facts.
- **L1** (~300 tokens): top 10 active memories.
- **L2** (dynamic): pulled on demand via `recall()`.

---

## Quick start

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://rustup.rs/)
- [Python](https://www.python.org/) 3.13+ — only required if you want the opt-in advanced features (compile, PDF ingest, Zotero sync)
- [uv](https://docs.astral.sh/uv/) — same; not needed for the daily-use path

### Install

```bash
git clone https://github.com/sirdath/NeuroVault.git
cd NeuroVault

# Frontend
npm install
```

### Run

```bash
# One terminal. The Tauri shell hosts the React frontend AND the
# in-process Rust HTTP server on 127.0.0.1:8765 — there's nothing
# else to start.
npx tauri dev
```

For a release build:

```bash
npx tauri build
# Installer drops at src-tauri/target/release/bundle/nsis/NeuroVault_*.exe
```

### Connect Claude Desktop

The installed app has a one-click connector under **Settings → Connect Claude Desktop**. For source builds, paste this into your Claude Desktop config:

```json
{
  "mcpServers": {
    "neurovault": {
      "command": "uv",
      "args": [
        "--directory", "/path/to/NeuroVault/server",
        "run", "python", "mcp_proxy.py"
      ]
    }
  }
}
```

Restart Claude Desktop. The NeuroVault tools appear once NeuroVault.exe is open (the proxy bridges to its HTTP server).

---

## MCP tools

The proxy exposes these tools to any MCP-speaking agent (Claude Desktop, Claude Code, Cursor, ...). Every tool accepts an optional `brain` parameter to target a specific brain without switching active brain.

| Tool | What it does |
|------|-------------|
| `recall(q, mode, limit, rerank?)` | Hybrid search — semantic + BM25 + graph fusion via RRF, optional cross-encoder rerank. PageRank importance prior when Analytics mode is on. |
| `recall_chunks(q, limit)` | Same retrieval but returns matching paragraphs instead of whole notes. Cheaper. |
| `related(engram_id, hops, link_types?)` | Direct neighbours of an engram via the graph. ~50× cheaper than a fresh recall. |
| `remember(content, title?, dedupe?)` | Save a memory (triggers chunk + embed + entity extraction + graph link). |
| `session_start(agent_id?, since?)` | Wake-up tool: brain stats + L0 identity + top memories + open todos in one call. |
| `core_memory_set` / `_append` / `_replace` / `_read` | Persona-style always-included blocks (Letta pattern). |
| `list_brains` / `switch_brain` / `create_brain` | Multi-brain navigation. |
| `check_duplicate(content, threshold)` | Pure cosine pre-check before remember(). |
| `list_unnamed_clusters` / `set_cluster_names` | **New v0.1.1**: agent-driven cluster naming for the graph view's Analytics mode. See [docs/graph-analytics.md](docs/graph-analytics.md). |
| `add_todo` / `claim_todo` / `complete_todo` / `list_todos` | Multi-agent coordination via append-only todos.jsonl. |

---

## Architecture

```
+-------------------------------------------------+
|  Tauri 2 desktop app (React 19 + TypeScript)    |
|  Editor / Graph / Compile / Sidebar / Palette   |
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
|  brain.db, vault/*.md, raw/, assets/, cache/    |
+-------------------------------------------------+

External:
  + Python lives in server/ but is OPT-IN only —
    spawned as a one-shot subprocess for advanced
    features (compile pages, PDF ingest, Zotero,
    code-graph). Never runs at app boot.
  + mcp_proxy.py is a tiny stdio→HTTP bridge for
    MCP clients; it doesn't hold state.
```

### Data storage

```
~/.neurovault/
├── brains.json                    # Brain registry
└── brains/
    └── {brain_id}/
        ├── brain.db               # SQLite + sqlite-vec index
        ├── config.json            # Per-brain settings
        ├── vault/                 # CANONICAL — your markdown notes
        │   ├── concepts/  decisions/  entities/
        │   ├── summaries/ inbox/
        │   ├── index.md, log.md, CLAUDE.md
        ├── raw/                   # CANONICAL — explicit inputs
        │   ├── pdfs/ pastes/ clips/ imports/
        │   └── conversations/{imported,sessions}/
        ├── assets/                # images / audio referenced by notes
        ├── cache/                 # DERIVED — bm25/embeddings/rerank scratch
        ├── consolidated/          # rolled-up theme summaries (Python opt-in)
        ├── trash/                 # soft delete
        ├── audit.jsonl            # admin tool log
        ├── todos.jsonl            # multi-agent coordination
        └── cluster_names.json     # v0.1.1 — agent-named graph clusters
```

Markdown files in `vault/` and inputs in `raw/` are **canonical**. Everything in `cache/` and `brain.db` is **rebuildable**. If the index breaks, rebuild from the files. You own your brain.

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Desktop | Tauri 2 (~30 MB installed, no Electron) |
| Frontend | React 19, TypeScript (strict), Tailwind v4, Zustand |
| Editor | CodeMirror 6 with custom dark theme |
| Graph | `react-force-graph-2d` + `react-force-graph-3d` (lazy-loaded), `@dnd-kit/sortable` for tab drag |
| **Backend (in-process)** | **Rust + axum HTTP server, fastembed-rs ONNX embeddings, rusqlite + sqlite-vec, notify file watcher, parking_lot, tokio** |
| Vector search | sqlite-vec (KNN in pure SQL) |
| Embeddings | BAAI/bge-small-en-v1.5 (384 dims, local, free) |
| Keywords | BM25 (Rust port of Okapi) |
| Graph metrics | Vanilla TS PageRank + Louvain, ~250 lines, no dependency |
| MCP bridge | FastMCP — `server/mcp_proxy.py` forwards stdio to HTTP |
| Advanced features | Python CLI subprocesses (opt-in: compile, PDF, Zotero, code-graph) |

---

## Performance

| Operation | Time |
|-----------|------|
| Embed a note | ~20 ms |
| Recall (no reranker) | ~73 ms median |
| Recall (with reranker) | ~133 ms median |
| Full vault ingest (25 notes) | ~4 s cold start |
| Semantic link computation (1000 notes) | ~50 ms (numpy-accelerated) |

### Retrieval quality (reproducible benchmark)

Run `cd server && uv run python ../benchmarks/run_recall.py` to verify these numbers locally. The benchmark uses 25 hand-crafted notes and 25 queries (5 easy, 10 medium, 10 hard).

| Mode | Top-1 | Top-3 | Top-5 | MRR | Median latency |
|------|-------|-------|-------|-----|----------------|
| Hybrid (default) | **92%** | **96%** | 96% | 0.94 | 73 ms |
| Hybrid plus cross-encoder rerank | **92%** | **100%** | 100% | 0.96 | 133 ms |

Hard queries (no keyword overlap, semantic understanding required): **9/10 top-1** without reranker.
Easy queries (direct keyword match): **5/5** in both modes.

### Silent fact capture quality (end-to-end bench)

Run `cd server && uv run python benchmarks/bench_usefulness.py` to reproduce. The bench seeds 15 casual factual statements via the `UserPromptSubmit` hook (the same path Claude Code uses), then probes recall with 15 paraphrased questions that never use the original wording.

| Metric | Score |
|---|---|
| Hit@1 (correct fact is the #1 result) | **80%** |
| Hit@3 (correct fact in top 3) | **100%** |
| Hit@5 (correct fact in top 5) | **100%** |
| MRR (mean reciprocal rank) | **0.878** |
| Median recall latency | ~900 ms |

**Token economics** (from the same bench):

- Roughly 275 tokens per recall answer, flat regardless of vault size.
- Pasting the whole vault as context: 93k+ tokens and grows linearly.
- Break-even vs. manually re-explaining ~15 facts each session: around 17 facts.
- For real projects with hundreds of captured facts, savings exceed **99 percent**.

### Cost

| | NeuroVault | Mem0 Pro | Zep Flex |
|---|---|---|---|
| Annual cost (1000 notes) | **$0.55** | $2,988 | $300 |
| Graph features | Included | $249/mo extra | Included |
| Local and private | Yes | No | No |
| Open source | Yes (MIT) | No | Partial |

---

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+N` | New note |
| `Ctrl+S` | Save |
| `Ctrl+P` | Toggle editor / graph |
| `Ctrl+B` | Toggle memory panel |
| `Ctrl+K` | Focus search |

---

## Testing

```bash
cd server

# Fast tests (~12s)
uv run pytest tests/ -v -k "not reranker"

# Full suite with cross-encoder (~2 min)
uv run pytest tests/ -v

# TypeScript
cd .. && npx tsc --noEmit

# Rust
cd src-tauri && cargo check
```

237 Python tests covering database, embeddings, chunking, ingestion, retrieval, strength decay, write-back, insight extraction, impact analysis, and review context.

---

## Design

Dark theme with a warm, intentional feel:

- **Background:** `#07070e` (deep navy black).
- **Accent:** `#f0a500` (amber, active memories, CTAs).
- **AI elements:** `#00c9b1` (teal, links, indexing).
- **Typography:** Lora (editor), JetBrains Mono (code), Geist (UI).

---

## Roadmap

### Shipped (v0.1.0 + v0.1.1)

- [x] Markdown editor with auto-save, drag-to-reorder tabs, right-click context menu, safe-delete confirm dialog
- [x] MCP server with 18+ tools (recall / remember / related / session_start / core_memory_* / multi-brain / todos / clusters)
- [x] Hybrid retrieval (semantic + BM25 + graph) with optional cross-encoder rerank
- [x] Memory strength with Ebbinghaus decay
- [x] Multi-brain support
- [x] Silent fact capture (8-pattern regex extractor)
- [x] **Rust in-process backend** — retired the always-on Python sidecar; advanced features are now opt-in subprocesses
- [x] **Brain layout reshape** — `vault/{concepts,decisions,...}/`, `raw/`, `assets/`, `cache/`, `config.json`
- [x] **Graph view v2** — palette + shape + cluster-label customization, edge confidence rendering, hover-only labels
- [x] **Analytics mode** — opt-in PageRank node sizing + Louvain community tints + tip bar
- [x] **Recall importance boost** — Analytics-gated PageRank prior in the RRF fusion
- [x] **`/name-clusters` skill** — agent-driven cluster naming via MCP, no API keys

### Backlog (v0.1.2+)

- [ ] Cross-platform builds via GitHub Actions (macOS `.dmg`, Linux `.AppImage`)
- [ ] Eval matrix run to validate the PageRank recall boost (~1% hit@1 lift expected)
- [ ] More agent-fix MCP skills: `/find-duplicates`, `/file-inbox`, `/lint-frontmatter`
- [ ] Conversation substrate — `raw/conversations/sessions/` + auto-distillation pipeline
- [ ] Benchmark suite (LongMemEval, LoCoMo)
- [ ] Bridge/betweenness graph halos (cut from v0.1.1; revisit if requested)
- [ ] Code signing / notarization (kills SmartScreen + Gatekeeper warnings)
- [ ] Mobile companion (read-only — write needs the desktop's local-first guarantees)

---

## License

MIT

---

Built with Claude. Remembers everything.
