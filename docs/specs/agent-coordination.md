# Spec: Multi-agent coordination primitives

_2026-06-27. Status: approved (passes the won't-ruin-the-product gate). Scope: handoff/inbox + agent-scoped session_start._

## Problem
NeuroVault stores memory well, but multiple agents sharing one brain can't coordinate: `session_start` returns the same brain-wide blob to every agent (no per-agent view), and there's no first-class way for one agent to hand directed work to another. Add two **thin, zero-LLM** primitives so agents can read their own context and pass work through the brain.

**Done when:** (a) `session_start(agent=X)` returns X's *own* recent engrams + X's inbox; (b) `handoff(to_agent, type, payload)` enqueues a directed message and `agent_inbox(agent)` returns the open ones for that agent; (c) everything backward-compatible and exposed as MCP tools.

## Constraints (rails)
- **Zero-LLM** on the read/write path (pure SQL + JSONL).
- **JSONL/markdown canonical**: handoffs persist in the existing append-only `todos.jsonl`; DB stays rebuildable.
- **Local-first, single-file**: no new service, no scheduler, no daemon.
- **Backward-compatible**: new `Todo` fields are serde-optional; old `todos.jsonl` lines parse unchanged; `session_start` without `agent` is byte-identical.
- **Identity**: NeuroVault is the shared *brain*, not a *runtime*.

## Non-goals (this pass)
- NOT an orchestrator/scheduler/cron, "triggered-runs", or a director agent (the guide's Growth OS). NeuroVault never *runs* or *schedules* an agent.
- NOT LLM distill/classify/verify/judge anywhere.
- NOT the confidence column, conflicting-state, bitemporal write, or kind-decay (separate specs).
- NOT push/subscription — inbox is **pull-only** (agents poll via `session_start`/`agent_inbox`).
- NOT auto-routing or auto-acting on handoffs — a handoff is an **inert directed note** until an agent reads and acts.
- NOT touching existing todo HTTP endpoints or the drop-folder `list_inbox`.

## Decisions (alternative → why)
1. **Reuse `todos.jsonl`** for handoffs. _Rej: new `handoffs` table_ — todos.rs already has append-only, `agent_match` routing, claim/complete, concurrent-safe writes; a handoff *is* a directed todo. One queue, less surface.
2. **3 optional fields on `Todo`** (`kind`, `payload`, `source_engram`), not a parallel struct. _Rej: separate Handoff struct_ — forks the queue; serde-optional fields keep one log.
3. **Pull-based inbox**. _Rej: websocket/notify push_ — breaks single-file/local-first; agents already call `session_start`.
4. **Agent scoping via optional `agent` param** on `session_start`. _Rej: new `agent_session_start` tool_ — overloads surface; one param is back-compat.
5. **Tool names `handoff` + `agent_inbox`** (NOT `inbox`). _Rej: `inbox`_ — collides with the existing drop-folder `list_inbox`.

## Interfaces (exact)
`Todo` (src-tauri/src/memory/todos.rs) — add, all `#[serde(default, skip_serializing_if = "Option::is_none")]`:
```rust
pub kind: Option<String>,                // handoff type, e.g. "feature-request" | freeform
pub payload: Option<serde_json::Value>,  // structured handoff data
pub source_engram: Option<String>,       // engram id that motivated it
```

MCP `handoff` → `POST /api/handoff`:
```
in : { to_agent: string, type: string, payload?: object, source_engram?: string,
       note?: string, from_agent?: string, priority?: "low"|"normal"|"high", brain?: string }
do : add_todo(agent_match=to_agent, kind=type, payload, source_engram,
              created_by=from_agent, text="handoff:{type}", priority, note)
out: { id, status:"open", to_agent, type, created_at }
```

MCP `agent_inbox` → `GET /api/agent_inbox`:
```
in : { agent: string, brain?: string }
do : list_todos(status="open"), keep where kind IS NOT NULL AND
     (agent_match=="" OR regex(agent_match) matches agent)
out: [{ id, type, from_agent, payload, source_engram, note, priority, created_at }]
```
Claiming/completing a handoff reuses the existing `claim_todo`/`complete_todo` endpoints.

`session_start` (handlers/mod.rs) — add optional `agent` query param:
```
GET /api/session_start?brain=&agent=X
agent present → top_memories = SELECT ... WHERE agent_id=X AND state!='dormant'
                               ORDER BY updated_at DESC LIMIT 5
                open_todos   = X's inbox (agent_match=="" OR matches X)
                + inbox_count
agent absent  → unchanged (brain-wide; back-compat)
```

## Test plan (pass/fail)
- **Unit (todos):** Todo with kind/payload/source_engram round-trips JSONL; an OLD line (no new fields) still parses via serde defaults.
- **Unit (inbox filter):** handoff to "claude-code" appears in `agent_inbox("claude-code")`, NOT in `agent_inbox("other")`; empty `agent_match` appears for both; a plain (kind=null) todo never appears in an inbox.
- **Integration (HTTP):** POST /api/handoff → GET /api/agent_inbox?agent= returns it; another agent claims it → it leaves the first's open inbox.
- **Integration (session_start):** `agent=X` → top_memories only X's engrams; no `agent` → JSON shape byte-identical to today.
- **Manual smoke:** two agent_ids; A handoffs to B; B sees it in `session_start` inbox, claims it, it clears.

## Won't-ruin-the-product gate
| Check | Pass? |
|---|---|
| Zero-LLM | ✅ pure SQL/JSONL |
| JSONL/markdown canonical, DB rebuildable | ✅ handoffs in todos.jsonl |
| Local-first, single-file, no daemon/scheduler | ✅ pull-only |
| Substrate not orchestrator | ✅ handoff is inert; NeuroVault never runs/schedules an agent (fenced by non-goals) |
| Backward-compatible | ✅ optional fields + optional param; existing tools untouched |
| Reversible | ✅ tier-gate the tools off; fields additive |
| Scope contained | ✅ 3 fields + 2 handlers + 2 tool entries + 1 param; no retrieval change |

**Verdict: PASS.** The one real risk is identity drift toward orchestration; it's fenced by the non-goals (no scheduler, pull-only, inert handoffs).
