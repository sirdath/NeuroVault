"""Tests for the todos module — multi-agent handoff storage."""

from pathlib import Path

import pytest

from neurovault_server import todos


@pytest.fixture
def brain_dir(tmp_path: Path) -> Path:
    return tmp_path


def test_empty_brain_has_no_todos(brain_dir: Path) -> None:
    assert todos.list_todos(brain_dir) == []


def test_add_and_list(brain_dir: Path) -> None:
    t = todos.add_todo(brain_dir, "Ingest April logs", context="see obs-*", to_agent="claude-code", from_agent="user")
    assert t["id"]
    assert t["status"] == "open"
    assert t["task"] == "Ingest April logs"
    listed = todos.list_todos(brain_dir)
    assert len(listed) == 1 and listed[0]["id"] == t["id"]


def test_claim_returns_specific_agent_first(brain_dir: Path) -> None:
    # First two are "any", third is specifically for "claude-code"
    todos.add_todo(brain_dir, "Do general thing A", to_agent="any")
    todos.add_todo(brain_dir, "Do general thing B", to_agent="any")
    t_specific = todos.add_todo(brain_dir, "Fix bug", to_agent="claude-code")
    # claude-code claims "Fix bug" (specifically addressed) before the earlier "any" todos
    claimed = todos.claim_todo(brain_dir, "claude-code")
    assert claimed is not None and claimed["id"] == t_specific["id"]
    assert claimed["status"] == "claimed"
    assert claimed["claimed_by"] == "claude-code"


def test_claim_falls_back_to_any(brain_dir: Path) -> None:
    t1 = todos.add_todo(brain_dir, "Generic task", to_agent="any")
    claimed = todos.claim_todo(brain_dir, "claude-desktop")
    assert claimed is not None and claimed["id"] == t1["id"]


def test_claim_returns_none_when_empty(brain_dir: Path) -> None:
    assert todos.claim_todo(brain_dir, "claude-code") is None


def test_claim_skips_already_claimed(brain_dir: Path) -> None:
    todos.add_todo(brain_dir, "Task A", to_agent="any")
    todos.add_todo(brain_dir, "Task B", to_agent="any")
    first = todos.claim_todo(brain_dir, "claude-code")
    second = todos.claim_todo(brain_dir, "claude-code")
    assert first is not None and second is not None
    assert first["id"] != second["id"]


def test_complete_marks_done_and_is_idempotent(brain_dir: Path) -> None:
    t = todos.add_todo(brain_dir, "Write docs", to_agent="any")
    assert todos.complete_todo(brain_dir, t["id"], result="shipped") is True
    # Second call is a no-op: already done.
    assert todos.complete_todo(brain_dir, t["id"]) is False
    done = todos.list_todos(brain_dir, status="done")
    assert len(done) == 1 and done[0]["result"] == "shipped"


def test_complete_missing_todo(brain_dir: Path) -> None:
    assert todos.complete_todo(brain_dir, "nope") is False


def test_list_filter_by_status(brain_dir: Path) -> None:
    t1 = todos.add_todo(brain_dir, "Open one", to_agent="any")
    todos.add_todo(brain_dir, "Also open", to_agent="any")
    todos.complete_todo(brain_dir, t1["id"])
    assert len(todos.list_todos(brain_dir, status="open")) == 1
    assert len(todos.list_todos(brain_dir, status="done")) == 1


def test_list_filter_by_agent(brain_dir: Path) -> None:
    t1 = todos.add_todo(brain_dir, "For cursor", to_agent="cursor")
    todos.add_todo(brain_dir, "For any", to_agent="any")
    claimed = todos.claim_todo(brain_dir, "claude-code")  # claims the "any" one
    assert claimed is not None
    # claude-code is now tied via claimed_by
    for_claude = todos.list_todos(brain_dir, agent_id="claude-code")
    assert len(for_claude) == 1 and for_claude[0]["id"] == claimed["id"]
    # cursor is still waiting
    for_cursor = todos.list_todos(brain_dir, agent_id="cursor")
    assert len(for_cursor) == 1 and for_cursor[0]["id"] == t1["id"]


def test_folded_view_merges_mutations(brain_dir: Path) -> None:
    """The jsonl is append-only; later rows with the same id overlay earlier ones."""
    t = todos.add_todo(brain_dir, "Task", to_agent="any")
    todos.claim_todo(brain_dir, "claude-code")
    todos.complete_todo(brain_dir, t["id"], result="ok")
    rows = todos.list_todos(brain_dir)
    assert len(rows) == 1
    final = rows[0]
    assert final["status"] == "done"
    assert final["claimed_by"] == "claude-code"
    assert final["result"] == "ok"
    assert final["task"] == "Task"  # original fields preserved through folds


def test_get_todo_by_id(brain_dir: Path) -> None:
    t = todos.add_todo(brain_dir, "Findable", to_agent="any")
    found = todos.get_todo(brain_dir, t["id"])
    assert found is not None and found["id"] == t["id"]
    assert todos.get_todo(brain_dir, "nonexistent") is None
