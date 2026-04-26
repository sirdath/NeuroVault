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
}

const STORAGE_KEY = "nv.graph.settings";

const DEFAULTS: GraphSettings = {
  palette: "warm",
  nodeShape: "circle",
  showClusterLabels: false,
};

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
      const showClusterLabels =
        typeof parsed.showClusterLabels === "boolean"
          ? parsed.showClusterLabels
          : false;
      return { palette, nodeShape, showClusterLabels };
    }
  } catch { /* corrupt / private mode */ }
  return DEFAULTS;
}

interface GraphSettingsStore extends GraphSettings {
  setPalette: (p: GraphPalette) => void;
  setNodeShape: (s: GraphNodeShape) => void;
  setShowClusterLabels: (v: boolean) => void;
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
}));
