"""Tests for call_graph: edge extraction, find_callers/callees, dead code, stale callsites."""

import uuid

from engram_server.database import Database
from engram_server.call_graph import (
    extract_python_calls,
    extract_brace_calls,
    track_calls,
    find_callers,
    find_callees,
    find_dead_code,
    find_renamed_callsites,
    hot_functions,
)
from engram_server.variable_tracker import track_variables


def _stub(db: Database) -> str:
    eid = str(uuid.uuid4())
    db.insert_engram(eid, f"{eid}.md", "stub", "stub", "hash")
    return eid


# --- Extractor tests ------------------------------------------------------

def test_python_call_extractor_attributes_caller():
    src = """
def foo():
    bar()
    baz(1, 2)

def qux():
    foo()
"""
    edges = list(extract_python_calls(src))
    by_callee = {e["callee"]: e for e in edges}
    assert "bar" in by_callee
    assert by_callee["bar"]["caller"] == "foo"
    assert by_callee["baz"]["caller"] == "foo"
    assert by_callee["foo"]["caller"] == "qux"


def test_python_call_extractor_skips_builtins():
    src = """
def demo():
    print("hi")
    x = len([1, 2])
    real_call()
"""
    edges = list(extract_python_calls(src))
    callees = {e["callee"] for e in edges}
    assert "print" not in callees
    assert "len" not in callees
    assert "real_call" in callees


def test_brace_extractor_handles_js():
    src = """
function outer() {
  inner();
  helper();
}
function inner() {
  helper();
}
"""
    edges = list(extract_brace_calls(src))
    by_caller: dict = {}
    for e in edges:
        by_caller.setdefault(e["caller"], set()).add(e["callee"])
    assert "helper" in by_caller.get("outer", set())
    assert "inner" in by_caller.get("outer", set())
    assert "helper" in by_caller.get("inner", set())


# --- DB-backed tracking ---------------------------------------------------

def test_track_calls_stores_edges(tmp_db: Database):
    eid = _stub(tmp_db)
    src = "def a():\n    b()\n    c()\ndef b():\n    c()\n"
    count = track_calls(tmp_db, eid, "test.py", src, "python")
    assert count >= 2

    callers = find_callers(tmp_db, "c")
    caller_names = {c["caller"] for c in callers}
    assert "a" in caller_names
    assert "b" in caller_names


def test_find_callees_returns_outgoing_edges(tmp_db: Database):
    eid = _stub(tmp_db)
    src = "def hub():\n    leaf1()\n    leaf2()\n    leaf3()\n"
    track_calls(tmp_db, eid, "t.py", src, "python")

    callees = find_callees(tmp_db, "hub")
    names = {c["callee"] for c in callees}
    assert {"leaf1", "leaf2", "leaf3"} <= names


def test_hot_functions_ranks_by_count(tmp_db: Database):
    eid = _stub(tmp_db)
    src = """
def a():
    popular()
def b():
    popular()
def c():
    popular()
    lonely()
"""
    track_calls(tmp_db, eid, "t.py", src, "python")

    hot = hot_functions(tmp_db, limit=10)
    names = [h["name"] for h in hot]
    assert "popular" in names
    popular_idx = names.index("popular")
    if "lonely" in names:
        lonely_idx = names.index("lonely")
        assert popular_idx < lonely_idx


def test_find_dead_code_requires_stale_and_zero_callers(tmp_db: Database):
    eid = _stub(tmp_db)
    # Track a function nobody calls
    track_variables(tmp_db, eid, "a.py", "def orphan(): pass\n", "python")

    # Backdate last_seen so it clears the stale_days threshold
    tmp_db.conn.execute(
        "UPDATE variables SET last_seen = datetime('now', '-120 days') WHERE name = 'orphan'"
    )
    tmp_db.conn.commit()

    dead = find_dead_code(tmp_db, stale_days=60, max_callers=0, limit=10)
    names = {d["name"] for d in dead}
    assert "orphan" in names
    orphan = next(d for d in dead if d["name"] == "orphan")
    assert orphan["caller_count"] == 0
    assert 0 < orphan["confidence"] <= 1.0


def test_find_dead_code_excludes_called_functions(tmp_db: Database):
    eid = _stub(tmp_db)
    # Define `used` and call it from `caller`
    src = "def used(): pass\ndef caller():\n    used()\n"
    track_variables(tmp_db, eid, "a.py", src, "python")
    track_calls(tmp_db, eid, "a.py", src, "python")
    tmp_db.conn.execute(
        "UPDATE variables SET last_seen = datetime('now', '-120 days')"
    )
    tmp_db.conn.commit()

    dead = find_dead_code(tmp_db, stale_days=60, max_callers=0, limit=10)
    names = {d["name"] for d in dead}
    assert "used" not in names  # has 1 caller, not dead


def test_find_renamed_callsites_surfaces_stragglers(tmp_db: Database):
    # Two engrams: lib defines the symbol, caller uses it.
    lib_eid = _stub(tmp_db)
    caller_eid = _stub(tmp_db)

    # v1: lib defines old_name, caller calls it
    track_variables(tmp_db, lib_eid, "lib.py", "def old_name(): pass\n", "python")
    caller_src = "def client():\n    old_name()\n"
    track_variables(tmp_db, caller_eid, "caller.py", caller_src, "python")
    track_calls(tmp_db, caller_eid, "caller.py", caller_src, "python")

    # v2: rename in lib.py (same engram so rename detection fires)
    result = track_variables(tmp_db, lib_eid, "lib.py", "def new_name(): pass\n", "python")
    assert result["renamed"] >= 1

    # Caller is stale — still calls old_name. Stage "rename detective"
    # should catch it by cross-referencing variable_renames with live
    # function_calls rows.
    stale = find_renamed_callsites(tmp_db, limit=10)
    matches = [r for r in stale if r["old_name"] == "old_name" and r["new_name"] == "new_name"]
    assert matches, "expected stale callsite for old_name -> new_name"
    assert matches[0]["stale_callsite_count"] >= 1
