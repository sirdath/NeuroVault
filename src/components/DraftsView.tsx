import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { draftsApi } from "../lib/api";
import type { DraftSummary, DraftDetail } from "../lib/api";
import { useNoteStore } from "../stores/noteStore";
import { toast } from "../stores/toastStore";

export function DraftsView() {
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [activeDraft, setActiveDraft] = useState<DraftDetail | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newTarget, setNewTarget] = useState("");
  const [showAddSection, setShowAddSection] = useState(false);

  const allNotes = useNoteStore((s) => s.notes);
  const selectNote = useNoteStore((s) => s.selectNote);

  const loadDrafts = useCallback(async () => {
    try {
      const list = await draftsApi.list();
      setDrafts(list);
    } catch {
      toast.error("Server not running — cannot load drafts");
    }
  }, []);

  const loadActive = useCallback(async (id: string) => {
    try {
      const detail = await draftsApi.get(id);
      setActiveDraft(detail);
    } catch {
      toast.error("Failed to load draft");
    }
  }, []);

  useEffect(() => {
    loadDrafts();
  }, [loadDrafts]);

  const handleCreate = async () => {
    if (!newTitle.trim()) return;
    try {
      const result = await draftsApi.create({
        title: newTitle.trim(),
        target_words: parseInt(newTarget) || 0,
      });
      toast.success(`Created "${newTitle}"`);
      setNewTitle("");
      setNewTarget("");
      setCreating(false);
      await loadDrafts();
      await loadActive(result.draft_id);
    } catch {
      toast.error("Failed to create draft");
    }
  };

  const handleDelete = async (id: string, title: string) => {
    if (!window.confirm(`Delete draft "${title}"? Sections are preserved.`)) return;
    try {
      await draftsApi.delete(id);
      toast.success("Draft deleted");
      if (activeDraft?.draft_id === id) setActiveDraft(null);
      await loadDrafts();
    } catch {
      toast.error("Failed to delete draft");
    }
  };

  const handleAddSection = async (engramId: string) => {
    if (!activeDraft) return;
    try {
      await draftsApi.addSection(activeDraft.draft_id, engramId);
      toast.success("Section added");
      await loadActive(activeDraft.draft_id);
      await loadDrafts();
      setShowAddSection(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to add section");
    }
  };

  const handleRemoveSection = async (engramId: string) => {
    if (!activeDraft) return;
    try {
      await draftsApi.removeSection(activeDraft.draft_id, engramId);
      toast.success("Section removed");
      await loadActive(activeDraft.draft_id);
      await loadDrafts();
    } catch {
      toast.error("Failed to remove section");
    }
  };

  const handleMove = async (engramId: string, direction: "up" | "down") => {
    if (!activeDraft) return;
    const idx = activeDraft.sections.findIndex((s) => s.engram_id === engramId);
    if (idx < 0) return;
    const newPos = direction === "up" ? idx - 1 : idx + 1;
    if (newPos < 0 || newPos >= activeDraft.sections.length) return;
    try {
      await draftsApi.reorder(activeDraft.draft_id, engramId, newPos);
      await loadActive(activeDraft.draft_id);
    } catch {
      toast.error("Failed to reorder");
    }
  };

  const handleExport = async (format: string) => {
    if (!activeDraft) return;
    try {
      const result = await draftsApi.export(activeDraft.draft_id, format);
      if (result.error) {
        toast.error(`Export failed: ${result.error}`);
      } else if (result.output_path) {
        toast.success(`Exported to ${result.output_path.split(/[\\/]/).pop()}`);
      }
    } catch {
      toast.error("Export failed");
    }
  };

  const handleOpenSection = (engramId: string) => {
    const note = allNotes.find((n) => {
      // Match by id via filename trick — best-effort
      return n.filename.includes(engramId.slice(0, 8));
    });
    if (note) selectNote(note.filename);
    else toast.warning("Open this section from the editor sidebar");
  };

  return (
    <div className="flex-1 flex bg-[#0b0b12] overflow-hidden">
      {/* Drafts list (left column) */}
      <div className="w-[280px] min-w-[280px] flex flex-col border-r border-[#1f1f2e] bg-[#0b0b12]">
        <div className="px-4 py-3 border-b border-[#1f1f2e] flex items-center justify-between">
          <h2 className="text-xs font-semibold text-[#a8a6c0] font-[Geist,sans-serif] uppercase tracking-wider">
            Drafts
          </h2>
          <button
            onClick={() => setCreating(true)}
            className="text-[#f0a500] text-xs hover:bg-[#1a1a28] px-2 py-0.5 rounded font-[Geist,sans-serif]"
          >
            + New
          </button>
        </div>

        {creating && (
          <div className="p-3 space-y-2 border-b border-[#1f1f2e]">
            <input
              autoFocus
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
                if (e.key === "Escape") setCreating(false);
              }}
              placeholder="Draft title..."
              className="w-full bg-[#1a1a28] text-[#e8e6f0] text-xs px-2 py-1.5 rounded border border-[#1f1f2e] focus:border-[#f0a500] focus:outline-none font-[Geist,sans-serif] placeholder:text-[#35335a]"
            />
            <input
              value={newTarget}
              onChange={(e) => setNewTarget(e.target.value)}
              placeholder="Word count target (optional)"
              type="number"
              className="w-full bg-[#1a1a28] text-[#e8e6f0] text-xs px-2 py-1.5 rounded border border-[#1f1f2e] focus:border-[#f0a500]/50 focus:outline-none font-[Geist,sans-serif] placeholder:text-[#35335a]"
            />
            <div className="flex gap-1">
              <button
                onClick={handleCreate}
                className="flex-1 bg-[#f0a500] text-[#0b0b12] text-xs px-2 py-1 rounded hover:bg-[#f0a500]/90 font-medium font-[Geist,sans-serif]"
              >
                Create
              </button>
              <button
                onClick={() => setCreating(false)}
                className="text-xs px-2 py-1 text-[#8a88a0] hover:text-[#e8e6f0] font-[Geist,sans-serif]"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {drafts.length === 0 ? (
            <p className="text-[#6a6880] text-xs text-center mt-8 px-4 font-[Geist,sans-serif]">
              No drafts yet. Click + New to start a chapter.
            </p>
          ) : (
            <AnimatePresence>
              {drafts.map((d) => {
                const active = activeDraft?.draft_id === d.draft_id;
                const progress = d.target_words
                  ? Math.min(1, d.word_count / d.target_words)
                  : null;
                return (
                  <motion.div
                    key={d.draft_id}
                    layout
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    onClick={() => loadActive(d.draft_id)}
                    className={`group relative px-4 py-3 cursor-pointer border-l-2 ${
                      active
                        ? "border-[#f0a500] bg-[#1a1a28]"
                        : "border-transparent hover:bg-[#12121c]/80"
                    }`}
                  >
                    <h3 className="text-sm font-medium text-[#e8e6f0] font-[Geist,sans-serif] truncate">
                      {d.title}
                    </h3>
                    <div className="flex items-center gap-2 mt-1 text-[10px] text-[#8a88a0] font-[Geist,sans-serif]">
                      <span>{d.section_count} sections</span>
                      <span>·</span>
                      <span>{d.word_count.toLocaleString()} words</span>
                    </div>
                    {progress !== null && (
                      <div className="mt-1.5 h-[2px] bg-[#1a1a28] rounded-full overflow-hidden">
                        <div
                          className="h-full bg-[#f0a500] transition-all duration-500"
                          style={{ width: `${progress * 100}%` }}
                        />
                      </div>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(d.draft_id, d.title);
                      }}
                      className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 text-[#8a88a0] hover:text-[#ff6b6b] text-xs p-1"
                    >
                      ×
                    </button>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          )}
        </div>
      </div>

      {/* Active draft (right column) */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {!activeDraft ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <p className="text-[#6a6880] text-sm font-[Geist,sans-serif]">
                Select or create a draft
              </p>
              <p className="text-[#35335a] text-xs mt-2 font-[Geist,sans-serif]">
                Drafts stitch your notes into chapters and export to DOCX/PDF
              </p>
            </div>
          </div>
        ) : (
          <>
            {/* Draft header */}
            <div className="px-6 py-4 border-b border-[#1f1f2e] flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <h1 className="text-xl font-semibold text-[#e8e6f0] font-[Geist,sans-serif]">
                  {activeDraft.title}
                </h1>
                {activeDraft.description && (
                  <p className="text-xs text-[#8a88a0] mt-1 font-[Geist,sans-serif]">
                    {activeDraft.description}
                  </p>
                )}
                <div className="flex items-center gap-3 mt-2 text-xs text-[#8a88a0] font-[Geist,sans-serif]">
                  <span>{activeDraft.sections.length} sections</span>
                  <span>·</span>
                  <span>{activeDraft.word_count.toLocaleString()} words</span>
                  {activeDraft.target_words > 0 && (
                    <>
                      <span>·</span>
                      <span>
                        target: {activeDraft.target_words.toLocaleString()}{" "}
                        ({Math.round((activeDraft.word_count / activeDraft.target_words) * 100)}%)
                      </span>
                    </>
                  )}
                </div>
              </div>
              <div className="flex gap-1 flex-shrink-0">
                <button
                  onClick={() => handleExport("docx")}
                  className="text-xs bg-[#1a1a28] hover:bg-[#1f1f2e] text-[#e8e6f0] px-3 py-1.5 rounded font-[Geist,sans-serif] transition-colors"
                >
                  Export DOCX
                </button>
                <button
                  onClick={() => handleExport("pdf")}
                  className="text-xs bg-[#1a1a28] hover:bg-[#1f1f2e] text-[#e8e6f0] px-3 py-1.5 rounded font-[Geist,sans-serif] transition-colors"
                >
                  PDF
                </button>
                <button
                  onClick={() => handleExport("html")}
                  className="text-xs bg-[#1a1a28] hover:bg-[#1f1f2e] text-[#e8e6f0] px-3 py-1.5 rounded font-[Geist,sans-serif] transition-colors"
                >
                  HTML
                </button>
              </div>
            </div>

            {/* Sections */}
            <div className="flex-1 overflow-y-auto p-6">
              {activeDraft.sections.length === 0 ? (
                <p className="text-center text-[#6a6880] text-sm font-[Geist,sans-serif] mt-8">
                  No sections yet. Add notes from below to build your draft.
                </p>
              ) : (
                <div className="max-w-[700px] mx-auto space-y-3">
                  {activeDraft.sections.map((s, i) => (
                    <div
                      key={s.engram_id}
                      className="group p-4 bg-[#1a1a28] border border-[#1f1f2e] rounded-lg hover:border-[#2a2a40] transition-colors"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-[10px] text-[#6a6880] font-mono">
                              §{i + 1}
                            </span>
                            <button
                              onClick={() => handleOpenSection(s.engram_id)}
                              className="text-sm font-medium text-[#e8e6f0] hover:text-[#f0a500] font-[Geist,sans-serif] truncate text-left"
                            >
                              {s.title}
                            </button>
                          </div>
                          <p className="text-xs text-[#8a88a0] line-clamp-2 font-[Geist,sans-serif]">
                            {s.preview}
                          </p>
                          <span className="text-[10px] text-[#6a6880] font-[Geist,sans-serif] mt-1 inline-block">
                            {s.word_count} words
                          </span>
                        </div>
                        <div className="flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => handleMove(s.engram_id, "up")}
                            disabled={i === 0}
                            className="text-[#8a88a0] hover:text-[#f0a500] disabled:opacity-30 disabled:hover:text-[#8a88a0] text-xs px-1"
                            title="Move up"
                          >
                            ▲
                          </button>
                          <button
                            onClick={() => handleMove(s.engram_id, "down")}
                            disabled={i === activeDraft.sections.length - 1}
                            className="text-[#8a88a0] hover:text-[#f0a500] disabled:opacity-30 disabled:hover:text-[#8a88a0] text-xs px-1"
                            title="Move down"
                          >
                            ▼
                          </button>
                          <button
                            onClick={() => handleRemoveSection(s.engram_id)}
                            className="text-[#8a88a0] hover:text-[#ff6b6b] text-xs px-1"
                            title="Remove from draft"
                          >
                            ×
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Add section */}
              <div className="max-w-[700px] mx-auto mt-4">
                {!showAddSection ? (
                  <button
                    onClick={() => setShowAddSection(true)}
                    className="w-full py-3 border border-dashed border-[#2a2a40] rounded-lg text-[#8a88a0] hover:text-[#f0a500] hover:border-[#f0a500]/40 text-xs font-[Geist,sans-serif] transition-colors"
                  >
                    + Add section from your notes
                  </button>
                ) : (
                  <div className="border border-[#2a2a40] rounded-lg bg-[#1a1a28] p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] text-[#8a88a0] font-[Geist,sans-serif] uppercase tracking-wider">
                        Pick a note to add
                      </span>
                      <button
                        onClick={() => setShowAddSection(false)}
                        className="text-[#8a88a0] hover:text-[#e8e6f0] text-xs"
                      >
                        ×
                      </button>
                    </div>
                    <div className="max-h-[200px] overflow-y-auto space-y-1">
                      {allNotes
                        .filter(
                          (n) =>
                            !activeDraft.sections.some((s) =>
                              n.filename.includes(s.engram_id.slice(0, 8))
                            )
                        )
                        .slice(0, 20)
                        .map((n) => (
                          <button
                            key={n.filename}
                            onClick={async () => {
                              // Need engram_id — fetch from API
                              const res = await fetch(
                                "http://127.0.0.1:8765/api/notes"
                              );
                              const list = await res.json();
                              const match = list.find(
                                (x: { filename: string; id: string }) =>
                                  x.filename === n.filename
                              );
                              if (match) await handleAddSection(match.id);
                            }}
                            className="w-full text-left px-2 py-1 text-xs text-[#e8e6f0] hover:bg-[#1f1f2e] rounded font-[Geist,sans-serif] truncate"
                          >
                            {n.title}
                          </button>
                        ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
