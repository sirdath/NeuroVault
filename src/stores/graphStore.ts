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
  /** Canonical graph payload identity. Identical refreshes keep the existing
   * arrays and therefore do not disturb a settled snapshot renderer. */
  contentFingerprint: string;
  hoveredNode: string | null;
  selectedNode: string | null;
  loading: boolean;
  focusRequest: FocusRequest | null;

  loadGraph: (excludeTypes?: string[]) => Promise<void>;
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

let graphRequestGeneration = 0;

function fnv1a(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function stableUnit(value: string, salt: string): number {
  return Number.parseInt(fnv1a(`${salt}:${value}`), 16) / 0xffffffff;
}

function graphContentFingerprint(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): string {
  const nodeRows = nodes
    .map((node) => [
      node.id,
      node.title,
      node.state,
      node.strength,
      node.access_count,
      node.folder ?? "",
      node.created_at ?? "",
      node.kind ?? "",
    ])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const edgeRows = edges
    .map((edge) => [edge.from, edge.to, edge.link_type, edge.similarity])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return `graph-${nodes.length}-${edges.length}-${fnv1a(JSON.stringify([nodeRows, edgeRows]))}`;
}

export const useGraphStore = create<GraphStore>((set) => ({
  nodes: [],
  edges: [],
  contentFingerprint: "graph-0-0",
  hoveredNode: null,
  selectedNode: null,
  loading: false,
  focusRequest: null,

  loadGraph: async (excludeTypes?: string[]) => {
    const requestGeneration = ++graphRequestGeneration;
    set({ loading: true });

    // Normalise a GraphData-like payload into sim nodes, backfilling the
    // ``folder`` attribute if the server didn't send one (older server
    // builds return the field only on the disk-fallback path).
    const toSimNodes = (nodes: GraphNode[], filenameById?: Map<string, string>): SimNode[] =>
      nodes.map((n) => ({
        ...n,
        folder: n.folder ?? (filenameById ? folderOf(filenameById.get(n.id) ?? "") : ""),
        // Legacy renderers still read these fields. Seed them from the id so
        // a refresh cannot randomly reshuffle a user's graph.
        x: 0.1 + stableUnit(n.id, "x") * 0.8,
        y: 0.1 + stableUnit(n.id, "y") * 0.8,
        vx: 0,
        vy: 0,
        pinned: false,
      }));

    const commit = (rawNodes: GraphNode[], nextEdges: GraphEdge[], filenameById?: Map<string, string>) => {
      if (requestGeneration !== graphRequestGeneration) return false;
      const nextNodes = toSimNodes(rawNodes, filenameById);
      const fingerprint = graphContentFingerprint(nextNodes, nextEdges);
      set((state) =>
        state.contentFingerprint === fingerprint
          ? { loading: false }
          : { nodes: nextNodes, edges: nextEdges, contentFingerprint: fingerprint, loading: false },
      );
      return true;
    };

    try {
      const data = await fetchGraph(excludeTypes);
      if (data.nodes.length > 0) {
        commit(data.nodes, data.edges);
        return;
      }
      // Server up but empty index (cold start, reingest in flight). Fall
      // through to the disk builder so the graph view isn't blank.
    } catch {
      // Server unreachable — fall through to disk.
    }

    try {
      const disk = await buildGraphFromDisk();
      commit(disk.nodes, disk.edges);
    } catch {
      // Disk read also failed (running in browser without Tauri, perhaps).
      if (requestGeneration === graphRequestGeneration) set({ loading: false });
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
