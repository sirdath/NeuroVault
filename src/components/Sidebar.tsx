import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useNoteStore } from "../stores/noteStore";
import { relativeTime, extractPreview } from "../lib/utils";
import type { NoteMeta } from "../lib/tauri";
import { readNote } from "../lib/tauri";

interface NoteStrength {
  strength: number;
  state: string;
  connections: number;
}

function NoteCard({
  note,
  isActive,
  preview,
  strength,
  onSelect,
  onDelete,
}: {
  note: NoteMeta;
  isActive: boolean;
  preview: string;
  strength: NoteStrength | null;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const stateColor =
    strength?.state === "active" || strength?.state === "fresh"
      ? "#f0a500"
      : strength?.state === "connected"
        ? "#00c9b1"
        : "#35335a";

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.15 }}
      onClick={onSelect}
      className={`group relative px-4 py-3 cursor-pointer border-l-2 transition-colors ${
        isActive
          ? "border-[#f0a500] bg-[#131325]"
          : "border-transparent hover:bg-[#0d0d1a]"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3
          className={`text-sm font-medium truncate font-[Geist,sans-serif] ${
            isActive ? "text-[#ddd9f0]" : "text-[#ddd9f0]/80"
          }`}
        >
          {note.title}
        </h3>
        <span className="text-[10px] text-[#7a779a] font-[Geist,sans-serif] whitespace-nowrap mt-0.5">
          {relativeTime(note.modified)}
        </span>
      </div>

      {preview && (
        <p className="text-xs text-[#7a779a] mt-1 line-clamp-2 font-[Geist,sans-serif]">
          {preview}
        </p>
      )}

      {/* Strength bar */}
      {strength && (
        <div className="flex items-center gap-2 mt-1.5">
          <div className="flex-1 h-[2px] bg-[#131325] rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${strength.strength * 100}%`,
                backgroundColor: stateColor,
              }}
            />
          </div>
          {strength.connections > 0 && (
            <span className="text-[9px] text-[#35335a] font-[Geist,sans-serif]">
              {strength.connections}
            </span>
          )}
        </div>
      )}

      {/* Delete button */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 text-[#7a779a] hover:text-[#f06080] transition-opacity text-xs p-1 rounded hover:bg-[#131325]"
        title="Delete note"
      >
        ×
      </button>
    </motion.div>
  );
}

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
  const inputRef = useRef<HTMLInputElement>(null);

  // Load previews
  const loadPreview = async (note: NoteMeta) => {
    if (previews[note.filename] !== undefined) return;
    try {
      const content = await readNote(note.filename);
      setPreviews((prev) => ({
        ...prev,
        [note.filename]: extractPreview(content),
      }));
    } catch {
      setPreviews((prev) => ({ ...prev, [note.filename]: "" }));
    }
  };

  // Load strength data from API
  useEffect(() => {
    fetch("http://127.0.0.1:8765/api/notes")
      .then((r) => r.json())
      .then((apiNotes: Array<{ filename: string; strength: number; state: string; id: string }>) => {
        const map: Record<string, NoteStrength> = {};
        for (const n of apiNotes) {
          // Count connections
          fetch(`http://127.0.0.1:8765/api/backlinks/${n.id}`)
            .then((r) => r.json())
            .then((bl: unknown[]) => {
              setStrengths((prev) => ({
                ...prev,
                [n.filename]: {
                  strength: n.strength,
                  state: n.state,
                  connections: bl.length,
                },
              }));
            })
            .catch(() => {});
          map[n.filename] = { strength: n.strength, state: n.state, connections: 0 };
        }
        setStrengths(map);
      })
      .catch(() => {});
  }, [notes]);

  // Keyboard shortcut: Ctrl+N triggers new note
  useEffect(() => {
    if (triggerNewNote > 0) setIsCreating(true);
  }, [triggerNewNote]);

  // Keyboard shortcut: Ctrl+K focuses search
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (triggerSearch > 0 && searchRef.current) searchRef.current.focus();
  }, [triggerSearch]);

  // Filter notes
  const filtered = notes.filter(
    (note) =>
      searchQuery === "" ||
      note.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleCreate = async () => {
    const title = newTitle.trim();
    if (!title) return;
    await createNote(title);
    setNewTitle("");
    setIsCreating(false);
  };

  const handleDelete = (filename: string, title: string) => {
    if (window.confirm(`Move "${title}" to trash?`)) {
      deleteNoteAction(filename);
    }
  };

  // Focus input when creating
  useEffect(() => {
    if (isCreating && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isCreating]);

  return (
    <div className="w-[260px] min-w-[260px] h-full flex flex-col bg-[#0d0d1a] border-r border-[#1e1e38]">
      {/* Header */}
      <div className="px-4 py-3 border-b border-[#1e1e38]">
        <h1 className="text-lg font-semibold font-[Geist,sans-serif] text-[#f0a500] tracking-tight">
          engram
        </h1>
      </div>

      {/* New Note */}
      <div className="px-3 py-2 border-b border-[#1e1e38]">
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
      <div className="px-3 py-2">
        <input
          ref={searchRef}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search... (Ctrl+K)"
          className="w-full bg-[#131325] text-[#ddd9f0] text-sm px-3 py-1.5 rounded border border-[#1e1e38] focus:border-[#f0a500]/50 focus:outline-none font-[Geist,sans-serif] placeholder:text-[#35335a]"
        />
      </div>

      {/* Note List */}
      <div className="flex-1 overflow-y-auto">
        <AnimatePresence>
          {filtered.map((note) => {
            loadPreview(note);
            return (
              <NoteCard
                key={note.filename}
                note={note}
                isActive={activeFilename === note.filename}
                preview={previews[note.filename] ?? ""}
                strength={strengths[note.filename] ?? null}
                onSelect={() => selectNote(note.filename)}
                onDelete={() => handleDelete(note.filename, note.title)}
              />
            );
          })}
        </AnimatePresence>

        {filtered.length === 0 && notes.length > 0 && (
          <p className="text-[#35335a] text-xs text-center mt-8 font-[Geist,sans-serif]">
            No matching notes
          </p>
        )}

        {notes.length === 0 && (
          <p className="text-[#35335a] text-xs text-center mt-8 px-4 font-[Geist,sans-serif]">
            No notes yet. Create your first memory.
          </p>
        )}
      </div>
    </div>
  );
}
