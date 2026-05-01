"""Write a batch of structured session memories into the active brain.

Run once after a significant session of work to capture what was built,
why, and where. The agent_id is 'claude-code' so the files land under
agent/ and can be filtered by agent_id later.
"""

from __future__ import annotations

import json
import sys
import urllib.request
from datetime import datetime, timezone


API = "http://127.0.0.1:8765"

MEMORIES: list[dict] = [
    {
        "title": "External-folder vaults (Obsidian-style, delete preserves folder)",
        "content": (
            "NeuroVault supports external-folder vaults. Create a brain with "
            "`vault_path: <absolute path>` and the folder IS the vault — no copy. "
            "DB + scratch live at `~/.neurovault/brains/{id}/`, vault points externally. "
            "Delete-brain removes internal scratch + registry entry; the user's folder "
            "is never touched. Implemented in `brain.py:BrainContext.external_vault_path`, "
            "`api.py:CreateBrainRequest.vault_path`, `lib.rs:vault_dir()` which reads "
            "`brains.json[].vault_path`. Missing/moved external paths fall back to "
            "internal with a warning. Commit 48a135d."
        ),
    },
    {
        "title": "Folders as first-class storage",
        "content": (
            "Note filenames are relative paths (e.g. `agent/foo.md`). MCP `remember()` "
            "with `agent_id != 'user'` auto-routes into `agent/`. `ingest_file(vault_root=...)` "
            "stores the relative path as filename; `ingest_vault` uses rglob. Rust `list_notes` "
            "walks subdirs; `save_note` creates parent dirs; `delete_note` flattens paths into "
            "trash with collision-avoidance. Sidebar folder tree groups by first path segment "
            "with collapse/expand persisted in localStorage. Commit 48a135d."
        ),
    },
    {
        "title": "Async write path — 107ms remember() latency",
        "content": (
            "`remember()` and POST /api/notes are two-phase. Fast phase (sync, ~100ms): "
            "file write + engram row + chunks + embeddings — after this the note IS "
            "recallable via semantic search. Slow phase (single-worker thread pool): "
            "BM25 rebuild, semantic links O(n), entities, wikilinks, temporal facts, "
            "karpathy index, git commit. Opt-in via `async_slow_phase=True` at the MCP "
            "remember + HTTP POST /api/notes boundaries. Default sync elsewhere because "
            "SQLite connections aren't thread-safe. Measured p50: 2-5s → 107ms (24-46x). "
            "Commit 3bfb67c."
        ),
    },
    {
        "title": "Core MCP tool surface v2 (2026-04-18)",
        "content": (
            "Default tier (NEUROVAULT_MCP_TIER=core) ships these MCP tools: "
            "session_start, remember, remember_batch, check_duplicate, recall, "
            "recall_chunks, recall_and_read, add_todo, claim_todo, complete_todo, "
            "list_brains, switch_brain, create_brain, tool_menu. Power tier adds forget, "
            "list_memories, compile_page, timeline, working_memory, pin_memory, etc. "
            "Code tier adds ingest_code, find_callers, get_impact_radius. "
            "`tool_menu()` returns a short index of other tiers without loading their "
            "schemas. Tight docstrings (3-5 lines) save ~3k tokens at session start "
            "vs the earlier verbose versions."
        ),
    },
    {
        "title": "session_start() — one-call session wake-up",
        "content": (
            "`session_start(agent_id?, since?)` collapses 5-6 startup round trips into "
            "one MCP tool call. Returns: {brain:{id,name,vault_path,is_external}, "
            "stats:{memories,entities,connections}, l0:'...identity facts ~100tok', "
            "top_memories:[top 5 by strength], open_todos:[filtered to this agent], "
            "changes:[engrams since arg]|null}. HTTP: GET /api/session_start. Use at "
            "the start of every conversation. Commit 71a3cd9."
        ),
    },
    {
        "title": "Semantic dedup: check_duplicate + remember() hint",
        "content": (
            "`check_duplicate(content, threshold=0.85, limit=5)` — pure read-only "
            "similarity check, no LLM call, uses sqlite-vec KNN on the content's "
            "embedding. Returns [{engram_id, title, similarity, preview}] sorted "
            "best-first. `remember()` response now includes "
            "`likely_duplicate: {engram_id, title, similarity}` when ≥0.92 similar "
            "to an existing engram (advisory, non-blocking). Threshold guide: 0.70 "
            "loose / 0.85 paraphrase / 0.92 duplicate / 0.95 identical. HTTP: POST "
            "/api/check_duplicate. Commit d007d99."
        ),
    },
    {
        "title": "Chunk-level recall — passage retrieval",
        "content": (
            "`recall_chunks(query, top_k=10, granularity='paragraph')` returns "
            "matching passages instead of whole engrams. Typical 10-chunk reply: 2-4k "
            "tokens vs 10-40k for whole-engram recall on long wiki pages. Dedups to "
            "one chunk per engram (prevents single long note dominating). "
            "Granularities: document/paragraph/sentence. Simpler pipeline than "
            "hybrid_retrieve — no graph signal (graph is engram-level), no expansion, "
            "no reranker. `chunk_retrieve()` in retriever.py. HTTP: "
            "GET /api/recall/chunks?q=&top_k=&granularity=. Commit e9a6ac7."
        ),
    },
    {
        "title": "Multi-agent todos (Octogent-inspired)",
        "content": (
            "Per-brain append-only jsonl at `<brain_dir>/todos.jsonl`. Five primitives "
            "in neurovault_server/todos.py: add_todo, claim_todo, complete_todo, "
            "list_todos, get_todo. Status machine: open → claimed → done. Claim picks "
            "oldest open matching agent_id or to_agent='any'. Complete is idempotent. "
            "Later jsonl rows with the same id overlay earlier ones — folded-view read. "
            "MCP tools (add/claim/complete in core tier, list in power) + HTTP "
            "endpoints /api/todos. 12 tests in tests/test_todos.py. Commit 1dfcf1d."
        ),
    },
    {
        "title": "Reranker toggle on recall()",
        "content": (
            "`recall(rerank=True)` runs a cross-encoder (MiniLM-L-6-v2) second pass on "
            "top 20 RRF candidates. ~50ms extra. Graceful fallback: bundled sidecar "
            "excludes sentence-transformers to save ~80MB; rerank=True silently "
            "degrades to plain RRF there. Dev server (uv run) has the dep and rerank "
            "actually runs. Log tag shows 'on' | 'requested-but-unavailable' | 'off'. "
            "Cross-encoder scores are log-odds (can be negative); relative ordering is "
            "what matters. HTTP: /api/recall?rerank=true. Commit 71a3cd9."
        ),
    },
    {
        "title": "Agent-driven compile (no API key)",
        "content": (
            "Two new endpoints decouple compilation from server-side LLM calls. "
            "POST /api/compilations/prepare returns {topic, existing_wiki, sources, "
            "contradictions, schema} — no LLM call. POST /api/compilations/submit "
            "accepts {topic, wiki_markdown, source_engram_ids?} and persists a "
            "compilations row with status=pending, model='agent-driven'. "
            "CompilationReview UI has a collapsible 'Compile with an agent' panel: "
            "topic → Prepare → Copy pack → paste into Claude Code → paste wiki "
            "back → Submit. Shows up in review queue identical to LLM-driven. "
            "Commit 48a135d."
        ),
    },
    {
        "title": "Tauri UI state after this session",
        "content": (
            "Desktop app features as of 2026-04-18: folder tree sidebar with "
            "collapse/expand; external-folder vault badge + path display; pencil "
            "rename + trash UI on hover for both notes and brains; command palette "
            "with per-brain switch entries + Open Settings + MCP setup + Hide "
            "Window; ingest progress banner during brain switch; graph auto-refresh "
            "on note changes; MCP Setup section in Settings (auto-detects sidecar "
            "path + Claude config location, one-click copy); export brain as zip "
            "with external-vault support; editor word count + reading time footer; "
            "drag-note-onto-folder to move; 7 themes with full CSS-var compliance "
            "(Midnight/Claude/OpenAI/GitHub Dark/Rosé Pine/Nord/Obsidian); Reduce "
            "Motion actually applies (WCAG 2.3.3); tab persistence + Ctrl+1/2/3."
        ),
    },
    {
        "title": "HTTP API additions 2026-04-18",
        "content": (
            "New HTTP endpoints added this session: GET /api/brains/:id/stats, "
            "GET /api/brains/:id/ingest_status, PATCH /api/brains/:id (rename), "
            "PATCH /api/notes/:id (rename+move), POST /api/compilations/prepare, "
            "POST /api/compilations/submit, POST /api/todos + /claim + /complete, "
            "GET /api/todos, GET /api/changes?since=<iso>, GET /api/session_start, "
            "POST /api/check_duplicate, GET /api/recall/chunks. New Tauri commands: "
            "export_brain_as_zip, mcp_sidecar_path, mcp_config_path, "
            "reveal_in_file_manager, brain_storage_stats, hide_to_background."
        ),
    },
    {
        "title": "LLM-memory research references (2026)",
        "content": (
            "Key sources informing NeuroVault's agent-efficiency design: "
            "Anthropic code-execution-with-MCP (Nov 2025, 98.7% token reduction on "
            "chained ops via JS sandbox), advanced-tool-use (Tool Search + "
            "defer_loading, 85% context preservation), prompt caching (90% cost + "
            "2x latency cut, up to 4 breakpoints, 5-min TTL). Competitors: Mem0 "
            "(reranker + conflict detector, LOCOMO 91.6, LongMemEval 93.4), "
            "Zep/Graphiti (temporal KG with validity windows, P95 300ms, DMR 94.8% "
            "beats MemGPT), Letta/MemGPT (three-tier core/archival/recall, agent "
            "self-manages memory via tool calls). NeuroVault already matches: "
            "temporal_facts table (Graphiti pattern), hybrid retrieval (Zep), "
            "L0/L1/L2 session_context (MemGPT). Gaps closed this session: async "
            "writes, batch writes, chunk-level recall, session_start mega-tool, "
            "semantic dedup, multi-agent todos. Open: code-execution adapter, "
            "prompt-caching breakpoints on stable resources."
        ),
    },
    {
        "title": "Octogent coordination pattern",
        "content": (
            "Octogent (github.com/hesamsheikh/octogent) orchestrates multiple Claude "
            "Code terminals. Core insight worth stealing: **coordination lives in "
            "durable files, not chat history**. Each agent has scoped "
            "`.octogent/tentacles/<id>/` with CONTEXT.md + todo.md. Handoff = writing "
            "markdown into a known layout. NeuroVault applies this via per-brain "
            "todos.jsonl + agent_id scoping on engrams + external-folder vaults. When "
            "multi-agent workflows are needed, the todos + file-first vault are the "
            "substrate."
        ),
    },
    {
        "title": "NeuroVault project status 2026-04-18",
        "content": (
            "Local-first AI memory system with Tauri desktop app + Python MCP server. "
            "Meta-brain `NeuroVaultBrain1` (208+ memories) documents the project "
            "itself. Repo: sirdath/NeuroVault on GitHub. Desktop exe at "
            "C:\\Users\\Dath\\AppData\\Local\\NeuroVault\\neurovault.exe (~15MB). "
            "Installer NeuroVault_0.1.0_x64-setup.exe (~76MB). Tests: 249 passing "
            "(237 existing + 12 new todos tests). Session commits (newest first): "
            "d007d99 dedup, 71a3cd9 rerank+session_start, e9a6ac7 chunks, 1dfcf1d "
            "todos+changes, 927f34e auto-title+batch+tight-docs, 3bfb67c "
            "async+slim+tool_menu. Earlier session: a9858f8 export+wc+dnd, "
            "917954c palette+README, 5b30487 welcome+shortcuts, 61f5804 "
            "fulltext-search+rename, 198ce52 ingest-progress+graph-refresh+MCP-UI, "
            "6857993 brain-rename+reduce-motion+tabs+themes, 48a135d "
            "external-vaults+folders+agent-compile."
        ),
    },
]


def post_note(mem: dict) -> dict:
    body = json.dumps({
        "content": mem["content"],
        "title": mem["title"],
        "agent_id": "claude-code",
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{API}/api/notes",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def main() -> int:
    total = len(MEMORIES)
    ok = 0
    print(f"Writing {total} session memories to the active brain...\n")
    for i, mem in enumerate(MEMORIES, 1):
        try:
            resp = post_note(mem)
            if resp.get("engram_id"):
                ok += 1
                print(f"[{i}/{total}] {resp.get('status','?'):8} {mem['title'][:70]}")
            else:
                print(f"[{i}/{total}] ERROR    {resp}")
        except Exception as e:
            print(f"[{i}/{total}] ERROR    {e}")
    print(f"\nDone: {ok}/{total} memories written at {datetime.now(timezone.utc).isoformat()}")
    return 0 if ok == total else 1


if __name__ == "__main__":
    sys.exit(main())
