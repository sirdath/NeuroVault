import { UndirectedGraph } from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import {
  ATLAS_LAYOUT_ENGINE_VERSION,
  ATLAS_LAYOUT_ITERATIONS,
  type AtlasLayoutEdgeSeed,
  type AtlasLayoutNodeSeed,
  type AtlasLayoutRequest,
  type AtlasLayoutResponse,
  type AtlasPosition,
} from "../lib/atlasLayoutTypes";

interface LayoutNodeAttributes {
  x: number;
  y: number;
  size: number;
}

interface LayoutEdgeAttributes {
  weight: number;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: AtlasLayoutResponse): void;
}

interface NormalizedInput {
  nodes: AtlasLayoutNodeSeed[];
  edges: AtlasLayoutEdgeSeed[];
  droppedNodes: number;
  droppedEdges: number;
}

const scope = self as unknown as WorkerScope;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function fallbackPosition(id: string, index: number): AtlasPosition {
  const phase = (hashString(id) / 0xffffffff) * Math.PI * 2;
  const angle = index * GOLDEN_ANGLE + phase;
  const radius = 2 + Math.sqrt(index + 1) * 3;
  return { id, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object";
}

function isRequest(value: unknown): value is AtlasLayoutRequest {
  if (!isRecord(value)) return false;
  return (
    value.type === "atlas-layout" &&
    typeof value.requestId === "string" &&
    value.requestId.length > 0 &&
    Array.isArray(value.nodes) &&
    Array.isArray(value.edges)
  );
}

function normalizedInput(request: AtlasLayoutRequest): NormalizedInput {
  const sortedNodes = [...request.nodes].sort((a, b) =>
    String(a.id).localeCompare(String(b.id)),
  );
  const nodes: AtlasLayoutNodeSeed[] = [];
  const knownIds = new Set<string>();
  const occupiedSeeds = new Set<string>();
  let droppedNodes = 0;

  for (const candidate of sortedNodes) {
    if (!candidate || typeof candidate.id !== "string" || !candidate.id || knownIds.has(candidate.id)) {
      droppedNodes += 1;
      continue;
    }

    const fallback = fallbackPosition(candidate.id, nodes.length);
    let x = Number.isFinite(candidate.x) ? candidate.x : fallback.x;
    let y = Number.isFinite(candidate.y) ? candidate.y : fallback.y;
    const collisionKey = `${x.toPrecision(12)}:${y.toPrecision(12)}`;
    if (occupiedSeeds.has(collisionKey)) {
      // Perfectly coincident nodes can remain coincident in force solvers. A
      // tiny id-derived nudge is deterministic and visually imperceptible.
      const jitter = fallbackPosition(candidate.id, nodes.length + sortedNodes.length);
      x += jitter.x * 1e-4;
      y += jitter.y * 1e-4;
    }

    const size = Number.isFinite(candidate.size) ? clamp(candidate.size, 0.1, 100) : 1;
    nodes.push({ id: candidate.id, x, y, size });
    knownIds.add(candidate.id);
    occupiedSeeds.add(`${x.toPrecision(12)}:${y.toPrecision(12)}`);
  }

  const edges: AtlasLayoutEdgeSeed[] = [];
  const seenPairs = new Set<string>();
  let droppedEdges = 0;
  const sortedEdges = [...request.edges].sort(
    (a, b) =>
      String(a.source).localeCompare(String(b.source)) ||
      String(a.target).localeCompare(String(b.target)) ||
      String(a.id).localeCompare(String(b.id)),
  );

  for (const candidate of sortedEdges) {
    if (
      !candidate ||
      typeof candidate.id !== "string" ||
      typeof candidate.source !== "string" ||
      typeof candidate.target !== "string" ||
      !knownIds.has(candidate.source) ||
      !knownIds.has(candidate.target) ||
      candidate.source === candidate.target
    ) {
      droppedEdges += 1;
      continue;
    }
    const [source, target] =
      candidate.source < candidate.target
        ? [candidate.source, candidate.target]
        : [candidate.target, candidate.source];
    const pair = JSON.stringify([source, target]);
    if (seenPairs.has(pair)) {
      droppedEdges += 1;
      continue;
    }
    seenPairs.add(pair);
    edges.push({
      // The canonical pair is a guaranteed-unique graphology key. Source
      // relation ids are metadata only and may legitimately collide.
      id: pair,
      source,
      target,
      weight: Number.isFinite(candidate.weight) ? clamp(candidate.weight, 0.01, 20) : 1,
    });
  }

  return { nodes, edges, droppedNodes, droppedEdges };
}

function layout(request: AtlasLayoutRequest): AtlasLayoutResponse {
  const startedAt = performance.now();
  const input = normalizedInput(request);
  const graph = new UndirectedGraph<LayoutNodeAttributes, LayoutEdgeAttributes>({
    allowSelfLoops: false,
  });

  for (const node of input.nodes) {
    graph.addNode(node.id, { x: node.x, y: node.y, size: node.size });
  }
  for (const edge of input.edges) {
    graph.addUndirectedEdgeWithKey(edge.id, edge.source, edge.target, { weight: edge.weight });
  }

  const seedById = new Map(input.nodes.map((node) => [node.id, node]));
  let positions: Record<string, { x: number; y: number }> = {};
  if (graph.order > 1 && graph.size > 0) {
    const inferred = forceAtlas2.inferSettings(graph.order);
    positions = forceAtlas2<LayoutNodeAttributes, LayoutEdgeAttributes>(graph, {
      iterations: ATLAS_LAYOUT_ITERATIONS,
      getEdgeWeight: "weight",
      settings: {
        ...inferred,
        adjustSizes: true,
        barnesHutOptimize: graph.order > 300,
        barnesHutTheta: 0.5,
        edgeWeightInfluence: 1,
        gravity: 0.08,
        linLogMode: true,
        scalingRatio: Math.max(6, inferred.scalingRatio ?? 10),
        slowDown: Math.max(2, inferred.slowDown ?? 2),
        strongGravityMode: true,
      },
    });
  }

  const output: AtlasPosition[] = input.nodes.map((node) => {
    const candidate = positions[node.id];
    if (candidate && Number.isFinite(candidate.x) && Number.isFinite(candidate.y)) {
      return { id: node.id, x: candidate.x, y: candidate.y };
    }
    const seed = seedById.get(node.id);
    return { id: node.id, x: seed?.x ?? node.x, y: seed?.y ?? node.y };
  });

  return {
    type: "atlas-layout-result",
    requestId: request.requestId,
    engineVersion: ATLAS_LAYOUT_ENGINE_VERSION,
    positions: output,
    stats: {
      nodeCount: input.nodes.length,
      edgeCount: input.edges.length,
      droppedNodes: input.droppedNodes,
      droppedEdges: input.droppedEdges,
      iterations: graph.order > 1 && graph.size > 0 ? ATLAS_LAYOUT_ITERATIONS : 0,
      durationMs: Math.max(0, performance.now() - startedAt),
    },
  };
}

scope.onmessage = (event) => {
  const request = event.data;
  if (!isRequest(request)) return;

  try {
    scope.postMessage(layout(request));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Atlas layout failed";
    scope.postMessage({
      type: "atlas-layout-error",
      requestId: request.requestId,
      engineVersion: ATLAS_LAYOUT_ENGINE_VERSION,
      message: message.slice(0, 500),
    });
  }
};
