import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { EditorView } from "@codemirror/view";
import { useNoteStore } from "../stores/noteStore";
import { neurovaultTheme } from "./editor/theme";
import { livePreviewPlugin, livePreviewTheme } from "./editor/livePreview";
import { buildCompletions } from "./editor/completions";
import { MarkdownPreview } from "./MarkdownPreview";

export function Editor() {
  const activeFilename = useNoteStore((s) => s.activeFilename);
  const activeContent = useNoteStore((s) => s.activeContent);
  const isDirty = useNoteStore((s) => s.isDirty);
  const updateContent = useNoteStore((s) => s.updateContent);
  const saveNote = useNoteStore((s) => s.saveNote);
  const selectNote = useNoteStore((s) => s.selectNote);
  const notes = useNoteStore((s) => s.notes);

  // Tab system — track open tabs as filenames
  const [openTabs, setOpenTabs] = useState<string[]>([]);

  // When a note is selected, add it to tabs if not already there
  useEffect(() => {
    if (activeFilename && !openTabs.includes(activeFilename)) {
      setOpenTabs((t) => [...t, activeFilename]);
    }
  }, [activeFilename]); // eslint-disable-line react-hooks/exhaustive-deps

  const closeTab = (filename: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = openTabs.filter((f) => f !== filename);
    setOpenTabs(next);
    if (filename === activeFilename && next.length > 0) {
      selectNote(next[next.length - 1]!);
    }
  };

  // Reader mode by default. Only switches to raw CodeMirror when the user
  // explicitly clicks "Edit". Escape flips back to preview.
  const [mode, setMode] = useState<"preview" | "edit">("preview");

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notesRef = useRef(notes);
  notesRef.current = notes;

  // Build extensions once — autocomplete reads note titles via ref
  const extensions = useMemo(
    () => [
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      EditorView.lineWrapping,
      neurovaultTheme,
      livePreviewTheme,
      livePreviewPlugin,
      buildCompletions(() => notesRef.current.map((n) => n.title)),
    ],
    []
  );

  // Auto-save with 1-second debounce
  useEffect(() => {
    if (!isDirty) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => { saveNote(); }, 1000);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [isDirty, activeContent, saveNote]);

  // Reset to preview whenever a different note is opened so the user always
  // starts in reader mode, same as Obsidian's default behaviour.
  useEffect(() => {
    setMode("preview");
  }, [activeFilename]);

  // Escape in edit mode flips back to preview (only when focus is not in
  // an input the user might be typing into — CodeMirror's own focus is
  // fine since Escape is treated as a view toggle there).
  useEffect(() => {
    if (mode !== "edit") return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA")) return;
      e.preventDefault();
      setMode("preview");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [mode]);

  const onChange = useCallback(
    (value: string) => { updateContent(value); },
    [updateContent]
  );

  if (!activeFilename) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ backgroundColor: "var(--nv-bg)" }}>
        <div className="text-center max-w-xs">
          <div
            className="w-14 h-14 mx-auto mb-5 rounded-2xl flex items-center justify-center"
            style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)", boxShadow: "inset 0 1px 1px rgba(255,255,255,0.05)" }}
          >
            <svg className="w-6 h-6" style={{ color: "var(--nv-text-dim)" }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
            </svg>
          </div>
          <p className="text-[15px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>
            Select a note to start reading
          </p>
          <p className="text-[13px] mt-2 font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
            or press <kbd className="px-1.5 py-0.5 rounded-md text-[12px] font-mono" style={{ background: "var(--nv-surface)", color: "var(--nv-text-muted)", border: "1px solid var(--nv-border)" }}>Ctrl+N</kbd> to create one
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex overflow-hidden" style={{ backgroundColor: "var(--nv-bg)" }}>
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Tab bar */}
        {openTabs.length > 1 && (
          <div
            className="flex items-center overflow-x-auto flex-shrink-0"
            style={{ background: "var(--nv-surface)", borderBottom: "1px solid var(--nv-border)" }}
          >
            {openTabs.map((filename) => {
              const note = notes.find((n) => n.filename === filename);
              const title = note?.title ?? filename.replace(/\.md$/, "");
              const isActive = filename === activeFilename;
              return (
                <button
                  key={filename}
                  onClick={() => selectNote(filename)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-[Geist,sans-serif] whitespace-nowrap transition-all flex-shrink-0 max-w-[180px]"
                  style={{
                    color: isActive ? "var(--nv-text)" : "var(--nv-text-dim)",
                    borderBottom: isActive ? `2px solid var(--nv-accent)` : "2px solid transparent",
                    background: isActive ? "var(--nv-surface)" : undefined,
                  }}
                >
                  <span className="truncate">{title}</span>
                  <span
                    onClick={(e) => closeTab(filename, e)}
                    className="opacity-0 group-hover:opacity-100 hover:opacity-100 text-[10px] w-4 h-4 flex items-center justify-center rounded flex-shrink-0"
                    style={{ color: "var(--nv-text-dim)" }}
                  >
                    ×
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* Header */}
        <div
          className="flex items-center justify-between px-6 py-2.5"
          style={{
            background: "var(--nv-surface)",
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
            {mode === "edit" && (
              <span
                className="text-[9px] uppercase tracking-wider px-2 py-0.5 rounded-lg font-[Geist,sans-serif] font-medium"
                style={{ background: "var(--nv-surface)", color: "var(--nv-text-muted)", border: "1px solid var(--nv-border)" }}
              >
                editing
              </span>
            )}
            {isDirty && (
              <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: "var(--nv-accent)" }} title="Saving..." />
            )}
          </div>
          <div className="flex items-center gap-2">
            {mode === "edit" ? (
              <button
                onClick={() => setMode("preview")}
                className="text-[11px] font-medium font-[Geist,sans-serif] px-3.5 py-1.5 rounded-lg transition-all"
                style={{
                  background: "var(--nv-accent)",
                  color: "var(--nv-bg)",
                  boxShadow: "inset 0 1px 1px rgba(255,255,255,0.15)",
                }}
              >
                Done
              </button>
            ) : (
              <button
                onClick={() => setMode("edit")}
                className="text-[11px] font-medium font-[Geist,sans-serif] px-3.5 py-1.5 rounded-lg transition-all"
                style={{ border: "1px solid var(--nv-border)", color: "var(--nv-text-muted)" }}
              >
                Edit
              </button>
            )}
          </div>
        </div>

        {/* Editor body: reader-style preview by default, raw CodeMirror on demand */}
        {mode === "preview" ? (
          <MarkdownPreview
            content={activeContent}
            onSwitchToEdit={() => setMode("edit")}
          />
        ) : (
          <div className="flex-1 overflow-auto">
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
        )}

        <EditorStats content={activeContent} />
      </div>

    </div>
  );
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

