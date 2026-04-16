import { useEffect, useMemo, useState, useRef } from "react";
import { useCompilationStore } from "../stores/compilationStore";
import { MarkdownPreview } from "./MarkdownPreview";
import { toast } from "../stores/toastStore";
import type { CompilationChangelogEntry } from "../lib/api";

// Vault Noir palette anchors (kept local to this file — same values the
// other panels use, imported via CSS custom properties elsewhere but
// inlined here for Tailwind arbitrary-value syntax).
const BG = "bg-[#08080f]";
const BORDER = "border-white/[0.06]";
const TEXT = "text-white/90";
const TEXT_MUTED = "text-white/40";
const TEXT_DIM = "text-white/20";
const ACCENT = "text-[#b592ff]";
const ACCENT_BG = "bg-white/[0.12]";
const POSITIVE = "text-[#4ade80]";
const NEGATIVE = "text-[#ff6b6b]";

function statusBadge(status: string): { label: string; color: string } {
  if (status === "approved") return { label: "APPROVED", color: "bg-[#4ade80]/10 text-[#4ade80] border border-[#4ade80]/15" };
  if (status === "rejected") return { label: "REJECTED", color: "bg-[#ff6b6b]/10 text-[#ff6b6b] border border-[#ff6b6b]/15" };
  return { label: "PENDING", color: "bg-white/[0.06] text-white/50 border border-white/[0.08]" };
}

/** Short relative timestamp — "2 min ago", "3 hours ago", "yesterday".
 *  Falls back to the raw ISO string if Date parsing fails so we never
 *  crash the header on a malformed row. */
function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const diff = Date.now() - then;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.round(hr / 24);
  if (day === 1) return "yesterday";
  if (day < 7) return `${day} days ago`;
  return new Date(then).toISOString().slice(0, 10);
}

function changeBadge(change: string): string {
  if (change === "added") return POSITIVE;
  if (change === "removed") return NEGATIVE;
  return ACCENT;
}

/** Side-by-side compare view used when a compilation is UPDATING an existing
 *  wiki page (i.e. `old_content` is non-empty). Renders both versions through
 *  MarkdownPreview so we keep typography + wiki-link handling consistent with
 *  the normal reader view, and lets the reviewer eyeball what actually
 *  changed at the prose level rather than reading a raw unified diff. The
 *  changelog sidebar carries the structured "why" in parallel.
 */
function CompareView({ oldContent, newContent }: { oldContent: string; newContent: string }) {
  return (
    <div className="flex h-full min-h-0">
      <div className={`flex-1 overflow-y-auto border-r ${BORDER}`}>
        <div className={`sticky top-0 ${BG} px-6 pt-5 pb-2 border-b ${BORDER} z-10`}>
          <div className={`text-[10px] uppercase tracking-wider ${TEXT_DIM} font-[Geist,sans-serif]`}>
            Before · previous wiki page
          </div>
        </div>
        <div className="px-6 py-4 max-w-none">
          <MarkdownPreview content={oldContent} />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className={`sticky top-0 ${BG} px-6 pt-5 pb-2 border-b ${BORDER} z-10`}>
          <div className={`text-[10px] uppercase tracking-wider ${ACCENT} font-[Geist,sans-serif]`}>
            After · compiled version
          </div>
        </div>
        <div className="px-6 py-4 max-w-none">
          <MarkdownPreview content={newContent} />
        </div>
      </div>
    </div>
  );
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
    // Optional annotation — blank / cancel means no comment. We don't block
    // approval on providing one; most approvals are a silent "ship it".
    const comment = window.prompt(
      `Approve compilation for "${activeDetail.topic}"?\n\nOptional comment (press OK to approve without one):`,
      ""
    );
    if (comment === null) return; // cancelled
    await approve(activeDetail.id, comment || undefined);
    toast.success(`Approved "${activeDetail.topic}"`);
  };

  const handleReject = async () => {
    if (!activeDetail) return;
    // Rejection reason is more useful — asking for one every time trains
    // the habit. Cancel aborts; empty string is still allowed (user can
    // reject without explaining if they really want to).
    const comment = window.prompt(
      `Reject compilation for "${activeDetail.topic}"?\n\nReason (helps future compiles do better):`,
      ""
    );
    if (comment === null) return;
    await reject(activeDetail.id, comment || undefined);
    toast.success(`Rejected "${activeDetail.topic}"`);
  };

  // Resizable panels
  const [listWidth, setListWidth] = useState(260);
  const [changelogWidth, setChangelogWidth] = useState(300);
  const resizingList = useRef(false);
  const resizingChangelog = useRef(false);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (resizingList.current) {
        setListWidth(Math.max(180, Math.min(450, e.clientX)));
      }
      if (resizingChangelog.current) {
        setChangelogWidth(Math.max(200, Math.min(500, window.innerWidth - e.clientX)));
      }
    };
    const onMouseUp = () => {
      resizingList.current = false;
      resizingChangelog.current = false;
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  return (
    <div className={`flex-1 flex ${BG} overflow-hidden`}>
      {/* Left: compilation list */}
      <div
        className={`border-r ${BORDER} flex flex-col bg-white/[0.02] relative`}
        style={{ width: listWidth, minWidth: listWidth }}
      >
        {/* Resize handle */}
        <div
          className="absolute top-0 right-0 w-1 h-full cursor-col-resize z-10 hover:bg-white/[0.08] active:bg-white/[0.12] transition-colors"
          onMouseDown={() => { resizingList.current = true; document.body.style.cursor = "col-resize"; }}
        />
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
            <div className={`px-4 py-6`}>
              <div className={`text-[10px] uppercase tracking-wider ${NEGATIVE} mb-2 font-[Geist,sans-serif] font-semibold`}>
                Can't reach the server
              </div>
              <div className={`text-[11px] ${TEXT_MUTED} font-[Geist,sans-serif] mb-3 leading-relaxed`}>
                The Python backend on <span className="font-mono">127.0.0.1:8765</span> isn't
                answering. Compilations are stored in the brain DB so this view
                needs it running.
              </div>
              <div className={`text-[10px] ${TEXT_DIM} font-mono whitespace-pre-wrap mb-3`}>
                {error}
              </div>
              <button
                onClick={() => loadList()}
                className={`text-[10px] uppercase tracking-wider px-2 py-1 border ${BORDER} ${TEXT_MUTED} hover:${TEXT} rounded font-[Geist,sans-serif]`}
              >
                retry
              </button>
            </div>
          )}
          {!loadingList && list.length === 0 && !error && (
            <div className={`px-4 py-8`}>
              <div className={`text-[10px] uppercase tracking-wider ${TEXT_DIM} mb-2 font-[Geist,sans-serif] font-semibold`}>
                Nothing to review
              </div>
              <div className={`text-[11px] ${TEXT_MUTED} font-[Geist,sans-serif] leading-relaxed`}>
                No compilations yet. The compiler turns raw notes about a topic
                into a single canonical wiki page, gated behind a human
                approval. Ask Claude Code to compile a topic that's well-covered
                in the current brain and the review will show up here.
              </div>
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
        {!activeDetail && !loadingDetail && list.length > 0 && (
          <div className={`flex-1 flex items-center justify-center ${TEXT_DIM}`}>
            <div className="text-center max-w-sm px-8">
              <p className={`text-sm ${TEXT_MUTED} font-[Geist,sans-serif]`}>
                Select a compilation on the left
              </p>
              <p className={`text-xs mt-2 ${TEXT_DIM} font-[Geist,sans-serif]`}>
                {counts.pending > 0
                  ? `${counts.pending} waiting for your review`
                  : "Everything reviewed — nothing pending"}
              </p>
            </div>
          </div>
        )}

        {!activeDetail && !loadingDetail && list.length === 0 && (
          <div className={`flex-1 flex items-center justify-center ${TEXT_DIM}`}>
            <div className="text-center max-w-md px-8">
              <div className={`text-3xl ${TEXT_DIM} mb-3 font-[Geist,sans-serif]`}>○</div>
              <p className={`text-sm ${TEXT_MUTED} font-[Geist,sans-serif] mb-2`}>
                The compiler hasn't run yet
              </p>
              <p className={`text-xs ${TEXT_DIM} font-[Geist,sans-serif] leading-relaxed`}>
                When you ask Claude Code to compile a topic, the generated
                wiki page lands here as <span className="font-mono">pending</span> and
                waits for you to approve, reject with a reason, or edit the
                raw sources and recompile.
              </p>
            </div>
          </div>
        )}

        {loadingDetail && (
          <div className={`flex-1 flex items-center justify-center ${TEXT_DIM}`}>
            <p className={`text-xs ${TEXT_MUTED} font-[Geist,sans-serif]`}>Loading detail…</p>
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
                <span>·</span>
                <span title={activeDetail.created_at}>
                  created {relativeTime(activeDetail.created_at)}
                </span>
                {activeDetail.reviewed_at && (
                  <>
                    <span>·</span>
                    <span title={activeDetail.reviewed_at}>
                      reviewed {relativeTime(activeDetail.reviewed_at)}
                    </span>
                  </>
                )}
              </div>
              {activeDetail.review_comment && (
                <div
                  className={`mt-3 border-l-2 ${
                    activeDetail.status === "approved"
                      ? "border-[#8cd98c]"
                      : activeDetail.status === "rejected"
                      ? "border-[#ff8a8a]"
                      : "border-[#b592ff]"
                  } pl-3 py-1`}
                >
                  <div className={`text-[9px] uppercase tracking-wider ${TEXT_DIM} font-[Geist,sans-serif] mb-0.5`}>
                    Reviewer note
                  </div>
                  <div className={`text-xs ${TEXT} font-[Geist,sans-serif] italic`}>
                    "{activeDetail.review_comment}"
                  </div>
                </div>
              )}
            </div>

            {/* Body: two columns - preview + changelog */}
            <div className="flex-1 flex overflow-hidden">
              {/* Wiki preview (or diff view when we're UPDATING an existing page) */}
              <div className="flex-1 overflow-y-auto">
                {activeDetail.old_content ? (
                  <CompareView
                    oldContent={activeDetail.old_content}
                    newContent={activeDetail.new_content}
                  />
                ) : (
                  <div className="px-8 py-6">
                    <div className={`text-[10px] uppercase tracking-wider ${TEXT_DIM} mb-3 font-[Geist,sans-serif]`}>
                      Compiled wiki page · first compile
                    </div>
                    <div className="max-w-3xl">
                      <MarkdownPreview content={activeDetail.new_content} />
                    </div>
                  </div>
                )}
              </div>

              {/* Changelog sidebar — resizable */}
              <div
                className={`border-l ${BORDER} flex flex-col bg-white/[0.02] relative`}
                style={{ width: changelogWidth, minWidth: changelogWidth }}
              >
                {/* Resize handle (left edge) */}
                <div
                  className="absolute top-0 left-0 w-1 h-full cursor-col-resize z-10 hover:bg-white/[0.08] active:bg-white/[0.12] transition-colors"
                  onMouseDown={() => { resizingChangelog.current = true; document.body.style.cursor = "col-resize"; }}
                />
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
