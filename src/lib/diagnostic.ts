/* Brain Diagnostic — a health scorecard for a vault.
 *
 * Inspired by ifixai's one-command diagnostic: instead of a wall of raw
 * analytics, distill the brain's structure into a handful of graded
 * categories + one headline letter grade, with concrete, actionable
 * issues. Runs entirely from the graph the UI already has loaded — no
 * backend round-trip, no embeddings — so it's instant and offline.
 *
 * Each category scores 0..1; the overall is their weighted mean, mapped
 * to a letter grade. The point isn't a precise "IQ" for your brain — it's
 * a fast, legible signal of what maintenance would help most (and a
 * ready-made task list for the agent to act on).
 */

export interface DiagNode {
  id: string;
  title: string;
  state: string;
  folder?: string;
}
export interface DiagEdge {
  from: string;
  to: string;
}

export interface DiagCategory {
  key: string;
  label: string;
  /** 0..1 */
  score: number;
  /** One-line human explanation of the current value. */
  detail: string;
}

export interface DiagIssue {
  /** Short imperative summary, e.g. "47 orphan notes (no links)". */
  label: string;
  /** How many items this concerns. */
  count: number;
  /** "high" surfaces first. */
  severity: "high" | "medium" | "low";
}

export interface Diagnostic {
  /** A–F (with +/- bands). */
  grade: string;
  /** 0..100 overall. */
  score: number;
  total: number;
  categories: DiagCategory[];
  issues: DiagIssue[];
}

const WEIGHTS: Record<string, number> = {
  connectivity: 0.25,
  interlinking: 0.2,
  cohesion: 0.2,
  freshness: 0.2,
  organization: 0.15,
};

const DORMANT = new Set(["dormant"]);

function letterGrade(pct: number): string {
  if (pct >= 97) return "A+";
  if (pct >= 93) return "A";
  if (pct >= 90) return "A-";
  if (pct >= 87) return "B+";
  if (pct >= 83) return "B";
  if (pct >= 80) return "B-";
  if (pct >= 77) return "C+";
  if (pct >= 73) return "C";
  if (pct >= 70) return "C-";
  if (pct >= 67) return "D+";
  if (pct >= 60) return "D";
  return "F";
}

/** Largest connected component size via union-find over the edge list. */
function largestComponent(nodes: DiagNode[], edges: DiagEdge[]): number {
  if (nodes.length === 0) return 0;
  const parent = new Map<string, string>();
  for (const n of nodes) parent.set(n.id, n.id);
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    // path-compress
    let c = x;
    while (parent.get(c) !== r) { const next = parent.get(c)!; parent.set(c, r); c = next; }
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const e of edges) {
    if (parent.has(e.from) && parent.has(e.to)) union(e.from, e.to);
  }
  const sizes = new Map<string, number>();
  for (const n of nodes) {
    const r = find(n.id);
    sizes.set(r, (sizes.get(r) ?? 0) + 1);
  }
  let max = 0;
  for (const s of sizes.values()) if (s > max) max = s;
  return max;
}

export function computeDiagnostic(nodes: DiagNode[], edges: DiagEdge[]): Diagnostic {
  const total = nodes.length;
  if (total === 0) {
    return {
      grade: "—",
      score: 0,
      total: 0,
      categories: [],
      issues: [{ label: "This brain has no notes yet", count: 0, severity: "low" }],
    };
  }

  // Degree per node.
  const degree = new Map<string, number>();
  for (const n of nodes) degree.set(n.id, 0);
  for (const e of edges) {
    if (degree.has(e.from)) degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    if (degree.has(e.to)) degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }

  const orphans = nodes.filter((n) => (degree.get(n.id) ?? 0) === 0).length;
  const dormant = nodes.filter((n) => DORMANT.has(n.state)).length;
  const unfiled = nodes.filter((n) => !n.folder || n.folder.trim() === "").length;
  const totalDegree = [...degree.values()].reduce((a, b) => a + b, 0);
  const avgDegree = totalDegree / total;
  const largest = largestComponent(nodes, edges);

  // --- Category scores (0..1) ---------------------------------------------
  const connectivity = 1 - orphans / total;            // fewer orphans = better
  const interlinking = Math.min(1, avgDegree / 3);     // ~3 links/note is "well-linked"
  const cohesion = largest / total;                    // one big web vs scattered islands
  const freshness = 1 - dormant / total;               // active share
  const organization = 1 - unfiled / total;            // filed into categories

  const categories: DiagCategory[] = [
    { key: "connectivity", label: "Connectivity", score: connectivity,
      detail: orphans === 0 ? "Every note is linked" : `${orphans} of ${total} notes are orphans (no links)` },
    { key: "interlinking", label: "Interlinking", score: interlinking,
      detail: `${avgDegree.toFixed(1)} links per note on average` },
    { key: "cohesion", label: "Cohesion", score: cohesion,
      detail: largest === total ? "All notes form one connected web" : `Largest cluster holds ${largest} of ${total} notes` },
    { key: "freshness", label: "Freshness", score: freshness,
      detail: dormant === 0 ? "No dormant notes" : `${dormant} of ${total} notes are dormant` },
    { key: "organization", label: "Organization", score: organization,
      detail: unfiled === 0 ? "Every note is filed in a folder" : `${unfiled} of ${total} notes are unfiled (root)` },
  ];

  const weighted = categories.reduce((acc, c) => acc + c.score * (WEIGHTS[c.key] ?? 0), 0);
  const score = Math.round(weighted * 100);

  // --- Actionable issues, worst first -------------------------------------
  const issues: DiagIssue[] = [];
  if (orphans > 0)
    issues.push({ label: `${orphans} orphan note${orphans === 1 ? "" : "s"} with no links — connect or merge them`, count: orphans, severity: orphans / total > 0.2 ? "high" : "medium" });
  if (dormant > 0)
    issues.push({ label: `${dormant} dormant note${dormant === 1 ? "" : "s"} — revisit or let them be pruned`, count: dormant, severity: dormant / total > 0.3 ? "high" : "low" });
  if (unfiled > 0)
    issues.push({ label: `${unfiled} unfiled note${unfiled === 1 ? "" : "s"} in the root — sort into folders`, count: unfiled, severity: unfiled / total > 0.4 ? "medium" : "low" });
  if (largest < total && total > 3) {
    const islands = total - largest;
    issues.push({ label: `${islands} note${islands === 1 ? "" : "s"} outside the main cluster — bridge them in`, count: islands, severity: islands / total > 0.3 ? "medium" : "low" });
  }
  if (avgDegree < 1.5)
    issues.push({ label: `Sparse linking (${avgDegree.toFixed(1)}/note) — add [[wikilinks]] between related notes`, count: total, severity: "low" });

  const sevRank = { high: 0, medium: 1, low: 2 };
  issues.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || b.count - a.count);

  return { grade: letterGrade(score), score, total, categories, issues };
}

/** Render the scorecard as a monospace ASCII report — the shareable,
 *  paste-to-your-agent form (and the same aesthetic shown in the docs). */
export function diagnosticToAscii(d: Diagnostic, brainName = "brain"): string {
  if (d.total === 0) return `NeuroVault — ${brainName}\nNo notes yet.`;
  const barW = 24;
  const lines: string[] = [];
  lines.push(`NeuroVault brain diagnostic — ${brainName}`);
  lines.push(`Overall: ${d.grade}  (${d.score}/100, ${d.total} notes)`);
  lines.push("");
  for (const c of d.categories) {
    const filled = Math.round(c.score * barW);
    const bar = "█".repeat(filled) + "░".repeat(barW - filled);
    const pct = `${Math.round(c.score * 100)}%`.padStart(4);
    lines.push(`${c.label.padEnd(13)} ${bar} ${pct}`);
  }
  if (d.issues.length) {
    lines.push("");
    lines.push("Top fixes:");
    for (const is of d.issues.slice(0, 5)) lines.push(`  - ${is.label}`);
  }
  return lines.join("\n");
}
