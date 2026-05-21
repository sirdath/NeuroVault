//! Preference extraction — index explicit user assertions as
//! first-class retrievable facts.
//!
//! WHY (real-user problem, not bench-shape):
//! Users state durable preferences inside long mixed-content notes
//! ("…spent the morning on auth; by the way I always use ripgrep
//! instead of grep; then fixed the token bug…"). Later they ask
//! "what do I use for code search?" and the preference clause is
//! diluted by the surrounding narrative — the note's title/summary is
//! about auth debugging, and the chunk embedding splits its attention
//! across unrelated prose. Pulling the assertion sentence out and
//! indexing it as its own terse engram makes it directly retrievable.
//!
//! PRECEDENT:
//! - MemPalace `benchmarks/longmemeval_bench.py:1612` `extract_preferences`
//!   (16 regex markers, emits synthetic "User has mentioned: …" docs;
//!   measured +0.6pp, concentrated on the preference category).
//! - General IR: assertion/proposition extraction for indexing
//!   (OpenIE, "atomic facts" decomposition for long-context QA).
//!
//! DESIGN:
//! Sentence-level, not capture-group level. We split content into
//! rough sentences and keep any sentence containing a preference
//! marker, verbatim. This preserves the full assertion ("I always use
//! ripgrep instead of grep for code search") as one retrievable unit
//! instead of a lossy capture, and is far less brittle than trying to
//! parse the object of every preference construction.
//!
//! The caller (ingest slow-phase) turns each returned sentence into a
//! derived `kind='preference'` engram. Idempotency + recursion safety
//! are the caller's concern (deterministic `pref-<hash>` filename +
//! a `pref-` filename guard so a derived note can't re-extract itself).

use once_cell::sync::Lazy;
use regex::Regex;

/// Max preference sentences pulled from a single note. A pathological
/// note ("I always X. I always Y. I never Z. …") shouldn't spawn
/// dozens of derived engrams. 6 covers any realistic note; beyond that
/// the note is itself basically a preference list and the user can
/// recall it directly.
const MAX_PER_NOTE: usize = 6;

/// Minimum sentence length (chars) to bother indexing. "I prefer it."
/// has a marker but no information — skip sub-informative fragments.
const MIN_SENTENCE_CHARS: usize = 18;

/// Preference markers. Case-insensitive. Each is intentionally
/// conservative: it must look like a *standing* statement about the
/// user's habits/tastes, not a one-off ("I used grep today" must NOT
/// match — only "I always use ripgrep"). False positives create junk
/// engrams, so precision is weighted over recall here.
static MARKERS: Lazy<Vec<Regex>> = Lazy::new(|| {
    [
        // habitual verbs
        r"\bi (?:always|usually|generally|typically|normally|tend to|habitually)\b",
        // explicit preference
        r"\bi (?:prefer|favou?r|like|love|enjoy)\b",
        // explicit aversion (also a durable signal)
        r"\bi (?:never|don'?t|do not|dislike|hate|avoid|can'?t stand)\b",
        // identity statements ("I'm a vim person", "I am a morning person")
        r"\bi(?:'m| am) an? [a-z][a-z \-]{1,30}? (?:person|user|fan|type)\b",
        // go-to / default constructions
        r"\b(?:my|our) (?:go-?to|default|preferred|favou?rite) \b",
        // long-term recollection ("I still remember …", "growing up …")
        r"\bi (?:still )?(?:remember|recall)\b",
        r"\bgrowing up\b",
    ]
    .iter()
    .map(|p| Regex::new(&format!("(?i){p}")).expect("static preference regex"))
    .collect()
});

/// Split into rough sentences. Markdown notes aren't prose-perfect, so
/// we split on sentence terminators AND newlines/bullets (a preference
/// is often its own bullet line with no period). Good enough — we only
/// need the assertion clause, not linguistically perfect segmentation.
fn split_sentences(content: &str) -> Vec<String> {
    // Normalise bullets/headings to spaces so "- I always use X" →
    // "I always use X", then split on . ! ? and newlines.
    let cleaned: String = content
        .chars()
        .map(|c| match c {
            '\n' | '\r' => '.', // line break ends a unit
            '#' | '*' | '`' | '>' | '-' if false => ' ', // (kept explicit; see below)
            _ => c,
        })
        .collect();
    cleaned
        .split(['.', '!', '?'])
        .map(|s| {
            // strip leading markdown bullet/heading punctuation + ws
            s.trim()
                .trim_start_matches(|c: char| {
                    c == '#' || c == '*' || c == '-' || c == '>' || c == '`' || c == ' '
                })
                .trim()
                .to_string()
        })
        .filter(|s| !s.is_empty())
        .collect()
}

/// Extract preference sentences from note content. Returns deduped,
/// length-filtered, capped list — verbatim sentences, ready to be
/// turned into derived engrams by the caller.
pub fn extract_preferences(content: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for sentence in split_sentences(content) {
        if sentence.len() < MIN_SENTENCE_CHARS {
            continue;
        }
        let lc = sentence.to_lowercase();
        if !MARKERS.iter().any(|re| re.is_match(&lc)) {
            continue;
        }
        // Dedup on the lowercased sentence so trivial case variants
        // don't create twin engrams.
        if seen.insert(lc) {
            out.push(sentence);
            if out.len() >= MAX_PER_NOTE {
                break;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catches_habitual_use_buried_in_narrative() {
        let note = "Spent the morning debugging the auth flow. By the \
                    way I always use ripgrep instead of grep for code \
                    search — much faster on the monorepo. Then fixed \
                    the token refresh bug.";
        let prefs = extract_preferences(note);
        assert_eq!(prefs.len(), 1, "got: {prefs:?}");
        assert!(prefs[0].to_lowercase().contains("ripgrep"));
        assert!(prefs[0].to_lowercase().contains("always use"));
    }

    #[test]
    fn catches_prefer_and_identity_and_aversion() {
        let note = "I prefer Postgres over MySQL for anything \
                    relational. I am a dark-mode person through and \
                    through. I never commit directly to main.";
        let prefs = extract_preferences(note);
        assert_eq!(prefs.len(), 3, "got: {prefs:?}");
    }

    #[test]
    fn ignores_one_off_actions_without_markers() {
        let note = "I used grep today to find the bug. Then I ran the \
                    tests and pushed the fix to the branch.";
        let prefs = extract_preferences(note);
        assert!(prefs.is_empty(), "false positive: {prefs:?}");
    }

    #[test]
    fn skips_subinformative_fragments() {
        // has a marker but no payload
        let prefs = extract_preferences("I prefer it.");
        assert!(prefs.is_empty(), "got: {prefs:?}");
    }

    #[test]
    fn caps_pathological_notes() {
        let mut note = String::new();
        for i in 0..40 {
            note.push_str(&format!("I always use tool number {i} for that task. "));
        }
        let prefs = extract_preferences(&note);
        assert!(prefs.len() <= MAX_PER_NOTE, "got {} prefs", prefs.len());
    }

    #[test]
    fn derived_preference_note_does_not_self_match_into_a_loop() {
        // The caller guards recursion by filename, but the *content*
        // of a derived note ("Preference: I always use ripgrep…")
        // does still contain a marker — that's expected and fine; the
        // filename guard (pref-*) is what stops recursion, not this.
        // This test just documents that extract() is content-only and
        // has no filename awareness by design.
        let derived = "Preference: I always use ripgrep instead of grep.";
        let prefs = extract_preferences(derived);
        assert_eq!(prefs.len(), 1);
    }
}
