import { useEffect, useMemo } from "react";
import { useCompilationStore } from "../stores/compilationStore";
import { MarkdownPreview } from "./MarkdownPreview";
import { toast } from "../stores/toastStore";
import type { CompilationChangelogEntry } from "../lib/api";

// Vault Noir palette anchors (kept local to this file — same values the
// other panels use, imported via CSS custom properties elsewhere but
// inlined here for Tailwind arbitrary-value syntax).
const BG = "bg-[#0b0b12]";
const BORDER = "border-[#1f1f2e]";
const TEXT = "text-[#e8e6f0]";
const TEXT_MUTED = "text-[#8a88a0]";
const TEXT_DIM = "text-[#6a6880]";
const ACCENT = "text-[#b592ff]";
const ACCENT_BG = "bg-[#b592ff]";
const POSITIVE = "text-[#8cd98c]";
const NEGATIVE = "text-[#ff8a8a]";

function statusBadge(status: string): { label: string; color: string } {
  if (status === "approved") return { label: "APPROVED", color: "bg-[#1f3a1f] text-[#8cd98c]" };
  if (status === "rejected") return { label: "REJECTED", color: "bg-[#3a1f1f] text-[#ff8a8a]" };
  return { label: "PENDING", color: "bg-[#2a2438] text-[#b592ff]" };
}

function changeBadge(change: string): string {
  if (change === "added") return POSITIVE;
  if (change === "removed") return NEGATIVE;
  return ACCENT;
}

function ChangelogEntry({ entry }: { entry: CompilationChangelogEntry }) {
  return (
    <div className={`border-l-2 ${BORDER} pl-3 py-2 hover:bg-[#15152a] transition-colors`}>
      <div className="flex items-center gap-2 mb-1">
        <span
          className={`text-[10px] uppercase tracking-wider font-semibold ${changeBadge(
            entry.change
          )}`}
        >
          {entry.change}
        </span>
        <span className={`text-xs ${TEXT} font-medium`}>{entry.field}</span>
        {entry.source_ids.length > 0 && (
          <span className={`text-[10px] ${TEXT_DIM} ml-auto font-mono`}>
            src: {entry.source_ids.join(", ")}
          </span>
        )}
      </div>
      {entry.before && (
        <div className="mb-1">
          <span className={`text-[10px] ${TEXT_DIM} font-mono mr-1`}>before</span>
          <span className={`text-xs ${TEXT_MUTED} line-through`}>{entry.before}</span>
        </div>
      )}
      {entry.after && (
        <div className="mb-1">
          <span className={`text-[10px] ${TEXT_DIM} font-mono mr-1`}>after</span>
          <span className={`text-xs ${TEXT}`}>{entry.after}</span>
        </div>
      )}
      {entry.reason && (
        <div className={`text-[11px] ${TEXT_MUTED} italic mt-1`}>
          {entry.reason}
        </div>
      )}
    </div>
  );
}

export function CompilationReview() {
  const list = useCompilationStore((s) => s.list);
  const activeId = useCompilationStore((s) => s.activeId);
  const activeDetail = useCompilationStore((s) => s.activeDetail);
  const loadingList = useCompilationStore((s) => s.loadingList);
  const loadingDetail = useCompilationStore((s) => s.loadingDetail);
  const error = useCompilationStore((s) => s.error);

  const loadList = useCompilationStore((s) => s.loadList);
  const selectCompilation = useCompilationStore((s) => s.selectCompilation);
  const approve = useCompilationStore((s) => s.approve);
  const reject = useCompilationStore((s) => s.reject);

  useEffect(() => {
    loadList();
  }, [loadList]);

  // Auto-select the first pending item on load
  useEffect(() => {
    const first = list[0];
    if (!activeId && first) {
      selectCompilation(first.id);
    }
  }, [activeId, list, selectCompilation]);

  const counts = useMemo(() => {
    const pending = list.filter((c) => c.status === "pending").length;
    const approved = list.filter((c) => c.status === "approved").length;
    const rejected = list.filter((c) => c.status === "rejected").length;
    return { pending, approved, rejected, total: list.length };
  }, [list]);

  const handleApprove = async () => {
    if (!activeDetail) return;
    await approve(activeDetail.id);
    toast.success(`Approved "${activeDetail.topic}"`);
  };

  const handleReject = async () => {
    if (!activeDetail) return;
    if (!window.confirm(`Reject compilation for "${activeDetail.topic}"?`)) return;
    await reject(activeDetail.id);
    toast.success(`Rejected "${activeDetail.topic}"`);
  };

  return (
    <div className={`flex-1 flex ${BG} overflow-hidden`}>
      {/* Left: compilation list */}
      <div className={`w-[320px] border-r ${BORDER} flex flex-col`}>
        <div className={`px-4 py-3 border-b ${BORDER}`}>
          <div className="flex items-center justify-between mb-1">
            <h2 className={`text-sm font-semibold ${TEXT} font-[Geist,sans-serif]`}>
              Compilations
            </h2>
            <button
              onClick={() => loadList()}
              className={`text-[10px] ${TEXT_DIM} hover:${TEXT} uppercase tracking-wider`}
              title="Refresh"
            >
              refresh
            </button>
          </div>
          <div className={`text-[11px] ${TEXT_MUTED} font-[Geist,sans-serif]`}>
            {counts.pending} pending · {counts.approved} approved · {counts.rejected} rejected
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loadingList && (
            <div className={`px-4 py-6 text-xs ${TEXT_DIM} font-[Geist,sans-serif]`}>
              Loading compilations…
            </div>
          )}
          {error && !loadingList && (
            <div className={`px-4 py-6 text-xs ${NEGATIVE} font-[Geist,sans-serif]`}>
              {error}
            </div>
          )}
          {!loadingList && list.length === 0 && !error && (
            <div className={`px-4 py-6 text-xs ${TEXT_DIM} font-[Geist,sans-serif]`}>
              No compilations yet. Run the compiler to generate wiki pages from
              raw sources.
            </div>
          )}
          {list.map((c) => {
            const badge = statusBadge(c.status);
            const isActive = c.id === activeId;
            return (
              <button
                key={c.id}
                onClick={() => selectCompilation(c.id)}
                className={`w-full text-left px-4 py-3 border-b ${BORDER} hover:bg-[#15152a] transition-colors ${
                  isActive ? "bg-[#1a1a2e]" : ""
                }`}
              >
                <div className="flex items-start justify-between gap-2 mb-1">
                  <span className={`text-sm ${TEXT} font-medium font-[Geist,sans-serif] truncate`}>
                    {c.topic}
                  </span>
                  <span
                    className={`text-[9px] px-1.5 py-0.5 rounded font-mono uppercase tracking-wider ${badge.color} shrink-0`}
                  >
                    {badge.label}
                  </span>
                </div>
                <div className={`text-[11px] ${TEXT_DIM} font-[Geist,sans-serif]`}>
                  {c.change_count} changes · {c.source_count} sources
                </div>
                <div className={`text-[10px] ${TEXT_DIM} font-mono mt-0.5`}>
                  {c.model}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Right: detail */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {!activeDetail && !loadingDetail && (
          <div className={`flex-1 flex items-center justify-center ${TEXT_DIM}`}>
            <div className="text-center">
              <p className="text-sm font-[Geist,sans-serif]">
                Select a compilation to review
              </p>
              <p className="text-xs mt-2 font-[Geist,sans-serif]">
                {counts.pending > 0
                  ? `${counts.pending} pending review`
                  : "Nothing pending"}
              </p>
            </div>
          </div>
        )}

        {loadingDetail && (
          <div className={`flex-1 flex items-center justify-center ${TEXT_DIM}`}>
            <p className="text-sm font-[Geist,sans-serif]">Loading…</p>
          </div>
        )}

        {activeDetail && !loadingDetail && (
          <>
            {/* Header */}
            <div className={`px-6 py-4 border-b ${BORDER}`}>
              <div className="flex items-center justify-between gap-3 mb-2">
                <h1 className={`text-lg font-semibold ${TEXT} font-[Geist,sans-serif]`}>
                  {activeDetail.topic}
                </h1>
                <div className="flex items-center gap-2">
                  {activeDetail.status === "pending" && (
                    <>
                      <button
                        onClick={handleReject}
                        className={`px-3 py-1 text-[11px] border ${BORDER} ${TEXT_MUTED} hover:${NEGATIVE} hover:border-[#3a1f1f] rounded uppercase tracking-wider font-[Geist,sans-serif]`}
                      >
                        reject
                      </button>
                      <button
                        onClick={handleApprove}
                        className={`px-3 py-1 text-[11px] ${ACCENT_BG} text-[#0b0b12] rounded uppercase tracking-wider font-semibold font-[Geist,sans-serif] hover:brightness-110`}
                      >
                        approve
                      </button>
                    </>
                  )}
                  {activeDetail.status !== "pending" && (
                    <span
                      className={`text-[10px] px-2 py-1 rounded font-mono uppercase tracking-wider ${
                        statusBadge(activeDetail.status).color
                      }`}
                    >
                      {statusBadge(activeDetail.status).label}
                    </span>
                  )}
                </div>
              </div>
              <div className={`text-[11px] ${TEXT_DIM} font-[Geist,sans-serif] flex items-center gap-3`}>
                <span>{activeDetail.changelog.length} changes</span>
                <span>·</span>
                <span>{activeDetail.sources.length} sources</span>
                <span>·</span>
                <span className="font-mono">{activeDetail.model}</span>
                {activeDetail.reviewed_at && (
                  <>
                    <span>·</span>
                    <span>reviewed {activeDetail.reviewed_at}</span>
                  </>
                )}
              </div>
            </div>

            {/* Body: two columns - preview + changelog */}
            <div className="flex-1 flex overflow-hidden">
              {/* Wiki preview */}
              <div className="flex-1 overflow-y-auto px-8 py-6">
                <div className={`text-[10px] uppercase tracking-wider ${TEXT_DIM} mb-3 font-[Geist,sans-serif]`}>
                  Compiled wiki page
                </div>
                <div className="max-w-3xl">
                  <MarkdownPreview
                    content={activeDetail.new_content}
                    onSwitchToEdit={() => {
                      /* read-only preview in the review panel */
                    }}
                  />
                </div>
              </div>

              {/* Changelog sidebar */}
              <div className={`w-[340px] border-l ${BORDER} flex flex-col`}>
                <div className={`px-4 py-3 border-b ${BORDER}`}>
                  <div className={`text-[10px] uppercase tracking-wider ${TEXT_DIM} font-[Geist,sans-serif]`}>
                    Changelog ({activeDetail.changelog.length})
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1">
                  {activeDetail.changelog.map((entry, i) => (
                    <ChangelogEntry key={i} entry={entry} />
                  ))}
                </div>

                {/* Sources footer */}
                <div className={`px-4 py-3 border-t ${BORDER}`}>
                  <div className={`text-[10px] uppercase tracking-wider ${TEXT_DIM} mb-2 font-[Geist,sans-serif]`}>
                    Sources ({activeDetail.sources.length})
                  </div>
                  <div className="space-y-1">
                    {activeDetail.sources.map((s) => (
                      <div
                        key={s.id}
                        className={`text-[11px] ${TEXT_MUTED} font-[Geist,sans-serif] truncate`}
                        title={s.title}
                      >
                        <span className={`font-mono ${TEXT_DIM} mr-1`}>
                          {s.kind[0]?.toUpperCase() ?? "?"}
                        </span>
                        {s.title}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
