"""Query audit log — structured append-only JSONL for every MCP tool call.

Every call to an MCP tool (recall, remember, get_related, etc.) gets logged
to ``~/.neurovault/brains/{id}/audit.jsonl`` with:

  - timestamp (ISO 8601, UTC)
  - tool name
  - arguments (serialized)
  - result summary (engram IDs returned/modified, counts)
  - caller identity (session ID when available)

This gives NeuroVault a compliance-ready query audit trail at near-zero cost
(one JSONL line per call, ~200 bytes, no DB writes). The append-only format
means the file is a pure log — nothing ever rewrites or deletes entries.

Usage in MCP tool handlers::

    from neurovault_server.audit import log_tool_call

    @mcp.tool()
    async def recall(query: str, limit: int = 8, mode: str = "preview"):
        results = hybrid_retrieve(...)
        log_tool_call("recall", {"query": query, "limit": limit, "mode": mode},
                      result_ids=[r["engram_id"] for r in results],
                      result_count=len(results))
        return results
"""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from loguru import logger

# Module-level state: the audit log path is set once on server boot via
# init_audit_log(). All writes go through a single lock so concurrent
# tool calls don't interleave partial JSON lines.
_audit_path: Path | None = None
_lock = threading.Lock()


def init_audit_log(brain_dir: Path) -> None:
    """Set the audit log path for the active brain.

    Called once during server startup after the active brain is resolved.
    Subsequent calls (e.g. brain switch) update the path.
    """
    global _audit_path
    _audit_path = brain_dir / "audit.jsonl"
    logger.info("audit: logging to {}", _audit_path)


def log_tool_call(
    tool: str,
    arguments: dict[str, Any],
    *,
    result_ids: list[str] | None = None,
    result_count: int | None = None,
    modified_ids: list[str] | None = None,
    session_id: str | None = None,
    error: str | None = None,
    duration_ms: int | None = None,
    status_code: int | None = None,
) -> None:
    """Append one JSONL entry for a tool call.

    Best-effort: if the write fails (disk full, permission error), we log a
    warning and move on rather than crashing the tool call. The audit log is
    an observability feature, not a critical path.
    """
    if _audit_path is None:
        return  # init_audit_log() hasn't been called yet

    entry: dict[str, Any] = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "tool": tool,
        "args": arguments,
    }
    if result_ids is not None:
        entry["result_ids"] = result_ids[:20]  # cap to keep lines reasonable
    if result_count is not None:
        entry["result_count"] = result_count
    if modified_ids is not None:
        entry["modified_ids"] = modified_ids
    if session_id is not None:
        entry["session_id"] = session_id
    if error is not None:
        entry["error"] = error
    if duration_ms is not None:
        entry["duration_ms"] = duration_ms
    if status_code is not None:
        entry["status_code"] = status_code

    line = json.dumps(entry, ensure_ascii=False, separators=(",", ":"))

    try:
        with _lock:
            with open(_audit_path, "a", encoding="utf-8") as f:
                f.write(line + "\n")
    except Exception as e:
        logger.warning("audit: write failed: {}", e)
