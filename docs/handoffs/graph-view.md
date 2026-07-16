# Handoff: the NeuroVault graph view

> Self-contained brief for the next agent. Last updated 2026-07-16, after the
> preset-bar collapse. Read this before editing `NeuralGraph.tsx`.
>
> **This supersedes the "calm receipt vs aesthetic playground" contract.** The
> previous version of this file described two deliberately different products —
> an everyday snapshot page, and a Graph Engine playground you opened from it.
> That split is gone. If you are about to re-add an "Open Graph Engine" button,
> a second toolbar, or a separate composition gallery: that is the thing that
> was removed on purpose, and why is below.

## Product contract

**The graph has one job and one control.** Eight views, all peers, all on one
bar. Pick one; it persists; that is the whole model.

```
[2D] [3D] │ [Time Rings] [Islands] [Arbor] [Halo] [Flow] [Globe]
Names: Off · Key · All    Lines: Off · Some · All    [Fit]  [•••]
```

**Why the split died.** 2D and 3D were in the toolbar; the other six lived
behind an "Open Graph Engine" button that swapped in a different toolbar, a
different picker, and its own localStorage key, with "← Snapshots" to get out.
If you never found that button you never learned six of the eight views
existed. The Engine's own choice was never persisted, so a reload silently
returned you to a snapshot — the "playground" could not even remember itself.
Meanwhile the duplication was leaking: `Fit` in both toolbars, image export in
both under different names, and one setting called "Lines" in one place and
"Connections" in the other.

The compositions were never the problem. They are the best thing in the UI.
Only their entry point was.

**What is still true from the old contract:** the everyday page must stay
understandable, coordinates never drift, and no decorative flourish may be
presented as memory evidence.

## The one source of truth

`graphSettingsStore.preset` — a `GraphPreset`, which is `"2d" | "3d" |
AtlasPatternId`. `presetRenderer(preset)` is the **only** place mapping a
preset to a renderer (`"2d" | "3d" | "engine"`).

This replaced three mechanisms that could disagree: an ad-hoc `nv.graph.mode`
key, AtlasGraph's private `nv.atlas.pattern` key, and the settings store. Both
legacy keys are read once by `migratePreset()` and deleted; see
`graphSettingsStore.test.tsx` for the upgrade paths that matter.

**Do not add a second place that knows what view is on screen.** That is the
bug class this whole refactor existed to kill.

## Control matrix

Every control, every preset. Verified by hand on the live 247-memory brain
(2026-07-16) via `graph-preview.html`, plus the automated coverage named below.

| Control | 2D | 3D | 6 compositions | Notes |
|---|---|---|---|---|
| Preset pills (×8) | ✅ | ✅ | ✅ | Each click asserted to fire in `GraphPresetBar.test.tsx`; a dead pill fails by name. |
| Names `Off/Key/All` | ✅ | ✅ | ✅ | 3D uses real sprite labels (`graphLabelSprite.ts`), not hover tooltips. |
| Lines `Off/Some/All` | ✅ | ✅ | ✅ | `Some` = the non-detail backbone in snapshots; an authored budget in compositions. |
| Fit | ✅ | ✅ | ✅ | 3D uses `cameraPosition` off the known shell bound — never an early `zoomToFit`. |
| ••• → Filters | ✅ | ✅ | ✅ | Was gated on `mode === "engine"`; that gate would now make the button dead in 2D/3D. |
| ••• → Update snapshot | ✅ | ✅ | ✅ | |
| ••• → Vault diagnostic | ✅ | ✅ | ✅ | |
| ••• → Show/Hide analytics | ✅ | ✅ | ✅ | Mounts the legend + tip bar. |
| ••• → Save PNG / Copy image | ✅ | ✅ | ✅ | 2D composites the theme background at export (a transparent PNG is invisible on light backgrounds). Composition export still misses some CSS/SVG atmosphere — see follow-ups. |

`Names` and `Lines` are single-sourced in the toolbar. AtlasGraph reads them and
renders no duplicate pair.

## Files

| File | Role |
|---|---|
| `src/components/NeuralGraph.tsx` | Shell, 2D/3D snapshot renderers, the one toolbar, camera, hover/focus, WebGL fallback. |
| `src/components/GraphPresetBar.tsx` | The view picker. Labels + hints for all 8 presets. |
| `src/components/AtlasGraph.tsx` | Sigma/WebGL compositions. **Controlled** — takes `patternId`, owns no view state. |
| `src/lib/graphSnapshots.ts` | Pure deterministic 2D packing + 3D Fibonacci shell. |
| `src/lib/atlasVisualModel.ts` | Deterministic row collapse, tiers, communities, fingerprint. |
| `src/lib/atlasPatterns.ts` | Pure composition geometry. `AtlasPatternId` is the closed set of shipped ids. |
| `src/lib/graphLabelSprite.ts` | 3D label sprites + cache. |
| `src/stores/graphStore.ts` | Graph fetch/state. Preserves refs when the fingerprint is unchanged. |
| `src/stores/graphSettingsStore.ts` | `preset` + Names/Lines/palette/etc. Owns the legacy-key migration. |
| `src/components/GraphFilterPanel.tsx` | Advanced filters. Mounted for **every** preset. |

Server data is read-only here: `src-tauri/src/memory/handlers/mod.rs` →
`/api/graph`.

## Rendering architecture

```text
/api/graph
  → graphStore canonical content fingerprint
  → NeuralGraph  (preset → presetRenderer)
      ├─ "2d"     buildAtlasVisualModel → graphSnapshot2D
      │           fixed fx/fy → ForceGraph2D, zero warmup/cooldown
      ├─ "3d"     buildAtlasVisualModel → graphSnapshot3D
      │           fixed fx/fy/fz → lazy ForceGraph3D, zero warmup/cooldown
      │           deterministic camera distance (never early zoomToFit)
      └─ "engine" buildAtlasVisualModel → the preset's pure composition
                  → AtlasGraph: Sigma WebGL + @sigma/edge-curve
```

Compositions are deterministic O(N + E) / O(E log E) presentation passes. They
do not simulate physics — no settling, no idle layout work.

### The 3D links trap — do not re-break this

2D and 3D **must never share link objects.** `snapshotLinks` is copied per
surface (`.map((link) => ({ ...link }))`) and both graphs pass
`linkSource="from"` / `linkTarget="to"`.

Why: with a shared array, d3-force resolves `link.source` from the id string
into a **2D node object** and writes it back. d3-force-3d then sees an object,
skips re-resolution, and draws 3D links bound to 2D nodes at 2D coordinates
flattened to z=0 — links that connect nothing. It only reproduces on the
2D→3D path; loading straight into 3D always looked fine.

`NeuralGraph.test.tsx` locks both halves. It was written by reintroducing the
bug and watching it fail.

## Snapshot behavior

### Fixed 2D
- Communities packed on a deterministic golden-angle spiral; notes in compact
  phyllotaxis inside their community; orphans in outer rings.
- Normalized to a stable extent, pinned via `fx/fy`.
- `Some` uses the model's full non-detail backbone — **do not sparsify again**
  or the snapshot becomes confetti.
- Node radius is `snapshotNodeRadius` (sqrt of degree, anchors flat-boosted).
  The pointer hit area must track it: they drifted once, giving a click target
  ~2.7× the drawn dot.

### Fixed 3D
- Deterministic Fibonacci shell with real depth; radius scales with
  `sqrt(nodeCount)`, bounded for tiny/large brains; pinned via `fx/fy/fz`.
- Framing and Fit use `cameraPosition` with the known shell bound. **Do not**
  replace with an early `zoomToFit`: while the lazy Three renderer mounts, its
  bounding box can still be at the origin, putting the camera inside the globe.

## Composition contract

A credible composition owns more than coordinates: silhouette, node emphasis,
which real relationships appear in `Some`, curve amount and colour, atmosphere,
and fit identity.

All relationships are real model edges. Rings, lanes and glows are atmosphere
only and are **never** presented as evidence.

- **Time Rings** — chronological spiral, a few authored long-range arcs.
- **Islands** — up to ten substantial communities as islands; tiny groups become
  outer dust, not fake anchors.
- **Arbor** — up to eight communities as radial spanning trees built from real
  relationships.
- **Halo** — community arcs on a circle, cross-community chords + perimeter.
- **Flow** — five chronological currents; SVG streams are atmosphere.
- **Globe** — interleaved community ordering projected as an orb.

`Some` budgets are small and composition-specific; `All` exposes the full
collapsed evidence graph. Edges use `@sigma/edge-curve`. Colours are pre-blended
with the theme background because low-alpha WebGL compositing varies by GPU.

**Naming:** the 3D snapshot and the Globe composition are both spheres. The
true-3D view is plainly `3D`; `Globe` is the flat composition shaped like one.
Nothing else on the bar is a shape word. A test asserts only one preset may be
called a globe — do not reintroduce "3D Globe" / "Orb".

## Scale and performance

Live QA brain (2026-07-16): **247 memories, 4,034 relationships.** Must stay
comfortable at ~2,000 nodes and tens of thousands of raw rows.

- Never add one DOM element per note.
- Keep 3D lazy-loaded (it is its own build chunk).
- Keep compositions simulation-free.
- Preserve graph-store identical-refresh reference reuse.
- Preserve deterministic fingerprints and replay tests.
- Do not materialize extra copies of all raw edges inside render callbacks.
- `All` may be dense by explicit choice; the default `Some` must stay sparse.

## Verification

```bash
cd src-tauri && GATES_FRONTEND=1 ../scripts/gates.sh
```

The gate runs Rust tests + both clippy targets, `tsc`, release hardening, the
**lib suites**, the component suites, and the Playwright smoke.

> The gate did not always run the lib suites. `test:graph` and `test:durability`
> existed but were never called, and vitest's include (`*.test.tsx`) skipped
> every `.ts` suite — so `graphExport`, `consumerHealth` and `noteDrafts` were
> run by *nothing*, and the replay guarantee went unverified through ~2,100
> lines of graph deletions. `scripts/run-lib-tests.mjs` now discovers suites
> instead of listing them. **Two harnesses, split by extension:** `.test.tsx` →
> vitest; `.test.ts` → tsx scripts under `src/lib`. A vitest test saved as
> `.test.ts` runs in neither (the runner fails the gate if it finds one).

Visual QA without booting Tauri: `graph-preview.html` +
`src/graph-preview-main.tsx` render `NeuralGraph` against the live API on
`127.0.0.1:8765`. Inspect all eight presets at desktop size, plus at least one
with Names Key and Lines Off.

## Hard constraints

- Do not touch journal, consolidation, adaptive-memory or observation-window
  behavior for graph work.
- Keep all palette choices theme-derived.
- TypeScript strict; do not add `any`.
- **Preserve exact replay.** A refresh with unchanged content must not move a
  single note.
- Do not claim a decorative connection is memory evidence.
- Judge on the user's real brain, not synthetic data.
- **Every control must do something in every preset it renders in.** ~31 of ~97
  affordances were dead or no-ops before this work; that is how the graph got
  into the state it was in. If a control cannot work in a preset, do not render
  it there.
- **The UI must not describe encodings the renderer does not draw.** The legend
  once documented a health-ring colour key — teal/amber/grey — that no code
  painted, and the tip bar credited PageRank for sizing that comes from degree.
  If you change the painter, change the legend in the same commit.

## Honest follow-ups

- Composition PNG export captures Sigma and a solid background, but not every
  CSS/SVG atmosphere layer. A compositor should make the saved image pixel-match
  the viewport.
- `ForceGraph3D` has fixed physics but still owns a Three render loop. A bespoke
  on-demand renderer could cut idle GPU further.
- `NeuralGraph.tsx` is still ~2,000 lines and ~96 hooks. The seams for
  extraction (`graph2DPainters.ts`, `useGraphData()`, `useGraphCamera()`,
  `useTimelapse()`, `<GraphToolbar/>`) are real; do it incrementally, behind
  `NeuralGraph.test.tsx`.
- If a new composition cannot produce a genuinely different, polished
  silhouette, do not add it merely to raise the count.
