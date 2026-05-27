//! Brain diagnostic — a health scorecard for a vault, computed from the
//! database. Mirrors the client-side scorer in `src/lib/diagnostic.ts`
//! (same five categories, weights, and letter-grade bands) so the in-app
//! panel, the HTTP endpoint, and the MCP `diagnose_brain` tool all report
//! the same numbers.
//!
//! Why a DB-backed copy as well as the TS one: the graph payload the UI
//! loads excludes dormant notes, so a purely client-side "freshness"
//! score is blind to them. Computing here over the full engram set makes
//! freshness (and orphan/organisation rates) honest, and lets a connected
//! agent run the diagnostic and act on the fixes without the UI open.

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use super::db::BrainDb;
use super::types::Result;

#[derive(Debug, Clone, Serialize)]
pub struct DiagCategory {
    pub key: String,
    pub label: String,
    /// 0..1
    pub score: f64,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiagIssue {
    pub label: String,
    pub count: i64,
    /// "high" | "medium" | "low"
    pub severity: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiagnosticReport {
    pub grade: String,
    /// 0..100
    pub score: i64,
    pub total: i64,
    pub categories: Vec<DiagCategory>,
    pub issues: Vec<DiagIssue>,
}

fn weight(key: &str) -> f64 {
    match key {
        "connectivity" => 0.25,
        "interlinking" => 0.20,
        "cohesion" => 0.20,
        "freshness" => 0.20,
        "organization" => 0.15,
        _ => 0.0,
    }
}

fn letter_grade(pct: i64) -> &'static str {
    match pct {
        p if p >= 97 => "A+",
        p if p >= 93 => "A",
        p if p >= 90 => "A-",
        p if p >= 87 => "B+",
        p if p >= 83 => "B",
        p if p >= 80 => "B-",
        p if p >= 77 => "C+",
        p if p >= 73 => "C",
        p if p >= 70 => "C-",
        p if p >= 67 => "D+",
        p if p >= 60 => "D",
        _ => "F",
    }
}

/// Top-level folder of a note (first path segment of its filename), or ""
/// for a root-level note. Matches the UI's `noteFolder` derivation.
fn folder_of(filename: &str) -> &str {
    match filename.find('/') {
        Some(i) if i > 0 => &filename[..i],
        _ => "",
    }
}

struct UnionFind {
    parent: HashMap<String, String>,
}
impl UnionFind {
    fn new(ids: &[String]) -> Self {
        let mut parent = HashMap::with_capacity(ids.len());
        for id in ids {
            parent.insert(id.clone(), id.clone());
        }
        UnionFind { parent }
    }
    fn find(&mut self, x: &str) -> String {
        let mut root = x.to_string();
        while self.parent.get(&root).map(|p| p != &root).unwrap_or(false) {
            root = self.parent[&root].clone();
        }
        // Path-compress.
        let mut cur = x.to_string();
        while self.parent.get(&cur).map(|p| p != &root).unwrap_or(false) {
            let next = self.parent[&cur].clone();
            self.parent.insert(cur, root.clone());
            cur = next;
        }
        root
    }
    fn union(&mut self, a: &str, b: &str) {
        let ra = self.find(a);
        let rb = self.find(b);
        if ra != rb {
            self.parent.insert(ra, rb);
        }
    }
}

/// Compute the scorecard for one brain.
pub fn diagnose(db: &BrainDb) -> Result<DiagnosticReport> {
    let conn = db.lock();

    // Real notes only (drop observations / session summaries), but keep
    // dormant ones so freshness is honest.
    let mut stmt = conn.prepare(
        "SELECT id, COALESCE(state,''), COALESCE(filename,'')
         FROM engrams
         WHERE COALESCE(kind, 'note') NOT IN ('observation', 'session_summary')",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);

    let total = rows.len() as i64;
    if total == 0 {
        return Ok(DiagnosticReport {
            grade: "—".to_string(),
            score: 0,
            total: 0,
            categories: vec![],
            issues: vec![DiagIssue {
                label: "This brain has no notes yet".to_string(),
                count: 0,
                severity: "low".to_string(),
            }],
        });
    }

    let ids: Vec<String> = rows.iter().map(|(id, _, _)| id.clone()).collect();
    let id_set: HashSet<&str> = ids.iter().map(|s| s.as_str()).collect();

    let dormant = rows.iter().filter(|(_, st, _)| st == "dormant").count() as i64;
    let unfiled = rows.iter().filter(|(_, _, fname)| folder_of(fname).is_empty()).count() as i64;

    // Links among the note set (ignore endpoints outside it).
    let mut stmt = conn.prepare("SELECT from_engram, to_engram FROM engram_links")?;
    let links = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);
    drop(conn);

    let mut degree: HashMap<&str, i64> = ids.iter().map(|s| (s.as_str(), 0)).collect();
    let mut uf = UnionFind::new(&ids);
    let mut edge_count = 0i64;
    for (from, to) in &links {
        if id_set.contains(from.as_str()) && id_set.contains(to.as_str()) {
            *degree.get_mut(from.as_str()).unwrap() += 1;
            *degree.get_mut(to.as_str()).unwrap() += 1;
            uf.union(from, to);
            edge_count += 1;
        }
    }

    let orphans = degree.values().filter(|&&d| d == 0).count() as i64;
    let avg_degree = (2.0 * edge_count as f64) / total as f64;

    // Largest connected component.
    let mut comp_sizes: HashMap<String, i64> = HashMap::new();
    for id in &ids {
        let root = uf.find(id);
        *comp_sizes.entry(root).or_insert(0) += 1;
    }
    let largest = comp_sizes.values().copied().max().unwrap_or(0);

    // --- Category scores (0..1) ---------------------------------------------
    let connectivity = 1.0 - orphans as f64 / total as f64;
    let interlinking = (avg_degree / 3.0).min(1.0);
    let cohesion = largest as f64 / total as f64;
    let freshness = 1.0 - dormant as f64 / total as f64;
    let organization = 1.0 - unfiled as f64 / total as f64;

    let categories = vec![
        DiagCategory {
            key: "connectivity".into(),
            label: "Connectivity".into(),
            score: connectivity,
            detail: if orphans == 0 {
                "Every note is linked".into()
            } else {
                format!("{orphans} of {total} notes are orphans (no links)")
            },
        },
        DiagCategory {
            key: "interlinking".into(),
            label: "Interlinking".into(),
            score: interlinking,
            detail: format!("{avg_degree:.1} links per note on average"),
        },
        DiagCategory {
            key: "cohesion".into(),
            label: "Cohesion".into(),
            score: cohesion,
            detail: if largest == total {
                "All notes form one connected web".into()
            } else {
                format!("Largest cluster holds {largest} of {total} notes")
            },
        },
        DiagCategory {
            key: "freshness".into(),
            label: "Freshness".into(),
            score: freshness,
            detail: if dormant == 0 {
                "No dormant notes".into()
            } else {
                format!("{dormant} of {total} notes are dormant")
            },
        },
        DiagCategory {
            key: "organization".into(),
            label: "Organization".into(),
            score: organization,
            detail: if unfiled == 0 {
                "Every note is filed in a folder".into()
            } else {
                format!("{unfiled} of {total} notes are unfiled (root)")
            },
        },
    ];

    let weighted: f64 = categories.iter().map(|c| c.score * weight(&c.key)).sum();
    let score = (weighted * 100.0).round() as i64;

    // --- Issues, worst first ------------------------------------------------
    let mut issues: Vec<DiagIssue> = Vec::new();
    let frac = |n: i64| n as f64 / total as f64;
    if orphans > 0 {
        issues.push(DiagIssue {
            label: format!(
                "{orphans} orphan note{} with no links — connect or merge them",
                if orphans == 1 { "" } else { "s" }
            ),
            count: orphans,
            severity: if frac(orphans) > 0.2 { "high" } else { "medium" }.into(),
        });
    }
    if dormant > 0 {
        issues.push(DiagIssue {
            label: format!(
                "{dormant} dormant note{} — revisit or let them be pruned",
                if dormant == 1 { "" } else { "s" }
            ),
            count: dormant,
            severity: if frac(dormant) > 0.3 { "high" } else { "low" }.into(),
        });
    }
    if unfiled > 0 {
        issues.push(DiagIssue {
            label: format!(
                "{unfiled} unfiled note{} in the root — sort into folders",
                if unfiled == 1 { "" } else { "s" }
            ),
            count: unfiled,
            severity: if frac(unfiled) > 0.4 { "medium" } else { "low" }.into(),
        });
    }
    if largest < total && total > 3 {
        let islands = total - largest;
        issues.push(DiagIssue {
            label: format!(
                "{islands} note{} outside the main cluster — bridge them in",
                if islands == 1 { "" } else { "s" }
            ),
            count: islands,
            severity: if frac(islands) > 0.3 { "medium" } else { "low" }.into(),
        });
    }
    if avg_degree < 1.5 {
        issues.push(DiagIssue {
            label: format!(
                "Sparse linking ({avg_degree:.1}/note) — add [[wikilinks]] between related notes"
            ),
            count: total,
            severity: "low".into(),
        });
    }
    let sev_rank = |s: &str| match s {
        "high" => 0,
        "medium" => 1,
        _ => 2,
    };
    issues.sort_by(|a, b| {
        sev_rank(&a.severity)
            .cmp(&sev_rank(&b.severity))
            .then(b.count.cmp(&a.count))
    });

    Ok(DiagnosticReport {
        grade: letter_grade(score).to_string(),
        score,
        total,
        categories,
        issues,
    })
}
