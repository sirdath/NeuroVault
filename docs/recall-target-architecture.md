# NeuroVault recall — target architecture (the path to 90%+)

_Companion to `retrieval-state.md` (which documents the CURRENT state at
~70%). This document is the TARGET: what the infrastructure must look
like for recall quality to be genuinely amazing (90%+ on LongMemEval-
class evaluation), grounded in what the systems that actually hit that
band do. Written 2026-05-21._

---

## 0. The core thesis (read this first)

**The systems at 90%+ do not win on the retrieval ranker.** We proved
NeuroVault's ranker is already sound — in a turn-by-turn behavioral diff
it matched the v1 (64%) Python implementation almost exactly
(`retrieval-state.md` §5.2). Tuning the hybrid ranker (BGE-small + BM25
+ RRF + cross-encoder) tops out around **70–75%**.

The 90%+ systems win on two layers NeuroVault barely has:
1. **Write-time memory construction** — they don't store raw notes and
   hope; at ingest they extract atomic facts, resolve contradictions,
   and build a clean, queryable knowledge layer.
2. **Read-time LLM reasoning** — recall is not a single dense lookup;
   it's iterative retrieval + LLM reranking/synthesis over candidates.

So 90% is a **different shape**, not a tuned version of today. Evidence
band (LongMemEval-Oracle): MemPalace ~96.6%, Mastra ~95%, ByteRover
~92.8%, Emergence SOTA-with-RAG — all use LLMs heavily at write and/or
read time.

---

## 1. Target architecture — six layers

### Layer 1 — Write-time memory construction  ← biggest single lever
At ingest, an extraction pass turns each raw note into structured memory:
- **Atomic fact extraction**: "grocery budget = £550", "prefers ripgrep
  for code search", "Sarah owns retrieval".
- **Conflict resolution / supersession**: a new fact that contradicts an
  old one marks the old superseded and records the current value.
  *Precedent:* Mem0 ADD/UPDATE/DELETE/NOOP (github.com/mem0ai/mem0,
  arXiv:2504.19413); Zep/Graphiti bitemporal validity (arXiv:2501.13956).
- **Entity resolution**: "Sarah" = "Sarah Chen" = "my manager" → one node.
- **Dedup / consolidation**: kill near-duplicates so they can't crowd
  recall ("Replace, Don't Expand", arXiv:2512.10787).
- **Key expansion (not duplication)**: append extracted facts to the
  *index key* of the original note; keep the note as the retrievable
  unit (LongMemEval paper's validated technique, arXiv:2410.10813 — and
  the explicit fix for the imp#1 anti-pattern we found).

*NeuroVault today:* `entities` / `entity_mentions` / `temporal_facts`
tables exist (skeleton); imp#4 (`facts.rs`) was a first step. *Needs:*
the extraction + reconciliation pass that actually populates them.
**Most of the gain lives here.**

### Layer 2 — Structured stores (not just a vector index)
- **Typed fact store** (subject / attribute / value / valid_from /
  valid_until) → answers "what's my current X" directly, no similarity
  guessing.
- **Entity-relationship graph** → multi-hop: "what did Sarah decide
  about the thing Tom started" (Zep/Graphiti arXiv:2501.13956; HippoRAG
  github.com/osu-nlp-group/hipporag, arXiv:2405.14831).
- **Episodic / session index** → "what did we conclude last time about X."
- Raw markdown stays source of truth; all three are derived indices.

*NeuroVault today:* has the skeletons of all three; under-populated only
because nothing does Layer 1 yet.

### Layer 3 — Query understanding + routing
- **Decompose** complex queries into sub-queries (Adaptive-RAG,
  arXiv:2403.14403).
- **Route** each sub-query to the right store: fact-store for current-
  value, graph for multi-hop, vector for fuzzy semantic, episodic for
  temporal. The hybrid ranker becomes ONE strategy among several.
- **Cheap router**: a TF-IDF / linear classifier on the raw query beats
  sentence-embeddings here and needs no LLM (RAGRouter-Bench
  arXiv:2604.03455). We already compute most of the signals.
- *Already shipped, related:* conditional reranking by query shape
  (`retrieval-state.md` §5.3) is a tiny first instance of routing.

### Layer 4 — Read-time LLM reasoning  ← the 90% gate
- **Iterative retrieve → check → re-query** (Self-RAG arXiv:2310.11511):
  if the first pass doesn't fully answer, reformulate and go again.
- **LLM reranking / synthesis** over candidates — an LLM judges and
  composes; the cross-encoder is a weak proxy for this. **Every system
  in the 90%+ band uses an LLM in the recall loop.**

### Layer 5 — A stronger embedder
BGE-small (384-dim) is the weak link on proper nouns / numerals. A
1024-dim top-MTEB model is a bounded, measurable swap worth a few points.
*Cost:* larger model, more RAM/latency.

### Layer 6 — A trustworthy evaluation harness  ← the substrate
None of Layers 1–5 is buildable without reliable measurement. The entire
reason the retrieval-hardening loop thrashed was the absence of one
(contaminated 500-Q bench, sub-noise effects, machine-crashing runs,
over-trusted toy fixtures). A fast, clean, discriminating eval is the
foundation everything else is tuned against. **Step 0 for any path.**

---

## 2. What each layer buys (honest score bands)

| Configuration | Realistic band |
|---|---|
| Today: hybrid ranker, raw notes, no write-time, no read-time LLM | ~70% |
| + Layers 1–3 + 5, local-first (small/local LLM or rules for extraction) | ~80% |
| + Layer 4 (read-time LLM reasoning) | **90%+** |

---

## 2.1 Empirical justification — failure bucketing (2026-05-21)

The plan rests on "write-time consolidation is the biggest lever." We
tested that against data instead of asserting it. Bucketed all 138
gradable WRONG answers from the 500-Q run by **how many sessions the
evidence spans** (from the oracle's `answer_session_ids`):

| Bucket | Failures | What fixes it |
|---|---|---|
| Evidence in **1 session** (retrieval/ranking) | 58 (42%) | better ranking / reranker — NOT write-time |
| Evidence across **≥2 sessions** (scatter) | 80 (58%) | **write-time consolidation** (collapse scattered facts into one resolved unit) |

It splits cleanly by category: all single-session-{assistant,preference,
user} failures (56) are 1-session retrieval/ranking; all multi-session
(35), temporal-reasoning (26), knowledge-update (19) failures are
≥2-session scatter.

**Conclusion:** neither lever alone reaches 90. **~58% of the gap is
write-time-consolidation-addressable** (justifies Layer 1, well above the
"+5pp" commit bar), **~42% is pure retrieval/ranking** (the reranker fix
§retrieval-state §5.3 + ranking work — the cheaper half, already underway).
Read-time recovers the 42%, write-time the 58%; option D delivers both
via the agent.

**Caveat:** "≥2 sessions ⇒ consolidation helps" is a *proxy* (a
multi-session miss could be retrieval too). And these are the imp1-5
stack's failures, which include the *broken* reranker — the 42% retrieval
bucket may shrink once the reranker fix is measured. Treat 58/42 as
directional, not exact.

## 3. The "LLM in the loop" question — and why NeuroVault gets it for free

90% needs an LLM in the loop. The naive options each have a cost:

- **(A) Local-first, no LLM (today):** private, free, light. Ceiling ~70%.
- **(B) Local-first + a local LLM** (ollama/llama.cpp for extraction):
  private, free, but **heavy on hardware** (the dev laptop already
  crashes on embeddings alone) and lower extraction quality → ~80%.
- **(C) Cloud LLM** (NeuroVault calls Claude/GPT itself): 90%+ possible,
  but data leaves the device, costs money per call, needs internet —
  breaks the private/free promise.

### 3.1 Option D (RECOMMENDED) — the connected agent IS the LLM
NeuroVault is an **MCP server**. The way it is used, there is *already* a
frontier model at the other end of the wire — the Claude (Code / Desktop)
the user is talking to. So NeuroVault does not need to spawn, run, or pay
for an LLM. It reuses the one already at the keyboard.

- **No new API call, no local model, no extra cost from NeuroVault.**
- **No new privacy boundary** — the data goes to the LLM the user already
  chose to use. (A user on the pure desktop app with no agent falls back
  to option A behaviour, ~70%.)
- Plays to NeuroVault's structural advantage: it is the *structured
  memory substrate + tool surface*; the connected agent is the *brain*.
  "Agent-tended memory," not "autonomous memory."

**Read-time (Layer 4): already happening.** The agent calls `recall()`,
reasons over results, composes the answer, and can re-query — that IS
read-time LLM reasoning. The 70.5% bench run already had it (the bench
drives a Claude). The lever is to feed the agent *better-structured*
candidates and let it *route its own* sub-queries (the agent is a far
better router than any TF-IDF classifier — Layer 3 done by the agent).

**Write-time (Layer 1): the new build.** Extraction wants to happen at
ingest, but the agent is not always present then (desktop file-watcher
writes have no agent). Design: **deferred, agent-tended consolidation.**
NeuroVault flags un-consolidated notes; the connected agent processes the
queue at natural moments via a small tool surface:
- `consolidate(limit)` → returns raw notes that have not been
  fact-extracted yet.
- `record_fact(subject, attribute, value, source_engram)` → agent writes
  an extracted fact; server handles supersession + dedup (Layer 1/2).
- `current_value(subject)`, `related(entity)`, `timeline(topic)` →
  structured-store reads the agent routes to directly.
The agent becomes the memory's librarian: during normal use it extracts
facts, resolves conflicts, and records them. NeuroVault itself stays
**LLM-free** — pure Rust storage + a smart tool API. (Note: the deleted
Python server already had a "Stage 5 silent fact capture / self-improving
retrieval" — precedent worth mining from git history.)

### 3.2 Honest limits of option D
- **Quality tracks the connected agent.** Capable agent → great
  consolidation; weak/no agent → falls back to raw retrieval (~70%). So
  standalone-90% is not guaranteed; *agent-in-the-loop*-90% is the claim.
- **Cost/latency falls on the user's agent session** (tokens/turns spent
  tending memory) — so consolidation must be cheap and opt-in, not
  intrusive.
- **Less deterministic** — agent behaviour varies, so the eval must
  tolerate that (assert on retrieval surface + fact-store correctness,
  not exact agent prose).

**The remaining real decision** is narrow: how much consolidation work to
push onto the agent's session, and whether to *also* offer an optional
cloud/local-LLM tier for users who run NeuroVault head-less (no agent).
Default path = D.

---

## 4. Build sequence (gated, one layer at a time) — option-D path

0. **Eval first (Layer 6).** Harden the fast-eval (real distractors,
   top-1 assertions, real user query shapes), establish a clean
   baseline. Nothing below is verifiable without it.
1. **Structured fact store + agent tool surface (Layers 1–2 substrate).**
   Pure Rust, no LLM in NeuroVault: a typed fact store with supersession,
   plus the tools `consolidate()`, `record_fact()`, `current_value()`,
   `related()`, `timeline()`. The *connected agent* does the extraction
   by calling these — so this ships the storage + API, and the
   intelligence comes for free from option D.
2. **Read-time surface (Layer 4 via agent).** Make `recall()` return
   reasoning-friendly structured candidates (fact vs raw note, timestamp,
   supersession status, why-matched) so the agent can route + drill down.
   Mostly enhancing existing tools; the agent supplies the reasoning.
3. **Layer 5** — embedder swap (cheap, parallelizable, measurable).
4. **(Optional) headless tier** — only if you want NeuroVault to hit ~80%
   *without* an agent present: a local small-LLM or cloud consolidation
   path reusing the same `record_fact` plumbing. Not needed for the
   agent-in-the-loop benchmark path.

Each step ships behind a flag, is judged on the eval (mechanism + delta
beyond noise), and is reverted in-turn if it doesn't earn its place.

---

## 5. Honest caveats (do not repeat past mistakes)

- **Measure before believing.** Mechanism plausibility is not validation;
  the loop's defining failure was trusting toy A/Bs over scale tests.
- **One variable at a time.** Never bundle a layer with an infra change
  (the Python→Rust port confound made a whole 500-Q uninterpretable).
- **Don't run the heavy bench on the dev laptop** (it crashes); use a
  spare/idle machine or a small fast eval for iteration.
- **Local-first is a real constraint, not a footnote** — it caps the
  achievable score unless consciously relaxed.

---

## 6. What NeuroVault already has (the head start)
- Markdown-as-source-of-truth — a clean substrate to derive from.
- `entities` / `entity_mentions` / `temporal_facts` tables — skeletons
  for Layers 1–2.
- A sound hybrid ranker (vec + BM25 + graph + RRF + conditional rerank).
- imp#4 (`facts.rs`) — a first write-time supersession step.
- The fast-eval scaffold (`bench/fast_eval/`) — needs hardening to be the
  Layer-6 gate.

The path to 90 is **additive on this base** — not a rewrite. The work is
the write-time consolidation layer + structured-store population +
(for 90) read-time LLM reasoning, each gated by a trustworthy eval.
