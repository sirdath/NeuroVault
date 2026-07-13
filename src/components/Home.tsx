/**
 * Home — a living memory briefing, then vault navigation.
 *
 * Hierarchy (Dath, 2026-07-12): (1) is memory operating? (2) what
 * should I continue? (3) what changed? (4) does anything need
 * attention? (5) which vault do I explore? So the screen leads with a
 * status line + a "continue where you left off" hero + a "since you
 * were away" digest, and the brain gallery sits below.
 *
 * Data: GET /api/home_brief (one read-only call assembling the
 * briefing across vaults) + GET /api/brains for the grid + lazy
 * per-card open-task counts on hover. Cards use simple branded surfaces;
 * data-like graph decoration is reserved for views built from real notes.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { API_HOST } from "../lib/config";
import { useBrainStore } from "../stores/brainStore";
import { activityApi, type ContextReceipt } from "../lib/api";
import { healthToneColor } from "../lib/consumerHealth";
import { proposalNeedsAttention } from "../lib/inspectorCopy";
import { useConsumerHealthStore } from "../stores/consumerHealthStore";

type BrainStats = { note_count: number; total_bytes: number; last_modified_secs: number };
type BrainCard = { id: string; name: string; is_active: boolean; stats?: BrainStats };
type Brief = {
  needs_review: number;
  sessions_today: number;
  continue: null | {
    brain: string;
    brain_name: string;
    current_task?: string | null;
    next_step?: string | null;
    last_files?: string[];
    updated_at?: string | null;
    stale: boolean;
  };
  since: { brain: string; text: string; ts: string }[];
};

const T = {
  text: "var(--nv-text)",
  dim: "var(--nv-text-dim)",
  muted: "var(--nv-text-muted)",
  accent: "var(--nv-accent, #568cfa)",
  glow: "var(--nv-accent-glow, rgba(86,140,250,0.16))",
  surface: "var(--nv-surface)",
  border: "var(--nv-border)",
};

// ---- helpers --------------------------------------------------------------

const mb = (b?: number) =>
  b ? (b / 1e6 >= 1 ? `${(b / 1e6).toFixed(0)} MB` : `${(b / 1e3).toFixed(0)} KB`) : "—";
function agoMs(ms: number): string {
  const d = ms / 1000;
  if (d < 120) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 172800) return "yesterday";
  if (d < 2592000) return `${Math.floor(d / 86400)}d ago`;
  return new Date(Date.now() - ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
const agoSecs = (secs?: number) => (secs ? agoMs(Date.now() - secs * 1000) : "—");
function agoIso(iso?: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "—" : agoMs(Date.now() - t);
}
function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? "Still awake" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

// ---- per-card open-task count on hover ------------------------------------

function useOpenTasks(brainId: string | null) {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    if (!brainId) return;
    let alive = true;
    setN(null);
    (async () => {
      try {
        const r = await fetch(
          `${API_HOST}/api/todos?brain=${encodeURIComponent(brainId)}&status=open`,
          { signal: AbortSignal.timeout(4000) }
        );
        const rows = (await r.json()) as unknown[];
        if (alive) setN(Array.isArray(rows) ? rows.length : 0);
      } catch {
        if (alive) setN(0);
      }
    })();
    return () => {
      alive = false;
    };
  }, [brainId]);
  return n;
}

// ---- brain card -----------------------------------------------------------

function Card({ b, onEnter, entering }: { b: BrainCard; onEnter: (id: string, filename?: string) => void; entering: boolean }) {
  const [hover, setHover] = useState(false);
  const openTasks = useOpenTasks(hover ? b.id : null);
  const notes = b.stats?.note_count ?? 0;
  return (
    <button
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => onEnter(b.id)}
      className="relative text-left rounded-2xl overflow-hidden group transition-transform hover:-translate-y-0.5"
      style={{
        background: T.surface,
        border: `1px solid ${b.is_active ? "var(--nv-accent, #568cfa)" : T.border}`,
        boxShadow: hover ? `0 8px 30px -12px ${T.glow}` : "none",
        minHeight: 176,
      }}
    >
      <div className="absolute inset-x-0 top-0 h-20" style={{ background: "radial-gradient(circle at 20% 0%, var(--nv-accent-glow), transparent 68%)" }} />
      <div className="relative p-4 pt-16 flex flex-col h-full">
        <div className="flex items-baseline gap-2">
          <span className="text-[15px] font-semibold truncate" style={{ color: T.text }}>
            {b.name || b.id}
          </span>
          {b.is_active && (
            <span
              className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
              style={{ background: T.glow, color: T.accent }}
            >
              active
            </span>
          )}
        </div>
        <div className="text-[12px] mt-0.5" style={{ color: T.dim }}>
          {notes.toLocaleString()} {notes === 1 ? "memory" : "memories"} · {mb(b.stats?.total_bytes)} ·{" "}
          {agoSecs(b.stats?.last_modified_secs)}
        </div>
        <div className="mt-3 min-h-[20px] text-[11px]" style={{ color: T.dim }}>
          {entering ? (
            <span style={{ color: T.accent }}>Opening…</span>
          ) : hover ? (
            openTasks === null ? (
              "…"
            ) : openTasks > 0 ? (
              <span>
                {openTasks} open {openTasks === 1 ? "task" : "tasks"}
              </span>
            ) : (
              "no open tasks"
            )
          ) : (
            <span className="opacity-0 group-hover:opacity-100 transition-opacity">Open →</span>
          )}
        </div>
      </div>
    </button>
  );
}

// ---- the briefing + gallery ----------------------------------------------

type SortKey = "recent" | "largest" | "az";

export default function Home({
  onEnter,
  onOpenReview,
  onOpenActivity,
}: {
  onEnter: (filename?: string) => void;
  onOpenReview: (kind: "attention" | "learning") => void;
  onOpenActivity: () => void;
}) {
  const [brains, setBrains] = useState<BrainCard[] | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [reviewSummary, setReviewSummary] = useState({ attention: 0, learning: 0 });
  const [receipts, setReceipts] = useState<ContextReceipt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [entering, setEntering] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("recent");
  const switchBrain = useBrainStore((s) => s.switchBrain);
  const activeBrainId = useBrainStore((s) => s.activeBrainId);
  const health = useConsumerHealthStore((s) => s.health);
  const signals = useConsumerHealthStore((s) => s.signals);
  const refreshHealth = useConsumerHealthStore((s) => s.refresh);

  const load = useCallback(async () => {
    try {
      const [br, bf, proposalData, recentReceipts] = await Promise.all([
        fetch(`${API_HOST}/api/brains`, { signal: AbortSignal.timeout(6000) }).then((r) => {
          if (!r.ok) throw new Error(`brains ${r.status}`);
          return r.json();
        }),
        fetch(`${API_HOST}/api/home_brief`, { signal: AbortSignal.timeout(8000) })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
        fetch(`${API_HOST}/api/proposals?decision=unreviewed&limit=200`, {
          signal: AbortSignal.timeout(6000),
        })
          .then((r) => (r.ok ? r.json() : { proposals: [] }))
          .catch(() => ({ proposals: [] })),
        activityApi.contextReceipts(3).catch(() => []),
      ]);
      setBrains(Array.isArray(br) ? br : br.brains ?? []);
      setBrief(bf);
      const proposals = Array.isArray(proposalData?.proposals) ? proposalData.proposals : [];
      setReviewSummary({
        attention: proposals.filter((p: { action?: string }) => proposalNeedsAttention(p.action ?? "")).length,
        learning: proposals.filter((p: { action?: string }) => !proposalNeedsAttention(p.action ?? "")).length,
      });
      setReceipts(recentReceipts);
      setError(null);
    } catch {
      setError("Can't reach NeuroVault — is the app running?");
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    refreshHealth();
  }, [refreshHealth]);

  const enter = useCallback(
    async (id: string, filename?: string) => {
      if (id === activeBrainId) {
        onEnter(filename);
        return;
      }
      setEntering(id);
      setError(null);
      try {
        await switchBrain(id);
        onEnter(filename);
      } catch (e) {
        setError(
          `Couldn't open that vault${e instanceof Error ? `: ${e.message}` : ""}. You're still on your current one.`
        );
      } finally {
        setEntering(null);
      }
    },
    [activeBrainId, switchBrain, onEnter]
  );

  const sorted = useMemo(() => {
    const list = [...(brains ?? [])];
    if (sort === "largest") list.sort((a, b) => (b.stats?.note_count ?? 0) - (a.stats?.note_count ?? 0));
    else if (sort === "az") list.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
    else
      // recent: active first, then by last-modified (where the user is
      // likely to return — not the largest archive).
      list.sort((a, b) => {
        if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
        return (b.stats?.last_modified_secs ?? 0) - (a.stats?.last_modified_secs ?? 0);
      });
    return list;
  }, [brains, sort]);

  const totals = useMemo(
    () => ({
      vaults: brains?.length ?? 0,
      notes: (brains ?? []).reduce((s, b) => s + (b.stats?.note_count ?? 0), 0),
    }),
    [brains]
  );

  const cont = brief?.continue ?? null;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto px-8 py-9" style={{ maxWidth: 1040 }}>
        {/* 1. Is memory operating? One shared state machine, never a
            decorative always-green dot. */}
        <div className="mb-6 flex items-start gap-4">
          <div>
            <h1 className="text-[26px] font-semibold tracking-tight" style={{ color: T.text }}>
              {greeting()}
            </h1>
            <p className="text-[13.5px] mt-1 flex items-center gap-2" style={{ color: T.dim }}>
              <span
                className="inline-block w-1.5 h-1.5 rounded-full"
                style={{
                  background: healthToneColor(health.tone),
                  boxShadow: health.tone === "positive" ? `0 0 6px ${healthToneColor(health.tone)}` : undefined,
                }}
              />
              <span style={{ color: health.kind === "ready" ? T.muted : healthToneColor(health.tone) }}>
                {health.headline}
              </span>
              {brief && signals.service === "online"
                ? ` · ${brief.sessions_today} session${brief.sessions_today === 1 ? "" : "s"} observed today`
                : ""}
            </p>
            <p className="text-[11.5px] mt-1 ml-3.5" style={{ color: T.dim }}>
              {health.detail}
            </p>
          </div>
          {(health.action === "finish_setup" || health.action === "enable_automatic_memory") && (
            <button
              onClick={() => window.dispatchEvent(new Event("nv:open-onboarding"))}
              className="ml-auto px-3.5 py-2 rounded-lg text-[12px] font-semibold"
              style={{ color: T.accent, background: T.glow, border: `1px solid ${T.accent}` }}
            >
              {health.action === "finish_setup" ? "Finish setup" : "Enable automatic memory"}
            </button>
          )}
          {health.action === "retry" && (
            <button
              onClick={refreshHealth}
              className="ml-auto px-3.5 py-2 rounded-lg text-[12px]"
              style={{ color: T.text, border: `1px solid ${T.border}` }}
            >
              Check again
            </button>
          )}
        </div>

        {error && (
          <div className="text-[13px] mb-4" style={{ color: "#f87171" }}>
            {error}{" "}
            <button className="underline" onClick={load}>
              retry
            </button>
          </div>
        )}

        {/* 2. Needs attention is reserved for proposals that would execute
            a memory change. Accuracy-only labels are a separate, calm lane. */}
        {(reviewSummary.attention > 0 || reviewSummary.learning > 0) && (
          <div className="grid grid-cols-2 gap-3 mb-5">
            {reviewSummary.attention > 0 && (
              <button
                onClick={() => onOpenReview("attention")}
                className="rounded-xl px-4 py-3 text-left"
                style={{ background: "rgba(248,113,113,0.07)", border: "1px solid rgba(248,113,113,0.24)" }}
              >
                <div className="text-[11px] uppercase tracking-wider font-semibold" style={{ color: "var(--nv-negative)" }}>
                  Needs attention · {reviewSummary.attention}
                </div>
                <p className="text-[12.5px] mt-1" style={{ color: T.text }}>
                  NeuroVault wants to change memory. Nothing happens until you review it.
                </p>
              </button>
            )}
            {reviewSummary.learning > 0 && (
              <button
                onClick={() => onOpenReview("learning")}
                className="rounded-xl px-4 py-3 text-left"
                style={{ background: T.surface, border: `1px solid ${T.border}` }}
              >
                <div className="text-[11px] uppercase tracking-wider font-semibold" style={{ color: T.accent }}>
                  Help it learn · {reviewSummary.learning}
                </div>
                <p className="text-[12.5px] mt-1" style={{ color: T.muted }}>
                  Optional accuracy checks. Your answers improve the rule; they do not change memory.
                </p>
              </button>
            )}
          </div>
        )}

        {/* 3. What should I continue? */}
        {cont && (cont.current_task || cont.next_step) && (
          <div
            className="rounded-2xl p-6 mb-5"
            style={{ background: T.surface, border: `1px solid ${T.accent}`, boxShadow: `0 0 0 1px ${T.glow}` }}
          >
            <div className="text-[11px] font-semibold tracking-wider uppercase mb-2" style={{ color: T.accent }}>
              Continue where you left off
            </div>
            <div className="text-[13px] mb-0.5" style={{ color: T.dim }}>
              {cont.brain_name}
              {cont.stale ? " · may be stale" : ""} · last active {agoIso(cont.updated_at)}
            </div>
            {cont.current_task && (
              <div className="text-[17px] font-medium mb-1" style={{ color: T.text }}>
                {cont.current_task}
              </div>
            )}
            {cont.next_step && (
              <div className="text-[13.5px]" style={{ color: T.muted }}>
                Next: {cont.next_step}
              </div>
            )}
            <div className="mt-4">
              <button
                onClick={() => enter(cont.brain, cont.last_files?.find((filename) => filename.endsWith(".md")))}
                className="text-[13px] px-5 py-2 rounded-lg font-semibold hover:opacity-90"
                style={{ background: T.glow, color: T.accent, border: `1px solid ${T.accent}` }}
              >
                {entering === cont.brain ? "Opening…" : `Continue in ${cont.brain_name} →`}
              </button>
            </div>
          </div>
        )}

        {/* 4. What changed? */}
        {brief && brief.since.length > 0 && (
          <div className="mb-6">
            <div className="text-[11px] font-semibold tracking-wider uppercase mb-2" style={{ color: T.dim }}>
              Since you were away
            </div>
            <div className="space-y-1">
              {brief.since.map((s, i) => (
                <button
                  type="button"
                  key={`${s.brain}:${s.ts}:${i}`}
                  onClick={() => enter(s.brain)}
                  className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-[13px]"
                  style={{ color: T.muted }}
                  title="Open this vault"
                >
                  <span style={{ color: T.accent }}>·</span>
                  <span>{s.text}</span>
                  <span style={{ color: T.dim, opacity: 0.7 }}>· {agoIso(s.ts)}</span>
                  <span className="ml-auto" style={{ color: T.dim }}>Open →</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 5. What context did the AI use? */}
        {receipts.length > 0 && (
          <div className="mb-7">
            <div className="flex items-baseline mb-2">
              <div className="text-[11px] font-semibold tracking-wider uppercase" style={{ color: T.dim }}>
                Recent memory receipts
              </div>
              <button onClick={onOpenActivity} className="ml-auto text-[11px]" style={{ color: T.accent }}>
                View all activity →
              </button>
            </div>
            <div className="rounded-xl overflow-hidden" style={{ background: T.surface, border: `1px solid ${T.border}` }}>
              {receipts.map((receipt) => {
                const injected = receipt.decision === "inject";
                const titles = (receipt.candidates ?? [])
                  .filter((candidate) => receipt.injected.includes(candidate.engram_id))
                  .map((candidate) => candidate.title);
                return (
                  <button
                    key={receipt.event_id}
                    onClick={onOpenActivity}
                    className="w-full px-4 py-2.5 flex items-center gap-3 text-left"
                    style={{ borderBottom: "1px solid var(--nv-border)" }}
                  >
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: injected ? "var(--nv-positive)" : T.dim }} />
                    <span className="text-[12px]" style={{ color: T.text }}>
                      {injected
                        ? `Added ${receipt.injected.length} ${receipt.injected.length === 1 ? "memory" : "memories"} to the AI`
                        : "Stayed quiet — no context added"}
                    </span>
                    {titles.length > 0 && (
                      <span className="text-[11px] truncate" style={{ color: T.dim }}>{titles.join(" · ")}</span>
                    )}
                    <span className="text-[11px] ml-auto shrink-0" style={{ color: T.dim }}>{agoIso(receipt.ts)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* 6. Which vault? */}
        <div className="flex items-baseline mb-3">
          <div className="text-[13px] font-semibold" style={{ color: T.text }}>
            Your vaults
            <span className="font-normal ml-2" style={{ color: T.dim }}>
              {totals.vaults} · {totals.notes.toLocaleString()} memories
            </span>
          </div>
          <div className="ml-auto flex items-center gap-1 text-[12px]">
            {(["recent", "largest", "az"] as const).map((k) => (
              <button
                key={k}
                onClick={() => setSort(k)}
                className="px-2 py-0.5 rounded-md"
                style={{ color: sort === k ? T.accent : T.dim, background: sort === k ? T.glow : "transparent" }}
              >
                {k === "recent" ? "Recent" : k === "largest" ? "Largest" : "A–Z"}
              </button>
            ))}
          </div>
        </div>

        {brains === null && !error && (
          <div className="text-[13px]" style={{ color: T.dim }}>
            Loading your vaults…
          </div>
        )}

        {brains?.length === 0 && signals.service === "online" && (
          <button
            onClick={() => window.dispatchEvent(new Event("nv:open-onboarding"))}
            className="w-full rounded-2xl p-7 text-left"
            style={{ background: T.surface, border: `1px dashed ${T.accent}` }}
          >
            <div className="text-[15px] font-semibold" style={{ color: T.text }}>Create your first vault</div>
            <p className="text-[12.5px] mt-1" style={{ color: T.dim }}>Choose an existing Markdown folder or start a private local library.</p>
          </button>
        )}

        <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(228px, 1fr))" }}>
          {sorted.map((b) => (
            <Card key={b.id} b={b} onEnter={enter} entering={entering === b.id} />
          ))}
        </div>
      </div>
    </div>
  );
}
