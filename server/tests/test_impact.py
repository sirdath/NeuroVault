"""Tests for impact: BFS blast radius, diff parsing, risk scoring."""

import uuid

from neurovault_server.database import Database
from neurovault_server.variable_tracker import track_variables
from neurovault_server.call_graph import track_calls
from neurovault_server.impact import (
    parse_diff_filepaths,
    get_impact_radius,
    detect_changes,
    _compute_risk,
    _has_related_decision,
)


def _stub(db: Database) -> str:
    eid = str(uuid.uuid4())
    db.insert_engram(eid, f"{eid}.md", "stub", "stub", "hash")
    return eid


# --- Diff parser ---------------------------------------------------------

def test_parse_diff_extracts_git_bplus_paths():
    diff = """diff --git a/src/auth.py b/src/auth.py
index abc..def 100644
--- a/src/auth.py
+++ b/src/auth.py
@@ -1,3 +1,4 @@
 def foo(): pass
+def bar(): pass
diff --git a/src/db.py b/src/db.py
--- a/src/db.py
+++ b/src/db.py
@@ -10,0 +11 @@
+x = 1
"""
    paths = parse_diff_filepaths(diff)
    assert paths == ["src/auth.py", "src/db.py"]


def test_parse_diff_skips_dev_null():
    diff = """--- /dev/null
+++ b/src/new_file.py
@@ -0,0 +1 @@
+pass
"""
    paths = parse_diff_filepaths(diff)
    assert paths == ["src/new_file.py"]


def test_parse_diff_handles_empty_input():
    assert parse_diff_filepaths("") == []
    assert parse_diff_filepaths("no diff markers here") == []


def test_parse_diff_dedupes():
    diff = "+++ b/same.py\n+++ b/same.py\n+++ b/other.py\n"
    paths = parse_diff_filepaths(diff)
    assert paths == ["same.py", "other.py"]


# --- Impact radius BFS ---------------------------------------------------

def test_impact_radius_empty_filepaths():
    # Passing empty list should return a trivial response, not crash
    result = get_impact_radius(None, [])
    assert result["stats"]["total_affected"] == 0
    assert result["directly_affected"] == []


def test_impact_radius_direct_symbols_only(tmp_db: Database):
    eid = _stub(tmp_db)
    track_variables(tmp_db, eid, "lib.py", "def lonely(): pass\n", "python")

    result = get_impact_radius(tmp_db, ["lib.py"])
    assert len(result["directly_affected"]) == 1
    assert result["directly_affected"][0]["name"] == "lonely"
    assert result["directly_affected"][0]["depth"] == 0
    assert result["transitively_affected"] == []


def test_impact_radius_bfs_one_hop(tmp_db: Database):
    # Separate engrams per file — mirrors real ingestion so the stale
    # sweep doesn't mark symbols from a different file as removed.
    eid_lib = _stub(tmp_db)
    eid_caller = _stub(tmp_db)
    track_variables(tmp_db, eid_lib, "lib.py", "def target(): pass\n", "python")
    src_caller = "def client():\n    target()\n"
    track_variables(tmp_db, eid_caller, "caller.py", src_caller, "python")
    track_calls(tmp_db, eid_caller, "caller.py", src_caller, "python")

    result = get_impact_radius(tmp_db, ["lib.py"])

    # `target` is direct, `client` is transitive at depth 1
    direct_names = {v["name"] for v in result["directly_affected"]}
    trans_names = {v["name"] for v in result["transitively_affected"]}
    assert "target" in direct_names
    assert "client" in trans_names

    client = next(v for v in result["transitively_affected"] if v["name"] == "client")
    assert client["depth"] == 1
    assert client["path_via"] == ["target"]


def test_impact_radius_bfs_two_hops(tmp_db: Database):
    eid_lib = _stub(tmp_db)
    eid_mid = _stub(tmp_db)
    eid_top = _stub(tmp_db)
    track_variables(tmp_db, eid_lib, "lib.py", "def base(): pass\n", "python")
    src_mid = "def mid():\n    base()\n"
    track_variables(tmp_db, eid_mid, "mid.py", src_mid, "python")
    track_calls(tmp_db, eid_mid, "mid.py", src_mid, "python")
    src_top = "def top():\n    mid()\n"
    track_variables(tmp_db, eid_top, "top.py", src_top, "python")
    track_calls(tmp_db, eid_top, "top.py", src_top, "python")

    result = get_impact_radius(tmp_db, ["lib.py"], max_depth=3)

    all_names = (
        {v["name"] for v in result["directly_affected"]}
        | {v["name"] for v in result["transitively_affected"]}
    )
    assert {"base", "mid", "top"} <= all_names

    top_node = next(v for v in result["transitively_affected"] if v["name"] == "top")
    mid_node = next(v for v in result["transitively_affected"] if v["name"] == "mid")
    assert mid_node["depth"] == 1
    assert top_node["depth"] == 2


def test_impact_radius_respects_max_depth(tmp_db: Database):
    eid_a = _stub(tmp_db)
    eid_b = _stub(tmp_db)
    track_variables(tmp_db, eid_a, "a.py", "def a(): pass\n", "python")
    src = "def b():\n    a()\ndef c():\n    b()\n"
    track_variables(tmp_db, eid_b, "b.py", src, "python")
    track_calls(tmp_db, eid_b, "b.py", src, "python")

    result = get_impact_radius(tmp_db, ["a.py"], max_depth=1)

    # At depth=1 we should reach b but not c
    names = {v["name"] for v in result["transitively_affected"]}
    assert "b" in names
    assert "c" not in names


def test_impact_radius_ranks_by_risk(tmp_db: Database):
    eid = _stub(tmp_db)
    # `popular` has 3 callers, `lonely` has 0
    src = (
        "def a():\n    popular()\n"
        "def b():\n    popular()\n"
        "def c():\n    popular()\n"
        "def popular(): pass\n"
        "def lonely(): pass\n"
    )
    track_variables(tmp_db, eid, "lib.py", src, "python")
    track_calls(tmp_db, eid, "lib.py", src, "python")

    result = get_impact_radius(tmp_db, ["lib.py"])
    direct = result["directly_affected"]
    names = [v["name"] for v in direct]

    # `popular` should be first (3 callers > 0 callers)
    pop_idx = names.index("popular")
    lone_idx = names.index("lonely")
    assert pop_idx < lone_idx
    popular = direct[pop_idx]
    lonely = direct[lone_idx]
    assert popular["risk_score"] > lonely["risk_score"]
    assert popular["caller_count"] == 3


# --- Risk scoring --------------------------------------------------------

def test_compute_risk_returns_bounded_score(tmp_db: Database):
    risk, reasons = _compute_risk(tmp_db, "no_such_fn", caller_count=0, depth=0)
    assert 0.0 <= risk <= 10.0
    assert isinstance(reasons, list)


def test_compute_risk_increases_with_callers(tmp_db: Database):
    low, _ = _compute_risk(tmp_db, "fn", caller_count=0, depth=0)
    high, _ = _compute_risk(tmp_db, "fn", caller_count=50, depth=0)
    assert high > low


def test_compute_risk_drops_with_depth(tmp_db: Database):
    direct, _ = _compute_risk(tmp_db, "fn", caller_count=5, depth=0)
    far, _ = _compute_risk(tmp_db, "fn", caller_count=5, depth=3)
    assert direct > far


def test_related_decision_bumps_risk(tmp_db: Database):
    # A regular function
    without, _ = _compute_risk(tmp_db, "validate_token", caller_count=2, depth=0)

    # Add a Decision engram mentioning it
    eid = str(uuid.uuid4())
    tmp_db.insert_engram(
        eid,
        "decision-jwt.md",
        "Decision: use validate_token with RS256",
        "Explicit design decision about validate_token",
        "h",
    )
    assert _has_related_decision(tmp_db, "validate_token")

    with_dec, reasons = _compute_risk(tmp_db, "validate_token", caller_count=2, depth=0)
    assert with_dec > without
    assert any("decision" in r.lower() for r in reasons)


# --- detect_changes end-to-end -------------------------------------------

def test_detect_changes_with_empty_diff(tmp_db: Database):
    result = detect_changes(tmp_db, diff_text="")
    assert result["risk_score"] == 0.0
    assert result["risk_level"] == "none"
    assert result["changed_files"] == []


def test_detect_changes_aggregates_risk(tmp_db: Database):
    eid = _stub(tmp_db)
    # Heavy file: one function called by many
    src = (
        "def a():\n    hot()\n"
        "def b():\n    hot()\n"
        "def c():\n    hot()\n"
        "def d():\n    hot()\n"
        "def hot(): pass\n"
    )
    track_variables(tmp_db, eid, "hot.py", src, "python")
    track_calls(tmp_db, eid, "hot.py", src, "python")

    diff = "+++ b/hot.py\n@@ -1,5 +1,5 @@\n def hot(): pass\n"
    result = detect_changes(tmp_db, diff_text=diff)

    assert result["changed_files"] == ["hot.py"]
    assert result["risk_score"] > 0
    assert result["risk_level"] in {"low", "medium", "high", "critical"}
    # `hot` should be the highest-risk item
    assert any(s["name"] == "hot" for s in result["high_risk_symbols"] + result["directly_affected"])


def test_detect_changes_filepaths_override(tmp_db: Database):
    eid = _stub(tmp_db)
    track_variables(tmp_db, eid, "explicit.py", "def go(): pass\n", "python")

    result = detect_changes(tmp_db, diff_text="", filepaths=["explicit.py"])
    assert result["changed_files"] == ["explicit.py"]
    assert any(v["name"] == "go" for v in result["directly_affected"])
