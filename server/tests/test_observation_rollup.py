"""Tests for observation_rollup — compressing stale hook sessions into summaries."""

import uuid
from pathlib import Path
from types import SimpleNamespace

from neurovault_server.database import Database
from neurovault_server.bm25_index import BM25Index
from neurovault_server.observation_rollup import (
    rollup_session,
    rollup_stale_sessions,
    get_rollup_stats,
    _session_short_from_filename,
    _parse_observation,
)


def _make_ctx(tmp_db: Database, tmp_path: Path) -> SimpleNamespace:
    """Build a minimal BrainContext-like object for rollup tests."""
    vault = tmp_path / "vault"
    vault.mkdir()
    return SimpleNamespace(
        db=tmp_db,
        vault_dir=vault,
        bm25=BM25Index(),
        brain_id="test",
        name="Test Brain",
    )


def _make_obs_engram(db: Database, vault: Path, session: str, event: str, content: str, tool: str | None = None) -> str:
    """Insert one fake observation engram, mirroring the hook capture format."""
    eid = str(uuid.uuid4())
    short_id = uuid.uuid4().hex[:6]
    filename = f"obs-{session}-{event.lower()}-{short_id}.md"
    title = f"{tool or event} - {session}"
    body = f"# {title}\n\n**Event:** {event}\n**Session:** `{session}`\n"
    if tool:
        body += f"**Tool:** `{tool}`\n"
    body += f"\n{content}\n"
    (vault / filename).write_text(body, encoding="utf-8")
    db.insert_engram(eid, filename, title, body, f"hash-{short_id}")
    db.conn.execute("UPDATE engrams SET kind='observation' WHERE id = ?", (eid,))
    db.conn.commit()
    return eid


# --- Filename / parsing helpers ---

def test_session_short_from_filename():
    assert _session_short_from_filename("obs-abc12345-posttooluse-deadbe.md") == "abc12345"
    assert _session_short_from_filename("obs-xy-sessionstart-00.md") == "xy"
    assert _session_short_from_filename("not-an-observation.md") is None
    assert _session_short_from_filename("obs-.md") is None


def test_parse_observation_extracts_event_and_tool():
    content = "# Edit · abc12345\n\n**Event:** PostToolUse\n**Tool:** `Edit`\n\ndone"
    parsed = _parse_observation("Edit · abc12345", content)
    assert parsed["event"] == "PostToolUse"
    assert parsed["tool"] == "Edit"


def test_parse_observation_extracts_prompt():
    content = "# User prompt\n\n**Event:** UserPromptSubmit\n\n## Prompt\n\nHow do I debug this?"
    parsed = _parse_observation("User prompt", content)
    assert parsed["event"] == "UserPromptSubmit"
    assert "debug this" in (parsed["prompt"] or "")


# --- Single-session rollup ---

def test_rollup_session_with_no_observations(tmp_db: Database, tmp_path: Path):
    ctx = _make_ctx(tmp_db, tmp_path)
    result = rollup_session(ctx, "nosuchsession")
    assert result["status"] == "no_observations"


def test_rollup_single_session_creates_summary_and_archives_raws(tmp_db: Database, tmp_path: Path):
    ctx = _make_ctx(tmp_db, tmp_path)
    session = "sess1234"

    raw_ids = []
    for i in range(5):
        eid = _make_obs_engram(
            tmp_db, ctx.vault_dir, session,
            event="PostToolUse" if i % 2 == 0 else "UserPromptSubmit",
            content=f"observation body {i}",
            tool="Edit" if i % 2 == 0 else None,
        )
        raw_ids.append(eid)

    result = rollup_session(ctx, session)
    assert result["status"] == "rolled_up"
    assert result["event_count"] == 5
    assert result["events_archived"] == 5

    # Raw engrams should all be dormant now
    for eid in raw_ids:
        row = tmp_db.conn.execute("SELECT state FROM engrams WHERE id = ?", (eid,)).fetchone()
        assert row[0] == "dormant", f"{eid} should be dormant"

    # Summary engram exists with kind='session_summary'
    sid = result["summary_engram_id"]
    row = tmp_db.conn.execute(
        "SELECT kind, title, content FROM engrams WHERE id = ?", (sid,)
    ).fetchone()
    assert row is not None
    assert row[0] == "session_summary"
    assert session in row[1]
    assert "Event types" in row[2]
    assert "PostToolUse" in row[2]

    # Archive dir should contain the raw files
    archive = ctx.vault_dir.parent / "archive"
    assert archive.exists()
    archived = list(archive.glob("obs-*.md"))
    assert len(archived) == 5

    # Raw files should NOT be in the vault anymore
    vault_obs = list(ctx.vault_dir.glob("obs-*.md"))
    assert len(vault_obs) == 0


# --- Stale-sessions bulk rollup ---

def test_rollup_stale_skips_fresh_sessions(tmp_db: Database, tmp_path: Path):
    ctx = _make_ctx(tmp_db, tmp_path)
    session = "freshsss"
    for i in range(5):
        _make_obs_engram(tmp_db, ctx.vault_dir, session, "PostToolUse", f"body {i}", tool="Edit")

    # Default older_than_hours=24 — our fresh obs are seconds old, should skip
    result = rollup_stale_sessions(ctx, older_than_hours=24, min_events=3)
    assert result["sessions_rolled_up"] == 0


def test_rollup_stale_respects_min_events(tmp_db: Database, tmp_path: Path):
    ctx = _make_ctx(tmp_db, tmp_path)
    # Only 2 events — below default min of 3
    for i in range(2):
        _make_obs_engram(tmp_db, ctx.vault_dir, "tinysesh", "PostToolUse", f"body {i}", tool="Edit")

    # Backdate so age isn't the blocker
    tmp_db.conn.execute(
        "UPDATE engrams SET created_at = datetime('now', '-2 days') WHERE filename LIKE 'obs-tinysesh-%'"
    )
    tmp_db.conn.commit()

    result = rollup_stale_sessions(ctx, older_than_hours=1, min_events=3)
    assert result["sessions_rolled_up"] == 0


def test_rollup_stale_processes_old_sessions(tmp_db: Database, tmp_path: Path):
    ctx = _make_ctx(tmp_db, tmp_path)
    session = "oldsesh1"
    for i in range(5):
        _make_obs_engram(tmp_db, ctx.vault_dir, session, "PostToolUse", f"body {i}", tool="Edit")

    # Backdate the whole session
    tmp_db.conn.execute(
        "UPDATE engrams SET created_at = datetime('now', '-2 days') WHERE filename LIKE 'obs-oldsesh1-%'"
    )
    tmp_db.conn.commit()

    result = rollup_stale_sessions(ctx, older_than_hours=24, min_events=3)
    assert result["sessions_rolled_up"] == 1
    assert result["stats"][0]["events"] == 5


def test_rollup_stale_caps_at_max_sessions(tmp_db: Database, tmp_path: Path):
    ctx = _make_ctx(tmp_db, tmp_path)
    # Create 4 stale sessions
    for s in ["sx01abcd", "sx02abcd", "sx03abcd", "sx04abcd"]:
        for i in range(3):
            _make_obs_engram(tmp_db, ctx.vault_dir, s, "PostToolUse", f"body {i}", tool="Edit")
    tmp_db.conn.execute(
        "UPDATE engrams SET created_at = datetime('now', '-2 days') WHERE filename LIKE 'obs-sx%'"
    )
    tmp_db.conn.commit()

    # Cap at 2
    result = rollup_stale_sessions(ctx, older_than_hours=24, min_events=3, max_sessions=2)
    assert result["sessions_rolled_up"] == 2


# --- Observability ---

def test_get_rollup_stats_reports_live_vs_summaries(tmp_db: Database, tmp_path: Path):
    ctx = _make_ctx(tmp_db, tmp_path)
    # 3 live obs
    for i in range(3):
        _make_obs_engram(tmp_db, ctx.vault_dir, "statsid1", "PostToolUse", f"b{i}", tool="Edit")

    stats = get_rollup_stats(ctx)
    assert stats["live_observations"] == 3
    assert stats["live_sessions"] >= 1
    assert stats["session_summaries"] == 0

    # Backdate + rollup
    tmp_db.conn.execute(
        "UPDATE engrams SET created_at = datetime('now', '-2 days') WHERE filename LIKE 'obs-statsid1-%'"
    )
    tmp_db.conn.commit()
    rollup_stale_sessions(ctx, older_than_hours=1, min_events=1)

    stats2 = get_rollup_stats(ctx)
    assert stats2["live_observations"] == 0
    assert stats2["session_summaries"] == 1
    assert stats2["archived_files"] == 3
