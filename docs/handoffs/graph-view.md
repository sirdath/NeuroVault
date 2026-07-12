# Handoff: improving the NeuroVault graph view

> Self-contained brief for an agent (Codex) picking up the graph view
> cold. Everything you need to be productive without spelunking. Read
> this fully before editing; the graph file is large and easy to
> regress. Last updated 2026-07-12.

## What the graph view is

The "neural graph" is NeuroVault's flagship visual: an interactive,
force-directed map of the user's memory. Each node is a note (engram);
each edge is a semantic/graph link between two notes. It's the second
main view of the desktop app (editor is the first), reachable from the
activity bar. It must feel alive and legible, and stay smooth on a
real brain of hundreds-to-thousands of nodes.

## Where it lives

| File | Lines | Role |
|---|---|---|
| `src/components/NeuralGraph.tsx` | ~2500 | The whole renderer. Canvas paint, force config, modes, interaction, camera, time-lapse, search, hover/focus. This is 90% of the work surface. |
| `src/components/GraphFilterPanel.tsx` | ~700 | The Filters side panel (layout presets, folder colors, toggles, label-zoom threshold, node size). |
| `src/components/GraphLegend.tsx` | ~145 | On-canvas legend for Analytics mode. |
| `src/stores/graphStore.ts` | ~110 | Zustand store: nodes/edges/hover/selection/focus + `loadGraph`. |
| `src/stores/graphSettingsStore.ts` | — | Persisted graph UI settings (`graphMode`, toggles, thresholds). Search for `useGraphSettingsStore`. |
| `src/lib/api.ts` | — | `GraphNode`, `GraphEdge`, `GraphData`, `fetchGraph`. |
| `src/lib/graphFromDisk.ts` | — | Disk-fallback graph builder (when the HTTP server is down). |

Server side (Rust): `src-tauri/src/memory/handlers/mod.rs` → `pub async fn graph(...)` → `get_graph(db, include_observations, min_similarity, exclude_types)`. Returns `GraphData { nodes, edges }`. **You almost certainly do not need to touch Rust** — the frontend is where the graph experience lives.

## Tech stack

- **`react-force-graph-2d` and `react-force-graph-3d` (v1.29.1)** — the renderer. 2D is canvas-based (the default and the important one); 3D is ThreeJS and **lazy-loaded** (`lazy(() => import(...))`) so its heavy deps don't bloat the 2D path. Don't un-lazy it.
- **`d3-force` (v3)** — the physics. Custom forces are attached via the force-graph ref's `d3Force(name, force)` escape hatch (see `NeuralGraph.tsx` ~line 508–575: link, collide, a custom cluster force, centerX/centerY).
- Plain Canvas 2D API for all node/link/label painting (`nodeCanvasObject={paintNode2D}`, `nodeCanvasObjectMode="replace"`).
- Zustand for state, Tailwind for the surrounding chrome, CSS variables for theming.

## Data flow

```
NeuralGraph mounts
  → useGraphStore().loadGraph(excludeTypes)   [on mount, brain switch, +3s settle refresh]
  → fetchGraph()  (src/lib/api.ts)
      → GET http://127.0.0.1:8765/api/graph?exclude_types=...   (preferred)
      → falls back to buildGraphFromDisk() if the server is down
  → store holds SimNode[] (GraphNode + {x,y,vx,vy,pinned}) + GraphEdge[]
  → NeuralGraph reads them into a memoized `graphData` and hands it to <ForceGraph2D graphData=...>
```

`loadGraph` is also re-fired 3s after mount (a settle refresh) and on `activeBrainId` change. The GET is uncached server-side.

## Data shapes (from `src/lib/api.ts`)

```ts
interface GraphNode {
  id: string;
  title: string;
  state: string;          // "fresh" | "active" | "connected" | "dormant" | ...
  strength: number;       // 0..1 usage/recency — drives the health ring
  access_count: number;
  folder?: string;        // top-level folder ("projects", "agent", "") for cluster color/layout
  created_at?: string;    // SQLite TEXT — drives the time-lapse ordering
  kind?: string;          // "note" | "source" | "code" | ... ; kind="code" gets gold styling + its own layer
}
interface GraphEdge {
  from: string; to: string;
  similarity: number;     // 0..1
  link_type: string;      // "similar" | "uses" (gold) | ... ; shown in the hover tooltip "type · 0.87"
}
```

## The scale you're optimizing for (measured live, 2026-07-12)

Active brain (`ml-ai`): **616 nodes, 7063 edges** — ~11 edges/node. This is the real target and the core problem: **the graph is edge-dense (a hairball)**, not node-heavy. The server already raised `min_similarity` 0.75 → 0.85 to cut edges, but a topic-focused brain (all ML notes) still scores densely. Node paint is largely solved (see below); **edge legibility and edge rendering cost are the biggest open problems.**

## Performance work ALREADY done — do NOT redo these

1. **Node sprite cache** (`getNodeSprite`, `spriteCache`, `SPRITE_SS=6`, ~line 200–265). The glassy orb (drop shadow + 3-stop radial gradient + specular) is baked once per `(color, size-bucket, shape)` into a 6×-supersampled offscreen canvas and stamped with `drawImage`. Was the dominant per-frame cost (two gradients + shadowBlur per node per frame); now ~10–30× cheaper. Alpha (focus/orphan/search dims) applied via `globalAlpha` over the stamp. Cache bounded at 512 entries.
2. **Auto-lite** (`lite || nodes.length > 800`, ~line 1654). Past 800 nodes the paint falls back to a flat fill (no gradient/ring/label). User's explicit "Lite" preset (`graphMode === "lite"`) forces it at any size.
3. **Static mode** (`mode === "static"`): physics loop fully off (`cooldownTicks/Time/warmupTicks = 0`), nodes pinned to `fx/fy` from the last settled layout captured on `onEngineStop`. Idle CPU between interactions.
4. **Lazy 3D**, cluster labels only in non-lite (`onRenderFramePost={lite ? undefined : paintClusterLabels}`), background tints only non-lite (`onRenderFramePre`).

## The render call (NeuralGraph.tsx ~2355)

```tsx
<ForceGraph2D
  ref={fg2dRef}
  graphData={graphData}
  width={size.w} height={size.h}
  backgroundColor="rgba(0,0,0,0)"
  nodeRelSize={5}
  nodeVal={nodeVal} nodeColor={nodeColor}
  nodeCanvasObject={paintNode2D} nodeCanvasObjectMode={() => "replace"}
  nodePointerAreaPaint={paintPointerArea2D}
  linkLabel={linkLabel} linkColor={linkColor} linkWidth={linkWidth} linkCurvature={linkCurvature}
  linkDirectionalArrowLength={showArrows ? 3.5 : 0}
  onRenderFramePre={lite ? undefined : paintBackgroundTints}
  onRenderFramePost={lite ? undefined : paintClusterLabels}
  cooldownTicks={mode === "static" ? 0 : lite ? 25 : 100}
  onNodeHover={handleNodeHover} onNodeClick={handleNodeClick}
  enableNodeDrag={mode !== "static"}
  minZoom={0.05} maxZoom={50}
/>
```

Modes: `"2d" | "3d" | "static"` (in `graphSettingsStore` as `graphMode`, plus a `"lite"` value that sets `lite=true`). Layout presets ("organic" vs clustered) are wired through the `d3Force` block.

## Highest-value improvement targets (pick from these)

These are opportunities, not prescriptions — use judgment:

1. **Edge rendering & legibility (biggest win).** 7k edges on 616 nodes reads as a hairball and costs the most per frame.
   - Consider: edge bundling, opacity/width scaled by `similarity`, hiding weak edges below a user threshold, drawing only edges touching the hovered/selected node + its neighbors at full strength and dimming the rest, or a per-frame edge budget with LOD (draw fewer edges when zoomed out).
   - The adjacency map already exists (search `adjacency`) — reuse it.
2. **Link paint cost.** Links are drawn by the library every frame. At 7k edges that's the new hot path now that nodes are cached. Profile it (Chrome perf tab against the live app) before optimizing.
3. **Initial layout settling.** Big/dense graphs can look chaotic on first load and take time to settle. Consider a better initial seeding, stronger early cooling, or a "settling…" affordance.
4. **Visual polish (brand just went blue — 2026-07-12).** The accent is now `#568cfa` on deep indigo-black (`--nv-accent`, theme id `neurovault`). Node state colors: fresh = brand blue ring, active/connected = teal `#00c9b1`, dormant = grey, `kind="code"` = gold `#f5c350`. Make sure any new visuals read against the blue identity and both look intentional.
5. **Labels.** Currently zoom-gated (`labelZoomThreshold`, default ~3.2) + shown for hover-focus neighbors. Overlap/decluttering at mid-zoom is an open problem.
6. **Empty / tiny / huge states.** Verify 0-node, ~10-node, and 2000+-node all look deliberate.

## Hard constraints — respect these

- **Do not touch backend/consolidation/memory semantics.** The project is mid-"observation window" (a frozen evaluation of the memory-review feature). Graph work is pure frontend and unrelated; keep it that way. Do not modify `src-tauri/src/memory/adaptive/**`, the journal, or consolidation. `/api/graph` is stable — treat it as read-only contract.
- **Theming via CSS vars, never hardcode.** Use `var(--nv-accent)`, `var(--nv-text)`, `var(--nv-surface)`, `var(--nv-border)`, etc. There are 8 themes; the graph must work in all. (A recent pass removed 20 hardcoded amber values — don't reintroduce hardcoded colors.)
- **TypeScript strict, no `any`** (the 3D ref has one grandfathered `any` with an eslint-disable; don't add more).
- **Preserve the existing perf machinery** (sprite cache, auto-lite, static mode). Build on it.
- **Keep it a single canvas** — no DOM-per-node overlays (they don't scale and break zoom transforms). Canvas paint + `onRenderFramePre/Post` is the pattern.

## How to run and verify

```bash
# from repo root
npm install                       # if fresh
npm run dev -- --port 1420        # Vite dev (CORS allows :1420). BUT the app
                                  # needs the Tauri runtime; see note below.
```

**Important:** the full app boots inside Tauri and calls Tauri APIs, so a
plain browser at `/` crashes with "Cannot read properties of undefined
(reading 'metadata')". Two ways to see the graph in a browser:
- Run the real desktop app: `npm run tauri dev` (hot-reloads the frontend), OR
- Use the preview harness pattern already in the repo (`preview.html` + `src/preview-main.tsx` render a single component against the live API on :8765) — copy that approach for a `<NeuralGraph>`-only preview if useful. The backend must be running (open the installed NeuroVault.app, or `neurovault-server --http-only`) so `/api/graph` answers on 127.0.0.1:8765.

**The gate (must pass before committing):**
```bash
cd src-tauri && GATES_FRONTEND=1 ../scripts/gates.sh    # runs: cargo fmt/test/clippy + tsc + vite build
```
For a frontend-only change you mainly need `npx tsc --noEmit` and `npm run build` green; the full gate also runs the Rust suite (should stay green since you didn't touch Rust).

Commit style: small, conventional (`feat(graph): ...`, `perf(graph): ...`, `fix(graph): ...`), no `Co-Authored-By` trailer. Branch is `feat/headless-mcp`; PR into `main`.

## Suggested first move

Profile the live app (616 nodes / 7063 edges) with Chrome's Performance
tab while panning/zooming, confirm links are now the hot path, then
tackle edge LOD + similarity-weighted opacity + neighbor-focus dimming.
That single change should improve both frame rate and legibility — the
two things a user actually feels.
