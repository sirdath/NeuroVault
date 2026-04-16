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
  const notes = useNoteStore((s) => s.notes);

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
      <div className="flex-1 flex items-center justify-center bg-[#0b0b12]">
        <div className="text-center">
          <p className="text-[#8a88a0] text-lg font-[Geist,sans-serif]">
            Select or create a note
          </p>
          <p className="text-[#35335a] text-sm mt-2 font-[Geist,sans-serif]">
            Your memories live here
          </p>
          <p className="text-[#35335a] text-xs mt-4 font-[Geist,sans-serif]">
            Ctrl+N to create &middot; Ctrl+P to toggle graph
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex bg-[#0b0b12] overflow-hidden">
      {/* Main editor area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header — reader-first: title + edit button. No toggle pill. */}
        <div className="flex items-center justify-between px-6 py-2 border-b border-[#1f1f2e]">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <span className="text-[#e8e6f0] text-sm font-semibold font-[Geist,sans-serif] truncate" title={activeFilename ?? undefined}>
              {notes.find((n) => n.filename === activeFilename)?.title ??
                activeFilename?.replace(/\.md$/, "") ??
                "Untitled"}
            </span>
            {mode === "edit" && (
              <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-[#f0a500]/10 text-[#f0a500] font-[Geist,sans-serif]">
                editing
              </span>
            )}
            {isDirty && (
              <span className="text-[10px] text-[#f0a500]/60 font-[Geist,sans-serif]">saving</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {mode === "edit" ? (
              <button
                onClick={() => setMode("preview")}
                className="text-[10px] font-[Geist,sans-serif] px-3 py-1 rounded bg-[#1f1f2e] text-[#e8e6f0] hover:bg-[#2a2a3e] transition-colors uppercase tracking-wider"
              >
                Done
              </button>
            ) : (
              <button
                onClick={() => setMode("edit")}
                className="text-[10px] font-[Geist,sans-serif] px-3 py-1 rounded border border-[#1f1f2e] text-[#8a88a0] hover:text-[#e8e6f0] hover:border-[#3a3a4e] transition-colors uppercase tracking-wider"
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
      </div>

    </div>
  );
}

