# Changelog

All notable changes to NeuroVault are documented in this file.

The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

Categories used: **Added**, **Changed**, **Fixed**, **Performance**, **Security**,
**Deprecated**, **Removed**.

---

## [0.5.0] — 2026-06-05

The open-sourcing release: the agent sets itself up, memory follows the
folder you're working in, and a tiny floating widget keeps the backend a
click away without the full window.

### Added
- **Agent auto-start.** The native MCP server (`neurovault-server
  --mcp-only`) now health-checks `127.0.0.1:8765` on launch and, if the
  backend isn't up, starts it detached — so a connected agent gets a live
  memory backend without the user opening the app first. Opt out with
  `NEUROVAULT_AUTOSTART=0`.
- **Opt-in per-folder brains.** Point a working directory at its own brain
  via a `.neurovault` file (or `NEUROVAULT_BRAIN`); the MCP forwarder
  injects that brain into each call, so a project's memory stays scoped to
  the project. Off unless you opt in.
- **The minitab.** A small, frameless, always-on-top widget showing backend
  status with Start/Pause and "Open app". It can **shrink to just the
  logo** (a puck that resizes the OS window so it never eats clicks) or
  **hide** entirely — the global `Ctrl/Cmd+Shift+Space` shortcut re-summons
  it.
- **Window-mode control.** A top-bar menu (and matching command-palette
  entries) to **Minimize**, **Hide in background**, or **Shrink to widget**.
  Every mode keeps a recovery path (Dock reopen on macOS, the global
  shortcut, or the minitab's Open app button).
- **One-click Claude Code MCP setup.** Settings → Connect Claude Code now
  has a **Register automatically** button that merges `neurovault` into
  `~/.claude.json` for you (CLI + JSON snippets remain as fallbacks).

### Fixed
- **Claude Code MCP registration targets the right file.** Registration now
  writes user-scope `~/.claude.json` (`mcpServers.neurovault`) — not
  `~/.claude/.mcp.json`, which Claude Code only reads for project-level
  approval and never spawns servers from. The write **merges** into the
  existing file (atomic temp-file + rename) and **refuses to overwrite a
  malformed file**, so it can never wipe an existing Claude Code login.

### Security
- **CORS is now scoped to NeuroVault's own surfaces.** The loopback HTTP
  server (`127.0.0.1:8765`) previously sent `Access-Control-Allow-Origin: *`,
  so a malicious page in the user's browser could read a brain's contents via
  `fetch()`. It now only allows the app's own origins — the Tauri webview
  (`tauri://localhost`, `https://tauri.localhost`, `http://tauri.localhost`),
  the Vite dev server, and the VS Code extension webview
  (`vscode-webview://…`). Non-browser clients (the MCP forwarder, your own
  agents) send no `Origin` and are unaffected.

### Removed
- **Leaner public repo.** Dropped ~70 files that never affected the build or
  runtime: the unused iOS/Android/Windows-Store icon sets, Tauri's
  build-generated `gen/` schemas (now git-ignored, regenerated locally),
  two orphan brand images, internal design docs, and one-off dev scripts.
  Roughly 2.1 MB lighter on a fresh clone.

---

## [0.4.3] — 2026-06-03

### Fixed
- **The MCP server binary now actually ships in the installer on every
  platform.** The v0.4.2 approach (bundling `neurovault-server` as a Tauri
  `externalBin` sidecar) never built in CI: `externalBin` is validated at
  compile time by `build.rs`, but the staging ran at bundle time — and since
  the sidecar is a binary in the same crate, the check is circular. It's now
  staged in `beforeBuildCommand` (before compile) and built with the
  `externalBin` check disabled (via `TAURI_CONFIG`) to break the cycle. So
  Windows/Linux MCP — which silently never worked — now does.
- **macOS: minimising the window trapped the app.** Clicking the Dock icon to
  bring a minimised (or hidden) window back fires a `Reopen` event that the
  run-loop ignored, so there was no way to restore the window. Now handled —
  Dock-click unminimises + shows + focuses the main window. (Windows restores
  from the taskbar natively, so this only affected macOS.)
- **MCP: intermittent multi-second stall on multi-query recall.** The forwarder
  reused a pooled keep-alive connection the loopback server had since closed,
  hanging the next request until the timeout. Disabled idle-connection pooling
  in the forwarder — a fresh connection per call is free on loopback.

### Changed
- **App icon** redrawn as a fully opaque square so macOS 26 (Tahoe) masks it
  into a clean squircle without a light "frame" around the edge.

---

## [0.4.2] — 2026-06-03

### Fixed
- **Windows/Linux: the MCP server binary wasn't bundled** — `neurovault-server`
  is only present in the macOS app today, so `--mcp-only` (and therefore the
  whole MCP integration) silently didn't work on Windows or Linux: the
  installer shipped `neurovault.exe` but no `neurovault-server.exe`, so the
  Settings dialog reported "sidecar binary not found." It was never wired as a
  Tauri sidecar — macOS just happened to pick it up. Declared
  `neurovault-server` as a proper `externalBin` (staged per-target by
  `scripts/stage-sidecar.mjs` at bundle time), so it now ships next to the app
  binary on **every** platform — exactly where `mcp_sidecar_path()` looks.

---

## [0.4.1] — 2026-06-02

### Fixed
- **macOS: embedding model failed to load when the app was launched
  normally** (`fastembed init failed: Failed to retrieve onnx/model.onnx`),
  which broke `remember` / `recall`. fastembed defaults to a
  *working-directory-relative* `.fastembed_cache`; an app launched from
  Finder has working directory `/`, where it can't create the cache, so
  the model download failed. The embedder now pins an absolute, app-owned
  cache dir (`<data-root>/.fastembed_cache`, e.g.
  `~/.neurovault/.fastembed_cache`) regardless of launch directory; an
  explicit `FASTEMBED_CACHE_DIR` still takes precedence.

---

## [0.4.0] — 2026-06-02

### Added
- **Native Rust MCP server** — `neurovault-server --mcp-only` is now a
  first-class stdio MCP server (built on the official `rmcp` SDK), so
  Claude Desktop / Claude Code connect with no Python dependency. It is a
  thin shim: it loads no model and opens no database, forwarding every
  tool call over HTTP to the running app on `127.0.0.1:8765`, so the
  handshake is instant and it never competes with the app for the port or
  the brain.db lock. All 45 tools are ported 1:1 from the previous Python
  proxy (data-driven registry), including the tier system (minimal / lite
  / standard / full; default **lite**) and the server instructions block.

### Changed
- The MCP setup snippets in Settings now pass `--mcp-only`, matching the
  native server (Claude Desktop config gains the `args` field).

### Fixed
- **macOS build** now launches and works:
  - Resolved a startup crash (`SIGABRT`) — the updater plugin requires a
    `plugins.updater` config block at startup; added an inert one so the
    app stays dormant-until-signed instead of aborting.
  - Resolved "sqlite-vec extension not found" on macOS — the loader now
    also looks in the `.app`'s `Contents/Resources/resources/` location,
    not just next to the executable (the Windows layout).
- Top-bar server indicator no longer shows "offline" on a fresh install —
  it now polls the brain-independent `/api/health` for liveness instead of
  `/api/status` (which requires an active brain).
- `retrieval_integration` test resolves the platform-correct sqlite-vec
  filename (`.dylib`/`.so`/`.dll`) instead of hardcoding `vec0.dll`.

### Deprecated
- `server/mcp_proxy.py` (the Python MCP proxy) is superseded by the native
  Rust server and will be removed in a future release.

---

## [0.3.1] — 2026-05-27

### Added
- **Contradiction resolution** — new information can now beat stale
  information, agent-driven and reversible:
  - `remember` flags `potential_conflicts` when a new note sits in the
    mid-similarity band (~0.82–0.92) of an existing one, and accepts
    `supersedes: [ids]` to retire the old note in the same call.
  - `supersede_note(old, new)` MCP tool + `POST /api/notes/supersede`
    mark a note superseded; recall hides it but it stays on disk
    (reversible). Nothing is auto-superseded on similarity alone.
  - `find_conflicts` MCP tool + `GET /api/conflicts` sweep the brain for
    likely contradictions; the Brain Diagnostic gains a "potential
    contradictions" line.
- **`raw/` drop-folder** — the per-brain drop-folder is now a visible
  `raw/` folder (was `_inbox/`) seeded with a `README.md` guide, created
  on brain activation. Paste documents in; the agent turns them into
  notes; originals are kept in `raw/_done/`.

### Changed
- Recall now hides superseded notes across every candidate path.

### Fixed
- Release workflow: retry the sqlite-vec download (transient mac-runner
  failures) and add a per-job timeout so a stuck runner can't hang the
  build.

---

## [0.3.0] — 2026-05-27

### Added
- **Brain Diagnostic** — a one-click health scorecard for a vault
  (graph toolbar → "Diagnostic"): five graded categories (connectivity,
  interlinking, cohesion, freshness, organization) + an A–F grade and a
  worst-first list of fixes. DB-backed scorer shared by the panel,
  `GET /api/diagnostic`, the `nv_diagnose` command, and a read-only
  **`diagnose_brain`** MCP tool, so a connected agent can run it and act
  on the fixes. "Copy report" emits a plain-text scorecard to paste.
- **Drop-folder ingest** — a per-brain `_inbox/`; drag files onto the
  window and they're copied there for the connected agent to convert into
  clean notes via the `list_inbox` / `read_inbox_file` / `mark_inbox_done`
  MCP tools. No bundled converters — the agent is the converter.
- **In-app updater** — checks for a newer release on launch and surfaces
  an **Update** button in the top bar + Settings → Updates. Ships the
  `tauri-plugin-updater` scaffolding (inert until release signing lands;
  falls back to opening the release page). See `docs/UPDATER-SETUP.md`.
- **Graph analytics legend** — a visual key (size = importance, ring =
  health, fill/tint = category) plus a clickable cluster list that flies
  the camera to a community.
- **Graph controls** — Spread slider, Animations toggle (skips the 3D
  bloom + particle flow to save GPU), Venn/hull category grouping, and a
  Refresh button.
- **Notes-tree coloring** — folder + note rows tinted with the same
  category colour the graph uses.

### Changed
- **Graph node encoding reworked**: fill now encodes **category**
  (folder), a **ring** encodes **health** (state + strength), and size
  encodes importance. Fixes the long-standing "color filter doesn't do
  anything" confusion.
- Node labels sit on a measured background pill so long titles no longer
  bleed into neighbouring nodes.
- README modernized; documentation site moved to its own repo and is
  served at **neurovault.dathproject.com**.

### Fixed
- **Time-lapse** now orders nodes by `created_at` (carried on the graph
  payload), so a batch import whose notes share an `updated_at` animates
  progressively instead of appearing all at once.
- **Linux build / CI**: `netstat2` (which fails to compile on Linux) is
  now a non-Linux-only dependency; `port_recovery` degrades to a no-op on
  Linux. Windows + macOS keep port auto-recovery.

### Removed
- **Compilations tab** and its nav/command/shortcut entries (the backend
  table is left dormant).
- Dead Python server package (`server/neurovault_server/`), its tests,
  and the benchmark harness — the `run_python_job` path was removed in
  0.2. The MCP bridge (`server/mcp_proxy.py`) and the Claude Code hook
  remain.

---

## [0.1.8] — 2026-05-01

### Added
- **GraphFilterPanel** — Obsidian-style slide-out panel in the graph
  view (top-right toolbar → "Filters" pill). Sections:
  - **Filters**: search nodes, show orphans, show semantic edges,
    manual links only, show arrows.
  - **Display**: node-size slider, link-thickness slider, label-zoom
    threshold slider, show all folder labels.
  - **Appearance**: palette picker, node-shape picker, per-folder
    + per-cluster colour-override editors.
  - **Layout**: organic / circle layout shape, centering pull,
    charge strength, link distance — all live sliders.
  - **Time-lapse**: replays the brain's creation order. Nodes
    appear chronologically, edges fade in once both endpoints are
    visible. Adjustable duration (3-60 s).
- **Graph screenshot** button next to the Filters pill — exports the
  current canvas as a transparent PNG named
  `neurovault-graph-<timestamp>.png` (Obsidian-style).
- **Sidebar collapse**. New toggle at the leftmost edge of the top
  app bar hides the entire left sidebar; bound globally to **Ctrl+B**
  (Cmd+B on macOS). Persists to localStorage.
- **Tab right-click menu** in the Notes view: Close / Close others /
  Close all. Middle-click and the existing × button still work.
- **Tab strip always visible** when at least one note is open
  (previously hidden when only one tab was open, leaving no way to
  close it).
- **Tab icons** on Notes / Graph / Compile.
- **Compile review queue endpoints** that the CompilationReview UI
  has been calling since v0.1.0 but were never ported from Python:
  `GET /api/compilations`, `/pending`, `/:id`,
  `POST /:id/approve`, `/:id/reject`. The Compile tab loads cleanly
  again instead of 404'ing on open.
- **Auto-approve on submit** toggle in the agent compile panel.
  Persists to localStorage. When on, the new wiki goes straight to
  `status='approved'` instead of `'pending'`. Same flag exposed to
  MCP via `compile_submit(auto_approve=true)`.

### Changed
- **Graph appearance settings moved** from the global Settings panel
  into the in-graph Filters panel. Removes a confusing duplication
  where palette, node shape, cluster labels, and analytics-layer
  toggles existed in both places.
- **Close all + closing the last tab** now actually empties the
  editor body (clears the active filename), so the
  "Select a note to start reading" placeholder appears as expected
  instead of leaving the previously-active note rendered.

## [0.1.7] — 2026-04-30

### Added
- **MCP `/update` tool + `POST /api/update`.** Re-scans the brain's
  vault, re-ingests files whose `content_hash` has changed, and
  soft-deletes engrams whose markdown file disappeared from disk.
  Idempotent (re-running on a clean vault is a no-op). Useful after
  out-of-band edits (Obsidian, vim, Drive sync).
- **MCP `/status` tool + extended `/api/status`.** One-call brain
  health snapshot: memories / chunks / entities / connections totals,
  freshness breakdown (`fresh` / `active` / `dormant`), link
  breakdown (`manual` / `entity` / `semantic` / `other`).
- **MCP `compile_prepare` + `compile_submit` + matching HTTP
  endpoints.** Agent-driven wiki compile flow: `prepare` returns a
  source pack for a topic, `submit` writes the agent-authored markdown
  to `vault/wiki/<slug>.md` and queues a `pending` compilation row
  for human review. Replaces the dead Python-only endpoints the
  CompilationReview UI was calling since v0.1.0.
- **Semantic-edges toggle in the graph view.** New "Semantic <count>"
  pill in the top-right toolbar. Default off — auto-computed cosine
  similarity edges are hidden so the graph reflects authored +
  grounded structure first. Click to bring them back.
- **Orphan ring layout.** Nodes with no rendered edges are pinned
  onto concentric rings around the connected brain, with smaller
  radius (× 0.55) and dimmer alpha (× 0.65) so they read as a halo
  rather than equal-weight peers. Ring radius scales with
  `sqrt(connectedCount) * 22 + 80`, so it adapts as the brain grows.

### Changed
- **Default `min_similarity` raised from 0.75 to 0.85.** At 0.75 the
  meta-brain rendered with 11k+ semantic edges (~83 / node, hairball);
  0.85 drops to ~2k (~15 / node, readable). The Semantic toggle
  hides them entirely by default regardless.
- **Centering forces added to the graph simulation.** `forceX(0)` +
  `forceY(0)` at strength 0.04 keep multi-component layouts from
  sprawling indefinitely. Pinned orphan ring nodes ignore the force
  and stay where the layout puts them.
- **Server-status indicators no longer flicker.** Both the top status
  dot (App.tsx) and the Settings server panel (SettingsView.tsx) now
  require multiple consecutive failures before flipping to "offline";
  background polls run silently instead of flashing "Checking…" every
  3 seconds.
- **Node label-render threshold raised** from `globalScale ≥ 1.4` to
  `≥ 3.2`. Default zoom reads as a clean shape; titles only appear
  when you zoom in. Hover / focus still surface the label early.

### Fixed
- **`update-logo.py` autocrop bug** that pulled icon bounds out to the
  full canvas (raw alpha treated near-white texture as opaque). Now
  thresholds at alpha ≥ 64 so only meaningfully-visible pixels
  participate in the bbox.
- **`cargo run` ambiguity** between the `neurovault` and
  `neurovault-server` binary targets — added `default-run` to
  Cargo.toml so `tauri dev` picks the desktop app.

## [0.1.6] — 2026-04-30

### Changed
- **Brand mark redrawn and fully re-rendered.** The new mark (heavier
  blue strokes, properly centered) replaces the previous version
  across every surface: Tauri installer + window + taskbar icons,
  VS Code extension Marketplace icon, website nav / hero / favicon,
  in-app sidebar / Settings → About / Onboarding. The icons now fill
  the entire canvas (the outer ring touches the edges), about three
  times bigger than the v0.1.5 attempt.

### Fixed
- **Server-status indicator flicker.** Two pollers in App.tsx (top
  status dot) and SettingsView.tsx (Settings → Server) were flipping
  their "online" flags to false on a single transient HTTP failure,
  then back to true on the next successful poll. Both now require
  multiple consecutive failures before declaring offline, and the
  Settings poller runs silently in the background without flashing
  "Checking..." every 3 seconds.
- **`update-logo.py` autocrop.** The bbox detection used the raw
  alpha channel, which counted near-white background texture (alpha
  values like 10-15) as opaque content and pulled the crop bounds
  out to the full canvas. Now thresholds at alpha ≥ 64 so only
  meaningfully-visible pixels participate in the bbox.

## [0.1.5] — 2026-04-29

### Added
- **New brand mark.** Outer ring + three connected nodes + key hub.
  Rolled out across the desktop app icons (Windows installer, macOS
  .icns, Microsoft-Store style tiles), the VS Code extension
  Marketplace icon and activity-bar SVG, and the website nav, hero
  image, and favicon. Visible inside the running app in three places:
  sidebar bottom bar, Settings → About, and the first-launch
  Onboarding welcome slide.
- **VS Code extension.** New `vscode-extension/` folder ships a
  Marketplace-ready extension that hosts the existing React UI in a
  webview tab and spawns the standalone server binary as a sidecar.
  First milestone: read + write parity with the desktop app via HTTP.
  Sidesteps macOS code-signing entirely because Microsoft signs every
  Marketplace install. See `vscode-extension/README.md`.
- **Standalone `neurovault-server` binary.** Cargo bin target inside
  the existing crate (`src-tauri/src/bin/neurovault-server.rs`).
  Same axum HTTP server the desktop app embeds, but launchable as
  its own process. Used by the VS Code extension; also handy for
  headless / server deployments.
- **HTTP write endpoints.** `PUT /api/notes` and `DELETE /api/notes`
  expose `write_ops::save_note` / `write_ops::delete_note` over HTTP
  so non-Tauri clients (the VS Code extension webview, agents over
  MCP, future browser PWAs) can drive the full write path. Existing
  `POST /api/notes` (the `remember` endpoint) is untouched.
- **Runtime API_HOST detection.** `src/lib/config.ts` now reads
  `window.__NEUROVAULT_CONFIG__.serverUrl` first when present, falling
  through to the Vite env var and the conventional `127.0.0.1:8765`.
  Unblocks the VS Code extension where the sidecar may bind to a
  non-default port if the desktop app is already running.

### Fixed
- **Windows release CI.** The Windows job was failing at the
  sqlite-vec download step with curl exit 22 because upstream only
  ships Windows builds as `.tar.gz`, not `.zip`. Workflow now asks
  for `tar.gz` and lets the existing extract step handle it. Future
  tag pushes will produce a Windows installer automatically; manual
  uploads no longer needed.

### Changed
- **Body type bumped for readability.** The website now renders body
  copy at 17px / 1.6 (was 16px / 1.55), hero and pitch at 18px / 1.65,
  and feature card paragraphs at 15px / 1.6 (were 13.5px / 1.5).
  `--text-muted` and `--text-dim` lifted a few stops on both peach
  and blue themes so secondary copy stops fading.
- **Mac download UX.** The website's primary download button now
  spells out the chips covered ("Apple Silicon (M1 / M2 / M3 / M4)"),
  and Mac visitors see an "On an Intel Mac? Build from source" hint
  in the Other platforms row so they self-select correctly.
- **Glassmorphism Mac button + animated peach Windows button.** The
  hero CTAs now have distinct treatments so they read as siblings
  rather than twins.

## [0.1.4] — 2026-04-27

### Fixed
- **Server-status indicator was always offline.** The Tauri webview's
  plain `fetch()` calls to the in-process Rust backend at
  `http://127.0.0.1:8765` were silently failing the CORS preflight —
  the webview origin (`tauri://localhost` in production,
  `http://localhost:1420` in dev) is cross-origin to the backend, and
  the axum router wasn't sending CORS headers. Most of the app worked
  because graph + notes traffic goes through Tauri *invoke* (no CORS),
  but the Settings → Server panel and the top "Server offline" banner
  both used direct `fetch()` and were stuck showing offline forever.
  Added a permissive `tower-http::cors::CorsLayer` (any origin /
  methods / headers). Safe because the listener still binds to
  127.0.0.1 only — no LAN exposure, so the only origins that can ever
  reach this port are running on the same machine.

## [0.1.3] — 2026-04-27

### Fixed
- **Start Server button** — the Settings panel's status check ran once
  at mount, so on a fresh launch (where the Rust backend takes a few
  seconds to load ONNX + scan the vault) it could land on "Server
  offline". Clicking *Start Server* then returned "already running"
  because the backend had finished booting in the meantime. The panel
  now polls `/api/brains/active` every 3 s and "already running" is
  treated as success (silently re-checks instead of alerting).

## [0.1.2] — 2026-04-27

### Added — graph polish
- **Glass-orb shading**: every node now reads as a small marble — 3-stop
  radial gradient (lighter top-left → base → slightly darker bottom-right)
  plus a soft white specular highlight on circles + hexes ≥ 3 px.
- **State-driven finish**: dormant notes desaturate (true grey-shift, not
  just alpha); fresh notes get a subtle amber halo using the brand
  status colour.
- **Per-folder colour overrides** — native colour picker per folder in
  Settings → Graph; folder list auto-derived from the active brain;
  hex-validated and persisted.
- **Per-cluster colour overrides** — only for clusters the user has
  named (via `/name-clusters` or by hand). Unnamed clusters fall back
  to the dominant-folder tint because Louvain ids aren't stable.

### Fixed
- **Big-node overlap**: `forceCollide.radius()` and link distance now
  follow the same `effectiveNodeRadius()` the painter uses, so two
  PageRank-boosted hubs no longer overlap when Analytics mode is on.
  Live ref + reheat keeps the simulation in sync without re-attaching
  forces.
- **Settings card overlap**: the Palette swatch grid was overflowing
  the right-shrunk `SettingRow`. New `SettingBlock` layout (stacked
  label/description above full-width control, explicit header margin)
  keeps wide controls inside the section card.
- **Start Server / Stop Server**: were calling the *retired* Python
  sidecar's `start_server` / `stop_server` Tauri commands. Both the
  Settings panel and the top "Server offline" banner now control the
  in-process Rust HTTP backend via `nv_start_rust_server` /
  `nv_stop_rust_server`.

### Changed
- Stale "uv run python -m neurovault_server" hint replaced by "restart
  NeuroVault to auto-start the in-process backend".
- Repo cleanup: `Makefile` rewritten for the in-process Rust setup;
  three dead scripts removed (`scripts/launch-neurovault.bat`, `.vbs`,
  `pin-legacy-installer.ps1`); `docs/BUILDING_SIDECAR.md` carries a
  clear deprecation note now that the sidecar isn't required for
  normal use.

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

[Unreleased]: https://github.com/sirdath/NeuroVault/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sirdath/NeuroVault/releases/tag/v0.1.0
