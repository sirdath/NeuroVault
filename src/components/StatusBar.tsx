import { useNoteStore } from "../stores/noteStore";

export function StatusBar() {
  const notes = useNoteStore((s) => s.notes);
  const activeContent = useNoteStore((s) => s.activeContent);

  // Word count for the active note (more useful than token estimate)
  const wordCount = activeContent
    ? activeContent.trim().split(/\s+/).filter(Boolean).length
    : 0;

  return (
    <div className="h-6 min-h-[24px] flex items-center justify-between px-4 bg-[#12121c] border-t border-[#1f1f2e]">
      <span className="text-[10px] text-[#6a6880] font-[Geist,sans-serif]">
        {notes.length} {notes.length === 1 ? "note" : "notes"}
      </span>
      <div className="flex items-center gap-3">
        {wordCount > 0 && (
          <span className="text-[10px] text-[#6a6880] font-[Geist,sans-serif]">
            {wordCount.toLocaleString()} {wordCount === 1 ? "word" : "words"}
          </span>
        )}
        <span className="text-[10px] text-[#35335a] font-[Geist,sans-serif]">
          ?&thinsp;shortcuts
        </span>
      </div>
    </div>
  );
}
