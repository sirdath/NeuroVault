# Gemini browser-control prompt: NeuroVault marketing screenshots (v0.1.8)

Updated for the v0.1.8 UI (filter panel, time-lapse, tab right-click,
sidebar collapse, etc.). Save path is `D:\Ai-Brain\engram\website\assets\screenshots\`.

---

## PROMPT START

You are taking marketing screenshots of NeuroVault, a local-first AI
memory app, version 0.1.8. The app is running locally as a web view
at **http://localhost:1420**. A backend API is live at
http://127.0.0.1:8765. Both are already running.

Capture **10 hero shots** at a fixed **1440 × 900** viewport. Save
each one as PNG to `D:\Ai-Brain\engram\website\assets\screenshots\`
using the exact filename in each step. Do not invent names.

**Before you start:** open the URL, wait for the React app to
finish loading, look for the Notes / Graph / Compile tabs at the
top. Verify the bottom-right server status reads **"connected"**
(green dot). If "offline", refresh and wait 5 seconds.

### Shot 1 — Graph view, default state
Filename: `01-graph-default.png`

1. Click the **Graph** tab at the top (icon: three connected dots).
2. Wait 3 seconds for the force-graph to settle.
3. Top-right toolbar should show four pills/buttons:
   `2D | 3D` · `Analytics` · `Filters` · `Save`. Confirm none are
   filled with the orange accent (i.e. all "off"). If Analytics is
   on, click to turn off. If the Filters panel is open, click
   "Filters" to close it.
4. Capture full viewport. The shot should show the connected brain
   in the centre with a halo of orphan nodes on a ring around it.

### Shot 2 — Filter panel, open + populated
Filename: `02-filter-panel.png`

1. From the Graph view, click the **"Filters"** pill in the
   top-right toolbar. A slide-out panel appears on the right side.
2. Click the **"Filters"** section heading if it's not already
   expanded — it shows: search box, Show orphans, Semantic edges
   <count>, Manual links only, Show arrows.
3. Click **"Display"** section heading to expand it (Node size,
   Link thickness, Show labels at zoom).
4. Capture full viewport. Both panel and graph should be visible.

### Shot 3 — Time-lapse mid-playback
Filename: `03-timelapse.png`

1. With the Filters panel still open, scroll inside it to the
   **"Time-lapse"** section.
2. Set the duration slider to 30 seconds (so the shot is easy to time).
3. Click **"▶ Start time-lapse"**.
4. Wait roughly 12 seconds (so the playback is at ~40 % progress —
   roughly half the nodes will be visible, edges fading in).
5. Capture full viewport. The graph should look partially
   constructed, with some nodes visible and others not.
6. Click **"Stop time-lapse"** to abort the playback before moving on.

### Shot 4 — Graph view with Semantic edges ON
Filename: `04-graph-semantic-on.png`

1. In the Filters panel, toggle **"Semantic edges"** ON.
2. Close the panel by clicking the × at its top-right OR clicking
   the "Filters" pill again so the canvas fills the viewport.
3. Wait 4 seconds for the dense graph to re-settle.
4. Capture full viewport. The graph should look much denser than
   shot 1 — thousands of inferred edges added.

### Shot 5 — Multiple tabs + right-click context menu
Filename: `05-tabs-context-menu.png`

1. Click the **Notes** tab at the top.
2. In the left sidebar, click the first note. Wait for it to load.
3. Click the second note. A tab strip should now appear above the
   editor (if it didn't appear with one tab, the v0.1.8 build is
   not running yet — confirm with the user).
4. Click a third note so three tabs are open.
5. **Right-click** any tab. A context menu appears with
   "Close" / "Close others" / "Close all".
6. Capture full viewport with the menu visible. Move the cursor
   over "Close all" so it's highlighted.

### Shot 6 — Sidebar collapsed (full-width content)
Filename: `06-sidebar-collapsed.png`

1. Press **Ctrl + B** (or click the sidebar-toggle button at the
   leftmost edge of the top bar). The left sidebar should hide.
2. Switch to the **Graph** tab. The graph fills the entire width
   of the window.
3. Capture full viewport.
4. Press **Ctrl + B** again to bring the sidebar back before the
   next shot.

### Shot 7 — Command palette
Filename: `07-palette.png`

1. From any view, press **Ctrl + K** (or Cmd + K).
2. The command palette opens centred over the viewport.
3. Type the word `recall` so the palette shows command + memory
   results.
4. Wait 1 second.
5. Capture full viewport.
6. Press **Escape** to close.

### Shot 8 — Compile tab with agent panel + auto-approve
Filename: `08-compile-agent.png`

1. Click the **Compile** tab.
2. Find the disclosure labelled **"Compile with an agent"** near the
   top of the panel. Click it to expand.
3. In the topic input, type `VS Code extension`.
4. Click the **"Prepare"** button.
5. Wait 3 seconds for the source pack to load. The panel will show
   a list of source notes.
6. Make sure the **"Auto-approve on submit"** checkbox is visible
   (above the Submit button). It can be either on or off.
7. Capture full viewport.

### Shot 9 — Settings → About
Filename: `09-settings-about.png`

1. Find the **gear / settings icon** at the bottom-left corner of
   the sidebar (next to the brain selector).
2. Click it. A slide-over panel opens from the right.
3. Scroll the panel to the bottom until the **"About"** section is
   visible. The 40px NeuroVault logo + version string ("NeuroVault
   v0.1.8") should be in view.
4. Capture full viewport.
5. Press **Escape** to close before the next shot.

### Shot 10 — Activity panel
Filename: `10-activity.png`

1. At the very bottom of the window, click the small status pill
   that shows recent activity.
2. A panel slides up from the bottom showing recent ingest events
   and tool calls.
3. Capture full viewport.

### Cleanup

After all 10 screenshots are saved, list the files you wrote and
verify each is between 100 KB and 800 KB. A tiny file usually means
the page hadn't finished rendering — re-take if so.

### Failure modes to watch for

- If a view shows "Server offline" or a red banner: the desktop app
  is not running. Stop and report which step failed.
- If the graph shows a single dot or zero nodes: the active brain
  is empty. Open Settings and confirm a brain is selected.
- If a screenshot includes a browser address bar or scroll bars:
  retake at the 1440 × 900 viewport with browser chrome hidden.
- If shot 5 shows only the editor body and no tab strip: confirm
  with the user that they are running the v0.1.8 build (the strip
  was always-visible only from v0.1.8 onward).

## PROMPT END
