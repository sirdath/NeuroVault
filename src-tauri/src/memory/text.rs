//! Small string helpers that are safe on non-ASCII input.
//!
//! Why this module exists: an audit before the open-source release found
//! six separate panics in shipping code, and every one was the same
//! mistake — `&s[..n.min(s.len())]`. The author writes `.min(len)` and
//! believes that is the safety check. It isn't. It guards the *length*;
//! the hazard is the *char boundary*. Slicing a `str` at an index inside
//! a multi-byte character panics:
//!
//! ```text
//! byte index 60 is not a char boundary; it is inside 'こ' (bytes 58..61)
//! ```
//!
//! Release builds set `panic = "abort"` (see Cargo.toml), so each of
//! those was not a failed request but a **SIGABRT that killed the whole
//! desktop app** — editor, webview, watcher and server together. And
//! because `cargo test` and `tauri dev` build with unwind, the failure
//! looked like a dropped connection in development and a total crash
//! only in the shipped product.
//!
//! The affected inputs were ordinary: a recall query in Japanese, a note
//! title with an accent, a journal containing an emoji. Every existing
//! test was ASCII, which is exactly why these survived to a release
//! audit.
//!
//! Use these helpers instead of slicing by hand.

/// Truncate `s` to at most `max_bytes`, snapping down to the nearest
/// character boundary. Never panics, never splits a character.
///
/// Prefer this over `&s[..n.min(s.len())]` anywhere `s` can contain
/// user text — note titles, queries, log lines, file contents.
pub fn truncate_bytes(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    // `is_char_boundary(0)` is always true, so this terminates.
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Take the last `max_bytes` of `s`, snapping *up* to the nearest
/// character boundary so the returned tail is valid UTF-8.
///
/// The mirror of `truncate_bytes`, for "scan the tail of a big file"
/// patterns like the journal's idempotency check.
pub fn tail_bytes(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut start = s.len() - max_bytes;
    // Walk forward to a boundary; `s.len()` is always one, so this
    // terminates.
    while !s.is_char_boundary(start) {
        start += 1;
    }
    &s[start..]
}

#[cfg(test)]
mod tests {
    use super::*;

    // The bug class these helpers exist to prevent. Each case is a real
    // panic that shipped, reduced to its essentials.

    #[test]
    fn truncate_never_splits_a_character() {
        // 3 bytes per char: every cut from 1..8 lands mid-character
        // somewhere, and each must snap down rather than panic.
        let jp = "日本語のテキスト";
        for n in 0..=jp.len() {
            let out = truncate_bytes(jp, n);
            assert!(out.len() <= n);
            assert!(jp.starts_with(out));
        }
    }

    #[test]
    fn truncate_at_60_bytes_the_recall_multi_case() {
        // handlers::recall_multi logged `&s[..s.len().min(60)]`. For CJK
        // (3 bytes/char) byte 60 lands mid-character about 2 times in 3,
        // so a normal-length Japanese query had a coin-flip chance of
        // killing the app — from a debug log line, not from logic.
        let q = "日本語".repeat(40);
        assert!(q.len() > 60);
        let out = truncate_bytes(&q, 60);
        // 60 is divisible by 3, so the cut lands exactly on a boundary
        // here; the point is that it never exceeds the cap.
        assert_eq!(out.len(), 60);
        assert!(std::str::from_utf8(out.as_bytes()).is_ok());
    }

    #[test]
    fn truncate_is_a_no_op_when_it_fits() {
        assert_eq!(truncate_bytes("short", 100), "short");
        assert_eq!(truncate_bytes("", 10), "");
        assert_eq!(truncate_bytes("exact", 5), "exact");
    }

    #[test]
    fn truncate_handles_a_zero_cap_and_emoji() {
        assert_eq!(truncate_bytes("日本", 0), "");
        // A 4-byte char must not be split at any offset.
        let emoji = "🧠🧠🧠";
        for n in 0..=emoji.len() {
            assert!(emoji.starts_with(truncate_bytes(emoji, n)));
        }
    }

    #[test]
    fn tail_never_splits_a_character() {
        // journal::append_idempotent sliced at `len - 64KiB`. Every
        // append shifts the length, so it re-sampled a new offset each
        // time — for a journal with any accented title this was not
        // "if" but "how many events until".
        let s = "héllo wörld ünicode";
        for n in 0..=s.len() {
            let out = tail_bytes(s, n);
            // Snapping FORWARD to a boundary can only shrink the tail,
            // never grow it past the cap.
            assert!(out.len() <= n);
            assert!(s.ends_with(out));
        }
    }

    #[test]
    fn tail_is_a_no_op_when_it_fits() {
        assert_eq!(tail_bytes("short", 100), "short");
        assert_eq!(tail_bytes("", 10), "");
    }

    #[test]
    fn tail_reproduces_the_journal_offset() {
        // The exact shape from the audit: a file just over the 64 KiB
        // window whose boundary char straddles the cut.
        let mut raw = "é".repeat(32_768); // 65_536 bytes
        raw.push_str("\"idempotency_key\":\"abc\"");
        let tail = tail_bytes(&raw, 64 * 1024);
        assert!(tail.contains("\"idempotency_key\":\"abc\""));
    }
}
