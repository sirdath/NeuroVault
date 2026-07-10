//! MemoryRouter — classify a prompt into a recall intent (spec §4).
//!
//! v1 is deliberately RULES-FIRST: an ordered pattern table,
//! first-match-wins, zero-LLM, sub-microsecond. The IDF lesson
//! (2026-07-07) applies here too: for a bounded vocabulary of
//! trigger phrases, a curated table beats clever statistics — and it
//! is debuggable ("reason" names the exact pattern that fired).
//!
//! An `IntentClassifier` trait leaves the seam for a cheap-LLM
//! fallback on the ambiguous band later (v2); the router must NEVER
//! block on an LLM in the hook path.

use super::types::RecallIntent;
use super::Scope;

/// Everything the router may consider. Cheap to build: the one
/// filesystem touch (WorkingState freshness) is a single stat/read
/// the caller already needed.
#[derive(Debug, Clone)]
pub struct RouterInput<'a> {
    pub prompt: &'a str,
    pub scope: &'a Scope,
    pub agent_id: Option<&'a str>,
    pub host: Option<&'a str>,
    /// Is there a fresh WorkingState for this scope? Gates whether
    /// "continue" is answerable at all.
    pub working_state_fresh: bool,
}

/// Router verdict. `confidence` is rule strength (1.0 = exact phrase
/// hit, 0.75 = strong pattern, 0.5 = weak/fallback); the recipe layer
/// may use it later to decide when an LLM fallback is worth asking.
#[derive(Debug, Clone)]
pub struct RouterOutput {
    pub intent: RecallIntent,
    pub confidence: f64,
    pub reason: String,
}

/// Extensibility seam for v2's cheap-judge classifier. Impl #1 is the
/// rules table below.
pub trait IntentClassifier: Send + Sync {
    fn classify(&self, input: &RouterInput) -> Option<RouterOutput>;
}

/// One row of the rules table: any `phrases` substring hit fires the
/// intent (phrases are lowercase; prompt is lowercased once).
struct Rule {
    intent: RecallIntent,
    confidence: f64,
    phrases: &'static [&'static str],
}

/// Ordered, first-match-wins. Order is load-bearing: more specific
/// intents come before broader ones (e.g. "why did we decide" must
/// beat DraftOutput's "write the" when both appear, so
/// ExplainDecision sits earlier than DraftOutput; ContinueWork is
/// first because its phrases are pure glue everywhere else).
const RULES: &[Rule] = &[
    Rule {
        intent: RecallIntent::ContinueWork,
        confidence: 1.0,
        phrases: &[
            "continue",
            "what was i doing",
            "what was i working on",
            "pick up where",
            "where were we",
            "where did we leave off",
            "resume",
            "keep going",
        ],
    },
    Rule {
        intent: RecallIntent::ExplainDecision,
        confidence: 0.9,
        phrases: &[
            "why did we",
            "why did i",
            "what was the rationale",
            "what was the reasoning",
            "who decided",
            "why was it decided",
            "why do we use",
            "what led to the decision",
        ],
    },
    Rule {
        intent: RecallIntent::FindSource,
        confidence: 0.9,
        phrases: &[
            "where did this number",
            "where did that number",
            "number come from",
            "figure come from",
            "percent come from",
            "where is this from",
            "what's the source",
            "whats the source",
            "where does this come from",
            "where did this come from",
            "what source",
            "which source",
            "show me the evidence",
            "show the evidence",
            "what supports this",
            "citation for",
            "cite the source",
        ],
    },
    Rule {
        intent: RecallIntent::TemporalDiff,
        confidence: 0.9,
        phrases: &[
            "what changed since",
            "what has changed",
            "what changed",
            "what's new since",
            "whats new since",
            "what is new this week",
            "since yesterday",
            "since last week",
            "since the last meeting",
            "since our last",
        ],
    },
    Rule {
        intent: RecallIntent::PrepareBrief,
        confidence: 0.85,
        phrases: &[
            "prepare me for",
            "prep me for",
            "brief me",
            "briefing for",
            "steering committee brief",
            "before the meeting",
            "before tomorrow's meeting",
            "summarize what matters",
            "get me up to speed",
            "catch me up on",
        ],
    },
    Rule {
        intent: RecallIntent::ReviewRisks,
        confidence: 0.85,
        phrases: &[
            "what are the risks",
            "what could go wrong",
            "review this for weak",
            "weak claims",
            "poke holes",
            "risk review",
            "what are we missing",
            "devil's advocate",
        ],
    },
    Rule {
        intent: RecallIntent::DraftOutput,
        confidence: 0.75,
        phrases: &[
            "draft the",
            "draft a",
            "draft an",
            "write the email",
            "write an email",
            "write the proposal",
            "write the summary",
            "compose the",
            "create the executive summary",
            "write the follow-up",
            "draft the follow-up",
        ],
    },
];

/// The v1 rules classifier.
pub struct RulesClassifier;

impl IntentClassifier for RulesClassifier {
    fn classify(&self, input: &RouterInput) -> Option<RouterOutput> {
        let lc = input.prompt.trim().to_lowercase();
        if lc.is_empty() {
            return None;
        }
        for rule in RULES {
            if let Some(hit) = rule.phrases.iter().find(|p| lc.contains(*p)) {
                // ContinueWork is only answerable with a fresh
                // WorkingState — otherwise these phrases are the same
                // glue the ambient pre-gate suppresses today, and the
                // right verdict is the fallback (which will stay
                // silent for pure glue). This keeps "continue" from
                // injecting stale or empty state.
                if rule.intent == RecallIntent::ContinueWork && !input.working_state_fresh {
                    return Some(RouterOutput {
                        intent: RecallIntent::GeneralQuestion,
                        confidence: 0.5,
                        reason: format!(
                            "matched '{hit}' (continue_work) but no fresh working state; fell back"
                        ),
                    });
                }
                // Guard: "continue" matching must be word-ish for the
                // single-word triggers, so "continuous integration"
                // doesn't route to ContinueWork. Substrings that are
                // full phrases (contain a space) are safe as-is.
                if !hit.contains(' ') && !word_hit(&lc, hit) {
                    continue;
                }
                return Some(RouterOutput {
                    intent: rule.intent,
                    confidence: rule.confidence,
                    reason: format!("matched '{hit}'"),
                });
            }
        }
        Some(RouterOutput {
            intent: RecallIntent::GeneralQuestion,
            confidence: 0.5,
            reason: "no intent pattern matched; general_question fallback".into(),
        })
    }
}

/// Whole-word containment for single-word triggers ("resume",
/// "continue"): the char before/after the hit must not be alphanumeric.
fn word_hit(haystack: &str, word: &str) -> bool {
    let mut start = 0;
    while let Some(pos) = haystack[start..].find(word) {
        let abs = start + pos;
        let before_ok = abs == 0
            || !haystack[..abs]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_alphanumeric());
        let after_ok = !haystack[abs + word.len()..]
            .chars()
            .next()
            .is_some_and(|c| c.is_alphanumeric());
        if before_ok && after_ok {
            return true;
        }
        start = abs + word.len();
        if start >= haystack.len() {
            break;
        }
    }
    false
}

/// Route a prompt: the public entry point (rules only in v1).
pub fn route(input: &RouterInput) -> RouterOutput {
    RulesClassifier
        .classify(input)
        .unwrap_or_else(|| RouterOutput {
            intent: RecallIntent::GeneralQuestion,
            confidence: 0.5,
            reason: "empty prompt; fallback".into(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input<'a>(prompt: &'a str, scope: &'a Scope, ws_fresh: bool) -> RouterInput<'a> {
        RouterInput {
            prompt,
            scope,
            agent_id: None,
            host: Some("test"),
            working_state_fresh: ws_fresh,
        }
    }

    #[test]
    fn continue_routes_to_working_state_when_fresh() {
        let s = Scope::brain("b");
        let out = route(&input("continue", &s, true));
        assert_eq!(out.intent, RecallIntent::ContinueWork);
        assert_eq!(out.confidence, 1.0);
        let out = route(&input("ok pick up where we left off", &s, true));
        assert_eq!(out.intent, RecallIntent::ContinueWork);
    }

    #[test]
    fn continue_without_fresh_state_falls_back() {
        let s = Scope::brain("b");
        let out = route(&input("continue", &s, false));
        assert_eq!(out.intent, RecallIntent::GeneralQuestion);
        assert!(out.reason.contains("no fresh working state"));
    }

    #[test]
    fn continuous_integration_is_not_continue() {
        let s = Scope::brain("b");
        let out = route(&input(
            "set up continuous integration for the repo",
            &s,
            true,
        ));
        assert_ne!(out.intent, RecallIntent::ContinueWork);
    }

    #[test]
    fn each_intent_has_a_live_trigger() {
        let s = Scope::brain("b");
        let cases = [
            (
                "why did we decide on usage based pricing",
                RecallIntent::ExplainDecision,
            ),
            ("where did this number come from", RecallIntent::FindSource),
            (
                "where did the 21 percent number come from",
                RecallIntent::FindSource,
            ),
            (
                "what changed since the last meeting",
                RecallIntent::TemporalDiff,
            ),
            (
                "prepare me for the client meeting",
                RecallIntent::PrepareBrief,
            ),
            ("what are the risks in this plan", RecallIntent::ReviewRisks),
            (
                "draft the follow-up email to elena",
                RecallIntent::DraftOutput,
            ),
            (
                "how does the reranker fuse scores",
                RecallIntent::GeneralQuestion,
            ),
        ];
        for (prompt, want) in cases {
            let got = route(&input(prompt, &s, true));
            assert_eq!(got.intent, want, "prompt: {prompt} -> {:?}", got);
        }
    }

    #[test]
    fn specific_intents_beat_draft_when_both_present() {
        let s = Scope::brain("b");
        // "write the summary" + "why did we" -> ExplainDecision (earlier rule)
        let out = route(&input(
            "write the summary of why did we decide this",
            &s,
            true,
        ));
        assert_eq!(out.intent, RecallIntent::ExplainDecision);
    }
}
