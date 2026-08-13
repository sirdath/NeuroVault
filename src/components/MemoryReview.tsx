/**
 * Memory Review — NeuroVault's trust ceremony.
 *
 * One question, asked calmly: "Should NeuroVault remember this?"
 * One focused proposal at a time (an inbox, not a dashboard), the
 * human decision first, implementation detail strictly on demand.
 * No bulk approval — an inspected label is the product.
 *
 * Backend semantics untouched: same endpoints, same immutable review
 * events, same evidence. This file is presentation only.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_HOST } from "../lib/config";
import {
  actionCopy,
  curatorClassLabel,
  curatorCodeLabel,
  curatorGateLabel,
  curatorGateTag,
  curatorOutcomeLabel,
  curatorRoleLabel,
  curatorPreviewUnavailable,
  CURATOR_EVIDENCE_LOADING,
  CURATOR_G10_NOT_RUN_NOTE,
  CURATOR_GATE_ORDER,
  CURATOR_SPAN_DIGEST_DRIFT,
  eventSentence,
  fieldLabel,
  memoryTypeLabel,
  proposalNeedsAttention,
  projectFromEvents,
  relativeTime,
  REJECT_REASONS,
} from "../lib/inspectorCopy";
import { useBrainStore } from "../stores/brainStore";

// ---------------------------------------------------------------------------
// Types (mirror the API; unchanged)
// ---------------------------------------------------------------------------

export type ProposedField = {
  name: string;
  proposed_value: string;
  approved_value?: string | null;
  evidence: string[];
};

// ---- Local Memory Curator receipts ----------------------------------------
// Mirrors `MEM/adaptive/curator/receipts.rs` field for field. The extension
// is additive and optional on the SHARED proposal store — the curator does
// not fork it — so every field below is only ever read, never required.
// `span_identities()` / `source_roles()` are Rust-side projections of
// `primary` + `context`; the UI derives the same thing from those two.

export type CuratorSourceRole =
  | "user"
  | "assistant"
  | "tool_result"
  | "file_content"
  | "web_content"
  | "system_event";

export type CuratorGateOutcome =
  | "pass"
  | "not_run"
  | "no_op"
  | "reject"
  | "defer"
  | "require_review";

export type CuratorGateRecord = {
  gate: string;
  effect: CuratorGateOutcome;
  code?: string | null;
  note?: string | null;
};

export type CuratorVerifiedSpan = {
  evidence_event_id: string;
  transcript_prefix_sha256: string;
  observed_prefix_len: number;
  record_index: number;
  segment_content_sha256: string;
  parser_version: number;
  redaction_policy_version: number;
  segmenter_version: number;
  sentence_index: number;
  start_byte: number;
  end_byte: number;
  span_sha256: string;
  role: CuratorSourceRole;
};

export type CuratorGenerationReceipt = {
  provider: string;
  model_id: string;
  model_digest: string;
  prompt_sha256: string;
  request_sha256: string;
  response_sha256: string;
  output_schema_version: number;
  started_at: string;
  duration_ms: number;
};

export type CuratorNliRecord = {
  model_fingerprint: string;
  renderer_version: number;
  entailment_bps: number;
  neutral_bps: number;
  contradiction_bps: number;
};

export type CuratorVerificationReceipt = {
  verifier_version: number;
  policy_epoch: string;
  parser_version: number;
  redaction_policy_version: number;
  segmenter_version: number;
  envelope_sha256: string;
  gates: CuratorGateRecord[];
  nli?: CuratorNliRecord | null;
  verified_at: string;
};

export type CuratorExtension = {
  ext_version: number;
  unit_id: string;
  claim_class: string;
  source_role: CuratorSourceRole;
  primary: CuratorVerifiedSpan;
  context?: CuratorVerifiedSpan[];
  evidence_key: string;
  claim_key: string;
  generation: CuratorGenerationReceipt;
  verification: CuratorVerificationReceipt;
  review_codes?: string[];
};

/** One re-sliced sentence, resolved server-side by `/api/curator/span_preview`
 *  (`runner::PreviewSpan`). Transcript text is never stored in the proposal —
 *  the server re-opens the file, re-verifies the prefix hash, and re-slices on
 *  demand. `role` is the renderer's label (`user` / `assistant` today). */
export type CuratorSpanText = {
  role: string;
  text: string;
  primary?: boolean;
  /** False = the file drifted under a still-valid prefix. Shown, never hidden. */
  digest_matches?: boolean;
  sentence_index?: number;
  record_index?: number;
};

export type CuratorSpanPreviewResponse = {
  proposal_id?: string;
  brain_id?: string;
  available?: boolean;
  /** `evidence_unavailable` · `consent_revoked` · `platform_unsupported` ·
   *  `not_a_curator_proposal`. */
  code?: string | null;
  spans?: CuratorSpanText[] | null;
};

export type Proposal = {
  proposal_id: string;
  brain_id: string;
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
  /** Present only on local-curator proposals. */
  curator?: CuratorExtension | null;
};

type JournalEvent = {
  event_id: string;
  ts: string;
  event_type: string;
  actor: string;
  title?: string | null;
  before?: string | null;
  after?: string | null;
};

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

const T = {
  text: "var(--nv-text)",
  dim: "var(--nv-text-dim)",
  accent: "var(--nv-accent, #568cfa)",
  surface: "var(--nv-surface)",
  border: "var(--nv-border)",
};

function useEvidence(proposal: Proposal | null, brainId: string | null) {
  const [events, setEvents] = useState<JournalEvent[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setEvents(null);
    setFailed(false);
    if (!proposal || !brainId) return;
    let alive = true;
    (async () => {
      try {
        const params = new URLSearchParams({
          ids: proposal.evidence.join(","),
          brain_id: brainId,
        });
        const r = await fetch(
          `${API_HOST}/api/journal_events?${params}`,
          { signal: AbortSignal.timeout(5000) }
        );
        const data = (await r.json()) as { events: JournalEvent[] };
        if (alive) setEvents((data.events ?? []).sort((a, b) => a.ts.localeCompare(b.ts)));
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [proposal?.proposal_id, brainId]); // eslint-disable-line react-hooks/exhaustive-deps
  return { events, failed };
}

function Disclosure({
  label,
  children,
  onOpen,
}: {
  label: string;
  children: React.ReactNode;
  /** Fired on every summary activation. Callers that start work here must be
   *  idempotent — this is the lazy-load trigger for the span-preview panel,
   *  which must not re-open a transcript until the user asks to see it. */
  onOpen?: () => void;
}) {
  return (
    <details className="group">
      <summary
        className="cursor-pointer list-none text-[13px] py-1 select-none"
        style={{ color: T.dim }}
        onClick={onOpen}
      >
        <span className="inline-block w-4 group-open:rotate-90 transition-transform">▸</span>
        {label}
      </summary>
      <div className="pl-4 pt-1 pb-2 text-[13px] leading-relaxed" style={{ color: T.dim }}>
        {children}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Local Memory Curator — evidence panel + gate receipt
// ---------------------------------------------------------------------------

const shortHash = (h: string): string => (h.length > 14 ? `${h.slice(0, 14)}…` : h);

type SpanState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; spans: CuratorSpanText[] }
  | { status: "unavailable"; code?: string | null };

/** Re-reads the cited sentences on demand.
 *
 *  Nothing is fetched until `active` — opening this panel makes the server
 *  re-open the transcript and re-verify its prefix hash, which is not work to
 *  do for every card that scrolls past. Any failure at all (file changed,
 *  server down, empty answer) collapses to the same honest defer state: we
 *  would rather show nothing than bytes nobody verified. */
function CuratorSpanPanel({
  proposalId,
  brainId,
  curator,
  active,
}: {
  proposalId: string;
  brainId: string;
  curator: CuratorExtension;
  active: boolean;
}) {
  const [state, setState] = useState<SpanState>({ status: "idle" });

  useEffect(() => {
    setState({ status: "idle" });
  }, [proposalId, brainId]);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    setState((prev) => (prev.status === "idle" ? { status: "loading" } : prev));
    (async () => {
      try {
        const params = new URLSearchParams({ proposal_id: proposalId, brain_id: brainId });
        const r = await fetch(`${API_HOST}/api/curator/span_preview?${params}`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as CuratorSpanPreviewResponse;
        const spans = data.spans ?? [];
        if (!alive) return;
        if (data.available === false || spans.length === 0)
          setState({ status: "unavailable", code: data.code ?? null });
        else setState({ status: "ready", spans });
      } catch {
        if (alive) setState({ status: "unavailable" });
      }
    })();
    return () => {
      alive = false;
    };
  }, [active, proposalId, brainId]);

  const spanCount = 1 + (curator.context?.length ?? 0);

  return (
    <div className="mb-3">
      <div className="text-[11px] font-semibold tracking-wider uppercase mb-1" style={{ color: T.dim }}>
        {spanCount === 1 ? "The sentence this came from" : "The sentences this came from"}
      </div>
      {state.status !== "ready" && (
        <p>
          {state.status === "unavailable"
            ? curatorPreviewUnavailable(state.code)
            : CURATOR_EVIDENCE_LOADING}
        </p>
      )}
      {state.status === "ready" &&
        state.spans.map((s, i) => (
          <div key={`${s.role}-${s.record_index ?? 0}-${s.sentence_index ?? i}`} className="py-1">
            <span
              className="text-[11px] uppercase tracking-wider mr-2"
              style={{ color: T.accent }}
            >
              {curatorRoleLabel(s.role)}
              {s.primary === false ? " · context" : ""}
            </span>
            <span style={{ color: T.text, opacity: 0.9 }}>“{s.text}”</span>
            {s.digest_matches === false && (
              <span className="ml-2" style={{ color: "var(--nv-negative)" }}>
                ({CURATOR_SPAN_DIGEST_DRIFT})
              </span>
            )}
          </div>
        ))}
      <p className="mt-1" style={{ opacity: 0.75 }}>
        Quoted straight from your transcript on disk — never from the model, which is only allowed
        to point at sentence numbers.
      </p>
    </div>
  );
}

/** The gate receipt: all thirteen gates, whether they ran or not.
 *
 *  A gate with no record did not run — either the candidate died at an
 *  earlier gate, or (G10) the check isn't part of this version. Both are
 *  shown rather than hidden: a check that silently vanishes is the failure
 *  mode this whole receipt exists to prevent. */
function CuratorReceipt({ curator }: { curator: CuratorExtension }) {
  const rows = useMemo(() => {
    const byName = new Map(curator.verification.gates.map((g) => [g.gate, g]));
    return CURATOR_GATE_ORDER.map((gate) => ({
      gate,
      record: byName.get(gate) ?? null,
    }));
  }, [curator]);

  const counts = useMemo(() => {
    const c = { pass: 0, not_run: 0, reject: 0, defer: 0, require_review: 0, no_op: 0 };
    for (const r of rows) {
      const effect: CuratorGateOutcome = r.record?.effect ?? "not_run";
      c[effect] += 1;
    }
    return c;
  }, [rows]);

  const summary = [
    `${counts.pass} passed`,
    counts.require_review > 0 ? `${counts.require_review} flagged for you` : null,
    counts.reject > 0 ? `${counts.reject} rejected` : null,
    counts.defer > 0 ? `${counts.defer} deferred` : null,
    counts.no_op > 0 ? `${counts.no_op} already known` : null,
    counts.not_run > 0 ? `${counts.not_run} not run` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const gen = curator.generation;
  const seconds = Math.round(gen.duration_ms / 1000);

  return (
    <div className="space-y-2">
      <p>
        {rows.length} checks ran against your transcript — {summary}. Every one of them can only
        reject; none of them can invent.
      </p>
      <div className="space-y-0.5">
        {rows.map(({ gate, record }) => {
          const effect: CuratorGateOutcome = record?.effect ?? "not_run";
          const tone =
            effect === "reject" || effect === "defer"
              ? "var(--nv-negative)"
              : effect === "require_review"
                ? T.accent
                : effect === "pass"
                  ? "var(--nv-positive)"
                  : T.dim;
          return (
            <div key={gate} className="flex items-baseline gap-2">
              <span className="font-mono text-[11px] shrink-0" style={{ opacity: 0.6 }}>
                {curatorGateTag(gate)}
              </span>
              <span
                className="text-[11px] px-1.5 py-0.5 rounded shrink-0"
                style={{ color: tone, border: `1px solid color-mix(in srgb, ${tone} 35%, transparent)` }}
              >
                {curatorOutcomeLabel(effect)}
              </span>
              <span style={{ color: T.text, opacity: 0.85 }}>
                {curatorGateLabel(gate)}
                {record?.code ? ` — ${curatorCodeLabel(record.code)}` : ""}
              </span>
            </div>
          );
        })}
      </div>
      {!curator.verification.gates.some((g) => g.gate === "g12_derive_disposition") && (
        <p style={{ opacity: 0.75 }}>
          G12 is the verdict itself and records no line of its own — this card is its output.
        </p>
      )}
      {rows.some((r) => r.gate === "g10_score_entailment" && (r.record?.effect ?? "not_run") === "not_run") && (
        <p style={{ opacity: 0.75 }}>{CURATOR_G10_NOT_RUN_NOTE}</p>
      )}
      {(curator.review_codes?.length ?? 0) > 0 && (
        <p>
          Flagged for you: {curator.review_codes?.map((c) => curatorCodeLabel(c)).join("; ")}.
        </p>
      )}
      <div className="font-mono text-[11px] space-y-0.5 pt-1">
        <div>
          model: {gen.model_id} · {shortHash(gen.model_digest)} · {gen.provider}, on this Mac
        </div>
        <div>
          generated: {relativeTime(gen.started_at)} · {seconds}s · output schema v
          {gen.output_schema_version}
        </div>
        <div>
          verifier: v{curator.verification.verifier_version} · policy {curator.verification.policy_epoch}
        </div>
        <div>
          transforms: parser v{curator.verification.parser_version} · redaction v
          {curator.verification.redaction_policy_version} · segmenter v
          {curator.verification.segmenter_version}
        </div>
        <div>
          evidence key: {curator.evidence_key} · claim key: {curator.claim_key}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The focused proposal card
// ---------------------------------------------------------------------------

function FocusedProposal({
  p,
  brainId,
  project,
  events,
  evidenceFailed,
  onDecided,
  registerKeyActions,
}: {
  p: Proposal;
  brainId: string;
  project: string | null;
  events: JournalEvent[] | null;
  evidenceFailed: boolean;
  onDecided: (brainId: string) => void;
  registerKeyActions: (a: { approve?: () => void; edit?: () => void; reject?: () => void }) => void;
}) {
  const copy = actionCopy(p.action);
  const [mode, setMode] = useState<"view" | "edit" | "reject">("view");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [rejectReason, setRejectReason] = useState<string>("");
  const [rejectDetail, setRejectDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The transcript is only re-opened once the user asks to see the evidence.
  const [evidenceOpened, setEvidenceOpened] = useState(false);
  const curator = p.curator ?? null;
  const statement = p.fields.find((f) => f.name === "statement")?.proposed_value ?? p.title;
  const subject = p.fields.find((f) => f.name === "subject")?.proposed_value ?? null;

  useEffect(() => {
    setMode("view");
    setEdits({});
    setRejectReason("");
    setRejectDetail("");
    setError(null);
    setEvidenceOpened(false);
  }, [p.proposal_id]);

  const decide = useCallback(
    async (approve: boolean) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        // The decision must stay attached to the vault that produced this
        // card. The globally active vault can change while the request is in
        // flight, so never let the backend infer this mutation's scope.
        const body: Record<string, unknown> = { brain_id: brainId, reviewer: "user" };
        if (approve && Object.keys(edits).length > 0) body.edits = edits;
        if (!approve) {
          const reason = [rejectReason, rejectDetail.trim()].filter(Boolean).join(" — ");
          if (reason) body.reason = reason;
        }
        const r = await fetch(
          `${API_HOST}/api/proposals/${p.proposal_id}/${approve ? "approve" : "reject"}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(8000),
          }
        );
        if (!r.ok) throw new Error(await r.text());
        onDecided(brainId);
      } catch (e) {
        setError(e instanceof Error ? e.message : "The request failed — try again.");
      } finally {
        setBusy(false);
      }
    },
    [p.proposal_id, brainId, edits, rejectReason, rejectDetail, busy, onDecided]
  );

  // Keyboard actions delegate here (guarded upstream against inputs).
  useEffect(() => {
    registerKeyActions({
      approve: mode === "view" ? () => decide(true) : undefined,
      edit: mode === "view" ? () => setMode("edit") : undefined,
      reject: mode === "view" ? () => setMode("reject") : undefined,
    });
  }, [mode, decide, registerKeyActions]);

  const unreviewed = p.review_status === "unreviewed";

  return (
    <div
      className="rounded-2xl px-8 py-7 mx-auto w-full"
      style={{ background: T.surface, border: `1px solid ${T.border}`, maxWidth: 660 }}
    >
      {/* 1. Context */}
      <div className="flex items-baseline gap-3 mb-5">
        <span className="text-[14px] font-semibold" style={{ color: T.accent }}>
          {project ?? "Your workspace"}
        </span>
        <span className="text-[13px]" style={{ color: T.dim }}>
          {memoryTypeLabel(p.memory_type)} · {relativeTime(p.proposed_at)}
        </span>
        <span className="ml-auto text-[12px]" style={{ color: T.dim, opacity: 0.75 }}>
          {p.band} confidence
        </span>
      </div>

      {/* 2. Observation */}
      <h2 className="text-[19px] font-semibold leading-snug mb-2" style={{ color: T.text }}>
        {copy.headline}
      </h2>
      <p className="text-[14px] leading-relaxed mb-6" style={{ color: T.text, opacity: 0.9 }}>
        {copy.meaning}
      </p>

      {/* 3. Proposed change */}
      <div className="mb-5">
        <div className="text-[11px] font-semibold tracking-wider uppercase mb-1" style={{ color: T.dim }}>
          Proposed change
        </div>
        <p className="text-[14px] leading-relaxed" style={{ color: T.text }}>
          {copy.proposedChange ?? copy.meaning}
        </p>
      </div>

      {/* 3b. The proposed memory itself, verbatim (curator cards only) */}
      {curator && (
        <div className="mb-5">
          <div className="text-[11px] font-semibold tracking-wider uppercase mb-1" style={{ color: T.dim }}>
            Proposed memory
          </div>
          <p className="text-[15px] leading-relaxed" style={{ color: T.text }}>
            “{statement}”
          </p>
          <p className="text-[12px] mt-1" style={{ color: T.dim }}>
            {curatorClassLabel(curator.claim_class)}
            {subject ? ` · subject: ${subject}` : ""} · said by{" "}
            {curatorRoleLabel(curator.source_role)}
          </p>
        </div>
      )}

      {/* 4. Consequence */}
      <div className="mb-6">
        <div className="text-[11px] font-semibold tracking-wider uppercase mb-1" style={{ color: T.dim }}>
          {copy.executable ? "If applied" : "What your answer does"}
        </div>
        <p className="text-[14px] leading-relaxed" style={{ color: T.text, opacity: 0.9 }}>
          {copy.ifApproved}
        </p>
      </div>

      {/* Decided banner (non-unreviewed states) */}
      {!unreviewed && (
        <div
          className="rounded-lg px-4 py-3 mb-5 text-[13px]"
          style={{
            background:
              p.review_status === "rejected" ? "color-mix(in srgb, var(--nv-negative) 8%, transparent)" : "color-mix(in srgb, var(--nv-positive) 8%, transparent)",
            color: p.review_status === "rejected" ? "var(--nv-negative)" : "var(--nv-positive)",
          }}
        >
          {p.review_status === "approved" && "You approved this memory"}
          {p.review_status === "edited" && "You approved this memory with corrections"}
          {p.review_status === "rejected" && "You rejected this"}
          {p.decided_at ? ` · ${relativeTime(p.decided_at)}` : ""}
          {p.decision_reason ? (
            <span style={{ color: T.dim }}> — “{p.decision_reason}”</span>
          ) : null}
          <div className="mt-1" style={{ color: T.dim }}>
            {p.application_status === "applied" && "The change was applied."}
            {p.application_status === "pending" &&
              p.review_status !== "rejected" &&
              "Recorded. No data changes until NeuroVault can support this safely."}
            {p.application_status === "failed" && (
              <span style={{ color: "var(--nv-negative)" }}>
                NeuroVault couldn't apply the change ({p.application_error}) — your decision stands.
              </span>
            )}
          </div>
        </div>
      )}

      {/* 5. Progressive disclosure */}
      <div className="mb-6 space-y-0.5">
        <Disclosure label="Why NeuroVault suggested this">
          <p>{p.reason}</p>
          {curator && (
            <p className="mt-1">
              A model on this Mac proposed it from one finished turn of your{" "}
              {project ?? "Claude Code"} session, and NeuroVault verified every value against the
              transcript before this card existed. The model never wrote the evidence — it pointed
              at sentence numbers, and the server read the sentences.
            </p>
          )}
          {p.predecessor && (
            <p className="mt-1">
              A similar suggestion was rejected before; this one exists because new evidence appeared.
            </p>
          )}
        </Disclosure>
        <Disclosure
          label={curator ? "Evidence from your transcript" : "Evidence from this session"}
          onOpen={curator ? () => setEvidenceOpened(true) : undefined}
        >
          {curator && (
            <CuratorSpanPanel
              proposalId={p.proposal_id}
              brainId={brainId}
              curator={curator}
              active={evidenceOpened}
            />
          )}
          {evidenceFailed && <p>The evidence couldn't be loaded — the events are still in the journal.</p>}
          {!evidenceFailed && !events && <p>Loading…</p>}
          {events?.map((e) => (
            <div key={e.event_id} className="flex gap-3 py-0.5">
              <span className="tabular-nums shrink-0" style={{ opacity: 0.7 }}>
                {relativeTime(e.ts)}
              </span>
              <span style={{ color: T.text, opacity: 0.85 }}>{eventSentence(e)}</span>
            </div>
          ))}
          {events && events.length === 0 && <p>The evidence events are older than the timeline window.</p>}
        </Disclosure>
        {curator && (
          <Disclosure label="How NeuroVault checked this">
            <CuratorReceipt curator={curator} />
          </Disclosure>
        )}
        <Disclosure label="Technical details">
          <div className="font-mono text-[11px] space-y-0.5">
            <div>action: {p.action}</div>
            <div>rule: {p.reason}</div>
            <div>proposal: {p.proposal_id}</div>
            <div>object: {p.object_id}</div>
            <div>
              fields:{" "}
              {p.fields
                .map((f) => `${f.name}=${f.proposed_value}${f.approved_value ? `→${f.approved_value}` : ""}`)
                .join(", ")}
            </div>
            <div>evidence: {p.evidence.map((e) => e.slice(0, 8)).join(" ")}</div>
            <div>application: {p.application_status}</div>
          </div>
        </Disclosure>
      </div>

      {error && (
        <div className="mb-4 text-[13px]" style={{ color: "var(--nv-negative)" }}>
          {error}{" "}
          <button className="underline" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      )}

      {/* 6. Actions */}
      {unreviewed && mode === "view" && (
        <div className="flex items-center gap-3">
          <button
            disabled={busy}
            onClick={() => setMode("reject")}
            className="text-[13px] px-4 py-2 rounded-lg hover:opacity-80 disabled:opacity-40"
            style={{ color: "var(--nv-negative)", border: "1px solid color-mix(in srgb, var(--nv-negative) 35%, transparent)" }}
          >
            {copy.executable ? "Reject" : "Not accurate"}
          </button>
          <button
            disabled={busy}
            onClick={() => setMode("edit")}
            className="text-[13px] px-4 py-2 rounded-lg hover:opacity-80 disabled:opacity-40"
            style={{ color: T.text, border: `1px solid ${T.border}` }}
          >
            Edit before approving
          </button>
          <button
            disabled={busy}
            onClick={() => decide(true)}
            className="text-[13px] px-5 py-2 rounded-lg font-semibold hover:opacity-90 disabled:opacity-40 ml-auto"
            style={{ background: "color-mix(in srgb, var(--nv-positive) 14%, transparent)", color: "var(--nv-positive)", border: "1px solid color-mix(in srgb, var(--nv-positive) 40%, transparent)" }}
          >
            {copy.executable ? "Apply change" : "Accurate"}
          </button>
        </div>
      )}

      {unreviewed && mode === "edit" && (
        <div className="space-y-3">
          <div className="text-[13px]" style={{ color: T.dim }}>
            Correct anything that's wrong, then approve. Both the original and your version are kept.
          </div>
          {p.fields.map((f) => (
            <div key={f.name} className="space-y-1">
              <div className="text-[12px] font-medium" style={{ color: T.text }}>
                {fieldLabel(f.name)}
                <span className="ml-2" style={{ color: T.dim }}>
                  proposed: {f.proposed_value === "true" ? "yes" : f.proposed_value === "false" ? "no" : f.proposed_value}
                </span>
              </div>
              <input
                className="w-full text-[13px] rounded-lg px-3 py-2"
                style={{ background: "var(--nv-surface-2)", border: `1px solid ${T.border}`, color: T.text }}
                placeholder="your corrected value (leave empty to keep the proposal)"
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
            </div>
          ))}
          <div className="flex items-center gap-3">
            <button
              className="text-[13px] px-4 py-2 rounded-lg"
              style={{ color: T.dim, border: `1px solid ${T.border}` }}
              onClick={() => setMode("view")}
            >
              Cancel
            </button>
            <button
              disabled={busy}
              onClick={() => decide(true)}
              className="text-[13px] px-5 py-2 rounded-lg font-semibold ml-auto disabled:opacity-40"
              style={{ background: "color-mix(in srgb, var(--nv-positive) 14%, transparent)", color: "var(--nv-positive)", border: "1px solid color-mix(in srgb, var(--nv-positive) 40%, transparent)" }}
            >
              {Object.keys(edits).length > 0
                ? copy.executable
                  ? "Apply with corrections"
                  : "Accurate, with corrections"
                : copy.executable
                  ? "Apply change"
                  : "Accurate"}
            </button>
          </div>
        </div>
      )}

      {unreviewed && mode === "reject" && (
        <div className="space-y-3">
          <div className="text-[13px]" style={{ color: T.dim }}>
            Why is this wrong? Your reason teaches NeuroVault what to avoid.
          </div>
          <div className="flex flex-wrap gap-2">
            {REJECT_REASONS.map((r) => (
              <button
                key={r}
                onClick={() => setRejectReason(r)}
                className="text-[13px] px-3 py-1.5 rounded-lg"
                style={{
                  border: `1px solid ${rejectReason === r ? "color-mix(in srgb, var(--nv-negative) 50%, transparent)" : T.border}`,
                  background: rejectReason === r ? "color-mix(in srgb, var(--nv-negative) 10%, transparent)" : "transparent",
                  color: rejectReason === r ? "var(--nv-negative)" : T.text,
                }}
              >
                {r}
              </button>
            ))}
          </div>
          <input
            className="w-full text-[13px] rounded-lg px-3 py-2"
            style={{ background: "var(--nv-surface-2)", border: `1px solid ${T.border}`, color: T.text }}
            placeholder="optional detail"
            value={rejectDetail}
            onChange={(e) => setRejectDetail(e.target.value)}
          />
          <div className="flex items-center gap-3">
            <button
              className="text-[13px] px-4 py-2 rounded-lg"
              style={{ color: T.dim, border: `1px solid ${T.border}` }}
              onClick={() => setMode("view")}
            >
              Cancel
            </button>
            <button
              disabled={busy || !rejectReason}
              onClick={() => decide(false)}
              className="text-[13px] px-5 py-2 rounded-lg font-semibold ml-auto disabled:opacity-40"
              style={{ background: "color-mix(in srgb, var(--nv-negative) 12%, transparent)", color: "var(--nv-negative)", border: "1px solid color-mix(in srgb, var(--nv-negative) 40%, transparent)" }}
            >
              Reject
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The inbox
// ---------------------------------------------------------------------------

export default function MemoryReview({
  tab,
}: {
  tab: "pending" | "history";
}) {
  const activeBrainId = useBrainStore((s) => s.activeBrainId);
  const activeBrainIdRef = useRef(activeBrainId);
  activeBrainIdRef.current = activeBrainId;
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [loadedBrainId, setLoadedBrainId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [note, setNote] = useState<string | null>(null);
  const keyActions = useRef<{ approve?: () => void; edit?: () => void; reject?: () => void }>({});
  const loadGeneration = useRef(0);

  const load = useCallback(async (requestedBrainId: string | null) => {
    const generation = ++loadGeneration.current;
    if (!requestedBrainId) {
      if (generation === loadGeneration.current && activeBrainIdRef.current === null) {
        setLoadedBrainId(null);
        setProposals([]);
        setError(null);
      }
      return;
    }
    try {
      const status = tab === "pending" ? "unreviewed" : "";
      const params = new URLSearchParams({ limit: "200" });
      if (status) params.set("decision", status);
      params.set("brain_id", requestedBrainId);
      const r = await fetch(`${API_HOST}/api/proposals?${params}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) throw new Error(await r.text());
      const data = (await r.json()) as { brain?: string; proposals: Proposal[] };
      if (!data.brain) throw new Error("Proposal response did not identify its vault");
      if (data.brain !== requestedBrainId) {
        throw new Error("Proposal response came from a different vault");
      }
      let list = data.proposals ?? [];
      if (list.some((proposal) => proposal.brain_id !== data.brain)) {
        throw new Error("Proposal response mixed records from different vaults");
      }
      if (tab === "pending") {
        // Real memory changes come first, followed by optional accuracy checks.
        // Within each group, preserve the oldest-first inbox discipline.
        list.sort((a, b) => {
          const priority = Number(proposalNeedsAttention(b.action)) - Number(proposalNeedsAttention(a.action));
          return priority || a.proposed_at.localeCompare(b.proposed_at);
        });
      } else {
        list = list.filter((proposal) => proposal.review_status !== "unreviewed");
        list.sort((a, b) => (b.decided_at ?? b.proposed_at).localeCompare(a.decided_at ?? a.proposed_at));
      }
      if (generation === loadGeneration.current && requestedBrainId === activeBrainIdRef.current) {
        setLoadedBrainId(data.brain);
        setProposals(list);
        setError(null);
      }
    } catch {
      if (generation === loadGeneration.current && requestedBrainId === activeBrainIdRef.current) {
        setLoadedBrainId(null);
        setError("Can't load this vault's review queue — is NeuroVault running?");
      }
    }
  }, [tab]);

  useEffect(() => {
    // A review card is scoped data. Remove it immediately on vault changes,
    // invalidate any slower request for the prior vault, and load a fresh
    // queue before exposing another decision button.
    loadGeneration.current += 1;
    setProposals(null);
    setLoadedBrainId(null);
    setIndex(0);
    setSkipped(new Set());
    setNote(null);
    keyActions.current = {};
    void load(activeBrainId);
    return () => {
      loadGeneration.current += 1;
    };
  }, [activeBrainId, load]);

  const queue = useMemo(() => {
    if (!proposals) return [];
    if (tab !== "pending") return proposals;
    // Skipped items move to the back but stay reviewable.
    const active = proposals.filter((p) => !skipped.has(p.proposal_id));
    const parked = proposals.filter((p) => skipped.has(p.proposal_id));
    return [...active, ...parked];
  }, [proposals, skipped, tab]);

  const current = queue.length > 0 ? queue[Math.min(index, queue.length - 1)] : null;
  const { events, failed } = useEvidence(current ?? null, loadedBrainId);
  const project = useMemo(() => (events ? projectFromEvents(events) : null), [events]);

  // Similar-observation grouping: same action as the focused card.
  const similar = useMemo(
    () => (current ? queue.filter((p) => p.action === current.action).length : 0),
    [queue, current]
  );

  const onDecided = useCallback((decisionBrainId: string) => {
    if (decisionBrainId !== activeBrainIdRef.current) return;
    setNote("Recorded.");
    setTimeout(() => setNote(null), 1500);
    void load(decisionBrainId);
  }, [load]);

  // Keyboard: A approve, E edit, R reject, arrows navigate. Never when
  // the user is typing in an input/textarea/select.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)
      )
        return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowRight") setIndex((i) => Math.min(i + 1, Math.max(queue.length - 1, 0)));
      else if (e.key === "ArrowLeft") setIndex((i) => Math.max(i - 1, 0));
      else if (tab === "pending" && (e.key === "a" || e.key === "A")) keyActions.current.approve?.();
      else if (tab === "pending" && (e.key === "e" || e.key === "E")) keyActions.current.edit?.();
      else if (tab === "pending" && (e.key === "r" || e.key === "R")) keyActions.current.reject?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [queue.length, tab]);

  const registerKeyActions = useCallback(
    (a: { approve?: () => void; edit?: () => void; reject?: () => void }) => {
      keyActions.current = a;
    },
    []
  );

  const checkForNew = useCallback(async () => {
    setNote("Checking recent activity…");
    try {
      const r = await fetch(`${API_HOST}/api/consolidate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brain_id: activeBrainId, mode: "proposal" }),
        signal: AbortSignal.timeout(60000),
      });
      const data = (await r.json()) as { proposals: unknown[] };
      setNote(
        data.proposals.length > 0
          ? `Found ${data.proposals.length} new thing(s) worth reviewing.`
          : "Nothing new worth remembering right now."
      );
      void load(activeBrainId);
    } catch {
      setNote("Couldn't check — is the app running?");
    }
  }, [activeBrainId, load]);

  // ---- states ----
  if (error)
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="text-[14px]" style={{ color: "var(--nv-negative)" }}>
            {error}
          </div>
          <button
            onClick={() => void load(activeBrainId)}
            className="text-[13px] px-4 py-2 rounded-lg"
            style={{ color: T.text, border: `1px solid ${T.border}` }}
          >
            Retry
          </button>
        </div>
      </div>
    );

  if (proposals === null)
    return (
      <div className="flex-1 flex items-center justify-center text-[14px]" style={{ color: T.dim }}>
        Loading…
      </div>
    );

  if (queue.length === 0)
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-3 max-w-sm">
          <div className="text-[16px] font-medium" style={{ color: T.text }}>
            {tab === "pending" ? "Nothing to review" : "No review history yet"}
          </div>
          <div className="text-[13px] leading-relaxed" style={{ color: T.dim }}>
            {tab === "pending"
              ? "No memory changes or optional accuracy checks are waiting for you."
              : "Your approved, corrected, and rejected decisions will appear here."}
          </div>
          {tab === "pending" && (
            <button
              onClick={checkForNew}
              className="text-[13px] px-4 py-2 rounded-lg"
              style={{ color: T.accent, border: `1px solid ${T.border}` }}
            >
              Check recent activity
            </button>
          )}
          {note && (
            <div className="text-[13px]" style={{ color: T.accent }}>
              {note}
            </div>
          )}
        </div>
      </div>
    );

  return (
    <div className="flex-1 overflow-y-auto px-6 py-6">
      <div className="mx-auto" style={{ maxWidth: 660 }}>
        <div className="flex items-center mb-4">
          <div className="text-[13px]" style={{ color: T.dim }}>
            {similar > 1 && tab === "pending"
              ? `${similar} similar observations — reviewing them one at a time`
              : tab === "pending"
                ? current?.curator
                  ? "A local model proposed this from your own transcript. Your answer records a verdict — nothing is written."
                  : current && proposalNeedsAttention(current.action)
                    ? "NeuroVault wants to change memory. Nothing happens until you decide."
                    : "Optional accuracy check — this does not change memory."
                : "Review history is read-only."}
          </div>
          <div className="ml-auto text-[13px] tabular-nums" style={{ color: T.dim }}>
            {Math.min(index + 1, queue.length)} of {queue.length}
          </div>
        </div>

        {current && loadedBrainId && (
          <FocusedProposal
            p={current}
            brainId={loadedBrainId}
            project={project}
            events={events}
            evidenceFailed={failed}
            onDecided={onDecided}
            registerKeyActions={registerKeyActions}
          />
        )}

        <div className="flex items-center mt-4">
          <button
            disabled={index === 0}
            onClick={() => setIndex((i) => Math.max(i - 1, 0))}
            className="text-[13px] px-3 py-1.5 rounded-lg disabled:opacity-30"
            style={{ color: T.dim, border: `1px solid ${T.border}` }}
          >
            ← Previous
          </button>
          {tab === "pending" && current && (
            <button
              onClick={() => {
                setSkipped((s) => new Set(s).add(current.proposal_id));
                setIndex((i) => Math.min(i + 1, queue.length - 1));
              }}
              className="text-[13px] px-3 py-1.5 rounded-lg mx-auto"
              style={{ color: T.dim }}
            >
              Skip for now
            </button>
          )}
          <button
            disabled={index >= queue.length - 1}
            onClick={() => setIndex((i) => Math.min(i + 1, queue.length - 1))}
            className="text-[13px] px-3 py-1.5 rounded-lg disabled:opacity-30 ml-auto"
            style={{ color: T.dim, border: `1px solid ${T.border}` }}
          >
            Next →
          </button>
        </div>

        {note && (
          <div className="text-center mt-3 text-[13px]" style={{ color: T.accent }}>
            {note}
          </div>
        )}
        {tab === "pending" && (
          <div className="text-center mt-6 text-[11px]" style={{ color: T.dim, opacity: 0.7 }}>
            A approve · E edit · R reject · ←/→ navigate
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Learning report (metrics live here now, away from the review flow)
// ---------------------------------------------------------------------------

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
  median_review_seconds?: number | null;
};

export function LearningReport() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [fnText, setFnText] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API_HOST}/api/consolidation_metrics`, {
        signal: AbortSignal.timeout(5000),
      });
      setMetrics((await r.json()) as Metrics);
    } catch {
      setMetrics(null);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const reportMiss = useCallback(async () => {
    if (fnText.trim().length < 4) return;
    try {
      await fetch(`${API_HOST}/api/consolidation_false_negative`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: fnText.trim(), reviewer: "user" }),
        signal: AbortSignal.timeout(5000),
      });
      setFnText("");
      setNote("Recorded — misses count against NeuroVault, not you.");
      load();
    } catch {
      setNote("Couldn't record it — is the app running?");
    }
  }, [fnText, load]);

  const row = (label: string, value: string | number) => (
    <div className="flex justify-between text-[13px] py-1.5" style={{ borderBottom: `1px solid ${T.border}` }}>
      <span style={{ color: T.dim }}>{label}</span>
      <span style={{ color: T.text }}>{value}</span>
    </div>
  );

  return (
    <div className="flex-1 overflow-y-auto px-6 py-6">
      <div className="mx-auto space-y-6" style={{ maxWidth: 560 }}>
        <p className="text-[13px] leading-relaxed" style={{ color: T.dim }}>
          How NeuroVault is doing at learning from you. These numbers matter once you've reviewed a
          meaningful sample — early on they'll look sparse, and that's fine.
        </p>
        {metrics ? (
          <div>
            {row("Waiting for your review", metrics.unreviewed)}
            {row("Reviewed so far", `${(metrics.review_coverage * 100).toFixed(0)}%`)}
            {row("Approved as-is", metrics.approved_untouched)}
            {row("Approved after your corrections", metrics.approved_after_edits)}
            {row("Rejected", metrics.rejected)}
            {row("Changes actually applied", metrics.app_applied)}
            {row("Awaiting safe support (no data changed)", metrics.app_pending)}
            {row("Failed to apply (verdicts unaffected)", metrics.app_failed)}
            {row("Misses you reported", metrics.audited_false_negatives)}
          </div>
        ) : (
          <div className="text-[13px]" style={{ color: T.dim }}>
            Loading…
          </div>
        )}
        <div className="space-y-2">
          <div className="text-[13px] font-medium" style={{ color: T.text }}>
            Did NeuroVault miss something it should have noticed?
          </div>
          <textarea
            className="w-full text-[13px] rounded-lg px-3 py-2 h-20 resize-none"
            style={{ background: "var(--nv-surface-2)", border: `1px solid ${T.border}`, color: T.text }}
            placeholder="e.g. “I made a big decision today and it never suggested saving it”"
            value={fnText}
            onChange={(e) => setFnText(e.target.value)}
          />
          <button
            onClick={reportMiss}
            disabled={fnText.trim().length < 4}
            className="text-[13px] px-4 py-2 rounded-lg disabled:opacity-40"
            style={{ color: T.text, border: `1px solid ${T.border}` }}
          >
            Report a miss
          </button>
          {note && (
            <div className="text-[13px]" style={{ color: T.accent }}>
              {note}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
