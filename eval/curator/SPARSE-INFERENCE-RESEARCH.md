# Conditional Computation & Partial-Activation Inference

**Research brief for the NeuroVault Curator — how to run a "big" model on a 24 GB Mac without touching all its weights per token.**

Date: 2026-08-13 · Status: research only, nothing benchmarked here · Target stack: **Ollama HTTP API on 127.0.0.1:11434, 24 GB Apple Silicon Mac, nightly batch extraction job**

---

## How to read this

Every technique below is tagged twice.

| Tag | Meaning |
| --- | --- |
| **PROVEN** | Shipping in a runtime you can install today, or independently reproduced with public numbers |
| **EMERGING** | Paper-only, PoC, or single-lab result; no path to your runtime yet |

And scored on **applicability to this stack**:

| Score | Meaning |
| --- | --- |
| ✅ **Today** | A model tag or an Ollama option. Zero code. |
| 🟡 **llama.cpp** | Needs a flag Ollama does not expose — you'd run `llama-server` behind the same OpenAI-compatible URL |
| 🟠 **Different runtime** | MLX / PowerInfer / custom; app would need a new backend |
| 🔴 **Research only** | Do not spend time on it for ~2 years |

**The three things people conflate.** Keep them separate or every conclusion goes wrong:

- **RAM** — how many bytes must be resident. Set by *total* parameters (plus KV cache).
- **FLOPs** — arithmetic per token. Set by *active* parameters. Dominates **prefill**.
- **Latency / bandwidth** — bytes streamed per generated token. Set by *active* parameters. Dominates **decode**.

MoE cuts FLOPs and bandwidth. It does **not** cut RAM. Quantization cuts RAM and bandwidth. It does **not** cut FLOPs. Offloading cuts RAM and *adds* latency. Nothing cuts all three.

---

## 0. The framing that changes every answer: your job is prefill-dominated

Before any technique: read the shape of the curator workload out of `run_bench.py`.

- Each request = a ~700-token prompt template + one ExperienceUnit of **~2,000–4,000 approximate tokens** (`README.md`), i.e. **≈3–5 k tokens of prefill**.
- Output = one small JSON object under a `format: <schema>` constraint — on the order of **100–400 tokens of decode**.
- `num_ctx` default **8192**, `temperature 0`, `keep_alive 30m`, ~100 units per sweep, run overnight.

So the token ledger per unit is roughly **10:1 prefill:decode**. That single fact re-ranks the entire field:

| Phase | Bound by | Which techniques help |
| --- | --- | --- |
| **Prefill (~90% of your tokens)** | **compute / FLOPs** — big parallel GEMMs over thousands of positions ([TDS](https://towardsdatascience.com/prefill-is-compute-bound-decode-is-memory-bound-why-your-gpu-shouldnt-do-both/)) | **MoE** (fewer FLOPs per token), quantization (a little), better kernels, bigger `num_batch` |
| **Decode (~10%)** | **memory bandwidth** — stream active weights + KV per token | MoE, quantization, speculative decoding, activation sparsity |

Consequences you should internalise before reading further:

1. **Speculative decoding is near-worthless for this job.** It accelerates decode only, and decode is ~10% of your tokens. Amdahl caps you at a few percent. It is the most-hyped 2026 knob and the least relevant one to you.
2. **TEAL/Deja-Vu-style activation sparsity is also near-worthless here** — it is explicitly a *batch-1 decode* technique (TEAL: "targets single-batch decoding… in batched scenarios, different inputs require different sparsity patterns", [arXiv 2408.14690](https://arxiv.org/html/2408.14690v3)). Prefill is a batch of thousands of tokens, each with a different sparsity mask. The sparsity averages out to dense.
3. **MoE is the one conditional-computation family that helps the phase you actually pay for**, because expert routing removes FLOPs in prefill *and* bytes in decode.
4. Latency is not even your primary axis. It's a nightly batch. **Quality per resident gigabyte** is the objective; wall-clock only matters insofar as the sweep must finish overnight.

---

## 1. Mixture of Experts

### 1.1 The math

An MoE layer replaces the dense FFN with `N` expert FFNs and a router. For token representation `x`:

```
h(x)   = W_r · x                          router logits, W_r ∈ R^{N×d}
p(x)   = softmax(h(x))                    distribution over experts
T      = TopK(p(x), k)                    the k winning expert indices
y      = Σ_{i∈T}  p_i(x) · FFN_i(x)       weighted sum over ONLY the winners
```

The gating is a hard, discrete, input-dependent selection: `N − k` experts contribute exactly zero and are never multiplied. Because the FFN block is the most expensive part of a transformer layer, capacity scales with `N` while per-token cost scales with `k` ([IBM](https://www.ibm.com/think/topics/mixture-of-experts); [Expert-Choice routing, NeurIPS 2022](https://papers.neurips.cc/paper_files/paper/2022/file/2f00ecd787b432c1d36f3de9800728eb-Paper-Conference.pdf)).

**Load balancing.** Top-k over a softmax is unstable: a rich-get-richer feedback loop collapses routing onto a handful of experts. Switch Transformer added an explicit auxiliary loss penalising the dot product of (fraction of tokens routed to expert i) with (mean router probability for expert i), plus a **router z-loss** to stop logits exploding ([review](https://huggingface.co/blog/NormalUhr/moe-balance)). DeepSeek-V3 later showed you can drop the auxiliary loss entirely and instead nudge a **per-expert bias term** added to the routing logits, adjusted online toward balance — no gradient interference with the language-modelling loss ([arXiv 2408.15664](https://arxiv.org/pdf/2408.15664)). This is training-side math; it matters to you only because it's why modern MoEs route more evenly, which makes expert caching *worse* (see §1.4) and quality *better*.

**Tag: PROVEN. Applicability: ✅ Today.**

### 1.2 Why `qwen3-coder:30b` behaves like a 3 B model on your Mac

`Qwen3-30B-A3B`: **30.5 B total / 3.3 B activated**, 48 layers, **128 experts, top-8 routed**, GQA with 32 query heads and 4 KV heads ([Qwen3-30B-A3B model card](https://huggingface.co/Qwen/Qwen3-30B-A3B)). On Ollama, `qwen3-coder:30b` is **19 GB at 256 K context**, described as "30B total parameters with only 3.3B activated" ([ollama.com/library/qwen3-coder](https://ollama.com/library/qwen3-coder)).

Single-stream decode on Apple Silicon is bandwidth-bound, and the ceiling is essentially:

```
tok/s  ≲  effective_memory_bandwidth / (active_weight_bytes + KV traffic)
```

with real throughput landing at ~50–80% of that ceiling once attention over the KV cache, kernel launches and sampling are counted ([Cerebras MoE math](https://www.cerebras.ai/blog/moe-guide-calculator); [InventiveHQ](https://inventivehq.com/blog/local-llm-performance-what-to-expect)). For an MoE it is **only the active experts** in the numerator's denominator. At Q4-ish, 3.3 B active ≈ 2 GB streamed per token instead of ~19 GB — roughly a **9× lower** per-token byte cost than a dense model of the same file size. That is the entire trick. Nothing is being "swapped out"; the router simply never reads the other 120 experts for that token.

The same argument holds in prefill for FLOPs rather than bytes: the GEMMs are over 3.3 B weights, not 30 B.

**The catch, stated plainly: MoE does not save RAM.** All 128 experts must be resident, because any token may route to any of them. A 19 GB MoE occupies 19 GB. On a 24 GB Mac that is the binding constraint, not speed — see §3.3.

Reported Apple-Silicon throughput for this class: an M4 Max (48 GB) runs a 35B-A3B-class MoE at ~42 tok/s, versus ~38 tok/s for a *dense 14 B* on the same chip ([LLMCheck](https://llmcheck.net/models/qwen-36-35b-a3b-on-m4-max/); [Markaicode](https://markaicode.com/benchmarks/hugging-face-qwen-3-m4-max-throughput-benchmark/)). That comparison is the whole value proposition in one line: **~30 B of knowledge at ~14 B of speed** — but at 19 GB of RAM, not 8 GB.

**Tag: PROVEN. Applicability: ✅ Today.**

### 1.3 MoE models in the 8–20 GB class on Ollama today

Verified against the Ollama library pages (sizes are the download/on-disk figure; add KV cache on top):

| Tag | On disk | Total / active | Context | Notes |
| --- | --- | --- | --- | --- |
| `gpt-oss:20b` | **14 GB** | ~21 B / ~3.6 B, MoE weights are 90 %+ of params | 128 K | Native **MXFP4** at "4.25 bits per parameter"; page states it runs on "as little as 16 GB memory" ([src](https://ollama.com/library/gpt-oss)) |
| `gemma4:26b` | **18 GB** | 25.2 B / **4 B active**, 8 of 128 experts | 256 K | Also `gemma4:26b-mlx` at 18 GB ([src](https://ollama.com/library/gemma4)) |
| `qwen3-coder:30b` | **19 GB** | 30 B / 3.3 B | 256 K | ([src](https://ollama.com/library/qwen3-coder)) |
| `nemotron-3.5-lightning:30b` | **25 GB** (mlx 23 GB) | 30 B / **3 B active** | 1 M | NVIDIA; claims 4× throughput vs comparable open models, aimed at "the execution layer of always-on agents" ([src](https://ollama.com/library/nemotron-3.5-lightning)) — **too big for 24 GB**, listed for completeness |
| `granite4.1:30b` | **17 GB** | page describes the family as dense decoder-only; **verify the architecture on the model card before trusting this row** | 128 K | Explicitly advertises "tool use, and structured JSON output" ([src](https://ollama.com/library/granite4.1)) |
| `gemma4:12b` | 7.6 GB | dense | 256 K | Dense control arm for the bench |

**For an extraction task specifically**, the two that deserve a bench slot are **`gpt-oss:20b`** (smallest MoE that reaches the class, native 4-bit so no quant-choice confound, biggest headroom left over for KV cache) and **`gemma4:26b`** (4 B active, more total capacity, still fits). `qwen3-coder:30b` is code-tuned; for prose-transcript extraction the non-coder Qwen MoE tag is the better arm if one exists at your size.

**Tag: PROVEN. Applicability: ✅ Today.**

### 1.4 Expert offloading and caching — the part that *would* save RAM

If you don't want all experts resident, you keep a small pool of expert slots in fast memory and page the rest. Four generations of this idea:

**(a) Mixtral-offloading (2023).** LRU cache over experts in GPU memory + **speculative expert loading**: after computing layer `L`'s router, prefetch the 1–2 most likely experts for layer `L+1` ([arXiv 2312.17238](https://arxiv.org/pdf/2312.17238)). A later analysis of Mixtral 8×7B measured LRU hit rates of **~40% at cache size 2 and ~60%+ at size 4** ([arXiv 2511.05814](https://arxiv.org/pdf/2511.05814)). Note what that implies: at a 60% hit rate, 40% of tokens stall on a disk/host fetch. **Tag: PROVEN (as a library) / EMERGING (as a general technique). Applicability: 🟠.**

**(b) llama.cpp `--cpu-moe` / `--n-cpu-moe N`.** The shipping version of the idea. `-cmoe` keeps **all** routed-expert weights in CPU RAM; `-ncmoe N` keeps the expert weights of `N` layers there. It overrides the buffer type for *only* the routed-expert tensors — attention, KV cache, router, shared experts and norms stay on the accelerator. It counts from the **highest-numbered layers downward**. Equivalent manual form: `--override-tensor '\.ffn_.*_exps\.weight=CPU'` ([llama.cpp issue #20757](https://github.com/ggml-org/llama.cpp/issues/20757); [flag explainer](https://aliteq.com/n-cpu-moe-llama-cpp-what-it-actually-does); [MoE offload guide](https://huggingface.co/blog/Doctor-Shotgun/llamacpp-moe-offload-guide)).

  The honest framing, from the same sources: **adding `--n-cpu-moe` normally makes an MoE model slower, not faster.** The famous "5× speedup" only appears when the model didn't fit in VRAM at all and the driver was paging over PCIe. **On Apple Silicon this flag is close to a no-op in spirit**: CPU and GPU share one unified memory pool, so "moving experts to CPU RAM" doesn't free GPU memory the way it does on a discrete card — it mostly just moves the matmul to a slower compute unit. This is the single most important negative result in this document for your machine.
  **Tag: PROVEN. Applicability: 🟡 llama.cpp — and probably not worth it on a Mac.**

**(c) Two-tier expert cache (proposed, not merged).** llama.cpp issue #20757 proposes GPU-slot / pinned-RAM / SSD tiers with a **Segmented LRU** policy (~20% probationary, ~80% protected, frequency-gated admission) to stop cold experts polluting the cache. Reported figures on an 8 GB RTX PRO 2000 running GPT-OSS-120B: **12–14 tok/s at ~98–100% steady-state hit rate**, versus **~0.5–1 tok/s** for plain CPU offload. Opened 2026-03-19; **closed with no merged implementation**. **Tag: EMERGING. Applicability: 🔴 for now.**

**(d) SpecPrefetch (2026) — the current research frontier.** A shared lightweight adapter predicts next-layer expert candidates *for prefetch only*, while the frozen native router still decides what actually executes (so a misprediction costs bandwidth, never accuracy). Reported **~96% top-1 next-layer accuracy, ~90% even 2–3 layers ahead**, and up to **14% TPOT reduction** over on-demand loading ([arXiv 2607.24787](https://arxiv.org/abs/2607.24787)). The 14% is the number to remember: even with a near-perfect predictor, offloaded MoE is *still* far slower than resident MoE. **Tag: EMERGING. Applicability: 🔴.**

### 1.5 The Apple-Silicon-specific version: MoE paging to disk

This is the most directly relevant live work for your machine.

**llama.cpp Discussion #23324 — "RFC+PoC: MoE offload to disk with on-demand paging."** Allocates `N` expert slots in Metal shared memory; a Metal kernel (`kernel_moe_interceptor`) copies the selected expert IDs into shared CPU/GPU memory; a CPU sidecar thread resolves expert→slot with LRU eviction and `pread`s missing experts straight out of the GGUF; the GPU then runs against the compact pool unchanged.

Measured on **M3 Pro 36 GB, Qwen3-30B-A3B-Q6_K (128 experts)**:

| Config | tok/s | Wired memory | Saved |
| --- | --- | --- | --- |
| Vanilla (all experts resident) | **38.1** | ~27.2 GiB | — |
| 80 slots | **29.1** | ~18.9 GiB | ~8.3 GiB |
| 8 slots | **12.0** | ~6.3 GiB | ~20.9 GiB |

And on an **M1 Pro with 16 GB**: **13 tok/s** on a model that cannot otherwise load at all. Constraints: needs `--no-mmap` and `--no-warmup`, and `batch_size × experts_used ≤ slots` ([discussion #23324](https://github.com/ggml-org/llama.cpp/discussions/23324)).

Read the trade curve carefully: **−31 % memory buys −24 % speed; −77 % memory buys −68 % speed.** For a nightly batch job that would otherwise not fit, that is a *completely acceptable* trade. For a job that already fits, it is a pure loss. **Tag: EMERGING (PoC + PR, unmerged). Applicability: 🟡→🟠 — it is a llama.cpp build, not an Ollama option.**

**mlx-lm issue #1438** requests the same thing for MLX (lazy expert loading, on-demand fetch into an LRU cache, opt-in toggle, next-layer prefetch), motivated by running a ~395 GB MoE on 128 GB. Opened 2026-06-27, **open, no maintainer response, no labels** ([src](https://github.com/ml-explore/mlx-lm/issues/1438)). Third-party projects claim to do it already — `SwiftLM` advertises SSD expert streaming with a "10× generation speedup" for memory-constrained Apple Silicon ([src](https://github.com/SharpAI/SwiftLM)), and `Mference` advertises Swift+Metal MoE inference including "Gemma 4 26B in ~2 GB" on a 24 GB M5 ([src](https://github.com/NeelM0906/Mference)) — both unverified single-author projects; treat as leads, not evidence. **Tag: EMERGING. Applicability: 🟠.**

---

## 2. Activation / contextual sparsity

The MoE idea, applied to a **dense** model at inference time: discover that most neurons are irrelevant to *this* token and skip their rows/columns.

### 2.1 Deja Vu — contextual sparsity

**The math.** For input `x` at block `k`, there exists a small input-dependent subset of attention heads and MLP neurons whose output approximates the dense output. Deja Vu trains a small MLP **sparse predictor** per block and side-steps its own latency with **lookahead**: the input to attention at block `k` predicts the MLP sparsity at block `k`, and the input to the MLP at block `k` predicts the *next* block's sparsity — so prediction overlaps with compute instead of serialising.

**Measured:** up to **85% contextual sparsity**; >80% of attention heads silenced and >95% of MLP parameters zeroed for a given token; **>2× speedup** ([arXiv 2310.17157](https://arxiv.org/abs/2310.17157) / [PMLR](https://proceedings.mlr.press/v202/liu23am/liu23am.pdf)). **Tag: PROVEN (as research, ICML 2023) but not in your runtime. Applicability: 🔴.**

### 2.2 PowerInfer / PowerInfer-2 — hot/cold neuron split

Exploits a power-law in activation frequency: a small set of **hot** neurons fires for almost every input; the **cold** majority is input-specific. PowerInfer pins hot neurons on the GPU and leaves cold ones on CPU. PowerInfer-2 generalises to phones: matmuls are decomposed into **fine-grained neuron-cluster** computations, big hot clusters go to the NPU as dense work, small cold clusters go to the CPU as sparse work, with segmented neuron caching and cluster-level pipelining to hide I/O. Runs models up to **47 B on a smartphone**, up to **29.2×** faster than baselines ([arXiv 2406.06282](https://arxiv.org/pdf/2406.06282); [project](https://powerinfer.ai/v2/)).

**The catch that kills it for you:** PowerInfer's speedup is measured *against llama.cpp*, and it is a **fork** of llama.cpp, not a feature of it. llama.cpp upstream **does not use activation sparsity at all** — it computes FFNs densely ([llama.cpp issue #4559](https://github.com/ggml-org/llama.cpp/issues/4559); [SparseInfer, arXiv 2411.12692](https://arxiv.org/pdf/2411.12692) states this explicitly). Ollama is llama.cpp + MLX. So none of this reaches you. **Tag: PROVEN (in its own fork). Applicability: 🟠 different runtime — and the fork lags upstream badly on model support.**

### 2.3 The SwiGLU problem — why this whole family stalled

Deja Vu and PowerInfer both lean on **ReLU**, which emits *exact* zeros. Modern models use SwiGLU/SiLU, which emits *small but nonzero* values everywhere — so there is no free sparsity to exploit. Two responses:

**ReLUfication / ProSparse.** Swap the activation to ReLU and continue pre-training to recover quality. ProSparse does it in three steps — activation substitution, **progressive sparsity regularisation** (a flat warm-up then incremental stages along gentle sine curves, so the activation distribution shifts gradually), and activation threshold shifting — reaching **89.32% sparsity on LLaMA2-7B, 88.80% on 13B, 87.89% on MiniCPM-1B** at comparable quality ([arXiv 2402.13516](https://arxiv.org/abs/2402.13516), COLING 2025). But this requires **continued pre-training on hundreds of billions of tokens**. It is a model-producer technique; nobody ships ReLU-fied versions of the models you want.

**"Sparsing Law" (arXiv 2411.02335)** puts numbers on the gap: the activation ratio follows a *convergent increasing* power law in training data for SiLU models but a *decreasing* logspace power law for ReLU models — i.e. **SiLU models get denser the more you train them, ReLU models get sparser**. It also finds the limit activation sparsity varies only weakly with parameter scale, and that deeper-narrower models stay sparser at fixed parameter count ([src](https://arxiv.org/abs/2411.02335)). Translation: the entire 2026 frontier of SwiGLU models is structurally hostile to this family, and getting more so.

**Tag: PROVEN (ProSparse) but producer-side. Applicability: 🔴.**

### 2.4 TEAL and CATS — training-free activation sparsity

**CATS** sparsifies only the SwiGLU intermediate state: it builds a mask from the gated (SiLU) activation, applies it to the up-projection output, then exploits input sparsity in the down-projection. Attention stays fully dense, capping model-wide sparsity at **roughly 25%**.

**TEAL** (ICLR 2025 spotlight) generalises it. Before **every** linear projection, given the incoming hidden state `x` and a target sparsity `p`, it computes a magnitude threshold `t_p` such that the fraction of entries with `|x_i| ≤ t_p` equals `p`, and zeroes those entries:

```
sparsify_p(x)_i  =  x_i   if |x_i| > t_p
                 =  0     otherwise
```

Per-layer sparsity levels are allocated by a **block-wise greedy** search (Algorithm 1): sparsity is raised incrementally, inversely proportional to matrix size, always on whichever of the block's seven matrices costs the least ℓ2 activation error, while holding block-level targets uniform.

**Measured:** 40–50% model-wide sparsity across Llama-2, Llama-3 and Mistral, 7B–70B. Llama-2-7B perplexity **5.07 → 5.22 at 40%, → 5.43 at 50%**. Wall-clock decoding **1.53× at 40% and 1.80× at 50% on an A6000**, but only **1.25× / 1.40× on an A100** — the gap is precisely because the A6000 has less bandwidth, confirming this is a bandwidth trick. Compatible with weight quantization. Requires **custom Triton sparse GEMV kernels** (column-major weight storage for coalescing, selective column loads, SplitK with FP16 outer accumulation) ([arXiv 2408.14690](https://arxiv.org/html/2408.14690v3); [Together blog](https://www.together.ai/blog/teal-training-free-activation-sparsity-in-large-language-models)).

**Three catches, all fatal for this stack:**
1. **Triton kernels = NVIDIA.** There is no Metal port. Apple-Silicon sparse-kernel work exists but is early and unrelated (e.g. a blocked/interleaved sparse **ternary** GEMM for M-series, [arXiv 2510.06957](https://arxiv.org/pdf/2510.06957)).
2. **Batch-1 decode only.** The paper concedes that under batching, different inputs need different masks and averaging magnitudes across a batch collapses effective sparsity. Your prefill *is* a batch of thousands of positions.
3. **Not in llama.cpp, not in Ollama, not in MLX.**

**2026 successor: WiSparse** ([arXiv 2602.14452](https://arxiv.org/pdf/2602.14452), Feb 2026) — "weight-aware mixed activation sparsity", combining structured and unstructured patterns and using weight distributions rather than activation magnitude alone to choose what to prune, benchmarked against TEAL, CATS, Deja Vu, R-Sparse and Q-Sparse. Same runtime problem.

**Tag: TEAL = PROVEN on NVIDIA; WiSparse = EMERGING. Applicability: 🔴 for both.**

> **Honest bottom line for §2:** activation sparsity is the most intellectually satisfying answer to the owner's question and the least usable one. It needs (a) a ReLU-ish model, (b) custom sparse kernels for your accelerator, (c) batch-1 decode. You have none of the three, and the SwiGLU trend is moving away from (a). **Ignore for two years.**

---

## 3. Memory-mapped and storage-offload execution

### 3.1 Apple's "LLM in a flash"

The paper that started this line, and it is Apple's, which makes it doubly relevant. Model parameters live in flash; only what's needed is pulled into DRAM. Two mechanisms:

- **Windowing** — keep only the neurons activated by the last `k` tokens resident, reusing activations across the sliding window. Because consecutive tokens activate largely overlapping neuron sets, each new token requires loading only the *delta*, collapsing the number of I/O requests.
- **Row-column bundling** — using neuron `i` requires column `i` of the up-projection and row `i` of the down-projection. Storing them **contiguously as one bundle** doubles the size of each sequential read, which is exactly what flash is good at (bandwidth scales with chunk size).

**Measured:** run models **up to 2× the size of available DRAM**, with **4–5× (CPU) and 20–25× (GPU)** speedup versus naive load-from-flash ([arXiv 2312.11514](https://arxiv.org/pdf/2312.11514); [Apple ML Research](https://machinelearning.apple.com/research/efficient-large-language)).

The unavoidable footnote: the paper's windowing depends on **ReLU-induced activation sparsity** to know which neurons to skip — same dependency as §2. Its *storage* insight (bundle co-accessed weights, read big chunks sequentially) is architecture-neutral and is exactly what llama.cpp's MoE-paging PoC (§1.5) reimplements with experts as the bundling unit. **Tag: PROVEN (as a paper, Apple); not shipped in any consumer runtime. Applicability: 🔴 directly, ✅ indirectly via §1.5.**

**ActiveFlow** ([arXiv 2504.08378](https://arxiv.org/abs/2504.08378), Jia et al.) is the modern restatement for non-ReLU models: cross-layer preloading (predict the next layer's active weights from the current activations and overlap fetch with compute), **sparsity-aware distillation** (retrain weights so the sparse model's output matches the dense model's, compensating for the imprecision of contextual sparsity), and adaptive DRAM budgeting between active-weight cache and compute buffers. **Tag: EMERGING. Applicability: 🔴.**

### 3.2 mmap as Ollama already does it

llama.cpp memory-maps the GGUF by default, so pages of weights are faulted in by the OS on first touch and evicted under pressure. This is *not* conditional computation — every weight is still touched every token for a dense model, so under memory pressure you get thrash, not sparsity. Its real benefits are fast startup and shared pages between processes. Note that the MoE-paging PoC in §1.5 explicitly requires `--no-mmap`, because it needs to own expert residency itself rather than letting the OS guess.

**Tag: PROVEN. Applicability: ✅ Today (already on).**

### 3.3 Unified memory: the actual 24 GB budget

This is the constraint that decides your model list.

On Apple Silicon the CPU and GPU share one pool, so there is no host↔device copy — which is why MoE offload-to-CPU (§1.4b) buys nothing here. But the GPU cannot address *all* of it: macOS enforces a **wired/VRAM limit**, conventionally around **65–75% of physical RAM** by default, adjustable via the `iogpu.wired_limit_mb` sysctl. On a 24 GB Mac that is roughly **15.5–18 GB addressable by the GPU**, with the remainder for the OS, Ollama itself, the Tauri app, and everything else you have open.

Sanity-check the §1.3 table against that ceiling:

| Model | On disk | Fits under ~16–18 GB with an 8 K KV cache? |
| --- | --- | --- |
| `gemma4:12b` (dense) | 7.6 GB | Comfortably |
| `gpt-oss:20b` | 14 GB | **Yes**, with real headroom |
| `granite4.1:30b` | 17 GB | Marginal |
| `gemma4:26b` | 18 GB | **Marginal** — likely needs the wired limit raised |
| `qwen3-coder:30b` | 19 GB | **Over budget** on 24 GB |
| `nemotron-3.5-lightning:30b` | 25 GB | No |

Overflow does not fail cleanly — it spills to swap and throughput falls off a cliff. `ollama ps` reports the CPU/GPU split per loaded model ([Ollama FAQ](https://docs.ollama.com/faq)), and `run_bench.py` already samples it, so the harness will tell you when a model has fallen off the GPU. **Watch that column: a bench arm that quietly ran 40% on CPU is not a comparable arm.**

### 3.4 KV cache: the other RAM consumer

```
KV bytes  =  2 (K and V) · n_layers · n_kv_heads · head_dim · seq_len · bytes_per_elem
```

For **Qwen3-30B-A3B** (48 layers, **4** KV heads via GQA, head_dim 128) at f16:

```
2 · 48 · 4 · 128 · 2 bytes = 98,304 B/token ≈ 96 KiB/token
```

| `num_ctx` | KV @ f16 | @ q8_0 | @ q4_0 |
| --- | --- | --- | --- |
| 4,096 | 0.38 GiB | 0.19 GiB | 0.09 GiB |
| **8,192** (your default) | **0.75 GiB** | 0.38 GiB | 0.19 GiB |
| 32,768 | 3.0 GiB | 1.5 GiB | 0.75 GiB |
| 131,072 | 12.0 GiB | 6.0 GiB | 3.0 GiB |

**Conclusion for the curator: your KV cache is a rounding error.** At `num_ctx 8192` it costs under a gigabyte. GQA (4 KV heads instead of 32) already bought you the 8× that KV quantization would buy again. Do **not** spend effort on KV quantization or eviction schemes (H2O/SnapKV/StreamingLLM) — they solve a long-context problem you do not have. The one thing to check: `OLLAMA_NUM_PARALLEL` multiplies the KV allocation by the number of concurrent slots, and `OLLAMA_CONTEXT_LENGTH` defaults to **4096** server-side (your per-request `num_ctx: 8192` overrides it) ([Ollama FAQ](https://docs.ollama.com/faq)). Ollama sets `OLLAMA_KV_CACHE_TYPE` to `f16` by default and enables flash attention automatically where supported; quantized KV requires flash attention.

---

## 4. Depth and width skipping

### 4.1 Mixture-of-Depths

MoD applies the MoE routing trick along the **sequence** axis instead of the expert axis. Each block gets a router that scores every position; only the **top-k positions** (k fixed *a priori*, e.g. 12.5% of the sequence) enter that block's attention+MLP, and the rest pass through the residual connection untouched. Because k is static, the tensor shapes are known and the computation graph stays static despite the dynamism. Reported: matches baseline quality at equal FLOPs/wall-clock while using a fraction of the FLOPs per forward pass, and **upwards of 50% faster** post-training sampling ([arXiv 2404.02258](https://arxiv.org/abs/2404.02258)).

The structural problem MoD has to solve: top-k over a sequence is **non-causal** — you cannot know a token's rank among future tokens during autoregressive generation. MoD trains an auxiliary per-token predictor to make the routing decision causally at sampling time.

**This is an architecture, not an inference trick.** You cannot apply MoD to an existing checkpoint; a model is either trained with it or not. No mainstream open weights ship it. **Tag: EMERGING. Applicability: 🔴.**

Adjacent 2025–26 work in the same vein — Router-Tuning/MindSkip ([arXiv 2410.13184](https://arxiv.org/html/2410.13184)), Mixture-of-Recursions ([OpenReview](https://openreview.net/pdf?id=YtQtGsNr64)), residual-gate layer skipping ([arXiv 2510.13876](https://arxiv.org/pdf/2510.13876)), LiteStage ([arXiv 2510.14211](https://arxiv.org/pdf/2510.14211)), TIDE per-token early exit ([arXiv 2603.21365](https://arxiv.org/pdf/2603.21365)) — is all fine-tune-or-retrain territory.

### 4.2 LayerSkip / early exit / self-speculative decoding

**LayerSkip** (ACL 2024) trains with layer dropout + a shared early-exit LM head, so the model can exit at layer `j < L` and still emit a usable token. The elegant part: instead of accepting the degraded early-exit token, use the first `j` layers as their **own draft model** and verify with the remaining `L − j` layers — the draft and target share weights *and* share the KV cache, so self-speculation costs no extra memory. Integrated into HF `transformers` (Nov 2024), torchtune (Dec 2024) and `trl` (Mar 2025) ([repo](https://github.com/facebookresearch/LayerSkip)).

Requires a LayerSkip-trained checkpoint. Not a GGUF feature, not in Ollama. **Tag: PROVEN (as research + HF support). Applicability: 🟠 → 🔴 for this stack.**

### 4.3 Draft-model speculative decoding — what Ollama actually exposes

This one *is* shipping, and it's worth knowing precisely what exists so you can correctly decline to use it.

**The math.** A small draft model proposes `γ` tokens; the target model verifies all `γ+1` positions in **one forward pass**; a modified rejection-sampling rule accepts the longest correct prefix and guarantees the output distribution is *identical* to the target's. You trade FLOPs (which decode has spare) for bandwidth reads (which decode is starved of). Net win iff acceptance rate is high enough to amortise the draft's cost — the rule of thumb in the field is ~70%+ acceptance to see real gains, below which you go *slower* than baseline.

**llama.cpp:** `llama-server` supports a draft model, with `--draft-max` / `--draft-min` bounding the speculation window; the 2026 CLI rework moved these under a `--spec-` prefix (`--spec-draft-model`) ([docs/speculative.md](https://github.com/ggml-org/llama.cpp/blob/master/docs/speculative.md)).

**Ollama:** a **`DRAFT <path>` directive in the Modelfile** pairs a target with a drafter, plus `--quantize-draft` on `ollama create` so the drafter inherits your quantization. The parser rejects a DRAFT that points at the same path as FROM. Release notes confirm the plumbing is live and being tuned: v0.32.4 "Quantize draft-model output heads at the requested type when creating speculative-decoding drafts"; v0.32.6 "**Qwen3.5 is faster on Apple GPUs: the MLX engine now uses the model's MTP head for speculative decoding automatically**"; v0.32.10 changed the default `repeat_penalty` to 1.0 "matching other engines and speeding up speculative decoding" ([v0.32.4](https://github.com/ollama/ollama/releases/tag/v0.32.4), [v0.32.6](https://github.com/ollama/ollama/releases/tag/v0.32.6), [releases](https://github.com/ollama/ollama/releases)).

**MTP (multi-token prediction)** is the better version: instead of a separate draft model, the target model carries extra prediction heads trained to guess tokens `t+2, t+3…`. Zero extra weights to load, near-perfect distribution match. Qwen3-Next was pretrained with MTP and vLLM supports it natively ([vLLM blog](https://vllm.ai/blog/2025-09-11-qwen3-next)); Ollama's MLX engine now uses a model's MTP head automatically where present.

**Why you should still ignore it:**
1. Decode is ~10% of your token budget (§0). A 2× decode speedup is a **<5% end-to-end** win.
2. Your generation is **grammar-constrained** (`format: <schema>`). Grammar constraints must be applied to the draft *and* the target, and doing multi-token grammar checking is hard — "an exponential number of states that need precomputing" — while llama.cpp's grammar implementation already does runtime checking on all tokens with "significant overhead" ([DeepWiki: grammar & structured output](https://deepwiki.com/ggml-org/llama.cpp/7.3-grammar-and-structured-output)). Constrained decode + speculation is where acceptance rates go to die.
3. A drafter costs RAM you do not have.

**Tag: PROVEN. Applicability: ✅ Today — but low value for *this* workload.**

---

## 5. Static shrinking: the baseline everything must beat

*(Detailed quantization and pruning findings — see the dedicated section below.)*

---

## 6. Genuinely new in 2026

### 6.1 Sparse attention for long context

**DeepSeek Sparse Attention (DSA)**, shipped in V3.2-Exp, inserts a two-stage attention path: a lightweight **"lightning indexer"** — few heads, FP8, so its cost is negligible against dense attention — scores every context token, and full attention then runs over only the **top-k = 2048** selected KV entries. Inference cost scales close to linearly rather than quadratically in context length. DeepSeek cut API prices accordingly: 128 K-context input from **$2.30 → $0.30 per million tokens** (~3–6× at long context) at benchmark parity ([MarkTechPost](https://www.marktechpost.com/2025/09/30/deepseek-v3-2-exp-cuts-long-context-costs-with-deepseek-sparse-attention-dsa-while-maintaining-benchmark-parity/); [DeepLearning.AI](https://www.deeplearning.ai/the-batch/deepseek-v3-2-exp-streamlines-processing-using-a-lightning-indexer/); [Red Hat / vLLM](https://developers.redhat.com/articles/2025/10/03/deepseek-v32-exp-vllm-day-0-sparse-attention-long-context-inference)).

**Relevance to you: near zero, and this is worth saying loudly.** Sparse attention attacks the O(L²) term. At L ≈ 4,000 with GQA, attention is a small fraction of your prefill cost; the FFN GEMMs dominate. Sparse attention pays off at 100 K+, not at 4 K. **Tag: PROVEN (in DeepSeek's own serving). Applicability: 🔴 for the curator.**

### 6.2 Hybrid / linear attention architectures

The 2026 consensus, per [mlabonne's Qwen3.5 write-up](https://huggingface.co/blog/mlabonne/qwen35), is that "nobody agrees on attention anymore":

- **Qwen3-Next / Qwen3.5** — **Gated DeltaNet** (linear attention) in a **3:1 ratio** with gated full attention; in Qwen3-Next-80B-A3B that is 48 layers = 12 repeats of [DeltaNet, DeltaNet, DeltaNet, Attention], so 36 linear + 12 softmax layers. Expert count raised **128 → 512**, giving **~3.7% of parameters active per token**; trained with MTP ([DeepLearning.AI](https://www.deeplearning.ai/the-batch/alibabas-new-model-uses-hybrid-attention-layers-and-a-sparse-moe-architecture-for-speed-and-performance/); [vLLM](https://vllm.ai/blog/2025-09-11-qwen3-next); [Bojie Li](https://01.me/en/2025/09/qwen3-next/)).
- **Qwen3.5-397B-A17B** (released 2026-02-16), **Kimi K2.5** and **GLM-5** on MLA, GLM-5 additionally with DSA, **MiniMax M2.5** deliberately retaining full MHA "for reliability".

The direction of travel is **ever-sparser MoE** (3–4% active) plus **cheaper attention**. Both trends are good for you *if* they reach sizes that fit 24 GB, because both reduce bytes-per-token without reducing knowledge. Watch for a ~20–26 GB-class hybrid MoE. **Tag: PROVEN (models exist). Applicability: ✅ when a size fits.**

### 6.3 Metal / MLX kernel work — the quiet, real win

This is where 2026 progress actually lands on your machine.

- **MLX `gather_qmm` batched kernel** (merged 2025-04-17) fused quantized MoE expert matmuls. Prompt-processing throughput: **Mixtral 8×7B 189 → 590 tok/s** at ~500-token prompts and **196 → 681 tok/s** at ~6000 tokens; Qwen 1.5 2.7B **1,239 → 2,213 tok/s** ([MLX PR #2078](https://github.com/ml-explore/mlx/pull/2078)). Note these are **prefill** numbers — precisely your bottleneck.
- **Ollama v0.32.4** — "Fixed Qwen3 MoE decoding for differently-quantized experts, plus faster packed gate/up projection (**~4–9% on M5 Max**)" ([src](https://github.com/ollama/ollama/releases/tag/v0.32.4)).
- Ollama ships MLX variants of many tags (`gemma4:26b-mlx`, `qwen3.6:35b-mlx`, `nemotron-3.5-lightning:30b-mlx`), which route to the MLX engine on Apple GPUs rather than llama.cpp/Metal.

**Actionable: benchmark the `-mlx` tag against the default GGUF tag of the same model.** It is a one-word change in `--model` and it is the highest-value, lowest-effort experiment in this entire document.

**Tag: PROVEN. Applicability: ✅ Today.**

### 6.4 MoE on the Apple Neural Engine

**NPUMoE** (Benazir & Lin, University of Virginia, 2026-04-20) adapts dynamic MoE routing to the ANE's static-graph constraints: **static capacity tiers** for experts from offline routing calibration (trading padding against token dropping), **grouped expert execution** (fusing several experts into one compute graph to amortise launch overhead), and **load-aware residency** (hot expert groups on ANE, cold ones falling back to CPU/GPU). On **M2 Max and M2 Ultra**, with Phi-3.5-MoE, Phi-tiny-MoE and **Qwen3-30B-A3B**: **1.32–5.55× prefill latency speedup, 1.81–7.37× better energy, <1.1% accuracy loss** despite ~10–20% token dropping; 3.86× end-to-end over naive ([arXiv 2604.18788](https://arxiv.org/html/2604.18788v1)).

Explicitly a **prefill** technique — the authors note decode is memory-bound with too little parallelism to amortise CPU↔NPU sync. Which makes it, on paper, the single best-matched research result to the curator's actual workload. It is also a research prototype with no public runtime. **Tag: EMERGING. Applicability: 🔴 today — but this is the one to re-check in 12 months.**

---

## 7. Ranked recommendation for the NeuroVault curator

The governing constraint: **the app speaks only Ollama's HTTP API.** A model tag or an option in the JSON body costs nothing. A different runtime costs a backend rewrite plus a second thing to install, ship, and support on users' machines. That gap is worth roughly two tiers of theoretical speedup, so the ranking below is dominated by "can this be a string in a config file".

### Tier 1 — do this in the next sweep (pure config, no code)

1. **Add `gpt-oss:20b` as the MoE arm.** 14 GB, native MXFP4, MoE weights 90%+ of params, documented to run in 16 GB. It is the largest-capacity model that leaves real headroom under a 24 GB Mac's ~16–18 GB GPU budget, and it is the cleanest test of "does sparse-30B-class beat dense-12B-class on extraction". Second arm: **`gemma4:26b`** (18 GB, 4 B active) if `ollama ps` shows it staying on the GPU.
2. **Benchmark `-mlx` tags against GGUF tags for the same model.** `gemma4:26b-mlx` vs `gemma4:26b`, etc. MLX's fused quantized-MoE kernels showed 3× prompt-processing gains in their own PR, and prefill is ~90% of your token budget. One-word change in `--model`. Highest value-per-effort in this document.
3. **Keep a dense control arm** (`gemma4:12b`, 7.6 GB) in every sweep. Every claim in §1 is a *speed* claim; the curator's objective is quality per resident GB. A dense 12B that wins on extraction F1 at half the RAM ends the discussion.
4. **Instrument prefill and decode separately.** Record `prompt_eval_count`/`prompt_eval_duration` and `eval_count`/`eval_duration` from the Ollama response, not just wall-clock. Right now the harness cannot tell you *which* phase a model is losing in, which means it cannot tell you which of these techniques would help. This is a small `run_bench.py` change and it makes every future decision evidence-based.
5. **Confirm `OLLAMA_NUM_PARALLEL=1`** for the sweep. Parallel slots each allocate their own KV cache; on a 24 GB machine running an 18 GB model, an unnoticed default of >1 is the difference between GPU-resident and swapping.

### Tier 2 — worth an experiment, some effort

6. **Raise `iogpu.wired_limit_mb`** if and only if `ollama ps` shows an 18–19 GB model partly on CPU. This converts `gemma4:26b` / `qwen3-coder:30b` from "doesn't fit" to "fits", which is the difference between a usable arm and a wasted night. Reversible, no code.
7. **Push `num_ctx` down, not up.** Your units are ~2–4 k tokens plus a ~700-token template. `num_ctx: 8192` is right; there is no reason to go higher, and every KB of KV cache is a KB not spent on experts. Consider a per-unit `num_ctx` sized to the actual prompt if you ever go bigger.
8. **A `llama-server` side-experiment** (not a product change): if a 30B-class MoE is clearly better on quality but doesn't fit, the MoE-paging PoC from llama.cpp Discussion #23324 is the only technique in this document that genuinely converts RAM into time on your hardware — 30B-A3B-Q6_K at 18.9 GiB wired and 29 tok/s on an M3 Pro, or 6.3 GiB and 12 tok/s. For a batch job that runs while you sleep, 12 tok/s is fine. Run it as `llama-server` against the same OpenAI-compatible endpoint, measure once, and only then decide whether it's worth a product-level runtime discussion.

### Tier 3 — know it exists, don't build on it

9. **Speculative decoding / MTP.** Real and shipping in Ollama (`DRAFT` directive, automatic MTP on MLX). But it accelerates ~10% of your tokens, costs RAM for a drafter, and interacts badly with grammar-constrained JSON output. Revisit only if the curator ever generates long-form text.
10. **`--n-cpu-moe` / `--cpu-moe`.** Designed for discrete-GPU machines where "move it to host RAM" frees VRAM. On unified memory it mostly relocates the matmul to slower silicon. Expect a regression; test only to confirm.
11. **KV cache quantization, H2O/SnapKV/StreamingLLM.** Solving a long-context RAM problem you do not have — your KV cache is <1 GiB at `num_ctx 8192`.

### Ignore for two years

12. **TEAL / CATS / Deja Vu / PowerInfer / ReLUfication.** Needs ReLU-ish models, custom sparse kernels for your accelerator, and batch-1 decode. You have none of the three, upstream llama.cpp computes FFNs densely by design, and "Sparsing Law" says SwiGLU models get *denser* with more training. The most interesting family in this document and the least reachable.
13. **Mixture-of-Depths, LayerSkip, early exit.** Architecture/training-time decisions. No mainstream open checkpoint ships them; you cannot retrofit them onto a GGUF.
14. **Sparse attention (DSA/NSA).** Pays off at 100 K+ context. Yours is 8 K.
15. **Expert prefetch research (SpecPrefetch, two-tier caches).** Even a 96%-accurate predictor bought only ~14% TPOT. The ceiling on this whole line is low relative to just fitting the model.

### The two things to re-check in ~12 months

- **A hybrid-attention, ultra-sparse MoE in the 12–18 GB class.** The Qwen3-Next line (512 experts, 3.7% active, 3:1 linear:full attention, MTP) is the right architecture; it just hasn't shipped at a size that fits 24 GB. When it does, it dominates every option above.
- **MoE expert paging landing upstream** in llama.cpp or MLX (Discussion #23324 / mlx-lm issue #1438). If either merges and Ollama picks it up, "run a 30B MoE in 8 GB" becomes an option string rather than a fork, and Tier 2 item 8 promotes to Tier 1.

### One-line answer to the owner's question

> You cannot call "only part" of a dense model on this stack — every training-free technique that does so (Deja Vu, TEAL, PowerInfer) needs sparse kernels nobody has written for Metal and a ReLU-era model nobody ships. **But you can buy a model that was *built* to call only part of itself.** That is MoE, it works on Ollama today with zero code, and `gpt-oss:20b` at 14 GB gives you ~21 B of parameters at ~3.6 B of per-token cost. The remaining lever is that MoE saves compute, not memory — so the honest question for the curator bench is not "how do I run a 30 B model" but "does a 20 B sparse model actually extract better than a 12 B dense one at the same 14 GB". Measure that first; everything else in this document is downstream of the answer.

---

## Appendix: source index

**MoE fundamentals** — [IBM: What is MoE](https://www.ibm.com/think/topics/mixture-of-experts) · [Expert-Choice routing (NeurIPS 2022)](https://papers.neurips.cc/paper_files/paper/2022/file/2f00ecd787b432c1d36f3de9800728eb-Paper-Conference.pdf) · [Load-balancing evolution review](https://huggingface.co/blog/NormalUhr/moe-balance) · [Auxiliary-loss-free balancing (arXiv 2408.15664)](https://arxiv.org/pdf/2408.15664) · [Cerebras MoE math](https://www.cerebras.ai/blog/moe-guide-calculator)

**Models** — [Qwen3-30B-A3B card](https://huggingface.co/Qwen/Qwen3-30B-A3B) · [ollama/gpt-oss](https://ollama.com/library/gpt-oss) · [ollama/gemma4](https://ollama.com/library/gemma4) · [ollama/qwen3-coder](https://ollama.com/library/qwen3-coder) · [ollama/granite4.1](https://ollama.com/library/granite4.1) · [ollama/nemotron-3.5-lightning](https://ollama.com/library/nemotron-3.5-lightning)

**Expert offload / caching** — [Mixtral-offloading (arXiv 2312.17238)](https://arxiv.org/pdf/2312.17238) · [Caching/prefetch analysis (arXiv 2511.05814)](https://arxiv.org/pdf/2511.05814) · [llama.cpp #20757 two-tier expert cache](https://github.com/ggml-org/llama.cpp/issues/20757) · [llama.cpp #23324 MoE disk paging PoC](https://github.com/ggml-org/llama.cpp/discussions/23324) · [MoE offload guide](https://huggingface.co/blog/Doctor-Shotgun/llamacpp-moe-offload-guide) · [`--n-cpu-moe` explained](https://aliteq.com/n-cpu-moe-llama-cpp-what-it-actually-does) · [mlx-lm #1438 expert streaming](https://github.com/ml-explore/mlx-lm/issues/1438) · [SpecPrefetch (arXiv 2607.24787)](https://arxiv.org/abs/2607.24787)

**Activation sparsity** — [Deja Vu (arXiv 2310.17157)](https://arxiv.org/abs/2310.17157) · [PowerInfer-2 (arXiv 2406.06282)](https://arxiv.org/pdf/2406.06282) · [TEAL (arXiv 2408.14690)](https://arxiv.org/html/2408.14690v3) · [TEAL blog](https://www.together.ai/blog/teal-training-free-activation-sparsity-in-large-language-models) · [ProSparse (arXiv 2402.13516)](https://arxiv.org/abs/2402.13516) · [Sparsing Law (arXiv 2411.02335)](https://arxiv.org/abs/2411.02335) · [SparseInfer (arXiv 2411.12692)](https://arxiv.org/pdf/2411.12692) · [WiSparse (arXiv 2602.14452)](https://arxiv.org/pdf/2602.14452) · [llama.cpp #4559 on PowerInfer](https://github.com/ggml-org/llama.cpp/issues/4559)

**Storage offload** — [LLM in a flash (arXiv 2312.11514)](https://arxiv.org/pdf/2312.11514) · [Apple ML Research page](https://machinelearning.apple.com/research/efficient-large-language) · [ActiveFlow (arXiv 2504.08378)](https://arxiv.org/abs/2504.08378)

**Depth skipping / speculation** — [Mixture-of-Depths (arXiv 2404.02258)](https://arxiv.org/abs/2404.02258) · [LayerSkip](https://github.com/facebookresearch/LayerSkip) · [Router-Tuning (arXiv 2410.13184)](https://arxiv.org/html/2410.13184) · [llama.cpp speculative.md](https://github.com/ggml-org/llama.cpp/blob/master/docs/speculative.md) · [Ollama releases](https://github.com/ollama/ollama/releases)

**2026 architectures** — [DSA / V3.2-Exp](https://www.marktechpost.com/2025/09/30/deepseek-v3-2-exp-cuts-long-context-costs-with-deepseek-sparse-attention-dsa-while-maintaining-benchmark-parity/) · [Qwen3-Next (vLLM)](https://vllm.ai/blog/2025-09-11-qwen3-next) · [Qwen3.5 architecture survey](https://huggingface.co/blog/mlabonne/qwen35) · [MLX gather_qmm PR #2078](https://github.com/ml-explore/mlx/pull/2078) · [NPUMoE (arXiv 2604.18788)](https://arxiv.org/html/2604.18788v1) · [Sparse ternary GEMM on Apple Silicon (arXiv 2510.06957)](https://arxiv.org/pdf/2510.06957)

**Runtime / ops** — [Ollama FAQ](https://docs.ollama.com/faq) · [Ollama v0.32.4](https://github.com/ollama/ollama/releases/tag/v0.32.4) · [Ollama v0.32.6](https://github.com/ollama/ollama/releases/tag/v0.32.6) · [Grammar & structured output in llama.cpp](https://deepwiki.com/ggml-org/llama.cpp/7.3-grammar-and-structured-output) · [Prefill vs decode](https://towardsdatascience.com/prefill-is-compute-bound-decode-is-memory-bound-why-your-gpu-shouldnt-do-both/)
