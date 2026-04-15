"""Entity extraction for the knowledge graph.

Three extraction strategies (in priority order):
1. Claude Haiku — best quality, ~$0.0003 per note
2. Enhanced local — pattern matching + heuristics (free, decent quality)
3. Basic regex — capitalized phrases only (free, fallback)

The enhanced local extractor catches:
- Markdown headers as concepts
- Capitalized multi-word phrases (proper nouns)
- Backtick-wrapped terms as technology
- Common technology keywords
- Wikilink targets as entities
"""

import json
import os
import re
import uuid

from loguru import logger

# Common technology terms to recognize without API
TECH_KEYWORDS = {
    "python", "rust", "javascript", "typescript", "react", "tauri", "sqlite",
    "fastapi", "flask", "django", "node", "npm", "cargo", "git", "github",
    "docker", "kubernetes", "aws", "gcp", "azure", "linux", "windows", "macos",
    "postgresql", "mongodb", "redis", "neo4j", "chromadb", "pinecone",
    "pytorch", "tensorflow", "scikit-learn", "numpy", "pandas",
    "openai", "anthropic", "claude", "gpt", "llm", "mcp", "rag",
    "html", "css", "tailwind", "vite", "webpack", "eslint",
    "fastmcp", "sentence-transformers", "sqlite-vec", "watchdog",
    "codemirror", "zustand", "framer-motion",
}


def _extract_entities_with_haiku(content: str) -> list[dict]:
    """Use Claude Haiku for high-quality entity extraction."""
    try:
        import anthropic

        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            logger.debug("No ANTHROPIC_API_KEY — using enhanced local extraction")
            return _extract_entities_local(content)

        client = anthropic.Anthropic(api_key=api_key)
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=600,
            messages=[{
                "role": "user",
                "content": (
                    "Extract entities from this text.\n"
                    "Return JSON ONLY, no other text:\n"
                    '{"entities": [{"name": "...", "type": "concept|person|technology|project|place", '
                    '"relations": [{"target": "...", "relation": "uses|implements|extends|causes|part_of"}]}]}\n\n'
                    f"Text: {content[:2000]}"
                ),
            }],
        )
        text = response.content[0].text.strip()
        if text.startswith("```"):
            text = re.sub(r'^```(?:json)?\n?', '', text)
            text = re.sub(r'\n?```$', '', text)
        data = json.loads(text)
        return data.get("entities", [])

    except Exception as e:
        logger.warning("Haiku extraction failed: {} — using local", e)
        return _extract_entities_local(content)


def _extract_entities_local(content: str) -> list[dict]:
    """Enhanced local entity extraction using multiple heuristics."""
    entities: list[dict] = []
    seen: set[str] = set()

    def add(name: str, etype: str) -> None:
        key = name.lower().strip()
        if key and key not in seen and len(key) > 1:
            seen.add(key)
            entities.append({"name": name.strip(), "type": etype, "relations": []})

    # 1. Markdown headers → concepts
    for match in re.finditer(r'^#{1,3}\s+(.+)$', content, re.MULTILINE):
        name = match.group(1).strip()
        if len(name) > 2 and len(name) < 60:
            add(name, "concept")

    # 2. Wikilinks → whatever they reference
    for match in re.finditer(r'\[\[([^\]]+)\]\]', content):
        add(match.group(1).strip(), "concept")

    # 3. Backtick terms → technology
    for match in re.finditer(r'`([^`]+)`', content):
        name = match.group(1).strip()
        if 1 < len(name) < 40 and not name.startswith('{'):
            add(name, "technology")

    # 4. Known technology keywords from content
    content_lower = content.lower()
    for tech in TECH_KEYWORDS:
        if tech in content_lower:
            # Find the properly cased version in the text
            pattern = re.compile(re.escape(tech), re.IGNORECASE)
            match = pattern.search(content)
            if match:
                add(match.group(0), "technology")

    # 5. Capitalized multi-word phrases (2-4 words) → person or concept
    for match in re.finditer(r'\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b', content):
        name = match.group(1)
        # Skip common false positives
        if name.lower() not in {"the", "this", "that", "these", "those"}:
            add(name, "person")

    # 6. Quoted terms → concept
    for match in re.finditer(r'"([^"]{3,40})"', content):
        name = match.group(1).strip()
        if not name.startswith('http'):
            add(name, "concept")

    return entities[:30]


def extract_entities(content: str) -> list[dict]:
    """Extract entities — tries Haiku first, falls back to enhanced local."""
    return _extract_entities_with_haiku(content)


def store_entities(db, engram_id: str, entities: list[dict]) -> None:
    """Store extracted entities and their mentions in the database."""
    for entity_data in entities:
        name = entity_data.get("name", "").strip()
        entity_type = entity_data.get("type", "concept")
        if not name:
            continue

        entity_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, name.lower()))
        # Upsert: increment mention count if entity exists
        existing = db.conn.execute(
            "SELECT id, mention_count FROM entities WHERE id = ? OR name = ? COLLATE NOCASE",
            (entity_id, name),
        ).fetchone()
        if existing:
            db.conn.execute(
                "UPDATE entities SET mention_count = mention_count + 1 WHERE id = ?",
                (existing[0],),
            )
            entity_id = existing[0]
        else:
            db.conn.execute(
                "INSERT OR IGNORE INTO entities (id, name, entity_type, mention_count) VALUES (?, ?, ?, 1)",
                (entity_id, name, entity_type),
            )

        db.conn.execute(
            """INSERT OR IGNORE INTO entity_mentions (entity_id, engram_id, salience)
               VALUES (?, ?, 1.0)""",
            (entity_id, engram_id),
        )

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
