import { create } from "zustand";

import { isAtlasPatternId, type AtlasPatternId } from "../lib/atlasPatterns";

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
export type GraphLabelMode = "off" | "key" | "all";
export type GraphConnectionMode = "off" | "featured" | "all";
/** Master performance switch for the graph view. */
export type GraphMode = "full" | "lite" | "off";

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

/** Deterministic folder → colour mapping, shared by the graph view and
 *  the notes-tree sidebar so a folder reads the *same* colour in both.
 *  A user override (set on the canvas) wins; otherwise a stable FNV hash
 *  picks a tone from the active palette. Empty string = root folder. */
export function folderColor(
  folder: string,
  palette: GraphPalette,
  overrides?: Record<string, string>,
): string {
  if (overrides && overrides[folder]) return overrides[folder]!;
  if (!folder) return PALETTE_NEUTRAL[palette];
  let h = 2166136261;
  for (let i = 0; i < folder.length; i++) {
    h ^= folder.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  const colors = PALETTES[palette];
  return colors[h % colors.length]!;
}

interface GraphSettings {
  /** Which view is on screen. See GraphPreset — this replaced the old
   *  mode + patternId split. */
  preset: GraphPreset;
  palette: GraphPalette;
  nodeShape: GraphNodeShape;
  /** When true, every cluster centroid gets a folder label at all
   *  times (the original behaviour). When false, only the cluster of
   *  the focused node is labelled (Phase 4 default). */
  showClusterLabels: boolean;
  /** Master toggle for the Analytics layer (community tints, cluster
   *  legend, tip bar). Default: off. Toggled via the toolbar pill or
   *  Cmd+Shift+A. Persisted so the user's choice survives reloads.
   *  NOTE: this no longer resizes nodes by PageRank. The fixed snapshots
   *  size by degree via snapshotNodeRadius; the old PR boost survived only
   *  in the invisible pointer hit area, which made the click target ~2.7x
   *  the drawn dot. Removed 2026-07 along with analyticsResizeByImportance,
   *  a setting that had no UI to toggle it. */
  analyticsMode: boolean;
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
  /** When false, graphified code nodes (kind="code") and every edge that
   *  touches them are hidden — the graph shows only authored notes.
   *  Default true so a freshly graphified repo is immediately visible. */
  showCode: boolean;
  /** When true, only manually-authored wikilinks render. Overrides
   *  showSemanticEdges; entity edges are also hidden. */
  manualOnly: boolean;
  /** Multiplicative scale on every node's drawn radius. 1.0 default,
   *  user-tunable 0.5..2.0 via the Display section slider. */
  nodeSizeScale: number;
  /** Multiplicative scale on every link's drawn width. */
  linkThicknessScale: number;
  /** Draw arrowheads on directed edges (manual wikilinks). Default
   *  off — undirected look reads cleaner at typical zoom. */
  showArrows: boolean;
  /** Time-lapse playback speed in seconds (full graph reveal time).
   *  Lower = faster. Default 15 s. */
  timelapseSpeedSec: number;
  /** Cluster-background style: "soft" circles (default) or "hull"
   *  convex-hull polygons (venn-diagram look, one colour per category). */
  groupingStyle: GraphGroupingStyle;
  /** Master performance switch. "full" = every effect (default). "lite" =
   *  a derived low-power preset (semantic edges off, flat node paint, no
   *  animations, faster settle) for large brains — the overrides are applied
   *  at read time in NeuralGraph so the user's real preferences are preserved
   *  and restored when they switch back. "off" = the graph view never mounts
   *  (zero cost); the nav button shows a re-enable placeholder instead. */
  graphMode: GraphMode;
  /** Presentation-only visibility. These never invalidate a snapshot layout. */
  labelMode: GraphLabelMode;
  connectionMode: GraphConnectionMode;
}

export type GraphGroupingStyle = "soft" | "hull";

/**
 * Which view the graph is showing — the ONE source of truth for it.
 *
 * Until 2026-07 this was spread across three competing mechanisms that could
 * disagree with each other:
 *   1. `mode` ("2d" | "3d" | "engine") in an ad-hoc "nv.graph.mode" key,
 *      written by NeuralGraph -- and "engine" was deliberately never persisted,
 *      so a reload always dumped you back into a snapshot.
 *   2. `patternId` in AtlasGraph's own private "nv.atlas.pattern" key.
 *   3. Everything else, here.
 *
 * A preset flattens (mode + patternId) into one value: the two fixed snapshots
 * plus the six compositions are all just presets on one bar. `presetRenderer`
 * is the only place that maps a preset back to a renderer.
 */
export type GraphPreset = "2d" | "3d" | AtlasPatternId;

/** Which renderer draws a given preset. The snapshots use force-graph 2D/3D;
 *  every composition is drawn by AtlasGraph (Sigma/WebGL). */
export function presetRenderer(preset: GraphPreset): "2d" | "3d" | "engine" {
  if (preset === "2d") return "2d";
  if (preset === "3d") return "3d";
  return "engine";
}

export function isGraphPreset(value: unknown): value is GraphPreset {
  return value === "2d" || value === "3d" || isAtlasPatternId(value);
}

const STORAGE_KEY = "nv.graph.settings";

/** Pre-2026-07 keys, read once by `migratePreset` then deleted. */
const LEGACY_MODE_KEY = "nv.graph.mode";
const LEGACY_PATTERN_KEY = "nv.atlas.pattern";

/**
 * One-shot migration off the two legacy keys.
 *
 * Only "2d"/"3d" are recoverable: the old code never persisted "engine", so a
 * user sitting in the Engine at reload had already been silently returned to a
 * snapshot. That means the old pattern key cannot tell us they *wanted* the
 * Engine, and honouring it would drop users into a composition they never
 * chose to persist. So the composition choice becomes the preset only when the
 * legacy mode is absent -- i.e. never for existing users -- and we clear both
 * keys either way so this runs exactly once.
 */
function migratePreset(): GraphPreset {
  try {
    const legacyMode = localStorage.getItem(LEGACY_MODE_KEY);
    localStorage.removeItem(LEGACY_MODE_KEY);
    localStorage.removeItem(LEGACY_PATTERN_KEY);
    if (legacyMode === "3d") return "3d";
  } catch { /* private mode */ }
  return "2d";
}

const DEFAULTS: GraphSettings = {
  preset: "2d",
  palette: "warm",
  nodeShape: "circle",
  showClusterLabels: false,
  analyticsMode: false,
  analyticsGroupByCommunity: true,
  showSemanticEdges: false,
  folderColors: {},
  clusterColors: {},
  searchQuery: "",
  showOrphans: true,
  showCode: true,
  manualOnly: false,
  nodeSizeScale: 1.0,
  linkThicknessScale: 1.0,
  showArrows: false,
  timelapseSpeedSec: 15,
  groupingStyle: "soft",
  graphMode: "full",
  labelMode: "off",
  connectionMode: "featured",
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
      const labelMode: GraphLabelMode =
        parsed.labelMode === "key" || parsed.labelMode === "all" ? parsed.labelMode : "off";
      const connectionMode: GraphConnectionMode =
        parsed.connectionMode === "off" || parsed.connectionMode === "all"
          ? parsed.connectionMode
          : "featured";
      return {
        // A stored preset wins. Anything else -- first run after the upgrade,
        // or a corrupt/unknown value -- falls back to the legacy keys.
        preset: isGraphPreset(parsed.preset) ? parsed.preset : migratePreset(),
        palette,
        nodeShape,
        showClusterLabels: bool("showClusterLabels", false),
        analyticsMode: bool("analyticsMode", false),
        analyticsGroupByCommunity: bool("analyticsGroupByCommunity", true),
        showSemanticEdges: bool("showSemanticEdges", false),
        folderColors: sanitizeColorMap(parsed.folderColors),
        clusterColors: sanitizeColorMap(parsed.clusterColors),
        searchQuery: typeof parsed.searchQuery === "string" ? parsed.searchQuery : "",
        showOrphans: bool("showOrphans", true),
        showCode: bool("showCode", true),
        manualOnly: bool("manualOnly", false),
        nodeSizeScale: num("nodeSizeScale", 1.0, 0.3, 3.0),
        linkThicknessScale: num("linkThicknessScale", 1.0, 0.3, 3.0),
        showArrows: bool("showArrows", false),
        timelapseSpeedSec: num("timelapseSpeedSec", 15, 3, 90),
        groupingStyle: parsed.groupingStyle === "hull" ? "hull" : "soft",
        graphMode:
          parsed.graphMode === "lite" || parsed.graphMode === "off"
            ? parsed.graphMode
            : "full",
        labelMode,
        connectionMode,
      };
    }
  } catch { /* corrupt / private mode */ }
  // No settings blob yet: still honour a legacy mode key, so upgrading users
  // who had never opened Settings don't get silently reset to 2D.
  return { ...DEFAULTS, preset: migratePreset() };
}

interface GraphSettingsStore extends GraphSettings {
  /** Switch the view. One call replaces the old setModePersist +
   *  openGraphEngine + closeGraphEngine + AtlasGraph's private setter. */
  setPreset: (p: GraphPreset) => void;
  setPalette: (p: GraphPalette) => void;
  setNodeShape: (s: GraphNodeShape) => void;
  setShowClusterLabels: (v: boolean) => void;
  setAnalyticsMode: (v: boolean) => void;
  toggleAnalyticsMode: () => void;
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
  setShowCode: (v: boolean) => void;
  setManualOnly: (v: boolean) => void;
  setNodeSizeScale: (v: number) => void;
  setLinkThicknessScale: (v: number) => void;
  setShowArrows: (v: boolean) => void;
  setTimelapseSpeedSec: (v: number) => void;
  setGroupingStyle: (v: GraphGroupingStyle) => void;
  setGraphMode: (m: GraphMode) => void;
  setLabelMode: (m: GraphLabelMode) => void;
  setConnectionMode: (m: GraphConnectionMode) => void;
}

function persist(s: GraphSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch { /* ignore */ }
}

export const useGraphSettingsStore = create<GraphSettingsStore>((set, get) => ({
  ...load(),
  setPreset: (preset) => {
    set({ preset });
    persist({ ...get(), preset });
  },
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
  setShowCode: (showCode) => { set({ showCode }); persist({ ...get(), showCode }); },
  setManualOnly: (manualOnly) => { set({ manualOnly }); persist({ ...get(), manualOnly }); },
  setNodeSizeScale: (nodeSizeScale) => { set({ nodeSizeScale }); persist({ ...get(), nodeSizeScale }); },
  setLinkThicknessScale: (linkThicknessScale) => { set({ linkThicknessScale }); persist({ ...get(), linkThicknessScale }); },
  setShowArrows: (showArrows) => { set({ showArrows }); persist({ ...get(), showArrows }); },
  setTimelapseSpeedSec: (timelapseSpeedSec) => { set({ timelapseSpeedSec }); persist({ ...get(), timelapseSpeedSec }); },
  setGroupingStyle: (groupingStyle) => { set({ groupingStyle }); persist({ ...get(), groupingStyle }); },
  setGraphMode: (graphMode) => { set({ graphMode }); persist({ ...get(), graphMode }); },
  setLabelMode: (labelMode) => { set({ labelMode }); persist({ ...get(), labelMode }); },
  setConnectionMode: (connectionMode) => { set({ connectionMode }); persist({ ...get(), connectionMode }); },
}));
