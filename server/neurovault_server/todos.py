"""Multi-agent todo handoff — append-only jsonl store at <brain_dir>/todos.jsonl.

Designed for lightweight coordination between agents sharing a NeuroVault
brain. Inspired by Octogent's pattern of keeping coordination state in
durable files rather than chat threads.

Invariants:
  - Each write is a single JSON line — partial writes never corrupt
    earlier entries (unix atomic-ish append).
  - Status transitions are idempotent: claiming an already-claimed todo
    is a no-op + return the existing record.
  - No background worker — reads scan the whole file. For <10k todos this
    is ~1ms; beyond that, add an index. We're not there yet.
  - File is created lazily on first write; reads of a missing file
    return an empty list.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


TODOS_FILENAME = "todos.jsonl"


def _todos_path(brain_dir: Path) -> Path:
    return brain_dir / TODOS_FILENAME


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read_all(brain_dir: Path) -> list[dict]:
    """Return every todo in insertion order, with later mutations overlaid.

    The file is an append-only log — when a todo is claimed or completed
    we append a partial record with the same `id`. The folded view
    collapses those back into a single effective record per id.
    """
    path = _todos_path(brain_dir)
    if not path.exists():
        return []
    by_id: dict[str, dict] = {}
    order: list[str] = []
    try:
        with path.open(encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                tid = row.get("id")
                if not tid:
                    continue
                if tid in by_id:
                    by_id[tid].update(row)
                else:
                    by_id[tid] = dict(row)
                    order.append(tid)
    except OSError:
        return []
    return [by_id[tid] for tid in order]


def _append(brain_dir: Path, row: dict) -> None:
    path = _todos_path(brain_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def add_todo(
    brain_dir: Path,
    task: str,
    *,
    context: str = "",
    to_agent: str = "any",
    from_agent: str | None = None,
) -> dict:
    """Create a new open todo. `to_agent='any'` means any agent can claim it."""
    row = {
        "id": str(uuid.uuid4()),
        "created_at": _now(),
        "task": task,
        "context": context,
        "from_agent": from_agent,
        "to_agent": to_agent or "any",
        "status": "open",
    }
    _append(brain_dir, row)
    return row


def claim_todo(brain_dir: Path, agent_id: str) -> dict | None:
    """Claim the oldest open todo that matches this agent (or to_agent='any').

    Returns the full todo record on success, None if nothing is open.
    Idempotent: re-claiming a todo already held by this agent returns it
    unchanged.
    """
    todos = _read_all(brain_dir)
    # Prefer todos addressed specifically to this agent; fall back to "any".
    best: dict | None = None
    for t in todos:
        if t.get("status") != "open":
            continue
        target = t.get("to_agent") or "any"
        if target == agent_id:
            best = t
            break
        if target == "any" and best is None:
            best = t
    if not best:
        return None
    claim = {
        "id": best["id"],
        "status": "claimed",
        "claimed_at": _now(),
        "claimed_by": agent_id,
    }
    _append(brain_dir, claim)
    merged = dict(best)
    merged.update(claim)
    return merged


def complete_todo(
    brain_dir: Path,
    todo_id: str,
    *,
    result: str = "",
) -> bool:
    """Mark a todo done. Returns True if the todo existed and wasn't already done."""
    todos = _read_all(brain_dir)
    existing = next((t for t in todos if t.get("id") == todo_id), None)
    if not existing or existing.get("status") == "done":
        return False
    _append(brain_dir, {
        "id": todo_id,
        "status": "done",
        "done_at": _now(),
        "result": result,
    })
    return True


def list_todos(
    brain_dir: Path,
    *,
    status: str | None = None,
    agent_id: str | None = None,
    limit: int = 100,
) -> list[dict]:
    """Return todos filtered by status and/or agent_id (claimed_by OR to_agent)."""
    todos = _read_all(brain_dir)
    out: list[dict] = []
    for t in todos:
        if status and t.get("status") != status:
            continue
        if agent_id:
            if t.get("claimed_by") != agent_id and t.get("to_agent") != agent_id:
                continue
        out.append(t)
        if len(out) >= limit:
            break
    return out


def get_todo(brain_dir: Path, todo_id: str) -> dict | None:
    for t in _read_all(brain_dir):
        if t.get("id") == todo_id:
            return t
    return None


__all__ = [
    "add_todo",
    "claim_todo",
    "complete_todo",
    "list_todos",
    "get_todo",
    "TODOS_FILENAME",
]


def _run_self_test() -> None:  # pragma: no cover
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        brain = Path(tmp) / "brain"
        brain.mkdir()
        t1 = add_todo(brain, "Ingest the April logs", context="see obs-*.md", to_agent="claude-code", from_agent="user")
        t2 = add_todo(brain, "Update the Pavel page", to_agent="any", from_agent="user")
        assert len(list_todos(brain)) == 2
        c = claim_todo(brain, "claude-code")
        assert c and c["id"] == t1["id"] and c["status"] == "claimed"
        c2 = claim_todo(brain, "claude-desktop")
        assert c2 and c2["id"] == t2["id"]
        assert complete_todo(brain, t1["id"], result="done in 3 files") is True
        assert complete_todo(brain, t1["id"]) is False  # idempotent
        done = list_todos(brain, status="done")
        assert len(done) == 1 and done[0]["result"] == "done in 3 files"
        print("todos self-test passed")


if __name__ == "__main__":  # pragma: no cover
    _run_self_test()
