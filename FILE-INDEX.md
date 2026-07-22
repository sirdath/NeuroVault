# NeuroVault — File Index

> **Every tracked file in this repo, with a one-line purpose.** 384 files, grouped by area.
> Generated 2026-07-15, updated 2026-07-16 after the Tier A–C cleanup (22 files removed).
> Build artifacts are excluded (`node_modules/`, `src-tauri/target/`, `dist/`, `.fastembed_cache/`, `.git/`).

**How to read this.** Find your area below, scan for the file. A ⚠ _[X]_ badge marks a
[cleanup candidate](#cleanup-candidates) (X = tier). Large binary/generated bulk (icon sets,
lockfiles, benchmark data) is folded into one `glob (N files)` row — every such file is still
counted in the coverage check. This doc is **regenerable**: re-run the indexing workflow rather
than hand-editing rows. Markdown is canonical for note content; the search
indexes in `brain.db` are rebuildable, while structured state and history are
not. In the same spirit, this file describes the tree, it isn't the tree.

## Map

| Area | What it is | Open first |
|------|-----------|-----------|
| **Rust backend** — `src-tauri/` | Tauri app + in-process memory engine + native MCP server (the product) | `src-tauri/src/memory/mod.rs` |
| **Frontend** — `src/` | React/TS UI in the Tauri webview: editor, neural graph, settings | `src/App.tsx` |
| **Docs** — `docs/` + root | Specs, guides, handoffs, branding, benchmark data | `docs/HOW-NEUROVAULT-WORKS.md` |
| **Sub-projects** | VS Code extension, npm-publish scaffolding, Python eval, e2e | `vscode-extension/src/extension.ts` |
| **Config, CI & root** | CI workflows, build scripts, brand assets, governance | `.github/workflows/ci.yml` |

## Rust backend — `src-tauri/`

A thin Tauri GUI shell (feature-gated behind `gui`) sitting on a large, GUI-free memory engine. The same crate builds the desktop app **and** the headless `neurovault-server` / MCP binaries. Start at `src-tauri/src/lib.rs` → `app.rs`, or dive into the engine at `src-tauri/src/memory/mod.rs`.

### Memory engine — `src-tauri/src/memory/`

| File | Purpose |
|------|---------|
| `src-tauri/src/memory/adaptive/composer.rs` | ContextComposer: assembles sectioned context packets from recipe outputs. |
| `src-tauri/src/memory/adaptive/consolidate.rs` | Memory consolidation engine (shadow mode) proposing merges/summaries. |
| `src-tauri/src/memory/adaptive/mod.rs` | Adaptive-memory module root: typed memories, intent routing, recipes. |
| `src-tauri/src/memory/adaptive/orchestrator.rs` | Executes a ContextRecipe: runs its sections and gathers retrieval. |
| `src-tauri/src/memory/adaptive/proposals.rs` | Proposal store for consolidation stage 2 (pending edits). |
| `src-tauri/src/memory/adaptive/recipes.rs` | ContextRecipe registry mapping recall intent to context sections. |
| `src-tauri/src/memory/adaptive/router.rs` | MemoryRouter: classifies a prompt into a recall intent. |
| `src-tauri/src/memory/adaptive/salience.rs` | Salience scoring: how much a memory matters now. |
| `src-tauri/src/memory/adaptive/temporal.rs` | temporal_diff: reconstruct memory state over time (bitemporal). |
| `src-tauri/src/memory/adaptive/types.rs` | Typed memory shapes (WorkingState, PlaybookRule, etc.). |
| `src-tauri/src/memory/ambient.rs` | Ambient-recall engine behind POST /api/ambient_recall for coding agents. ⚠ _[D]_ |
| `src-tauri/src/memory/api_audit.rs` | Append-only audit log for the external API gateway. |
| `src-tauri/src/memory/api_gateway.rs` | External (non-loopback) HTTP API gateway, sibling to http_server. |
| `src-tauri/src/memory/api_keys.rs` | API-key data model and storage for the gateway. |
| `src-tauri/src/memory/bm25.rs` | In-memory BM25 keyword index with debounced rebuild. |
| `src-tauri/src/memory/chunker.rs` | Hierarchical text chunking plus wikilink extraction. |
| `src-tauri/src/memory/cluster_state.rs` | Per-brain Louvain community summaries and named-cluster registry. |
| `src-tauri/src/memory/core_memory.rs` | Core-memory blocks (Letta/MemGPT persona/context pattern). |
| `src-tauri/src/memory/db.rs` | Per-brain brain.db connection lifecycle (open/close/count). |
| `src-tauri/src/memory/diagnostic.rs` | Brain health scorecard computed from the database. |
| `src-tauri/src/memory/embedder.rs` | Local text embedding via fastembed-rs (BGE-small ONNX). |
| `src-tauri/src/memory/employee.rs` | AI-employee fleet engine: roster, per-employee loops, guardrails. ⚠ _[D]_ |
| `src-tauri/src/memory/entities.rs` | Local regex-based entity extraction. |
| `src-tauri/src/memory/facts.rs` | Fact-supersession extraction: pull current revised values. |
| `src-tauri/src/memory/graphify.rs` | Parse a codebase into the local knowledge graph (tree-sitter). |
| `src-tauri/src/memory/handlers/mod.rs` | HTTP handler functions and request/response types (god-module). ⚠ _[D]_ |
| `src-tauri/src/memory/hooks.rs` | Automatic memory for Claude Code via ambient hooks. |
| `src-tauri/src/memory/http_server.rs` | Loopback axum HTTP server on 127.0.0.1:8765. |
| `src-tauri/src/memory/inbox.rs` | Drop-folder inbox: staging area for files to convert to notes. |
| `src-tauri/src/memory/ingest.rs` | End-to-end ingest pipeline: chunk, embed, persist, entities. |
| `src-tauri/src/memory/journal.rs` | Event Journal: append-only episodic record of what happened. |
| `src-tauri/src/memory/mcp/forward.rs` | HTTP forwarder turning MCP tool calls into :8765 requests. |
| `src-tauri/src/memory/mcp/instructions.txt` | MCP server instructions text served to connecting agents. |
| `src-tauri/src/memory/mcp/mod.rs` | Native MCP stdio server root for --mcp-only. |
| `src-tauri/src/memory/mcp/registry.rs` | Data-driven MCP tool registry (loads tools.json). |
| `src-tauri/src/memory/mcp/server.rs` | The rmcp ServerHandler implementation. |
| `src-tauri/src/memory/mcp/tools.json` | Declarative MCP tool definitions and JSON schemas. |
| `src-tauri/src/memory/migrations.rs` | Idempotent schema migrations for brain.db. |
| `src-tauri/src/memory/mod.rs` | memory module root: declarations, re-exports, Python-to-Rust map. |
| `src-tauri/src/memory/pagerank_state.rs` | Per-brain PageRank scores held in-memory. |
| `src-tauri/src/memory/paths.rs` | Canonical path helpers (nv_home, brain_dir, vault_dir, db_path). |
| `src-tauri/src/memory/port_recovery.rs` | Self-heal bind failure when port held by stale process. |
| `src-tauri/src/memory/preference.rs` | Preference extraction: index explicit user assertions as facts. |
| `src-tauri/src/memory/query_parser.rs` | Parse kind:/folder:/after: operator queries into structured filters. |
| `src-tauri/src/memory/read_ops.rs` | Read-path queries behind Tauri commands (notes/graph/stats). |
| `src-tauri/src/memory/recall_cache.rs` | Session-level recall result cache. |
| `src-tauri/src/memory/related.rs` | get_related: cheap graph-neighbour lookup around an engram. |
| `src-tauri/src/memory/reranker.rs` | Cross-encoder reranker via fastembed TextRerank. |
| `src-tauri/src/memory/retriever.rs` | Hybrid retrieval: sqlite-vec + BM25 + graph + RRF + rerank. ⚠ _[D]_ |
| `src-tauri/src/memory/roles.rs` | Employee role registry: catalog of hireable AI employees. |
| `src-tauri/src/memory/rrf.rs` | Reciprocal Rank Fusion helper. |
| `src-tauri/src/memory/schema.sql` | CREATE-IF-NOT-EXISTS schema for brain.db (port of Python SCHEMA_SQL). |
| `src-tauri/src/memory/source_mirror.rs` | Per-brain source-folder mirror/sync engine. |
| `src-tauri/src/memory/spread.rs` | Spreading activation: expand candidate pool via graph. |
| `src-tauri/src/memory/sqlite_vec.rs` | Loader for the sqlite-vec SQLite extension. |
| `src-tauri/src/memory/summaries.rs` | Tiered per-engram summaries (L0 abstract + L1 overview). |
| `src-tauri/src/memory/throttle.rs` | Per-session recall throttle to prevent context spam. |
| `src-tauri/src/memory/todos.rs` | Append-only multi-agent todos/handoff queue. |
| `src-tauri/src/memory/tool_audit.rs` | Per-brain MCP-tool audit log. |
| `src-tauri/src/memory/types.rs` | Shared data types for the Rust memory layer. |
| `src-tauri/src/memory/watcher.rs` | Cross-platform vault file watcher (notify crate). |
| `src-tauri/src/memory/write_ops.rs` | Write-path helpers: create/save/delete/supersede notes. |

### App shell, binaries, tests & config

| File | Purpose |
|------|---------|
| `src-tauri/build.rs` | Build script; runs tauri_build only when gui feature is enabled. |
| `src-tauri/capabilities/default.json` | Tauri permission set for the main app window. |
| `src-tauri/capabilities/employee-manager.json` | Capability for feature-flagged-off employee-manager window; inert, not declared in tauri.conf.json. ⚠ _[J]_ |
| `src-tauri/capabilities/minitab.json` | Capability for the floating minitab status/toggle window. |
| `src-tauri/Cargo.lock` | Cargo dependency lockfile pinning exact crate versions. |
| `src-tauri/Cargo.toml` | Crate manifest: deps, gui feature gate, release profile, bin targets. |
| `src-tauri/dmg/background.png` | macOS DMG installer background image. |
| `src-tauri/resources/vec0.dll` | Prebuilt sqlite-vec SQLite extension for Windows, bundled at build. |
| `src-tauri/resources/vec0.dylib` | Prebuilt sqlite-vec SQLite extension for macOS, bundled at build. |
| `src-tauri/src/app.rs` | Tauri desktop shell: IPC commands, windows, sidecar spawn; oversized, carries legacy .engram/Python-sidecar plumbing. ⚠ _[D]_ |
| `src-tauri/src/bin/neurovault-api.rs` | Headless external HTTP API-gateway binary; near-duplicate of neurovault-server's gateway startup. ⚠ _[C]_ |
| `src-tauri/src/bin/neurovault-server.rs` | Standalone HTTP + stdio-MCP server binary (--mcp-only); the bundled agent sidecar. |
| `src-tauri/src/bin/nv-bench.rs` | Local benchmark harness: graphify ingestion + LongMemEval retrieval metrics. |
| `src-tauri/src/lib.rs` | Crate root; exposes memory engine plus gui-gated app module and run(). |
| `src-tauri/src/main.rs` | Desktop binary entrypoint; calls run() under gui feature, else errors out. |
| `src-tauri/tauri.conf.json` | Tauri app config: windows, CSP, updater, bundle, dmg, resources. |
| `src-tauri/tests/adaptive_scenario.rs` | Integration test: adaptive-memory 'consulting room' scenario regression gate. |
| `src-tauri/tests/graphify_integration.rs` | Integration test: graphify a repo over a real loopback axum server. |
| `src-tauri/tests/notes_scope.rs` | Integration test: per-brain note listing stays brain-scoped/isolated. |
| `src-tauri/tests/retrieval_integration.rs` | Integration test: fixed-fixture recall regression gate for retrieval scoring. |
| `src-tauri/updater-ci.conf.json` | CI config overlay enabling updater-artifact creation on release builds. |

### App & platform icons — `src-tauri/icons/`

| File | Purpose |
|------|---------|
| `src-tauri/icons/{32x32,64x64,128x128,128x128@2x}.png (4 files)` | Desktop app-icon PNG sizes; conf bundles 32/128/128@2x (64 spare) |
| `src-tauri/icons/android/mipmap-*/*.png (15 files)` | Android launcher icons (base/foreground/round) across 5 densities ⚠ _[J]_ |
| `src-tauri/icons/android/mipmap-anydpi-v26/ic_launcher.xml` | Android adaptive-icon def: foreground drawable + background color ⚠ _[J]_ |
| `src-tauri/icons/android/values/ic_launcher_background.xml` | Defines ic_launcher_background color (#fff) for adaptive icon ⚠ _[J]_ |
| `src-tauri/icons/icon.icns` | macOS app icon bundle; referenced by tauri.conf bundle.icon |
| `src-tauri/icons/icon.ico` | Windows app icon; referenced by tauri.conf bundle.icon |
| `src-tauri/icons/icon.png` | Master 1024² source icon; tauri icon regenerates the whole set from this |
| `src-tauri/icons/ios/AppIcon-*.png (18 files)` | iOS AppIcon set at all required sizes and @1x/2x/3x scales ⚠ _[J]_ |
| `src-tauri/icons/Square*Logo.png + StoreLogo.png (10 files)` | Windows Store/MSIX tile logos at 30-310px plus StoreLogo |

## Frontend — `src/`

A React/TypeScript app rendered in the Tauri webview. `main.tsx` picks a window mode; `App.tsx` is a lazy-loading router over the views. State lives in Zustand `stores/`; heavy non-React logic lives in `lib/`. All backend contact funnels through `lib/api.ts` (+ `lib/tauri.ts`).

### Entrypoints, HTML shells & assets

| File | Purpose |
|------|---------|
| `graph-preview.html` | Vite HTML shell serving the NeuralGraph dev preview |
| `index.html` | Production Vite HTML shell; mounts #root and loads main.tsx |
| `preview.html` | Vite HTML shell serving the Memory Review dev preview |
| `src/App.shortcuts.test.tsx` | Test locking number-row view shortcuts to a stable map |
| `src/App.tsx` | Top-level view router and app shell wiring consumer surfaces |
| `src/assets/vault-mark-transparent.png` | Transparent vault mark; imported by splash, minitab, settings, nav |
| `src/graph-preview-main.tsx` | Dev-only harness rendering NeuralGraph standalone via graph-preview.html |
| `src/index.css` | Global design-system stylesheet: theme CSS vars, Tailwind (617 lines) |
| `src/main.tsx` | React entry; routes main/minitab/employee windows by query param |
| `src/preview-main.tsx` | Dev-only harness rendering MemoryInspector standalone via preview.html |
| `src/test/setup.ts` | Vitest setup: jest-dom, cleanup, matchMedia/ResizeObserver mocks |
| `src/vite-env.d.ts` | Vite client type declarations reference |

### Components — `src/components/`

| File | Purpose |
|------|---------|
| `src/components/ActivityPanel.tsx` | Memory activity feed panel, embedded inside TrustCenter |
| `src/components/AnalyticsTipBar.tsx` | On-graph contextual tip bar for analytics mode |
| `src/components/AtlasGraph.tsx` | Sigma.js graph-engine renderer for large atlas snapshots ⚠ _[D]_ |
| `src/components/AttentionCenter.tsx` | Pending/history attention tabs wrapping the memory-review surface |
| `src/components/BrainDiagnostic.tsx` | On-canvas brain health/diagnostic overlay for the graph |
| `src/components/BrainSelector.test.tsx` | Tests for BrainSelector vault list |
| `src/components/BrainSelector.tsx` | Vault/brain picker list with sort and stats |
| `src/components/BrainSourcesPanel.tsx` | Ingest-sources panel: last-synced, add/remove brain sources |
| `src/components/CommandPalette.tsx` | Ctrl-K fuzzy command palette |
| `src/components/ConfirmDialog.test.tsx` | Tests for ConfirmDialog |
| `src/components/ConfirmDialog.tsx` | Styled in-app confirmation modal replacing window.confirm |
| `src/components/ConnectionsCenter.tsx` | Connections/integrations hub (MCP + sources) consumer surface |
| `src/components/ConsumerNavigation.test.tsx` | Tests for ConsumerNavigation |
| `src/components/ConsumerNavigation.tsx` | Consumer-mode navigation between top-level destinations |
| `src/components/ContextMenu.tsx` | Reusable right-click context-menu primitive |
| `src/components/CuratorOrb.tsx` | Animated Curator AI-employee orb SVG ⚠ _[D]_ |
| `src/components/Editor.tsx` | CodeMirror markdown editor with tabs and drag reorder |
| `src/components/editor/completions.ts` | CodeMirror slash-command + [[wikilink]] autocomplete extensions |
| `src/components/editor/livePreview.ts` | CodeMirror Obsidian-style live-preview syntax concealment |
| `src/components/editor/theme.ts` | CodeMirror editor theme and syntax-highlight styles |
| `src/components/EmployeeCharacter.tsx` | Geometric SVG face for AI employees; dormant cluster ⚠ _[D]_ |
| `src/components/EmployeeManager.tsx` | AI-Employees fleet tab (separate window); EMPLOYEES_ENABLED=false ⚠ _[D]_ |
| `src/components/EmployeePanel.tsx` | Curator mission-control panel; dormant, EMPLOYEES_ENABLED=false ⚠ _[D]_ |
| `src/components/ErrorBoundary.test.tsx` | Tests for ErrorBoundary |
| `src/components/ErrorBoundary.tsx` | Top-level React error boundary wrapping the app tree |
| `src/components/GraphFilterPanel.tsx` | Slide-out graph controls: filters, display, forces, time-lapse |
| `src/components/GraphLegend.tsx` | On-canvas analytics-mode color/shape legend |
| `src/components/Home.test.tsx` | Tests for Home pulse view |
| `src/components/Home.tsx` | Compact daily memory-pulse dashboard view |
| `src/components/HoverPreview.tsx` | Cached hover tooltip previewing a note's content |
| `src/components/MemoryInspector.tsx` | Context Trace inspector UI; mounted only by preview harness ⚠ _[J]_ |
| `src/components/MemoryReview.test.tsx` | Tests for MemoryReview |
| `src/components/MemoryReview.tsx` | Trust-ceremony review of pending remembered memories |
| `src/components/Minitab.tsx` | Frameless always-on-top mini backend-control window |
| `src/components/NeuralGraph.tsx` | Force-directed neural knowledge-graph canvas; main graph view ⚠ _[D]_ |
| `src/components/Onboarding.tsx` | First-run onboarding flow |
| `src/components/QuickCapture.test.tsx` | Tests for QuickCapture |
| `src/components/QuickCapture.tsx` | Quick note/memory capture input with title derivation |
| `src/components/SearchView.tsx` | Hybrid search view (all/notes/remembered modes) |
| `src/components/SettingsView.test.tsx` | Tests for SettingsView |
| `src/components/SettingsView.tsx` | Settings screen: MCP tier, sources, appearance, brains |
| `src/components/ShortcutHelp.test.tsx` | Tests for ShortcutHelp |
| `src/components/ShortcutHelp.tsx` | Keyboard-shortcut cheat-sheet overlay |
| `src/components/Sidebar.preview.test.tsx` | Tests for Sidebar preview behavior |
| `src/components/Sidebar.resize.test.tsx` | Tests for Sidebar resize behavior |
| `src/components/Sidebar.tsx` | Note-list / file-tree sidebar with resize |
| `src/components/SplashScreen.tsx` | Animated app-open splash with neural rings |
| `src/components/Toasts.test.tsx` | Tests for Toasts |
| `src/components/Toasts.tsx` | Toast notification stack with tone variants |
| `src/components/TrashPanel.tsx` | Deleted-notes trash panel with restore |
| `src/components/TrustCenter.test.tsx` | Tests for TrustCenter |
| `src/components/TrustCenter.tsx` | Trust hub (overview/history) embedding ActivityPanel |
| `src/components/UpdateButton.tsx` | Top-bar update pill: checks and installs releases |

### Logic & state — `src/lib` · `src/stores` · `src/hooks` · `src/workers`

| File | Purpose |
|------|---------|
| `src/hooks/useHoverPreview.ts` | Hook returning mouseenter/leave handlers for the preview card |
| `src/lib/api.ts` | HTTP client for the in-process Rust backend at 127.0.0.1:8765 |
| `src/lib/atlasLayoutCache.ts` | IndexedDB cache of computed Atlas graph layouts, keyed by fingerprint |
| `src/lib/atlasLayoutTypes.ts` | Clone-safe protocol types shared by Atlas renderer and layout worker |
| `src/lib/atlasPatterns.test.ts` | Tests for Atlas coordinate-transform patterns |
| `src/lib/atlasPatterns.ts` | Named coordinate transforms (spiral/radial/globe/islands) for Atlas scenes |
| `src/lib/atlasVisualModel.test.ts` | Tests for the Atlas visual scene builder |
| `src/lib/atlasVisualModel.ts` | Pure scene builder collapsing graph edges into a visual model |
| `src/lib/brainScopedUiState.ts` | Helpers for per-brain UI state keys and preview cache |
| `src/lib/config.ts` | Single source of truth for the backend base URL |
| `src/lib/consumerBootstrap.test.tsx` | Tests for consumer vault bootstrap sequencing |
| `src/lib/consumerBootstrap.ts` | Sequences brain load then vault init before note-scoped state |
| `src/lib/consumerHealth.test.ts` | Tests for the consumer health derivation state machine |
| `src/lib/consumerHealth.ts` | Derives one product-level health state from technical probes |
| `src/lib/consumerViewState.test.tsx` | Tests for restorable consumer view persistence |
| `src/lib/consumerViewState.ts` | Persist/restore active consumer view (today/memories/graph) |
| `src/lib/diagnostic.ts` | Brain health scorecard computed from the already-loaded graph |
| `src/lib/graph.test.ts` | Aggregator importing the graph-pipeline test suites |
| `src/lib/graphExport.test.ts` | Tests for graph PNG export helpers |
| `src/lib/graphExport.ts` | Shared WebGL renderer config plus PNG export for graph views |
| `src/lib/graphFromDisk.ts` | Fallback graph builder reading vault files via Tauri when API down |
| `src/lib/graphMetrics.test.ts` | Tests for graph metrics (confidence, PageRank, Louvain) |
| `src/lib/graphMetrics.ts` | Pure graph metrics: edge confidence, PageRank, community detection |
| `src/lib/graphSnapshots.test.ts` | Tests for layout position snapshot serialization |
| `src/lib/graphSnapshots.ts` | Serialize/restore 2D and 3D layout position snapshots |
| `src/lib/inspectorCopy.ts` | Maps internal ids to plain-language Inspector strings |
| `src/lib/latestRequest.ts` | Generation gate that ignores stale async responses |
| `src/lib/mcpConfig.test.tsx` | Tests for MCP stdio config JSON generation |
| `src/lib/mcpConfig.ts` | Builds stdio MCP server JSON config snippets for agents |
| `src/lib/meetingsDropClaim.ts` | Tiny shared boolean claim for the optional meetings drop zone |
| `src/lib/navigationGuard.test.tsx` | Tests for the leave-Memories save-flush guard |
| `src/lib/navigationGuard.ts` | Gate leaving Memories view on a pending durable-save flush |
| `src/lib/noteDraftPersistence.test.tsx` | Tests for the debounced draft persistence queue |
| `src/lib/noteDraftPersistence.ts` | Debounced coalescing queue writing crash-recovery drafts to storage |
| `src/lib/noteDrafts.test.ts` | Tests for synchronous crash-recovery draft storage |
| `src/lib/noteDrafts.ts` | Synchronous crash-recovery draft storage isolated by vault id |
| `src/lib/noteDurability.test.ts` | Tests for the serial revision-aware note write queue |
| `src/lib/noteDurability.ts` | Serial, revision-aware write queue for the active note |
| `src/lib/tauri.ts` | Typed Tauri invoke wrappers plus browser-vs-webview detection |
| `src/lib/updater.ts` | GitHub-release update check and native install/relaunch |
| `src/lib/utils.ts` | Small formatting helpers (relative time, preview snippet) |
| `src/lib/wikilink.ts` | Resolve [[wikilinks]] to notes, mirroring the backend resolver |
| `src/stores/brainStore.test.tsx` | Tests for the brains Zustand store |
| `src/stores/brainStore.ts` | Zustand store for brains list and active-brain switching |
| `src/stores/consumerHealthStore.ts` | Zustand store polling probes and deriving consumer health |
| `src/stores/densityStore.ts` | Zustand store for the UI density preference |
| `src/stores/graphSettingsStore.ts` | Zustand store for persisted graph visual preferences |
| `src/stores/graphStore.ts` | Zustand store for graph data and force-simulation state |
| `src/stores/hoverPreviewStore.ts` | Singleton Zustand store for the hover preview card |
| `src/stores/noteStore.draftPersistence.test.tsx` | Tests for note store draft-persistence integration |
| `src/stores/noteStore.ts` | Zustand store for notes, editor buffer, and durable saves |
| `src/stores/settingsStore.test.tsx` | Tests for the settings/theme Zustand store |
| `src/stores/settingsStore.ts` | Zustand store for theme mode and app settings |
| `src/stores/toastStore.ts` | Zustand store for transient toast notifications |
| `src/stores/updateStore.ts` | Zustand store driving the update check/install flow |
| `src/workers/atlasLayout.worker.ts` | Web Worker running ForceAtlas2 graph layout off the main thread |

## Documentation — `docs/` + root governance

Governance/onboarding docs live at the repo root; everything else is under `docs/`. Note `docs/benchmarks/` is really an experiment/data directory, not prose.

### Guides, specs, handoffs & branding

| File | Purpose |
|------|---------|
| `docs/ambient-recall.md` | User guide for the automatic Ambient Recall context layer |
| `docs/api.md` | External HTTP API reference for self-built agents |
| `docs/branding/apple-icon-research.md` | Research on macOS Tahoe icon squircle-frame fix |
| `docs/branding/icon-source-2026-07-11.png` | Dated source PNG artwork for the app icon |
| `docs/branding/neurovault-logo.svg` | Brand logo vector artwork |
| `docs/BUILDING_SIDECAR.md` | Legacy guide to packaging the now-deprecated Python sidecar binary |
| `docs/consumer-feature-map.md` | Product/IA inventory of consumer app surfaces (audited 2026-07-15) |
| `docs/CONSUMER-ROADMAP.md` | Roadmap for the free open-source consumer desktop app |
| `docs/designs/graphify.md` | Original design spec for the shipped graphify code-graph feature |
| `docs/HANDOFF.md` | Explicitly archived 2026-07-16 session handoff; historical only ⚠ _[C]_ |
| `docs/handoffs/graph-view.md` | Handoff brief for graph snapshots and Graph Engine V2 |
| `docs/HOW-NEUROVAULT-WORKS.md` | Comprehensive engineering reference for the whole system (591 lines) |
| `docs/MACOS-RELEASE.md` | Signed/notarized macOS Developer-ID DMG release checklist |
| `docs/reference.html` | Standalone styled technical-reference web page (677 lines) |
| `docs/reference.png` | Rendered image of the technical-reference page (README asset) |
| `docs/research/programmatic-tool-calling-mcp.md` | Research on whether NeuroVault should adopt programmatic tool calling |
| `docs/ROADMAP-vs-agentmemory.md` | Benchmark-guarded plan to out-position competitor agentmemory |
| `docs/screenshots/*.png (6 files)` | Product UI screenshots used by README and docs |
| `docs/skills/name-clusters.md` | Agent skill: name unnamed Louvain graph clusters |
| `docs/specs/adaptive-memory.md` | Design spec for the Adaptive Memory build (734 lines) |
| `docs/specs/agent-coordination.md` | Spec for handoff/inbox multi-agent coordination primitives |
| `docs/specs/ai-employees.md` | Draft spec for AI-employee curator archetype on NeuroVault |
| `docs/specs/ambient-recall.md` | v1 design contract for Ambient Recall (user guide's spec) |
| `docs/specs/stage3-admission.md` | Frozen stage-3 memory-admission acceptance criteria |
| `docs/specs/window-lifecycle.md` | Plan for window minimize/close/stay-alive behavior |
| `docs/specs/window1-notes.md` | Observation-window-1 review process log (not rule changes) |
| `docs/TROUBLESHOOTING.md` | User recovery, backup, and data-location troubleshooting guide |
| `docs/UPDATER-SETUP.md` | Tauri auto-updater signing-key setup and rotation notes |

### Benchmarks (experiment data) — `docs/benchmarks/`

| File | Purpose |
|------|---------|
| `docs/benchmarks/ANALYSIS-2026-07-02-miss5-forensics.md` | Forensic writeup of LongMemEval hit@5 misses by question type. |
| `docs/benchmarks/longmemeval-*.json (5 files)` | Published merged LongMemEval scorecard result JSONs (100q/12q/470q/rerank/fusion). |
| `docs/benchmarks/merge_chunked_ab.py` | Aggregates chunked compare-ablate run log into full-470 A/B scorecard. |
| `docs/benchmarks/merge_reports.py` | Merges per-chunk nv-bench longmemeval JSON reports into one scorecard. |
| `docs/benchmarks/README.md` | Reproducible local benchmark guide: graphify speed + LongMemEval retrieval scorecards. |
| `docs/benchmarks/rerank_ab/*.log (3 files)` | Raw A/B run evidence logs; full470 log feeds merge_chunked_ab.py. |
| `docs/benchmarks/rerank_ab/*.txt (2 files)` | A/B summary table + targeted miss@5 question-id list. |
| `docs/benchmarks/rerank_ab/*medium_n*.json (3 files)` | Medium-n A/B rerank-ablation result scorecards (engine-only, fusion, matched-chunk baseline). |
| `docs/benchmarks/rerank_ab/full_ab_chunk_*.json (5 files)` | Per-chunk full-470 compare-ablate A/B result JSONs. |
| `docs/benchmarks/run_chunk.sh` | Runs next hours-sized chunk of full LongMemEval benchmark, resumable. |
| `docs/benchmarks/run_prod_loop.sh` | Drives production-config LongMemEval run to completion, chunk by chunk. |
| `docs/benchmarks/run_rerank_loop.sh` | Drives full rerank-fusion LongMemEval run to completion, chunk by chunk. |

## Sub-projects

Independent build trees with their own manifests, shipped from this repo.

### VS Code extension · npm publish · eval · e2e

| File | Purpose |
|------|---------|
| `dist-npm/.gitignore` | Ignores staged binaries, node_modules, tgz in npm scaffolding |
| `dist-npm/bin/neurovault-mcp.js` | npm bin shim launching neurovault-server --mcp-only stdio bridge |
| `dist-npm/lib/resolve.js` | Maps platform to per-platform npm subpackage with prebuilt binary |
| `dist-npm/package.json` | Root @neurovault/mcp manifest with per-platform optionalDependencies |
| `dist-npm/packages/mcp-darwin-arm64/package.json` | Per-platform stub shipping prebuilt binary for macOS arm64 |
| `dist-npm/packages/mcp-linux-x64/package.json` | Per-platform stub shipping prebuilt binary for Linux x64 glibc |
| `dist-npm/packages/mcp-win32-x64/package.json` | Per-platform stub shipping prebuilt binary for Windows x64 |
| `dist-npm/README.md` | npm package README: install @neurovault/mcp into MCP clients |
| `dist-npm/WINDOWS-TEST.md` | Runbook to verify headless MCP server on real Windows x64 |
| `e2e/consumer-smoke.spec.ts` | Playwright smoke test: consumer shell boots, navigates, a11y-clean |
| `eval/baselines/2026-04-23-tier1-baseline.json` | Saved 20-case retrieval-eval baseline snapshot for diffing |
| `eval/baselines/2026-04-23-tier1-real.json` | Saved retrieval-eval snapshot run against a real vault |
| `eval/README.md` | Docs for the retrieval eval harness and its metrics |
| `eval/run_eval.py` | Python retrieval-eval harness: hit@k, MRR, latency vs :8765 |
| `eval/testset.jsonl` | 30 curated recall queries with expected title matches |
| `vscode-extension/.gitignore` | Ignores build outputs, node_modules, copied ui/server-bin, vsix |
| `vscode-extension/.vscodeignore` | Excludes source and config from the packaged .vsix bundle |
| `vscode-extension/esbuild.js` | esbuild config bundling extension.ts to out/extension.js |
| `vscode-extension/media/activity-icon.svg` | Monochrome 24px activity-bar icon using currentColor tint |
| `vscode-extension/media/icon.png` | 1024px extension/marketplace icon (brand mark) |
| `vscode-extension/package-lock.json` | npm lockfile for the VS Code extension devDependencies |
| `vscode-extension/package.json` | VS Code extension manifest: commands, views, config, scripts |
| `vscode-extension/README.md` | Marketplace README for the NeuroVault VS Code extension |
| `vscode-extension/scripts/package-assets.mjs` | Pre-package: copy React build + host sidecar into extension |
| `vscode-extension/src/extension.ts` | Extension entry: spawns sidecar, hosts webview UI, sidebar panel |
| `vscode-extension/tsconfig.json` | TypeScript config for the VS Code extension source |

## Config, CI & repo root

Continuous integration, build/release automation, brand source assets, the archived Python prototype, and root-level config + governance files.

### CI, scripts, brand assets, archived `server/`, root files

| File | Purpose |
|------|---------|
| `.editorconfig` | Editor consistency: charset, LF, indent rules per filetype |
| `.git-blame-ignore-revs` | Excludes mechanical reformat commits from git blame |
| `.github/dependabot.yml` | Dependabot config: weekly grouped npm + cargo update PRs |
| `.github/ISSUE_TEMPLATE/bug_report.yml` | GitHub bug-report issue form (structured fields, bug label) |
| `.github/ISSUE_TEMPLATE/config.yml` | Issue-template chooser config; routes questions to Discussions |
| `.github/ISSUE_TEMPLATE/feature_request.yml` | GitHub feature-request issue form (enhancement label) |
| `.github/PULL_REQUEST_TEMPLATE.md` | PR description template prompting changelog/test bookkeeping |
| `.github/workflows/ci.yml` | CI: typecheck, vitest a11y, hardening, browser smoke, Rust fmt/clippy/test |
| `.github/workflows/npm-release.yml` | Build + publish headless @neurovault/mcp npm package per-platform on npm-v* tag |
| `.github/workflows/release-vscode.yml` | Build cross-platform VS Code extension .vsix on vscode-v* tag |
| `.github/workflows/release.yml` | Cross-platform app installers to a draft GitHub Release on v* tag |
| `.github/workflows/security.yml` | Weekly scheduled npm audit / dependency security scan |
| `.gitignore` | Ignore node_modules, build output, sidecar binaries, generated schemas |
| `assets/brand/neurovault-icon-master.png` | 1024 opaque square app-icon master, generated by make-app-icon.py |
| `assets/brand/neurovault-logo-dark.png` | README dark-mode logo; byte-identical to src/assets/vault-logo.png ⚠ _[C]_ |
| `assets/brand/neurovault-logo.png` | README light-mode wordmark logo |
| `assets/brand/neurovault-mark-1024.png` | Source brain+vault mark; input to icon and DMG scripts |
| `CHANGELOG.md` | Keep-a-Changelog release history (SemVer) |
| `CLAUDE.md` | Project build spec / source-of-truth instructions for Claude |
| `CODE_OF_CONDUCT.md` | Contributor Covenant code of conduct |
| `CONTRIBUTING.md` | Contributor guide: layout, dev loop, PR expectations |
| `CORE-COVENANT.md` | Public-core commitments: local-first, files-yours, open-source promises |
| `FILE-INDEX.md` | This file — every tracked file with a one-line purpose |
| `LICENSE` | MIT License |
| `llms.txt` | LLM-oriented project summary + doc links (llms.txt convention) |
| `Makefile` | Dev convenience targets: dev/build/install/typecheck/test/clean |
| `package-lock.json` | npm dependency lockfile |
| `package.json` | npm manifest: scripts, deps, dev tooling for the React/Tauri app |
| `playwright.config.ts` | Playwright e2e config (testDir e2e, port 1420) |
| `PRIVACY.md` | Privacy policy: what stays local vs leaves the machine |
| `README.md` | Project README: pitch, architecture, install, usage |
| `scripts/build-headless.mjs` | Build headless neurovault-server per triple, stage into dist-npm subpackage |
| `scripts/gates.sh` | Full verification gate; treats empty diagnostic output as failure |
| `scripts/make-app-icon.py` | Generate inverted split-colour opaque-square app icon (Tahoe-safe) |
| `scripts/make-dmg-background.py` | Render macOS .dmg installer background (neural graph, drag-to-install) |
| `scripts/release-hardening.test.mjs` | node:test asserting CSP/updater/release security invariants in tauri.conf |
| `scripts/stage-sidecar.mjs` | Build + stage neurovault-server as Tauri externalBin sidecar (breaks build.rs circularity) |
| `scripts/verify-macos-release.sh` | Verify macOS app codesign/notarization of built .app and .dmg |
| `SECURITY.md` | Security policy, threat model, vulnerability reporting |
| `THIRD-PARTY-NOTICES.md` | Inventory of third-party components and their licenses |
| `tsconfig.json` | TypeScript strict config for the frontend (noEmit, bundler resolution) |
| `vite.config.ts` | Vite config: React + Tailwind plugins, port 1420 |
| `vitest.config.ts` | Vitest config: jsdom, src/**/*.test.tsx, setup file |

## Cleanup candidates

Proposals only — **nothing here is executed without your explicit per-item yes.** Grouped by risk; each row is an independent approve/skip. The ⚠ badges in the index above cross-reference these tiers.

### Tier A · clutter — RESOLVED 2026-07-16

Each item below was individually verified against the repo before action; three
claims from the original broad scan (a committed `docs/.DS_Store`, a committed
`docs/benchmarks/.fastembed_cache/` model-blob dir, and 18 stray `*.partial.jsonl`)
turned out to be **false positives** — those paths exist on disk but were never
tracked, so there was nothing to clean.

| File | Verified finding | Outcome |
|------|------------------|---------|
| `docs/benchmarks/chunks/chunk_*.json (6 files)` | Regenerable resumability checkpoints written by `run_chunk.sh`, merged into the tracked `longmemeval-*.json` scorecards by `merge_reports.py`; matched `.gitignore:87` (`docs/benchmarks/chunks*/`) but were tracked, making the rule a silent no-op. Nothing depended on the committed copies; 7 newer siblings were already untracked. | **Untracked** (`3c6c4b7`), kept on disk. Ignored-but-tracked count is now 0. |
| `scripts/preview-shoot.mjs` | Tracked but unreferenced (absent from `package.json`, `Makefile`, CI, docs) and non-functional: line 2 pinned an ephemeral Claude-session scratchpad path, so it could not run for anyone. Swept in accidentally by `df0b364`. | **Deleted** (`d55cf19`). Recover via `git show df0b364:scripts/preview-shoot.mjs`. |
| `capture.js` | Untracked portfolio-screenshot script writing into the `dath-portfolio` repo. Verified **active** (modified 2026-07-16) and functional — it needs this repo's `puppeteer-core` dep and dev server, so it legitimately lives here. Not dead. | **Intentionally kept** as-is. |

### Tier B · dead code — RESOLVED 2026-07-16

Every file was proven unreferenced before removal: no static, dynamic, or `lazy()`
import; no barrel re-export; no test file; no config/CI reference. The full gate
(`scripts/gates.sh`) was green after each removal.

| Removed | Verified finding | Commit |
|---------|------------------|--------|
| `src/components/ActivityBar.tsx` (98) | Zero importers. Its live sibling `ActivityPanel` stays (used by `TrustCenter`). `release-hardening.test.mjs:123` asserts ActivityBar's *absence* from `App.tsx`, so removal keeps that test green. | `8974b73` |
| `src/components/HireMenu.tsx` (150) | Zero references anywhere — even the dormant `EmployeeManager` never imported it. | `8974b73` |
| `src/components/MarkdownPreview.tsx` (190) + `src/components/WikiLink.tsx` (34) | Dead **as a pair** — WikiLink's only importer was MarkdownPreview. Superseded by the CodeMirror `editor/livePreview.ts` path. Also orphaned `react-markdown` + `remark-gfm`, both dropped from `package.json`. | `8974b73` |
| `src/hooks/useKeyboard.ts` (41) | Zero references; superseded by `CommandPalette` + inline handlers. `src/hooks/` now holds only the live `useHoverPreview`. | `8974b73` |
| `server/` (9 files) | The pre-Rust Python prototype. Its own README declared it archived while describing `mcp_proxy.py`/`.venv` that no longer exist; no code, CI job, or npm script spawned it; and the live Claude Code hooks invoke the native `neurovault-hook` binary, **not** `server/scripts/neurovault_hook.py`. | `9c04a42` |

**513 lines of dead UI code + the whole Python prototype removed.** Two false claims
it left behind were corrected in the same commits: `HOW-NEUROVAULT-WORKS.md` had
documented the dead ActivityBar as a live feature, and `CLAUDE.md` advertised
"PDF / Zotero ingest" helpers in `server/` that never existed.

### Tier C · duplicate / overlap — RESOLVED 2026-07-16

| File | Verified finding | Outcome |
|------|------------------|---------|
| `src/assets/vault-logo.png` (704K) | md5 `807e5492…` — **byte-identical** to `assets/brand/neurovault-logo-dark.png`, and zero references by exact path. The README uses the brand copy. | **Deleted** (`5344f9b`) |
| `src/assets/vault-mark.png` (32K) | Zero references; superseded by `vault-mark-transparent.png`, which is live in four components and asserted by the hardening test. | **Deleted** (`5344f9b`) |
| `assets/brand/*` (4 files) | All live: the README's light/dark logos, plus the mark that `make-app-icon.py` and `make-dmg-background.py` read. | **Kept** |
| `docs/HANDOFF.md` | Historical 2026-07-16 session context contains completed branch and benchmark work. | **Kept as an explicitly archived design snapshot**; current contributors are routed to distribution and contributor docs |
| `src-tauri/src/bin/neurovault-api.rs` | Genuinely overlaps `neurovault-server`'s gateway startup — but consolidating two binaries is a **refactor, not cleanup**. Left for a deliberate change. | **Deferred** → see Tier D |

### Tier D · structural / oversized (flag only)

| File | Note |
|------|------|
| `src-tauri/src/app.rs` | Tauri desktop shell: IPC commands, windows, sidecar spawn; oversized, carries legacy .engram/Python-sidecar plumbing. |
| `src-tauri/src/memory/ambient.rs` | Ambient-recall engine behind POST /api/ambient_recall for coding agents. |
| `src-tauri/src/memory/employee.rs` | AI-employee fleet engine: roster, per-employee loops, guardrails. |
| `src-tauri/src/memory/handlers/mod.rs` | HTTP handler functions and request/response types (god-module). |
| `src-tauri/src/memory/retriever.rs` | Hybrid retrieval: sqlite-vec + BM25 + graph + RRF + rerank. |
| `src/components/AtlasGraph.tsx` | Sigma.js graph-engine renderer for large atlas snapshots |
| `src/components/CuratorOrb.tsx` | Animated Curator AI-employee orb SVG |
| `src/components/EmployeeCharacter.tsx` | Geometric SVG face for AI employees; dormant cluster |
| `src/components/EmployeeManager.tsx` | AI-Employees fleet tab (separate window); EMPLOYEES_ENABLED=false |
| `src/components/EmployeePanel.tsx` | Curator mission-control panel; dormant, EMPLOYEES_ENABLED=false |
| `src/components/NeuralGraph.tsx` | Force-directed neural knowledge-graph canvas; main graph view |

### Tier J · needs a call from you

| File | Note |
|------|------|
| `src-tauri/capabilities/employee-manager.json` | Capability for feature-flagged-off employee-manager window; inert, not declared in tauri.conf.json. |
| `src-tauri/icons/android/mipmap-*/*.png (15 files)` | Android launcher icons (base/foreground/round) across 5 densities |
| `src-tauri/icons/android/mipmap-anydpi-v26/ic_launcher.xml` | Android adaptive-icon def: foreground drawable + background color |
| `src-tauri/icons/android/values/ic_launcher_background.xml` | Defines ic_launcher_background color (#fff) for adaptive icon |
| `src-tauri/icons/ios/AppIcon-*.png (18 files)` | iOS AppIcon set at all required sizes and @1x/2x/3x scales |
| `src/components/MemoryInspector.tsx` | Context Trace inspector UI; mounted only by preview harness |
