//! ContextRecipe registry — intent → sections (spec §6).
//!
//! Data-driven like the MCP tool registry: a table, not a trait
//! forest. Each intent maps to ordered sections; each section names
//! its retrieval source and caps. `general_question` deliberately has
//! NO recipe here — it falls through to the unmodified Ambient Recall
//! pipeline, which is what guarantees this layer can never regress
//! shipped behavior.

use super::types::RecallIntent;

/// Where a section's items come from (V1a sources only; RoomSummary
/// and People land with V1b/V1c per the spec phasing).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SectionSource {
    /// O(1) read of the per-scope working-state buffer. Never touches
    /// retrieval; gated by freshness, not relevance.
    WorkingState,
    /// Open todos/handoffs view (todos.jsonl). Structural, no CE gate.
    OpenTasks,
    /// Semantic recall filtered to `kind:decision`.
    Decisions,
    /// Semantic recall filtered to `kind:preference` (the ingest
    /// pipeline already derives preference engrams; typed playbook
    /// notes join them via their `Preference:` body line).
    PlaybookRules,
    /// Semantic recall filtered to `kind:source`.
    Sources,
    /// Unfiltered semantic recall (what ambient does today).
    Semantic,
    /// Semantic recall constrained to `after:<now - window_days>`.
    RecentChanges { window_days: u16 },
}

#[derive(Debug, Clone, Copy)]
pub struct SectionSpec {
    /// Section heading in the packet ("Relevant decisions").
    pub title: &'static str,
    pub source: SectionSource,
    pub max_items: usize,
    /// CE-floor override. `None` = the recipe's gate floor.
    /// `Some(0.0)` marks a QUOTA section: its items belong because
    /// they're in scope and recent/important ("latest decisions" in a
    /// brief, "recent changes" in a diff), so they order by SALIENCE,
    /// never gate on prompt similarity, and still deliver when the
    /// reranker is down. First live scenario (2026-07-10): the room's
    /// own pricing decision was CE-skipped from its own briefing.
    pub floor: Option<f64>,
}

/// Per-intent gate tuning (spec §7.1). The CE floor applies to
/// semantic sections only; structural sections (WorkingState, tasks)
/// have their own gates (freshness, status).
#[derive(Debug, Clone, Copy)]
pub struct GateProfile {
    /// Absolute CE floor for semantic sections under this intent.
    pub ce_floor: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct ContextRecipe {
    pub intent: RecallIntent,
    pub sections: &'static [SectionSpec],
    pub token_budget: usize,
    pub gate: GateProfile,
}

/// The V1a registry. Section order == packet order. Budgets are the
/// spec §14 defaults; calibrate with `ambient test` like the gate was.
pub const RECIPES: &[ContextRecipe] = &[
    ContextRecipe {
        intent: RecallIntent::ContinueWork,
        sections: &[
            SectionSpec {
                title: "Current situation",
                source: SectionSource::WorkingState,
                max_items: 1,
                floor: None,
            },
            SectionSpec {
                title: "Open tasks",
                source: SectionSource::OpenTasks,
                max_items: 3,
                floor: None,
            },
        ],
        token_budget: 400,
        // No semantic sections; floor unused but kept sane.
        gate: GateProfile { ce_floor: 0.60 },
    },
    ContextRecipe {
        intent: RecallIntent::PrepareBrief,
        sections: &[
            SectionSpec {
                title: "Current situation",
                source: SectionSource::WorkingState,
                max_items: 1,
                floor: None,
            },
            SectionSpec {
                title: "Relevant decisions",
                source: SectionSource::Decisions,
                max_items: 3,
                floor: Some(0.0),
            },
            SectionSpec {
                title: "Open tasks",
                source: SectionSource::OpenTasks,
                max_items: 5,
                floor: None,
            },
            SectionSpec {
                title: "Playbook rules",
                source: SectionSource::PlaybookRules,
                max_items: 3,
                floor: None,
            },
            SectionSpec {
                title: "Background",
                source: SectionSource::Semantic,
                max_items: 3,
                floor: None,
            },
        ],
        token_budget: 900,
        gate: GateProfile { ce_floor: 0.50 },
    },
    ContextRecipe {
        intent: RecallIntent::DraftOutput,
        sections: &[
            SectionSpec {
                title: "Playbook rules",
                source: SectionSource::PlaybookRules,
                max_items: 4,
                floor: None,
            },
            SectionSpec {
                title: "Relevant decisions",
                source: SectionSource::Decisions,
                max_items: 2,
                floor: Some(0.0),
            },
            SectionSpec {
                title: "Background",
                source: SectionSource::Semantic,
                max_items: 3,
                floor: None,
            },
        ],
        token_budget: 700,
        gate: GateProfile { ce_floor: 0.50 },
    },
    ContextRecipe {
        intent: RecallIntent::ReviewRisks,
        sections: &[
            SectionSpec {
                title: "Open tasks and blockers",
                source: SectionSource::OpenTasks,
                max_items: 5,
                floor: None,
            },
            SectionSpec {
                title: "Relevant decisions",
                source: SectionSource::Decisions,
                max_items: 3,
                floor: Some(0.0),
            },
            SectionSpec {
                title: "Playbook rules",
                source: SectionSource::PlaybookRules,
                max_items: 2,
                floor: None,
            },
            SectionSpec {
                title: "Background",
                source: SectionSource::Semantic,
                max_items: 3,
                floor: None,
            },
        ],
        token_budget: 700,
        gate: GateProfile { ce_floor: 0.50 },
    },
    ContextRecipe {
        intent: RecallIntent::ExplainDecision,
        sections: &[
            SectionSpec {
                title: "Decisions",
                source: SectionSource::Decisions,
                max_items: 4,
                floor: None,
            },
            SectionSpec {
                title: "Sources",
                source: SectionSource::Sources,
                max_items: 3,
                floor: None,
            },
        ],
        token_budget: 700,
        gate: GateProfile { ce_floor: 0.45 },
    },
    ContextRecipe {
        intent: RecallIntent::FindSource,
        sections: &[SectionSpec {
            title: "Sources",
            source: SectionSource::Sources,
            max_items: 5,
            floor: None,
        }],
        token_budget: 700,
        // Exact-evidence lookups tolerate a lower floor; strong-match
        // relief (existing gate rule) lowers it further on verbatim hits.
        gate: GateProfile { ce_floor: 0.35 },
    },
    ContextRecipe {
        intent: RecallIntent::TemporalDiff,
        sections: &[
            SectionSpec {
                title: "Recent changes",
                source: SectionSource::RecentChanges { window_days: 7 },
                max_items: 6,
                floor: Some(0.0),
            },
            SectionSpec {
                title: "Open tasks",
                source: SectionSource::OpenTasks,
                max_items: 4,
                floor: None,
            },
        ],
        token_budget: 700,
        gate: GateProfile { ce_floor: 0.40 },
    },
];

/// Recipe lookup. `GeneralQuestion` (and anything unknown) returns
/// None — callers fall through to the classic ambient pipeline.
pub fn recipe_for(intent: RecallIntent) -> Option<&'static ContextRecipe> {
    RECIPES.iter().find(|r| r.intent == intent)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_is_complete_and_sane() {
        // Every intent except the fallback has a recipe…
        for i in [
            RecallIntent::ContinueWork,
            RecallIntent::PrepareBrief,
            RecallIntent::DraftOutput,
            RecallIntent::ReviewRisks,
            RecallIntent::ExplainDecision,
            RecallIntent::FindSource,
            RecallIntent::TemporalDiff,
        ] {
            let r = recipe_for(i).unwrap_or_else(|| panic!("{i:?} has no recipe"));
            assert!(!r.sections.is_empty());
            assert!(r.token_budget >= 200 && r.token_budget <= 2000);
            assert!(r.gate.ce_floor >= 0.3 && r.gate.ce_floor <= 0.8);
            for s in r.sections {
                assert!(s.max_items >= 1 && s.max_items <= 8);
            }
        }
        // …and the fallback deliberately has none.
        assert!(recipe_for(RecallIntent::GeneralQuestion).is_none());
    }

    #[test]
    fn continue_work_never_touches_semantic_retrieval() {
        let r = recipe_for(RecallIntent::ContinueWork).unwrap();
        assert!(r.sections.iter().all(|s| matches!(
            s.source,
            SectionSource::WorkingState | SectionSource::OpenTasks
        )));
    }
}
