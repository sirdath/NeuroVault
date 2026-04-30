import { create } from "zustand";

/**
 * User-tweakable visual options for the graph view.
 *
 * Why a separate store from `graphStore`:
 *   - `graphStore` is *graph data* (nodes, edges, hover state, focus
 *     requests). It changes when the brain's index changes.
 *   - `graphSettingsStore` is *visual preferences* the user picks once
 *     and forgets. It changes only on Settings interactions and persists
 *     to localStorage so the next session opens with the chosen palette.
 *
 *  Keeping them separate means a graph reload doesn't churn the
 *  settings consumers and a settings change doesn't trigger a graph
 *  data refetch.
 */

export type GraphPalette = "warm" | "cool" | "mono" | "vivid";
export type GraphNodeShape = "circle" | "square" | "hex";

/** Hand-tuned palettes — opinionated defaults beat infinite color
 *  pickers for an OSS tool. Each palette is 8 hues meant to look
 *  cohesive against the Vault Noir background. */
export const PALETTES: Record<GraphPalette, string[]> = {
  warm: [
    "#DE7356", // peach (brand)
    "#5CC8A8", // soft teal
    "#6C9FD8", // sky blue
    "#A78BFA", // violet
    "#87A396", // sage
    "#C9A3C8", // dusty rose
    "#7891B0", // slate blue
    "#C9A673", // warm sand
  ],
  cool: [
    "#5CC8A8", // teal
    "#6C9FD8", // sky
    "#A78BFA", // violet
    "#7891B0", // slate
    "#88C0D0", // arctic
    "#9CB6D6", // ice blue
    "#B8A2D8", // pale violet
    "#7DB8B0", // sea green
  ],
  mono: [
    "#A8A8C0", // light slate
    "#9090A8", // mid slate
    "#787890", // slate
    "#606078", // dim slate
    "#B0B0C0", // very light
    "#7A7A92", // muted
    "#8C8CA0", // soft
    "#6E6E86", // deep
  ],
  vivid: [
    "#FF6B6B", // coral
    "#4ECDC4", // teal pop
    "#45B7D1", // bright sky
    "#FFA94D", // saturated orange
    "#A855F7", // electric violet
    "#34D399", // emerald
    "#F472B6", // pink
    "#FBBF24", // gold
  ],
};

/** Color used for nodes whose folder is "" (root-level), per palette.
 *  Picked to feel "neutral" against the rest. */
export const PALETTE_NEUTRAL: Record<GraphPalette, string> = {
  warm: "#6e6d8f",
  cool: "#7a8aa0",
  mono: "#5e5e74",
  vivid: "#8a8aa0",
};

interface GraphSettings {
  palette: GraphPalette;
  nodeShape: GraphNodeShape;
  /** When true, every cluster centroid gets a folder label at all
   *  times (the original behaviour). When false, only the cluster of
   *  the focused node is labelled (Phase 4 default). */
  showClusterLabels: boolean;
  /** Master toggle for the Analytics layer (PageRank-driven node
   *  sizing + community tints + tip bar). Default: off. Toggled via
   *  the toolbar pill or Cmd+Shift+A. Persisted so the user's choice
   *  survives reloads. */
  analyticsMode: boolean;
  /** When analyticsMode is on: also resize nodes by importance
   *  (PageRank). User can opt out per-layer in Settings → Graph
   *  without disabling analytics entirely. */
  analyticsResizeByImportance: boolean;
  /** When analyticsMode is on: also tint backgrounds by community. */
  analyticsGroupByCommunity: boolean;
  /** When false (default), edges with link_type === "semantic" are
   *  filtered out of the graph view. Manual wikilinks and entity
   *  co-mentions still render. Default is off because on a brain
   *  with a few hundred notes the auto-computed semantic-similarity
   *  edges create a fully-connected hairball that obscures real
   *  structure. Toggled via the floating "Semantic links" pill in
   *  the graph view. Persisted. */
  showSemanticEdges: boolean;
  /** Per-folder colour overrides — keyed by folder name (vault
   *  subfolder). Empty string ("") is the root folder. Overrides win
   *  over the palette hash; folders not present here fall back to the
   *  palette as before. Persisted. */
  folderColors: Record<string, string>;
  /** Per-cluster colour overrides — keyed by the cluster's NAME. Only
   *  applies after the user has named a cluster (via /name-clusters or
   *  by editing config.json); unnamed clusters keep their dominant-folder
   *  derived tint because numeric Louvain ids aren't stable across
   *  brain edits. */
  clusterColors: Record<string, string>;
  // -- v0.1.8 graph filter panel additions ----------------------------
  /** Free-text node filter. When non-empty, nodes whose title does not
   *  match (case-insensitive substring) are dimmed out. Edges that
   *  touch a non-matching node are also dimmed. */
  searchQuery: string;
  /** When false, isolated (degree-0) nodes are completely hidden from
   *  the canvas. Default true — they render in the orphan halo. */
  showOrphans: boolean;
  /** When true, only manually-authored wikilinks render. Overrides
   *  showSemanticEdges; entity edges are also hidden. */
  manualOnly: boolean;
  /** Multiplicative scale on every node's drawn radius. 1.0 default,
   *  user-tunable 0.5..2.0 via the Display section slider. */
  nodeSizeScale: number;
  /** Multiplicative scale on every link's drawn width. */
  linkThicknessScale: number;
  /** globalScale threshold above which node titles render. Higher =
   *  zoom in more before labels appear. Default 3.2. */
  labelZoomThreshold: number;
  /** Draw arrowheads on directed edges (manual wikilinks). Default
   *  off — undirected look reads cleaner at typical zoom. */
  showArrows: boolean;
  /** d3-force gentle "stay near origin" pull strength on every
   *  non-pinned node. 0 disables, 0.04 default. Higher = tighter
   *  cluster, less sprawl. */
  centeringStrength: number;
  /** d3-forceManyBody charge strength. More negative = more node
   *  repulsion = more spread out. Default -90. */
  chargeStrength: number;
  /** d3-forceLink target distance for connected nodes. Default 26. */
  linkDistance: number;
  /** Layout shape for the connected component. "organic" is the
   *  default d3-force layout; "circle" pulls connected nodes onto a
   *  ring around the centre via forceRadial. */
  layoutShape: GraphLayoutShape;
  /** Time-lapse playback speed in seconds (full graph reveal time).
   *  Lower = faster. Default 15 s. */
  timelapseSpeedSec: number;
}

export type GraphLayoutShape = "organic" | "circle";

const STORAGE_KEY = "nv.graph.settings";

const DEFAULTS: GraphSettings = {
  palette: "warm",
  nodeShape: "circle",
  showClusterLabels: false,
  analyticsMode: false,
  analyticsResizeByImportance: true,
  analyticsGroupByCommunity: true,
  showSemanticEdges: false,
  folderColors: {},
  clusterColors: {},
  searchQuery: "",
  showOrphans: true,
  manualOnly: false,
  nodeSizeScale: 1.0,
  linkThicknessScale: 1.0,
  labelZoomThreshold: 3.2,
  showArrows: false,
  centeringStrength: 0.04,
  chargeStrength: -90,
  linkDistance: 26,
  layoutShape: "organic",
  timelapseSpeedSec: 15,
};

/** Tight `#rrggbb` validator. We only persist colours that match this
 *  shape so a corrupt store entry can't smuggle invalid CSS into the
 *  canvas. */
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function sanitizeColorMap(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === "string" && HEX_RE.test(v)) out[k] = v.toLowerCase();
  }
  return out;
}

function load(): GraphSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Defensive: only keep keys we know, otherwise fall back to default.
      const palette: GraphPalette =
        parsed.palette === "cool" ||
        parsed.palette === "mono" ||
        parsed.palette === "vivid"
          ? parsed.palette
          : "warm";
      const nodeShape: GraphNodeShape =
        parsed.nodeShape === "square" || parsed.nodeShape === "hex"
          ? parsed.nodeShape
          : "circle";
      const bool = (key: string, fallback: boolean): boolean =>
        typeof parsed[key] === "boolean" ? parsed[key] : fallback;
      const num = (key: string, fallback: number, min: number, max: number): number => {
        const v = parsed[key];
        return typeof v === "number" && v >= min && v <= max ? v : fallback;
      };
      const layoutShape: GraphLayoutShape =
        parsed.layoutShape === "circle" ? "circle" : "organic";
      return {
        palette,
        nodeShape,
        showClusterLabels: bool("showClusterLabels", false),
        analyticsMode: bool("analyticsMode", false),
        analyticsResizeByImportance: bool("analyticsResizeByImportance", true),
        analyticsGroupByCommunity: bool("analyticsGroupByCommunity", true),
        showSemanticEdges: bool("showSemanticEdges", false),
        folderColors: sanitizeColorMap(parsed.folderColors),
        clusterColors: sanitizeColorMap(parsed.clusterColors),
        searchQuery: typeof parsed.searchQuery === "string" ? parsed.searchQuery : "",
        showOrphans: bool("showOrphans", true),
        manualOnly: bool("manualOnly", false),
        nodeSizeScale: num("nodeSizeScale", 1.0, 0.3, 3.0),
        linkThicknessScale: num("linkThicknessScale", 1.0, 0.3, 3.0),
        labelZoomThreshold: num("labelZoomThreshold", 3.2, 0.5, 8.0),
        showArrows: bool("showArrows", false),
        centeringStrength: num("centeringStrength", 0.04, 0, 0.5),
        chargeStrength: num("chargeStrength", -90, -300, -10),
        linkDistance: num("linkDistance", 26, 5, 120),
        layoutShape,
        timelapseSpeedSec: num("timelapseSpeedSec", 15, 3, 90),
      };
    }
  } catch { /* corrupt / private mode */ }
  return DEFAULTS;
}

interface GraphSettingsStore extends GraphSettings {
  setPalette: (p: GraphPalette) => void;
  setNodeShape: (s: GraphNodeShape) => void;
  setShowClusterLabels: (v: boolean) => void;
  setAnalyticsMode: (v: boolean) => void;
  toggleAnalyticsMode: () => void;
  setAnalyticsResizeByImportance: (v: boolean) => void;
  setAnalyticsGroupByCommunity: (v: boolean) => void;
  setShowSemanticEdges: (v: boolean) => void;
  toggleShowSemanticEdges: () => void;
  /** Set or clear (`null`) the colour for one folder. Invalid hex is
   *  silently ignored. Empty-string folder is the root folder. */
  setFolderColor: (folder: string, color: string | null) => void;
  /** Wipe every folder override at once — used by the "Reset all" button. */
  clearFolderColors: () => void;
  setClusterColor: (clusterName: string, color: string | null) => void;
  clearClusterColors: () => void;
  setSearchQuery: (q: string) => void;
  setShowOrphans: (v: boolean) => void;
  setManualOnly: (v: boolean) => void;
  setNodeSizeScale: (v: number) => void;
  setLinkThicknessScale: (v: number) => void;
  setLabelZoomThreshold: (v: number) => void;
  setShowArrows: (v: boolean) => void;
  setCenteringStrength: (v: number) => void;
  setChargeStrength: (v: number) => void;
  setLinkDistance: (v: number) => void;
  setLayoutShape: (v: GraphLayoutShape) => void;
  setTimelapseSpeedSec: (v: number) => void;
}

function persist(s: GraphSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch { /* ignore */ }
}

export const useGraphSettingsStore = create<GraphSettingsStore>((set, get) => ({
  ...load(),
  setPalette: (palette) => {
    set({ palette });
    persist({ ...get(), palette });
  },
  setNodeShape: (nodeShape) => {
    set({ nodeShape });
    persist({ ...get(), nodeShape });
  },
  setShowClusterLabels: (showClusterLabels) => {
    set({ showClusterLabels });
    persist({ ...get(), showClusterLabels });
  },
  setAnalyticsMode: (analyticsMode) => {
    set({ analyticsMode });
    persist({ ...get(), analyticsMode });
  },
  toggleAnalyticsMode: () => {
    const next = !get().analyticsMode;
    set({ analyticsMode: next });
    persist({ ...get(), analyticsMode: next });
  },
  setAnalyticsResizeByImportance: (analyticsResizeByImportance) => {
    set({ analyticsResizeByImportance });
    persist({ ...get(), analyticsResizeByImportance });
  },
  setAnalyticsGroupByCommunity: (analyticsGroupByCommunity) => {
    set({ analyticsGroupByCommunity });
    persist({ ...get(), analyticsGroupByCommunity });
  },
  setShowSemanticEdges: (showSemanticEdges) => {
    set({ showSemanticEdges });
    persist({ ...get(), showSemanticEdges });
  },
  toggleShowSemanticEdges: () => {
    const next = !get().showSemanticEdges;
    set({ showSemanticEdges: next });
    persist({ ...get(), showSemanticEdges: next });
  },
  setFolderColor: (folder, color) => {
    const next = { ...get().folderColors };
    if (color == null) {
      delete next[folder];
    } else if (HEX_RE.test(color)) {
      next[folder] = color.toLowerCase();
    } else {
      return;
    }
    set({ folderColors: next });
    persist({ ...get(), folderColors: next });
  },
  clearFolderColors: () => {
    set({ folderColors: {} });
    persist({ ...get(), folderColors: {} });
  },
  setClusterColor: (clusterName, color) => {
    const next = { ...get().clusterColors };
    if (color == null) {
      delete next[clusterName];
    } else if (HEX_RE.test(color)) {
      next[clusterName] = color.toLowerCase();
    } else {
      return;
    }
    set({ clusterColors: next });
    persist({ ...get(), clusterColors: next });
  },
  clearClusterColors: () => {
    set({ clusterColors: {} });
    persist({ ...get(), clusterColors: {} });
  },
  setSearchQuery: (searchQuery) => { set({ searchQuery }); persist({ ...get(), searchQuery }); },
  setShowOrphans: (showOrphans) => { set({ showOrphans }); persist({ ...get(), showOrphans }); },
  setManualOnly: (manualOnly) => { set({ manualOnly }); persist({ ...get(), manualOnly }); },
  setNodeSizeScale: (nodeSizeScale) => { set({ nodeSizeScale }); persist({ ...get(), nodeSizeScale }); },
  setLinkThicknessScale: (linkThicknessScale) => { set({ linkThicknessScale }); persist({ ...get(), linkThicknessScale }); },
  setLabelZoomThreshold: (labelZoomThreshold) => { set({ labelZoomThreshold }); persist({ ...get(), labelZoomThreshold }); },
  setShowArrows: (showArrows) => { set({ showArrows }); persist({ ...get(), showArrows }); },
  setCenteringStrength: (centeringStrength) => { set({ centeringStrength }); persist({ ...get(), centeringStrength }); },
  setChargeStrength: (chargeStrength) => { set({ chargeStrength }); persist({ ...get(), chargeStrength }); },
  setLinkDistance: (linkDistance) => { set({ linkDistance }); persist({ ...get(), linkDistance }); },
  setLayoutShape: (layoutShape) => { set({ layoutShape }); persist({ ...get(), layoutShape }); },
  setTimelapseSpeedSec: (timelapseSpeedSec) => { set({ timelapseSpeedSec }); persist({ ...get(), timelapseSpeedSec }); },
}));
