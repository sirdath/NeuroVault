/**
 * Today is a calm resumption page, not a second control centre.
 *
 * It owns two questions only: where was I, and what changed? Health, review,
 * context receipts, and vault management each have one canonical home
 * elsewhere in the app.
 */

import { useCallback, useEffect, useState } from "react";
import { API_HOST } from "../lib/config";
import { useBrainStore } from "../stores/brainStore";

type Brief = {
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
  accent: "var(--nv-accent)",
  glow: "var(--nv-accent-glow)",
  surface: "var(--nv-surface)",
  border: "var(--nv-border)",
};

function agoMs(ms: number): string {
  const seconds = Math.max(0, ms / 1000);
  if (seconds < 120) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 172800) return "yesterday";
  if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(Date.now() - ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function agoIso(iso?: string | null): string {
  if (!iso) return "recently";
  const timestamp = Date.parse(iso);
  return Number.isNaN(timestamp) ? "recently" : agoMs(Date.now() - timestamp);
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return "Still awake";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export default function Home({ onEnter }: { onEnter: (filename?: string) => void }) {
  const [brief, setBrief] = useState<Brief | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entering, setEntering] = useState<string | null>(null);
  const brains = useBrainStore((state) => state.brains);
  const brainsLoading = useBrainStore((state) => state.loading);
  const activeBrainId = useBrainStore((state) => state.activeBrainId);
  const switchBrain = useBrainStore((state) => state.switchBrain);

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
      setError("Today's briefing is temporarily unavailable.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const enter = useCallback(
    async (brainId: string, filename?: string) => {
      if (brainId === activeBrainId) {
        onEnter(filename);
        return;
      }

      setEntering(brainId);
      setError(null);
      try {
        await switchBrain(brainId);
        onEnter(filename);
      } catch (reason) {
        setError(
          `Couldn't open that vault${reason instanceof Error ? `: ${reason.message}` : ""}. Your current vault is unchanged.`,
        );
      } finally {
        setEntering(null);
      }
    },
    [activeBrainId, onEnter, switchBrain],
  );

  const continuation = brief?.continue ?? null;
  const recentChanges = brief?.since.slice(0, 3) ?? [];
  const hasContinuation = Boolean(continuation && (continuation.current_task || continuation.next_step));

  return (
    <main className="flex-1 overflow-y-auto" aria-labelledby="today-heading">
      <div className="mx-auto px-8 py-8" style={{ maxWidth: 980 }}>
        <header className="mb-7">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: T.accent }}>Today</p>
          <h1 id="today-heading" className="mt-1 text-[30px] font-semibold tracking-[-0.035em]" style={{ color: T.text }}>
            {greeting()}
          </h1>
          <p className="mt-1 text-[13px]" style={{ color: T.dim }}>
            {brief
              ? `${brief.sessions_today} ${brief.sessions_today === 1 ? "session" : "sessions"} observed today`
              : "Pick up where you left off."}
          </p>
        </header>

        {error && (
          <div
            className="mb-5 flex items-center gap-3 rounded-xl px-4 py-3 text-[12px]"
            style={{ color: "var(--nv-negative)", background: "color-mix(in srgb, var(--nv-negative) 7%, transparent)", border: "1px solid color-mix(in srgb, var(--nv-negative) 20%, transparent)" }}
            role="status"
          >
            <span>{error}</span>
            <button type="button" className="ml-auto font-semibold underline underline-offset-2" onClick={() => void load()}>
              Try again
            </button>
          </div>
        )}

        {!brainsLoading && brains.length === 0 && (
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event("nv:open-onboarding"))}
            className="mb-5 w-full rounded-2xl p-6 text-left"
            style={{ background: T.surface, border: `1px dashed ${T.accent}` }}
          >
            <div className="text-[15px] font-semibold" style={{ color: T.text }}>Create your first vault</div>
            <p className="mt-1 text-[12.5px]" style={{ color: T.dim }}>Choose a Markdown folder or start a private local library.</p>
          </button>
        )}

        {hasContinuation && continuation && (
          <section
            className="mb-6 rounded-2xl p-5"
            style={{ background: T.surface, border: `1px solid color-mix(in srgb, ${T.accent} 55%, ${T.border})`, boxShadow: `0 12px 30px -24px ${T.accent}` }}
            aria-labelledby="continue-heading"
          >
            <p id="continue-heading" className="text-[10px] font-semibold uppercase tracking-[0.16em]" style={{ color: T.accent }}>
              Continue where you left off
            </p>
            <p className="mt-2 text-[12px]" style={{ color: T.dim }}>
              {continuation.brain_name}{continuation.stale ? " · may be stale" : ""} · {agoIso(continuation.updated_at)}
            </p>
            {continuation.current_task && (
              <h2 className="mt-2 text-[18px] font-semibold tracking-[-0.015em]" style={{ color: T.text }}>
                {continuation.current_task}
              </h2>
            )}
            {continuation.next_step && (
              <p className="mt-1 text-[13.5px] leading-relaxed" style={{ color: T.muted }}>
                Next: {continuation.next_step}
              </p>
            )}
            <button
              type="button"
              onClick={() => void enter(continuation.brain, continuation.last_files?.find((filename) => filename.endsWith(".md")))}
              className="mt-4 rounded-lg px-4 py-2 text-[12px] font-semibold"
              style={{ color: "var(--nv-on-accent)", background: T.accent }}
              disabled={entering !== null}
            >
              {entering === continuation.brain ? "Opening…" : `Continue in ${continuation.brain_name}`}
            </button>
          </section>
        )}

        {recentChanges.length > 0 && (
          <section aria-labelledby="since-heading">
            <div className="mb-2 flex items-center justify-between">
              <h2 id="since-heading" className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: T.dim }}>
                Since you were away
              </h2>
              <span className="text-[10px]" style={{ color: T.dim }}>Latest {recentChanges.length}</span>
            </div>
            <div className="overflow-hidden rounded-xl" style={{ background: "var(--nv-surface-elevated)", border: `1px solid ${T.border}` }}>
              {recentChanges.map((change, index) => (
                <button
                  type="button"
                  key={`${change.brain}:${change.ts}:${index}`}
                  onClick={() => void enter(change.brain)}
                  disabled={entering !== null}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left"
                  style={{ color: T.muted, borderBottom: index < recentChanges.length - 1 ? `1px solid ${T.border}` : undefined }}
                >
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: T.accent }} />
                  <span className="min-w-0 flex-1 text-[13px]">{change.text}</span>
                  <span className="shrink-0 text-[11px]" style={{ color: T.dim }}>{agoIso(change.ts)}</span>
                  <span aria-hidden="true" style={{ color: T.dim }}>→</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {brains.length > 0 && !hasContinuation && recentChanges.length === 0 && !error && (
          <section className="rounded-2xl px-6 py-8 text-center" style={{ background: T.surface, border: `1px solid ${T.border}` }}>
            <h2 className="text-[16px] font-semibold" style={{ color: T.text }}>You're all caught up</h2>
            <p className="mt-1 text-[12.5px]" style={{ color: T.dim }}>There is nothing you need to manage here.</p>
            <button
              type="button"
              onClick={() => onEnter()}
              className="mt-4 rounded-lg px-4 py-2 text-[12px] font-semibold"
              style={{ color: T.accent, background: T.glow, border: `1px solid color-mix(in srgb, ${T.accent} 34%, transparent)` }}
            >
              Open Memories
            </button>
          </section>
        )}
      </div>
    </main>
  );
}
