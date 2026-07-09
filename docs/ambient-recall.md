# Ambient Recall — automatic memory that prefers silence

Ambient Recall is NeuroVault's automatic context layer for Claude Code:
relevant local memories are retrieved and injected **before** Claude
processes your prompt, with zero tool calls and zero effort. The full
design contract lives in [docs/specs/ambient-recall.md](specs/ambient-recall.md);
this page is the user guide.

## The principle: silence over weak context

Automatic context is only good if it is trustworthy. Vector search
always returns *something* — the nearest neighbor of a vague prompt is
still its nearest neighbor, even when it's useless. So Ambient Recall
is built around a precision gate, and **"no context injected" is a
successful outcome**:

- The **cross-encoder reranker** (the strongest relevance signal in the
  stack) must clear an **absolute score floor** — not just "best of the
  candidates", but "actually about this prompt".
- The floor **rises for vague prompts** ("fix it", "cargo build") and
  **relaxes slightly for exact matches** (a file path, code symbol,
  error string, or entity from your prompt appearing verbatim in the
  memory).
- A weak-ish top hit that barely beats its runner-up is noise-shaped
  and gets suppressed (**score-gap rule**), unless it's an exact match
  or genuinely confident.
- Already-injected memories are excluded for the rest of the session;
  a strict token budget caps the block; at most 3 memories by default.

## Setup

Settings → Automatic Memory (Claude Code), or:

```bash
neurovault-server hook install     # wires ~/.claude/settings.json (backup written)
neurovault-server hook status
neurovault-server hook uninstall
```

The hook is a thin, fail-open client: if the NeuroVault app isn't
running, it prints nothing and exits 0. It can never block or slow a
prompt — the installed command is wrapped so even a broken binary
degrades to silence.

## Tuning — `~/.neurovault/ambient.json`

Missing file or fields = these defaults:

```json
{
  "enabled": true,
  "min_cross_encoder_score": 0.60,
  "min_score_gap": 0.04,
  "max_memories": 3,
  "max_tokens": 700,
  "strict_mode": false,
  "vague_prompt_score_boost": 0.15,
  "log_prompt_text": false,
  "brains": {
    "work-brain": { "min_cross_encoder_score": 0.70, "max_memories": 1 }
  }
}
```

- Raise `min_cross_encoder_score` (or set `strict_mode: true`) if you
  see injections you didn't find useful; lower it if memory feels shy.
- `brains.<id>` overrides any field for one brain.
- `log_prompt_text` is **off by default**: the decision log stores a
  SHA-256 of your prompt, not the text, unless you opt in.

## Debugging — see exactly what the gate saw

```bash
neurovault-server ambient test "why does sqlite-vec fail on startup" --cwd ~/code/myproj
```

Prints the query packet (with resolved repo/branch), the full candidate
table (cross-encoder probability, fused score, per-channel ranks, match
signals), the gate decision with its reasoning, and the final context
block — or `no injection`.

## The decision log

Every request appends one JSON line to
`~/.neurovault/logs/ambient_recall.jsonl`: all candidate scores, the
decision, the reason, and what was injected. This is the substrate for
the planned v2 feedback loop (learning per-brain thresholds from
whether injected memories actually get used) — v1 only writes it.

## What Ambient Recall deliberately does NOT do (v1)

No word2vec, no separate TF-IDF engine (BM25 already covers the useful
lexical case), no PMI gate (a config stub exists for later), no learned
model. The deterministic pipeline first; learning only once the log
proves what it should learn.
