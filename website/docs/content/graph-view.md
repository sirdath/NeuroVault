# The graph view

The graph view turns your vault into a force-directed map: every engram is a node, every link an edge. It's the fastest way to *see* the shape of what you know — which ideas are central, what clusters together, what's drifting toward the edges. Open it with **Ctrl/Cmd + 2** or the **Graph** tab.

This page covers the controls and what every visual cue means. For the math behind the structural overlays (PageRank, communities), see [Graph analytics](#graph-analytics).

## Reading a node

Each node encodes three independent signals, so you can read a node at a glance without hovering:

- **Fill colour = category.** A node's fill is the colour of its top-level folder. Notes in the same folder share a colour, in the tree and on the canvas alike. Override any folder's colour from **Filters → Appearance**.
- **Ring = health.** The ring around a node shows its state and strength. Teal = active and well-connected, amber = freshly added, dim grey = dormant (rarely accessed). A thicker, brighter ring means a stronger memory.
- **Size = importance.** In [Analytics](#graph-analytics) mode, node size scales with PageRank — how often the rest of your brain references it. Big nodes are your core concepts.

> [!NOTE]
> Fill is category and the ring is health — they're separate on purpose. A dormant note in your "projects" folder keeps its project colour (fill) while its ring fades to grey (health). Colour never lies about category.

## Toolbar controls

Along the top of the graph:

- **Refresh** — re-pulls the graph from the vault so newly-indexed notes and fresh links appear without restarting the app. Useful right after your agent writes a batch of notes.
- **Analytics** — toggles the structural overlay: importance-scaled sizing, community tints, the cluster legend, and the hover read-outs. See [Graph analytics](#graph-analytics).
- **Filters** — opens the side panel with everything below.
- **Save** — exports the current 2D canvas as a transparent PNG.
- **2D / 3D** — switch renderers. 3D adds depth and a bloom glow; 2D is lighter and the default.

## The Filters panel

### Layout

- **Spread** — one slider for how far apart nodes sit. Drag right to fan the graph out, left to pull it tight. It drives the three lower-level force sliders (charge, link distance, centering) in one move; those remain available if you want to fine-tune.
- **Layout shape** — *Organic* (default d3-force) or *Circle* (connected nodes arranged on a ring).

### Display

- **Node size / Link thickness** — global scale multipliers.
- **Show labels at zoom** — the zoom level past which node titles appear. Labels now sit on a semi-transparent pill so long titles never bleed into a neighbouring node.
- **Animations** — turn off to stop the 3D particle flow and skip the bloom pass. This is the main "save GPU" switch, especially helpful on the 3D view or older machines.
- **Category grouping** — *Off* or *Venn*. Venn draws a soft outlined region (a convex hull) around each folder/category, visible when you're zoomed out — handy for seeing your categories as territories.

### Appearance

Palette, node shape (circle / square / hex), and per-folder / per-cluster colour overrides.

### Time-lapse

Replays the order your notes were created — nodes appear chronologically, edges fade in once both endpoints are visible. Set a duration and press play. (Ordering is by creation time, so a batch import where every note shares an *updated* timestamp still animates correctly.)

## Analytics legend

Turn on **Analytics** and a legend pins to the bottom-left. It does two things:

1. **Decodes the encoding** — a compact key for size (importance), ring (health), and fill/tint (category), so you never have to guess what a colour means.
2. **Lists your clusters** — the communities NeuroVault found, biggest first, each with its colour and note count. **Click a cluster to fly the camera to it.** It's a way to *navigate* structure, not just read it.

> [!TIP]
> Clusters are computed with Louvain community detection over your links. They often map to topics that cut across folders — which is exactly the cross-pollination a flat folder tree hides.

## Dropping files onto the graph

You can drag files from your file manager straight onto the window. They land in the brain's [drop-folder inbox](#drop-folder) for your connected agent to turn into clean notes — they don't get force-indexed as raw blobs. See [Drop-folder ingest](#drop-folder) for the full flow.
