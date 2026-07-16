import type { AtlasVisualNode } from "./atlasVisualModel";

/** One per shipped composition. "identity", "spiral" and "brain-warp" were
 *  removed in 2026-07: they existed only for hand-authored imported patterns
 *  and were the sole consumers of the ForceAtlas worker + IndexedDB layout
 *  cache, all of which went with pattern import/export. */
export type AtlasTransform =
  | "radial-time"
  | "islands"
  | "dendrite"
  | "halo"
  | "flow"
  | "globe";

/** The six shipped compositions, as a closed set. This is a literal union
 *  rather than `string` so GraphPreset can be derived from it: the preset bar
 *  offers "2d" | "3d" | AtlasPatternId, and tsc rejects a preset that names a
 *  composition we don't ship. Since pattern import/export was removed, these
 *  ids are the only ones that can ever exist. */
export type AtlasPatternId =
  | "timeline"
  | "constellation"
  | "dendrite"
  | "halo"
  | "flow"
  | "globe";

export interface AtlasPatternV1 {
  schemaVersion: 1;
  id: AtlasPatternId;
  name: string;
  version: number;
  transform: {
    type: AtlasTransform;
    rotation: number;
    intensity: number;
    clusterSpacing: number;
  };
  appearance: {
    atmosphere: number;
    labelDensity: number;
    edgeOpacity: number;
  };
}

export interface AtlasPosition {
  x: number;
  y: number;
}

export type AtlasPositions = Record<string, AtlasPosition>;

const BUILT_INS: readonly AtlasPatternV1[] = [
  {
    schemaVersion: 1,
    id: "timeline",
    name: "Time Rings",
    version: 2,
    transform: { type: "radial-time", rotation: -Math.PI / 2, intensity: 0.65, clusterSpacing: 1 },
    appearance: { atmosphere: 0.16, labelDensity: 0.2, edgeOpacity: 0.34 },
  },
  {
    schemaVersion: 1,
    id: "constellation",
    name: "Constellation Islands",
    version: 2,
    transform: { type: "islands", rotation: -0.18, intensity: 0.62, clusterSpacing: 1.15 },
    appearance: { atmosphere: 0.62, labelDensity: 0.18, edgeOpacity: 0.22 },
  },
  {
    schemaVersion: 1,
    id: "dendrite",
    name: "Neural Arbor",
    version: 2,
    transform: { type: "dendrite", rotation: 0, intensity: 0.72, clusterSpacing: 1.05 },
    appearance: { atmosphere: 0.45, labelDensity: 0.12, edgeOpacity: 0.28 },
  },
  {
    schemaVersion: 1,
    id: "halo",
    name: "Connectome Halo",
    version: 2,
    transform: { type: "halo", rotation: -Math.PI / 2, intensity: 0.64, clusterSpacing: 1.08 },
    appearance: { atmosphere: 0.2, labelDensity: 0.1, edgeOpacity: 0.3 },
  },
  {
    schemaVersion: 1,
    id: "flow",
    name: "Memory Flow",
    version: 2,
    transform: { type: "flow", rotation: 0, intensity: 0.58, clusterSpacing: 1 },
    appearance: { atmosphere: 0.12, labelDensity: 0.14, edgeOpacity: 0.2 },
  },
  {
    schemaVersion: 1,
    id: "globe",
    name: "Knowledge Globe",
    version: 2,
    transform: { type: "globe", rotation: -0.22, intensity: 0.7, clusterSpacing: 1 },
    appearance: { atmosphere: 0.34, labelDensity: 0.1, edgeOpacity: 0.24 },
  },
] as const;

export const ATLAS_BUILT_IN_PATTERNS: readonly AtlasPatternV1[] = BUILT_INS;

/** Every shipped composition id, derived from the patterns themselves so the
 *  preset validator can never drift from what we actually render. */
export const ATLAS_PATTERN_IDS: readonly AtlasPatternId[] = BUILT_INS.map((p) => p.id);

export function isAtlasPatternId(value: unknown): value is AtlasPatternId {
  return typeof value === "string" && ATLAS_PATTERN_IDS.includes(value as AtlasPatternId);
}

export function atlasBuiltInPattern(id: string): AtlasPatternV1 {
  return BUILT_INS.find((pattern) => pattern.id === id) ?? BUILT_INS[0]!;
}

function normalizedPositions(nodes: readonly AtlasVisualNode[], positions: AtlasPositions): AtlasPositions {
  const finite = nodes
    .map((node) => ({ id: node.id, point: positions[node.id] }))
    .filter((item): item is { id: string; point: AtlasPosition } =>
      item.point != null && Number.isFinite(item.point.x) && Number.isFinite(item.point.y),
    );
  if (finite.length === 0) return {};
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const { point } of finite) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const span = Math.max(maxX - minX, maxY - minY, 1);
  const result: AtlasPositions = {};
  for (const { id, point } of finite) {
    result[id] = { x: ((point.x - cx) / span) * 2, y: ((point.y - cy) / span) * 2 };
  }
  return result;
}

/** Apply an inexpensive deterministic transform to a cached base layout. */
export function transformAtlasPositions(
  pattern: AtlasPatternV1,
  nodes: readonly AtlasVisualNode[],
  basePositions: AtlasPositions,
): AtlasPositions {
  const normalized = normalizedPositions(nodes, basePositions);
  const output: AtlasPositions = {};
  const { rotation, intensity, clusterSpacing } = pattern.transform;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const rotate = (x: number, y: number): AtlasPosition => ({
    x: (x * cos - y * sin) * clusterSpacing,
    y: (x * sin + y * cos) * clusterSpacing,
  });

  const stableNodes = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const communities = new Map<number, AtlasVisualNode[]>();
  for (const node of stableNodes) {
    const key = node.communityId ?? -1;
    const list = communities.get(key);
    if (list) list.push(node);
    else communities.set(key, [node]);
  }
  const groups = [...communities.entries()]
    .map(([id, members]) => ({
      id,
      members: members.sort((a, b) => a.labelRank - b.labelRank || a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => b.members.length - a.members.length || a.id - b.id);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const hashUnit = (value: string): number => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) / 0xffffffff;
  };

  if (pattern.transform.type === "radial-time") {
    const ordered = [...nodes].sort((a, b) => {
      const ta = a.created_at ? Date.parse(a.created_at) : Number.NaN;
      const tb = b.created_at ? Date.parse(b.created_at) : Number.NaN;
      const va = Number.isFinite(ta) ? ta : Number.MAX_SAFE_INTEGER;
      const vb = Number.isFinite(tb) ? tb : Number.MAX_SAFE_INTEGER;
      return va - vb || a.id.localeCompare(b.id);
    });
    const count = Math.max(1, ordered.length);
    ordered.forEach((node, index) => {
      const t = (index + 0.5) / count;
      const turns = 2.15 + intensity * 1.35;
      const angle = rotation + t * Math.PI * 2 * turns;
      const radius = (0.18 + Math.sqrt(t) * 1.75) * clusterSpacing;
      output[node.id] = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
    });
    return output;
  }

  if (pattern.transform.type === "islands") {
    const majorGroups = groups.filter((group) => group.id !== -1 && group.members.length >= 3).slice(0, 10);
    if (majorGroups.length === 0) {
      const fallback = groups.find((group) => group.id !== -1) ?? groups[0];
      if (fallback) majorGroups.push(fallback);
    }
    const majorIds = new Set(majorGroups.map((group) => group.id));
    const placed: Array<{ x: number; y: number; radius: number }> = [];
    majorGroups.forEach((group, groupIndex) => {
      const groupRadius = Math.max(0.2, 0.1 + Math.sqrt(group.members.length) * 0.064);
      let centerX = 0;
      let centerY = 0;
      if (groupIndex > 0) {
        for (let step = 1; step < 12_000; step += 1) {
          const distance = 0.02 + step * 0.014;
          const angle = step * goldenAngle;
          const candidateX = Math.cos(angle) * distance;
          const candidateY = Math.sin(angle) * distance;
          const overlaps = placed.some((item) =>
            Math.hypot(candidateX - item.x, candidateY - item.y)
              < groupRadius + item.radius + 0.075,
          );
          if (overlaps) continue;
          centerX = candidateX;
          centerY = candidateY;
          break;
        }
      }
      placed.push({ x: centerX, y: centerY, radius: groupRadius });
      group.members.forEach((node, memberIndex) => {
        if (memberIndex === 0) {
          output[node.id] = rotate(centerX, centerY);
          return;
        }
        const radius = Math.min(
          groupRadius - 0.018,
          0.035 + Math.sqrt(memberIndex) * (0.045 + intensity * 0.009),
        );
        const angle = memberIndex * goldenAngle + hashUnit(node.id) * 0.2;
        output[node.id] = rotate(
          centerX + Math.cos(angle) * radius,
          centerY + Math.sin(angle) * radius,
        );
      });
    });
    const dust = groups
      .filter((group) => !majorIds.has(group.id))
      .flatMap((group) => group.members)
      .sort((a, b) => a.labelRank - b.labelRank || a.id.localeCompare(b.id));
    const dustRadius = Math.max(
      0.75,
      ...placed.map((item) => Math.hypot(item.x, item.y) + item.radius),
    ) + 0.18;
    dust.forEach((node, index) => {
      const angle = index * goldenAngle + hashUnit(node.id) * 0.24;
      const ring = dustRadius + (index % 5) * 0.035 + Math.floor(index / 64) * 0.08;
      output[node.id] = rotate(Math.cos(angle) * ring, Math.sin(angle) * ring);
    });
    return output;
  }

  if (pattern.transform.type === "dendrite") {
    const groupCount = Math.max(1, groups.length);
    groups.forEach((group, groupIndex) => {
      const rootX = groupCount === 1
        ? 0
        : -1.05 + (groupIndex / Math.max(1, groupCount - 1)) * 2.1;
      const rootY = -1.02 + (groupIndex % 2) * 0.035;
      const groupWidth = 0.58 / Math.sqrt(groupCount);
      group.members.forEach((node, memberIndex) => {
        if (memberIndex === 0) {
          output[node.id] = rotate(rootX, rootY);
          return;
        }
        const treeIndex = memberIndex + 1;
        const level = Math.floor(Math.log2(treeIndex));
        const firstInLevel = 2 ** level;
        const slot = treeIndex - firstInLevel;
        const slots = 2 ** level;
        const normalizedSlot = (slot + 0.5) / slots - 0.5;
        const spread = groupWidth * (1 + level * (0.28 + intensity * 0.08));
        const sway = (hashUnit(node.id) - 0.5) * 0.035;
        output[node.id] = rotate(
          rootX + normalizedSlot * spread * 2 + sway,
          rootY + level * (0.22 + intensity * 0.018),
        );
      });
    });
    return output;
  }

  if (pattern.transform.type === "halo") {
    const ordered = groups.flatMap((group) => group.members);
    const total = Math.max(1, ordered.length);
    ordered.forEach((node, index) => {
      const angle = rotation + (index / total) * Math.PI * 2;
      const ring = 1.05 + ((node.communityId ?? -1) % 3) * 0.035;
      output[node.id] = {
        x: Math.cos(angle) * ring * clusterSpacing,
        y: Math.sin(angle) * ring * clusterSpacing,
      };
    });
    return output;
  }

  if (pattern.transform.type === "flow") {
    const ordered = [...stableNodes].sort((a, b) => {
      const ta = a.created_at ? Date.parse(a.created_at) : Number.NaN;
      const tb = b.created_at ? Date.parse(b.created_at) : Number.NaN;
      const va = Number.isFinite(ta) ? ta : Number.MAX_SAFE_INTEGER;
      const vb = Number.isFinite(tb) ? tb : Number.MAX_SAFE_INTEGER;
      return va - vb || a.id.localeCompare(b.id);
    });
    const indexById = new Map(ordered.map((node, index) => [node.id, index]));
    const laneGroups = groups.filter((group) => group.id !== -1).slice(0, 5);
    const laneOrder = [0, -1, 1, -2, 2];
    const laneByCommunity = new Map(laneGroups.map((group, index) => [group.id, laneOrder[index] ?? index]));
    const maxLane = Math.max(1, Math.ceil(laneGroups.length / 2));
    for (const node of stableNodes) {
      const index = indexById.get(node.id) ?? 0;
      const t = (index + 0.5) / Math.max(1, ordered.length);
      const assignedLane = laneByCommunity.get(node.communityId ?? -1);
      const dustLane = Math.round((hashUnit(`${node.communityId ?? node.id}:lane`) - 0.5) * maxLane * 2);
      const lane = assignedLane ?? dustLane;
      const laneY = (lane / maxLane) * 0.9;
      const jitter = (hashUnit(node.id) - 0.5) * (0.055 + intensity * 0.055);
      const wave = Math.sin(t * Math.PI * 2.4 + lane * 0.72) * 0.12;
      output[node.id] = rotate((-1.45 + t * 2.9) * clusterSpacing, laneY + wave + jitter);
    }
    return output;
  }

  if (pattern.transform.type === "globe") {
    const ordered: AtlasVisualNode[] = [];
    const queues = groups.map((group) => [...group.members]);
    for (let memberIndex = 0; ordered.length < stableNodes.length; memberIndex += 1) {
      let added = false;
      for (const queue of queues) {
        const node = queue[memberIndex];
        if (!node) continue;
        ordered.push(node);
        added = true;
      }
      if (!added) break;
    }
    const count = Math.max(1, ordered.length);
    ordered.forEach((node, index) => {
      const t = (index + 0.5) / count;
      const y = 1 - 2 * t;
      const latitudeRadius = Math.sqrt(Math.max(0, 1 - y * y));
      const angle = rotation + index * goldenAngle;
      const depth = Math.sin(angle) * latitudeRadius;
      const perspective = 0.82 + (depth + 1) * 0.09;
      output[node.id] = {
        x: Math.cos(angle) * latitudeRadius * perspective * clusterSpacing,
        y: y * perspective * clusterSpacing,
      };
    });
    return output;
  }

  // Every shipped composition returns above. This keeps the function total and
  // is what the removed "identity" transform did: place each note at its seed
  // coordinate under the pattern's rotation. (The "spiral" and "brain-warp"
  // branches that also lived here went with pattern import/export in 2026-07.)
  for (const node of stableNodes) {
    const point = normalized[node.id] ?? { x: 0, y: 0 };
    output[node.id] = rotate(point.x, point.y);
  }
  return output;
}
