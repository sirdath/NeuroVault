import { useEffect, useMemo, useRef, useState, useCallback, Suspense, lazy } from "react";
import { useGraphStore } from "../stores/graphStore";
import type { SimNode } from "../stores/graphStore";
import type { GraphEdge } from "../lib/api";
import { useNoteStore } from "../stores/noteStore";
import { useBrainStore } from "../stores/brainStore";
import { readNote } from "../lib/tauri";
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

const STATE_COLORS: Record<string, string> = {
  fresh: "#f0a500",
  active: "#f0a500",
  connected: "#00c9b1",
  dormant: "#35335a",
  consolidated: "#1f1f2e",
};

const STATE_GLOW: Record<string, string> = {
  fresh: "rgba(240, 165, 0, 0.22)",
  active: "rgba(240, 165, 0, 0.22)",
  connected: "rgba(0, 201, 177, 0.14)",
};

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

function nodeRadius(accessCount: number): number {
  // Same curve as the old hand-rolled sim so the perceived "size" stays
  // consistent for existing users.
  return Math.min(20, 6 + Math.sqrt(accessCount) * 2);
}

/** Deterministic palette — a folder always maps to the same color across
 *  reloads and machines. Hand-picked against the app's dark navy bg so
 *  even small nodes pop without being garish. Peach leads the list so a
 *  vault with only root-level notes (empty folder string) still feels
 *  like it belongs to the NeuroVault brand. */
const FOLDER_PALETTE = [
  "#DE7356",  // peach (brand)
  "#00c9b1",  // teal
  "#8b7cf8",  // purple
  "#60a5fa",  // blue
  "#f0a500",  // amber
  "#f472b6",  // pink
  "#34d399",  // green
  "#38bdf8",  // sky
  "#a78bfa",  // violet
  "#fb7185",  // rose
  "#facc15",  // yellow
  "#FFAF87",  // peach-soft
];

function folderColor(folder: string): string {
  if (!folder) return "#6e6d8f"; // root-level notes — neutral slate
  // Simple FNV-ish hash so the mapping is stable across sessions without
  // pulling in a real hashing lib.
  let h = 2166136261;
  for (let i = 0; i < folder.length; i++) {
    h ^= folder.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return FOLDER_PALETTE[h % FOLDER_PALETTE.length]!;
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

  // Install the folder-cluster force on the 2D graph's d3-force sim.
  // Uses an interval to poll because the ref isn't set until after
  // Suspense resolves the lazy import + the library mounts internally.
  useEffect(() => {
    if (mode !== "2d") return;
    if (clusterAttachedRef.current) return;
    let cancelled = false;

    type D3ForceAPI = {
      d3Force: (name: string, force?: unknown) => D3ForceAPI;
      d3ReheatSimulation?: () => void;
    };

    const tryAttach = () => {
      if (cancelled || clusterAttachedRef.current) return;
      const fg = fg2dRef.current as D3ForceAPI | undefined;
      if (!fg || typeof fg.d3Force !== "function") return;
      try {
        fg.d3Force("cluster", createClusterForce(0.08));
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

  const { nodes, edges, loadGraph, setSelected } = useGraphStore();
  const selectNote = useNoteStore((s) => s.selectNote);
  const allNotes = useNoteStore((s) => s.notes);

  const activeBrainId = useBrainStore((s) => s.activeBrainId);
  const notesList = useNoteStore((s) => s.notes);
  useEffect(() => { loadGraph(); }, [loadGraph, activeBrainId, notesList]);

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
  const graphData = useMemo(() => ({
    nodes: nodes.map((n) => ({ ...n })),  // shallow clone so the sim can stamp x/y without polluting the store
    links: edges.map((e: GraphEdge) => ({
      source: e.from,
      target: e.to,
      similarity: e.similarity,
      link_type: e.link_type,
    })),
  }), [nodes, edges]);

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
      return;
    }
    cancelClose();
    const n = node as SimNode & { x?: number; y?: number };
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

  // Custom 2D node renderer: folder drives the primary fill color so
  // clusters pop visually; the state color (amber/teal/gray) becomes a
  // thin outer ring so "heat" and "grouping" are both legible at once.
  const paintNode2D = useCallback((rawNode: unknown, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const node = rawNode as SimNode & { x?: number; y?: number };
    if (node.x == null || node.y == null) return;
    const r = nodeRadius(node.access_count);
    const fill = folderColor(node.folder ?? "");
    const stateRing = STATE_COLORS[node.state] ?? "#35335a";
    const glow = STATE_GLOW[node.state];

    // Soft outer glow for hot / freshly-touched notes.
    if (glow) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + 6, 0, Math.PI * 2);
      ctx.fillStyle = glow;
      ctx.fill();
    }

    // Folder-colored body.
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();

    // 1.5px state ring on top — communicates "strong / connected /
    // dormant" without stealing the folder signal.
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = stateRing;
    ctx.stroke();

    // Labels only appear once the user zooms in past ~1.4× default. At the
    // overview zoom, node colour + folder clusters carry the story and
    // labels would just turn the graph into wall-of-text. The hover card
    // already shows the title, so readers never lose identity.
    if (globalScale >= 1.4) {
      const fontSize = 12 / globalScale;
      ctx.font = `${fontSize}px "Geist", system-ui, sans-serif`;
      ctx.fillStyle = "#8a88a0";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      const truncated = node.title.length > 24 ? node.title.slice(0, 22) + "…" : node.title;
      ctx.fillText(truncated, node.x, node.y + r + 2);
    }
  }, []);

  // Pointer hit area for custom-drawn nodes — drawn in the same shape so
  // hover/click respond where the node visually is.
  const paintPointerArea2D = useCallback((rawNode: unknown, color: string, ctx: CanvasRenderingContext2D) => {
    const node = rawNode as SimNode & { x?: number; y?: number };
    if (node.x == null || node.y == null) return;
    const r = nodeRadius(node.access_count) + 2;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    ctx.fill();
  }, []);

  // Color accessors shared by 2D + 3D. 3D uses folder color too — so
  // orbiting the scene, you see folders as clearly-colored clouds of
  // nodes rather than a monochromatic swarm.
  const nodeColor = useCallback((rawNode: unknown) => {
    const n = rawNode as SimNode;
    return folderColor(n.folder ?? "");
  }, []);
  const nodeVal = useCallback((rawNode: unknown) => {
    const n = rawNode as SimNode;
    // nodeVal is an area (2D) / volume (3D) multiplier — map our 6-20px
    // radius curve onto a 1-10 range.
    return 1 + Math.min(9, n.access_count * 0.6);
  }, []);
  const linkColor = useCallback((rawLink: unknown) => {
    const l = rawLink as { similarity: number; link_type: string };
    const alpha = Math.max(0.15, Math.min(0.6, l.similarity * 0.5));
    return edgeColor(l.link_type, alpha);
  }, []);
  const linkWidth = useCallback((rawLink: unknown) => {
    const l = rawLink as { similarity: number };
    return 0.5 + l.similarity * 0.8;
  }, []);

  return (
    <div
      ref={containerRef}
      className="flex-1 relative overflow-hidden"
      style={{ background: "var(--nv-bg)" }}
      onMouseMove={handleContainerMouseMove}
      onMouseLeave={() => scheduleClose()}
    >
      {/* Mode toggle */}
      <div className="absolute top-4 right-4 z-20 flex gap-1 rounded-lg p-0.5"
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
            linkColor={linkColor}
            linkWidth={linkWidth}
            linkDirectionalParticles={0}
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
            linkColor={linkColor}
            linkWidth={linkWidth}
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
