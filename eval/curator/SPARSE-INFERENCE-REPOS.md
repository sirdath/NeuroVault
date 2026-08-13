# Sparse & Offloaded Inference — The Code

**Repo survey companion to `SPARSE-INFERENCE-RESEARCH.md`. That document covered the *techniques*; this one covers the *software you could actually install*.**

Date: 2026-08-13 · Status: research only — nothing installed, nothing run, Ollama untouched · Target: **24 GB Apple Silicon Mac, Ollama HTTP API on 127.0.0.1:11434, nightly prefill-dominated batch extraction**

All star counts, commit dates and issue states were fetched on 2026-08-13 and will drift.

---

## How to read this

The research doc established the governing fact: **the curator's token ledger is ~10:1 prefill:decode.** Everything below is judged against that, not against the tok/s number on the repo's front page.

Verdicts:

| | |
| --- | --- |
| **USE NOW** | Installable today, helps this workload, fits the Ollama-only constraint or is a legitimate side-experiment |
| **WATCH** | Real project, real trajectory, not yet worth the integration cost — re-check on a named trigger |
| **IGNORE** | Doesn't run on this hardware, doesn't help this phase, or isn't maintained |

---

## 0. Two findings that reframe the whole survey

### 0.1 The SSD-expert-streaming genre is a *decode* trick, and prefill is where it degenerates

This is the single most important analytical point in this document, and no README states it.

Every project in §7 (flash-moe, Mference, SwiftLM, mlx-moe, expertcache) works the same way: keep the dense trunk resident, and for each token fetch only the `k` experts the router selected. At **batch size 1 during decode** that is a genuine 10–100× reduction in bytes touched, because one token routes to `k` of `N` experts.

Prefill is not batch size 1. A 4,000-token prompt is 4,000 routing decisions per layer, each choosing a different `k`-subset. **The union of experts touched across the prefill batch rapidly approaches all `N` of them.** With 128 experts, top-8, and a few thousand tokens, you will touch essentially every expert in every layer — so "stream only what you need" collapses back into "stream the entire model", once, through the SSD, per prefill.

Which is why the honest numbers in §7 are decode numbers. Where a project publishes a prefill figure it is either (a) compared against its own slower baseline rather than against a resident model, or (b) quietly reliant on the OS page cache holding the whole expert file after the first pass — which only works if the file fits in RAM, which is the thing you were trying to avoid.

**Consequence:** expert streaming converts a "doesn't fit" into a "fits and runs slowly." It does not make a fitting model faster, and it is at its *weakest* on precisely the phase that is 90% of this job. It stays on the list only as an answer to the question "can I run a 30B-class model I currently cannot load at all", never as a speed optimization.

### 0.2 The search results for this topic are heavily contaminated by generated content

Worth recording, because it nearly produced a wrong answer here.

A search for ktransformers + Apple Silicon returns a DEV.to article asserting that KTransformers has "first-class Metal Performance Shaders (MPS) support" and that "with the `--backend metal` flag, it offloads matrix multiplications to the Apple Neural Engine." **All of this is fabricated.** The KTransformers README contains no occurrence of macOS, Mac, Apple, Metal, MPS or M-series; the 2026 Q1 roadmap ([issue #1779](https://github.com/kvcache-ai/ktransformers/issues/1779)) mentions no Apple work; the supported backends are CUDA, ROCm, Intel Arc, Ascend NPU and x86 CPU. The article also confuses MPS (a GPU framework) with the ANE (a separate coprocessor), which is the tell.

The same genre — `aliteq.com`, `openclawdc.com`, `localaimaster.com`, `runaihome.com`, `qwe.edu.pl`, `llmpicker.blog` — ranks highly on every query in this space and confidently invents flags, version numbers and benchmark tables. **Rule for any follow-up: a hardware-support claim counts only if it appears in the repo's own README, docs, issues, or CI matrix.** Every support claim in this document was checked that way, and where a repo is silent, this document says "not mentioned" rather than "unsupported."

---

## 1. ktransformers — kvcache-ai

[github.com/kvcache-ai/ktransformers](https://github.com/kvcache-ai/ktransformers) · **19.2k ★**

**(a) Mechanism.** Heterogeneous CPU-GPU MoE inference: the dense trunk, attention and KV cache stay on the GPU while routed-expert FFN weights live in CPU DRAM and are computed *in place on the CPU* using hand-written AMX / AVX-512 / AVX2 kernels (the `kt-kernel` subproject), with NUMA-aware placement. Nothing is decided per-token by a predictor — the split is static, chosen at load time by which tensors you assign where. This is the "DeepSeek-671B on one workstation GPU" story, and it works because a Xeon with AMX can do the expert GEMMs fast enough to keep a single GPU fed.

**(b) Hardware reality.** **CUDA-first, x86-only, no Apple support of any kind.** Verified three ways: the README has zero mentions of macOS/Apple/Metal/MPS; the 2026 Q1 roadmap prioritizes AMD, NVIDIA FP8-MoE for Ampere, and Intel NPU, with no Apple line item; the entire performance story depends on Intel AMX, an x86 instruction-set extension that does not exist on ARM. The published reference config is `8×L20 GPU + Xeon Gold 6454S`. See §0.2 for the blog post that claims otherwise.

**(c) Maturity.** Excellent, for its target platform. 19.2k stars, v0.6.1 (2026-04-30), day-0 support cadence through 2026 (Kimi-K2.5 Jan, GLM-5 Feb, MiniMax-M2.5 Feb, DeepSeek-V4-Flash May, GLM-5.2 Jun, MiniMax-M3 Jun), multi-institution backing, named maintainers per roadmap item. Not a single-maintainer risk.

**(d) Integration cost.** Infinite — it does not run on the hardware.

**(e) Benefit for this job.** Zero.

**(f) Verdict: IGNORE.** The best-engineered project in this survey and it cannot execute a single instruction on an M-series Mac; its core advantage (AMX expert kernels) is architecturally unavailable on ARM.

---

## 2. PowerInfer / PowerInfer-2 — SJTU-IPADS

[github.com/SJTU-IPADS/PowerInfer](https://github.com/SJTU-IPADS/PowerInfer) · **9.7k ★** · now under the **Tiiny-AI** org

**(a) Mechanism.** Exploits a power-law in neuron activation frequency: a small set of "hot" neurons fires for nearly every token and is pinned in GPU memory, while the "cold" majority is input-specific and left on the CPU, computed sparsely only when the online predictor says it will fire. PowerInfer-2 extends this to phones by decomposing matmuls into neuron *clusters* — large hot clusters dispatched to the NPU as dense work, small cold clusters to the CPU as sparse work.

**(b) Hardware reality — the honest version.** The README's own words: **"Apple M Chips (CPU only) on macOS. (As we do not optimize for Mac, the performance improvement is not significant now.)"** Metal support has been listed as "coming soon" since the 2023 launch and has not arrived. So on this Mac you would run a CPU-only fork of an old llama.cpp with no GPU acceleration — strictly worse than stock Ollama. Compounding this: the whole method needs **ReLU-family activations**, and the supported-model list is exactly that museum — Falcon-40B, Llama2, ProSparse-Llama2, ReluLLaMA 7B/13B/70B, Bamboo-7B, TurboSparse-Mixtral-47B. Not one model the curator would consider.

**(c) Maturity.** Repository transferred to **Tiiny-AI** and the project has pivoted commercial — the headline news is the "Tiiny AI Pocket Lab" hardware device at CES 2026 (2026-01-05), running GPT-OSS-120B int4 at 20 tok/s. Last commit **2026-05-11**, and it is `Update README.md (#280)`. Open issues sit unanswered (e.g. #277, #278 from March 2026). The pattern is unambiguous: the open-source repo is now a marketing artifact for a hardware product.

**(d) Integration cost.** Different runtime entirely, and a stale llama.cpp fork at that — it lags upstream badly on model support, so you'd lose Gemma 4, Qwen 3.x and gpt-oss to gain nothing.

**(e) Benefit.** Negative. CPU-only on a Mac, ReLU-only models, dead codebase.

**(f) Verdict: IGNORE.** The README itself tells you not to use it on a Mac, and the project has become a hardware company.

---

## 3. llama.cpp — ggml-org

[github.com/ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp) · the substrate under Ollama

**(a) Mechanism (the relevant options).**
- `--override-tensor` / `-ot` — regex-match tensor names and pin them to a named backend. The general primitive; e.g. `-ot '\.ffn_.*_exps\.weight=CPU'`.
- `--cpu-moe` / `-cmoe` — sugar for the above across all routed experts.
- `--n-cpu-moe N` / `-ncmoe N` — same for the top `N` layers, counting **downward from the highest-numbered layer**.
- `-b` / `-ub` (batch / micro-batch) — **the one that actually matters here.** Raising the micro-batch to 1024–2048 gives the Metal matmul kernels enough parallelism to run near peak during prefill. This is a prefill knob on a prefill-dominated job.
- `--spec-draft-model` etc. — speculative decoding, post-2026 CLI rework, moved under a `--spec-` prefix.
- mmap is on by default; the disk-paging PoC below requires `--no-mmap` precisely because it wants to own expert residency itself.

**(b) Hardware reality.** Metal backend is first-class and is the recommended path on Apple Silicon. But note the asymmetry in what the *expert-offload* flags do here: on a discrete-GPU box, `-ncmoe` moves weights out of VRAM into host RAM and frees real VRAM. On unified memory there is one pool — you free nothing and merely relocate the matmul to slower silicon. Expect a regression, as the research doc concluded. Release activity as of 2026-08-13 is at `b10405` with multiple builds per day; recent Metal/Apple-side work is incremental rather than a sparse-kernel landing. There is no upstream activation sparsity — llama.cpp computes FFNs densely by design.

**(c) Maturity.** The healthiest project in the survey. Continuous releases, huge contributor base, no single-maintainer risk.

**(d) Integration cost — and the Ollama gap, checked properly.** This is the actionable part. **Ollama exposes almost none of the above.** Both requests are open with *no maintainer response*:
- [ollama#16515](https://github.com/ollama/ollama/issues/16515) — "Support for Tensor Overrides (`--override-tensor`) and Split/Sharded Models" — opened 2026-06-04, open, unassigned, no maintainer comment.
- [ollama#11772](https://github.com/ollama/ollama/issues/11772) — "use cpu to offload moe weights to reduce the VRAM usage", referencing the upstream llama.cpp PR — open, unassigned, no maintainer comment, nothing equivalent shipped.

What Ollama *has* shipped on the Apple/MoE axis is engine-side and automatic rather than user-tunable: the MLX engine now applies **mixed quantization across dense and routed MoE layers** (keeping the tied output head and router at source precision, selectively promoting sensitive expert down-projections), plus **fused gate/up projections**, **sorted GatherMM/GatherQMM for larger prefills**, and **cache-backed 512-token prefill chunks** ([Ollama MLX blog](https://ollama.com/blog/mlx); Aug 2026 notes). Those are real prefill wins you get for free by staying on Ollama and using `-mlx` tags — but they are *chosen for you*, and the 512-token prefill chunking in particular is a fixed policy where `llama-server` would let you set `-ub 2048`.

- **The MoE disk-paging PoC** ([discussion #23324](https://github.com/ggml-org/llama.cpp/discussions/23324)) is still **not merged**. The implementation lives in a personal fork (`kisasexypantera94/llama.cpp` PR #2), not an upstream PR; latest substantive comment 2026-07-27; no maintainer response. Flags proposed: `--moe-n-slots`, `--moe-n-layers`, plus mandatory `--no-mmap` and `--no-warmup`. Its Apple-Silicon result stands — Qwen3-30B-A3B-Q6_K at **13 tok/s on an M1 Pro 16 GB**, a machine that cannot otherwise load the model.

**(e) Benefit.** The expert-offload flags: none-to-negative on unified memory. The **micro-batch flag: plausibly the largest free prefill win available**, and it is invisible from Ollama.

**(f) Verdict: USE NOW — but for `-ub`, not for `-ncmoe`.** Run `llama-server` once as a measurement instrument to find out how much prefill throughput Ollama's fixed 512-token chunking is costing you; ignore the MoE-offload flags entirely on this machine.

---

## 4. AirLLM — lyogavin

[github.com/lyogavin/airllm](https://github.com/lyogavin/airllm) · **30.9k ★**

**(a) Mechanism.** Layer-by-layer weight streaming. The model is pre-split into per-layer shards on disk; at inference exactly **one transformer layer is resident at a time**, loaded, executed, discarded. VRAM scales with the largest single layer, not the model. No routing, no prediction, no cleverness — it is a for-loop over layers with a disk read in the body.

**(b) Hardware reality.** Genuinely supports Apple Silicon, and via **MLX** rather than the PyTorch MPS fallback — README: *"only Apple silicon is supported"* for the Mac path, requiring `mlx` and `torch` installed, and *"Just install airllm and run the code the same as on linux."* So unlike §1 and §2, this one really does run on the target machine.

**(c) Maturity.** 30.9k stars is the highest in this survey and is mostly a viral-headline artifact ("70B on a 4GB GPU"). But it is not abandoned: v3.0 in 2026-06 and Kimi-K3 support in 2026-07, 317 commits. Effectively single-author.

**(d) Integration cost.** Python library, no OpenAI-compatible server, no Ollama compatibility. You would write the serving layer yourself.

**(e) Benefit — the real tok/s, which the README conspicuously omits.** The README publishes VRAM tables and a "3× speed up" from block-wise quantization but **no absolute throughput figure anywhere.** Independent reports put it at **0.5–2 tok/s** for a 70B on a 4 GB GPU, and community reports of **well under 1 tok/s** for larger models. The repo's own Kimi-K3 (2.8T) example is **292 seconds *per token*** on an RTX 6000 Ada. Now apply this document's §0.1: AirLLM streams *every* layer for *every* forward pass, so a 4,000-token prefill pays the full disk cost of the entire model — there isn't even a routing story to save it. A nightly sweep of ~100 units would not finish in a night. It would not finish in a week.

**(f) Verdict: IGNORE.** It converts a memory bottleneck into a disk bottleneck with no conditional computation at all, and the omission of tok/s from a 30.9k-star README is itself the finding.

---

## 5. mixtral-offloading — dvmazur

[github.com/dvmazur/mixtral-offloading](https://github.com/dvmazur/mixtral-offloading) · **2.3k ★**

**(a) Mechanism.** The canonical reference implementation of MoE expert caching. Two ideas: **mixed quantization via HQQ** (different bit-widths for attention vs expert layers, chosen so the split fits combined GPU+CPU memory), and **per-expert offloading with an LRU cache** — each expert is offloaded individually and pulled back to GPU only when routed to.

**(b) Hardware reality.** CUDA/Colab-oriented; built on HQQ and PyTorch CUDA paths. No Metal story.

**(c) Maturity — effectively dormant.** 86 commits total, 22 open issues, **no visible 2025 or 2026 activity**; the most recent issue traffic is early 2025 and consists largely of unanswered user questions. Not formally archived, which is worse than archived: it looks alive in search results and isn't. The most telling detail is that the README's headline second contribution, **speculative expert prefetching, is described in the paper and explicitly "not yet available in this repo"** — and never became available. The prefetching analysis everyone cites was done by *other* people against Mixtral, finding LRU hit rates of only ~40% at cache size 2 and ~60% at size 4.

**(d) Integration cost.** Research notebook. Not a server, not a library you'd ship.

**(e) Benefit.** None directly — Mixtral-8×7B is a 2023 model and the code targets it specifically.

**(f) Verdict: IGNORE the code, keep the paper.** Its value is as the citation that established LRU-over-experts; the ~60% hit-rate result (i.e. 40% of tokens stall) is the number that should keep expectations low for everything in §7.

---

## 6. DeepSpeed ZeRO-Inference / DeepSpeed-MII — Microsoft

[github.com/deepspeedai/DeepSpeed-MII](https://github.com/deepspeedai/DeepSpeed-MII) · **2.1k ★**

**(a) Mechanism.** ZeRO-Inference streams model weights layer-by-layer from CPU DRAM or NVMe into GPU memory, overlapping fetch with compute, so a single GPU can host a model far larger than its VRAM. MII wraps it with FastGen-era serving (blocked KV cache, continuous batching, Dynamic SplitFuse).

**(b) Hardware reality.** **Hard CUDA-only.** Documented requirement is NVIDIA compute capability **8.0+ (Ampere or newer), CUDA 11.6+, Ubuntu 20+**, with custom kernels shipped through the separate DeepSpeed-Kernels binary package. There is no CPU-only inference path worth using and no Apple path at all.

**(c) Maturity.** 241 commits, **198 open issues**, and the framing on the repo itself relegates ZeRO-Inference to **"MII Legacy"** — current v0.2 documentation foregrounds FastGen and does not highlight weight offload. Blog-post cadence trails off after early 2024. This is a datacenter-serving project that has moved on from the offload story.

**(d) Integration cost.** Not applicable.

**(e) Benefit.** Zero.

**(f) Verdict: IGNORE.** CUDA-only by construction, and the specific feature you'd want is self-labelled legacy.

---

## 7. MLX and the Apple-Silicon expert-streaming cluster

This is where 2026 actually happened for this hardware. Treat §7.1 as infrastructure and §7.2–§7.6 as a genre — six projects that appeared within months of each other, all doing the same thing, all reading the same Apple paper.

### 7.1 mlx / mlx-lm — Apple (ml-explore)

[github.com/ml-explore/mlx-lm](https://github.com/ml-explore/mlx-lm) · **6.6k ★**

**(a) Mechanism.** Not a sparsity technique — the Apple-native array framework and its LLM layer, with unified-memory-aware kernels. Its MoE relevance is the **fused batched quantized expert matmul** (`gather_qmm`), which turns a loop over selected experts into one kernel and disproportionately helps *prompt processing*.

**(b) Hardware reality.** Apple Silicon is the only target. This is the home team.

**(c) Maturity.** Apple's `ml-explore` org, 6.6k stars / 953 forks, continuous development. Lowest project risk in the survey.

**(d) Integration cost — the API question, answered.** `mlx-lm` **does ship an OpenAI-compatible HTTP server**: `mlx_lm.server --model <path>`, default **localhost:8080**, implementing `/v1/chat/completions` and `/v1/models`, accepting `temperature`, `top_p`, `top_k`, `min_p`, `repetition_penalty`, `logit_bias`, `logprobs`, and notably `draft_model` / `num_draft_tokens` for speculative decoding. The caveat is explicit and should be respected: **"The MLX LM server is not recommended for production as it only implements basic security checks."** Fine for a benchmark harness on loopback, not something to ship to users.

But the cheaper path already exists: **Ollama routes `-mlx` tags to the MLX engine**, so you get MLX's fused quantized-MoE kernels through the API the app already speaks, with zero new software.

**Expert streaming is requested and unanswered:** [mlx-lm#1438](https://github.com/ml-explore/mlx-lm/issues/1438), opened 2026-06-27, asks for lazy expert loading / SSD offload with optional prefetch, citing `mlx-moe` and `SwiftLM` as proof of feasibility and explicitly asking whether a PR would be welcome. **Still open, no maintainer response.** That silence is the WATCH trigger: if Apple accepts this, the entire §7.2–§7.6 cluster collapses into one supported feature and Ollama inherits it.

**(e) Benefit.** Real and already partly banked via Ollama's MLX engine — fused gate/up, sorted GatherQMM for larger prefills, mixed dense/MoE quantization.

**(f) Verdict: USE NOW, via Ollama's `-mlx` tags.** Direct `mlx_lm.server` only as a measurement instrument; watch #1438 as the signal that expert streaming is going mainstream.

### 7.2 Mference — NeelM0906

[github.com/NeelM0906/Mference](https://github.com/NeelM0906/Mference) · **91 ★** · MIT

**The one benchmarked on this exact hardware class.**

**(a) Mechanism.** Swift + Metal. Keeps the shared/dense core and the KV cache resident, then streams only the router-selected experts per token from SSD via `pread`, behind a **per-layer LFU cache** with a configurable slot count. For Qwen 3.6's linear-attention layers it replaces KV storage with a 2 MiB delta-rule state plus a 3-row convolution tail updated in place.

**(b) Hardware reality.** Apple Silicon only — arm64, macOS 15+, Metal 3, Swift 6.1+/Xcode 16.3+. Built for this machine, not ported to it.

**(c) Maturity.** 91 stars, 245 commits, small contributor set — **effectively single-author, and the headline claims are unreplicated.** Derived in part from TurboFieldfare (Apache-2.0).

**(d) Integration cost.** Ships a **loopback OpenAI-compatible server** (`MferenceServer`) that auto-selects each model's native chat dialect including Qwen ChatML with `<tool_call>`. So a bench arm is a base-URL swap. But it is a `swift build -c release` from source and a large model download — **both gated behind written approval**, and it is a *side-experiment only*: the app itself stays on Ollama.

**(e) Benefit — the numbers, on a 24 GB Mac.** Quoted for **Qwen 3.6 35B-A3B on a 24 GB M5**: **23.5–29.3 tok/s decode**, **2.20× faster long-prompt prefill (58.45s → 26.54s)**, footprint **~1.45 GB at the 16-slot profile**. And **Gemma 4 26B-A4B in ~2 GB, 31–35 tok/s decode on a 24 GB M5 Pro.** If that Gemma figure survives contact with reality it is the most consequential number in this survey — the research doc lists `gemma4:26b` at **18 GB on disk and "marginal, likely needs the wired limit raised"** on 24 GB. Two gigabytes instead of eighteen turns a marginal arm into a comfortable one.

Read the caveats with equal weight. The prefill claim is **against its own baseline**, not against resident Ollama, so it does not establish that streaming beats fitting — and §0.1 predicts prefill is exactly where this approach should struggle. The README also documents a real memory cliff: on the 24 GB M5, *"a 24-slot control warmup entered memory pressure and regressed sharply."* Only one model-owning process may run at a time. Byte-identical output is not guaranteed across MSL 3.2 vs 4.0 tensor paths — which matters for a `temperature: 0` grammar-constrained extraction bench where you want reproducibility.

**(f) Verdict: WATCH, with one high-value experiment (see Experiment 3).** The only project in the survey with published numbers on the owner's exact memory class, and the "26B in 2 GB" claim is either a genuine unlock or a measurement artifact — worth one night to find out which.

### 7.3 flash-moe — Anemll

[github.com/Anemll/flash-moe](https://github.com/Anemll/flash-moe) · **221 ★**

**(a) Mechanism.** Pure C / Objective-C / Metal, no Python in the inference binary. Dense attention weights and the shared expert stay resident as MLX 4-bit; the 209 GB of routed experts live on NVMe and only the **K=4 active experts per layer (~6.75 MB each)** are read per token via parallel `pread()` with GCD dispatch groups. Notably it **delegates caching to the OS page cache** rather than implementing its own — an honest simplification, and the reason it needs a lot of spare RAM to go fast.

**(b) Hardware reality.** Apple Silicon native, with Metal 4 **NAX** (neural accelerator) support on M5+ behind a `--nax` flag. Nicely honest about where NAX helps: *"LM head GEMM in isolation: 4.5x speedup (7ms vs 32ms)"* but *"single-token decode (M=1): FMA kernel already 1.4ms on M5 Max native — NAX adds tile padding overhead, no net gain."*

**(c) Maturity.** 221 stars, 151 commits, from the **Anemll** org (an established Apple-Neural-Engine LLM group), which is more credibility than the rest of §7 combined. Still a research engine.

**(d) Integration cost.** **CLI only — `./infer` and `./chat`, no HTTP server.** That alone disqualifies it as a bench arm without writing a serving shim. Model preparation is a five-step offline pipeline including a ~25-minute expert repack.

**(e) Benefit for this job.** The target is Qwen3.5-**397B**-A17B on an **M5 Max 128 GB**, at **12.9 tok/s** with a per-token breakdown that is the clearest illustration of §0.1 anywhere: expert SSD I/O **26.7 ms (35%)** versus expert *compute* **1.3 ms (2%)**. The arithmetic is free; the bytes are everything. Active RAM is only ~5.8 GB — but it leaves **~42 GB for page cache**, which a 24 GB machine does not have. The M3 Max 48 GB baseline manages **4.36 tok/s**. Scaled down to 24 GB with a fraction of the page cache, this is not a nightly-batch-viable configuration.

**(f) Verdict: WATCH.** The most technically impressive engine here and the wrong size class — its whole design assumes tens of gigabytes of spare page cache.

### 7.4 SwiftLM — SharpAI

[github.com/SharpAI/SwiftLM](https://github.com/SharpAI/SwiftLM) · **735 ★** · MIT

**(a) Mechanism.** Native MLX-Swift server. Two levers: **SSD expert streaming** from NVMe to GPU (self-described "10× speedup", inspired by flash-moe), and **TurboQuant KV cache compression** using 3-bit non-linear Lloyd-Max codebooks.

**(b) Hardware reality.** Apple Silicon M1+, macOS and iOS.

**(c) Maturity.** 735 stars, 687 commits, named engineer for the SSD rewrite, comprehensive benchmark scripts, an iOS companion app. The most *productized* of the cluster. Still small-team.

**(d) Integration cost.** **OpenAI-compatible REST on port 5413** (`--port` configurable) with `/v1/chat/completions`, `/v1/models`, `/health`; 50+ architectures including Gemma 4, Qwen 3.5/3, Mixtral, DeepSeek V3. Base-URL swap for a bench arm.

**(e) Benefit.** Headline numbers are on an **M5 Pro 64 GB** — Gemma 4-26B at **66.2 tok/s** time-weighted with MTP+TurboQuant vs 36.6 baseline, 100K-context TTFT 33.95s vs 63.11s, and GPU memory at 40K tokens dropping **54.8 GB → 23.9 GB**. Note what that last figure implies: their *compressed* 40K-context footprint is roughly the owner's *entire machine*. The KV-compression work is aimed at long context, which per the research doc §3.4 the curator does not have — at `num_ctx 8192` the KV cache is under a gigabyte and already 8×-reduced by GQA. And the project itself concedes MTP on 35B+ MoE models **"will be slower than baseline"** due to I/O fan-out, with "Community Help Wanted" on expert prefetching.

**(f) Verdict: WATCH.** Best-productized of the cluster, but its two headline features (long-context KV compression, MTP decode acceleration) both target problems the curator does not have.

### 7.5 mlx-moe — mu-hashmi

[github.com/mu-hashmi/mlx-moe](https://github.com/mu-hashmi/mlx-moe) · **6 ★** · MIT

**(a) Mechanism.** The most interesting *policy* in the cluster and it is nearly the opposite of streaming. Rather than paging experts per token forever, it does a **router-only forward pass over the prompt (~1s) to discover which experts will actually be needed**, loads just those into GPU-resident stacked tensors (~15s), and then generates with "zero-eval dispatch." Effectively a *profile-then-pin* strategy: pay a one-off routing survey, then run resident.

**(b) Hardware reality.** Apple Silicon / MLX; targets `SwitchGLU`-architecture models (Qwen 3/2, Mixtral, GLM, DeepSeek, Hunyuan, PhiMoE, Jamba).

**(c) Maturity.** **6 stars, 2 forks, 43 commits — single author.** Maximum bus factor risk. Partially offset by unusual discipline for a repo this size: 100 unit/integration tests, a real benchmark suite, 20-turn multi-turn stability testing with flat memory growth, and unusually candid limits.

**(d) Integration cost.** `pip install .`, then `mlx-moe serve <model>` on **127.0.0.1:8080** with `/v1/chat/completions`, `/v1/messages` and `/v1/models`. Cheapest bench arm in the cluster. Not thread-safe — the server serialises requests, which is fine for a sequential nightly sweep.

**(e) Benefit.** **Qwen3-Coder-Next-4bit, a 46 GB model, running in 19.1 GB on a 32 GB Mac at 6–23 tok/s**, warm start ~6s. Its RAM table starts at 32 GB, so a 24 GB machine is below the documented floor. The candid limitations are the useful part: quality degrades below capacity 192; a **"Metal pressure cliff above capacity 208 on 32 GB"**; mild repetition past 1000 tokens attributed to running at only **40% expert coverage**. That last admission is the whole genre's honesty problem stated out loud — *the quality cost of not having all the experts is real and they measured it.*

**Why the mechanism matters more than the repo:** profile-then-pin is genuinely well-matched to a **nightly batch over homogeneous inputs**. If 100 curator units all route similarly (same prompt template, same domain, same extraction task), the profiled expert set should be stable across the whole sweep, so you pay the survey once rather than per request. Nobody has tested that hypothesis. It is the most interesting untested idea in this document.

**(f) Verdict: WATCH the idea, IGNORE the repo as a dependency.** At 6 stars it cannot be a product dependency, but *profile-then-pin over a homogeneous batch* is the one mechanism here that is designed for a workload shaped like the curator's.

### 7.6 mlx-flash, expertcache, PonyExl3 — the tail

- **[mlx-flash](https://github.com/matt-k-wong/mlx-flash)** (matt-k-wong, **125 ★**, MIT) — *layer*-granularity streaming for MLX, i.e. AirLLM's idea done properly: mmap'd lazy arrays behind a `StreamingProxy`, an "MPC-Lite" bandwidth scheduler and a token-bucket actuator pacing SSD reads, with predictive prefetch of layer N+1 during layer N. Claims "30B on 16 GB, 70B+ on 32 GB+" and GPU degradation "below 5%", but the only concrete figure given is a *load-time* improvement (Nemotron-30B: 0.8s vs 4.1s), not throughput. No server. Explicitly warns *"Do not `pip install mlx-flash`"* (name-squat on PyPI) — install from GitHub only. **WATCH** the prefetch scheduler; the absent throughput number is the same tell as AirLLM.
- **[expertcache](https://github.com/amos-labs/expertcache)** (amos-labs, **9 ★**, Apache-2.0) — page-aware Metal: exposes only selected expert byte-ranges to Metal through page-aligned direct host-memory views, so a 63.4 GB checkpoint never binds whole expert tensors into the GPU working set. Self-described: *"It is research software, not a production inference runtime."* Numbers confirm it — 64 GiB M1 Max prefill 5.75 → 9.80 tok/s (+70%), decode ~3 tok/s; **16 GiB M1 Pro: 0.75 prefill / 0.72 decode tok/s**, with a full qualification run taking 8,249 seconds. **IGNORE** — the small-memory case is exactly the owner's case and it is ~0.7 tok/s.
- **[PonyExl3](https://github.com/beamivalice/PonyExl3)** (beamivalice, **47 ★**, Beta) — answers the exllamav2/v3 question: turboderp's EXL3 trellis format ported to Metal, weights staying in low-bit trellis form and decoded on-the-fly inside fused GEMV/GEMM kernels. **Qwen3.6-27B @ 4.15bpw: 16.6 tok/s plain, 37.8 tok/s with DFlash speculative decoding (2.28×) on M5 Max**; 4.0 → 15.0 tok/s on an M1 Max. No OpenAI server, Python ≥3.14, **32 GB minimum for 27B**. This is a *quantization* story, not a sparsity one, and it is decode-speculation-driven — the research doc already established speculation is worth <5% end-to-end here. **IGNORE** for the curator.

---

## 8. exllamav2/v3, vLLM, SGLang — the Mac reality check

**exllamav2 / exllamav3 (turboderp).** CUDA-only upstream; the EXL2/EXL3 kernels are written against NVIDIA. The only Apple path is the third-party **PonyExl3** port above (47 ★, beta, no server). Its quantization format is genuinely excellent, but nothing about it is conditional computation, and reaching it on a Mac means a beta single-author port. **IGNORE.**

**vLLM.** The situation changed materially in 2026 and this is the one to know about: **[vllm-project/vllm-metal](https://github.com/vllm-project/vllm-metal)** is a community-maintained hardware plugin *under the official vLLM org* — **1.6k ★**, **v0.2.0 (April 2026)** shipping a unified paged varlen Metal kernel as the default attention backend and claiming **83× TTFT and 3.6× throughput over v0.1.0**. It uses MLX as the compute backend, requires native arm64 Python 3.12 (Rosetta explicitly unsupported), and is now a **Docker Model Runner** backend on macOS, which is a real distribution signal. Separately, **[waybarrios/vllm-mlx](https://github.com/waybarrios/vllm-mlx)** (**1.5k ★**, Apache-2.0, 550 commits, 54 open issues) is an independent OpenAI+Anthropic-compatible MLX server with continuous batching, paged KV cache, prefix caching, SSD-tiered KV spillover, and — relevant here — **a `--moe-top-k` flag that reduces the number of experts evaluated per token**, which is the only *user-facing "use less of the model" knob* found anywhere in this survey. Quoted M4 Max single-stream: Qwen3-30B at 127.7 tok/s. **[raullenchai/Rapid-MLX](https://github.com/raullenchai/Rapid-MLX)** (3.5k ★) is a community fork of it claiming "4.2× faster than Ollama". Treat all three throughput claims as vendor-reported. **WATCH `vllm-metal`** — official-org backing plus Docker distribution makes it the most likely non-Ollama runtime to become defensible; **note `--moe-top-k`** as a cheap quality-vs-cost experiment if a second runtime ever becomes acceptable.

**SGLang.** No Apple Silicon support. [Issue #19137](https://github.com/sgl-project/sglang/issues/19137) is an *initial roadmap* for Apple device support dated 2026 Q2, soliciting contributors; today it must be built from source and does not work properly on a Mac. **IGNORE** for at least a year.

---

## 9. fiddler — efeslab

[github.com/efeslab/fiddler](https://github.com/efeslab/fiddler) · **267 ★** · ICLR'25

**(a) Mechanism.** The cleanest idea in MoE offloading, and it inverts everyone else's. When a routed expert is missing from GPU memory, don't move the *weights* to the GPU — move the *activations* to the CPU, compute the expert there, and copy the (tiny) result back. Activations are kilobytes; expert weights are hundreds of megabytes. It exploits CPU compute rather than treating the CPU as dumb storage.

**(b) Hardware reality.** PyTorch + CUDA; performance is explicitly contingent on **AVX-512** CPU support. No Apple Silicon support, and — as with ktransformers — the mechanism's whole premise is that CPU and GPU are separate memory domains where copying is expensive. **On unified memory the premise evaporates**: there is no PCIe hop to avoid, so "avoid moving weights" is not a saving, it's a no-op.

**(c) Maturity.** 267 stars, 49 commits, README self-describes as *"a proof-of-concept and still under heavy construction"*, and the newest update referenced is **February 2024**. Supports exactly one model: 16-bit Mixtral-8×7B. Roadmap items (DeepSeek-MoE, OpenMoE, Switch Transformer) never landed. Dormant academic artifact.

**(d) Integration cost.** No API server. Research code.

**(e) Benefit.** >3 tok/s for unquantized Mixtral-8×7B (>90 GB) on a single 24 GB GPU — impressive for 2024, irrelevant now.

**(f) Verdict: IGNORE.** Elegant idea whose entire value proposition — don't pay the CPU↔GPU transfer — is worth nothing on unified memory, on top of being unmaintained since early 2024.

**LLM-in-a-flash implementations.** Apple never released code for [arXiv 2312.11514](https://arxiv.org/pdf/2312.11514). The open-source descendants are exactly §7.2–§7.6, all of which cite it: `flash-moe` and `mlx-flash` name it explicitly, `SwiftLM` derives its SSD streaming from `flash-moe`. Note what survived the translation and what didn't: the paper's **storage** insight (bundle co-accessed weights, issue large sequential reads) is everywhere, while its **windowing** insight — keep only neurons activated by the last k tokens — is nowhere, because windowing depends on ReLU-induced sparsity that modern SwiGLU models don't have. The genre kept the half that was architecture-neutral and silently dropped the half that made it a *sparsity* technique. What's left is a storage-tiering trick wearing a conditional-computation costume.

**2026-era newcomers** beyond the above: `Luce-Org/lucebox` (speculative inference for heterogeneous consumer hardware) and the **NPUMoE** paper ([arXiv 2604.18788](https://arxiv.org/abs/2604.18788)) — Apple-Silicon *NPU* MoE execution with static capacity tiers and load-aware residency, reporting 1.32–5.55× prefill speedup on M2 Max/Ultra including on Qwen3-30B-A3B. NPUMoE remains the best-matched *result* to this workload (it is explicitly a prefill technique) and has **no public code**. Re-check in 12 months.

---

## 10. Scoreboard

| Project | ★ | Apple Silicon today | Server | Prefill-relevant? | Verdict |
| --- | --- | --- | --- | --- | --- |
| ktransformers | 19.2k | **No** (x86+CUDA/AMX) | — | — | IGNORE |
| PowerInfer | 9.7k | CPU-only, README disclaims | — | No | IGNORE |
| llama.cpp | — | **Yes**, first-class Metal | OpenAI-compat | **`-ub` yes**, `-ncmoe` no | **USE NOW (`-ub`)** |
| AirLLM | 30.9k | Yes (via MLX) | No | No — 0.5–2 tok/s | IGNORE |
| mixtral-offloading | 2.3k | No | No | No | IGNORE |
| DeepSpeed-MII | 2.1k | **No** (CC 8.0+) | Yes (CUDA) | No | IGNORE |
| **mlx / mlx-lm** | 6.6k | **Yes** (Apple) | `:8080` OpenAI | **Yes** (fused MoE GEMM) | **USE NOW via `-mlx` tags** |
| Mference | 91 | Yes | `:` OpenAI | Claims 2.20× | **WATCH → Exp. 3** |
| flash-moe | 221 | Yes | CLI only | No (I/O = 35%/tok) | WATCH |
| SwiftLM | 735 | Yes | `:5413` OpenAI | Long-ctx only | WATCH |
| mlx-moe | 6 | Yes | `:8080` OpenAI | **Profile-then-pin** | WATCH the idea |
| mlx-flash | 125 | Yes | No | Unproven | WATCH |
| expertcache | 9 | Yes | No | 0.75 tok/s @16 GB | IGNORE |
| PonyExl3 | 47 | Yes (beta) | No | No | IGNORE |
| vllm-metal | 1.6k | **Yes** (official org) | Yes | Yes (TTFT claims) | WATCH |
| vllm-mlx | 1.5k | Yes | OpenAI+Anthropic | `--moe-top-k` | WATCH |
| fiddler | 267 | No | No | No | IGNORE |
| SGLang | — | **No** (roadmap only) | — | — | IGNORE |

---

## 11. Three experiments worth running

Constraints respected throughout: **nothing downloads gigabytes without written approval**, and **the app itself only ever speaks Ollama's API** — experiments 2 and 3 are measurement side-experiments, not product changes.

### Experiment 1 — Is Ollama's fixed prefill chunking costing us? (`llama-server` micro-batch sweep)

**Install/run.** Build `llama.cpp` from source (~200 MB, no model download — **reuse a GGUF already in the Ollama blob store** via `--model`, so no new gigabytes). Run `llama-server` on a spare port against a model already on disk, sweeping `-ub 512` (Ollama's effective default) against `-ub 1024` and `-ub 2048`, with `-b` matched. Fire the real curator prompt: ~700-token template + a real 3–5k-token ExperienceUnit, `temperature 0`, same JSON schema.

**Measure.** `prompt_eval_duration` / `prompt_eval_count` — prefill tok/s, nothing else. Decode is 10% of the job and is noise here. Also capture peak wired memory per setting.

**What would change our model choice.** If `-ub 2048` beats Ollama's prefill throughput by **>25%**, then the nightly sweep is paying a meaningful tax for staying on Ollama, and either (a) a bigger MoE arm becomes affordable within the same overnight window, or (b) it becomes worth supporting an Ollama issue to expose micro-batch. If the gain is <10%, close this line permanently and stop wondering — Ollama's MLX-engine prefill work has already captured it.

**Why first.** Zero new model bytes, zero new runtime in the product, and it directly measures the phase that is 90% of the job. It is also the only experiment that can *retire* a question rather than open one.

### Experiment 2 — Does the MLX engine actually win on prefill? (`-mlx` tag A/B, pure Ollama)

**Install/run.** No new software whatsoever. Add paired arms to the existing sweep: `gemma4:26b` vs `gemma4:26b-mlx`, and `gpt-oss:20b` (14 GB, native MXFP4) as the MoE arm against `gemma4:12b` (7.6 GB) as the dense control. Model pulls **require written approval** — `gemma4:26b-mlx` is ~18 GB. Confirm `OLLAMA_NUM_PARALLEL=1` before starting.

**Measure.** Split `prompt_eval_*` from `eval_*` per request (the `run_bench.py` change the research doc already recommends — this experiment is blocked on it). Sample `ollama ps` every arm to verify **100% GPU**; an arm that silently ran 40% on CPU is not a comparable arm and must be discarded, not averaged. Plus extraction quality against the 58-unit gold set.

**What would change our model choice.** Two independent decisions from one sweep. (1) If `-mlx` beats GGUF on prefill by **>20%** at equal quality, the MLX engine becomes the default target and everything in §7 gets re-read as "MLX ecosystem" rather than "exotic runtimes." (2) If `gpt-oss:20b` does **not** beat `gemma4:12b` on extraction quality, then the entire sparse-inference research programme is moot for the curator — a dense 12B at half the RAM ends the discussion, and both this document and its predecessor can be archived.

**Why second.** It answers the actual product question. Experiment 1 only tells you how fast the runtime *could* go; this tells you which model to ship.

### Experiment 3 — Does "26B in 2 GB" survive contact with a real prefill? (Mference, side-experiment only)

**Install/run.** Only if Experiment 2 shows a 26B-class MoE winning on quality but sitting uncomfortably in memory. `git clone` + `swift build -c release` (Swift 6.1+/Xcode 16.3+ required); Gemma 4 26B-A4B weights — **a multi-gigabyte download requiring explicit written approval**. Point the harness at its loopback OpenAI-compatible server; keep the app itself on Ollama throughout. Run at the documented 16-slot profile, **not** 24 slots — the README records a sharp memory-pressure regression at 24 slots on a 24 GB M5.

**Measure.** Three things, in priority order. (1) **Prefill throughput on real 3–5k-token units** — this is the falsification test for §0.1; if per-token expert streaming degenerates on a multi-thousand-token batch, prefill will be catastrophically slow regardless of the pretty decode number. (2) Resident memory via `footprint`/Activity Monitor, to test the "~2 GB" claim against the "18 GB" Ollama baseline. (3) **Extraction quality against the same gold set** — `mlx-moe` measured real degradation at 40% expert coverage, so assume quality loss until measured, and check determinism across repeated runs given the MSL-version caveat.

**What would change our model choice.** If prefill holds up **and** quality matches Ollama's `gemma4:26b` at a fraction of resident memory, then the memory ceiling stops being the binding constraint on model choice — which reopens the entire 26–35B class and would justify a serious "second runtime" conversation at product level. If prefill collapses (the predicted outcome), we get the definitive local measurement that **expert streaming is a decode technique**, and this whole genre can be closed out for the curator with evidence rather than argument.

**Why third, and why still worth doing.** It is the only experiment that could change the memory budget rather than just the throughput, and either outcome is decisive. A negative result is nearly as valuable as a positive one here, because it retires six repositories at once.

---

## 12. Standing watch triggers

Re-check these; each one, if it fires, promotes something from WATCH to USE NOW:

1. **[mlx-lm#1438](https://github.com/ml-explore/mlx-lm/issues/1438) gets a maintainer response.** Apple accepting expert streaming into `mlx-lm` collapses §7.2–§7.6 into one supported feature that Ollama would inherit through its MLX engine — turning "install a single-author Swift project" into "use a flag."
2. **[llama.cpp #23324](https://github.com/ggml-org/llama.cpp/discussions/23324) becomes a real upstream PR.** Still living in a personal fork with no maintainer response as of 2026-07-27. If it merges, `--moe-n-slots` eventually reaches Ollama.
3. **[ollama#16515](https://github.com/ollama/ollama/issues/16515) / [#11772](https://github.com/ollama/ollama/issues/11772) get maintainer attention.** Both open, both unanswered. Tensor overrides in Ollama would make Experiment 1's finding directly actionable inside the product.
4. **`vllm-metal` v0.3 + broader Docker Model Runner adoption.** Official-org backing is what would make a non-Ollama runtime defensible to ship.
5. **NPUMoE code release.** Still the best-matched published result to a prefill-dominated MoE workload on Apple Silicon, and still paper-only.
6. **A hybrid-attention ultra-sparse MoE in the 12–18 GB class.** Unchanged from the research doc, and still the single development that would dominate every option above.
