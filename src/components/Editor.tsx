import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { EditorView } from "@codemirror/view";
import { useNoteStore } from "../stores/noteStore";
import { neurovaultTheme } from "./editor/theme";
import { livePreviewPlugin, livePreviewTheme } from "./editor/livePreview";
import { buildCompletions } from "./editor/completions";
import { fetchNote, fetchBacklinks } from "../lib/api";
import type { Backlink } from "../lib/api";
import { MarkdownPreview } from "./MarkdownPreview";

interface NoteMetadata {
  strength: number;
  state: string;
  access_count: number;
  connections: { engram_id: string; title: string; similarity: number; link_type: string }[];
  entities: { name: string; type: string }[];
}

export function Editor() {
  const activeFilename = useNoteStore((s) => s.activeFilename);
  const activeContent = useNoteStore((s) => s.activeContent);
  const isDirty = useNoteStore((s) => s.isDirty);
  const updateContent = useNoteStore((s) => s.updateContent);
  const saveNote = useNoteStore((s) => s.saveNote);
  const selectNote = useNoteStore((s) => s.selectNote);
  const notes = useNoteStore((s) => s.notes);

  const [metadata, setMetadata] = useState<NoteMetadata | null>(null);
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const [showMeta, setShowMeta] = useState(false);
  // Preview mode is the default when opening a note (Obsidian-style Reader
  // mode). Clicking anywhere inside the preview flips to raw CodeMirror
  // edit mode. Escape (outside an input) flips back to preview after save.
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

  // Load metadata when note changes
  useEffect(() => {
    if (!activeFilename) {
      setMetadata(null);
      setBacklinks([]);
      return;
    }
    // Find engram ID from notes list (match by filename)
    const note = notes.find((n) => n.filename === activeFilename);
    if (!note) return;

    // Try loading from API (server might not be running)
    fetchNote(note.filename.replace(".md", ""))
      .catch(() => null)
      .then(() => {
        // Use the /api/notes endpoint which lists all notes with IDs
        // We need to find the engram_id for this file
      });

    // Fetch via the notes list from API
    fetch(`http://127.0.0.1:8765/api/notes`)
      .then((r) => r.json())
      .then((apiNotes: Array<{ id: string; filename: string; strength: number; state: string; access_count: number }>) => {
        const match = apiNotes.find((n) => n.filename === activeFilename);
        if (!match) return;

        // Load full note detail
        fetch(`http://127.0.0.1:8765/api/notes/${match.id}`)
          .then((r) => r.json())
          .then((detail) => {
            setMetadata({
              strength: detail.strength,
              state: detail.state,
              access_count: detail.access_count,
              connections: detail.connections || [],
              entities: detail.entities || [],
            });
          })
          .catch(() => setMetadata(null));

        // Load backlinks
        fetchBacklinks(match.id)
          .then(setBacklinks)
          .catch(() => setBacklinks([]));
      })
      .catch(() => {
        setMetadata(null);
        setBacklinks([]);
      });
  }, [activeFilename, notes]);

  const onChange = useCallback(
    (value: string) => { updateContent(value); },
    [updateContent]
  );

  // Navigate to a connected note
  const navigateTo = (title: string) => {
    const match = notes.find(
      (n) => n.title.toLowerCase() === title.toLowerCase()
    );
    if (match) selectNote(match.filename);
  };

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
        {/* Status bar */}
        <div className="flex items-center justify-between px-6 py-2 border-b border-[#1f1f2e]">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {/* Breadcrumb: Vault › Title. The vault segment is a visual
                anchor only for now; clicking the title would open a rename
                dialog in a later PR. Keeps the header honest about where
                the user is without eating a whole row of vertical space. */}
            <span className="text-[10px] uppercase tracking-wider text-[#6a6880] font-[Geist,sans-serif]">
              Vault
            </span>
            <span className="text-[#6a6880] text-xs">›</span>
            <span className="text-[#e8e6f0] text-xs font-semibold font-[Geist,sans-serif] truncate" title={activeFilename ?? undefined}>
              {notes.find((n) => n.filename === activeFilename)?.title ??
                activeFilename?.replace(/\.md$/, "") ??
                "Untitled"}
            </span>
            {metadata && (
              <span
                className={`text-[10px] font-[Geist,sans-serif] px-1.5 py-0.5 rounded ${
                  metadata.state === "active" || metadata.state === "fresh"
                    ? "bg-[#f0a500]/10 text-[#f0a500]"
                    : metadata.state === "connected"
                      ? "bg-[#00c9b1]/10 text-[#00c9b1]"
                      : "bg-[#35335a]/30 text-[#8a88a0]"
                }`}
              >
                {Math.round(metadata.strength * 100)}% {metadata.state}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs font-[Geist,sans-serif]">
              {isDirty ? (
                <span className="text-[#f0a500]">Saving...</span>
              ) : (
                <span className="text-[#35335a]">Saved</span>
              )}
            </span>
            <div className="flex items-center gap-0.5 bg-[#1a1a28] rounded p-0.5">
              <button
                onClick={() => setMode("preview")}
                title="Reader mode (Esc)"
                className={`text-[10px] font-[Geist,sans-serif] px-2 py-0.5 rounded transition-colors ${
                  mode === "preview"
                    ? "bg-[#1f1f2e] text-[#e8e6f0]"
                    : "text-[#8a88a0] hover:text-[#e8e6f0]"
                }`}
              >
                preview
              </button>
              <button
                onClick={() => setMode("edit")}
                title="Raw edit mode"
                className={`text-[10px] font-[Geist,sans-serif] px-2 py-0.5 rounded transition-colors ${
                  mode === "edit"
                    ? "bg-[#1f1f2e] text-[#e8e6f0]"
                    : "text-[#8a88a0] hover:text-[#e8e6f0]"
                }`}
              >
                edit
              </button>
            </div>
            <button
              onClick={() => setShowMeta((v) => !v)}
              className={`text-[10px] font-[Geist,sans-serif] px-2 py-0.5 rounded transition-colors ${
                showMeta
                  ? "bg-[#1f1f2e] text-[#e8e6f0]"
                  : "text-[#8a88a0] hover:text-[#e8e6f0]"
              }`}
            >
              info
            </button>
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

      {/* Metadata sidebar (toggleable) */}
      {showMeta && metadata && (
        <div className="w-[240px] min-w-[240px] border-l border-[#1f1f2e] bg-[#12121c] overflow-y-auto">
          <div className="p-4 space-y-5">
            {/* Strength */}
            <MetaSection title="Strength">
              <div className="flex items-center gap-2">
                <div className="flex-1 h-1.5 bg-[#1a1a28] rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${metadata.strength * 100}%`,
                      backgroundColor:
                        metadata.state === "active" || metadata.state === "fresh"
                          ? "#f0a500"
                          : metadata.state === "connected"
                            ? "#00c9b1"
                            : "#35335a",
                    }}
                  />
                </div>
                <span className="text-xs text-[#e8e6f0] font-[Geist,sans-serif]">
                  {Math.round(metadata.strength * 100)}%
                </span>
              </div>
              <p className="text-[10px] text-[#8a88a0] font-[Geist,sans-serif] mt-1">
                {metadata.access_count} accesses
              </p>
            </MetaSection>

            {/* Connections */}
            {metadata.connections.length > 0 && (
              <MetaSection title={`Connections (${metadata.connections.length})`}>
                <div className="space-y-1">
                  {metadata.connections.map((c) => (
                    <button
                      key={c.engram_id}
                      onClick={() => navigateTo(c.title)}
                      className="w-full text-left text-xs text-[#00c9b1] hover:text-[#e8e6f0] font-[Geist,sans-serif] truncate py-0.5 transition-colors"
                    >
                      {c.link_type === "manual" ? "[[" : ""}
                      {c.title}
                      {c.link_type === "manual" ? "]]" : ""}
                      <span className="text-[#35335a] ml-1">
                        {Math.round(c.similarity * 100)}%
                      </span>
                    </button>
                  ))}
                </div>
              </MetaSection>
            )}

            {/* Backlinks */}
            {backlinks.length > 0 && (
              <MetaSection title={`Backlinks (${backlinks.length})`}>
                <div className="space-y-1">
                  {backlinks.map((b) => (
                    <button
                      key={b.engram_id}
                      onClick={() => navigateTo(b.title)}
                      className="w-full text-left text-xs text-[#8b7cf8] hover:text-[#e8e6f0] font-[Geist,sans-serif] truncate py-0.5 transition-colors"
                    >
                      {b.title}
                    </button>
                  ))}
                </div>
              </MetaSection>
            )}

            {/* Entities */}
            {metadata.entities.length > 0 && (
              <MetaSection title={`Entities (${metadata.entities.length})`}>
                <div className="flex flex-wrap gap-1">
                  {metadata.entities.map((e) => (
                    <span
                      key={e.name}
                      className={`text-[10px] font-[Geist,sans-serif] px-1.5 py-0.5 rounded ${
                        e.type === "technology"
                          ? "bg-[#8b7cf8]/10 text-[#8b7cf8]"
                          : e.type === "person"
                            ? "bg-[#f0a500]/10 text-[#f0a500]"
                            : "bg-[#00c9b1]/10 text-[#00c9b1]"
                      }`}
                    >
                      {e.name}
                    </span>
                  ))}
                </div>
              </MetaSection>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function MetaSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h4 className="text-[10px] font-medium text-[#8a88a0] font-[Geist,sans-serif] uppercase tracking-wider mb-1.5">
        {title}
      </h4>
      {children}
    </div>
  );
}
