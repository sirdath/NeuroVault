import { useEffect, useMemo, useState } from "react";
import {
  activityApi,
  type AuditEntry,
  type ContextReceipt,
  type ContextReceiptFeedback,
} from "../lib/api";
import { decisionSentence, intentLabel } from "../lib/inspectorCopy";
import { toast } from "../stores/toastStore";

interface ActivityPanelProps {
  open: boolean;
  onClose: () => void;
  presentation?: "modal" | "page" | "embedded";
}

type View = "receipts" | "technical";
type DecisionFilter = "all" | "inject" | "silent";
type ToolFilter = "all" | "read" | "write";

/**
 * Activity has two levels on purpose:
 *
 * - Memory receipts answer the consumer question: "what context did the AI
 *   receive, and why?"
 * - Technical log keeps the lower-level HTTP/MCP audit trail available for
 *   debugging without making it the default product language.
 */
export function ActivityPanel({ open, onClose, presentation = "modal" }: ActivityPanelProps) {
  const [view, setView] = useState<View>("receipts");
  const [receipts, setReceipts] = useState<ContextReceipt[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [decisionFilter, setDecisionFilter] = useState<DecisionFilter>("all");
  const [toolFilter, setToolFilter] = useState<ToolFilter>("all");
  const [selectedReceipt, setSelectedReceipt] = useState<ContextReceipt | null>(null);
  const [selectedAudit, setSelectedAudit] = useState<AuditEntry | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = async () => {
      const [receiptResult, auditResult] = await Promise.allSettled([
        activityApi.contextReceipts(200),
        activityApi.recent(200),
      ]);
      if (cancelled) return;
      if (receiptResult.status === "fulfilled") setReceipts(receiptResult.value);
      if (auditResult.status === "fulfilled") setAudit(auditResult.value);
      setError(
        receiptResult.status === "rejected" && auditResult.status === "rejected"
          ? "Activity is unavailable while the local memory service is offline."
          : null,
      );
    };
    load();
    const id = window.setInterval(load, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [open]);

  const filteredReceipts = useMemo(
    () =>
      receipts.filter(
        (r) => decisionFilter === "all" || r.decision === decisionFilter,
      ),
    [receipts, decisionFilter],
  );

  const filteredAudit = useMemo(
    () =>
      audit.filter((entry) => {
        if (toolFilter === "all") return true;
        const tool = entry.tool.toLowerCase();
        if (toolFilter === "read")
          return ["recall", "get", "notes", "graph", "list"].some((part) =>
            tool.includes(part),
          );
        return ["remember", "post", "save", "create", "update", "delete"].some(
          (part) => tool.includes(part),
        );
      }),
    [audit, toolFilter],
  );

  const receiptStats = useMemo(() => {
    const injected = receipts.filter((r) => r.decision === "inject");
    return {
      decisions: receipts.length,
      injections: injected.length,
      memories: injected.reduce((sum, r) => sum + r.injected.length, 0),
    };
  }, [receipts]);

  if (!open) return null;

  const embedded = presentation === "embedded";

  const panel = (
      <div
        className={presentation === "modal"
          ? "fixed bottom-0 left-0 right-0 h-[74vh] z-50 flex flex-col rounded-t-2xl overflow-hidden"
          : embedded
            ? "flex min-w-0 flex-col overflow-hidden rounded-2xl"
            : "flex min-w-0 flex-1 flex-col overflow-hidden"}
        style={{
          background: "var(--nv-bg)",
          borderTop: presentation === "modal" ? "1px solid var(--nv-border)" : undefined,
          border: embedded ? "1px solid var(--nv-border)" : undefined,
          boxShadow: presentation === "modal" ? "0 -24px 80px rgba(0,0,0,0.35)" : undefined,
          height: embedded ? "min(620px, calc(100vh - 220px))" : undefined,
          minHeight: embedded ? 420 : undefined,
        }}
        role={presentation === "modal" ? "dialog" : embedded ? "region" : "main"}
        aria-label={embedded ? "Context receipt list" : "Memory activity"}
      >
        {!embedded && (
          <div
            className="flex items-center gap-4 px-6 py-4 flex-shrink-0"
            style={{ borderBottom: "1px solid var(--nv-border)" }}
          >
            <div>
              <h2 className="text-[15px] font-semibold" style={{ color: "var(--nv-text)" }}>
                Activity
              </h2>
              <p className="text-[11px] mt-0.5" style={{ color: "var(--nv-text-dim)" }}>
                A local receipt for what NeuroVault gave your AI — and what it deliberately withheld.
              </p>
            </div>
            <div className="flex items-center gap-1 ml-3">
              <ViewButton active={view === "receipts"} onClick={() => setView("receipts")}>
                Memory receipts
              </ViewButton>
              <ViewButton active={view === "technical"} onClick={() => setView("technical")}>
                Technical log
              </ViewButton>
            </div>
            {presentation === "modal" && (
              <button
                onClick={onClose}
                className="ml-auto w-8 h-8 flex items-center justify-center rounded-lg text-lg"
                style={{ color: "var(--nv-text-muted)", border: "1px solid var(--nv-border)" }}
                aria-label="Close activity panel"
                title="Close (Esc)"
              >
                ×
              </button>
            )}
          </div>
        )}

        {error && (
          <div className="px-6 py-3 text-[12px]" style={{ color: "var(--nv-negative)" }}>
            {error}
          </div>
        )}

        {embedded || view === "receipts" ? (
          <>
            <div
              className="flex flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3 flex-shrink-0"
              style={{ borderBottom: "1px solid var(--nv-border)" }}
            >
              <Stat value={receiptStats.decisions} label="decisions" />
              <Stat value={receiptStats.injections} label="times context was added" />
              <Stat value={receiptStats.memories} label="memories shared" />
              <div className="ml-auto flex flex-wrap justify-end gap-1">
                {(["all", "inject", "silent"] as const).map((filter) => (
                  <button
                    key={filter}
                    onClick={() => setDecisionFilter(filter)}
                    className="text-[11px] px-2.5 py-1 rounded-md"
                    style={{
                      color:
                        decisionFilter === filter
                          ? "var(--nv-accent)"
                          : "var(--nv-text-dim)",
                      background:
                        decisionFilter === filter
                          ? "var(--nv-accent-glow)"
                          : "transparent",
                    }}
                  >
                    {filter === "all" ? "All" : filter === "inject" ? "Context added" : "Stayed quiet"}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex-1 flex overflow-hidden">
              <div className="flex-1 overflow-y-auto">
                {filteredReceipts.length === 0 ? (
                  <EmptyState
                    title="No memory receipts yet"
                    body="Use Claude Code normally. Each automatic recall decision will appear here, including the healthy choice to stay quiet."
                  />
                ) : (
                  filteredReceipts.map((receipt) => (
                    <ReceiptRow
                      key={receipt.event_id}
                      receipt={receipt}
                      selected={selectedReceipt?.event_id === receipt.event_id}
                      onClick={() =>
                        setSelectedReceipt(
                          selectedReceipt?.event_id === receipt.event_id ? null : receipt,
                        )
                      }
                    />
                  ))
                )}
              </div>
              {selectedReceipt && <ReceiptDetail key={selectedReceipt.event_id} receipt={selectedReceipt} />}
            </div>
          </>
        ) : (
          <>
            <div
              className="flex items-center gap-2 px-6 py-2.5 flex-shrink-0"
              style={{ borderBottom: "1px solid var(--nv-border)" }}
            >
              <span className="text-[11px] mr-2" style={{ color: "var(--nv-text-dim)" }}>
                For troubleshooting · {audit.length} local calls
              </span>
              {(["all", "read", "write"] as const).map((filter) => (
                <button
                  key={filter}
                  onClick={() => setToolFilter(filter)}
                  className="text-[11px] px-2.5 py-1 rounded-md"
                  style={{
                    color: toolFilter === filter ? "var(--nv-accent)" : "var(--nv-text-dim)",
                    background: toolFilter === filter ? "var(--nv-accent-glow)" : "transparent",
                  }}
                >
                  {filter === "all" ? "All" : filter === "read" ? "Reads" : "Writes"}
                </button>
              ))}
            </div>
            <div className="flex-1 flex overflow-hidden">
              <div className="flex-1 overflow-y-auto">
                {filteredAudit.length === 0 ? (
                  <EmptyState title="No technical activity" body="No matching local API or MCP calls were recorded." />
                ) : (
                  filteredAudit.map((entry, index) => (
                    <AuditRow
                      key={`${entry.ts}-${index}`}
                      entry={entry}
                      selected={selectedAudit === entry}
                      onClick={() => setSelectedAudit(selectedAudit === entry ? null : entry)}
                    />
                  ))
                )}
              </div>
              {selectedAudit && <AuditDetail entry={selectedAudit} />}
            </div>
          </>
        )}
      </div>
  );

  if (presentation === "page" || presentation === "embedded") return panel;
  return (
    <>
      <div className="fixed inset-0 z-40" style={{ background: "var(--nv-overlay)" }} onClick={onClose} />
      {panel}
    </>
  );
}

function ViewButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="text-[12px] px-3 py-1.5 rounded-lg"
      style={{
        color: active ? "var(--nv-accent)" : "var(--nv-text-dim)",
        background: active ? "var(--nv-accent-glow)" : "transparent",
        border: `1px solid ${active ? "var(--nv-accent)" : "transparent"}`,
      }}
    >
      {children}
    </button>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-[15px] font-semibold tabular-nums" style={{ color: "var(--nv-text)" }}>
        {value}
      </span>
      <span className="text-[11px]" style={{ color: "var(--nv-text-dim)" }}>
        {label}
      </span>
    </div>
  );
}

function ReceiptRow({ receipt, selected, onClick }: { receipt: ContextReceipt; selected: boolean; onClick: () => void }) {
  const injected = receipt.decision === "inject";
  return (
    <button
      onClick={onClick}
      className="w-full text-left flex items-start gap-3 px-6 py-3.5"
      style={{
        background: selected ? "var(--nv-surface)" : "transparent",
        borderBottom: "1px solid var(--nv-border)",
      }}
    >
      <span
        className="w-2 h-2 rounded-full mt-1.5 shrink-0"
        style={{ background: injected ? "var(--nv-positive)" : "var(--nv-text-dim)" }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-medium" style={{ color: "var(--nv-text)" }}>
            {decisionSentence(receipt.decision, receipt.reason, receipt.injected.length, receipt.tokens)}
          </span>
          <span className="text-[11px]" style={{ color: "var(--nv-text-dim)" }}>
            {intentLabel(receipt.intent)}
          </span>
        </div>
        <p className="text-[11px] mt-1 truncate" style={{ color: "var(--nv-text-dim)" }}>
          {injected ? receiptTitles(receipt).join(" · ") || "Memory details available" : quietReason(receipt.reason)}
        </p>
      </div>
      <span className="text-[11px] tabular-nums shrink-0" style={{ color: "var(--nv-text-dim)" }}>
        {new Date(receipt.ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
      </span>
    </button>
  );
}

function ReceiptDetail({ receipt }: { receipt: ContextReceipt }) {
  const titles = receiptTitles(receipt);
  const storageKey = `nv.context-feedback.${receipt.event_id}`;
  const [feedback, setFeedback] = useState<ContextReceiptFeedback | null>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      return stored === "useful" || stored === "wrong_project" || stored === "outdated" ? stored : null;
    } catch {
      return null;
    }
  });
  const [savingFeedback, setSavingFeedback] = useState(false);

  const submitFeedback = async (next: ContextReceiptFeedback) => {
    if (savingFeedback || feedback === next) return;
    setSavingFeedback(true);
    try {
      await activityApi.contextFeedback(receipt, next);
      setFeedback(next);
      try { localStorage.setItem(storageKey, next); } catch { /* journal remains authoritative */ }
      toast.success(next === "useful" ? "Marked useful." : "Correction saved with this receipt's evidence.");
    } catch (cause) {
      toast.error(`Couldn't save that correction: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setSavingFeedback(false);
    }
  };

  return (
    <aside className="w-[390px] overflow-y-auto p-5" style={{ borderLeft: "1px solid var(--nv-border)" }}>
      <p className="text-[10px] uppercase tracking-wider" style={{ color: "var(--nv-text-dim)" }}>
        Memory receipt
      </p>
      <h3 className="text-[15px] font-semibold mt-1" style={{ color: "var(--nv-text)" }}>
        {receipt.decision === "inject" ? "Context was added" : "NeuroVault stayed quiet"}
      </h3>
      <p className="text-[12px] leading-relaxed mt-2" style={{ color: "var(--nv-text-muted)" }}>
        {decisionSentence(receipt.decision, receipt.reason, receipt.injected.length, receipt.tokens)}
      </p>
      <div className="grid grid-cols-2 gap-2 mt-5">
        <DetailCard label="When" value={new Date(receipt.ts).toLocaleString()} />
        <DetailCard label="Activity" value={intentLabel(receipt.intent)} />
        <DetailCard label="AI host" value={receipt.host || "local AI client"} />
        <DetailCard label="Decision time" value={receipt.ms != null ? `${receipt.ms} ms` : "—"} />
      </div>
      {receipt.decision === "inject" ? (
        <div className="mt-5">
          <p className="text-[10px] uppercase tracking-wider mb-2" style={{ color: "var(--nv-text-dim)" }}>
            Memories shared with the AI
          </p>
          <div className="space-y-2">
            {titles.length > 0 ? titles.map((title) => (
              <div key={title} className="rounded-lg px-3 py-2 text-[12px]" style={{ background: "var(--nv-surface)", color: "var(--nv-text)", border: "1px solid var(--nv-border)" }}>
                {title}
              </div>
            )) : (
              <p className="text-[12px]" style={{ color: "var(--nv-text-dim)" }}>The receipt contains ids, but their titles are no longer in the candidate window.</p>
            )}
          </div>
          <div className="mt-5 rounded-xl px-4 py-3" style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)" }}>
            <p className="text-[11px] font-medium" style={{ color: "var(--nv-text)" }}>Was this context right?</p>
            <p className="mt-1 text-[10.5px] leading-relaxed" style={{ color: "var(--nv-text-dim)" }}>
              Your answer is stored locally with this receipt. It records evidence for future improvements; it does not silently move or delete a memory.
            </p>
            <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Context receipt feedback">
              {([
                ["useful", "Useful"],
                ["wrong_project", "Wrong vault"],
                ["outdated", "Outdated"],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={feedback === value}
                  disabled={savingFeedback}
                  onClick={() => void submitFeedback(value)}
                  className="rounded-lg px-2.5 py-1.5 text-[11px] font-medium disabled:opacity-50"
                  style={{
                    color: feedback === value ? "var(--nv-bg)" : "var(--nv-text-muted)",
                    background: feedback === value ? "var(--nv-accent)" : "transparent",
                    border: `1px solid ${feedback === value ? "var(--nv-accent)" : "var(--nv-border)"}`,
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-5 rounded-xl px-4 py-3" style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)" }}>
          <p className="text-[10px] uppercase tracking-wider mb-1" style={{ color: "var(--nv-text-dim)" }}>Why nothing was added</p>
          <p className="text-[12px] leading-relaxed" style={{ color: "var(--nv-text-muted)" }}>{quietReason(receipt.reason)}</p>
        </div>
      )}
      <details className="mt-5">
        <summary className="text-[11px] cursor-pointer" style={{ color: "var(--nv-text-dim)" }}>Privacy-safe technical details</summary>
        <div className="mt-2 text-[11px] font-mono space-y-1" style={{ color: "var(--nv-text-dim)" }}>
          <div>decision: {receipt.decision}</div>
          <div>reason: {receipt.reason}</div>
          <div>tokens: {receipt.tokens}</div>
          {receipt.session_id && <div>session: {receipt.session_id}</div>}
          <p className="font-sans leading-relaxed pt-1">Prompt text is not stored here by default; NeuroVault records a hash for correlation.</p>
        </div>
      </details>
    </aside>
  );
}

function receiptTitles(receipt: ContextReceipt): string[] {
  const ids = new Set(receipt.injected);
  return (receipt.candidates ?? [])
    .filter((candidate) => ids.has(candidate.engram_id))
    .map((candidate) => candidate.title)
    .filter(Boolean);
}

function quietReason(reason: string): string {
  return decisionSentence("silent", reason, 0, 0).replace(/^Stayed quiet —\s*/i, "");
}

function AuditRow({ entry, selected, onClick }: { entry: AuditEntry; selected: boolean; onClick: () => void }) {
  const isUi = entry.tool.startsWith("http:");
  const label = isUi ? "NeuroVault UI" : "Local AI client";
  const isError = typeof entry.status_code === "number" && entry.status_code >= 400;
  return (
    <button
      onClick={onClick}
      className="w-full text-left flex items-center gap-3 px-6 py-2.5 text-[12px]"
      style={{ background: selected ? "var(--nv-surface)" : "transparent", borderBottom: "1px solid var(--nv-border)" }}
    >
      <span className="font-mono w-[72px] shrink-0" style={{ color: "var(--nv-text-dim)" }}>
        {new Date(entry.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
      </span>
      <span className="w-[112px] shrink-0" style={{ color: isUi ? "var(--nv-text-dim)" : "var(--nv-accent)" }}>{label}</span>
      <span className="font-mono truncate flex-1" style={{ color: isError ? "var(--nv-negative)" : "var(--nv-text-muted)" }}>{entry.tool}</span>
      {entry.duration_ms != null && <span className="font-mono text-[11px]" style={{ color: "var(--nv-text-dim)" }}>{entry.duration_ms} ms</span>}
    </button>
  );
}

function AuditDetail({ entry }: { entry: AuditEntry }) {
  return (
    <aside className="w-[390px] overflow-y-auto p-5" style={{ borderLeft: "1px solid var(--nv-border)" }}>
      <p className="text-[10px] uppercase tracking-wider" style={{ color: "var(--nv-text-dim)" }}>Technical event</p>
      <h3 className="text-[13px] font-semibold font-mono mt-1 break-all" style={{ color: "var(--nv-text)" }}>{entry.tool}</h3>
      <div className="grid grid-cols-2 gap-2 mt-4">
        <DetailCard label="Time" value={new Date(entry.ts).toLocaleString()} />
        <DetailCard label="Duration" value={entry.duration_ms != null ? `${entry.duration_ms} ms` : "—"} />
        <DetailCard label="Status" value={entry.status_code != null ? String(entry.status_code) : "—"} />
        <DetailCard label="Results" value={entry.result_count != null ? String(entry.result_count) : "—"} />
      </div>
      <p className="text-[10px] uppercase tracking-wider mt-5 mb-1" style={{ color: "var(--nv-text-dim)" }}>Arguments</p>
      <pre className="text-[11px] font-mono p-3 rounded-lg overflow-x-auto whitespace-pre-wrap" style={{ background: "var(--nv-surface)", color: "var(--nv-text-muted)", border: "1px solid var(--nv-border)" }}>{JSON.stringify(entry.args, null, 2)}</pre>
      {entry.error && <p className="text-[12px] mt-3" style={{ color: "var(--nv-negative)" }}>{entry.error}</p>}
    </aside>
  );
}

function DetailCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg px-3 py-2" style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)" }}>
      <p className="text-[9px] uppercase tracking-wider" style={{ color: "var(--nv-text-dim)" }}>{label}</p>
      <p className="text-[11px] mt-0.5 break-words" style={{ color: "var(--nv-text-muted)" }}>{value}</p>
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="text-center px-8 py-14 max-w-md mx-auto">
      <p className="text-[14px] font-medium" style={{ color: "var(--nv-text)" }}>{title}</p>
      <p className="text-[12px] leading-relaxed mt-2" style={{ color: "var(--nv-text-dim)" }}>{body}</p>
    </div>
  );
}
