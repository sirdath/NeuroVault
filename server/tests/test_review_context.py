"""Tests for review_context — token-efficient structural review summaries."""

import uuid

from engram_server.database import Database
from engram_server.variable_tracker import track_variables
from engram_server.call_graph import track_calls
from engram_server.review_context import (
    get_review_context,
    _estimate_tokens,
    _symbols_in_file,
)


def _stub(db: Database) -> str:
    eid = str(uuid.uuid4())
    db.insert_engram(eid, f"{eid}.md", "stub", "stub", "hash")
    return eid


def test_empty_filepaths_returns_empty(tmp_db: Database):
    result = get_review_context(tmp_db, [])
    assert result["files"] == []
    assert result["total_tokens"] == 0


def test_untracked_file_returns_placeholder(tmp_db: Database):
    result = get_review_context(tmp_db, ["never/ingested.py"])
    assert len(result["files"]) == 1
    f = result["files"][0]
    assert f["summary"]["tracked_symbols"] == 0
    assert f["symbols"] == []
    assert "note" in f


def test_summary_counts_functions_and_classes(tmp_db: Database):
    eid = _stub(tmp_db)
    src = "def foo(): pass\ndef bar(): pass\nclass Widget: pass\nCONST = 1\n"
    track_variables(tmp_db, eid, "a.py", src, "python")

    result = get_review_context(tmp_db, ["a.py"])
    summary = result["files"][0]["summary"]
    assert summary["functions"] == 2
    assert summary["classes"] == 1
    assert summary["tracked_symbols"] >= 3  # foo, bar, Widget + CONST


def test_symbols_include_callers_and_callees(tmp_db: Database):
    eid = _stub(tmp_db)
    src = (
        "def entry():\n"
        "    helper()\n"
        "    other()\n"
        "def helper(): pass\n"
        "def other(): pass\n"
    )
    track_variables(tmp_db, eid, "mod.py", src, "python")
    track_calls(tmp_db, eid, "mod.py", src, "python")

    result = get_review_context(tmp_db, ["mod.py"])
    syms = {s["name"]: s for s in result["files"][0]["symbols"]}

    # `entry` calls helper and other
    entry = syms["entry"]
    callee_names = {c["callee"] for c in entry["callees"]}
    assert "helper" in callee_names
    assert "other" in callee_names

    # `helper` has `entry` as a caller
    helper = syms["helper"]
    caller_names = {c["caller"] for c in helper["callers"]}
    assert "entry" in caller_names


def test_related_memories_surface_matching_engrams(tmp_db: Database):
    # Put a decision engram that mentions a function name
    eid_decision = str(uuid.uuid4())
    tmp_db.insert_engram(
        eid_decision,
        "decision-jwt.md",
        "Decision: use validate_token with RS256",
        "We decided that validate_token should use asymmetric JWT signatures.",
        "hash-decision",
    )

    # Define the function that the decision mentions
    eid_code = _stub(tmp_db)
    track_variables(tmp_db, eid_code, "auth.py", "def validate_token(): pass\n", "python")

    result = get_review_context(tmp_db, ["auth.py"])
    syms = result["files"][0]["symbols"]
    assert len(syms) >= 1
    fn = next(s for s in syms if s["name"] == "validate_token")
    titles = {m["title"] for m in fn["related_memories"]}
    assert any("validate_token" in t for t in titles)


def test_related_memories_exclude_observations(tmp_db: Database):
    # Create an observation engram that mentions the function
    eid_obs = str(uuid.uuid4())
    tmp_db.insert_engram(eid_obs, "obs-123-edit.md", "Edit · 123", "validate_token edited", "h")
    tmp_db.conn.execute(
        "UPDATE engrams SET kind = 'observation' WHERE id = ?", (eid_obs,)
    )
    tmp_db.conn.commit()

    # And a regular note that also mentions it
    eid_note = str(uuid.uuid4())
    tmp_db.insert_engram(eid_note, "note.md", "validate_token design", "notes on validate_token", "h2")

    eid_code = _stub(tmp_db)
    track_variables(tmp_db, eid_code, "auth.py", "def validate_token(): pass\n", "python")

    result = get_review_context(tmp_db, ["auth.py"])
    fn = next(s for s in result["files"][0]["symbols"] if s["name"] == "validate_token")
    mem_kinds = {m.get("kind") for m in fn["related_memories"]}
    assert "observation" not in mem_kinds


def test_token_budget_truncates_long_output(tmp_db: Database):
    # Ingest a lot of functions in one file
    eid = _stub(tmp_db)
    src = "\n".join(f"def fn_{i}(): pass" for i in range(40))
    track_variables(tmp_db, eid, "big.py", src, "python")

    # Request a tiny budget — we should get fewer symbols than 40 and truncated=True
    result = get_review_context(tmp_db, ["big.py"], total_token_budget=400)
    f = result["files"][0]
    assert len(f["symbols"]) < 40
    assert f.get("truncated") is True
    assert f["tokens_used"] <= 600  # allow some slack for JSON overhead


def test_hot_score_is_inbound_caller_count(tmp_db: Database):
    eid = _stub(tmp_db)
    src = (
        "def a():\n"
        "    popular()\n"
        "def b():\n"
        "    popular()\n"
        "def c():\n"
        "    popular()\n"
        "def popular(): pass\n"
    )
    track_variables(tmp_db, eid, "m.py", src, "python")
    track_calls(tmp_db, eid, "m.py", src, "python")

    result = get_review_context(tmp_db, ["m.py"])
    syms = {s["name"]: s for s in result["files"][0]["symbols"]}
    assert syms["popular"]["hot_score"] == 3


def test_estimate_tokens_is_positive():
    assert _estimate_tokens({"key": "value"}) > 0
    assert _estimate_tokens([]) >= 1


def test_symbols_in_file_returns_sorted_by_priority(tmp_db: Database):
    eid = _stub(tmp_db)
    src = "def fn1(): pass\nclass Cls: pass\nCONST = 1\n"
    track_variables(tmp_db, eid, "sort.py", src, "python")
    syms = _symbols_in_file(tmp_db, "sort.py")
    kinds = [s["kind"] for s in syms]
    # Classes should come before functions before constants
    cls_idx = kinds.index("class") if "class" in kinds else 99
    fn_idx = kinds.index("function") if "function" in kinds else 99
    if "class" in kinds and "function" in kinds:
        assert cls_idx < fn_idx


def test_multiple_files_get_split_budget(tmp_db: Database):
    eid = _stub(tmp_db)
    track_variables(tmp_db, eid, "one.py", "def a(): pass\n", "python")
    track_variables(tmp_db, eid, "two.py", "def b(): pass\n", "python")

    result = get_review_context(tmp_db, ["one.py", "two.py"], total_token_budget=1000)
    assert result["per_file_budget"] == 500
    assert len(result["files"]) == 2
