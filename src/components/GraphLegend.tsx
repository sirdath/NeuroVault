import { useState } from "react";

/**
 * On-canvas legend for Analytics mode. Two jobs:
 *
 *   1. A visual KEY that decodes the encoding the graph uses — what node
 *      size means, what the fill / background tint means (category), and
 *      what fading and rims mean. This is the concrete answer to "I don't
 *      understand what the analytics are showing me." Every row here must
 *      match NeuralGraph's painter; a row that outlives its encoding is
 *      worse than no legend at all.
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
            {/* Opacity → dormancy */}
            <div className="flex items-center gap-2.5">
              <span className="flex items-center gap-1 flex-shrink-0" style={{ width: 34 }}>
                <span className="rounded-full" style={{ width: 11, height: 11, background: "#6ea8ff", opacity: 0.9 }} />
                <span className="rounded-full" style={{ width: 11, height: 11, background: "#6ea8ff", opacity: 0.5 }} />
              </span>
              <span className="text-[11px] font-[Geist,sans-serif] leading-tight" style={{ color: "var(--nv-text)" }}>
                Faded = dormant
              </span>
            </div>
            {/* Rim → anchor or fresh. Detached ring in the node's own colour,
                matching NeuralGraph's stroke at radius + 1.7. */}
            <div className="flex items-center gap-2.5">
              <span className="flex items-center gap-1 flex-shrink-0" style={{ width: 34, paddingLeft: 3 }}>
                <span
                  className="rounded-full"
                  style={{
                    width: 9,
                    height: 9,
                    background: "#6ea8ff",
                    outline: "1.5px solid rgba(110, 168, 255, 0.68)",
                    outlineOffset: 2,
                    opacity: 0.9,
                  }}
                />
              </span>
              <span className="text-[11px] font-[Geist,sans-serif] leading-tight" style={{ color: "var(--nv-text)" }}>
                Rim = hub or newly added
              </span>
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
