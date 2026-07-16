import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import Graph from "graphology";
import type { Attributes } from "graphology-types";
import Sigma from "sigma";
import type { CameraState, EdgeDisplayData, NodeDisplayData } from "sigma/types";
import { createNodeBorderProgram } from "@sigma/node-border";
import { createEdgeCurveProgram } from "@sigma/edge-curve";
import { toBlob } from "@sigma/export-image";
import {
  type AtlasEdgeTier,
  type AtlasVisualModel,
} from "../lib/atlasVisualModel";
import {
  ATLAS_BUILT_IN_PATTERNS,
  atlasBuiltInPattern,
  transformAtlasPositions,
  type AtlasPatternId,
  type AtlasPositions,
} from "../lib/atlasPatterns";
// atlasLayoutTypes survives the ForceAtlas removal: deterministicAtlasSeed
// seeds EVERY composition, built-ins included.
import {
  deterministicAtlasSeed,
  type AtlasPosition,
} from "../lib/atlasLayoutTypes";
import type { SimNode } from "../stores/graphStore";
import { useSettingsStore } from "../stores/settingsStore";
import {
  folderColor,
  PALETTES,
  useGraphSettingsStore,
  type GraphConnectionMode,
  type GraphLabelMode,
  type GraphPalette,
} from "../stores/graphSettingsStore";

type SemanticTier = "overview" | "medium" | "detail";

interface AtlasNodeAttributes extends Attributes {
  x: number;
  y: number;
  size: number;
  baseSize: number;
  color: string;
  dimColor: string;
  borderColor: string;
  dimBorderColor: string;
  label: string;
  type: "border";
  hidden: boolean;
  forceLabel: boolean;
  highlighted: boolean;
  zIndex: number;
  labelRank: number;
  communityId: number;
  orphan: boolean;
  anchor: boolean;
}

interface AtlasEdgeAttributes extends Attributes {
  size: number;
  baseSize: number;
  color: string;
  baseColor: string;
  type: "curved";
  curvature: number;
  hidden: boolean;
  forceLabel: boolean;
  label: string;
  zIndex: number;
  tier: AtlasEdgeTier;
  sourceId: string;
  targetId: string;
}

interface AtlasGraphAttributes extends Attributes {
  brainId: string;
}

interface InteractionState {
  tier: SemanticTier;
  hoveredNodeId: string | null;
  pulseNodeId: string | null;
  pulseStartedAt: number;
  searchMatches: ReadonlySet<string> | null;
  visibleNodeIds: ReadonlySet<string> | null;
  showOrphans: boolean;
  edgeOpacity: number;
  labelDensity: number;
  labelMode: GraphLabelMode;
  connectionMode: GraphConnectionMode;
  featuredEdgeIds: ReadonlySet<string>;
  patternId: string;
}

export interface AtlasGraphHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
  focusNode: (nodeId: string) => void;
  fitNodes: (nodeIds: readonly string[]) => void;
  pulse: (nodeId: string) => void;
  exportPng: () => Promise<Blob | null>;
}

interface AtlasGraphProps {
  brainId: string;
  nodes: readonly SimNode[];
  /** Which composition to draw. Controlled by the preset bar — AtlasGraph used
   *  to own this in its own localStorage key, a second source of truth that
   *  could disagree with NeuralGraph about what was on screen. */
  patternId: AtlasPatternId;
  /** Built once by NeuralGraph and shared by every preset. */
  model: AtlasVisualModel;
  palette: GraphPalette;
  folderColors: Record<string, string>;
  nodeSizeScale: number;
  linkThicknessScale: number;
  lite: boolean;
  searchMatches: ReadonlySet<string> | null;
  visibleNodeIds: ReadonlySet<string> | null;
  showOrphans: boolean;
  onNodeHover: (node: SimNode | null) => void;
  onNodeClick: (node: SimNode) => void;
  onRuntimeError: (error: Error) => void;
}

interface ThemeColors {
  background: string;
  text: string;
  dim: string;
  border: string;
  accent: string;
  positive: string;
  negative: string;
  warning: string;
}


const AtlasNodeProgram = createNodeBorderProgram<
  AtlasNodeAttributes,
  AtlasEdgeAttributes,
  AtlasGraphAttributes
>({
  borders: [
    {
      size: { value: 0.08, mode: "relative" },
      color: { attribute: "borderColor", defaultValue: "#8b7cf8" },
    },
    {
      size: { fill: true },
      color: { attribute: "color", defaultValue: "#68708b" },
    },
  ],
});
const AtlasEdgeCurveProgram = createEdgeCurveProgram<
  AtlasNodeAttributes,
  AtlasEdgeAttributes,
  AtlasGraphAttributes
>();

function colorWithAlpha(color: string, alpha: number): string {
  const bounded = Math.max(0, Math.min(1, alpha));
  const hex = color.trim().match(/^#([0-9a-f]{6})$/i)?.[1];
  if (hex) {
    const red = Number.parseInt(hex.slice(0, 2), 16);
    const green = Number.parseInt(hex.slice(2, 4), 16);
    const blue = Number.parseInt(hex.slice(4, 6), 16);
    return `rgba(${red}, ${green}, ${blue}, ${bounded})`;
  }
  const rgb = color.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (rgb) {
    return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${bounded})`;
  }
  return color;
}

function colorChannels(color: string): [number, number, number] | null {
  const hex = color.trim().match(/^#([0-9a-f]{6})$/i)?.[1];
  if (hex) {
    return [
      Number.parseInt(hex.slice(0, 2), 16),
      Number.parseInt(hex.slice(2, 4), 16),
      Number.parseInt(hex.slice(4, 6), 16),
    ];
  }
  const rgb = color.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  return rgb
    ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
    : null;
}

/** Sigma's WebGL edge programs do not consistently composite low-alpha
 * colours across every GPU. Pre-blending produces the same quiet line on
 * every machine instead of unexpectedly bright white chords. */
function blendColor(background: string, foreground: string, amount: number): string {
  const bg = colorChannels(background);
  const fg = colorChannels(foreground);
  if (!bg || !fg) return foreground;
  const mix = Math.max(0, Math.min(1, amount));
  return `rgb(${Math.round(bg[0] + (fg[0] - bg[0]) * mix)}, ${Math.round(bg[1] + (fg[1] - bg[1]) * mix)}, ${Math.round(bg[2] + (fg[2] - bg[2]) * mix)})`;
}

function nodeSize(node: { degree: number; importance: number; access_count: number }): number {
  const degree = Math.max(0, node.degree);
  const importance = Math.max(0, node.importance);
  const access = Math.max(0, node.access_count);
  return Math.min(
    7.5,
    1.15 + Math.sqrt(degree) * 0.36 + Math.sqrt(importance) * 0.5 + Math.min(0.8, Math.sqrt(access) * 0.1),
  );
}

function edgeThemeColor(linkType: string, colors: ThemeColors): string {
  switch (linkType) {
    case "manual":
    case "defines":
    case "part_of":
    case "extends":
      return colors.accent;
    case "contradicts":
      return colors.negative;
    case "supersedes":
      return colors.warning;
    default:
      return colors.dim;
  }
}

/** A sparse visual skeleton. Truth is never discarded from the model; this
 * set only decides what the overview is allowed to draw. */
function featuredEdges(
  model: AtlasVisualModel,
  positions: AtlasPositions,
  patternId: string,
): ReadonlySet<string> {
  // Each composition gets a deliberately small visual budget. The full truth
  // remains available through "All"; Featured is an authored silhouette.
  const ratioByPattern: Readonly<Record<string, number>> = {
    timeline: 0.11,
    constellation: 0.14,
    halo: 0.36,
    flow: 0.13,
    globe: 0.16,
  };
  const capByPattern: Readonly<Record<string, number>> = {
    timeline: 28,
    constellation: 36,
    halo: 96,
    flow: 34,
    globe: 42,
  };
  const ratio = ratioByPattern[patternId] ?? 0.14;
  const cap = capByPattern[patternId] ?? 44;
  const budget = Math.min(cap, Math.max(12, Math.round(model.nodes.length * ratio)));
  const degree = new Map(model.nodes.map((node) => [node.id, 0]));
  const communityByNode = new Map(model.nodes.map((node) => [node.id, node.communityId]));
  const distanceByEdge = new Map(model.edges.map((edge) => {
    const source = positions[edge.source];
    const target = positions[edge.target];
    return [edge.id, source && target ? Math.hypot(source.x - target.x, source.y - target.y) : 99] as const;
  }));
  const selected = new Set<string>();
  const sorted = [...model.edges].sort((a, b) => {
    const distanceA = distanceByEdge.get(a.id) ?? 99;
    const distanceB = distanceByEdge.get(b.id) ?? 99;
    const aAsserted = a.reasons.includes("asserted") ? 1 : 0;
    const bAsserted = b.reasons.includes("asserted") ? 1 : 0;
    const sameCommunityA = communityByNode.get(a.source) === communityByNode.get(a.target) ? 1 : 0;
    const sameCommunityB = communityByNode.get(b.source) === communityByNode.get(b.target) ? 1 : 0;
    const visualScoreA = distanceA - aAsserted * 0.34 - sameCommunityA * 0.16 - a.confidence * 0.08;
    const visualScoreB = distanceB - bAsserted * 0.34 - sameCommunityB * 0.16 - b.confidence * 0.08;
    return visualScoreA - visualScoreB || bAsserted - aAsserted || b.confidence - a.confidence || a.id.localeCompare(b.id);
  });
  const degreeCap = patternId === "halo" ? 3 : 2;
  const select = (edge: AtlasVisualModel["edges"][number]): boolean => {
    if (selected.size >= budget || selected.has(edge.id)) return false;
    const sourceDegree = degree.get(edge.source) ?? 0;
    const targetDegree = degree.get(edge.target) ?? 0;
    if (sourceDegree >= degreeCap || targetDegree >= degreeCap) return false;
    selected.add(edge.id);
    degree.set(edge.source, sourceDegree + 1);
    degree.set(edge.target, targetDegree + 1);
    return true;
  };

  // Halo needs genuine chords, not only neighbour-to-neighbour perimeter
  // arcs. Time Rings similarly reserves a few authored long-range memories;
  // the rest of each budget still favours locally legible relationships.
  if (patternId === "halo") {
    const chordTarget = Math.round(budget * 0.46);
    const chords = [...model.edges]
      .filter((edge) =>
        communityByNode.get(edge.source) !== communityByNode.get(edge.target)
        && (distanceByEdge.get(edge.id) ?? 0) > 0.48,
      )
      .sort((a, b) => {
        const assertedA = a.reasons.includes("asserted") ? 1 : 0;
        const assertedB = b.reasons.includes("asserted") ? 1 : 0;
        return assertedB - assertedA
          || b.confidence - a.confidence
          || (distanceByEdge.get(b.id) ?? 0) - (distanceByEdge.get(a.id) ?? 0)
          || a.id.localeCompare(b.id);
      });
    for (const edge of chords) {
      select(edge);
      if (selected.size >= chordTarget) break;
    }
  } else if (patternId === "timeline") {
    const storyTarget = Math.min(9, Math.round(budget * 0.34));
    const stories = [...model.edges]
      .filter((edge) => edge.reasons.includes("asserted") || edge.tier === "essential")
      .sort((a, b) => b.confidence - a.confidence || (distanceByEdge.get(b.id) ?? 0) - (distanceByEdge.get(a.id) ?? 0) || a.id.localeCompare(b.id));
    for (const edge of stories) {
      select(edge);
      if (selected.size >= storyTarget) break;
    }
  }

  for (const edge of sorted) {
    if (selected.size >= budget) break;
    select(edge);
  }
  return selected;
}

/** A true relationship-backed arbor. Each community becomes one tidy tree;
 * only the tree's real evidence edges are returned for the Featured view, so
 * the branches line up with the geometry instead of cutting across it. */
function dendriteScene(model: AtlasVisualModel): {
  positions: AtlasPositions;
  edgeIds: ReadonlySet<string>;
} {
  const positions: AtlasPositions = {};
  const treeEdgeIds = new Set<string>();
  const communities = [...model.communities].sort(
    (a, b) => b.size - a.size || a.id - b.id,
  );
  const major = communities.filter((community) => community.size >= 4).slice(0, 8);
  if (major.length === 0 && communities[0]) major.push(communities[0]);
  const majorIds = new Set(major.map((community) => community.id));
  const totalWeight = Math.max(1, major.reduce((sum, community) => sum + Math.sqrt(community.size), 0));
  const edgesByNode = new Map<string, typeof model.edges>();
  for (const node of model.nodes) edgesByNode.set(node.id, []);
  for (const edge of model.edges) {
    edgesByNode.get(edge.source)?.push(edge);
    edgesByNode.get(edge.target)?.push(edge);
  }
  for (const list of edgesByNode.values()) {
    list.sort((a, b) => {
      const essentialA = a.tier === "essential" ? 1 : 0;
      const essentialB = b.tier === "essential" ? 1 : 0;
      return essentialB - essentialA || b.confidence - a.confidence || a.id.localeCompare(b.id);
    });
  }

  const gap = major.length > 1 ? 0.12 : 0.24;
  const availableAngle = Math.PI * 2 - gap * major.length;
  let angleCursor = -Math.PI / 2;
  const rankById = new Map(model.nodes.map((node) => [node.id, node.labelRank]));
  for (const community of major) {
    const sectorWidth = availableAngle * (Math.sqrt(community.size) / totalWeight);
    const sectorStart = angleCursor + gap / 2;
    const sectorEnd = sectorStart + sectorWidth;
    const sectorCenter = (sectorStart + sectorEnd) / 2;
    angleCursor += sectorWidth + gap;
    const members = new Set(community.nodeIds);
    const root = community.anchorNodeId;
    const parent = new Map<string, string>();
    const parentEdge = new Map<string, string>();
    const depth = new Map<string, number>([[root, 0]]);
    const queue = [root];
    for (let index = 0; index < queue.length; index += 1) {
      const nodeId = queue[index]!;
      for (const edge of edgesByNode.get(nodeId) ?? []) {
        const neighbour = edge.source === nodeId ? edge.target : edge.source;
        if (!members.has(neighbour) || depth.has(neighbour)) continue;
        parent.set(neighbour, nodeId);
        parentEdge.set(neighbour, edge.id);
        depth.set(neighbour, (depth.get(nodeId) ?? 0) + 1);
        queue.push(neighbour);
      }
    }
    // Defensive fallback for disconnected evidence components: they keep a
    // deterministic seat in the branch but never gain an invented line.
    for (const nodeId of community.nodeIds) {
      if (depth.has(nodeId)) continue;
      parent.set(nodeId, root);
      depth.set(nodeId, 1);
      queue.push(nodeId);
    }

    const children = new Map<string, string[]>();
    for (const nodeId of community.nodeIds) children.set(nodeId, []);
    for (const [child, parentId] of parent) children.get(parentId)?.push(child);
    for (const list of children.values()) {
      list.sort((a, b) => (rankById.get(a) ?? 0) - (rankById.get(b) ?? 0) || a.localeCompare(b));
    }

    const angleById = new Map<string, number>();
    let leafIndex = 0;
    const leafCount = Math.max(1, community.nodeIds.filter((id) => (children.get(id)?.length ?? 0) === 0).length);
    const assignAngle = (nodeId: string): number => {
      const childIds = children.get(nodeId) ?? [];
      if (childIds.length === 0) {
        const t = leafCount === 1 ? 0.5 : leafIndex / (leafCount - 1);
        leafIndex += 1;
        const angle = sectorStart + sectorWidth * (0.1 + t * 0.8);
        angleById.set(nodeId, angle);
        return angle;
      }
      const childAngles = childIds.map(assignAngle);
      const angle = childAngles.reduce((sum, childAngle) => sum + childAngle, 0) / childAngles.length;
      angleById.set(nodeId, angle);
      return angle;
    };
    assignAngle(root);
    const maxDepth = Math.max(1, ...depth.values());
    for (const nodeId of community.nodeIds) {
      const nodeDepth = depth.get(nodeId) ?? 0;
      const depthRatio = nodeDepth / maxDepth;
      const angle = angleById.get(nodeId) ?? sectorCenter;
      const radius = 0.16 + Math.pow(depthRatio, 0.82) * 0.92;
      positions[nodeId] = {
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
      };
      const edgeId = parentEdge.get(nodeId);
      if (edgeId) treeEdgeIds.add(edgeId);
    }
  }

  const dustNodes = model.nodes
    .filter((node) => node.communityId == null || !majorIds.has(node.communityId))
    .sort((a, b) => a.labelRank - b.labelRank || a.id.localeCompare(b.id));
  dustNodes.forEach((node, index) => {
    const angle = index * Math.PI * (3 - Math.sqrt(5));
    const radius = 1.18 + (index % 4) * 0.045 + Math.floor(index / 48) * 0.07;
    positions[node.id] = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  });
  return { positions, edgeIds: treeEdgeIds };
}

function atmosphereBackground(patternId: string, colors: ThemeColors, alpha: number): string {
  switch (patternId) {
    case "timeline":
      return [
        `repeating-radial-gradient(circle at 50% 50%, transparent 0 9%, ${colorWithAlpha(colors.border, 0.025)} 9.2%, transparent 9.5% 18%)`,
        `radial-gradient(circle at 50% 50%, ${colorWithAlpha(colors.accent, alpha)} 0%, transparent 48%)`,
      ].join(", ");
    case "halo":
      return [
        `radial-gradient(circle at 50% 50%, transparent 0 43%, ${colorWithAlpha(colors.accent, 0.17)} 43.5%, transparent 44.2% 48%, ${colorWithAlpha(colors.positive, 0.07)} 48.3%, transparent 49%)`,
        `radial-gradient(circle at 50% 50%, ${colorWithAlpha(colors.accent, alpha * 0.22)} 0%, transparent 54%)`,
      ].join(", ");
    case "globe":
      return [
        `radial-gradient(circle at 52% 46%, ${colorWithAlpha(colors.text, 0.035)} 0 8%, transparent 36%)`,
        `radial-gradient(circle at 50% 50%, ${colorWithAlpha(colors.accent, alpha * 0.42)} 0 34%, ${colorWithAlpha(colors.positive, alpha * 0.2)} 46%, transparent 61%)`,
        `radial-gradient(circle at 50% 50%, transparent 0 48%, ${colorWithAlpha(colors.accent, 0.13)} 48.4%, transparent 49.2%)`,
      ].join(", ");
    case "flow":
      return [
        `repeating-linear-gradient(0deg, transparent 0 12%, ${colorWithAlpha(colors.border, 0.06)} 12.2%, transparent 12.5% 24%)`,
        `linear-gradient(90deg, transparent, ${colorWithAlpha(colors.accent, alpha * 0.7)}, transparent)`,
      ].join(", ");
    case "constellation":
      return [
        `radial-gradient(circle at 32% 38%, ${colorWithAlpha(colors.accent, alpha)} 0%, transparent 27%)`,
        `radial-gradient(circle at 68% 60%, ${colorWithAlpha(colors.positive, alpha * 0.65)} 0%, transparent 31%)`,
      ].join(", ");
    case "dendrite":
      return [
        `radial-gradient(circle at 50% 50%, ${colorWithAlpha(colors.accent, alpha * 0.7)} 0%, transparent 42%)`,
        `repeating-conic-gradient(from -90deg at 50% 50%, ${colorWithAlpha(colors.positive, alpha * 0.1)} 0deg 0.5deg, transparent 0.5deg 24deg)`,
      ].join(", ");
    default:
      return `radial-gradient(circle at 50% 50%, ${colorWithAlpha(colors.accent, alpha * 0.65)} 0%, transparent 52%)`;
  }
}

function nodeStyleScale(patternId: string, anchor: boolean): number {
  const ordinary = patternId === "halo"
    ? 0.88
    : patternId === "flow"
      ? 0.92
      : patternId === "timeline"
        ? 0.8
        : patternId === "globe"
          ? 0.8
          : patternId === "constellation"
            ? 0.92
            : 0.84;
  return anchor ? ordinary * 1.55 : ordinary;
}

function semanticTierForRatio(ratio: number): SemanticTier {
  if (ratio >= 0.82) return "overview";
  if (ratio >= 0.3) return "medium";
  return "detail";
}

function positionRecord(positions: readonly AtlasPosition[]): AtlasPositions {
  const result: AtlasPositions = {};
  for (const position of positions) {
    if (Number.isFinite(position.x) && Number.isFinite(position.y)) {
      result[position.id] = { x: position.x, y: position.y };
    }
  }
  return result;
}

function initialPositions(nodes: readonly { id: string; degree: number }[]): AtlasPositions {
  return positionRecord(
    deterministicAtlasSeed(nodes.map((node) => ({ id: node.id, size: 1 + Math.sqrt(node.degree) }))),
  );
}

export const AtlasGraph = forwardRef<AtlasGraphHandle, AtlasGraphProps>(function AtlasGraph(
  {
    brainId,
    nodes,
    patternId,
    model,
    palette,
    folderColors,
    nodeSizeScale,
    linkThicknessScale,
    lite,
    searchMatches,
    visibleNodeIds,
    showOrphans,
    onNodeHover,
    onNodeClick,
    onRuntimeError,
  },
  forwardedRef,
) {
  const rendererContainerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<Sigma<AtlasNodeAttributes, AtlasEdgeAttributes, AtlasGraphAttributes> | null>(null);
  const pulseRafRef = useRef<number | null>(null);
  const runtimeErrorReportedRef = useRef(false);
  const [rendererReady, setRendererReady] = useState(false);
  const appTheme = useSettingsStore((state) => state.theme);
  // Read-only here: the toolbar owns these controls for every preset now.
  // AtlasGraph used to render its own duplicate pair inside the Engine panel.
  const labelMode = useGraphSettingsStore((state) => state.labelMode);
  const connectionMode = useGraphSettingsStore((state) => state.connectionMode);

  const sourceNodesById = useMemo(
    () => new Map(nodes.map((node) => [node.id, node])),
    [nodes],
  );
  const adjacency = useMemo(() => {
    const result = new Map<string, Set<string>>();
    for (const node of model.nodes) result.set(node.id, new Set());
    for (const edge of model.edges) {
      result.get(edge.source)?.add(edge.target);
      result.get(edge.target)?.add(edge.source);
    }
    return result;
  }, [model.nodes, model.edges]);
  const pattern = ATLAS_BUILT_IN_PATTERNS.find((item) => item.id === patternId)
    ?? atlasBuiltInPattern("timeline");
  const dendrite = useMemo(() => dendriteScene(model), [model]);
  const colors = useMemo<ThemeColors>(() => ({
    background: appTheme.bg,
    text: appTheme.text,
    dim: appTheme.textDim,
    border: appTheme.border,
    accent: appTheme.accent,
    positive: appTheme.positive,
    negative: appTheme.negative,
    warning: appTheme.accent,
  }), [appTheme]);
  // Every built-in composition generates its own deterministic geometry from
  // this seed; none simulates physics. (A ForceAtlas worker + IndexedDB layout
  // cache used to sit behind `basePositions` here, but only the legacy
  // identity/spiral/brain-warp transforms consumed them, and those were only
  // reachable by hand-authoring a JSON pattern file -- removed 2026-07.)
  const seededPositions = useMemo(() => initialPositions(model.nodes), [model.nodes]);
  const displayPositions = useMemo(
    () => pattern.transform.type === "dendrite"
      ? dendrite.positions
      : transformAtlasPositions(pattern, model.nodes, seededPositions),
    [pattern, model.nodes, seededPositions, dendrite.positions],
  );
  const featuredEdgeIds = useMemo(
    () => pattern.transform.type === "dendrite"
      ? dendrite.edgeIds
      : featuredEdges(model, displayPositions, pattern.id),
    [dendrite.edgeIds, displayPositions, model, pattern.id, pattern.transform.type],
  );

  const interactionRef = useRef<InteractionState>({
    tier: "overview",
    hoveredNodeId: null,
    pulseNodeId: null,
    pulseStartedAt: 0,
    searchMatches,
    visibleNodeIds,
    showOrphans,
    edgeOpacity: pattern.appearance.edgeOpacity,
    labelDensity: pattern.appearance.labelDensity,
    labelMode,
    connectionMode,
    featuredEdgeIds,
    patternId: pattern.id,
  });

  const reportRuntimeError = useCallback((error: Error) => {
    if (runtimeErrorReportedRef.current) return;
    runtimeErrorReportedRef.current = true;
    onRuntimeError(error);
  }, [onRuntimeError]);

  const graph = useMemo(() => {
    const next = new Graph<AtlasNodeAttributes, AtlasEdgeAttributes, AtlasGraphAttributes>({
      type: "undirected",
      multi: false,
      allowSelfLoops: false,
    });
    next.replaceAttributes({ brainId: brainId || "default" });
    const communityFolder = new Map(
      model.communities.map((community) => [community.id, community.dominantFolder]),
    );
    const anchorNodeIds = new Set(
      model.communities
        .filter((community) => community.size >= 4)
        .map((community) => community.anchorNodeId),
    );

    for (const node of model.nodes) {
      const position = seededPositions[node.id] ?? { x: 0, y: 0 };
      const folder = node.communityId == null
        ? (node.folder ?? "")
        : (communityFolder.get(node.communityId) ?? node.folder ?? "");
      const folderTint = folderColor(folder, palette, folderColors);
      const communityPalette = PALETTES[palette];
      const color = folderColors[folder]
        ?? (node.communityId == null
          ? folderTint
          : communityPalette[Math.abs(node.communityId) % communityPalette.length]!);
      const isFresh = node.state === "fresh" || node.state === "active";
      const isConnected = node.state === "connected";
      const anchor = anchorNodeIds.has(node.id);
      const borderColor = anchor
        ? colors.text
        : isFresh
          ? colors.accent
          : isConnected
            ? colors.positive
            : colors.border;
      const baseSize = nodeSize(node) * nodeSizeScale;
      next.addNode(node.id, {
        x: position.x,
        y: position.y,
        size: baseSize,
        baseSize,
        color,
        dimColor: colorWithAlpha(color, 0.2),
        borderColor,
        dimBorderColor: colorWithAlpha(borderColor, 0.2),
        label: node.title || node.id,
        type: "border",
        hidden: false,
        forceLabel: false,
        highlighted: false,
        zIndex: 0,
        labelRank: node.labelRank,
        communityId: node.communityId ?? -1,
        orphan: node.orphan,
        anchor,
      });
    }

    for (const edge of model.edges) {
      const relationColor = edgeThemeColor(edge.primaryType, colors);
      const baseColor = relationColor === colors.dim
        ? next.getNodeAttribute(edge.source, "color")
        : relationColor;
      const tierWeight = edge.tier === "essential" ? 0.5 : edge.tier === "backbone" ? 0.34 : 0.2;
      const baseSize = Math.max(0.05, tierWeight * (0.28 + edge.confidence * 0.3) * linkThicknessScale);
      const curveSign = edge.id.charCodeAt(edge.id.length - 1) % 2 === 0 ? 1 : -1;
      next.addEdgeWithKey(edge.id, edge.source, edge.target, {
        size: baseSize,
        baseSize,
        color: blendColor(colors.background, baseColor, 0.12),
        baseColor,
        type: "curved",
        curvature: curveSign * 0.16,
        hidden: false,
        forceLabel: false,
        label: edge.primaryType,
        zIndex: edge.tier === "essential" ? 2 : edge.tier === "backbone" ? 1 : 0,
        tier: edge.tier,
        sourceId: edge.source,
        targetId: edge.target,
      });
    }
    return next;
  }, [brainId, colors, folderColors, linkThicknessScale, model, nodeSizeScale, palette, seededPositions]);

  useEffect(() => {
    const state = interactionRef.current;
    state.searchMatches = searchMatches;
    state.visibleNodeIds = visibleNodeIds;
    state.showOrphans = showOrphans;
    state.edgeOpacity = pattern.appearance.edgeOpacity;
    state.labelDensity = pattern.appearance.labelDensity;
    state.labelMode = labelMode;
    state.connectionMode = connectionMode;
    state.featuredEdgeIds = featuredEdgeIds;
    state.patternId = pattern.id;
    const renderer = rendererRef.current;
    if (renderer) {
      renderer.setSetting("renderLabels", labelMode !== "off");
      renderer.setSetting(
        "labelDensity",
        labelMode === "all" ? 2 : Math.max(0.15, pattern.appearance.labelDensity),
      );
      renderer.setSetting("labelRenderedSizeThreshold", labelMode === "key" ? 1_000 : 0);
      renderer.scheduleRefresh();
    }
  }, [
    connectionMode,
    featuredEdgeIds,
    labelMode,
    pattern.appearance.edgeOpacity,
    pattern.appearance.labelDensity,
    pattern.id,
    searchMatches,
    showOrphans,
    visibleNodeIds,
  ]);

  useEffect(() => {
    const container = rendererContainerRef.current;
    if (!container || graph.order === 0) return;
    let renderer: Sigma<AtlasNodeAttributes, AtlasEdgeAttributes, AtlasGraphAttributes> | null = null;
    const contextCanvases: HTMLCanvasElement[] = [];
    const onContextLost = (event: Event): void => {
      event.preventDefault();
      reportRuntimeError(new Error("The Atlas WebGL context was lost"));
    };

    try {
      renderer = new Sigma<AtlasNodeAttributes, AtlasEdgeAttributes, AtlasGraphAttributes>(graph, container, {
        defaultNodeType: "border",
        nodeProgramClasses: { border: AtlasNodeProgram },
        defaultEdgeType: "curved",
        edgeProgramClasses: { curved: AtlasEdgeCurveProgram },
        hideEdgesOnMove: lite || graph.size > 2_500,
        hideLabelsOnMove: true,
        renderLabels: interactionRef.current.labelMode !== "off",
        renderEdgeLabels: false,
        enableEdgeEvents: false,
        labelFont: "Geist, sans-serif",
        labelSize: 12,
        labelWeight: "500",
        labelColor: { color: colors.text },
        labelDensity: interactionRef.current.labelMode === "all"
          ? 2
          : Math.max(0.15, interactionRef.current.labelDensity),
        labelGridCellSize: 92,
        labelRenderedSizeThreshold: interactionRef.current.labelMode === "key" ? 1_000 : 0,
        defaultDrawNodeHover: (context, data, settings) => {
          if (!data.label) return;
          const label = data.label;
          context.save();
          context.font = `${settings.labelWeight} ${settings.labelSize}px ${settings.labelFont}`;
          const width = context.measureText(label).width + 14;
          const height = settings.labelSize + 10;
          const x = data.x + data.size + 7;
          const y = data.y - height / 2;
          context.fillStyle = colorWithAlpha(colors.background, 0.94);
          context.strokeStyle = colors.border;
          context.lineWidth = 1;
          context.beginPath();
          context.rect(x, y, width, height);
          context.fill();
          context.stroke();
          context.fillStyle = colors.text;
          context.textBaseline = "middle";
          context.fillText(label, x + 7, data.y);
          context.restore();
        },
        stagePadding: 34,
        zIndex: true,
        minCameraRatio: 0.025,
        maxCameraRatio: 8,
        nodeReducer: (nodeId, data): Partial<NodeDisplayData> => {
          const state = interactionRef.current;
          const visibleInTime = state.visibleNodeIds?.has(nodeId) ?? true;
          const hidden = !visibleInTime || (!state.showOrphans && data.orphan);
          const focusId = state.hoveredNodeId;
          const focusVisible = !focusId || nodeId === focusId || adjacency.get(focusId)?.has(nodeId) === true;
          const searchVisible = state.searchMatches?.has(nodeId) ?? true;
          const dimmed = !focusVisible || !searchVisible;
          const showLabel = state.labelMode === "all"
            ? true
            : state.labelMode === "key" && data.anchor;
          let size = data.baseSize * nodeStyleScale(state.patternId, data.anchor);
          if (state.pulseNodeId === nodeId) {
            const elapsed = performance.now() - state.pulseStartedAt;
            if (elapsed >= 0 && elapsed < 1_250) {
              size *= 1 + Math.sin((elapsed / 1_250) * Math.PI) * 0.65;
            }
          }
          return {
            ...data,
            hidden,
            size: dimmed ? size * 0.72 : size,
            color: dimmed ? data.dimColor : data.color,
            forceLabel: !hidden && showLabel,
            highlighted: !hidden && (nodeId === focusId || state.pulseNodeId === nodeId),
            zIndex: nodeId === focusId || state.pulseNodeId === nodeId ? 10 : data.zIndex,
          };
        },
        edgeReducer: (edgeId, data): Partial<EdgeDisplayData> & { curvature: number } => {
          const state = interactionRef.current;
          const endpointsVisible =
            (state.visibleNodeIds?.has(data.sourceId) ?? true) &&
            (state.visibleNodeIds?.has(data.targetId) ?? true);
          const focusId = state.hoveredNodeId;
          const touchesFocus = focusId == null || data.sourceId === focusId || data.targetId === focusId;
          const searchVisible =
            (state.searchMatches?.has(data.sourceId) ?? true) &&
            (state.searchMatches?.has(data.targetId) ?? true);
          const allowedByMode = state.connectionMode === "all"
            || (state.connectionMode === "featured" && state.featuredEdgeIds.has(edgeId));
          const hidden = state.connectionMode === "off"
            || !endpointsVisible
            || !allowedByMode
            || !touchesFocus;
          const tierStrength = data.tier === "essential"
            ? 0.23
            : data.tier === "backbone"
              ? (state.tier === "overview" ? 0.14 : 0.18)
              : state.connectionMode === "all" ? 0.055 : 0.1;
          const styleBoost = state.patternId === "halo"
            ? 1.55
            : state.patternId === "timeline"
              ? 1.32
              : state.patternId === "flow"
                ? 1.2
                : 1;
          const strength = tierStrength * styleBoost * (0.72 + state.edgeOpacity) * (searchVisible ? 1 : 0.14) * (focusId ? 3.2 : 1);
          const curveAmount = state.patternId === "halo"
            ? 0.34
            : state.patternId === "globe"
              ? 0.26
              : state.patternId === "timeline"
                ? 0.22
                : state.patternId === "flow"
                  ? 0.18
                  : state.patternId === "dendrite"
                    ? 0.11
                    : 0.14;
          const curveSign = edgeId.charCodeAt(edgeId.length - 1) % 2 === 0 ? 1 : -1;
          return {
            ...data,
            hidden,
            size: focusId ? data.baseSize * 1.5 : data.baseSize,
            color: blendColor(colors.background, data.baseColor, Math.min(0.62, strength)),
            curvature: curveSign * curveAmount,
            zIndex: focusId ? 12 : data.zIndex,
          };
        },
      });
      rendererRef.current = renderer;
      setRendererReady(true);

      const enterNode = ({ node }: { node: string }): void => {
        interactionRef.current.hoveredNodeId = node;
        renderer?.scheduleRefresh();
        const source = sourceNodesById.get(node);
        if (source) onNodeHover(source);
      };
      const leaveNode = (): void => {
        interactionRef.current.hoveredNodeId = null;
        renderer?.scheduleRefresh();
        onNodeHover(null);
      };
      const clickNode = ({ node }: { node: string }): void => {
        const source = sourceNodesById.get(node);
        if (source) onNodeClick(source);
      };
      const camera = renderer.getCamera();
      const cameraUpdated = (state: CameraState): void => {
        const nextTier = semanticTierForRatio(state.ratio);
        if (nextTier === interactionRef.current.tier) return;
        interactionRef.current.tier = nextTier;
        renderer?.scheduleRefresh();
      };
      interactionRef.current.tier = semanticTierForRatio(camera.ratio);
      renderer.on("enterNode", enterNode);
      renderer.on("leaveNode", leaveNode);
      renderer.on("clickNode", clickNode);
      camera.on("updated", cameraUpdated);

      for (const canvas of Object.values(renderer.getCanvases())) {
        canvas.addEventListener("webglcontextlost", onContextLost);
        contextCanvases.push(canvas);
      }

      return () => {
        for (const canvas of contextCanvases) {
          canvas.removeEventListener("webglcontextlost", onContextLost);
        }
        camera.off("updated", cameraUpdated);
        renderer?.off("enterNode", enterNode);
        renderer?.off("leaveNode", leaveNode);
        renderer?.off("clickNode", clickNode);
        rendererRef.current = null;
        renderer?.kill();
        setRendererReady(false);
      };
    } catch (error: unknown) {
      renderer?.kill();
      reportRuntimeError(error instanceof Error ? error : new Error("Atlas failed to start"));
      return;
    }
  }, [adjacency, colors.background, colors.border, colors.text, graph, lite, onNodeClick, onNodeHover, reportRuntimeError, sourceNodesById]);

  useEffect(() => {
    for (const nodeId of graph.nodes()) {
      const position = displayPositions[nodeId];
      if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) continue;
      graph.mergeNodeAttributes(nodeId, { x: position.x, y: position.y });
    }
    rendererRef.current?.scheduleRefresh();
  }, [displayPositions, graph]);

  const focusNodes = useCallback((nodeIds: readonly string[]): void => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const points = nodeIds
      .map((nodeId) => renderer.getNodeDisplayData(nodeId))
      .filter((point): point is NodeDisplayData => point != null && !point.hidden);
    if (points.length === 0) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const point of points) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
    }
    const ratio = Math.max(0.08, Math.min(1.4, Math.max(maxX - minX, maxY - minY) * 1.8));
    void renderer.getCamera().animate(
      { x: (minX + maxX) / 2, y: (minY + maxY) / 2, ratio },
      { duration: 460, easing: "quadraticInOut" },
    );
  }, []);

  useImperativeHandle(forwardedRef, () => ({
    zoomIn: () => { void rendererRef.current?.getCamera().animatedZoom({ duration: 220 }); },
    zoomOut: () => { void rendererRef.current?.getCamera().animatedUnzoom({ duration: 220 }); },
    fit: () => { void rendererRef.current?.getCamera().animatedReset({ duration: 380 }); },
    focusNode: (nodeId) => focusNodes([nodeId]),
    fitNodes: focusNodes,
    pulse: (nodeId) => {
      interactionRef.current.pulseNodeId = nodeId;
      interactionRef.current.pulseStartedAt = performance.now();
      if (pulseRafRef.current != null) cancelAnimationFrame(pulseRafRef.current);
      const animate = (): void => {
        const elapsed = performance.now() - interactionRef.current.pulseStartedAt;
        rendererRef.current?.scheduleRefresh();
        if (elapsed < 1_250) pulseRafRef.current = requestAnimationFrame(animate);
        else {
          interactionRef.current.pulseNodeId = null;
          pulseRafRef.current = null;
          rendererRef.current?.scheduleRefresh();
        }
      };
      pulseRafRef.current = requestAnimationFrame(animate);
    },
    exportPng: async () => {
      const renderer = rendererRef.current;
      if (!renderer) return null;
      try {
        return await toBlob(renderer as unknown as Sigma, {
          format: "png",
          fileName: "neurovault-atlas",
          backgroundColor: colors.background,
          cameraState: renderer.getCamera().getState(),
        });
      } catch {
        return null;
      }
    },
  }), [colors.background, focusNodes]);

  useEffect(() => () => {
    if (pulseRafRef.current != null) cancelAnimationFrame(pulseRafRef.current);
  }, []);

  const atmosphereAlpha = 0.04 + pattern.appearance.atmosphere * 0.12;
  const shownRelationshipCount = connectionMode === "off"
    ? 0
    : connectionMode === "featured"
      ? featuredEdgeIds.size
      : model.edges.length;

  return (
    <div className="absolute inset-0 overflow-hidden" aria-label="Graph Engine knowledge visualization">
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ background: atmosphereBackground(pattern.id, colors, atmosphereAlpha) }}
      />
      {pattern.id === "flow" && (
        <svg
          className="absolute inset-0 h-full w-full pointer-events-none"
          viewBox="0 0 1000 600"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {[
            "M -30 68 C 170 28 315 112 505 68 S 830 22 1030 68",
            "M -30 184 C 175 132 322 234 510 184 S 824 128 1030 184",
            "M -30 300 C 180 246 330 352 515 300 S 820 244 1030 300",
            "M -30 416 C 170 364 318 468 508 416 S 828 360 1030 416",
            "M -30 532 C 176 482 326 580 512 532 S 822 478 1030 532",
          ].map((path, index) => (
            <g key={path}>
              <path
                d={path}
                fill="none"
                stroke={colorWithAlpha(index % 2 === 0 ? colors.accent : colors.positive, 0.035)}
                strokeWidth="18"
                vectorEffect="non-scaling-stroke"
                style={{ filter: "blur(9px)" }}
              />
              <path
                d={path}
                fill="none"
                stroke={colorWithAlpha(index % 2 === 0 ? colors.accent : colors.positive, 0.11)}
                strokeWidth="0.8"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ))}
        </svg>
      )}
      <div ref={rendererContainerRef} className="absolute inset-0" />

      {/* A 316px card sat here naming the composition and repeating the Names /
          Connections controls the toolbar already owned — the duplication that
          made "Lines" and "Connections" two words for one setting. The preset
          bar's active pill names the view and carries the same description as
          its tooltip, so the card was restating what the control already said.

          The composition gallery lived here too — a second, competing view picker
          that only existed once you had found the "Open Graph Engine" button.
          It IS the preset bar now, in the toolbar, alongside 2D and 3D.
          Dropping to bottom-4: it no longer has to clear the gallery. */}
      <div
        className="absolute bottom-4 right-4 pointer-events-none text-[10px] font-[Geist,sans-serif] tabular-nums"
        style={{ color: "var(--nv-text-dim)" }}
      >
        {model.nodes.length.toLocaleString()} memories · {shownRelationshipCount.toLocaleString()} shown
        {shownRelationshipCount !== model.edges.length ? ` · ${model.edges.length.toLocaleString()} total` : ""}
        {!rendererReady && model.nodes.length > 0 ? " · starting WebGL" : ""}
      </div>
    </div>
  );
});
