import { useState, useEffect, useRef, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useNoteStore } from "../stores/noteStore";
import { relativeTime, extractPreview } from "../lib/utils";
import { readNote } from "../lib/tauri";
import type { NoteMeta } from "../lib/tauri";

interface NoteStrength {
  strength: number;
  state: string;
  connections: number;
  kind?: string;
}

// Virtualized row estimate. Rows with previews run ~72px, without ~48px.
// The virtualizer uses this as a bootstrap and then refines per-row once
// each row is measured via measureElement.
const ESTIMATED_ROW_HEIGHT = 68;
const VIRTUAL_OVERSCAN = 6;

type KindFilter = "all" | "note" | "source" | "quote" | "draft" | "question";

const KIND_TABS: Array<{ id: KindFilter; label: string; color: string }> = [
  { id: "all", label: "All", color: "#a8a6c0" },
  { id: "note", label: "Notes", color: "#f0a500" },
  { id: "source", label: "Sources", color: "#00c9b1" },
  { id: "quote", label: "Quotes", color: "#8b7cf8" },
  { id: "draft", label: "Drafts", color: "#ff6b6b" },
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
    <div className="w-[260px] min-w-[260px] h-full flex flex-col bg-[#12121c] border-r border-[#1f1f2e]">
      {/* Header */}
      <div className="px-4 py-3 border-b border-[#1f1f2e] flex-shrink-0">
        <h1 className="text-lg font-semibold font-[Geist,sans-serif] text-[#f0a500] tracking-tight">
          neurovault
        </h1>
      </div>

      {/* New Note */}
      <div className="px-3 py-2 border-b border-[#1f1f2e] flex-shrink-0">
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
              className="flex-1 bg-[#1a1a28] text-[#e8e6f0] text-sm px-2 py-1.5 rounded border border-[#1f1f2e] focus:border-[#f0a500] focus:outline-none font-[Geist,sans-serif] placeholder:text-[#35335a]"
            />
            <button
              type="submit"
              className="text-[#f0a500] text-sm px-2 py-1 hover:bg-[#1a1a28] rounded font-[Geist,sans-serif]"
            >
              +
            </button>
          </form>
        ) : (
          <button
            onClick={() => setIsCreating(true)}
            className="w-full text-left text-sm text-[#8a88a0] hover:text-[#f0a500] px-2 py-1.5 hover:bg-[#1a1a28] rounded transition-colors font-[Geist,sans-serif]"
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
          className="w-full bg-[#1a1a28] text-[#e8e6f0] text-sm px-3 py-1.5 rounded border border-[#1f1f2e] focus:border-[#f0a500]/50 focus:outline-none font-[Geist,sans-serif] placeholder:text-[#35335a]"
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
                  ? "bg-[#1a1a28] text-[#e8e6f0]"
                  : "text-[#8a88a0] hover:text-[#e8e6f0] hover:bg-[#1a1a28]/50"
              }`}
              style={active ? { borderBottom: `1px solid ${tab.color}` } : undefined}
            >
              {tab.label}
              {count > 0 && (
                <span className="ml-1 text-[9px] text-[#6a6880]">{count}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Note List — virtualized via @tanstack/react-virtual.
           Row heights vary (with/without preview/strength bar), so we let
           the virtualizer measure each row after first paint via
           measureElement. The scroll container MUST have a fixed height
           (flex-1 + min-h-0 provides that inside the flex column). */}
      <NoteList
        filtered={filtered}
        strengths={strengths}
        previews={previews}
        activeFilename={activeFilename}
        onSelect={(fn) => selectNote(fn)}
        onDelete={handleDelete}
      />

      <div className="flex-shrink-0">
        {filtered.length === 0 && notes.length > 0 && (
          <p className="text-[#35335a] text-xs text-center mt-8 font-[Geist,sans-serif]">
            No matching notes
          </p>
        )}

        {notes.length === 0 && (
          <div className="text-center mt-8 px-4">
            <p className="text-[#8a88a0] text-sm font-[Geist,sans-serif]">
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

// --- Virtualized note list ------------------------------------------------

interface NoteListProps {
  filtered: NoteMeta[];
  strengths: Record<string, NoteStrength>;
  previews: Record<string, string>;
  activeFilename: string | null;
  onSelect: (filename: string) => void;
  onDelete: (filename: string, title: string) => void;
}

/**
 * Virtualized note-list scroller. Only renders rows currently in the
 * viewport (+ overscan) regardless of total list size, so sidebars with
 * thousands of notes stay as responsive as lists with ten.
 *
 * Rows have variable heights (preview lines wrap, strength bar optional)
 * so we let `measureElement` take a real measurement on first paint and
 * cache it by index. Selection by filename keeps row identity stable
 * across filter changes so scroll position isn't reset.
 */
function NoteList({
  filtered,
  strengths,
  previews,
  activeFilename,
  onSelect,
  onDelete,
}: NoteListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: VIRTUAL_OVERSCAN,
    getItemKey: (index) => filtered[index]?.filename ?? index,
  });

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto min-h-0"
      data-testid="sidebar-note-list"
    >
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: "100%",
          position: "relative",
        }}
      >
        {virtualItems.map((virtualRow) => {
          const note = filtered[virtualRow.index];
          if (!note) return null;
          const s = strengths[note.filename];
          const stateColor =
            s?.state === "active" || s?.state === "fresh"
              ? "#f0a500"
              : s?.state === "connected"
                ? "#00c9b1"
                : "#35335a";
          const isActive = activeFilename === note.filename;
          const preview = previews[note.filename];

          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              onClick={() => onSelect(note.filename)}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start}px)`,
                paddingLeft: "var(--pad-x)",
                paddingRight: "var(--pad-x)",
                paddingTop: "var(--pad-y)",
                paddingBottom: "var(--pad-y)",
              }}
              className={`group cursor-pointer border-l-2 transition-colors ${
                isActive
                  ? "border-[#f0a500] bg-[#1a1a28]"
                  : "border-transparent hover:bg-[#12121c]/80"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <h3
                  className={`text-sm font-medium truncate font-[Geist,sans-serif] ${
                    isActive ? "text-[#e8e6f0]" : "text-[#e8e6f0]/80"
                  }`}
                >
                  {note.title}
                </h3>
                <span className="text-[10px] text-[#8a88a0] font-[Geist,sans-serif] whitespace-nowrap mt-0.5">
                  {relativeTime(note.modified)}
                </span>
              </div>

              {preview && (
                <p className="text-xs text-[#8a88a0] mt-1 line-clamp-2 font-[Geist,sans-serif]">
                  {preview}
                </p>
              )}

              {s && (
                <div className="flex items-center gap-2 mt-1.5">
                  <div className="flex-1 h-[2px] bg-[#1a1a28] rounded-full overflow-hidden">
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

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(note.filename, note.title);
                }}
                className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 text-[#8a88a0] hover:text-[#ff6b6b] transition-opacity text-xs p-1 rounded hover:bg-[#1a1a28]"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
