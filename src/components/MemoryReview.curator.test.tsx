/**
 * The curator review card.
 *
 * The fixture is the guide's §6.6 worked example, structure-exact: one
 * `StoredProposal` in the ordinary review store carrying the optional
 * `curator` extension. The store is not forked, so everything the existing
 * card does must keep working — and the extension must add evidence and a
 * receipt without ever implying that approving writes something.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBrainStore } from "../stores/brainStore";
import MemoryReview, {
  type CuratorExtension,
  type CuratorGateRecord,
  type Proposal,
} from "./MemoryReview";

const BRAIN = "NeuroVaultBrain1";
const PID = "3f8c2a94d1e07b56";
const SENTENCE = "From now on we deploy Atlas only on Tuesdays.";

const passingGates: CuratorGateRecord[] = [
  { gate: "g00_validate_output_envelope", effect: "pass" },
  { gate: "g01_resolve_allowed_object", effect: "pass" },
  { gate: "g02_resolve_allowed_evidence", effect: "pass" },
  { gate: "g03_enforce_action_field_contract", effect: "pass" },
  { gate: "g04_enforce_scope_and_source_policy", effect: "pass" },
  { gate: "g05_enforce_atomic_claim", effect: "pass" },
  { gate: "g06_verify_lexical_integrity", effect: "pass" },
  { gate: "g07_verify_attribution_binding", effect: "pass", note: "template:DEC_T1" },
  { gate: "g08_verify_polarity_modality_and_time", effect: "pass" },
  { gate: "g09_screen_sensitive_content", effect: "pass" },
  { gate: "g10_score_entailment", effect: "not_run" },
  { gate: "g11_check_existing_state", effect: "pass" },
];

const curator: CuratorExtension = {
  ext_version: 1,
  unit_id: "ev_ctx_7f21",
  claim_class: "decision",
  source_role: "user",
  primary: {
    evidence_event_id: "ev_stop_9c44",
    transcript_prefix_sha256: "c0ffee11",
    observed_prefix_len: 871,
    record_index: 0,
    segment_content_sha256: "5eg0",
    parser_version: 1,
    redaction_policy_version: 1,
    segmenter_version: 1,
    sentence_index: 0,
    start_byte: 0,
    end_byte: 45,
    span_sha256: "9b41",
    role: "user",
  },
  context: [],
  evidence_key: "a77b12c9e03d4f58",
  claim_key: "7d2e91c40b5aa318",
  generation: {
    provider: "ollama",
    model_id: "qwen3:30b-a3b-instruct-2507-q4_K_M",
    model_digest: "sha256:9f3c1e0d4b7a2c5e",
    prompt_sha256: "aaa",
    request_sha256: "bbb",
    response_sha256: "ccc",
    output_schema_version: 2,
    started_at: "2026-08-12T02:09:12Z",
    duration_ms: 86412,
  },
  verification: {
    verifier_version: 1,
    policy_epoch: "2026-08-vp1",
    parser_version: 1,
    redaction_policy_version: 1,
    segmenter_version: 1,
    envelope_sha256: "ddd",
    gates: passingGates,
    verified_at: "2026-08-12T02:10:44Z",
  },
  review_codes: [],
};

const proposal: Proposal = {
  proposal_id: PID,
  brain_id: BRAIN,
  action: "curator_remember_decision",
  memory_type: "engram",
  object_id: "curator/7d2e91c40b5aa318",
  title: "Remember: Atlas deploys only on Tuesdays.",
  reason:
    "Extracted from your atlas session; every value verified against the transcript (12 gates).",
  band: "medium",
  fields: [
    {
      name: "statement",
      proposed_value: "Atlas deploys only on Tuesdays.",
      evidence: ["ev_ctx_7f21", "ev_stop_9c44"],
    },
    {
      name: "subject",
      proposed_value: "deployment",
      evidence: ["ev_ctx_7f21", "ev_stop_9c44"],
    },
  ],
  evidence: ["ev_ctx_7f21", "ev_stop_9c44"],
  review_status: "unreviewed",
  application_status: "not_applicable",
  proposed_at: "2026-08-12T02:10:44Z",
  curator,
};

type SpanReply = { ok: boolean; status?: number; body?: unknown };

let fetchMock: ReturnType<typeof vi.fn>;
let spanReply: SpanReply;
let card: Proposal;

function mountFetch() {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/curator/span_preview")) {
      if (!spanReply.ok) {
        return { ok: false, status: spanReply.status ?? 500, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => spanReply.body };
    }
    if (url.includes("/api/journal_events")) {
      return { ok: true, json: async () => ({ events: [] }) };
    }
    if (init?.method === "POST") {
      return { ok: true, text: async () => "", json: async () => ({ changed: false }) };
    }
    const brainId = new URL(url).searchParams.get("brain_id");
    return {
      ok: true,
      json: async () => ({ brain: brainId, proposals: brainId === BRAIN ? [card] : [] }),
    };
  });
  vi.stubGlobal("fetch", fetchMock);
}

/** The evidence disclosure is the lazy-load trigger — nothing re-opens the
 *  user's transcript until they ask to see it. */
async function openEvidence(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByText(/Evidence from your transcript/, { selector: "summary" }));
}

const spanCalls = () =>
  fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/curator/span_preview"));

describe("curator review card", () => {
  beforeEach(() => {
    card = proposal;
    // Shape of `runner::SpanPreview` / `PreviewSpan`, exactly as the handler
    // serialises it.
    spanReply = {
      ok: true,
      body: {
        proposal_id: PID,
        brain_id: BRAIN,
        available: true,
        spans: [
          {
            role: "user",
            record_index: 0,
            sentence_index: 0,
            text: SENTENCE,
            digest_matches: true,
            primary: true,
          },
        ],
      },
    };
    mountFetch();
    useBrainStore.setState({ activeBrainId: BRAIN, activeBrainName: "NeuroVault" });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("leads with the §6.6 headline, the proposed memory, and who said it", async () => {
    render(<MemoryReview tab="pending" />);

    expect(await screen.findByText("Your session recorded a decision")).toBeInTheDocument();
    expect(screen.getByText("“Atlas deploys only on Tuesdays.”")).toBeInTheDocument();
    expect(screen.getByText(/subject: deployment/)).toBeInTheDocument();
    expect(screen.getByText(/said by you/)).toBeInTheDocument();
    expect(
      screen.getByText(/Your answer records a verdict — no memory is written today/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/A local model proposed this from your own transcript/),
    ).toBeInTheDocument();
  });

  it("re-reads the transcript only when the evidence panel is opened", async () => {
    const user = userEvent.setup();
    render(<MemoryReview tab="pending" />);
    await screen.findByText("Your session recorded a decision");

    expect(spanCalls()).toHaveLength(0);

    await openEvidence(user);

    expect(await screen.findByText(`“${SENTENCE}”`)).toBeInTheDocument();
    expect(screen.getByText(/^you$/)).toBeInTheDocument();
    expect(spanCalls()).toHaveLength(1);
    expect(String(spanCalls()[0]?.[0])).toContain(`proposal_id=${PID}`);
    expect(String(spanCalls()[0]?.[0])).toContain(`brain_id=${BRAIN}`);
  });

  it("defers gracefully when the transcript has moved on", async () => {
    spanReply = { ok: false, status: 410 };
    const user = userEvent.setup();
    render(<MemoryReview tab="pending" />);
    await screen.findByText("Your session recorded a decision");

    await openEvidence(user);

    expect(
      await screen.findByText(/Transcript changed since capture — evidence can no longer be shown/),
    ).toBeInTheDocument();
    expect(screen.queryByText(`“${SENTENCE}”`)).not.toBeInTheDocument();
  });

  it("treats an empty span list as unavailable rather than as evidence", async () => {
    spanReply = { ok: true, body: { available: false, code: "evidence_unavailable", spans: [] } };
    const user = userEvent.setup();
    render(<MemoryReview tab="pending" />);
    await screen.findByText("Your session recorded a decision");

    await openEvidence(user);

    expect(
      await screen.findByText(/Transcript changed since capture — evidence can no longer be shown/),
    ).toBeInTheDocument();
  });

  it("distinguishes revoked consent from a changed transcript", async () => {
    spanReply = { ok: true, body: { available: false, code: "consent_revoked", spans: [] } };
    const user = userEvent.setup();
    render(<MemoryReview tab="pending" />);
    await screen.findByText("Your session recorded a decision");

    await openEvidence(user);

    expect(await screen.findByText(/Transcript access is off/)).toBeInTheDocument();
    expect(
      screen.queryByText(/Transcript changed since capture/),
    ).not.toBeInTheDocument();
  });

  it("shows, rather than hides, a span whose bytes drifted", async () => {
    spanReply = {
      ok: true,
      body: {
        available: true,
        spans: [
          {
            role: "assistant",
            record_index: 1,
            sentence_index: 2,
            text: "The staging cron still runs at 03:30 UTC.",
            digest_matches: false,
            primary: false,
          },
        ],
      },
    };
    const user = userEvent.setup();
    render(<MemoryReview tab="pending" />);
    await screen.findByText("Your session recorded a decision");

    await openEvidence(user);

    expect(await screen.findByText(/Claude · context/)).toBeInTheDocument();
    expect(
      screen.getByText(/these bytes no longer match what was verified/),
    ).toBeInTheDocument();
  });

  it("shows all thirteen gates, including the ones that did not run", async () => {
    render(<MemoryReview tab="pending" />);
    await screen.findByText("Your session recorded a decision");

    // 12 recorded + G12 (the verdict itself records no line) = 13 rows.
    expect(screen.getByText("G00")).toBeInTheDocument();
    expect(screen.getByText("G12")).toBeInTheDocument();
    expect(screen.getByText("Every cited sentence really exists in your transcript")).toBeInTheDocument();
    expect(screen.getByText(/11 passed · 2 not run/)).toBeInTheDocument();
    expect(screen.getByText("Second-opinion entailment check")).toBeInTheDocument();
    expect(
      screen.getByText(/The entailment second opinion isn't part of this version/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/G12 is the verdict itself and records no line of its own/),
    ).toBeInTheDocument();
    expect(screen.getAllByText("not run")).toHaveLength(2);
  });

  it("names the model that proposed it, with its digest", async () => {
    render(<MemoryReview tab="pending" />);
    await screen.findByText("Your session recorded a decision");

    expect(
      screen.getByText(/qwen3:30b-a3b-instruct-2507-q4_K_M · sha256:9f3c1e0… · ollama, on this Mac/),
    ).toBeInTheDocument();
    expect(screen.getByText(/output schema v2/)).toBeInTheDocument();
    expect(screen.getByText(/policy 2026-08-vp1/)).toBeInTheDocument();
  });

  it("renders a terminal receipt honestly: the code, then nothing after it", async () => {
    // V1 never ships a G06 rejection to a card (it dies in the run ledger),
    // but the renderer must not assume every receipt is all-pass.
    card = {
      ...proposal,
      curator: {
        ...curator,
        verification: {
          ...curator.verification,
          gates: [
            ...passingGates.slice(0, 6),
            { gate: "g06_verify_lexical_integrity", effect: "reject", code: "literal_mismatch" },
          ],
        },
        review_codes: ["weak_provenance"],
      },
    };
    render(<MemoryReview tab="pending" />);
    await screen.findByText("Your session recorded a decision");

    expect(
      screen.getByText(
        /No number, date or name was altered — a number, date or name didn't match the transcript/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("rejected")).toBeInTheDocument();
    expect(screen.getByText(/6 passed · 1 rejected · 6 not run/)).toBeInTheDocument();
    expect(
      screen.getByText(/Flagged for you: the source is weaker than the claim/),
    ).toBeInTheDocument();
  });

  it("keeps the accuracy verdict actions — no 'apply', and both still dispatch", async () => {
    const user = userEvent.setup();
    render(<MemoryReview tab="pending" />);
    await screen.findByText("Your session recorded a decision");

    expect(screen.queryByRole("button", { name: "Apply change" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Accurate" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(`/api/proposals/${PID}/approve`),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ brain_id: BRAIN, reviewer: "user" }),
        }),
      );
    });
  });

  it("rejects with a reason, which is what tombstones the evidence", async () => {
    const user = userEvent.setup();
    render(<MemoryReview tab="pending" />);
    await screen.findByText("Your session recorded a decision");

    await user.click(screen.getByRole("button", { name: "Not accurate" }));
    await user.click(screen.getByRole("button", { name: "Incorrect observation" }));
    await user.click(screen.getByRole("button", { name: "Reject" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(`/api/proposals/${PID}/reject`),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            brain_id: BRAIN,
            reviewer: "user",
            reason: "Incorrect observation",
          }),
        }),
      );
    });
  });

  it("leaves non-curator cards exactly as they were", async () => {
    card = {
      ...proposal,
      proposal_id: "plain-1",
      action: "memory_strengthened",
      curator: null,
    };
    render(<MemoryReview tab="pending" />);

    expect(await screen.findByRole("button", { name: "Apply change" })).toBeInTheDocument();
    expect(screen.queryByText("G00")).not.toBeInTheDocument();
    expect(screen.getByText(/Evidence from this session/, { selector: "summary" })).toBeInTheDocument();
    expect(spanCalls()).toHaveLength(0);
  });
});
