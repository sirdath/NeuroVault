import { useState, useEffect, useRef, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useNoteStore } from "../stores/noteStore";
import { relativeTime, extractPreview } from "../lib/utils";
import { readNote } from "../lib/tauri";
import { BrainSelector } from "./BrainSelector";
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
  onSettingsOpen,
}: {
  triggerNewNote?: number;
  triggerSearch?: number;
  onNoteSelect?: () => void;
  onSettingsOpen?: () => void;
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
  const renameNoteAction = useNoteStore((s) => s.renameNote);

  // Inline rename — populated with the note's current filename when the
  // user clicks the pencil icon on a row. The corresponding row renders
  // an input instead of the title. Enter commits; Esc cancels.
  const [renamingFilename, setRenamingFilename] = useState<string | null>(null);

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

  // Full-text search via /api/recall when the server is up; local title
  // substring match as a fallback when it's not. noteStore.setSearchQuery
  // populates searchResults async, so a fresh keystroke may briefly
  // filter by title before the server reply lands — intentional; avoids
  // the sidebar going blank while we wait.
  const searchResults = useNoteStore((s) => s.searchResults);
  const filtered = (() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return notes;
    if (searchResults.length > 0) {
      const rank = new Map(searchResults.map((fn, i) => [fn, i]));
      return notes
        .filter((n) => rank.has(n.filename))
        .sort((a, b) => (rank.get(a.filename)! - rank.get(b.filename)!));
    }
    // Local fallback: match title OR filename path substring. Adding
    // filename lets users find notes by folder name too ("agent/…").
    return notes.filter(
      (n) =>
        n.title.toLowerCase().includes(q) ||
        n.filename.toLowerCase().includes(q),
    );
  })();

  // Folder tree state — first path segment of filename groups notes.
  // Notes with no slash in filename live at root (they render directly).
  // Expanded state persists in localStorage so collapses survive reloads.
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem("nv.folders.expanded");
      if (raw) return JSON.parse(raw);
    } catch { /* corrupt */ }
    return { agent: true, user: true };
  });
  useEffect(() => {
    try { localStorage.setItem("nv.folders.expanded", JSON.stringify(expanded)); }
    catch { /* quota */ }
  }, [expanded]);
  const toggleFolder = useCallback((name: string) => {
    setExpanded((prev) => ({ ...prev, [name]: !prev[name] }));
  }, []);

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
        className="absolute top-0 right-0 w-1 h-full cursor-col-resize z-10 hover:[background-color:var(--nv-border)] active:[background-color:var(--nv-accent-glow)] transition-colors"
        onMouseDown={() => { resizing.current = true; document.body.style.cursor = "col-resize"; }}
      />
      {/* Header — search + new note on same line */}
      <div className="px-3 pt-3 pb-2 flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <input
              ref={searchRef}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search notes..."
              className="w-full text-[13px] pl-8 pr-3 py-1.5 rounded-md focus:outline-none font-[Geist,sans-serif] transition-all"
              style={{
                background: "var(--nv-surface)",
                color: "var(--nv-text)",
                border: "1px solid var(--nv-border)",
              }}
            />
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: "var(--nv-text-dim)" }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <button
            onClick={() => setIsCreating(true)}
            className="w-7 h-7 flex items-center justify-center rounded-md transition-all text-base leading-none flex-shrink-0"
            style={{ background: "var(--nv-surface)", color: "var(--nv-text-muted)", border: "1px solid var(--nv-border)" }}
            title="New note (Ctrl+N)"
          >
            +
          </button>
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
              className="w-full text-[13px] px-3 py-2 rounded-md focus:outline-none font-[Geist,sans-serif]"
              style={{ background: "var(--nv-surface)", color: "var(--nv-text)", border: "1px solid var(--nv-border)" }}
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
        rows={buildFolderRows(filtered, expanded)}
        previews={previews}
        activeFilename={activeFilename}
        onSelect={(fn) => selectNote(fn)}
        onDelete={handleDelete}
        onToggleFolder={toggleFolder}
        renamingFilename={renamingFilename}
        onStartRename={setRenamingFilename}
        onCommitRename={async (oldFn, newFn) => {
          if (newFn.trim() === oldFn || !newFn.trim()) {
            setRenamingFilename(null);
            return;
          }
          const ok = await renameNoteAction(oldFn, newFn.trim());
          if (ok) setRenamingFilename(null);
        }}
      />

      {/* Empty states */}
      {filtered.length === 0 && notes.length > 0 && (
        <p className="text-[13px] text-center mt-12 font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
          No results
        </p>
      )}
      {notes.length === 0 && (
        <div className="mt-12 text-center px-4">
          <p className="text-[13px] font-[Geist,sans-serif] mb-1" style={{ color: "var(--nv-text-muted)" }}>
            No notes yet
          </p>
          <p className="text-[12px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
            Press <kbd className="px-1 py-0.5 rounded text-[11px] font-mono" style={{ background: "var(--nv-surface)", color: "var(--nv-accent)" }}>Ctrl+N</kbd> to start
          </p>
        </div>
      )}

      {/* Bottom bar — Obsidian-style: brain selector + settings */}
      <div
        className="flex-shrink-0 flex items-center justify-between px-3 py-2 gap-2"
        style={{ borderTop: "1px solid var(--nv-border)" }}
      >
        <BrainSelector />
        {/* Small NeuroVault mark — three connected nodes, a neural-graph
            motif that matches the product's memory-as-graph framing. */}
        <svg
          viewBox="0 0 24 24"
          className="w-4 h-4 flex-shrink-0"
          style={{ color: "var(--nv-accent)", opacity: 0.6 }}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.4}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-label="NeuroVault"
        >
          <path d="M7 8l5 4 5-4" />
          <path d="M7 8v8l5 4" />
          <path d="M17 8v8l-5 4" />
          <circle cx="7" cy="8" r="1.5" fill="currentColor" />
          <circle cx="17" cy="8" r="1.5" fill="currentColor" />
          <circle cx="12" cy="12" r="1.5" fill="currentColor" />
          <circle cx="12" cy="20" r="1.5" fill="currentColor" />
        </svg>
        <button
          onClick={() => onSettingsOpen?.()}
          className="w-7 h-7 flex items-center justify-center rounded-md transition-all"
          style={{ color: "var(--nv-text-dim)" }}
          title="Settings"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// --- Inline rename input --------------------------------------------------

/**
 * Autofocused filename input used when a note row enters rename mode.
 * The filename is a relative path (e.g. `agent/foo.md`); editing the
 * path prefix effectively MOVES the note across folders — one primitive
 * covers rename + move + manual folder creation.
 */
function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (next: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    // Select only the stem — not the folder prefix or the .md extension —
    // so the common case (renaming inside the current folder) is one
    // keystroke: start typing and the stem gets replaced.
    const slash = initial.lastIndexOf("/");
    const dot = initial.lastIndexOf(".md");
    const from = slash + 1;
    const to = dot > from ? dot : initial.length;
    try { ref.current?.setSelectionRange(from, to); } catch { /* ignore */ }
  }, [initial]);

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") onCommit(value);
        else if (e.key === "Escape") onCancel();
      }}
      onBlur={() => onCommit(value)}
      className="w-full text-[13px] px-2 py-1 rounded-md focus:outline-none font-mono"
      style={{
        background: "var(--nv-bg)",
        color: "var(--nv-text)",
        border: "1px solid var(--nv-accent)",
      }}
      placeholder="folder/name.md"
    />
  );
}

// --- Folder tree helpers --------------------------------------------------

type Row =
  | { kind: "folder"; name: string; count: number; expanded: boolean }
  | { kind: "note"; note: NoteMeta; indent: number };

/**
 * Flatten notes into a renderable row list grouped by their top-level
 * folder (first segment of `filename` before `/`). Folders come first in
 * alphabetical order; root-level notes trail behind. Notes inside a
 * folder only appear when the folder is expanded.
 */
function buildFolderRows(
  notes: NoteMeta[],
  expanded: Record<string, boolean>,
): Row[] {
  const byFolder: Record<string, NoteMeta[]> = {};
  const rootNotes: NoteMeta[] = [];
  for (const n of notes) {
    const slash = n.filename.indexOf("/");
    if (slash > 0) {
      const folder = n.filename.slice(0, slash);
      (byFolder[folder] ??= []).push(n);
    } else {
      rootNotes.push(n);
    }
  }
  const rows: Row[] = [];
  const folderNames = Object.keys(byFolder).sort((a, b) => a.localeCompare(b));
  for (const name of folderNames) {
    const isOpen = expanded[name] !== false;
    rows.push({ kind: "folder", name, count: byFolder[name]!.length, expanded: isOpen });
    if (isOpen) {
      for (const n of byFolder[name]!) rows.push({ kind: "note", note: n, indent: 1 });
    }
  }
  for (const n of rootNotes) rows.push({ kind: "note", note: n, indent: 0 });
  return rows;
}

// --- Virtualized note list ------------------------------------------------

interface NoteListProps {
  rows: Row[];
  previews: Record<string, string>;
  activeFilename: string | null;
  onSelect: (filename: string) => void;
  onDelete: (filename: string, title: string) => void;
  onToggleFolder: (name: string) => void;
  renamingFilename: string | null;
  onStartRename: (filename: string | null) => void;
  onCommitRename: (oldFilename: string, newFilename: string) => void;
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
  rows,
  previews,
  activeFilename,
  onSelect,
  onDelete,
  onToggleFolder,
  renamingFilename,
  onStartRename,
  onCommitRename,
}: NoteListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.kind === "folder" ? 32 : ESTIMATED_ROW_HEIGHT),
    overscan: VIRTUAL_OVERSCAN,
    getItemKey: (i) => {
      const r = rows[i];
      if (!r) return i;
      return r.kind === "folder" ? `folder:${r.name}` : `note:${r.note.filename}`;
    },
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
          const row = rows[virtualRow.index];
          if (!row) return null;

          const positioning: React.CSSProperties = {
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            transform: `translateY(${virtualRow.start}px)`,
          };

          if (row.kind === "folder") {
            return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                style={positioning}
                className="px-3 pt-1"
              >
                <button
                  onClick={() => onToggleFolder(row.name)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors hover:[background-color:var(--nv-surface)]"
                  style={{ color: "var(--nv-text-muted)" }}
                >
                  <svg
                    className={`w-[11px] h-[11px] flex-shrink-0 transition-transform duration-150 ${row.expanded ? "rotate-90" : ""}`}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                  <svg
                    className="w-[13px] h-[13px] flex-shrink-0"
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}
                    style={{ opacity: 0.7 }}
                  >
                    {row.expanded ? (
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 00-1.883 2.542l.857 6a2.25 2.25 0 002.227 1.932H19.05a2.25 2.25 0 002.227-1.932l.857-6a2.25 2.25 0 00-1.883-2.542m-16.5 0V6A2.25 2.25 0 016 3.75h3.879a1.5 1.5 0 011.06.44l2.122 2.12a1.5 1.5 0 001.06.44H18A2.25 2.25 0 0120.25 9v.776" />
                    ) : (
                      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                    )}
                  </svg>
                  <span className="text-[12px] font-[Geist,sans-serif] capitalize truncate">
                    {row.name}
                  </span>
                  <span className="ml-auto text-[10px] font-[Geist,sans-serif] tabular-nums" style={{ color: "var(--nv-text-dim)" }}>
                    {row.count}
                  </span>
                </button>
              </div>
            );
          }

          const note = row.note;
          const isActive = activeFilename === note.filename;
          const preview = previews[note.filename];
          const isRenaming = renamingFilename === note.filename;

          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              onClick={() => !isRenaming && onSelect(note.filename)}
              style={positioning}
              className="py-0.5"
            >
              <div
                className="group relative cursor-pointer rounded-lg px-3.5 py-3 transition-all duration-200"
                style={{
                  marginLeft: 12 + row.indent * 16,
                  marginRight: 12,
                  ...(isActive ? {
                    background: "var(--nv-surface)",
                    border: `1px solid var(--nv-border)`,
                    boxShadow: `inset 0 1px 1px rgba(255,255,255,0.06), 0 4px 16px rgba(0,0,0,0.15)`,
                  } : {
                    border: "1px solid transparent",
                  }),
                }}
              >
                {isRenaming ? (
                  <RenameInput
                    initial={note.filename}
                    onCommit={(next) => onCommitRename(note.filename, next)}
                    onCancel={() => onStartRename(null)}
                  />
                ) : (
                  <>
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

                    {/* Hover toolbar: rename + delete. Pencil opens the
                        inline filename editor; × goes straight to trash
                        (already confirmed via window.confirm upstream). */}
                    <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5">
                      <button
                        onClick={(e) => { e.stopPropagation(); onStartRename(note.filename); }}
                        className="w-5 h-5 flex items-center justify-center rounded-md transition-colors [color:var(--nv-text-dim)] hover:[color:var(--nv-text)] hover:[background-color:var(--nv-surface)]"
                        title="Rename (change name or move folder)"
                      >
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
                        </svg>
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); onDelete(note.filename, note.title); }}
                        className="w-5 h-5 flex items-center justify-center rounded-md transition-colors text-xs [color:var(--nv-text-dim)] hover:[color:var(--nv-negative)] hover:[background-color:var(--nv-surface)]"
                        title="Move to trash"
                      >
                        ×
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
