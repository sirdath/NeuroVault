"""Tests for insight_extractor — silent fact extraction from conversation text."""

from pathlib import Path
from types import SimpleNamespace

from neurovault_server.database import Database
from neurovault_server.bm25_index import BM25Index
from neurovault_server.insight_extractor import (
    extract_insights,
    promote_insights_from_text,
    _looks_like_question,
    _split_sentences,
    _clean_fact,
    _slugify,
    _insight_filename,
    MAX_INSIGHTS_PER_MESSAGE,
)


# --- Question detection ---------------------------------------------------

def test_question_detection_catches_question_mark():
    assert _looks_like_question("What is the deadline?") is True
    assert _looks_like_question("I prefer Tauri.") is False


def test_question_detection_catches_leading_question_words():
    for q in ("what is X", "how do I Y", "why is Z", "when does W", "can you A", "is it B"):
        assert _looks_like_question(q) is True, f"failed on: {q}"


def test_question_detection_skips_statements_starting_with_similar_words():
    # "What" inside a sentence shouldn't trigger
    assert _looks_like_question("I know what I'm doing.") is False


def test_split_sentences_handles_multiple_punctuation():
    text = "I prefer Tauri. We chose Rust! The deadline is Friday."
    sentences = _split_sentences(text)
    assert len(sentences) == 3
    assert "I prefer Tauri" in sentences[0]


# --- Explicit save pattern -------------------------------------------------

def test_explicit_remember_pattern():
    insights = extract_insights("Remember that Sarah runs the weekly check-ins.")
    assert len(insights) == 1
    assert insights[0].pattern_name == "explicit"
    assert "Sarah" in insights[0].fact
    assert insights[0].title.startswith("Note:")


def test_explicit_fyi_pattern():
    insights = extract_insights("FYI the database password is in vault/config.yml")
    assert len(insights) == 1
    assert insights[0].pattern_name == "explicit"


def test_explicit_btw_pattern():
    insights = extract_insights("btw, the deadline is next Friday")
    assert len(insights) >= 1
    # Either explicit or deadline pattern — both acceptable
    assert any(i.pattern_name in ("explicit", "deadline") for i in insights)


# --- Preference patterns ---------------------------------------------------

def test_preference_positive():
    insights = extract_insights("I prefer Tauri 2.0 over Electron.")
    assert len(insights) == 1
    assert insights[0].pattern_name == "preference"
    assert "Tauri" in insights[0].fact
    assert insights[0].title.startswith("Preference:")


def test_preference_uses_keyword():
    insights = extract_insights("I use Neovim with LazyVim every day.")
    assert len(insights) == 1
    assert insights[0].pattern_name == "preference"
    assert "Neovim" in insights[0].fact


def test_anti_preference_captured_as_negated():
    insights = extract_insights("I don't use Electron for desktop apps.")
    assert len(insights) == 1
    assert insights[0].negated is True
    assert "Electron" in insights[0].fact
    assert "not" in insights[0].title.lower()


# --- Decision pattern ------------------------------------------------------

def test_decision_pattern_we_decided():
    insights = extract_insights("We decided to use sqlite-vec for the embedding store.")
    assert len(insights) == 1
    assert insights[0].pattern_name == "decision"
    assert "sqlite-vec" in insights[0].fact


def test_decision_pattern_we_went_with():
    insights = extract_insights("We went with Rust for the Tauri backend.")
    assert len(insights) == 1
    assert insights[0].pattern_name == "decision"


# --- Stack pattern ---------------------------------------------------------

def test_stack_pattern_were_using():
    insights = extract_insights("We're using FastAPI for the HTTP layer.")
    assert len(insights) == 1
    assert insights[0].pattern_name == "stack"
    assert "FastAPI" in insights[0].fact


# --- Deadline pattern ------------------------------------------------------

def test_deadline_pattern():
    insights = extract_insights("The deadline is next Friday at 5pm.")
    assert len(insights) == 1
    assert insights[0].pattern_name == "deadline"


# --- Rejections -----------------------------------------------------------

def test_questions_never_produce_insights():
    for q in (
        "What is the deadline?",
        "How do I install this?",
        "Why is the graph so dense?",
        "Can you help me debug this?",
        "Is it supposed to work that way?",
    ):
        assert extract_insights(q) == [], f"question leaked insight: {q}"


def test_very_short_sentences_skipped():
    assert extract_insights("No.") == []
    assert extract_insights("Yes!") == []
    assert extract_insights("ok") == []


def test_commands_without_factual_claim_skipped():
    # A pure command with no factual content shouldn't fire
    assert extract_insights("Please run the tests.") == []
    assert extract_insights("Fix the bug.") == []


# --- Multi-fact + bounded -------------------------------------------------

def test_multiple_facts_in_one_message():
    text = (
        "I prefer Tauri 2.0 for desktop apps. "
        "We decided to use sqlite-vec for embeddings. "
        "The deadline is Friday."
    )
    insights = extract_insights(text)
    assert len(insights) == 3
    pattern_names = {i.pattern_name for i in insights}
    assert "preference" in pattern_names
    assert "decision" in pattern_names
    assert "deadline" in pattern_names


def test_max_insights_per_message_is_capped():
    # 5 facts, but default cap is 3
    text = (
        "I prefer Tauri. "
        "We chose Rust. "
        "We're using FastAPI. "
        "The deadline is Friday. "
        "Remember that Sarah leads the project."
    )
    insights = extract_insights(text)
    assert len(insights) == MAX_INSIGHTS_PER_MESSAGE


def test_same_title_dedupes_within_one_call():
    # Two sentences that produce the same normalized title should collapse
    text = "I prefer Tauri. I prefer Tauri."
    insights = extract_insights(text)
    assert len(insights) == 1


# --- Clean + slug helpers --------------------------------------------------

def test_clean_fact_strips_trailing_punctuation_and_whitespace():
    assert _clean_fact("  Tauri 2.0.  ") == "Tauri 2.0"
    assert _clean_fact("  many    spaces   inside  ") == "many spaces inside"


def test_clean_fact_caps_length():
    long = "a" * 500
    assert len(_clean_fact(long)) <= 200


def test_insight_filename_is_deterministic():
    # Same title → same filename. Future runs upsert instead of dup.
    a = _insight_filename("Preference: Tauri 2.0")
    b = _insight_filename("Preference: Tauri 2.0")
    assert a == b
    assert a.startswith("insight-")
    assert a.endswith(".md")


def test_insight_filename_differs_by_title():
    a = _insight_filename("Preference: Tauri")
    b = _insight_filename("Preference: Electron")
    assert a != b


def test_slugify_handles_special_chars():
    assert _slugify("Preference: Tauri 2.0!") == "preference-tauri-2-0"
    assert _slugify("   whitespace   ") == "whitespace"


# --- Promotion → first-class engrams --------------------------------------

def _make_ctx(tmp_db: Database, tmp_path: Path) -> SimpleNamespace:
    vault = tmp_path / "vault"
    vault.mkdir()
    return SimpleNamespace(
        db=tmp_db,
        vault_dir=vault,
        bm25=BM25Index(),
        brain_id="test",
        name="Test Brain",
    )


def test_promote_creates_insight_engrams(tmp_db: Database, tmp_path: Path):
    ctx = _make_ctx(tmp_db, tmp_path)
    created = promote_insights_from_text(
        ctx,
        "I prefer Tauri 2.0 for desktop apps. We decided to use sqlite-vec.",
    )
    assert len(created) == 2

    # Each insight should be a live engram with kind='insight'
    for entry in created:
        row = tmp_db.conn.execute(
            "SELECT kind, state FROM engrams WHERE id = ?", (entry["engram_id"],)
        ).fetchone()
        assert row is not None
        assert row[0] == "insight"
        assert row[1] != "dormant"


def test_promote_upserts_on_duplicate_text(tmp_db: Database, tmp_path: Path):
    ctx = _make_ctx(tmp_db, tmp_path)
    promote_insights_from_text(ctx, "I prefer Tauri 2.0 for desktop apps.")
    # Same sentence again — should NOT create a second engram
    promote_insights_from_text(ctx, "I prefer Tauri 2.0 for desktop apps.")

    count = tmp_db.conn.execute(
        "SELECT COUNT(*) FROM engrams WHERE kind = 'insight'"
    ).fetchone()[0]
    assert count == 1


def test_promote_writes_source_provenance(tmp_db: Database, tmp_path: Path):
    ctx = _make_ctx(tmp_db, tmp_path)
    promote_insights_from_text(
        ctx,
        "I prefer Tauri 2.0.",
        source_filename="obs-abc12345-userpromptsubmit-xyz.md",
    )

    row = tmp_db.conn.execute(
        "SELECT content FROM engrams WHERE kind = 'insight' LIMIT 1"
    ).fetchone()
    assert row is not None
    assert "obs-abc12345-userpromptsubmit-xyz.md" in row[0]
    assert "[[" in row[0]  # wiki-link format


def test_promote_returns_empty_for_questions(tmp_db: Database, tmp_path: Path):
    ctx = _make_ctx(tmp_db, tmp_path)
    assert promote_insights_from_text(ctx, "What's the deadline?") == []
    assert promote_insights_from_text(ctx, "How should I install this?") == []
