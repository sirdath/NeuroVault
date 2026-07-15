# NeuroVault consumer feature map

Last audited: 2026-07-15

This document describes the consumer desktop app and the local/headless surfaces that support it. It is an information-architecture and product inventory, not a promise that every backend capability has a graphical control.

## Availability labels

- **Available** — reachable and usable in the consumer app today.
- **Available, secondary** — usable, but intentionally outside the primary navigation or behind an advanced control.
- **Agent-facing / headless** — implemented through MCP, HTTP, hooks, or local files; not a normal consumer screen.
- **Hidden / inactive** — code exists but the public app does not expose a working route to it.
- **Not implemented** — product idea or implied capability with no complete implementation.

## Current navigation and hierarchy

| Surface | Status | Current entry point | Purpose |
| --- | --- | --- | --- |
| Memories | **Available; default landing** | Primary rail, `Cmd+2` | Browse, organize, write, and recover Markdown memory. |
| Graph | **Available** | Primary rail, `Cmd+3` | See the active vault as efficient 2D/3D snapshots or open the visual Graph Engine. |
| Today | **Available** | Primary rail, `Cmd+1` | Compact memory pulse: activity, review count, recent work, and recent memory changes. |
| Review | **Available** | Permanent rail item, badge when proposals wait | Judge automatic memory-management proposals and build the evidence required for safe autonomy. |
| Settings | **Available** | Rail footer, `Cmd+,`, native app menu | General appearance, Sources, Connections, Vaults, and opt-in Developer controls. Opens in the same app window. |
| Search | **Available, secondary** | `Cmd+/` or command palette | Dedicated exact/semantic memory search. Not shown in the rail. |
| Privacy & Trust | **Available, secondary** | Health/status control or command palette | Service health, automatic-context control, privacy explanation, and context receipts. |
| Context history | **Available, secondary** | Privacy & Trust | Inspect when context was injected or when NeuroVault stayed quiet, then rate retrieval quality. |

The rail itself collapses from 208px to 64px and persists that preference. The active-vault selector appears at the bottom when more than one vault exists and the rail is expanded. Settings remains a single canonical footer item.

The app restores only Memories, Graph, or Today between launches. Transient screens such as Settings and Review never become the next launch's front door. A first launch, invalid saved destination, or unavailable local storage falls back to **Memories**.

Source: `src/App.tsx`, `src/components/ConsumerNavigation.tsx`, `src/lib/consumerViewState.ts`.

## Window, sidebar, and minimize behavior

### Main app

- **Available:** native resizable macOS window, currently configured at 1200×800 with an 800×600 minimum.
- **Available:** collapsing global navigation rail; state persists independently from the Memories note browser.
- **Available:** Memories note browser can be resized from 220px to 420px and hidden with `Cmd+B`; size and folder expansion persist, while collapse is session-only so every cold launch visibly opens the active vault.
- **Available:** leaving Memories passes through a durable-save barrier. A failed save keeps the note open rather than switching views or vaults.
- **Available:** switching the active vault first leaves any vault-scoped screen, activates the new vault, expands the note browser, and lands on Memories. The selector is locked during activation.
- **Available:** custom one-click Minimize, plus a chevron menu for Hide in background and Shrink to widget.
- **Available:** the native yellow minimize control and Window menu continue to work.
- **Available:** closing the main window hides NeuroVault while its local memory service continues running. Explicit Quit flushes pending work and exits.
- **Available:** Dock reopening restores, shows, and focuses the main window.

### Floating widget

- **Available, secondary:** Shrink to widget hides the main window and shows a small always-on-top service widget.
- The widget can open the app, start/stop the local service, hide itself, or collapse from roughly 248×132 to a 60×60 puck.
- The widget's **Pause** stops the memory service. This is different from Privacy & Trust's **Pause automatic context**, which disables hooks while leaving the service available.

### Overlays and native interactions

- Command palette, Quick Capture, Trash, shortcut help, onboarding, toasts, import/drop overlay, context menus, and hover preview infrastructure.
- Deep links can open a memory directly or open Graph focused on a node.
- Files dropped anywhere on the window are copied to the active vault's private Import inbox; originals are untouched.
- Settings uses the existing main webview rather than opening a duplicate tab/window.

Source: `src/App.tsx`, `src/components/Sidebar.tsx`, `src/components/Minitab.tsx`, `src/lib/navigationGuard.ts`, `src-tauri/src/app.rs`, `src-tauri/tauri.conf.json`.

## Keyboard shortcuts

| Shortcut | Action | Availability |
| --- | --- | --- |
| `Cmd+K` | Command palette | **Available** |
| `Cmd+Shift+Space` | Quick Capture, including from outside the focused window | **Available** |
| `Cmd+N` | New note and open Memories | **Available** |
| `Cmd+S` | Save current note | **Available** |
| `Cmd+B` | Show/hide Memories note browser | **Available in Memories** |
| `Cmd+P` | Toggle Memories and Graph | **Available** |
| `Cmd+1` | Today | **Available; stable mapping** |
| `Cmd+2` | Memories | **Available; stable mapping** |
| `Cmd+3` | Graph | **Available; stable mapping** |
| `Cmd+/` | Dedicated Search | **Available** |
| `/` | Editor slash-command completion | **Available in editor** |
| `[[` | Wikilink completion | **Available in editor** |
| `?` | Shortcut help when not typing | **Available** |
| `Escape` | Close the active modal/overlay or exit edit mode | **Available** |

The native global Quick Capture registration and Hide-menu restore hint use Command on macOS and Control on other platforms.

Source: `src/App.tsx`, `src/components/ShortcutHelp.tsx`, `src-tauri/src/app.rs`.

## Memories

**Status: Available**

The Memories workspace contains a note browser and a live Markdown editor.

### Browser and organization

- Exact/local title and path filtering plus semantic search.
- Folder tree with persistent expansion.
- Virtualized rows and bounded preview loading for large vaults.
- Create, rename, move, reveal in Finder, copy filename, and move to Trash.
- Drag a note into a folder to move/rename it.
- Recoverable Trash with restore and re-indexing.
- Per-vault state prevents tabs, selections, and folder expansion leaking between vaults.

### Editor

- Multiple persisted tabs, drag reorder, middle-click close, Close Others, and Close All.
- Live Markdown presentation in CodeMirror, line wrapping, slash commands, and `[[wikilink]]` completion.
- One-second autosave with explicit Retry, Save a copy, Discard, and draft-recovery paths.
- Word count, character count, and estimated reading time.
- Small, Medium, and Large font-size settings affect the live editor.

When no target exists, autocomplete truthfully offers an unresolved `Link to "name"`; note creation remains explicit.

Source: `src/components/Sidebar.tsx`, `src/components/Editor.tsx`, `src/components/TrashPanel.tsx`, `src/components/editor/completions.ts`, `src/components/editor/theme.ts`.

## Graph

**Status: Available**

### Everyday graph

- Deterministic **2D snapshot** and **3D snapshot** modes.
- Names: Off, Key, or All.
- Connections: Off, Featured, or All.
- Fit, update snapshot, diagnostics, analytics, hover details, and Open note.
- Save PNG and Copy image export the actual visual, not configuration JSON.
- Empty state can create a first note or retry loading.

### Graph Engine

- Six deterministic visual patterns: Time Rings, Constellation Islands, Neural Arbor, Connectome Halo, Memory Flow, and Knowledge Globe.
- Full, Lite, and Off performance levels.
- Search, orphan/edge/layer filters, node and connection sizing, folder colours, Warm/Cool/Mono/Vivid palettes, and time-lapse controls.
- Declarative, allowlisted custom style JSON import/export with size and count limits.
- Image export remains separate from style JSON export.

### Performance baseline

- Heavy 3D code is lazy-loaded separately.
- Everyday snapshots use stable positions and do not continuously run force physics.
- Note-driven refreshes are debounced.
- Engine layout work is cached and can run off the UI thread.
- Off unmounts the graph rather than leaving an invisible simulation consuming CPU.

Source: `src/components/NeuralGraph.tsx`, `src/components/AtlasGraph.tsx`, `src/components/GraphFilterPanel.tsx`, `src/lib/atlasPatterns.ts`.

## Review and automatic memory management

**Status: Available**

Review is the consumer surface for consolidation proposals. It is always visible in the rail; a badge counts every unreviewed proposal for the active vault, including proposals that currently collect accuracy labels without applying a write.

- Pending and History views.
- One evidence-backed card at a time; no bulk approval.
- Observation, evidence timeline, proposed field values, consequence, confidence band, and technical detail.
- Field editing before a verdict.
- Keyboard review using A, E, R, and arrow navigation.
- “Check recent activity” runs proposal-mode consolidation.
- Quality metrics, review coverage, audit samples, and false-negative reporting.

There are deliberately two kinds of decision:

1. **Accurate / Not accurate** — labels an observation. `working_state_refresh` and `room_summary_refresh` currently use this path and do not silently rewrite memory.
2. **Apply change / Reject** — reviews a safe, executable proposal. `memory_strengthened` and `supersession_suggestion` use this path.

Verdict history is immutable. Application state is tracked separately, so an application failure cannot rewrite what the user judged. These labels are the evidence used to decide whether a proposal class has earned future autonomy.

This is different from Context History's Useful / Wrong vault / Outdated feedback: Review measures memory-management quality; Context History measures retrieval/injection quality. The UI should keep explaining that distinction.

Source: `src/components/AttentionCenter.tsx`, `src/components/MemoryReview.tsx`, `src/lib/inspectorCopy.ts`.

## Today

**Status: Available; secondary to Memories**

Today is now a compact memory pulse rather than only “continue where you left off.” It shows:

- active vault and memory count;
- automatic-context activity and times NeuroVault correctly stayed quiet;
- memories surfaced and notes changed;
- pending Review count with a direct link;
- a continuation only when it is non-stale and no more than 72 hours old;
- recent memory changes;
- direct Open Memories and Explore Graph actions.

Memories remains the default landing because it is the product's core surface. Today should stay concise and observational; vault management, settings, and detailed receipts retain their canonical homes.

Source: `src/components/Home.tsx`, `src-tauri/src/memory/handlers/mod.rs`, `src/lib/consumerViewState.ts`.

## Search and capture

### Search

- **Available:** local note filter in the Memories sidebar.
- **Available:** `Cmd+K` universal palette combining commands, notes, semantic recall, and vault switching.
- **Available, secondary:** full Search screen with Everything, Notes, and Remembered filters, exact/semantic results, offline exact fallback, and keyboard navigation.

These are currently three overlapping search concepts. The target is the local Memories filter plus one clearly named universal search. Until that consolidation, top-bar search and documented shortcuts must state which surface they open.

### Capture

- **Available:** Quick Capture overlay with first-line title, `Cmd+Enter` save, Escape cancel, and character/line count. The title line is not duplicated in the saved body, and title overflow is preserved.
- **Available:** native global shortcut can invoke capture while another app is focused.
- **Available:** file drop stages copies in the private Import inbox.

Current caveat: global capture focuses the main app instead of behaving like a truly quiet floating capture.

Source: `src/components/SearchView.tsx`, `src/components/CommandPalette.tsx`, `src/components/QuickCapture.tsx`, `src/App.tsx`.

## Vaults, sources, imports, and export

### Vaults

**Status: Available**

- Quick active-vault switcher in the expanded rail when multiple vaults exist.
- Full manager in Settings → Vaults.
- Create an internally managed vault or open an existing Markdown folder as an external vault.
- Rename and describe a vault.
- Export a vault as ZIP.
- Remove an external vault from NeuroVault without deleting the source folder.
- Delete an internal vault with explicit confirmation.

The rail selector is for frequent switching; Settings → Vaults is for lifecycle management. The target is a single bottom vault chip/menu that makes this relationship explicit with **Switch vault** and **Manage vaults** actions, avoiding the appearance of duplicate settings.

### Sources

**Status: Available**

Settings → Sources is the canonical consumer entry point for knowledge ingestion:

- use a Markdown/Obsidian folder as a vault;
- mirror additional Markdown folders without changing their originals;
- enable, disable, remove, preview, and apply source-folder sync;
- treat Notion exports and transcripts as exported Markdown folders;
- index supported local code repositories into the graph for symbols, imports, definitions, and call relationships.

### Import inbox

**Status: Agent-facing after capture**

The consumer can drop files and see that they were staged, but there is no complete inbox browser, processor, or review queue in the desktop UI. MCP tools can list/read/mark inbox items. NeuroVault does not silently extract arbitrary non-Markdown files.

Source: `src/components/BrainSelector.tsx`, `src/components/BrainSourcesPanel.tsx`, `src/components/SettingsView.tsx`, `src/App.tsx`, MCP registry/tools.

## Connections and extensibility

### AI clients

**Status: Available**

Settings → Connections provides local MCP setup for:

- Claude Code — best-supported automatic context, outcome capture, and memory tools;
- Claude Desktop — memory tools;
- Cursor — memory tools;
- VS Code / Continue — memory tools;
- other stdio MCP clients and agent frameworks — portable configuration.

Configuration generation preserves unrelated MCP servers. Connection cards expose the server path/configuration and recent agent activity.

Important boundary: only Claude Code currently has NeuroVault's automatic hook-based context and outcome channel. Other MCP hosts receive tools; the host decides when to call them. “Supports MCP” must not be presented as “automatically injects context in every host.”

### Local API and MCP tiers

**Status: Available, secondary / agent-facing**

- Lite is the default MCP tier with 8 daily-use tools.
- Standard exposes 21 tools.
- Full exposes 55 tools including advanced graph, consolidation, inbox, code-indexing, bulk-maintenance, and administration surfaces.
- External HTTP access is off by default and configurable for loopback, LAN, or a specific address/port.
- API keys support read/write/admin roles, vault allowlists, one-time plaintext display, and revocation.

Source: `src/components/ConnectionsCenter.tsx`, `src/components/SettingsView.tsx`, `src-tauri/src/memory/mcp/registry.rs`, `src-tauri/src/memory/mcp/tools.json`.

## Privacy, Trust, and context history

**Status: Available, secondary**

Privacy & Trust contains:

- local service health and recheck;
- automatic-context enable/pause;
- clear “observed / stored / shared” explanations;
- links to Review History, Trash, Vaults/backups, and Connections;
- context receipts showing when memories were injected or NeuroVault stayed quiet;
- Useful, Wrong vault, and Outdated retrieval feedback.

Automatic context and service availability are separate controls. Copy should consistently say whether an action pauses hooks, stops the local server, hides the window, or quits the application.

The lower-level technical event/audit presentation exists in code but is not currently reachable through the normal embedded Trust flow; it is therefore **Hidden**, not a consumer feature.

Source: `src/components/TrustCenter.tsx`, `src/components/ActivityPanel.tsx`.

## Onboarding

**Status: Available**

- First-run overlay, reopenable from the app.
- Product promise and optional sample vault.
- Create a private local vault or open an existing Markdown folder.
- Explains the ownership/isolation boundary.
- Optional Claude Code automatic-context setup, with Enable later and Connections paths.
- “Not now” and Escape keep onboarding non-blocking.

Onboarding must describe the current product truth: declining automatic context leaves the manual memory and MCP surfaces available, but it does not currently create a special limited-state receipt on Today.

Source: `src/components/Onboarding.tsx`.

## Agent-facing, hidden, and inactive surfaces

| Capability | Status | Consumer truth |
| --- | --- | --- |
| Stdio MCP server and headless/local HTTP server | **Agent-facing / headless** | Core integration surface; not a consumer page. |
| Automatic event journal, temporal replay, outcome capture, consolidation cursor, metrics | **Agent-facing with Review UI consumer** | Mostly automatic infrastructure; proposals and metrics surface through Review. |
| Import inbox list/read/mark tools | **Agent-facing** | File drop exists in UI; inbox management does not. |
| Code graph queries such as definition/call/blast-radius tools | **Agent-facing** | Source setup/indexing is consumer-visible; detailed queries are for connected agents. |
| Compile/document synthesis workflow | **Agent-facing** | Backend tool exists; there is no desktop Compile tab. |
| Technical context event log mode | **Hidden** | Component state exists, but the normal Trust route exposes receipts instead. |
| Classic/legacy graph controls | **Hidden** | Retained in stores/components; current Graph Engine does not expose all of them. |
| Reader-style MarkdownPreview, Cmd-click wikilink navigation, hover preview | **Hidden / incomplete** | Live consumer editor is CodeMirror; do not document reader behavior as available. |
| AI Employees manager/scheduler | **Hidden / inactive** | Code remains, but `EMPLOYEES_ENABLED` is false and the public window/scheduler is not declared. |
| Legacy ActivityBar and preview-only MemoryInspector | **Hidden / unused** | Not part of the live consumer shell. |

## Not implemented

- Native live connectors for Notion, Slack, Google Drive, Zotero, email, or calendars. Exported Markdown can be used through Sources, but that is not a live SaaS integration.
- Universal no-tool context injection across every MCP host. Only Claude Code has the automatic hook path today.
- A complete consumer Import inbox with preview, processing, acceptance, and error recovery.
- Public AI Employees in the base app.
- A desktop Compile tab or automatic compiled-document approval workflow.
- Safe substantive working-state/room-summary writes that require the hardened transcript reader; their Review cards currently collect accuracy evidence only.
- A companion/pet interface; this remains a future personality idea, not current functionality.

## Simplified target information architecture

The target hierarchy is deliberately smaller than the implementation inventory.

### Primary work

1. **Memories** — default landing and canonical writing/browsing workspace.
2. **Graph** — canonical visual exploration workspace.
3. **Review** — always discoverable; badge only communicates pending work.

### Secondary

4. **Today** — compact optional memory pulse, not a replacement for Memories.
5. **Settings** — one in-app destination containing General, Sources, Connections, Privacy & Trust, Vaults, and hidden-by-default Developer controls.

### Global controls

- One universal search plus the local Memories filter.
- One bottom vault chip with Switch and Manage actions.
- One health/status control leading to Privacy & Trust.
- Conventional window controls; Hide and Widget remain advanced options.

This target preserves power without forcing users to learn the backend architecture.

## Optimization decisions

### P0 — correctness and trust

Completed in the current implementation:

- Memories is the first-launch/default destination.
- Active-vault switching drains the editor, locks during activation, opens Memories, and expands its browser.
- Cold launch resolves the active vault before loading explicitly brain-scoped paths and notes; the note browser starts expanded.
- Review is permanent and counts accuracy-only as well as executable proposals.
- The live editor obeys the font-size setting.
- Native global Quick Capture uses Command on macOS.
- Hide/restore copy uses the same platform-correct shortcut.
- Quick Capture no longer duplicates its title in the saved body.
- MCP tier copy matches Lite 8 / Standard 21 / Full 55 and Lite default.
- Unsupported Cmd-click wikilink help was removed.
- Unresolved wikilink completion no longer claims to create a note.

Still required:

- Keep installer/build/version verification separate from source completion: a repository change is not shipped until the installed app bundle is rebuilt and hash/version-checked.

### P1 — simplification and discoverability

Completed or underway:

- Today now reports useful memory activity and only shows recent, non-stale continuation.
- Sources is a first-class Settings section rather than a deeply buried icon.
- Connections explicitly distinguishes Claude Code automation from tool-only MCP hosts.
- Graph copy names the actual six patterns and image export is distinct from style export.

Next decisions:

- Consolidate standalone Search and command-palette search into one understandable universal search.
- Replace the apparent Active Vault / Vault Settings duplication with one vault chip plus a clear manager action.
- Add a consumer Import inbox or keep file drop explicitly described as staging for connected agents.
- Make Review-vs-context-feedback language consistent across Today, Review, and Trust.
- Expose the technical log intentionally or remove its dead consumer state.
- Remove or quarantine inactive preview, employee, activity-bar, and legacy graph code from the public app surface.
- Reassess the always-created widget's background health polling and the launch splash's perceived startup cost.
- Reduce duplicate minimize affordances while preserving native macOS expectations.

## Primary code index

- App shell and routing: `src/App.tsx`
- Main rail and active vault: `src/components/ConsumerNavigation.tsx`
- Memories: `src/components/Sidebar.tsx`, `src/components/Editor.tsx`, `src/components/TrashPanel.tsx`
- Graph: `src/components/NeuralGraph.tsx`, `src/components/AtlasGraph.tsx`, `src/components/GraphFilterPanel.tsx`
- Today: `src/components/Home.tsx`
- Review: `src/components/AttentionCenter.tsx`, `src/components/MemoryReview.tsx`
- Search/capture: `src/components/SearchView.tsx`, `src/components/CommandPalette.tsx`, `src/components/QuickCapture.tsx`
- Settings/sources/connections/vaults: `src/components/SettingsView.tsx`, `src/components/ConnectionsCenter.tsx`, `src/components/BrainSelector.tsx`, `src/components/BrainSourcesPanel.tsx`
- Trust/context receipts: `src/components/TrustCenter.tsx`, `src/components/ActivityPanel.tsx`
- Onboarding: `src/components/Onboarding.tsx`
- Window/widget lifecycle: `src/components/Minitab.tsx`, `src-tauri/src/app.rs`, `src-tauri/tauri.conf.json`
- MCP registry: `src-tauri/src/memory/mcp/registry.rs`, `src-tauri/src/memory/mcp/tools.json`
