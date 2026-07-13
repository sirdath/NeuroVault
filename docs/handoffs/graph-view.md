# Handoff: NeuroVault graph snapshots and Graph Engine

> Self-contained brief for the next agent. Last updated 2026-07-13 after the
> Graph Engine V2 redesign. Read this before editing: `NeuralGraph.tsx` still
> contains legacy code paths and is easy to regress accidentally.

## Product contract

The graph has two deliberately different jobs:

1. **Everyday Graph View** is a calm visual receipt of the user's collected
   memory. It offers only a fixed **2D snapshot** and fixed **3D snapshot**.
   Their coordinates never settle or drift; they change only when graph
   content changes.
2. **Graph Engine** is the optional aesthetic playground. It opens from the
   snapshot toolbar, supplies curated compositions, and returns to the exact
   snapshot the user came from. Engine is never persisted as the startup mode.

The everyday page must stay understandable. Experimental styling, filters,
pattern import/export, and image export belong in Graph Engine.

## Current user-facing surface

Snapshot toolbar:

- `2D | 3D`
- Names: `Off | Key | All`
- Connections: `Off | Featured | All`
- `Fit`
- `Open Graph Engine`
- a small overflow menu for refresh/diagnostics/analytics/save actions

Graph Engine:

- compact composition description and `← Snapshots`
- Names and Connections controls
- safe declarative pattern import/export
- Fit, Save image, Filters
- six composition gallery: **Time Rings, Constellation Islands, Neural Arbor,
  Connectome Halo, Memory Flow, Knowledge Globe**

The bottom count is honest: it reports relationships shown and total
relationships separately.

## Files

| File | Role |
|---|---|
| `src/components/NeuralGraph.tsx` | Shared shell, fixed snapshot renderers, toolbar, camera, hover/focus, Engine handoff and fallback. |
| `src/components/AtlasGraph.tsx` | Sigma/WebGL Graph Engine, style-aware curved relationships, six-style gallery, controls, export and failure fallback. |
| `src/lib/graphSnapshots.ts` | Pure deterministic 2D community packing and 3D Fibonacci-shell coordinates. |
| `src/lib/atlasVisualModel.ts` | Deterministic row collapse, relationship tiers, communities, importance and fingerprint. |
| `src/lib/atlasPatterns.ts` | Pure composition geometry plus bounded declarative custom-pattern parser. |
| `src/lib/atlasLayoutCache.ts` | IndexedDB cache retained for imported legacy transforms that still consume a ForceAtlas base layout. |
| `src/workers/atlasLayout.worker.ts` | Deterministic fixed-iteration ForceAtlas worker for legacy/custom transforms only. Built-ins do not run it. |
| `src/stores/graphStore.ts` | Graph fetch/state. Preserves node/edge references when the content fingerprint is unchanged and ignores stale requests. |
| `src/stores/graphSettingsStore.ts` | Persisted Names, Connections, palette and other graph settings. |
| `src/components/GraphFilterPanel.tsx` | Advanced filters. Mounted only in Graph Engine. |

Server data remains read-only here:
`src-tauri/src/memory/handlers/mod.rs` → `/api/graph`.

## Rendering architecture

```text
/api/graph
  → graphStore canonical content fingerprint
  → NeuralGraph
      ├─ 2D snapshot
      │    buildAtlasVisualModel → graphSnapshot2D
      │    fixed fx/fy → ForceGraph2D, zero warmup/cooldown
      ├─ 3D snapshot
      │    buildAtlasVisualModel → graphSnapshot3D
      │    fixed fx/fy/fz → lazy ForceGraph3D, zero warmup/cooldown
      │    deterministic camera distance (never early zoomToFit)
      └─ Graph Engine
           buildAtlasVisualModel → selected pure composition
           → Sigma WebGL nodes + @sigma/edge-curve relationships
```

The built-in Engine compositions are deterministic O(N + E) or O(E log E)
presentation passes. They do not simulate physics and therefore have no
visible settling or idle layout work.

## Snapshot behavior

### Fixed 2D

- Communities are packed on a deterministic golden-angle spiral.
- Notes use compact phyllotaxis inside their community.
- Orphans occupy outer rings.
- Coordinates are normalized to a stable extent and pinned through `fx/fy`.
- Featured connections use the visual model's full non-detail connectivity
  backbone; do not sparsify it again or the snapshot becomes confetti.

### Fixed 3D

- Notes occupy a deterministic Fibonacci shell with real depth.
- Radius scales with `sqrt(nodeCount)` and is bounded for tiny/large brains.
- Coordinates are pinned through `fx/fy/fz`; the user may orbit but nodes do
  not move.
- Initial framing and Fit call `cameraPosition` using the known shell bound.
  Do not replace this with an early `zoomToFit`: while the lazy Three renderer
  is mounting its bounding box can still be at the origin, putting the camera
  inside the globe and producing giant clipped spheres.

## Graph Engine composition contract

A credible style owns more than coordinates. Each built-in controls:

- silhouette/layout
- node emphasis
- which real relationships appear in Featured mode
- curve amount and relationship colour
- atmosphere/background
- fit and gallery identity

All relationships are real model edges. Decorative rings, lanes and glows are
atmosphere only and are never represented as evidence.

Current styles:

- **Time Rings:** chronological spiral with a few authored long-range arcs and
  a local relationship skeleton.
- **Constellation Islands:** up to ten substantial communities packed as
  islands; tiny groups become an outer dust field instead of fake anchors.
- **Neural Arbor:** up to eight substantial communities become radial spanning
  trees built from actual relationships. Tiny groups remain peripheral dust.
- **Connectome Halo:** community arcs around a circle plus a curated mix of
  cross-community chords and local perimeter relationships.
- **Memory Flow:** five centred chronological currents; largest community is in
  the central lane and subtle SVG streams are atmosphere only.
- **Knowledge Globe:** interleaved community ordering projected as an orb with
  curved relationships and a restrained depth atmosphere.

Featured budgets are deliberately small and style-specific. `All` still makes
the full collapsed evidence graph available. Edges use Sigma's official
`@sigma/edge-curve` WebGL renderer. Colours are pre-blended with the theme
background because low-alpha WebGL line compositing varies across GPUs.

## Controls and persistence

- Default is Names Off, Connections Featured.
- Off genuinely removes labels/relationships from rendering.
- Key names are community anchors only, and singleton/tiny communities do not
  become oversized anchors.
- Engine pattern selection persists; Engine itself does not persist as the
  startup view.
- Custom JSON patterns are schema-versioned, size-bounded, numeric-bounded,
  allowlisted transforms only, and reject URLs/callbacks/shaders/code.

## Scale and performance target

Latest live QA brain on 2026-07-13: **247 memories, 4,111 raw relationships**.
The system must also remain comfortable at roughly 2,000 nodes and tens of
thousands of raw relationship rows.

Important performance rules:

- Never add one DOM element per note.
- Keep 3D lazy-loaded.
- Keep built-in compositions simulation-free.
- Preserve graph-store identical-refresh reference reuse.
- Preserve deterministic fingerprints and replay tests.
- Do not materialize extra copies of all raw edges inside render callbacks.
- All-mode may be visually dense by explicit user choice; default Featured
  must remain sparse.

## Verification

Pure graph suite:

```bash
npm run test:graph
# or: ./node_modules/.bin/tsx src/lib/graph.test.ts
```

It covers model correctness, replay, safe pattern parsing, six finite/distinct
composition silhouettes, row-order independence, fixed snapshot replay,
metadata-only stability, mutation isolation, tiny/empty brains and true 3D
depth.

Frontend checks:

```bash
npx tsc --noEmit
npm run build
```

For visual QA without booting the full Tauri app, `graph-preview.html` and
`src/graph-preview-main.tsx` render `NeuralGraph` against the live API on
`127.0.0.1:8765`. Inspect all eight states at desktop size:

- fixed 2D
- fixed 3D
- every Engine composition with Names Off / Connections Featured
- at least one style with Names Key and Connections Off

The production gate remains:

```bash
cd src-tauri && GATES_FRONTEND=1 ../scripts/gates.sh
```

## Hard constraints

- Do not touch journal, consolidation, adaptive-memory or observation-window
  behavior for graph work.
- Keep all palette choices theme-derived.
- TypeScript strict; do not add `any`.
- Preserve exact replay. A graph refresh with unchanged content must not move a
  single note.
- Do not claim a decorative connection is memory evidence.
- Judge styles on the user's real brain screenshots, not only synthetic data.

## Honest follow-ups

- Engine PNG export captures Sigma and a solid background but not every CSS/SVG
  atmosphere layer yet; a future export compositor should make the saved image
  pixel-match the viewport.
- ForceGraph3D has fixed physics but still owns a Three render loop. A bespoke
  on-demand renderer could further reduce idle GPU use later.
- If a new composition cannot produce a genuinely different, polished
  silhouette, do not add it merely to increase the gallery count.
