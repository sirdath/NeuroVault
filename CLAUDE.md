# CLAUDE.md — Engram Build Specification

> You are Claude, operating as the primary developer of the Engram project.
> Read this file before writing code. This is the source of truth.

## What is Engram?

A **local-first, open source, AI-native memory system** for Claude and other LLMs.

**One sentence:** Claude forgets you after every conversation. Engram doesn't.

Three components:
1. **Tauri 2.0 desktop app** (React + TypeScript) — markdown note editor + neural graph view
2. **Python MCP server** (FastMCP) — 6 tools, hybrid retrieval, ingestion pipeline, write-back
3. **SQLite database** (~/.engram/brain.db) — sqlite-vec for vectors, knowledge graph

## Architecture

```
Tauri App (React) --file I/O--> ~/.engram/vault/*.md <--watchdog-- Python Server
Tauri App --HTTP :8765--> Python Server (status, graph, strength)
Claude Desktop --stdio/MCP--> Python Server (6 tools + 1 resource)
```

## MCP Tools

1. `remember(title, content)` — save memory, triggers full ingestion
2. `recall(query, limit)` — hybrid search: semantic + BM25 + graph + cross-encoder rerank
3. `forget(engram_id)` — mark dormant
4. `list_memories(tag)` — list with connections
5. `get_related(title, limit)` — knowledge graph traversal
6. `save_conversation_insights(user_message, assistant_response)` — write-back

Resource: `engram://session-context` — L0/L1 wake-up context

## Development

```bash
# Install
npm install
cd server && uv sync --extra dev

# Dev (two terminals)
cd server && uv run python -m engram_server   # Terminal 1: Python server
cargo tauri dev                                 # Terminal 2: Tauri app

# Test
cd server && uv run pytest tests/ -v

# Build
make build
```

## Rules

1. One phase at a time. Complete before moving on.
2. Tests are part of every deliverable.
3. TypeScript strict mode, no `any`.
4. Markdown files are source of truth, DB is an index.
5. Small commits: `feat(mcp): add recall tool with hybrid search`
