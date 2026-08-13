/**
 * Local Memory Curator — the consent surface.
 *
 * Once a night, while the app is open, a model running on the user's own
 * machine reads the Claude Code turns they consented to capture and proposes
 * memories. A deterministic Rust gauntlet verifies every one of them, and the
 * survivors land in Memory Review. Nothing is written without a human verdict,
 * and nothing leaves the machine.
 *
 * That is a lot of power to hand a background job, so this panel exists to say
 * so in plain words and to make stopping it trivial:
 *
 *  - Everything defaults OFF. The master switch is a real kill switch: off
 *    means no run is scheduled and no transcript is ever opened.
 *  - The two consent switches are shown separately, because they mean two
 *    different things (keep evidence / act on it) and the user should be able
 *    to grant one without the other.
 *  - The model picker lists ONLY models already installed in the user's
 *    Ollama. There is deliberately no download button anywhere in this file:
 *    NeuroVault never pulls multiple gigabytes on someone's behalf. If the
 *    configured model is missing we say so and hand the decision back.
 *  - Costs are stated, not buried: RAM while resident, fans, battery.
 *
 * The server owns `~/.neurovault/local_curator.json`; this panel edits it only
 * through the loopback endpoint (same shape as /api/consolidation_auto).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { API_HOST } from "../lib/config";
import { relativeTime } from "../lib/inspectorCopy";
import { useBrainStore } from "../stores/brainStore";
import { toast } from "../stores/toastStore";

// ---------------------------------------------------------------------------
// Contract — GET/PUT /api/local_curator, GET /api/curator/runs
//
// Mirrors `curator/provider.rs::{LocalCuratorFile, ProviderConfig}` and
// `curator/state.rs::CuratorRunAudit`. Everything the Rust side may or may not
// send yet is optional here, and the panel degrades to a static explanation
// rather than blanking out — a consent surface that disappears when a field is
// missing is worse than one that admits it does not know.
// ---------------------------------------------------------------------------

export type CuratorProviderConfig = {
  endpoint: string;
  model: string;
  model_digest?: string | null;
  num_ctx?: number;
  num_predict?: number;
  keep_alive?: string;
  max_units_per_run?: number;
  run_wall_clock_mins?: number;
};

/** One entry of the user's `ollama list` — surfaced by the backend, never
 *  fetched from the browser, and never accompanied by a "download" affordance. */
export type CuratorInstalledModel = {
  name: string;
  size_bytes?: number | null;
  digest?: string | null;
  parameter_size?: string | null;
};

/** Preflight's verdict, carrying `ProviderError::user_hint()` verbatim. */
export type CuratorProviderStatus = {
  ok?: boolean;
  code?: string | null;
  hint?: string | null;
};

/** `schedule::TickDecision`, snake_cased. */
export type CuratorTickDecision =
  | "run"
  | "consent_off"
  | "provider_not_configured"
  | "not_due"
  | "outside_quiet_hours"
  | "busy";

export type CuratorSchedule = {
  interval_hours?: number | null;
  check_interval_secs?: number | null;
  startup_delay_secs?: number | null;
  last_run?: string | null;
  next_run_at?: string | null;
  decision?: CuratorTickDecision | string | null;
};

export type LocalCuratorConfig = {
  brain?: string;
  enabled: boolean;
  transcript_access: boolean;
  /** Both switches, as the curator's own consent loader reads them. */
  consent_granted?: boolean;
  provider?: CuratorProviderConfig | null;
  provider_configured?: boolean;
  installed_models?: CuratorInstalledModel[] | null;
  provider_status?: CuratorProviderStatus | null;
  schedule?: CuratorSchedule | null;
  platform_supported?: boolean | null;
};

/** `runner::CuratorRunReport` — what POST /api/curator/run answers with. */
export type CuratorRunReport = {
  run_id: string;
  status?: string;
  units_processed?: number;
  units_deferred?: number;
  proposals_created?: number;
  candidates_rejected?: number;
  notes?: string[];
};

const SCHEDULE_DECISION: Record<string, string> = {
  run: "Ready — it will run at the next check.",
  consent_off: "It won't run: both switches above have to be on.",
  provider_not_configured: "It won't run: no usable local model is configured yet.",
  not_due: "It ran recently, so tonight's run is already accounted for.",
  outside_quiet_hours: "Waiting for its quiet window before it spends your battery.",
  busy: "A run is in flight right now.",
};

export type CuratorRunOutcome = {
  outcome: string;
  proposal_id?: string | null;
};

/** One line of `curator_runs.jsonl` (`CuratorRunAudit`) — one unit's outcome. */
export type CuratorRunAuditLine = {
  run_id: string;
  brain_id?: string;
  unit_id?: string;
  unit_status?: string;
  outcomes?: CuratorRunOutcome[] | null;
  no_proposal_reason?: string | null;
  started_at?: string;
  ts: string;
  duration_ms?: number;
};

export type CuratorRunSummary = {
  run_id: string | null;
  ts: string | null;
  units_seen: number;
  proposals: number;
  deferred: number;
};

export type CuratorRunsResponse = {
  runs?: CuratorRunAuditLine[] | null;
  summary?: CuratorRunSummary | null;
};

const DEFAULT_ENDPOINT = "http://127.0.0.1:11434";
const PROPOSAL_OUTCOMES = new Set(["proposal_ready", "review_required"]);

/** Fold the newest run's audit lines into the one sentence a human wants.
 *
 *  Audit lines are per-unit, one run writes many, and the file is append-only
 *  — so "the last run" is every line sharing the newest line's `run_id`.
 *  Exported because this arithmetic is the whole summary, and it deserves a
 *  test that does not go through the DOM. */
export function summarizeCuratorRuns(runs: CuratorRunAuditLine[]): CuratorRunSummary | null {
  if (runs.length === 0) return null;
  const sorted = [...runs].sort((a, b) => (b.ts ?? "").localeCompare(a.ts ?? ""));
  const newest = sorted[0];
  if (!newest) return null;
  const lines = sorted.filter((r) => r.run_id === newest.run_id);
  let proposals = 0;
  let deferred = 0;
  for (const line of lines) {
    for (const outcome of line.outcomes ?? []) {
      if (PROPOSAL_OUTCOMES.has(outcome.outcome)) proposals += 1;
    }
    if (line.unit_status === "deferred") deferred += 1;
  }
  return {
    run_id: newest.run_id,
    ts: newest.ts ?? null,
    units_seen: lines.length,
    proposals,
    deferred,
  };
}

const formatSize = (bytes?: number | null): string | null => {
  if (!bytes || bytes <= 0) return null;
  const gb = bytes / 1_000_000_000;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1_000_000)} MB`;
};

/** Mirrors `ProviderError::ModelNotInstalled::user_hint()`. Used only when the
 *  backend hasn't sent its own hint — the wording must stay a prompt to the
 *  user, never a promise of a download. */
export const modelNotInstalledHint = (model: string): string =>
  `The model ${model} is not installed. Install it yourself with Ollama — the curator will not pull it for you.`;

// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-10">
      <h2
        className="text-[11px] uppercase tracking-wider font-semibold font-[Geist,sans-serif] mb-4"
        style={{ color: "var(--nv-text-dim)" }}
      >
        {title}
      </h2>
      <div
        className="rounded-2xl p-5 space-y-5"
        style={{
          background: "var(--nv-surface-elevated)",
          border: "1px solid var(--nv-border)",
          boxShadow: "0 1px 2px color-mix(in srgb, var(--nv-text) 4%, transparent)",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function ConsentSwitch({
  label,
  description,
  checked,
  disabled,
  onToggle,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-[13px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>
          {label}
        </p>
        <p
          className="text-[11px] leading-relaxed font-[Geist,sans-serif] mt-0.5"
          style={{ color: "var(--nv-text-dim)" }}
        >
          {description}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-label={label}
        aria-checked={checked}
        disabled={disabled}
        onClick={onToggle}
        className="relative h-6 w-11 rounded-full transition-colors shrink-0 disabled:opacity-40"
        style={{ background: checked ? "var(--nv-accent)" : "var(--nv-border)" }}
      >
        <span
          className="absolute top-1 h-4 w-4 rounded-full transition-transform"
          style={{
            left: 4,
            background: checked ? "var(--nv-bg)" : "var(--nv-text-muted)",
            transform: checked ? "translateX(20px)" : "translateX(0)",
          }}
        />
      </button>
    </div>
  );
}

export function CuratorSettings() {
  const activeBrainId = useBrainStore((s) => s.activeBrainId);
  const [cfg, setCfg] = useState<LocalCuratorConfig | null>(null);
  const [modelDraft, setModelDraft] = useState("");
  const [offline, setOffline] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<CuratorRunSummary | null>(null);

  const loadRuns = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (activeBrainId) params.set("brain_id", activeBrainId);
      const r = await fetch(`${API_HOST}/api/curator/runs?${params}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) return;
      const j = (await r.json()) as CuratorRunsResponse;
      setSummary(j.summary ?? summarizeCuratorRuns(j.runs ?? []));
    } catch {
      /* the run ledger is a nicety; its absence must not hide the switches */
    }
  }, [activeBrainId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${API_HOST}/api/local_curator`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as LocalCuratorConfig;
        if (cancelled) return;
        setCfg(j);
        setModelDraft(j.provider?.model ?? "");
        setOffline(false);
      } catch {
        if (!cancelled) setOffline(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  const save = useCallback(
    async (next: LocalCuratorConfig) => {
      if (saving) return;
      setSaving(true);
      setError(null);
      const previous = cfg;
      setCfg(next);
      try {
        // Only the three fields this panel owns. `provider` is omitted
        // rather than sent as null when we have none: a consent toggle must
        // never be able to erase a provider block the user configured by
        // hand in `local_curator.json`.
        const body: Record<string, unknown> = {
          enabled: next.enabled,
          transcript_access: next.transcript_access,
        };
        if (next.provider) body.provider = next.provider;
        const r = await fetch(`${API_HOST}/api/local_curator`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `HTTP ${r.status}`);
        }
        const j = (await r.json()) as LocalCuratorConfig;
        setCfg(j);
        setModelDraft(j.provider?.model ?? next.provider?.model ?? "");
      } catch (e) {
        setCfg(previous);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    },
    [cfg, saving],
  );

  const runNow = useCallback(async () => {
    if (running) return;
    setRunning(true);
    try {
      // The endpoint is detached: it answers 202 with a run_id immediately
      // and the run continues server-side. Completion is observed by polling
      // /api/curator/runs until the in-flight marker clears.
      const r = await fetch(`${API_HOST}/api/curator/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brain_id: activeBrainId }),
      });
      if (r.status === 409) {
        toast.warning("A curator run is already in flight — its results will land in Memory Review.");
        setRunning(false);
        return;
      }
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string; hint?: string };
        toast.error(j.hint ?? j.error ?? `The run couldn't start (HTTP ${r.status}).`);
        setRunning(false);
        return;
      }
      const started = (await r.json().catch(() => ({}))) as { run_id?: string };
      toast.success(
        "Curator run started — proposals will land in Memory Review as they pass the gates.",
      );
      // Poll until the backend reports no run in flight (or this one's id is
      // gone), then refresh the last-run summary. Bounded: give up polling
      // after 60 ticks (~30 min) and just leave the summary stale — the run
      // itself is unaffected.
      for (let tick = 0; tick < 60; tick += 1) {
        await new Promise((resolve) => setTimeout(resolve, 30_000));
        try {
          const s = await fetch(
            `${API_HOST}/api/curator/runs?brain_id=${encodeURIComponent(activeBrainId ?? "")}`,
          );
          if (!s.ok) continue;
          const j = (await s.json().catch(() => ({}))) as {
            running?: boolean;
            in_flight?: { run_id?: string } | null;
          };
          const stillThisRun =
            j.running === true &&
            (started.run_id === undefined || j.in_flight?.run_id === started.run_id);
          if (!stillThisRun) break;
        } catch {
          // transient poll failure: keep waiting, the run is server-side
        }
      }
      await loadRuns();
    } catch {
      toast.error("Couldn't reach NeuroVault to start the run.");
    } finally {
      setRunning(false);
    }
  }, [activeBrainId, running, loadRuns]);

  const enabled = cfg?.enabled ?? false;
  const transcriptAccess = cfg?.transcript_access ?? false;
  const provider = cfg?.provider ?? null;
  const installed = useMemo(() => cfg?.installed_models ?? [], [cfg]);
  /** Does the backend list installed models at all in this build? An absent
   *  list and an empty list mean different things and must read differently. */
  const knowsInstalled = Array.isArray(cfg?.installed_models);
  const configuredModel = provider?.model?.trim() ?? "";
  const modelInstalled =
    configuredModel.length > 0 && installed.some((m) => m.name === configuredModel);
  const status = cfg?.provider_status ?? null;
  const unsupported = cfg?.platform_supported === false;
  const lastRunAt = cfg?.schedule?.last_run ?? null;
  const decision = cfg?.schedule?.decision
    ? SCHEDULE_DECISION[String(cfg.schedule.decision)] ?? null
    : null;

  const consentLine = !enabled
    ? "The curator is off. Nothing is scheduled, and no transcript is opened."
    : !transcriptAccess
      ? "Curation is on, but evidence capture is off — so there is nothing verifiable to read, and the curator stays silent."
      : "Both switches are on. The curator may run tonight while the app is open.";

  // "Not installed" is only claimed when it is actually known: either the
  // backend said so, or it listed the installed models and this one isn't
  // among them. An unlisted-because-unlistable model must not be slandered.
  const modelMissing =
    configuredModel.length > 0 &&
    (status?.code === "model_not_installed" || (installed.length > 0 && !modelInstalled));
  const modelHint = !configuredModel
    ? "No model is configured yet. Pick one of the models you already have installed."
    : modelMissing
      ? (status?.hint ?? modelNotInstalledHint(configuredModel))
      : null;

  const setModel = (name: string) => {
    if (!cfg) return;
    setModelDraft(name);
    void save({
      ...cfg,
      provider: { ...(provider ?? { endpoint: DEFAULT_ENDPOINT }), model: name },
    });
  };

  return (
    <Section title="Local memory curator">
      <p
        className="text-[12px] leading-relaxed font-[Geist,sans-serif]"
        style={{ color: "var(--nv-text-muted)" }}
      >
        Off by default. When you turn it on, once a night — while the app is open — a model running
        on this Mac reads the Claude Code turns you allowed NeuroVault to keep evidence for, and
        proposes memories. Every proposal is then checked against your transcript word by word, and
        the survivors wait for you in Memory Review. Nothing is written without your yes, and no
        text leaves this machine.
      </p>
      <p
        className="text-[12px] leading-relaxed font-[Geist,sans-serif]"
        style={{ color: "var(--nv-text-muted)" }}
      >
        It costs real hardware while it runs: a 12B-class model holds roughly 8&nbsp;GB of RAM (a
        30B one closer to 20&nbsp;GB), your fans will notice, and a laptop on battery will notice
        too. The model is unloaded when the run finishes. NeuroVault never downloads a model for
        you — you install what you want to run, and the curator uses only that.
      </p>

      {unsupported && (
        <p className="text-[12px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
          This build can't run the curator on your platform yet — transcript reads are macOS and
          Linux only for now.
        </p>
      )}

      {offline && (
        <p className="text-[12px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
          NeuroVault isn't answering, so the curator's switches can't be read. Nothing runs while
          the app is offline.
        </p>
      )}

      <ConsentSwitch
        label="Curate my sessions"
        description="The kill switch. Off means no nightly run is scheduled, no transcript is opened, and no proposal is ever made. On means the curator may run — and every result still waits for your review."
        checked={enabled}
        disabled={!cfg || saving}
        onToggle={() => cfg && void save({ ...cfg, enabled: !cfg.enabled })}
      />
      <ConsentSwitch
        label="Keep evidence from my sessions"
        description="When a Claude Code turn finishes, NeuroVault records where its transcript lives and hashes the bytes it saw — never the text itself. That hash is what lets it prove, later, that a proposed memory really came from your own words."
        checked={transcriptAccess}
        disabled={!cfg || saving}
        onToggle={() => cfg && void save({ ...cfg, transcript_access: !cfg.transcript_access })}
      />
      <p className="text-[12px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
        {consentLine}
      </p>

      {/* ---- model ---- */}
      <div className="space-y-2">
        <p className="text-[13px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>
          Model
        </p>
        <div className="flex items-center gap-2">
          <input
            aria-label="Model tag"
            value={modelDraft}
            disabled={!cfg || saving}
            onChange={(e) => setModelDraft(e.target.value)}
            placeholder="qwen3:30b-a3b-instruct-2507-q4_K_M"
            className="flex-1 text-[12px] font-mono rounded-lg px-3 py-2 disabled:opacity-40"
            style={{
              background: "var(--nv-bg)",
              border: "1px solid var(--nv-border)",
              color: "var(--nv-text)",
            }}
          />
          <button
            type="button"
            disabled={!cfg || saving || modelDraft.trim() === configuredModel}
            onClick={() => setModel(modelDraft.trim())}
            className="text-[12px] font-medium font-[Geist,sans-serif] px-3 py-2 rounded-lg disabled:opacity-40"
            style={{ border: "1px solid var(--nv-border)", color: "var(--nv-text-muted)" }}
          >
            Use this model
          </button>
        </div>
        <p className="text-[11px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
          Talks to your own Ollama at{" "}
          <span className="font-mono">{provider?.endpoint ?? DEFAULT_ENDPOINT}</span> — a loopback
          address only, never a remote host.
        </p>
        <div className="space-y-1">
          <p className="text-[11px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
            Installed models
          </p>
          {installed.length === 0 ? (
            <p className="text-[11px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
              {knowsInstalled
                ? "No installed models found. NeuroVault lists what Ollama already has; it does not download anything."
                : "NeuroVault can't list your installed models here yet — type the exact tag of one you already have. It will never download one for you."}
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {installed.map((m) => {
                const selected = m.name === configuredModel;
                const size = formatSize(m.size_bytes);
                return (
                  <button
                    key={m.name}
                    type="button"
                    aria-pressed={selected}
                    disabled={!cfg || saving}
                    onClick={() => setModel(m.name)}
                    className="text-[11px] font-mono px-2.5 py-1.5 rounded-lg disabled:opacity-40"
                    style={{
                      background: selected ? "var(--nv-surface)" : "var(--nv-bg)",
                      border: selected ? "1px solid var(--nv-accent)" : "1px solid var(--nv-border)",
                      color: "var(--nv-text-muted)",
                    }}
                  >
                    {m.name}
                    {size ? ` · ${size}` : ""}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {modelHint && (
          <p className="text-[11px] font-[Geist,sans-serif]" style={{ color: "var(--nv-negative, #ef4444)" }}>
            {modelHint}
          </p>
        )}
      </div>

      {/* ---- schedule + run now ---- */}
      <div className="space-y-2">
        <p className="text-[13px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>
          Schedule
        </p>
        <p className="text-[11px] leading-relaxed font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
          Runs at most once every {cfg?.schedule?.interval_hours ?? 24} hours, and only while
          NeuroVault is open — it is not a background daemon and never wakes your Mac. It curates
          the active vault only.
          {lastRunAt ? ` Last run ${relativeTime(lastRunAt)}.` : " It hasn't run on this vault yet."}
          {decision ? ` ${decision}` : ""}
        </p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void runNow()}
            disabled={running || !enabled || !transcriptAccess}
            className="text-[12px] font-medium font-[Geist,sans-serif] px-3 py-2 rounded-lg disabled:opacity-40"
            style={{ border: "1px solid var(--nv-border)", color: "var(--nv-text-muted)" }}
          >
            {running ? "Running…" : "Run now"}
          </button>
          {!enabled || !transcriptAccess ? (
            <span className="text-[11px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
              Both switches must be on before a run can start.
            </span>
          ) : (
            <span className="text-[11px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
              {running
                ? "Reading one turn at a time — a full run takes minutes, and you can close this panel."
                : "Runs immediately instead of waiting for tonight. It still only proposes."}
            </span>
          )}
        </div>
      </div>

      {/* ---- last run ---- */}
      <div className="space-y-1">
        <p className="text-[13px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>
          Last run
        </p>
        {summary ? (
          <>
            <p className="text-[11px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
              {summary.ts ? `${relativeTime(summary.ts)} · ` : ""}
              {summary.units_seen} turn{summary.units_seen === 1 ? "" : "s"} seen ·{" "}
              {summary.proposals} proposed · {summary.deferred} deferred
            </p>
            <p className="text-[11px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
              {summary.proposals === 0
                ? "Nothing is waiting in Memory Review — a quiet night is the normal result."
                : `${summary.proposals} proposal${summary.proposals === 1 ? "" : "s"} waiting in Memory Review.`}
            </p>
          </>
        ) : (
          <p className="text-[11px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
            The curator hasn't run yet.
          </p>
        )}
      </div>

      {error && (
        <p className="text-[11px] font-[Geist,sans-serif]" style={{ color: "var(--nv-negative, #ef4444)" }}>
          Couldn't save: {error}
        </p>
      )}
    </Section>
  );
}
