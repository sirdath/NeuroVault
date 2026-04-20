"""Tiered summaries per engram — OpenViking / ByteDance-Volcengine pattern.

Every engram carries three layers:
  - L0: one-sentence abstract, ~10-20 tokens. For fast scans.
  - L1: paragraph overview, ~50-80 tokens. For decision-making.
  - L2: full content. Existing `engrams.content` column.

Generation is heuristic first (no LLM, no API key, ~1ms per note) with
an optional LLM upgrade path the caller can trigger later (Anthropic
key required; not used in the default ingest path). The heuristic
handles 80% of notes well because they're already markdown with an H1
title + short intro paragraph.

The `recall` pipeline returns the cheapest layer that answers the query
and the agent expands to L2 on demand via `read_note` / `recall_and_read`
/ `mode="full"`. Cuts default recall payload by ~80-90% on long notes.
"""

from __future__ import annotations

import re


# ---- Heuristic --------------------------------------------------------------

# Markdown noise we strip before summarizing so quotes and headings don't
# leak into the L0 abstract. Kept narrow: aggressive stripping loses
# information the reader actually wants.
_HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s+", re.MULTILINE)
_WIKILINK_RE = re.compile(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]")
_MDLINK_RE = re.compile(r"\[([^\]]+)\]\([^)]+\)")
_CODEBLOCK_RE = re.compile(r"```[\s\S]*?```|`[^`]*`")
_FRONTMATTER_RE = re.compile(r"\A---\n[\s\S]*?\n---\n", re.MULTILINE)
# Tags on their own line (e.g. "#foo #bar\n") — remove so the L0 doesn't
# start with a tag string.
_TAG_LINE_RE = re.compile(r"^\s*(#\w+\s*)+$", re.MULTILINE)


def _strip_chrome(text: str) -> str:
    """Strip markdown chrome that's noise in a prose summary. Preserves
    paragraph breaks (\\n\\n) — callers that need fully-collapsed text
    (like L0 first-sentence extraction) do a second pass themselves.
    """
    t = _FRONTMATTER_RE.sub("", text)
    t = _CODEBLOCK_RE.sub(" ", t)
    t = _TAG_LINE_RE.sub("", t)
    t = _HEADING_RE.sub("", t)
    # Wikilinks: prefer display text (group 2, after the pipe) when
    # present, else the target. Matches Obsidian's [[target|display]]
    # convention — the display is what the reader sees.
    t = _WIKILINK_RE.sub(lambda m: m.group(2) or m.group(1), t)
    t = _MDLINK_RE.sub(lambda m: m.group(1), t)
    # Bold / italic markers — leave the word, drop the stars.
    t = re.sub(r"\*\*([^*]+)\*\*", r"\1", t)
    t = re.sub(r"\*([^*]+)\*", r"\1", t)
    # Block quotes — drop the leading >.
    t = re.sub(r"^\s*>\s?", "", t, flags=re.MULTILINE)
    # Collapse intra-line whitespace only — preserve blank lines so
    # _first_paragraph can split on \n\n. Keep leading/trailing blank
    # stripping though.
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()


def _collapse(text: str) -> str:
    """Collapse ALL whitespace (incl. paragraph breaks) into single spaces.
    Used for L0 first-sentence extraction which is a single-line shape.
    """
    return re.sub(r"\s+", " ", text).strip()


def _first_sentence(text: str, max_chars: int = 180) -> str:
    """Extract the first sentence. Falls back to a char-length truncation
    when no sentence terminator appears in `max_chars`.
    """
    if not text:
        return ""
    # Prefer an early ". " / "? " / "! " break within the budget.
    snippet = text[: max_chars + 80]  # look slightly past the budget for a nicer cut
    # Avoid common-abbreviation false splits (e.g. "e.g. " "i.e. " "Mr. ").
    snippet_for_split = re.sub(r"\b(?:e\.g|i\.e|etc|vs|Mr|Mrs|Dr|No)\.", lambda m: m.group(0).replace(".", "\x00"), snippet)
    match = re.search(r"([.!?])\s+[A-Z]", snippet_for_split)
    if match:
        end = match.start() + 1  # include the terminator
        sentence = snippet[:end].replace("\x00", ".")
        return sentence.strip()
    # No clean break — truncate at the nearest word boundary.
    if len(text) <= max_chars:
        return text.strip()
    cut = text[:max_chars].rsplit(" ", 1)[0]
    return (cut.rstrip(",;:") + "…").strip()


def _first_paragraph(text: str, max_chars: int = 480) -> str:
    """Extract the first informative paragraph (text up to a blank-line
    break or to `max_chars`, whichever comes first). Short leading
    paragraphs that look like stripped-heading residue (<40 chars, no
    sentence terminator) are skipped so L1 doesn't just echo the title.
    """
    if not text:
        return ""
    # Split into paragraphs and find the first one that looks like
    # actual prose (has a sentence terminator OR is longer than 40 chars).
    paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chosen = ""
    for p in paras:
        if len(p) >= 40 or re.search(r"[.!?]", p):
            chosen = p
            break
    if not chosen:
        # All paragraphs looked title-ish — join the first two so we
        # return something informative.
        chosen = " ".join(paras[:2]) if paras else ""
    if len(chosen) <= max_chars:
        return chosen.strip()
    cut = chosen[:max_chars].rsplit(" ", 1)[0]
    return (cut.rstrip(",;:") + "…").strip()


def generate_summaries(
    content: str,
    title: str | None = None,
    l0_chars: int = 180,
    l1_chars: int = 480,
) -> tuple[str, str]:
    """Return (L0, L1) summaries for an engram.

    L0 is a single sentence suitable for a one-line recall result
    (~10-20 tokens). L1 is a paragraph overview for the agent to decide
    whether to expand to L2 (~50-80 tokens).

    The title, if provided, is PREpended to L0 ONLY when it adds signal
    the sentence lacks — e.g. `title="Backend: Ingest Pipeline"` with
    a content that starts mid-story becomes `"Backend: Ingest Pipeline
    — <first-sentence>"`. When the content's first sentence already
    restates the title, we skip the prefix.
    """
    # Two-pass clean: L1 needs paragraph breaks preserved (so we can
    # split on \n\n), L0 wants a single-line collapsed form to extract
    # the first sentence cleanly.
    stripped = _strip_chrome(content)
    if not stripped:
        return "", ""

    l1 = _first_paragraph(stripped, max_chars=l1_chars)
    l0 = _first_sentence(_collapse(stripped), max_chars=l0_chars)

    if title:
        tnorm = title.strip().rstrip(".").lower()
        l0_start = l0.lower()[: len(tnorm) + 2]
        if tnorm and tnorm not in l0_start:
            # Title carries information the sentence doesn't — prepend it.
            l0 = f"{title.strip().rstrip('.')} — {l0}"
            # Keep L0 from ballooning — budget is roughly l0_chars + title.
            if len(l0) > l0_chars + 80:
                l0 = l0[: l0_chars + 80].rsplit(" ", 1)[0].rstrip(",;:") + "…"

    return l0, l1


__all__ = ["generate_summaries"]
