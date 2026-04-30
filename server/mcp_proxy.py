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
) -> Any:
    """Submit your compiled wiki page for the user to review. Step 2
    of the agent-driven compile flow, after `compile_prepare`.

    Writes the wiki markdown to vault/wiki/<slug>.md, marks the
    engram as kind='wiki', and inserts a row in the compilations
    table with status='pending'. The desktop app's Compile tab
    surfaces it the same way an LLM-driven compile would, so the
    user can diff old vs new and approve / reject.

    Returns:
        compilation_id   — the pending row's id
        wiki_engram_id   — the engram id of the written wiki page
        wiki_filename    — relative path inside the vault
        brain_id         — which brain it landed in
        status           — always "pending" on submit

    Args:
        topic: same topic you passed to `compile_prepare`.
        wiki_markdown: the full wiki body you authored. No code fences,
            no preamble — just the markdown.
        source_engram_ids: list of source engram ids (from the prepare
            pack) you actually used. Persisted for provenance.
        brain: target brain id (defaults to active).
    """
    body: dict[str, Any] = {
        "topic": topic,
        "wiki_markdown": wiki_markdown,
        "source_engram_ids": source_engram_ids or [],
    }
    if brain:
        body["brain"] = brain
    return _http_post("/api/compilations/submit", body)


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
