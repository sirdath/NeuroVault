//! Tiered summaries per engram — L0 abstract + L1 paragraph overview.
//!
//! Port of `server/neurovault_server/summaries.py`. The Phase-3 parity
//! test feeds the same markdown to both implementations and compares
//! the outputs — the regex set here is chosen to match Python's output
//! on the common cases (markdown chrome stripping, wikilink display-
//! preference, abbreviation-aware first-sentence split).
//!
//! Heuristic-only. The Python file has an optional LLM upgrade path;
//! the Rust port skips it because LLM calls don't belong on the hot
//! ingest path — advanced-features-as-subprocess (Phase 8) will run
//! the LLM re-summarise if a user asks for it.

use once_cell::sync::Lazy;
use regex::Regex;

/// Markdown noise regexes. Each one mirrors the Python module-level
/// constant with the same name and semantics. `(?m)` inline flag
/// replaces Python's `re.MULTILINE`.
static HEADING_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^\s{0,3}#{1,6}\s+").unwrap());
static WIKILINK_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]").unwrap());
static MDLINK_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\[([^\]]+)\]\([^)]+\)").unwrap());
/// Code block + inline code. Python's pattern uses `[\s\S]` for a
/// dot-matches-all shorthand; we switch to `(?s)` + `.` which Rust's
/// regex engine supports natively.
static CODEBLOCK_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?s)```.*?```|`[^`]*`").unwrap());
/// `\A` matches start-of-input; same as Python.
static FRONTMATTER_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?s)\A---\n.*?\n---\n").unwrap());
/// Tag-only line: `#foo #bar` with nothing else.
static TAG_LINE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^\s*(?:#\w+\s*)+$").unwrap());

static BOLD_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\*\*([^*]+)\*\*").unwrap());
static ITALIC_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\*([^*]+)\*").unwrap());
static BLOCKQUOTE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^\s*>\s?").unwrap());
static WHITESPACE_RUN_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[ \t]+").unwrap());
static TRIPLE_NEWLINES_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\n{3,}").unwrap());
static SENTENCE_BREAK_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"([.!?])\s+[A-Z]").unwrap());
/// Abbreviation-protected dot replacement. Python uses a callback;
/// we do the same via `replace_all` with a closure.
static ABBREV_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\b(?:e\.g|i\.e|etc|vs|Mr|Mrs|Dr|No)\.").unwrap());
/// Paragraph splitter: `\n\s*\n`. Matches Python's `re.split`.
static PARAGRAPH_SPLIT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\n\s*\n").unwrap());
/// All-whitespace collapse. Python uses `re.sub(r"\s+", " ", text)`.
static COLLAPSE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s+").unwrap());

/// Strip markdown chrome but preserve paragraph breaks. The L0 path
/// needs a second pass (`collapse`) to flatten those breaks.
fn strip_chrome(text: &str) -> String {
    let t = FRONTMATTER_RE.replace(text, "").into_owned();
    let t = CODEBLOCK_RE.replace_all(&t, " ").into_owned();
    let t = TAG_LINE_RE.replace_all(&t, "").into_owned();
    let t = HEADING_RE.replace_all(&t, "").into_owned();
    // Wikilinks: display text if the pipe form is present, else target.
    let t = WIKILINK_RE
        .replace_all(&t, |caps: &regex::Captures| {
            caps.get(2)
                .map(|m| m.as_str().to_string())
                .unwrap_or_else(|| caps.get(1).map(|m| m.as_str().to_string()).unwrap_or_default())
        })
        .into_owned();
    // Markdown links: keep display text only.
    let t = MDLINK_RE
        .replace_all(&t, |caps: &regex::Captures| {
            caps.get(1).map(|m| m.as_str().to_string()).unwrap_or_default()
        })
        .into_owned();
    // Bold / italic — keep the word, drop the markers.
    let t = BOLD_RE.replace_all(&t, "$1").into_owned();
    let t = ITALIC_RE.replace_all(&t, "$1").into_owned();
    // Block quotes — drop the leading `>`.
    let t = BLOCKQUOTE_RE.replace_all(&t, "").into_owned();
    // Collapse intra-line whitespace but keep blank lines intact.
    let t = WHITESPACE_RUN_RE.replace_all(&t, " ").into_owned();
    let t = TRIPLE_NEWLINES_RE.replace_all(&t, "\n\n").into_owned();
    t.trim().to_string()
}

/// Collapse every whitespace run (including blank lines) to a single
/// space. Used on the L0 path where we want a flat, single-line
/// shape before first-sentence extraction.
fn collapse(text: &str) -> String {
    COLLAPSE_RE.replace_all(text, " ").trim().to_string()
}

/// Truncate `s` at the last space before `max_chars`. Used by both
/// `first_sentence` and `first_paragraph` fallbacks. Adds an ellipsis
/// and strips trailing comma/semicolon/colon to match Python.
fn truncate_at_word(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.trim().to_string();
    }
    // Character-count truncation — Python slices by index which for
    // ASCII maps 1:1 to bytes but not for multibyte. Be careful.
    let cut: String = s.chars().take(max_chars).collect();
    let cut = match cut.rfind(' ') {
        Some(idx) => &cut[..idx],
        None => &cut,
    };
    let trimmed = cut.trim_end_matches(|c: char| c == ',' || c == ';' || c == ':');
    format!("{}…", trimmed).trim().to_string()
}

/// Extract the first sentence. Prefers a clean `.!?` break within the
/// character budget; falls back to a word-boundary truncation with
/// ellipsis. Abbreviations are temporarily masked so "e.g." doesn't
/// falsely split.
fn first_sentence(text: &str, max_chars: usize) -> String {
    if text.is_empty() {
        return String::new();
    }
    let char_count = text.chars().count();
    let window_end = (max_chars + 80).min(char_count);
    let snippet: String = text.chars().take(window_end).collect();

    // Mask abbreviation dots with NUL — the replace callback swaps
    // each `.` in the match with `\x00`, same trick Python uses.
    let snippet_masked = ABBREV_RE
        .replace_all(&snippet, |caps: &regex::Captures| {
            caps.get(0)
                .map(|m| m.as_str().replace('.', "\u{0}"))
                .unwrap_or_default()
        })
        .into_owned();

    if let Some(m) = SENTENCE_BREAK_RE.find(&snippet_masked) {
        // End position = start of the match + 1 (include the terminator).
        // Byte offset into `snippet_masked` equals the byte offset into
        // `snippet` because the replacement preserves byte count (dot
        // and NUL are both 1 byte).
        let end = m.start() + 1;
        let sentence: String = snippet[..end].replace('\u{0}', ".");
        return sentence.trim().to_string();
    }

    // No clean break — character-count truncate.
    if char_count <= max_chars {
        return text.trim().to_string();
    }
    truncate_at_word(text, max_chars)
}

/// Extract the first informative paragraph. Skips leading "paragraphs"
/// that look like stripped-heading residue (< 40 chars and no
/// terminator) so L1 doesn't just echo the title.
fn first_paragraph(text: &str, max_chars: usize) -> String {
    if text.is_empty() {
        return String::new();
    }
    let paras: Vec<String> = PARAGRAPH_SPLIT_RE
        .split(text)
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();

    let mut chosen: Option<String> = None;
    for p in &paras {
        let has_terminator = p.contains('.') || p.contains('!') || p.contains('?');
        if p.chars().count() >= 40 || has_terminator {
            chosen = Some(p.clone());
            break;
        }
    }

    let chosen = match chosen {
        Some(c) => c,
        None => {
            // Nothing looked prose-ish — join the first two paragraphs
            // so L1 is at least informative. Matches Python's fallback.
            let joined = paras.iter().take(2).cloned().collect::<Vec<_>>().join(" ");
            joined
        }
    };

    if chosen.chars().count() <= max_chars {
        return chosen.trim().to_string();
    }
    truncate_at_word(&chosen, max_chars)
}

/// Public entry point. Returns `(L0, L1)` — a one-sentence abstract
/// and a paragraph overview. `title`, if passed, is optionally
/// prepended to L0 when the first sentence doesn't already restate it.
pub fn generate_summaries(
    content: &str,
    title: Option<&str>,
    l0_chars: usize,
    l1_chars: usize,
) -> (String, String) {
    let stripped = strip_chrome(content);
    if stripped.is_empty() {
        return (String::new(), String::new());
    }

    let l1 = first_paragraph(&stripped, l1_chars);
    let l0 = first_sentence(&collapse(&stripped), l0_chars);

    let mut l0 = l0;
    if let Some(t) = title {
        let tnorm = t.trim().trim_end_matches('.').to_lowercase();
        if !tnorm.is_empty() {
            let prefix_len = (tnorm.chars().count() + 2).min(l0.chars().count());
            let l0_start: String = l0
                .chars()
                .take(prefix_len)
                .collect::<String>()
                .to_lowercase();
            if !l0_start.contains(&tnorm) {
                let title_clean = t.trim().trim_end_matches('.');
                l0 = format!("{} — {}", title_clean, l0);
                // Bound L0 growth.
                let cap = l0_chars + 80;
                if l0.chars().count() > cap {
                    l0 = truncate_at_word(&l0, cap);
                }
            }
        }
    }

    (l0, l1)
}

/// Convenience wrapper matching the Python default character budgets
/// (l0=180, l1=480). Used by the ingest pipeline.
pub fn generate_summaries_default(content: &str, title: Option<&str>) -> (String, String) {
    generate_summaries(content, title, 180, 480)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_returns_empty_pair() {
        let (l0, l1) = generate_summaries_default("", None);
        assert_eq!(l0, "");
        assert_eq!(l1, "");
    }

    #[test]
    fn strip_chrome_removes_frontmatter_and_heading() {
        let input = "---\ntags: [a]\n---\n# Title\n\nBody here. Second sentence.";
        let out = strip_chrome(input);
        assert!(!out.contains("---"));
        assert!(!out.contains("# "));
        assert!(out.contains("Body here"));
    }

    #[test]
    fn first_sentence_respects_abbreviations() {
        // "e.g." must not cause a split; "Real break." should.
        let s = first_sentence("See e.g. foo bar. Real break here. Third.", 180);
        assert!(s.starts_with("See e.g. foo bar."));
    }

    #[test]
    fn title_prefix_added_when_missing() {
        let (l0, _) = generate_summaries(
            "Body text with no title-restating first sentence.",
            Some("My Topic"),
            180,
            480,
        );
        assert!(l0.starts_with("My Topic — "));
    }

    #[test]
    fn title_prefix_skipped_when_already_present() {
        let (l0, _) = generate_summaries(
            "My Topic overview goes here. More text follows.",
            Some("My Topic"),
            180,
            480,
        );
        assert!(!l0.starts_with("My Topic — "));
    }
}
