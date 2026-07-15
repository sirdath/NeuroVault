/**
 * Today is NeuroVault's compact memory pulse.
 *
 * It answers three useful questions without becoming a second settings page:
 * what did memory do today, is anything waiting for me, and is there a recent
 * thread genuinely worth resuming?
 */

import { useCallback, useEffect, useState } from "react";
import { API_HOST } from "../lib/config";
import { useBrainStore } from "../stores/brainStore";
import { useConsumerHealthStore } from "../stores/consumerHealthStore";

type Brief = {
  needs_review: number;
  needs_review_by_brain?: Record<string, number>;
  sessions_today: number;
  activity?: {
    context_added: number;
    context_quiet: number;
    memories_surfaced: number;
    notes_changed: number;
  };
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
  accent: "var(--nv-accent)",
  glow: "var(--nv-accent-glow)",
  surface: "var(--nv-surface)",
  elevated: "var(--nv-surface-elevated)",
  border: "var(--nv-border)",
};

const RECENT_CONTINUATION_MS = 72 * 60 * 60 * 1000;

function agoMs(ms: number): string {
  const seconds = Math.max(0, ms / 1000);
  if (seconds < 120) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 172800) return "yesterday";
  if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(Date.now() - ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function ageOfIso(iso?: string | null): number | null {
  if (!iso) return null;
  const timestamp = Date.parse(iso);
  return Number.isNaN(timestamp) ? null : Math.max(0, Date.now() - timestamp);
}

function agoIso(iso?: string | null): string {
  const age = ageOfIso(iso);
  return age === null ? "recently" : agoMs(age);
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return "Still awake";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function PulseCard({ label, value, detail, onClick }: {
  label: string;
  value: string;
  detail: string;
  onClick?: () => void;
}) {
  const className = "min-w-0 rounded-xl px-4 py-3 text-left";
  const style = { background: T.surface, border: `1px solid ${T.border}` };
  const content = (
    <>
      <p className="text-[10px] font-semibold uppercase tracking-[0.13em]" style={{ color: T.dim }}>{label}</p>
      <p className="mt-1 truncate text-[17px] font-semibold tracking-[-0.02em]" style={{ color: T.text }}>{value}</p>
      <p className="mt-0.5 truncate text-[11px]" style={{ color: T.dim }}>{detail}</p>
    </>
  );
  return onClick ? <button type="button" className={className} style={style} onClick={onClick}>{content}</button> : <div className={className} style={style}>{content}</div>;
}

export default function Home({
  onEnter,
  onOpenGraph,
  onOpenReview,
}: {
  onEnter: (filename?: string) => void;
  onOpenGraph: () => void;
  onOpenReview: () => void;
}) {
  const [brief, setBrief] = useState<Brief | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entering, setEntering] = useState<string | null>(null);
  const brains = useBrainStore((state) => state.brains);
  const brainsLoading = useBrainStore((state) => state.loading);
  const activeBrainId = useBrainStore((state) => state.activeBrainId);
  const activeBrainName = useBrainStore((state) => state.activeBrainName);
  const switchBrain = useBrainStore((state) => state.switchBrain);
  const healthSignals = useConsumerHealthStore((state) => state.signals);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${API_HOST}/api/home_brief`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`home brief ${response.status}`);
      setBrief((await response.json()) as Brief);
      setError(null);
    } catch {
      setBrief(null);
      setError("Today's memory pulse is temporarily unavailable.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const enter = useCallback(async (brainId: string, filename?: string) => {
    if (brainId === activeBrainId) {
      onEnter(filename);
      return;
    }
    setEntering(brainId);
    setError(null);
    try {
      const switched = await switchBrain(brainId);
      if (!switched) throw new Error("the current note could not be saved");
      onEnter(filename);
    } catch (reason) {
      setError(`Couldn't open that vault${reason instanceof Error ? `: ${reason.message}` : ""}. Your current vault is unchanged.`);
    } finally {
      setEntering(null);
    }
  }, [activeBrainId, onEnter, switchBrain]);

  const continuation = brief?.continue ?? null;
  const continuationAge = ageOfIso(continuation?.updated_at);
  const hasRecentContinuation = Boolean(
    continuation &&
    !continuation.stale &&
    (continuation.current_task || continuation.next_step) &&
    continuationAge !== null &&
    continuationAge <= RECENT_CONTINUATION_MS,
  );
  const recentChanges = brief?.since.slice(0, 3) ?? [];
  const activity = brief?.activity ?? { context_added: 0, context_quiet: 0, memories_surfaced: 0, notes_changed: 0 };
  const memoryCount = healthSignals.activeBrainId === activeBrainId ? healthSignals.memories : null;
  const memoryDetail = memoryCount === null ? "Local Markdown memory" : `${memoryCount.toLocaleString()} ${memoryCount === 1 ? "memory" : "memories"}`;
  const automaticDecisionCount = activity.context_added + activity.context_quiet;
  const activeReviewCount = activeBrainId
    ? (brief?.needs_review_by_brain?.[activeBrainId] ?? brief?.needs_review ?? 0)
    : 0;
  const contextDetail = automaticDecisionCount === 0
    ? "No prompts observed yet"
    : `${activity.context_quiet} ${activity.context_quiet === 1 ? "prompt" : "prompts"} needed no context`;
  const subtitle = brief
    ? `${brief.sessions_today} ${brief.sessions_today === 1 ? "session" : "sessions"} observed across your vaults today`
    : `${activeBrainName || "Your vault"} is ready.`;

  return (
    <main className="flex-1 overflow-y-auto" aria-labelledby="today-heading">
      <div className="mx-auto px-7 py-7" style={{ maxWidth: 1040 }}>
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: T.accent }}>Today</p>
            <h1 id="today-heading" className="mt-1 text-[30px] font-semibold tracking-[-0.035em]" style={{ color: T.text }}>{greeting()}</h1>
            <p className="mt-1 text-[13px]" style={{ color: T.dim }}>{subtitle}</p>
          </div>
          {brains.length > 0 && (
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => onEnter()} className="rounded-lg px-3.5 py-2 text-[12px] font-semibold" style={{ color: T.accent, background: T.glow, border: `1px solid color-mix(in srgb, ${T.accent} 32%, transparent)` }}>Open memories</button>
              <button type="button" onClick={onOpenGraph} className="rounded-lg px-3.5 py-2 text-[12px] font-medium" style={{ color: T.muted, border: `1px solid ${T.border}` }}>Explore graph</button>
            </div>
          )}
        </header>

        {error && (
          <div className="mb-5 flex items-center gap-3 rounded-xl px-4 py-3 text-[12px]" style={{ color: "var(--nv-negative)", background: "color-mix(in srgb, var(--nv-negative) 7%, transparent)", border: "1px solid color-mix(in srgb, var(--nv-negative) 20%, transparent)" }} role="status">
            <span>{error}</span>
            <button type="button" className="ml-auto font-semibold underline underline-offset-2" onClick={() => void load()}>Try again</button>
          </div>
        )}

        {!brainsLoading && brains.length === 0 && (
          <button type="button" onClick={() => window.dispatchEvent(new Event("nv:open-onboarding"))} className="mb-5 w-full rounded-2xl p-6 text-left" style={{ background: T.surface, border: `1px dashed ${T.accent}` }}>
            <div className="text-[15px] font-semibold" style={{ color: T.text }}>Create your first vault</div>
            <p className="mt-1 text-[12.5px]" style={{ color: T.dim }}>Choose a Markdown folder or start a private local library.</p>
          </button>
        )}

        {brains.length > 0 && (
          <>
            <section className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Memory today">
              <PulseCard label="Active vault" value={activeBrainName || "Local vault"} detail={memoryDetail} onClick={() => onEnter()} />
              <PulseCard label="Automatic context" value={activity.context_added === 0 ? "Quiet" : `${activity.context_added} ${activity.context_added === 1 ? "time" : "times"}`} detail={contextDetail} />
              <PulseCard label="Memories surfaced" value={activity.memories_surfaced.toLocaleString()} detail={`${activity.notes_changed} ${activity.notes_changed === 1 ? "memory change" : "memory changes"} observed`} />
              <PulseCard label="Review" value={activeReviewCount > 0 ? `${activeReviewCount} waiting` : "Up to date"} detail={`${activeBrainName || "Active vault"} review queue`} onClick={onOpenReview} />
            </section>

            <div className="grid gap-4 lg:grid-cols-5">
              <section className="rounded-2xl p-5 lg:col-span-3" style={{ background: T.surface, border: `1px solid ${hasRecentContinuation ? `color-mix(in srgb, ${T.accent} 50%, ${T.border})` : T.border}` }} aria-labelledby="continue-heading">
                {hasRecentContinuation && continuation ? (
                  <>
                    <p id="continue-heading" className="text-[10px] font-semibold uppercase tracking-[0.16em]" style={{ color: T.accent }}>Continue recent work</p>
                    <p className="mt-2 text-[12px]" style={{ color: T.dim }}>{continuation.brain_name} · {agoIso(continuation.updated_at)}</p>
                    {continuation.current_task && <h2 className="mt-2 text-[18px] font-semibold tracking-[-0.015em]" style={{ color: T.text }}>{continuation.current_task}</h2>}
                    {continuation.next_step && <p className="mt-1 text-[13.5px] leading-relaxed" style={{ color: T.muted }}>Next: {continuation.next_step}</p>}
                    <button type="button" onClick={() => void enter(continuation.brain, continuation.last_files?.find((filename) => filename.endsWith(".md")))} className="mt-4 rounded-lg px-4 py-2 text-[12px] font-semibold" style={{ color: "var(--nv-on-accent)", background: T.accent }} disabled={entering !== null}>{entering === continuation.brain ? "Opening…" : `Continue in ${continuation.brain_name}`}</button>
                  </>
                ) : (
                  <>
                    <p id="continue-heading" className="text-[10px] font-semibold uppercase tracking-[0.16em]" style={{ color: T.dim }}>Ready when you are</p>
                    <h2 className="mt-2 text-[18px] font-semibold tracking-[-0.015em]" style={{ color: T.text }}>No recent thread needs resuming</h2>
                    <p className="mt-1 max-w-xl text-[13px] leading-relaxed" style={{ color: T.dim }}>Older working-state snapshots stay out of the way. Open a memory or use the graph when you want to explore what NeuroVault has collected.</p>
                    <button type="button" onClick={() => onEnter()} className="mt-4 rounded-lg px-4 py-2 text-[12px] font-semibold" style={{ color: T.accent, background: T.glow }}>Open {activeBrainName || "Memories"}</button>
                  </>
                )}
              </section>

              <section className="rounded-2xl p-5 lg:col-span-2" style={{ background: T.elevated, border: `1px solid ${T.border}` }} aria-labelledby="memory-work-heading">
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em]" style={{ color: T.dim }}>Automatic memory</p>
                <h2 id="memory-work-heading" className="mt-2 text-[16px] font-semibold" style={{ color: T.text }}>How it helped today</h2>
                <div className="mt-3 space-y-2.5">
                  <ActivityRow label="Added relevant context" value={activity.context_added} />
                  <ActivityRow label="Stayed quiet" value={activity.context_quiet} />
                  <ActivityRow label="Memories surfaced" value={activity.memories_surfaced} />
                  <ActivityRow label="Notes added or updated" value={activity.notes_changed} />
                </div>
                <p className="mt-4 text-[11px] leading-relaxed" style={{ color: T.dim }}>Quiet is a valid result: NeuroVault should add context only when it is likely to help.</p>
              </section>
            </div>

            {recentChanges.length > 0 && (
              <section className="mt-5" aria-labelledby="since-heading">
                <div className="mb-2 flex items-center justify-between">
                  <h2 id="since-heading" className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: T.dim }}>Recent memory changes</h2>
                  <span className="text-[10px]" style={{ color: T.dim }}>Latest {recentChanges.length}</span>
                </div>
                <div className="overflow-hidden rounded-xl" style={{ background: T.elevated, border: `1px solid ${T.border}` }}>
                  {recentChanges.map((change, index) => (
                    <button type="button" key={`${change.brain}:${change.ts}:${index}`} onClick={() => void enter(change.brain)} disabled={entering !== null} className="flex w-full items-center gap-3 px-4 py-3 text-left" style={{ color: T.muted, borderBottom: index < recentChanges.length - 1 ? `1px solid ${T.border}` : undefined }}>
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: T.accent }} />
                      <span className="min-w-0 flex-1 text-[13px]">{change.text}</span>
                      <span className="shrink-0 text-[11px]" style={{ color: T.dim }}>{agoIso(change.ts)}</span>
                      <span aria-hidden="true" style={{ color: T.dim }}>→</span>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}

function ActivityRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between gap-4 text-[12px]">
      <span style={{ color: T.muted }}>{label}</span>
      <span className="tabular-nums font-semibold" style={{ color: value > 0 ? T.text : T.dim }}>{value.toLocaleString()}</span>
    </div>
  );
}
