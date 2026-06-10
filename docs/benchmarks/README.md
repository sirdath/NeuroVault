# NeuroVault benchmarks

Reproducible, fully-local benchmarks. No API keys, no cloud calls, no LLM
judges — every number on this page can be regenerated on your own machine
with one command from a clean checkout.

```bash
# build the harness (release — debug numbers are not comparable)
cd src-tauri && cargo build --release --no-default-features --bin nv-bench
```

---

## 1. Graphify: codebase → knowledge graph (speed)

What it measures: wall time to turn a real repository into NeuroVault's
queryable code graph — tree-sitter parse of every supported source file +
SQLite population (symbols, call edges, file-dependency edges). On-device;
the target repo is only ever read.

```bash
./target/release/nv-bench graphify --repo /path/to/repo
```

Measured 2026-06-10 on an Apple-silicon MacBook (release build, single run):

| Repo | Files | Symbols | Call sites | Graph edges | Parse | Parse + index | Rate |
|---|---|---|---|---|---|---|---|
| NeuroVault (Rust + TS) | 112 | 1,469 | 3,068 | 793 | 0.2 s | **1.1 s** | ~100 files/s |
| agentmemory (TypeScript) | 356 | 1,538 | 8,416 | 4,588 | 0.4 s | **2.1 s** | ~170 files/s |
| gbrain (TypeScript) | 1,887 | 8,348 | 66,199 | 33,180 | 2.5 s | **8.4 s** | ~225 files/s |

Yes — those last two rows are the codebases of the two largest "agent memory"
competitors, graphified in seconds. Index size: 8–86 MB of SQLite for the
repos above (the repo stays the system of record; the index is disposable
and rebuildable).

---

## 2. LongMemEval: long-term memory retrieval

What it measures: given a question and a haystack of ~50 chat sessions
(~115k tokens), does retrieval surface the session(s) that contain the
evidence? This is the public [LongMemEval](https://github.com/xiaowu0162/LongMemEval)
benchmark (ICLR 2025), **cleaned** variant
([xiaowu0162/longmemeval-cleaned](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned)),
the same variant agentmemory's published numbers use.

```bash
# download the dataset (~277 MB, one-time)
curl -L -o /tmp/longmemeval_s_cleaned.json \
  "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json"

# run (full 500 questions; use --limit 50 for a quick pass)
./target/release/nv-bench longmemeval \
  --dataset /tmp/longmemeval_s_cleaned.json --out report.json
```

### Methodology — exactly what runs

- **Per question, a fresh isolated brain.** Each of the question's haystack
  sessions is serialized as a transcript and ingested through NeuroVault's
  **full production pipeline** — hierarchical chunking, local embeddings,
  entity extraction, knowledge-graph links. No benchmark-only shortcut path.
- **Retrieval = the real `recall()`**: hybrid sqlite-vec KNN + BM25 +
  entity-graph, fused with RRF — the identical code path an MCP agent hits.
- **Embeddings: BGE-small-en-v1.5, local ONNX (fastembed).** No network.
- **Scoring is session-level.** Retrieved engrams map back to session ids by
  filename only (ids never appear in embedded content, so retrieval cannot
  cheat on id tokens).
- **Abstention questions excluded** (the 30 `_abs` questions have no
  retrievable answer by design; they test refusal, not search).
- **Recency ablated by default** for byte-reproducibility: the production
  scorer has a wall-clock age-decay term, which makes scores drift
  minute-to-minute. LongMemEval probes content, not freshness. Run
  `--keep-recency` to measure the production default instead.
- **Each session carries a distinct natural title** (its dataset-provided
  date). This matters, and we learned it the hard way: our first harness
  draft titled every session "Chat session", which made every document's
  title-embedding identical — and NeuroVault's MMR diversifier *correctly*
  collapsed them as one redundant cluster, scoring hit@5 = 0.20. A benchmark
  that silently rewards or punishes serialization choices is measuring the
  adapter, not the retriever; we publish ours so you can audit it.
  (`--ablate mmr,...` exposes every scoring feature for exactly this kind of
  diagnosis.)

### Metrics

| Name | Definition |
|---|---|
| `hit@k` | 1 if **any** gold session is in the top-k. This is the metric agentmemory and gbrain both publish as "R@k". |
| `recall@k` | Fraction of **all** gold sessions in the top-k (partial credit on multi-session questions) — stricter, and the standard IR definition. |
| `ndcg@k` | Binary-relevance NDCG. |
| `mrr` | 1 / rank of the first gold session. |

We report both `hit@k` (for comparability) and `recall@k` (because it is the
honest metric). When you see a single headline number from any memory
product, ask which of these it is.

### Results

| Config | hit@5 ("R@5") | recall@5 | ndcg@5 | mrr | questions |
|---|---|---|---|---|---|
| Plumbing check (oracle, gold-only haystacks) | 1.000 | 1.000 | 1.000 | 1.000 | 5 |
| Full run — *in progress* | — | — | — | — | 500 |

*(This table is updated from `nv-bench` output; the JSON report with
per-question receipts is committed alongside.)*

### How the published competitor numbers were produced (for honest comparison)

We read both competitors' benchmark source before building ours. Their
headline numbers are real but configured differently than their marketing
implies — worth knowing before comparing anything:

| | NeuroVault (this harness) | agentmemory "95.2% R@5" | gbrain "97.60% R@5" |
|---|---|---|---|
| Metric | hit@5 + recall@5, both reported | `recall_any@5` (= hit@5) | any-hit @5 (= hit@5) |
| Dataset | LongMemEval-S cleaned, abstention excluded | LongMemEval-S cleaned — abstention exclusion is claimed but **bugged**; the 30 `_abs` questions are in the scored 500 (95.1% on the clean 470) | LongMemEval-S, full 500 |
| Embeddings | **BGE-small, local, free** | MiniLM, local — but only the **first 512 characters** of each ~2.4k-token session are embedded | **OpenAI text-embedding-3-large — cloud, paid, API key required** |
| Ingestion | Full production pipeline (chunking, entities, graph) | Benchmark-only path: 1 session = 1 document, no chunking, library classes called directly (server/hooks/consolidation never exercised) | Production import pipeline (PGLite) |
| Graph signal | On (it's part of hybrid recall) | **Off** (graph weight 0.0) | On |
| Reranker | Available (`--rerank`) | Off (marketing site claims it was on) | Off in benchmark mode |

None of this makes their numbers fake — retrieval over ~50 session-level
candidates is simply a forgiving task, which is why every hybrid system
lands in the 95–98% band. It does mean: (a) single-number comparisons
between products are mostly marketing, and (b) the differentiator is *what
pipeline produced the number* — NeuroVault's runs the same code your agent
uses, fully locally.

---

## 3. Internal regression evals (already in the repo)

- `eval/run_eval.py` — 31-query curated testset against the live HTTP API;
  hit@k / MRR / latency; 17-feature ablation matrix; saved baselines under
  `eval/baselines/`.
- `src-tauri/tests/retrieval_integration.rs` — the fast regression gate:
  23 probes on a fixed 34-engram fixture, recency-ablated, rank-membership
  oracles. Runs in CI.
- `src-tauri/tests/graphify_integration.rs` — boots the real HTTP server,
  graphifies a fixture repo, asserts every `/api/code/*` endpoint and the
  graph payload.

---

*Hardware note: all numbers above were measured on a single Apple-silicon
laptop. Absolute times vary by machine; the methodology doesn't.*
