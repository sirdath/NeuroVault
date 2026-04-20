"""Tests for the tiered-summary generator (L0 / L1)."""

from neurovault_server.summaries import generate_summaries


def test_short_note_l0_is_the_full_first_sentence():
    content = "The user prefers pnpm over npm for JavaScript projects. Decided in April 2026."
    l0, l1 = generate_summaries(content)
    assert l0.endswith(".")
    assert "pnpm" in l0 and "npm" in l0
    # L0 should be just the first sentence, not the trailing "Decided..." part.
    assert "Decided" not in l0


def test_long_note_l1_is_first_paragraph_not_full_body():
    content = (
        "NeuroVault stores embeddings in sqlite-vec and uses BM25 for keyword "
        "retrieval, fused via reciprocal rank fusion. This is the paragraph.\n\n"
        "This is a second paragraph that should not be in L1. It contains a lot "
        "of unrelated context about implementation details we don't want in the "
        "summary because it bloats the token budget for no benefit."
    )
    l0, l1 = generate_summaries(content)
    assert "second paragraph" not in l1
    assert "sqlite-vec" in l1
    assert "BM25" in l1


def test_strips_markdown_chrome():
    # Put everything relevant in one sentence so both L0 and L1 can be
    # checked for the same stripping behavior.
    content = (
        "# Setup Guide\n\n"
        "You need **Python 3.13** and `uv` installed — see the "
        "[docs](https://example.com) for details."
    )
    l0, l1 = generate_summaries(content)
    assert "#" not in l0
    assert "**" not in l0
    assert "`" not in l0
    # Bold preserved as plain word in L0
    assert "Python" in l0
    # Link display text preserved in L1; URL dropped
    assert "docs" in l1 and "example.com" not in l1


def test_wikilink_display_text_kept():
    content = "This references [[Hybrid Retrieval|our RRF]] and [[backend-core]]."
    l0, _ = generate_summaries(content)
    assert "our RRF" in l0
    assert "backend-core" in l0
    assert "[[" not in l0 and "]]" not in l0


def test_frontmatter_stripped():
    content = (
        "---\n"
        "title: My Note\n"
        "tags: [a, b]\n"
        "---\n"
        "The actual body of the note starts here."
    )
    l0, _ = generate_summaries(content)
    assert "title:" not in l0
    assert "body" in l0


def test_code_blocks_not_in_summary():
    content = (
        "Here's a working fix:\n\n"
        "```python\n"
        "def foo():\n"
        "    return 42\n"
        "```\n\n"
        "The trick is to memoize."
    )
    l0, _ = generate_summaries(content)
    assert "def foo" not in l0
    assert "Here's a working fix" in l0 or "memoize" in l0


def test_title_prefixed_when_it_adds_information():
    # Body starts mid-topic — title carries the subject.
    content = "Uses three signals fused via reciprocal rank fusion."
    l0, _ = generate_summaries(content, title="Hybrid Retrieval")
    assert l0.startswith("Hybrid Retrieval")
    assert "three signals" in l0


def test_title_not_duplicated_when_body_restates_it():
    # Body already leads with the subject — don't prepend redundantly.
    content = "Hybrid retrieval uses three signals fused via RRF."
    l0, _ = generate_summaries(content, title="Hybrid Retrieval")
    # Should not be "Hybrid Retrieval — Hybrid retrieval uses..."
    assert l0.lower().count("hybrid retrieval") == 1


def test_empty_input():
    l0, l1 = generate_summaries("")
    assert l0 == "" and l1 == ""


def test_abbreviations_do_not_break_sentence_split():
    content = "We use tools like pytest, black, etc. for the server test stack. The JS side uses Vitest."
    l0, _ = generate_summaries(content)
    # The "etc." shouldn't truncate the sentence at "pytest, black, etc"
    assert "stack" in l0 or "server" in l0


def test_l0_truncates_when_first_sentence_is_huge():
    content = "A" * 500 + " is a ridiculous single sentence with no punctuation"
    l0, _ = generate_summaries(content, l0_chars=180)
    assert 100 < len(l0) <= 260  # allowance for trailing ellipsis


def test_l1_paragraph_break_respected():
    content = "First paragraph content.\n\nSecond paragraph."
    _, l1 = generate_summaries(content)
    assert "First paragraph content." in l1
    assert "Second paragraph" not in l1


def test_tag_only_line_stripped():
    content = "#foo #bar #baz\n\nThe actual note body is here."
    l0, _ = generate_summaries(content)
    assert "#foo" not in l0
    assert "body" in l0
