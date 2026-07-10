//! Adaptive Memory — typed memories, intent routing, context recipes.
//!
//! The layer above retrieval. NeuroVault's hybrid stack answers "how
//! relevant is this text?"; this module answers the question retrieval
//! alone can't: "what KIND of question is this, and what SHAPE of
//! memory answers it?" — then reconstructs context for the situation
//! instead of ranking chunks.
//!
//!   Every memory has a type.
//!   Every type has a shape.
//!   Every prompt has an intent.
//!   Every intent has a context recipe.
//!   The final output is not raw chunks.
//!   The final output is reconstructed context for the current situation.
//!
//! Spec: docs/specs/adaptive-memory.md (wins over code comments).
//! V1a scope: rules MemoryRouter (8 intents), ContextRecipe registry,
//! WorkingState + PlaybookRule shapes, sectioned composer — all
//! wrapping the existing recall + Ambient Recall gate. The
//! `general_question` fallback IS today's ambient pipeline, so this
//! layer can never regress the shipped behavior.

pub mod composer;
pub mod orchestrator;
pub mod recipes;
pub mod router;
pub mod salience;
pub mod types;

use serde::{Deserialize, Serialize};

/// Where a memory lives / a query looks. A "room" (client engagement,
/// project) IS a vault folder — no third storage concept beyond
/// brain + folder. `room: None` means brain-wide (the degenerate
/// one-room case). Folder filtering rides the existing `folder:`
/// query operator, and markdown stays canonical: a room is literally
/// a directory you can open.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Scope {
    pub brain_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub room: Option<String>,
}

impl Scope {
    pub fn brain(brain_id: impl Into<String>) -> Self {
        Self {
            brain_id: brain_id.into(),
            room: None,
        }
    }

    pub fn room(brain_id: impl Into<String>, room: impl Into<String>) -> Self {
        let r = normalize_room(&room.into());
        Self {
            brain_id: brain_id.into(),
            room: if r.is_empty() { None } else { Some(r) },
        }
    }

    /// Filesystem-safe identifier for per-room files
    /// ("clients/acme" -> "clients__acme"; brain-wide -> "_brain").
    pub fn room_slug(&self) -> String {
        match &self.room {
            None => "_brain".to_string(),
            Some(r) => r
                .chars()
                .map(|c| {
                    if c.is_alphanumeric() || c == '-' || c == '.' {
                        c
                    } else if c == '/' {
                        '\u{0}' // placeholder, replaced below
                    } else {
                        '_'
                    }
                })
                .collect::<String>()
                .replace('\u{0}', "__"),
        }
    }
}

/// Trim slashes/whitespace so "clients/acme/", " /clients/acme" and
/// "clients/acme" are the same room.
pub fn normalize_room(raw: &str) -> String {
    raw.trim().trim_matches('/').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_room_normalizes_and_slugs() {
        let s = Scope::room("work", "/clients/acme/");
        assert_eq!(s.room.as_deref(), Some("clients/acme"));
        assert_eq!(s.room_slug(), "clients__acme");
        assert_eq!(Scope::brain("work").room_slug(), "_brain");
        // whitespace-only room collapses to brain-wide
        assert_eq!(Scope::room("work", "  /  ").room, None);
    }
}
