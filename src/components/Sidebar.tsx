import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useNoteStore } from "../stores/noteStore";
import { relativeTime, extractPreview } from "../lib/utils";
import { readNote } from "../lib/tauri";

interface NoteStrength {
  strength: number;
  state: string;
  connections: number;
  kind?: string;
}

type KindFilter = "all" | "note" | "source" | "quote" | "draft" | "question";

const KIND_TABS: Array<{ id: KindFilter; label: string; color: string }> = [
  { id: "all", label: "All", color: "#9999b8" },
  { id: "note", label: "Notes", color: "#f0a500" },
  { id: "source", label: "Sources", color: "#00c9b1" },
  { id: "quote", label: "Quotes", color: "#8b7cf8" },
  { id: "draft", label: "Drafts", color: "#f06080" },
];

export function Sidebar({
  triggerNewNote = 0,
  triggerSearch = 0,
}: {
  triggerNewNote?: number;
  triggerSearch?: number;
} = {}) {
  const notes = useNoteStore((s) => s.notes);
  const activeFilename = useNoteStore((s) => s.activeFilename);
  const searchQuery = useNoteStore((s) => s.searchQuery);
  const setSearchQuery = useNoteStore((s) => s.setSearchQuery);
  const selectNote = useNoteStore((s) => s.selectNote);
  const createNote = useNoteStore((s) => s.createNote);
  const deleteNoteAction = useNoteStore((s) => s.deleteNote);

  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [strengths, setStrengths] = useState<Record<string, NoteStrength>>({});
  const [isCreating, setIsCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const inputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Load previews when notes change (NOT in render)
  useEffect(() => {
    const loadPreviews = async () => {
      const newPreviews: Record<string, string> = {};
      for (const note of notes) {
        if (previews[note.filename]) continue;
        try {
          const content = await readNote(note.filename);
          newPreviews[note.filename] = extractPreview(content);
        } catch {
          newPreviews[note.filename] = "";
        }
      }
      if (Object.keys(newPreviews).length > 0) {
        setPreviews((prev) => ({ ...prev, ...newPreviews }));
      }
    };
    if (notes.length > 0) loadPreviews();
  }, [notes]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load strength data from API (single batch, no race condition)
  useEffect(() => {
    const loadStrengths = async () => {
      try {
        const res = await fetch("http://127.0.0.1:8765/api/notes");
        if (!res.ok) return;
        const apiNotes: Array<{
          filename: string;
          strength: number;
          state: string;
          id: string;
          kind?: string;
        }> = await res.json();

        const map: Record<string, NoteStrength> = {};
        for (const n of apiNotes) {
          map[n.filename] = {
            strength: n.strength,
            state: n.state,
            connections: 0,
            kind: n.kind,
          };
        }
        setStrengths(map);
      } catch {
        // Server not running — ok
      }
    };
    if (notes.length > 0) loadStrengths();
  }, [notes]);

  // Keyboard: Ctrl+N
  useEffect(() => {
    if (triggerNewNote > 0) setIsCreating(true);
  }, [triggerNewNote]);

  // Keyboard: Ctrl+K
  useEffect(() => {
    if (triggerSearch > 0 && searchRef.current) searchRef.current.focus();
  }, [triggerSearch]);

  // Focus input when creating
  useEffect(() => {
    if (isCreating && inputRef.current) inputRef.current.focus();
  }, [isCreating]);

  const filtered = notes.filter((note) => {
    // Search filter
    if (
      searchQuery !== "" &&
      !note.title.toLowerCase().includes(searchQuery.toLowerCase())
    ) {
      return false;
    }
    // Kind filter
    if (kindFilter !== "all") {
      const s = strengths[note.filename];
      const kind = s?.kind ?? "note";
      if (kind !== kindFilter) return false;
    }
    return true;
  });

  const kindCounts = notes.reduce<Record<string, number>>(
    (acc, note) => {
      const kind = strengths[note.filename]?.kind ?? "note";
      acc[kind] = (acc[kind] ?? 0) + 1;
      acc.all = (acc.all ?? 0) + 1;
      return acc;
    },
    { all: 0 }
  );

  const handleCreate = useCallback(async () => {
    const title = newTitle.trim();
    if (!title) return;
    await createNote(title);
    setNewTitle("");
    setIsCreating(false);
  }, [newTitle, createNote]);

  const handleDelete = useCallback(
    (filename: string, title: string) => {
      if (window.confirm(`Move "${title}" to trash?`)) {
        deleteNoteAction(filename);
      }
    },
    [deleteNoteAction]
  );

  return (
    <div className="w-[260px] min-w-[260px] h-full flex flex-col bg-[#0d0d1a] border-r border-[#1e1e38]">
      {/* Header */}
      <div className="px-4 py-3 border-b border-[#1e1e38] flex-shrink-0">
        <h1 className="text-lg font-semibold font-[Geist,sans-serif] text-[#f0a500] tracking-tight">
          neurovault
        </h1>
      </div>

      {/* New Note */}
      <div className="px-3 py-2 border-b border-[#1e1e38] flex-shrink-0">
        {isCreating ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleCreate();
            }}
            className="flex gap-1"
          >
            <input
              ref={inputRef}
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setIsCreating(false);
                  setNewTitle("");
                }
              }}
              onBlur={() => {
                if (!newTitle.trim()) setIsCreating(false);
              }}
              placeholder="Note title..."
              className="flex-1 bg-[#131325] text-[#ddd9f0] text-sm px-2 py-1.5 rounded border border-[#1e1e38] focus:border-[#f0a500] focus:outline-none font-[Geist,sans-serif] placeholder:text-[#35335a]"
            />
            <button
              type="submit"
              className="text-[#f0a500] text-sm px-2 py-1 hover:bg-[#131325] rounded font-[Geist,sans-serif]"
            >
              +
            </button>
          </form>
        ) : (
          <button
            onClick={() => setIsCreating(true)}
            className="w-full text-left text-sm text-[#7a779a] hover:text-[#f0a500] px-2 py-1.5 hover:bg-[#131325] rounded transition-colors font-[Geist,sans-serif]"
          >
            + New note
          </button>
        )}
      </div>

      {/* Search */}
      <div className="px-3 py-2 flex-shrink-0">
        <input
          ref={searchRef}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search... (Ctrl+K)"
          className="w-full bg-[#131325] text-[#ddd9f0] text-sm px-3 py-1.5 rounded border border-[#1e1e38] focus:border-[#f0a500]/50 focus:outline-none font-[Geist,sans-serif] placeholder:text-[#35335a]"
        />
      </div>

      {/* Kind tabs */}
      <div className="px-2 pb-1 flex-shrink-0 flex gap-0.5 overflow-x-auto">
        {KIND_TABS.map((tab) => {
          const count = kindCounts[tab.id] ?? 0;
          const active = kindFilter === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setKindFilter(tab.id)}
              className={`flex-shrink-0 px-2 py-1 rounded text-[10px] font-[Geist,sans-serif] font-medium transition-colors ${
                active
                  ? "bg-[#131325] text-[#ddd9f0]"
                  : "text-[#7a779a] hover:text-[#ddd9f0] hover:bg-[#131325]/50"
              }`}
              style={active ? { borderBottom: `1px solid ${tab.color}` } : undefined}
            >
              {tab.label}
              {count > 0 && (
                <span className="ml-1 text-[9px] text-[#555570]">{count}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Note List */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <AnimatePresence>
          {filtered.map((note) => {
            const s = strengths[note.filename];
            const stateColor =
              s?.state === "active" || s?.state === "fresh"
                ? "#f0a500"
                : s?.state === "connected"
                  ? "#00c9b1"
                  : "#35335a";

            return (
              <motion.div
                key={note.filename}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.15 }}
                onClick={() => selectNote(note.filename)}
                className={`group relative px-4 py-3 cursor-pointer border-l-2 transition-colors ${
                  activeFilename === note.filename
                    ? "border-[#f0a500] bg-[#131325]"
                    : "border-transparent hover:bg-[#0d0d1a]/80"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <h3
                    className={`text-sm font-medium truncate font-[Geist,sans-serif] ${
                      activeFilename === note.filename
                        ? "text-[#ddd9f0]"
                        : "text-[#ddd9f0]/80"
                    }`}
                  >
                    {note.title}
                  </h3>
                  <span className="text-[10px] text-[#7a779a] font-[Geist,sans-serif] whitespace-nowrap mt-0.5">
                    {relativeTime(note.modified)}
                  </span>
                </div>

                {previews[note.filename] && (
                  <p className="text-xs text-[#7a779a] mt-1 line-clamp-2 font-[Geist,sans-serif]">
                    {previews[note.filename]}
                  </p>
                )}

                {/* Strength bar */}
                {s && (
                  <div className="flex items-center gap-2 mt-1.5">
                    <div className="flex-1 h-[2px] bg-[#131325] rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-500"
                        style={{
                          width: `${s.strength * 100}%`,
                          backgroundColor: stateColor,
                        }}
                      />
                    </div>
                  </div>
                )}

                {/* Delete */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(note.filename, note.title);
                  }}
                  className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 text-[#7a779a] hover:text-[#f06080] transition-opacity text-xs p-1 rounded hover:bg-[#131325]"
                >
                  ×
                </button>
              </motion.div>
            );
          })}
        </AnimatePresence>

        {filtered.length === 0 && notes.length > 0 && (
          <p className="text-[#35335a] text-xs text-center mt-8 font-[Geist,sans-serif]">
            No matching notes
          </p>
        )}

        {notes.length === 0 && (
          <div className="text-center mt-8 px-4">
            <p className="text-[#7a779a] text-sm font-[Geist,sans-serif]">
              No notes yet
            </p>
            <p className="text-[#35335a] text-xs mt-1 font-[Geist,sans-serif]">
              Start the server, then create your first note
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
