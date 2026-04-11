import { useNoteStore } from "../stores/noteStore";

export function StatusBar() {
  const notes = useNoteStore((s) => s.notes);
  const activeContent = useNoteStore((s) => s.activeContent);

  // Rough token estimate: ~4 chars per token
  const tokenEstimate = activeContent
    ? Math.round(activeContent.length / 4)
    : 0;

  return (
    <div className="h-6 min-h-[24px] flex items-center justify-between px-4 bg-[#0d0d1a] border-t border-[#1e1e38]">
      <span className="text-[10px] text-[#35335a] font-[Geist,sans-serif]">
        {notes.length} {notes.length === 1 ? "memory" : "memories"}
      </span>

      {tokenEstimate > 0 && (
        <span className="text-[10px] text-[#35335a] font-[Geist,sans-serif]">
          ~{tokenEstimate.toLocaleString()} tokens
        </span>
      )}
    </div>
  );
}
