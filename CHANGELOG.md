# Changelog

All notable changes to NeuroVault are documented in this file.

The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

Categories used: **Added**, **Changed**, **Fixed**, **Performance**, **Security**,
**Deprecated**, **Removed**.

---

## [Unreleased]

### Added — agent ergonomics
- `session_start(agent_id?, since?)` MCP tool + `GET /api/session_start` — one-call
  wake-up that packs brain info, stats, L0 identity facts, top-5 memories, open
  todos for this agent, and an optional diff feed into a single response.
- `remember_batch([{content, title?}])` MCP tool — writes N facts in one round trip
  instead of N separate tool calls.
- `recall_and_read(query, top_k=1)` MCP tool — combines hybrid retrieval with
  full-body fetch so `recall`-then-`get_note` becomes a single call.
- `recall_chunks(query, top_k=10, granularity='paragraph')` MCP tool +
  `GET /api/recall/chunks` — returns the matching passages from each engram
  instead of whole notes. Typical 10-chunk reply is 2–4k tokens vs 10–40k for
  whole-engram recall on long wiki pages.
- `check_duplicate(content, threshold=0.85)` MCP tool + `POST /api/check_duplicate`
  — pure read-only similarity check, no LLM call. `remember()` response now
  surfaces a `likely_duplicate` hint when a near-duplicate (sim ≥ 0.92) is found.
- `tool_menu()` core MCP tool — returns an index of capabilities available in
  power/code/research tiers without loading their schemas into context.
- `execute_js(code, timeout_ms=15000)` MCP tool + `POST /api/execute_js` — runs a
  JS snippet via the user's local Node.js with an auto-generated `neurovault.mjs`
  SDK auto-imported. Lets agents chain multi-step operations in one round trip
  with intermediate results staying in the JS runtime. Per Anthropic's
  code-execution-with-MCP research, this pattern cuts token usage by up to 98.7%
  on complex workflows.

### Added — multi-agent coordination
- Per-brain append-only `todos.jsonl` store with five primitives: `add_todo`,
  `claim_todo`, `complete_todo`, `list_todos`, `get_todo`. MCP tools + HTTP
  endpoints. Status machine: open → claimed → done; claim is FIFO by agent
  match; complete is idempotent. 12 tests in `test_todos.py`.
- `GET /api/changes?since=<iso>` — diff feed returning engrams touched since an
  ISO timestamp. Lets long-running sessions detect what moved without re-running
  a broad `recall`.

### Added — external-folder vaults (Obsidian-style)
- Brains can register any absolute folder as their vault via `vault_path`. DB +
  scratch still live at `~/.neurovault/brains/{id}/`; vault points externally.
  Deleting an external-vault brain removes registry + internal scratch but
  **never touches the user's folder**.
- `BrainContext.external_vault_path`, `CreateBrainRequest.vault_path`,
  `lib.rs:vault_dir()` reads `brains.json[].vault_path`. Missing/moved paths
  fall back to internal with a logged warning.

### Added — folders as first-class storage
- Note filenames are now relative paths (e.g. `agent/foo.md`). MCP `remember()`
  with `agent_id != 'user'` auto-routes into `agent/`. `ingest_vault` walks
  subdirs via rglob.
- Sidebar renders a collapsible folder tree grouped by first path segment.
  Expand state persists in localStorage.
- Drag a note onto a folder header to move it. Rename-with-slash (e.g. rename
  `foo.md` to `projects/foo.md`) moves across folders and creates the folder if
  missing.

### Added — agent-driven compile workflow
- `POST /api/compilations/prepare` returns a source pack (topic, existing wiki,
  sources, contradictions, schema) with no LLM call — no `ANTHROPIC_API_KEY`
  needed.
- `POST /api/compilations/submit` persists an agent-written wiki, shows up in
  the review queue identical to an LLM-driven compile.
- `CompilationReview` UI has a collapsible "Compile with an agent" panel:
  Prepare → Copy pack → paste into Claude Code → paste wiki back → Submit.

### Added — other
- Export brain as .zip via new Rust command `export_brain_as_zip` + a download
  icon in the `BrainSelector` row hover toolbar. External-folder brains pack
  their markdown under `<brain_id>/external_vault/` in the archive.
- Editor footer shows `N words · M chars · K min read` (238 wpm, WCAG 2.3.3
  reduce-motion compliant).
- Ingest progress banner during a brain switch — polls
  `/api/brains/{id}/ingest_status` and shows a progress bar + the current file.
- Auto-refresh of the `NeuralGraph` view when notes change.
- MCP Setup section in Settings that auto-detects the sidecar path and Claude
  Desktop config location, generates a ready-to-paste JSON, and offers a "Show
  in folder" button (uses `explorer /select,` on Windows, `open -R` on macOS).
- Brain rename (pencil icon on hover), delete (with external-vs-internal
  confirmation copy), storage stats (notes + MB).
- Full-text search in the sidebar via `/api/recall` with a local title+path
  fallback when the server is offline.
- Command palette (Ctrl+K) gets dynamic "Switch to [Brain Name]" entries plus
  Open Settings, Connect Claude Desktop, Hide Window.
- Seven themes with full CSS-variable compliance: Midnight, Claude, OpenAI,
  GitHub Dark, Rosé Pine, Nord, Obsidian. Reduce Motion actually disables
  transitions globally.
- Tab persistence + Ctrl+1/2/3 shortcuts (Editor / Graph / Compile).

### Changed
- `remember()` now accepts `remember(content, title="")` — title is auto-derived
  from the first sentence of content when omitted. Same behavior in
  `POST /api/notes`.
- `recall()` preview output slimmed by default: dropped `strength` and `state`
  fields (pass `include_meta=True` to restore). About 30% fewer tokens per
  result.
- Core-tier MCP tool docstrings compressed from 30–40 lines to 3–5 lines. Saves
  ~3k tokens of schema at session start.
- Sidebar note filename storage changed from leaf (`foo.md`) to relative path
  (`agent/foo.md`). Back-compat: existing flat notes render at root.

### Fixed
- **Contradiction detector** (`_facts_conflict`) rewritten with embedding-based
  topic matching + explicit supersede markers. The 2025 detector fired on any
  pair sharing 3+ content words with "not" in one side (thousands of false
  positives on real vaults like added/removed, free/paid, yes/no). New rule:
  cosine similarity in [0.55, 0.92] AND a marker like "switched from",
  "no longer", "instead of", "used to". +8 tests covering the false-positive
  regressions.
- Four silent-no-op hook commands in `~/.claude/settings.json` that still
  referenced `scripts.engram_hook` after the engram→neurovault rename.
- `delete_note` (Rust) now flattens subfolder paths into trash and
  suffix-disambiguates collisions, instead of failing when the target directory
  doesn't exist.
- `POST /api/notes` response body now echoes `agent_id` so callers can confirm
  multi-agent tagging.
- `PATCH /api/notes/{id}` for rename+move in one call — atomically moves the
  file on disk, updates the DB, and rewrites the vault fingerprint so next boot
  doesn't re-ingest the pair as delete+add (which would orphan connections).

### Performance
- **Async slow-phase ingest**: `remember()` + `POST /api/notes` return after
  the fast phase (file + engram row + chunks + embeddings, ~100 ms). Slow phase
  (BM25 rebuild, semantic links, entities, wikilinks, temporal facts, karpathy
  index, git) runs on a single-worker thread pool. p50 latency dropped from
  2–5 s to **107 ms** (24–46× faster). Notes are recallable via semantic search
  immediately after return.
- Chunk-level retrieval pipeline (`chunk_retrieve`) — semantic KNN + BM25 fused
  via RRF, per-engram dedup, granularity filter. Massive token savings on long
  notes.
- Optional cross-encoder reranker (`recall(rerank=True)`) — adds ~50ms for a
  meaningful precision lift on ambiguous queries. Gracefully skips when
  `sentence-transformers` isn't installed (e.g. in the stripped sidecar).
- `extract_temporal_facts` pre-batches embeddings of all current facts once per
  ingest instead of re-embedding per comparison (1000 × 20 = 20k embed calls →
  ~1020).

### Security
- Tauri `ExitRequested` handler now kills the sidecar on app exit so the server
  can't survive the app and eat port 8765 indefinitely.

---

## [0.1.0] — TBD

Initial public release. Tauri desktop app + Python MCP server + SQLite (with
sqlite-vec) knowledge graph. Draft release notes will be assembled from the
Unreleased section above when this version is tagged.

---

[Unreleased]: https://github.com/daththeanalyst/NeuroVault/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/daththeanalyst/NeuroVault/releases/tag/v0.1.0
