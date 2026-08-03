/**
 * The edge half of the graph legend.
 *
 * GraphLegend's house rule is that every row must match the painter — a row
 * that outlives its encoding is worse than no legend. Edges make that rule easy
 * to break, because two different renderers colour them: the force-graph
 * snapshots use `edgeColor` (a 13-hue link_type palette) and the Atlas
 * compositions use `edgeThemeColor` (four theme buckets). So the rows are
 * DERIVED from whichever painter is on screen instead of being written by hand:
 *
 *   - the caller passes its own colour function, and
 *   - only link types with an edge in the current view get counted, and
 *   - types that paint the SAME colour collapse into one row.
 *
 * That last rule is not cosmetic. In the Atlas palette `warning` is mapped to
 * the accent colour, so `supersedes` and `manual` are literally the same pixel
 * — a hand-written legend would claim a distinction the renderer never draws.
 */

/** One decoded edge colour. */
export interface EdgeLegendRow {
  /** The colour the painter returns — doubles as the row's stable key. */
  color: string;
  /** Human label built from the link types that paint this colour. */
  label: string;
  /** The link types folded into this row, most frequent first. */
  types: string[];
  /** True when this is the renderer's untyped bucket, which Atlas draws in the
   *  source note's own colour rather than the bucket colour. */
  inheritsNodeColor: boolean;
}

/** Reader-facing names for the link types the backend writes. Anything not
 *  listed falls back to its raw type with underscores relaxed, so a new
 *  link_type shows up honestly instead of silently disappearing. */
export const EDGE_TYPE_LABELS: Readonly<Record<string, string>> = {
  manual: "Wikilink",
  semantic: "Semantic similarity",
  entity: "Shared entity",
  mentions: "Mentions",
  contradicts: "Contradicts",
  supersedes: "Supersedes",
  defines: "Defines",
  part_of: "Part of",
  extends: "Extends",
  depends_on: "Depends on",
  uses: "Uses",
  caused_by: "Caused by",
  works_at: "Works at",
  calls: "Code: calls",
  references: "Code: references",
};

export function edgeTypeLabel(linkType: string): string {
  return EDGE_TYPE_LABELS[linkType] ?? linkType.replace(/_/g, " ");
}

/** The subset of the app theme the Atlas edge painter reads. */
export interface GraphEdgeTheme {
  accent: string;
  negative: string;
  warning: string;
  dim: string;
}

/**
 * The Atlas/Sigma edge palette, derived from the app theme.
 *
 * AtlasGraph builds its `colors` object through this, and the legend decodes
 * the same object — one mapping, so the card cannot drift from the canvas.
 * `warning` intentionally resolves to the accent colour: that is what the
 * composition has always painted, and changing it here would silently restyle
 * the graph rather than fix the legend.
 */
export function atlasEdgeTheme(theme: {
  accent: string;
  negative: string;
  textDim: string;
}): GraphEdgeTheme {
  return {
    accent: theme.accent,
    negative: theme.negative,
    warning: theme.accent,
    dim: theme.textDim,
  };
}

/** Atlas edge colour by link_type. Structural links share the accent, conflict
 *  gets the negative colour, and everything else lands in the `dim` bucket —
 *  which AtlasGraph then replaces with the source node's own colour. */
export function edgeThemeColor(linkType: string, colors: GraphEdgeTheme): string {
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

export interface EdgeLegendOptions {
  /** The renderer's untyped-bucket colour, if it has one. Rows painted this
   *  colour are flagged `inheritsNodeColor`. */
  inheritColor?: string;
  /** Row cap — the legend card is 230px wide and shares space with clusters. */
  max?: number;
}

/**
 * Group the link types actually present in `edges` by the colour `colorOf`
 * paints them, most edges first.
 *
 * Passing the painter's own function is the whole point: the swatch a user sees
 * is produced by the same code that drew the line.
 */
export function buildEdgeLegendRows(
  edges: readonly { link_type: string }[],
  colorOf: (linkType: string) => string,
  options: EdgeLegendOptions = {},
): EdgeLegendRow[] {
  const max = options.max ?? 5;
  const counts = new Map<string, number>();
  for (const edge of edges) {
    const type = edge.link_type || "unknown";
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }

  const buckets = new Map<string, { total: number; types: { type: string; count: number }[] }>();
  for (const [type, count] of counts) {
    const color = colorOf(type);
    const bucket = buckets.get(color) ?? { total: 0, types: [] };
    bucket.total += count;
    bucket.types.push({ type, count });
    buckets.set(color, bucket);
  }

  const rows: EdgeLegendRow[] = [];
  for (const [color, bucket] of buckets) {
    const types = bucket.types
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
      .map((entry) => entry.type);
    const names = types.map(edgeTypeLabel);
    const shown = names.slice(0, 2).join(" · ");
    rows.push({
      color,
      label: names.length > 2 ? `${shown} +${names.length - 2}` : shown,
      types,
      inheritsNodeColor: options.inheritColor !== undefined && options.inheritColor === color,
    });
  }

  // Busiest colour first; label as the tie-break so the order is stable across
  // renders (Map iteration order would otherwise leak insertion order).
  const totalFor = (row: EdgeLegendRow) => buckets.get(row.color)?.total ?? 0;
  rows.sort((a, b) => totalFor(b) - totalFor(a) || a.label.localeCompare(b.label));
  return rows.slice(0, max);
}
