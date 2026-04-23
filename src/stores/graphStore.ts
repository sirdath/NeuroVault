import { create } from "zustand";
import { fetchGraph } from "../lib/api";
import { buildGraphFromDisk, folderOf } from "../lib/graphFromDisk";
import type { GraphNode, GraphEdge } from "../lib/api";

/** Simulation node — extends GraphNode with position/velocity */
export interface SimNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  pinned: boolean;
}

/** One-shot "please tween to this node" request. The NeuralGraph
 *  component subscribes; when it sees a new `at` timestamp it animates
 *  the camera + draws a fading pulse ring for ~1.5s. `at` is the
 *  trigger timestamp — consumers re-read it to detect new requests
 *  even for repeat selections of the same node. */
export interface FocusRequest {
  nodeId: string;
  at: number;
}

interface GraphStore {
  nodes: SimNode[];
  edges: GraphEdge[];
  hoveredNode: string | null;
  selectedNode: string | null;
  loading: boolean;
  focusRequest: FocusRequest | null;

  loadGraph: () => Promise<void>;
  setHovered: (id: string | null) => void;
  setSelected: (id: string | null) => void;
  pinNode: (id: string, x: number, y: number) => void;
  unpinNode: (id: string) => void;
  /** Fire a new focus-tween request. Callers are the Cmd+K palette
   *  (find-a-node-from-search) and anything else that wants to jump
   *  the camera to a specific node. NeuralGraph handles the actual
   *  animation; this just hands off the node id + timestamp. */
  requestFocus: (nodeId: string) => void;
}

export const useGraphStore = create<GraphStore>((set) => ({
  nodes: [],
  edges: [],
  hoveredNode: null,
  selectedNode: null,
  loading: false,
  focusRequest: null,

  loadGraph: async () => {
    set({ loading: true });

    // Normalise a GraphData-like payload into sim nodes, backfilling the
    // ``folder`` attribute if the server didn't send one (older server
    // builds return the field only on the disk-fallback path).
    const toSimNodes = (nodes: GraphNode[], filenameById?: Map<string, string>): SimNode[] =>
      nodes.map((n) => ({
        ...n,
        folder: n.folder ?? (filenameById ? folderOf(filenameById.get(n.id) ?? "") : ""),
        x: 0.1 + Math.random() * 0.8,
        y: 0.1 + Math.random() * 0.8,
        vx: 0,
        vy: 0,
        pinned: false,
      }));

    try {
      const data = await fetchGraph();
      if (data.nodes.length > 0) {
        set({ nodes: toSimNodes(data.nodes), edges: data.edges, loading: false });
        return;
      }
      // Server up but empty index (cold start, reingest in flight). Fall
      // through to the disk builder so the graph view isn't blank.
    } catch {
      // Server unreachable — fall through to disk.
    }

    try {
      const disk = await buildGraphFromDisk();
      set({ nodes: toSimNodes(disk.nodes), edges: disk.edges, loading: false });
    } catch {
      // Disk read also failed (running in browser without Tauri, perhaps).
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

  requestFocus: (nodeId) =>
    set({ focusRequest: { nodeId, at: Date.now() } }),
}));
