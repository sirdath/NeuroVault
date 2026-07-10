//! Retrieval orchestrator — execute a ContextRecipe (spec §6, §7).
//!
//! Per-section retrieval with ONE pooled rerank pass: semantic
//! sections retrieve cheaply (no reranker, ~0.3s each), their
//! candidates pool into a single cross-encoder call, and the per-item
//! CE probability gates each section against the recipe's floor.
//! Pooling is what keeps multi-section intents (prepare_brief runs up
//! to three semantic sections) inside the hook's 3.5s budget — three
//! reranked recalls would cost ~4s; pooled it's ~2s.
//!
//! Structural sections (WorkingState, open tasks) never touch
//! retrieval and never CE-gate: their gates are freshness and status.
//! Deliberate consequence: "continue" keeps working when the reranker
//! is down.

use std::collections::HashMap;

use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use super::recipes::{ContextRecipe, SectionSource, SectionSpec};
use super::salience::{age_days, salience_breakdown, SalienceBreakdown, SalienceInput};
use super::types::{load_working_state, WorkingState};
use super::Scope;
use crate::memory::db::BrainDb;
use crate::memory::retriever::{
    hybrid_retrieve_with_scores, structural_confidence, RecallOpts, THROTTLE_HINT_ID,
};
use crate::memory::types::MemoryError;
use crate::memory::{reranker, todos};

type Result<T> = std::result::Result<T, MemoryError>;

/// One item that survived a section's gate.
#[derive(Debug, Clone)]
pub struct SectionItem {
    /// Typed display id: `W` (working state), `T-xxxx` (task),
    /// `D-/R-/S-/M-xxxxxxxx` (engrams by section type).
    pub display_id: String,
    /// Pre-sanitized single-line rendering (composer trusts it).
    pub line: String,
    /// Full engram id when the item is an engram (for the seen-file
    /// and the decision log); None for structural items.
    pub engram_id: Option<String>,
    /// CE probability when the item came through the pooled rerank.
    pub ce_prob: Option<f64>,
    /// Salience (spec §5.2) when the item is an engram.
    pub salience: Option<f64>,
    /// Full salience components + lifecycle status for the trace —
    /// the Inspector's per-memory "why" (spec V1c-1).
    pub trace: Option<ItemTrace>,
}

/// Per-memory trace: everything the Inspector needs to explain a
/// ranking/gate decision without re-running it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ItemTrace {
    pub kind: String,
    pub lifecycle: String,
    pub salience: SalienceBreakdown,
}

/// A section after retrieval + gating.
#[derive(Debug, Clone)]
pub struct SectionResult {
    pub title: &'static str,
    pub items: Vec<SectionItem>,
    /// (what, why) — retrieved but not injected; feeds the log + CLI.
    pub skipped: Vec<(String, String)>,
}

/// Full orchestrator output.
#[derive(Debug)]
pub struct RecipeRun {
    pub sections: Vec<SectionResult>,
    /// True when at least one item survived somewhere.
    pub has_content: bool,
}

/// Snippet budget per item line (composer adds headers around these).
const ITEM_CHARS: usize = 200;
/// Per-section retrieval overshoot: fetch a few extra so the gate has
/// slack to drop weak ones and still fill max_items.
const FETCH_SLACK: usize = 2;
/// Cap on the pooled rerank set (docs are title+400 chars; 24 keeps
/// the single CE pass ~1.2s worst-case).
const POOL_CAP: usize = 24;

pub fn run_recipe(
    db: &BrainDb,
    scope: &Scope,
    prompt: &str,
    recipe: &ContextRecipe,
    exclude_ids: &[String],
) -> Result<RecipeRun> {
    let now = OffsetDateTime::now_utc();
    let sanitize = crate::memory::hooks::sanitize;

    // ---- pass 1: retrieve raw candidates per section (no reranker) ----
    struct RawSection {
        spec: SectionSpec,
        // engram candidates awaiting the pooled rerank
        cands: Vec<RawCand>,
        // structural items, already final
        items: Vec<SectionItem>,
        skipped: Vec<(String, String)>,
    }
    struct RawCand {
        engram_id: String,
        title: String,
        content: String,
        salience: f64,
        trace: Option<ItemTrace>,
    }

    let mut raw: Vec<RawSection> = Vec::with_capacity(recipe.sections.len());
    let mut seen_engrams: HashMap<String, usize> = HashMap::new(); // id -> first section idx

    for spec in recipe.sections {
        let mut sec = RawSection {
            spec: *spec,
            cands: Vec::new(),
            items: Vec::new(),
            skipped: Vec::new(),
        };
        match spec.source {
            SectionSource::WorkingState => {
                let ws = load_working_state(scope);
                if ws.is_empty() {
                    sec.skipped.push(("working_state".into(), "empty".into()));
                } else {
                    let stale = ws.is_stale(now);
                    sec.items.push(SectionItem {
                        display_id: "W".into(),
                        line: render_working_state(&ws, stale, now, sanitize),
                        engram_id: None,
                        ce_prob: None,
                        salience: None,
                        trace: None,
                    });
                }
            }
            SectionSource::OpenTasks => match todos::list_todos(&scope.brain_id, Some("open")) {
                Ok(open) => {
                    for t in open.iter().take(spec.max_items) {
                        let mut line = sanitize(&t.text, ITEM_CHARS);
                        if t.priority == "high" {
                            line.push_str(" (high priority)");
                        }
                        if let Some(by) = &t.claimed_by {
                            line.push_str(&format!(" (claimed by {})", sanitize(by, 40)));
                        }
                        sec.items.push(SectionItem {
                            display_id: format!("T-{}", &t.id[..t.id.len().min(6)]),
                            line,
                            engram_id: None,
                            ce_prob: None,
                            salience: None,
                            trace: None,
                        });
                    }
                    if open.is_empty() {
                        sec.skipped.push(("tasks".into(), "no open todos".into()));
                    }
                }
                Err(e) => sec
                    .skipped
                    .push(("tasks".into(), format!("unavailable: {e}"))),
            },
            SectionSource::Decisions
            | SectionSource::PlaybookRules
            | SectionSource::Sources
            | SectionSource::Semantic
            | SectionSource::RecentChanges { .. } => {
                let query = section_query(spec.source, prompt, scope, now);
                let opts = RecallOpts {
                    top_k: spec.max_items + FETCH_SLACK,
                    spread_hops: 0,
                    exclude_kinds: vec!["observation".to_string()],
                    as_of: None,
                    use_reranker: false, // pooled pass below
                    ablate: Vec::new(),
                };
                match hybrid_retrieve_with_scores(db, &query, &opts) {
                    Ok((hits, _)) => {
                        for h in hits {
                            if h.engram_id == THROTTLE_HINT_ID || h.state == "throttle_hint" {
                                continue;
                            }
                            if exclude_ids.iter().any(|x| x == &h.engram_id) {
                                sec.skipped.push((
                                    short(&h.engram_id),
                                    "already injected this session".into(),
                                ));
                                continue;
                            }
                            if seen_engrams.contains_key(&h.engram_id) {
                                sec.skipped.push((
                                    short(&h.engram_id),
                                    "already in an earlier section".into(),
                                ));
                                continue;
                            }
                            // Lifecycle gate (spec §5.1): superseded /
                            // rejected / archived memories are never
                            // auto-injected, whatever their relevance.
                            let row = lifecycle_row(db, &h.engram_id);
                            if let Some(reason) = lifecycle_verdict(
                                row.as_ref().map(|r| r.state.as_str()).unwrap_or("active"),
                                row.as_ref().and_then(|r| r.superseded_by.as_deref()),
                            ) {
                                sec.skipped.push((short(&h.engram_id), reason.to_string()));
                                continue;
                            }
                            let trace = row.as_ref().map(|r| r.trace(now));
                            let sal = trace.as_ref().map(|t| t.salience.total).unwrap_or(0.5);
                            seen_engrams.insert(h.engram_id.clone(), raw.len());
                            sec.cands.push(RawCand {
                                engram_id: h.engram_id,
                                title: h.title,
                                content: h.content,
                                salience: sal,
                                trace,
                            });
                        }
                    }
                    Err(e) => sec
                        .skipped
                        .push((spec.title.to_string(), format!("retrieval failed: {e}"))),
                }
            }
        }
        raw.push(sec);
    }

    // ---- pass 2: ONE pooled cross-encoder call over all candidates ----
    let mut pool: Vec<(usize, usize)> = Vec::new(); // (section idx, cand idx)
    for (si, sec) in raw.iter().enumerate() {
        for ci in 0..sec.cands.len() {
            if pool.len() >= POOL_CAP {
                break;
            }
            pool.push((si, ci));
        }
    }
    let ce_by_pos: Option<Vec<f64>> = if pool.is_empty() {
        Some(Vec::new())
    } else {
        let docs: Vec<String> = pool
            .iter()
            .map(|&(si, ci)| {
                let c = &raw[si].cands[ci];
                let body: String = c.content.chars().take(400).collect();
                format!("{}\n{}", c.title, body)
            })
            .collect();
        match reranker::rerank(prompt, &docs) {
            Ok(logits) => Some(
                logits
                    .into_iter()
                    .map(|l| 1.0 / (1.0 + (-(l as f64)).exp()))
                    .collect(),
            ),
            Err(e) => {
                eprintln!("[adaptive] pooled rerank unavailable: {e}");
                None
            }
        }
    };

    // ---- pass 3: gate each semantic section against the recipe floor ----
    let mut ce_map: HashMap<(usize, usize), f64> = HashMap::new();
    if let Some(ce) = &ce_by_pos {
        for (k, &(si, ci)) in pool.iter().enumerate() {
            if let Some(p) = ce.get(k) {
                ce_map.insert((si, ci), *p);
            }
        }
    }

    let mut out: Vec<SectionResult> = Vec::with_capacity(raw.len());
    let mut has_content = false;
    for (si, sec) in raw.into_iter().enumerate() {
        let mut result = SectionResult {
            title: sec.spec.title,
            items: sec.items,
            skipped: sec.skipped,
        };
        // Quota sections (floor override 0.0, and PlaybookRules) carry
        // items that belong by SCOPE + salience, not prompt
        // similarity — so they order salience-first and still deliver
        // when the reranker is down. Floored sections stay
        // conservative: no CE, no injection.
        let is_quota =
            sec.spec.floor == Some(0.0) || matches!(sec.spec.source, SectionSource::PlaybookRules);
        if !sec.cands.is_empty() {
            if ce_by_pos.is_none() && !is_quota {
                result.skipped.push((
                    sec.spec.title.to_string(),
                    "reranker unavailable; semantic section suppressed".into(),
                ));
            } else {
                // Rank by CE within the section, gate on the floor.
                let mut scored: Vec<(usize, f64, f64)> = sec
                    .cands
                    .iter()
                    .enumerate()
                    .map(|(ci, c)| {
                        (
                            ci,
                            ce_map.get(&(si, ci)).copied().unwrap_or(0.0),
                            c.salience,
                        )
                    })
                    .collect();
                // Quota sections order by SALIENCE first (importance
                // and freshness outrank prompt similarity); everything
                // else by CE with salience as the tiebreak (spec §5.2:
                // salience orders within a type, never overrides
                // relevance).
                scored.sort_by(|a, b| {
                    let ka = if is_quota { (a.2, a.1) } else { (a.1, a.2) };
                    let kb = if is_quota { (b.2, b.1) } else { (b.1, b.2) };
                    kb.partial_cmp(&ka).unwrap_or(std::cmp::Ordering::Equal)
                });
                // PlaybookRules are standing orders: they apply
                // because they're IN SCOPE, not because they resemble
                // the prompt ("avoid cost-cutting framing" must gate a
                // pricing email it shares zero vocabulary with). Scope
                // + max_items is their gate; CE only ORDERS them so
                // topical rules float up. Everything else keeps the
                // recipe's absolute floor. (Found live: a captured
                // rule scored ce 0.04 against the draft prompt it
                // existed to constrain.)
                let floor = sec.spec.floor.unwrap_or(match sec.spec.source {
                    SectionSource::PlaybookRules => 0.0,
                    _ => recipe.gate.ce_floor,
                });
                for (ci, p, sal) in scored {
                    let c = &sec.cands[ci];
                    if result.items.len() >= sec.spec.max_items {
                        break;
                    }
                    if p < floor {
                        result
                            .skipped
                            .push((short(&c.engram_id), format!("ce {p:.2} < floor {floor:.2}")));
                        continue;
                    }
                    let prefix = match sec.spec.source {
                        SectionSource::Decisions => "D",
                        SectionSource::PlaybookRules => "R",
                        SectionSource::Sources => "S",
                        _ => "M",
                    };
                    result.items.push(SectionItem {
                        display_id: format!("{prefix}-{}", short(&c.engram_id)),
                        line: format!(
                            "{} — {}",
                            sanitize(&c.title, 100),
                            sanitize(strip_note_scaffolding(&c.content), ITEM_CHARS)
                        ),
                        engram_id: Some(c.engram_id.clone()),
                        ce_prob: Some(p),
                        salience: Some(sal),
                        trace: c.trace.clone(),
                    });
                }
            }
        }
        has_content |= !result.items.is_empty();
        out.push(result);
    }

    Ok(RecipeRun {
        sections: out,
        has_content,
    })
}

/// Build the operator-augmented recall query for a semantic section.
fn section_query(
    source: SectionSource,
    prompt: &str,
    scope: &Scope,
    now: OffsetDateTime,
) -> String {
    let text: String = prompt.chars().take(400).collect();
    let folder = scope
        .room
        .as_ref()
        .map(|r| format!("folder:{r} "))
        .unwrap_or_default();
    match source {
        SectionSource::Decisions => format!("{folder}kind:decision {text}"),
        SectionSource::PlaybookRules => format!("{folder}kind:preference {text}"),
        SectionSource::Sources => format!("{folder}kind:source {text}"),
        SectionSource::RecentChanges { window_days } => {
            let since = now - time::Duration::days(window_days as i64);
            let date = since
                .format(&Rfc3339)
                .map(|s| s[..10].to_string())
                .unwrap_or_default();
            format!("{folder}after:{date} {text}")
        }
        _ => format!("{folder}{text}"),
    }
}

/// The lifecycle fields salience + the gate need, in one PK lookup.
struct LifecycleRow {
    state: String,
    superseded_by: Option<String>,
    kind: String,
    use_count: u32,
    importance: String,
    /// Freshest of last_confirmed_at / accessed_at / updated_at /
    /// created_at (RFC-3339-ish).
    last_touch: Option<String>,
}

impl LifecycleRow {
    fn trace(&self, now: time::OffsetDateTime) -> ItemTrace {
        let age = self
            .last_touch
            .as_deref()
            .and_then(parse_when)
            .map(|t| age_days(t, now))
            .unwrap_or(365.0);
        let conf = structural_confidence(&self.kind);
        let breakdown = salience_breakdown(&SalienceInput {
            age_days: age,
            kind: self.kind.clone(),
            use_count: self.use_count,
            importance: self.importance.clone(),
            confidence: conf,
            reliability: conf,
            ..SalienceInput::default()
        });
        let lifecycle = if self.superseded_by.as_deref().is_some_and(|x| !x.is_empty()) {
            "superseded".to_string()
        } else {
            self.state.clone()
        };
        ItemTrace {
            kind: self.kind.clone(),
            lifecycle,
            salience: breakdown,
        }
    }
}

/// SQLite timestamps here are either RFC-3339 or the space-separated
/// `datetime('now')` shape; accept both.
fn parse_when(raw: &str) -> Option<time::OffsetDateTime> {
    use time::format_description::well_known::Rfc3339;
    if let Ok(t) = time::OffsetDateTime::parse(raw, &Rfc3339) {
        return Some(t);
    }
    let patched = format!("{}Z", raw.replace(' ', "T"));
    time::OffsetDateTime::parse(&patched, &Rfc3339).ok()
}

fn lifecycle_row(db: &BrainDb, engram_id: &str) -> Option<LifecycleRow> {
    let conn = db.lock();
    conn.query_row(
        "SELECT COALESCE(state,'active'), superseded_by, COALESCE(kind,'note'), \
                COALESCE(access_count,0), COALESCE(importance,'normal'), \
                COALESCE(last_confirmed_at, accessed_at, updated_at, created_at) \
         FROM engrams WHERE id = ?1",
        [engram_id],
        |r| {
            Ok(LifecycleRow {
                state: r.get(0)?,
                superseded_by: r.get(1)?,
                kind: r.get(2)?,
                use_count: r.get::<_, i64>(3)? as u32,
                importance: r.get(4)?,
                last_touch: r.get(5)?,
            })
        },
    )
    .ok()
}

/// Spec §5.1: statuses that are NEVER auto-injected. Superseded and
/// rejected memories stay retrievable by explicit search (and
/// explain_decision will label them as history in V1c); ambient
/// context must only carry live facts.
fn lifecycle_verdict(state: &str, superseded_by: Option<&str>) -> Option<&'static str> {
    if let Some(s) = superseded_by {
        if !s.is_empty() {
            return Some("superseded");
        }
    }
    match state {
        "archived" => Some("archived"),
        "rejected" => Some("rejected"),
        "dormant" => Some("deleted"),
        _ => None,
    }
}

fn short(id: &str) -> String {
    id[..id.len().min(8)].to_string()
}

/// Drop leading YAML frontmatter and a leading `# heading` from note
/// content before snippeting — the packet carries the title
/// separately, and frontmatter is machine metadata, not context.
fn strip_note_scaffolding(content: &str) -> &str {
    let mut rest = content.trim_start();
    if let Some(after) = rest.strip_prefix("---") {
        if let Some(end) = after.find("\n---") {
            rest = after[end + 4..].trim_start();
        }
    }
    if rest.starts_with('#') {
        if let Some(nl) = rest.find('\n') {
            rest = rest[nl + 1..].trim_start();
        }
    }
    rest
}

fn render_working_state(
    ws: &WorkingState,
    stale: bool,
    now: OffsetDateTime,
    sanitize: fn(&str, usize) -> String,
) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(t) = &ws.current_task {
        parts.push(sanitize(t, 120));
    }
    if let Some(n) = &ws.next_step {
        parts.push(format!("next: {}", sanitize(n, 120)));
    }
    if !ws.last_files.is_empty() {
        let files: Vec<String> = ws
            .last_files
            .iter()
            .take(3)
            .map(|f| sanitize(f, 60))
            .collect();
        parts.push(format!("files: {}", files.join(", ")));
    }
    if let Some(d) = &ws.unfinished_draft {
        parts.push(format!("unfinished draft: {}", sanitize(d, 80)));
    }
    if let Some(a) = &ws.last_agent_run {
        parts.push(format!("last agent run: {}", sanitize(a, 80)));
    }
    let age = ws
        .age_hours(now)
        .map(|h| {
            if h < 1 {
                // no angle brackets anywhere inside the packet — the
                // injection-as-data invariant applies to OUR text too
                // (caught by the scenario test's tag-shape assertion).
                "updated under 1h ago".to_string()
            } else if h < 48 {
                format!("updated {h}h ago")
            } else {
                format!("updated {}d ago", h / 24)
            }
        })
        .unwrap_or_else(|| "age unknown".into());
    let flag = if stale { " — MAY BE STALE" } else { "" };
    format!("{} ({age}{flag})", parts.join(" · "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn section_queries_carry_operators_and_scope() {
        let now = OffsetDateTime::now_utc();
        let brain = Scope::brain("b");
        let room = Scope::room("b", "clients/acme");
        assert!(
            section_query(SectionSource::Decisions, "why usage pricing", &brain, now)
                .starts_with("kind:decision ")
        );
        assert!(section_query(SectionSource::PlaybookRules, "x", &room, now)
            .starts_with("folder:clients/acme kind:preference "));
        let rc = section_query(
            SectionSource::RecentChanges { window_days: 7 },
            "x",
            &brain,
            now,
        );
        assert!(rc.starts_with("after:20"), "{rc}");
        assert_eq!(
            section_query(SectionSource::Semantic, "plain", &brain, now),
            "plain"
        );
    }

    #[test]
    fn lifecycle_verdict_blocks_dead_states_only() {
        assert_eq!(lifecycle_verdict("active", None), None);
        assert_eq!(lifecycle_verdict("fresh", Some("")), None);
        assert_eq!(lifecycle_verdict("archived", None), Some("archived"));
        assert_eq!(lifecycle_verdict("rejected", None), Some("rejected"));
        assert_eq!(lifecycle_verdict("dormant", None), Some("deleted"));
        assert_eq!(lifecycle_verdict("active", Some("abc")), Some("superseded"));
    }

    #[test]
    fn note_scaffolding_is_stripped_from_snippets() {
        let raw = "---\nnv_type: playbook_rule\nimportance: high\n---\n# Title here\n\nThe actual rule text.";
        assert_eq!(strip_note_scaffolding(raw), "The actual rule text.");
        assert_eq!(strip_note_scaffolding("plain body"), "plain body");
        assert_eq!(strip_note_scaffolding("# Only heading\nbody"), "body");
    }

    #[test]
    fn working_state_renders_compact_with_staleness_flag() {
        let now = OffsetDateTime::now_utc();
        let mut ws = WorkingState {
            current_task: Some("review <pricing> draft".into()),
            next_step: Some("send follow-up".into()),
            last_files: vec!["deck.md".into()],
            ..Default::default()
        };
        ws.updated_at = (now - time::Duration::days(10)).format(&Rfc3339).ok();
        let line = render_working_state(&ws, ws.is_stale(now), now, crate::memory::hooks::sanitize);
        assert!(line.contains("review (pricing) draft"), "{line}");
        assert!(line.contains("next: send follow-up"));
        assert!(line.contains("MAY BE STALE"));
    }
}
