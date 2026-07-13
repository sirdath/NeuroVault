/**
 * Pure, deterministic scene builder for the GPU Atlas graph.
 *
 * The backend can return thousands of reciprocal and overlapping relation
 * rows. Rendering all of them with equal weight creates a hairball even when
 * the renderer is fast. This module collapses those rows into undirected
 * visual relations, preserves authored/typed links, and selects a sparse
 * semantic backbone for layout and overview rendering.
 *
 * No browser or renderer dependencies belong here. The arrays are safe to
 * pass to a Web Worker and straightforward to test.
 */

import type { GraphData, GraphEdge, GraphNode } from "./api";
import { canonicalEdgeKey, edgeConfidence, louvain, pageRank } from "./graphMetrics";

export type AtlasEdgeTier = "essential" | "backbone" | "detail";
export type AtlasEdgeReason = "asserted" | "mutual-top-k" | "connectivity" | "detail";

export interface AtlasVisualRelation {
  type: string;
  similarity: number;
  confidence: number;
  forward: boolean;
  reverse: boolean;
}

export interface AtlasVisualEdge {
  id: string;
  source: string;
  target: string;
  tier: AtlasEdgeTier;
  reasons: AtlasEdgeReason[];
  primaryType: string;
  relations: AtlasVisualRelation[];
  confidence: number;
  maxSimilarity: number;
  reciprocal: boolean;
  weight: number;
}

export interface AtlasVisualNode extends GraphNode {
  degree: number;
  essentialDegree: number;
  importance: number;
  labelRank: number;
  communityId: number | null;
  orphan: boolean;
}

export interface AtlasVisualCommunity {
  id: number;
  nodeIds: string[];
  anchorNodeId: string;
  topNodeIds: string[];
  dominantFolder: string;
  size: number;
}

export interface AtlasVisualCommunityEdge {
  id: string;
  sourceCommunity: number;
  targetCommunity: number;
  edgeCount: number;
  essentialCount: number;
  maxConfidence: number;
}

export interface AtlasVisualDiagnostics {
  duplicateNodes: number;
  duplicateEdges: number;
  selfEdges: number;
  danglingEdges: number;
  invalidSimilarities: number;
}

export interface AtlasVisualModel {
  schemaVersion: 1;
  algorithmVersion: 1;
  fingerprint: string;
  nodes: AtlasVisualNode[];
  edges: AtlasVisualEdge[];
  communities: AtlasVisualCommunity[];
  communityEdges: AtlasVisualCommunityEdge[];
  diagnostics: AtlasVisualDiagnostics;
}

export interface AtlasVisualModelOptions {
  inferredTopK?: number;
}

const SCHEMA_VERSION = 1 as const;
const ALGORITHM_VERSION = 1 as const;
const DEFAULT_TOP_K = 3;
const INFERRED_TYPES = new Set(["semantic", "entity"]);

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

function pairKey(a: string, b: string): string {
  return JSON.stringify(a < b ? [a, b] : [b, a]);
}

function directedKey(from: string, to: string): string {
  return JSON.stringify([from, to]);
}

function fnv1a(payload: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function stableNodeSignature(node: GraphNode): string {
  return JSON.stringify([
    node.id,
    node.title,
    node.state,
    node.strength,
    node.access_count,
    node.folder ?? "",
    node.created_at ?? "",
    node.kind ?? "",
  ]);
}

class DisjointSet {
  private readonly parent = new Map<string, string>();

  constructor(ids: readonly string[]) {
    for (const id of ids) this.parent.set(id, id);
  }

  private find(id: string): string {
    const parent = this.parent.get(id);
    if (parent == null || parent === id) return id;
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }

  union(a: string, b: string): boolean {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return false;
    const [keep, move] = rootA < rootB ? [rootA, rootB] : [rootB, rootA];
    this.parent.set(move, keep);
    return true;
  }
}

interface RelationAccumulator {
  type: string;
  similarity: number;
  forward: boolean;
  reverse: boolean;
}

interface PairAccumulator {
  source: string;
  target: string;
  relations: Map<string, RelationAccumulator>;
}

function edgeRank(a: AtlasVisualEdge, b: AtlasVisualEdge): number {
  return (
    b.confidence - a.confidence ||
    b.maxSimilarity - a.maxSimilarity ||
    a.source.localeCompare(b.source) ||
    a.target.localeCompare(b.target) ||
    a.id.localeCompare(b.id)
  );
}

function modelFingerprint(
  nodes: readonly GraphNode[],
  edges: readonly AtlasVisualEdge[],
  inferredTopK: number,
): string {
  const payload = JSON.stringify({
    algorithmVersion: ALGORITHM_VERSION,
    inferredTopK,
    nodes: nodes.map((node) => node.id),
    edges: edges.map((edge) => [
      edge.source,
      edge.target,
      edge.tier,
      Math.round(edge.confidence * 10_000),
      edge.relations.map((relation) => [
        relation.type,
        Math.round(relation.similarity * 10_000),
        relation.forward,
        relation.reverse,
      ]),
    ]),
  });
  return `atlas-${nodes.length}-${edges.length}-${fnv1a(payload)}`;
}

export function buildAtlasVisualModel(
  input: GraphData,
  options: AtlasVisualModelOptions = {},
): AtlasVisualModel {
  const inferredTopK = Math.max(0, Math.min(8, Math.round(options.inferredTopK ?? DEFAULT_TOP_K)));
  const diagnostics: AtlasVisualDiagnostics = {
    duplicateNodes: 0,
    duplicateEdges: 0,
    selfEdges: 0,
    danglingEdges: 0,
    invalidSimilarities: 0,
  };

  // Resolve duplicate ids by a stable signature so shuffled input produces
  // byte-identical output.
  const nodeById = new Map<string, GraphNode>();
  for (const node of input.nodes) {
    if (!node.id) continue;
    const existing = nodeById.get(node.id);
    if (!existing) {
      nodeById.set(node.id, node);
      continue;
    }
    diagnostics.duplicateNodes += 1;
    if (stableNodeSignature(node) < stableNodeSignature(existing)) nodeById.set(node.id, node);
  }
  const baseNodes = [...nodeById.values()].sort((a, b) => a.id.localeCompare(b.id));
  const knownIds = new Set(baseNodes.map((node) => node.id));

  const directedSeen = new Set<string>();
  for (const edge of input.edges) {
    if (knownIds.has(edge.from) && knownIds.has(edge.to) && edge.from !== edge.to) {
      directedSeen.add(directedKey(edge.from, edge.to));
    }
  }
  const reciprocalPairs = new Set<string>();
  for (const edge of input.edges) {
    if (directedSeen.has(directedKey(edge.to, edge.from))) {
      reciprocalPairs.add(pairKey(edge.from, edge.to));
    }
  }

  const pairs = new Map<string, PairAccumulator>();
  for (const raw of input.edges) {
    if (!knownIds.has(raw.from) || !knownIds.has(raw.to)) {
      diagnostics.danglingEdges += 1;
      continue;
    }
    if (raw.from === raw.to) {
      diagnostics.selfEdges += 1;
      continue;
    }
    const [source, target] = raw.from < raw.to ? [raw.from, raw.to] : [raw.to, raw.from];
    const key = pairKey(source, target);
    let pair = pairs.get(key);
    if (!pair) {
      pair = { source, target, relations: new Map() };
      pairs.set(key, pair);
    }

    const finite = Number.isFinite(raw.similarity);
    if (!finite || raw.similarity < 0 || raw.similarity > 1) diagnostics.invalidSimilarities += 1;
    const similarity = finite ? clamp01(raw.similarity) : 0;
    const direction = raw.from === source ? "forward" : "reverse";
    const relationKey = JSON.stringify([raw.link_type, direction]);
    const existing = pair.relations.get(relationKey);
    if (existing) {
      diagnostics.duplicateEdges += 1;
      existing.similarity = Math.max(existing.similarity, similarity);
    } else {
      pair.relations.set(relationKey, {
        type: raw.link_type || "unknown",
        similarity,
        forward: direction === "forward",
        reverse: direction === "reverse",
      });
    }
  }

  const visualEdges: AtlasVisualEdge[] = [...pairs.values()]
    .sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target))
    .map((pair, index) => {
      const key = pairKey(pair.source, pair.target);
      const bidi = reciprocalPairs.has(key)
        ? new Set([canonicalEdgeKey(pair.source, pair.target)])
        : new Set<string>();
      const relationByType = new Map<string, AtlasVisualRelation>();
      for (const raw of [...pair.relations.values()].sort((a, b) => a.type.localeCompare(b.type))) {
        const current = relationByType.get(raw.type);
        const confidence = edgeConfidence(
          {
            from: pair.source,
            to: pair.target,
            similarity: raw.similarity,
            link_type: raw.type,
          },
          { bidi },
        );
        if (current) {
          current.similarity = Math.max(current.similarity, raw.similarity);
          current.confidence = Math.max(current.confidence, confidence);
          current.forward ||= raw.forward;
          current.reverse ||= raw.reverse;
        } else {
          relationByType.set(raw.type, {
            type: raw.type,
            similarity: raw.similarity,
            confidence,
            forward: raw.forward,
            reverse: raw.reverse,
          });
        }
      }
      const relations = [...relationByType.values()].sort((a, b) => {
        const inferredA = INFERRED_TYPES.has(a.type) ? 1 : 0;
        const inferredB = INFERRED_TYPES.has(b.type) ? 1 : 0;
        return inferredA - inferredB || b.confidence - a.confidence || a.type.localeCompare(b.type);
      });
      const primary = relations[0];
      const essential = relations.some((relation) => !INFERRED_TYPES.has(relation.type));
      const confidence = Math.max(0, ...relations.map((relation) => relation.confidence));
      const maxSimilarity = Math.max(0, ...relations.map((relation) => relation.similarity));
      return {
        id: `atlas-edge-${index}-${fnv1a(key)}`,
        source: pair.source,
        target: pair.target,
        tier: essential ? "essential" : "detail",
        reasons: essential ? ["asserted"] : ["detail"],
        primaryType: primary?.type ?? "unknown",
        relations,
        confidence,
        maxSimilarity,
        reciprocal: reciprocalPairs.has(key),
        weight: (essential ? 1.4 : 0.7) + confidence * 1.6,
      } satisfies AtlasVisualEdge;
    });

  // Rank inferred edges separately for every endpoint. Only mutual top-K
  // choices enter the overview, keeping dense semantic brains bounded.
  const inferredByNode = new Map<string, AtlasVisualEdge[]>();
  for (const edge of visualEdges) {
    if (edge.tier === "essential") continue;
    for (const id of [edge.source, edge.target]) {
      const list = inferredByNode.get(id);
      if (list) list.push(edge);
      else inferredByNode.set(id, [edge]);
    }
  }
  const topByNode = new Map<string, Set<string>>();
  for (const [id, list] of inferredByNode) {
    list.sort(edgeRank);
    topByNode.set(id, new Set(list.slice(0, inferredTopK).map((edge) => edge.id)));
  }

  const components = new DisjointSet(baseNodes.map((node) => node.id));
  for (const edge of visualEdges) {
    if (edge.tier === "essential") components.union(edge.source, edge.target);
  }
  for (const edge of visualEdges) {
    if (edge.tier === "essential") continue;
    const mutual = topByNode.get(edge.source)?.has(edge.id) && topByNode.get(edge.target)?.has(edge.id);
    if (!mutual) continue;
    edge.tier = "backbone";
    edge.reasons = ["mutual-top-k"];
    components.union(edge.source, edge.target);
  }
  for (const edge of visualEdges.filter((item) => item.tier !== "essential").sort(edgeRank)) {
    if (!components.union(edge.source, edge.target)) continue;
    edge.tier = "backbone";
    edge.reasons = edge.reasons.includes("mutual-top-k")
      ? [...edge.reasons, "connectivity"]
      : ["connectivity"];
  }

  const layoutEdges = visualEdges.filter((edge) => edge.tier !== "detail");
  const metricEdges: GraphEdge[] = layoutEdges.map((edge) => ({
    from: edge.source,
    to: edge.target,
    similarity: edge.confidence,
    link_type: edge.primaryType,
  }));
  const communitiesByNode = louvain(baseNodes, metricEdges);
  const importanceByNode = pageRank(baseNodes, metricEdges);

  const degree = new Map<string, number>();
  const essentialDegree = new Map<string, number>();
  for (const edge of visualEdges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    if (edge.tier === "essential") {
      essentialDegree.set(edge.source, (essentialDegree.get(edge.source) ?? 0) + 1);
      essentialDegree.set(edge.target, (essentialDegree.get(edge.target) ?? 0) + 1);
    }
  }

  const labelOrder = [...baseNodes].sort((a, b) => {
    const importanceDiff = (importanceByNode.get(b.id) ?? 0) - (importanceByNode.get(a.id) ?? 0);
    return (
      importanceDiff ||
      (essentialDegree.get(b.id) ?? 0) - (essentialDegree.get(a.id) ?? 0) ||
      (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) ||
      a.id.localeCompare(b.id)
    );
  });
  const labelRank = new Map(labelOrder.map((node, index) => [node.id, index]));
  const visualNodes: AtlasVisualNode[] = baseNodes.map((node) => {
    const nodeDegree = degree.get(node.id) ?? 0;
    return {
      ...node,
      degree: nodeDegree,
      essentialDegree: essentialDegree.get(node.id) ?? 0,
      importance: importanceByNode.get(node.id) ?? 0,
      labelRank: labelRank.get(node.id) ?? baseNodes.length,
      communityId: nodeDegree === 0 ? null : (communitiesByNode.get(node.id) ?? null),
      orphan: nodeDegree === 0,
    };
  });

  const membersByCommunity = new Map<number, AtlasVisualNode[]>();
  for (const node of visualNodes) {
    if (node.communityId == null) continue;
    const list = membersByCommunity.get(node.communityId);
    if (list) list.push(node);
    else membersByCommunity.set(node.communityId, [node]);
  }
  const communities: AtlasVisualCommunity[] = [...membersByCommunity.entries()]
    .sort(([a], [b]) => a - b)
    .map(([id, members]) => {
      members.sort((a, b) => a.labelRank - b.labelRank || a.id.localeCompare(b.id));
      const folderCounts = new Map<string, number>();
      for (const member of members) {
        const folder = member.folder ?? "";
        folderCounts.set(folder, (folderCounts.get(folder) ?? 0) + 1);
      }
      const dominantFolder = [...folderCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "";
      return {
        id,
        nodeIds: members.map((member) => member.id).sort(),
        anchorNodeId: members[0]?.id ?? "",
        topNodeIds: members.slice(0, 5).map((member) => member.id),
        dominantFolder,
        size: members.length,
      };
    });

  const visualNodeById = new Map(visualNodes.map((node) => [node.id, node]));
  const crossCommunity = new Map<string, AtlasVisualCommunityEdge>();
  for (const edge of layoutEdges) {
    const sourceCommunity = visualNodeById.get(edge.source)?.communityId;
    const targetCommunity = visualNodeById.get(edge.target)?.communityId;
    if (sourceCommunity == null || targetCommunity == null || sourceCommunity === targetCommunity) continue;
    const [source, target] = sourceCommunity < targetCommunity
      ? [sourceCommunity, targetCommunity]
      : [targetCommunity, sourceCommunity];
    const key = `${source}:${target}`;
    const existing = crossCommunity.get(key);
    if (existing) {
      existing.edgeCount += 1;
      existing.essentialCount += edge.tier === "essential" ? 1 : 0;
      existing.maxConfidence = Math.max(existing.maxConfidence, edge.confidence);
    } else {
      crossCommunity.set(key, {
        id: `atlas-community-${key}`,
        sourceCommunity: source,
        targetCommunity: target,
        edgeCount: 1,
        essentialCount: edge.tier === "essential" ? 1 : 0,
        maxConfidence: edge.confidence,
      });
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    algorithmVersion: ALGORITHM_VERSION,
    fingerprint: modelFingerprint(baseNodes, visualEdges, inferredTopK),
    nodes: visualNodes,
    edges: visualEdges,
    communities,
    communityEdges: [...crossCommunity.values()].sort((a, b) => a.id.localeCompare(b.id)),
    diagnostics,
  };
}

export function atlasLayoutEdges(model: AtlasVisualModel): AtlasVisualEdge[] {
  return model.edges.filter((edge) => edge.tier !== "detail");
}
