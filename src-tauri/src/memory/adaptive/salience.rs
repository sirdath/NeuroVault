//! Salience — how much a memory matters right now (spec §5.2).
//!
//! A weighted, zero-LLM score computed at retrieval time. Salience
//! ORDERS and BUDGETS within a memory type; it never overrides the
//! cross-encoder relevance floor for semantic retrieval (a
//! salient-but-irrelevant memory is still irrelevant). The weights
//! are v1 constants; every component lands in the decision log so the
//! v2 learning loop can fit them from real usage instead of guesses —
//! the same log-first discipline as the ambient gate.

use time::OffsetDateTime;

/// Everything salience considers about one memory. Build it from the
/// engram row (`access_count`, `accessed_at`/`updated_at`, `kind`,
/// `importance`) plus graph facts where cheaply available.
#[derive(Debug, Clone, Default)]
pub struct SalienceInput {
    /// Days since the memory was last touched (updated, accessed, or
    /// confirmed — the freshest of them).
    pub age_days: f64,
    /// Engram kind ("decision", "preference", "source", "note", …) —
    /// picks the recency half-life.
    pub kind: String,
    /// `access_count` from the engram row.
    pub use_count: u32,
    /// "low" | "normal" | "high" (user corrections write high).
    pub importance: String,
    /// Trust in the fact itself, in [0,1] (structural_confidence or
    /// the authoritative memory_types value).
    pub confidence: f64,
    /// Source reliability in [0,1] (source-mirrored = 1.0; defaults
    /// to confidence when no separate signal exists).
    pub reliability: f64,
    /// Graph links that raise stakes (each contributes a third of the
    /// link bonus, capped at 1.0 total).
    pub linked_to_active_decision: bool,
    pub linked_to_deadline: bool,
    pub linked_to_client_preference: bool,
}

/// Recency half-life per memory type, in days (spec §5.2): working
/// state goes stale in days, decisions stay warm for months, playbook
/// rules and sources barely decay.
pub fn half_life_days(kind: &str) -> f64 {
    match kind {
        "working_state" => 2.0,
        "task" | "todo" => 14.0,
        "decision" => 180.0,
        "preference" | "playbook_rule" => 365.0,
        "source" | "code" => 365.0,
        _ => 90.0, // notes, insights, everything else
    }
}

/// Weighted salience in [0,1].
///
/// ```text
/// 0.25·recency + 0.20·usage + 0.20·importance
///   + 0.15·confidence + 0.10·reliability + 0.10·link_bonus
/// ```
pub fn salience(input: &SalienceInput) -> f64 {
    let recency = (-input.age_days.max(0.0) / half_life_days(&input.kind) * std::f64::consts::LN_2)
        .exp()
        .clamp(0.0, 1.0);
    let usage = ((1.0 + input.use_count as f64).ln() / 20f64.ln()).clamp(0.0, 1.0);
    let importance = match input.importance.as_str() {
        "high" => 1.0,
        "low" => 0.3,
        _ => 0.6,
    };
    let links = [
        input.linked_to_active_decision,
        input.linked_to_deadline,
        input.linked_to_client_preference,
    ]
    .iter()
    .filter(|&&b| b)
    .count() as f64;
    let link_bonus = (links / 3.0).clamp(0.0, 1.0);

    0.25 * recency
        + 0.20 * usage
        + 0.20 * importance
        + 0.15 * input.confidence.clamp(0.0, 1.0)
        + 0.10 * input.reliability.clamp(0.0, 1.0)
        + 0.10 * link_bonus
}

/// Days between two instants, non-negative.
pub fn age_days(then: OffsetDateTime, now: OffsetDateTime) -> f64 {
    ((now - then).whole_seconds().max(0) as f64) / 86_400.0
}

/// The decay verdict used by consolidation (spec §5.3): archive when
/// old, unused, unimportant, and salience-cold. Never deletes.
pub fn should_archive(input: &SalienceInput) -> bool {
    salience(input) < 0.15
        && input.age_days > 90.0
        && input.use_count == 0
        && input.importance == "low"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base(kind: &str, age: f64) -> SalienceInput {
        SalienceInput {
            age_days: age,
            kind: kind.into(),
            use_count: 0,
            importance: "normal".into(),
            confidence: 0.9,
            reliability: 0.9,
            ..Default::default()
        }
    }

    #[test]
    fn fresh_beats_old_within_a_type() {
        assert!(salience(&base("note", 0.0)) > salience(&base("note", 200.0)));
    }

    #[test]
    fn half_lives_respect_type_shape() {
        // A 30-day-old decision is still warm; a 30-day-old note has
        // meaningfully decayed; a year-old playbook rule keeps half
        // its recency.
        let d = salience(&base("decision", 30.0));
        let n = salience(&base("note", 30.0));
        assert!(d > n, "decision {d} vs note {n}");
        let r = base("preference", 365.0);
        let recency_share = salience(&r) - salience(&base("preference", 100_000.0));
        assert!(recency_share > 0.1, "rules keep recency value at 1y");
    }

    #[test]
    fn user_correction_importance_dominates_staleness() {
        // A high-importance old rule outranks a fresh low-importance note.
        let mut old_rule = base("preference", 300.0);
        old_rule.importance = "high".into();
        let mut fresh_low = base("note", 1.0);
        fresh_low.importance = "low".into();
        assert!(salience(&old_rule) > salience(&fresh_low));
    }

    #[test]
    fn usage_saturates_and_links_bound() {
        let mut a = base("note", 10.0);
        a.use_count = 5;
        let mut b = a.clone();
        b.use_count = 500;
        let (sa, sb) = (salience(&a), salience(&b));
        assert!(sb > sa);
        assert!(sb - sa < 0.15, "usage saturates: {sa} -> {sb}");
        let mut linked = base("note", 10.0);
        linked.linked_to_active_decision = true;
        linked.linked_to_deadline = true;
        linked.linked_to_client_preference = true;
        assert!(salience(&linked) - salience(&base("note", 10.0)) <= 0.101);
    }

    #[test]
    fn decay_verdict_is_conservative() {
        // Old + unused + low importance + cold -> archive.
        let mut cold = base("note", 200.0);
        cold.importance = "low".into();
        cold.confidence = 0.0;
        cold.reliability = 0.0;
        assert!(should_archive(&cold));
        // High importance is never archived by decay.
        let mut important = cold.clone();
        important.importance = "high".into();
        assert!(!should_archive(&important));
        // Any use protects.
        let mut used = cold.clone();
        used.use_count = 1;
        assert!(!should_archive(&used));
    }

    #[test]
    fn salience_stays_in_unit_range() {
        let mut max = base("decision", 0.0);
        max.use_count = 10_000;
        max.importance = "high".into();
        max.confidence = 1.0;
        max.reliability = 1.0;
        max.linked_to_active_decision = true;
        max.linked_to_deadline = true;
        max.linked_to_client_preference = true;
        let s = salience(&max);
        assert!(s <= 1.0 && s > 0.95, "{s}");
        assert!(salience(&SalienceInput::default()) >= 0.0);
    }
}
