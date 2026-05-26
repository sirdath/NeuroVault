# How NeuroVault Works

*A comprehensive engineering reference — enough depth that a future maintainer (or agent) can pick up exactly where the current author left off without re-reading the whole repo.*

---

## Table of contents

1. [What NeuroVault is (and what it isn't)](#1-what-neurovault-is-and-what-it-isnt)
2. [Architecture at 10,000 feet](#2-architecture-at-10000-feet)
3. [What's on disk](#3-whats-on-disk)
4. [The ingest pipeline — how memory gets in](#4-the-ingest-pipeline--how-memory-gets-in)
5. [The retrieval pipeline — how memory comes out](#5-the-retrieval-pipeline--how-memory-comes-out)
6. [The MCP boundary — how agents talk to it](#6-the-mcp-boundary--how-agents-talk-to-it)
7. [The UI — what humans see](#7-the-ui--what-humans-see)
8. [Build and deploy](#8-build-and-deploy)
9. [Design decisions worth knowing](#9-design-decisions-worth-knowing)
10. [Known limits and what to measure before adding more](#10-known-limits-and-what-to-measure-before-adding-more)

---

## 1. What NeuroVault is (and what it isn't)

**One-sentence positioning:** NeuroVault is a persistent, local-first memory layer for AI agents. It remembers things the user tells their agent across conversations, and it does so without a cloud service, a heavyweight Python runtime, or a vector database subscription.

**The problem it solves.** Modern chat assistants (Claude Code, Claude Desktop, Cursor, Codex) have no native long-term memory. Every new session starts from zero. NeuroVault sits between the user's local markdown vault and any MCP-compatible agent, giving that agent a callable `recall()` + `remember()` surface that persists forever.

**What it is not:**
- It is **not** a cloud RAG service. Everything runs on one machine.
- It is **not** a general-purpose vector database. It's a memory system for a specific shape of data (markdown notes + typed metadata).
- It is **not** trying to beat LightRAG or Graphiti on academic benchmarks. It optimises for a different axis: "single user, many agents, no cost per ingest, under 100 ms per retrieval."
- It is **not** a Python app anymore. Phase 0-9 of the migration moved the entire hot path into Rust in-process.

**Concrete numbers** (measured on the current build, April 2026):
- Installer: **9.3 MB** (was 76 MB before the Rust migration).
- Idle RAM: **~35 MB** (was 500 MB – 3 GB with the Python sidecar).
- Cold start: **<500 ms** to interactive.
- Recall latency: **20-50 ms** median for the default pipeline, **~680 ms** when the optional cross-encoder reranker is enabled.
- Quality (internal eval set, 30 queries): **86.67% hit@1 / MRR 0.867** default, **93.33% hit@1 / MRR 0.933** with reranker.

---

## 2. Architecture at 10,000 feet

```
┌─────────────────────────────────────────────────────────────────────┐
│  NeuroVault.exe (Tauri, single process, ~35 MB idle)                │
│                                                                      │
│  ┌──────────────────┐       ┌──────────────────────────────────────┐│
│  │ React UI         │◄─────►│ Rust memory::* modules (in-process)  ││
│  │  - sidebar       │ Tauri │  - retriever (hybrid + rerank)       ││
│  │  - editor        │  IPC  │  - ingest (chunk/embed/link/BM25)    ││
│  │  - graph view    │       │  - recall cache + throttle           ││
│  │  - command palt. │       │  - bm25 index                        ││
│  │  - settings      │       │  - file watcher (notify crate)       ││
│  └──────────────────┘       │  - SQLite + sqlite-vec               ││
│                             │  - fastembed (BGE-small + reranker)  ││
│                             └───┬──────────────────────────────────┘│
│                                 │                                    │
│                             axum HTTP server (127.0.0.1:8765)        │
└─────────────────────────────────┼────────────────────────────────────┘
                                  │ loopback HTTP
                  ┌───────────────┴────────────────┐
                  │ mcp_proxy.py (~30-50 MB)       │
                  │   - FastMCP stdio transport    │
                  │   - urllib → HTTP forwarder    │
                  │   - thin shim, no heavy deps   │
                  └───────────────┬────────────────┘
                                  │ stdio JSON-RPC
                                  ▼
                  ┌────────────────────────────────┐
                  │ Claude Code / Cursor / Desktop │
                  └────────────────────────────────┘
```

**Why this shape**, specifically:

- **One process.** Python had two processes (desktop + sidecar). That meant two fastembed loads, two SQLite connections, two sources of truth. The Rust version collapses that: the memory layer runs *inside* the Tauri process.
- **Tauri, not Electron.** WebView2 is Chromium already installed on Windows — no shipping a second browser. The installer drops to 9 MB instead of 150 MB.
- **HTTP server for agents, Tauri IPC for the UI.** Same code answers both: the UI calls `nv_recall` via Tauri's zero-copy command bus; agents call `/api/recall` over loopback HTTP. Both hit the same `memory::retriever::hybrid_retrieve_throttled`.
- **FastMCP proxy is a separate tiny process.** Claude Code spawns it fresh each session; it imports nothing heavy (`urllib` + `mcp` stdlib-shaped). The actual memory work lives in the always-running `neurovault.exe`. This is the single most important architectural decision: **the heavy stuff never runs in the agent's process tree.**

---

## 3. What's on disk

Everything NeuroVault persists lives under `~/.neurovault/`:

```
~/.neurovault/
├── brains.json                     ← registry: which brain is active
├── extensions/
│   └── vec0.dll                    ← sqlite-vec binary (fallback; bundled in app too)
└── brains/
    └── <brain_id>/
        ├── brain.db                ← SQLite: engrams + chunks + vec_chunks + links + entities
        ├── brain.db-wal            ← WAL journal (concurrent-safe)
        ├── brain.db-shm            ← shared-mem index
        ├── audit.jsonl             ← append-only tool-call log
        ├── trash/                  ← soft-deleted files
        └── vault/
            ├── *.md                ← user-facing markdown (source of truth)
            ├── index.md            ← auto-maintained wiki index
            ├── log.md              ← append-only activity feed
            └── <subdirs>/          ← user-organised folders
```

**The markdown files are the source of truth.** If `brain.db` is ever deleted, it can be rebuilt deterministically by re-ingesting every `.md` file. This is a hard invariant — no memory exists only in the database.

**Key tables in `brain.db`** (full schema in `src-tauri/src/memory/schema.sql`, 24 tables):

| Table | What's in it |
|---|---|
| `engrams` | One row per note: id, filename, title, content, kind, strength, state, tags, agent_id, timestamps |
| `chunks` | Hierarchical chunks at 3 granularities: document / paragraph / sentence |
| `vec_chunks` | sqlite-vec virtual table — 384-dim BGE-small embeddings per chunk |
| `entities` | Named entities (regex-extracted) with mention count + type |
| `entity_mentions` | Entity ↔ engram edges |
| `engram_links` | Typed edges between engrams: semantic / entity / wikilink with link_type + similarity |
| `temporal_facts` | Bi-temporal facts with valid_from/valid_until/superseded_by |
| `working_memory` | Pinned memories always-in-context (Letta-style) |
| `core_memory_blocks` | Agent-editable persona/project/user blocks |
| `query_affinity` | Stage-4 learned query→engram boosts (schema only; logic not fully ported) |
| `retrieval_feedback` | Every recall's top-K + was_accessed flag (for self-improving ranking) |
| `contradictions` | Detected conflicting facts |
| `compilations` | Wiki-page compile history (approve/reject workflow) |

**Embeddings.** Each chunk's `embed_text` is **title-prefixed** (`"{title}: {chunk_content}"`) before encoding. This gives the semantic model topic context — a sentence from a deep note isn't scored in isolation.

---

## 4. The ingest pipeline — how memory gets in

A note becomes a memory when any of three things happens:

1. User creates a note in the UI (`nv_create_note` Tauri command).
2. User saves an existing note (`nv_save_note` or auto-save in the editor).
3. The file watcher detects a change in the vault (external editor, git pull, etc.).

All three paths converge on `memory::ingest::ingest_content(filename, content, db)` in `src-tauri/src/memory/ingest.rs`. Here's what that function does, in order:

```
ingest_content
├── 1. Extract title from first `# ` heading (fallback: filename)
├── 2. Compute SHA-256 content_hash
├── 3. Look up existing engram by filename
│      - if hash matches   → return Ok(None), skip everything below
│      - if no existing    → mint new UUIDv4
│      - if hash differs   → reuse existing id, overwrite
├── 4. UPSERT engrams row (with millisecond-precision timestamps)
├── 5. Set kind by filename prefix (source-, quote-, draft-, question-, theme-, clip-)
├── 6. DELETE old chunks + vec_chunks rows for this engram
├── 7. Chunk at 3 granularities (chunker.rs):
│      - document: title + first 2000 chars (1 chunk)
│      - paragraph: 2-paragraph sliding window, 1200-char cap, min 15 words
│      - sentence: 3-sentence sliding window, 500-char cap, min 6 words
├── 8. embedder::encode_batch(embed_texts) — batch ≤32 for RAM safety
├── 9. INSERT chunks + vec_chunks (with LE-packed float32 bytes)
├── 10. summaries::generate_summaries (L0 + L1 tiered)
├── 11. entities::extract_entities_locally (regex path — headings,
│      wikilinks, backticks, TECH_KEYWORDS, TitleCase, quoted)
├── 12. entities::store_entities (UUIDv5-hashed for dedup)
├── 13. update_semantic_links: O(n) cosine vs all other doc embeddings,
│      insert bidirectional edge if sim ≥ LINK_THRESHOLD (0.75)
├── 14. update_entity_links: A-Mem pattern — shared-entity edges
│      similarity = min(1, 0.5 + shared_count × 0.1)
├── 15. process_wikilinks: [[Target]] or [[Target|type]] — lookup,
│      insert REPLACE-upsert bidirectional edge at similarity 1.0
├── 16. bm25::schedule_rebuild (debounced 5s, coalesces bursts)
└── 17. recall_cache::invalidate_brain(brain_id) — cache drop on write
```

**The `remember()` MCP tool** is a thin wrapper:
1. Derive title from first-line if omitted.
2. If `deduplicate=<threshold>` is set, run `ingest::dedupe_check` first — it embeds the `# title\n\n{content}` form (matching what the chunker would store), KNN-searches `vec_chunks`, deserialises the top match's bytes, computes direct cosine. If the best cosine ≥ threshold, return `{status: "merged", engram_id: <existing>, similarity: <value>}` WITHOUT running the pipeline. Saves ~500 ms per duplicate write.
3. Otherwise, write the markdown file to disk, then call `ingest_content`.

**Safety rails on `remember`** (`http_server.rs`):
- Content > 32 KB rejected with HTTP 413. Agents should split, not dump.
- Embedder batch capped at 32 items per inference (peak RAM ~75 MB regardless of document size).

---

## 5. The retrieval pipeline — how memory comes out

When `recall(query)` fires, the work happens in `memory::retriever::hybrid_retrieve_throttled` (the outer entry point) and `hybrid_retrieve` (the inner pipeline). Full flow:

```
hybrid_retrieve_throttled(db, query, opts)
│
├── throttle::tick(brain_id, top_k)         // 60s rolling counter
│     - 1-3 calls:  pass through
│     - 4-8 calls:  halve top_k
│     - 9+ calls:   return 1 result + sentinel hint
│
├── recall_cache::get(brain, cache_key)     // 60s LRU, epoch-invalidated
│     - hit: return cached result (zero compute)
│     - miss: continue
│
└── hybrid_retrieve(db, query, opts)
    │
    ├── 1. query_parser::parse(query) → (filters, free_text)
    │        Operators: kind:, folder:, after:, before:, entity:, state:, agent:
    │
    ├── 2. build entity_allow_set (if entity: filter present)
    │
    ├── 3. classify_query(free_text) → "keyword" | "natural" | "mixed"
    │        Sets RRF weights: kw→(0.30/0.50/0.20), nat→(0.55/0.25/0.20), mix→(0.45/0.35/0.20)
    │
    ├── 4. classify_temporal_intent → "fresh" | "historical" | "neutral"
    │        Drives recency factor + λ in the exponential age-decay term
    │
    ├── 5. SIGNAL A — semantic KNN:
    │        - embedder::encode_query (hits 1000-entry LRU for repeats)
    │        - sqlite-vec MATCH against vec_chunks, k=candidate_pool (40)
    │
    ├── 6. SIGNAL B — BM25 (bm25.rs):
    │        - tokenise: lowercase, strip md-chrome, stopword-filter, min 2 chars
    │        - Okapi BM25 with k1=1.5, b=0.75, epsilon=0.25
    │        - Runs on both original query + (historical) expanded form
    │        - Batched: bm25_scores merged with 1.2× boost for orig-query hits
    │
    ├── 7. SIGNAL C — graph retrieval (_graph_retrieve):
    │        - extract_entities_locally(query) + word-overlap fallback
    │        - hop-1: entity_mentions → engrams
    │        - hop-2: engram_links with similarity > 0.5, limit 5/node
    │
    ├── 8. RRF fusion:  Σ weight × 1/(60 + rank)
    │        Each signal's rank list contributes its weighted RRF score
    │
    ├── 9. TITLE BOOSTS (the heaviest single factor):
    │        - title_keyword: bidirectional token coverage against (title ∪ slug)
    │          UNCAPPED, coverage ≥ 0.4 → keyword_score ∈ [0.56, 1.0], ×0.30 weight
    │        - title_semantic: cosine(query_emb, title_emb), sim > 0.45, top-10 only, ×0.15 weight
    │        - Title embeddings cached in 4000-entry LRU
    │
    ├── 10. Materialise top-candidate_pool as Candidate rows from engrams table
    │         - apply: filters, dormant-skip, exclude_kinds, as_of cutoff
    │
    ├── 11. OPTIONAL — spreading activation if spread_hops ≥ 1:
    │         - seed_count=3 top candidates radiate 1-hop
    │         - neighbour.rrf = seed_rrf × link_sim × 0.4
    │
    ├── 12. Temporal/supersede adjustment (if !recency_off):
    │         - linear rank-relative spread on updated_at DESC
    │         - exp(-λ × age_days) multiplier, λ per intent
    │         - 50% supersede-penalty per superseded-fact fraction
    │
    ├── 13. OPTIONAL — cross-encoder rerank if use_reranker=true:
    │         - BGE-reranker-base on top-20 (title + first 400 chars)
    │         - sigmoid(logit) blended 30/70 with existing RRF score
    │         - +~650 ms latency, +~7 pts hit@1 (93% vs 86%)
    │
    └── 14. Final score:
           base = rerank_score × 0.75 + strength × 0.15
           final = base × recency_factor + affinity_bonus + insight_bonus
           (decision_bonus was removed in 2026-04-23 — eval showed net-negative)
```

**What the eval matrix told us** (`eval/baselines/`):

| Signal | Effect if removed |
|---|---|
| `title_keyword` | **-30 points hit@1** — the single most critical signal |
| Both title boosts | -50 points — catastrophic |
| `decision_bonus` | **+3.3 points** (noise, now removed) |
| `query_expansion` | **+3.3 points** (noise, now removed) |
| `title_semantic` alone | -7 points hit@3 (helps on near-misses) |
| `recency`, `supersede`, `entity_graph`, `insight_boost` | flat on this set (kept for edge cases) |
| +reranker | **+6.7 points hit@1**, 30× latency (opt-in per call) |

---

## 6. The MCP boundary — how agents talk to it

### The transport stack

```
Claude Code ──spawn──► mcp_proxy.py ──HTTP──► axum on 127.0.0.1:8765 ──► Rust memory::*
             stdio     (~30-50 MB)            (inside neurovault.exe)
```

Claude Code's `~/.claude.json` (or equivalent) registers the proxy via:

```json
{
  "mcpServers": {
    "neurovault": {
      "command": "uv",
      "args": ["--directory", "D:/Ai-Brain/engram/server", "run", "python", "-m", "mcp_proxy"]
    }
  }
}
```

On session start, Claude Code spawns the proxy. The proxy calls `/api/health` to check the desktop app is up, then answers MCP's `tools/list` + `tools/call` by forwarding HTTP requests.

### The tool surface (the agent's contract)

**Read-only (auto-approvable):**
- `recall(query, mode, limit, brain, include_observations, rerank, spread_hops, as_of)` — hybrid search. Primary tool. Supports search operators inside `query`: `kind:`, `folder:`, `after:`, `before:`, `entity:`, `state:`, `agent:`.
- `related(engram_id, hops, limit, min_similarity, link_types, include_observations, brain)` — direct 1-or-2-hop neighbour lookup. ~50× cheaper than a follow-up recall.
- `recall_chunks(query, limit, brain)` — passage-level retrieval when the matching note is huge.
- `session_start(brain)` — bootstrap pack: active brain + recent activity + core memory blocks.
- `list_brains()` — registry dump.
- `check_duplicate(content, threshold, brain)` — "would this be a dup if I saved it?" (prefer `remember(deduplicate=...)` for actual writes).
- `core_memory_read(label, brain)` — read typed persona/project/user blocks.

**Write (gated in auto-allow-read-only mode):**
- `remember(content, title, brain, agent_id, folder, deduplicate)` — save a fact. Always pass `deduplicate=0.92` to avoid clutter.
- `switch_brain(brain_id)` — rotate active brain.
- `create_brain(name, description, vault_path)` — new vault.
- `core_memory_set/append/replace(label, ...)` — Letta-style block edits.

### The agent-efficiency layer

Several features exist specifically so agents don't spam or misuse the memory:

- **Throttle** (`throttle.rs`): 60s rolling counter per brain. Calls 1-3 are normal. 4-8 halve top_k. 9+ cut to one result + inject a synthetic `__throttle_hint__` sentinel into the response.
- **Session cache** (`recall_cache.rs`): identical queries within 60s return the cached result in ~1 ms. Invalidated on any write via brain-level epoch bump. Bounded at 100 entries per brain (~500 KB max RAM).
- **Query operators**: parsed at the retriever entry point, turn into SQL filters BEFORE scoring runs — reducing the candidate pool by up to 90%. One call does the work of several filter+recall round-trips.
- **Dedupe on write**: `remember(content, deduplicate=0.92)` runs a single KNN+cosine check before ingest; on match, returns the matched engram id without running the full chunk/embed/link pipeline.
- **Reranker opt-in**: `rerank=true` on recall adds the cross-encoder second stage. Agents are taught (via tool docstring + server instructions) to use it only when top-1 precision actually matters.

### MCP protocol choices

- **Tool annotations** (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) on every tool so Claude Code can auto-confirm safe ones without user prompts.
- **`outputSchema` + `structuredContent`** — FastMCP auto-derives from Python return types; Claude parses structured JSON instead of regex-ing text.
- **Sentinel resource** at `neurovault://empty` — some strict MCP clients disconnect on empty `resources/list`; this returns a non-empty array of one dummy resource.
- **Deep-link URL scheme** (`neurovault://engram/<id>[?view=graph]`) — Claude emits clickable markdown links; clicks are forwarded to the running app via Tauri's `single-instance` plugin.

---

## 7. The UI — what humans see

Three primary views, togglable via the tab bar or `Ctrl+1/2/3`:

### Editor (`src/components/Editor.tsx`)

- Reader mode default: `react-markdown` + `remark-gfm`, click to toggle edit.
- Edit mode: CodeMirror 6 with markdown syntax, live typing, 1 s auto-save debounce.
- Tab system: opens multiple notes, `Ctrl+W` to close, `Ctrl+Tab` to cycle.
- Wikilink autocomplete: typing `[[` triggers a dropdown of note titles.

### Graph view (`src/components/NeuralGraph.tsx`)

- 2D canvas via `react-force-graph-2d` (default) or 3D via `react-force-graph-3d` (lazy-loaded).
- Nodes coloured by folder (deterministic FNV hash → 12-colour palette); outer ring = state (fresh/connected/dormant); size = access count; opacity = Ebbinghaus strength.
- Edges coloured by `link_type` (semantic, entity, uses, depends_on, contradicts, etc.). Bidirectional pairs curve apart; badges appear at zoom ≥1.6×.
- Folder clusters have floating labels at their centroid (auto-sized to cluster weight).
- Hover → neighbourhood focus (dims everything outside the 1-hop subgraph).
- Cmd+K while on graph view → fuzzy-search notes, pick one → camera tweens + fires sonar pulse ring.
- 3D mode has UnrealBloomPass for glow; particles animate along edges.

### Sidebar (`src/components/Sidebar.tsx`)

- Virtualised note list via `@tanstack/react-virtual` (handles 10k+ notes smoothly).
- Folder tree collapsible.
- Full-text search: `/api/recall` when server is up, local title substring fallback otherwise.
- Drag-to-resize handle with visible 2-dot glyph (discoverability).
- Inline rename, drag-drop between folders.

### Shared UI patterns

- **Command palette** (`Ctrl+K`, `CommandPalette.tsx`): three sections — commands / notes / memory. Fuzzy scored with consecutive-run bonus. Memory section hits `/api/recall` debounced at 220 ms. Throttle hints render distinctly.
- **Quick capture** (`Ctrl+Shift+Space`, `QuickCapture.tsx`): global-shortcut overlay. Writes to inbox silently, no view switch.
- **Hover preview** (`HoverPreview.tsx`): 260-px card with title, L0 summary, strength pill, "View note" button.
- **Activity bar + panel** (`ActivityBar.tsx`, `ActivityPanel.tsx`): bottom status pill shows connected agents + call rate. Click to slide up full audit feed.
- **Themes** (6 options, `settingsStore.ts`): Midnight, Claude, OpenAI, GitHub Dark, Rosé Pine, Nord. CSS-variable driven.
- **Density** (`densityStore.ts`): comfortable / cozy / compact sidebar rows.
- **Toasts** (`Toasts.tsx`): bottom-right. Errors sticky; info/success auto-dismiss at 4 s.

### Keyboard shortcuts (all wired in `App.tsx`)

- `Ctrl+K` — command palette
- `Ctrl+Shift+Space` — quick capture (global)
- `Ctrl+N` — new note
- `Ctrl+S` — save
- `Ctrl+P` — cycle views
- `Ctrl+1/2/3` — editor / graph / compile
- `Ctrl+/` — focus search
- `?` — shortcut help modal
- `Esc` — close overlays

---

## 8. Build and deploy

### Local dev

```bash
cd D:/Ai-Brain/engram
npx tauri dev              # hot-reload frontend + Rust rebuild on change
```

First `tauri dev` on a fresh checkout takes ~3-5 min (downloads + compiles the full crate tree). Incremental recompiles are ~5-30 s for Rust, instant for React.

### Release build

```bash
cd D:/Ai-Brain/engram
npx tauri build            # ~8-15 min first time, ~3-5 min incremental
```

Produces:
- `src-tauri/target/release/neurovault.exe` — 32 MB bare binary (stripped)
- `src-tauri/target/release/bundle/nsis/NeuroVault_0.1.0_x64-setup.exe` — 9.3 MB installer
- `src-tauri/target/release/bundle/msi/NeuroVault_0.1.0_x64_en-US.msi` — 13 MB MSI

### Cargo release profile (the LTO config that matters)

```toml
[profile.release]
lto = "fat"             # cross-crate optimisation; 5-15% speedup on embed hot path
codegen-units = 1        # single-unit compile; 3-10% extra speedup
strip = "symbols"        # 25% smaller exe
panic = "abort"          # smaller binary + slight speedup
```

### SQLite pragmas that matter (`db.rs::apply_startup_pragmas`)

```sql
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;             -- safe under WAL, 2x write throughput
PRAGMA cache_size=-65536;              -- 64 MiB page cache per connection
PRAGMA mmap_size=268435456;            -- 256 MiB mmap region
PRAGMA temp_store=MEMORY;
PRAGMA wal_autocheckpoint=1000;
```

Plus `conn.set_prepared_statement_cache_capacity(64)` on each connection.

### Release to GitHub

```bash
# The legacy Python installer is pinned as rollback target
gh release create v0.1.0-python --prerelease \
    --notes "Legacy Python-sidecar build for rollback" \
    NeuroVault_0.1.0_x64-setup.exe       # the 76 MB one

# The new Rust installer
gh release upload v0.1.0 --clobber \
    NeuroVault_0.1.0_x64-setup.exe \
    NeuroVault_0.1.0_x64_en-US.msi
```

See `scripts/pin-legacy-installer.ps1` for the rollback-pin automation.

### Key bundled resources

- `src-tauri/resources/vec0.dll` — sqlite-vec extension, loaded at runtime via `LoadExtensionGuard` from 4 candidate paths (env var → exe dir → exe dir/resources → ~/.neurovault/extensions). The plugin's `bundle.resources` key in `tauri.conf.json` copies it into the install dir.

---

## 9. Design decisions worth knowing

Every one of these was a real choice between alternatives. Written so a future maintainer can judge whether to reverse them.

### Rust + Tauri, not Python + Electron
- Before: Python FastAPI + PyInstaller sidecar + Electron frontend. 76 MB installer, 500 MB-3 GB RAM, crashed a TDR-prone Intel iGPU laptop regularly.
- After: single Rust+Tauri binary, 9 MB installer, 35 MB idle.
- **Reversibility:** none. This was a 16-day migration (Phases 0-9). Git history `rust-migration` branch preserves the move.

### SQLite + sqlite-vec, not LanceDB / Qdrant / Pinecone
- Sufficient for single-user at 250-10k notes. Beats any alternative on "no services to run."
- Reconsider only if vault grows past ~100k notes (where brute-force cosine over doc embeddings starts costing >100 ms).

### BM25 hand-rolled in Rust, not Tantivy / FTS5
- The hand-roll was ported from the Python version. It works but rebuilds from scratch on startup.
- **Debt:** FTS5 would persist between boots and be transactional with engram writes. Flagged in `docs/` for a future session.

### fastembed-rs BGE-small-en-v1.5 (384-dim), not Nomic / all-MiniLM / cloud
- BGE-small scores ~65 MTEB, 10-15% better than MiniLM at the same speed, same 384 dims.
- Cached at `~/.cache/fastembed/` — shared with the Python version, so migration cost was zero.
- Reconsider if MTEB ever matters for a specific workload; batch cap at 32 keeps RAM bounded.

### Hybrid retrieval (3 signals + RRF + title boosts), not pure semantic
- Pure semantic misses queries that work best as exact phrase match (names, code identifiers). BM25 catches those.
- Title boosts are the single biggest contributor — 30 points hit@1 (per April 2026 eval matrix).
- **Decision bonus + query expansion removed in 2026-04-23** — eval showed both were net-negative.

### Cross-encoder reranker (BGE-reranker-base) as opt-in, not default
- Pushes hit@1 from 87% to 93% but adds ~650 ms latency.
- Most agent calls are quick context checks where 93% vs 87% doesn't matter.
- Agents are explicitly taught when to flip `rerank=true` via tool docstring.

### MCP stdio proxy forwarding to loopback HTTP, not stdio-native Rust server
- The proxy is ~30 MB Python (stdlib only). Claude Code spawns it per session.
- Avoids spawning a full `neurovault.exe` per MCP client. Heavy state stays in the desktop app.
- Loopback HTTP is safer than stdio against CVE-2026-30623 (stdio command-injection).

### Per-brain SQLite files, not one DB with a brain_id column
- Clean separation — switching brains is `open(brain_id)` on a fresh connection.
- Deleting a brain is `rm -rf` the directory; no residual rows elsewhere.
- Backup is "copy this folder."

### Markdown files as source of truth, not database-only
- User can edit notes in any editor. Git commits work. If the DB corrupts, rebuild by walking the vault.
- File watcher (`notify` crate) catches external edits; 500 ms per-file debounce coalesces editor save bursts.

### Strength decay (Ebbinghaus), not static scores
- Memories fade if never accessed. Reinforced by reads. This is what makes it a *memory* system, not a *search* system.
- Lives in the `strength` column on engrams; the retriever multiplies it into final_score at 0.15 weight.

---

## 10. Known limits and what to measure before adding more

**Scale ceiling (estimated, untested):**
- At ~5k notes: fastembed batch of 115 chunks starts taking noticeable wall-clock. Current 32-batch cap handles it fine.
- At ~10k notes: brute-force cosine in `update_semantic_links` starts adding 100+ ms per write. Consider ANN (HNSW) at that point.
- At ~30k notes: graph view starts stuttering in `react-force-graph-2d`. Migrate to `cosmograph.gl` (WebGL GPU-sim).

**Retrieval quality gaps** (from 2026-04-23 eval):
- Queries with vocabulary that doesn't appear in note content or title (e.g. "force-directed visualisation" when the note is "Neural Graph View"). The reranker fixes these but costs 650 ms.
- Multi-hop reasoning ("find notes that connect X and Y without mentioning both"). The spread-activation helps but isn't as strong as LightRAG's LLM-built graph.

**Things to measure before investing engineering effort:**
1. **Always re-run the eval matrix after scoring changes.** `python eval/run_eval.py --matrix` gives the grid in 5 min.
2. **Any "this feature improves retrieval" claim needs ablation data.** The decision bonus LOOKED smart and tested as net-negative. Don't trust intuition.
3. **Latency is measured end-to-end.** `median_ms` and `p95_ms` are in every eval report; if a change regresses either by >20%, it needs to pay for itself in hit@k.

**Things the author was tempted to build and defers for evidence:**
- Tantivy / FTS5 swap — waiting on BM25 to actually become a bottleneck.
- LightRAG-style LLM-extracted graph — waiting on benchmark showing the current graph signal is weak.
- Typed-entity panels in the UI — Capacities pattern; worth it if user has identity/project/technology entities they'd benefit from distinct layouts for.
- Background reconciliation on boot — Obsidian-style mtime-diff walk. Waiting on a user with a large vault (>1k notes) reporting sluggish boot.
- Cosmograph.gl graph view — deferred until current view stutters.

---

## Appendix: file map

The places a future maintainer will actually be reading/editing:

**Rust backend (`src-tauri/src/memory/`):**
- `retriever.rs` — the hybrid pipeline. Longest file. Start here for retrieval questions.
- `ingest.rs` — the write pipeline. Start here for write/chunk/embed questions.
- `bm25.rs` — in-memory BM25 with 5 s debounced rebuild.
- `embedder.rs` — fastembed singleton with 1000-entry query LRU + 32-item batch cap.
- `reranker.rs` — BGE-reranker-base cross-encoder wrapper.
- `db.rs` — connection lifecycle, pragmas, per-brain cache.
- `schema.sql` — 24-table schema (byte-identical to the Python version).
- `http_server.rs` — axum routes; matches what Python's FastAPI served.
- `watcher.rs` — notify crate + 500 ms debounce.
- `chunker.rs` — 3-granularity hierarchical chunking + wikilink extraction.
- `summaries.rs` — L0/L1 summary generation (regex-based).
- `entities.rs` — regex entity extraction + UUIDv5-hashed store.
- `related.rs` — 1-or-2-hop neighbour lookup (the `get_related` tool).
- `query_parser.rs` — the `kind:/folder:/after:` operator grammar.
- `recall_cache.rs` — 60 s LRU with brain-level epoch invalidation.
- `throttle.rs` — 60 s rolling counter, staircase decay.
- `read_ops.rs` — read-only queries (list_notes, get_note, get_graph, brain_stats).
- `write_ops.rs` — file+ingest bundles (create_note, save_note, delete_note).
- `paths.rs` — canonical `~/.neurovault/...` path helpers.
- `sqlite_vec.rs` — extension loader with 4 candidate paths.

**Frontend (`src/`):**
- `components/NeuralGraph.tsx` — 800-line graph view.
- `components/Editor.tsx` — CodeMirror + markdown preview.
- `components/Sidebar.tsx` — virtualised note list.
- `components/CommandPalette.tsx` — fuzzy search + memory hits.
- `components/SettingsView.tsx` — theme/density/fontSize/brain management.
- `stores/*Store.ts` — Zustand state (noteStore, graphStore, brainStore, hoverPreviewStore, settingsStore, densityStore, toastStore, compilationStore).
- `lib/tauri.ts` — Tauri command wrappers with browser fallbacks.
- `lib/api.ts` — HTTP API client, prefers `nv_*` Tauri commands with graceful fallback.

**MCP proxy (`server/`):**
- `mcp_proxy.py` — the only file that matters for MCP integration.
- `neurovault_server/` — Python codebase kept for advanced features (compile, pdf ingest, zotero). Spawned on-demand via `run_python_job` Tauri command, not as a persistent process.

**Eval (`eval/`):**
- `testset.jsonl` — 30 hand-curated queries with expected title matches.
- `run_eval.py` — runs the set, computes hit@k + MRR, supports `--ablate`, `--rerank`, `--matrix`.
- `baselines/*.json` — saved eval snapshots for before/after comparison.
- `README.md` — how to add cases + iterate.

**Config:**
- `src-tauri/Cargo.toml` — Rust deps + `[profile.release]` LTO config.
- `src-tauri/tauri.conf.json` — bundle config + deep-link scheme.
- `src-tauri/capabilities/default.json` — Tauri IPC allow-list.
- `vite.config.ts` — frontend bundler.
- `package.json` — npm deps.

---

*Last updated: 2026-04-23 after the Tier A agent-efficiency + Tier 1 perf + reranker + ablation-driven scoring cuts.*
