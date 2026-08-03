# Curator benchmark — data

Offline harness for NeuroVault's planned **Local Memory Curator**: a small local
model that reads a bounded slice of an agent session and proposes durable
memories (facts / preferences / decisions) with a verbatim evidence quote.

This file covers the **data half** — building the ExperienceUnits the benchmark
runs on. The runner/scoring half is documented in `README-harness.md`.

> Offline tooling only. Nothing here ships in the app, and the app never
> invokes it — same rule as `eval/run_eval.py`.

---

## The local-only rule

`units/` contains slices of **real Claude Code session transcripts from this
machine**. They are redacted for secrets, but they are still the owner's private
work: client names, unreleased product decisions, personal projects.

- **Never commit `units/`, `gold/`, `results/`, or `units_manifest.json`.**
  `.gitignore` in this directory enforces that. Do not weaken it.
- Never paste unit text into a bug report, an issue, a PR, or a hosted model.
  The benchmark runs against a **local** model (Ollama on loopback) precisely so
  the data never leaves the machine.
- Only the tooling — `build_units.py`, the harness scripts, the prompts, this
  README — is committable.

---

## What is an ExperienceUnit?

A bounded slice of one session, not a whole transcript:

- **~2,000-4,000 approximate tokens** (approximated as `len(text) / 4`; no
  tokenizer dependency).
- A run of **consecutive turns** from a single session, rendered as a readable
  interleaved transcript with role markers.
- Cut at a **USER turn** wherever possible, so a unit reads as "a request and
  what happened next" rather than an arbitrary window.

That mirrors what the real curator sees at runtime: it is handed a bounded
window per turn/session, never a whole conversation.

What goes into the text:

| Line | Kept? | Why |
| --- | --- | --- |
| `USER: …` | yes | the highest-signal source of durable content |
| `ASSISTANT: …` | yes | decisions and rationale usually land here |
| `ASSISTANT [tool:Bash] npm run tauri dev` | yes, one line | shows *what happened* without the payload |
| `TOOL_RESULT: …` (≤ 400 chars) | yes | short results are context |
| `TOOL_RESULT: [12043 chars omitted] …` | summarised | bulk file dumps swamp the signal; the real curator gets bounded evidence, not raw dumps |
| assistant `thinking` blocks | no | not part of the transcript the curator is given |
| CLI wrapper text (`<system-reminder>`, `<command-name>`, quota notices, IDE hints) | no | the user never said it, so it must not become "evidence" |

---

## Running it

```bash
# Build the default 100 units from ~/.claude/projects
python3 eval/curator/build_units.py

# See the stats without writing anything
python3 eval/curator/build_units.py --dry-run

# Bigger/smaller set, different mix
python3 eval/curator/build_units.py --target 80 --negative-frac 0.25

# Leave a project out entirely (substring match on the project dir)
python3 eval/curator/build_units.py --exclude-project ATH-FAMILY --exclude-project JOB

# Extra scrubbing for emails / phone numbers / postcodes
python3 eval/curator/build_units.py --redact-contact
```

Python 3 **stdlib only** — no venv, no pip, no network. A full run over ~2 GB of
transcripts takes about 10 seconds.

Output:

```
eval/curator/units/unit_<session8>-<turn_index>.json   # one unit per file
eval/curator/units_manifest.json                       # stats + index
```

Unit ids are derived from the session id and the turn offset, so a rerun over
unchanged transcripts produces the **same ids** — gold labels keyed on
`unit_id` survive a rebuild.

### Unit format

```jsonc
{
  "unit_id": "5e510a6c-2920",
  "session_id": "5e510a6c-4595-46dc-9346-8cf5187a2eb0",
  "project": "NeuroVault",
  "approx_tokens": 3275,
  "created_range": { "start": "2026-07-07T23:16:19Z", "end": "2026-07-09T05:42:14Z" },
  "text": "USER: …\n\nASSISTANT: …\n\nASSISTANT [tool:Bash] cargo test\n\n…",
  "meta": {
    "source_file": "…/<session>.jsonl",
    "session_date": "2026-07-07",
    "n_turns": 24, "user_turns": 5, "user_chars": 1840, "tool_lines": 9,
    "redactions": { "CREDENTIAL": 1 }, "redaction_count": 1,
    "heuristic_label": "positive", "heuristic_score": 19.0,
    "heuristic_terms": ["decided", "i_prefer", "from_now_on"]
  }
}
```

The six top-level fields are the contract; `meta` is additive and exists to make
gold labelling and error analysis easier. The harness only reads `unit_id` and
`text`.

---

## The pipeline

1. **Discover.** `<projects-dir>/<project>/<session-uuid>.jsonl` — the main
   session transcripts. Subagent transcripts nested under
   `<session>/subagents/**` are skipped unless `--include-subagents`; sidechain
   records inside a main file are skipped unless `--include-sidechain`.
   Any path containing `_private` or `.private` is never opened.
2. **Parse defensively.** Schema-drift tolerant: unknown record types, missing
   fields and unparseable lines are counted, not fatal. Lines are read through a
   chunked reader with a size cap, because real transcripts contain single lines
   of tens of MB (embedded images) and whole files of 350 MB+.
3. **Group** consecutive turns into ~2,000-4,000-token units. A slice with no
   user turn at all is discarded (`dropped_no_user_turn` in the manifest) — a
   unit should stand on its own, and pure agent monologue has no requester to
   attribute a preference to.
4. **Redact** (mandatory, before anything is written — see below).
5. **Heuristically pre-label** each unit.
6. **Select** for diversity across projects, sessions and dates.

### Redaction

Runs on every unit before it is written. Matches become
`[REDACTED:<TYPE>]`; for `CREDENTIAL` the key name survives
(`password=[REDACTED:CREDENTIAL]`) so the sentence still reads.

`PRIVATE_KEY` (PEM blocks) · `ANTHROPIC_KEY` (`sk-ant-…`) · `API_KEY` (`sk-…`) ·
`GITHUB_TOKEN` (`ghp_`/`github_pat_`) · `SLACK_TOKEN` (`xox…`) · `AWS_KEY`
(`AKIA…`) · `GOOGLE_API_KEY` (`AIza…`) · `JWT` · `BEARER` · `CREDENTIAL`
(`password=` / `token:` / `api_key=` …) · `BASE64` (≥40 chars, mixed-case +
digits) · `HEX` (≥32 chars — this also catches git SHAs, which is deliberate)

Then:

- a unit with **more than 5 redactions** (`--max-redactions`) is **dropped
  entirely** — too sensitive or too noisy to be a useful benchmark item;
- `--redact-contact` adds emails, phone numbers and UK postcodes. Off by default
  so redaction counts stay a meaningful "how secret-y is this unit" signal.

Redaction is best-effort pattern matching, not a guarantee. It is the second
line of defence; the first is `.gitignore` and keeping the data local.

### Heuristic pre-labels

`heuristic_label` is a **selection aid, not a gold label**. Gold labels come
from a separate human/judge pass over ~50 of these units.

- **positive** — contains durable-sounding language: `decided`, `let's use`,
  `I prefer`, `from now on`, `remember this`, `instead of`, `the rule is`,
  `we use`, version numbers.
- **negative** — the opposite on purpose: low signal, tool-dominated, the user
  saying "continue"/"fix it" while the agent churns through edits. The benchmark
  needs "nothing durable here" cases to measure **over-extraction**, so ~20%
  (`--negative-frac`) of the set is selected from this pool.
- **neutral** — in between; used only to top up a short set.

### Selection

Round-robin across projects, then across sessions within a project (ordered by
date), capped at `--per-session-cap` units per session and
`--per-project-frac` of the target per project. Negatives are filled first
because they are the scarce pool and the per-session cap is shared. The result
is a set spread over many sessions and many dates rather than 100 units from one
mega-session.

---

## Flags

| Flag | Default | What it does |
| --- | --- | --- |
| `--projects-dir` | `~/.claude/projects` | where session JSONL lives |
| `--out-dir` / `--manifest` | `units/`, `units_manifest.json` | outputs |
| `--target` | `100` | how many units to select |
| `--negative-frac` | `0.2` | share of likely-negative units |
| `--min-tokens` / `--max-tokens` | `2000` / `4000` | unit size band |
| `--floor-tokens` | `1000` | discard anything smaller |
| `--max-redactions` | `5` | drop a unit above this |
| `--tool-result-max-chars` | `400` | above this a tool result is summarised away |
| `--per-session-cap` | `5` | anti-mega-session cap |
| `--per-project-frac` | `0.22` | anti-mega-project cap |
| `--positive-threshold` | `3.0` | durable-language score for `positive` |
| `--exclude-project` | — | repeatable substring exclusion |
| `--redact-contact` | off | also scrub emails / phones / postcodes |
| `--include-subagents` / `--include-sidechain` | off | widen the source set |
| `--max-file-mb` / `--max-line-mb` | `200` / `4` | read caps for huge transcripts |
| `--dry-run` | off | print stats, write nothing |
| `--no-clean` | off | keep existing `unit_*.json` instead of replacing |

## Manifest

`units_manifest.json` records the run parameters plus:

- `discovery` — files read, lines seen, unparseable lines, oversized lines
  skipped, private paths skipped;
- `candidates` — pool size, heuristic split, units dropped by the redaction
  limit / size floor;
- `selected` — final split, units per project, units per date, distinct sessions;
- `tokens` — min / p25 / median / p75 / max / mean / total;
- `redactions` — totals by type, for the selected set and for the whole pool;
- `units` — the index (id, project, date, tokens, label, redaction count).

Read it after every rebuild. If `lines_unparseable` jumps, the CLI's transcript
format has drifted and `extract_turns` needs a look.
# Curator benchmark — harness half

> Merge target: the harness sections of `eval/curator/README.md`.
> The units / data-generation sections are owned separately.

Picks the local model that becomes NeuroVault's bundled **Local Memory Curator**:
a ≤2B model that reads one bounded ExperienceUnit (a 2–4K-token transcript slice)
and emits schema-constrained JSON proposals of durable memories, each carrying a
verbatim evidence quote.

Python 3 stdlib only. Ollama on `localhost:11434` is the only dependency.

## Files

| File | Role |
|---|---|
| `schema.json` | draft-07 proposal schema, passed to Ollama as `format` |
| `prompts/extract.txt` | extraction prompt, 2 inline few-shot examples |
| `run_bench.py` | drives one model over the units, records raw output + latency |
| `verify.py` | deterministic G1/G2/G3 gauntlet, model-free |
| `score.py` | metrics vs gold, emits `metrics.json` + markdown table |
| `smoke_test.py` | 2 synthetic units end-to-end; proves the plumbing |

## Running

```bash
# 0. sanity-check the whole pipeline (writes its own fixtures)
python eval/curator/smoke_test.py

# 1. one model over the real units
python eval/curator/run_bench.py --model qwen3:1.7b \
    --units-dir eval/curator/units --out eval/curator/results/qwen3-1.7b

# 2. gauntlet
python eval/curator/verify.py \
    --results-dir eval/curator/results/qwen3-1.7b --units-dir eval/curator/units

# 3. score one model, or several side by side
python eval/curator/score.py \
    --results-dir eval/curator/results/qwen3-1.7b eval/curator/results/nuextract-2b \
    --gold-dir eval/curator/gold --units-dir eval/curator/units
```

`run_bench.py` is **idempotent** — a unit already present in the results dir is
skipped, so an interrupted sweep resumes. `--force` re-runs everything.
Timeouts and HTTP errors are recorded as result rows, never raised; a long
sweep cannot die partway.

## Gold format

`gold/unit_<id>.gold.json`:

```json
{"gold_proposals": [{"statement": "...", "must_match_terms": ["5433"]}],
 "nothing_durable": false}
```

A proposal **matches** a gold item when every `must_match_terms` entry appears
in the proposal's `statement`, case-insensitively. Crude on purpose: term lists
are auditable by eye and do not drift the way an embedding threshold would.
Write the terms tight enough that a *wrong* statement cannot satisfy them.
`gold_proposals: []` marks a gold-negative unit — the model should abstain.

## The gauntlet

| Gate | Checks | Verdict |
|---|---|---|
| **G1** grounding | `grounding_quote` is a verbatim substring of the unit. Exact first, then whitespace-normalized. | `reject(G1)` |
| **G2** containment | Numbers, versions, identifiers and capitalized names in `statement` appear in the quote — or failing that, in the unit. | `reject(G2)` |
| **G3** polarity | Statement asserts a settled preference/decision ("prefers", "always", "decided") over a quote that hedges ("might", "considering"). | `flag(G3)` |

Precedence G1 > G2 > G3. G3 only *flags* — it is a judgement call for a human.

G1 records **which** match succeeded: `exact`, `normalized`, `case_insensitive`,
or `none`. Only the first two pass. `case_insensitive` is broken out because it
is the signature of a model that trims or re-capitalizes a quote — one step from
paraphrasing, and worth measuring separately from outright fabrication.

## Metrics

Pre-registered. **Do not tune these after seeing results.**

- `degenerate_rate` — gold-positive units with zero proposals, for any reason
  (empty array, `{}`, parse error, timeout). The kill criterion for
  grammar-induced collapse.
- `abstention_correctness` — gold-negative units answered with the sanctioned
  abstention: `nothing_durable: true` **and** no proposals.
- `pre_gate_unsupported_rate` — G1 rejects / all proposals. How often the model
  invents a quote, measured *before* gating, because post-gate numbers hide it.
- `post_gate_precision` / `post_gate_recall` — vs gold, over proposals that
  survive the gauntlet.
- `over_extraction_rate` — gold-negative units with ≥1 surviving proposal, i.e.
  noise injected into a clean brain.
- `verifier_false_reject_rate` — rejected proposals whose statement *did* match
  gold. The gauntlet's own error rate; a high value means the gates are too
  tight, not that the model is bad.
- `incoherent_abstention_rate` — `nothing_durable: true` emitted *alongside*
  proposals. See below.
- `latency_p50_s` / `latency_p95_s` (warm), `cold_load_s` (measured once).
- `json_parse_failure_rate`.

Rates return `n/a`, never `0.0`, when the denominator is zero — "no negative
units in the set" must not read as "0% correct abstention".

## Two findings the harness is built around

**1. `think: false` is required for Qwen3 and it works.** Ollama 0.32.5 accepts
a top-level `think` boolean on `/api/chat`. With thinking left on, `qwen3:1.7b`
burns its budget reasoning under the JSON grammar and mismatches quotes to the
wrong turn; with `think: false` it is **3.3× faster** and grounds correctly.
`--think auto` (the default) sends `false` for known thinking families and omits
the field otherwise; a 400 triggers one retry without the field, so non-thinking
candidates still run.

**2. Incoherent abstention is real and cross-model.** Both candidates have been
observed setting `nothing_durable: true` *while* emitting proposals. Rule 7 of
the prompt states the constraint explicitly, and the runner records
`incoherent_abstention` per unit rather than trusting the flag. Consequence:
**`nothing_durable` is only authoritative when `proposals` is empty.** Anything
downstream — including the product — must treat it that way.

## Adding a candidate

Nothing to change. `run_bench.py` takes any Ollama tag, including `hf.co/...`
GGUF pulls. Unit loading accepts `.txt`, `.md`, `.json` (a bare string, a
text-ish key, or a message list) and `.jsonl`, so it does not care how the unit
builder writes them.
