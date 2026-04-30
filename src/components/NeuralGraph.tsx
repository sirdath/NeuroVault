import { useEffect, useMemo, useRef, useState, useCallback, Suspense, lazy } from "react";
import type { SimulationNodeDatum } from "d3-force";
import { useGraphStore } from "../stores/graphStore";
import type { SimNode } from "../stores/graphStore";
import type { GraphEdge } from "../lib/api";
import { useNoteStore } from "../stores/noteStore";
import { useBrainStore } from "../stores/brainStore";
import {
  PALETTES,
  PALETTE_NEUTRAL,
  useGraphSettingsStore,
  type GraphPalette,
  type GraphNodeShape,
} from "../stores/graphSettingsStore";
import { edgeConfidence, pageRank, louvain, graphCacheKey } from "../lib/graphMetrics";
import { AnalyticsTipBar } from "./AnalyticsTipBar";
import { nvSetPagerank, nvSetClusters, nvGetClusterNames, readNote, type NvClusterSummary } from "../lib/tauri";
import { extractPreview } from "../lib/utils";

// Minimal shape of the ForceGraph3D ref handle we actually touch. The real
// type (ForceGraphMethods) exposes 20+ methods; we only need the composer
// accessor, so we cast through a narrow slice to keep bloom wiring readable.
type Composer = { addPass: (pass: unknown) => void; passes: unknown[] };
type ForceGraph3DComposerAccess = { postProcessingComposer(): Composer };

// react-force-graph ships heavy ThreeJS deps in its 3D variant. Lazy-load so
// the 2D mode (which is the default) doesn't pull in the whole 3D bundle until
// the user actually toggles into 3D view. Cuts initial bundle size ~600 KB.
const ForceGraph2D = lazy(() =>
  import("react-force-graph-2d").then((m) => ({ default: m.default }))
);
const ForceGraph3D = lazy(() =>
  import("react-force-graph-3d").then((m) => ({ default: m.default }))
);

// STATE_COLORS + STATE_GLOW were removed in the graph-aesthetic
// redesign (2026-04-23). Node state (fresh/active/dormant) is now
// encoded as a single alpha channel on the fill, not a separate
// ring + halo — the previous layered look was too busy on the
// small node sizes and competed with folder color as the primary
// identity signal.

/** Edge color by link_type — typed-wikilink vocabulary mapped to a palette
 *  so the graph communicates relationship semantics at a glance.
 *  Grouped by intent: structural (blue/purple), dependency (green/teal),
 *  conflict (red/orange), neutral fallback. */
function edgeColor(linkType: string, alpha: number): string {
  switch (linkType) {
    case "manual":      return `rgba(139, 124, 248, ${alpha})`;
    case "entity":      return `rgba(0, 201, 177, ${alpha})`;
    case "defines":     return `rgba(139, 124, 248, ${alpha})`;
    case "part_of":     return `rgba(100, 140, 240, ${alpha})`;
    case "extends":     return `rgba(120, 160, 255, ${alpha})`;
    case "depends_on":  return `rgba(0, 201, 177, ${alpha})`;
    case "uses":        return `rgba(80, 220, 160, ${alpha})`;
    case "caused_by":   return `rgba(60, 200, 140, ${alpha})`;
    case "works_at":    return `rgba(40, 190, 180, ${alpha})`;
    case "contradicts": return `rgba(255, 100, 100, ${alpha})`;
    case "supersedes":  return `rgba(255, 165, 80, ${alpha})`;
    case "mentions":    return `rgba(150, 150, 170, ${alpha})`;
    default:            return `rgba(122, 119, 154, ${alpha})`;
  }
}

/** Node radius curve — tasteful, not domineering. Hand-tuned against
 *  Obsidian + Cosmograph references.
 *
 *  Sized by graph DEGREE (number of incident edges), with a small
 *  access-count boost. Why degree first:
 *    - "Importance" in a knowledge graph correlates with how often a
 *      note is referenced, not how often the user clicked it. A hub
 *      that everyone wikilinks to should look big even if the user
 *      hasn't reread it lately.
 *    - access_count alone produced ~3-4 outliers (the user's most-
 *      opened recent note) ballooning while the actual graph hubs
 *      stayed tiny — visually misleading.
 *
 *  Curve: 2.5 px floor (isolated nodes) up to ~9 px cap (a hub with
 *  ~50 incident edges). Square root keeps the long tail compressed
 *  so 200-edge superhubs don't dominate the canvas. */
function nodeRadius(node: { degree?: number; access_count?: number }): number {
  const degree = Math.max(0, node.degree ?? 0);
  const access = Math.max(0, node.access_count ?? 0);
  const base = 2.5 + Math.sqrt(degree) * 0.8;
  // Access count is a secondary signal — clamp the boost so a
  // hot-but-isolated note grows modestly, not as much as a hub.
  const accessBoost = Math.min(1.5, Math.sqrt(access) * 0.2);
  return Math.min(9, base + accessBoost);
}

/** Radius the user actually sees, after the optional Analytics-mode
 *  PageRank boost. Centralised so the painter, the pointer hit area,
 *  and the d3-force collision force agree on the same number — when
 *  they don't (e.g. collide using `nodeRadius` while paint uses the
 *  PR-boosted size), big hub nodes overlap. PR mean is 1.0; sqrt-
 *  scaled boost compresses the long tail (a PR=10 hub stays ~9px,
 *  capped at 11px). */
function effectiveNodeRadius(
  node: { id?: string; degree?: number; access_count?: number },
  prMap: Map<string, number> | null,
  applyPRBoost: boolean,
): number {
  const r = nodeRadius(node);
  if (!applyPRBoost || !prMap || !node.id) return r;
  const pr = prMap.get(node.id) ?? 1;
  const prBoost = Math.min(2.5, Math.sqrt(Math.max(0, pr - 1)) * 1.4);
  return Math.min(11, r + prBoost);
}

/** Deterministic palette — a folder always maps to the same color
 *  within a session and across reloads, regardless of which palette
 *  the user picks. The hash → index step is stable; only the array
 *  it indexes into changes when the user switches palettes (warm /
 *  cool / mono / vivid via Settings).
 *
 *  Philosophy: when the graph is "the hero view people screenshot
 *  to show off their brain", colour harmony matters more than
 *  colour variety. Eight cohesive tones per palette group folders
 *  without making the canvas feel like a toy chest. */
function folderColor(
  folder: string,
  palette: GraphPalette,
  overrides?: Record<string, string>,
): string {
  // User-set per-folder colour wins over the palette hash. Empty
  // string is the root folder; we look it up the same way.
  if (overrides && overrides[folder]) return overrides[folder]!;
  if (!folder) return PALETTE_NEUTRAL[palette];
  // Simple FNV-ish hash so the mapping is stable across sessions without
  // pulling in a real hashing lib.
  let h = 2166136261;
  for (let i = 0; i < folder.length; i++) {
    h ^= folder.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  const colors = PALETTES[palette];
  return colors[h % colors.length]!;
}

/** Trace a node-shape path on the given canvas context. Caller is
 *  responsible for `fill()` / `stroke()` afterwards. The shape is one
 *  of the user-pickable presets (circle / square / hex); circle is the
 *  default. Square draws as a rounded rect inscribed in the same
 *  bounding circle so visually-equivalent footprint is preserved.
 *  Hex draws a flat-top regular hexagon with the same circumradius. */
function drawNodeShape(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  shape: GraphNodeShape,
): void {
  ctx.beginPath();
  if (shape === "square") {
    // Rounded rect — corner radius proportional to the node so small
    // nodes still read as squarish, large nodes feel softer.
    const side = r * 1.7;
    const half = side / 2;
    const radius = Math.min(r * 0.25, half);
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(cx - half, cy - half, side, side, radius);
    } else {
      // Fallback for ancient browsers that miss roundRect.
      ctx.rect(cx - half, cy - half, side, side);
    }
  } else if (shape === "hex") {
    // Flat-top hexagon. 6 vertices at 0, 60, 120, ... degrees.
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i;
      const x = cx + r * Math.cos(angle);
      const y = cy + r * Math.sin(angle);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  } else {
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
  }
}

/** Cache derived colours (lighten / darken / desaturate) — string
 *  parsing + math is the hot path of `paintNode2D` at 60fps × 250+
 *  nodes. Keyed by `${op}${amount.toFixed(2)}_${hex}` so the same
 *  request returns the same string in O(1). Cleared implicitly on
 *  page reload; no eviction needed at our scale (≤ ~50 distinct
 *  hexes × 3 ops = ~150 entries max).
 */
const COLOR_DERIV_CACHE = new Map<string, string>();

function toHexByte(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
}

/** Blend `hex` toward pure white (`target=255`) or black (`target=0`)
 *  by fraction `t` (0..1). 0 returns the input, 1 returns the target.
 *  Cheap RGB-space blend — gamma is wrong, but for graph node shading
 *  the perceptual difference is invisible and the cost is one-eighth
 *  of a proper sRGB↔linear conversion. */
function blendHex(hex: string, target: number, t: number): string {
  if (!(hex.startsWith("#") && hex.length === 7)) return hex;
  const k = `B${target}_${t.toFixed(2)}_${hex}`;
  const cached = COLOR_DERIV_CACHE.get(k);
  if (cached) return cached;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const out = `#${toHexByte(r + (target - r) * t)}${toHexByte(g + (target - g) * t)}${toHexByte(b + (target - b) * t)}`;
  COLOR_DERIV_CACHE.set(k, out);
  return out;
}

const lightenHex = (hex: string, t: number) => blendHex(hex, 255, t);
const darkenHex  = (hex: string, t: number) => blendHex(hex, 0, t);

/** Reduce the saturation of `hex` toward grayscale by fraction
 *  `amount` (0..1). 1 = full grayscale. Used for `dormant` nodes —
 *  combined with a small alpha drop, dormant reads as "this exists
 *  but isn't currently part of the live conversation" without
 *  vanishing. */
function desaturateHex(hex: string, amount: number): string {
  if (!(hex.startsWith("#") && hex.length === 7)) return hex;
  const k = `D${amount.toFixed(2)}_${hex}`;
  const cached = COLOR_DERIV_CACHE.get(k);
  if (cached) return cached;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // Rec.601 luma — close enough to perceptual grey for our purposes.
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  const out = `#${toHexByte(r + (lum - r) * amount)}${toHexByte(g + (lum - g) * amount)}${toHexByte(b + (lum - b) * amount)}`;
  COLOR_DERIV_CACHE.set(k, out);
  return out;
}

/** Turn a CSS/hex color into an rgba() with the given alpha. Handles
 *  both `#rrggbb` + `rgba(...)` input shapes — folder colors are hex,
 *  node glow colors are rgba already. Pure function; hoisted outside
 *  the component so useCallback deps don't churn every render. */
function withAlpha(c: string, alpha: number): string {
  if (c.startsWith("#") && c.length === 7) {
    const r = parseInt(c.slice(1, 3), 16);
    const g = parseInt(c.slice(3, 5), 16);
    const b = parseInt(c.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  if (c.startsWith("rgba(")) {
    // Replace the last comma-separated value (alpha).
    return c.replace(/,\s*[\d.]+\)$/, `, ${alpha})`);
  }
  return c;
}

/** Custom d3-force that pulls each node toward its folder's centroid.
 *  Makes folders visibly cluster on the graph without destroying the
 *  natural link-based layout — the link + charge forces still run, this
 *  is just an extra nudge. Strength is gentle (0.08) so tightly-linked
 *  cross-folder notes still pull together when the edges are strong.
 *
 *  Runs per simulation tick; centroids are recomputed every call so
 *  dragging one cluster away moves the pull point with it.
 */
function createClusterForce(strength: number = 0.08) {
  type F = {
    (alpha: number): void;
    initialize?: (nodes: unknown[]) => void;
  };
  let nodes: Array<{ folder?: string; x?: number; y?: number; vx?: number; vy?: number }> = [];
  const force: F = (alpha: number) => {
    if (!nodes.length) return;
    // Accumulate centroids by folder in one pass.
    const sums = new Map<string, { x: number; y: number; n: number }>();
    for (const n of nodes) {
      if (n.x == null || n.y == null) continue;
      const key = n.folder ?? "";
      const s = sums.get(key);
      if (s) { s.x += n.x; s.y += n.y; s.n += 1; }
      else sums.set(key, { x: n.x, y: n.y, n: 1 });
    }
    const centroids = new Map<string, { x: number; y: number }>();
    for (const [k, s] of sums) centroids.set(k, { x: s.x / s.n, y: s.y / s.n });

    const k = strength * alpha;
    for (const n of nodes) {
      if (n.x == null || n.y == null) continue;
      const c = centroids.get(n.folder ?? "");
      if (!c) continue;
      n.vx = (n.vx ?? 0) + (c.x - n.x) * k;
      n.vy = (n.vy ?? 0) + (c.y - n.y) * k;
    }
  };
  force.initialize = (ns: unknown[]) => { nodes = ns as typeof nodes; };
  return force;
}

type Mode = "2d" | "3d";

interface HoverCard {
  node: SimNode;
  screenX: number;
  screenY: number;
  preview: string;
}

interface NeuralGraphProps {
  /** Called after the user clicks "View note" so the parent can switch
   * back to the Editor view. */
  onOpenNote?: () => void;
}

export function NeuralGraph({ onOpenNote }: NeuralGraphProps = {}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [mode, setMode] = useState<Mode>(() => {
    try {
      const v = localStorage.getItem("nv.graph.mode");
      return v === "3d" ? "3d" : "2d";
    } catch { return "2d"; }
  });
  // Ref to the 3D force-graph instance so we can attach an UnrealBloomPass
  // once the Three.js renderer/composer is available. The ref is passed
  // to ForceGraph3D as-is; we narrow at the use site.
  const fg3dRef = useRef<unknown>(undefined);
  const fg2dRef = useRef<unknown>(undefined);
  const bloomAttachedRef = useRef(false);
  const clusterAttachedRef = useRef(false);
  // Live snapshot the d3-force collide+link callbacks read on every
  // tick. Keeping it in a ref avoids re-attaching the forces (which
  // would restart the simulation) every time analytics state flips.
  // Updated by the effect below whenever PR data or the toggle moves.
  const analyticsRadiusRef = useRef<{
    applyPRBoost: boolean;
    prMap: Map<string, number> | null;
  }>({ applyPRBoost: false, prMap: null });

  // On toggle into 3D, lazy-import UnrealBloomPass and inject it into the
  // composer. Kept separate from the 2D path so the bloom module (and its
  // Three.js addons) only ship in the already-lazy 3D chunk.
  useEffect(() => {
    if (mode !== "3d") return;
    let cancelled = false;
    const tryAttach = async () => {
      const fg = fg3dRef.current as ForceGraph3DComposerAccess | undefined;
      if (!fg || bloomAttachedRef.current) return;
      const composer = fg.postProcessingComposer?.();
      if (!composer) return;
      const [{ UnrealBloomPass }, { Vector2 }] = await Promise.all([
        import("three/examples/jsm/postprocessing/UnrealBloomPass.js"),
        import("three"),
      ]);
      if (cancelled) return;
      // Tuned so "fresh" (amber) and "connected" (teal) nodes bleed light
      // without drowning the rest of the scene. resolution scales with
      // the container; strength/radius/threshold are the classic UE4
      // bloom knobs (threshold 0.85 ≈ only bright colors bloom).
      const pass = new UnrealBloomPass(
        new Vector2(size.w, size.h),
        0.9, // strength
        0.6, // radius
        0.1, // threshold (low so most bright colors contribute)
      );
      composer.addPass(pass);
      bloomAttachedRef.current = true;
    };
    // The ref isn't populated synchronously when Suspense resolves, so
    // retry a couple of times over the next few frames.
    const id = window.setInterval(tryAttach, 200);
    // Also try immediately in case it's ready already.
    tryAttach();
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [mode, size.w, size.h]);

  // Clearing the flag on mode-switch so bloom re-attaches if the user
  // toggles 3D → 2D → 3D (the composer is a fresh instance each time).
  useEffect(() => {
    if (mode === "2d") bloomAttachedRef.current = false;
    // Same story for the cluster force — re-mounted ForceGraph instance
    // means a fresh d3-force graph with no custom forces attached.
    clusterAttachedRef.current = false;
  }, [mode]);

  // Install the folder-cluster force + tighter charge/collide tuning
  // on the 2D graph's d3-force sim. Default force-graph parameters
  // are tuned for ~100 nodes; at 250+ nodes with 30k+ edges the
  // default charge (-30) and no-collide behaviour produce a hairball.
  //
  // Cluster strength 0.03 (was 0.08): gentler pull so folders are
  // still visible as regions but don't clump into tight balls that
  // hide intra-folder structure.
  //
  // Charge -120: ~4× default repulsion; spreads the graph into a
  // more readable layout at our scale.
  //
  // Collide radius: matches the drawn `nodeRadius` + a 4-px buffer
  // so nodes never overlap visually. `replace` rendering mode made
  // the library's internal collision calc use `nodeVal` (which maps
  // to a smaller radius than we actually draw) — this fixes the
  // "nodes intertwine" symptom.
  useEffect(() => {
    if (mode !== "2d") return;
    if (clusterAttachedRef.current) return;
    let cancelled = false;

    type D3ForceAPI = {
      d3Force: (name: string, force?: unknown) => D3ForceAPI;
      d3ReheatSimulation?: () => void;
    };

    const tryAttach = async () => {
      if (cancelled || clusterAttachedRef.current) return;
      const fg = fg2dRef.current as D3ForceAPI | undefined;
      if (!fg || typeof fg.d3Force !== "function") return;
      try {
        // Lazy-load d3-force. ~30 KB gzipped, already a transitive
        // dep of react-force-graph-2d — no bundle cost.
        const d3 = await import("d3-force");

        // Force tuning — rebalanced for the smaller 2.5-7 px node
        // size. Default force-graph is tuned for bigger nodes at
        // ~100 count; our 250+ nodes at smaller draw size need
        // less aggressive repulsion + tighter links to look tidy.
        //
        //   charge -90, distanceMax 280  → enough to separate
        //     clusters without flinging outliers to the edge of
        //     the canvas.
        //   collide r + 1 px  → matched to the (smaller) drawn
        //     radius; tight enough that the graph packs densely
        //     but no overlap.
        //   cluster 0.025 → folder pull is a visual hint, not a
        //     vacuum.
        //   link distance 26 → nodes connected by a strong edge
        //     sit close, forming a readable "group". Was 50,
        //     felt sparse against the smaller nodes.
        fg.d3Force(
          "charge",
          d3.forceManyBody().strength(-90).distanceMax(280),
        );
        const collide = d3
          .forceCollide<SimulationNodeDatum>()
          .radius((node) => {
            const n = node as SimulationNodeDatum & {
              access_count?: number; degree?: number; id?: string;
            };
            const { applyPRBoost, prMap } = analyticsRadiusRef.current;
            // +2 buffer (was +1) so even at the largest 11-px hub the
            // gap between centres is ≥ 4 px — prevents the "two index
            // hubs overlap" symptom when Analytics resize is on.
            return effectiveNodeRadius(n, prMap, applyPRBoost) + 2;
          })
          .strength(0.95)
          .iterations(2);
        fg.d3Force("collide", collide);
        fg.d3Force("cluster", createClusterForce(0.025));
        const linkForce = (fg as unknown as {
          d3Force: (n: string) => {
            distance?: (d: number | ((l: unknown) => number)) => unknown;
          } | undefined;
        }).d3Force("link");
        if (linkForce && typeof linkForce.distance === "function") {
          // Per-link distance instead of a fixed 26 — when Analytics
          // resize is on, hubs need more room. Adds up to 8 px when
          // either endpoint is a PR-boosted hub.
          linkForce.distance((rawLink: unknown) => {
            const { applyPRBoost, prMap } = analyticsRadiusRef.current;
            if (!applyPRBoost || !prMap) return 26;
            const l = rawLink as {
              source: { id?: string } | string;
              target: { id?: string } | string;
            };
            const sId = typeof l.source === "string" ? l.source : l.source.id;
            const tId = typeof l.target === "string" ? l.target : l.target.id;
            const sPr = sId ? (prMap.get(sId) ?? 1) : 1;
            const tPr = tId ? (prMap.get(tId) ?? 1) : 1;
            const maxBoost = Math.sqrt(Math.max(0, Math.max(sPr, tPr) - 1)) * 1.4;
            return 26 + Math.min(8, maxBoost * 3);
          });
        }
        fg.d3ReheatSimulation?.();
        clusterAttachedRef.current = true;
      } catch {
        /* ref not ready yet — retry on next interval tick */
      }
    };

    const id = window.setInterval(tryAttach, 200);
    tryAttach();
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [mode]);

  const { nodes, edges: rawEdges, loadGraph, setSelected } = useGraphStore();
  const focusRequest = useGraphStore((s) => s.focusRequest);
  const selectNote = useNoteStore((s) => s.selectNote);
  const allNotes = useNoteStore((s) => s.notes);

  // User-pickable graph appearance: palette, node shape, cluster-label
  // toggle. Selecting individually so a change to one doesn't rerender
  // consumers of the others (Zustand subscribes per-selector).
  const palette = useGraphSettingsStore((s) => s.palette);
  const nodeShape = useGraphSettingsStore((s) => s.nodeShape);
  const showClusterLabels = useGraphSettingsStore((s) => s.showClusterLabels);
  // User colour overrides — folder name → hex, cluster name → hex.
  // Selecting individually so a change to one doesn't rerender the
  // other consumer.
  const folderColors = useGraphSettingsStore((s) => s.folderColors);
  const clusterColors = useGraphSettingsStore((s) => s.clusterColors);
  // Analytics-mode master toggle + per-layer toggles. The master
  // gates whether anything analytics-y renders at all; the per-layer
  // booleans decide which specific overlays light up.
  const analyticsMode = useGraphSettingsStore((s) => s.analyticsMode);
  const toggleAnalyticsMode = useGraphSettingsStore((s) => s.toggleAnalyticsMode);
  const analyticsResizeByImportance = useGraphSettingsStore((s) => s.analyticsResizeByImportance);
  const analyticsGroupByCommunity = useGraphSettingsStore((s) => s.analyticsGroupByCommunity);
  const showSemanticEdges = useGraphSettingsStore((s) => s.showSemanticEdges);
  const toggleShowSemanticEdges = useGraphSettingsStore((s) => s.toggleShowSemanticEdges);

  // Filter the raw edges from the store BEFORE anything else consumes
  // them. When `showSemanticEdges` is false (default), drop every edge
  // whose link_type is "semantic" — these are auto-computed cosine
  // similarities, not anything the user authored. Manual wikilinks
  // and entity co-mentions stay. The downstream graphData / adjacency /
  // bidi memos read this filtered list, so the visual graph and the
  // hover-focus neighbourhood match what the user actually wrote.
  const edges = useMemo(
    () => (showSemanticEdges ? rawEdges : rawEdges.filter((e) => e.link_type !== "semantic")),
    [rawEdges, showSemanticEdges],
  );
  const semanticEdgeCount = useMemo(
    () => rawEdges.filter((e) => e.link_type === "semantic").length,
    [rawEdges],
  );

  // Cmd+Shift+A toggles analytics. Cmd+A is select-all in editor
  // contexts, hence the Shift disambiguator. Skipped if focus is in
  // an input so the user can still type "A" inside the search box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
      if (e.key !== "A" && e.key !== "a") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      e.preventDefault();
      toggleAnalyticsMode();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleAnalyticsMode]);

  const activeBrainId = useBrainStore((s) => s.activeBrainId);
  const notesList = useNoteStore((s) => s.notes);
  useEffect(() => { loadGraph(); }, [loadGraph, activeBrainId, notesList]);

  // Pulse-ring state. `focusPulse` carries the node id + start time
  // of the most recent focus request. The per-frame renderer reads
  // elapsed time and draws a fading ring around the node; cleared
  // ~1.5s after the request. Separate from `focusedNodeId` (which is
  // the hover-dim state) because the two are independent signals.
  const [focusPulse, setFocusPulse] = useState<{ nodeId: string; start: number } | null>(null);

  // Wake the 2D graph's camera to the focused node + kick off the
  // pulse ring whenever the store fires a new `requestFocus`. Runs
  // only when the request timestamp changes; repeated focus requests
  // for the same node still re-tween because `at` bumps each call.
  useEffect(() => {
    if (!focusRequest) return;
    if (mode !== "2d") return; // 3D camera tween would need a different API
    const target = (nodes as Array<SimNode & { x?: number; y?: number }>)
      .find((n) => n.id === focusRequest.nodeId);
    if (!target || target.x == null || target.y == null) return;

    type CamApi = {
      centerAt?: (x: number, y: number, ms?: number) => void;
      zoom?: (scale: number, ms?: number) => void;
    };
    const fg = fg2dRef.current as CamApi | undefined;
    // centerAt tweens the camera over `ms`; zoom slides the zoom
    // factor over the same duration so both land together.
    fg?.centerAt?.(target.x, target.y, 450);
    fg?.zoom?.(2.2, 450);

    setFocusPulse({ nodeId: focusRequest.nodeId, start: Date.now() });
    // Clear the pulse after its animation window. Using a timeout
    // instead of a prop-driven render loop keeps idle frames at zero.
    const id = window.setTimeout(() => setFocusPulse(null), 1500);
    return () => window.clearTimeout(id);
  }, [focusRequest, mode, nodes]);

  // During the pulse window, kick a per-frame repaint so the ring
  // actually animates. force-graph's internal render loop goes idle
  // after cooldown; `tickFrame()` on the ref forces a single paint.
  // Only runs while a pulse is active; idle frames stay free.
  useEffect(() => {
    if (!focusPulse) return;
    let raf = 0;
    const tick = () => {
      const fg = fg2dRef.current as { tickFrame?: () => void } | undefined;
      fg?.tickFrame?.();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [focusPulse]);

  // Container resize → re-measure so ForceGraph fills the pane.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(100, r.width), h: Math.max(100, r.height) });
    };
    measure();
    const obs = new ResizeObserver(measure);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // react-force-graph wants {nodes, links} with source/target keys. Our
  // store uses edges with from/to. Remap once per change.
  //
  // Also precompute two side-indexes the render path needs:
  //   - `bidiEdges`: set of "a|b" (sorted) pairs where BOTH directions
  //     exist. We curve these apart visually so A→B and B→A don't
  //     stack on top of each other. Half the edges in a semantic brain
  //     are bidirectional so this matters a lot.
  //   - `adjacency`: node_id → set of neighbour ids. Used by the
  //     hover-focus mode to dim everything outside the 1-hop
  //     neighbourhood of the hovered node.
  const graphData = useMemo(() => {
    const directedSeen = new Set<string>();
    const bidi = new Set<string>();
    for (const e of edges) {
      const key = `${e.from}|${e.to}`;
      const rev = `${e.to}|${e.from}`;
      if (directedSeen.has(rev)) {
        // Canonicalise on sorted pair so both edges get the same lookup key.
        const [a, b] = e.from < e.to ? [e.from, e.to] : [e.to, e.from];
        bidi.add(`${a}|${b}`);
      }
      directedSeen.add(key);
    }

    const adjacency = new Map<string, Set<string>>();
    const addEdge = (from: string, to: string) => {
      let s = adjacency.get(from);
      if (!s) { s = new Set(); adjacency.set(from, s); }
      s.add(to);
    };
    for (const e of edges) { addEdge(e.from, e.to); addEdge(e.to, e.from); }

    // Pin isolated nodes (degree 0) onto concentric rings AROUND the
    // connected brain. The connected graph clusters near (0,0) by
    // d3-force defaults; orphans form an outer halo at radii 280+.
    // Reads as: "your brain is the centre, these notes haven't been
    // integrated yet but they're not lost."
    //
    // Packing: walk outward, each ring sized to keep neighbour
    // spacing ≈ 22 px. 250 orphans → 3 rings (~80/88/97 capacity at
    // r=280/310/340). Sort order is by node id so the rings are the
    // same on every reload.
    const isolatedIds: string[] = [];
    for (const n of nodes) {
      if ((adjacency.get(n.id)?.size ?? 0) === 0) isolatedIds.push(n.id);
    }
    isolatedIds.sort();

    const SPACING = 22;
    const FIRST_RING_R = 280;
    const RING_GAP = 30;
    const orphanPos = new Map<string, { fx: number; fy: number }>();
    let placed = 0;
    let ringIdx = 0;
    while (placed < isolatedIds.length) {
      const r = FIRST_RING_R + ringIdx * RING_GAP;
      const capacity = Math.max(1, Math.floor((2 * Math.PI * r) / SPACING));
      const taking = Math.min(capacity, isolatedIds.length - placed);
      // Stagger every other ring by half-step so adjacent rings
      // don't have nodes pointing at the same angle (Moiré-like
      // aliasing when two close rings are perfectly aligned).
      const angleOffset = ringIdx % 2 === 0 ? 0 : Math.PI / taking;
      for (let i = 0; i < taking; i++) {
        const angle = (i / taking) * 2 * Math.PI + angleOffset;
        const id = isolatedIds[placed + i];
        if (!id) continue;
        orphanPos.set(id, {
          fx: r * Math.cos(angle),
          fy: r * Math.sin(angle),
        });
      }
      placed += taking;
      ringIdx += 1;
    }

    return {
      // Attach `degree` to each node so nodeRadius() can read it directly
      // without a Map lookup. Degree is the number of distinct neighbours
      // (undirected); matches what the user sees as "lines coming out of
      // this node" in the graph view. Orphans also get fx/fy from the
      // grid layout above so they snap to the shelf.
      nodes: nodes.map((n) => {
        const degree = adjacency.get(n.id)?.size ?? 0;
        const pos = orphanPos.get(n.id);
        return pos ? { ...n, degree, fx: pos.fx, fy: pos.fy } : { ...n, degree };
      }),
      links: edges.map((e: GraphEdge) => ({
        source: e.from,
        target: e.to,
        similarity: e.similarity,
        link_type: e.link_type,
      })),
      bidi,
      adjacency,
    };
  }, [nodes, edges]);

  // Cache key for analytics computations — same brain state = same key.
  // Used by the analyticsData memo below so toggling analytics off and
  // back on doesn't recompute when nothing has changed.
  const analyticsKey = useMemo(
    () => graphCacheKey(nodes, edges),
    [nodes, edges]
  );

  // PageRank + Louvain are only computed when the user actually flips
  // Analytics on. Off path = zero cost, identical render to v0.1.0.
  // useMemo cache invalidates on cacheKey change, so adding/removing
  // notes recomputes; toggling analytics on/off does not.
  const analyticsData = useMemo<{
    pr: Map<string, number>;
    com: Map<string, number>;
    communitySizes: Map<number, number>;
  } | null>(() => {
    if (!analyticsMode) return null;
    if (nodes.length === 0) {
      return { pr: new Map(), com: new Map(), communitySizes: new Map() };
    }
    const pr = pageRank(nodes, edges);
    const com = louvain(nodes, edges);
    const communitySizes = new Map<number, number>();
    for (const c of com.values()) {
      communitySizes.set(c, (communitySizes.get(c) ?? 0) + 1);
    }
    return { pr, com, communitySizes };
    // analyticsKey is part of deps via the cache-key sentinel; including
    // it explicitly is what makes the memo refresh on graph change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analyticsMode, analyticsKey]);

  // Keep the d3-force radius/distance ref in sync with the live
  // analytics state. Re-heating the simulation when this flips lets
  // the existing collide+link forces relax with the new sizes — no
  // need to detach/re-attach forces (which would feel jumpy).
  useEffect(() => {
    analyticsRadiusRef.current = {
      applyPRBoost: analyticsMode && analyticsResizeByImportance,
      prMap: analyticsData?.pr ?? null,
    };
    const fg = fg2dRef.current as { d3ReheatSimulation?: () => void } | undefined;
    fg?.d3ReheatSimulation?.();
  }, [analyticsMode, analyticsResizeByImportance, analyticsData]);

  // (Hover-driven tip bar copy lives further down, after focusedNodeId
  //  is declared.)

  // Track hover node and its screen position (set from onNodeHover).
  const [hoverCard, setHoverCard] = useState<HoverCard | null>(null);
  const previewCacheRef = useRef<Record<string, string>>({});
  const closeTimerRef = useRef<number | null>(null);
  const cancelClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);
  const scheduleClose = useCallback((delayMs: number = 220) => {
    if (closeTimerRef.current !== null) return;
    closeTimerRef.current = window.setTimeout(() => {
      setHoverCard(null);
      closeTimerRef.current = null;
    }, delayMs);
  }, []);
  useEffect(() => () => cancelClose(), [cancelClose]);

  const loadPreview = useCallback(async (node: SimNode): Promise<string> => {
    if (previewCacheRef.current[node.id]) return previewCacheRef.current[node.id]!;
    const match = allNotes.find((n) => n.title === node.title);
    if (!match) return "";
    try {
      const content = await readNote(match.filename);
      const preview = extractPreview(content);
      previewCacheRef.current[node.id] = preview;
      return preview;
    } catch { return ""; }
  }, [allNotes]);

  const handleNodeHover = useCallback((node: unknown) => {
    if (!node) {
      scheduleClose();
      setFocusedNodeId(null);
      return;
    }
    cancelClose();
    const n = node as SimNode & { x?: number; y?: number };
    // Turn on focus dim so the 1-hop neighbourhood pops while everything
    // else fades. Cleared in the `!node` branch above when the cursor
    // leaves the node area.
    setFocusedNodeId(n.id);
    // For 2D mode, x/y are in graph space; the ForceGraph2D ref would be
    // needed to project to screen coords. Simpler: we anchor the hover
    // card near the cursor via a mousemove handler on the container.
    // But for 3D mode, the projection isn't straightforward. So we just
    // center the card horizontally in the container for 3D, and use the
    // last-known mouse position for 2D.
    loadPreview(n).then((preview) => {
      setHoverCard((prev) => ({
        node: n,
        screenX: prev?.screenX ?? size.w / 2 - 130,
        screenY: prev?.screenY ?? 60,
        preview,
      }));
    });
  }, [cancelClose, scheduleClose, loadPreview, size.w]);

  const lastMouseRef = useRef({ x: 0, y: 0 });
  const handleContainerMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const r = containerRef.current?.getBoundingClientRect();
    if (!r) return;
    lastMouseRef.current = { x: e.clientX - r.left, y: e.clientY - r.top };
  }, []);

  // Reposition hover card to track the last mouse position.
  useEffect(() => {
    if (!hoverCard) return;
    const { x, y } = lastMouseRef.current;
    const cardW = 260, cardH = 180;
    const sx = x + 20 + cardW > size.w ? Math.max(10, x - cardW - 20) : x + 20;
    const sy = Math.max(10, Math.min(size.h - cardH - 10, y - 40));
    if (sx !== hoverCard.screenX || sy !== hoverCard.screenY) {
      setHoverCard((p) => p ? { ...p, screenX: sx, screenY: sy } : p);
    }
  }, [hoverCard, size.w, size.h]);

  const handleNodeClick = useCallback((node: unknown) => {
    const n = node as SimNode;
    cancelClose();
    setSelected(n.id);
    const match = allNotes.find((m) => m.title === n.title);
    if (match) {
      selectNote(match.filename);
      setHoverCard(null);
      onOpenNote?.();
    }
  }, [cancelClose, setSelected, allNotes, selectNote, onOpenNote]);

  const handleViewNote = useCallback((node: SimNode) => {
    cancelClose();
    setSelected(node.id);
    const match = allNotes.find((m) => m.title === node.title);
    if (match) {
      selectNote(match.filename);
      setHoverCard(null);
      onOpenNote?.();
    }
  }, [cancelClose, setSelected, allNotes, selectNote, onOpenNote]);

  const toggleMode = useCallback(() => {
    setMode((m) => {
      const next = m === "2d" ? "3d" : "2d";
      try { localStorage.setItem("nv.graph.mode", next); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // Hover-focus state. When set, `paintNode2D` dims every node that
  // isn't the hovered node or one of its 1-hop neighbours. Same story
  // for `linkColor`. This turns a hairball of 30k edges into a
  // reading-friendly subgraph on the fly.
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);

  // Clear stale focus when the graph reloads (brain switch, ingest).
  // Otherwise a previously-hovered node id can outlive its node and
  // silently dim the whole new graph because the adjacency lookup
  // returns nothing.
  useEffect(() => {
    if (!focusedNodeId) return;
    if (!nodes.some((n) => n.id === focusedNodeId)) {
      setFocusedNodeId(null);
    }
  }, [nodes, focusedNodeId]);

  // Push PageRank scores to the Rust retriever whenever they change.
  // The retriever applies a gentle ln-based multiplier during recall
  // when state is non-empty for the active brain. Pushing an empty
  // object on Analytics-off clears state so recall returns to the
  // un-boosted baseline — Analytics mode IS the gate.
  useEffect(() => {
    if (analyticsMode && analyticsData) {
      const scores: Record<string, number> = {};
      for (const [id, v] of analyticsData.pr) scores[id] = v;
      nvSetPagerank(scores, activeBrainId ?? undefined);
    } else {
      nvSetPagerank({}, activeBrainId ?? undefined);
    }
  }, [analyticsMode, analyticsData, activeBrainId]);

  // Cluster names (community id → human label), loaded from disk
  // when Analytics mode flips on or the active brain changes. The
  // /name-clusters skill writes these via the Rust HTTP endpoint;
  // the frontend reads here so labels surface in the tip bar.
  const [clusterNames, setClusterNames] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!analyticsMode) {
      setClusterNames({});
      return;
    }
    let cancelled = false;
    nvGetClusterNames(activeBrainId ?? undefined).then((names) => {
      if (!cancelled) setClusterNames(names);
    });
    return () => { cancelled = true; };
  }, [analyticsMode, activeBrainId, analyticsKey]);

  // Push cluster summaries to the Rust HTTP server whenever Louvain
  // produces fresh communities. The agent-driven /name-clusters
  // skill reads these via GET /api/clusters and proposes names.
  // Empty array clears state when Analytics is disabled.
  useEffect(() => {
    if (!analyticsMode || !analyticsData) {
      nvSetClusters([], activeBrainId ?? undefined);
      return;
    }
    // Build a top-N-titles + sample-links payload per community.
    // Top-titles by PageRank within the community (best signal for
    // theming); sample_links from edge endpoints already inside
    // graphData. Capped to keep MCP payload ergonomic.
    const byCommunity = new Map<number, { id: string; pr: number; title: string }[]>();
    for (const n of nodes) {
      const c = analyticsData.com.get(n.id);
      if (c == null) continue;
      const pr = analyticsData.pr.get(n.id) ?? 0;
      let arr = byCommunity.get(c);
      if (!arr) { arr = []; byCommunity.set(c, arr); }
      arr.push({ id: n.id, pr, title: n.title });
    }
    const summaries: NvClusterSummary[] = [];
    for (const [cid, members] of byCommunity) {
      members.sort((a, b) => b.pr - a.pr);
      const topMembers = members.slice(0, 5);
      const top_titles = topMembers.map((m) => m.title);
      // Sample links: edges where both endpoints are in this cluster.
      // Cap at 10 — agents need a flavour, not the full subgraph.
      const memberIds = new Set(members.map((m) => m.id));
      const sample_links: string[] = [];
      for (const e of edges) {
        if (sample_links.length >= 10) break;
        if (memberIds.has(e.from) && memberIds.has(e.to)) {
          sample_links.push(`${e.from} → ${e.to} (${e.link_type})`);
        }
      }
      summaries.push({
        id: cid,
        size: members.length,
        top_titles,
        sample_links,
      });
    }
    nvSetClusters(summaries, activeBrainId ?? undefined);
  }, [analyticsMode, analyticsData, activeBrainId, nodes, edges]);

  // Hover-driven tip bar copy. Active only in Analytics mode; falls
  // through to the idle copy when nothing meaningful is hovered.
  // PR mean is 1.0 by design — 2.0+ is a hub, 0.5- is peripheral.
  // Cluster name (when set via /name-clusters) replaces "a cluster"
  // with the actual theme — "in 'API design' (12 notes)".
  const tipBarHoverText = useMemo<string | null>(() => {
    if (!analyticsMode || !analyticsData || !focusedNodeId) return null;
    const pr = analyticsData.pr.get(focusedNodeId) ?? 0;
    const com = analyticsData.com.get(focusedNodeId);
    const size = com != null ? analyticsData.communitySizes.get(com) ?? 0 : 0;
    const clusterLabel =
      com != null && clusterNames[String(com)]
        ? `'${clusterNames[String(com)]}' (${size} notes)`
        : `a cluster of ${size} linked notes`;
    if (pr >= 2.0) {
      return size > 1
        ? `Core note · ${pr.toFixed(1)}× the average reference rate · in ${clusterLabel}`
        : `Core note · ${pr.toFixed(1)}× the average reference rate`;
    }
    if (size >= 3) return `In ${clusterLabel}`;
    if (pr <= 0.5) return `Peripheral note · few links to the rest of your brain`;
    return null;
  }, [analyticsMode, analyticsData, focusedNodeId, clusterNames]);

  // Custom 2D node renderer. "Glass-orb" aesthetic with state-driven
  // finish:
  //   - Each node is filled with a 3-stop radial gradient (light → base
  //     → slightly dark) centred ~30% top-left so it reads like a small
  //     marble lit from over the shoulder. Beats flat fill at making
  //     the canvas feel like an actual object scene.
  //   - A small specular highlight (white, soft) reinforces the orb
  //     read on circles + hexes. Skipped on squares (looks weird) and
  //     on tiny / focus-dimmed nodes (would just be noise).
  //   - Dormant state desaturates the base colour (true grey-shift,
  //     not just alpha) so the canvas reads "live vs. archived" at a
  //     glance instead of "bright vs. dim".
  //   - Fresh state gets a 1-px amber halo — same brand colour as the
  //     status pill — so newly-arrived notes pop without screaming.
  //   - 0.5-px dark rim still drawn last so light nodes separate from
  //     light edges.
  const paintNode2D = useCallback((rawNode: unknown, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const node = rawNode as SimNode & { x?: number; y?: number; degree?: number };
    if (node.x == null || node.y == null) return;
    // Orphan = degree 0 = pinned to a ring around the connected
    // brain by the graphData layout. Render them smaller and with
    // muted alpha so the eye reads them as peripheral satellites,
    // not equal-weight peers of the linked notes.
    const isOrphan = (node.degree ?? 0) === 0;
    const orphanScale = isOrphan ? 0.55 : 1.0;
    const orphanAlphaMult = isOrphan ? 0.65 : 1.0;
    const r = effectiveNodeRadius(
      node,
      analyticsData?.pr ?? null,
      analyticsMode && analyticsResizeByImportance,
    ) * orphanScale;

    const isDormant = node.state === "dormant";
    const isFresh = node.state === "fresh";

    // Resolve base colour, then apply state finish in colour-space:
    // dormant → desaturate 60% (grey-shifted), fresh/connected/active
    // → keep the saturated folder colour. Alpha is still used for
    // strength fade, but no longer carries the dormant signal alone.
    const folderHue = folderColor(node.folder ?? "", palette, folderColors);
    const baseColor = isDormant ? desaturateHex(folderHue, 0.6) : folderHue;

    // Strength alpha — independent of state now. Dormant gets a small
    // additional alpha drop on top of the desaturation so the two
    // signals reinforce each other.
    const stateScale = isDormant ? 0.78 : 1.0;
    const strengthAlpha = (0.55 + 0.45 * Math.min(1, Math.max(0, node.strength))) * stateScale;

    // Hover-focus dimming unchanged — still the right UX.
    let focusAlpha = 1;
    if (focusedNodeId) {
      const neighbours = graphData.adjacency.get(focusedNodeId);
      const isSelf = node.id === focusedNodeId;
      const isNeighbour = neighbours?.has(node.id) ?? false;
      focusAlpha = (isSelf || isNeighbour) ? 1 : 0.08;
    }

    const alpha = strengthAlpha * focusAlpha * orphanAlphaMult;

    // Drop shadow (atmosphere). Drawn on the gradient fill pass so the
    // shadow follows the orb shape, not just the path.
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
    ctx.shadowBlur = 3;
    ctx.shadowOffsetY = 0.5;

    // 3-stop radial gradient. Centre offset toward top-left of the
    // node so the highlight reads as overhead lighting. Inner radius
    // small but non-zero — a hard pinhole highlight looks plastic;
    // 0.1·r softens it.
    const gx = node.x - r * 0.32;
    const gy = node.y - r * 0.38;
    const grad = ctx.createRadialGradient(gx, gy, r * 0.1, node.x, node.y, r * 1.05);
    const lighter = lightenHex(baseColor, 0.34);
    const darker  = darkenHex(baseColor, 0.22);
    grad.addColorStop(0,   withAlpha(lighter, alpha));
    grad.addColorStop(0.55, withAlpha(baseColor, alpha));
    grad.addColorStop(1,   withAlpha(darker, alpha));

    drawNodeShape(ctx, node.x, node.y, r, nodeShape);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();

    // Specular highlight — small soft white spot, top-left. Only on
    // circle / hex (square would look like a sticker corner), only
    // when the node is large enough (≥3 px) and not focus-dimmed.
    if (focusAlpha > 0.4 && nodeShape !== "square" && r >= 3) {
      const sx = node.x - r * 0.42;
      const sy = node.y - r * 0.46;
      const sr = Math.max(0.7, r * 0.3);
      const specGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, sr);
      specGrad.addColorStop(0, `rgba(255, 255, 255, ${0.42 * alpha})`);
      specGrad.addColorStop(1, `rgba(255, 255, 255, 0)`);
      ctx.save();
      ctx.fillStyle = specGrad;
      ctx.beginPath();
      ctx.arc(sx, sy, sr, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Fresh-state amber halo — drawn after fill, before the dark rim,
    // so it sits as a glow at the boundary rather than competing with
    // the orb body. Using the brand amber (#f0a500) keeps "fresh" tied
    // to the same colour the status pill uses elsewhere.
    if (isFresh && focusAlpha > 0.5) {
      ctx.save();
      drawNodeShape(ctx, node.x, node.y, r + 1.6 / globalScale, nodeShape);
      ctx.lineWidth = 1.4 / globalScale;
      ctx.strokeStyle = `rgba(240, 165, 0, ${0.42 * focusAlpha})`;
      ctx.shadowColor = "rgba(240, 165, 0, 0.55)";
      ctx.shadowBlur = 4;
      ctx.stroke();
      ctx.restore();
    }

    // Thin BG-coloured rim so any pair of near-colour nodes still
    // separates visually. 0.5 px divided by zoom so it stays
    // consistently thin regardless of how close the user is.
    if (focusAlpha > 0.2) {
      drawNodeShape(ctx, node.x, node.y, r, nodeShape);
      ctx.lineWidth = 0.5 / globalScale;
      ctx.strokeStyle = withAlpha("#0b0b12", 0.75 * focusAlpha);
      ctx.stroke();
    }

    // Labels only on zoom-in (>1.4×) OR for neighbours during
    // hover-focus — the overview zoom should read as a shape, not
    // a wall of text. Smaller font than before (was 12 px) to
    // match the smaller nodes.
    const focusLabelBoost = focusAlpha === 1 && focusedNodeId != null;
    if (globalScale >= 1.4 || focusLabelBoost) {
      const fontSize = (focusLabelBoost ? 11 : 10) / Math.max(1, globalScale);
      ctx.font = `${fontSize}px "Geist", system-ui, sans-serif`;
      ctx.fillStyle = withAlpha("#a8a6c0", Math.max(0.35, focusAlpha));
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      const truncated = node.title.length > 28 ? node.title.slice(0, 26) + "…" : node.title;
      ctx.fillText(truncated, node.x, node.y + r + 2);
    }
  }, [focusedNodeId, graphData.adjacency, palette, folderColors, nodeShape, analyticsMode, analyticsResizeByImportance, analyticsData]);

  // Pointer hit area for custom-drawn nodes — drawn in the same shape so
  // hover/click respond where the node visually is.
  const paintPointerArea2D = useCallback((rawNode: unknown, color: string, ctx: CanvasRenderingContext2D) => {
    const node = rawNode as SimNode & { x?: number; y?: number; degree?: number };
    if (node.x == null || node.y == null) return;
    const r = effectiveNodeRadius(
      node,
      analyticsData?.pr ?? null,
      analyticsMode && analyticsResizeByImportance,
    ) + 2;
    ctx.fillStyle = color;
    drawNodeShape(ctx, node.x, node.y, r, nodeShape);
    ctx.fill();
  }, [nodeShape, analyticsMode, analyticsResizeByImportance, analyticsData]);

  /** Native hover tooltip for edges. react-force-graph-2d reads this
   *  and renders a lightweight DOM tooltip on mouseover — no extra
   *  state plumbing on our end. Format: "uses · 0.87" so the reader
   *  sees both the relationship type AND how strong it is. */
  const linkLabel = useCallback((rawLink: unknown) => {
    const l = rawLink as { similarity: number; link_type: string };
    const sim = l.similarity.toFixed(2);
    return `${l.link_type} · ${sim}`;
  }, []);

  /** Cluster-label renderer — draws the folder name at each cluster's
   *  centroid on top of the force graph. Runs once per frame via
   *  `onRenderFramePost`, after all nodes + links have painted.
   *
   *  Why on the canvas vs HTML overlay: we get the correct zoom
   *  transform + DPR handling for free, and the labels follow the
   *  sim without any projection math on our end. `globalScale` is the
   *  zoom factor so we shrink the font as the user zooms out (keeps
   *  labels legible without dominating the view).
   *
   *  Uses folder color at low opacity so labels feel "of" the cluster
   *  rather than pasted on top. Root-level notes (folder === "") are
   *  labelled "Root" only when they're a meaningful group (>2 nodes).
   */
  const paintClusterLabels = useCallback((ctx: CanvasRenderingContext2D, globalScale: number) => {
    if (!nodes.length) return;

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // Two render modes (controlled by the Settings → Graph toggle):
    //
    //   1. showClusterLabels = false  (default after Phase 4):
    //        Render NO labels by default. When the user hovers a
    //        node, label only that node's cluster. Keeps the canvas
    //        clean for screenshots and reading.
    //
    //   2. showClusterLabels = true:
    //        Render all clusters with ≥5 members at all zoom levels
    //        below 2.0×. The original behaviour — for users who want
    //        the orientation aid permanently visible.
    if (showClusterLabels) {
      if (globalScale > 2.0) {
        // Skip — user is zoomed in reading titles directly.
      } else {
        const sums = new Map<string, { x: number; y: number; n: number }>();
        for (const n of nodes as Array<SimNode & { x?: number; y?: number; folder?: string }>) {
          if (n.x == null || n.y == null) continue;
          const key = n.folder ?? "";
          const s = sums.get(key);
          if (s) { s.x += n.x; s.y += n.y; s.n += 1; }
          else sums.set(key, { x: n.x, y: n.y, n: 1 });
        }
        for (const [folder, s] of sums) {
          if (s.n < 5) continue;
          const cx = s.x / s.n;
          const cy = s.y / s.n;
          const color = folder === ""
            ? (folderColors[""] ?? PALETTE_NEUTRAL[palette])
            : folderColor(folder, palette, folderColors);
          const label = folder === "" ? "root" : folder;
          const weight = Math.min(1, s.n / 15);
          const size = (11 + weight * 4) / globalScale;
          ctx.save();
          ctx.font = `600 ${size}px "Geist", system-ui, sans-serif`;
          ctx.shadowColor = "rgba(0, 0, 0, 0.65)";
          ctx.shadowBlur = 5 / globalScale;
          ctx.fillStyle = withAlpha(color, 0.72);
          ctx.fillText(label, cx, cy);
          ctx.restore();
        }
      }
    } else if (focusedNodeId) {
      // Hover-only mode: label only the focused node's cluster.
      const focused = (nodes as Array<SimNode & { folder?: string; x?: number; y?: number }>)
        .find((n) => n.id === focusedNodeId);
      if (focused && globalScale <= 2.0) {
        const focusedFolder = focused.folder ?? "";
        let sx = 0, sy = 0, count = 0;
        for (const n of nodes as Array<SimNode & { x?: number; y?: number; folder?: string }>) {
          if (n.x == null || n.y == null) continue;
          if ((n.folder ?? "") !== focusedFolder) continue;
          sx += n.x; sy += n.y; count += 1;
        }
        if (count >= 2) {
          const cx = sx / count;
          const cy = sy / count;
          const color = focusedFolder === ""
            ? (folderColors[""] ?? PALETTE_NEUTRAL[palette])
            : folderColor(focusedFolder, palette, folderColors);
          const label = focusedFolder === "" ? "root" : focusedFolder;
          const weight = Math.min(1, count / 15);
          const size = (11 + weight * 4) / globalScale;
          ctx.save();
          ctx.font = `600 ${size}px "Geist", system-ui, sans-serif`;
          ctx.shadowColor = "rgba(0, 0, 0, 0.65)";
          ctx.shadowBlur = 5 / globalScale;
          ctx.fillStyle = withAlpha(color, 0.85);
          ctx.fillText(label, cx, cy);
          ctx.restore();
        }
      }
    }

    // --- Focus pulse ring. Drawn in the same post-frame pass so it
    // sits on top of nodes + links. Two concentric expanding rings
    // offset in phase for a sonar-ping feel.
    if (focusPulse) {
      const target = (nodes as Array<SimNode & { x?: number; y?: number; degree?: number }>)
        .find((n) => n.id === focusPulse.nodeId);
      if (target && target.x != null && target.y != null) {
        const elapsed = (Date.now() - focusPulse.start) / 1500;
        if (elapsed >= 0 && elapsed <= 1) {
          const baseR = nodeRadius(target);
          // Ring 1: expands fast, fades out.
          const r1 = baseR + 4 + elapsed * 60;
          const a1 = Math.max(0, 0.8 * (1 - elapsed));
          ctx.save();
          ctx.strokeStyle = withAlpha("#00c9b1", a1);
          ctx.lineWidth = 2 / globalScale;
          ctx.beginPath();
          ctx.arc(target.x, target.y, r1 / globalScale + baseR, 0, Math.PI * 2);
          ctx.stroke();
          // Ring 2: offset by 0.3 phase, slower expand.
          const p2 = Math.max(0, elapsed - 0.3);
          if (p2 > 0) {
            const r2 = baseR + 4 + p2 * 50;
            const a2 = Math.max(0, 0.6 * (1 - p2 / 0.7));
            ctx.strokeStyle = withAlpha("#f0a500", a2);
            ctx.lineWidth = 1.5 / globalScale;
            ctx.beginPath();
            ctx.arc(target.x, target.y, r2 / globalScale + baseR, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.restore();
        }
      }
    }
  }, [nodes, focusedNodeId, focusPulse, palette, folderColors, showClusterLabels]);

  /** Community background tints — gated on Analytics mode + the
   *  "group by community" toggle. Drawn in `onRenderFramePre` so
   *  every other layer (links, nodes, labels) paints on top.
   *
   *  Algorithm (cheap on purpose):
   *    For each community with ≥3 members, compute the centroid and
   *    the max distance from centroid to any member. Fill a circle
   *    of (max-distance + padding) radius at low opacity. Overlapping
   *    blobs blend additively at low alpha — totally fine visually.
   *
   *  No convex hull, no Voronoi, no marching squares. The simpler
   *  approach reads well at our scale and has zero per-frame
   *  trigonometry overhead.
   */
  const paintBackgroundTints = useCallback((ctx: CanvasRenderingContext2D, globalScale: number) => {
    if (!analyticsMode || !analyticsGroupByCommunity || !analyticsData) return;
    if (globalScale > 1.6) return; // Hide once user is reading nodes.

    // Bucket node positions by community.
    const buckets = new Map<number, Array<{ x: number; y: number }>>();
    for (const raw of nodes as Array<SimNode & { x?: number; y?: number }>) {
      if (raw.x == null || raw.y == null) continue;
      const c = analyticsData.com.get(raw.id);
      if (c == null) continue;
      let arr = buckets.get(c);
      if (!arr) { arr = []; buckets.set(c, arr); }
      arr.push({ x: raw.x, y: raw.y });
    }

    // For each community with ≥3 members: centroid + max radius blob.
    for (const [comId, pts] of buckets) {
      if (pts.length < 3) continue;
      let sx = 0, sy = 0;
      for (const p of pts) { sx += p.x; sy += p.y; }
      const cx = sx / pts.length;
      const cy = sy / pts.length;
      let maxR = 0;
      for (const p of pts) {
        const d = Math.hypot(p.x - cx, p.y - cy);
        if (d > maxR) maxR = d;
      }
      const padding = 14;
      const blobR = maxR + padding;

      // Tint hue: derive from the top-degree node in this community
      // so it visually matches the dominant folder colour. Fallback
      // to community-id-based hash so two communities of the same
      // folder still get different tints.
      let dominantFolder: string | undefined;
      let bestDegree = -1;
      for (const raw of nodes as Array<SimNode & { folder?: string; degree?: number }>) {
        if (analyticsData.com.get(raw.id) !== comId) continue;
        const d = raw.degree ?? 0;
        if (d > bestDegree) { bestDegree = d; dominantFolder = raw.folder; }
      }
      // Cluster-name override wins (only present once the user has
      // named this cluster via /name-clusters or by hand). Otherwise
      // tint from the dominant folder, with the same per-folder
      // override path used elsewhere.
      const clusterName = clusterNames[String(comId)];
      const tint = (clusterName && clusterColors[clusterName])
        ? clusterColors[clusterName]!
        : folderColor(dominantFolder ?? `__comm_${comId}`, palette, folderColors);

      ctx.save();
      ctx.fillStyle = withAlpha(tint, 0.10);
      ctx.beginPath();
      ctx.arc(cx, cy, blobR, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }, [analyticsMode, analyticsGroupByCommunity, analyticsData, nodes, palette, folderColors, clusterColors, clusterNames]);

  // Color accessors shared by 2D + 3D. 3D uses folder color too — so
  // orbiting the scene, you see folders as clearly-colored clouds of
  // nodes rather than a monochromatic swarm.
  const nodeColor = useCallback((rawNode: unknown) => {
    const n = rawNode as SimNode;
    return folderColor(n.folder ?? "", palette, folderColors);
  }, [palette, folderColors]);
  const nodeVal = useCallback((rawNode: unknown) => {
    const n = rawNode as SimNode;
    // nodeVal is an area (2D) / volume (3D) multiplier — map our 6-20px
    // radius curve onto a 1-10 range.
    return 1 + Math.min(9, n.access_count * 0.6);
  }, []);
  const linkColor = useCallback((rawLink: unknown) => {
    const l = rawLink as {
      from?: string;
      to?: string;
      similarity: number;
      link_type: string;
      source: string | { id: string };
      target: string | { id: string };
    };
    // Driven by `edgeConfidence` (semantic + link kind + reciprocity)
    // not raw similarity. A manual wikilink at sim 0.5 now reads
    // bolder than an unknown semantic at sim 0.7 — honest fidelity
    // for what the relationship actually is.
    const fromId = typeof l.source === "string" ? l.source : l.source.id;
    const toId = typeof l.target === "string" ? l.target : l.target.id;
    const conf = edgeConfidence(
      { from: l.from ?? fromId, to: l.to ?? toId, similarity: l.similarity, link_type: l.link_type },
      { bidi: graphData.bidi },
    );
    const baseAlpha = Math.max(0.08, Math.min(0.55, conf * 0.55));
    // Dim non-neighbourhood edges when hover-focus is on. (react-force-
    // graph mutates source/target into node objects once the simulation
    // starts, hence the union type.)
    if (focusedNodeId) {
      const touchesFocus = fromId === focusedNodeId || toId === focusedNodeId;
      const a = touchesFocus ? Math.min(0.92, baseAlpha * 2.2) : 0.04;
      return edgeColor(l.link_type, a);
    }
    return edgeColor(l.link_type, baseAlpha);
  }, [focusedNodeId, graphData.bidi]);
  const linkWidth = useCallback((rawLink: unknown) => {
    const l = rawLink as {
      from?: string;
      to?: string;
      similarity: number;
      link_type: string;
      source: string | { id: string };
      target: string | { id: string };
    };
    const fromId = typeof l.source === "string" ? l.source : l.source.id;
    const toId = typeof l.target === "string" ? l.target : l.target.id;
    const conf = edgeConfidence(
      { from: l.from ?? fromId, to: l.to ?? toId, similarity: l.similarity, link_type: l.link_type },
      { bidi: graphData.bidi },
    );
    // 0.25 px (weak) to 0.95 px (high-confidence wikilink) at rest.
    // Was capped at 0.65 — slight headroom now so the strongest edges
    // really announce themselves.
    const base = 0.25 + conf * 0.7;
    if (focusedNodeId) {
      if (fromId === focusedNodeId || toId === focusedNodeId) return base * 2.4;
    }
    return base;
  }, [focusedNodeId, graphData.bidi]);
  // Bidirectional edge curvature: when both A→B and B→A exist, curve
  // them in opposite directions so they no longer draw on top of each
  // other. Each direction gets ±0.15 curvature — subtle enough not
  // to distort layout but enough to visually separate the pair.
  const linkCurvature = useCallback((rawLink: unknown) => {
    const l = rawLink as {
      source: string | { id: string };
      target: string | { id: string };
    };
    const from = typeof l.source === "string" ? l.source : l.source.id;
    const to = typeof l.target === "string" ? l.target : l.target.id;
    const [a, b] = from < to ? [from, to] : [to, from];
    if (!graphData.bidi.has(`${a}|${b}`)) return 0;
    // A→B curves +0.15, B→A curves -0.15. Use the canonical order.
    return from === a ? 0.15 : -0.15;
  }, [graphData.bidi]);

  // Edge-type labels (the "manual" / "semantic" / "uses" / etc.
  // pills) were REMOVED in the aesthetic pass. Even at zoom ≥1.6×
  // they produced wall-of-text — a 200-edge subgraph means 200
  // pills. The hover tooltip (`linkLabel`) surfaces the same info
  // on demand without polluting the static canvas.

  return (
    <div
      ref={containerRef}
      className="flex-1 relative overflow-hidden"
      style={{ background: "var(--nv-bg)" }}
      onMouseMove={handleContainerMouseMove}
      onMouseLeave={() => scheduleClose()}
    >
      {/* Toolbar: 2D/3D mode + Analytics pill */}
      <div className="absolute top-4 right-4 z-20 flex items-center gap-2">
        <div className="flex gap-1 rounded-lg p-0.5"
          style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)" }}
        >
          {(["2d", "3d"] as const).map((m) => (
            <button
              key={m}
              onClick={() => { if (mode !== m) toggleMode(); }}
              className="px-3 py-1 text-[11px] font-[Geist,sans-serif] font-medium rounded uppercase tracking-wider transition-colors"
              style={{
                background: mode === m ? "var(--nv-accent)" : "transparent",
                color: mode === m ? "var(--nv-bg)" : "var(--nv-text-muted)",
              }}
              aria-pressed={mode === m}
              aria-label={`Switch to ${m.toUpperCase()} graph view`}
            >
              {m}
            </button>
          ))}
        </div>
        <button
          onClick={toggleAnalyticsMode}
          className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-[Geist,sans-serif] font-medium rounded-lg tracking-wide transition-colors"
          style={{
            background: analyticsMode ? "var(--nv-accent)" : "var(--nv-surface)",
            color: analyticsMode ? "var(--nv-bg)" : "var(--nv-text-muted)",
            border: "1px solid var(--nv-border)",
          }}
          aria-pressed={analyticsMode}
          aria-label="Toggle analytics overlay"
          title={analyticsMode ? "Analytics on (Cmd+Shift+A)" : "Show analytics (Cmd+Shift+A)"}
        >
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: analyticsMode ? "var(--nv-bg)" : "var(--nv-text-dim)" }}
          />
          Analytics
        </button>
        {/* Semantic-edges toggle. Off by default — auto-computed cosine
            similarity edges create a hairball on dense brains, and they
            represent inferred relationships rather than authored ones.
            Toggling on adds the inferred layer back; the count tells the
            user how many edges they're hiding. */}
        <button
          onClick={toggleShowSemanticEdges}
          className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-[Geist,sans-serif] font-medium rounded-lg tracking-wide transition-colors"
          style={{
            background: showSemanticEdges ? "var(--nv-accent)" : "var(--nv-surface)",
            color: showSemanticEdges ? "var(--nv-bg)" : "var(--nv-text-muted)",
            border: "1px solid var(--nv-border)",
          }}
          aria-pressed={showSemanticEdges}
          aria-label="Toggle semantic-similarity edges"
          title={
            showSemanticEdges
              ? `Semantic edges shown (${semanticEdgeCount}). Click to hide.`
              : `Semantic edges hidden (${semanticEdgeCount} would render). Click to show.`
          }
        >
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: showSemanticEdges ? "var(--nv-bg)" : "var(--nv-text-dim)" }}
          />
          Semantic
          {semanticEdgeCount > 0 && (
            <span
              className="ml-0.5 opacity-70"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {semanticEdgeCount}
            </span>
          )}
        </button>
      </div>

      {/* Analytics tip bar — appears below the toolbar when analytics
          mode is on. Idle copy + per-hover swap + dismiss-for-session. */}
      <AnalyticsTipBar visible={analyticsMode} hoverText={tipBarHoverText} />

      <Suspense fallback={
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="text-sm font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
            Loading graph engine…
          </p>
        </div>
      }>
        {mode === "2d" ? (
          <ForceGraph2D
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ref={fg2dRef as any}
            graphData={graphData}
            width={size.w}
            height={size.h}
            backgroundColor="rgba(0,0,0,0)"
            nodeLabel=""
            nodeRelSize={5}
            nodeVal={nodeVal}
            nodeColor={nodeColor}
            nodeCanvasObject={paintNode2D}
            nodeCanvasObjectMode={() => "replace"}
            nodePointerAreaPaint={paintPointerArea2D}
            linkLabel={linkLabel}
            linkColor={linkColor}
            linkWidth={linkWidth}
            linkCurvature={linkCurvature}
            linkDirectionalParticles={0}
            onRenderFramePre={paintBackgroundTints}
            onRenderFramePost={paintClusterLabels}
            cooldownTicks={100}
            onNodeHover={handleNodeHover}
            onNodeClick={handleNodeClick}
            enableNodeDrag={true}
          />
        ) : (
          <ForceGraph3D
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ref={fg3dRef as any}
            graphData={graphData}
            width={size.w}
            height={size.h}
            backgroundColor="#0b0b12"
            nodeLabel={(n: unknown) => (n as SimNode).title}
            nodeRelSize={5}
            nodeVal={nodeVal}
            nodeColor={nodeColor}
            nodeOpacity={0.9}
            linkLabel={linkLabel}
            linkColor={linkColor}
            linkWidth={linkWidth}
            linkCurvature={linkCurvature}
            linkOpacity={0.55}
            linkDirectionalParticles={1}
            linkDirectionalParticleSpeed={0.006}
            linkDirectionalParticleWidth={1.6}
            onNodeHover={handleNodeHover}
            onNodeClick={handleNodeClick}
            enableNodeDrag={true}
            showNavInfo={false}
          />
        )}
      </Suspense>

      {/* Hover preview card — positioned near the cursor */}
      {hoverCard && (
        <div
          className="absolute rounded-lg shadow-2xl p-4 w-[260px] pointer-events-auto z-10"
          style={{
            left: hoverCard.screenX,
            top: hoverCard.screenY,
            background: "var(--nv-bg)",
            border: "1px solid var(--nv-border)",
          }}
          onMouseEnter={cancelClose}
          onMouseLeave={() => scheduleClose()}
        >
          <div className="flex items-start justify-between gap-2 mb-2">
            <h3 className="text-sm font-semibold font-[Geist,sans-serif] leading-tight" style={{ color: "var(--nv-text)" }}>
              {hoverCard.node.title}
            </h3>
            <span
              className={`text-[9px] font-[Geist,sans-serif] px-1.5 py-0.5 rounded flex-shrink-0 ${
                hoverCard.node.state === "active" || hoverCard.node.state === "fresh"
                  ? "bg-[#f0a500]/15 text-[#f0a500]"
                  : hoverCard.node.state === "connected"
                    ? "bg-[#00c9b1]/15 text-[#00c9b1]"
                    : "[background-color:var(--nv-surface)] [color:var(--nv-text-muted)]"
              }`}
            >
              {Math.round(hoverCard.node.strength * 100)}%
            </span>
          </div>

          {hoverCard.preview && (
            <p className="text-xs line-clamp-4 mb-3 font-[Geist,sans-serif] leading-relaxed" style={{ color: "var(--nv-text-muted)" }}>
              {hoverCard.preview}
            </p>
          )}

          <div className="flex items-center justify-between text-[10px] font-[Geist,sans-serif] mb-3" style={{ color: "var(--nv-text-dim)" }}>
            <span>{hoverCard.node.access_count} accesses</span>
            <span className="capitalize">{hoverCard.node.state}</span>
          </div>

          <button
            onClick={() => handleViewNote(hoverCard.node)}
            className="w-full text-xs font-medium font-[Geist,sans-serif] py-1.5 rounded hover:brightness-110 transition-all"
            style={{ background: "var(--nv-accent)", color: "var(--nv-bg)" }}
          >
            View note
          </button>
        </div>
      )}

      {/* Legend — color swatches match node state colors (semantic,
          not theme chrome) so stay as fixed hex values. */}
      <div className="absolute bottom-4 left-4 flex gap-4 text-[10px] font-[Geist,sans-serif] pointer-events-none" style={{ color: "var(--nv-text-muted)" }}>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[#f0a500]" /> strong
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[#00c9b1]" /> linked
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: "var(--nv-text-dim)" }} /> fading
        </span>
        <span className="flex items-center gap-1 ml-2" style={{ color: "var(--nv-text-dim)" }}>
          {mode === "3d" ? "drag to rotate · scroll to zoom · click a node to open" : "click a node to open"}
        </span>
      </div>

      {nodes.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <p className="text-sm font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>
            Create a few notes to see your knowledge graph
          </p>
        </div>
      )}
    </div>
  );
}
