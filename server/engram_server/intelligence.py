"""Advanced intelligence features stolen from competitors.

- Contradiction detection (from Supermemory)
- Temporal fact tracking (from Zep/Graphiti)
- Memory type classification (from Hindsight's 4-network model)
- Wiki synthesis (from Atomic)
- Web clipper (from Atomic's browser extension concept)
"""

import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from loguru import logger

from engram_server.database import Database
from engram_server.embeddings import Embedder


# ============================================================
# CONTRADICTION DETECTION (from Supermemory)
# ============================================================

def detect_contradictions(
    db: Database,
    embedder: Embedder,
    engram_id: str,
    content: str,
) -> list[dict]:
    """Check if a new/updated memory contradicts existing ones.

    Uses semantic similarity to find related memories, then checks for
    opposing statements. Returns list of detected contradictions.
    """
    import numpy as np

    new_embedding = np.array(embedder.encode(content[:1000]), dtype=np.float32)
    new_norm = np.linalg.norm(new_embedding)
    if new_norm == 0:
        return []

    new_normalized = new_embedding / new_norm

    # Find highly similar memories (similarity > 0.7 = same topic)
    doc_embeddings = db.get_all_doc_embeddings()
    contradictions = []

    for other_id, other_emb in doc_embeddings:
        if other_id == engram_id:
            continue

        other_arr = np.array(other_emb, dtype=np.float32)
        other_norm = np.linalg.norm(other_arr)
        if other_norm == 0:
            continue

        similarity = float(np.dot(new_normalized, other_arr / other_norm))

        if similarity > 0.7:
            # High similarity = same topic. Check for contradicting statements.
            other_engram = db.get_engram(other_id)
            if not other_engram:
                continue

            contradiction = _find_contradiction_local(
                content, other_engram["content"], other_engram["title"]
            )
            if contradiction:
                cid = str(uuid.uuid4())
                db.conn.execute(
                    """INSERT OR IGNORE INTO contradictions
                       (id, engram_a, engram_b, fact_a, fact_b)
                       VALUES (?, ?, ?, ?, ?)""",
                    (cid, engram_id, other_id,
                     contradiction["fact_a"], contradiction["fact_b"]),
                )
                contradictions.append({
                    "id": cid,
                    "other_title": other_engram["title"],
                    "fact_a": contradiction["fact_a"],
                    "fact_b": contradiction["fact_b"],
                })

    if contradictions:
        db.conn.commit()
        logger.info("Detected {} contradictions for engram {}", len(contradictions), engram_id[:8])

    return contradictions


def _find_contradiction_local(new_content: str, old_content: str, old_title: str) -> dict | None:
    """Local heuristic to detect contradicting statements.

    Looks for negation patterns and opposing keywords.
    """
    negation_pairs = [
        ("use", "don't use"), ("chose", "rejected"), ("prefer", "avoid"),
        ("switched to", "switched from"), ("enabled", "disabled"),
        ("added", "removed"), ("yes", "no"), ("true", "false"),
        ("better", "worse"), ("faster", "slower"), ("free", "paid"),
        ("local", "cloud"), ("open source", "proprietary"),
    ]

    new_lower = new_content.lower()
    old_lower = old_content.lower()

    for pos, neg in negation_pairs:
        if (pos in new_lower and neg in old_lower) or (neg in new_lower and pos in old_lower):
            # Extract the surrounding context
            new_match = _extract_context(new_content, pos if pos in new_lower else neg)
            old_match = _extract_context(old_content, neg if pos in new_lower else pos)
            if new_match and old_match:
                return {"fact_a": new_match, "fact_b": old_match}

    return None


def _extract_context(text: str, keyword: str) -> str | None:
    """Extract a sentence containing the keyword."""
    for sentence in re.split(r'[.!?\n]', text):
        if keyword.lower() in sentence.lower() and len(sentence.strip()) > 10:
            return sentence.strip()[:200]
    return None


# ============================================================
# TEMPORAL FACT TRACKING (from Zep/Graphiti)
# ============================================================

def extract_temporal_facts(
    db: Database,
    engram_id: str,
    content: str,
) -> int:
    """Extract time-sensitive facts and track their validity periods.

    When a new fact supersedes an old one, marks the old as no longer current.
    """
    facts = _extract_facts_from_content(content)
    stored = 0

    for fact in facts:
        fact_id = str(uuid.uuid4())

        # Check if this fact supersedes an existing one
        existing = db.conn.execute(
            """SELECT id, fact FROM temporal_facts
               WHERE engram_id != ? AND is_current = 1""",
            (engram_id,),
        ).fetchall()

        for old_id, old_fact in existing:
            if _facts_conflict(fact, old_fact):
                # Mark old fact as superseded
                db.conn.execute(
                    """UPDATE temporal_facts SET
                       is_current = 0,
                       valid_until = datetime('now'),
                       superseded_by = ?
                       WHERE id = ?""",
                    (fact_id, old_id),
                )
                logger.debug("Fact superseded: '{}' -> '{}'", old_fact[:50], fact[:50])

        db.conn.execute(
            """INSERT OR IGNORE INTO temporal_facts (id, engram_id, fact)
               VALUES (?, ?, ?)""",
            (fact_id, engram_id, fact),
        )
        stored += 1

    db.conn.commit()
    return stored


def _extract_facts_from_content(content: str) -> list[str]:
    """Extract declarative facts from content."""
    facts = []
    for line in content.split('\n'):
        line = line.strip()
        # Bullet points are usually facts
        if line.startswith('- ') and len(line) > 20:
            facts.append(line[2:].strip())
        # Sentences with decisive verbs
        elif any(kw in line.lower() for kw in ["uses", "chose", "decided", "switched", "prefer", "running", "built with"]):
            if len(line) > 15 and len(line) < 300:
                facts.append(line)
    return facts[:20]


def _facts_conflict(new_fact: str, old_fact: str) -> bool:
    """Check if two facts are about the same topic but contradict."""
    # Simple: if they share 3+ content words and one has a negation
    new_words = set(new_fact.lower().split()) - {"the", "a", "is", "to", "and", "of", "for", "with", "in"}
    old_words = set(old_fact.lower().split()) - {"the", "a", "is", "to", "and", "of", "for", "with", "in"}
    overlap = new_words & old_words

    if len(overlap) < 3:
        return False

    # Check for opposing signals
    new_lower = new_fact.lower()
    old_lower = old_fact.lower()
    return (
        ("not" in new_lower and "not" not in old_lower) or
        ("not" in old_lower and "not" not in new_lower) or
        ("instead of" in new_lower) or
        ("switched from" in new_lower) or
        ("no longer" in new_lower)
    )


# ============================================================
# MEMORY TYPE CLASSIFICATION (from Hindsight's 4-network model)
# ============================================================

def classify_memory(db: Database, engram_id: str, content: str) -> str:
    """Classify a memory into one of 4 types.

    - fact: objective information (decisions, configs, specs)
    - experience: what happened (debugging sessions, events)
    - opinion: subjective views (preferences, assessments)
    - procedure: how-to knowledge (workflows, recipes)
    """
    content_lower = content.lower()

    # Procedure indicators
    procedure_signals = ["how to", "step 1", "step 2", "first,", "then,", "finally,",
                         "## steps", "## workflow", "run ", "install ", "execute"]
    if sum(1 for s in procedure_signals if s in content_lower) >= 2:
        memory_type = "procedure"

    # Experience indicators
    elif any(kw in content_lower for kw in ["happened", "encountered", "debugged",
             "meeting", "session", "tried", "discovered", "learned that"]):
        memory_type = "experience"

    # Opinion indicators
    elif any(kw in content_lower for kw in ["prefer", "think", "feel", "better than",
             "worse than", "should", "recommend", "opinion", "assessment"]):
        memory_type = "opinion"

    # Default: fact
    else:
        memory_type = "fact"

    db.conn.execute(
        """INSERT OR REPLACE INTO memory_types (engram_id, memory_type, confidence)
           VALUES (?, ?, 1.0)""",
        (engram_id, memory_type),
    )
    db.conn.commit()

    return memory_type


# ============================================================
# WIKI SYNTHESIS (from Atomic)
# ============================================================

def synthesize_wiki(
    db: Database,
    topic: str,
    embedder: Embedder,
) -> str:
    """Generate a wiki-style summary article from related memories.

    Finds all notes related to a topic, synthesizes them into a
    coherent article with citations.
    """
    # Find related engrams via semantic search
    query_embedding = embedder.encode(topic)
    results = db.knn_search(query_embedding, limit=10)

    if not results:
        return f"# {topic}\n\nNo memories found for this topic."

    # Collect content from related notes
    sources: list[dict] = []
    seen: set[str] = set()
    for r in results:
        eid = r["engram_id"]
        if eid in seen:
            continue
        seen.add(eid)
        engram = db.get_engram(eid)
        if engram:
            sources.append({
                "title": engram["title"],
                "content": engram["content"][:500],
            })

    # Build synthesis (local — no API needed)
    lines = [f"# {topic}", "", "*Synthesized from {} sources*".format(len(sources)), ""]

    for i, src in enumerate(sources):
        lines.append(f"## From: {src['title']}")
        # Extract key sentences
        sentences = [s.strip() for s in src["content"].split('.') if len(s.strip()) > 20]
        for sent in sentences[:3]:
            lines.append(f"- {sent}.")
        lines.append("")

    return "\n".join(lines)


# ============================================================
# WEB CLIPPER (from Atomic's browser extension concept)
# ============================================================

def clip_to_vault(
    url: str,
    title: str,
    content: str,
    vault_dir: Path,
    db: Database,
    embedder: Embedder,
    bm25,
) -> dict:
    """Save web content as a vault note. Like a browser extension save.

    Args:
        url: Source URL
        title: Page title
        content: Extracted text content
        vault_dir: Brain vault directory
        db: Database instance
        embedder: Embedder instance
        bm25: BM25 index

    Returns:
        Info about the created engram
    """
    from engram_server.ingest import ingest_file

    # Clean the content
    clean = _clean_web_content(content)

    # Build markdown
    slug = re.sub(r'[^a-z0-9]+', '-', title.lower())[:50].strip('-')
    filename = f"clip-{slug}-{uuid.uuid4().hex[:6]}.md"
    filepath = vault_dir / filename

    now = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    md = f"# {title}\n\n*Clipped from [{url}]({url}) on {now}*\n\n{clean}"
    filepath.write_text(md, encoding="utf-8")

    # Ingest through full pipeline
    engram_id = ingest_file(filepath, db, embedder, bm25)

    logger.info("Web clip saved: {} -> {}", title[:40], filename)
    return {"engram_id": engram_id, "filename": filename, "title": title}


def _clean_web_content(text: str) -> str:
    """Clean web content: remove excessive whitespace, scripts, etc."""
    # Remove common web artifacts
    text = re.sub(r'\s+', ' ', text)
    text = re.sub(r'(cookie|privacy policy|terms of service|subscribe|newsletter).*?\n', '', text, flags=re.IGNORECASE)
    # Wrap at reasonable line length
    paragraphs = text.split('. ')
    lines = []
    for p in paragraphs:
        p = p.strip()
        if p and len(p) > 10:
            lines.append(p + '.')
    return '\n\n'.join(lines)
