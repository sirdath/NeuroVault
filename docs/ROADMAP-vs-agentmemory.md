# Roadmap: improve & out-position agentmemory (low-risk, benchmark-guarded)

_Authored 2026-06-26. Grounded in: (a) a code-verified study of agentmemory's actual eval, (b) our in-flight 470-q rerank-fusion run, (c) a code-grounded + adversarially-stress-tested plan of six improvement levers._

## TL;DR — the honest reframe
agentmemory's headline **95.2% R@5 on LongMemEval-S is real and apples-to-apples** with our retrieval-only **hit@5 0.938** (verified in their `benchmark/longmemeval-bench.ts`: binary hit@5 over gold session ids, no LLM reader/judge, **raw-session ingest with LLM-consolidation OFF**). The honest gap is **~1.4pp on the same task**, and they get there with a **simpler** config (BM25 0.4 + MiniLM-vector 0.6 RRF, **no graph, no reranker**, dense input **truncated to the first 512 chars/session**).

When we code-grounded and adversarially stress-tested six levers to close that gap, the result was sobering: **almost none reliably move the benchmark.** There is **no clean silver bullet for the 1.4pp.** So the strategy is: chase a **statistical tie** with cheap, A/B-guarded probes, take the **real wins in perf + positioning**, and **win on the dimensions where we're structurally ahead**.

## Per-lever findings (EV = effect on LongMemEval hit@5 unless noted)
- **Session-diversification — 0pp (no-op).** Our chunk→engram dedup already enforces one-result-per-session (retriever.rs:883-920), and each LongMemEval session is one engram. A per-session cap cannot change the ranked list. It's a *production* guard (auto-capture can fan one session into many engrams), not a benchmark lever. Needs a synthetic multi-engram-per-session fixture even to test.
- **BM25 Porter stemming — +0 to +1pp (median ~0).** Low-risk, cheap. Synonyms are **proven harmful** for us (synonym table removed 2026-04-23, −3.3pp hit@1) → stemming only.
- **Multi-query expansion — +0 to +1pp (leaning wash).** Must be **entity-anchored, zero-LLM**, never synonym-blind.
- **Typed entity edges — ≈neutral on the benchmark.** Graph leg weight is only 0.20, so re-weighting inside it is second-order. Large effort; the gbrain "+31pp P@5" was a different setup. Worth it only for GUI/graphify richness, not the score.
- **Title-scan scoping — 0pp ranking change, BIG CPU win.** Today every recall re-embeds all live engram titles (retriever.rs ~982-1031, TITLE_CACHE_MAX=4000) = O(notes)/query. Scope the title-boost to the candidate pool. Provably inert on the published number if scoped right.
- **Reranker — 0pp.** 0/500 LongMemEval queries are keyword-shaped, so under default gating the cross-encoder **never fires** on the benchmark (our `--rerank` run forced it on). In production it's dormant on natural-language recall. The fp32 model is **1 GB** (the in-repo comment wrongly says ~110 MB).

## Sequenced plan (start when the eval frees the machine)

### Phase 0 — safe wins, zero benchmark risk
1. **Title-scan scoping** (retriever.rs ~982-1031, behind `--ablate title_pool_scope`). Big CPU win (kills the O(notes)/query storm — the #1 large-vault CPU cause); A/B must prove hit@5 unchanged. _small._
2. **Reranker hygiene** (reranker.rs:30-34 comment fix 110 MB→1 GB; env-gate the load; document neutral). Removes a footgun + CPU/RAM risk. _trivial._

### Phase 1 — cheap benchmark probes (A/B on a 30–60q dev slice; ship only if it wins)
3. **BM25 Porter stemming** (`rust-stemmers`, bm25.rs tokenizer, docs+queries identically, behind `--ablate stemming`). _small._
4. **candidate_pool `*4 → *6`** (retriever.rs:851) — +0–1pp recall@10; watch added per-query CPU. _trivial._

### Phase 2 — medium bets, only if Phase 1 shows life
5. **Multi-query expansion** — entity-anchored, zero-LLM, `--ablate multiquery`. _medium._
6. **Embedder fp32→`BGESmallENV15Q`** — **separate branch**, forced reindex, quality A/B (~1–3% risk). CPU win. _small but isolated._

### Phase 3 — deferred / not for the score
7. **Typed entity edges** (large) — only for GUI/graphify richness; ≈neutral on the benchmark.

## Guardrails ("without ruining much")
- Every change behind an **`--ablate` flag**, individually A/B-able and revertible.
- **A/B on a 30–60q dev slice first; full 470-q chunked run only if the slice wins.**
- **Never regress the published engine-only 0.938** (Phase 0 items are provably inert on it).
- One lever per branch/commit — **no bundling** (esp. the embedder Q-swap).
- Markdown stays canonical; **no Python** in the app/MCP path.

## How we actually become "better than agentmemory"
The benchmark is a near-tie with no silver bullet — don't bet the strategy on winning 1.4pp.
1. **Durability/ownership** — their open issues are our pitch: iii-engine **OOM ~3.7 GB RSS**, **"all data lost on stop/restart"** (just fixed), engine version-pin that breaks on upgrade. Markdown-canonical + on-disk sqlite-vec means that *class* of failure can't happen to us.
2. **Match their credibility moves** — adopt their honest benchmark framing verbatim ("retrieval-only recall, not QA accuracy"); publish the full scorecard (R@5/10/20, NDCG, MRR — we already added **precision@k**) **+ per-question-type breakdown**; ship a **one-command reproducible harness**.
3. **GUI + graphify** — structural product moats they don't have (read-only viewer, coding-agent-only).
