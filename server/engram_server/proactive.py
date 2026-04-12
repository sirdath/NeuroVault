"""Proactive context injection — detect topic patterns and pre-fetch relevant memories.

This runs WITHOUT calling any LLM. Pure pattern matching + vector similarity.
When a user message matches a trigger pattern, NeuroVault automatically fetches
relevant context so Claude doesn't have to ask.

How it works:
1. Classify the user's message into a topic domain (education, health, project, etc.)
2. If the domain matches stored memories, pre-fetch the top-K most relevant
3. Return them as proactive context attached to any tool call

The patterns are adjustable and the system is "quiet" — it only triggers when
there's enough signal to be confident.
"""

import re

from engram_server.database import Database
from engram_server.embeddings import Embedder


# Topic triggers — regex patterns that indicate a domain is being discussed
TOPIC_TRIGGERS: dict[str, list[str]] = {
    "education": [
        r"\b(school|university|college|degree|dissertation|thesis|phd|masters|student|education|learning|study|course|class|grade)\b",
    ],
    "work": [
        r"\b(job|work|career|employer|boss|colleague|meeting|project|deadline|salary|promotion|office)\b",
    ],
    "health": [
        r"\b(health|doctor|medication|exercise|diet|sleep|symptom|illness|therapy|fitness)\b",
    ],
    "code": [
        r"\b(code|function|bug|debug|deploy|test|repo|commit|pull request|api|library|framework)\b",
    ],
    "relationships": [
        r"\b(family|friend|partner|relationship|wife|husband|kids|children|parent|sibling)\b",
    ],
    "finance": [
        r"\b(money|budget|invest|save|expense|income|bank|tax|stock|crypto|loan|debt)\b",
    ],
    "writing": [
        r"\b(writing|draft|chapter|essay|article|paper|publish|edit|review|citation)\b",
    ],
    "research": [
        r"\b(research|study|experiment|hypothesis|data|analysis|method|finding|result|paper)\b",
    ],
}


def detect_topics(message: str) -> list[str]:
    """Detect which topic domains a message touches on. Returns list of matching topics."""
    message_lower = message.lower()
    hits: list[tuple[str, int]] = []

    for topic, patterns in TOPIC_TRIGGERS.items():
        match_count = 0
        for pattern in patterns:
            if re.search(pattern, message_lower):
                match_count += 1
        if match_count > 0:
            hits.append((topic, match_count))

    hits.sort(key=lambda x: x[1], reverse=True)
    return [topic for topic, _ in hits[:3]]  # Top 3 topics


def proactive_context(
    message: str,
    db: Database,
    embedder: Embedder,
    max_memories: int = 5,
    min_strength: float = 0.3,
) -> dict:
    """Given a user message, proactively fetch relevant context.

    Returns:
        {
            "topics_detected": ["education", ...],
            "memories": [{title, preview, score, topic}, ...],
            "trigger": True if any triggers matched,
        }
    """
    topics = detect_topics(message)

    if not topics:
        return {"topics_detected": [], "memories": [], "trigger": False}

    # Vector search using the raw message as the query
    query_embedding = embedder.encode(message)
    hits = db.knn_search(query_embedding, limit=max_memories * 2)

    # Filter by strength and de-duplicate
    seen: set[str] = set()
    memories: list[dict] = []
    for hit in hits:
        eid = hit["engram_id"]
        if eid in seen:
            continue
        seen.add(eid)
        if hit["strength"] < min_strength:
            continue
        similarity = max(0.0, 1.0 - hit["distance"])
        if similarity < 0.35:  # Only include genuinely relevant results
            continue

        memories.append({
            "title": hit["title"],
            "preview": hit["content"][:200],
            "similarity": round(similarity, 3),
            "strength": hit["strength"],
            "state": hit["state"],
        })

        if len(memories) >= max_memories:
            break

    return {
        "topics_detected": topics,
        "memories": memories,
        "trigger": len(memories) > 0,
    }
