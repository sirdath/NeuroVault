import { useState } from "react";
import MemoryReview, { LearningReport } from "./MemoryReview";

export type AttentionTab = "pending" | "history";

const TABS: Array<{ id: AttentionTab; label: string; help: string }> = [
  { id: "pending", label: "Pending", help: "Decisions and optional accuracy checks waiting for you" },
  { id: "history", label: "History", help: "Everything you have approved, corrected, or rejected" },
];

export function AttentionCenter({ initialTab = "pending" }: { initialTab?: AttentionTab }) {
  const [tab, setTab] = useState<AttentionTab>(initialTab);
  const [showQuality, setShowQuality] = useState(false);

  const selectTab = (next: AttentionTab) => {
    setTab(next);
    setShowQuality(false);
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden" aria-labelledby="attention-heading">
      <header className="shrink-0 px-7 pb-4 pt-7" style={{ borderBottom: "1px solid var(--nv-border)" }}>
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--nv-accent)" }}>Your judgment</p>
        <div className="mt-1 flex items-end justify-between gap-6">
          <div>
            <h1 id="attention-heading" className="text-2xl font-semibold tracking-[-0.025em]" style={{ color: "var(--nv-text)" }}>Review</h1>
            <p className="mt-1 max-w-2xl text-[12px] leading-relaxed" style={{ color: "var(--nv-text-dim)" }}>
              NeuroVault asks only when it needs permission or wants to check that an observation is accurate.
            </p>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap gap-1" role="tablist" aria-label="Memory review">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              title={item.help}
              onClick={() => selectTab(item.id)}
              className="rounded-lg px-3 py-1.5 text-[11px] font-medium"
              style={{
                color: tab === item.id ? "var(--nv-accent)" : "var(--nv-text-dim)",
                background: tab === item.id ? "var(--nv-accent-glow)" : "transparent",
              }}
            >
              {item.label}
            </button>
          ))}
          {tab === "history" && (
            <button
              type="button"
              onClick={() => setShowQuality((open) => !open)}
              className="ml-auto rounded-lg px-3 py-1.5 text-[11px] font-medium"
              style={{ color: showQuality ? "var(--nv-accent)" : "var(--nv-text-dim)", border: "1px solid var(--nv-border)" }}
            >
              {showQuality ? "Back to history" : "Quality report"}
            </button>
          )}
        </div>
      </header>
      <section className="flex min-h-0 flex-1" role="tabpanel">
        {showQuality ? <LearningReport /> : <MemoryReview tab={tab} />}
      </section>
    </main>
  );
}
