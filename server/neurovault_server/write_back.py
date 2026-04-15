"""Write-back system — the brain grows from conversations automatically.

After every Claude response, this module:
1. Extracts durable facts from the user/assistant exchange
2. Decides if a new memory should be created
3. Saves extracted facts as a new engram (triggers full ingestion)
4. Bumps access on any memories that were retrieved during the exchange

Falls back to a local extraction heuristic if no Anthropic API key is set.
"""

import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from loguru import logger

from neurovault_server.database import Database
from neurovault_server.embeddings import Embedder
from neurovault_server.bm25_index import BM25Index
from neurovault_server.ingest import ingest_file


EXTRACTION_PROMPT = (
    "From this conversation exchange, extract durable knowledge worth "
    "remembering across sessions.\n\n"
    "Focus on:\n"
    "1. New facts about the user (decisions made, preferences revealed, goals stated)\n"
    "2. Technical decisions or architectural choices\n"
    "3. Key learnings or discoveries\n"
    "4. Project context (deadlines, constraints, stakeholders)\n\n"
    "Do NOT extract:\n"
    "- Ephemeral details (what was asked, greetings, filler)\n"
    "- Information already stored in memory\n"
    "- Opinions without decisions\n\n"
    'Return JSON ONLY:\n'
    '{{\n'
    '  "facts": ["fact 1", "fact 2"],\n'
    '  "should_create_engram": true/false,\n'
    '  "engram_title": "Short descriptive title",\n'
    '  "entities": ["entity1", "entity2"]\n'
    '}}\n\n'
    "If nothing durable was learned, return:\n"
    '{{"facts": [], "should_create_engram": false, "engram_title": "", "entities": []}}\n\n'
    "User: {user_message}\n\nAssistant: {assistant_response}"
)


def _slugify(text: str) -> str:
    slug = ""
    for ch in text.lower():
        if ch.isalnum():
            slug += ch
        elif slug and slug[-1] != "-":
            slug += "-"
    return slug.strip("-")[:60]


def _extract_with_haiku(
    user_message: str,
    assistant_response: str,
) -> dict:
    """Use Claude Haiku to extract durable facts from a conversation exchange."""
    try:
        import anthropic

        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            logger.debug("No ANTHROPIC_API_KEY — falling back to local write-back extraction")
            return _extract_local(user_message, assistant_response)

        client = anthropic.Anthropic(api_key=api_key)
        prompt = EXTRACTION_PROMPT.format(
            user_message=user_message[:3000],
            assistant_response=assistant_response[:3000],
        )

        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=600,
            messages=[{"role": "user", "content": prompt}],
        )

        text = response.content[0].text.strip()

        # Handle markdown code blocks
        if text.startswith("```"):
            text = re.sub(r'^```(?:json)?\n?', '', text)
            text = re.sub(r'\n?```$', '', text)

        data = json.loads(text)
        return {
            "facts": data.get("facts", []),
            "should_create_engram": data.get("should_create_engram", False),
            "engram_title": data.get("engram_title", ""),
            "entities": data.get("entities", []),
        }

    except Exception as e:
        logger.warning("Haiku write-back extraction failed: {} — falling back to local", e)
        return _extract_local(user_message, assistant_response)


def _extract_local(
    user_message: str,
    assistant_response: str,
) -> dict:
    """Simple local fact extraction heuristic.

    Looks for decision-like patterns, preferences, and factual statements.
    """
    combined = f"{user_message}\n{assistant_response}"
    facts: list[str] = []

    # Pattern: "I decided to..." / "I chose..." / "I prefer..."
    decision_patterns = [
        r"(?:I|we)\s+(?:decided|chose|picked|selected|went with|prefer|use|switched to)\s+(.{20,100})",
        r"(?:going|decided)\s+(?:to|with)\s+(.{20,100})",
        r"(?:my|our)\s+(?:preference|choice|decision)\s+(?:is|was)\s+(.{20,100})",
    ]
    for pattern in decision_patterns:
        for match in re.finditer(pattern, combined, re.IGNORECASE):
            fact = match.group(0).strip().rstrip(".,;")
            if fact not in facts:
                facts.append(fact)

    # Pattern: "The key insight is..." / "TIL..." / "Learned that..."
    learning_patterns = [
        r"(?:key insight|important note|learned that|turns out|TIL|takeaway)[:\s]+(.{20,150})",
    ]
    for pattern in learning_patterns:
        for match in re.finditer(pattern, combined, re.IGNORECASE):
            fact = match.group(0).strip().rstrip(".,;")
            if fact not in facts:
                facts.append(fact)

    # Only create an engram if we found meaningful facts
    should_create = len(facts) >= 1
    title = ""
    if should_create and facts:
        # Use first fact as basis for title
        title = facts[0][:60].strip()
        if len(title) > 50:
            title = title[:50].rsplit(" ", 1)[0]

    return {
        "facts": facts[:5],
        "should_create_engram": should_create,
        "engram_title": title,
        "entities": [],
    }


def write_back(
    user_message: str,
    assistant_response: str,
    retrieved_engram_ids: list[str],
    db: Database,
    embedder: Embedder,
    bm25: BM25Index,
    vault_dir: Path,
) -> dict | None:
    """Process a conversation exchange and grow the brain.

    Args:
        user_message: What the user said
        assistant_response: What Claude responded
        retrieved_engram_ids: IDs of memories used in this exchange
        db: Database instance
        embedder: Embedder instance
        bm25: BM25 index instance
        vault_dir: Path to the brain's vault directory

    Returns:
        Info about the created engram, or None if nothing was extracted
    """
    # 1. Extract durable facts
    extraction = _extract_with_haiku(user_message, assistant_response)

    # 2. Bump access count for retrieved memories
    for eid in retrieved_engram_ids:
        db.bump_access(eid)

    # 3. Create new engram if significant knowledge found
    if not extraction["should_create_engram"] or not extraction["facts"]:
        logger.debug("Write-back: no durable facts extracted")
        return None

    title = extraction["engram_title"] or "Conversation Insight"
    facts = extraction["facts"]

    # Build content as a bullet list with metadata
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    content_lines = [
        f"# {title}\n",
        f"*Extracted from conversation on {now}*\n",
    ]
    for fact in facts:
        content_lines.append(f"- {fact}")

    if extraction["entities"]:
        content_lines.append(f"\n**Entities:** {', '.join(extraction['entities'])}")

    content = "\n".join(content_lines)

    # Write the markdown file
    engram_id = str(uuid.uuid4())
    short_id = engram_id[:8]
    slug = _slugify(title)
    filename = f"{slug}-{short_id}.md"
    filepath = vault_dir / filename
    filepath.write_text(content, encoding="utf-8")

    # Ingest through the full pipeline (chunk, embed, entities, links)
    ingest_file(filepath, db, embedder, bm25)

    logger.info(
        "Write-back: created '{}' with {} facts ({})",
        title, len(facts), engram_id[:8],
    )

    return {
        "engram_id": engram_id,
        "title": title,
        "facts_count": len(facts),
        "filename": filename,
    }


def build_session_context(db: Database) -> dict:
    """Build the session wake-up context (L0 + L1 layers).

    L0 (~100 tokens): Always-on identity facts — top strength, most accessed
    L1 (~300 tokens): Top 10 highest-strength memories
    L2: Dynamic, pulled on demand via recall()

    Returns a dict with l0 and l1 context strings.
    """
    # L0: Top 3 highest-access-count memories (identity/core facts)
    l0_rows = db.conn.execute(
        """SELECT title, content FROM engrams
           WHERE state != 'dormant'
           ORDER BY access_count DESC, strength DESC
           LIMIT 3"""
    ).fetchall()

    l0_items = []
    for row in l0_rows:
        # Take first 100 chars of content as summary
        summary = row[1][:100].replace("\n", " ").strip()
        l0_items.append(f"- **{row[0]}**: {summary}")

    l0_text = "\n".join(l0_items) if l0_items else "No core memories yet."

    # L1: Top 10 by strength (active memories)
    l1_rows = db.conn.execute(
        """SELECT title, content, strength, state FROM engrams
           WHERE state IN ('fresh', 'active', 'connected')
           ORDER BY strength DESC
           LIMIT 10"""
    ).fetchall()

    l1_items = []
    for row in l1_rows:
        summary = row[1][:150].replace("\n", " ").strip()
        strength_pct = f"{row[2]:.0%}"
        l1_items.append(f"- [{strength_pct}] **{row[0]}**: {summary}")

    l1_text = "\n".join(l1_items) if l1_items else "No active memories."

    # Stats
    total = db.conn.execute(
        "SELECT COUNT(*) FROM engrams WHERE state != 'dormant'"
    ).fetchone()[0]
    links = db.conn.execute("SELECT COUNT(*) FROM engram_links").fetchone()[0]

    return {
        "l0": l0_text,
        "l1": l1_text,
        "stats": {
            "total_memories": total,
            "total_connections": links,
        },
    }
