import { useEffect, useMemo, useRef, useState } from "react";
import { recall, type RecallResult } from "../lib/api";
import { useBrainStore } from "../stores/brainStore";
import { useNoteStore } from "../stores/noteStore";

type SearchMode = "all" | "notes" | "remembered";

type SearchItem =
  | { id: string; kind: "note"; title: string; filename: string; explanation: string }
  | { id: string; kind: "memory"; title: string; filename?: string; engramId: string; excerpt: string; explanation: string; state: string };

export function SearchView({
  onOpenNote,
  onOpenMemory,
}: {
  onOpenNote: (filename: string) => void;
  onOpenMemory: (engramId: string) => void;
}) {
  const notes = useNoteStore((state) => state.notes);
  const activeBrainName = useBrainStore((state) => state.activeBrainName);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("all");
  const [semantic, setSemantic] = useState<RecallResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const generation = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    const requestGeneration = ++generation.current;
    setSelected(0);
    if (trimmed.length < 2 || mode === "notes") {
      setSemantic([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    const timer = window.setTimeout(async () => {
      try {
        const results = await recall(trimmed, 30);
        if (requestGeneration === generation.current) setSemantic(Array.isArray(results) ? results : []);
      } catch {
        if (requestGeneration === generation.current) {
          setSemantic([]);
          setError("Meaning search is unavailable. Exact note matches still work offline.");
        }
      } finally {
        if (requestGeneration === generation.current) setLoading(false);
      }
    }, 220);
    return () => window.clearTimeout(timer);
  }, [query, mode]);

  const items = useMemo<SearchItem[]>(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return [];

    const exact: SearchItem[] = mode === "remembered" ? [] : notes
      .filter((note) => note.title.toLocaleLowerCase().includes(normalized) || note.filename.toLocaleLowerCase().includes(normalized))
      .map((note) => ({
        id: `note:${note.filename}`,
        kind: "note",
        title: note.title,
        filename: note.filename,
        explanation: note.title.toLocaleLowerCase().includes(normalized)
          ? "Exact title match"
          : "Exact folder or filename match",
      }));

    if (mode === "notes") return exact;
    const exactFiles = new Set(exact.map((item) => item.kind === "note" ? item.filename : ""));
    const remembered: SearchItem[] = semantic
      .filter((hit) => hit.engram_id !== "__throttle_hint__")
      .filter((hit) => !hit.filename || !exactFiles.has(hit.filename))
      .map((hit) => ({
        id: `memory:${hit.engram_id}`,
        kind: "memory",
        title: hit.title,
        filename: hit.filename,
        engramId: hit.engram_id,
        excerpt: hit.preview || hit.content || "",
        state: hit.state,
        explanation: `Related by meaning · relevance ${Math.round(Math.max(0, Math.min(1, hit.score)) * 100)}%`,
      }));
    return [...exact, ...remembered];
  }, [notes, semantic, query, mode]);

  const open = (item: SearchItem | undefined) => {
    if (!item) return;
    if (item.kind === "note") onOpenNote(item.filename);
    else if (item.filename) onOpenNote(item.filename);
    else onOpenMemory(item.engramId);
  };

  return (
    <main className="flex-1 overflow-y-auto" aria-labelledby="search-heading">
      <div className="mx-auto w-full max-w-[1040px] px-8 py-7">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--nv-accent)" }}>Find the source</p>
            <h1 id="search-heading" className="mt-1 text-[30px] font-semibold tracking-[-0.035em]" style={{ color: "var(--nv-text)" }}>Search memory</h1>
            <p className="mt-1 text-[13px]" style={{ color: "var(--nv-text-dim)" }}>
              Searching <strong style={{ color: "var(--nv-text-muted)" }}>{activeBrainName || "the active vault"}</strong>. Exact matches are never hidden by meaning scores.
            </p>
          </div>
        </div>

        <div className="relative mt-6">
          <svg className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ color: "var(--nv-text-dim)" }}><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") { event.preventDefault(); setSelected((value) => Math.min(items.length - 1, value + 1)); }
              if (event.key === "ArrowUp") { event.preventDefault(); setSelected((value) => Math.max(0, value - 1)); }
              if (event.key === "Enter") { event.preventDefault(); open(items[selected]); }
              if (event.key === "Escape") setQuery("");
            }}
            aria-controls="search-results"
            aria-activedescendant={items[selected]?.id}
            placeholder="Search decisions, notes, people, tasks, or exact words…"
            className="nv-search-field w-full rounded-xl py-3.5 pl-12 pr-12 text-[15px] outline-none"
            style={{ color: "var(--nv-text)", background: "var(--nv-surface-elevated)", border: "1px solid var(--nv-border)", boxShadow: "var(--nv-shadow)" }}
          />
          {query && (
            <button type="button" onClick={() => setQuery("")} className="absolute right-3 top-1/2 h-7 w-7 -translate-y-1/2 rounded-lg" style={{ color: "var(--nv-text-dim)" }} aria-label="Clear search">×</button>
          )}
        </div>

        <div className="mt-3 flex items-center gap-1" role="group" aria-label="Search result type">
          {(["all", "notes", "remembered"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setMode(value)}
              className="rounded-lg px-3 py-1.5 text-[11px] font-medium"
              style={{ color: mode === value ? "var(--nv-accent)" : "var(--nv-text-dim)", background: mode === value ? "var(--nv-accent-glow)" : "transparent" }}
              aria-pressed={mode === value}
            >
              {value === "all" ? "Everything" : value === "notes" ? "Notes" : "Remembered"}
            </button>
          ))}
          {loading && <span className="ml-2 text-[11px]" style={{ color: "var(--nv-text-dim)" }} role="status">Searching by meaning…</span>}
        </div>

        {error && (
          <div className="mt-5 rounded-xl px-4 py-3 text-[12px]" style={{ color: "var(--nv-warning)", background: "color-mix(in srgb, var(--nv-warning) 9%, transparent)", border: "1px solid color-mix(in srgb, var(--nv-warning) 28%, transparent)" }} role="status">
            {error}
          </div>
        )}

        <div id="search-results" role="listbox" aria-label="Search results" className="mt-5 overflow-hidden rounded-2xl" style={items.length ? { border: "1px solid var(--nv-border)" } : undefined}>
          {items.map((item, index) => (
            <button
              id={item.id}
              key={item.id}
              type="button"
              role="option"
              aria-selected={selected === index}
              onMouseEnter={() => setSelected(index)}
              onClick={() => open(item)}
              className="flex w-full items-start gap-4 px-5 py-4 text-left"
              style={{ background: selected === index ? "var(--nv-surface)" : "transparent", borderBottom: index < items.length - 1 ? "1px solid var(--nv-border)" : undefined }}
            >
              <span
                className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[11px] font-semibold"
                style={{
                  color: item.kind === "note" ? "var(--nv-accent)" : "var(--nv-positive)",
                  background: item.kind === "note"
                    ? "var(--nv-accent-glow)"
                    : "color-mix(in srgb, var(--nv-positive) 14%, var(--nv-surface-elevated))",
                }}
              >
                {item.kind === "note" ? "N" : "M"}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium" style={{ color: "var(--nv-text)" }}>{item.title}</span>
                {item.kind === "note" ? (
                  <span className="mt-1 block truncate text-[11px]" style={{ color: "var(--nv-text-dim)" }}>{item.filename}</span>
                ) : item.excerpt ? (
                  <span className="mt-1 line-clamp-2 block text-[12px] leading-relaxed" style={{ color: "var(--nv-text-muted)" }}>{item.excerpt}</span>
                ) : null}
                <span className="mt-1.5 block text-[10px] font-medium uppercase tracking-wide" style={{ color: "var(--nv-text-dim)" }}>{item.explanation}</span>
              </span>
              <span className="mt-1 text-[12px]" style={{ color: "var(--nv-text-dim)" }}>Open →</span>
            </button>
          ))}
        </div>

        {query.trim().length === 1 && <Empty title="Keep typing" body="Enter at least two characters to search by meaning." />}
        {query.trim().length >= 2 && !loading && items.length === 0 && <Empty title="No matches in this vault" body="Try a person, decision, task, exact phrase, or a broader description." />}
        {!query && <Empty title="Search files and remembered context together" body="Use natural language or exact words. Every result stays scoped to the active vault and opens its source when one exists." />}
      </div>
    </main>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto mt-16 max-w-md text-center">
      <p className="text-[14px] font-medium" style={{ color: "var(--nv-text)" }}>{title}</p>
      <p className="mt-2 text-[12px] leading-relaxed" style={{ color: "var(--nv-text-dim)" }}>{body}</p>
    </div>
  );
}
