import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { EditorView } from "@codemirror/view";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useNoteStore, type SaveStatus } from "../stores/noteStore";
import { useBrainStore } from "../stores/brainStore";
import {
  brainUiScope,
  loadScopedTabOrder,
  persistScopedTabOrder,
} from "../lib/brainScopedUiState";
import { ContextMenu } from "./ContextMenu";
import { ConfirmDialog } from "./ConfirmDialog";
import { neurovaultEditorTheme } from "./editor/theme";
import { livePreviewPlugin, livePreviewTheme } from "./editor/livePreview";
import { buildCompletions } from "./editor/completions";
import { useSettingsStore } from "../stores/settingsStore";
import { shortcut } from "../lib/platform";

export function Editor() {
  const brainId = useBrainStore((state) => state.activeBrainId);
  const vaultPath = useNoteStore((state) => state.vaultPath);
  const scope = brainUiScope(brainId, vaultPath);

  // A filename such as `index.md` may exist in many brains. Remounting at
  // this boundary prevents one brain from inheriting another's tabs.
  return <BrainEditor key={scope} scope={scope} />;
}

function BrainEditor({ scope }: { scope: string }) {
  const themeMode = useSettingsStore((state) => state.theme.mode);
  const fontSize = useSettingsStore((state) => state.fontSize);
  const activeFilename = useNoteStore((s) => s.activeFilename);
  const activeContent = useNoteStore((s) => s.activeContent);
  const isDirty = useNoteStore((s) => s.isDirty);
  const saveStatus = useNoteStore((s) => s.saveStatus);
  const saveError = useNoteStore((s) => s.saveError);
  const recoveryDraft = useNoteStore((s) => s.recoveryDraft);
  const recoverDraft = useNoteStore((s) => s.recoverDraft);
  const discardRecoveryDraft = useNoteStore((s) => s.discardRecoveryDraft);
  const transitionLocked = useNoteStore((s) => s.transitionLocked);
  const notesStatus = useNoteStore((s) => s.notesStatus);
  const notesError = useNoteStore((s) => s.notesError);
  const updateContent = useNoteStore((s) => s.updateContent);
  const saveNote = useNoteStore((s) => s.saveNote);
  const saveNoteAsCopy = useNoteStore((s) => s.saveNoteAsCopy);
  const discardUnsavedChanges = useNoteStore((s) => s.discardUnsavedChanges);
  const selectNote = useNoteStore((s) => s.selectNote);
  const closeActiveNote = useNoteStore((s) => s.closeActiveNote);
  const loadNotes = useNoteStore((s) => s.loadNotes);
  const notes = useNoteStore((s) => s.notes);
  const createNote = useNoteStore((s) => s.createNote);
  const [creating, setCreating] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // Tab system — track open tabs as filenames. Order is user-controllable
  // via drag-to-reorder (dnd-kit) and persisted to localStorage so the
  // tab strip looks the way the user left it after a reload.
  const [openTabs, setOpenTabs] = useState<string[]>(() =>
    loadScopedTabOrder(localStorage, scope)
  );

  // When a note is selected, add it to tabs if not already there.
  useEffect(() => {
    if (!activeFilename) return;
    setOpenTabs((tabs) => tabs.includes(activeFilename) ? tabs : [...tabs, activeFilename]);
  }, [activeFilename]);

  // Persist tab order across reloads.
  useEffect(() => {
    try {
      persistScopedTabOrder(localStorage, scope, openTabs);
    } catch { /* quota / private mode */ }
  }, [openTabs, scope]);

  const closeTab = useCallback(
    async (filename: string) => {
      const next = openTabs.filter((tab) => tab !== filename);
      if (filename !== activeFilename) {
        setOpenTabs(next);
        return;
      }

      if (next.length > 0) {
        const index = openTabs.indexOf(filename);
        const replacement = next[Math.min(index, next.length - 1)] ?? next[next.length - 1]!;
        if (!(await selectNote(replacement))) return;
      } else if (!(await closeActiveNote())) {
        return;
      }
      // A failed save leaves the active buffer and its tab untouched.
      setOpenTabs(next);
    },
    [activeFilename, closeActiveNote, openTabs, selectNote]
  );

  // Close every other tab. The right-clicked one becomes active.
  const closeOthers = useCallback(
    async (keepFilename: string) => {
      if (keepFilename !== activeFilename && !(await selectNote(keepFilename))) return;
      setOpenTabs([keepFilename]);
    },
    [activeFilename, selectNote]
  );

  // Close everything — empty tab strip AND empty editor body.
  const closeAll = useCallback(async () => {
    if (!(await closeActiveNote())) return;
    setOpenTabs([]);
  }, [closeActiveNote]);

  // Right-click context menu state. Tracks which tab was clicked
  // so the close-others / close-all actions know the target.
  const [tabMenu, setTabMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    filename: string;
  }>({ open: false, x: 0, y: 0, filename: "" });

  // dnd-kit setup. Pointer sensor with a 6px activation distance so a
  // plain click on the tab body still fires onClick for navigation —
  // only an actual drag gesture starts a reorder.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const handleTabDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setOpenTabs((tabs) => {
      const oldIdx = tabs.indexOf(active.id as string);
      const newIdx = tabs.indexOf(over.id as string);
      if (oldIdx < 0 || newIdx < 0) return tabs;
      return arrayMove(tabs, oldIdx, newIdx);
    });
  }, []);

  // Obsidian-style live preview: one always-on editor. There is no
  // preview/edit toggle - syntax marks simply hide on every line except the
  // one you are editing (see editor/livePreview.ts).

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notesRef = useRef(notes);
  notesRef.current = notes;

  // Build extensions once — autocomplete reads note titles via ref
  const extensions = useMemo(
    () => [
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      EditorView.lineWrapping,
      EditorView.editable.of(!transitionLocked),
      neurovaultEditorTheme(themeMode === "dark", fontSize),
      livePreviewTheme,
      livePreviewPlugin,
      buildCompletions(() => notesRef.current.map((n) => n.title)),
    ],
    [fontSize, themeMode, transitionLocked]
  );

  // Auto-save with 1-second debounce
  useEffect(() => {
    if (!isDirty) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => { void saveNote(); }, 1000);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [isDirty, activeContent, saveNote]);

  const onChange = useCallback(
    (value: string) => { updateContent(value); },
    [updateContent]
  );

  if (!activeFilename) {
    if (notesStatus === "loading" || notesStatus === "idle") {
      return (
        <div
          className="flex-1 flex items-center justify-center"
          style={{ backgroundColor: "var(--nv-bg)", color: "var(--nv-text-muted)" }}
        >
          <span className="text-[13px] font-[Geist,sans-serif]">Loading notes…</span>
        </div>
      );
    }
    if (notesStatus === "error" && notes.length === 0) {
      return (
        <div className="flex-1 flex items-center justify-center" style={{ backgroundColor: "var(--nv-bg)" }}>
          <div className="text-center max-w-sm px-6">
            <p className="text-[15px] font-semibold" style={{ color: "var(--nv-text)" }}>Notes couldn’t be loaded</p>
            <p className="text-[12px] mt-2" style={{ color: "var(--nv-text-dim)" }}>{notesError ?? "Unknown error"}</p>
            <button
              type="button"
              onClick={() => { void loadNotes(); }}
              className="mt-4 px-3 py-2 rounded-lg text-[12px] font-semibold"
              style={{ background: "var(--nv-surface)", color: "var(--nv-text)", border: "1px solid var(--nv-border)" }}
            >
              Retry
            </button>
          </div>
        </div>
      );
    }
    const hasNotes = notes.length > 0;
    const onNewNote = async () => {
      if (creating) return;
      setCreating(true);
      try {
        await createNote("Untitled");
      } finally {
        setCreating(false);
      }
    };
    return (
      <div className="flex-1 flex items-center justify-center" style={{ backgroundColor: "var(--nv-bg)" }}>
        <div className="text-center max-w-sm px-6">
          <div
            className="w-16 h-16 mx-auto mb-6 rounded-2xl flex items-center justify-center"
            style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)", boxShadow: "inset 0 1px 1px rgba(255,255,255,0.05)" }}
          >
            <svg className="w-7 h-7" style={{ color: "var(--nv-text-dim)" }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
            </svg>
          </div>
          <p className="text-[17px] font-semibold font-[Geist,sans-serif]" style={{ color: "var(--nv-text)" }}>
            {hasNotes ? "Nothing open yet" : "Your vault is empty"}
          </p>
          <p className="text-[13px] mt-2 font-[Geist,sans-serif] leading-relaxed" style={{ color: "var(--nv-text-dim)" }}>
            {hasNotes
              ? "Pick a note from the sidebar to start reading, or create a new one."
              : "Start your memory by writing your first markdown note. Everything stays local on your machine."}
          </p>
          <div className="mt-6 flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => void onNewNote()}
              disabled={creating}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-[13px] font-semibold font-[Geist,sans-serif] transition-all disabled:opacity-60"
              style={{ background: "var(--nv-accent)", color: "var(--nv-on-accent)" }}
            >
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              {creating ? "Creating..." : hasNotes ? "New note" : "Create your first note"}
            </button>
          </div>
          <p className="text-[12px] mt-4 font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
            or press <kbd className="px-1.5 py-0.5 rounded-md text-[11px] font-mono" style={{ background: "var(--nv-surface)", color: "var(--nv-text-muted)", border: "1px solid var(--nv-border)" }}>{shortcut("N")}</kbd>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="nv-editor-shell flex-1 flex overflow-hidden" style={{ backgroundColor: "var(--nv-bg)" }}>
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Tab bar — drag to reorder, middle-click to close, x always
            visible. Shown whenever any note is open so a single-tab
            session is still closeable (was hidden < v0.1.8 when only
            one tab was open, leaving the user no way to close it
            without opening a second). */}
        {openTabs.length > 0 && (
          <div
            className="nv-editor-tabs flex items-center overflow-x-auto flex-shrink-0"
            style={{ background: "var(--nv-surface)", borderBottom: "1px solid var(--nv-border)" }}
          >
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleTabDragEnd}
            >
              <SortableContext items={openTabs} strategy={horizontalListSortingStrategy}>
                {openTabs.map((filename) => {
                  const note = notes.find((n) => n.filename === filename);
                  const title = note?.title ?? filename.replace(/\.md$/, "");
                  return (
                    <SortableTab
                      key={filename}
                      filename={filename}
                      title={title}
                      isActive={filename === activeFilename}
                      onSelect={() => { void selectNote(filename); }}
                      onClose={() => { void closeTab(filename); }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setTabMenu({ open: true, x: e.clientX, y: e.clientY, filename });
                      }}
                    />
                  );
                })}
              </SortableContext>
            </DndContext>
          </div>
        )}

        {recoveryDraft && (
          <div
            className="flex shrink-0 items-center gap-3 px-5 py-3"
            style={{ background: "color-mix(in srgb, var(--nv-warning) 8%, transparent)", borderBottom: "1px solid color-mix(in srgb, var(--nv-warning) 25%, transparent)" }}
            role="alert"
          >
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-semibold" style={{ color: "var(--nv-warning)" }}>Unsaved work was recovered from the last session</p>
              <p className="mt-0.5 text-[11px]" style={{ color: "var(--nv-text-dim)" }}>
                A newer draft from {new Date(recoveryDraft.updatedAt).toLocaleString()} differs from the Markdown file. Nothing has been overwritten.
              </p>
            </div>
            <button type="button" onClick={discardRecoveryDraft} className="rounded-lg px-3 py-1.5 text-[11px]" style={{ color: "var(--nv-text-muted)", border: "1px solid var(--nv-border)" }}>
              Keep disk version
            </button>
            <button type="button" onClick={recoverDraft} className="rounded-lg px-3 py-1.5 text-[11px] font-semibold" style={{ color: "var(--nv-on-accent)", background: "var(--nv-warning)" }}>
              Restore draft
            </button>
          </div>
        )}

        {/* Header */}
        <div
          className="nv-editor-header flex items-center justify-between px-6 py-2.5"
          style={{
            background: "color-mix(in srgb, var(--nv-surface-elevated) 84%, transparent)",
            borderBottom: "1px solid var(--nv-border)",
            boxShadow: "inset 0 -1px 0 rgba(255,255,255,0.02)",
          }}
        >
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <span className="text-[14px] font-semibold font-[Geist,sans-serif] truncate" style={{ color: "var(--nv-text)" }} title={activeFilename ?? undefined}>
              {notes.find((n) => n.filename === activeFilename)?.title ??
                activeFilename?.replace(/\.md$/, "") ??
                "Untitled"}
            </span>
            <SaveIndicator
              status={saveStatus}
              error={saveError}
              isDirty={isDirty}
              onRetry={() => { void saveNote(); }}
              onSaveCopy={() => { void saveNoteAsCopy(); }}
              onDiscard={() => setConfirmDiscard(true)}
            />
          </div>
        </div>

        {/* One always-live editor - Obsidian-style. No preview/edit toggle;
            syntax marks hide on every line except the one you are editing. */}
        <div className="nv-editor-canvas flex-1 overflow-auto">
          <CodeMirror
            value={activeContent}
            onChange={onChange}
            extensions={extensions}
            theme="none"
            basicSetup={{
              lineNumbers: false,
              foldGutter: false,
              highlightActiveLine: true,
              highlightSelectionMatches: true,
              bracketMatching: true,
              closeBrackets: true,
              autocompletion: false,
            }}
            className="h-full"
            style={{ height: "100%" }}
          />
        </div>

        <EditorStats content={activeContent} />
      </div>

      {/* Right-click context menu for tabs. Only rendered when the
          user has actually right-clicked a tab; the ContextMenu
          component handles outside-click / Escape / blur dismissal. */}
      <ContextMenu
        open={tabMenu.open}
        x={tabMenu.x}
        y={tabMenu.y}
        items={[
          {
            label: "Close",
            hint: "Middle-click",
            onSelect: () => { void closeTab(tabMenu.filename); },
          },
          {
            label: "Close others",
            disabled: openTabs.length <= 1,
            onSelect: () => { void closeOthers(tabMenu.filename); },
          },
          { divider: true },
          {
            label: "Close all",
            destructive: true,
            disabled: openTabs.length === 0,
            onSelect: () => { void closeAll(); },
          },
        ]}
        onClose={() => setTabMenu((m) => ({ ...m, open: false }))}
      />
      <ConfirmDialog
        open={confirmDiscard}
        title="Discard unsaved changes?"
        message="NeuroVault will reload the last saved Markdown file. The unsaved draft for this note will be permanently removed."
        confirmLabel="Discard changes"
        destructive
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={() => {
          setConfirmDiscard(false);
          void discardUnsavedChanges();
        }}
      />
    </div>
  );
}

function SaveIndicator({
  status,
  error,
  isDirty,
  onRetry,
  onSaveCopy,
  onDiscard,
}: {
  status: SaveStatus;
  error: string | null;
  isDirty: boolean;
  onRetry: () => void;
  onSaveCopy: () => void;
  onDiscard: () => void;
}) {
  if (status === "failed") {
    return (
      <div className="flex items-center gap-1.5" role="alert" title={error ?? "Save failed"}>
        <span className="text-[11px] font-semibold" style={{ color: "var(--nv-negative)" }}>Save failed</span>
        <button type="button" onClick={onRetry} className="rounded-md px-2 py-1 text-[11px] font-medium" style={{ color: "var(--nv-text)", border: "1px solid var(--nv-border)" }}>Retry</button>
        <button type="button" onClick={onSaveCopy} className="rounded-md px-2 py-1 text-[11px] font-medium" style={{ color: "var(--nv-text)", border: "1px solid var(--nv-border)" }}>Save a copy</button>
        <button type="button" onClick={onDiscard} className="rounded-md px-2 py-1 text-[11px] font-medium" style={{ color: "var(--nv-negative)", border: "1px solid color-mix(in srgb, var(--nv-negative) 45%, transparent)" }}>Discard</button>
      </div>
    );
  }
  if (status === "saving") {
    return <span className="text-[11px]" style={{ color: "var(--nv-text-muted)" }}>Saving…</span>;
  }
  if (status === "dirty" || isDirty) {
    return <span className="text-[11px]" style={{ color: "var(--nv-text-dim)" }}>Unsaved</span>;
  }
  return <span className="text-[11px]" style={{ color: "var(--nv-positive)" }}>Saved</span>;
}

/**
 * Small footer showing word count + reading time + char count for the
 * active note. Recomputes from `content` which is cheap even at 100k
 * chars (regex split + divide). Hidden on empty notes so the welcome
 * screen stays minimal.
 */
function EditorStats({ content }: { content: string }) {
  const stats = useMemo(() => {
    if (!content) return null;
    // Strip frontmatter + heading markup + code fences + wikilinks for a
    // reading-oriented count (matches what a reader actually processes,
    // not raw markdown syntax).
    const stripped = content
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`[^`]*`/g, " ")
      .replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, "$1")
      .replace(/[#*_>`]/g, " ");
    const words = stripped.trim().split(/\s+/).filter(Boolean).length;
    const chars = content.length;
    // 238 wpm is the mean adult reading speed for prose
    // (Trauzettel-Klosinski & Dietz 2012). Round up to keep short
    // snippets from flashing "0 min".
    const minutes = Math.max(1, Math.round(words / 238));
    return { words, chars, minutes };
  }, [content]);

  if (!stats) return null;
  return (
    <div
      className="flex items-center gap-4 px-6 py-1.5 text-[11px] font-[Geist,sans-serif] flex-shrink-0 tabular-nums"
      style={{
        background: "var(--nv-surface)",
        borderTop: "1px solid var(--nv-border)",
        color: "var(--nv-text-dim)",
      }}
    >
      <span>{stats.words.toLocaleString()} {stats.words === 1 ? "word" : "words"}</span>
      <span style={{ color: "var(--nv-text-dim)" }}>·</span>
      <span>{stats.chars.toLocaleString()} chars</span>
      <span style={{ color: "var(--nv-text-dim)" }}>·</span>
      <span>{stats.minutes} min read</span>
    </div>
  );
}

/**
 * One tab in the editor tab strip. Wrapped in dnd-kit's `useSortable`
 * so the user can grab and drop to reorder. The PointerSensor's 6px
 * activation distance (set on the parent <DndContext>) means a quick
 * click still fires `onSelect` cleanly — only an actual drag gesture
 * starts a reorder.
 *
 * Behavioural details worth preserving:
 *   - Middle-click closes the tab (mouse button 1, matched in onMouseDown
 *     because some browsers don't fire onClick for the middle button).
 *   - The × is always visible (was hover-only with a broken
 *     `group-hover:opacity-100` referencing a parent `group` class that
 *     didn't exist). It dims to text-muted at rest, brightens on hover.
 *   - The × button has `e.stopPropagation()` so clicking it doesn't also
 *     activate the tab on the way down.
 *   - During an active drag, opacity drops to 0.5 so the user sees which
 *     tab they've grabbed.
 */
function SortableTab({
  filename,
  title,
  isActive,
  onSelect,
  onClose,
  onContextMenu,
}: {
  filename: string;
  title: string;
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: filename });

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={onSelect}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          onClose();
        }
      }}
      onContextMenu={onContextMenu}
      role="tab"
      aria-selected={isActive}
      className="flex items-center gap-2 px-3 py-2 text-[12px] font-[Geist,sans-serif] whitespace-nowrap transition-all flex-shrink-0 max-w-[200px] cursor-pointer select-none"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        color: isActive ? "var(--nv-text)" : "var(--nv-text-muted)",
        borderBottom: isActive ? "2px solid var(--nv-accent)" : "2px solid transparent",
        background: isActive ? "var(--nv-surface)" : undefined,
        zIndex: isDragging ? 1 : undefined,
      }}
    >
      <span className="truncate">{title}</span>
      <span
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        onMouseDown={(e) => e.stopPropagation()}
        className="text-[12px] w-5 h-5 flex items-center justify-center rounded leading-none transition-colors hover:[background-color:var(--nv-surface-elevated,var(--nv-surface))]"
        style={{ color: "var(--nv-text-muted)" }}
        title="Close"
        aria-label={`Close ${title}`}
      >
        ×
      </span>
    </div>
  );
}
