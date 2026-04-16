import { useState, useEffect, useRef, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useNoteStore } from "../stores/noteStore";
import { relativeTime, extractPreview } from "../lib/utils";
import { readNote } from "../lib/tauri";
import type { NoteMeta } from "../lib/tauri";


// Virtualized row estimate. Rows with previews run ~72px, without ~48px.
// The virtualizer uses this as a bootstrap and then refines per-row once
// each row is measured via measureElement.
const ESTIMATED_ROW_HEIGHT = 68;
const VIRTUAL_OVERSCAN = 6;


export function Sidebar({
  triggerNewNote = 0,
  triggerSearch = 0,
  onNoteSelect,
}: {
  triggerNewNote?: number;
  triggerSearch?: number;
  onNoteSelect?: () => void;
} = {}) {
  const notes = useNoteStore((s) => s.notes);
  const activeFilename = useNoteStore((s) => s.activeFilename);
  const searchQuery = useNoteStore((s) => s.searchQuery);
  const setSearchQuery = useNoteStore((s) => s.setSearchQuery);
  const _selectNote = useNoteStore((s) => s.selectNote);

  // When a note is clicked, select it AND switch to editor view
  const selectNote = useCallback(
    async (filename: string) => {
      await _selectNote(filename);
      onNoteSelect?.();
    },
    [_selectNote, onNoteSelect]
  );
  const createNote = useNoteStore((s) => s.createNote);
  const deleteNoteAction = useNoteStore((s) => s.deleteNote);

  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [isCreating, setIsCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
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
    if (
      searchQuery !== "" &&
      !note.title.toLowerCase().includes(searchQuery.toLowerCase())
    ) {
      return false;
    }
    return true;
  });

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

  // Resizable sidebar width
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const resizing = useRef(false);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!resizing.current) return;
      const w = Math.max(200, Math.min(500, e.clientX));
      setSidebarWidth(w);
    };
    const onMouseUp = () => { resizing.current = false; document.body.style.cursor = ""; };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => { window.removeEventListener("mousemove", onMouseMove); window.removeEventListener("mouseup", onMouseUp); };
  }, []);

  return (
    <div
      className="h-full flex flex-col backdrop-blur-[10px] relative"
      style={{
        width: sidebarWidth,
        minWidth: sidebarWidth,
        background: "var(--nv-surface)",
        borderRight: "1px solid var(--nv-border)",
      }}
    >
      {/* Resize handle */}
      <div
        className="absolute top-0 right-0 w-1 h-full cursor-col-resize z-10 hover:bg-white/[0.08] active:bg-white/[0.12] transition-colors"
        onMouseDown={() => { resizing.current = true; document.body.style.cursor = "col-resize"; }}
      />
      {/* Header */}
      <div className="px-5 pt-5 pb-4 flex-shrink-0">
        <div className="flex items-center justify-between mb-5">
          <h1 className="text-[15px] font-semibold font-[Geist,sans-serif] tracking-tight" style={{ color: "var(--nv-text)" }}>
            NeuroVault
          </h1>
          <button
            onClick={() => setIsCreating(true)}
            className="w-7 h-7 flex items-center justify-center rounded-xl bg-white/[0.07] text-white/50 hover:bg-white/[0.12] hover:text-white/80 transition-all text-lg leading-none border border-white/[0.06]"
            title="New note (Ctrl+N)"
          >
            +
          </button>
        </div>

        {/* Search */}
        <div className="relative">
          <input
            ref={searchRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search notes..."
            className="w-full bg-white/[0.06] text-white/90 text-[13px] pl-8 pr-3 py-2 rounded-xl border border-white/[0.08] focus:border-white/[0.15] focus:bg-white/[0.08] focus:outline-none font-[Geist,sans-serif] placeholder:text-white/20 transition-all"
            style={{ boxShadow: "inset 0 1px 1px rgba(255,255,255,0.05)" }}
          />
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
      </div>

      {/* New note input (expands when creating) */}
      {isCreating && (
        <div className="px-4 pb-3 flex-shrink-0">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleCreate();
            }}
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
              className="w-full bg-white/[0.06] text-white/90 text-[13px] px-3 py-2 rounded-xl border border-white/[0.12] focus:border-white/[0.2] focus:outline-none font-[Geist,sans-serif] placeholder:text-white/20"
              autoFocus
            />
          </form>
        </div>
      )}

      {/* Note List — virtualized via @tanstack/react-virtual.
           Row heights vary (with/without preview/strength bar), so we let
           the virtualizer measure each row after first paint via
           measureElement. The scroll container MUST have a fixed height
           (flex-1 + min-h-0 provides that inside the flex column). */}
      <NoteList
        filtered={filtered}
        previews={previews}
        activeFilename={activeFilename}
        onSelect={(fn) => selectNote(fn)}
        onDelete={handleDelete}
      />

      <div className="flex-shrink-0 px-4">
        {filtered.length === 0 && notes.length > 0 && (
          <p className="text-[#4a4870] text-[13px] text-center mt-12 font-[Geist,sans-serif]">
            No results
          </p>
        )}

        {notes.length === 0 && (
          <div className="mt-12 text-center">
            <div className="w-10 h-10 mx-auto mb-4 rounded-xl bg-[#16162a] flex items-center justify-center">
              <span className="text-[#b592ff] text-lg">+</span>
            </div>
            <p className="text-[#8a88a0] text-[13px] font-[Geist,sans-serif] mb-1">
              No notes yet
            </p>
            <p className="text-[#4a4870] text-[12px] font-[Geist,sans-serif] mb-6">
              Press <kbd className="px-1.5 py-0.5 bg-[#16162a] rounded text-[#b592ff] text-[11px] font-mono">Ctrl+N</kbd> to start
            </p>
            <div className="text-left space-y-2">
              <p className="text-[12px] text-[#4a4870] font-[Geist,sans-serif]">
                <span className="text-[#b592ff] font-mono">[[</span> link notes together
              </p>
              <p className="text-[12px] text-[#4a4870] font-[Geist,sans-serif]">
                <kbd className="text-[#6a6880] font-mono">Ctrl+K</kbd> search everything
              </p>
              <p className="text-[12px] text-[#4a4870] font-[Geist,sans-serif]">
                Auto-saves as you type
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Virtualized note list ------------------------------------------------

interface NoteListProps {
  filtered: NoteMeta[];
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
              }}
              className="px-3 py-0.5"
            >
              <div
                className="group relative cursor-pointer rounded-2xl px-3.5 py-3 transition-all duration-200"
                style={isActive ? {
                  background: "var(--nv-surface)",
                  border: `1px solid var(--nv-border)`,
                  boxShadow: `inset 0 1px 1px rgba(255,255,255,0.06), 0 4px 16px rgba(0,0,0,0.15)`,
                } : {
                  border: "1px solid transparent",
                }}
              >
                <div className="flex items-start justify-between gap-2">
                  <h3
                    className="text-[13px] font-medium truncate font-[Geist,sans-serif] leading-snug"
                    style={{ color: isActive ? "var(--nv-text)" : "var(--nv-text-muted)" }}
                  >
                    {note.title}
                  </h3>
                  <span className="text-[10px] font-[Geist,sans-serif] whitespace-nowrap mt-0.5" style={{ color: "var(--nv-text-dim)" }}>
                    {relativeTime(note.modified)}
                  </span>
                </div>

                {preview && (
                  <p className="text-[11.5px] mt-1.5 line-clamp-2 font-[Geist,sans-serif] leading-relaxed" style={{ color: "var(--nv-text-dim)" }}>
                    {preview}
                  </p>
                )}

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(note.filename, note.title);
                  }}
                  className="absolute top-2.5 right-2.5 opacity-0 group-hover:opacity-100 text-white/20 hover:text-[#ff6b6b] transition-all text-xs w-5 h-5 flex items-center justify-center rounded-lg hover:bg-white/[0.06]"
                >
                  ×
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
