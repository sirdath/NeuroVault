import { useEffect, useState } from "react";
import { useNoteStore } from "../stores/noteStore";

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
  const [openSections, setOpenSections] = useState({
    outline: true,
    backlinks: true,
    connections: true,
    entities: false,
  });

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
        }
      )
      .catch(() => {});
  }, [activeFilename, open]);

  const navigateTo = (title: string) => {
    const match = allNotes.find((n) => n.title.toLowerCase() === title.toLowerCase());
    if (match) selectNote(match.filename);
  };

  const toggle = (key: keyof typeof openSections) => {
    setOpenSections((s) => ({ ...s, [key]: !s[key] }));
  };

  if (!open) return null;

  return (
    <div className="w-[280px] min-w-[280px] h-full flex flex-col bg-[#07070e] border-l border-[#1e1e38] overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-[#1e1e38] flex items-center justify-between flex-shrink-0">
        <h2 className="text-xs font-semibold text-[#9999b8] font-[Geist,sans-serif] uppercase tracking-wider">
          Note Info
        </h2>
        <button
          onClick={onClose}
          className="text-[#555570] hover:text-[#ddd9f0] text-base"
          title="Close panel"
        >
          ×
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {!activeFilename && (
          <div className="text-center py-12 px-4">
            <p className="text-[#555570] text-xs font-[Geist,sans-serif]">
              Select a note to see info
            </p>
          </div>
        )}

        {activeFilename && (
          <>
            {/* Strength card */}
            {detail && (
              <div className="px-4 py-3 border-b border-[#1e1e38]">
                <div className="flex items-center gap-2 mb-2">
                  <div className="flex-1 h-1 bg-[#131325] rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${detail.strength * 100}%`,
                        backgroundColor:
                          detail.state === "active" || detail.state === "fresh"
                            ? "#f0a500"
                            : detail.state === "connected"
                              ? "#00c9b1"
                              : "#555570",
                      }}
                    />
                  </div>
                  <span className="text-[10px] text-[#9999b8] font-[Geist,sans-serif]">
                    {Math.round(detail.strength * 100)}%
                  </span>
                </div>
                <div className="flex items-center justify-between text-[10px] text-[#555570] font-[Geist,sans-serif]">
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
                <p className="text-[10px] text-[#555570] font-[Geist,sans-serif] px-4 py-2">
                  No headings
                </p>
              ) : (
                <div className="space-y-0.5">
                  {outline.map((item, i) => (
                    <div
                      key={i}
                      style={{ paddingLeft: 16 + (item.level - 1) * 12 }}
                      className="text-xs text-[#9999b8] hover:text-[#ddd9f0] font-[Geist,sans-serif] py-1 pr-4 cursor-pointer truncate"
                    >
                      {item.text}
                    </div>
                  ))}
                </div>
              )}
            </Section>

            {/* Backlinks */}
            <Section
              title="Backlinks"
              count={backlinks.length}
              open={openSections.backlinks}
              onToggle={() => toggle("backlinks")}
            >
              {backlinks.length === 0 ? (
                <p className="text-[10px] text-[#555570] font-[Geist,sans-serif] px-4 py-2">
                  No notes link here
                </p>
              ) : (
                <div className="space-y-1 px-2">
                  {backlinks.map((bl) => (
                    <button
                      key={bl.engram_id}
                      onClick={() => navigateTo(bl.title)}
                      className="w-full text-left text-xs text-[#8b7cf8] hover:text-[#ddd9f0] font-[Geist,sans-serif] py-1.5 px-2 rounded hover:bg-[#131325] truncate transition-colors"
                    >
                      {bl.title}
                      <span className="text-[#555570] ml-2 text-[9px]">
                        {Math.round(bl.similarity * 100)}%
                      </span>
                    </button>
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
                <p className="text-[10px] text-[#555570] font-[Geist,sans-serif] px-4 py-2">
                  No outgoing links
                </p>
              ) : (
                <div className="space-y-1 px-2">
                  {detail.connections.map((c) => (
                    <button
                      key={c.engram_id}
                      onClick={() => navigateTo(c.title)}
                      className="w-full text-left text-xs text-[#00c9b1] hover:text-[#ddd9f0] font-[Geist,sans-serif] py-1.5 px-2 rounded hover:bg-[#131325] truncate transition-colors"
                    >
                      {c.link_type === "manual" ? "[[" : ""}
                      {c.title}
                      {c.link_type === "manual" ? "]]" : ""}
                      <span className="text-[#555570] ml-2 text-[9px]">
                        {Math.round(c.similarity * 100)}%
                      </span>
                    </button>
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
                <p className="text-[10px] text-[#555570] font-[Geist,sans-serif] px-4 py-2">
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
    <div className="border-b border-[#1e1e38]">
      <button
        onClick={onToggle}
        className="w-full px-4 py-2 flex items-center justify-between hover:bg-[#131325]/40 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span
            className={`text-[#555570] text-xs transition-transform ${
              open ? "rotate-90" : ""
            }`}
          >
            ▶
          </span>
          <span className="text-[10px] uppercase tracking-wider text-[#9999b8] font-[Geist,sans-serif] font-semibold">
            {title}
          </span>
        </div>
        <span className="text-[10px] text-[#555570] font-[Geist,sans-serif]">
          {count}
        </span>
      </button>
      {open && <div className="pb-2">{children}</div>}
    </div>
  );
}
