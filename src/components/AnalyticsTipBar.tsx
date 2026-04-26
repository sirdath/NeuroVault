import { useCallback, useEffect, useState } from "react";

/**
 * Single-line tip strip that appears under the graph toolbar when
 * Analytics mode is on. Two jobs:
 *
 *   1. First time a session sees Analytics enabled, show a one-line
 *      explanation of what's being visualised. Dismissable per-session
 *      so it doesn't pester repeat users.
 *   2. While hovering a node (or other graph element), swap to a
 *      contextual one-liner ("Core note · referenced from 18 places"
 *      etc). Caller passes `hoverText` from upstream hover state.
 *
 * After the user dismisses the idle tip, the bar stays mounted but
 * collapses when no `hoverText` is provided. So you still get the
 * per-hover info even after dismissing the explainer — the dismissal
 * only kills the always-on idle copy.
 *
 * "Learn more" opens a small modal (~200 words) explaining what's
 * being computed. Plain language; no math jargon. Modal is closed
 * by Esc / backdrop / "Got it".
 *
 * Per-session dismiss state lives in sessionStorage under
 * `nv.graph.tipBar.dismissed`. Reload = fresh session = bar shows
 * again on first analytics enable.
 */

const SESSION_DISMISS_KEY = "nv.graph.tipBar.dismissed";

const DEFAULT_IDLE_COPY =
  "Bigger nodes are more referenced. Background colours group notes that link to each other.";

interface AnalyticsTipBarProps {
  visible: boolean;
  /** Optional one-line copy shown while a graph element is hovered.
   *  Falls back to the idle explainer when absent. */
  hoverText?: string | null;
}

export function AnalyticsTipBar({ visible, hoverText }: AnalyticsTipBarProps) {
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(SESSION_DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [helpOpen, setHelpOpen] = useState(false);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      sessionStorage.setItem(SESSION_DISMISS_KEY, "1");
    } catch { /* private mode — fine, in-memory only */ }
  }, []);

  // Esc closes the help modal when it's open.
  useEffect(() => {
    if (!helpOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setHelpOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [helpOpen]);

  if (!visible) return null;

  // Decide what (if anything) to render in the strip itself.
  // - hoverText present → render it (overrides dismissal).
  // - hoverText absent + not dismissed → idle explainer.
  // - hoverText absent + dismissed → render nothing (collapsed).
  const text = hoverText ?? (dismissed ? null : DEFAULT_IDLE_COPY);
  const showLearnMore = !hoverText && !dismissed;

  return (
    <>
      {text != null && (
        <div
          className="absolute top-[60px] left-1/2 -translate-x-1/2 z-20 flex items-center gap-3 px-3 py-1.5 rounded-lg max-w-[640px] mx-auto"
          style={{
            background: "var(--nv-surface)",
            border: "1px solid var(--nv-border)",
            boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
            color: "var(--nv-text)",
          }}
          role="status"
          aria-live="polite"
        >
          <svg
            className="w-3.5 h-3.5 flex-shrink-0"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.75}
            style={{ color: "var(--nv-accent)" }}
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
          <span
            className="text-[12px] font-[Geist,sans-serif] leading-snug truncate"
            style={{ color: "var(--nv-text)" }}
          >
            {text}
          </span>
          {showLearnMore && (
            <>
              <button
                onClick={() => setHelpOpen(true)}
                className="text-[11px] font-[Geist,sans-serif] underline underline-offset-2 transition-colors flex-shrink-0"
                style={{ color: "var(--nv-text-muted)" }}
              >
                Learn more
              </button>
              <button
                onClick={dismiss}
                className="w-5 h-5 flex items-center justify-center rounded transition-colors flex-shrink-0 hover:[background-color:var(--nv-surface-elevated,var(--nv-surface))]"
                style={{ color: "var(--nv-text-muted)" }}
                aria-label="Dismiss tip"
                title="Dismiss for this session"
              >
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </>
          )}
        </div>
      )}

      {helpOpen && <AnalyticsHelpModal onClose={() => setHelpOpen(false)} />}
    </>
  );
}

/** In-app explainer for what Analytics mode is computing. Plain
 *  language — no math vocabulary. ~180 words. */
function AnalyticsHelpModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.55)" }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-[480px] max-w-[92vw] rounded-xl shadow-2xl p-6"
        style={{
          background: "var(--nv-surface)",
          border: "1px solid var(--nv-border)",
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="analytics-help-title"
      >
        <h2
          id="analytics-help-title"
          className="text-base font-semibold font-[Geist,sans-serif] mb-3"
          style={{ color: "var(--nv-text)" }}
        >
          What Analytics mode shows you
        </h2>
        <div
          className="text-[13px] leading-relaxed font-[Geist,sans-serif] space-y-3"
          style={{ color: "var(--nv-text)" }}
        >
          <p>
            <strong>Bigger nodes</strong> are notes that lots of other notes
            point to. They tend to be your core concepts — the ideas your
            brain orbits around.
          </p>
          <p>
            <strong>Background tints</strong> mark groups of notes that
            link to each other a lot. Notes that share a tint are usually
            on the same topic, even if they're in different folders.
          </p>
          <p style={{ color: "var(--nv-text-muted)" }}>
            All of this runs locally on your machine. Nothing is sent
            anywhere. The math (PageRank for sizing, Louvain for groups)
            recomputes only when your brain changes.
          </p>
        </div>
        <div className="flex justify-end mt-5">
          <button
            onClick={onClose}
            autoFocus
            className="px-4 py-1.5 text-[13px] font-medium font-[Geist,sans-serif] rounded-md transition-colors"
            style={{
              background: "var(--nv-accent)",
              color: "var(--nv-bg)",
              border: "1px solid transparent",
            }}
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
