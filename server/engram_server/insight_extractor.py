"""Silent fact extraction from conversation messages — Stage 5.

When a user drops a casual factual claim in conversation ("oh by the way,
I prefer Tauri 2.0" / "remember that Sarah runs the weekly check-ins"),
the brain should silently pick it up as a first-class memory without the
user having to explicitly say "remember this". This module runs a small
set of hand-tuned regex patterns against text and extracts anything that
looks like a fact worth saving.

Design principles:

  - **Regex only, no LLM**: runs in microseconds, costs nothing, no API
    key required. The 2026-era Stage 6 can add an LLM classifier on top
    for higher recall, but the regex layer catches the obvious cases.
  - **Conservative**: false positives are worse than false negatives.
    We'd rather miss a borderline claim than save noise. Every pattern
    is anchored on strong lexical cues ("I prefer", "we decided",
    "remember that", etc.).
  - **Questions never fire**: anything ending in `?` or starting with
    a question word gets dropped before we even try matching.
  - **Bounded per message**: max 3 extractions per text block so a long
    rambling prompt can't flood the vault.
  - **Deterministic titles**: each extraction produces a stable title
    prefix ("Preference:", "Decision:", "Note:", etc.) so re-extracting
    the same fact upserts the existing engram instead of duplicating.
  - **Provenance tracked**: each insight engram carries a
    `**Source:** [[...]]` wiki-link back to the original observation, so
    you can always trace the fact to where it was said.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path

from loguru import logger


MAX_INSIGHTS_PER_MESSAGE = 3
MIN_FACT_LENGTH = 3
MAX_FACT_LENGTH = 200


# --- Pattern definitions --------------------------------------------------

@dataclass
class InsightPattern:
    name: str                       # short category name
    regex: re.Pattern                # compiled regex
    title_prefix: str               # prefix for the generated engram title
    confidence: float = 0.8          # 0-1, used for ranking if multiple match
    group: int = 1                   # regex group containing the fact
    negated: bool = False            # True if this pattern captures a "NOT" fact


def _pat(pattern: str, flags: int = re.IGNORECASE) -> re.Pattern:
    return re.compile(pattern, flags)


PATTERNS: list[InsightPattern] = [
    # Explicit "remember that ..." — highest confidence
    InsightPattern(
        name="explicit",
        regex=_pat(r"\b(?:remember|note|save|keep in mind|don'?t forget|fyi|btw,?)\s+(?:that\s+)?(.{5,200}?)(?:(?:\.(?!\w))|!|$)"),
        title_prefix="Note",
        confidence=0.95,
    ),
    # "I prefer X" / "I use X" / "I like X"
    InsightPattern(
        name="preference",
        regex=_pat(r"\bi\s+(?:prefer|like|love|always\s+use|mostly\s+use|usually\s+use|use)\s+(.{3,100}?)(?:(?:\.(?!\w))|[,!]|\s+(?:because|since|for|over|instead)|$)"),
        title_prefix="Preference",
        confidence=0.85,
    ),
    # "I don't use X" / "I'm not using X"
    InsightPattern(
        name="anti-preference",
        regex=_pat(r"\bi\s+(?:don'?t|do\s+not|no\s+longer|stopped)\s+(?:use|like|prefer)\s+(.{3,100}?)(?:(?:\.(?!\w))|[,!]|$)"),
        title_prefix="Preference: not",
        confidence=0.85,
        negated=True,
    ),
    # "we decided X" / "we chose X" / "we went with X"
    InsightPattern(
        name="decision",
        regex=_pat(r"\b(?:we|i|the\s+team)\s+(?:decided|chose|went\s+with|picked|agreed\s+on|settled\s+on|are\s+going\s+with)\s+(?:to\s+)?(.{5,150}?)(?:(?:\.(?!\w))|!|\s+because|$)"),
        title_prefix="Decision",
        confidence=0.9,
    ),
    # "we're using X" / "we're running X" — the subject is the tool itself,
    # so we stop at filler words that introduce purpose ("for", "to").
    InsightPattern(
        name="stack",
        regex=_pat(r"\b(?:we(?:'re|\s+are)|i(?:'m|\s+am))\s+(?:using|running)\s+(.{3,80}?)(?:(?:\.(?!\w))|[,!]|\s+for\s+|\s+to\s+|$)"),
        title_prefix="Stack",
        confidence=0.8,
    ),
    # "we're deploying X to Y [in Z]" — deploy verbs are destination-heavy,
    # so we keep the full phrase including the destination. Otherwise we'd
    # end up with weak facts like "the API" instead of "the API to Fly.io".
    InsightPattern(
        name="deployment",
        regex=_pat(r"\b(?:we(?:'re|\s+are)|i(?:'m|\s+am))\s+deploying\s+(.{5,140}?)(?:(?:\.(?!\w))|!|$)"),
        title_prefix="Deployment",
        confidence=0.85,
    ),
    # "the deadline is X" / "X is due on Y"
    InsightPattern(
        name="deadline",
        regex=_pat(r"\b(?:the\s+)?deadline\s+(?:is|for\s+[^\.]{3,40}\s+is)\s+(.{3,60}?)(?:(?:\.(?!\w))|!|$)"),
        title_prefix="Deadline",
        confidence=0.9,
    ),
    # "X is at path" / "X lives in path" / "X is located at path"
    InsightPattern(
        name="location",
        regex=_pat(r"\bthe\s+([\w\s-]{3,40}?)\s+(?:is|lives|can\s+be\s+found|is\s+located|resides|sits)\s+(?:in|at|on|under|inside)\s+([^\s,][^.,!?]{2,120}?)(?:[.,!]|$)"),
        title_prefix="Location",
        confidence=0.8,
        group=0,  # whole match for location type
    ),
    # "Sarah is the X" / "<Name> handles/owns/runs/leads X"
    InsightPattern(
        name="identity",
        regex=_pat(r"\b([A-Z][a-z]{2,20})\s+(?:is|handles|owns|runs|leads|manages|maintains)\s+(?:the\s+)?(.{3,80}?)(?:[.,!]|$)", re.MULTILINE),
        title_prefix="Person",
        confidence=0.75,
        group=0,
    ),
]


# --- Extraction -----------------------------------------------------------

@dataclass
class Insight:
    fact: str                  # the extracted factual statement (1-line)
    title: str                 # "Preference: Tauri 2.0"
    pattern_name: str          # which pattern matched
    confidence: float
    negated: bool = False
    sentence: str = ""         # the original sentence this was extracted from,
                               # kept for retrieval context (so "ripgrep" can be
                               # found by a query about "code search")


_QUESTION_STARTS = (
    "what", "why", "how", "when", "where", "who", "which",
    "can you", "could you", "would you", "should", "do you",
    "does", "is there", "are there", "is it", "are you",
)


def _looks_like_question(sentence: str) -> bool:
    s = sentence.strip().lower()
    if not s:
        return True
    if s.endswith("?"):
        return True
    for starter in _QUESTION_STARTS:
        if s.startswith(starter + " ") or s == starter:
            return True
    return False


def _split_sentences(text: str) -> list[str]:
    # Cheap sentence splitter — avoids bringing in nltk / spacy
    raw = re.split(r"(?<=[.!?])\s+", text.replace("\n", " "))
    return [s.strip() for s in raw if s.strip()]


def _clean_fact(fact: str) -> str:
    fact = fact.strip().rstrip(".,!?;:")
    # Collapse internal whitespace
    fact = re.sub(r"\s+", " ", fact)
    return fact[:MAX_FACT_LENGTH]


# Weak pronominal phrases — these look like they carry information but
# actually just reference something unnamed. "the API" / "a thing" are
# classic false-positive shapes from the stack regex when the real fact
# is a destination: "deploying the API to Fly.io" -> we want "Fly.io"
# not "the API".
_WEAK_FACT_RE = re.compile(
    r"^(?:the|a|an|this|that|these|those|some|my|our|their|its|his|her)\s+\w+$",
    re.IGNORECASE,
)


def _looks_too_weak(fact: str) -> bool:
    """Return True if `fact` is a pronominal placeholder with no specifics.

    Examples that should return True:
      - "the API", "a thing", "this tool", "our service"
    Examples that should return False:
      - "FastAPI", "sqlite-vec for embeddings", "the API on Fly.io"
    """
    if _WEAK_FACT_RE.match(fact.strip()):
        return True
    # Single common word with no specifics
    if len(fact.split()) == 1 and len(fact) < 4:
        return True
    return False


def _make_title(pattern: InsightPattern, fact: str) -> str:
    snippet = fact[:60].strip()
    return f"{pattern.title_prefix}: {snippet}"


def extract_insights(text: str, max_insights: int = MAX_INSIGHTS_PER_MESSAGE) -> list[Insight]:
    """Extract factual claims from a block of free text.

    Returns up to `max_insights` insights sorted by pattern confidence.
    Questions, commands, and very short sentences are skipped before
    pattern matching. A given sentence can only produce one insight
    (the highest-confidence match).
    """
    if not text:
        return []

    results: list[Insight] = []
    seen_titles: set[str] = set()

    for sentence in _split_sentences(text):
        if len(results) >= max_insights:
            break
        if _looks_like_question(sentence):
            continue
        if len(sentence) < 8 or len(sentence.split()) < 3:
            continue

        # Try each pattern; keep only the best hit per sentence
        best: tuple[InsightPattern, re.Match] | None = None
        for pat in PATTERNS:
            match = pat.regex.search(sentence)
            if not match:
                continue
            if best is None or pat.confidence > best[0].confidence:
                best = (pat, match)

        if best is None:
            continue
        pat, match = best

        try:
            raw_fact = match.group(pat.group) if pat.group > 0 else match.group(0)
        except IndexError:
            raw_fact = match.group(0)

        fact = _clean_fact(raw_fact)
        if len(fact) < MIN_FACT_LENGTH:
            continue
        if _looks_too_weak(fact):
            continue

        title = _make_title(pat, fact)
        if title in seen_titles:
            continue
        seen_titles.add(title)

        results.append(Insight(
            fact=fact,
            title=title,
            pattern_name=pat.name,
            confidence=pat.confidence,
            negated=pat.negated,
            sentence=sentence.strip().rstrip(".!?"),
        ))

    return results


# --- Promotion to first-class memories -----------------------------------

def _slugify(text: str) -> str:
    s = ""
    for ch in text.lower():
        if ch.isalnum():
            s += ch
        elif s and s[-1] != "-":
            s += "-"
    return s.strip("-")[:60]


def _insight_filename(title: str) -> str:
    """Deterministic filename so the same title always upserts the same engram."""
    slug = _slugify(title)
    # Hash to disambiguate near-identical slugs
    digest = hashlib.sha1(title.encode("utf-8")).hexdigest()[:6]
    return f"insight-{slug}-{digest}.md"


def promote_insights_from_text(
    ctx,
    text: str,
    source_engram_id: str | None = None,
    source_filename: str | None = None,
) -> list[dict]:
    """Extract insights from `text` and create first-class engrams for each.

    Each extracted insight becomes a new engram with `kind='insight'`,
    titled `<category>: <fact>`, and carries a wiki-link back to the
    source observation for provenance. Duplicate extractions upsert
    the existing engram (same filename) so re-hearing the same fact
    doesn't flood the vault.

    Returns a list of dicts summarising what was created/updated.
    """
    from engram_server.ingest import ingest_file
    from engram_server.embeddings import Embedder

    insights = extract_insights(text)
    if not insights:
        return []

    created: list[dict] = []
    for ins in insights:
        filename = _insight_filename(ins.title)
        filepath: Path = ctx.vault_dir / filename

        # Build the markdown body with provenance.
        # Body layout is tuned for retrieval: the fact + original sentence
        # both land in the content so queries that use conceptual wording
        # absent from the bare fact ("what do I use for code search?" vs
        # fact="ripgrep") still semantically match the original context.
        body_lines = [
            f"# {ins.title}",
            "",
            f"**Kind:** {ins.pattern_name}",
            f"**Confidence:** {ins.confidence}",
        ]
        if ins.negated:
            body_lines.append("**Negated:** true")
        if source_filename:
            body_lines.append(f"**Source:** [[{source_filename}]]")
        body_lines.append("")
        body_lines.append(ins.fact)
        if ins.sentence and ins.sentence.lower() != ins.fact.lower():
            body_lines.append("")
            body_lines.append(f"> {ins.sentence}")

        try:
            filepath.write_text("\n".join(body_lines), encoding="utf-8")
        except Exception as e:
            logger.debug("insight write failed: {}", e)
            continue

        try:
            engram_id = ingest_file(filepath, ctx.db, Embedder.get(), ctx.bm25)
        except Exception as e:
            logger.debug("insight ingest failed: {}", e)
            continue

        if engram_id:
            try:
                ctx.db.conn.execute(
                    "UPDATE engrams SET kind = 'insight' WHERE id = ?",
                    (engram_id,),
                )
                ctx.db.conn.commit()
            except Exception as e:
                logger.debug("insight kind tag failed: {}", e)

        created.append({
            "engram_id": engram_id,
            "filename": filename,
            "title": ins.title,
            "pattern": ins.pattern_name,
            "fact": ins.fact,
            "confidence": ins.confidence,
        })

    if created:
        logger.info("insight_extractor: promoted {} insight(s) from text", len(created))
    return created
