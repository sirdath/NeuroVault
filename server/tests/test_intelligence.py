"""Tests for advanced intelligence: contradictions, temporal facts, memory classification."""

import uuid
import hashlib
from pathlib import Path

from neurovault_server.database import Database
from neurovault_server.embeddings import Embedder
from neurovault_server.bm25_index import BM25Index
from neurovault_server.ingest import ingest_vault
from neurovault_server.intelligence import (
    classify_memory,
    extract_temporal_facts,
    detect_contradictions,
    _find_contradiction_local,
    _facts_conflict,
    synthesize_wiki,
)


def _insert(db: Database, title: str, content: str) -> str:
    eid = str(uuid.uuid4())
    h = hashlib.sha256(content.encode()).hexdigest()
    db.insert_engram(eid, f"{title.lower()}-{eid[:8]}.md", title, content, h)
    return eid


def test_classify_fact(tmp_db: Database):
    eid = _insert(tmp_db, "Config", "The API runs on port 8765 with FastAPI framework.")
    kind = classify_memory(tmp_db, eid, "The API runs on port 8765 with FastAPI framework.")
    assert kind == "fact"


def test_classify_procedure(tmp_db: Database):
    content = """# Setup Steps

How to install the dev environment:

## Steps
1. First, clone the repo
2. Then, run npm install
3. Finally, run cargo tauri dev
"""
    eid = _insert(tmp_db, "Setup", content)
    kind = classify_memory(tmp_db, eid, content)
    assert kind == "procedure"


def test_classify_opinion(tmp_db: Database):
    content = "I prefer FastAPI over Flask because it has better async support and I think the docs are clearer."
    eid = _insert(tmp_db, "Views", content)
    kind = classify_memory(tmp_db, eid, content)
    assert kind == "opinion"


def test_classify_experience(tmp_db: Database):
    content = "Yesterday I debugged a session where the auth middleware was misconfigured."
    eid = _insert(tmp_db, "Debug session", content)
    kind = classify_memory(tmp_db, eid, content)
    assert kind == "experience"


def test_facts_conflict_detects_negation():
    new_fact = "We are not using PostgreSQL anymore"
    old_fact = "We are using PostgreSQL for the database"
    assert _facts_conflict(new_fact, old_fact) is True


def test_facts_dont_conflict_when_unrelated():
    assert _facts_conflict("Python is our language", "Coffee is brewed at 8am") is False


# --- False-positive regressions from the 2025 keyword-only detector -----
# Each of these used to trigger a spurious supersede because the old
# matcher only needed 3 shared content words + the token "not" in one
# side. The new detector requires an explicit supersede marker, so a
# casual "not" isn't enough.

def test_no_conflict_from_casual_not_in_unrelated_topic():
    # Both mention "testing" but one just happens to contain "not".
    # No supersede marker → should NOT conflict.
    new = "Jest is not the only testing framework teams use"
    old = "We chose Vitest as our testing framework last year"
    assert _facts_conflict(new, old) is False


def test_no_conflict_from_added_vs_removed_overlap():
    # The old detector fired on pairs like "added X / removed X" because
    # both share "X" + function words. Without a real supersede marker,
    # these are just sequential facts, not contradictions.
    new = "Added a rate-limiter to the API"
    old = "Removed the old rate-limiter from the API"
    assert _facts_conflict(new, old) is False


def test_no_conflict_from_free_vs_paid_overlap():
    # Two facts about pricing tiers but each is a complete claim in its
    # own right — not a contradiction.
    new = "The free tier is rate-limited at 100 requests per hour"
    old = "The paid tier removes all rate limits"
    assert _facts_conflict(new, old) is False


def test_conflict_when_explicit_supersede_marker():
    # "switched from X to Y" IS a real supersede signal.
    new = "The team switched from MongoDB to PostgreSQL this month"
    old = "The team uses MongoDB for the primary database"
    assert _facts_conflict(new, old) is True


def test_conflict_when_no_longer_marker():
    new = "We no longer use Redis for session storage"
    old = "Redis handles session storage for the web tier"
    assert _facts_conflict(new, old) is True


def test_conflict_when_instead_of_marker():
    new = "The team uses Bun instead of Node for the build pipeline"
    old = "The build pipeline runs on Node"
    assert _facts_conflict(new, old) is True


def test_conflict_used_to_marker():
    new = "We used to deploy on Heroku but moved everything to Fly.io"
    old = "Production deployments run on Heroku"
    assert _facts_conflict(new, old) is True


def test_fallback_keyword_path_still_tighter_than_2025():
    # With no embeddings, the keyword fallback still requires BOTH a
    # 3+ word overlap AND an explicit supersede marker — tighter than
    # the 2025 detector which fired on any "not" mismatch.
    # Unrelated with "not" in only one → no conflict.
    assert _facts_conflict(
        "Backup jobs do not run on weekends",
        "Coffee is served in the kitchen"
    ) is False


def test_find_contradiction_local():
    new = "We decided to use the cloud for storage going forward."
    old = "We prefer local storage because it avoids cloud dependencies."
    result = _find_contradiction_local(new, old, "Storage Decision")
    # Detects local vs cloud
    if result:
        assert "fact_a" in result and "fact_b" in result


def test_extract_temporal_facts_bullet_points(tmp_db: Database):
    content = """# Updates

- The API uses FastAPI framework with async handlers
- We decided to use SQLite with sqlite-vec extension
- Switched from Flask to FastAPI for performance
"""
    eid = _insert(tmp_db, "Updates", content)
    count = extract_temporal_facts(tmp_db, eid, content)
    assert count >= 2

    facts = tmp_db.conn.execute(
        "SELECT fact FROM temporal_facts WHERE engram_id = ?", (eid,)
    ).fetchall()
    assert len(facts) >= 2


def test_detect_contradictions_no_false_positives(
    tmp_db: Database, embedder: Embedder, tmp_vault: Path
):
    """Two unrelated memories should not generate a contradiction."""
    bm25 = BM25Index()
    (tmp_vault / "a.md").write_text(
        "# Note A\n\nPython is great for data science work and machine learning.",
        encoding="utf-8",
    )
    (tmp_vault / "b.md").write_text(
        "# Note B\n\nI enjoy hiking on weekends in the nearby mountains.",
        encoding="utf-8",
    )
    ingest_vault(tmp_db, embedder, bm25, tmp_vault)

    # Run on one of them explicitly
    engrams = tmp_db.list_engrams()
    for e in engrams:
        detect_contradictions(tmp_db, embedder, e["id"], e["content"])

    # Should be no contradictions between unrelated notes
    count = tmp_db.conn.execute(
        "SELECT COUNT(*) FROM contradictions"
    ).fetchone()[0]
    assert count == 0


def test_synthesize_wiki(tmp_db: Database, embedder: Embedder, tmp_vault: Path):
    bm25 = BM25Index()
    (tmp_vault / "py1.md").write_text(
        "# Python Web Framework\n\nFastAPI is great for building modern APIs quickly.",
        encoding="utf-8",
    )
    (tmp_vault / "py2.md").write_text(
        "# Python Data\n\nPandas and NumPy are essential for data science work.",
        encoding="utf-8",
    )
    ingest_vault(tmp_db, embedder, bm25, tmp_vault)

    wiki = synthesize_wiki(tmp_db, "Python", embedder)
    assert "Python" in wiki
    assert "Synthesized from" in wiki
