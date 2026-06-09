# Graphify — codebase → local knowledge graph

> Status: **design / spec** (not yet built). Target: NeuroVault v0.6 headline feature.
> Author: spec drafted 2026-06-09.

## 1. Summary & position

**Graphify** lets a user point NeuroVault at a code repository and turn it into a
navigable neural graph of files, symbols, imports, and calls — embedded and
queryable **100% on-device** — then fuse it with the notes and decisions they've
written *about* that code. The agent (Claude Code / any MCP client) queries the
same graph.

This is the flagship feature behind NeuroVault's position:

> **The local-first, private brain connected to your Claude agent — that can graph your codebase.**
> Zero cloud, zero API keys. Your source never leaves the machine.

Why this wins the lane the competitors leave empty (see the `neurovault` brain →
`recall("positioning")`, `recall("gbrain")`, `recall("agentmemory")`):

- **agentmemory** = headless memory for coding agents (token pitch), cloud-leaning.
- **gbrain** = personal/company brain (people/companies), CLI + Postgres, runs on **your hosted API keys**.
- Neither is a **visual, on-device map of your codebase** fused with your own notes.
  CODE × LOCAL × VISUAL is unowned, and it's exactly where NeuroVault's strengths stack:
  a real graph GUI, fully-local embeddings/rerank, and per-folder brains.

**Privacy is the unlock, specifically for code.** Nobody ships proprietary source
to a hosted embedder. gbrain's default (your OpenAI/ZeroEntropy keys) is a
non-starter for a serious team's codebase. NeuroVault makes zero outbound calls —
tree-sitter parses locally, fastembed embeds locally, the derived graph lives in
the local SQLite brain.

## 2. Why it's feasible now (not a moonshot)

The data model **already exists, dormant**, in [`schema.sql`](../../src-tauri/src/memory/schema.sql):

- `variables` — "remember every named thing in your codebase" (name, scope, kind =
  variable|constant|function|class|type|interface, type_hint, language, description,
  first_seen/last_seen/removed_at).
- `function_calls` — caller→callee call-graph edges (caller_name, callee_name,
  language, engram_id, filepath, line_number).
- `variable_references` — define|use|assign references per symbol (filepath, line, context).
- `variable_renames` — rename-candidate detection (old_name→new_name).

These tables are defined with intent but **never written to** (no tree-sitter, ingest
is markdown-only — [`ingest.rs:157`](../../src-tauri/src/memory/ingest.rs) skips
non-`.md` files; no MCP tools surface them). Graphify is *finishing* this.

Everything downstream already works and is reused as-is:

- Chunking + **local embeddings** (fastembed BGE-small) + the cross-encoder reranker.
- `engram_links` edge table + the React **graph renderer**
  ([`NeuralGraph.tsx`](../../src/components/NeuralGraph.tsx),
  [`graphFromDisk.ts`](../../src/lib/graphFromDisk.ts),
  [`graphStore.ts`](../../src/stores/graphStore.ts)).
- **Per-folder brains** (`.neurovault`) — already scope memory to a project directory.
- The `notify` file watcher — already re-ingests on change.
- `ingest_content` ([`ingest.rs:198`](../../src-tauri/src/memory/ingest.rs)) — the
  reusable note→engram core.
- The data-driven MCP registry ([`mcp/tools.json`](../../src-tauri/src/memory/mcp/tools.json) +
  [`registry.rs`](../../src-tauri/src/memory/mcp/registry.rs)).

**Net-new surface:** (1) a tree-sitter parse layer, (2) a code-ingest path that
populates the dormant tables + emits typed edges, (3) ~5 MCP query tools, (4) graph-view
styling for code nodes/edges, (5) a "Graphify a repo" entry point.

## 3. Canonical-source rule (important design decision)

For **notes**, the vault markdown is canonical and the DB is a rebuildable index.
For **code**, that inverts: the **repo is the system of record**; NeuroVault stores
only the *derived* graph + embeddings (+ an optional snippet cache for display).
We **do not copy source into the vault.** Re-running graphify rebuilds the index
from the repo. This keeps the "it's just an index, you own your data" ethos, avoids
duplicating the user's code, and means a `.gitignore`'d brain DB is the only artifact.

## 4. Scope

### Phase 1 — Map (the demo)
- Walk a repo (respect `.gitignore`, skip vendored/`node_modules`/build dirs, size caps).
- tree-sitter parse per file → **file nodes** + **symbol extraction** (functions,
  classes, types, top-level consts) + **import edges** (file→file).
- Each source file becomes an engram with `kind='code'` (so it flows through the
  existing chunk→embed→graph→recall pipeline), code-aware chunking (one chunk per
  top-level symbol + a file-header chunk).
- Populate `variables` + `variable_references`; write import edges into `engram_links`
  with `link_type='import'`.
- Render code nodes + import edges in the graph. MCP: `where_defined`, `whats_in_file`,
  `recall_code`.
- **Outcome:** point at a repo → watch it become a navigable graph → ask the agent
  "where is `FooService` defined / what's in `auth.rs`."

### Phase 2 — Connect
- Call graph: populate `function_calls` (caller→callee); render as `link_type='call'`.
- Rename detection via `variable_renames`.
- MCP: `who_calls`, `callees_of`, `blast_radius` (transitive callers), `find_symbol`.
- Incremental re-parse on file change (file watcher) + soft-delete (`removed_at`) on
  file/symbol removal.
- **Outcome:** "what calls `charge()` / what breaks if I change it."

### Phase 3 — Fuse (the thing nobody else can do)
- Link code symbols ↔ notes/decisions: an engram can `[[fn:charge]]` / `[[file:billing/charge.rs]]`
  wikilink a symbol; entity-mention-style auto-links when a note names a symbol.
- Traversal: "why is this written this way?" walks from the function node to the ADR/note
  where the decision was made.
- **Outcome:** code graph + decision graph in one local brain.

### Non-goals (v0.6)
- Not a full LSP / type-resolver / compiler. Heuristic name-based symbol + call
  resolution (good enough for retrieval + graph; matches gbrain's "no full AST diff" stance).
- No cross-repo/monorepo-wide single graph initially (one repo → one brain).
- No cloud, no hosted models, no multi-user — those stay out (they break the moat).

## 5. Architecture & data flow

```
repo/ ──walk(.gitignore, caps)──▶ per-file:
   tree-sitter(lang) ─▶ { symbols, imports, calls, refs }
        │
        ├─▶ file engram (kind='code', path=rel)  ─▶ chunk-by-symbol ─▶ fastembed ─▶ sqlite-vec
        ├─▶ variables / variable_references        (structured symbol layer)
        ├─▶ function_calls                         (call edges)
        └─▶ engram_links(link_type='import'|'call')(graph edges)
                          │
   NeuralGraph.tsx ◀──────┘   MCP tools ◀── handlers read variables/function_calls
```

All steps run in-process in the Rust backend (axum :8765). Nothing leaves the host.

## 6. Languages (Phase 1 set)

tree-sitter grammars (mature Rust crates) for the highest-value set first:
**TypeScript/TSX, JavaScript, Python, Rust, Go, Java.** Add C/C++, C#, Ruby, PHP
behind the same trait. One `LanguageParser` trait → per-grammar impl returning a
normalized `{ symbols, imports, calls, refs }`.

## 7. MCP tools (add to `mcp/tools.json`)

| Tool | Tier | Returns |
|---|---|---|
| `recall_code(query)` | lite/standard | semantic search scoped to `kind='code'` engrams |
| `where_defined(symbol)` | standard | file + line for a symbol (from `variables`) |
| `whats_in_file(path)` | standard | symbols declared in a file |
| `who_calls(symbol)` | standard | callers (from `function_calls`) |
| `callees_of(symbol)` | standard | callees |
| `blast_radius(symbol)` | full | transitive callers (impact of a change) |
| `find_rename(name)` | full | rename candidates |

Every tool keeps the existing optional `brain` param to target the repo's brain.

## 8. Graph view (UI)

- Code file nodes: distinct shape/color, sized by symbol count or PageRank; language
  badge. Style in [`NeuralGraph.tsx`](../../src/components/NeuralGraph.tsx) +
  [`GraphLegend.tsx`](../../src/components/GraphLegend.tsx).
- Edge types: add `import` (file→file) and `call` (symbol→symbol) to the existing
  manual/entity/semantic palette in `graphFromDisk.ts`.
- A **"Code" layer toggle** + language/kind filters in
  [`GraphFilterPanel.tsx`](../../src/components/GraphFilterPanel.tsx) (mirror the
  existing semantic-edges toggle). A **"Fuse" toggle** shows note↔code links (Phase 3).

## 9. Entry points / UX

- In-app: **"Graphify a repo…"** action (folder picker) → progress → graph populates.
- Per-folder brain: a repo with `.neurovault` auto-graphifies on open / on watch.
- MCP/CLI: `graphify <path>` (parallels [`import_folder`](../../src-tauri/src/memory/handlers/mod.rs)
  at mod.rs:2203) so an agent can graphify a checkout headlessly.

## 10. Performance & scale

- One repo → one brain (per-folder `.neurovault`). Keeps the index bounded.
- Parse + embed budget: batch fastembed, embed the symbol/header chunks (not every
  line). Cap files (e.g. skip > N KB, skip minified/generated), respect ignore files.
- Incremental: file watcher re-parses only changed files; symbol diff updates
  `variables.last_seen` / `removed_at` without a full rebuild.
- Estimate: a ~5k-file repo ≈ tens of MB of embeddings in sqlite-vec — same order as
  the existing dissertation brain (28 MB / 8k chunks); acceptable. Add a sentence-vs-
  symbol embedding granularity switch if needed.

## 11. Eval / benchmark tie-in

Build a small **NamedThingBench-style** retrieval eval for code (title-substring,
alias/synonym, "find the function this query names", multi-chunk dilution) so
graphify retrieval quality is measured + regression-gated — and so we have a real,
reproducible number to publish (closes the gap vs agentmemory/gbrain, who both lead
with benchmarks). Ties into the separate LongMemEval harness task.

## 12. Effort & risks

- **Effort:** Phase 1–2 ≈ a few focused weeks (schema + renderer + embedder + rerank +
  per-folder brains already exist; the work is tree-sitter ingest + UI wiring + ~5 tools).
- **Risks / open questions:**
  - Symbol/call resolution is name-heuristic, not type-accurate → false edges on
    overloaded names. Mitigate: scope by file/module + language; mark `evidence`.
  - Index-in-place vs snippet-cache for display (recommend: store line ranges + read
    on demand from the repo; small optional snippet cache for offline graph view).
  - Graph node explosion on huge repos → default to file-level nodes, expand symbols
    on drill-down.
  - Keeping derived graph in sync with rapid edits → debounce the watcher.

## 13. What this cements

A demo no headless/cloud competitor can match: **"point NeuroVault at your repo →
it becomes a living graph → your Claude agent answers questions about it → nothing
left your laptop."** That is the Product Hunt launch.
