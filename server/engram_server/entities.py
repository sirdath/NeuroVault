"""Entity extraction via Claude Haiku for the knowledge graph.

Extracts people, concepts, technologies, projects, and places from note content.
Falls back to a simple regex-based extractor if no API key is available.
"""

import json
import os
import uuid
import re
from loguru import logger


def _extract_entities_with_haiku(content: str) -> list[dict]:
    """Use Claude Haiku to extract structured entities."""
    try:
        import anthropic

        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            logger.debug("No ANTHROPIC_API_KEY — falling back to local extraction")
            return _extract_entities_local(content)

        client = anthropic.Anthropic(api_key=api_key)
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=600,
            messages=[{
                "role": "user",
                "content": f"""Extract entities from this text.
Return JSON ONLY, no other text:
{{
  "entities": [
    {{
      "name": "...",
      "type": "concept|person|technology|project|place",
      "relations": [
        {{"target": "...", "relation": "uses|implements|extends|causes|part_of"}}
      ]
    }}
  ]
}}

Text: {content[:2000]}"""
            }]
        )
        text = response.content[0].text.strip()

        # Parse JSON — handle markdown code blocks
        if text.startswith("```"):
            text = re.sub(r'^```(?:json)?\n?', '', text)
            text = re.sub(r'\n?```$', '', text)

        data = json.loads(text)
        return data.get("entities", [])

    except Exception as e:
        logger.warning("Haiku entity extraction failed: {} — falling back to local", e)
        return _extract_entities_local(content)


def _extract_entities_local(content: str) -> list[dict]:
    """Simple local entity extraction using patterns.

    Extracts:
    - Capitalized multi-word phrases (likely proper nouns / names)
    - Technology keywords (common programming terms)
    - Markdown headers as concepts
    """
    entities: list[dict] = []
    seen: set[str] = set()

    # Extract markdown headers as concepts
    for match in re.finditer(r'^#{1,3}\s+(.+)$', content, re.MULTILINE):
        name = match.group(1).strip()
        if name.lower() not in seen and len(name) > 2:
            seen.add(name.lower())
            entities.append({"name": name, "type": "concept", "relations": []})

    # Extract capitalized phrases (2+ words, likely proper nouns)
    for match in re.finditer(r'\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b', content):
        name = match.group(1)
        if name.lower() not in seen and len(name.split()) <= 4:
            seen.add(name.lower())
            entities.append({"name": name, "type": "person", "relations": []})

    # Extract backtick-wrapped terms as technology
    for match in re.finditer(r'`([^`]+)`', content):
        name = match.group(1).strip()
        if name.lower() not in seen and len(name) > 1 and len(name) < 40:
            seen.add(name.lower())
            entities.append({"name": name, "type": "technology", "relations": []})

    return entities[:20]  # cap to avoid noise


def extract_entities(content: str) -> list[dict]:
    """Extract entities from content. Tries Haiku first, falls back to local."""
    return _extract_entities_with_haiku(content)


def store_entities(db, engram_id: str, entities: list[dict]) -> None:
    """Store extracted entities and their mentions in the database."""
    for entity_data in entities:
        name = entity_data.get("name", "").strip()
        entity_type = entity_data.get("type", "concept")
        if not name:
            continue

        # Upsert entity
        entity_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, name.lower()))
        db.conn.execute(
            """INSERT INTO entities (id, name, entity_type, mention_count)
               VALUES (?, ?, ?, 1)
               ON CONFLICT(name) DO UPDATE SET
                 mention_count = mention_count + 1""",
            (entity_id, name, entity_type),
        )

        # Link entity to engram
        db.conn.execute(
            """INSERT OR IGNORE INTO entity_mentions (entity_id, engram_id, salience)
               VALUES (?, ?, 1.0)""",
            (entity_id, engram_id),
        )

        # Store relations as entity-to-entity links (via shared engrams)
        for rel in entity_data.get("relations", []):
            target_name = rel.get("target", "").strip()
            if target_name:
                target_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, target_name.lower()))
                db.conn.execute(
                    """INSERT OR IGNORE INTO entities (id, name, entity_type, mention_count)
                       VALUES (?, ?, 'concept', 1)""",
                    (target_id, target_name),
                )
                db.conn.execute(
                    """INSERT OR IGNORE INTO entity_mentions (entity_id, engram_id, salience)
                       VALUES (?, ?, 0.5)""",
                    (target_id, engram_id),
                )

    db.conn.commit()
