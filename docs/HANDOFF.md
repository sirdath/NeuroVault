# NeuroVault — Session Handoff

> **Archived engineering snapshot.** This handoff records work and benchmark
> decisions from 2026-07-16. It is not the current task list, distribution
> status, or product architecture contract. The npm packages described below
> were scaffolding and were not published at the 0.6.0 cut; the private
> Desktop and public Core have since been split.

> Historical cut last updated 2026-07-16. Do not execute §7 without first
> checking the current branch, roadmap, and benchmark configuration.

---

## 1. What NeuroVault is
Local-first, markdown-canonical **AI memory** for Claude/other LLMs. "Claude
forgets you after every conversation; NeuroVault doesn't."
- **Desktop app**: Tauri 2.0 (React/TS) with an **in-process Rust backend** (axum HTTP on `127.0.0.1:8765`).
- **Storage**: Markdown is canonical for note/engram content. SQLite +
  **sqlite-vec** holds the rebuildable retrieval index and structured state
  without Markdown mirrors (including core-memory blocks, drafts, and version
  history). A complete brain backup includes both. Engine table = `engrams`.
- **Embeddings**: BGE-small-en-v1.5 (384-d) via **fastembed-rs** (ONNX), **on-device, zero-LLM ingest**. Cross-encoder reranker is a separate model (`BGERerankerBase`).
- **Retrieval**: hybrid (vector KNN + BM25 + entity-graph) → **RRF** → optional rerank → recency/boosts → final score.
- **MCP**: native Rust `neurovault-server --mcp-only` (rmcp), 55 tools, tiers `minimal` (3), `lite` (8, default), `standard` (21), and `full` (55). Thin stdio→loopback-HTTP bridge; loads no model/DB.
- Flagship extras: **graphify** (codebase → on-device knowledge graph: `who_calls`, `blast_radius`, …).

## 2. Conventions / preferences (IMPORTANT)
- **Commits: NO `Co-Authored-By: Claude` trailer.** Small conventional commits (`feat(scope): …`).
- **No Python** in the app/MCP path (it's a product promise). Code import goes through graphify (Rust), never a Python importer.
- **Markdown-note ownership is explicit.** Keep note/engram content portable;
  do not describe the entire DB as disposable while structured-only state
  remains there.
- **Verify before claiming done**: build + tests + a real smoke. The user values honesty over hype; be critical.
- Website must stay **receipt-honest** (don't publish numbers/features we haven't verified).
- Build: `cd src-tauri && cargo build --no-default-features --features model-download …`. Tests: `cargo test --no-default-features --features model-download --lib`.
- macOS local build needs `vec0.dylib` in `src-tauri/resources/` (already there).

## 3. Branches & where things live
- `main`: graphify merged + published 470-q benchmark (hit@5 0.938).
- `feat/source-folders`: the add-ons + abstention + bench infra (ancestor of below).
- **`feat/headless-mcp` (the live working branch)**: everything below, **pushed to origin**. ~14 commits ahead of main. **Open a PR `feat/headless-mcp` → main** to trigger the cross-platform CI (it builds + smokes mac/linux/windows; publish stays tag-gated).

## 4. What we built over the past days (all committed)
**A. Friend's add-ons, adapted to mainline** (from github.com/Stel777/NeuroVault-AddOns-by-Stel):
- **Source Folders** (flagship): per-brain folder mirroring — `source_mirror.rs` engine (incremental by content hash, skips node_modules/.git/dist, dedup, shared `_source_files/` layout, owns deletions), 4 HTTP endpoints, `BrainSourcesPanel.tsx` modal + a per-brain entry button, code-import via graphify. Live-smoke-verified end to end.
- **Static graph mode** (frozen layout, ~0 idle CPU), **sortable brain list**, **fixes** (`:root` theme mirror, `checkpoint_all()` WAL flush on quit).

**B. Abstention scoring** (`nv-bench.rs`): `Abstention@k` retrieval-confidence gate — keeps `_abs` questions, sweeps τ over the top-score distribution, reports balanced-accuracy / F1. 5 unit tests. No market-uniqueness claim was verified.

**C. Headless npm distribution scaffold** (historical work; see §5):
- **`gui` cargo feature gate** (default on): moved all 47 Tauri commands + `run()` into a gated `src-tauri/src/app.rs`; `lib.rs` root is now just `pub mod memory` + the gated app. `--no-default-features --features model-download` links **zero** GUI frameworks (verified via `otool`/`ldd`) while retaining Core's explicit model fetch path. This unblocked headless Linux/Docker (the binary used to statically drag webkit2gtk).
- **rustls TLS**: `fastembed = { default-features=false, features=["ort-download-binaries","hf-hub-rustls-tls"] }` — `native-tls`/`openssl-sys` are GONE; model download is pure-Rust rustls. No libssl on Linux.
- **npm wrapper scaffold** (`dist-npm/`): root `@neurovault/mcp` plus
  platform package work was implemented but not published at the 0.6.0 cut.
  The verified macOS target was Apple Silicon; Intel remained blocked on a
  matching x86_64/universal sqlite-vec extension. Linux x64 and Windows x64
  were build targets, not shipped-package facts.
- **CI** `.github/workflows/npm-release.yml`: builds + per-platform smoke (start server → `/api/version` → create brain → **load vec0**) on PRs into main and on `npm-v*` tags; publishes with `--provenance`. `dist-npm/WINDOWS-TEST.md` is a no-Rust runbook for the user's Windows laptop.
- Also added `GET /api/version` and fixed the reranker model-cache dir (`reranker.rs` now pins `~/.neurovault/.fastembed_cache`).
- **Historical intent**: npm packaging was meant to reduce installation
  friction. Because it was not published, it did not yet unblock users.

## 5. The competitive picture (vs agentmemory et al.)
A heavy Opus council analyzed NeuroVault vs the field. **Candidate strengths**:
zero-LLM on-device ingest, Markdown note ownership, an embedded stack,
**graphify**, and cross-agent access through one MCP bridge. These were product
hypotheses, not verified first/only claims. **Weaknesses (ranked)**: (1)
distribution friction, (2) no published zero-friction install, (3) no
auto-capture, (4) brute-force flat vector scan, (5) temporal/bitemporal gaps,
and (6) a weak regex entity graph.

## 6. The benchmark situation (READ — this drives the next task)
- **Engine-only** config (no rerank, recency ablated, title boosts ablated) = our published & best: **hit@5 0.938**, recall@5 0.861, hit@10 0.981 (470 answerable). agentmemory self-reports ~**0.951**.
- We ran a multi-day **"production-A"** config (`--rerank --keep-recency`, abstention included). Interim (458 q) it **UNDERPERFORMED**: hit@5 **0.806**, and hit@10 **collapsed 0.981 → 0.865**.
- **Diagnosis**: a reranker reordering the top-20 can't push gold out of the top-10 — only a score *multiplier* can. That's **wall-clock recency**: LongMemEval ingests all sessions in a burst, so "recency" is noise that buries correct-but-older gold. (Recency is *correct* for real users; it just tanks this synthetic benchmark — which is exactly why engine-only ablates it.)
- **We STOPPED that run** (not worth riding to confirm a regression). Saved the finding to the NeuroVault brain.
- **Open question the next task answers**: was the regression *entirely* recency, or does the cross-encoder reranker *also* hurt? We've never measured rerank in isolation. The reranker is currently unproven — if it actually helps (with recency off), wiring it well is our most direct shot at passing 0.951.

## 7. Immediate next task — run the rerank-isolation A/B (medium mode)
A new nv-bench mode `--compare-rerank` is **built & committed** (release binary at `src-tauri/target/release/nv-bench`). It ingests each question ONCE, then recalls twice (rerank OFF baseline vs rerank ON) on the same brain and prints both columns + the per-metric delta. Run it in **medium mode** (`taskpolicy -c utility`, the user is CPU-conscious):

```bash
# 1. Ensure the dataset exists (/tmp gets wiped between sessions — re-download if missing):
[ -f /tmp/longmemeval/longmemeval_s_cleaned.json ] || { mkdir -p /tmp/longmemeval && \
  curl -L -o /tmp/longmemeval/longmemeval_s_cleaned.json \
  "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json"; }

# 2. Paired A/B on ~30 answerable questions, MEDIUM mode, in the background (~2-3h):
cd "src-tauri" && taskpolicy -c utility caffeinate -is ./target/release/nv-bench longmemeval \
  --dataset /tmp/longmemeval/longmemeval_s_cleaned.json \
  --compare-rerank --no-abstention --limit 30 --k 1,5,10 \
  --out /tmp/rerank_ab.json
```
Output prints an `A/B: reranker isolated` block: `metric | baseline | +rerank | delta`. **Positive hit@5 delta = the reranker helps** → next step is to wire a proper rank-fusion blend (today the final score is `rerank·0.75 + strength·0.15`, which throws away the strong RRF rank prior — fuse them instead) and re-measure. **Flat/negative** → skip rerank, go to the other levers below.
- Run in the background and report the baseline vs +rerank vs delta when done. The expensive part is ingest (~190–400s/q in medium); 30 q ≈ 2–3h.

## 8. The "beat agentmemory" roadmap (after the A/B tells us about rerank)
Ranked by expected value:
1. **Fix/rank-fuse the reranker** (if §7 shows it helps) — most direct path to >0.951.
2. **Multi-query expansion** — generate 2–3 query variants (LLM-free via existing entity/keyword extraction), RRF-fuse. Proven RAG win.
3. **Typed entity edges** — promote graphify call/import + wikilink-section + heading co-occurrence into typed graph edges (zero-LLM). gbrain shows +31pp P@5 upside.
4. **Chunk-score max-pooling** (ColBERT-style late interaction; we already chunk 3 levels).
- Don't redo the full 470-q eval until a config beats 0.938 on a dev slice.
  Report the exact configuration and dimensions without claiming uniqueness.

## 9. Other open threads
- **Feature idea saved**: user-selectable embedding model (Settings → pick model + reindex). Today hardcoded BGE-small@384 in `embedder.rs:128`/`:34`, `db.rs:44` (`vec0 float[384]`). Swap needs `EMBEDDING_DIM` + vec0 schema change + full re-embed (cheap because markdown-canonical). Use only fastembed-supported ONNX models (no Python).
- **Windows verification**: open the PR (§3) → CI builds the Windows `.exe` → run `dist-npm/WINDOWS-TEST.md` on the user's Windows laptop.
- The eval's partial results are in `docs/benchmarks/chunks_prod/` (production-A, the underperforming config — keep for the record, don't publish).
