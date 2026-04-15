import { useEffect } from "react";
import { useIntelligenceStore } from "../stores/intelligenceStore";

/**
 * IntelligenceView — visible home for the 2026 features that were
 * previously only reachable via MCP/HTTP. Six panels:
 *
 *   1. Brain Health  — feedback loop stats + variable stats
 *   2. Dead Code     — decay-weighted candidates for deletion
 *   3. Rename Detective — stale callsites of renamed symbols
 *   4. Hot Functions — most-called functions in the codebase
 *   5. Learned Shortcuts — Stage 4 query→engram affinities
 *   6. Recent Sessions — auto-captured Claude Code observations
 *
 * Every panel degrades gracefully to empty-state when its backing
 * endpoint returns nothing (fresh install, no code ingested yet).
 */
export function IntelligenceView() {
  const store = useIntelligenceStore();

  useEffect(() => {
    store.loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const {
    deadCode,
    staleRenames,
    hotFunctions,
    variableStats,
    sessions,
    feedbackStats,
    affinityStats,
    loading,
    error,
    lastLoaded,
    loadAll,
    reconcileAffinity,
  } = store;

  return (
    <div className="flex-1 overflow-y-auto bg-[#0b0b12]">
      <div className="max-w-[1400px] mx-auto px-8 py-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-[#f0a500] font-[Geist,sans-serif]">
              Brain Intelligence
            </h1>
            <p className="text-xs text-[#8a88a0] font-[Geist,sans-serif] mt-1">
              Code cognition &amp; self-improving retrieval
              {lastLoaded && (
                <span className="ml-2 text-[#35335a]">
                  · refreshed {new Date(lastLoaded).toLocaleTimeString()}
                </span>
              )}
            </p>
          </div>
          <button
            onClick={() => loadAll()}
            disabled={loading}
            className="px-3 py-1.5 text-xs font-[Geist,sans-serif] bg-[#1a1a28] hover:bg-[#1f1f2e] text-[#e8e6f0] rounded border border-[#1f1f2e] disabled:opacity-50"
          >
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>

        {error && (
          <div className="bg-[#2a1018] border border-[#ff6b6b]/30 text-[#ff6b6b] text-xs px-4 py-3 rounded font-[Geist,sans-serif]">
            {error}
          </div>
        )}

        {/* 2×3 responsive grid. Brain Health and Recent Sessions span both
             columns because they carry wide stats/lists; the other four
             sections sit side-by-side on screens wide enough (lg:). Below
             lg: the whole grid collapses to a single column automatically. */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="lg:col-span-2">
        {/* 1. Brain Health */}
        <Section
          title="Brain Health"
          subtitle="Self-improving retrieval loop stats (Stage 1 + Stage 4)"
        >
          <div className="grid grid-cols-4 gap-3">
            <Stat
              label="Retrievals (24h)"
              value={feedbackStats?.retrievals_last_24h ?? 0}
            />
            <Stat
              label="Hit Rate (7d)"
              value={
                feedbackStats
                  ? `${Math.round(feedbackStats.overall_hit_rate_7d * 100)}%`
                  : "—"
              }
            />
            <Stat
              label="Learned Shortcuts"
              value={affinityStats?.total_learned_shortcuts ?? 0}
            />
            <Stat
              label="Live Variables"
              value={variableStats?.live ?? 0}
            />
          </div>
          {variableStats && variableStats.removed > 0 && (
            <p className="text-[10px] text-[#8a88a0] font-[Geist,sans-serif] mt-3">
              {variableStats.removed} removed · {variableStats.renames_pending} rename candidates ·
              {Object.entries(variableStats.by_language)
                .slice(0, 3)
                .map(([l, c]) => ` ${c} ${l}`)
                .join(",")}
            </p>
          )}
        </Section>
          </div>

        {/* 2. Dead Code */}
        <Section
          title="Dead Code"
          subtitle="Decay + zero callers → likely safe to delete"
        >
          {deadCode.length === 0 ? (
            <EmptyState text="No dead code detected. Ingest a repo via /api/ingest-repo to populate this." />
          ) : (
            <div className="space-y-1">
              {deadCode.slice(0, 10).map((d) => (
                <Row
                  key={`${d.name}-${d.language}`}
                  left={
                    <>
                      <span className="text-[#e8e6f0] font-mono">{d.name}</span>
                      <span className="ml-2 text-[10px] text-[#8a88a0]">
                        {d.kind} · {d.language}
                      </span>
                    </>
                  }
                  right={
                    <>
                      <ConfidenceBar confidence={d.confidence} />
                      <span className="text-[10px] text-[#8a88a0] ml-3 min-w-[50px] text-right">
                        {d.caller_count} callers
                      </span>
                    </>
                  }
                />
              ))}
            </div>
          )}
        </Section>

        {/* 3. Rename Detective */}
        <Section
          title="Rename Detective"
          subtitle="Callsites still using the OLD name after a rename"
        >
          {staleRenames.length === 0 ? (
            <EmptyState text="No stale callsites. Either no renames detected yet, or every rename propagated cleanly." />
          ) : (
            <div className="space-y-1">
              {staleRenames.slice(0, 10).map((r, i) => (
                <Row
                  key={`${r.old_name}-${i}`}
                  left={
                    <>
                      <span className="font-mono text-[#ff6b6b] line-through">
                        {r.old_name}
                      </span>
                      <span className="mx-2 text-[#8a88a0]">→</span>
                      <span className="font-mono text-[#00c9b1]">{r.new_name}</span>
                    </>
                  }
                  right={
                    <span className="text-[10px] text-[#8a88a0]">
                      {r.language} · {r.kind ?? "—"}
                    </span>
                  }
                />
              ))}
            </div>
          )}
        </Section>

        {/* 4. Hot Functions */}
        <Section
          title="Hot Functions"
          subtitle="Most-called across the codebase — your de-facto API surface"
        >
          {hotFunctions.length === 0 ? (
            <EmptyState text="No call graph data. Ingest a repo to populate." />
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {hotFunctions.slice(0, 10).map((h) => (
                <div
                  key={`${h.name}-${h.language}`}
                  className="bg-[#1a1a28] rounded px-3 py-2 flex items-center justify-between"
                >
                  <span className="font-mono text-xs text-[#e8e6f0] truncate">
                    {h.name}
                  </span>
                  <span className="text-[10px] text-[#f0a500] font-[Geist,sans-serif] ml-2">
                    {h.call_count}×
                  </span>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* 5. Learned Shortcuts */}
        <Section
          title="Learned Shortcuts"
          subtitle="Stage 4: queries the brain learned to answer directly"
          action={
            <button
              onClick={() => reconcileAffinity()}
              className="text-[10px] font-[Geist,sans-serif] text-[#8a88a0] hover:text-[#f0a500] px-2 py-1 rounded hover:bg-[#1a1a28]"
            >
              reconcile
            </button>
          }
        >
          {!affinityStats || affinityStats.top_shortcuts.length === 0 ? (
            <EmptyState text="No learned shortcuts yet. They appear after the brain sees the same successful query multiple times." />
          ) : (
            <div className="space-y-1">
              {affinityStats.top_shortcuts.map((s, i) => (
                <Row
                  key={`${s.query}-${i}`}
                  left={
                    <>
                      <span className="text-[#e8e6f0]">{truncate(s.query, 50)}</span>
                      <span className="mx-2 text-[#8a88a0]">→</span>
                      <span className="text-[#00c9b1]">{truncate(s.engram_title, 40)}</span>
                    </>
                  }
                  right={
                    <span className="text-[10px] text-[#f0a500]">
                      {s.hit_count} hit{s.hit_count === 1 ? "" : "s"}
                    </span>
                  }
                />
              ))}
            </div>
          )}
        </Section>

        {/* 6. Recent Sessions */}
        <div className="lg:col-span-2">
        <Section
          title="Recent Sessions"
          subtitle="Auto-captured Claude Code sessions (via lifecycle hooks)"
        >
          {sessions.length === 0 ? (
            <EmptyState text="No sessions captured yet. Install hooks via `scripts/install_hooks.py` to auto-capture." />
          ) : (
            <div className="space-y-1">
              {sessions.slice(0, 10).map((s) => (
                <Row
                  key={s.session_id}
                  left={
                    <>
                      <span className="font-mono text-xs text-[#e8e6f0]">
                        {s.session_id}
                      </span>
                      <span className="ml-2 text-[10px] text-[#8a88a0]">
                        {s.event_count} events
                      </span>
                    </>
                  }
                  right={
                    <span className="text-[10px] text-[#8a88a0]">
                      {new Date(s.last_seen).toLocaleString()}
                    </span>
                  }
                />
              ))}
            </div>
          )}
        </Section>
        </div>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
  action,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="bg-[#12121c] border border-[#1f1f2e] rounded-lg px-5 py-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-sm font-semibold text-[#e8e6f0] font-[Geist,sans-serif]">
            {title}
          </h2>
          {subtitle && (
            <p className="text-[10px] text-[#8a88a0] font-[Geist,sans-serif] mt-0.5">
              {subtitle}
            </p>
          )}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="bg-[#1a1a28] rounded px-3 py-2">
      <p className="text-lg font-semibold text-[#e8e6f0] font-[Geist,sans-serif]">
        {value}
      </p>
      <p className="text-[10px] text-[#8a88a0] font-[Geist,sans-serif]">
        {label}
      </p>
    </div>
  );
}

function Row({
  left,
  right,
}: {
  left: React.ReactNode;
  right: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between bg-[#1a1a28] rounded px-3 py-2 text-xs font-[Geist,sans-serif]">
      <div className="flex items-center overflow-hidden min-w-0">{left}</div>
      <div className="flex items-center flex-shrink-0">{right}</div>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="text-[11px] text-[#35335a] font-[Geist,sans-serif] italic py-2">
      {text}
    </div>
  );
}

function ConfidenceBar({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  const color =
    confidence > 0.7 ? "#ff6b6b" : confidence > 0.4 ? "#f0a500" : "#00c9b1";
  return (
    <div className="flex items-center gap-2 w-[80px]">
      <div className="flex-1 h-1.5 bg-[#1f1f2e] rounded-full overflow-hidden">
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
      <span className="text-[10px] text-[#8a88a0] min-w-[24px] text-right">
        {pct}%
      </span>
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
