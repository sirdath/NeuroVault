import { useEffect, useRef, useCallback, useState } from "react";
import { useGraphStore } from "../stores/graphStore";
import type { SimNode } from "../stores/graphStore";
import type { GraphEdge } from "../lib/api";
import { useNoteStore } from "../stores/noteStore";
import { readNote } from "../lib/tauri";
import { extractPreview } from "../lib/utils";

const REPULSION = 0.0004;
const SPRING = 0.004;
const TARGET_DIST = 0.15;
const DAMPING = 0.85;
const CENTER_GRAVITY = 0.005;
const MIN_NODE_RADIUS = 6;
const MAX_NODE_RADIUS = 20;
const SIMULATION_ITERATIONS = 300; // pre-simulate this many ticks then freeze

const STATE_COLORS: Record<string, string> = {
  fresh: "#f0a500",
  active: "#f0a500",
  connected: "#00c9b1",
  dormant: "#35335a",
  consolidated: "#1f1f2e",
};

function nodeRadius(accessCount: number): number {
  return Math.min(MAX_NODE_RADIUS, MIN_NODE_RADIUS + Math.sqrt(accessCount) * 2);
}

function tick(nodes: SimNode[], edges: GraphEdge[], nodeMap: Map<string, number>): void {
  if (nodes.length === 0) return;

  // Spatial grid for repulsion
  const CELL = 0.12;
  const grid = new Map<string, number[]>();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    const key = `${Math.floor(n.x / CELL)},${Math.floor(n.y / CELL)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key)!.push(i);
  }

  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]!;
    const cx = Math.floor(a.x / CELL);
    const cy = Math.floor(a.y / CELL);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const neighbors = grid.get(`${cx + dx},${cy + dy}`);
        if (!neighbors) continue;
        for (const j of neighbors) {
          if (j <= i) continue;
          const b = nodes[j]!;
          const ddx = a.x - b.x;
          const ddy = a.y - b.y;
          const dist = Math.sqrt(ddx * ddx + ddy * ddy) || 0.001;
          const force = REPULSION / (dist * dist);
          if (!a.pinned) { a.vx += ddx * force; a.vy += ddy * force; }
          if (!b.pinned) { b.vx -= ddx * force; b.vy -= ddy * force; }
        }
      }
    }
  }

  for (const edge of edges) {
    const ai = nodeMap.get(edge.from);
    const bi = nodeMap.get(edge.to);
    if (ai === undefined || bi === undefined) continue;
    const a = nodes[ai]!;
    const b = nodes[bi]!;
    const ddx = b.x - a.x;
    const ddy = b.y - a.y;
    const dist = Math.sqrt(ddx * ddx + ddy * ddy) || 0.001;
    const force = (dist - edge.similarity * TARGET_DIST) * SPRING;
    if (!a.pinned) { a.vx += ddx * force; a.vy += ddy * force; }
    if (!b.pinned) { b.vx -= ddx * force; b.vy -= ddy * force; }
  }

  for (const n of nodes) {
    if (n.pinned) continue;
    n.x += n.vx;
    n.y += n.vy;
    n.vx *= DAMPING;
    n.vy *= DAMPING;
    n.x += (0.5 - n.x) * CENTER_GRAVITY;
    n.y += (0.5 - n.y) * CENTER_GRAVITY;
    n.x = Math.max(0.05, Math.min(0.95, n.x));
    n.y = Math.max(0.05, Math.min(0.95, n.y));
  }
}

interface HoverCard {
  node: SimNode;
  x: number;
  y: number;
  preview: string;
}

interface NeuralGraphProps {
  /** Called when the user clicks "View note" on a hover card. Lets the
   * parent switch back to the Editor view so the selected note becomes
   * visible (the graph view has no editor of its own). */
  onOpenNote?: () => void;
}

export function NeuralGraph({ onOpenNote }: NeuralGraphProps = {}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const edgesRef = useRef<GraphEdge[]>([]);
  const nodeMapRef = useRef<Map<string, number>>(new Map());
  const dragRef = useRef<{ id: string } | null>(null);
  const sizeRef = useRef({ w: 800, h: 600 });
  const settledRef = useRef(false);
  const animRef = useRef<number>(0);

  const [hoverCard, setHoverCard] = useState<HoverCard | null>(null);
  const previewCacheRef = useRef<Record<string, string>>({});
  // Grace-period timer for closing the hover card. Without this, moving the
  // cursor from the node toward the card (through the 30px gap) fires
  // onMouseMove-with-no-node and closes the card before the user can click
  // "View note". The timer is cancelled when the cursor enters the card.
  const closeTimerRef = useRef<number | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const scheduleClose = useCallback((delayMs: number = 250) => {
    if (closeTimerRef.current !== null) return;  // already scheduled
    closeTimerRef.current = window.setTimeout(() => {
      setHoverCard(null);
      closeTimerRef.current = null;
    }, delayMs);
  }, []);

  // Clean up any pending timer on unmount
  useEffect(() => () => cancelClose(), [cancelClose]);

  const { nodes, edges, loadGraph, setSelected } = useGraphStore();
  const selectNote = useNoteStore((s) => s.selectNote);
  const allNotes = useNoteStore((s) => s.notes);
  const activeFilename = useNoteStore((s) => s.activeFilename);

  // Sync store into refs and pre-simulate to settle
  useEffect(() => {
    if (nodes.length === 0) return;
    nodesRef.current = nodes.map((n) => ({ ...n }));
    edgesRef.current = edges;
    const map = new Map<string, number>();
    nodes.forEach((n, i) => map.set(n.id, i));
    nodeMapRef.current = map;

    // Pre-simulate the layout to a stable state
    settledRef.current = false;
    for (let i = 0; i < SIMULATION_ITERATIONS; i++) {
      tick(nodesRef.current, edgesRef.current, nodeMapRef.current);
    }
    // Freeze: zero out all velocities
    for (const n of nodesRef.current) {
      n.vx = 0;
      n.vy = 0;
    }
    settledRef.current = true;
  }, [nodes, edges]);

  // Load graph on mount
  useEffect(() => {
    loadGraph();
  }, [loadGraph]);

  // Resize canvas
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      canvas.width = rect.width;
      canvas.height = rect.height;
      sizeRef.current = { w: rect.width, h: rect.height };
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const findNodeAt = useCallback((cx: number, cy: number): SimNode | null => {
    const { w, h } = sizeRef.current;
    for (let i = nodesRef.current.length - 1; i >= 0; i--) {
      const n = nodesRef.current[i]!;
      const nx = n.x * w;
      const ny = n.y * h;
      const r = nodeRadius(n.access_count) + 4;
      if ((cx - nx) ** 2 + (cy - ny) ** 2 < r ** 2) return n;
    }
    return null;
  }, []);

  const getCanvasPos = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { cx: 0, cy: 0 };
    const rect = canvas.getBoundingClientRect();
    return { cx: e.clientX - rect.left, cy: e.clientY - rect.top };
  }, []);

  // Load preview content for hover
  const loadPreviewForNode = useCallback(async (node: SimNode): Promise<string> => {
    if (previewCacheRef.current[node.id]) return previewCacheRef.current[node.id]!;
    const match = allNotes.find((n) => n.title === node.title);
    if (!match) return "";
    try {
      const content = await readNote(match.filename);
      const preview = extractPreview(content);
      previewCacheRef.current[node.id] = preview;
      return preview;
    } catch {
      return "";
    }
  }, [allNotes]);

  // When the user clicks a sidebar note while the graph is visible, open
  // the hover card over the matching node instead of silently switching
  // the active note in the background. NeuralGraph only exists while the
  // user is on the graph view, so this effect won't fire during editor
  // navigation.
  useEffect(() => {
    if (!activeFilename) return;
    const matchingNote = allNotes.find((n) => n.filename === activeFilename);
    if (!matchingNote) return;
    const title = matchingNote.title;
    // Find the node in the current sim. Use the live ref so we get the
    // post-settle coordinates even if React's state hasn't flushed yet.
    const node = nodesRef.current.find((n) => n.title === title);
    if (!node) return;

    const { w, h } = sizeRef.current;
    if (w === 0 || h === 0) return;
    const nx = node.x * w;
    const ny = node.y * h;
    const cardX = nx + 30 > w - 280 ? nx - 290 : nx + 30;
    const cardY = Math.max(10, Math.min(h - 200, ny - 50));

    cancelClose();
    loadPreviewForNode(node).then((preview) => {
      setHoverCard({ node, x: cardX, y: cardY, preview });
      setSelected(node.id);
    });
  }, [activeFilename, allNotes, loadPreviewForNode, cancelClose, setSelected]);

  const onMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const { cx, cy } = getCanvasPos(e);
      const canvas = canvasRef.current;

      if (dragRef.current) {
        const { w, h } = sizeRef.current;
        const idx = nodeMapRef.current.get(dragRef.current.id);
        if (idx !== undefined && nodesRef.current[idx]) {
          nodesRef.current[idx]!.x = cx / w;
          nodesRef.current[idx]!.y = cy / h;
          nodesRef.current[idx]!.pinned = true;
        }
        return;
      }

      const node = findNodeAt(cx, cy);
      if (canvas) canvas.style.cursor = node ? "pointer" : "default";

      if (node) {
        // Cursor is on a node — cancel any pending close and (re)position the card.
        cancelClose();
        const { w, h } = sizeRef.current;
        const nx = node.x * w;
        const ny = node.y * h;
        // Show card to the right unless near right edge
        const cardX = nx + 30 > w - 280 ? nx - 290 : nx + 30;
        const cardY = Math.max(10, Math.min(h - 200, ny - 50));

        if (!hoverCard || hoverCard.node.id !== node.id) {
          loadPreviewForNode(node).then((preview) => {
            setHoverCard({ node, x: cardX, y: cardY, preview });
          });
        }
      } else if (hoverCard) {
        // Cursor moved off a node. Don't close the card immediately — the
        // user may be transiting through empty canvas toward the "View note"
        // button. Schedule a close; the card's onMouseEnter will cancel it.
        scheduleClose();
      }
    },
    [findNodeAt, getCanvasPos, hoverCard, loadPreviewForNode, cancelClose, scheduleClose]
  );

  const onMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const { cx, cy } = getCanvasPos(e);
      const node = findNodeAt(cx, cy);
      if (node) dragRef.current = { id: node.id };
    },
    [findNodeAt, getCanvasPos]
  );

  const onMouseUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  const handleViewNote = useCallback((node: SimNode) => {
    cancelClose();
    setSelected(node.id);
    const match = allNotes.find((n) => n.title === node.title);
    if (match) {
      selectNote(match.filename);
      setHoverCard(null);
      // Switch back to the editor so the selected note is visible — the
      // graph view has no editor of its own.
      onOpenNote?.();
    }
  }, [setSelected, selectNote, allNotes, cancelClose, onOpenNote]);

  // Render loop — only redraws on change/hover, not constantly
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const render = () => {
      const { w, h } = sizeRef.current;
      if (w === 0 || h === 0) {
        animRef.current = requestAnimationFrame(render);
        return;
      }

      // Only run physics if not yet settled OR if user is dragging
      if (!settledRef.current || dragRef.current) {
        tick(nodesRef.current, edgesRef.current, nodeMapRef.current);
      }

      ctx.fillStyle = "#0b0b12";
      ctx.fillRect(0, 0, w, h);

      // Edges
      for (const edge of edgesRef.current) {
        const ai = nodeMapRef.current.get(edge.from);
        const bi = nodeMapRef.current.get(edge.to);
        if (ai === undefined || bi === undefined) continue;
        const a = nodesRef.current[ai]!;
        const b = nodesRef.current[bi]!;

        const alpha = Math.max(0.1, edge.similarity * 0.5);
        const isHov = hoverCard && (hoverCard.node.id === a.id || hoverCard.node.id === b.id);

        ctx.beginPath();
        ctx.moveTo(a.x * w, a.y * h);
        ctx.lineTo(b.x * w, b.y * h);
        ctx.strokeStyle = isHov
          ? `rgba(240, 165, 0, ${alpha + 0.3})`
          : edge.link_type === "manual"
            ? `rgba(139, 124, 248, ${alpha})`
            : edge.link_type === "entity"
              ? `rgba(0, 201, 177, ${alpha})`
              : `rgba(122, 119, 154, ${alpha})`;
        ctx.lineWidth = isHov ? 2 : 0.7;
        ctx.stroke();
      }

      // Nodes
      for (const n of nodesRef.current) {
        const nx = n.x * w;
        const ny = n.y * h;
        const r = nodeRadius(n.access_count);
        const color = STATE_COLORS[n.state] ?? "#35335a";
        const isHov = hoverCard?.node.id === n.id;

        // Glow for active/connected nodes
        if (n.state === "active" || n.state === "fresh" || n.state === "connected") {
          ctx.beginPath();
          ctx.arc(nx, ny, r + (isHov ? 10 : 5), 0, Math.PI * 2);
          ctx.fillStyle =
            n.state === "active" || n.state === "fresh"
              ? "rgba(240, 165, 0, 0.2)"
              : "rgba(0, 201, 177, 0.12)";
          ctx.fill();
        }

        // Circle
        ctx.beginPath();
        ctx.arc(nx, ny, isHov ? r + 2 : r, 0, Math.PI * 2);
        ctx.fillStyle = isHov ? "#ffffff" : color;
        ctx.fill();

        // Always show node title (so users can read them at a glance)
        ctx.font = '11px "Geist", system-ui, sans-serif';
        ctx.fillStyle = isHov ? "#e8e6f0" : "#8a88a0";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        const truncated = n.title.length > 20 ? n.title.slice(0, 18) + "…" : n.title;
        ctx.fillText(truncated, nx, ny + r + 4);
      }

      animRef.current = requestAnimationFrame(render);
    };

    animRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animRef.current);
  }, [hoverCard]);

  return (
    <div ref={containerRef} className="flex-1 relative bg-[#0b0b12] overflow-hidden">
      <canvas
        ref={canvasRef}
        onMouseMove={onMouseMove}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onMouseLeave={() => {
          dragRef.current = null;
          // Grace period — the user may be moving toward the hover card,
          // which sits inside this same container div.
          scheduleClose();
        }}
        className="absolute inset-0 w-full h-full"
      />

      {/* Hover preview card */}
      {hoverCard && (
        <div
          className="absolute bg-[#12121c] border border-[#1f1f2e] rounded-lg shadow-2xl p-4 w-[260px] pointer-events-auto z-10"
          style={{ left: hoverCard.x, top: hoverCard.y }}
          onMouseEnter={cancelClose}
          onMouseLeave={() => scheduleClose()}
        >
          <div className="flex items-start justify-between gap-2 mb-2">
            <h3 className="text-sm font-semibold text-[#e8e6f0] font-[Geist,sans-serif] leading-tight">
              {hoverCard.node.title}
            </h3>
            <span
              className={`text-[9px] font-[Geist,sans-serif] px-1.5 py-0.5 rounded flex-shrink-0 ${
                hoverCard.node.state === "active" || hoverCard.node.state === "fresh"
                  ? "bg-[#f0a500]/15 text-[#f0a500]"
                  : hoverCard.node.state === "connected"
                    ? "bg-[#00c9b1]/15 text-[#00c9b1]"
                    : "bg-[#35335a]/30 text-[#8a88a0]"
              }`}
            >
              {Math.round(hoverCard.node.strength * 100)}%
            </span>
          </div>

          {hoverCard.preview && (
            <p className="text-xs text-[#8a88a0] line-clamp-4 mb-3 font-[Geist,sans-serif] leading-relaxed">
              {hoverCard.preview}
            </p>
          )}

          <div className="flex items-center justify-between text-[10px] text-[#35335a] font-[Geist,sans-serif] mb-3">
            <span>{hoverCard.node.access_count} accesses</span>
            <span className="capitalize">{hoverCard.node.state}</span>
          </div>

          <button
            onClick={() => handleViewNote(hoverCard.node)}
            className="w-full text-xs font-medium font-[Geist,sans-serif] bg-[#f0a500] text-[#0b0b12] py-1.5 rounded hover:bg-[#f0a500]/90 transition-colors"
          >
            View note
          </button>
        </div>
      )}

      {/* Legend */}
      <div className="absolute bottom-4 left-4 flex gap-4 text-[10px] font-[Geist,sans-serif] text-[#8a88a0] pointer-events-none">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[#f0a500]" /> active
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[#00c9b1]" /> connected
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[#35335a]" /> dormant
        </span>
        <span className="flex items-center gap-1 ml-2 text-[#35335a]">
          drag nodes to reposition
        </span>
      </div>

      {nodes.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <p className="text-[#35335a] text-sm font-[Geist,sans-serif]">
            Start the server to see the knowledge graph
          </p>
        </div>
      )}
    </div>
  );
}
