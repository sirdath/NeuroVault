"""Tests for variable_tracker: extraction, stale sweep, rename detection."""

import uuid

from engram_server.database import Database
from engram_server.variable_tracker import (
    extract_python_variables,
    extract_typescript_variables,
    track_variables,
    find_variable,
    list_variables,
    find_renames,
    variable_stats,
)


# --- Extractor tests ------------------------------------------------------

def test_python_extractor_pulls_functions_classes_constants():
    src = '''
import os

MAX_RETRIES = 5
DEFAULT_PATH = "/tmp"

def fetch_data(url: str) -> dict:
    """Fetch data from a URL."""
    return {}

class HttpClient:
    pass
'''
    results = list(extract_python_variables(src))
    names = {r["name"]: r for r in results}
    assert "MAX_RETRIES" in names
    assert names["MAX_RETRIES"]["kind"] == "constant"
    assert "fetch_data" in names
    assert names["fetch_data"]["kind"] == "function"
    assert "HttpClient" in names
    assert names["HttpClient"]["kind"] == "class"


def test_python_extractor_respects_type_hints():
    src = "count: int = 0\nname: str = 'alice'\n"
    results = {r["name"]: r for r in extract_python_variables(src)}
    assert results["count"]["type_hint"].strip() == "int"
    assert results["name"]["type_hint"].strip() == "str"


def test_typescript_extractor_pulls_const_let_function_class():
    src = """
const MAX = 10;
let counter: number = 0;
function compute(x: number): number { return x * 2; }
class Widget { render() {} }
interface User { id: string }
type Id = string;
"""
    results = {r["name"]: r for r in extract_typescript_variables(src)}
    assert "MAX" in results
    assert results["MAX"]["kind"] == "constant"
    assert "compute" in results
    assert results["compute"]["kind"] == "function"
    assert "Widget" in results
    assert "User" in results
    assert results["User"]["kind"] == "type"


# --- DB-backed tracking tests ---------------------------------------------

def _insert_stub_engram(db: Database) -> str:
    eid = str(uuid.uuid4())
    db.insert_engram(eid, f"{eid}.md", "stub", "stub", "hash")
    return eid


def test_track_variables_upsert_and_last_seen(tmp_db: Database):
    eid = _insert_stub_engram(tmp_db)
    src = "FOO = 1\ndef bar(): pass\n"
    result = track_variables(tmp_db, eid, "test.py", src, "python")

    assert result["tracked"] == 2
    assert result["added"] == 2
    assert result["removed"] == 0

    # Re-run with the same content — nothing should be added or removed
    result2 = track_variables(tmp_db, eid, "test.py", src, "python")
    assert result2["removed"] == 0
    assert result2["renamed"] == 0


def test_stale_sweep_marks_removed(tmp_db: Database):
    eid = _insert_stub_engram(tmp_db)
    src_v1 = "def foo(): pass\ndef bar(): pass\n"
    track_variables(tmp_db, eid, "test.py", src_v1, "python")

    # Drop `bar` from the file
    src_v2 = "def foo(): pass\n"
    result = track_variables(tmp_db, eid, "test.py", src_v2, "python")

    assert result["removed"] == 1

    bar = find_variable(tmp_db, "bar")
    assert bar is not None
    assert bar["status"] == "removed"
    assert bar["removed_at"] is not None

    foo = find_variable(tmp_db, "foo")
    assert foo["status"] == "live"


def test_rename_detection_same_kind_and_type(tmp_db: Database):
    eid = _insert_stub_engram(tmp_db)
    src_v1 = "def validate_user(token): pass\n"
    track_variables(tmp_db, eid, "auth.py", src_v1, "python")

    # Rename validate_user -> auth_check, same kind (function), same type_hint (None)
    src_v2 = "def auth_check(token): pass\n"
    result = track_variables(tmp_db, eid, "auth.py", src_v2, "python")

    assert result["removed"] == 1
    assert result["renamed"] >= 1

    renames = find_renames(tmp_db)
    pair = next(
        (r for r in renames if r["old_name"] == "validate_user" and r["new_name"] == "auth_check"),
        None,
    )
    assert pair is not None
    assert pair["kind"] == "function"


def test_revival_clears_removed_at(tmp_db: Database):
    eid = _insert_stub_engram(tmp_db)
    track_variables(tmp_db, eid, "a.py", "def helper(): pass\n", "python")
    # Remove it
    track_variables(tmp_db, eid, "a.py", "", "python")
    helper = find_variable(tmp_db, "helper")
    assert helper["status"] == "removed"

    # Re-add helper from another engram — should come back to life
    eid2 = _insert_stub_engram(tmp_db)
    track_variables(tmp_db, eid2, "b.py", "def helper(): pass\n", "python")

    revived = find_variable(tmp_db, "helper")
    assert revived["status"] == "live"
    assert revived["removed_at"] is None


def test_list_variables_status_filter(tmp_db: Database):
    eid = _insert_stub_engram(tmp_db)
    track_variables(tmp_db, eid, "a.py", "def alive(): pass\ndef dying(): pass\n", "python")
    track_variables(tmp_db, eid, "a.py", "def alive(): pass\n", "python")

    live = list_variables(tmp_db, status="live")
    live_names = {v["name"] for v in live}
    assert "alive" in live_names
    assert "dying" not in live_names

    removed = list_variables(tmp_db, status="removed")
    removed_names = {v["name"] for v in removed}
    assert "dying" in removed_names

    all_vars = list_variables(tmp_db, status="all")
    all_names = {v["name"] for v in all_vars}
    assert "alive" in all_names and "dying" in all_names


def test_variable_stats_counts(tmp_db: Database):
    eid = _insert_stub_engram(tmp_db)
    track_variables(tmp_db, eid, "a.py", "def a(): pass\ndef b(): pass\n", "python")
    track_variables(tmp_db, eid, "a.py", "def a(): pass\n", "python")

    stats = variable_stats(tmp_db)
    assert stats["total"] >= 2
    assert stats["live"] >= 1
    assert stats["removed"] >= 1
    assert "python" in stats["by_language"]
