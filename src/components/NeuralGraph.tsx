import { useEffect, useRef, useCallback } from "react";
import { useGraphStore } from "../stores/graphStore";
import type { SimNode } from "../stores/graphStore";
import type { GraphEdge } from "../lib/api";
import { useNoteStore } from "../stores/noteStore";

// Physics constants
const REPULSION = 0.0004;
const SPRING = 0.003;
const TARGET_DIST = 0.15;
const DAMPING = 0.88;
const CENTER_GRAVITY = 0.004;
const MIN_NODE_RADIUS = 4;
const MAX_NODE_RADIUS = 18;

// Colors by state
const STATE_COLORS: Record<string, string> = {
  fresh: "#f0a500",
  active: "#f0a500",
  connected: "#00c9b1",
  dormant: "#35335a",
  consolidated: "#1e1e38",
};

const STATE_GLOW: Record<string, string> = {
  fresh: "rgba(240, 165, 0, 0.3)",
  active: "rgba(240, 165, 0, 0.25)",
  connected: "rgba(0, 201, 177, 0.15)",
  dormant: "transparent",
  consolidated: "transparent",
};

function nodeRadius(accessCount: number): number {
  return Math.min(MAX_NODE_RADIUS, MIN_NODE_RADIUS + Math.sqrt(accessCount) * 2);
}

function tick(
  nodes: SimNode[],
  edges: GraphEdge[],
  nodeMap: Map<string, number>
): void {
  // Spatial grid optimization: only compute repulsion between nearby nodes
  // Reduces O(n²) to ~O(n) for sparse layouts
  const CELL_SIZE = 0.15;
  const grid = new Map<string, number[]>();

  // Build spatial grid
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    const cx = Math.floor(n.x / CELL_SIZE);
    const cy = Math.floor(n.y / CELL_SIZE);
    // Check this cell and 8 neighbors
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const key = `${cx + dx},${cy + dy}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key)!.push(i);
      }
    }
  }

  // Repulsion only between nodes in nearby cells
  const processed = new Set<string>();
  for (const indices of grid.values()) {
    for (let ii = 0; ii < indices.length; ii++) {
      for (let jj = ii + 1; jj < indices.length; jj++) {
        const i = indices[ii]!;
        const j = indices[jj]!;
        const pairKey = i < j ? `${i},${j}` : `${j},${i}`;
        if (processed.has(pairKey)) continue;
        processed.add(pairKey);

        const a = nodes[i]!;
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

  // Spring attraction for connected pairs
  for (const edge of edges) {
    const ai = nodeMap.get(edge.from);
    const bi = nodeMap.get(edge.to);
    if (ai === undefined || bi === undefined) continue;
    const a = nodes[ai]!;
    const b = nodes[bi]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
    const force = (dist - edge.similarity * TARGET_DIST) * SPRING;
    if (!a.pinned) {
      a.vx += dx * force;
      a.vy += dy * force;
    }
    if (!b.pinned) {
      b.vx -= dx * force;
      b.vy -= dy * force;
    }
  }

  // Apply velocities with damping + center gravity
  for (const n of nodes) {
    if (n.pinned) continue;
    n.x += n.vx;
    n.y += n.vy;
    n.vx *= DAMPING;
    n.vy *= DAMPING;
    n.x += (0.5 - n.x) * CENTER_GRAVITY;
    n.y += (0.5 - n.y) * CENTER_GRAVITY;
    // Clamp to bounds
    n.x = Math.max(0.05, Math.min(0.95, n.x));
    n.y = Math.max(0.05, Math.min(0.95, n.y));
  }
}

export function NeuralGraph() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const nodesRef = useRef<SimNode[]>([]);
  const edgesRef = useRef<GraphEdge[]>([]);
  const nodeMapRef = useRef<Map<string, number>>(new Map());
  const dragRef = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null);

  const { nodes, edges, hoveredNode, loadGraph, setHovered, setSelected } =
    useGraphStore();
  const selectNote = useNoteStore((s) => s.selectNote);

  // Sync store nodes into refs for animation loop
  useEffect(() => {
    nodesRef.current = nodes.map((n) => ({ ...n }));
    edgesRef.current = edges;
    const map = new Map<string, number>();
    nodes.forEach((n, i) => map.set(n.id, i));
    nodeMapRef.current = map;
  }, [nodes, edges]);

  // Load graph data on mount
  useEffect(() => {
    loadGraph();
  }, [loadGraph]);

  // Find node at canvas coordinates
  const findNodeAt = useCallback(
    (cx: number, cy: number, canvas: HTMLCanvasElement): SimNode | null => {
      const w = canvas.width;
      const h = canvas.height;
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

  // Mouse handlers
  const onMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const cx = (e.clientX - rect.left) * (canvas.width / rect.width);
      const cy = (e.clientY - rect.top) * (canvas.height / rect.height);

      if (dragRef.current) {
        const idx = nodeMapRef.current.get(dragRef.current.id);
        if (idx !== undefined && nodesRef.current[idx]) {
          nodesRef.current[idx]!.x = cx / canvas.width;
          nodesRef.current[idx]!.y = cy / canvas.height;
          nodesRef.current[idx]!.vx = 0;
          nodesRef.current[idx]!.vy = 0;
          nodesRef.current[idx]!.pinned = true;
        }
        return;
      }

      const node = findNodeAt(cx, cy, canvas);
      setHovered(node?.id ?? null);
      canvas.style.cursor = node ? "pointer" : "default";
    },
    [findNodeAt, setHovered]
  );

  const onMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const cx = (e.clientX - rect.left) * (canvas.width / rect.width);
      const cy = (e.clientY - rect.top) * (canvas.height / rect.height);
      const node = findNodeAt(cx, cy, canvas);
      if (node) {
        dragRef.current = { id: node.id, offsetX: 0, offsetY: 0 };
      }
    },
    [findNodeAt]
  );

  const onMouseUp = useCallback(() => {
    if (dragRef.current) {
      const { id } = dragRef.current;
      // Pin the node at its current position
      const idx = nodeMapRef.current.get(id);
      if (idx !== undefined && nodesRef.current[idx]) {
        useGraphStore
          .getState()
          .pinNode(id, nodesRef.current[idx]!.x, nodesRef.current[idx]!.y);
      }
      dragRef.current = null;
    }
  }, []);

  const onClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const cx = (e.clientX - rect.left) * (canvas.width / rect.width);
      const cy = (e.clientY - rect.top) * (canvas.height / rect.height);
      const node = findNodeAt(cx, cy, canvas);
      if (node) {
        setSelected(node.id);
        // Find the filename for this engram and open in editor
        const notes = useNoteStore.getState().notes;
        const match = notes.find((n) => n.title === node.title);
        if (match) selectNote(match.filename);
      }
    },
    [findNodeAt, setSelected, selectNote]
  );

  // Animation loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const render = () => {
      const w = canvas.width;
      const h = canvas.height;

      // Physics tick
      tick(nodesRef.current, edgesRef.current, nodeMapRef.current);

      // Clear
      ctx.fillStyle = "#07070e";
      ctx.fillRect(0, 0, w, h);

      // Draw edges
      for (const edge of edgesRef.current) {
        const ai = nodeMapRef.current.get(edge.from);
        const bi = nodeMapRef.current.get(edge.to);
        if (ai === undefined || bi === undefined) continue;
        const a = nodesRef.current[ai]!;
        const b = nodesRef.current[bi]!;

        const alpha = Math.max(0.08, edge.similarity * 0.4);
        const isHovered = hoveredNode === a.id || hoveredNode === b.id;

        ctx.beginPath();
        ctx.moveTo(a.x * w, a.y * h);
        ctx.lineTo(b.x * w, b.y * h);
        ctx.strokeStyle = isHovered
          ? `rgba(240, 165, 0, ${alpha + 0.3})`
          : edge.link_type === "manual"
            ? `rgba(139, 124, 248, ${alpha})`
            : edge.link_type === "entity"
              ? `rgba(0, 201, 177, ${alpha})`
              : `rgba(122, 119, 154, ${alpha})`;
        ctx.lineWidth = isHovered ? 1.5 : 0.5;
        ctx.stroke();
      }

      // Draw nodes
      for (const n of nodesRef.current) {
        const nx = n.x * w;
        const ny = n.y * h;
        const r = nodeRadius(n.access_count);
        const color = STATE_COLORS[n.state] ?? "#35335a";
        const glow = STATE_GLOW[n.state] ?? "transparent";
        const isHovered = hoveredNode === n.id;

        // Glow for active/connected nodes
        if (glow !== "transparent") {
          ctx.beginPath();
          ctx.arc(nx, ny, r + (isHovered ? 8 : 4), 0, Math.PI * 2);
          ctx.fillStyle = glow;
          ctx.fill();
        }

        // Node circle
        ctx.beginPath();
        ctx.arc(nx, ny, r, 0, Math.PI * 2);
        ctx.fillStyle = isHovered ? "#ffffff" : color;
        ctx.fill();

        // Label on hover
        if (isHovered) {
          ctx.font = '12px "Geist", system-ui, sans-serif';
          ctx.fillStyle = "#ddd9f0";
          ctx.textAlign = "center";
          ctx.fillText(n.title, nx, ny - r - 8);

          // Strength + access count
          const info = `${Math.round(n.strength * 100)}% · ${n.access_count} hits`;
          ctx.font = '10px "Geist", system-ui, sans-serif';
          ctx.fillStyle = "#7a779a";
          ctx.fillText(info, nx, ny - r - 22);
        }
      }

      animRef.current = requestAnimationFrame(render);
    };

    animRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animRef.current);
  }, [hoveredNode]);

  // Resize canvas to fill container
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        canvas.width = width * window.devicePixelRatio;
        canvas.height = height * window.devicePixelRatio;
      }
    });

    observer.observe(canvas.parentElement!);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="flex-1 relative bg-[#07070e] overflow-hidden">
      <canvas
        ref={canvasRef}
        className="w-full h-full"
        onMouseMove={onMouseMove}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onClick={onClick}
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
        <span className="flex items-center gap-1">
          <span className="w-1.5 h-[1px] bg-[#8b7cf8]" /> wikilink
        </span>
      </div>
    </div>
  );
}
