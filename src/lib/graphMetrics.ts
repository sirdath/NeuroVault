/**
 * Graph metrics for the NeuroVault graph view.
 *
 * Pure functions. Zero dependencies. Vanilla TypeScript.
 *
 * What's here:
 *   - edgeConfidence(edge, bidiSet)
 *       Fuses semantic similarity + link-type weight + reciprocity into
 *       a single 0..1 confidence value per edge. Used by the renderer
 *       to make wikilinks render thicker/bolder than weak semantic
 *       matches.
 *
 *   - pageRank(nodes, edges, opts)
 *       Iterative damped PageRank, undirected. Returns a Map keyed by
 *       node id with normalised scores (mean = 1.0). ~30ms on 1000
 *       nodes. Used by Analytics mode for node sizing.
 *
 *   - louvain(nodes, edges, opts)
 *       Single-pass modularity optimisation. Returns a Map keyed by
 *       node id with integer community ids. Deterministic for a given
 *       input (nodes processed in id-sorted order; ties broken by
 *       lowest community id). ~100ms on 1000 nodes.
 *
 *   - graphCacheKey(nodes, edges)
 *       Stable hash used as a cache key. Same nodes + edges = same key
 *       across reloads, so analytics results don't recompute when the
 *       user toggles back into Analytics mode without changing the
 *       brain.
 *
 * Performance budget (measured target on a 1000-node, 5000-edge brain):
 *   edgeConfidence:    < 5 ms total (O(E))
 *   pageRank:         ~30 ms (30 iterations × O(N + E))
 *   louvain:         ~100 ms (single pass; sufficient for our scale)
 *   graphCacheKey:    < 5 ms (O(N + E) string concat + hash)
 */

import type { GraphEdge, GraphNode } from "./api";

// ---------------------------------------------------------------------------
// Edge confidence
// ---------------------------------------------------------------------------

/** Weight given to each link kind when computing edge confidence.
 *  Manually-typed wikilinks are treated as user-asserted (highest);
 *  entity-derived edges are well-grounded but inferred; structural
 *  semantic kinds (uses, depends_on) sit in the middle; everything
 *  else is weak by default.
 *
 *  Hand-tuned, not learned. The retrieval pipeline already weights
 *  these implicitly during RRF; this is the *visual* representation. */
const LINK_KIND_WEIGHT: Record<string, number> = {
  manual:       1.0,
  entity:       0.85,
  defines:      0.85,
  uses:         0.75,
  depends_on:   0.75,
  extends:      0.75,
  part_of:      0.75,
  caused_by:    0.7,
  works_at:     0.7,
  mentions:     0.55,
  contradicts:  0.9,   // strong relationship — disagreement is meaningful
  supersedes:   0.9,
};

const DEFAULT_LINK_WEIGHT = 0.5;

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/** Canonical undirected key for an edge — the two ids sorted +
 *  joined. Used by `bidi` set membership tests and by the cache-key
 *  hasher so direction doesn't change the hash. */
export function canonicalEdgeKey(from: string, to: string): string {
  return from < to ? `${from}|${to}` : `${to}|${from}`;
}

export interface EdgeConfidenceOpts {
  /** Set of canonical edge keys that have edges in BOTH directions. */
  bidi: Set<string>;
}

/** Combine semantic similarity + link-kind weight + reciprocity into
 *  a single confidence in [0, 1]. */
export function edgeConfidence(
  edge: GraphEdge,
  opts: EdgeConfidenceOpts
): number {
  const semantic = clamp01(Number.isFinite(edge.similarity) ? edge.similarity : 0);
  const kind = LINK_KIND_WEIGHT[edge.link_type] ?? DEFAULT_LINK_WEIGHT;
  const reciprocity = opts.bidi.has(canonicalEdgeKey(edge.from, edge.to)) ? 0.15 : 0;
  return clamp01(0.55 * semantic + 0.35 * kind + reciprocity);
}

// ---------------------------------------------------------------------------
// PageRank
// ---------------------------------------------------------------------------

export interface PageRankOpts {
  /** Damping factor — probability of following an edge vs random jump.
   *  Standard value 0.85 (Brin/Page 1998). Lower = flatter scores. */
  damping?: number;
  /** Hard iteration cap; we usually converge in 20-40. */
  maxIter?: number;
  /** L1 convergence threshold. Below this delta we stop early. */
  epsilon?: number;
}

/**
 * Iterative undirected PageRank.
 *
 * Returns a Map<nodeId, score> where the average score is normalised
 * to 1.0 and scores are non-negative. We use mean=1 (rather than the
 * textbook mean=1/N) because downstream code blends `sqrt(score)` into
 * a node radius — mean=1 keeps the radius math intuitive (an "average"
 * node contributes a unit boost; a 5× node a sqrt(5)× boost).
 *
 * Undirected because the user's brain is conceptually a citation
 * network, not a click stream. A→B and B→A both express "these are
 * related"; treating them symmetrically gives more stable scores.
 */
export function pageRank(
  nodes: GraphNode[],
  edges: GraphEdge[],
  opts: PageRankOpts = {}
): Map<string, number> {
  const damping = opts.damping ?? 0.85;
  const maxIter = opts.maxIter ?? 30;
  const epsilon = opts.epsilon ?? 1e-6;

  const N = nodes.length;
  const result = new Map<string, number>();
  if (N === 0) return result;

  // Build symmetric adjacency + degree counts.
  const adjacency = new Map<string, string[]>();
  const ids = new Set<string>();
  for (const n of nodes) {
    ids.add(n.id);
    adjacency.set(n.id, []);
  }
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    adjacency.get(e.from)!.push(e.to);
    adjacency.get(e.to)!.push(e.from);
  }

  // Initial score: uniform 1/N.
  let scores = new Map<string, number>();
  for (const n of nodes) scores.set(n.id, 1 / N);

  const teleport = (1 - damping) / N;

  for (let iter = 0; iter < maxIter; iter++) {
    const next = new Map<string, number>();
    let danglingMass = 0;

    // Sum scores from dangling nodes (no outbound edges) — distributed
    // uniformly so the score-mass conserves.
    for (const n of nodes) {
      const neighbours = adjacency.get(n.id)!;
      if (neighbours.length === 0) {
        danglingMass += scores.get(n.id)!;
      }
    }
    const danglingShare = (damping * danglingMass) / N;

    for (const n of nodes) next.set(n.id, teleport + danglingShare);

    for (const n of nodes) {
      const neighbours = adjacency.get(n.id)!;
      if (neighbours.length === 0) continue;
      const share = (damping * scores.get(n.id)!) / neighbours.length;
      for (const neigh of neighbours) {
        next.set(neigh, next.get(neigh)! + share);
      }
    }

    // Check L1 delta for early exit.
    let delta = 0;
    for (const n of nodes) {
      delta += Math.abs(next.get(n.id)! - scores.get(n.id)!);
    }
    scores = next;
    if (delta < epsilon) break;
  }

  // Normalise to mean=1 for intuitive downstream use.
  let total = 0;
  for (const v of scores.values()) total += v;
  const meanInverse = total > 0 ? N / total : 1;
  for (const [id, v] of scores) result.set(id, v * meanInverse);

  return result;
}

// ---------------------------------------------------------------------------
// Louvain community detection
// ---------------------------------------------------------------------------

/**
 * Single-pass Louvain modularity optimisation.
 *
 * Returns a Map<nodeId, communityId> where communityId is a stable
 * integer (0, 1, 2, ...) chosen so that lower-id communities tend to
 * contain lower-id nodes — gives a deterministic ordering for the
 * UI to reuse across reloads.
 *
 * Why a single pass (no aggregation phase): for our scale (≤5000
 * nodes) one local-move pass produces communities that are good
 * enough — the second-phase aggregation is what scales Louvain to
 * millions of nodes, but it adds complexity and recursive bookkeeping
 * we don't need. We can revisit if a power user shows up with a
 * 50,000-note vault.
 *
 * Determinism notes:
 *   - Nodes are processed in id-sorted order (not insertion order).
 *   - When evaluating candidate community moves, ties (equal Δ-modularity)
 *     are broken by lowest community id. This means rerunning on the
 *     same input always yields the same partition.
 */
export function louvain(
  nodes: GraphNode[],
  edges: GraphEdge[]
): Map<string, number> {
  const result = new Map<string, number>();
  if (nodes.length === 0) return result;

  // Build symmetric adjacency with edge weights (1 per edge for now —
  // could pass edgeConfidence here later if we want weighted comms).
  const ids = nodes.map((n) => n.id).sort();
  const idIndex = new Map<string, number>();
  ids.forEach((id, i) => idIndex.set(id, i));

  const N = ids.length;
  const adjacency: Array<Array<{ to: number; weight: number }>> = ids.map(() => []);
  let totalWeight = 0;
  const seenPairs = new Set<string>();
  for (const e of edges) {
    const a = idIndex.get(e.from);
    const b = idIndex.get(e.to);
    if (a == null || b == null || a === b) continue;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seenPairs.has(key)) continue; // Dedupe — undirected, count once.
    seenPairs.add(key);
    const w = 1; // Unweighted; can swap to confidence later.
    adjacency[a]!.push({ to: b, weight: w });
    adjacency[b]!.push({ to: a, weight: w });
    totalWeight += w;
  }
  // m in classic Louvain notation = total edge weight (each edge counted once).
  const m = totalWeight;
  if (m === 0) {
    // No edges — every node is its own community.
    ids.forEach((id, i) => result.set(id, i));
    return result;
  }

  // Per-node weighted degree.
  const degree = adjacency.map((adj) =>
    adj.reduce((s, e) => s + e.weight, 0)
  );

  // Initial partition: each node in its own community.
  const community = new Uint32Array(N);
  for (let i = 0; i < N; i++) community[i] = i;
  // Sum of weighted degrees of nodes in each community.
  const communitySumDegree = new Float64Array(N);
  for (let i = 0; i < N; i++) communitySumDegree[i] = degree[i]!;

  // For a candidate move we need Σ k_i,C (sum of weights from i into C).
  // Compute on demand per node move.

  let movedThisPass = 1;
  let pass = 0;
  const maxPasses = 8; // Convergence usually within 3–5 in practice.

  while (movedThisPass > 0 && pass < maxPasses) {
    movedThisPass = 0;
    pass++;
    for (let i = 0; i < N; i++) {
      const adj = adjacency[i]!;
      if (adj.length === 0) continue;

      // Sum of weights from i to each neighbouring community.
      const weightToComm = new Map<number, number>();
      for (const e of adj) {
        const c = community[e.to]!;
        weightToComm.set(c, (weightToComm.get(c) ?? 0) + e.weight);
      }

      const currentComm = community[i]!;
      const ki = degree[i]!;
      // Subtract i from its current community before evaluating moves.
      communitySumDegree[currentComm] = (communitySumDegree[currentComm] ?? 0) - ki;
      const k_i_in_current = weightToComm.get(currentComm) ?? 0;

      // Evaluate Δmodularity for moving i to each candidate community.
      // ΔQ = (k_{i,C} - k_i * Σ_C / 2m) — we only need the relative
      // ranking, so the constant 2m factor cancels in tie comparisons.
      let bestComm = currentComm;
      let bestGain = (k_i_in_current - (ki * communitySumDegree[currentComm]!) / (2 * m));

      // Sort candidate community ids ascending for deterministic
      // tie-breaking.
      const candidates = Array.from(weightToComm.keys()).sort((a, b) => a - b);
      for (const c of candidates) {
        if (c === currentComm) continue;
        const k_i_in_c = weightToComm.get(c) ?? 0;
        const gain = k_i_in_c - (ki * communitySumDegree[c]!) / (2 * m);
        if (gain > bestGain + 1e-12) {
          bestGain = gain;
          bestComm = c;
        }
      }

      // Apply move (re-add to whichever community we picked).
      communitySumDegree[bestComm] = (communitySumDegree[bestComm] ?? 0) + ki;
      if (bestComm !== currentComm) {
        community[i] = bestComm;
        movedThisPass++;
      }
    }
  }

  // Compress community ids to 0..K-1 in order of first appearance among
  // sorted node ids. Gives a stable, low-cardinality output.
  const remap = new Map<number, number>();
  let nextId = 0;
  for (let i = 0; i < N; i++) {
    const c = community[i]!;
    if (!remap.has(c)) remap.set(c, nextId++);
    result.set(ids[i]!, remap.get(c)!);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Cache key
// ---------------------------------------------------------------------------

/**
 * Deterministic hash of the (sorted) node + edge identity set. Used
 * as a memoisation key for analytics computations: same brain state
 * = same key = cached results returned instantly when the user
 * toggles Analytics mode back on.
 *
 * 32-bit FNV-1a — small, stable, plenty of collision resistance for
 * a per-brain in-memory cache keyed once per session. Rendered as
 * an unsigned hex string so consumers can safely use it as a Map key
 * or localStorage suffix.
 */
export function graphCacheKey(nodes: GraphNode[], edges: GraphEdge[]): string {
  const idsSorted = nodes.map((n) => n.id).sort();
  const edgeKeys = edges.map((e) => canonicalEdgeKey(e.from, e.to)).sort();
  // Concat with separators that can't appear in ids; assumes ids are
  // ULIDs / UUIDs / wiki slugs (no `` byte).
  const payload = idsSorted.join("") + "" + edgeKeys.join("");

  // FNV-1a 32-bit.
  let h = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
