import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useNoteStore } from "../stores/noteStore";

export interface Command {
  id: string;
  title: string;
  category: string;
  shortcut?: string;
  action: () => void;
  icon?: string;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}

/** Fuzzy match — characters in order, not substring */
function fuzzyScore(query: string, text: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  // Exact substring = highest score
  if (t.includes(q)) return 1000 + (1 - t.indexOf(q) / t.length) * 100;

  // Sequential character match
  let qi = 0;
  let consecutive = 0;
  let maxConsecutive = 0;
  let score = 0;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
      consecutive++;
      maxConsecutive = Math.max(maxConsecutive, consecutive);
      score += 10 + consecutive * 5;
    } else {
      consecutive = 0;
    }
  }

  if (qi < q.length) return 0;
  return score + maxConsecutive * 20;
}

export function CommandPalette({ open, onClose, commands }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const notes = useNoteStore((s) => s.notes);
  const selectNote = useNoteStore((s) => s.selectNote);

  // Combine commands + notes into one searchable list
  const allItems: Command[] = useMemo(() => {
    const noteCommands: Command[] = notes.map((note) => ({
      id: `note-${note.filename}`,
      title: note.title,
      category: "Note",
      action: () => selectNote(note.filename),
      icon: "doc",
    }));
    return [...commands, ...noteCommands];
  }, [commands, notes, selectNote]);

  // Score and sort
  const filtered = useMemo(() => {
    if (!query.trim()) {
      // Show recent / all commands when no query
      return allItems.slice(0, 50);
    }
    const scored = allItems
      .map((cmd) => ({
        cmd,
        score: Math.max(
          fuzzyScore(query, cmd.title),
          fuzzyScore(query, cmd.category) * 0.5
        ),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50);
    return scored.map((x) => x.cmd);
  }, [query, allItems]);

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Scroll selected into view
  useEffect(() => {
    if (!listRef.current) return;
    const selected = listRef.current.querySelector('[data-selected="true"]');
    if (selected) selected.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  // Reset selection when query changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const cmd = filtered[selectedIndex];
        if (cmd) {
          cmd.action();
          onClose();
        }
      }
    },
    [filtered, selectedIndex, onClose]
  );

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 z-50 fade-in"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="fixed top-[15vh] left-1/2 -translate-x-1/2 w-[640px] max-w-[90vw] max-h-[60vh] bg-[#0f0f17] border border-[#2a2a4a] rounded-lg shadow-2xl z-50 flex flex-col overflow-hidden fade-in">
        {/* Search input */}
        <div className="p-4 border-b border-[#1e1e38]">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type a command or search notes..."
            className="w-full bg-transparent text-[#ddd9f0] text-base font-[Geist,sans-serif] placeholder:text-[#555570] focus:outline-none"
          />
        </div>

        {/* Results */}
        <div ref={listRef} className="flex-1 overflow-y-auto py-2">
          {filtered.length === 0 && (
            <div className="text-center py-8 text-[#555570] text-sm font-[Geist,sans-serif]">
              No results
            </div>
          )}

          {filtered.map((cmd, i) => (
            <div
              key={cmd.id}
              data-selected={i === selectedIndex}
              onClick={() => {
                cmd.action();
                onClose();
              }}
              onMouseEnter={() => setSelectedIndex(i)}
              className={`px-4 py-2.5 cursor-pointer flex items-center justify-between gap-3 ${
                i === selectedIndex ? "bg-[#131325]" : ""
              }`}
            >
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <span
                  className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-medium font-[Geist,sans-serif] flex-shrink-0 ${
                    cmd.category === "Note"
                      ? "bg-[#00c9b1]/15 text-[#00c9b1]"
                      : cmd.category === "Brain"
                        ? "bg-[#8b7cf8]/15 text-[#8b7cf8]"
                        : "bg-[#f0a500]/15 text-[#f0a500]"
                  }`}
                >
                  {cmd.category}
                </span>
                <span className="text-sm text-[#ddd9f0] font-[Geist,sans-serif] truncate">
                  {cmd.title}
                </span>
              </div>
              {cmd.shortcut && (
                <span className="text-[10px] text-[#555570] font-[Geist,sans-serif] flex-shrink-0">
                  {cmd.shortcut}
                </span>
              )}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-[#1e1e38] flex items-center justify-between text-[10px] text-[#555570] font-[Geist,sans-serif]">
          <div className="flex gap-3">
            <span><kbd>↑↓</kbd> navigate</span>
            <span><kbd>↵</kbd> select</span>
            <span><kbd>esc</kbd> close</span>
          </div>
          <span>{filtered.length} results</span>
        </div>
      </div>
    </>
  );
}
