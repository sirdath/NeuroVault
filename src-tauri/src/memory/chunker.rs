//! Hierarchical text chunking + wikilink extraction.
//!
//! Byte-for-byte port of `server/neurovault_server/chunker.py`. The
//! retriever's `hit@k` numbers depend on both runtimes producing the
//! same chunk boundaries for the same input — a parity test in
//! `Phase 3 verification` diffs the output of both implementations on
//! a representative corpus.
//!
//! Three granularities, all with title-prefixed embed text:
//! - `document`: title + first 2000 chars (single chunk).
//! - `paragraph`: 2-paragraph sliding window, min 15 words, 1200-char cap.
//! - `sentence`: 3-sentence sliding window (i-1..=i+1), min 6 words,
//!   500-char cap.
//!
//! The embed text is what goes through the model; the content text is
//! what's stored for display + BM25.

use once_cell::sync::Lazy;
use regex::Regex;

/// Result shape — mirrors the dict the Python function returns. Only
/// the fields the ingest pipeline actually reads are typed; the Python
/// version shipped `id`/`engram_id`/`content`/`embed_text`/`granularity`/
/// `chunk_index` and so does this.
#[derive(Debug, Clone)]
pub struct HierChunk {
    pub id: String,
    pub engram_id: String,
    pub content: String,
    pub embed_text: String,
    pub granularity: String,
    pub chunk_index: i64,
}

/// Split text into sentences. Python uses `re.split(r'(?<=[.!?])\s+(?=[A-Z])', …)`
/// which needs lookbehind + lookahead. Rust's `regex` crate doesn't
/// support lookaround, so we scan manually for the same boundary
/// condition: a sentence terminator, followed by whitespace, followed
/// by an uppercase letter — with an additional pass that flattens
/// `\n`-delimited lines exactly like Python's `part.split('\n')` step.
fn split_sentences(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut parts: Vec<&str> = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        let c = bytes[i];
        if c == b'.' || c == b'!' || c == b'?' {
            // Advance past contiguous whitespace.
            let mut j = i + 1;
            let mut saw_whitespace = false;
            while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\t') {
                saw_whitespace = true;
                j += 1;
            }
            if saw_whitespace && j < bytes.len() && bytes[j].is_ascii_uppercase() {
                // Split position matches Python's split: everything up
                // to and including the terminator goes to the current
                // part, then we skip the run of whitespace and start
                // the next part at the uppercase letter.
                parts.push(&text[start..=i]);
                start = j;
                i = j;
                continue;
            }
        }
        i += 1;
    }
    if start < text.len() {
        parts.push(&text[start..]);
    }

    let mut sentences: Vec<String> = Vec::new();
    for part in parts {
        for line in part.split('\n') {
            let stripped = line.trim();
            if !stripped.is_empty() {
                sentences.push(stripped.to_string());
            }
        }
    }
    sentences
}

/// Extract the first `# ` heading's text — the note title. Empty if
/// the note has no H1. Whitespace-trimmed to match Python.
fn extract_title(content: &str) -> String {
    for line in content.split('\n') {
        let stripped = line.trim();
        if let Some(rest) = stripped.strip_prefix("# ") {
            return rest.trim().to_string();
        }
    }
    String::new()
}

/// Count whitespace-separated words, matching Python's `len(s.split())`
/// which collapses runs of whitespace. `str::split_whitespace` has the
/// same semantics.
fn word_count(s: &str) -> usize {
    s.split_whitespace().count()
}

/// Clip `s` to the first `max_chars` characters, respecting UTF-8
/// boundaries. Matches Python's `s[:n]` on a str (character-based for
/// non-ASCII but we usually have ASCII markdown; the bytes/char
/// distinction only bites on multibyte input).
fn clip_chars(s: &str, max_chars: usize) -> &str {
    if s.len() <= max_chars {
        return s;
    }
    // Walk char boundaries up to max_chars byte cap — this is the
    // closest match to Python string slicing for the ascii-heavy
    // markdown inputs we chunk. Proper char-count clipping would be
    // `s.chars().take(max_chars).collect::<String>()` but that
    // allocates; we accept the tiny boundary difference on rare
    // multibyte content in exchange for returning a `&str`.
    let mut end = max_chars;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Primary chunker entry point. Matches `hierarchical_chunk(content,
/// engram_id)` on the Python side.
pub fn hierarchical_chunk(content: &str, engram_id: &str) -> Vec<HierChunk> {
    let mut chunks = Vec::new();
    let mut idx: i64 = 0;
    let title = extract_title(content);
    let title_prefix = if title.is_empty() {
        String::new()
    } else {
        format!("{}: ", title)
    };

    // Strip the title line from `content` for chunking: cut everything
    // up to and including the first `# ` line.
    //
    // This used to slice at `content[line.len()..]` — the LENGTH of the
    // heading line, not its OFFSET in `content`. Those coincide only when
    // the H1 is the very first line. Two bugs fell out of it:
    //
    //   1. Silent corruption. A note with any text above its H1 was cut
    //      at a meaningless offset, so the paragraph/sentence chunks that
    //      get embedded and BM25-indexed were built from a mangled body —
    //      degrading retrieval on exactly those notes, invisibly.
    //   2. A hard panic. When that offset landed inside a multi-byte
    //      character, slicing a `str` panics ("byte index N is not a char
    //      boundary"). Release builds set `panic = "abort"`, so this took
    //      down the entire desktop app — and it is reachable from the
    //      hottest write paths there are: saving a note, the watcher
    //      picking up an external edit, folder import, and MCP `remember`.
    //      Any note mixing non-ASCII text with a non-leading H1 hit it.
    let mut body = content.to_string();
    let mut offset = 0usize;
    for line in content.split('\n') {
        if line.trim_start().starts_with("# ") {
            // `offset + line.len()` is always a char boundary: it lands
            // on the '\n' that ended this line, or at end-of-string.
            let after = (offset + line.len()).min(content.len());
            body = content[after..].trim().to_string();
            break;
        }
        offset += line.len() + 1; // +1 for the '\n' that `split` consumed
    }

    // Level 1 — document. First 2000 chars of the RAW content (not
    // body) — matches Python's `content[:2000]` which includes the
    // heading line.
    let doc_text = clip_chars(content, 2000).trim().to_string();
    if !doc_text.is_empty() {
        let embed = format!("{}{}", title_prefix, doc_text);
        chunks.push(HierChunk {
            id: format!("{}-doc-0", engram_id),
            engram_id: engram_id.to_string(),
            content: doc_text,
            embed_text: embed,
            granularity: "document".to_string(),
            chunk_index: idx,
        });
        idx += 1;
    }

    // Level 2 — paragraph windows (size 2, min 15 words, 1200-char cap).
    let paragraphs: Vec<&str> = body
        .split("\n\n")
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .collect();
    for i in 0..paragraphs.len() {
        let end = (i + 2).min(paragraphs.len());
        let window_text = paragraphs[i..end].join("\n\n");
        if word_count(&window_text) < 15 {
            continue;
        }
        let clipped = clip_chars(&window_text, 1200).to_string();
        let embed = format!("{}{}", title_prefix, clipped);
        chunks.push(HierChunk {
            id: format!("{}-para-{}", engram_id, idx),
            engram_id: engram_id.to_string(),
            content: clipped,
            embed_text: embed,
            granularity: "paragraph".to_string(),
            chunk_index: idx,
        });
        idx += 1;
    }

    // Level 3 — sentence windows (size 3: i-1..=i+1, min 6 words,
    // 500-char cap).
    let sentences = split_sentences(&body);
    for i in 0..sentences.len() {
        let start = i.saturating_sub(1);
        let end = (i + 2).min(sentences.len());
        let window_text = sentences[start..end].join(" ");
        if word_count(&window_text) < 6 {
            continue;
        }
        let clipped = clip_chars(&window_text, 500).to_string();
        let embed = format!("{}{}", title_prefix, clipped);
        chunks.push(HierChunk {
            id: format!("{}-sent-{}", engram_id, idx),
            engram_id: engram_id.to_string(),
            content: clipped,
            embed_text: embed,
            granularity: "sentence".to_string(),
            chunk_index: idx,
        });
        idx += 1;
    }

    chunks
}

// ---- Wikilink extraction ---------------------------------------------------

/// Canonical typed-link vocabulary. Mirrors `LINK_TYPES` in the Python
/// chunker; the lint pass and compiler both reference this set.
pub const LINK_TYPES: &[&str] = &[
    "works_at",
    "uses",
    "extends",
    "depends_on",
    "supersedes",
    "contradicts",
    "mentions",
    "defines",
    "part_of",
    "caused_by",
];

static WIKILINK_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]").unwrap());

/// Extract bare wikilink targets (lowercased). For `[[Foo|uses]]` this
/// returns just `"foo"`. Callers that need the link type use
/// `extract_typed_wikilinks`.
pub fn extract_wikilinks(content: &str) -> Vec<String> {
    extract_typed_wikilinks(content)
        .into_iter()
        .map(|(target, _)| target)
        .collect()
}

/// Extract `(target, link_type)` pairs. `link_type` is `None` for
/// plain `[[Target]]` links, `Some(...)` for `[[Target|type]]` links.
/// Unknown types are kept — lint handles the warning.
pub fn extract_typed_wikilinks(content: &str) -> Vec<(String, Option<String>)> {
    let mut out = Vec::new();
    for caps in WIKILINK_RE.captures_iter(content) {
        let target = caps
            .get(1)
            .map(|m| m.as_str().trim().to_lowercase())
            .unwrap_or_default();
        if target.is_empty() {
            continue;
        }
        let link_type = caps
            .get(2)
            .map(|m| m.as_str().trim().to_lowercase())
            .filter(|s| !s.is_empty());
        out.push((target, link_type));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_extraction_strips_prefix() {
        let t = extract_title("# Hello World\n\nbody");
        assert_eq!(t, "Hello World");
    }

    #[test]
    fn no_title_returns_empty() {
        assert_eq!(extract_title("no heading here"), "");
    }

    #[test]
    fn split_sentences_matches_python_case() {
        let out = split_sentences("Hello world. This is a test. Final one!");
        assert_eq!(out.len(), 3);
        assert_eq!(out[0], "Hello world.");
        assert_eq!(out[1], "This is a test.");
        assert_eq!(out[2], "Final one!");
    }

    #[test]
    fn wikilinks_lowercase_targets() {
        let out = extract_typed_wikilinks("see [[Alpha]] and [[Beta|uses]]");
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], ("alpha".to_string(), None));
        assert_eq!(out[1], ("beta".to_string(), Some("uses".to_string())));
    }

    #[test]
    fn document_chunk_always_present_for_non_empty_content() {
        let c = hierarchical_chunk("# T\n\nHello world. Short body.", "eg1");
        assert!(c.iter().any(|x| x.granularity == "document"));
        assert!(c[0].id.starts_with("eg1-doc"));
    }

    #[test]
    fn paragraph_chunks_respect_word_floor() {
        // Two paragraphs, each < 15 words combined: no paragraph chunk.
        let c = hierarchical_chunk("# T\n\nshort\n\nshort two", "eg1");
        let para_count = c.iter().filter(|x| x.granularity == "paragraph").count();
        assert_eq!(para_count, 0);
    }

    #[test]
    fn embed_text_is_title_prefixed() {
        let c = hierarchical_chunk(
            "# MyTitle\n\nFirst sentence here. Second one follows.",
            "e1",
        );
        for chunk in &c {
            assert!(chunk.embed_text.starts_with("MyTitle: "));
        }
    }

    // ---- Regression: the title-stripping offset bug -----------------
    //
    // `body` was sliced at `content[line.len()..]` — the LENGTH of the
    // heading line rather than its OFFSET. Correct only when the H1 is
    // line 1. Reached from every write path: note save, watcher, folder
    // import, MCP `remember`.

    #[test]
    fn body_is_cut_after_a_non_leading_heading() {
        // Sentinels chosen so the assertion survives the mangling. With
        // the bug the cut landed mid-way through the INTRO, so the body
        // kept the intro's tail AND the heading line itself. Asserting
        // on the intro's opening words would pass even when broken —
        // the corrupted body simply starts after them.
        let intro = "ZZINTRO alpha bravo charlie delta echo foxtrot golf \
                     hotel india juliet kilo lima mike november oscar QQTAIL.";
        let body = "The actual body text also needs to be sufficiently long \
                    so that it produces its own paragraph chunk downstream.";
        let content = format!("{intro}\n# Real Title\n\n{body}");
        let c = hierarchical_chunk(&content, "e1");

        let body_chunks: Vec<&str> = c
            .iter()
            .filter(|x| x.granularity != "document")
            .map(|x| x.content.as_str())
            .collect();
        assert!(!body_chunks.is_empty(), "expected body-derived chunks");

        for chunk in &body_chunks {
            // QQTAIL sits at the END of the intro, so it survives a
            // wrong-offset cut and proves text above the heading leaked.
            assert!(
                !chunk.contains("QQTAIL"),
                "text above the heading leaked into a body chunk: {chunk:?}"
            );
            // The heading line itself must never reach a body chunk.
            assert!(
                !chunk.contains("Real Title"),
                "heading leaked into a body chunk: {chunk:?}"
            );
        }
        assert!(
            body_chunks.iter().any(|t| t.contains("actual body text")),
            "real body missing from chunks: {body_chunks:?}"
        );
    }

    #[test]
    fn a_leading_heading_still_behaves_as_before() {
        // The case that always worked must not change.
        let content = "# T\n\nAlpha beta gamma delta epsilon zeta eta theta \
                       iota kappa lambda mu nu xi omicron pi rho sigma.";
        let c = hierarchical_chunk(content, "e1");
        let body_chunks: Vec<&str> = c
            .iter()
            .filter(|x| x.granularity != "document")
            .map(|x| x.content.as_str())
            .collect();
        assert!(
            body_chunks.iter().any(|t| t.contains("Alpha beta")),
            "{body_chunks:?}"
        );
        for chunk in &body_chunks {
            assert!(
                !chunk.contains("# T"),
                "heading leaked into body: {chunk:?}"
            );
        }
    }

    #[test]
    fn assorted_non_ascii_shapes_survive() {
        for content in [
            "émoji intro 🧠\n# Heading\n\nbody text here.",
            "Ünicode ölé\n\n# Später\n\nDeutscher Text hier.",
            "前置き\n# 見出し\n\n本文がここにあります。",
            "# 日本語だけ\n\n本文。",
            "no heading at all, just body text",
            "",
        ] {
            let _ = hierarchical_chunk(content, "e1");
        }
    }
}
