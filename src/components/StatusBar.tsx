import { useNoteStore } from "../stores/noteStore";
import { useDensityStore } from "../stores/densityStore";

const DENSITY_LABELS: Record<string, string> = {
  comfortable: "comfy",
  cozy: "cozy",
  compact: "compact",
};

export function StatusBar() {
  const notes = useNoteStore((s) => s.notes);
  const activeContent = useNoteStore((s) => s.activeContent);
  const density = useDensityStore((s) => s.density);
  const cycleDensity = useDensityStore((s) => s.cycle);

  // Rough token estimate: ~4 chars per token
  const tokenEstimate = activeContent
    ? Math.round(activeContent.length / 4)
    : 0;

  return (
    <div className="h-6 min-h-[24px] flex items-center justify-between px-4 bg-[#12121c] border-t border-[#1f1f2e]">
      <span className="text-[10px] text-[#8a88a0] font-[Geist,sans-serif]">
        {notes.length} {notes.length === 1 ? "memory" : "memories"}
      </span>

      <div className="flex items-center gap-3">
        {tokenEstimate > 0 && (
          <span className="text-[10px] text-[#8a88a0] font-[Geist,sans-serif]">
            ~{tokenEstimate.toLocaleString()} tokens
          </span>
        )}
        <button
          onClick={cycleDensity}
          title={`Density: ${density} (click to cycle)`}
          className="text-[10px] text-[#8a88a0] hover:text-[#e8e6f0] font-[Geist,sans-serif] transition-colors uppercase tracking-wider"
        >
          {DENSITY_LABELS[density] ?? density}
        </button>
      </div>
    </div>
  );
}
