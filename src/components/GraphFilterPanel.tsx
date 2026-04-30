/* GraphFilterPanel — Obsidian-style slide-out panel for the graph
 * view. Groups every graph-specific control (filters, display,
 * forces, time-lapse) in one place so the main toolbar stays clean
 * and the user can customise without leaving the canvas.
 *
 * The panel reads / writes the graph settings store. The graph view
 * subscribes to the same store, so every change applies live with no
 * apply / save step.
 */

import { useState } from "react";
import { useGraphSettingsStore, PALETTES } from "../stores/graphSettingsStore";
import type {
  GraphPalette,
  GraphNodeShape,
  GraphLayoutShape,
} from "../stores/graphSettingsStore";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Total node count + isolated count, surfaced in the Filters
   *  section so the user knows how many orphans are around without
   *  having to count rings. */
  nodeCount: number;
  orphanCount: number;
  semanticEdgeCount: number;
  /** Callbacks the parent owns because they touch the simulation
   *  reference, not just store state. */
  onTimelapseStart: () => void;
  onTimelapseStop: () => void;
  timelapseActive: boolean;
}

const PALETTE_LABELS: { value: GraphPalette; label: string; hint: string }[] = [
  { value: "warm", label: "Warm", hint: "Peach + cools" },
  { value: "cool", label: "Cool", hint: "Blue / teal" },
  { value: "mono", label: "Mono", hint: "Single hue" },
  { value: "vivid", label: "Vivid", hint: "Saturated" },
];

const SHAPE_LABELS: { value: GraphNodeShape; label: string }[] = [
  { value: "circle", label: "Circle" },
  { value: "square", label: "Square" },
  { value: "hex", label: "Hex" },
];

const LAYOUT_LABELS: { value: GraphLayoutShape; label: string; hint: string }[] = [
  { value: "organic", label: "Organic", hint: "Default d3-force" },
  { value: "circle", label: "Circle", hint: "Connected nodes on a ring" },
];

function Section({
  title,
  open,
  setOpen,
  children,
}: {
  title: string;
  open: boolean;
  setOpen: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="border-b"
      style={{ borderColor: "var(--nv-border)" }}
    >
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-4 py-3 text-[12px] font-[Geist,sans-serif] font-medium uppercase tracking-wider transition-colors"
        style={{ color: "var(--nv-text-muted)" }}
      >
        <span
          className="inline-block transition-transform"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
        >
          ▶
        </span>
        {title}
      </button>
      {open && <div className="px-4 pb-4 space-y-3">{children}</div>}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <label
      className="flex items-center justify-between gap-2 cursor-pointer select-none text-[12px] font-[Geist,sans-serif]"
      style={{ color: "var(--nv-text)" }}
      title={hint}
    >
      <span>{label}</span>
      <span
        onClick={() => onChange(!checked)}
        className="relative inline-block w-9 h-5 rounded-full transition-colors flex-shrink-0"
        style={{
          background: checked ? "var(--nv-accent)" : "var(--nv-surface)",
          border: "1px solid var(--nv-border)",
        }}
      >
        <span
          className="absolute top-[2px] w-3.5 h-3.5 rounded-full transition-transform"
          style={{
            left: checked ? "calc(100% - 1.05rem)" : "2px",
            background: checked ? "var(--nv-bg)" : "var(--nv-text-muted)",
          }}
        />
      </span>
    </label>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  formatter,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  formatter?: (v: number) => string;
}) {
  return (
    <div className="space-y-1.5">
      <div
        className="flex items-center justify-between text-[11px] font-[Geist,sans-serif]"
        style={{ color: "var(--nv-text-muted)" }}
      >
        <span>{label}</span>
        <span style={{ color: "var(--nv-text-dim)", fontVariantNumeric: "tabular-nums" }}>
          {formatter ? formatter(value) : value.toFixed(2)}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-current cursor-pointer"
        style={{ color: "var(--nv-accent)" }}
      />
    </div>
  );
}

function ColorMapEditor({
  title,
  entries,
  onSet,
  onClear,
  emptyHint,
}: {
  title: string;
  entries: [string, string][];
  onSet: (key: string, color: string | null) => void;
  onClear: () => void;
  emptyHint: string;
}) {
  return (
    <div className="space-y-2">
      <div
        className="flex items-center justify-between text-[11px] font-[Geist,sans-serif]"
        style={{ color: "var(--nv-text-muted)" }}
      >
        <span>{title}</span>
        {entries.length > 0 && (
          <button
            onClick={onClear}
            className="text-[10px] underline transition-colors"
            style={{ color: "var(--nv-text-dim)" }}
          >
            reset all
          </button>
        )}
      </div>
      {entries.length === 0 ? (
        <p
          className="text-[10px] italic font-[Geist,sans-serif]"
          style={{ color: "var(--nv-text-dim)" }}
        >
          {emptyHint}
        </p>
      ) : (
        <div className="space-y-1">
          {entries.map(([k, color]) => (
            <div key={k} className="flex items-center gap-2 text-[11px]">
              <input
                type="color"
                value={color}
                onChange={(e) => onSet(k, e.target.value)}
                className="w-6 h-6 rounded cursor-pointer flex-shrink-0"
                style={{ background: "transparent", border: "1px solid var(--nv-border)" }}
              />
              <span
                className="flex-1 truncate font-[Geist,sans-serif]"
                style={{ color: "var(--nv-text)" }}
                title={k}
              >
                {k || "(root)"}
              </span>
              <button
                onClick={() => onSet(k, null)}
                className="text-[10px] transition-colors"
                style={{ color: "var(--nv-text-dim)" }}
                title="Clear override"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function GraphFilterPanel({
  open,
  onClose,
  nodeCount,
  orphanCount,
  semanticEdgeCount,
  onTimelapseStart,
  onTimelapseStop,
  timelapseActive,
}: Props) {
  const s = useGraphSettingsStore();
  const [openSections, setOpenSections] = useState({
    filters: true,
    display: true,
    forces: false,
    appearance: false,
    timelapse: true,
  });

  if (!open) return null;

  const toggleSection = (k: keyof typeof openSections) =>
    setOpenSections((prev) => ({ ...prev, [k]: !prev[k] }));

  const folderEntries = Object.entries(s.folderColors).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  const clusterEntries = Object.entries(s.clusterColors).sort(([a], [b]) =>
    a.localeCompare(b)
  );

  return (
    <div
      className="absolute top-4 right-4 bottom-4 w-72 z-30 rounded-xl overflow-hidden flex flex-col"
      style={{
        background: "var(--nv-bg)",
        border: "1px solid var(--nv-border)",
        boxShadow: "0 12px 40px rgba(0,0,0,0.4)",
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0"
        style={{ borderColor: "var(--nv-border)" }}
      >
        <div
          className="text-[13px] font-[Geist,sans-serif] font-medium"
          style={{ color: "var(--nv-text)" }}
        >
          Graph Filters
        </div>
        <button
          onClick={onClose}
          className="w-6 h-6 rounded flex items-center justify-center text-[14px] transition-colors"
          style={{ color: "var(--nv-text-muted)" }}
          aria-label="Close graph filters panel"
          title="Close (Esc)"
        >
          ×
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Filters */}
        <Section
          title="Filters"
          open={openSections.filters}
          setOpen={() => toggleSection("filters")}
        >
          <input
            type="text"
            value={s.searchQuery}
            onChange={(e) => s.setSearchQuery(e.target.value)}
            placeholder="Search nodes..."
            className="w-full text-[12px] px-2.5 py-1.5 rounded-md focus:outline-none font-[Geist,sans-serif]"
            style={{
              background: "var(--nv-surface)",
              color: "var(--nv-text)",
              border: "1px solid var(--nv-border)",
            }}
          />
          <Toggle
            label={`Show orphans (${orphanCount})`}
            checked={s.showOrphans}
            onChange={s.setShowOrphans}
            hint="Isolated nodes (no edges) — render them in a halo around the connected brain."
          />
          <Toggle
            label={`Semantic edges (${semanticEdgeCount})`}
            checked={s.showSemanticEdges}
            onChange={s.setShowSemanticEdges}
            hint="Auto-computed cosine similarity edges. Off by default — they create a hairball at brain scale."
          />
          <Toggle
            label="Manual links only"
            checked={s.manualOnly}
            onChange={s.setManualOnly}
            hint="Hide entity + semantic edges. Show only [[wikilinks]] you typed."
          />
          <Toggle
            label="Show arrows"
            checked={s.showArrows}
            onChange={s.setShowArrows}
            hint="Draw arrowheads on directed edges (manual wikilinks)."
          />
        </Section>

        {/* Display */}
        <Section
          title="Display"
          open={openSections.display}
          setOpen={() => toggleSection("display")}
        >
          <Slider
            label="Node size"
            value={s.nodeSizeScale}
            min={0.3}
            max={3.0}
            step={0.05}
            onChange={s.setNodeSizeScale}
            formatter={(v) => `${v.toFixed(2)}×`}
          />
          <Slider
            label="Link thickness"
            value={s.linkThicknessScale}
            min={0.3}
            max={3.0}
            step={0.05}
            onChange={s.setLinkThicknessScale}
            formatter={(v) => `${v.toFixed(2)}×`}
          />
          <Slider
            label="Show labels at zoom"
            value={s.labelZoomThreshold}
            min={0.5}
            max={8.0}
            step={0.1}
            onChange={s.setLabelZoomThreshold}
            formatter={(v) => `≥ ${v.toFixed(1)}`}
          />
          <Toggle
            label="Show all folder labels"
            checked={s.showClusterLabels}
            onChange={s.setShowClusterLabels}
          />
        </Section>

        {/* Appearance — palette / shape / colour overrides */}
        <Section
          title="Appearance"
          open={openSections.appearance}
          setOpen={() => toggleSection("appearance")}
        >
          <div className="space-y-2">
            <div
              className="text-[11px] font-[Geist,sans-serif]"
              style={{ color: "var(--nv-text-muted)" }}
            >
              Palette
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {PALETTE_LABELS.map((p) => {
                const colors = PALETTES[p.value];
                const selected = s.palette === p.value;
                return (
                  <button
                    key={p.value}
                    onClick={() => s.setPalette(p.value)}
                    title={p.hint}
                    className="text-left rounded p-2 transition-all border"
                    style={{
                      background: "var(--nv-surface)",
                      borderColor: selected ? "var(--nv-accent)" : "var(--nv-border)",
                    }}
                  >
                    <div className="flex gap-0.5 mb-1">
                      {colors.slice(0, 5).map((c: string, i: number) => (
                        <span
                          key={i}
                          className="w-2.5 h-2.5 rounded-full"
                          style={{ background: c }}
                        />
                      ))}
                    </div>
                    <p
                      className="text-[10px] font-medium font-[Geist,sans-serif]"
                      style={{ color: "var(--nv-text)" }}
                    >
                      {p.label}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="space-y-2">
            <div
              className="text-[11px] font-[Geist,sans-serif]"
              style={{ color: "var(--nv-text-muted)" }}
            >
              Node shape
            </div>
            <div
              className="flex gap-0.5 rounded-lg p-0.5"
              style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)" }}
            >
              {SHAPE_LABELS.map((sh) => (
                <button
                  key={sh.value}
                  onClick={() => s.setNodeShape(sh.value)}
                  className="flex-1 px-2 py-1 text-[11px] font-medium font-[Geist,sans-serif] rounded transition-all"
                  style={
                    s.nodeShape === sh.value
                      ? {
                          background: "var(--nv-bg)",
                          color: "var(--nv-text)",
                          border: "1px solid var(--nv-border)",
                        }
                      : { color: "var(--nv-text-muted)" }
                  }
                >
                  {sh.label}
                </button>
              ))}
            </div>
          </div>
          <ColorMapEditor
            title="Folder colours"
            entries={folderEntries}
            onSet={s.setFolderColor}
            onClear={s.clearFolderColors}
            emptyHint="No folder overrides yet. Right-click a folder cluster on the canvas to pick a colour."
          />
          <ColorMapEditor
            title="Cluster colours"
            entries={clusterEntries}
            onSet={s.setClusterColor}
            onClear={s.clearClusterColors}
            emptyHint="Name some clusters via /name-clusters first, then customise their tints."
          />
        </Section>

        {/* Layout */}
        <Section
          title="Layout"
          open={openSections.forces}
          setOpen={() => toggleSection("forces")}
        >
          <div className="space-y-2">
            <div
              className="text-[11px] font-[Geist,sans-serif]"
              style={{ color: "var(--nv-text-muted)" }}
            >
              Layout shape
            </div>
            <div
              className="flex gap-0.5 rounded-lg p-0.5"
              style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)" }}
            >
              {LAYOUT_LABELS.map((l) => (
                <button
                  key={l.value}
                  onClick={() => s.setLayoutShape(l.value)}
                  title={l.hint}
                  className="flex-1 px-2 py-1 text-[11px] font-medium font-[Geist,sans-serif] rounded transition-all"
                  style={
                    s.layoutShape === l.value
                      ? {
                          background: "var(--nv-bg)",
                          color: "var(--nv-text)",
                          border: "1px solid var(--nv-border)",
                        }
                      : { color: "var(--nv-text-muted)" }
                  }
                >
                  {l.label}
                </button>
              ))}
            </div>
          </div>
          <Slider
            label="Centering pull"
            value={s.centeringStrength}
            min={0}
            max={0.3}
            step={0.005}
            onChange={s.setCenteringStrength}
            formatter={(v) => v.toFixed(3)}
          />
          <Slider
            label="Charge (repulsion)"
            value={s.chargeStrength}
            min={-300}
            max={-10}
            step={5}
            onChange={s.setChargeStrength}
            formatter={(v) => v.toFixed(0)}
          />
          <Slider
            label="Link distance"
            value={s.linkDistance}
            min={5}
            max={120}
            step={1}
            onChange={s.setLinkDistance}
            formatter={(v) => `${v.toFixed(0)} px`}
          />
        </Section>

        {/* Time-lapse */}
        <Section
          title="Time-lapse"
          open={openSections.timelapse}
          setOpen={() => toggleSection("timelapse")}
        >
          <p
            className="text-[11px] font-[Geist,sans-serif] leading-snug"
            style={{ color: "var(--nv-text-dim)" }}
          >
            Replay the order in which {nodeCount} notes were created — nodes appear in
            chronological order, edges fade in once both endpoints are visible.
          </p>
          <Slider
            label="Duration"
            value={s.timelapseSpeedSec}
            min={3}
            max={60}
            step={1}
            onChange={s.setTimelapseSpeedSec}
            formatter={(v) => `${v.toFixed(0)} s`}
          />
          <button
            onClick={timelapseActive ? onTimelapseStop : onTimelapseStart}
            className="w-full text-[12px] font-[Geist,sans-serif] font-medium px-3 py-2 rounded-md transition-all"
            style={{
              background: timelapseActive ? "var(--nv-negative)" : "var(--nv-accent)",
              color: "var(--nv-bg)",
            }}
          >
            {timelapseActive ? "Stop time-lapse" : "▶ Start time-lapse"}
          </button>
        </Section>
      </div>
    </div>
  );
}
