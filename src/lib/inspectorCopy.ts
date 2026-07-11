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
  question: string;
  ifApproved: string;
};
const ACTIONS: Record<string, ActionCopy> = {
  working_state_refresh: {
    headline: "Your “continue” snapshot looks out of date",
    meaning:
      "A session did real work and ended, but the little note NeuroVault keeps about “what you were doing” was never updated. If you type “continue”, it would recall older work instead of this session's.",
    question: "Is that a fair observation?",
    ifApproved:
      "Nothing changes yet — NeuroVault can't safely read what the session did until the transcript reader ships. Your answer just teaches it whether this kind of observation is useful.",
  },
  memory_strengthened: {
    headline: "This memory proved itself useful",
    meaning:
      "A task linked to this memory was completed. That's real evidence the memory matters, so NeuroVault wants to mark it as “confirmed by use” (which keeps it fresher for longer).",
    question: "Should it be marked as confirmed?",
    ifApproved: "The memory's “last confirmed” date is updated. Nothing else changes.",
  },
  supersession_suggestion: {
    headline: "These two notes might be duplicates",
    meaning:
      "Two notes with nearly identical titles live in the same folder. The newer one may have replaced the older one without saying so.",
    question: "Should the older note be marked as replaced by the newer one?",
    ifApproved:
      "The older note is marked “replaced” and stops appearing in automatic recall. The note itself is untouched and can be restored.",
  },
  room_summary_refresh: {
    headline: "This folder's summary is falling behind",
    meaning:
      "Quite a few things changed in this folder recently, so its overview summary is probably stale.",
    question: "Would a refreshed summary be worth it?",
    ifApproved:
      "Nothing changes yet — the summariser isn't built. Your answer teaches NeuroVault whether these nudges are wanted.",
  },
};
export const actionCopy = (action: string): ActionCopy =>
  ACTIONS[action] ?? {
    headline: humanize(action),
    meaning: "NeuroVault noticed a pattern in your recent activity.",
    question: "Is this observation right?",
    ifApproved: "Your answer is recorded as feedback.",
  };

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

/** Tab explainers — one paragraph a stranger can read. */
export const TRACE_EXPLAINER =
  "Every time you talk to Claude, NeuroVault quietly decides whether any of your saved memories would help — and adds them to the conversation if they're relevant enough. This page is that decision log: what was added, what wasn't, and why. Staying quiet on purpose is normal and healthy.";

export const PROPOSALS_EXPLAINER =
  "NeuroVault watches what happens across your sessions and sometimes thinks it has learned something — but it never trusts itself without asking you first. Each card below is one suggestion with the evidence behind it. Your yes/no answers are how it earns (or loses) the right to act on its own later.";
