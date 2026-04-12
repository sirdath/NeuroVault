import { create } from "zustand";
import { fetchGraph } from "../lib/api";
import type { GraphNode, GraphEdge } from "../lib/api";

/** Simulation node — extends GraphNode with position/velocity */
export interface SimNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  pinned: boolean;
}

interface GraphStore {
  nodes: SimNode[];
  edges: GraphEdge[];
  hoveredNode: string | null;
  selectedNode: string | null;
  loading: boolean;

  loadGraph: () => Promise<void>;
  setHovered: (id: string | null) => void;
  setSelected: (id: string | null) => void;
  pinNode: (id: string, x: number, y: number) => void;
  unpinNode: (id: string) => void;
}

export const useGraphStore = create<GraphStore>((set) => ({
  nodes: [],
  edges: [],
  hoveredNode: null,
  selectedNode: null,
  loading: false,

  loadGraph: async () => {
    set({ loading: true });
    try {
      const data = await fetchGraph();
      // Initialize positions randomly in 0..1 space
      const simNodes: SimNode[] = data.nodes.map((n) => ({
        ...n,
        x: 0.1 + Math.random() * 0.8,
        y: 0.1 + Math.random() * 0.8,
        vx: 0,
        vy: 0,
        pinned: false,
      }));
      set({ nodes: simNodes, edges: data.edges, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  setHovered: (id) => set({ hoveredNode: id }),
  setSelected: (id) => set({ selectedNode: id }),

  pinNode: (id, x, y) =>
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === id ? { ...n, x, y, vx: 0, vy: 0, pinned: true } : n
      ),
    })),

  unpinNode: (id) =>
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === id ? { ...n, pinned: false } : n
      ),
    })),
}));
