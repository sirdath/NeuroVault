/**
 * The Inspector's plain-language layer.
 *
 * Field report (Dath, 2026-07-11): "i truly try to read what it says on
 * the inspector and i dont understand anything." The Inspector was
 * rendering the system's INTERNAL vocabulary — action ids, band names,
 * gate reason codes, score inequalities — instead of meaning. Rule from
 * that day forward: every string a user sees leads with a sentence a
 * stranger could understand; the technical detail stays available, but
 * collapsed and clearly secondary.
 *
 * Everything here maps internal identifiers → human sentences. If a
 * new id has no mapping, callers fall back to a readable version of the
 * raw id (never hide data, never crash on unknowns).
 */

const humanize = (id: string): string => id.replace(/_/g, " ");

/** Intent ids → what the user was doing. */
const INTENTS: Record<string, string> = {
  continue_work: "Continuing work",
  prepare_brief: "Meeting prep",
  draft_output: "Drafting something",
  review_risks: "Risk check",
  explain_decision: "Explaining a decision",
  find_source: "Finding a source",
  temporal_diff: "What changed",
  general_question: "General question",
};
export const intentLabel = (id?: string | null): string =>
  id ? INTENTS[id] ?? humanize(id) : "General question";

/** Gate silence reason codes → why nothing was added. */
const SILENCE_REASONS: Array<[RegExp, string]> = [
  [/no_contentful_tokens/, "The prompt was small talk — nothing to search for."],
  [/below_min_score/, "Some memories matched a little, but none were relevant enough to trust."],
  [/gap_too_small/, "Several memories matched about equally weakly — too close to call, so none were used."],
  [/no_candidates/, "No stored memories matched this prompt."],
  [/all_duplicates/, "Everything relevant was already shown earlier in this session."],
  [/reranker_unavailable/, "The relevance model wasn't available, so nothing was trusted enough to add."],
  [/empty_prompt/, "The prompt was empty."],
  [/disabled/, "Automatic memory is turned off in the settings."],
  [/nothing passed the gate/, "Memories were found, but none were solid enough to add."],
];

/** One-line human explanation of a recall decision. */
export function decisionSentence(
  decision: string,
  reason: string,
  memories: number,
  tokens: number
): string {
  if (decision === "inject") {
    const what = memories === 1 ? "1 memory" : `${memories} memories`;
    return `Added ${what} to Claude's context (${tokens} tokens).`;
  }
  for (const [re, text] of SILENCE_REASONS) {
    if (re.test(reason)) return `Stayed quiet — ${text.toLowerCase()}`;
  }
  return "Stayed quiet — nothing was added.";
}

/** Proposal action ids → headline + what-it-means + the question. */
export type ActionCopy = {
  headline: string;
  meaning: string;
  /** The proposed change, in plain English (never raw field names). */
  proposedChange?: string;
  question: string;
  ifApproved: string;
  /** True when approving EXECUTES a change today; false when the
   *  decision only evaluates the observation (two different action
   *  models in the UI — "Apply change" vs "Accurate"). */
  executable: boolean;
};
const ACTIONS: Record<string, ActionCopy> = {
  working_state_refresh: {
    headline: "Your project state may be out of date",
    meaning:
      "This session completed meaningful work, but the state NeuroVault uses when you say “continue” was not refreshed.",
    proposedChange: "Mark this project's working state as needing an update.",
    question: "Is this observation accurate?",
    ifApproved:
      "Your answer evaluates this rule — no memory changes today. NeuroVault will not invent the missing task, files or next step.",
    executable: false,
  },
  memory_strengthened: {
    headline: "This memory proved itself useful",
    meaning:
      "A task linked to this memory was completed — real evidence the memory matters.",
    proposedChange: "Mark the memory as confirmed by use, which keeps it fresher for longer.",
    question: "Apply this change?",
    ifApproved: "Applying this updates the memory's “last confirmed” date. Nothing else changes, and it can be reversed.",
    executable: true,
  },
  supersession_suggestion: {
    headline: "These two notes might be duplicates",
    meaning:
      "Two notes with nearly identical titles live in the same folder. The newer one may have replaced the older one without saying so.",
    proposedChange: "Mark the older note as replaced by the newer one.",
    question: "Apply this change?",
    ifApproved:
      "Applying this stops the older note appearing in automatic recall. The note itself is untouched and can be restored.",
    executable: true,
  },
  room_summary_refresh: {
    headline: "This folder's summary is falling behind",
    meaning:
      "Quite a few things changed in this folder recently, so its overview summary is probably stale.",
    proposedChange: "Flag this folder's summary for a refresh.",
    question: "Is this observation accurate?",
    ifApproved:
      "Your answer evaluates this rule — no memory changes today. Nothing is rewritten; the summariser isn't built yet.",
    executable: false,
  },

  // ---- Local Memory Curator (implementation guide §6.6) -----------------
  // A model on this Mac proposes, a deterministic Rust gauntlet verifies,
  // you decide. In V1 approving records the verdict and NOTHING else: these
  // action ids have no executor arm in `proposal_approve`, and their
  // proposals are stored `application_status: not_applicable`. So
  // `executable: false` is a fact about the backend, not a UI softener —
  // when the note-writing executor lands (post-V1) this copy flips with it.
  curator_remember_decision: {
    headline: "Your session recorded a decision",
    meaning:
      "A model running on this Mac read one turn of a Claude Code session and thinks you decided something durable. It was only allowed to point at sentences — NeuroVault read those sentences itself and checked every number, date and name against your transcript before showing you this.",
    proposedChange: "Remember this decision, in the words your own transcript used.",
    question: "Is this accurate?",
    ifApproved:
      "Your answer records a verdict — no memory is written today. NeuroVault does not create the note yet; that step is separate, and it will be its own opt-in.",
    executable: false,
  },
  curator_remember_fact: {
    headline: "Your session recorded a fact",
    meaning:
      "A model running on this Mac read one turn of a Claude Code session and found a fact worth keeping. It was only allowed to point at sentences — NeuroVault read those sentences itself and checked every number, date and name against your transcript before showing you this.",
    proposedChange: "Remember this fact, in the words your own transcript used.",
    question: "Is this accurate?",
    ifApproved:
      "Your answer records a verdict — no memory is written today. NeuroVault does not create the note yet; that step is separate, and it will be its own opt-in.",
    executable: false,
  },
  curator_remember_preference: {
    headline: "Your session recorded a preference",
    meaning:
      "A model running on this Mac read one turn of a Claude Code session and thinks you stated a standing preference. It was only allowed to point at sentences — NeuroVault read those sentences itself and checked every number, date and name against your transcript before showing you this.",
    proposedChange: "Remember this preference, in the words your own transcript used.",
    question: "Is this accurate?",
    ifApproved:
      "Your answer records a verdict — no memory is written today. NeuroVault does not create the note yet; that step is separate, and it will be its own opt-in.",
    executable: false,
  },
};

/** The three local-curator action ids. */
export const CURATOR_ACTIONS = [
  "curator_remember_decision",
  "curator_remember_fact",
  "curator_remember_preference",
] as const;
export const isCuratorAction = (action: string): boolean =>
  (CURATOR_ACTIONS as readonly string[]).includes(action);

export const actionCopy = (action: string): ActionCopy =>
  ACTIONS[action] ?? {
    headline: humanize(action),
    meaning: "NeuroVault noticed a pattern in your recent activity.",
    question: "Is this observation accurate?",
    ifApproved: "Your answer evaluates this rule — no memory changes today.",
    executable: false,
  };

/** Only executable proposals deserve the urgent "Needs attention" label.
 * Accuracy-only observations remain reviewable learning checks, but they do
 * not imply that the user's memory is at risk or waiting on a change. */
const ACCURACY_ONLY_ACTIONS = new Set(["working_state_refresh", "room_summary_refresh"]);
export const proposalNeedsAttention = (action: string): boolean =>
  !ACCURACY_ONLY_ACTIONS.has(action);

/** Review-status chips. */
export const reviewLabel = (s: string): string =>
  ({
    unreviewed: "waiting for you",
    approved: "you said yes",
    edited: "you corrected it",
    rejected: "you said no",
  })[s] ?? humanize(s);

/** Application-status chips (independent from the review verdict). */
export const applicationLabel = (s: string): string =>
  ({
    pending: "changes nothing yet",
    applied: "change applied",
    failed: "couldn't apply (your verdict stands)",
    not_applicable: "informational only",
  })[s] ?? humanize(s);

export const bandLabel = (b: string): string =>
  ({ high: "high confidence", medium: "medium confidence", low: "low confidence" })[b] ??
  humanize(b);

/** Journal event → a sentence for the "What happened" timeline. */
export function eventSentence(e: {
  event_type: string;
  title?: string | null;
  before?: string | null;
  after?: string | null;
  session_id?: string | null;
}): string {
  const t = e.title ? `“${e.title}”` : "";
  switch (e.event_type) {
    case "context_decision": {
      const a = e.after ?? "";
      if (a.startsWith("inject")) return `A prompt came in — NeuroVault added memories (${a.replace("inject ", "")})`;
      return "A prompt came in — NeuroVault stayed quiet";
    }
    case "assistant_response_completed":
      return "Claude finished its reply";
    case "session_ended": {
      const cwd = e.after?.replace("cwd: ", "");
      const proj = cwd ? cwd.split("/").filter(Boolean).pop() : null;
      return proj ? `The session ended (project: ${proj})` : "The session ended";
    }
    case "session_started":
      return "A session started";
    case "task_created":
      return `New task: ${t}`;
    case "task_completed":
      return `Task completed: ${t}`;
    case "note_created":
      return `New note: ${t}`;
    case "note_updated":
      return `Note edited: ${t}`;
    case "note_superseded":
      return `Note marked as replaced: ${t}`;
    case "playbook_rule_added":
      return `You corrected Claude — saved as a standing rule ${t}`;
    case "working_state_updated":
      return `The “what I'm doing” snapshot was updated${e.after ? ` (${e.after})` : ""}`;
    default:
      return `${humanize(e.event_type)}${t ? ` ${t}` : ""}`;
  }
}

/** Human memory-type names for the context row. */
export const memoryTypeLabel = (t: string): string =>
  ({
    working_state: "Working state",
    engram: "Saved memory",
    room_summary: "Folder summary",
  })[t] ?? humanize(t);

/** Human labels for proposed-field names (edit mode / details). */
export const fieldLabel = (name: string): string =>
  ({
    needs_refresh: "Needs an update?",
    last_confirmed_at: "Last confirmed",
    superseded_engram: "Older note",
    superseded_by: "Replaced by",
    refresh: "Refresh the summary?",
  })[name] ?? humanize(name);

/** Relative time — "just now", "3h ago", "yesterday at 15:08", date. */
export function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  const now = Date.now();
  const mins = Math.floor((now - t) / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (hours < 24 && d.getDate() === new Date().getDate()) return `today at ${hhmm}`;
  const yesterday = new Date(now - 86400000);
  if (d.getDate() === yesterday.getDate() && now - t < 2 * 86400000) return `yesterday at ${hhmm}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${hhmm}`;
}

/** Pull a human project name out of evidence events (session cwd). */
export function projectFromEvents(
  events: Array<{ event_type: string; after?: string | null }>
): string | null {
  for (const e of events) {
    if (e.event_type === "session_ended" && e.after?.startsWith("cwd: ")) {
      const seg = e.after.replace("cwd: ", "").split("/").filter(Boolean).pop();
      if (seg) return seg.trim();
    }
  }
  return null;
}

/** Rejection reasons — a menu beats free text for label quality. */
export const REJECT_REASONS = [
  "Not meaningful work",
  "Already up to date",
  "Wrong project",
  "Incorrect observation",
  "Duplicate",
  "Other",
] as const;

/** Tab explainers — one paragraph a stranger can read. */
export const TRACE_EXPLAINER =
  "Every time you talk to Claude, NeuroVault quietly decides whether any of your saved memories would help — and adds them to the conversation if they're relevant enough. This page is that decision log: what was added, what wasn't, and why. Staying quiet on purpose is normal and healthy.";

export const PROPOSALS_EXPLAINER =
  "NeuroVault watches what happens across your sessions and sometimes thinks it has learned something — but it never trusts itself without asking you first. Each card below is one suggestion with the evidence behind it. Your yes/no answers are how it earns (or loses) the right to act on its own later.";

// ---------------------------------------------------------------------------
// Local Memory Curator — the plain-language layer for receipts
//
// The gauntlet's vocabulary (gate ids, reject/defer/review codes, source
// roles) is precise and completely opaque to a human. Same rule as the rest
// of this file: lead with a sentence a stranger understands, keep the raw id
// visible but secondary, and never crash on an id this build hasn't met.
// ---------------------------------------------------------------------------

/** The thirteen gates, in execution order (Rust: `gates::GateName`). */
export const CURATOR_GATE_ORDER = [
  "g00_validate_output_envelope",
  "g01_resolve_allowed_object",
  "g02_resolve_allowed_evidence",
  "g03_enforce_action_field_contract",
  "g04_enforce_scope_and_source_policy",
  "g05_enforce_atomic_claim",
  "g06_verify_lexical_integrity",
  "g07_verify_attribution_binding",
  "g08_verify_polarity_modality_and_time",
  "g09_screen_sensitive_content",
  "g10_score_entailment",
  "g11_check_existing_state",
  "g12_derive_disposition",
] as const;

const CURATOR_GATE_LABELS: Record<string, string> = {
  g00_validate_output_envelope: "The answer had the shape we demanded",
  g01_resolve_allowed_object: "It aimed at this vault and nothing else",
  g02_resolve_allowed_evidence: "Every cited sentence really exists in your transcript",
  g03_enforce_action_field_contract: "The fields stayed inside their limits",
  g04_enforce_scope_and_source_policy: "The claimed speaker matches who actually spoke",
  g05_enforce_atomic_claim: "One claim, not several bundled together",
  g06_verify_lexical_integrity: "No number, date or name was altered",
  g07_verify_attribution_binding: "Who did what was read the right way round",
  g08_verify_polarity_modality_and_time: "Not / maybe / already-done survived intact",
  g09_screen_sensitive_content: "Nothing secret-looking made it through",
  g10_score_entailment: "Second-opinion entailment check",
  g11_check_existing_state: "Not already saved, not something you rejected before",
  g12_derive_disposition: "Final verdict",
};
export const curatorGateLabel = (gate: string): string =>
  CURATOR_GATE_LABELS[gate] ?? humanize(gate);

/** "g06_verify_lexical_integrity" → "G06" (the chip's compact tag). */
export const curatorGateTag = (gate: string): string => {
  const m = /^g(\d{2})_/.exec(gate);
  return m ? `G${m[1]}` : gate.slice(0, 3).toUpperCase();
};

/** Gate outcomes (Rust: `receipts::GateOutcome`). */
export const curatorOutcomeLabel = (effect: string): string =>
  ({
    pass: "passed",
    not_run: "not run",
    no_op: "nothing to do",
    reject: "rejected",
    defer: "deferred",
    require_review: "flagged for you",
  })[effect] ?? humanize(effect);

/** Closed reject / defer / review / no-op codes → one human clause. */
const CURATOR_CODES: Record<string, string> = {
  // rejects
  invalid_envelope: "the model's answer didn't parse",
  object_out_of_scope: "it pointed at something outside this vault",
  invalid_evidence: "a cited sentence didn't resolve",
  invalid_field_contract: "a field broke its contract",
  private_evidence: "the evidence was private",
  provenance_violation: "that source isn't allowed to carry this kind of claim",
  not_extractive: "the claim wasn't covered by the sentences it cited",
  literal_mismatch: "a number, date or name didn't match the transcript",
  attribution_mismatch: "who said or did what didn't line up",
  semantic_state_mismatch: "a negation, a maybe, or the tense drifted",
  sensitive_output: "the text looked like a credential or secret",
  // defers
  object_unavailable: "the target wasn't available",
  evidence_unavailable: "the transcript couldn't be re-read",
  incomplete_turn: "the turn wasn't finished",
  provider_unavailable: "the local model wasn't reachable",
  provider_timeout: "the local model took too long",
  verifier_unavailable: "a verifier wasn't available",
  // review flags
  weak_provenance: "the source is weaker than the claim",
  synthesis: "it combined more than one sentence",
  oversized_evidence: "it leaned on a lot of text",
  alias_or_paraphrase: "it used a synonym rather than your words",
  ambiguous_attribution: "who it belongs to is ambiguous",
  complex_semantics: "the sentence is semantically tricky",
  nli_contradiction: "a second opinion read it as contradicted",
  nli_uncertain: "a second opinion wasn't sure",
  conflict: "it conflicts with something you already have",
  destructive_action: "the action would destroy something",
  policy_requires_review: "this class always comes to you",
  // no-ops
  exact_duplicate: "you already have this",
  rejected_evidence_tombstone: "you rejected this evidence before",
};
export const curatorCodeLabel = (code: string): string =>
  CURATOR_CODES[code] ?? humanize(code);

/** Who a span came from (Rust: `receipts::SourceRole`). */
export const curatorRoleLabel = (role: string): string =>
  ({
    user: "you",
    assistant: "Claude",
    tool_result: "a tool result",
    file_content: "a file",
    web_content: "a web page",
    system_event: "a system event",
  })[role] ?? humanize(role);

/** The claim class the gauntlet assigned. */
export const curatorClassLabel = (claimClass: string): string =>
  ({ decision: "decision", fact: "fact", preference: "preference" })[claimClass] ??
  humanize(claimClass);

/** G10 is recorded as `not_run` in V1 — recorded, never silently skipped. */
export const CURATOR_G10_NOT_RUN_NOTE =
  "The entailment second opinion isn't part of this version. It is recorded as not run rather than quietly skipped.";

/** The span panel's defer state. The transcript is re-opened and re-hashed
 *  every time you look; if the file moved on, NeuroVault shows nothing
 *  rather than newer bytes it never verified. */
export const CURATOR_EVIDENCE_UNAVAILABLE =
  "Transcript changed since capture — evidence can no longer be shown. NeuroVault re-reads the original file to quote it and refuses to show bytes it didn't verify, so there is nothing safe to display here. If you can't verify it from memory, reject it.";

/** `SpanPreview.code` → why there is nothing to show. Every branch says what
 *  is missing and what the user can do; none of them blames the user. */
export const curatorPreviewUnavailable = (code?: string | null): string => {
  switch (code) {
    case "consent_revoked":
      return "Transcript access is off, so NeuroVault can't re-open the file to quote it. Turn it back on in Settings if you want to see the evidence — the proposal itself is unaffected.";
    case "platform_unsupported":
      return "Re-reading transcripts isn't supported on this platform yet, so the exact words can't be shown here.";
    case "not_a_curator_proposal":
      return "This proposal has no transcript evidence attached.";
    default:
      return CURATOR_EVIDENCE_UNAVAILABLE;
  }
};

/** A span whose bytes no longer hash to what was verified. Shown, never
 *  hidden: the file drifted under a still-valid prefix. */
export const CURATOR_SPAN_DIGEST_DRIFT =
  "these bytes no longer match what was verified — read them with suspicion";

/** Shown while the sentences are being re-read from disk. */
export const CURATOR_EVIDENCE_LOADING = "Re-reading your transcript…";
