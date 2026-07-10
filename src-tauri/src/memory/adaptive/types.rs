//! Typed memory shapes — V1a: WorkingState + PlaybookRule.
//!
//! Storage principle (spec §3.1): a typed memory is a markdown note
//! whose YAML frontmatter carries the shape; typed tables are
//! rebuildable mirrors. WorkingState is the ONE exception (like
//! todos.jsonl): it is ephemeral *state*, not knowledge, so it lives
//! as a per-scope JSON file under the brain dir and never pollutes
//! the vault.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use super::Scope;
use crate::memory::types::MemoryError;

type Result<T> = std::result::Result<T, MemoryError>;

/// The eight recall intents (spec §4). `GeneralQuestion` is the
/// fallback and maps to the unmodified Ambient Recall pipeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecallIntent {
    ContinueWork,
    PrepareBrief,
    DraftOutput,
    ReviewRisks,
    ExplainDecision,
    FindSource,
    TemporalDiff,
    GeneralQuestion,
}

impl RecallIntent {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ContinueWork => "continue_work",
            Self::PrepareBrief => "prepare_brief",
            Self::DraftOutput => "draft_output",
            Self::ReviewRisks => "review_risks",
            Self::ExplainDecision => "explain_decision",
            Self::FindSource => "find_source",
            Self::TemporalDiff => "temporal_diff",
            Self::GeneralQuestion => "general_question",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "continue_work" => Self::ContinueWork,
            "prepare_brief" => Self::PrepareBrief,
            "draft_output" => Self::DraftOutput,
            "review_risks" => Self::ReviewRisks,
            "explain_decision" => Self::ExplainDecision,
            "find_source" => Self::FindSource,
            "temporal_diff" => Self::TemporalDiff,
            "general_question" => Self::GeneralQuestion,
            _ => return None,
        })
    }
}

// ---------------------------------------------------------------------------
// WorkingState — the hot buffer behind "continue" (spec §3.2.3)
// ---------------------------------------------------------------------------

/// Considered stale after this many hours; stale state is FLAGGED in
/// the packet ("updated 3 days ago — may be stale"), never silently
/// injected as current (spec: its gate is freshness, not relevance).
pub const WORKING_STATE_STALE_HOURS: i64 = 7 * 24;

/// Per-scope singleton: what's in flight right now. Read in O(1) by
/// `continue_work` — no retrieval, no reranker. Every field optional:
/// partial state is normal.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WorkingState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_task: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub last_files: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_agent_run: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unfinished_draft: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_step: Option<String>,
    /// Which agent last touched this state (claude-code, cursor, app).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_by: Option<String>,
    /// RFC-3339; drives the staleness flag.
    #[serde(default)]
    pub updated_at: Option<String>,
}

impl WorkingState {
    pub fn is_empty(&self) -> bool {
        self.current_task.is_none()
            && self.last_files.is_empty()
            && self.last_agent_run.is_none()
            && self.unfinished_draft.is_none()
            && self.next_step.is_none()
    }

    /// Hours since last update; `None` when never written / unparsable.
    pub fn age_hours(&self, now: OffsetDateTime) -> Option<i64> {
        let raw = self.updated_at.as_deref()?;
        let ts = OffsetDateTime::parse(raw, &Rfc3339).ok()?;
        Some((now - ts).whole_hours())
    }

    pub fn is_stale(&self, now: OffsetDateTime) -> bool {
        match self.age_hours(now) {
            Some(h) => h >= WORKING_STATE_STALE_HOURS,
            None => true,
        }
    }

    /// Merge a partial update: `Some`/non-empty fields overwrite, the
    /// rest survive — so an agent reporting only "next_step" doesn't
    /// wipe the file list. Stamps updated_at/updated_by.
    pub fn apply(&mut self, update: WorkingState, now: OffsetDateTime) {
        if update.current_task.is_some() {
            self.current_task = update.current_task;
        }
        if !update.last_files.is_empty() {
            self.last_files = update.last_files;
        }
        if update.last_agent_run.is_some() {
            self.last_agent_run = update.last_agent_run;
        }
        if update.unfinished_draft.is_some() {
            self.unfinished_draft = update.unfinished_draft;
        }
        if update.next_step.is_some() {
            self.next_step = update.next_step;
        }
        if update.updated_by.is_some() {
            self.updated_by = update.updated_by;
        }
        self.updated_at = now.format(&Rfc3339).ok();
    }
}

/// `~/.neurovault/brains/<id>/working_state/<room-slug>.json`
pub fn working_state_path(scope: &Scope) -> PathBuf {
    crate::memory::paths::nv_home()
        .join("brains")
        .join(&scope.brain_id)
        .join("working_state")
        .join(format!("{}.json", scope.room_slug()))
}

/// Missing/corrupt file → empty state (state is best-effort by
/// nature; an unreadable buffer must never fail a recall).
pub fn load_working_state(scope: &Scope) -> WorkingState {
    load_working_state_at(&working_state_path(scope))
}

pub fn load_working_state_at(path: &std::path::Path) -> WorkingState {
    match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => WorkingState::default(),
    }
}

/// Atomic write (temp + rename) so a concurrent reader never sees a
/// half-written buffer.
pub fn save_working_state(scope: &Scope, state: &WorkingState) -> Result<()> {
    save_working_state_at(&working_state_path(scope), state)
}

pub fn save_working_state_at(path: &std::path::Path, state: &WorkingState) -> Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| MemoryError::Other("working_state path has no parent".into()))?;
    fs::create_dir_all(dir).map_err(|e| MemoryError::Other(format!("create {dir:?}: {e}")))?;
    let raw = serde_json::to_string_pretty(state)
        .map_err(|e| MemoryError::Other(format!("serialize working state: {e}")))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, raw).map_err(|e| MemoryError::Other(format!("write {tmp:?}: {e}")))?;
    fs::rename(&tmp, path).map_err(|e| MemoryError::Other(format!("rename {tmp:?}: {e}")))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// PlaybookRule — reusable rules and preferences (spec §3.2.6)
// ---------------------------------------------------------------------------

/// Where a rule came from. `UserCorrection` is the highest-value
/// capture in the system and defaults importance=high,
/// confidence=high, last_confirmed=now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleSource {
    UserCorrection,
    UserApproval,
    Observed,
    Imported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleCategory {
    Framing,
    Style,
    Process,
    Avoid,
}

/// The shape written into note frontmatter (`nv_type: playbook_rule`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaybookRule {
    pub rule: String,
    /// Room/folder this rule applies to; None = brain-wide.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    pub category: RuleCategory,
    pub source: RuleSource,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub examples: Vec<String>,
    pub importance: String, // low | normal | high
    pub confidence: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_confirmed_at: Option<String>,
}

impl PlaybookRule {
    /// A rule captured from an explicit user correction ("no, don't
    /// frame it as cost-cutting — the client prefers operational
    /// resilience").
    pub fn from_correction(
        rule: impl Into<String>,
        scope: Option<String>,
        now: OffsetDateTime,
    ) -> Self {
        Self {
            rule: rule.into(),
            scope,
            category: RuleCategory::Framing,
            source: RuleSource::UserCorrection,
            examples: Vec::new(),
            importance: "high".into(),
            confidence: 0.95,
            last_confirmed_at: now.format(&Rfc3339).ok(),
        }
    }

    /// Render as a vault note: YAML frontmatter + title + body. The
    /// note goes through the NORMAL write path (markdown canonical);
    /// this only decides its content.
    pub fn to_markdown(&self, title: &str) -> String {
        let fm = serde_yaml_frontmatter(self);
        format!(
            "---\nnv_type: playbook_rule\n{fm}---\n# {title}\n\n{}\n",
            self.rule
        )
    }
}

/// Minimal YAML emitter for the flat rule shape (no serde_yaml dep:
/// the fields are simple scalars/lists and the format is ours).
fn serde_yaml_frontmatter(r: &PlaybookRule) -> String {
    let mut out = String::new();
    if let Some(s) = &r.scope {
        out.push_str(&format!("scope: {s}\n"));
    }
    out.push_str(&format!(
        "category: {}\n",
        serde_json::to_value(r.category).unwrap().as_str().unwrap()
    ));
    out.push_str(&format!(
        "source: {}\n",
        serde_json::to_value(r.source).unwrap().as_str().unwrap()
    ));
    out.push_str(&format!("importance: {}\n", r.importance));
    out.push_str(&format!("confidence: {}\n", r.confidence));
    if let Some(t) = &r.last_confirmed_at {
        out.push_str(&format!("last_confirmed_at: {t}\n"));
    }
    if !r.examples.is_empty() {
        out.push_str("examples:\n");
        for e in &r.examples {
            out.push_str(&format!("  - {}\n", e.replace('\n', " ")));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn working_state_roundtrip_merge_and_staleness() {
        let dir = std::env::temp_dir().join(format!("nv-ws-{}", std::process::id()));
        let path = dir.join("ws").join("_brain.json");
        let now = OffsetDateTime::now_utc();

        // missing file -> empty, stale
        let ws = load_working_state_at(&path);
        assert!(ws.is_empty() && ws.is_stale(now));

        // partial update merges without wiping
        let mut ws = WorkingState::default();
        ws.apply(
            WorkingState {
                current_task: Some("review pricing draft".into()),
                last_files: vec!["deck.md".into()],
                ..Default::default()
            },
            now,
        );
        ws.apply(
            WorkingState {
                next_step: Some("send follow-up to Elena".into()),
                ..Default::default()
            },
            now,
        );
        assert_eq!(ws.current_task.as_deref(), Some("review pricing draft"));
        assert_eq!(ws.next_step.as_deref(), Some("send follow-up to Elena"));
        assert_eq!(ws.last_files, vec!["deck.md"]);
        assert!(!ws.is_stale(now));
        assert!(ws.is_stale(now + time::Duration::hours(WORKING_STATE_STALE_HOURS + 1)));

        // atomic save + reload
        save_working_state_at(&path, &ws).unwrap();
        let back = load_working_state_at(&path);
        assert_eq!(back.current_task.as_deref(), Some("review pricing draft"));

        // corrupt file -> empty, never errors
        std::fs::write(&path, "{ nope").unwrap();
        assert!(load_working_state_at(&path).is_empty());
    }

    #[test]
    fn correction_rule_is_high_importance_and_renders_frontmatter() {
        let now = OffsetDateTime::now_utc();
        let r = PlaybookRule::from_correction(
            "Avoid cost-cutting framing. Use operational resilience framing.",
            Some("clients/acme".into()),
            now,
        );
        assert_eq!(r.importance, "high");
        assert_eq!(r.source, RuleSource::UserCorrection);
        let md = r.to_markdown("Framing: operational resilience");
        assert!(md.starts_with("---\nnv_type: playbook_rule\n"));
        assert!(md.contains("scope: clients/acme"));
        assert!(md.contains("source: user_correction"));
        assert!(md.contains("# Framing: operational resilience"));
    }

    #[test]
    fn intent_str_roundtrip() {
        for i in [
            RecallIntent::ContinueWork,
            RecallIntent::PrepareBrief,
            RecallIntent::DraftOutput,
            RecallIntent::ReviewRisks,
            RecallIntent::ExplainDecision,
            RecallIntent::FindSource,
            RecallIntent::TemporalDiff,
            RecallIntent::GeneralQuestion,
        ] {
            assert_eq!(RecallIntent::parse(i.as_str()), Some(i));
        }
        assert_eq!(RecallIntent::parse("nope"), None);
    }
}
