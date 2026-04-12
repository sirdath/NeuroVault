# NeuroVault

**Local-first AI memory system for Claude.**

Claude forgets you after every conversation. NeuroVault doesn't.

NeuroVault gives Claude persistent memory across sessions — automatically, locally, and without any cloud dependency. It is three things simultaneously:

1. A **markdown note editor** (Tauri desktop app)
2. A **local AI memory database** (SQLite + vector search)
3. An **MCP server** that Claude connects to directly

Everything runs on your machine. Your notes are plain `.md` files you own forever.

---

## How It Works

```
You write a note in the editor
  → Auto-saved as markdown in your vault
  → File watcher triggers ingestion pipeline
  → Text chunked → embedded locally → entities extracted → knowledge graph updated

You ask Claude a question
  → Claude calls recall() via MCP
  → Hybrid search: semantic + keywords + knowledge graph
  → Top memories returned with relevance scores
  → Claude answers with full context of your vault

After Claude responds
  → Write-back extracts durable facts from the exchange
  → New facts auto-saved as notes
  → Brain grows from every conversation
```

## Features

### Multiple Brains
Separate memory spaces for different projects. Each brain has its own vault, database, and knowledge graph. Switch instantly via the dropdown or MCP.

### Hybrid Retrieval
Three signals merged via Reciprocal Rank Fusion:
- **Semantic search** (50%) — vector similarity across multi-granularity chunks
- **BM25 keywords** (30%) — term matching for exact phrases
- **Knowledge graph** (20%) — entity resolution + 2-hop traversal

Optional cross-encoder reranking for maximum precision.

### Memory Strength
Ebbinghaus forgetting curve with access reinforcement. Frequently retrieved memories stay strong. Unused ones naturally fade. The system prioritizes what matters.

### Neural Graph View
Force-directed visualization of your knowledge graph. Nodes sized by usage, colored by strength (amber = active, teal = connected, gray = dormant). Click to open, drag to pin.

### Auto Write-Back
After every meaningful exchange, Claude extracts durable facts and saves them as new notes. Decisions, preferences, technical choices — captured without any effort from you.

### Note Interconnection
Three types of links computed automatically:
- **Semantic** — cosine similarity between note embeddings
- **Entity** — shared people, concepts, technologies
- **Wikilinks** — explicit `[[references]]` in your markdown

### Session Wake-Up
On session start, NeuroVault provides layered context:
- **L0** (~100 tokens): Core identity facts
- **L1** (~300 tokens): Top 10 active memories
- **L2** (dynamic): Pulled on demand via `recall()`

---

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://rustup.rs/)
- [Python](https://www.python.org/) 3.13+
- [uv](https://docs.astral.sh/uv/)

### Install

```bash
git clone https://github.com/daththeanalyst/NeuroVault.git
cd NeuroVault

# Frontend
npm install

# Backend
cd server && uv sync --extra dev
```

### Run

```bash
# Terminal 1: Start the memory server
cd server && uv run python -m engram_server --http-only

# Terminal 2: Start the desktop app
cargo tauri dev
```

### Connect Claude Desktop

Add to your Claude Desktop config (`%APPDATA%\Claude\claude_desktop_config.json` on Windows, `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "neurovault": {
      "command": "uv",
      "args": [
        "--directory", "/path/to/NeuroVault/server",
        "run", "python", "-m", "engram_server"
      ]
    }
  }
}
```

Restart Claude Desktop. The 9 NeuroVault tools will appear.

---

## MCP Tools

| Tool | What it does |
|------|-------------|
| `remember` | Save a memory (triggers full ingestion pipeline) |
| `recall` | Hybrid search with semantic + BM25 + graph fusion |
| `forget` | Mark a memory as dormant |
| `list_memories` | List all memories with strength and connections |
| `get_related` | Find related notes via knowledge graph |
| `save_conversation_insights` | Extract and save facts from conversation |
| `list_brains` | List all available brains |
| `switch_brain` | Switch active memory space |
| `create_brain` | Create a new brain for a project |

Every memory tool accepts an optional `brain` parameter to target a specific brain without switching.

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Tauri Desktop App (React + TypeScript)         │
│  Editor · Graph View · Memory Panel · Sidebar   │
└──────────────────────┬──────────────────────────┘
                       │ HTTP :8765
┌──────────────────────▼──────────────────────────┐
│  Python MCP Server (FastMCP)                    │
│  9 tools · hybrid retrieval · write-back        │
│  Also: stdio transport for Claude Desktop       │
└──────────────────────┬──────────────────────────┘
                       │ SQL
┌──────────────────────▼──────────────────────────┐
│  SQLite + sqlite-vec                            │
│  6 tables · 12 indexes · vector search          │
│  ~/.engram/brains/{name}/brain.db               │
└─────────────────────────────────────────────────┘
```

### Data Storage

```
~/.engram/
  brains.json                    # Brain registry
  brains/
    default/
      vault/*.md                 # Your notes (source of truth)
      brain.db                   # SQLite + vectors + knowledge graph
    project-alpha/
      vault/*.md
      brain.db
```

Markdown files are always the source of truth. The database is an index. If it breaks, rebuild from files.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop | Tauri 2.0 (10MB vs Electron's 150MB) |
| Frontend | React 19, TypeScript (strict), Tailwind v4 |
| Editor | CodeMirror 6 with custom dark theme |
| Animation | Framer Motion |
| State | Zustand |
| Graph | Canvas API (custom force simulation) |
| MCP | FastMCP |
| Vector Search | sqlite-vec (KNN in pure SQL) |
| Embeddings | BAAI/bge-small-en-v1.5 (384 dims, local, free) |
| Keywords | rank-bm25 |
| File Watching | watchdog |
| HTTP API | FastAPI + uvicorn |

---

## Performance

| Operation | Time |
|-----------|------|
| Embed a note | ~20ms |
| Recall (no reranker) | ~73ms median |
| Recall (with reranker) | ~133ms median |
| Full vault ingest (25 notes) | ~4s cold start |
| Semantic link computation (1000 notes) | ~50ms (numpy-accelerated) |

### Retrieval Quality (reproducible benchmark)

Run `cd server && uv run python ../benchmarks/run_recall.py` to verify these numbers locally. The benchmark uses 25 hand-crafted notes and 25 queries (5 easy, 10 medium, 10 hard).

| Mode | Top-1 | Top-3 | Top-5 | MRR | Median latency |
|------|-------|-------|-------|-----|----------------|
| Hybrid (default) | **92%** | **96%** | 96% | 0.94 | 73ms |
| Hybrid + cross-encoder rerank | **92%** | **100%** | 100% | 0.96 | 133ms |

Hard queries (no keyword overlap, semantic understanding required): **9/10 top-1** without reranker.
Easy queries (direct keyword match): **5/5** in both modes.

### Cost

| | NeuroVault | Mem0 Pro | Zep Flex |
|---|---|---|---|
| Annual cost (1000 notes) | **$0.55** | $2,988 | $300 |
| Graph features | Included | $249/mo extra | Included |
| Local/private | Yes | No | No |
| Open source | Yes (MIT) | No | Partial |

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+N` | New note |
| `Ctrl+S` | Save |
| `Ctrl+P` | Toggle Editor / Graph |
| `Ctrl+B` | Toggle Memory Panel |
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

49 Python tests covering database, embeddings, chunking, ingestion, retrieval, strength decay, and write-back.

---

## Design

Dark theme with a warm, intentional feel:

- **Background**: `#07070e` (deep navy black)
- **Accent**: `#f0a500` (amber — active memories, CTAs)
- **AI elements**: `#00c9b1` (teal — links, indexing)
- **Typography**: Lora (editor), JetBrains Mono (code), Geist (UI)

---

## Roadmap

- [x] Markdown editor with auto-save
- [x] MCP server with 9 tools
- [x] Hybrid retrieval (semantic + BM25 + graph)
- [x] Cross-encoder reranking
- [x] Memory strength with Ebbinghaus decay
- [x] Auto write-back from conversations
- [x] Neural graph view
- [x] Memory panel with transparency
- [x] Multi-brain support
- [x] Performance optimizations (numpy, batch queries, indexes)
- [ ] PyInstaller packaging for one-click install
- [ ] Cross-platform builds (macOS, Linux)
- [ ] Benchmark suite (LongMemEval, LoCoMo)
- [ ] Mobile companion app

---

## License

MIT

---

Built with Claude. Remembers everything.
