# Hybrid brain + code intelligence — git archaeology & revive plan

_Written 2026-05-21. Context: the idea of a HYBRID brain — keep the
unstructured wiki/vector store for human/user info, ADD a structured
store for the codebase (how files connect, tech stack, changes) so
indirect questions ("why is my backend not working?") can pull real
structural context. Archaeology finding: **this was the original
NeuroVault design.** The Python server built it; the Rust port kept the
DB schema but dropped most of the logic._

## The key finding: schema survived, logic didn't

The Rust `schema.sql` still declares all the structured tables —
`function_calls`, `variables`, `variable_references`, `contradictions`,
`compilations`, `entities`, `temporal_facts`, `episodic_facts`,
`themes`, `query_affinity`, … — but the code that POPULATES and QUERIES
them was not ported. Evidence (Rust `src-tauri/src`):

| Table | Rust INSERTs | Rust reads | State |
|---|---|---|---|
| `function_calls` | 0 | 0 | **dead schema** (code call graph) |
| `variables` / `variable_references` | 0 | 0 | **dead schema** (code vars) |
| `contradictions` | 0 | 1 | effectively dead (nothing writes it) |
| `compilations` | 2 | 4 | **partially alive** (wiki compile survived) |
| `entities` / `entity_mentions` | 2 | — | alive |
| `facts` (imp#4) | 1 | — | alive (this session) |

Symbol search confirms: `call_graph` / `code_ingest` / `compiler` /
`ast_extractors` → **0 Rust files**. They live only in git history.

## What the Python server actually had (reference implementations in git, on HEAD)
- `server/neurovault_server/code_ingest.py` (513 ln) — code-aware ingest:
  language detection, skip rules, extract functions/classes, **imports
  (dependency graph)**, TODO/FIXME/HACK markers, `ingest_repo` (walk a
  whole project), `find_todos`.
- `server/neurovault_server/call_graph.py` (387 ln) — caller→callee edges
  into `function_calls`; `find_callers(name)` / `find_callees(name)`.
  Per-language (Python via indentation, brace-langs via brace depth, or
  tree-sitter AST).
- `server/neurovault_server/ast_extractors.py` (275 ln) — tree-sitter
  accurate parsing (soft-imports `tree_sitter_language_pack`, degrades
  gracefully if absent).
- `server/neurovault_server/compiler.py` (927 ln) — **"LLM-as-compiler"
  write-time consolidation**: gather source engrams on a topic → fetch
  existing wiki + unresolved contradictions → prompt Claude → emit a
  recompiled canonical wiki page + changelog with citations. This is
  Layer 1 / option D done at write time, and it *already used Claude.*

(Recover any with `git show HEAD:server/neurovault_server/<file>.py`.)

## Why this matters for the hybrid idea
1. **It validates the design.** Unstructured wiki + structured code
   graph + LLM consolidation was the intended architecture. The DB is
   already shaped for it.
2. **The work is REVIVE, not greenfield.** Building the structured code
   store = port `code_ingest` + `call_graph` (+ optional tree-sitter)
   into Rust to fill the `function_calls` table that already exists.
3. **The LLM-compiler maps onto option D.** Instead of NeuroVault calling
   Claude (what `compiler.py` did — a cost/privacy commitment), the
   *connected agent* runs the compile/contradiction-resolution via tools
   (`consolidate`/`record_fact`). Same outcome, no API cost, no new
   privacy boundary. `compiler.py` is the reference for the *logic*.

## Honest caveats (do not revive blind)
- **We don't know why it was dropped in the port** — time pressure, or
  did it underperform / cost too much to maintain? Understand that before
  wholesale revival.
- **Sync cost is the hard part.** A live call graph re-parses on every
  code change; that's heavy (ingest is already our heaviest path).
  Decide depth: *lightweight* (files + tech stack + import/dependency
  edges + change log) likely gets ~80% of the value at ~20% of the
  maintenance vs a *full live call graph*.
- **Vestigial schema is cleanup debt now.** `function_calls`,
  `variables`, `variable_references` (0 writes/reads) are dead weight —
  either revive them or drop them from `schema.sql`; leaving them
  unused is confusing.
- **The structured store is only half the value** — the other half is
  the agent (option D) knowing to query it and merge with the
  unstructured store to answer indirect questions.

## Suggested order when we build this
0. (Prereq) the hardened fast-eval, + add a few *dev-question* cases
   ("why is my backend not working", "what depends on auth.py").
1. Lightweight structured code store: port `code_ingest`'s import/symbol
   extraction → populate `function_calls` (+ a small file/dep map). Gate
   on the eval.
2. Agent tools to query it (`callers`, `callees`, `deps`, `stack`) so the
   connected agent can route indirect questions to it.
3. Agent-tended consolidation (option D) reusing `compiler.py`'s logic as
   reference, writing to `compilations` / `contradictions`.
