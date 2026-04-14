"""Tests for hooks: dedupe cache, capture_observation, privacy filtering."""

from engram_server.hooks import (
    _observation_signature,
    _is_recent_duplicate,
    _recent_sigs,
    _strip_private,
    _format_observation,
    capture_observation,
)


def _reset_dedupe():
    _recent_sigs.clear()


# --- Signature + dedupe cache ---------------------------------------------

def test_signature_none_for_non_post_tool_use():
    sig = _observation_signature("SessionStart", {"session_id": "abc"})
    assert sig is None


def test_signature_stable_for_same_input():
    payload = {"session_id": "sess1", "tool_name": "Edit", "tool_input": {"path": "x.py"}}
    sig1 = _observation_signature("PostToolUse", payload)
    sig2 = _observation_signature("PostToolUse", payload)
    assert sig1 == sig2
    assert sig1 is not None


def test_signature_differs_for_different_tools():
    p1 = {"session_id": "s", "tool_name": "Edit", "tool_input": {"x": 1}}
    p2 = {"session_id": "s", "tool_name": "Bash", "tool_input": {"x": 1}}
    assert _observation_signature("PostToolUse", p1) != _observation_signature("PostToolUse", p2)


def test_signature_differs_for_different_sessions():
    p1 = {"session_id": "sess1", "tool_name": "Edit", "tool_input": {"x": 1}}
    p2 = {"session_id": "sess2", "tool_name": "Edit", "tool_input": {"x": 1}}
    assert _observation_signature("PostToolUse", p1) != _observation_signature("PostToolUse", p2)


def test_dedupe_cache_detects_repeat():
    _reset_dedupe()
    sig = "test-session:Edit:abc123"
    assert _is_recent_duplicate(sig) is False
    assert _is_recent_duplicate(sig) is True
    assert _is_recent_duplicate(sig) is True


def test_dedupe_cache_distinct_sigs_independent():
    _reset_dedupe()
    assert _is_recent_duplicate("sig-a") is False
    assert _is_recent_duplicate("sig-b") is False
    assert _is_recent_duplicate("sig-a") is True
    assert _is_recent_duplicate("sig-b") is True


# --- Privacy filter -------------------------------------------------------

def test_strip_private_removes_tagged_blocks():
    text = "safe stuff <private>secret token xyz</private> more safe"
    cleaned = _strip_private(text)
    assert "secret token xyz" not in cleaned
    assert "safe stuff" in cleaned
    assert "more safe" in cleaned


def test_strip_private_handles_multiline():
    text = "keep\n<private>\nline1\nline2\n</private>\nkeep2"
    cleaned = _strip_private(text)
    assert "line1" not in cleaned
    assert "line2" not in cleaned
    assert "keep" in cleaned and "keep2" in cleaned


def test_strip_private_case_insensitive():
    text = "A <PRIVATE>hidden</PRIVATE> B"
    cleaned = _strip_private(text)
    assert "hidden" not in cleaned


# --- Format observation ---------------------------------------------------

def test_format_observation_post_tool_use():
    title, body = _format_observation("PostToolUse", {
        "session_id": "abc12345",
        "tool_name": "Edit",
        "tool_input": {"file_path": "foo.py"},
        "tool_response": "done",
    })
    assert "Edit" in title
    assert "**Event:** PostToolUse" in body
    assert "**Tool:** `Edit`" in body
    assert "foo.py" in body


def test_format_observation_user_prompt_strips_private():
    title, body = _format_observation("UserPromptSubmit", {
        "session_id": "sess",
        "prompt": "Hello <private>api-key-xyz</private> world",
    })
    assert "api-key-xyz" not in body
    assert "Hello" in body


# --- End-to-end capture + dedupe ------------------------------------------

class _FakeBrainContext:
    """Minimal BrainContext stand-in for capture tests."""
    def __init__(self, db, vault_dir, bm25):
        self.db = db
        self.vault_dir = vault_dir
        self.bm25 = bm25


def test_capture_observation_dedupes_spam(tmp_db, tmp_vault, embedder):
    from engram_server.bm25_index import BM25Index
    _reset_dedupe()

    ctx = _FakeBrainContext(tmp_db, tmp_vault, BM25Index())
    payload = {
        "session_id": "spam-test",
        "tool_name": "Edit",
        "tool_input": {"file_path": "same.py", "old_string": "x", "new_string": "y"},
        "tool_response": "ok",
    }

    captured = 0
    deduped = 0
    for _ in range(5):
        result = capture_observation(ctx, embedder, "PostToolUse", payload)
        if result is None:
            continue
        if result.get("status") == "deduped":
            deduped += 1
        elif result.get("status") == "ok":
            captured += 1

    assert captured == 1
    assert deduped == 4


def test_capture_observation_skips_trivial_tools(tmp_db, tmp_vault, embedder):
    from engram_server.bm25_index import BM25Index
    _reset_dedupe()

    ctx = _FakeBrainContext(tmp_db, tmp_vault, BM25Index())
    for tool in ("Read", "Ls", "Glob", "Grep", "TodoWrite"):
        result = capture_observation(ctx, embedder, "PostToolUse", {
            "session_id": "test",
            "tool_name": tool,
            "tool_input": {"file_path": "x"},
            "tool_response": "ok",
        })
        assert result is None, f"{tool} should be filtered but got {result}"


def test_capture_observation_tags_kind_as_observation(tmp_db, tmp_vault, embedder):
    from engram_server.bm25_index import BM25Index
    _reset_dedupe()

    ctx = _FakeBrainContext(tmp_db, tmp_vault, BM25Index())
    result = capture_observation(ctx, embedder, "SessionStart", {
        "session_id": "kind-tag-test",
        "cwd": "/tmp/demo",
    })
    assert result is not None and result["status"] == "ok"

    row = tmp_db.conn.execute(
        "SELECT kind FROM engrams WHERE id = ?", (result["engram_id"],)
    ).fetchone()
    assert row is not None
    assert row[0] == "observation"
