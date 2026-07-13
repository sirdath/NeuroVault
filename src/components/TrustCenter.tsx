import { useCallback, useEffect, useMemo, useState } from "react";
import { activityApi, type ContextReceipt } from "../lib/api";
import { healthToneColor } from "../lib/consumerHealth";
import { useBrainStore } from "../stores/brainStore";
import { useConsumerHealthStore } from "../stores/consumerHealthStore";
import { useNoteStore } from "../stores/noteStore";

export function TrustCenter({
  onOpenActivity,
  onOpenTrash,
  onOpenSettings,
}: {
  onOpenActivity: () => void;
  onOpenTrash: () => void;
  onOpenSettings: () => void;
}) {
  const health = useConsumerHealthStore((state) => state.health);
  const signals = useConsumerHealthStore((state) => state.signals);
  const refreshing = useConsumerHealthStore((state) => state.refreshing);
  const refresh = useConsumerHealthStore((state) => state.refresh);
  const setAutomaticRecall = useConsumerHealthStore((state) => state.setAutomaticRecall);
  const vaultPath = useNoteStore((state) => state.vaultPath);
  const activeBrain = useBrainStore((state) => state.brains.find((brain) => brain.id === state.activeBrainId));
  const [receipts, setReceipts] = useState<ContextReceipt[]>([]);
  const [receiptsError, setReceiptsError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadReceipts = useCallback(async () => {
    setReceiptsError(false);
    try {
      setReceipts(await activityApi.contextReceipts(20));
    } catch {
      setReceipts([]);
      setReceiptsError(true);
    }
  }, []);

  useEffect(() => {
    void loadReceipts();
  }, [loadReceipts]);

  const shared = useMemo(() => receipts.filter((receipt) => receipt.decision === "inject"), [receipts]);
  const hosts = useMemo(() => Array.from(new Set(shared.map((receipt) => receipt.host).filter(Boolean))), [shared]);
  const automaticOn = signals.automaticRecall === "on";

  const toggleAutomatic = async () => {
    setBusy(true);
    setError(null);
    try {
      await setAutomaticRecall(!automaticOn);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex-1 overflow-y-auto" aria-labelledby="trust-heading">
      <div className="mx-auto max-w-5xl px-8 py-8">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--nv-accent)" }}>Privacy & Trust</p>
        <h1 id="trust-heading" className="mt-1 text-2xl font-semibold" style={{ color: "var(--nv-text)" }}>See and control the whole data flow</h1>
        <p className="mt-2 max-w-3xl text-[13px] leading-relaxed" style={{ color: "var(--nv-text-muted)" }}>
          Your vault and index stay on this Mac. NeuroVault shares selected context only with AI providers you connect. Every automatic context decision leaves a local receipt.
        </p>

        <section className="mt-7 grid gap-4 md:grid-cols-2" aria-label="Memory status and controls">
          <TrustCard title="Memory status" eyebrow="Is it working?">
            <div className="flex items-start gap-3">
              <span className="mt-1.5 h-2.5 w-2.5 rounded-full" style={{ background: healthToneColor(health.tone), boxShadow: `0 0 10px ${healthToneColor(health.tone)}` }} />
              <div>
                <p className="text-[14px] font-semibold" style={{ color: "var(--nv-text)" }}>{health.headline}</p>
                <p className="mt-1 text-[12px] leading-relaxed" style={{ color: "var(--nv-text-dim)" }}>{health.detail}</p>
              </div>
            </div>
            <button type="button" onClick={() => void refresh()} disabled={refreshing} className="mt-4 rounded-lg px-3 py-1.5 text-[11px] disabled:opacity-50" style={{ color: "var(--nv-accent)", border: "1px solid var(--nv-border)" }}>
              {refreshing ? "Checking…" : "Check again"}
            </button>
          </TrustCard>

          <TrustCard title="Automatic context" eyebrow="Control">
            <p className="text-[12px] leading-relaxed" style={{ color: "var(--nv-text-muted)" }}>
              {automaticOn
                ? "Claude Code can receive relevant memories before it answers. NeuroVault stays quiet when nothing is useful."
                : "Automatic context is paused. Your files and local search still work."}
            </p>
            <button
              type="button"
              onClick={() => void toggleAutomatic()}
              disabled={busy || signals.automaticRecall === "unavailable" || signals.automaticRecall === "checking"}
              className="mt-4 rounded-lg px-3 py-1.5 text-[11px] font-semibold disabled:opacity-45"
              style={{ color: automaticOn ? "#fbbf24" : "var(--nv-bg)", background: automaticOn ? "rgba(251,191,36,0.1)" : "var(--nv-accent)", border: automaticOn ? "1px solid rgba(251,191,36,0.28)" : "1px solid transparent" }}
            >
              {busy ? "Updating…" : automaticOn ? "Pause automatic context" : "Turn on automatic context"}
            </button>
            {error && <p className="mt-2 text-[11px]" style={{ color: "var(--nv-negative)" }} role="alert">{error}</p>}
          </TrustCard>
        </section>

        <section className="mt-4 grid gap-4 lg:grid-cols-3" aria-label="Observed stored and shared data">
          <TrustCard title="Observed" eyebrow="Inputs">
            <Fact label="Connection" value={automaticOn ? "Claude Code hooks active" : "No verified automatic observer"} />
            <Fact label="Prompt content" value="Hashed in ordinary receipts; not logged by default" />
            <Fact label="Boundaries" value={`Scoped to ${activeBrain?.name || "the active vault"}`} />
          </TrustCard>
          <TrustCard title="Stored" eyebrow="On this Mac">
            <Fact label="Markdown" value={vaultPath || activeBrain?.vault_path || "Select a vault to see its location"} breakAll />
            <Fact label="Index & journal" value="Local NeuroVault application data" />
            <Fact label="At rest" value="Plaintext unless your Mac volume is encrypted" />
            <p className="mt-3 text-[11px] leading-relaxed" style={{ color: "#fbbf24" }}>Turn on FileVault in macOS Settings to protect local data at rest.</p>
          </TrustCard>
          <TrustCard title="Shared" eyebrow="Outbound">
            <Fact label="Recent AI hosts" value={receiptsError ? "Could not load recent receipts" : hosts.length ? hosts.join(", ") : "No provider shown in recent receipts"} />
            <Fact label="Recent context deliveries" value={receiptsError ? "Unavailable until the local service reconnects" : `${shared.length} in the latest ${receipts.length} decisions`} />
            <Fact label="Updates" value="GitHub is contacted only by the update checker" />
            <div className="mt-3 flex items-center gap-3">
              <button type="button" onClick={onOpenActivity} className="text-[11px] font-medium" style={{ color: "var(--nv-accent)" }}>View context receipts →</button>
              {receiptsError && <button type="button" onClick={() => void loadReceipts()} className="text-[11px] underline" style={{ color: "var(--nv-text-muted)" }}>Try again</button>}
            </div>
          </TrustCard>
        </section>

        <section className="mt-4 rounded-2xl p-5" style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)" }}>
          <div className="flex flex-wrap items-center gap-5">
            <div className="min-w-[240px] flex-1">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--nv-text-dim)" }}>Ownership & recovery</p>
              <p className="mt-1 text-[13px]" style={{ color: "var(--nv-text)" }}>Notes remain ordinary Markdown. Deleted notes can be restored from NeuroVault Trash.</p>
            </div>
            <button type="button" onClick={onOpenTrash} className="rounded-lg px-3 py-2 text-[12px]" style={{ color: "var(--nv-text)", border: "1px solid var(--nv-border)" }}>Open Trash</button>
            <button type="button" onClick={onOpenSettings} className="rounded-lg px-3 py-2 text-[12px]" style={{ color: "var(--nv-accent)", border: "1px solid var(--nv-border)" }}>Backup, export & connections</button>
          </div>
        </section>
      </div>
    </main>
  );
}

function TrustCard({ title, eyebrow, children }: { title: string; eyebrow: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl p-5" style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)" }}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--nv-text-dim)" }}>{eyebrow}</p>
      <h2 className="mb-4 mt-1 text-[15px] font-semibold" style={{ color: "var(--nv-text)" }}>{title}</h2>
      {children}
    </div>
  );
}

function Fact({ label, value, breakAll = false }: { label: string; value: string; breakAll?: boolean }) {
  return (
    <div className="py-2" style={{ borderBottom: "1px solid var(--nv-border)" }}>
      <p className="text-[10px] uppercase tracking-wide" style={{ color: "var(--nv-text-dim)" }}>{label}</p>
      <p className={`mt-0.5 text-[11px] leading-relaxed ${breakAll ? "break-all" : ""}`} style={{ color: "var(--nv-text-muted)" }}>{value}</p>
    </div>
  );
}
