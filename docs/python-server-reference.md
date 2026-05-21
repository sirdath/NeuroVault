# Python server — feature reference (archived)

> **Status:** archived. The Python server (`server/neurovault_server/`) was deleted in 2026-05 because the Rust port covers the load-bearing surface and nothing in the UI was using the Python-only features. This document captures **what existed and why**, so future Rust work has the design context without needing the deleted code.
>
> If you ever want one of these features back: this doc tells you what shape it should take. Git history has the original implementation if you need a starting point.

## Codebase shape at archive time

- **18,619 LOC across ~50 `.py` files**
- ~100 HTTP endpoints (~50 unique to Python, the rest mirrored in Rust)
- Top-5 files: `server.py` (2873 LOC, MCP tool registrations), `api.py` (1778, HTTP routes), `retriever.py` (965), `compiler.py` (927), `database.py` (678)
- Dependencies: fastembed, sentence-transformers, sqlite-vec, pydantic, anthropic, loguru, watchdog, rank-bm25, fastapi, uvicorn, pymupdf, numpy

The Rust port (`src-tauri/src/memory/`) replaces ~80% of this surface at ~10× less RAM and ~5× less cold-start latency, and bundles into the Tauri app rather than running as a separate process.

## What the Rust port already covers

| Python module | Rust equivalent |
|---|---|
| `retriever.py` | `src-tauri/src/memory/retriever.rs` — hybrid vec + BM25 + graph + RRF + temporal disambig + optional cross-encoder rerank |
| `embeddings.py` | `src-tauri/src/memory/embedder.rs` — fastembed-rs (BGE-small-en-v1.5), same model, singleton |
| `bm25_index.py` | `src-tauri/src/memory/bm25.rs` — Okapi BM25, k1=1.5/b=0.75/ε=0.25, identical tokenizer |
| `chunker.py` | `src-tauri/src/memory/chunker.rs` — multi-granularity (document/paragraph/sentence) |
| `database.py` | `src-tauri/src/memory/db.rs` + `migrations.rs` + `schema.sql` |
| `brain.py` | `src-tauri/src/memory/db.rs` + brain registry in `paths.rs` |
| `ingest.py` | `src-tauri/src/memory/ingest.rs` |
| `entities.py` | `src-tauri/src/memory/entities.rs` |
| `core_memory.py` | `src-tauri/src/memory/core_memory.rs` + `/api/core_memory/*` |
| `audit.py` | (intentionally not ported — see notes below) |
| `summaries.py` (heuristic L0/L1 generation) | `src-tauri/src/memory/summarizer.rs` — same heuristic |
| `consolidation.py` (decay scheduler) | (not ported — see notes) |
| `hooks.py` (observation capture) | partial: `/api/observations` endpoint ported, rollup not |

## Modules that were Python-only — what they did and why

### Core memory & retrieval improvements (worth porting eventually)

**`retrieval_feedback.py`** (Stage 1 of self-improvement loop)
- Logs top-K results of every `recall()` to a `retrieval_feedback` table.
- When the agent subsequently does an explicit `fetch(engram_id)` within a short window, that counts as a positive usage signal.
- Engrams that get retrieved often but never fetched are deprioritized as noise.
- **Why useful:** turns idle usage into ranking improvements with no LLM calls.
- **Safety rails:** position-bias correction via inverse propensity weighting, per-pass `max_delta` to prevent runaway updates, `strength_floor` to prevent permadeath of rarely-used memories.
- **Rust port note:** the `retrieval_feedback` table is already in `schema.sql` but no writer wired up. Add a hook in `recall_handler` after results are returned.

**`query_affinity.py`** (Stage 2 of self-improvement)
- During consolidation, replays previously-useful queries through the current retriever.
- If a useful engram fell out of top-3, records a learned `(query, engram_id) → boost` mapping.
- The next identical query gets a direct final-score boost for that engram.
- **Why useful:** corrects ranking drift without retraining anything.
- **Schema:** `query_affinity` table already in Rust schema. Replay logic + boost lookup in `retriever.rs` are the missing pieces.

**`consolidation.py`** (sleep cycle)
- Background scheduler that periodically: decays memory strength (Ebbinghaus curve), spreads activation from recently-accessed engrams to neighbors, runs `query_affinity` replays, rolls up stale observations.
- Triggered on a timer (every N hours by default).
- **Rust port note:** strength model exists (`strength.rs` is mentioned in module list but light), no scheduler. A `tokio::time::interval` task started from `lib.rs::run()` is the natural shape.

**`strength.py`** (memory strength model)
- Ebbinghaus forgetting curve: `s(t) = s_0 * exp(-t / τ)` with τ tuned per-state.
- States: `fresh` (< 1 day), `active` (s > 0.70), `connected` (s > 0.40), `dormant` (s ≤ 0.20), `consolidated` (merged with neighbours).
- Access bumps strength back toward 1.0 with diminishing returns (no infinite reinforcement).
- **Why useful:** natural prioritization without manual tagging.
- **Rust port note:** state column exists in `engrams` table, strength field exists, but no decay calculation runs anywhere. Wire into consolidation scheduler.

**`summaries.py`** (tiered summaries — already partial in Rust)
- L0: ~10-20 token abstract for fast scans.
- L1: ~50-80 token overview for decision-making.
- L2: full content (always).
- Heuristic-first generation (no LLM), optional LLM upgrade.
- **Recall pipeline returns the cheapest layer that answers the query;** agent expands to L2 on demand.
- **Rust status:** `schema.sql` has `summary_l0`/`summary_l1` columns. Generation is heuristic-based in `summarizer.rs`. The recall pipeline doesn't yet pick the right layer dynamically — currently returns full content.

### Code intelligence (substantial system, fully Python-only)

**`code_ingest.py` + `ast_extractors.py` + `variable_tracker.py` + `call_graph.py`**
- Tree-sitter based parsing of code files (Python, JS/TS, Rust, Go).
- Extracts: variable declarations (name, scope, type), function signatures (name, params, return type), class definitions, constants, type aliases, imports.
- Tracks: first definition location, all callers, all callees, "stale renames" (variable name changed but old name still referenced).
- Endpoints (deleted): `/api/variables`, `/api/calls/callers/{name}`, `/api/calls/callees/{name}`, `/api/calls/hot`, `/api/calls/dead`, `/api/calls/stale-renames`, `/api/variables/renames`, `/api/variables/stats`, `/api/variables/search`, `/api/ingest-code`, `/api/ingest-repo`.
- **Why useful:** AI coding assistants forget variable names; this lets the agent recall "what was that config variable called" precisely.
- **Cost to port:** real — needs tree-sitter Rust bindings + grammars for each language. ~2k LOC equivalent.
- **Decision rationale:** No UI surface used this. If we want code intelligence back, the cleanest path is probably a separate Rust crate that depends on `tree-sitter`, registered as an optional ingest plugin.

**`impact.py`** (PR review workflow)
- Given a changed file, walks the call graph to find every function that transitively depends on it.
- Bounded BFS with cycle detection.
- Returns the impact radius + risk score.
- **Rust port note:** depends on `call_graph` being ported first.

**`review_context.py`** (token-efficient PR review)
- Given file paths, returns structural summaries instead of raw file content. Inspired by code-review-graph's "6.8× fewer tokens" trick.
- Per tracked symbol: signature, first docstring line, top-N callers, top-N callees, hot_score, top-K NeuroVault engrams whose title matches the symbol.
- **Why useful:** Claude reviews a diff by reading summary + changed lines, not by loading the whole file.

### Knowledge compilation (LLM-as-compiler loop)

**`compiler.py` (927 LOC) + `cli/compile.py`**
- "Compilation": takes a set of source engrams (notes, decisions, conversations) and synthesises a higher-density summary engram.
- LLM-driven (uses Anthropic API). Can be triggered by user (`mcp__neurovault__compile_submit`) or automatically when a topic accumulates enough source material.
- Approval workflow: compiler proposes → user approves/rejects → approved compilations become first-class engrams.
- Endpoints (deleted): `/api/compilations/*` (8 endpoints), `/api/compilations/run`, `/api/compilations/candidates`.
- **Rust port status:** stubs of `compile_prepare` and `compile_submit` MCP tools exist in `mcp_proxy.py`. The LLM driver loop is not ported.
- **Decision rationale:** LLM-driven and approval-gated — fits poorly with the local-first ethos unless the user supplies an API key. Defer until there's a clear product need.

### Drafts (Scrivener-style long-form writing)

**`drafts.py` + `dissertation.py`**
- A "draft" is an ordered collection of engrams plus a title and description.
- Endpoints (deleted): `/api/drafts*` (8 endpoints), `/api/dissertation/*`.
- Section reordering, export (markdown / PDF via pandoc).
- **Decision rationale:** No UI surface uses this. The user can manually compose long-form by reading multiple engrams. Defer.

### Hooks / observation capture (PARTIAL PORT NEEDED)

**`hooks.py` + `observation_rollup.py` + `insight_extractor.py`**
- Claude Code lifecycle hooks (SessionStart, UserPromptSubmit, PostToolUse, SessionEnd) POST to `/api/observations`.
- Each event becomes an "observation engram" tagged with session_id, event type, timestamp.
- `observation_rollup.py`: compresses stale per-event observations into one summary engram per session (saves disk + improves recall signal-to-noise).
- `insight_extractor.py`: scans the conversation for durable facts ("user prefers tabs over spaces", "we decided to use sqlite-vec"), saves them as insight engrams. Optional LLM step.
- **Rust port priority: HIGH** — `/api/observations` write endpoint must be ported because `scripts/neurovault_hook.py` is in the user's active Claude Code settings.json. Rollup + insight extraction can be deferred.

**`write_back.py` + `conversation_log.py`**
- Extracts durable facts from user/assistant exchanges after every response.
- Decides whether to create a new engram and persists if yes.
- Bumps strength on memories that were recalled during the exchange.
- Falls back to local heuristic extraction if no Anthropic API key.
- **Decision rationale:** similar to insight_extractor; defer.

### Ingest extensions

**`pdf_ingest.py`** — PDF → markdown via pymupdf, then standard ingest. ~286 LOC.
**`zotero.py`** — Polls Zotero's Better-BibTeX JSON-RPC endpoint, ingests library items as Source engrams.
**`brain_export.py`** — Brain → tar.gz archive for portability.
**`git_backup.py`** — Auto-commits to a per-brain hidden git repo on every ingest. Invisible to user; recovery story for accidental deletions.
- **Decision rationale:** all unused. The Rust port has `import_folder` for bulk markdown ingest; PDF/Zotero capture can be added later as optional features.

### Audit + feedback

**`audit.py`** (audit.jsonl writer)
- Every MCP tool call is appended to `<brain>/audit.jsonl`: tool name, kwargs, result summary (count + first N ids).
- Best-effort — never blocks a tool call.
- **Decision rationale:** worth porting eventually. ~30 LOC of Rust in `mcp_proxy.py` would replicate, but mcp_proxy is intentionally thin. Better: server-side log middleware.

**`retrieval_feedback.py`** — see "Core memory & retrieval improvements" above.

### Karpathy / Graphify-inspired surfaces

**`karpathy.py`** — auto-maintained `index.md`, `log.md`, `CLAUDE.md` files at the brain root. Pattern from Andrej Karpathy's LLM-wiki.
**`graph_report.py`** — generates `GRAPH_REPORT.md` with structural insights (hub nodes, isolated clusters, suggested merges). Inspired by Graphify.
- **Decision rationale:** both write to vault files, no UI dependency, defer.

### Multi-agent coordination

**`todos.py`** — append-only JSONL store at `<brain>/todos.jsonl`. Idempotent status transitions (claim, complete). Designed for multi-agent handoff.
- **Rust port status:** `todos.rs` exists in Rust. ✓

### Misc

- **`watcher.py`** — watchdog-based vault file watcher → triggers ingest on `.md` changes. Rust port has its own watcher via `notify` crate.
- **`intelligence.py`** — collection of "features stolen from competitors" — query reformulation, related-engram suggestions, etc. Not consolidated enough to summarize per-function; if anything looks interesting, read this file before deletion.
- **`js_sdk.py`** — emits a JS SDK wrapper for the HTTP API so agents can `import { recall } from '...'`. Useful if a JS-native agent ecosystem matters; otherwise dead weight.

## Lessons + design notes worth keeping

1. **The lazy-init pattern in `_LazyBrainManager`** worked: MCP transport starts in milliseconds, the heavy `BrainManager()` init only runs on first attribute access. The Rust equivalent is `OnceCell`-backed initialization in `db::cache()` and `embedder::instance()`.

2. **Multi-granularity chunking matters more than chunk size.** Ingest stores document/paragraph/sentence chunks separately and recall searches across all three. Sentence chunks dominate top-1 precision; document chunks anchor context.

3. **Audit.jsonl was load-bearing for debugging.** Without it, recall bugs are invisible — you only see the agent's hypothesis text, not what recall returned. Worth replicating: append-only JSONL of `{ts, query, top_k_ids, scores}` per recall call, behind an env-var flag.

4. **The Python warmup raced against MCP initialize on Claude Desktop.** Lesson: any heavy init must happen on a deferred path (background thread + delay, OR truly lazy on first tool call), never inside the MCP handshake path.

5. **HF_HUB_OFFLINE matters on cold start.** When the model is cached locally, fastembed still does ~20 HEAD requests to HuggingFace to check freshness. Setting `HF_HUB_OFFLINE=1` skips them. The Rust port should set this when the model dir exists.

6. **Feature flags via env vars beat per-tool MCP tiers.** `NEUROVAULT_MCP_TIER=core` was a workable but coarse knob. A more granular approach: each feature module reads its own enable flag at startup, MCP registration is per-feature.

## What "delete the Python server" means concretely

- ✅ Delete `server/neurovault_server/` (entire package, ~50 files, 18,619 LOC)
- ✅ Delete `server/scripts/__pycache__/engram_hook.cpython-313.pyc` (legacy compiled hook)
- ✅ Strip Python deps from `server/pyproject.toml` — keep only `mcp`
- ✅ Delete `run_python_job` Tauri command in `src-tauri/src/lib.rs` (~150 lines, no UI callers)
- ✅ Delete `runPythonJob` wrapper in `src/lib/tauri.ts` (~15 lines)
- ✅ Delete dead `api.ts` stubs pointing at Python-only endpoints (~30 methods)
- ⚠️ **Before deletion:** port `/api/observations` to Rust so `scripts/neurovault_hook.py` keeps working.

After this cleanup, `server/` contains exactly two Python files: `mcp_proxy.py` (MCP-stdio ↔ HTTP forwarder) and `scripts/neurovault_hook.py` (Claude Code lifecycle hook → HTTP forwarder). Both are thin shims with no heavy deps. The actual backend is `neurovault-server.exe` (Rust).
