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
import pathlib
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from mcp.server.fastmcp import FastMCP


# --- Config --------------------------------------------------------------
# Override via NEUROVAULT_API_URL if the sidecar runs on a different port.
API_BASE = os.environ.get("NEUROVAULT_API_URL", "http://127.0.0.1:8765").rstrip("/")
HTTP_TIMEOUT = float(os.environ.get("NEUROVAULT_PROXY_TIMEOUT", "30"))


# --- Tool tiers ----------------------------------------------------------
# Every MCP tool's name + description + input schema is loaded into the
# agent's context at session start — for ~30 NeuroVault tools that's
# 5-9k tokens of overhead per session before the user types anything.
# The tier system lets users pay only for the slice they actually use:
#
#   lite     — 8 tools, ~1.5k tokens. Read/write/navigate + brain mgmt.
#   standard — 17 tools, ~3.5k tokens. Lite + chunks/temporal/duplicate
#              detection + core_memory + delete + clutter.
#   full     — every tool registered (default), ~6-8k tokens. Includes
#              the rarely-needed admin surface: link editing,
#              orphan/contradiction audit, bulk metadata, optimize_disk,
#              compile flow, brain creation, cluster naming.
#
# Read order: NEUROVAULT_MCP_TIER env var, then ~/.neurovault/mcp_tier.txt,
# default 'full'. Writers (Settings UI, CLI) update the file; the proxy
# reads it once at startup. Restart the MCP to apply.
TIER_LITE = {
    "recall", "remember", "related", "session_start", "status",
    "list_brains", "switch_brain", "update",
}
TIER_STANDARD = TIER_LITE | {
    "recall_chunks", "temporal_recall", "check_duplicate",
    "core_memory_read", "core_memory_set",
    "core_memory_append", "core_memory_replace",
    "delete_engrams", "find_clutter", "engram_history",
}


def _load_active_tier() -> tuple[str, set[str] | None]:
    """Resolve the active tier. Returns (name, allowed_set) where
    allowed_set is None for 'full' (no filtering)."""
    raw = os.environ.get("NEUROVAULT_MCP_TIER", "").strip().lower()
    if not raw:
        try:
            tier_file = pathlib.Path.home() / ".neurovault" / "mcp_tier.txt"
            if tier_file.exists():
                raw = tier_file.read_text(encoding="utf-8").strip().lower()
        except OSError:
            pass
    if raw == "lite":
        return ("lite", TIER_LITE)
    if raw == "standard":
        return ("standard", TIER_STANDARD)
    return ("full", None)


_ACTIVE_TIER_NAME, _ALLOWED_TOOLS = _load_active_tier()


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


def _http_send(method: str, path: str, body: dict[str, Any] | None = None) -> Any:
    """Send an arbitrary-method request with a JSON body. Used for
    DELETE-with-body (urllib doesn't expose a native DELETE helper)
    and any future PATCH-style endpoints."""
    data = json.dumps(body or {}).encode("utf-8")
    req = urllib.request.Request(
        API_BASE + path,
        data=data,
        headers={"Content-Type": "application/json"},
        method=method,
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
    "NeuroVault" + (
        f" [{_ACTIVE_TIER_NAME}]" if _ACTIVE_TIER_NAME != "full" else ""
    ),
    instructions=(
        "NeuroVault is a persistent, local-first memory layer for this user. "
        "Treat it as an extension of your own memory — everything the user has "
        "told you across past sessions lives here.\n\n"
        "CORE WORKFLOW:\n"
        "1. BEFORE answering any question that could be about the user's life, "
        "preferences, projects, or prior decisions: call `recall(q, mode='preview')`.\n"
        "2. WHEN the user shares a durable fact, decision, or preference: call "
        "`remember(content, deduplicate=0.92)` immediately. The dedupe param "
        "prevents duplicate captures.\n"
        "3. AFTER picking a hit: call `related(engram_id)` to explore what's "
        "connected — 50-100x cheaper than another recall.\n"
        "4. ONCE per session: call `session_start()` to load active brain + "
        "recent activity + core memory blocks.\n\n"
        "TOKEN EFFICIENCY:\n"
        "- `recall(q, mode='titles')`  → ~20 tokens/hit (quick scan)\n"
        "- `recall(q, mode='preview')` → ~100 tokens/hit (DEFAULT)\n"
        "- `recall(q, mode='full')`    → ~400 tokens/hit (deep dives only)\n\n"
        "QUERY OPERATORS (inside the `q` string):\n"
        "- `kind:insight`, `kind:note`, `kind:source`, etc.\n"
        "- `folder:projects`   — only notes under projects/*\n"
        "- `after:2026-04-01`  — only recent engrams\n"
        "- `entity:claude`     — only engrams mentioning an entity\n"
        "- `state:fresh`       — only non-dormant\n"
        "Combine freely: `kind:insight folder:projects auth migration`.\n\n"
        "RATE-LIMITED: the backend throttles recall spam (1-3 calls normal, "
        "4-8 halved, 9+ strongly reduced). If you see a result with "
        "engram_id='__throttle_hint__', you're querying too aggressively — "
        "broaden your query or use `related()` instead.\n\n"
        "PRECISION BOOST: pass `rerank=true` on recall when the top-1 answer "
        "has to be right (before writing a dependent response, citing a "
        "specific note, or emitting a deep link). Pushes hit@1 from ~87% → "
        "~93% at the cost of ~700ms instead of ~25ms. Off by default.\n\n"
        "Deep links: every engram can be opened via "
        "`neurovault://engram/<id>` — emit these in chat so the user can click."
    ),
)


# Tier filter: wrap mcp.tool so existing `@mcp.tool(...)` decorators
# below skip registration for tools outside the active tier. The
# original returns a decorator factory; ours returns a no-op decorator
# (returning the function as-is) when the tool isn't in the allowlist.
# The function still defines, just isn't reachable via MCP — keeping
# the call sites unchanged is what makes this a one-line knob.
_original_mcp_tool = mcp.tool


def _filtered_mcp_tool(*args: Any, **kwargs: Any):
    inner_decorator = _original_mcp_tool(*args, **kwargs)

    def wrapper(fn):
        if _ALLOWED_TOOLS is not None and fn.__name__ not in _ALLOWED_TOOLS:
            return fn
        return inner_decorator(fn)

    return wrapper


mcp.tool = _filtered_mcp_tool  # type: ignore[assignment]


# ============================================================================
# READ tools — safe, idempotent, cacheable.
# Tool annotations help clients (Claude Code, Inspector) decide when to
# auto-approve vs prompt the user. `readOnlyHint=True` lets read-only
# tools pass through auto-allow-read-only mode without confirmation.
# ============================================================================


@mcp.tool(annotations={
    "title": "Recall from memory",
    "readOnlyHint": True,
    "idempotentHint": True,
    "openWorldHint": False,
})
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
    """Hybrid search across the user's memory. CALL THIS before answering
    anything the user might have told you — NeuroVault contains everything
    they've said across past conversations. This is your primary memory tool.

    WHEN TO CALL:
    - User asks about themselves, their preferences, opinions, projects
    - User references something from "before" / "last time" / "we discussed"
    - User asks a factual question where their context could inform the answer
    - Before generating advice so it's grounded in their actual history

    Modes (token cost per hit):
        titles  →  ~20 tokens   (fast scan when you only need names)
        preview →  ~100 tokens  (DEFAULT, best for most queries)
        full    →  ~400 tokens  (only when you need the entire text)

    Search operators inside `query`:
        kind:insight            — only insights
        folder:projects         — only notes under that folder
        after:2026-04-01        — only recent
        entity:claude           — only engrams mentioning Claude
        state:fresh             — only non-dormant

    Combine: `kind:insight folder:work auth migration decisions`.

    `spread_hops=1` adds 1-hop neighbours via engram_links (useful when
    the query is slightly off-target). `as_of` = ISO timestamp for
    time-travel queries ("what did I know last Tuesday?").

    Repeat queries inside 60s hit an in-process cache (~2ms vs ~200ms);
    you pay no extra tokens for re-asking.

    `rerank=True` runs a cross-encoder (BGE-reranker-base) over the
    top-20 candidates. Measured on the internal eval set: pushes
    hit@1 from 87% → 93% (right answer in top slot 6 more times
    out of every 100 queries). Trade-off: latency goes from ~25 ms
    to ~680 ms. WHEN TO USE:
      - You need the top-1 result to be RIGHT (before writing a
        dependent answer, citing a specific note, or following a
        deep link).
      - The default recall returned a plausible-but-wrong top-1
        and you want to rerank.
      - User explicitly asked for the "best" or "most relevant" hit.
    WHEN NOT TO USE:
      - Quick context scans.
      - You're going to read the top-5 anyway.
      - Inside a chain of recalls (the latency adds up).
    """
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


@mcp.tool(annotations={
    "title": "Get related engrams",
    "readOnlyHint": True,
    "idempotentHint": True,
    "openWorldHint": False,
})
def related(
    engram_id: str,
    hops: int = 1,
    limit: int = 20,
    min_similarity: float = 0.55,
    link_types: str | None = None,
    include_observations: bool = False,
    brain: str | None = None,
) -> Any:
    """Fetch engrams directly linked to a given engram. Use this INSTEAD
    of a fresh `recall` when you already have an engram and want to
    explore its neighbourhood — it's ~50-100x cheaper (single SQL query
    vs full hybrid retrieval).

    WHEN TO CALL:
    - User picked a specific memory and you want to show "what else
      relates to this"
    - You fetched engram X via recall and want to follow its edges
    - You're building a summary / compilation and need structural context
      around a known anchor

    Args:
        hops=1        — direct neighbours only (default, fastest)
        hops=2        — includes 2-hop neighbours (still cheap, slightly noisier)
        link_types    — comma-separated allow-list: "semantic,entity,manual,
                        uses,extends,depends_on,contradicts,supersedes,..."
                        Leave null for all types.
        min_similarity=0.55 — default matches the spread-activation threshold.

    Returns a list sorted by (hop_distance ASC, similarity DESC) so
    direct strong neighbours come first.
    """
    params = {
        "hops": hops,
        "limit": limit,
        "min_similarity": min_similarity,
        "include_observations": str(include_observations).lower(),
    }
    if link_types: params["link_types"] = link_types
    if brain: params["brain_id"] = brain
    return _http_get(f"/api/related/{urllib.parse.quote(engram_id)}", params)


@mcp.tool(annotations={
    "title": "Chunk-level recall",
    "readOnlyHint": True,
    "idempotentHint": True,
    "openWorldHint": False,
})
def recall_chunks(query: str, limit: int = 10, brain: str | None = None) -> Any:
    """Passage-level semantic search — returns the specific paragraphs
    inside notes that match, not the whole notes. Use this when `recall`
    is returning huge wiki pages where only one paragraph is relevant.

    WHEN TO CALL:
    - The query is narrow but the matching engram is a long document
    - User asks "what did I write about X in Y" (X is specific, Y is long)
    - You need to quote a specific passage rather than summarise a whole
      note

    Each returned chunk is 200-400 tokens. Deduped to one chunk per engram
    (the top-ranked one wins) so a single long note can't flood results.
    """
    return _http_get(
        "/api/recall/chunks",
        {"q": query, "limit": limit, "brain": brain},
    )


@mcp.tool(annotations={
    "title": "Recall across every brain (federated search)",
    "readOnlyHint": True,
    "idempotentHint": True,
    "openWorldHint": False,
})
def recall_across_brains(
    query: str,
    top_k: int = 10,
    per_brain: int = 5,
    brains: str | None = None,
    include_observations: bool = False,
    rerank: bool = False,
) -> Any:
    """Run hybrid retrieval against EVERY brain in the registry (or a
    caller-supplied subset) and merge by score. Each hit comes back
    annotated with `brain_id` + `brain_name` so the agent can answer
    "where does this live?" alongside the content.

    WHEN TO CALL:
    - User asks something but you don't know which brain holds it.
    - User says "search everywhere for X" / "across all my notes".
    - You ran `recall` against the active brain and got nothing
      relevant — try federated before giving up.

    Caveats:
    - RRF scores are unitless and brain-relative; comparing across
      brains is approximate. Use this as "anywhere this exists",
      not "globally ranked best answer."
    - Cost is linear in brain count. Each per-brain search runs
      through the throttled hybrid path; with 6 brains and the
      defaults you fan out to 30 hits.

    Args:
        query: search query (same operators as `recall`).
        top_k: total hits returned after merge. Default 10, max 50.
        per_brain: cap per-brain hits before merge. Default 5,
            max 20. Lower = faster, higher = better recall when one
            brain dominates the right answer.
        brains: comma-separated brain ids to scope the search.
            Empty/missing = every brain in the registry. Unknown
            ids are silently dropped.
        include_observations: include kind='observation' engrams
            (auto-extracted, noisier). Default False.
        rerank: cross-encoder rerank pass. Default False.

    Returns:
        query, brains_searched, total
        hits: [{ brain_id, brain_name, engram_id, title, content,
                 score, strength, state }]  sorted by score desc.
    """
    return _http_get(
        "/api/recall_across_brains",
        {
            "q": query,
            "top_k": top_k,
            "per_brain": per_brain,
            "brains": brains,
            "include_observations": "true" if include_observations else "false",
            "rerank": "true" if rerank else "false",
        },
    )


@mcp.tool(annotations={
    "title": "Session bootstrap",
    "readOnlyHint": True,
    "idempotentHint": True,
    "openWorldHint": False,
})
def session_start(brain: str | None = None) -> Any:
    """Load the user's session context: active brain, recent activity feed,
    core memory blocks (persona / project / preferences). Call this ONCE
    at the start of a conversation to know which brain you're in + what's
    been happening.

    WHEN TO CALL:
    - First tool call of a new conversation (unless the user's first
      message is trivial and obviously doesn't need memory)
    - After a `switch_brain` to rebootstrap on the new context

    Cheap (~10ms). Safe to call once per session without gating.
    """
    return _http_get("/api/session_start", {"brain": brain} if brain else None)


@mcp.tool(annotations={
    "title": "List all brains",
    "readOnlyHint": True,
    "idempotentHint": True,
    "openWorldHint": False,
})
def list_brains() -> Any:
    """List every memory brain (vault) with its active flag + note count.
    Brains are isolated memory spaces — "work", "personal", "research"
    etc. The active brain receives all recall/remember calls by default.

    WHEN TO CALL:
    - User asks "what vaults / brains do I have?"
    - Before a `switch_brain` to look up the target brain's id
    - Rarely; brains don't change often
    """
    return _http_get("/api/brains")


@mcp.tool(annotations={
    "title": "Check if content is a duplicate",
    "readOnlyHint": True,
    "idempotentHint": True,
    "openWorldHint": False,
})
def check_duplicate(content: str, threshold: float = 0.85, brain: str | None = None) -> Any:
    """Check whether `content` near-duplicates an existing engram BEFORE
    writing it. Returns the matched engram id + similarity if found,
    else null.

    PREFER `remember(content, deduplicate=0.92)` when you're going to
    write anyway — it runs the same check inline + skips the write on
    match, saving one round-trip. Use `check_duplicate` only when you
    want to INSPECT duplicates without committing to a write.
    """
    body: dict[str, Any] = {"content": content, "threshold": threshold}
    if brain: body["brain"] = brain
    return _http_post("/api/check_duplicate", body)


@mcp.tool(annotations={
    "title": "Read core memory block",
    "readOnlyHint": True,
    "idempotentHint": True,
    "openWorldHint": False,
})
def core_memory_read(label: str | None = None, brain: str | None = None) -> Any:
    """Read an agent-editable memory block (Letta/MemGPT pattern) —
    short, persistent, structured context the agent maintains about
    the user's identity, preferences, active project. Always loaded
    into your context via `session_start`; this tool is for deliberate
    re-reads when you need the fresh value.

    WHEN TO CALL:
    - After a `core_memory_append/replace/set` when you need the
      updated state
    - User asks "what do you remember about me" and you want the
      structured block, not fuzzy recall

    Omit `label` to list all blocks.
    """
    if label:
        return _http_get(
            f"/api/core_memory/{urllib.parse.quote(label)}",
            {"brain": brain} if brain else None,
        )
    return _http_get("/api/core_memory", {"brain": brain} if brain else None)


# ============================================================================
# WRITE tools — destructive/stateful. Annotated so clients can gate them
# behind confirmation or audit logs.
# ============================================================================


@mcp.tool(annotations={
    "title": "Remember a fact (write)",
    "readOnlyHint": False,
    "destructiveHint": False,  # creates new rows, doesn't modify existing
    "idempotentHint": False,    # multiple calls create multiple engrams unless deduplicate=
    "openWorldHint": False,
})
def remember(
    content: str,
    title: str = "",
    brain: str | None = None,
    agent_id: str | None = None,
    folder: str | None = None,
    deduplicate: float | None = None,
) -> Any:
    """Save a memory permanently. This is how information persists across
    conversations — if you don't call this, the fact is gone when the
    session ends.

    WHEN TO CALL:
    - User shares a durable fact: "I prefer Rust over Go"
    - User makes a decision: "we're moving to Postgres"
    - User reveals an identity / preference / constraint you should
      remember for future conversations
    - You reach a conclusion worth preserving: "the auth migration
      decision was to use JWT because..."

    WHEN NOT TO CALL:
    - Ephemeral requests ("summarize this for me right now")
    - Content the user is typing that will obviously be in the next
      message
    - You're unsure it matters — better to ask the user or skip

    ALMOST ALWAYS pass `deduplicate=0.92`. It runs a cosine-similarity
    check against existing engrams; on near-match the existing engram
    id comes back with `status="merged"` and no new note is created.
    Saves the "same insight captured five times" clutter — and is
    10x faster than a fresh ingest when a duplicate exists.

    `title` is auto-derived from the first line if omitted. `folder`
    places the note under that subdirectory. `content` supports
    markdown + `[[wikilinks]]` to other notes.

    Hard ceiling: 32 KB. Split longer content into multiple engrams.
    """
    body: dict[str, Any] = {"content": content}
    if title: body["title"] = title
    if brain: body["brain"] = brain
    if agent_id: body["agent_id"] = agent_id
    if folder: body["folder"] = folder
    if deduplicate is not None: body["deduplicate"] = float(deduplicate)
    return _http_post("/api/notes", body)


@mcp.tool(annotations={
    "title": "Switch active brain",
    "readOnlyHint": False,
    "destructiveHint": False,  # just changes pointer, doesn't delete
    "idempotentHint": True,     # switching to the already-active brain is a no-op
    "openWorldHint": False,
})
def switch_brain(brain_id: str) -> Any:
    """Change which brain (vault) subsequent `recall`/`remember` calls
    target. Also triggers a watcher + cache rotation on the Rust side.

    WHEN TO CALL:
    - User explicitly asks to switch context ("switch to work brain")
    - You detect you're in the wrong brain for a topic (e.g. user
      asks about a personal project while the "work" brain is active)

    WHEN NOT TO CALL:
    - Speculatively / between queries — brain switches are visible
      to the user and confusing if done without reason.

    Call `list_brains()` first if you don't have the target brain_id.
    """
    return _http_post(f"/api/brains/{urllib.parse.quote(brain_id)}/activate", {})


@mcp.tool(annotations={
    "title": "Create new brain",
    "readOnlyHint": False,
    "destructiveHint": False,
    "idempotentHint": False,
    "openWorldHint": False,
})
def create_brain(name: str, description: str = "", vault_path: str | None = None) -> Any:
    """Create a new brain (isolated memory vault). RARELY called by an
    agent — usually the user creates brains manually in the UI. Only
    invoke if the user explicitly asks for a new brain.

    `vault_path` points NeuroVault at an existing folder of markdown
    files (Obsidian-style) instead of creating a fresh vault.
    """
    body: dict[str, Any] = {"name": name, "description": description}
    if vault_path: body["vault_path"] = vault_path
    return _http_post("/api/brains", body)


@mcp.tool(annotations={
    "title": "Overwrite core memory block",
    "readOnlyHint": False,
    "destructiveHint": True,   # overwrites existing value
    "idempotentHint": True,     # setting same value twice is a no-op
    "openWorldHint": False,
})
def core_memory_set(label: str, value: str, brain: str | None = None) -> Any:
    """OVERWRITE a core memory block's entire value. Destructive —
    whatever was there before is gone. Prefer `core_memory_append` or
    `core_memory_replace` for incremental updates.

    WHEN TO CALL:
    - User explicitly replaces their persona / project / preferences
      wholesale: "actually, forget what I said, my project is now X"
    - Initial population of a new block

    char_limit is enforced via whole-word truncation.
    """
    body: dict[str, Any] = {"value": value}
    if brain: body["brain"] = brain
    return _http_put(f"/api/core_memory/{urllib.parse.quote(label)}", body)


@mcp.tool(annotations={
    "title": "Append to core memory block",
    "readOnlyHint": False,
    "destructiveHint": False,  # non-destructive addition
    "idempotentHint": False,    # same text twice is still two appends
    "openWorldHint": False,
})
def core_memory_append(label: str, text: str, brain: str | None = None) -> Any:
    """Append a line to a core memory block. Non-destructive — keeps
    the existing content and adds on. Drops OLDEST content (FIFO) if
    the block would overflow its char_limit.

    WHEN TO CALL:
    - User reveals a new preference / constraint that should accumulate:
      "and I prefer TypeScript over JavaScript"
    - Building up an active-project log during a working session
    """
    body: dict[str, Any] = {"text": text}
    if brain: body["brain"] = brain
    return _http_post(f"/api/core_memory/{urllib.parse.quote(label)}/append", body)


@mcp.tool(annotations={
    "title": "Find-and-replace in core memory",
    "readOnlyHint": False,
    "destructiveHint": True,   # modifies existing content
    "idempotentHint": False,    # replace can't be re-applied safely
    "openWorldHint": False,
})
def core_memory_replace(label: str, old: str, new: str, brain: str | None = None) -> Any:
    """Find-and-replace inside a core memory block. Precise edit — use
    when the user corrects a specific fact ("actually my role is
    Engineering Manager, not Engineer") without disturbing the rest
    of the block. Returns null if `old` wasn't found; non-destructive
    in that case.

    WHEN TO CALL:
    - User corrects a specific fact in a known block
    - You need to surgically update one line of a long persona

    PREFER this over `core_memory_set` for partial updates.
    """
    body: dict[str, Any] = {"old": old, "new": new}
    if brain: body["brain"] = brain
    return _http_post(f"/api/core_memory/{urllib.parse.quote(label)}/replace", body)


# --- Cluster naming ------------------------------------------------------
#
# Two tools that let an MCP-speaking agent name the user's brain
# clusters. Backed by the Rust HTTP server's /api/clusters and
# /api/clusters/names endpoints. The shape is:
#
#   1. User opens the app and enables Analytics mode in the graph
#      view. The frontend computes Louvain clusters and pushes
#      summaries to the Rust HTTP server (in-memory).
#   2. Agent calls list_unnamed_clusters() to fetch them.
#   3. Agent reads each cluster's top notes + sample wikilinks,
#      proposes a 2-4 word name capturing the theme, and calls
#      set_cluster_names({"3": "API design", ...}).
#   4. Names persist to ~/.neurovault/brains/{id}/cluster_names.json
#      and are picked up on next graph render.
#
# No API keys. The agent's own model (whatever Claude session the
# user is running) does the work. Same shape works in v0.1.2 for
# more "agent fixes the brain" tools (dedupe, folder suggestions).


@mcp.tool(annotations={
    "title": "List unnamed graph clusters",
    "readOnlyHint": True,
    "idempotentHint": True,
    "openWorldHint": False,
})
def list_unnamed_clusters(only_unnamed: bool = True, brain: str | None = None) -> Any:
    """List Louvain communities in the user's brain that don't have
    names yet, with sample notes for each so you can propose a name.

    REQUIRES: the user has Analytics mode enabled in the graph view
    (the app pushes cluster data when Analytics runs Louvain). If
    `needs_analytics` is true in the response, tell the user to
    open NeuroVault and click the Analytics toggle in the graph
    view, then try again.

    Each cluster has:
      id           — integer to use in `set_cluster_names`
      size         — total notes in this cluster
      top_titles   — first 5 most-referenced note titles (the
                     primary signal you'll use to name the cluster)
      sample_links — wikilinks observed across cluster members
      name         — already-saved name (only present when
                     only_unnamed=False)

    For each cluster propose a 2-4 word theme name based on the
    top_titles + sample_links. Skip clusters with size < 5 — they're
    noise. Then call `set_cluster_names` with the dict.

    Args:
        only_unnamed: when True (default), skip clusters that already
            have names — repeated runs of /name-clusters won't
            re-propose names for ones the user has hand-edited.
        brain: target brain id (defaults to active).
    """
    params: dict[str, Any] = {"only_unnamed": str(only_unnamed).lower()}
    if brain: params["brain_id"] = brain
    return _http_get("/api/clusters", params)


@mcp.tool(annotations={
    "title": "Save names for graph clusters",
    "readOnlyHint": False,
    "destructiveHint": False,   # additive — merges with existing names
    "idempotentHint": True,
    "openWorldHint": False,
})
def set_cluster_names(names: dict[str, str], brain: str | None = None) -> Any:
    """Persist names for one or more Louvain communities. Merges into
    the existing name registry — clusters not in `names` keep their
    current name (or stay unnamed). Empty string for a value clears
    that cluster's name.

    Args:
        names: map from cluster id (as string) → 2-4 word theme name.
            Example: {"0": "API design", "1": "Rust migration"}.
        brain: target brain id (defaults to active).

    Returns:
        saved        — count of names submitted in this call
        total_named  — total clusters that now have a name in the
                       registry (after the merge)

    The user's hand-edits in cluster_names.json are preserved unless
    you pass an empty string for that id; agents shouldn't overwrite
    a name they didn't propose.
    """
    body: dict[str, Any] = {"names": names}
    if brain: body["brain_id"] = brain
    return _http_post("/api/clusters/names", body)


@mcp.tool(annotations={
    "title": "Brain health status",
    "readOnlyHint": True,
    "idempotentHint": True,
    "openWorldHint": False,
})
def status() -> Any:
    """Quick brain-health snapshot. Use this to answer "is the user's
    brain in good shape?" in one call without scraping multiple
    endpoints.

    WHEN TO CALL:
    - User asks "how's my brain doing" / "is everything working" /
      "what's the status"
    - You want to confirm the sidecar is up + the active brain has
      data before doing other work
    - Before suggesting a recall-heavy task, sanity-check there are
      enough notes to recall from

    Returns:
        brain        — active brain id
        memories     — non-dormant engram count
        chunks       — total chunk rows (each engram has 1-N chunks)
        entities     — distinct entities extracted across the vault
        connections  — total engram_link rows (graph edges)
        freshness    — { fresh, active, dormant, total } counts.
                       "fresh" is recently touched, "active" is
                       stable, "dormant" has decayed past the recall
                       threshold. A healthy brain typically has
                       fresh + active >> dormant.
        links        — { manual, entity, semantic, other, total }
                       counts. "manual" is wikilinks the user typed,
                       "entity" is auto-extracted shared mentions,
                       "semantic" is cosine-similarity edges. Lots
                       of semantic and few manual is normal; lots of
                       manual signals a heavily curated brain.

    Cheap (~5-10 ms) so calling on every conversation start is fine.
    """
    return _http_get("/api/status")


@mcp.tool(annotations={
    "title": "Prepare a wiki compile pack",
    "readOnlyHint": True,
    "idempotentHint": True,
    "openWorldHint": False,
})
def compile_prepare(topic: str, brain: str | None = None, limit: int = 12) -> Any:
    """Build a source pack for compiling a wiki page on `topic`. Step
    1 of the agent-driven compile flow.

    WHEN TO CALL:
    - User asks you to "write a wiki page on X" / "summarise everything
      I've said about X" / "compile what we know about X"
    - You want to author a canonical reference page that the user can
      then review and approve

    Returns:
        topic        — the requested topic, trimmed
        brain_id     — which brain the pack is from
        sources      — top-N most relevant engrams, each with
                       {id, short_id, title, kind, content}
        existing_wiki — if a wiki page on this topic already exists,
                        its current content (so you can update vs
                        rewrite). Omitted on the first compile.
        schema       — CLAUDE.md or schema.md from the vault root, if
                       present. Use this to match house style.

    Next step: write the wiki markdown yourself from this pack, then
    call `compile_submit` to persist it as `pending` for the user to
    review in the Compile tab of the desktop app.

    Args:
        topic: short title for the page, e.g. "Auth migration".
        brain: target brain id (defaults to active).
        limit: source pack size. Default 12.
    """
    body: dict[str, Any] = {"topic": topic, "limit": limit}
    if brain:
        body["brain"] = brain
    return _http_post("/api/compilations/prepare", body)


@mcp.tool(annotations={
    "title": "Submit a compiled wiki for review",
    "readOnlyHint": False,
    "destructiveHint": False,  # writes a new wiki engram + a pending row
    "idempotentHint": False,   # repeat calls create more pending rows
    "openWorldHint": False,
})
def compile_submit(
    topic: str,
    wiki_markdown: str,
    source_engram_ids: list[str] | None = None,
    brain: str | None = None,
    auto_approve: bool = False,
) -> Any:
    """Submit your compiled wiki page for the user to review (or
    auto-approve it). Step 2 of the agent-driven compile flow, after
    `compile_prepare`.

    Writes the wiki markdown to vault/wiki/<slug>.md, marks the
    engram as kind='wiki', and inserts a row in the compilations
    table. By default status='pending' so the desktop app's Compile
    tab can show the diff for human review. Pass auto_approve=True
    to skip the review queue and mark it approved on the spot.

    Returns:
        compilation_id   — the row's id
        wiki_engram_id   — the engram id of the written wiki page
        wiki_filename    — relative path inside the vault
        brain_id         — which brain it landed in
        status           — "pending" or "approved" depending on flag

    Args:
        topic: same topic you passed to `compile_prepare`.
        wiki_markdown: the full wiki body you authored. No code fences,
            no preamble — just the markdown.
        source_engram_ids: list of source engram ids (from the prepare
            pack) you actually used. Persisted for provenance.
        brain: target brain id (defaults to active).
        auto_approve: when True, skip the review queue and mark the
            compilation approved immediately. Use only when the user
            has explicitly opted into auto-approve (the desktop app's
            Compile tab has a toggle for this) or has explicitly
            instructed you to auto-approve in this conversation.
    """
    body: dict[str, Any] = {
        "topic": topic,
        "wiki_markdown": wiki_markdown,
        "source_engram_ids": source_engram_ids or [],
        "auto_approve": auto_approve,
    }
    if brain:
        body["brain"] = brain
    return _http_post("/api/compilations/submit", body)


@mcp.tool(annotations={
    "title": "Find contradictions — facts that conflict with each other",
    "readOnlyHint": True,
    "idempotentHint": True,
    "openWorldHint": False,
})
def find_contradictions(
    resolved: bool | None = False,
    brain: str | None = None,
    limit: int = 50,
) -> Any:
    """Surface auto-detected fact-level conflicts in the brain. The
    ingest pipeline flags contradictions whenever two engrams assert
    incompatible things (e.g. "user prefers Rust" then later "user
    prefers Go"). They sit in the contradictions table waiting for
    review.

    WHEN TO CALL:
    - User asks "what conflicts in my brain" / "what changed my mind"
    - You're about to make a confident assertion in a recall response
      and want to check if it's been superseded
    - Auditing the brain after a long session of writes

    Returns:
        brain_id        — which brain was queried
        total           — number of contradictions in the response
        contradictions  — list of:
            { id, fact_a, fact_b,
              engram_a_id, engram_a_title,
              engram_b_id, engram_b_title,
              detected_at, resolved, resolution }
        Each row includes both engram titles so you can quote them
        when proposing a resolution.

    Args:
        resolved: filter by state. False (default) shows only
            unresolved — the actionable list. True shows the audit
            trail of past resolutions. None shows everything.
        brain: target brain id (defaults to active).
        limit: cap. Default 50, max 500.
    """
    params: dict[str, Any] = {"limit": limit}
    if resolved is not None:
        params["resolved"] = str(resolved).lower()
    if brain:
        params["brain"] = brain
    return _http_get("/api/contradictions", params)


@mcp.tool(annotations={
    "title": "Resolve a contradiction — mark it reviewed",
    "readOnlyHint": False,
    "destructiveHint": False,  # annotation only; no engram changes
    "idempotentHint": True,
    "openWorldHint": False,
})
def resolve_contradiction(
    contradiction_id: str,
    resolution: str | None = None,
    brain: str | None = None,
) -> Any:
    """Mark a contradiction as resolved with an optional human-
    readable note explaining the call. Does NOT delete or rewrite
    the underlying engrams — resolution is annotation, not action.

    WHEN TO CALL:
    - After find_contradictions() and the user has decided how to
      reconcile a specific conflict
    - When you've written a new engram that supersedes one of the
      facts and want the conflict closed

    To actually fix the underlying data, the user should edit the
    out-of-date engram (or use `delete_engrams` if it should be
    removed entirely). This tool just clears the entry from the
    "needs review" list.

    Args:
        contradiction_id: id from find_contradictions()
        resolution: optional note explaining the resolution
        brain: target brain id (defaults to active).
    """
    body: dict[str, Any] = {}
    if resolution is not None:
        body["resolution"] = resolution
    if brain:
        body["brain"] = brain
    return _http_post(
        f"/api/contradictions/{contradiction_id}/resolve",
        body,
    )


@mcp.tool(annotations={
    "title": "Find orphan links — high-similarity pairs missing a manual edge",
    "readOnlyHint": True,
    "idempotentHint": True,
    "openWorldHint": False,
})
def find_orphan_links(
    threshold: float = 0.85,
    limit: int = 50,
    brain: str | None = None,
) -> Any:
    """Surface engram pairs the system thinks are very similar but
    that have NO manual / typed link asserted between them — the
    obvious "you should probably wikilink these" candidates.

    Logic: walks the engram_links table for rows with
    link_type='semantic' (the auto-similarity layer) above the
    threshold, then excludes any pair that already has a manual,
    uses, extends, depends_on, supersedes, or contradicts edge in
    either direction. Cheap — pure SQL, no embedding scan.

    WHEN TO CALL:
    - User asks "what should I link" / "find missing connections"
    - You're auditing the brain after a recall surfaced two notes
      the user clearly thinks of together but never linked
    - After importing markdown from another tool that didn't carry
      its links over

    Returns:
        brain_id    — which brain was queried
        threshold   — the similarity floor used
        total       — number of pairs returned
        pairs       — list of:
            { engram_a_id, engram_a_title,
              engram_b_id, engram_b_title,
              similarity }
        Sorted by similarity DESC. Each unordered pair appears once.

    Args:
        threshold: 0.0-1.0, default 0.85. Raise to 0.90+ for "almost
            certainly related" pairs only.
        limit: cap on returned pairs. Default 50, max 500.
        brain: target brain id (defaults to active).

    Suggested follow-up: present the pairs to the user, then call
    `add_link(from, to, link_type='manual')` for confirmed ones.
    """
    return _http_get(
        "/api/orphan_links",
        {"threshold": threshold, "limit": limit, "brain": brain},
    )


@mcp.tool(annotations={
    "title": "Time-travel query against the temporal_facts table",
    "readOnlyHint": True,
    "idempotentHint": True,
    "openWorldHint": False,
})
def temporal_recall(
    query: str = "",
    as_of: str | None = None,
    engram_id: str | None = None,
    include_superseded: bool = False,
    limit: int = 50,
    brain: str | None = None,
) -> Any:
    """Query the bitemporal `temporal_facts` table — the layer that
    tracks WHEN each extracted fact was true. Lets you ask "what did I
    believe about X" or "what did I believe about X on date Y".

    Two time axes:
      • valid time: the period the fact described reality
                    [valid_from, valid_until)
      • system time: when we knew the fact; `expired_at` is set when
                     a row was retracted (vs simply ending its valid
                     interval)

    `as_of` filters on both axes simultaneously: the row's valid
    interval must contain `as_of` AND the row must not have been
    retracted before `as_of`. Result = exactly what the system would
    have asserted at that moment.

    WHEN TO CALL:
    - "What did I think about X" / "show me the history of X"
    - User references a past decision: "we were using Postgres back
      in March, right?" → temporal_recall(query='postgres',
      as_of='2026-03-15')
    - Auditing a topic before writing a new claim — see if the brain
      already has prior versions you'd be silently overriding
    - Surfacing the changelog for a specific engram with engram_id

    Returns:
        brain_id, query, as_of, include_superseded, total
        facts: list of:
            { id, engram_id, engram_title, fact,
              valid_from, valid_until, is_current,
              superseded_by, expired_at }
        Sorted by valid_from DESC (most recent assertion first).

    Args:
        query: free-text substring matched against fact content
            (case-insensitive). Empty = no text filter — returns the
            most recent facts in the brain.
        as_of: ISO timestamp ("2026-01-15" or "2026-01-15T12:00:00").
            Default = now: only currently-valid, unretracted facts.
        engram_id: scope to facts attached to this engram only.
        include_superseded: when True, drop the validity filter and
            return every match — current, ended, and retracted alike.
            Use this for full audit trails.
        limit: max rows. Default 50, max 500.
        brain: target brain id (defaults to active).

    Note: this surfaces the bitemporal table directly. For semantic
    recall (vector + BM25 + graph) use `recall()` — that pipeline
    already biases against superseded facts when ranking.
    """
    return _http_get(
        "/api/temporal_recall",
        {
            "query": query,
            "as_of": as_of,
            "engram_id": engram_id,
            "include_superseded": "true" if include_superseded else "false",
            "limit": limit,
            "brain": brain,
        },
    )


@mcp.tool(annotations={
    "title": "List image files in a folder (caption-at-ingest workflow)",
    "readOnlyHint": True,
    "idempotentHint": True,
    "openWorldHint": False,
})
def list_images(
    folder_path: str,
    recursive: bool = True,
    limit: int = 500,
) -> Any:
    """Walk a folder for image files (.png, .jpg, .jpeg, .webp, .gif,
    .bmp, .svg, .heic, .tiff). Returns absolute paths + sizes + last-
    modified timestamps. Use this as step 1 of the caption-at-ingest
    workflow:

    1. Call list_images(folder) to enumerate images.
    2. For each image: open it with Read in your context (Claude
       Code / Desktop is multimodal), then write a 1-3 sentence
       caption.
    3. Call remember_image(image_path, caption) to persist.

    The MCP server itself doesn't do CV — YOU are the captioning
    model. Nothing leaves the user's machine.

    Skipped: dotfile dirs (.git, .obsidian), trash/, non-image files.
    Ordering is filesystem-natural (no sort), so caption in the
    order returned and you'll match the user's mental model.

    Returns:
        folder_path, recursive, total
        images: list of:
            { path, basename, extension, size_bytes, last_modified }

    Args:
        folder_path: ABSOLUTE path to walk.
        recursive: default True. Set False for shallow scans.
        limit: max images returned. Default 500, max 5000.
    """
    return _http_get(
        "/api/list_images",
        {
            "folder_path": folder_path,
            "recursive": "true" if recursive else "false",
            "limit": limit,
        },
    )


@mcp.tool(annotations={
    "title": "Save an image's caption as a searchable engram",
    "readOnlyHint": False,
    "destructiveHint": False,
    "idempotentHint": True,  # passes deduplicate=0.92 by default
    "openWorldHint": False,
})
def remember_image(
    image_path: str,
    caption: str,
    title: str = "",
    brain: str | None = None,
) -> Any:
    """Persist a caption you've generated for an image. Call this
    AFTER viewing the image in your own context (via Read in Claude
    Code, or paste-into-message in Claude Desktop). The MCP layer
    is the index + writer; the captioning happens in your turn.

    The stored engram becomes searchable like any other note:
    `recall(q)` will surface it when the caption matches the query.
    The image itself stays on disk where it lives — only the
    caption is indexed.

    Storage shape:
      filename: images/<basename>.md
      kind:     'source'
      content:  "![title](image_path)\\n\\n<caption>"
                so the engram renders the image inline in the editor.

    WHEN TO CALL:
    - You've just viewed an image (screenshot, photo, diagram) the
      user dropped in chat or referenced from disk.
    - You're processing a batch from list_images() and have
      generated captions for each.

    WHEN NOT TO CALL:
    - You haven't actually seen the image — captioning blind
      defeats the point. Use Read on the image first.
    - The image is ephemeral (a clipboard paste the user is
      iterating on); wait until they say "save this".

    Args:
        image_path: ABSOLUTE path of the image on disk.
        caption: 1-3 sentences describing what's in the image.
            Focus on details a search query might hit.
        title: optional display title. Default = file basename.
        brain: target brain id (defaults to active).
    """
    import os as _os
    basename = _os.path.basename(image_path)
    display_title = title.strip() or _os.path.splitext(basename)[0]
    # Markdown body: image + caption. The image link uses the
    # absolute path as-is so the editor can resolve it.
    body = f"![{display_title}]({image_path})\n\n{caption}"
    # Step 1: write the engram via the standard remember path. This
    # also runs dedupe — if the same image was captioned before with
    # similar text we'll get status='merged'.
    written = _http_post(
        "/api/notes",
        {
            "content": body,
            "title": display_title,
            "folder": "images",
            "deduplicate": 0.92,
            "brain": brain,
        },
    )
    # Step 2 + 3: stamp kind=source and tag=image. /api/notes doesn't
    # accept those fields directly, so we compose with the bulk
    # endpoints. Best-effort — if these fail the caption is still
    # saved, we just return the partial state.
    eid = written.get("engram_id") if isinstance(written, dict) else None
    if eid:
        _http_post(
            "/api/engrams/bulk_set_kind",
            {"engram_ids": [eid], "kind": "source", "brain": brain},
        )
        _http_post(
            "/api/engrams/bulk_add_tag",
            {"engram_ids": [eid], "tag": "image", "brain": brain},
        )
    # Surface the image_path so the caller has everything it needs
    # for follow-up (e.g., updating their notes index).
    if isinstance(written, dict):
        written["image_path"] = image_path
    return written


@mcp.tool(annotations={
    "title": "Re-embed every engram in the brain (model upgrade path)",
    "readOnlyHint": False,
    "destructiveHint": False,
    "idempotentHint": True,  # same model + same content → identical vectors
    "openWorldHint": False,
})
def reindex_embeddings(
    dry_run: bool = False,
    brain: str | None = None,
) -> Any:
    """Walk every active engram, re-chunk, re-embed under the
    currently-loaded model, and replace the chunks + vec_chunks
    rows. The path users take when:

    - The embedding model has been upgraded (BGE-small → BGE-large,
      etc.) and the existing vectors no longer match.
    - The vec_chunks table got corrupted (manual SQL, schema bug,
      partial restore from backup) and needs to be rebuilt from
      engram content.
    - A chunker tweak shipped that changes how content gets split,
      and you want every engram to use the new chunking.

    Cost: ≈ same as the original ingest of every engram. On the
    BGE-small-en-v1.5 path that's ~5-10 ms per chunk; a 500-engram
    brain with 3 chunks each ≈ 7-15 seconds wall-clock. Pass
    `dry_run=True` first to size the work without doing it.

    Idempotent under a stable model — encoding the same text twice
    produces identical vectors. The work is the encode, not the
    disk IO. Per-engram failures are captured in `failed` and the
    rest of the engrams keep going.

    AFTER calling: run `optimize_disk()` to reclaim space from the
    chunk-table churn.

    Returns:
        brain_id, dry_run
        engrams_total       — active engrams found
        engrams_reembedded  — engrams that produced new chunks
                              (zero in dry_run)
        chunks_written      — total chunk rows touched
        failed              — list of "<engram_id>: <error>" lines
        elapsed_ms

    Args:
        dry_run: count without re-embedding. Default False.
        brain: target brain id (defaults to active).
    """
    return _http_post(
        "/api/reindex_embeddings",
        {"dry_run": dry_run, "brain": brain},
    )


@mcp.tool(annotations={
    "title": "Bulk-import a folder of markdown into the brain",
    "readOnlyHint": False,
    "destructiveHint": False,
    "idempotentHint": True,  # repeat = unchanged via content_hash dedupe
    "openWorldHint": False,
})
def import_folder(
    path: str,
    prefix: str | None = None,
    brain: str | None = None,
) -> Any:
    """Cold-start onboarding. Walk a folder of markdown files
    (Obsidian vault, Notion export, past chat transcripts) and
    bulk-ingest each .md into the brain. Idempotent: re-running
    with the same source after no edits reports zero ingests.

    Filenames are namespaced by the source folder name so that two
    imports with overlapping basenames (two READMEs) don't collide.
    Pass `prefix` to override the namespace, or `prefix=""` to land
    files directly under their relative paths (use this only when
    you've checked filenames don't clash with existing engrams).

    What this is NOT: it does NOT copy or symlink the source files.
    Content lands in engrams.content; the original markdown stays
    where it lives. Re-run the import to refresh after the source
    folder changes.

    Skipped automatically:
    - dotfile dirs (.git, .obsidian, .DS_Store)
    - any "trash" subdirectory
    - non-.md files

    WHEN TO CALL:
    - User installs NeuroVault and asks "can I import my Obsidian
      vault?"
    - User has a folder of past Claude conversations / Notion
      exports they want searchable
    - Periodic re-sync from a curated source folder

    Returns:
        brain_id, source_path, prefix
        scanned        — total .md files found
        ingested       — newly written or content-changed engrams
        unchanged      — files whose content_hash already matched
        errors         — list of "<path>: <error>" lines
        elapsed_ms

    Args:
        path: ABSOLUTE path to the folder to import.
        prefix: namespace override. Default = source folder
            basename. "" = no namespace.
        brain: target brain id (defaults to active).
    """
    return _http_post(
        "/api/import_folder",
        {"path": path, "prefix": prefix, "brain": brain},
    )


@mcp.tool(annotations={
    "title": "List edit history for a single engram",
    "readOnlyHint": True,
    "idempotentHint": True,
    "openWorldHint": False,
})
def engram_history(
    engram_id: str,
    limit: int = 50,
    version: int | None = None,
    brain: str | None = None,
) -> Any:
    """Surface the edit history of an engram. The ingest pipeline
    snapshots the OLD content into engram_versions whenever
    content_hash changes, so this list is sparse — one row per real
    edit, no entries for no-op re-ingests.

    Two modes:
    - `version=None` (default): list snapshots, most-recent first.
      Each row carries title + content_preview (first ~280 chars) +
      content_bytes + content_hash + created_at, plus the engram's
      CURRENT title + hash so you can spot whether it has drifted
      from any of the snapshots.
    - `version=N`: fetch the full content of that specific snapshot.

    Important: version N means "the content as it was N edits ago."
    The CURRENT engram lives in `engrams`, not in this table — so
    `version=1` is the OLDEST snapshot, and the highest version is
    the most-recent one BEFORE the current state.

    WHEN TO CALL:
    - User asks "what did this note say last week?"
    - You need to compare a current claim against an earlier one to
      detect drift / context-loss
    - Auditing: was a recent edit destructive?

    Returns the list shape on default, or the detail shape when
    `version` is set. Both shapes include brain_id + engram_id.

    Args:
        engram_id: UUID of the engram.
        limit: max rows in list mode. Default 50, max 500.
        version: if set, fetch full content of that snapshot
            instead of listing.
        brain: target brain id (defaults to active).
    """
    if version is not None:
        return _http_get(
            f"/api/engrams/{urllib.parse.quote(engram_id)}/versions/{version}",
            {"brain": brain},
        )
    return _http_get(
        f"/api/engrams/{urllib.parse.quote(engram_id)}/versions",
        {"limit": limit, "brain": brain},
    )


@mcp.tool(annotations={
    "title": "Reclaim disk space (VACUUM + WAL truncate, optional dormant purge)",
    "readOnlyHint": False,
    "destructiveHint": True,  # purge_dormant=True is irreversible
    "idempotentHint": True,   # repeating with same args is a no-op once converged
    "openWorldHint": False,
})
def optimize_disk(
    vacuum: bool = True,
    wal_checkpoint: bool = True,
    purge_dormant: bool = False,
    brain: str | None = None,
) -> Any:
    """Reclaim disk space inside the brain. Three composable steps:

    1. vacuum (default ON): rebuild brain.db dropping free pages.
       Most expensive (rewrites the whole file) but biggest reclaim
       on a brain that has churned through deletes.

    2. wal_checkpoint (default ON): flush + truncate the WAL file
       back to zero. Cheap. Runs AFTER vacuum so VACUUM's own WAL
       writes get truncated too.

    3. purge_dormant (default OFF, destructive): hard-delete every
       engram with state='dormant'. Soft-delete already strips
       chunks + vec rows; this just makes the deletion permanent
       and lets VACUUM reclaim the engrams-table pages.

    WHEN TO CALL:
    - User asks "the brain is getting big, can you shrink it?"
    - After a bulk delete (find_clutter → delete_engrams) — the
      free pages from those deletes only become disk space after
      VACUUM runs.
    - As periodic maintenance — once a month if the brain sees
      regular write churn.

    Pass purge_dormant=True ONLY when the user has confirmed they
    don't want soft-deleted engrams recoverable. After purge there
    is no in-DB trail; the markdown trash/ folder is the last copy.

    Returns:
        brain_id
        before / after — { db_bytes, wal_bytes, shm_bytes,
                           total_bytes, free_pages, page_size }
        reclaimed_bytes — total_bytes(before) - total_bytes(after)
        purged_engrams  — rows hard-deleted (0 unless purge_dormant)
        ran             — { purge_dormant, wal_checkpoint, vacuum }

    Args:
        vacuum: rebuild the DB file. Default True.
        wal_checkpoint: truncate WAL after VACUUM. Default True.
        purge_dormant: hard-delete dormant engrams. Default False.
        brain: target brain id (defaults to active).
    """
    return _http_post(
        "/api/optimize_disk",
        {
            "vacuum": vacuum,
            "wal_checkpoint": wal_checkpoint,
            "purge_dormant": purge_dormant,
            "brain": brain,
        },
    )


@mcp.tool(annotations={
    "title": "Set the kind on multiple engrams in one call",
    "readOnlyHint": False,
    "destructiveHint": False,
    "idempotentHint": True,  # repeat with same kind = unchanged
    "openWorldHint": False,
})
def bulk_set_kind(
    engram_ids: list[str],
    kind: str,
    brain: str | None = None,
) -> Any:
    """Reclassify many engrams' `kind` field in one round-trip.
    Single-engram updates would reingest the markdown; this skips
    the embed/chunk pipeline since `kind` doesn't affect them.

    Allowed kinds: note, source, quote, draft, question, decision,
    observation, insight. Other values 400.

    WHEN TO CALL:
    - Bulk-relabelling after an import: "everything I imported from
      Anki should be kind='source'"
    - Demoting a chatter cluster: "mark all of these as 'observation'
      so recall ignores them by default"
    - Cleaning up after `find_clutter` returns a category that's
      better expressed as a kind change than a delete

    Returns:
        brain_id, kind, updated, unchanged, not_found

    Args:
        engram_ids: list of UUIDs to update.
        kind: new value (lowercased, validated).
        brain: target brain id (defaults to active).
    """
    return _http_post(
        "/api/engrams/bulk_set_kind",
        {"engram_ids": engram_ids, "kind": kind, "brain": brain},
    )


@mcp.tool(annotations={
    "title": "Append a tag to multiple engrams in one call",
    "readOnlyHint": False,
    "destructiveHint": False,
    "idempotentHint": True,  # tag already present → unchanged
    "openWorldHint": False,
})
def bulk_add_tag(
    engram_ids: list[str],
    tag: str,
    brain: str | None = None,
) -> Any:
    """Append a tag to many engrams' `tags` JSON array in one
    round-trip. Tag is normalised: lowercased, trimmed, leading '#'
    stripped (`#Foo` and `foo` both store as `foo`). Engrams that
    already carry the tag are reported as `unchanged`.

    WHEN TO CALL:
    - "Tag everything from this conversation as #project-aegis"
    - "Mark these 12 retrieval hits as #reviewed"
    - Curating a corpus: tag a category before calling
      `recall(q, kind:note tag:reviewed)`

    Returns:
        brain_id, tag, updated, unchanged, not_found

    Args:
        engram_ids: list of UUIDs to tag.
        tag: tag text (case + leading-# normalised).
        brain: target brain id (defaults to active).
    """
    return _http_post(
        "/api/engrams/bulk_add_tag",
        {"engram_ids": engram_ids, "tag": tag, "brain": brain},
    )


@mcp.tool(annotations={
    "title": "Add a manual link between two engrams",
    "readOnlyHint": False,
    "destructiveHint": False,
    "idempotentHint": True,  # INSERT OR REPLACE — repeat call upserts
    "openWorldHint": False,
})
def add_link(
    from_engram: str,
    to_engram: str,
    link_type: str = "manual",
    similarity: float = 1.0,
    bidirectional: bool = True,
    brain: str | None = None,
) -> Any:
    """Wire two engrams together with a manual link. The ingest
    pipeline auto-creates links from `[[wikilinks]]` in markdown
    bodies and from shared entities — this tool is for the case
    where you want to assert a relationship after the fact, without
    rewriting the source markdown.

    WHEN TO CALL:
    - User says "this note is related to that one" / "these two
      should be connected"
    - You're auditing the brain (after find_orphan_links()) and
      want to materialise a connection the system inferred
    - Resolving a contradiction by asserting an explicit relationship
      ("A supersedes B") with link_type='supersedes'

    Returns:
        from_engram, to_engram, link_type, similarity,
        bidirectional, rows_written

    Args:
        from_engram, to_engram: engram ids (UUIDs).
        link_type: defaults to "manual" (the wikilink convention).
            Other useful values: "uses", "extends", "depends_on",
            "contradicts", "supersedes". Free-form, not validated.
        similarity: 0.0-1.0, defaults to 1.0 (strong manual link).
        bidirectional: True by default — adds the reverse edge too,
            matching wikilink behaviour. Set False for asymmetric
            relations like "A supersedes B".
        brain: target brain id (defaults to active).
    """
    body: dict[str, Any] = {
        "from_engram": from_engram,
        "to_engram": to_engram,
        "link_type": link_type,
        "similarity": similarity,
        "bidirectional": bidirectional,
    }
    if brain:
        body["brain"] = brain
    return _http_post("/api/links", body)


@mcp.tool(annotations={
    "title": "Remove a link between two engrams",
    "readOnlyHint": False,
    "destructiveHint": True,
    "idempotentHint": True,
    "openWorldHint": False,
})
def remove_link(
    from_engram: str,
    to_engram: str,
    bidirectional: bool = True,
    brain: str | None = None,
) -> Any:
    """Delete a link between two engrams. Symmetric pair to
    add_link. Removes both directions by default.

    Args:
        from_engram, to_engram: engram ids.
        bidirectional: True by default — also removes the reverse
            edge if it exists.
        brain: target brain id (defaults to active).

    Returns:
        rows_deleted: how many edges were actually removed (0, 1, or 2).
    """
    body: dict[str, Any] = {
        "from_engram": from_engram,
        "to_engram": to_engram,
        "bidirectional": bidirectional,
    }
    if brain:
        body["brain"] = brain
    return _http_send("DELETE", "/api/links", body)


@mcp.tool(annotations={
    "title": "Find clutter — surface engrams that look like noise",
    "readOnlyHint": True,
    "idempotentHint": True,
    "openWorldHint": False,
})
def find_clutter(brain: str | None = None, limit: int = 50) -> Any:
    """Surface engrams that look like noise so you can review and
    remove. Read-only — returns categorised candidates, no deletes
    happen here.

    WHEN TO CALL:
    - User asks "clean up my brain" / "find junk" / "remove old stubs"
    - You notice a recall returning low-quality results and want to
      audit what's polluting the corpus

    Returns:
        brain_id              — which brain was scanned
        stubs                 — engrams with very short content + low
                                access count (probably abandoned drafts)
        test_data             — titles matching test/smoke/verify/debug
                                with low access (forgotten test entries)
        forgotten_observations — kind='observation', access_count=0,
                                older than 7 days (auto-extracted but
                                never promoted)
        duplicate_titles      — multiple non-dormant engrams sharing
                                the same title (likely accidental dupes)
        total                 — sum of all four categories

    Each entry has {id, title, reason}. Pass the ids you want removed
    to `delete_engrams()` after confirming with the user.

    Args:
        brain: target brain id (defaults to active).
        limit: per-category cap. Default 50, max 500.
    """
    return _http_get("/api/clutter", {"brain": brain, "limit": limit})


@mcp.tool(annotations={
    "title": "Delete engrams by id",
    "readOnlyHint": False,
    "destructiveHint": True,   # soft-deletes; markdown moves to trash/
    "idempotentHint": False,
    "openWorldHint": False,
})
def delete_engrams(engram_ids: list[str], brain: str | None = None) -> Any:
    """Soft-delete a list of engrams. Markdown files move to the
    brain's `trash/` subdirectory (recoverable); DB rows go dormant.

    WHEN TO CALL:
    - After `find_clutter()` and the user has confirmed which engrams
      to remove
    - When the user explicitly identifies engrams to delete by id
      (e.g. from a recall result)

    Always confirm with the user before calling — this is destructive
    even though it's recoverable.

    Returns:
        brain_id   — which brain was modified
        deleted    — number successfully soft-deleted
        not_found  — engram ids that didn't exist
        failed     — engram ids whose delete raised an error

    Args:
        engram_ids: list of engram ids to soft-delete.
        brain: target brain id (defaults to active).
    """
    body: dict[str, Any] = {"engram_ids": engram_ids}
    if brain:
        body["brain"] = brain
    return _http_post("/api/engrams/delete", body)


@mcp.tool(annotations={
    "title": "Update brain (re-scan vault, refresh index)",
    "readOnlyHint": False,
    # Idempotent in the "calling twice in a row is fine" sense — the
    # second call sees content_hash matches and skips re-ingest.
    "idempotentHint": True,
    # Destructive only in the soft-delete-orphans sense: rows whose
    # markdown file has disappeared from disk get state='dormant'.
    # The markdown files themselves are untouched.
    "destructiveHint": False,
    "openWorldHint": False,
})
def update(brain: str | None = None) -> Any:
    """Re-scan the active brain's vault, re-ingest changed files, and
    soft-delete rows whose file has disappeared on disk. Idempotent and
    cheap when nothing changed — each file is read once and the
    content_hash short-circuit skips DB work.

    WHEN TO CALL:
    - User edited markdown files outside the desktop app (Obsidian,
      vim, Drive sync) and wants the index to catch up immediately
      without restarting the app.
    - User deleted files in the file manager and wants the
      corresponding engrams + connections cleaned up.
    - You want to sanity-check that what's in the index matches what's
      on disk before a recall-heavy task.

    Returns:
        scanned      — total .md files found under the vault
        ingested     — files re-ingested (new or content_hash changed)
        unchanged    — files where content_hash matched (no DB work)
        deleted      — engrams whose file is gone from disk
                       (soft-deleted, markdown files untouched)
        elapsed_ms   — wall-clock runtime
        brain_id     — which brain was updated

    Args:
        brain: target brain id (defaults to active).

    Note: when the desktop app is running, the vault watcher already
    re-ingests files as they are saved. This tool is the manual
    fallback for batch / out-of-band edits.
    """
    body: dict[str, Any] = {}
    if brain:
        body["brain"] = brain
    return _http_post("/api/update", body)


# --- Empty prompts / resources handlers ----------------------------------
#
# Some MCP clients (Claude Code, Inspector, a few experimental
# runners) probe `prompts/list` and `resources/list` during the
# startup handshake. If the server hasn't registered any handlers,
# FastMCP's default response is fine — but some clients treat the
# "method not found" reply as a fatal error and disconnect the
# session, which then reads as "NeuroVault crashed" in the user's
# log output.
#
# Pattern borrowed from `mksglu/context-mode`: register no-op
# handlers that return empty lists. The proxy exposes zero prompts
# and zero resources — everything useful lives in tools — so empty
# is the correct, truthful response. Costs nothing at runtime and
# silences the failure-mode entirely.
#
# FastMCP's decorators handle the protocol wiring for us. If a
# future version auto-registers empty handlers by default, these
# become redundant but stay harmless.


@mcp.resource("neurovault://empty")
def _empty_resource_sentinel() -> str:
    """Sentinel resource so `resources/list` returns a non-empty
    array. Real resources would be memory blocks or brain metadata,
    but those are served as tools to keep the shape consistent with
    the rest of the API. Content is the proxy's own instructions so
    clients that blindly read the first resource still get something
    descriptive rather than an empty string."""
    return (
        "NeuroVault MCP proxy. Resources are not used by this server — "
        "everything is exposed via tools (see `tools/list`). Prefer "
        "`recall(q, mode='preview')` for most lookups."
    )


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
