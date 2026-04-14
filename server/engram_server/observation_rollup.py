"""Observation rollup — compress stale hook-captured sessions into one summary.

Problem: the hooks pipeline creates one markdown file per captured event
(PostToolUse, UserPromptSubmit, SessionEnd, etc). A single 4-hour coding
session can easily generate 200+ `obs-*.md` files. Over a week of daily
use that's thousands of files, all living in the vault directory and
getting stat'd on every server boot by `ingest_vault`. Boot time grows
linearly. The Intelligence tab's session list grows unusable.

Solution: once a session has been idle for N hours, compress all of its
observation engrams into a single `session_summary` engram that captures:

  - Event-type counts (PostToolUse: 45, UserPromptSubmit: 12, ...)
  - Tool-usage breakdown (Edit: 23, Bash: 15, Write: 7, ...)
  - A chronological timeline of distinctive actions
  - Any captured user prompts (first 200 chars of each)

Then soft-delete the raw obs engrams and **move their markdown files out
of `vault/` into `~/.engram/brains/{brain}/archive/`**, where the vault
watcher and ingest pipeline can't see them. The raw files are preserved
(not deleted) so you can still grep through them with regular tools.

Runs automatically during the 4h consolidation cycle, and can be
triggered manually via the `rollup_session` MCP tool or the
`POST /api/observations/rollup` HTTP endpoint.
"""

from __future__ import annotations

import re
import uuid
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

from loguru import logger

from engram_server.brain import BrainContext


DEFAULT_OLDER_THAN_HOURS = 24      # only rollup sessions idle >24h
DEFAULT_MIN_EVENTS = 3             # below this, don't bother rolling up
DEFAULT_MAX_SESSIONS_PER_RUN = 10  # keep consolidation cycle snappy
MAX_TIMELINE_ENTRIES = 20          # cap the chronological timeline in the summary


_EVENT_RE = re.compile(r"\*\*Event:\*\*\s*(\w+)")
_TOOL_RE = re.compile(r"\*\*Tool:\*\*\s*`?([^`\n]+)`?")
_PROMPT_HEAD_RE = re.compile(r"## Prompt\s*\n\s*(.+)", re.DOTALL)


def _parse_observation(title: str, content: str) -> dict:
    """Pull structured fields out of a hook-captured observation engram."""
    event = "Unknown"
    tool = None
    prompt = None

    m = _EVENT_RE.search(content or "")
    if m:
        event = m.group(1)

    m = _TOOL_RE.search(content or "")
    if m:
        tool = m.group(1).strip().strip("`")

    m = _PROMPT_HEAD_RE.search(content or "")
    if m:
        prompt = m.group(1).strip().split("\n", 1)[0][:200]

    return {"event": event, "tool": tool, "prompt": prompt, "title": title}


def _session_short_from_filename(filename: str) -> str | None:
    """Extract the short session id from an `obs-{short}-{event}-{id}.md` name."""
    parts = filename.split("-", 3)
    if len(parts) < 3 or not filename.startswith("obs-"):
        return None
    return parts[1]


def _format_summary_content(
    session_short: str,
    rows: list[tuple],
    parsed: list[dict],
) -> tuple[str, str]:
    """Build the (title, markdown) for a compressed session summary engram."""
    if not rows:
        return ("Empty session", "")

    first_ts = rows[0][4] or "unknown"
    last_ts = rows[-1][4] or first_ts
    event_count = len(rows)

    event_counts = Counter(p["event"] for p in parsed)
    tool_counts = Counter(p["tool"] for p in parsed if p["tool"])

    # Date from the first timestamp
    date_hint = (first_ts or "")[:10] or "unknown-date"
    title = f"Session summary: {session_short} ({date_hint})"

    lines: list[str] = []
    lines.append(f"# {title}")
    lines.append("")
    lines.append(f"**Session:** `{session_short}`")
    lines.append(f"**First event:** {first_ts}")
    lines.append(f"**Last event:**  {last_ts}")
    lines.append(f"**Total events:** {event_count}")
    lines.append("")

    lines.append("## Event types")
    for ev, n in event_counts.most_common():
        lines.append(f"- {ev}: {n}")
    lines.append("")

    if tool_counts:
        lines.append("## Tools used")
        for t, n in tool_counts.most_common(15):
            lines.append(f"- `{t}`: {n}")
        lines.append("")

    # Chronological timeline — one bullet per distinctive event, capped
    prompts = [p for p in parsed if p["event"] == "UserPromptSubmit" and p["prompt"]]
    if prompts:
        lines.append("## User prompts")
        for p in prompts[:MAX_TIMELINE_ENTRIES]:
            lines.append(f"- {p['prompt']}")
        lines.append("")

    # Last resort: a short trailing timeline with tool-call titles
    lines.append("## Timeline")
    seen_titles: set[str] = set()
    count = 0
    for _eid, _fn, t, _c, _ts in rows:
        if t in seen_titles:
            continue
        seen_titles.add(t)
        lines.append(f"- {t}")
        count += 1
        if count >= MAX_TIMELINE_ENTRIES:
            break

    return title, "\n".join(lines)


def _archive_dir(ctx: BrainContext) -> Path:
    """Return the per-brain archive directory outside the vault tree."""
    archive = ctx.vault_dir.parent / "archive"
    archive.mkdir(parents=True, exist_ok=True)
    return archive


def rollup_session(
    ctx: BrainContext,
    session_short: str,
    rows: list[tuple] | None = None,
) -> dict:
    """Compress a single session's observation engrams into one summary.

    Writes a new `summary-{date}-{short}.md` engram to the vault, marks
    all the raw obs engrams as dormant, and moves the raw files into
    the per-brain archive directory. The archive is outside vault_dir so
    the watcher and ingest don't re-scan it.
    """
    db = ctx.db

    if rows is None:
        rows = db.conn.execute(
            """SELECT id, filename, title, content, created_at
               FROM engrams
               WHERE filename LIKE ?
                 AND state != 'dormant'
                 AND COALESCE(kind, 'note') = 'observation'
               ORDER BY created_at""",
            (f"obs-{session_short}-%",),
        ).fetchall()

    if not rows:
        return {"session": session_short, "status": "no_observations"}

    parsed = [_parse_observation(r[2] or "", r[3] or "") for r in rows]
    title, body = _format_summary_content(session_short, rows, parsed)

    # Write the summary engram to the vault
    date_hint = (rows[0][4] or "unknown")[:10].replace(" ", "")
    short_id = uuid.uuid4().hex[:6]
    summary_filename = f"summary-{date_hint}-{session_short}-{short_id}.md"
    summary_path = ctx.vault_dir / summary_filename

    try:
        summary_path.write_text(body, encoding="utf-8")
    except Exception as e:
        logger.warning("rollup: failed to write summary {}: {}", summary_filename, e)
        return {"session": session_short, "status": "error", "error": str(e)}

    # Index the summary via the normal ingest path so it picks up entities,
    # semantic links, chunks, etc. Delayed import to avoid cyclic deps.
    try:
        from engram_server.ingest import ingest_file
        from engram_server.embeddings import Embedder
        stored_id = ingest_file(summary_path, db, Embedder.get(), ctx.bm25)
    except Exception as e:
        logger.warning("rollup: ingest of summary {} failed: {}", summary_filename, e)
        stored_id = None

    # Tag the new engram as a session_summary (distinct kind → excluded
    # from the default observation filter but findable via recall).
    if stored_id:
        try:
            db.conn.execute(
                "UPDATE engrams SET kind = 'session_summary' WHERE id = ?",
                (stored_id,),
            )
            db.conn.commit()
        except Exception as e:
            logger.debug("rollup: kind tag failed: {}", e)

    # Soft-delete the raw obs engrams and move their files to archive
    archived = 0
    archive = _archive_dir(ctx)
    for engram_id, filename, _title, _content, _ts in rows:
        try:
            db.soft_delete(engram_id)
        except Exception as e:
            logger.debug("rollup: soft_delete failed for {}: {}", engram_id, e)
            continue

        src = ctx.vault_dir / filename
        if src.exists():
            try:
                dest = archive / filename
                # Avoid accidental overwrite in case of collision
                if dest.exists():
                    dest = archive / f"{filename}.{uuid.uuid4().hex[:6]}"
                src.replace(dest)
                archived += 1
            except Exception as e:
                logger.debug("rollup: archive move failed for {}: {}", filename, e)

    logger.info(
        "rollup: session {} → summary {} ({} events archived)",
        session_short, summary_filename, archived,
    )
    return {
        "session": session_short,
        "status": "rolled_up",
        "summary_engram_id": stored_id,
        "summary_filename": summary_filename,
        "events_archived": archived,
        "event_count": len(rows),
    }


def rollup_stale_sessions(
    ctx: BrainContext,
    older_than_hours: int = DEFAULT_OLDER_THAN_HOURS,
    min_events: int = DEFAULT_MIN_EVENTS,
    max_sessions: int = DEFAULT_MAX_SESSIONS_PER_RUN,
) -> dict:
    """Find sessions idle for >N hours with >=M events and roll them up.

    Intended to run inside the consolidation scheduler so the rollup
    happens automatically without user intervention. Bounded to
    `max_sessions` per call so the 4h consolidation cycle stays snappy.
    """
    db = ctx.db

    try:
        rows = db.conn.execute(
            """SELECT id, filename, title, content, created_at
               FROM engrams
               WHERE filename LIKE 'obs-%'
                 AND state != 'dormant'
                 AND COALESCE(kind, 'note') = 'observation'
               ORDER BY filename, created_at"""
        ).fetchall()
    except Exception as e:
        logger.warning("rollup: failed to query observations: {}", e)
        return {"error": str(e), "sessions_rolled_up": 0}

    if not rows:
        return {"sessions_rolled_up": 0, "total_observations": 0}

    # Group by session_short (second field of obs-{short}-...)
    grouped: dict[str, list[tuple]] = defaultdict(list)
    for r in rows:
        short = _session_short_from_filename(r[1] or "")
        if short:
            grouped[short].append(r)

    now = datetime.now(timezone.utc)
    cutoff_seconds = older_than_hours * 3600

    rolled = 0
    stats: list[dict] = []
    for session_short, session_rows in grouped.items():
        if rolled >= max_sessions:
            break
        if len(session_rows) < min_events:
            continue
        last_ts = session_rows[-1][4]
        if not last_ts:
            continue
        try:
            last = datetime.fromisoformat(last_ts)
            if last.tzinfo is None:
                last = last.replace(tzinfo=timezone.utc)
        except (ValueError, TypeError):
            continue
        age_seconds = (now - last).total_seconds()
        if age_seconds < cutoff_seconds:
            continue

        result = rollup_session(ctx, session_short, session_rows)
        if result.get("status") == "rolled_up":
            rolled += 1
            stats.append({
                "session": session_short,
                "events": result["event_count"],
                "archived": result["events_archived"],
            })

    return {
        "sessions_rolled_up": rolled,
        "total_observations": len(rows),
        "stats": stats,
        "older_than_hours": older_than_hours,
    }


def get_rollup_stats(ctx: BrainContext) -> dict:
    """Observability: how much observation data is living in the vault?"""
    db = ctx.db
    try:
        live = db.conn.execute(
            """SELECT COUNT(*) FROM engrams
               WHERE state != 'dormant'
                 AND COALESCE(kind, 'note') = 'observation'"""
        ).fetchone()[0]
        summaries = db.conn.execute(
            """SELECT COUNT(*) FROM engrams
               WHERE state != 'dormant'
                 AND COALESCE(kind, 'note') = 'session_summary'"""
        ).fetchone()[0]
        sessions_live = db.conn.execute(
            """SELECT COUNT(DISTINCT SUBSTR(filename, 5, INSTR(SUBSTR(filename, 5), '-') - 1))
               FROM engrams
               WHERE filename LIKE 'obs-%' AND state != 'dormant'"""
        ).fetchone()[0]
    except Exception as e:
        return {"error": str(e)}

    archive = ctx.vault_dir.parent / "archive"
    archived_files = 0
    if archive.exists():
        try:
            archived_files = sum(1 for _ in archive.glob("obs-*.md"))
        except Exception:
            archived_files = 0

    return {
        "live_observations": live,
        "live_sessions": sessions_live,
        "session_summaries": summaries,
        "archived_files": archived_files,
        "archive_dir": str(archive),
    }
