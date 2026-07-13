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
};
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
