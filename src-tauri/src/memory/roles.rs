//! The employee role registry — the catalog of hireable AI employees.
//!
//! Each role is a personality + a behavior contract over the SAME
//! economy loop (free Rust delta-scan -> cheap batched judgment ->
//! propose-or-write), differing in what it watches, what it asks the
//! judge, and what a verdict turns into. Characters are abstract
//! line-art beings; `palette` + `glyph_seed` drive each one's look so
//! every employee is visually its own creature.
//!
//! Availability: `available: true` roles are hireable today on
//! existing plumbing. The rest appear greyed in the hire menu as
//! coming soon — honest roadmap, not vaporware buttons.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct RoleDef {
    /// Stable id ("curator"). Also the default instance id for the
    /// first hire of a role.
    pub role: &'static str,
    /// The employee's name — they are characters, not features.
    pub name: &'static str,
    /// Job title shown under the name.
    pub title: &'static str,
    /// One-sentence pitch for the hire menu.
    pub blurb: &'static str,
    /// Identity color (stroke gradient base) for the line-art being.
    pub palette: &'static str,
    /// Secondary/highlight stroke color.
    pub palette_soft: &'static str,
    /// Seed for the character's procedural line-art (same component,
    /// different creature per seed).
    pub glyph_seed: u32,
    /// What this employee watches (drives the delta scanner + UI copy).
    pub watches: &'static [&'static str],
    /// Hireable today?
    pub available: bool,
    /// Does this role use deep (MCP, deep_model) runs in addition to
    /// the cheap judge loop?
    pub uses_deep_runs: bool,
    /// Default wake cadence in minutes.
    pub default_wake_minutes: u32,
}

pub const ROLES: &[RoleDef] = &[
    RoleDef {
        role: "curator",
        name: "Curator",
        title: "Knowledge ops",
        blurb: "Keeps the brain organized and true: merges duplicates, flags contradictions, retires stale facts. The first employee, always on.",
        palette: "#8b5cf6",
        palette_soft: "#c4b5fd",
        glyph_seed: 0x4e56_0001,
        watches: &["duplicates", "contradictions", "orphan links"],
        available: true,
        uses_deep_runs: true,
        default_wake_minutes: 20,
    },
    RoleDef {
        role: "scribe",
        name: "Scribe",
        title: "Meetings desk",
        blurb: "Turns dropped transcripts into context-aware notes: decisions with the why, action items routed as handoffs, superseded decisions flagged.",
        palette: "#14b8a6",
        palette_soft: "#5eead4",
        glyph_seed: 0x4e56_0002,
        watches: &["meetings inbox"],
        available: true,
        uses_deep_runs: true,
        default_wake_minutes: 15,
    },
    RoleDef {
        role: "librarian",
        name: "Librarian",
        title: "Ingest desk",
        blurb: "Watches the drop folder and turns raw files into clean, linked, indexed notes so nothing rots unread.",
        palette: "#f59e0b",
        palette_soft: "#fcd34d",
        glyph_seed: 0x4e56_0003,
        watches: &["raw drop folder"],
        available: true,
        uses_deep_runs: true,
        default_wake_minutes: 30,
    },
    RoleDef {
        role: "chronicler",
        name: "Chronicler",
        title: "Daily record",
        blurb: "Writes the daily digest: what entered the brain, what changed, what got superseded. Your memory's memory.",
        palette: "#10b981",
        palette_soft: "#6ee7b7",
        glyph_seed: 0x4e56_0004,
        watches: &["new engrams", "changes"],
        available: true,
        uses_deep_runs: false,
        default_wake_minutes: 240,
    },
    RoleDef {
        role: "quartermaster",
        name: "Quartermaster",
        title: "Handoffs and todos",
        blurb: "Keeps the work queue honest: surfaces stale handoffs, nudges forgotten todos, closes finished loops.",
        palette: "#60a5fa",
        palette_soft: "#bfdbfe",
        glyph_seed: 0x4e56_0005,
        watches: &["todos", "handoffs"],
        available: true,
        uses_deep_runs: false,
        default_wake_minutes: 120,
    },
    RoleDef {
        role: "scout",
        name: "Scout",
        title: "Outside intelligence",
        blurb: "Watches sources you choose (feeds, changelogs, forums) and files distilled intel with citations, superseding stale facts.",
        palette: "#06b6d4",
        palette_soft: "#67e8f9",
        glyph_seed: 0x4e56_0006,
        watches: &["rss", "url diffs", "hn"],
        available: false,
        uses_deep_runs: true,
        default_wake_minutes: 60,
    },
    RoleDef {
        role: "gatekeeper",
        name: "Gatekeeper",
        title: "Privacy audit",
        blurb: "Scans new memories for secrets and personal data, proposes redactions and ignore rules before anything sensitive settles in.",
        palette: "#f43f5e",
        palette_soft: "#fda4af",
        glyph_seed: 0x4e56_0007,
        watches: &["new engrams"],
        available: false,
        uses_deep_runs: false,
        default_wake_minutes: 60,
    },
];

pub fn role(role_id: &str) -> Option<&'static RoleDef> {
    ROLES.iter().find(|r| r.role == role_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roles_are_unique_and_complete() {
        let mut seen = std::collections::HashSet::new();
        let mut seeds = std::collections::HashSet::new();
        for r in ROLES {
            assert!(seen.insert(r.role), "duplicate role id {}", r.role);
            assert!(
                seeds.insert(r.glyph_seed),
                "duplicate glyph seed {}",
                r.role
            );
            assert!(!r.blurb.is_empty() && !r.name.is_empty() && !r.title.is_empty());
            assert!(r.palette.starts_with('#') && r.palette_soft.starts_with('#'));
            assert!(!r.watches.is_empty(), "{} watches nothing", r.role);
        }
        // the flagship is hireable and first
        assert_eq!(ROLES[0].role, "curator");
        assert!(ROLES[0].available);
        // at least four hireable at launch
        assert!(ROLES.iter().filter(|r| r.available).count() >= 4);
    }

    #[test]
    fn lookup_works() {
        assert!(role("curator").is_some());
        assert!(role("nonexistent").is_none());
    }
}
