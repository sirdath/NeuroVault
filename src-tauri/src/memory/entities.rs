//! Local-regex entity extraction.
//!
//! Port of `server/neurovault_server/entities.py::_extract_entities_local`.
//! Python's file also has an LLM upgrade path via Claude Haiku; we
//! skip that — LLM calls don't belong on the synchronous ingest hot
//! path, and the regex extractor covers the common patterns well
//! enough for the graph view. Future Phase-8 `run_python_job` can
//! invoke the Haiku path on demand if a user asks.
//!
//! Strategy order (same as Python, same dedupe behaviour):
//!   1. `#` / `##` / `###` markdown headings → `concept`
//!   2. `[[wikilinks]]` (untyped extraction) → `concept`
//!   3. `` `backtick terms` `` → `technology`
//!   4. Known technology keywords (TECH_KEYWORDS) → `technology`
//!   5. `Title Case Multi Word Phrases` → `person`
//!   6. `"quoted phrases"` → `concept`
//!
//! Dedupe is case-insensitive on the name. Output capped at 30 to
//! match Python's `entities[:30]` slice.

use once_cell::sync::Lazy;
use regex::Regex;
use rusqlite::Connection;
use std::collections::HashSet;

use super::types::Result;

/// Extracted entity to be stored via `store_entities`. `relations` is
/// empty for the regex path — only the Haiku path produces relations.
#[derive(Debug, Clone)]
pub struct ExtractedEntity {
    pub name: String,
    pub entity_type: String,
    pub relations: Vec<EntityRelation>,
}

#[derive(Debug, Clone)]
pub struct EntityRelation {
    pub target: String,
    pub relation: String,
}

/// Known technology keywords. Byte-for-byte the same set as Python's
/// `TECH_KEYWORDS`. Stored as a `HashSet` of lowercase strings so
/// lookup is O(1).
static TECH_KEYWORDS: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    [
        "python", "rust", "javascript", "typescript", "react", "tauri", "sqlite",
        "fastapi", "flask", "django", "node", "npm", "cargo", "git", "github",
        "docker", "kubernetes", "aws", "gcp", "azure", "linux", "windows", "macos",
        "postgresql", "mongodb", "redis", "neo4j", "chromadb", "pinecone",
        "pytorch", "tensorflow", "scikit-learn", "numpy", "pandas",
        "openai", "anthropic", "claude", "gpt", "llm", "mcp", "rag",
        "html", "css", "tailwind", "vite", "webpack", "eslint",
        "fastmcp", "sentence-transformers", "sqlite-vec", "watchdog",
        "codemirror", "zustand", "framer-motion",
    ]
    .iter()
    .copied()
    .collect()
});

static HEADING_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?m)^#{1,3}\s+(.+)$").unwrap());
static WIKILINK_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\[\[([^\]]+)\]\]").unwrap());
static BACKTICK_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"`([^`]+)`").unwrap());
static TITLECASE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b").unwrap());
static QUOTED_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#""([^"]{3,40})""#).unwrap());

/// Small false-positive filter for the title-case step. Matches
/// Python's `name.lower() not in {...}` check.
static TITLECASE_STOP: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    ["the", "this", "that", "these", "those"]
        .iter()
        .copied()
        .collect()
});

/// Extract entities from `content` using only regex heuristics. Caps
/// the result at 30 entries to match Python's slice.
pub fn extract_entities_locally(content: &str) -> Vec<ExtractedEntity> {
    let mut entities: Vec<ExtractedEntity> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let add = |name: &str, etype: &str, list: &mut Vec<ExtractedEntity>, seen: &mut HashSet<String>| {
        let key = name.trim().to_lowercase();
        if key.is_empty() || seen.contains(&key) || key.chars().count() <= 1 {
            return;
        }
        seen.insert(key);
        list.push(ExtractedEntity {
            name: name.trim().to_string(),
            entity_type: etype.to_string(),
            relations: Vec::new(),
        });
    };

    // 1. Headings → concept.
    for caps in HEADING_RE.captures_iter(content) {
        if let Some(m) = caps.get(1) {
            let name = m.as_str().trim();
            let len = name.chars().count();
            if len > 2 && len < 60 {
                add(name, "concept", &mut entities, &mut seen);
            }
        }
    }

    // 2. Wikilinks → concept. Uses the untyped form from entities.py
    // — `[[Target|type]]` still matches because `[^\]]+` is greedy.
    // Keep only the part before `|` if present, matching Python's
    // `match.group(1).strip()` on the same pattern.
    for caps in WIKILINK_RE.captures_iter(content) {
        if let Some(m) = caps.get(1) {
            let raw = m.as_str().trim();
            let bare = raw.split('|').next().unwrap_or(raw).trim();
            add(bare, "concept", &mut entities, &mut seen);
        }
    }

    // 3. Backtick terms → technology.
    for caps in BACKTICK_RE.captures_iter(content) {
        if let Some(m) = caps.get(1) {
            let name = m.as_str().trim();
            let len = name.chars().count();
            if len > 1 && len < 40 && !name.starts_with('{') {
                add(name, "technology", &mut entities, &mut seen);
            }
        }
    }

    // 4. Known tech keywords appearing anywhere in content. Use the
    // properly-cased version from the source text (first occurrence).
    let content_lower = content.to_lowercase();
    for tech in TECH_KEYWORDS.iter() {
        if content_lower.contains(tech) {
            // Case-insensitive find on the original content to preserve
            // author capitalisation. `find` returns the first byte
            // index; we slice by matching-length chars.
            if let Some(start) = content_lower.find(tech) {
                let end = start + tech.len();
                // `start..end` is valid on `content` because the lower-
                // case form is the same byte length as the source for
                // ASCII tech names. All TECH_KEYWORDS are ASCII.
                if let Some(match_str) = content.get(start..end) {
                    add(match_str, "technology", &mut entities, &mut seen);
                }
            }
        }
    }

    // 5. Title-case multi-word phrases (2-4 words) → person.
    for caps in TITLECASE_RE.captures_iter(content) {
        if let Some(m) = caps.get(1) {
            let name = m.as_str();
            if !TITLECASE_STOP.contains(name.to_lowercase().as_str()) {
                add(name, "person", &mut entities, &mut seen);
            }
        }
    }

    // 6. Quoted 3..40-char phrases → concept. Drop http-ish phrases.
    for caps in QUOTED_RE.captures_iter(content) {
        if let Some(m) = caps.get(1) {
            let name = m.as_str().trim();
            if !name.starts_with("http") {
                add(name, "concept", &mut entities, &mut seen);
            }
        }
    }

    entities.truncate(30);
    entities
}

/// Insert extracted entities + their `entity_mentions` rows for the
/// given engram. Mirrors `entities.py::store_entities`. Idempotent:
/// repeated calls on the same engram bump `mention_count` but don't
/// duplicate rows (the `INSERT OR IGNORE` on `entity_mentions` has
/// `(entity_id, engram_id)` as PK).
///
/// Entity id is a UUIDv5 over the lowercased name under the
/// `NAMESPACE_DNS` namespace — matches what Python computes with
/// `uuid.uuid5(uuid.NAMESPACE_DNS, name.lower())` so a row written by
/// either runtime deduplicates against the other.
pub fn store_entities(
    conn: &Connection,
    engram_id: &str,
    entities: &[ExtractedEntity],
) -> Result<()> {
    for ent in entities {
        let name = ent.name.trim();
        if name.is_empty() {
            continue;
        }
        let key = name.to_lowercase();
        let new_id = uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_DNS, key.as_bytes()).to_string();

        // Upsert — same three-branch logic as Python's store_entities.
        let existing: Option<(String, i64)> = conn
            .query_row(
                "SELECT id, mention_count FROM entities
                 WHERE id = ?1 OR name = ?2 COLLATE NOCASE",
                rusqlite::params![&new_id, name],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
            )
            .ok();
        let entity_id = match existing {
            Some((id, _)) => {
                conn.execute(
                    "UPDATE entities SET mention_count = mention_count + 1 WHERE id = ?1",
                    [&id],
                )?;
                id
            }
            None => {
                conn.execute(
                    "INSERT OR IGNORE INTO entities (id, name, entity_type, mention_count)
                     VALUES (?1, ?2, ?3, 1)",
                    rusqlite::params![&new_id, name, &ent.entity_type],
                )?;
                new_id
            }
        };

        conn.execute(
            "INSERT OR IGNORE INTO entity_mentions (entity_id, engram_id, salience)
             VALUES (?1, ?2, 1.0)",
            rusqlite::params![&entity_id, engram_id],
        )?;

        for rel in &ent.relations {
            let target_name = rel.target.trim();
            if target_name.is_empty() {
                continue;
            }
            let target_key = target_name.to_lowercase();
            let target_id = uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_DNS, target_key.as_bytes())
                .to_string();
            conn.execute(
                "INSERT OR IGNORE INTO entities (id, name, entity_type, mention_count)
                 VALUES (?1, ?2, 'concept', 1)",
                rusqlite::params![&target_id, target_name],
            )?;
            conn.execute(
                "INSERT OR IGNORE INTO entity_mentions (entity_id, engram_id, salience)
                 VALUES (?1, ?2, 0.5)",
                rusqlite::params![&target_id, engram_id],
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_headings_as_concepts() {
        let ents = extract_entities_locally("# Main Idea\n\nSome body.\n\n## Sub Topic\n");
        assert!(ents.iter().any(|e| e.name == "Main Idea" && e.entity_type == "concept"));
        assert!(ents.iter().any(|e| e.name == "Sub Topic" && e.entity_type == "concept"));
    }

    #[test]
    fn extract_backticks_as_technology() {
        let ents = extract_entities_locally("Use `fastembed` to embed and `sqlite-vec` to store.");
        assert!(ents.iter().any(|e| e.entity_type == "technology" && e.name == "fastembed"));
    }

    #[test]
    fn deduplicate_case_insensitive() {
        let ents = extract_entities_locally("Claude and claude and CLAUDE");
        let count = ents
            .iter()
            .filter(|e| e.name.to_lowercase() == "claude")
            .count();
        assert_eq!(count, 1);
    }

    #[test]
    fn caps_at_thirty() {
        // Enough distinct concepts to overflow the 30-entry cap.
        let content = (0..50)
            .map(|i| format!("`term{}`", i))
            .collect::<Vec<_>>()
            .join(" ");
        let ents = extract_entities_locally(&content);
        assert!(ents.len() <= 30);
    }
}
