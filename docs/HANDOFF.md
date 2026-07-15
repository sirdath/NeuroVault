# NeuroVault — Session Handoff (2026-06-23)

Context transfer for a fresh Claude session. Read this top-to-bottom, then
do **§7 Immediate next task**.

---

## 1. What NeuroVault is
Local-first, markdown-canonical **AI memory** for Claude/other LLMs. "Claude
forgets you after every conversation; NeuroVault doesn't."
- **Desktop app**: Tauri 2.0 (React/TS) with an **in-process Rust backend** (axum HTTP on `127.0.0.1:8765`).
- **Storage**: markdown vault is canonical (`~/.neurovault/brains/<id>/vault/*.md`); SQLite + **sqlite-vec** (`vec0`, `embedding float[384]`) is a **rebuildable** index. Engine table for a memory = `engrams`.
- **Embeddings**: BGE-small-en-v1.5 (384-d) via **fastembed-rs** (ONNX), **on-device, zero-LLM ingest**. Cross-encoder reranker is a separate model (`BGERerankerBase`).
- **Retrieval**: hybrid (vector KNN + BM25 + entity-graph) → **RRF** → optional rerank → recency/boosts → final score.
- **MCP**: native Rust `neurovault-server --mcp-only` (rmcp), 55 tools, tiers `minimal` (3), `lite` (8, default), `standard` (21), and `full` (55). Thin stdio→loopback-HTTP bridge; loads no model/DB.
- Flagship extras: **graphify** (codebase → on-device knowledge graph: `who_calls`, `blast_radius`, …).

## 2. Conventions / preferences (IMPORTANT)
- **Commits: NO `Co-Authored-By: Claude` trailer.** Small conventional commits (`feat(scope): …`).
- **No Python** in the app/MCP path (it's a product promise). Code import goes through graphify (Rust), never a Python importer.
- **Markdown canonical; DB rebuildable.** Don't add features that make the DB authoritative.
- **Verify before claiming done**: build + tests + a real smoke. The user values honesty over hype; be critical.
- Website must stay **receipt-honest** (don't publish numbers/features we haven't verified).
- Build: `cd src-tauri && cargo build --no-default-features …`. Tests: `cargo test --no-default-features --lib`.
- macOS local build needs `vec0.dylib` in `src-tauri/resources/` (already there).

## 3. Branches & where things live
- `main`: graphify merged + published 470-q benchmark (hit@5 0.938).
- `feat/source-folders`: the add-ons + abstention + bench infra (ancestor of below).
- **`feat/headless-mcp` (the live working branch)**: everything below, **pushed to origin**. ~14 commits ahead of main. **Open a PR `feat/headless-mcp` → main** to trigger the cross-platform CI (it builds + smokes mac/linux/windows; publish stays tag-gated).

## 4. What we built over the past days (all committed)
**A. Friend's add-ons, adapted to mainline** (from github.com/Stel777/NeuroVault-AddOns-by-Stel):
- **Source Folders** (flagship): per-brain folder mirroring — `source_mirror.rs` engine (incremental by content hash, skips node_modules/.git/dist, dedup, shared `_source_files/` layout, owns deletions), 4 HTTP endpoints, `BrainSourcesPanel.tsx` modal + a per-brain entry button, code-import via graphify. Live-smoke-verified end to end.
- **Static graph mode** (frozen layout, ~0 idle CPU), **sortable brain list**, **fixes** (`:root` theme mirror, `checkpoint_all()` WAL flush on quit).

**B. Abstention scoring** (`nv-bench.rs`): `Abstention@k` retrieval-confidence gate — keeps `_abs` questions, sweeps τ over the top-score distribution, reports balanced-accuracy / F1. 5 unit tests. We're the only system measuring retrieval-level abstention.

**C. Headless distribution — `npx @neurovault/mcp`** (the big one; council-driven, see §5):
- **`gui` cargo feature gate** (default on): moved all 47 Tauri commands + `run()` into a gated `src-tauri/src/app.rs`; `lib.rs` root is now just `pub mod memory` + the gated app. `--no-default-features` build links **zero** GUI frameworks (verified via `otool`/`ldd`). This unblocked headless Linux/Docker (the binary used to statically drag webkit2gtk).
- **rustls TLS**: `fastembed = { default-features=false, features=["ort-download-binaries","hf-hub-rustls-tls"] }` — `native-tls`/`openssl-sys` are GONE; model download is pure-Rust rustls. No libssl on Linux.
- **npm wrapper** (`dist-npm/`): root `@neurovault/mcp` (bin shim resolves the platform binary via optionalDependencies, defaults empty argv → `--mcp-only`, keeps stdout a clean JSON-RPC channel) + per-platform subpackages (macOS arm64/x64, Linux x64 glibc, Windows x64; musl guarded out). Binaries built by `scripts/build-headless.mjs`, never committed.
- **CI** `.github/workflows/npm-release.yml`: builds + per-platform smoke (start server → `/api/version` → create brain → **load vec0**) on PRs into main and on `npm-v*` tags; publishes with `--provenance`. `dist-npm/WINDOWS-TEST.md` is a no-Rust runbook for the user's Windows laptop.
- Also added `GET /api/version` and fixed the reranker model-cache dir (`reranker.rs` now pins `~/.neurovault/.fastembed_cache`).
- **Why it matters**: npm CLI binaries sidestep the macOS Gatekeeper "damaged" wall, so this unblocks the dev audience WITHOUT the Apple Developer account (signing is being handled separately by the user later).

## 5. The competitive picture (vs agentmemory et al.)
A heavy Opus council analyzed NeuroVault vs the field. **Moats**: zero-LLM on-device ingest (privacy is structural), markdown-canonical ownership, single-file embedded stack, **graphify** (only code-aware memory), cross-agent via one MCP bridge. **Weaknesses (ranked)**: (1) unsigned macOS Gatekeeper friction [user fixing later], (2) no zero-friction install [**now addressed by the npx work above**], (3) no auto-capture (empty-state), (4) brute-force flat vector scan (no ANN) — fine to ~10s of k chunks, (5) temporal/bitemporal write-dead on the Rust path, (6) weak regex entity graph (gbrain shows typed edges = +31pp P@5).

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
- Don't redo the full 470-q eval until a config beats 0.938 on a dev slice. Honest framing if we can't pass them: engine-only 0.938 is within ~1pt AND we're the only one publishing all 5 dimensions (incl. abstention) + the real moats.

## 9. Other open threads
- **Feature idea saved**: user-selectable embedding model (Settings → pick model + reindex). Today hardcoded BGE-small@384 in `embedder.rs:128`/`:34`, `db.rs:44` (`vec0 float[384]`). Swap needs `EMBEDDING_DIM` + vec0 schema change + full re-embed (cheap because markdown-canonical). Use only fastembed-supported ONNX models (no Python).
- **Windows verification**: open the PR (§3) → CI builds the Windows `.exe` → run `dist-npm/WINDOWS-TEST.md` on the user's Windows laptop.
- The eval's partial results are in `docs/benchmarks/chunks_prod/` (production-A, the underperforming config — keep for the record, don't publish).
