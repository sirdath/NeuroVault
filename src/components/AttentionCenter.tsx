import { useState } from "react";
import MemoryReview, { LearningReport } from "./MemoryReview";

type AttentionTab = "needs" | "observations" | "approved" | "rejected" | "quality";

const TABS: Array<{ id: AttentionTab; label: string; help: string }> = [
  { id: "needs", label: "Needs attention", help: "Possible memory changes that require a decision" },
  { id: "observations", label: "Learning checks", help: "Optional accuracy checks that do not change data" },
  { id: "approved", label: "Accepted", help: "Decisions you accepted or corrected" },
  { id: "rejected", label: "Not accurate", help: "Decisions you rejected" },
  { id: "quality", label: "Quality", help: "Advanced evaluation and missed observations" },
];

export function AttentionCenter({ initialTab = "needs" }: { initialTab?: AttentionTab }) {
  const [tab, setTab] = useState<AttentionTab>(initialTab);
  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden" aria-labelledby="attention-heading">
      <header className="shrink-0 px-7 pb-4 pt-7" style={{ borderBottom: "1px solid var(--nv-border)" }}>
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--nv-accent)" }}>Human judgment</p>
        <div className="mt-1 flex items-end justify-between gap-6">
          <div>
            <h1 id="attention-heading" className="text-2xl font-semibold" style={{ color: "var(--nv-text)" }}>Needs attention</h1>
            <p className="mt-1 max-w-2xl text-[12px] leading-relaxed" style={{ color: "var(--nv-text-dim)" }}>
              NeuroVault stays automatic for ordinary recall. It asks only when an observation is ambiguous or a memory change needs your permission.
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
              onClick={() => setTab(item.id)}
              className="rounded-lg px-3 py-1.5 text-[11px] font-medium"
              style={{
                color: tab === item.id ? "var(--nv-accent)" : "var(--nv-text-dim)",
                background: tab === item.id ? "var(--nv-accent-glow)" : "transparent",
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      </header>
      <section className="flex min-h-0 flex-1" role="tabpanel">
        {tab === "quality" ? <LearningReport /> : <MemoryReview tab={tab} />}
      </section>
    </main>
  );
}
