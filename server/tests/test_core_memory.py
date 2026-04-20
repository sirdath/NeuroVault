"""Tests for agent-editable core memory blocks (Letta/MemGPT pattern).

Unit-scoped against the `tmp_db` fixture. No embedder needed — these
tests are purely about block CRUD + char_limit enforcement.
"""

from __future__ import annotations

from neurovault_server.database import Database
from neurovault_server import core_memory as cm


def test_ensure_defaults_seeds_three_blocks(tmp_db: Database):
    cm.ensure_defaults(tmp_db)
    labels = {b["label"] for b in cm.list_blocks(tmp_db)}
    assert {"persona", "project", "user"}.issubset(labels)


def test_ensure_defaults_is_idempotent(tmp_db: Database):
    cm.ensure_defaults(tmp_db)
    # Write a real value, then re-seed — must not clobber.
    cm.set_block(tmp_db, "persona", "I am a dev agent.")
    cm.ensure_defaults(tmp_db)
    assert cm.read_block(tmp_db, "persona")["value"] == "I am a dev agent."


def test_set_block_updates_value_and_timestamp(tmp_db: Database):
    block = cm.set_block(tmp_db, "persona", "New persona text.")
    assert block["value"] == "New persona text."
    assert block["updated_at"] is not None


def test_set_block_creates_new_label_on_demand(tmp_db: Database):
    block = cm.set_block(tmp_db, "custom_label", "hello")
    assert block["label"] == "custom_label"
    assert block["value"] == "hello"
    assert block["char_limit"] == 2000  # default when auto-created


def test_set_block_respects_char_limit(tmp_db: Database):
    cm.ensure_defaults(tmp_db)
    # user block has char_limit=1500
    huge = "x " * 1000  # 2000 chars
    block = cm.set_block(tmp_db, "user", huge)
    assert len(block["value"]) <= 1500 + 1  # +1 for ellipsis


def test_append_block_newline_separates(tmp_db: Database):
    cm.set_block(tmp_db, "project", "first line")
    cm.append_block(tmp_db, "project", "second line")
    value = cm.read_block(tmp_db, "project")["value"]
    assert value == "first line\nsecond line"


def test_append_block_drops_oldest_when_full(tmp_db: Database):
    """The append strategy is 'drop_head' — when the block would exceed
    char_limit, the oldest leading lines are dropped until it fits, so
    the newest append always lands."""
    # Use a small char_limit for easy testing
    tmp_db.conn.execute(
        """INSERT INTO core_memory_blocks (label, value, char_limit)
           VALUES ('tight', '', 30)"""
    )
    tmp_db.conn.commit()
    cm.append_block(tmp_db, "tight", "line AAA")   # 8 chars
    cm.append_block(tmp_db, "tight", "line BBB")   # +1+8 = 17 chars
    cm.append_block(tmp_db, "tight", "line CCC")   # +1+8 = 26 chars
    cm.append_block(tmp_db, "tight", "line DDD")   # would be 35; drops leading
    value = cm.read_block(tmp_db, "tight")["value"]
    assert "DDD" in value, "newest append must always land"
    assert "AAA" not in value, "oldest should have been dropped"
    assert len(value) <= 30


def test_replace_block_happy_path(tmp_db: Database):
    cm.set_block(tmp_db, "persona", "I prefer pnpm over npm.")
    updated = cm.replace_block(tmp_db, "persona", "pnpm", "bun")
    assert updated is not None
    assert updated["value"] == "I prefer bun over npm."


def test_replace_block_returns_none_when_old_not_found(tmp_db: Database):
    cm.set_block(tmp_db, "persona", "hello world")
    result = cm.replace_block(tmp_db, "persona", "nonexistent", "new")
    assert result is None


def test_replace_respects_char_limit(tmp_db: Database):
    # Set a tight block then replace old -> giant new → must truncate
    tmp_db.conn.execute(
        """INSERT INTO core_memory_blocks (label, value, char_limit)
           VALUES ('tiny', 'abc', 20)"""
    )
    tmp_db.conn.commit()
    updated = cm.replace_block(tmp_db, "tiny", "abc", "x" * 200)
    assert updated is not None
    assert len(updated["value"]) <= 21  # 20 + ellipsis


def test_delete_default_block_clears_but_keeps_row(tmp_db: Database):
    cm.ensure_defaults(tmp_db)
    cm.set_block(tmp_db, "persona", "I am here.")
    ok = cm.delete_block(tmp_db, "persona")
    assert ok is True
    block = cm.read_block(tmp_db, "persona")
    assert block is not None  # still exists (reserved label)
    assert block["value"] == ""


def test_delete_custom_block_removes_row(tmp_db: Database):
    cm.set_block(tmp_db, "custom", "value")
    ok = cm.delete_block(tmp_db, "custom")
    assert ok is True
    assert cm.read_block(tmp_db, "custom") is None


def test_delete_nonexistent_returns_false(tmp_db: Database):
    assert cm.delete_block(tmp_db, "ghost") is False


def test_read_block_returns_none_for_unknown(tmp_db: Database):
    assert cm.read_block(tmp_db, "missing") is None


def test_list_blocks_sorted_by_label(tmp_db: Database):
    cm.set_block(tmp_db, "z_last", "z")
    cm.set_block(tmp_db, "a_first", "a")
    cm.set_block(tmp_db, "m_middle", "m")
    labels = [b["label"] for b in cm.list_blocks(tmp_db)]
    # Check relative ordering
    assert labels.index("a_first") < labels.index("m_middle") < labels.index("z_last")


def test_block_length_reported(tmp_db: Database):
    cm.set_block(tmp_db, "persona", "exactly twelve")
    block = cm.read_block(tmp_db, "persona")
    assert block["length"] == len("exactly twelve")
