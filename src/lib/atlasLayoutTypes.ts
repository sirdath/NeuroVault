/**
 * Structured-clone-safe protocol shared by the Atlas renderer and its layout
 * worker. Keeping it renderer-agnostic makes layout jobs easy to cancel,
 * replay, cache, and test.
 */

export const ATLAS_LAYOUT_ENGINE_VERSION = "forceatlas2-v1" as const;
export const ATLAS_LAYOUT_ITERATIONS = 180 as const;

export interface AtlasPosition {
  id: string;
  x: number;
  y: number;
}

export interface AtlasLayoutNodeSeed extends AtlasPosition {
  size: number;
}

export interface AtlasSeedableNode {
  id: string;
  size?: number;
}

export interface AtlasLayoutEdgeSeed {
  id: string;
  source: string;
  target: string;
  weight: number;
}

export interface AtlasLayoutRequest {
  type: "atlas-layout";
  requestId: string;
  nodes: AtlasLayoutNodeSeed[];
  edges: AtlasLayoutEdgeSeed[];
}

export interface AtlasLayoutStats {
  nodeCount: number;
  edgeCount: number;
  droppedNodes: number;
  droppedEdges: number;
  iterations: number;
  durationMs: number;
}

export interface AtlasLayoutResult {
  type: "atlas-layout-result";
  requestId: string;
  engineVersion: typeof ATLAS_LAYOUT_ENGINE_VERSION;
  positions: AtlasPosition[];
  stats: AtlasLayoutStats;
}

export interface AtlasLayoutFailure {
  type: "atlas-layout-error";
  requestId: string;
  engineVersion: typeof ATLAS_LAYOUT_ENGINE_VERSION;
  message: string;
}

export type AtlasLayoutResponse = AtlasLayoutResult | AtlasLayoutFailure;

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function atlasSeedHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Stable phyllotaxis seeds for a first layout. Intersecting positions from a
 * previous graph can be supplied to preserve the user's mental map while new
 * nodes receive deterministic positions close to the same origin.
 */
export function deterministicAtlasSeed(
  nodes: readonly AtlasSeedableNode[],
  previous: ReadonlyMap<string, AtlasPosition> = new Map(),
): AtlasLayoutNodeSeed[] {
  const unique = new Map<string, AtlasSeedableNode>();
  for (const node of nodes) {
    if (!node.id || unique.has(node.id)) continue;
    unique.set(node.id, node);
  }

  return [...unique.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((node, index) => {
      const previousPosition = previous.get(node.id);
      const hasPrevious =
        previousPosition != null &&
        Number.isFinite(previousPosition.x) &&
        Number.isFinite(previousPosition.y);
      const phase = (atlasSeedHash(node.id) / 0xffffffff) * Math.PI * 2;
      const angle = index * GOLDEN_ANGLE + phase;
      const radius = 2 + Math.sqrt(index + 1) * 3;
      return {
        id: node.id,
        x: hasPrevious ? previousPosition.x : Math.cos(angle) * radius,
        y: hasPrevious ? previousPosition.y : Math.sin(angle) * radius,
        size:
          typeof node.size === "number" && Number.isFinite(node.size)
            ? Math.max(0.1, Math.min(100, node.size))
            : 1,
      };
    });
}
