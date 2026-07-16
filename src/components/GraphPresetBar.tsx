import { ATLAS_BUILT_IN_PATTERNS } from "../lib/atlasPatterns";
import type { GraphPreset } from "../stores/graphSettingsStore";

/**
 * The one control that picks what the graph looks like.
 *
 * This replaced a two-tier split: two "everyday snapshots" (2D/3D) behind one
 * toolbar, and six "compositions" behind an "Open Graph Engine" button that
 * swapped in a different toolbar, a different gallery, and a different
 * localStorage key. Users had to know the Engine existed to find six of the
 * eight views, and the Engine's own choice was never restored on reload.
 *
 * They are all just presets. One row, one click each, one persisted key.
 *
 * Naming note: the 3D snapshot and the "globe" composition are both spheres,
 * which made "3D Globe" and "Orb" hopeless as labels. The true-3D view keeps
 * the plain "3D" it always had; "Globe" is the flat composition shaped like
 * one. Nothing else in the bar is a shape word, so they cannot be confused.
 */

/** Short labels for the bar. The patterns' own `name` fields ("Constellation
 *  Islands", "Connectome Halo") are too long for a pill and would wrap the
 *  toolbar; these are their marketing-free short forms. Every GraphPreset must
 *  appear here — GraphPresetBar.test.tsx asserts it, so a new composition
 *  cannot ship as an unlabelled pill. */
const PRESET_LABELS: Record<GraphPreset, string> = {
  "2d": "2D",
  "3d": "3D",
  timeline: "Time Rings",
  constellation: "Islands",
  dendrite: "Arbor",
  halo: "Halo",
  flow: "Flow",
  globe: "Globe",
};

/** What each preset is for, in the user's terms. Shown as the pill's tooltip
 *  and its accessible description. */
const PRESET_HINTS: Record<GraphPreset, string> = {
  "2d": "The flat map. Fastest, and the one to read structure from.",
  "3d": "The same brain as a rotatable sphere. Drag to orbit.",
  timeline: "Notes in rings by age — newest at the centre.",
  constellation: "Clusters pulled apart into separate islands.",
  dendrite: "Branching outward from your most-linked notes.",
  halo: "One ring, with the busiest notes on the rim.",
  flow: "Left-to-right, following how notes reference each other.",
  globe: "A flat projection of the brain wrapped onto a sphere.",
};

/** Snapshots first, then the compositions in shipped order. Derived from the
 *  patterns so a new composition appears here automatically. */
export const GRAPH_PRESETS: readonly GraphPreset[] = [
  "2d",
  "3d",
  ...ATLAS_BUILT_IN_PATTERNS.map((p) => p.id),
];

interface GraphPresetBarProps {
  preset: GraphPreset;
  onSelect: (preset: GraphPreset) => void;
}

export function GraphPresetBar({ preset, onSelect }: GraphPresetBarProps) {
  return (
    <div
      role="group"
      aria-label="Graph view"
      className="flex items-center gap-0.5 rounded-lg p-0.5"
      style={{ background: "var(--nv-bg)" }}
    >
      {GRAPH_PRESETS.map((id, index) => {
        const active = preset === id;
        return (
          <div key={id} className="flex items-center">
            {/* The two snapshots are a different kind of thing from the six
                compositions — same bar, but the divider says "everything to
                the right is a styling of the same data". */}
            {index === 2 && (
              <span
                aria-hidden="true"
                className="mx-1 h-3.5 w-px shrink-0"
                style={{ background: "var(--nv-border)" }}
              />
            )}
            <button
              type="button"
              onClick={() => onSelect(id)}
              title={PRESET_HINTS[id]}
              aria-label={`${PRESET_LABELS[id]} — ${PRESET_HINTS[id]}`}
              aria-pressed={active}
              className="rounded-md px-2 py-1 text-[10px] font-medium whitespace-nowrap transition-colors"
              style={{
                background: active ? "var(--nv-accent)" : "transparent",
                color: active ? "var(--nv-bg)" : "var(--nv-text-muted)",
              }}
            >
              {PRESET_LABELS[id]}
            </button>
          </div>
        );
      })}
    </div>
  );
}

export { PRESET_LABELS, PRESET_HINTS };
