"""NeuroVault MCP → HTTP proxy.

A lightweight stdio MCP server that forwards tool calls to the Tauri
sidecar's HTTP API on ``http://127.0.0.1:8765``. The whole point is to
keep Claude Code integration working WITHOUT spawning a second full
NeuroVault Python server (which loads fastembed + sqlite-vec + BM25
and easily hits 3-7 GB RAM).

This proxy is ~30-50 MB resident because it imports nothing heavy:
just ``mcp`` (FastMCP) and ``urllib.request`` from stdlib. All the
intelligence lives in the sidecar this process talks to.

Usage (registered via ``claude mcp add``):

    claude mcp add --scope user neurovault uv -- \
        --directory D:/Ai-Brain/engram/server \
        run python -m mcp_proxy

When the Tauri app is running, its sidecar handles the HTTP calls.
When it's not, every tool call returns a clear error — the user needs
to open the app.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from mcp.server.fastmcp import FastMCP


# --- Config --------------------------------------------------------------
# Override via NEUROVAULT_API_URL if the sidecar runs on a different port.
API_BASE = os.environ.get("NEUROVAULT_API_URL", "http://127.0.0.1:8765").rstrip("/")
HTTP_TIMEOUT = float(os.environ.get("NEUROVAULT_PROXY_TIMEOUT", "30"))


# --- HTTP helpers --------------------------------------------------------

def _http_get(path: str, params: dict[str, Any] | None = None) -> Any:
    """GET with query params, returns parsed JSON. Raises on network error."""
    url = API_BASE + path
    if params:
        filtered = {k: v for k, v in params.items() if v is not None}
        if filtered:
            url += "?" + urllib.parse.urlencode(filtered, doseq=True)
    try:
        with urllib.request.urlopen(url, timeout=HTTP_TIMEOUT) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else None
    except urllib.error.URLError as e:
        return _sidecar_down_error(e)


def _http_post(path: str, body: dict[str, Any] | None = None) -> Any:
    data = json.dumps(body or {}).encode("utf-8")
    req = urllib.request.Request(
        API_BASE + path,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            body_bytes = resp.read().decode("utf-8")
            return json.loads(body_bytes) if body_bytes else None
    except urllib.error.URLError as e:
        return _sidecar_down_error(e)
    except urllib.error.HTTPError as e:
        # Server returned an error response (400/404/500) — tunnel the body
        # so the caller sees the real message rather than a generic "HTTP 400".
        try:
            return json.loads(e.read().decode("utf-8"))
        except Exception:
            return {"error": f"{e.code}: {e.reason}"}


def _http_put(path: str, body: dict[str, Any] | None = None) -> Any:
    data = json.dumps(body or {}).encode("utf-8")
    req = urllib.request.Request(
        API_BASE + path,
        data=data,
        headers={"Content-Type": "application/json"},
        method="PUT",
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            body_bytes = resp.read().decode("utf-8")
            return json.loads(body_bytes) if body_bytes else None
    except urllib.error.URLError as e:
        return _sidecar_down_error(e)


def _sidecar_down_error(e: Exception) -> dict:
    return {
        "error": "NeuroVault sidecar is not running",
        "hint": "Open the NeuroVault desktop app — the MCP proxy talks "
                "to its HTTP API on 127.0.0.1:8765.",
        "detail": str(e),
    }


# --- MCP server ----------------------------------------------------------

mcp = FastMCP(
    "NeuroVault",
    instructions=(
        "NeuroVault HTTP proxy. Forwards tool calls to the desktop app's "
        "sidecar. No local embedder, no local DB — if the desktop app "
        "isn't running, tools return a 'sidecar is not running' hint.\n\n"
        "Prefer recall(q, mode='preview') for most lookups. "
        "Use recall(q, mode='titles') when you only need the name list."
    ),
)


@mcp.tool()
def recall(
    query: str,
    mode: str = "preview",
    limit: int = 10,
    brain: str | None = None,
    agent_id: str | None = None,
    include_observations: bool = False,
    rerank: bool = False,
    spread_hops: int = 0,
    as_of: str | None = None,
) -> Any:
    """Hybrid search across memory. Call before answering anything the
    user might have told you before. ``mode`` = titles | preview (default) |
    summary | full. ``spread_hops=1`` expands to 1-hop neighbors via
    engram_links. Set ``brain`` to target a specific vault."""
    return _http_get(
        "/api/recall",
        {
            "q": query,
            "mode": mode,
            "limit": limit,
            "brain": brain,
            "agent_id": agent_id,
            "include_observations": str(include_observations).lower(),
            "rerank": str(rerank).lower(),
            "spread_hops": spread_hops,
            "as_of": as_of,
        },
    )


@mcp.tool()
def remember(
    content: str,
    title: str = "",
    brain: str | None = None,
    agent_id: str | None = None,
    folder: str | None = None,
) -> Any:
    """Save a memory. Supports markdown + [[wikilinks]]. If title is
    omitted it's derived from the first sentence."""
    body: dict[str, Any] = {"content": content}
    if title: body["title"] = title
    if brain: body["brain"] = brain
    if agent_id: body["agent_id"] = agent_id
    if folder: body["folder"] = folder
    return _http_post("/api/notes", body)


@mcp.tool()
def list_brains() -> Any:
    """List all brains with their active flag."""
    return _http_get("/api/brains")


@mcp.tool()
def switch_brain(brain_id: str) -> Any:
    """Switch the active brain. Subsequent recall/remember calls target it."""
    return _http_post(f"/api/brains/{urllib.parse.quote(brain_id)}/activate", {})


@mcp.tool()
def create_brain(name: str, description: str = "", vault_path: str | None = None) -> Any:
    """Create a new brain. Pass ``vault_path`` to point at an existing folder
    (Obsidian-style) instead of creating a fresh internal vault."""
    body: dict[str, Any] = {"name": name, "description": description}
    if vault_path: body["vault_path"] = vault_path
    return _http_post("/api/brains", body)


@mcp.tool()
def check_duplicate(content: str, threshold: float = 0.85, brain: str | None = None) -> Any:
    """Check whether ``content`` is near-duplicate of an existing note.
    Call BEFORE remember() when you're unsure whether the fact is new."""
    body: dict[str, Any] = {"content": content, "threshold": threshold}
    if brain: body["brain"] = brain
    return _http_post("/api/check_duplicate", body)


@mcp.tool()
def recall_chunks(query: str, limit: int = 10, brain: str | None = None) -> Any:
    """Chunk-level semantic search — returns the best matching passages
    (200-400 tokens each) instead of whole notes. Use on long wiki pages."""
    return _http_get(
        "/api/recall/chunks",
        {"q": query, "limit": limit, "brain": brain},
    )


@mcp.tool()
def session_start(brain: str | None = None) -> Any:
    """Fetch the session bootstrap pack — active brain, recent activity,
    core memory blocks. Call once at the start of a session."""
    return _http_get("/api/session_start", {"brain": brain} if brain else None)


@mcp.tool()
def core_memory_read(label: str | None = None, brain: str | None = None) -> Any:
    """Read an agent-editable memory block (persona / project / user /
    custom). Omit ``label`` to list all blocks."""
    if label:
        return _http_get(
            f"/api/core_memory/{urllib.parse.quote(label)}",
            {"brain": brain} if brain else None,
        )
    return _http_get("/api/core_memory", {"brain": brain} if brain else None)


@mcp.tool()
def core_memory_set(label: str, value: str, brain: str | None = None) -> Any:
    """Overwrite a core memory block's value. Enforces char_limit by
    truncating at the last whole-word boundary."""
    body: dict[str, Any] = {"value": value}
    if brain: body["brain"] = brain
    return _http_put(f"/api/core_memory/{urllib.parse.quote(label)}", body)


@mcp.tool()
def core_memory_append(label: str, text: str, brain: str | None = None) -> Any:
    """Append a line to a core memory block. Drops the oldest content
    if the block would overflow its char_limit."""
    body: dict[str, Any] = {"text": text}
    if brain: body["brain"] = brain
    return _http_post(f"/api/core_memory/{urllib.parse.quote(label)}/append", body)


@mcp.tool()
def core_memory_replace(label: str, old: str, new: str, brain: str | None = None) -> Any:
    """Find-and-replace inside a core memory block. Returns the updated
    block on a hit, null when ``old`` wasn't found."""
    body: dict[str, Any] = {"old": old, "new": new}
    if brain: body["brain"] = brain
    return _http_post(f"/api/core_memory/{urllib.parse.quote(label)}/replace", body)


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
