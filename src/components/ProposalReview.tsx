/**
 * Proposal Review — consolidation stage 2's human side (adaptive spec).
 *
 * The bottleneck after proposal mode is trustworthy human labels, so
 * reviewing one proposal must take seconds: every proposed field with
 * its own evidence, the experience-unit timeline (intention → injected
 * context → outcome), the deterministic rule + confidence band, and
 * approve / edit / reject / mark-false-negative — one at a time,
 * deliberately NO bulk approval (bulk labels are weak labels).
 *
 * Review and application are independent axes: an approved proposal
 * may sit "pending" until its executor (or evidence) exists, and an
 * executor failure never rewrites the human verdict.
 */

import { useCallback, useEffect, useState } from "react";
import { API_HOST } from "../lib/config";
import {
  actionCopy,
  applicationLabel,
  bandLabel,
  eventSentence,
  reviewLabel,
  PROPOSALS_EXPLAINER,
} from "../lib/inspectorCopy";

type ProposedField = {
  name: string;
  proposed_value: string;
  approved_value?: string | null;
  evidence: string[];
};

type Proposal = {
  proposal_id: string;
  action: string;
  memory_type: string;
  object_id: string;
  title: string;
  reason: string;
  band: string;
  fields: ProposedField[];
  evidence: string[];
  review_status: "unreviewed" | "approved" | "edited" | "rejected";
  application_status: "not_applicable" | "pending" | "applied" | "failed";
  application_error?: string | null;
  proposed_at: string;
  decided_at?: string | null;
  decided_by?: string | null;
  decision_reason?: string | null;
  predecessor?: string | null;
};

type Metrics = {
  total: number;
  unreviewed: number;
  approved_untouched: number;
  approved_after_edits: number;
  rejected: number;
  app_pending: number;
  app_applied: number;
  app_failed: number;
  review_coverage: number;
  rejection_rate: number;
  field_edit_rate: number;
  audit_sample: string[];
  audited_false_negatives: number;
};

type JournalEvent = {
  event_id: string;
  ts: string;
  event_type: string;
  actor: string;
  title?: string | null;
  before?: string | null;
  after?: string | null;
  source_refs?: string[];
};

const chipTones: Record<string, { bg: string; fg: string }> = {
  ok: { bg: "rgba(74,222,128,0.12)", fg: "#4ade80" },
  dim: { bg: "rgba(255,255,255,0.06)", fg: "var(--nv-text-dim)" },
  warn: { bg: "rgba(248,113,113,0.12)", fg: "#f87171" },
  accent: { bg: "rgba(240,165,0,0.12)", fg: "var(--nv-accent, #f0a500)" },
  blue: { bg: "rgba(96,165,250,0.12)", fg: "#60a5fa" },
};

function Chip({ text, tone }: { text: string; tone: keyof typeof chipTones }) {
  const c = chipTones[tone] ?? chipTones.dim!;
  return (
    <span
      className="px-2 py-0.5 rounded-full text-[10px] font-semibold tracking-wide uppercase whitespace-nowrap"
      style={{ background: c.bg, color: c.fg }}
    >
      {text}
    </span>
  );
}

const reviewTone = (s: Proposal["review_status"]): keyof typeof chipTones =>
  s === "approved" || s === "edited" ? "ok" : s === "rejected" ? "warn" : "accent";
const appTone = (s: Proposal["application_status"]): keyof typeof chipTones =>
  s === "applied" ? "ok" : s === "failed" ? "warn" : s === "pending" ? "blue" : "dim";

/** Experience-unit timeline: the evidence events, oldest first. */
function Timeline({ evidence }: { evidence: string[] }) {
  const [events, setEvents] = useState<JournalEvent[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(
          `${API_HOST}/api/journal_events?ids=${encodeURIComponent(evidence.join(","))}`,
          { signal: AbortSignal.timeout(4000) }
        );
        const data = (await r.json()) as { events: JournalEvent[] };
        if (alive) setEvents(data.events ?? []);
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [evidence]);

  if (failed) return <div className="text-[11px]" style={{ color: "#f87171" }}>timeline unavailable</div>;
  if (!events) return <div className="text-[11px]" style={{ color: "var(--nv-text-dim)" }}>loading evidence…</div>;
  const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts));
  return (
    <div className="space-y-1">
      {sorted.map((e) => (
        <div key={e.event_id} className="flex items-start gap-2 text-[11px]">
          <span className="tabular-nums shrink-0" style={{ color: "var(--nv-text-dim)" }}>
            {e.ts.replace("T", " ").slice(5, 16)}
          </span>
          <span style={{ color: "var(--nv-text)" }}>{eventSentence(e)}</span>
        </div>
      ))}
      {sorted.length === 0 && (
        <div className="text-[11px]" style={{ color: "var(--nv-text-dim)" }}>
          evidence events outside the 60-day timeline window
        </div>
      )}
    </div>
  );
}

function ProposalCard({ p, onChanged }: { p: Proposal; onChanged: () => void }) {
  const [open, setOpen] = useState(p.review_status === "unreviewed");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [rejectReason, setRejectReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = useCallback(
    async (approve: boolean) => {
      setBusy(true);
      setError(null);
      try {
        const path = approve ? "approve" : "reject";
        const body: Record<string, unknown> = { reviewer: "user" };
        if (approve && Object.keys(edits).length > 0) body.edits = edits;
        if (!approve && rejectReason.trim()) body.reason = rejectReason.trim();
        const r = await fetch(`${API_HOST}/api/proposals/${p.proposal_id}/${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(6000),
        });
        if (!r.ok) throw new Error(await r.text());
        onChanged();
      } catch (e) {
        setError(e instanceof Error ? e.message : "request failed");
      } finally {
        setBusy(false);
        setRejecting(false);
      }
    },
    [p.proposal_id, edits, rejectReason, onChanged]
  );

  const unreviewed = p.review_status === "unreviewed";
  const age = p.proposed_at.replace("T", " ").slice(5, 16);
  const copy = actionCopy(p.action);

  return (
    <div
      className="rounded-xl p-3"
      style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)" }}
    >
      <button className="w-full flex items-center gap-2 text-left" onClick={() => setOpen((o) => !o)}>
        <Chip text={reviewLabel(p.review_status)} tone={reviewTone(p.review_status)} />
        <span className="text-xs truncate flex-1 font-medium" style={{ color: "var(--nv-text)" }}>
          {copy.headline}
        </span>
        <Chip text={bandLabel(p.band)} tone={p.band === "high" ? "ok" : p.band === "medium" ? "accent" : "dim"} />
        <span className="text-[10px] tabular-nums shrink-0" style={{ color: "var(--nv-text-dim)" }}>
          {age}
        </span>
        <span className="text-[10px]" style={{ color: "var(--nv-text-dim)" }}>
          {open ? "▾" : "▸"}
        </span>
      </button>

      {open && (
        <div className="mt-3 space-y-3 text-xs" style={{ color: "var(--nv-text)" }}>
          <p className="text-[12px] leading-relaxed" style={{ color: "var(--nv-text)" }}>
            {copy.meaning}
          </p>
          <div className="flex items-center gap-2">
            <Chip text={applicationLabel(p.application_status)} tone={appTone(p.application_status)} />
            <span className="text-[11px]" style={{ color: "var(--nv-text-dim)" }}>
              {copy.ifApproved}
            </span>
          </div>
          {p.predecessor && (
            <div className="text-[11px]" style={{ color: "var(--nv-text-dim)" }}>
              You rejected a similar suggestion before — this one exists because NEW evidence appeared.
            </div>
          )}
          {p.application_error && (
            <div className="text-[11px]" style={{ color: "#f87171" }}>
              NeuroVault couldn't apply this ({p.application_error}) — your decision still counts.
            </div>
          )}

          {/* Fields — each with its own evidence and optional edit */}
          <div className="space-y-2">
            <div className="text-[11px] font-semibold" style={{ color: "var(--nv-text)" }}>
              What it wants to record
            </div>
            {p.fields.map((f) => (
              <div key={f.name} className="pl-3 border-l" style={{ borderColor: "var(--nv-border)" }}>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px]" style={{ color: "var(--nv-accent, #f0a500)" }}>
                    {f.name}
                  </span>
                  <span className="text-[11px]" style={{ color: "var(--nv-text-dim)" }}>
                    proposed:
                  </span>
                  <span className="text-[11px] truncate">{f.proposed_value}</span>
                  {f.approved_value != null && (
                    <>
                      <span className="text-[11px]" style={{ color: "var(--nv-text-dim)" }}>
                        approved:
                      </span>
                      <span className="text-[11px] truncate" style={{ color: "#4ade80" }}>
                        {f.approved_value}
                      </span>
                    </>
                  )}
                  <span className="ml-auto font-mono text-[10px]" style={{ color: "var(--nv-text-dim)", opacity: 0.6 }}>
                    {f.evidence.map((e) => e.slice(0, 8)).join(" ")}
                  </span>
                </div>
                {unreviewed && (
                  <input
                    className="mt-1 w-full text-[11px] rounded-md px-2 py-1"
                    style={{
                      background: "rgba(0,0,0,0.25)",
                      border: "1px solid var(--nv-border)",
                      color: "var(--nv-text)",
                    }}
                    placeholder={`edit ${f.name} before approving (optional)`}
                    value={edits[f.name] ?? ""}
                    onChange={(e) =>
                      setEdits((prev) => {
                        const next = { ...prev };
                        if (e.target.value) next[f.name] = e.target.value;
                        else delete next[f.name];
                        return next;
                      })
                    }
                  />
                )}
              </div>
            ))}
          </div>

          {/* Experience-unit timeline */}
          <div>
            <div className="text-[11px] font-semibold mb-1">What happened (the evidence)</div>
            <Timeline evidence={p.evidence} />
          </div>

          {/* Technical detail, collapsed by default */}
          <details className="text-[11px]" style={{ color: "var(--nv-text-dim)" }}>
            <summary className="cursor-pointer">Technical detail</summary>
            <div className="mt-1 space-y-0.5 font-mono text-[10px]">
              <div>action: {p.action}</div>
              <div>rule: {p.reason}</div>
              <div>proposal: {p.proposal_id}</div>
              <div>object: {p.object_id}</div>
              {p.predecessor && <div>predecessor: {p.predecessor}</div>}
            </div>
          </details>

          {error && (
            <div className="text-[11px]" style={{ color: "#f87171" }}>
              {error}
            </div>
          )}

          {unreviewed && !rejecting && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[12px] font-medium" style={{ color: "var(--nv-text)" }}>
                {copy.question}
              </span>
              <button
                disabled={busy}
                onClick={() => decide(true)}
                className="text-[11px] px-3 py-1 rounded-md font-semibold hover:opacity-80 disabled:opacity-40"
                style={{ background: "rgba(74,222,128,0.15)", color: "#4ade80", border: "1px solid rgba(74,222,128,0.3)" }}
              >
                {Object.keys(edits).length > 0 ? "Yes, with my corrections" : "Yes, that's right"}
              </button>
              <button
                disabled={busy}
                onClick={() => setRejecting(true)}
                className="text-[11px] px-3 py-1 rounded-md font-semibold hover:opacity-80 disabled:opacity-40"
                style={{ background: "rgba(248,113,113,0.12)", color: "#f87171", border: "1px solid rgba(248,113,113,0.3)" }}
              >
                No, that's wrong…
              </button>
            </div>
          )}
          {unreviewed && rejecting && (
            <div className="flex items-center gap-2">
              <input
                autoFocus
                className="flex-1 text-[11px] rounded-md px-2 py-1"
                style={{ background: "rgba(0,0,0,0.25)", border: "1px solid var(--nv-border)", color: "var(--nv-text)" }}
                placeholder="what makes it wrong? (teaches NeuroVault what to avoid)"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
              />
              <button
                disabled={busy}
                onClick={() => decide(false)}
                className="text-[11px] px-3 py-1 rounded-md font-semibold"
                style={{ background: "rgba(248,113,113,0.12)", color: "#f87171" }}
              >
                Confirm reject
              </button>
              <button className="text-[11px]" style={{ color: "var(--nv-text-dim)" }} onClick={() => setRejecting(false)}>
                cancel
              </button>
            </div>
          )}
          {!unreviewed && (
            <div className="text-[11px]" style={{ color: "var(--nv-text-dim)" }}>
              {p.review_status} by {p.decided_by ?? "?"} at {p.decided_at?.replace("T", " ").slice(0, 19)}
              {p.decision_reason ? ` — “${p.decision_reason}”` : ""}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function ProposalReview() {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [statusFilter, setStatusFilter] = useState("unreviewed");
  const [actionFilter, setActionFilter] = useState("");
  const [bandFilter, setBandFilter] = useState("");
  const [fnText, setFnText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: "200" });
      if (statusFilter) params.set("decision", statusFilter);
      const [pr, mr] = await Promise.all([
        fetch(`${API_HOST}/api/proposals?${params}`, { signal: AbortSignal.timeout(4000) }),
        fetch(`${API_HOST}/api/consolidation_metrics`, { signal: AbortSignal.timeout(4000) }),
      ]);
      const pd = (await pr.json()) as { proposals: Proposal[] };
      setProposals(pd.proposals ?? []);
      setMetrics((await mr.json()) as Metrics);
      setError(null);
    } catch {
      setError("Cannot reach the memory server — is NeuroVault running?");
    }
  }, [statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const runConsolidation = useCallback(async () => {
    setNote("consolidating…");
    try {
      const r = await fetch(`${API_HOST}/api/consolidate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "proposal" }),
        signal: AbortSignal.timeout(60000),
      });
      const data = (await r.json()) as { proposals: unknown[]; events_read: number };
      setNote(`consolidated: ${data.events_read} events read, ${data.proposals.length} new proposal(s)`);
      load();
    } catch {
      setNote("consolidation failed — is the server running?");
    }
  }, [load]);

  const markFalseNegative = useCallback(async () => {
    if (fnText.trim().length < 4) return;
    try {
      await fetch(`${API_HOST}/api/consolidation_false_negative`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: fnText.trim(), reviewer: "user" }),
        signal: AbortSignal.timeout(4000),
      });
      setFnText("");
      setNote("false negative recorded — it counts against precision-by-silence");
      load();
    } catch {
      setNote("failed to record false negative");
    }
  }, [fnText, load]);

  const visible = proposals.filter(
    (p) => (!actionFilter || p.action === actionFilter) && (!bandFilter || p.band === bandFilter)
  );
  const actions = Array.from(new Set(proposals.map((p) => p.action)));

  const selectStyle = {
    background: "var(--nv-surface)",
    border: "1px solid var(--nv-border)",
    color: "var(--nv-text)",
  } as const;

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Queue */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-2">
        <p className="text-[11px] leading-relaxed max-w-2xl" style={{ color: "var(--nv-text-dim)" }}>
          {PROPOSALS_EXPLAINER}
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="text-[11px] rounded-md px-2 py-1" style={selectStyle}>
            <option value="unreviewed">waiting for you</option>
            <option value="">everything</option>
            <option value="approved">you said yes</option>
            <option value="edited">you corrected</option>
            <option value="rejected">you said no</option>
          </select>
          <select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)} className="text-[11px] rounded-md px-2 py-1" style={selectStyle}>
            <option value="">all actions</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {a.replace(/_/g, " ")}
              </option>
            ))}
          </select>
          <select value={bandFilter} onChange={(e) => setBandFilter(e.target.value)} className="text-[11px] rounded-md px-2 py-1" style={selectStyle}>
            <option value="">all bands</option>
            <option value="high">high</option>
            <option value="medium">medium</option>
            <option value="low">low</option>
          </select>
          <button onClick={runConsolidation} className="text-[11px] px-2.5 py-1 rounded-md hover:opacity-80" style={selectStyle}>
            Check for new suggestions
          </button>
          <button onClick={load} className="text-[11px] px-2.5 py-1 rounded-md hover:opacity-80" style={selectStyle}>
            Refresh
          </button>
        </div>

        {note && (
          <div className="text-[11px]" style={{ color: "var(--nv-accent, #f0a500)" }}>
            {note}
          </div>
        )}
        {error && (
          <div className="text-xs" style={{ color: "#f87171" }}>
            {error}
          </div>
        )}
        {!error && visible.length === 0 && (
          <div className="text-xs" style={{ color: "var(--nv-text-dim)" }}>
            Nothing here right now. Press “Check for new suggestions” and NeuroVault will look through recent activity.
          </div>
        )}
        {visible.map((p) => (
          <ProposalCard key={p.proposal_id} p={p} onChanged={load} />
        ))}
      </div>

      {/* Metrics rail */}
      <div
        className="w-64 shrink-0 overflow-y-auto px-4 py-4 space-y-3 text-[11px]"
        style={{ borderLeft: "1px solid var(--nv-border)", color: "var(--nv-text-dim)" }}
      >
        <div className="font-semibold text-xs" style={{ color: "var(--nv-text)" }}>
          Your reviewing, at a glance
        </div>
        {metrics ? (
          <>
            <div className="space-y-1">
              <div>
                waiting for you: <b style={{ color: "var(--nv-accent, #f0a500)" }}>{metrics.unreviewed}</b> of {metrics.total}
              </div>
              <div>reviewed so far: {(metrics.review_coverage * 100).toFixed(0)}%</div>
              <div>“yes” as-is: {metrics.approved_untouched}</div>
              <div>“yes” after your corrections: {metrics.approved_after_edits}</div>
              <div>“no”: {metrics.rejected}</div>
            </div>
            <div className="space-y-1">
              <div className="font-semibold" style={{ color: "var(--nv-text)" }}>
                What actually changed
              </div>
              <div>changes applied: {metrics.app_applied}</div>
              <div>approved but changes nothing yet: {metrics.app_pending}</div>
              <div>couldn't apply: {metrics.app_failed}</div>
            </div>
            <div className="space-y-1">
              <div className="font-semibold" style={{ color: "var(--nv-text)" }}>
                Keeping it honest
              </div>
              <div>things it missed (you reported): {metrics.audited_false_negatives}</div>
            </div>
          </>
        ) : (
          <div>loading…</div>
        )}
        <div className="space-y-1 pt-2" style={{ borderTop: "1px solid var(--nv-border)" }}>
          <div className="font-semibold" style={{ color: "var(--nv-text)" }}>
            Did NeuroVault miss something it should have noticed?
          </div>
          <textarea
            className="w-full text-[11px] rounded-md px-2 py-1 h-16 resize-none"
            style={{ background: "rgba(0,0,0,0.25)", border: "1px solid var(--nv-border)", color: "var(--nv-text)" }}
            placeholder="e.g. “I made a big decision today and it never suggested saving it”"
            value={fnText}
            onChange={(e) => setFnText(e.target.value)}
          />
          <button
            onClick={markFalseNegative}
            disabled={fnText.trim().length < 4}
            className="text-[11px] px-2.5 py-1 rounded-md hover:opacity-80 disabled:opacity-40"
            style={selectStyle}
          >
            Report a miss
          </button>
        </div>
      </div>
    </div>
  );
}
