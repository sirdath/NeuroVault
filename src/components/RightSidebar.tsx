import { useEffect, useState, useCallback } from "react";
import { useNoteStore } from "../stores/noteStore";
import { workingMemoryApi, contradictionsApi } from "../lib/api";
import type { WorkingMemoryItem, Contradiction } from "../lib/api";
import { toast } from "../stores/toastStore";
import { useHoverPreview, useTitleHoverPreview } from "../hooks/useHoverPreview";

interface NoteDetail {
  id: string;
  title: string;
  state: string;
  strength: number;
  access_count: number;
  connections: { engram_id: string; title: string; similarity: number; link_type: string }[];
  entities: { name: string; type: string }[];
}

interface Backlink {
  engram_id: string;
  title: string;
  similarity: number;
  link_type: string;
  contexts: string[];
}

interface UnlinkedMention {
  engram_id: string;
  title: string;
  snippet: string;
}

interface OutlineItem {
  level: number;
  text: string;
  line: number;
}

export function RightSidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const activeFilename = useNoteStore((s) => s.activeFilename);
  const activeContent = useNoteStore((s) => s.activeContent);
  const selectNote = useNoteStore((s) => s.selectNote);
  const allNotes = useNoteStore((s) => s.notes);

  const [detail, setDetail] = useState<NoteDetail | null>(null);
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const [unlinked, setUnlinked] = useState<UnlinkedMention[]>([]);
  const [workingMemory, setWorkingMemory] = useState<WorkingMemoryItem[]>([]);
  const [contradictions, setContradictions] = useState<Contradiction[]>([]);
  // Default-open: the 3 sections that carry the most signal for daily use.
  // Connections/entities/unlinked-mentions collapse by default — they're
  // power-user surfaces, not first-glance ones. Whatever the user opens
  // sticks via localStorage so they only have to reorganize once.
  type SectionState = {
    workingMemory: boolean;
    contradictions: boolean;
    outline: boolean;
    backlinks: boolean;
    unlinked: boolean;
    connections: boolean;
    entities: boolean;
  };
  const [openSections, setOpenSections] = useState<SectionState>(() => {
    const defaults: SectionState = {
      workingMemory: true,
      contradictions: true,  // auto-rendered only when there are any
      outline: true,
      backlinks: true,
      unlinked: false,
      connections: false,
      entities: false,
    };
    try {
      const saved = localStorage.getItem("nv.rightSidebar.openSections");
      if (saved) return { ...defaults, ...JSON.parse(saved) };
    } catch {
      /* corrupt LS — fall back to defaults */
    }
    return defaults;
  });

  const refreshBrainState = useCallback(async () => {
    try {
      const [wm, contras] = await Promise.all([
        workingMemoryApi.list(),
        contradictionsApi.list(),
      ]);
      setWorkingMemory(wm);
      setContradictions(contras);
    } catch {
      // Server offline — silent
    }
  }, []);

  // Load brain-level state once on open and after every active file change
  useEffect(() => {
    if (open) refreshBrainState();
  }, [open, activeFilename, refreshBrainState]);

  const handleUnpin = async (engramId: string) => {
    try {
      await workingMemoryApi.unpin(engramId);
      toast.success("Unpinned from working memory");
      await refreshBrainState();
    } catch {
      toast.error("Failed to unpin");
    }
  };

  const handleResolveContradiction = async (id: string) => {
    try {
      await contradictionsApi.resolve(id);
      toast.success("Contradiction resolved");
      await refreshBrainState();
    } catch {
      toast.error("Failed to resolve");
    }
  };

  // Extract outline from current content
  const outline: OutlineItem[] = activeContent
    .split("\n")
    .map((line, i) => {
      const match = line.match(/^(#{1,6})\s+(.+)$/);
      if (!match) return null;
      return {
        level: match[1]!.length,
        text: match[2]!.trim(),
        line: i,
      };
    })
    .filter((x): x is OutlineItem => x !== null);

  // Load metadata when active file changes
  useEffect(() => {
    if (!activeFilename || !open) {
      setDetail(null);
      setBacklinks([]);
      return;
    }

    fetch("http://127.0.0.1:8765/api/notes")
      .then((r) => r.json())
      .then(
        (apiNotes: Array<{ id: string; filename: string }>) => {
          const match = apiNotes.find((n) => n.filename === activeFilename);
          if (!match) return;

          fetch(`http://127.0.0.1:8765/api/notes/${match.id}`)
            .then((r) => r.json())
            .then(setDetail)
            .catch(() => setDetail(null));

          fetch(`http://127.0.0.1:8765/api/backlinks/${match.id}`)
            .then((r) => r.json())
            .then(setBacklinks)
            .catch(() => setBacklinks([]));

          fetch(`http://127.0.0.1:8765/api/unlinked-mentions/${match.id}`)
            .then((r) => r.json())
            .then(setUnlinked)
            .catch(() => setUnlinked([]));
        }
      )
      .catch(() => {});
  }, [activeFilename, open]);

  const navigateTo = (title: string) => {
    const match = allNotes.find((n) => n.title.toLowerCase() === title.toLowerCase());
    if (match) selectNote(match.filename);
  };

  const toggle = (key: keyof typeof openSections) => {
    setOpenSections((s) => {
      const next = { ...s, [key]: !s[key] };
      try {
        localStorage.setItem("nv.rightSidebar.openSections", JSON.stringify(next));
      } catch {
        /* private mode / quota exceeded — non-fatal */
      }
      return next;
    });
  };

  if (!open) return null;

  return (
    <div className="w-[280px] min-w-[280px] h-full flex flex-col bg-[#0b0b12] border-l border-[#1f1f2e] overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-[#1f1f2e] flex items-center justify-between flex-shrink-0">
        <h2 className="text-xs font-semibold text-[#a8a6c0] font-[Geist,sans-serif] uppercase tracking-wider">
          Note Info
        </h2>
        <button
          onClick={onClose}
          className="text-[#6a6880] hover:text-[#e8e6f0] text-base"
          title="Close panel"
        >
          ×
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Brain-level: Working Memory (always visible) */}
        <Section
          title="Working Memory"
          count={workingMemory.length}
          open={openSections.workingMemory}
          onToggle={() => toggle("workingMemory")}
        >
          {workingMemory.length === 0 ? (
            <p className="text-[10px] text-[#6a6880] font-[Geist,sans-serif] px-4 py-2">
              Empty — consolidation will populate this
            </p>
          ) : (
            <div className="space-y-1 px-2">
              {workingMemory.map((m) => (
                <WorkingMemoryRow
                  key={m.engram_id}
                  item={m}
                  onOpen={() => navigateTo(m.title)}
                  onUnpin={() => handleUnpin(m.engram_id)}
                />
              ))}
            </div>
          )}
        </Section>

        {/* Brain-level: Contradictions (always visible if any) */}
        {contradictions.length > 0 && (
          <Section
            title="Contradictions"
            count={contradictions.length}
            open={openSections.contradictions}
            onToggle={() => toggle("contradictions")}
          >
            <div className="space-y-2 px-3 py-1">
              {contradictions.map((c) => (
                <div
                  key={c.id}
                  className="border border-[#ff6b6b]/20 bg-[#ff6b6b]/5 rounded p-2"
                >
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-[9px] uppercase tracking-wider text-[#ff6b6b] font-semibold font-[Geist,sans-serif]">
                      Conflict
                    </span>
                    <button
                      onClick={() => handleResolveContradiction(c.id)}
                      className="text-[9px] bg-[#ff6b6b] text-[#0b0b12] px-1.5 py-0.5 rounded hover:bg-[#ff6b6b]/90 font-medium font-[Geist,sans-serif]"
                    >
                      Resolve
                    </button>
                  </div>
                  <button
                    onClick={() => navigateTo(c.note_a)}
                    className="text-[10px] text-[#8b7cf8] hover:text-[#e8e6f0] font-[Geist,sans-serif] block truncate"
                  >
                    {c.note_a}
                  </button>
                  <p className="text-[10px] text-[#a8a6c0] line-clamp-2 ml-2 font-[Geist,sans-serif]">
                    {c.fact_a}
                  </p>
                  <p className="text-[10px] text-[#6a6880] my-0.5">vs</p>
                  <button
                    onClick={() => navigateTo(c.note_b)}
                    className="text-[10px] text-[#8b7cf8] hover:text-[#e8e6f0] font-[Geist,sans-serif] block truncate"
                  >
                    {c.note_b}
                  </button>
                  <p className="text-[10px] text-[#a8a6c0] line-clamp-2 ml-2 font-[Geist,sans-serif]">
                    {c.fact_b}
                  </p>
                </div>
              ))}
            </div>
          </Section>
        )}

        {!activeFilename && (
          <div className="text-center py-12 px-4">
            <p className="text-[#6a6880] text-xs font-[Geist,sans-serif]">
              Select a note for note-specific info
            </p>
          </div>
        )}

        {activeFilename && (
          <>
            {/* Strength card */}
            {detail && (
              <div className="px-4 py-3 border-b border-[#1f1f2e]">
                <div className="flex items-center gap-2 mb-2">
                  <div className="flex-1 h-1 bg-[#1a1a28] rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${detail.strength * 100}%`,
                        backgroundColor:
                          detail.state === "active" || detail.state === "fresh"
                            ? "#f0a500"
                            : detail.state === "connected"
                              ? "#00c9b1"
                              : "#6a6880",
                      }}
                    />
                  </div>
                  <span className="text-[10px] text-[#a8a6c0] font-[Geist,sans-serif]">
                    {Math.round(detail.strength * 100)}%
                  </span>
                </div>
                <div className="flex items-center justify-between text-[10px] text-[#6a6880] font-[Geist,sans-serif]">
                  <span className="capitalize">{detail.state}</span>
                  <span>{detail.access_count} accesses</span>
                </div>
              </div>
            )}

            {/* Outline */}
            <Section
              title="Outline"
              count={outline.length}
              open={openSections.outline}
              onToggle={() => toggle("outline")}
            >
              {outline.length === 0 ? (
                <p className="text-[10px] text-[#6a6880] font-[Geist,sans-serif] px-4 py-2">
                  No headings
                </p>
              ) : (
                <div className="space-y-0.5">
                  {outline.map((item, i) => (
                    <div
                      key={i}
                      style={{ paddingLeft: 16 + (item.level - 1) * 12 }}
                      className="text-xs text-[#a8a6c0] hover:text-[#e8e6f0] font-[Geist,sans-serif] py-1 pr-4 cursor-pointer truncate"
                    >
                      {item.text}
                    </div>
                  ))}
                </div>
              )}
            </Section>

            {/* Backlinks with paragraph context (Obsidian-style) */}
            <Section
              title="Backlinks"
              count={backlinks.length}
              open={openSections.backlinks}
              onToggle={() => toggle("backlinks")}
            >
              {backlinks.length === 0 ? (
                <p className="text-[10px] text-[#6a6880] font-[Geist,sans-serif] px-4 py-2">
                  No notes link here
                </p>
              ) : (
                <div className="space-y-2 px-3 py-1">
                  {backlinks.map((bl) => (
                    <div key={bl.engram_id} className="space-y-1">
                      <HoverableTitle
                        title={bl.title}
                        onClick={() => navigateTo(bl.title)}
                        trailing={
                          <span className="text-[9px] text-[#6a6880] flex-shrink-0">
                            {Math.round(bl.similarity * 100)}%
                          </span>
                        }
                      />

                      {/* Paragraph context — the killer feature */}
                      {bl.contexts.length > 0 && (
                        <div className="space-y-1 pl-3 border-l border-[#1f1f2e]">
                          {bl.contexts.map((ctx, i) => (
                            <p
                              key={i}
                              className="text-[10px] text-[#a8a6c0] font-[Geist,sans-serif] leading-relaxed line-clamp-3"
                            >
                              {ctx}
                            </p>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Section>

            {/* Unlinked Mentions — Obsidian's #2 killer feature */}
            <Section
              title="Unlinked Mentions"
              count={unlinked.length}
              open={openSections.unlinked}
              onToggle={() => toggle("unlinked")}
            >
              {unlinked.length === 0 ? (
                <p className="text-[10px] text-[#6a6880] font-[Geist,sans-serif] px-4 py-2">
                  No unlinked mentions
                </p>
              ) : (
                <div className="space-y-2 px-3 py-1">
                  {unlinked.map((m) => (
                    <UnlinkedRow
                      key={m.engram_id}
                      title={m.title}
                      snippet={m.snippet}
                      onOpen={() => navigateTo(m.title)}
                    />
                  ))}
                </div>
              )}
            </Section>

            {/* Outgoing connections */}
            <Section
              title="Connections"
              count={detail?.connections.length ?? 0}
              open={openSections.connections}
              onToggle={() => toggle("connections")}
            >
              {!detail || detail.connections.length === 0 ? (
                <p className="text-[10px] text-[#6a6880] font-[Geist,sans-serif] px-4 py-2">
                  No outgoing links
                </p>
              ) : (
                <div className="space-y-1 px-2">
                  {detail.connections.map((c) => (
                    <ConnectionRow
                      key={c.engram_id}
                      title={c.title}
                      similarity={c.similarity}
                      linkType={c.link_type}
                      onOpen={() => navigateTo(c.title)}
                    />
                  ))}
                </div>
              )}
            </Section>

            {/* Entities */}
            <Section
              title="Entities"
              count={detail?.entities.length ?? 0}
              open={openSections.entities}
              onToggle={() => toggle("entities")}
            >
              {!detail || detail.entities.length === 0 ? (
                <p className="text-[10px] text-[#6a6880] font-[Geist,sans-serif] px-4 py-2">
                  No entities extracted
                </p>
              ) : (
                <div className="flex flex-wrap gap-1 px-3 py-2">
                  {detail.entities.map((e) => (
                    <span
                      key={e.name}
                      className={`text-[10px] px-1.5 py-0.5 rounded font-[Geist,sans-serif] ${
                        e.type === "technology"
                          ? "bg-[#8b7cf8]/15 text-[#8b7cf8]"
                          : e.type === "person"
                            ? "bg-[#f0a500]/15 text-[#f0a500]"
                            : "bg-[#00c9b1]/15 text-[#00c9b1]"
                      }`}
                    >
                      {e.name}
                    </span>
                  ))}
                </div>
              )}
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

function WorkingMemoryRow({
  item,
  onOpen,
  onUnpin,
}: {
  item: WorkingMemoryItem;
  onOpen: () => void;
  onUnpin: () => void;
}) {
  const hover = useTitleHoverPreview(item.title);
  return (
    <div className="group flex items-start justify-between gap-1 px-2 py-1.5 rounded hover:bg-[#1a1a28]">
      <button
        onClick={onOpen}
        onMouseEnter={hover.onMouseEnter}
        onMouseLeave={hover.onMouseLeave}
        className="flex-1 text-left text-xs text-[#f0a500] hover:text-[#e8e6f0] font-[Geist,sans-serif] truncate transition-colors"
      >
        <span className="text-[9px] mr-1">
          {item.pin_type === "manual" ? "📌" : "•"}
        </span>
        {item.title}
      </button>
      <button
        onClick={onUnpin}
        className="opacity-0 group-hover:opacity-100 text-[#8a88a0] hover:text-[#ff6b6b] text-xs flex-shrink-0"
        title="Unpin"
      >
        ×
      </button>
    </div>
  );
}

function UnlinkedRow({
  title,
  snippet,
  onOpen,
}: {
  title: string;
  snippet: string;
  onOpen: () => void;
}) {
  const hover = useTitleHoverPreview(title);
  return (
    <div className="space-y-1">
      <button
        onClick={onOpen}
        onMouseEnter={hover.onMouseEnter}
        onMouseLeave={hover.onMouseLeave}
        className="text-xs text-[#00c9b1] hover:text-[#e8e6f0] font-[Geist,sans-serif] font-medium transition-colors"
      >
        {title}
      </button>
      <p className="text-[10px] text-[#a8a6c0] font-[Geist,sans-serif] leading-relaxed line-clamp-2 pl-3 border-l border-[#1f1f2e]">
        {snippet}
      </p>
    </div>
  );
}

function ConnectionRow({
  title,
  similarity,
  linkType,
  onOpen,
}: {
  title: string;
  similarity: number;
  linkType: string;
  onOpen: () => void;
}) {
  const hover = useTitleHoverPreview(title);
  return (
    <button
      onClick={onOpen}
      onMouseEnter={hover.onMouseEnter}
      onMouseLeave={hover.onMouseLeave}
      className="w-full text-left text-xs text-[#00c9b1] hover:text-[#e8e6f0] font-[Geist,sans-serif] py-1.5 px-2 rounded hover:bg-[#1a1a28] truncate transition-colors"
    >
      {linkType === "manual" ? "[[" : ""}
      {title}
      {linkType === "manual" ? "]]" : ""}
      <span className="text-[#6a6880] ml-2 text-[9px]">
        {Math.round(similarity * 100)}%
      </span>
    </button>
  );
}

/**
 * A note title button with a delayed hover-preview card. Resolves the
 * title to a filename via the active note store so we can look up the
 * body lazily when the card opens.
 */
function HoverableTitle({
  title,
  onClick,
  trailing,
}: {
  title: string;
  onClick: () => void;
  trailing?: React.ReactNode;
}) {
  const notes = useNoteStore((s) => s.notes);
  const match = notes.find((n) => n.title.toLowerCase() === title.toLowerCase());
  const hover = useHoverPreview(match?.filename ?? null);
  return (
    <button
      onClick={onClick}
      onMouseEnter={hover.onMouseEnter}
      onMouseLeave={hover.onMouseLeave}
      className="w-full text-left flex items-center gap-1 group"
    >
      <span className="text-xs text-[#8b7cf8] group-hover:text-[#e8e6f0] font-[Geist,sans-serif] font-medium truncate transition-colors">
        {title}
      </span>
      {trailing}
    </button>
  );
}

function Section({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-[#1f1f2e]">
      <button
        onClick={onToggle}
        className="w-full px-4 py-2 flex items-center justify-between hover:bg-[#1a1a28]/40 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span
            className={`text-[#6a6880] text-xs transition-transform ${
              open ? "rotate-90" : ""
            }`}
          >
            ▶
          </span>
          <span className="text-[10px] uppercase tracking-wider text-[#a8a6c0] font-[Geist,sans-serif] font-semibold">
            {title}
          </span>
        </div>
        <span className="text-[10px] text-[#6a6880] font-[Geist,sans-serif]">
          {count}
        </span>
      </button>
      {open && <div className="pb-2">{children}</div>}
    </div>
  );
}
