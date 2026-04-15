"""Claude Code lifecycle hook capture — auto-ingest sessions as observations.

Solves the "user has to remember to call remember()" gap. When Claude Code
fires a lifecycle hook (SessionStart, UserPromptSubmit, PostToolUse, Stop,
SessionEnd), a small CLI shim posts the event payload to NeuroVault's HTTP
API, which lands here. Each event becomes an observation engram tagged with
the session id so the whole session can be queried as a unit later.

Observations are stored as regular engrams with `kind='observation'`, so
they participate in hybrid retrieval, decay, and consolidation just like
manual memories — but they're filterable via the `kind` column when you
want to see only the auto-captured stream.

Privacy: any text inside `<private>...</private>` tags is stripped before
ingestion, matching claude-mem's `<private>` convention so users migrating
get the same UX.

Filename convention: `obs-{session_id_short}-{event_seq}.md`
"""

from __future__ import annotations

import hashlib
import json
import re
import time
import uuid
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from loguru import logger

from engram_server.brain import BrainContext
from engram_server.embeddings import Embedder
from engram_server.ingest import ingest_file


# --- Dedupe cache for PostToolUse floods ---
# Claude Code can fire PostToolUse dozens of times per minute during an
# active coding session. Without dedupe the vault fills up with near-
# identical observations (same Edit repeatedly, same Bash poll loop, etc).
# We keep an in-memory LRU of recent signatures and skip any duplicate
# within DEDUPE_WINDOW_SECONDS. Bounded to DEDUPE_MAX_ENTRIES so it can't
# grow unbounded in a long-lived server process.
DEDUPE_WINDOW_SECONDS = 60
DEDUPE_MAX_ENTRIES = 500
_recent_sigs: "OrderedDict[str, float]" = OrderedDict()


# --- PostToolUse capture policy -------------------------------------------
# Claude Code's PostToolUse hook fires after EVERY tool call. In a typical
# coding session that's dozens of events per minute — Read, Grep, Bash,
# Glob, WebFetch, Monitor, etc. Most of them are transient observability
# ops that nobody ever needs to recall. Embedding them all saturates the
# embedder and drowns real memories in observation sludge.
#
# Policy comes from env var `ENGRAM_HOOKS_POSTTOOLUSE`:
#   "mutations"  (default) — only Edit, Write, NotebookEdit (state-changing)
#   "all"                  — every tool (the old behavior)
#   "off"                  — disable PostToolUse capture entirely
#
# Silent fact capture (UserPromptSubmit → insight_extractor) is unaffected
# and remains the recommended ambient-capture path for decisions/preferences.
import os

_POSTTOOLUSE_MODE = os.environ.get("ENGRAM_HOOKS_POSTTOOLUSE", "mutations").lower().strip()
# Tools that actually mutate user state — what's worth remembering by default.
_MUTATION_TOOLS = frozenset({"edit", "write", "notebookedit", "multiedit"})
logger.info("hooks: PostToolUse mode = {!r}", _POSTTOOLUSE_MODE)


def _observation_signature(event: str, payload: dict) -> str | None:
    """Build a stable dedupe key for a PostToolUse event, or None."""
    if event != "PostToolUse":
        return None
    session = str(payload.get("session_id") or payload.get("sessionId") or "unknown")[:8]
    tool = str(payload.get("tool_name") or payload.get("tool") or "")
    tool_input = payload.get("tool_input") or {}
    try:
        input_str = json.dumps(tool_input, sort_keys=True, default=str)[:1000]
    except Exception:
        input_str = str(tool_input)[:1000]
    input_hash = hashlib.sha1(input_str.encode("utf-8", errors="replace")).hexdigest()[:16]
    return f"{session}:{tool}:{input_hash}"


def _is_recent_duplicate(sig: str) -> bool:
    """Check+insert LRU. Returns True if sig was seen in the last window."""
    now = time.time()
    # Evict stale entries from the front
    while _recent_sigs:
        first_key = next(iter(_recent_sigs))
        if now - _recent_sigs[first_key] > DEDUPE_WINDOW_SECONDS:
            _recent_sigs.pop(first_key)
        else:
            break
    if sig in _recent_sigs:
        # Refresh recency so repeated dupes keep getting rejected
        _recent_sigs.move_to_end(sig)
        _recent_sigs[sig] = now
        return True
    _recent_sigs[sig] = now
    # Bound size
    while len(_recent_sigs) > DEDUPE_MAX_ENTRIES:
        _recent_sigs.popitem(last=False)
    return False


PRIVATE_PATTERN = re.compile(r"<private>.*?</private>", re.DOTALL | re.IGNORECASE)

# Hook events Claude Code fires. We only ingest the ones that carry useful
# signal — Stop is a no-op pause, so we skip it by default.
HANDLED_EVENTS = {
    "SessionStart",
    "UserPromptSubmit",
    "PostToolUse",
    "SessionEnd",
}


def _strip_private(text: str) -> str:
    """Remove any <private>...</private> blocks from the text."""
    if not text:
        return ""
    return PRIVATE_PATTERN.sub("[private content removed]", text)


def _short(text: str, n: int = 80) -> str:
    text = (text or "").strip().replace("\n", " ")
    return text[:n] + ("…" if len(text) > n else "")


def _format_observation(event: str, payload: dict) -> tuple[str, str]:
    """Convert a hook payload into (title, markdown_body) for an engram."""
    session_id = payload.get("session_id") or payload.get("sessionId") or "unknown"
    short_session = str(session_id)[:8]
    timestamp = payload.get("timestamp") or datetime.now(timezone.utc).isoformat()

    if event == "SessionStart":
        title = f"Session start · {short_session}"
        body = (
            f"**Event:** SessionStart\n"
            f"**Session:** `{session_id}`\n"
            f"**Started:** {timestamp}\n"
            f"**Cwd:** `{payload.get('cwd', '?')}`\n"
        )

    elif event == "UserPromptSubmit":
        prompt = _strip_private(payload.get("prompt", ""))
        title = f"User prompt · {_short(prompt, 60)}"
        body = (
            f"**Event:** UserPromptSubmit\n"
            f"**Session:** `{session_id}`\n"
            f"**Time:** {timestamp}\n\n"
            f"## Prompt\n\n{prompt}\n"
        )

    elif event == "PostToolUse":
        tool = payload.get("tool_name") or payload.get("tool") or "unknown"
        tool_input = payload.get("tool_input") or {}
        tool_output = _strip_private(str(payload.get("tool_response") or payload.get("output") or ""))
        # Cap output to keep observations from blowing up the index
        if len(tool_output) > 2000:
            tool_output = tool_output[:2000] + "\n... [truncated]"
        title = f"{tool} · {short_session}"
        try:
            input_md = "```json\n" + json.dumps(tool_input, indent=2)[:1500] + "\n```"
        except Exception:
            input_md = f"```\n{str(tool_input)[:1500]}\n```"
        body = (
            f"**Event:** PostToolUse\n"
            f"**Session:** `{session_id}`\n"
            f"**Tool:** `{tool}`\n"
            f"**Time:** {timestamp}\n\n"
            f"## Input\n\n{input_md}\n\n"
            f"## Output\n\n```\n{tool_output}\n```\n"
        )

    elif event == "SessionEnd":
        summary = _strip_private(payload.get("summary", ""))
        title = f"Session end · {short_session}"
        body = (
            f"**Event:** SessionEnd\n"
            f"**Session:** `{session_id}`\n"
            f"**Ended:** {timestamp}\n"
        )
        if summary:
            body += f"\n## Summary\n\n{summary}\n"

    else:
        title = f"{event} · {short_session}"
        body = (
            f"**Event:** {event}\n"
            f"**Session:** `{session_id}`\n"
            f"**Time:** {timestamp}\n\n"
            f"```json\n{json.dumps(payload, indent=2)[:2000]}\n```\n"
        )

    return title, body


def capture_observation(
    ctx: BrainContext,
    embedder: Embedder,
    event: str,
    payload: dict[str, Any],
) -> dict | None:
    """Persist a hook event as an observation engram in the active brain.

    Returns the engram id + filename, or None if the event was filtered out.
    """
    if event not in HANDLED_EVENTS:
        logger.debug("hooks: ignoring unhandled event {}", event)
        return None

    # PostToolUse is high-volume — apply the capture policy from
    # ENGRAM_HOOKS_POSTTOOLUSE (default "mutations"). See module top.
    if event == "PostToolUse":
        if _POSTTOOLUSE_MODE == "off":
            return None
        tool = (payload.get("tool_name") or payload.get("tool") or "").lower()
        if _POSTTOOLUSE_MODE == "mutations" and tool not in _MUTATION_TOOLS:
            return None

    # Dedupe: PostToolUse for the same tool+input inside the window is a
    # near-duplicate (Claude retrying, polling loops, repeated identical
    # edits). Drop it to protect the vault from flood.
    sig = _observation_signature(event, payload)
    if sig and _is_recent_duplicate(sig):
        logger.debug("hooks: deduped {} sig={}", event, sig)
        return {"status": "deduped", "signature": sig, "event": event}

    title, body = _format_observation(event, payload)
    short_id = uuid.uuid4().hex[:6]
    session_id = payload.get("session_id") or payload.get("sessionId") or "unknown"
    short_session = str(session_id)[:8]
    filename = f"obs-{short_session}-{event.lower()}-{short_id}.md"
    filepath = ctx.vault_dir / filename
    filepath.write_text(f"# {title}\n\n{body}", encoding="utf-8")

    try:
        engram_id = ingest_file(filepath, ctx.db, embedder, ctx.bm25)
    except Exception as e:
        logger.warning("hooks: ingest failed for {}: {}", filename, e)
        return {"status": "error", "filename": filename, "error": str(e)}

    if engram_id:
        try:
            ctx.db.conn.execute(
                "UPDATE engrams SET kind = 'observation' WHERE id = ?",
                (engram_id,),
            )
            ctx.db.conn.commit()
        except Exception as e:
            logger.debug("hooks: kind tag failed: {}", e)

    # Stage 5: silently extract factual claims from UserPromptSubmit events
    # and promote them to first-class insight engrams. Runs in real time so
    # facts drop into recall immediately after the user says them, no wait
    # for the 4h consolidation cycle.
    insights_created: list[dict] = []
    if event == "UserPromptSubmit" and engram_id:
        try:
            from engram_server.insight_extractor import promote_insights_from_text
            prompt_text = payload.get("prompt", "") or ""
            if prompt_text:
                insights_created = promote_insights_from_text(
                    ctx,
                    _strip_private(prompt_text),
                    source_engram_id=engram_id,
                    source_filename=filename,
                )
        except Exception as e:
            logger.debug("hooks: insight extraction failed: {}", e)

    logger.info(
        "hooks: captured {} as {} ({}) · insights={}",
        event, filename, engram_id, len(insights_created),
    )
    return {
        "status": "ok",
        "engram_id": engram_id,
        "filename": filename,
        "event": event,
        "insights": insights_created,
    }


def replay_session(ctx: BrainContext, session_id: str, max_events: int = 200) -> dict:
    """Reconstruct a Claude Code session from its captured observations.

    Returns a chronological replay with event types parsed out of each
    observation engram so Claude can answer "what did you do during the
    March 4 debugging session?" Uses the obs-{session}-* filename
    convention to scope to one session.
    """
    pattern = f"obs-{session_id[:8]}-%"
    rows = ctx.db.conn.execute(
        """SELECT id, title, content, created_at, filename
           FROM engrams
           WHERE filename LIKE ? AND state != 'dormant'
           ORDER BY created_at ASC
           LIMIT ?""",
        (pattern, max_events),
    ).fetchall()

    if not rows:
        return {
            "session_id": session_id,
            "found": False,
            "event_count": 0,
            "events": [],
        }

    events: list[dict] = []
    event_counts: dict[str, int] = {}
    tools_used: dict[str, int] = {}
    started = rows[0][3]
    ended = rows[-1][3]

    for engram_id, title, content, created_at, filename in rows:
        # Extract the Event: line we wrote when capturing
        event_type = "Unknown"
        tool_name: str | None = None
        for line in (content or "").splitlines()[:10]:
            line = line.strip()
            if line.startswith("**Event:**"):
                event_type = line.replace("**Event:**", "").strip()
            elif line.startswith("**Tool:**"):
                tool_name = line.replace("**Tool:**", "").strip().strip("`")

        event_counts[event_type] = event_counts.get(event_type, 0) + 1
        if tool_name:
            tools_used[tool_name] = tools_used.get(tool_name, 0) + 1

        events.append({
            "engram_id": engram_id,
            "event": event_type,
            "tool": tool_name,
            "title": title,
            "preview": (content or "")[:200],
            "created_at": created_at,
            "filename": filename,
        })

    return {
        "session_id": session_id,
        "found": True,
        "started": started,
        "ended": ended,
        "event_count": len(events),
        "by_event_type": event_counts,
        "tools_used": tools_used,
        "events": events,
    }


def list_session_observations(ctx: BrainContext, session_id: str, limit: int = 50) -> list[dict]:
    """Return all observation engrams for a given session, oldest first."""
    pattern = f"obs-{session_id[:8]}-%"
    rows = ctx.db.conn.execute(
        """SELECT id, title, content, created_at, filename
           FROM engrams
           WHERE filename LIKE ? AND state != 'dormant'
           ORDER BY created_at ASC
           LIMIT ?""",
        (pattern, limit),
    ).fetchall()
    return [
        {
            "engram_id": r[0],
            "title": r[1],
            "preview": (r[2] or "")[:200],
            "created_at": r[3],
            "filename": r[4],
        }
        for r in rows
    ]
