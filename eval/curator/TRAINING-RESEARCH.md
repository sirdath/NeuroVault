> Evidence backbone for the future Librarian training plan. Produced 2026-08-04 by a
> 6-angle deep-research pass with adversarial verification (126 sources checked).
> Training itself is GATED: curator V1 ships first; no GPU spend before a written,
> approved plan. See docs/specs/local-memory-curator.md for the product spec.

# EVIDENCE-BASED INPUTS FOR THE LIBRARIAN TRAINING PLAN
*Synthesized from 6 research angles + adversarial verification. Tags: PROVEN / EMERGING / OPINION carried through; verification corrections applied (Memory-R1 numbers discarded, GKD "6×" corrected, NuExtract-2.0-2B base identified as VL).*

---

## 1. THE PRECEDENT VERDICT

The flip is **proven for extraction, unproven-but-plausible for judgment — and the plan's structure already routes around the unproven half.** SELECT + EMIT is squarely covered: 0.5B NuExtract beats GPT-3.5 and its own 70B teacher at 3.8B ([blog](https://numind.ai/blog/nuextract-a-foundation-model-for-structured-extraction)), a 50M GLiNER beats ChatGPT on span selection ([arXiv:2311.08526](https://arxiv.org/pdf/2311.08526)), UniversalNER's student beats its teacher by 7-9 F1 ([arXiv:2308.03279](https://arxiv.org/abs/2308.03279)), and a production Qwen 0.8B lands within 2.2 F1 of Llama-8B on strict-JSON extraction ([arXiv:2606.08051](https://arxiv.org/abs/2606.08051)) — all PROVEN. The durability JUDGE is the gap: evaluative judgment is proven distillable only at 7B+ with ~100K examples (Prometheus, [arXiv:2405.01535](https://arxiv.org/pdf/2405.01535)); no published result trains a 0.6-2B model for salience/durability judgment on transcripts. Two mitigations have ablation support: frame judgment as *classification over enumerated sentences* — the framing that let 50-400M encoders match 8B generative models on groundedness ([arXiv:2506.21288](https://arxiv.org/abs/2506.21288), PROVEN) — and put the durability rubric in the training prompt so the model applies a stated definition rather than memorizing one (GoLLIE, [arXiv:2310.03668](https://arxiv.org/abs/2310.03668), PROVEN). Blunt bottom line: bet confirmed at 1.7-2B with those two levers; 0.6B is a stretch goal; a clean result on durability judgment at this size would be the first published one, so plan for iteration, not a single validating run.

## 2. ARCHITECTURE CALL

**Refines and partially overrides Codex.** Codex's sentence-pointer contract and selector formulation are confirmed — but the evidence says the SELECT+JUDGE+ABSTAIN core may not need a generative model at all:

- Fine-tuned 355-395M encoders match or beat 8B generative models at exactly this shape of task: groundedness classification (RoBERTa-L 90.2 vs zero-shot Llama-8B 81.9, [arXiv:2506.21288](https://arxiv.org/abs/2506.21288), PROVEN, verified verbatim) and span selection inside bounded documents (LettuceDetect ModernBERT, 79.22 F1 RAGTruth, [arXiv:2502.17125](https://arxiv.org/abs/2502.17125), PROVEN).
- The exact hybrid — LLM emits, encoder verifies evidence — is published and needed only ~500 labels, with teacher silver pre-training helping at every data size (SafePassage, [arXiv:2510.00276](https://arxiv.org/html/2510.00276v1), PROVEN, verified verbatim).
- An encoder scoring enumerated sentences has fabrication rate 0 *by construction* and abstains via threshold — the two failure modes that killed your zero-shot 0.6-4B evals cease to exist (OPINION, but architecturally sound).

**Call: run both, cheaply, and let the 58-unit gold decide.** Primary plan stays generative Qwen3-1.7B LoRA (it must phrase `statement` and assign `type`; single model is simpler to ship). But add a near-free arm: fine-tune a ~150-400M ModernBERT/DeBERTa-class sentence-durability scorer on the same silver (cost ≈ minutes; your ONNX cross-encoder infra already runs this class on-device — though at 22-33M today; 30M-scale parity is unverified, budget 150-400M). **Decision gate:** if encoder sentence-recall on the gold beats the teacher's 0.30-0.44 semantic recall, the shipped architecture becomes encoder-selects → tiny generative head phrases from pre-selected sentences (extract-then-generate is the published faithfulness win, [EMNLP Findings 2023](https://aclanthology.org/2023.findings-emnlp.214/)). Caveat: rationale selectors transfer across domains at F1 0.03-0.10 (MultiVerS, [arXiv:2112.01640](https://arxiv.org/pdf/2112.01640), PROVEN) — no off-the-shelf checkpoint; your own silver is mandatory either way.

## 3. DATA DESIGN

**Volume.** 600-1,000 units is inside the demonstrated regime for ~1B LoRA extraction ("a few hundred to one thousand samples per task", ETLCH, [arXiv:2509.08381](https://arxiv.org/abs/2509.08381), PROVEN) — but 20-50× below the 45-60K flip precedents. Close the gap by multiplying, not collecting: sample the 30B teacher **k=4-8× per unit at temperature, gauntlet-filter every candidate, train only on survivors.** This is the STaR/RFT mechanism — gains scale with *distinct accepted outputs per input*, weak models gain most ([arXiv:2308.01825](https://arxiv.org/abs/2308.01825), PROVEN) — and NuExtract's whole recipe was exactly this with a ~17% keep rate (EMERGING). Known RFT failure mode: easy units get overrepresented; oversample survivors from hard units. Codex's 250/500/1000 learning curves: keep, and add a second axis (k=1 vs k=4-8 at fixed units) since effective examples = units × survivors.

**Negative ratio — unresolved contradiction, must be an ablation arm.** Hammer's ablation says ~10% irrelevance examples is optimal and finds an *inverse relationship* between abstention and positive-call recall ([arXiv:2410.04587](https://arxiv.org/html/2410.04587v2), PROVEN, verified verbatim); NuExtract used ~50%; your natural rate is ~30%. Since recall is your weakest measured axis, do not settle this by argument: run 10% vs 30% arms. Negatives must be frequency-realistic, not uniform — UniversalNER's ablation: no negatives −21.9 F1, uniform −5.7 vs frequency-based (PROVEN, verified: 31.5/47.7/53.4). Also synthesize hard negatives xLAM-style by corrupting positives (delete the evidence sentence, keep the unit, label = empty branch).

**Positive-unlabeled handling.** Teacher recall 0.30-0.44 means teacher silence is not a negative. Only k-consensus silence (all k samples abstain) becomes an ABSTAIN label; single-sample emissions get down-weighted or a second teacher pass (SSR-PU framing, [arXiv:2210.08709](https://arxiv.org/pdf/2210.08709), PROVEN). Gold-set abstention labels are hand-made, never teacher-derived — otherwise you measure agreement with teacher blindness.

**Splits.** Session-disjoint (every unit from one session in exactly one split) — cross-unit references leak labels. Decontaminate train-vs-gold with 8-13-gram overlap *plus* embedding similarity (paraphrase defeats n-grams, [arXiv:2311.04850](https://arxiv.org/pdf/2311.04850)). Since silver and the 80-unit benchmark come from one transcript pool, this is the single most load-bearing eval decision.

**New mandatory pre-step (verifier's addition, costs nothing):** before training anything, score the 30B teacher's silver directly against the 58-unit gold to measure silver precision/recall. That number is your ceiling estimate and tells you whether k-sampling is load-bearing.

## 4. RECIPE

- **Base:** post-trained Qwen3-1.7B, LoRA-first — CONFIRMED. LoRA matches full FT at this data size when applied to **all layers including MLPs** (attention-only significantly underperforms), LR **~10× the full-FT optimum**, modest batch ([Thinking Machines](https://thinkingmachines.ai/blog/lora/), PROVEN, verified; reproduced in [TRL](https://huggingface.co/docs/trl/en/lora_without_regret)). Rank: 8-16 sufficed in the closest production analog (rank 8 within 0.20 F1 of rank 32, [arXiv:2606.08051](https://arxiv.org/abs/2606.08051), PROVEN); use 16-32 all-layer. 2-10 epochs, early-stop on harness metrics, not eval loss.
- **Reject NuExtract-2.0-2B as init** (verifier finding): its base is Qwen2-VL-2B-Instruct — different tokenizer (kills the on-policy-KD option), different template, harder GGUF path. Raw Qwen3 + rubric-in-prompt instead.
- **Masking:** completion-only is default, but your regime (few examples, 2-4K prompt, ~100-300-token completion) is the published exception where including instruction-token loss helps ([arXiv:2405.14394](https://arxiv.org/pdf/2405.14394), PROVEN — not re-verified this session). One ablation arm, weight ~0.1.
- **Protect format/abstention from narrow-SFT damage:** narrow SFT measurably degrades instruction-following (IF-eval 85→45 in the Thinking Machines case, EMERGING); mix 10-20% general/format-diverse data and gate on schema-validity + abstention-rate regressions.
- **Escalation ladder if SFT plateaus below teacher:** (1) on-policy GKD — direction PROVEN (on-policy KD with 5% of data beat supervised KD with 100%, [arXiv:2306.13649](https://arxiv.org/abs/2306.13649); the "6×" figure circulating is not in the paper), enabled by the shared Qwen3 tokenizer, but budget teacher-serving separately — 30B logprobs over student rollouts is hours of extra inference, not free. (2) GRPO with the gauntlet as verifiable reward — Abstain-R1 at Qwen2.5-3B: refusal 9.4→68.1% *while* answerable accuracy rose 48.8→57.2 ([arXiv:2604.17073](https://arxiv.org/html/2604.17073v1), EMERGING, numbers verified). Do **not** cite Memory-R1 as support — verification found its headline numbers unsupported in the versions checked.
- **Qwen3 gotchas (mandatory at 0.6B/1.7B):** the 2507 Instruct/Thinking split covers 4B+ only; at 0.6B/1.7B only hybrid-thinking checkpoints exist. Pick the non-thinking template, identical at train and inference, bake it into the Modelfile, handle empty `<think>` (ms-swift `--loss_scale ignore_empty_think`), and add a gauntlet check that output starts with `{`. Alternative: Qwen3-4B-Instruct-2507 sidesteps the trap at 2× the size. Verify current HF listings before committing.

## 5. ABSTENTION + FORMAT

- Abstention is purely a training artifact — vanilla small models essentially never abstain (your 0-0.6 measurement matches R-Tuning's vanilla-SFT baselines; method PROVEN, exact numbers not re-verified, [NAACL 2024](https://aclanthology.org/2024.naacl-long.394/)) — and it is *antagonistic* to recall (Hammer, PROVEN). Train it as an explicit schema branch (`{"memories": []}`), never as free-text refusal.
- Add a **refusal token with an inference-time logit threshold** ([arXiv:2412.06748](https://arxiv.org/pdf/2412.06748), EMERGING) so the abstention rate is a deployment dial, decoupling you from whichever negative ratio the ablation picks.
- **Evidence pointers = enumerated sentence IDs in the input, IDs in the output — never quotes.** Your 50-89% measured quote fabrication is the field-wide pattern (ALCE line, [arXiv:2305.14627](https://arxiv.org/abs/2305.14627), PROVEN); IDs turn the gauntlet's evidence check into a type-check and move all capacity to SELECT+JUDGE.
- **Keep GBNF/xgrammar constrained decoding permanently.** Fine-tuning does not guarantee compliance (JSON-tuned Llama 3.1: 13-40% unconstrained on hard schemas) and constraints *improve* accuracy up to ~4% ([arXiv:2501.10868](https://arxiv.org/html/2501.10868v1), PROVEN, verified). The schema's abstain branch ensures the grammar can never force an invented memory.

## 6. PRIVACY PATH TO A DISTRIBUTABLE MODEL

- Personal adapter: LoRA specifically reduces memorization vs full FT at kept task quality ([arXiv:2506.20856](https://arxiv.org/abs/2506.20856), PROVEN — note the paper's metric is similarity-based, not verbatim). Owner-transcript training stays a local LoRA adapter; silver dedup doubles as mitigation. Codex's gate CONFIRMED.
- **Release gate for any distributed checkpoint** (a few GPU-minutes): canary insertion + exposure below threshold; real-transcript-prefix prompts must not complete with real continuations; membership-inference AUC ≈ 0.5 on held-out units ([arXiv:2504.21036](https://arxiv.org/pdf/2504.21036), PROVEN methodology).
- **Distributable route = synthetic transcripts, not DP-SFT.** DP synthetic instructions fully replaced real user data in SFT with comparable utility (Google, ICML 2024, [arXiv:2402.13659](https://arxiv.org/abs/2402.13659), PROVEN); DP-SFT at 1-2B has a real utility gap and research-grade tuning cost. Recipe: ~100-200 hand-written session skeletons (personas × task types × durable-fact types × ~30% nothing-durable) → LLM expansion → same teacher+gauntlet labeling. Cost: mostly your time + one more $5-class training run. Unverified: no published head-to-head of synthetic-vs-real-trained *curation* models — this is the plan's largest untested assumption on the distribution path.

## 7. INFRA + BUDGET

- **The H100 budget is oversized for SFT** — 1,000 units × ~3K tokens × 3 epochs ≈ 9M tokens ≈ ~1 hr LoRA on one H100 at $1.5-3.3/hr rental ⇒ **~$2-6/run, a 10-run sweep $25-60** (EMERGING pricing + arithmetic). Spend the budget on the ablation grid (negative ratio, masking, data mix, seeds ×3 for the final config ≈ $15), not one hero run. Only GKD/GRPO arms threaten the budget (teacher serving).
- **Mac:** `mlx_lm.lora` handles Qwen3 QLoRA overnight (~260-500 tok/s ⇒ 9M tokens ≈ 5-10h) — free data/format iteration. But MLX's GGUF export supports Mistral/Mixtral/Llama only (PROVEN, verified from LORA.md); path is fuse → HF safetensors → llama.cpp `convert_hf_to_gguf.py` → quantize. Keep canonical runs on one CUDA stack for comparability.
- **The #1 predicted failure is the deployment seam, not training** (EMERGING, multiple independent writeups): chat template / thinking-mode mismatch between training, Modelfile, and the strict-JSON parser; merging into the wrong base variant; quantizing an unmerged adapter (silent garbage). Discipline: validate the F16 GGUF against the blind harness *before* quantizing; checkpoint selection by gauntlet-pass/abstention/recall, never eval loss.

## 8. WHERE THE EVIDENCE CHANGES THE PLAN

| Codex recommendation | Verdict | Change |
|---|---|---|
| Sentence-pointer contract | **CONFIRMED** | Strengthen: enumerated sentence IDs in/out, quotes banned; gauntlet becomes a type-check |
| Sentence-selector training formulation | **CONFIRMED + extended** | Evidence says selection may not need a generative model; add a ~150-400M encoder arm with a recall-vs-teacher gate (partial override) |
| Learning curves 250/500/1000 | **CONFIRMED** | Add k-samples-per-unit axis; effective data = units × gauntlet survivors |
| 30%+ negatives | **PARTIALLY CONTRADICTED** | Hammer's ablated optimum is ~10% with a proven recall tax; run 10% vs 30% arms + refusal-token dial; frequency-realistic + corrupted-positive hard negatives |
| LoRA-first from post-trained Qwen3-1.7B | **CONFIRMED + refined** | All-layer (incl. MLP), rank 16-32, LR ~10× full-FT; non-thinking template mandatory at 0.6B/1.7B (no 2507 checkpoints there); reject NuExtract-2.0-2B init (VL base) |
| Teacher-relative bars | **CONFIRMED + new pre-step** | Score teacher silver against the 58-gold *before* training; use an embedding/different-family judge for semantic recall (Qwen-judging-Qwen measures family agreement) |
| Privacy gate on distribution | **CONFIRMED + made concrete** | Canary + MIA probes as release gate; distributable model via synthetic transcripts, not DP-SFT |
| *(New)* | — | Gauntlet-filter teacher silver before it becomes training data (APIGen precedent — otherwise the 19% fabrication is distilled in); k-consensus for ABSTAIN labels (PU regime); 10-20% general-data mix; session-disjoint splits + embedding decontamination; keep constrained decoding at inference forever |

## 9. KEY SOURCES

1. https://numind.ai/blog/nuextract-a-foundation-model-for-structured-extraction — closest end-to-end recipe (teacher silver + text-presence filter + ~50% negatives, 0.5B result)
2. https://arxiv.org/abs/2308.03279 — UniversalNER (student beats teacher; negative-sampling ablation)
3. https://arxiv.org/abs/2410.04587 — Hammer (abstention-recall inverse relationship, ~10% optimum)
4. https://arxiv.org/abs/2506.21288 — Small Encoders Rival Large Decoders (groundedness)
5. https://arxiv.org/html/2510.00276v1 — SafePassage (the hybrid, ~500 labels suffice)
6. https://thinkingmachines.ai/blog/lora/ — LoRA Without Regret (all-layer, 10× LR)
7. https://arxiv.org/abs/2606.08051 — How Small Can You Go (production 0.8B strict-JSON, rank 8, Nothink)
8. https://arxiv.org/html/2604.17073v1 — Abstain-R1 (SFT+GRPO abstention without recall cost)
9. https://arxiv.org/html/2501.10868v1 — JSONSchemaBench (keep constrained decoding)
10. https://arxiv.org/abs/2506.20856 + https://arxiv.org/abs/2402.13659 — LoRA memorization reduction; DP-synthetic-data substitution

**Residual uncertainty, stated plainly:** durability judgment at 0.6-2B has zero published precedent (your benchmark appears to be first); the ~30% negative ratio has no ablation at exactly that value anywhere in 2024-2026 literature; synthetic-vs-real transcript training for curation is untested; and the 22-33M reranker you already ship has no published parity evidence at selection — the encoder arm needs 150-400M. Everything else above rests on verified numbers.