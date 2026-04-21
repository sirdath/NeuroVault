import { useEffect, useMemo, useRef, useState, useCallback, Suspense, lazy } from "react";
import { useGraphStore } from "../stores/graphStore";
import type { SimNode } from "../stores/graphStore";
import type { GraphEdge } from "../lib/api";
import { useNoteStore } from "../stores/noteStore";
import { useBrainStore } from "../stores/brainStore";
import { readNote } from "../lib/tauri";
import { extractPreview } from "../lib/utils";

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

  // Custom 2D node renderer: preserves the glow-ring for active/fresh/connected
  // nodes and draws the title label under each node (matching the old feel).
  const paintNode2D = useCallback((rawNode: unknown, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const node = rawNode as SimNode & { x?: number; y?: number };
    if (node.x == null || node.y == null) return;
    const r = nodeRadius(node.access_count);
    const color = STATE_COLORS[node.state] ?? "#35335a";
    const glow = STATE_GLOW[node.state];

    if (glow) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + 6, 0, Math.PI * 2);
      ctx.fillStyle = glow;
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    // Labels become readable past a zoom threshold — saves clutter at far zoom
    // and matches Obsidian's default behaviour.
    if (globalScale >= 0.6) {
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

  // Color accessors shared by 2D + 3D. 3D gets native sphere rendering.
  const nodeColor = useCallback((rawNode: unknown) => {
    const n = rawNode as SimNode;
    return STATE_COLORS[n.state] ?? "#35335a";
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
