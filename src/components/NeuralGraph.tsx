import { useEffect, useRef, useCallback } from "react";
import { useGraphStore } from "../stores/graphStore";
import type { SimNode } from "../stores/graphStore";
import type { GraphEdge } from "../lib/api";
import { useNoteStore } from "../stores/noteStore";

const REPULSION = 0.0003;
const SPRING = 0.003;
const TARGET_DIST = 0.15;
const DAMPING = 0.88;
const CENTER_GRAVITY = 0.005;
const MIN_NODE_RADIUS = 5;
const MAX_NODE_RADIUS = 18;

const STATE_COLORS: Record<string, string> = {
  fresh: "#f0a500",
  active: "#f0a500",
  connected: "#00c9b1",
  dormant: "#35335a",
  consolidated: "#1e1e38",
};

function nodeRadius(accessCount: number): number {
  return Math.min(MAX_NODE_RADIUS, MIN_NODE_RADIUS + Math.sqrt(accessCount) * 2);
}

function tick(nodes: SimNode[], edges: GraphEdge[], nodeMap: Map<string, number>): void {
  if (nodes.length === 0) return;

  // Build spatial grid: each node goes into ONE cell
  const CELL = 0.12;
  const grid = new Map<string, number[]>();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    const key = `${Math.floor(n.x / CELL)},${Math.floor(n.y / CELL)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key)!.push(i);
  }

  // Repulsion: check node against all 9 neighboring cells
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]!;
    const cx = Math.floor(a.x / CELL);
    const cy = Math.floor(a.y / CELL);

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const neighbors = grid.get(`${cx + dx},${cy + dy}`);
        if (!neighbors) continue;

        for (const j of neighbors) {
          if (j <= i) continue; // Avoid duplicate pairs
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

  // Spring attraction for connected pairs
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

  // Apply velocities
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

export function NeuralGraph() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const animRef = useRef<number>(0);
  const nodesRef = useRef<SimNode[]>([]);
  const edgesRef = useRef<GraphEdge[]>([]);
  const nodeMapRef = useRef<Map<string, number>>(new Map());
  const dragRef = useRef<{ id: string } | null>(null);
  const sizeRef = useRef({ w: 800, h: 600 });

  const { nodes, edges, hoveredNode, loadGraph, setHovered, setSelected } = useGraphStore();
  const selectNote = useNoteStore((s) => s.selectNote);
  const allNotes = useNoteStore((s) => s.notes);

  // Sync store into refs (only when data changes meaningfully)
  useEffect(() => {
    if (nodes.length === 0) return;
    nodesRef.current = nodes.map((n) => ({ ...n }));
    edgesRef.current = edges;
    const map = new Map<string, number>();
    nodes.forEach((n, i) => map.set(n.id, i));
    nodeMapRef.current = map;
  }, [nodes, edges]);

  // Load graph on mount
  useEffect(() => {
    loadGraph();
  }, [loadGraph]);

  // Resize canvas to fill container (no devicePixelRatio — keeps coordinates simple)
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

  const findNodeAt = useCallback(
    (cx: number, cy: number): SimNode | null => {
      const { w, h } = sizeRef.current;
      for (let i = nodesRef.current.length - 1; i >= 0; i--) {
        const n = nodesRef.current[i]!;
        const nx = n.x * w;
        const ny = n.y * h;
        const r = nodeRadius(n.access_count) + 4;
        if ((cx - nx) ** 2 + (cy - ny) ** 2 < r ** 2) return n;
      }
      return null;
    },
    []
  );

  const getCanvasPos = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { cx: 0, cy: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      cx: e.clientX - rect.left,
      cy: e.clientY - rect.top,
    };
  }, []);

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
          nodesRef.current[idx]!.vx = 0;
          nodesRef.current[idx]!.vy = 0;
          nodesRef.current[idx]!.pinned = true;
        }
        return;
      }

      const node = findNodeAt(cx, cy);
      setHovered(node?.id ?? null);
      if (canvas) canvas.style.cursor = node ? "pointer" : "default";
    },
    [findNodeAt, setHovered, getCanvasPos]
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

  const onClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const { cx, cy } = getCanvasPos(e);
      const node = findNodeAt(cx, cy);
      if (node) {
        setSelected(node.id);
        const match = allNotes.find((n) => n.title === node.title);
        if (match) selectNote(match.filename);
      }
    },
    [findNodeAt, setSelected, selectNote, allNotes, getCanvasPos]
  );

  // Animation loop
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

      tick(nodesRef.current, edgesRef.current, nodeMapRef.current);

      ctx.fillStyle = "#07070e";
      ctx.fillRect(0, 0, w, h);

      // Edges
      for (const edge of edgesRef.current) {
        const ai = nodeMapRef.current.get(edge.from);
        const bi = nodeMapRef.current.get(edge.to);
        if (ai === undefined || bi === undefined) continue;
        const a = nodesRef.current[ai]!;
        const b = nodesRef.current[bi]!;

        const alpha = Math.max(0.08, edge.similarity * 0.4);
        const isHov = hoveredNode === a.id || hoveredNode === b.id;

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
        ctx.lineWidth = isHov ? 1.5 : 0.5;
        ctx.stroke();
      }

      // Nodes
      for (const n of nodesRef.current) {
        const nx = n.x * w;
        const ny = n.y * h;
        const r = nodeRadius(n.access_count);
        const color = STATE_COLORS[n.state] ?? "#35335a";
        const isHov = hoveredNode === n.id;

        // Glow
        if (n.state === "active" || n.state === "fresh" || n.state === "connected") {
          ctx.beginPath();
          ctx.arc(nx, ny, r + (isHov ? 8 : 4), 0, Math.PI * 2);
          ctx.fillStyle =
            n.state === "active" || n.state === "fresh"
              ? "rgba(240, 165, 0, 0.2)"
              : "rgba(0, 201, 177, 0.12)";
          ctx.fill();
        }

        // Circle
        ctx.beginPath();
        ctx.arc(nx, ny, r, 0, Math.PI * 2);
        ctx.fillStyle = isHov ? "#ffffff" : color;
        ctx.fill();

        // Label on hover
        if (isHov) {
          ctx.font = '12px "Geist", system-ui, sans-serif';
          ctx.fillStyle = "#ddd9f0";
          ctx.textAlign = "center";
          ctx.fillText(n.title, nx, ny - r - 10);

          ctx.font = '10px "Geist", system-ui, sans-serif';
          ctx.fillStyle = "#7a779a";
          ctx.fillText(
            `${Math.round(n.strength * 100)}% · ${n.access_count} hits`,
            nx,
            ny - r - 24
          );
        }
      }

      animRef.current = requestAnimationFrame(render);
    };

    animRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animRef.current);
  }, [hoveredNode]);

  return (
    <div ref={containerRef} className="flex-1 relative bg-[#07070e] overflow-hidden">
      <canvas
        ref={canvasRef}
        onMouseMove={onMouseMove}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onClick={onClick}
        className="absolute inset-0 w-full h-full"
      />
      {/* Legend */}
      <div className="absolute bottom-4 left-4 flex gap-4 text-[10px] font-[Geist,sans-serif] text-[#7a779a]">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[#f0a500]" /> active
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[#00c9b1]" /> connected
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[#35335a]" /> dormant
        </span>
      </div>
      {nodesRef.current.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="text-[#35335a] text-sm font-[Geist,sans-serif]">
            Start the server to see the knowledge graph
          </p>
        </div>
      )}
    </div>
  );
}
