import type { AtlasVisualModel, AtlasVisualNode } from "./atlasVisualModel";

export interface SnapshotPoint2D {
  x: number;
  y: number;
}

export interface SnapshotPoint3D extends SnapshotPoint2D {
  z: number;
}

export type SnapshotPositions2D = Record<string, SnapshotPoint2D>;
export type SnapshotPositions3D = Record<string, SnapshotPoint3D>;

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function hashUnit(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

function orderedCommunities(model: AtlasVisualModel): Array<{
  id: number;
  nodes: AtlasVisualNode[];
}> {
  const byId = new Map<number, AtlasVisualNode[]>();
  for (const node of model.nodes) {
    if (node.communityId == null) continue;
    const list = byId.get(node.communityId);
    if (list) list.push(node);
    else byId.set(node.communityId, [node]);
  }
  return [...byId.entries()]
    .map(([id, nodes]) => ({
      id,
      nodes: nodes.sort((a, b) => a.labelRank - b.labelRank || a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => b.nodes.length - a.nodes.length || a.id - b.id);
}

function normalize2D(input: SnapshotPositions2D, targetRadius = 330): SnapshotPositions2D {
  const values = Object.values(input);
  if (values.length === 0) return {};
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of values) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const span = Math.max(maxX - minX, maxY - minY, 1);
  const scale = (targetRadius * 2) / span;
  const output: SnapshotPositions2D = {};
  for (const [id, point] of Object.entries(input)) {
    output[id] = {
      x: (point.x - centerX) * scale,
      y: (point.y - centerY) * scale,
    };
  }
  return output;
}

/**
 * Stable everyday 2D snapshot. Communities occupy separate cells and notes
 * use a compact phyllotaxis packing inside each cell. There is no force
 * simulation and therefore no visible settling or idle CPU cost.
 */
export function graphSnapshot2D(model: AtlasVisualModel): SnapshotPositions2D {
  const positions: SnapshotPositions2D = {};
  const communities = orderedCommunities(model);
  const placed: Array<{ x: number; y: number; radius: number }> = [];

  communities.forEach((community, communityIndex) => {
    const communityRadius = Math.max(28, 14 + Math.sqrt(community.nodes.length) * 12);
    let centerX = 0;
    let centerY = 0;
    if (communityIndex > 0) {
      // Deterministic circle packing on a golden-angle spiral. It gives the
      // everyday snapshot an organic constellation silhouette without any
      // force simulation or visible settling.
      for (let step = 1; step < 20_000; step += 1) {
        const distance = 4 + step * 1.8;
        const angle = step * GOLDEN_ANGLE;
        const candidateX = Math.cos(angle) * distance;
        const candidateY = Math.sin(angle) * distance;
        const overlaps = placed.some((item) =>
          Math.hypot(candidateX - item.x, candidateY - item.y)
            < communityRadius + item.radius + 18,
        );
        if (overlaps) continue;
        centerX = candidateX;
        centerY = candidateY;
        break;
      }
    }
    placed.push({ x: centerX, y: centerY, radius: communityRadius });
    community.nodes.forEach((node, nodeIndex) => {
      if (nodeIndex === 0) {
        positions[node.id] = { x: centerX, y: centerY };
        return;
      }
      const radius = Math.min(communityRadius - 6, 7 + Math.sqrt(nodeIndex) * 11);
      const angle = nodeIndex * GOLDEN_ANGLE + hashUnit(`${community.id}:${node.id}`) * 0.18;
      positions[node.id] = {
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius,
      };
    });
  });

  const orphans = model.nodes
    .filter((node) => node.communityId == null)
    .sort((a, b) => a.labelRank - b.labelRank || a.id.localeCompare(b.id));
  const outerRadius = Math.max(
    90,
    ...placed.map((item) => Math.hypot(item.x, item.y) + item.radius),
  ) + 42;
  const ringCapacity = Math.max(12, Math.floor((Math.PI * 2 * outerRadius) / 22));
  orphans.forEach((node, index) => {
    const ring = Math.floor(index / ringCapacity);
    const slot = index % ringCapacity;
    const angle = (slot / ringCapacity) * Math.PI * 2 + ring * 0.37;
    const radius = outerRadius + ring * 24;
    positions[node.id] = {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    };
  });

  return normalize2D(positions);
}

/**
 * Stable everyday 3D snapshot. Communities sit on a Fibonacci sphere and
 * their notes form small deterministic local spheres. Coordinates are fixed;
 * the user can orbit the camera but no layout physics ever runs.
 */
export function graphSnapshot3D(model: AtlasVisualModel): SnapshotPositions3D {
  const positions: SnapshotPositions3D = {};
  const communities = orderedCommunities(model);
  const connected = communities.flatMap((community) => community.nodes);
  const orphans = model.nodes
    .filter((node) => node.communityId == null)
    .sort((a, b) => a.id.localeCompare(b.id));
  const ordered = [...connected, ...orphans];
  const anchorIds = new Set(communities.map((community) => community.nodes[0]?.id).filter(Boolean));
  const count = Math.max(1, ordered.length);
  const baseRadius = Math.max(90, Math.min(220, 9 * Math.sqrt(count)));

  ordered.forEach((node, index) => {
    const t = (index + 0.5) / count;
    const unitY = 1 - 2 * t;
    const plane = Math.sqrt(Math.max(0, 1 - unitY * unitY));
    const angle = index * GOLDEN_ANGLE + hashUnit(`${node.communityId ?? "orphan"}`) * 0.32;
    const anchor = anchorIds.has(node.id);
    const shell = anchor
      ? baseRadius * 1.08
      : baseRadius * (0.92 + hashUnit(node.id) * 0.16);
    positions[node.id] = {
      x: Math.cos(angle) * plane * shell,
      y: unitY * shell,
      z: Math.sin(angle) * plane * shell,
    };
  });

  return positions;
}
