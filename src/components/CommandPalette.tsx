import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useNoteStore } from "../stores/noteStore";
import { useGraphStore } from "../stores/graphStore";
import { recall as apiRecall, type RecallResult } from "../lib/api";

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
  /** What the parent view is showing right now. Affects how Note
   *  and Memory picks behave: on the Graph view, picking a note
   *  tweens the camera + pulses the node instead of opening the
   *  editor. On every other view, the default selectNote happens. */
  currentView?: "editor" | "graph" | "compile";
}

// Per-section caps. The whole point of the rebuild is that you can scan the
// palette in a single eye-fixation, so we never let any section dominate.
const MAX_COMMANDS = 5;
const MAX_NOTES = 7;
const MAX_MEMORY = 5;
const RECALL_DEBOUNCE_MS = 220;
const MIN_RECALL_QUERY = 3;

type SectionKind = "command" | "note" | "memory";

interface PaletteItem {
  kind: SectionKind;
  id: string;
  title: string;
  subtitle?: string;
  badge?: string;
  shortcut?: string;
  score: number;
  action: () => void;
}

/** Fuzzy match — characters in order, with consecutive-run bonus. */
function fuzzyScore(query: string, text: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  if (t.includes(q)) return 1000 + (1 - t.indexOf(q) / Math.max(t.length, 1)) * 100;

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

export function CommandPalette({ open, onClose, commands, currentView }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [memoryHits, setMemoryHits] = useState<RecallResult[]>([]);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const recallSeq = useRef(0);

  const notes = useNoteStore((s) => s.notes);
  const selectNote = useNoteStore((s) => s.selectNote);
  const graphNodes = useGraphStore((s) => s.nodes);
  const requestGraphFocus = useGraphStore((s) => s.requestFocus);

  /** Pick the right action when the user selects a note or memory hit:
   *  if we're on the Graph view, find the matching graph node by
   *  title + fire a focus-tween request (camera slides + node pulses);
   *  otherwise open the note in the editor as before. Falls back to
   *  selectNote if we can't resolve a graph node id — the user still
   *  gets *something* useful when the graph's empty or still loading. */
  const pickNoteByFilename = useCallback(
    (filename: string, titleHint?: string) => {
      if (currentView === "graph") {
        const title = titleHint ?? notes.find((n) => n.filename === filename)?.title;
        const match = graphNodes.find((g) => g.title === title);
        if (match) {
          requestGraphFocus(match.id);
          return;
        }
      }
      selectNote(filename);
    },
    [currentView, notes, graphNodes, requestGraphFocus, selectNote],
  );
  /** Same resolver but for memory hits that already carry an engram id
   *  directly — skip the title lookup when we have the id on hand. */
  const pickEngramById = useCallback(
    (engramId: string, filename?: string) => {
      if (currentView === "graph") {
        requestGraphFocus(engramId);
        return;
      }
      if (filename) selectNote(filename);
    },
    [currentView, requestGraphFocus, selectNote],
  );

  // --- Local-only sections (commands + notes) -----------------------------

  const commandItems: PaletteItem[] = useMemo(() => {
    const scored = commands
      .map((cmd) => ({
        cmd,
        score: query
          ? Math.max(fuzzyScore(query, cmd.title), fuzzyScore(query, cmd.category) * 0.5)
          : 1,
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_COMMANDS);

    return scored.map(({ cmd, score }) => ({
      kind: "command" as SectionKind,
      id: `cmd-${cmd.id}`,
      title: cmd.title,
      badge: cmd.category,
      shortcut: cmd.shortcut,
      score,
      action: cmd.action,
    }));
  }, [commands, query]);

  const noteItems: PaletteItem[] = useMemo(() => {
    const scored = notes
      .map((n) => ({
        n,
        score: query ? fuzzyScore(query, n.title) : 1,
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_NOTES);

    return scored.map(({ n, score }) => ({
      kind: "note" as SectionKind,
      id: `note-${n.filename}`,
      title: n.title,
      subtitle: n.filename,
      score,
      action: () => pickNoteByFilename(n.filename, n.title),
    }));
  }, [notes, query, pickNoteByFilename]);

  // --- Memory section: debounced /api/recall ------------------------------
  // Local fuzzy match catches what's in your sidebar. Memory recall catches
  // anything semantically related — including engrams that aren't in the
  // current sidebar filter (insights, observations, archived notes, etc).

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_RECALL_QUERY) {
      setMemoryHits([]);
      setMemoryLoading(false);
      return;
    }
    setMemoryLoading(true);
    const seq = ++recallSeq.current;
    const t = setTimeout(async () => {
      try {
        const hits = await apiRecall(trimmed, MAX_MEMORY);
        if (seq === recallSeq.current) {
          setMemoryHits(Array.isArray(hits) ? hits : []);
          setMemoryLoading(false);
        }
      } catch {
        if (seq === recallSeq.current) {
          setMemoryHits([]);
          setMemoryLoading(false);
        }
      }
    }, RECALL_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const memoryItems: PaletteItem[] = useMemo(() => {
    return memoryHits.map((hit) => {
      // Phase-6 throttle-hint sentinel — the Rust retriever prepends
      // this synthetic result when agents spam recall. Render it
      // distinctly (no action, no score subtitle) so humans see the
      // "slow down" signal that Claude Code sees.
      if (hit.engram_id === "__throttle_hint__") {
        return {
          kind: "memory" as SectionKind,
          id: "mem-throttle-hint",
          title: hit.title,          // starts with ⚠️
          subtitle: hit.content,      // the hint text
          score: 0,
          action: () => {},           // not pickable
        };
      }
      // Normal hit: on the graph view, tween the camera to the engram;
      // everywhere else, open the note in the editor.
      const matchedNote =
        hit.filename && notes.find((n) => n.filename === hit.filename);
      const action = matchedNote
        ? () => pickEngramById(hit.engram_id, matchedNote.filename)
        : hit.filename
          ? () => pickEngramById(hit.engram_id, hit.filename!)
          : () => pickEngramById(hit.engram_id);
      return {
        kind: "memory" as SectionKind,
        id: `mem-${hit.engram_id}`,
        title: hit.title,
        subtitle: hit.kind ? `${hit.kind} · score ${hit.score.toFixed(2)}` : `score ${hit.score.toFixed(2)}`,
        score: hit.score,
        action,
      };
    });
  }, [memoryHits, notes, pickEngramById]);

  // --- Combined flat list for keyboard navigation -------------------------

  const sections = useMemo(() => {
    const out: { kind: SectionKind; label: string; items: PaletteItem[] }[] = [];
    if (commandItems.length) out.push({ kind: "command", label: "Commands", items: commandItems });
    if (noteItems.length) out.push({ kind: "note", label: "Notes", items: noteItems });
    if (memoryItems.length) out.push({ kind: "memory", label: "Memory", items: memoryItems });
    return out;
  }, [commandItems, noteItems, memoryItems]);

  const flatItems: PaletteItem[] = useMemo(
    () => sections.flatMap((s) => s.items),
    [sections],
  );

  // --- Lifecycle ----------------------------------------------------------

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      setMemoryHits([]);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    if (!listRef.current) return;
    const sel = listRef.current.querySelector('[data-selected="true"]');
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, flatItems.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = flatItems[selectedIndex];
        if (item) {
          item.action();
          onClose();
        }
      }
    },
    [flatItems, selectedIndex, onClose],
  );

  if (!open) return null;

  // --- Render -------------------------------------------------------------

  let runningIndex = 0;

  return (
    <>
      <div
        className="fixed inset-0 bg-black/60 z-50 fade-in"
        onClick={onClose}
      />

      <div
        className="fixed top-[15vh] left-1/2 -translate-x-1/2 w-[640px] max-w-[90vw] max-h-[60vh] rounded-lg shadow-2xl z-50 flex flex-col overflow-hidden fade-in"
        style={{
          backgroundColor: "var(--color-bg)",
          borderWidth: "1px",
          borderStyle: "solid",
          borderColor: "var(--color-border-strong)",
        }}
      >
        {/* Search input */}
        <div
          className="px-4 py-3.5"
          style={{ borderBottom: "1px solid var(--color-border)" }}
        >
          <div className="flex items-center gap-3">
            <span style={{ color: "var(--color-tertiary)" }} className="text-base select-none">
              ⌘K
            </span>
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Search commands, notes, memory…"
              className="flex-1 bg-transparent text-base font-[Geist,sans-serif] focus:outline-none"
              style={{ color: "var(--color-txt)" }}
            />
            {memoryLoading && (
              <span
                className="text-[10px] uppercase tracking-wider"
                style={{ color: "var(--color-tertiary)" }}
              >
                searching…
              </span>
            )}
          </div>
        </div>

        {/* Sectioned results */}
        <div ref={listRef} className="flex-1 overflow-y-auto py-1">
          {sections.length === 0 && (
            <div
              className="text-center py-10 text-sm font-[Geist,sans-serif]"
              style={{ color: "var(--color-sub)" }}
            >
              {query.trim() ? "No matches" : "Start typing to search"}
            </div>
          )}

          {sections.map((section) => (
            <div key={section.kind} className="py-1">
              <div
                className="px-4 pt-2 pb-1 text-[10px] uppercase tracking-wider font-semibold font-[Geist,sans-serif]"
                style={{ color: "var(--color-sub)" }}
              >
                {section.label}
                <span className="ml-2" style={{ color: "var(--color-tertiary)" }}>{section.items.length}</span>
              </div>
              {section.items.map((item) => {
                const myIndex = runningIndex++;
                const selected = myIndex === selectedIndex;
                return (
                  <div
                    key={item.id}
                    data-selected={selected}
                    onClick={() => {
                      item.action();
                      onClose();
                    }}
                    onMouseEnter={() => setSelectedIndex(myIndex)}
                    className={`cursor-pointer flex items-center gap-3 transition-colors nv-spotlight${selected ? " nv-spotlight-active" : ""}`}
                    onMouseMove={(e) => {
                      const el = e.currentTarget;
                      const r = el.getBoundingClientRect();
                      el.style.setProperty("--mx", `${e.clientX - r.left}px`);
                      el.style.setProperty("--my", `${e.clientY - r.top}px`);
                    }}
                    style={{
                      backgroundColor: selected ? "var(--color-surface-elevated)" : "transparent",
                      borderLeft: selected ? "2px solid var(--color-amber)" : "2px solid transparent",
                      boxShadow: selected ? "inset 0 0 24px -8px rgba(240, 165, 0, 0.18)" : "none",
                      // Density-aware row padding — keeps result rows in
                      // sync with the sidebar's row height.
                      paddingInline: "var(--pad-x, 16px)",
                      paddingBlock: "var(--pad-y, 8px)",
                      minHeight: "var(--row-h, auto)",
                    }}
                  >
                    <SectionIcon kind={item.kind} />
                    <div className="min-w-0 flex-1">
                      <div
                        className="text-sm font-[Geist,sans-serif] truncate"
                        style={{ color: "var(--color-txt)" }}
                      >
                        {item.title}
                      </div>
                      {item.subtitle && (
                        <div
                          className="text-[11px] font-[Geist,sans-serif] truncate"
                          style={{ color: "var(--color-sub)" }}
                        >
                          {item.subtitle}
                        </div>
                      )}
                    </div>
                    {item.badge && (
                      <span
                        className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-medium font-[Geist,sans-serif] flex-shrink-0"
                        style={{
                          backgroundColor: "var(--color-amber-dim)",
                          color: "var(--color-amber)",
                        }}
                      >
                        {item.badge}
                      </span>
                    )}
                    {item.shortcut && (
                      <span className={`nv-kbd flex-shrink-0${selected ? " nv-kbd-active" : ""}`}>
                        {item.shortcut}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div
          className="px-4 py-2 flex items-center justify-between text-[10px] font-[Geist,sans-serif]"
          style={{
            borderTop: "1px solid var(--color-border)",
            color: "var(--color-sub)",
          }}
        >
          <div className="flex gap-3 items-center">
            <span className="inline-flex items-center gap-1"><span className="nv-kbd">↑↓</span> navigate</span>
            <span className="inline-flex items-center gap-1"><span className="nv-kbd">↵</span> select</span>
            <span className="inline-flex items-center gap-1"><span className="nv-kbd">esc</span> close</span>
          </div>
          <span className="nv-tabular">{flatItems.length} results</span>
        </div>
      </div>
    </>
  );
}

function SectionIcon({ kind }: { kind: SectionKind }) {
  const color =
    kind === "command"
      ? "var(--color-amber)"
      : kind === "note"
        ? "var(--color-teal)"
        : "var(--color-purple)";
  const glyph = kind === "command" ? "›" : kind === "note" ? "◆" : "✦";
  return (
    <span
      className="w-4 h-4 flex items-center justify-center text-[12px] flex-shrink-0"
      style={{ color }}
    >
      {glyph}
    </span>
  );
}
