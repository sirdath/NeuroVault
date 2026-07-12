/**
 * Memory Inspector — the Context Trace UI (adaptive-memory spec V1c-1).
 *
 * Every automatic-recall event, fully explained: prompt → detected
 * intent (+ router reason) → per-section candidates with salience
 * components, cross-encoder score, and lifecycle status → gate verdict
 * with skip reasons → the injected packet head. "Silent" events are
 * first-class rows — no-context-injected is a decision, not an absence.
 *
 * Read-only over GET /api/ambient_log (the JSONL decision log). The
 * trust story: automatic injection is only safe if every judgment call
 * the system makes is inspectable after the fact.
 */

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { API_HOST } from "../lib/config";
import MemoryReview, { LearningReport } from "./MemoryReview";
import { decisionSentence, intentLabel, TRACE_EXPLAINER } from "../lib/inspectorCopy";

type ItemTrace = {
  kind?: string;
  lifecycle?: string;
  salience?: {
    recency: number;
    usage: number;
    importance: number;
    confidence: number;
    reliability: number;
    link_bonus: number;
    total: number;
  };
};

type SectionItem = {
  id: string;
  engram_id?: string | null;
  ce_prob?: number | null;
  salience?: number | null;
  trace?: ItemTrace | null;
};

type Section = {
  title: string;
  items: SectionItem[];
  skipped: [string, string][];
};

type LogRecord = {
  event_id: string;
  ts: string;
  brain: string;
  host?: string | null;
  session_id?: string | null;
  decision: "inject" | "silent";
  reason: string;
  intent?: string | null;
  intent_confidence?: number | null;
  route_reason?: string | null;
  sections?: Section[] | null;
  candidates?: {
    engram_id: string;
    title: string;
    scores?: { ce_prob?: number | null; rrf?: number };
    signals?: string[];
  }[];
  quality?: { contentful_tokens: number; vague: boolean; signals: string[] };
  injected: string[];
  context_block_head?: string | null;
  prompt_text?: string | null;
  prompt_sha256?: string;
  tokens: number;
  ms: number;
};

const pct = (v: number | null | undefined) =>
  v == null ? "—" : (v as number).toFixed(2);

function Chip({ text, tone }: { text: string; tone: "ok" | "dim" | "warn" | "accent" }) {
  const colors: Record<string, { bg: string; fg: string }> = {
    ok: { bg: "rgba(74,222,128,0.12)", fg: "#4ade80" },
    dim: { bg: "rgba(255,255,255,0.06)", fg: "var(--nv-text-dim)" },
    warn: { bg: "rgba(248,113,113,0.12)", fg: "#f87171" },
    accent: { bg: "rgba(86,140,250,0.12)", fg: "var(--nv-accent, #568cfa)" },
  };
  const c = colors[tone] ?? colors.dim!;
  return (
    <span
      className="px-2 py-0.5 rounded-full text-[10px] font-semibold tracking-wide uppercase"
      style={{ background: c.bg, color: c.fg }}
    >
      {text}
    </span>
  );
}

/** Tiny horizontal bar for a 0..1 component — reads faster than digits. */
function Bar({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-2 text-[10px]" style={{ color: "var(--nv-text-dim)" }}>
      <span className="w-20 shrink-0 text-right">{label}</span>
      <div className="h-1.5 w-24 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.07)" }}>
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.round(value * 100)}%`, background: "var(--nv-accent, #568cfa)", opacity: 0.85 }}
        />
      </div>
      <span className="w-8 tabular-nums">{value.toFixed(2)}</span>
    </div>
  );
}

function ItemRow({ item }: { item: SectionItem }) {
  const [open, setOpen] = useState(false);
  const t = item.trace ?? undefined;
  const lifecycleTone =
    t?.lifecycle === "superseded" || t?.lifecycle === "rejected" || t?.lifecycle === "archived"
      ? "warn"
      : "dim";
  return (
    <div className="pl-3 border-l" style={{ borderColor: "var(--nv-border)" }}>
      <button
        className="flex items-center gap-2 w-full text-left py-0.5 hover:opacity-80"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="font-mono text-[11px]" style={{ color: "var(--nv-accent, #568cfa)" }}>
          [{item.id}]
        </span>
        {item.ce_prob != null && (
          <span className="text-[10px] tabular-nums" style={{ color: "var(--nv-text-dim)" }}>
            ce {pct(item.ce_prob)}
          </span>
        )}
        {item.salience != null && (
          <span className="text-[10px] tabular-nums" style={{ color: "var(--nv-text-dim)" }}>
            sal {pct(item.salience)}
          </span>
        )}
        {t?.lifecycle && <Chip text={t.lifecycle} tone={lifecycleTone} />}
        {t?.kind && <Chip text={t.kind} tone="dim" />}
        {t?.salience && (
          <span className="ml-auto text-[10px]" style={{ color: "var(--nv-text-dim)" }}>
            {open ? "▾" : "▸"} components
          </span>
        )}
      </button>
      {open && t?.salience && (
        <div className="py-1 space-y-0.5">
          <Bar label="recency" value={t.salience.recency} />
          <Bar label="usage" value={t.salience.usage} />
          <Bar label="importance" value={t.salience.importance} />
          <Bar label="confidence" value={t.salience.confidence} />
          <Bar label="reliability" value={t.salience.reliability} />
          <Bar label="links" value={t.salience.link_bonus} />
          <Bar label="TOTAL" value={t.salience.total} />
        </div>
      )}
    </div>
  );
}

function RecordCard({ r }: { r: LogRecord }) {
  const [open, setOpen] = useState(false);
  const time = r.ts?.replace("T", " ").slice(5, 19) ?? "?";
  return (
    <div
      className="rounded-xl p-3"
      style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)" }}
    >
      <button className="w-full flex items-center gap-2 text-left" onClick={() => setOpen((o) => !o)}>
        <Chip text={r.decision === "inject" ? "memories added" : "stayed quiet"} tone={r.decision === "inject" ? "ok" : "dim"} />
        {r.intent && <Chip text={intentLabel(r.intent)} tone="accent" />}
        <span className="text-xs truncate flex-1" style={{ color: "var(--nv-text)" }}>
          {decisionSentence(r.decision, r.reason, r.injected.length, r.tokens)}
        </span>
        <span className="text-[10px] tabular-nums shrink-0" style={{ color: "var(--nv-text-dim)" }}>
          {r.tokens > 0 ? `${r.tokens} tok · ` : ""}
          {r.ms}ms · {time}
        </span>
        <span className="text-[10px]" style={{ color: "var(--nv-text-dim)" }}>
          {open ? "▾" : "▸"}
        </span>
      </button>

      {open && (
        <div className="mt-3 space-y-3 text-xs" style={{ color: "var(--nv-text)" }}>
          <details className="text-[11px]" style={{ color: "var(--nv-text-dim)" }}>
            <summary className="cursor-pointer">Technical detail</summary>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              <span>decision: {r.reason}</span>
              <span>brain: {r.brain}</span>
              {r.host && <span>host: {r.host}</span>}
              {r.intent && <span>intent: {r.intent}</span>}
              {r.intent_confidence != null && <span>router confidence: {pct(r.intent_confidence)}</span>}
              {r.quality && (
                <span>
                  quality: {r.quality.contentful_tokens} token(s)
                  {r.quality.vague ? " · vague" : ""}
                  {r.quality.signals.length > 0 ? ` · ${r.quality.signals.join(", ")}` : ""}
                </span>
              )}
              {r.route_reason && <span>router: {r.route_reason}</span>}
            </div>
          </details>
          {r.prompt_text ? (
            <div className="text-[11px] italic" style={{ color: "var(--nv-text-dim)" }}>
              “{r.prompt_text}”
            </div>
          ) : (
            <div className="text-[10px] font-mono" style={{ color: "var(--nv-text-dim)", opacity: 0.6 }}>
              prompt sha256 {r.prompt_sha256?.slice(0, 16)}… (text logging off)
            </div>
          )}

          {/* Adaptive per-section trace */}
          {r.sections?.map((sec) => (
            <div key={sec.title}>
              <div className="text-[11px] font-semibold mb-1" style={{ color: "var(--nv-text)" }}>
                {sec.title}
                <span style={{ color: "var(--nv-text-dim)" }}>
                  {" "}
                  — {sec.items.length} injected, {sec.skipped.length} skipped
                </span>
              </div>
              <div className="space-y-1">
                {sec.items.map((it) => (
                  <ItemRow key={it.id} item={it} />
                ))}
                {sec.skipped.map(([what, why], i) => (
                  <div key={i} className="pl-3 text-[11px]" style={{ color: "var(--nv-text-dim)" }}>
                    <span className="font-mono">{what}</span> — skipped: {why}
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* Classic-pipeline candidates */}
          {!r.sections && r.candidates && r.candidates.length > 0 && (
            <div>
              <div className="text-[11px] font-semibold mb-1">Candidates (classic pipeline)</div>
              {r.candidates.map((c) => (
                <div key={c.engram_id} className="pl-3 text-[11px] flex gap-2" style={{ color: "var(--nv-text-dim)" }}>
                  <span className="font-mono" style={{ color: "var(--nv-accent, #568cfa)" }}>
                    [{c.engram_id.slice(0, 8)}]
                  </span>
                  <span>ce {pct(c.scores?.ce_prob)}</span>
                  <span className="truncate">{c.title}</span>
                  {r.injected.includes(c.engram_id) ? <Chip text="injected" tone="ok" /> : <Chip text="gated" tone="dim" />}
                </div>
              ))}
            </div>
          )}

          {r.context_block_head && (
            <pre
              className="text-[10px] leading-relaxed p-2 rounded-lg overflow-x-auto whitespace-pre-wrap"
              style={{ background: "rgba(0,0,0,0.25)", border: "1px solid var(--nv-border)", color: "var(--nv-text-dim)" }}
            >
              {r.context_block_head}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export default function MemoryInspector({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<"needs" | "approved" | "rejected" | "trace" | "learning">("needs");
  const [needsCount, setNeedsCount] = useState<number | null>(null);
  const [records, setRecords] = useState<LogRecord[]>([]);
  const [decision, setDecision] = useState<string>("");
  const [intent, setIntent] = useState<string>("");
  const [auto, setAuto] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadNeedsCount = useCallback(async () => {
    try {
      const r = await fetch(`${API_HOST}/api/proposals?decision=unreviewed&limit=200`, {
        signal: AbortSignal.timeout(4000),
      });
      const data = (await r.json()) as { count: number };
      setNeedsCount(data.count ?? 0);
    } catch {
      setNeedsCount(null);
    }
  }, []);
  useEffect(() => {
    loadNeedsCount();
    const t = setInterval(loadNeedsCount, 15000);
    return () => clearInterval(t);
  }, [loadNeedsCount]);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (decision) params.set("decision", decision);
      if (intent) params.set("intent", intent);
      const r = await fetch(`${API_HOST}/api/ambient_log?${params}`, {
        signal: AbortSignal.timeout(4000),
      });
      const data = await r.json();
      setRecords(data.records ?? []);
      setError(null);
    } catch {
      setError("Cannot reach the memory server — is NeuroVault running?");
    }
  }, [decision, intent]);

  useEffect(() => {
    load();
    if (!auto) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load, auto]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const intents = [
    "continue_work",
    "prepare_brief",
    "draft_output",
    "review_risks",
    "explain_decision",
    "find_source",
    "temporal_diff",
    "general_question",
  ];

  const selectStyle = {
    background: "var(--nv-surface)",
    border: "1px solid var(--nv-border)",
    color: "var(--nv-text)",
  } as const;

  // Portal to <body>: the Inspector is opened from inside the Settings
  // slide-over, whose ancestor chain forms a CSS containing block
  // (retained transform), so a plain `position: fixed` resolves against
  // the 420px panel instead of the viewport — the "Inspector opens at
  // sidebar size" glitch. A portal escapes ANY ancestor styling.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex flex-col"
      style={{ background: "var(--nv-bg, #111)" }}
      role="dialog"
      aria-label="Memory Inspector"
    >
      <div
        className="flex items-center gap-3 px-5 py-3 shrink-0"
        style={{ borderBottom: "1px solid var(--nv-border)" }}
      >
        <h1 className="text-sm font-semibold" style={{ color: "var(--nv-text)" }}>
          Memory Review
        </h1>
        <div className="flex items-center gap-1 ml-3">
          {(
            [
              ["needs", needsCount != null && needsCount > 0 ? `Needs review (${needsCount})` : "Needs review"],
              ["approved", "Approved"],
              ["rejected", "Rejected"],
              ["trace", "Activity"],
              ["learning", "Learning report"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className="text-[12px] px-3 py-1.5 rounded-md"
              style={{
                background: tab === id ? "rgba(86,140,250,0.12)" : "transparent",
                color: tab === id ? "var(--nv-accent, #568cfa)" : "var(--nv-text-dim)",
                border: `1px solid ${tab === id ? "rgba(86,140,250,0.3)" : "transparent"}`,
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="text-[12px] ml-2" style={{ color: "var(--nv-text-dim)" }}>
          {tab === "trace"
            ? "what NeuroVault added to your conversations, and why"
            : tab === "learning"
              ? "how well it's learning from you"
              : "review what NeuroVault thinks is worth remembering"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {tab === "trace" && (
            <>
              <select value={decision} onChange={(e) => setDecision(e.target.value)} className="text-[11px] rounded-md px-2 py-1" style={selectStyle}>
                <option value="">added & quiet</option>
                <option value="inject">memories added</option>
                <option value="silent">stayed quiet</option>
              </select>
              <select value={intent} onChange={(e) => setIntent(e.target.value)} className="text-[11px] rounded-md px-2 py-1" style={selectStyle}>
                <option value="">any activity</option>
                {intents.map((i) => (
                  <option key={i} value={i}>
                    {intentLabel(i)}
                  </option>
                ))}
              </select>
            </>
          )}
          {tab === "trace" && (
          <label className="flex items-center gap-1 text-[11px]" style={{ color: "var(--nv-text-dim)" }}>
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            auto-refresh
          </label>
          )}
          {tab === "trace" && (
          <button
            onClick={load}
            className="text-[11px] px-2.5 py-1 rounded-md hover:opacity-80"
            style={selectStyle}
          >
            Refresh
          </button>
          )}
          <button
            onClick={onClose}
            className="text-[11px] px-2.5 py-1 rounded-md hover:opacity-80"
            style={{ ...selectStyle, color: "var(--nv-accent, #568cfa)" }}
          >
            Close (Esc)
          </button>
        </div>
      </div>

      {tab === "needs" || tab === "approved" || tab === "rejected" ? (
        <MemoryReview key={tab} tab={tab} />
      ) : tab === "learning" ? (
        <LearningReport />
      ) : (
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-2">
        <p className="text-[11px] leading-relaxed max-w-2xl" style={{ color: "var(--nv-text-dim)" }}>
          {TRACE_EXPLAINER}
        </p>
        {error && (
          <div className="text-xs" style={{ color: "#f87171" }}>
            {error}
          </div>
        )}
        {!error && records.length === 0 && (
          <div className="text-xs" style={{ color: "var(--nv-text-dim)" }}>
            No ambient-recall events logged yet. Type a prompt in a hooked Claude Code session, or run{" "}
            <code>neurovault-server ambient test "your prompt"</code>.
          </div>
        )}
        {records.map((r) => (
          <RecordCard key={r.event_id} r={r} />
        ))}
      </div>
      )}
    </div>,
    document.body
  );
}
