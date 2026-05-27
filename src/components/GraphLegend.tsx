import { useState } from "react";

/**
 * On-canvas legend for Analytics mode. Two jobs:
 *
 *   1. A visual KEY that decodes the encoding the graph uses — what node
 *      size means, what the ring colours mean (health), what the fill /
 *      background tint means (category). This is the concrete answer to
 *      "I don't understand what the analytics are showing me."
 *   2. A CLUSTER readout — the communities NeuroVault found, biggest
 *      first, each with its colour, name (or anchor note) and size.
 *      Clicking a cluster flies the camera to frame it, so the legend
 *      doubles as a way to *navigate* the structure, not just read it.
 *
 * Pinned bottom-left, collapsible, and scrolls internally so a brain with
 * many communities never pushes the card off-screen.
 */

export interface LegendClusterRow {
  id: number;
  size: number;
  color: string;
  name: string;
  topTitle: string;
}

interface GraphLegendProps {
  visible: boolean;
  clusters: LegendClusterRow[];
  onFocusCluster: (id: number) => void;
}

/** The health-ring colour key — mirrors the ring colours painted in
 *  NeuralGraph.paintNode2D so the legend can't drift from the canvas. */
const RING_KEY: { label: string; color: string; hint: string }[] = [
  { label: "Active", color: "#00c9b1", hint: "Well-connected, healthy memory" },
  { label: "Fresh", color: "#f0a500", hint: "Recently added" },
  { label: "Dormant", color: "#6a6880", hint: "Fading — rarely accessed" },
];

export function GraphLegend({ visible, clusters, onFocusCluster }: GraphLegendProps) {
  const [open, setOpen] = useState(true);
  if (!visible) return null;

  return (
    <div
      className="absolute bottom-4 left-4 z-20 w-[230px] rounded-xl overflow-hidden"
      style={{
        background: "var(--nv-surface)",
        border: "1px solid var(--nv-border)",
        boxShadow: "0 8px 28px rgba(0,0,0,0.28)",
      }}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-3 py-2 text-[11px] font-[Geist,sans-serif] font-semibold uppercase tracking-wider transition-colors"
        style={{ color: "var(--nv-text-muted)" }}
      >
        <span>Legend</span>
        <span
          className="inline-block transition-transform text-[9px]"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
        >
          ▶
        </span>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-3">
          {/* Visual key */}
          <div className="space-y-2">
            {/* Size → importance */}
            <div className="flex items-center gap-2.5">
              <span className="flex items-center gap-1 flex-shrink-0" style={{ width: 34 }}>
                <span className="rounded-full" style={{ width: 6, height: 6, background: "var(--nv-text-muted)" }} />
                <span className="rounded-full" style={{ width: 12, height: 12, background: "var(--nv-text-muted)" }} />
              </span>
              <span className="text-[11px] font-[Geist,sans-serif] leading-tight" style={{ color: "var(--nv-text)" }}>
                Size = how often referenced
              </span>
            </div>
            {/* Fill → category */}
            <div className="flex items-center gap-2.5">
              <span className="flex items-center gap-1 flex-shrink-0" style={{ width: 34 }}>
                <span className="rounded-full" style={{ width: 11, height: 11, background: "#6ea8ff" }} />
                <span className="rounded-full" style={{ width: 11, height: 11, background: "#c98aff" }} />
              </span>
              <span className="text-[11px] font-[Geist,sans-serif] leading-tight" style={{ color: "var(--nv-text)" }}>
                Fill / tint = category (folder)
              </span>
            </div>
            {/* Ring → health */}
            <div className="space-y-1">
              <span className="text-[11px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text)" }}>
                Ring = health
              </span>
              <div className="flex flex-wrap gap-x-3 gap-y-1 pl-0.5">
                {RING_KEY.map((r) => (
                  <span key={r.label} className="flex items-center gap-1.5" title={r.hint}>
                    <span
                      className="rounded-full"
                      style={{ width: 9, height: 9, border: `2px solid ${r.color}`, boxSizing: "border-box" }}
                    />
                    <span className="text-[10px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>
                      {r.label}
                    </span>
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* Cluster list */}
          {clusters.length > 0 && (
            <div className="space-y-1.5 pt-1" style={{ borderTop: "1px solid var(--nv-border)" }}>
              <p className="text-[10px] font-[Geist,sans-serif] uppercase tracking-wider pt-2" style={{ color: "var(--nv-text-dim)" }}>
                {clusters.length} clusters · click to frame
              </p>
              <ul className="space-y-0.5 max-h-[180px] overflow-y-auto -mx-1 px-1">
                {clusters.map((c) => (
                  <li key={c.id}>
                    <button
                      onClick={() => onFocusCluster(c.id)}
                      className="w-full flex items-center gap-2 px-1.5 py-1 rounded-md text-left transition-colors hover:[background-color:var(--nv-bg)]"
                      title={`${c.name} — ${c.size} notes`}
                    >
                      <span className="rounded-full flex-shrink-0" style={{ width: 9, height: 9, background: c.color }} />
                      <span className="flex-1 truncate text-[11px] font-[Geist,sans-serif] capitalize" style={{ color: "var(--nv-text)" }}>
                        {c.name}
                      </span>
                      <span className="text-[10px] font-[Geist,sans-serif] tabular-nums flex-shrink-0" style={{ color: "var(--nv-text-dim)" }}>
                        {c.size}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
