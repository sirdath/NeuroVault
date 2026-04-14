"""Usefulness + token-savings benchmark for NeuroVault.

Answers two honest questions:

  1. **Usefulness**: if a user casually drops facts in conversation, does the
     brain later retrieve the right fact when they ask about it? Measured as
     top-1 hit rate, top-3 hit rate, and mean reciprocal rank across a seeded
     probe set.

  2. **Token savings**: how many tokens does a recall answer cost compared
     to the "paste the whole vault" / "re-explain every session" baseline?

The bench talks to a live engram HTTP server on 127.0.0.1:8765. It:
  - seeds N real-world facts via the hooks endpoint (same path Claude Code
    uses), exercising the Stage 5 extractor end-to-end
  - asks M probe questions via /api/recall and checks whether the intended
    insight appears in the top-k results
  - reports hit rate, MRR, and estimated tokens saved per query

Run it with the server up:  python benchmarks/bench_usefulness.py
"""

from __future__ import annotations

import json
import time
import urllib.request
import urllib.error
import urllib.parse
from dataclasses import dataclass

SERVER = "http://127.0.0.1:8765"
SESSION = "bench-usefulness"


# --- Seed corpus: facts a real user might drop casually in chat --------

SEEDS: list[str] = [
    "I prefer Tauri 2.0 over Electron for desktop apps because the bundle size is smaller.",
    "We decided to use sqlite-vec for embeddings instead of Chroma.",
    "I use Neovim with LazyVim as my main editor.",
    "We're using FastAPI for the HTTP layer.",
    "The deadline for the beta release is next Friday at 5pm.",
    "Remember that Sarah runs the weekly check-ins on Thursdays.",
    "I don't use Electron for new desktop projects anymore.",
    "FYI the staging database credentials are in vault/staging.yml.",
    "We chose Rust for the Tauri backend because of memory safety.",
    "I prefer dark mode and monospace fonts in all my tools.",
    "btw the CI pipeline runs on GitHub Actions with a Windows runner.",
    "Remember that Marcus owns the billing integration.",
    "We're deploying the API to Fly.io in the iad region.",
    "I always use ripgrep instead of grep for code search.",
    "The team agreed on trunk-based development with short-lived branches.",
]


# --- Probe set: questions phrased differently from the seed sentences.
# Each probe lists keywords we expect to find in the top-1 recall result.
# (Keywords over exact-match to avoid brittleness and test semantic recall.)

@dataclass
class Probe:
    question: str
    expected_any: list[str]     # top result must contain AT LEAST ONE of these
    category: str


PROBES: list[Probe] = [
    Probe("what desktop framework do I like?", ["Tauri"], "preference"),
    Probe("which vector store did we pick for embeddings?", ["sqlite-vec"], "decision"),
    Probe("what editor do I use day-to-day?", ["Neovim", "LazyVim"], "preference"),
    Probe("what's the HTTP framework on this project?", ["FastAPI"], "stack"),
    Probe("when is the beta release due?", ["Friday", "deadline"], "deadline"),
    Probe("who runs the weekly check-ins?", ["Sarah"], "explicit"),
    Probe("am I avoiding Electron?", ["Electron"], "anti-preference"),
    Probe("where are the staging credentials stored?", ["staging", "vault"], "explicit"),
    Probe("why did we pick Rust?", ["Rust", "memory"], "decision"),
    Probe("what theme do I like?", ["dark", "monospace"], "preference"),
    Probe("what CI system are we using?", ["GitHub Actions", "CI"], "explicit"),
    Probe("who owns billing?", ["Marcus", "billing"], "explicit"),
    Probe("where is the API deployed?", ["Fly", "iad"], "stack"),
    Probe("what do I use for code search?", ["ripgrep"], "preference"),
    Probe("what's our branching strategy?", ["trunk", "branches"], "decision"),
]


# --- HTTP helpers ------------------------------------------------------

def _post(path: str, body: dict, timeout: float = 120.0) -> dict:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        f"{SERVER}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _get(path: str, timeout: float = 60.0) -> dict | list:
    req = urllib.request.Request(f"{SERVER}{path}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


# --- Bench steps -------------------------------------------------------

def seed_facts() -> list[dict]:
    """Fire each seed as a UserPromptSubmit hook and collect the created insights."""
    created: list[dict] = []
    for idx, text in enumerate(SEEDS, 1):
        try:
            result = _post("/api/observations", {
                "event": "UserPromptSubmit",
                "payload": {
                    "session_id": f"{SESSION}-{idx}",
                    "prompt": text,
                },
            })
            for ins in (result.get("insights") or []):
                created.append({"seed": text, **ins})
        except urllib.error.HTTPError as e:
            print(f"  [seed {idx}] HTTP {e.code}: {e.read().decode()[:200]}")
    return created


def probe_recall(probe: Probe, limit: int = 5) -> tuple[int | None, list[dict], int]:
    """Run a recall query. Returns (hit_rank_1based, top_results, tokens_returned)."""
    q = urllib.parse.quote(probe.question)
    results = _get(f"/api/recall?q={q}&limit={limit}")
    if not isinstance(results, list):
        results = []

    approx_tokens = 0
    for r in results:
        approx_tokens += _approx_tokens(str(r.get("title", "")) + " " + str(r.get("content", "") or r.get("preview", "")))

    hit_rank: int | None = None
    for rank, r in enumerate(results, 1):
        haystack = (str(r.get("title", "")) + " " + str(r.get("content", "") or r.get("preview", ""))).lower()
        for kw in probe.expected_any:
            if kw.lower() in haystack:
                hit_rank = rank
                break
        if hit_rank is not None:
            break
    return hit_rank, results, approx_tokens


def _approx_tokens(text: str) -> int:
    # ~4 chars/token for English prose; good enough for relative compare
    return max(1, len(text) // 4)


# --- Main --------------------------------------------------------------

def main() -> int:
    print("=" * 72)
    print("NeuroVault usefulness + token bench")
    print("=" * 72)

    # Sanity: server up?
    try:
        _get("/api/brains/active")
    except Exception as e:
        print(f"server not reachable at {SERVER}: {e}")
        return 1

    import sys
    skip_seed = "--no-seed" in sys.argv
    if skip_seed:
        print("\n[1/3] Skipping seed (--no-seed) — assuming facts already in vault")
    else:
        print(f"\n[1/3] Seeding {len(SEEDS)} facts via UserPromptSubmit hook ...")
        t0 = time.time()
        created = seed_facts()
        t_seed = time.time() - t0
        print(f"      created {len(created)} insight engrams in {t_seed:.1f}s")
        pattern_counts: dict[str, int] = {}
        for c in created:
            pattern_counts[c["pattern"]] = pattern_counts.get(c["pattern"], 0) + 1
        for p, n in sorted(pattern_counts.items(), key=lambda kv: -kv[1]):
            print(f"        - {p:18} {n}")
        time.sleep(0.5)

    print(f"\n[2/3] Probing recall with {len(PROBES)} questions ...")
    hits_top1 = 0
    hits_top3 = 0
    hits_top5 = 0
    rr_sum = 0.0
    total_tokens = 0
    latencies: list[float] = []
    misses: list[tuple[Probe, list[dict]]] = []

    for probe in PROBES:
        t0 = time.time()
        rank, results, approx_tokens = probe_recall(probe, limit=5)
        latencies.append((time.time() - t0) * 1000)
        total_tokens += approx_tokens
        if rank is not None:
            if rank == 1:
                hits_top1 += 1
            if rank <= 3:
                hits_top3 += 1
            if rank <= 5:
                hits_top5 += 1
            rr_sum += 1.0 / rank
        else:
            misses.append((probe, results))

    n = len(PROBES)
    mrr = rr_sum / n
    avg_tokens = total_tokens / n
    latencies.sort()
    median_latency = latencies[len(latencies) // 2]

    # Two honest baselines for the token comparison:
    #
    #   (a) "no-memory" — user re-explains context each session. Typical
    #       onboarding preamble is ~50-100 tokens per fact they care about.
    #       With N facts seeded, worst case they paste all N facts back to
    #       the model every session.
    #   (b) "paste full vault" — upper bound where user just dumps every
    #       .md file they've ever saved. Grows unboundedly with vault size.
    no_memory_tokens = sum(_approx_tokens(s) for s in SEEDS)

    baseline_tokens = 0
    try:
        notes = _get("/api/notes?limit=500")
        if isinstance(notes, list):
            for n_note in notes:
                # Fetch full content one at a time if preview is truncated
                nid = n_note.get("id")
                if not nid:
                    continue
                try:
                    full = _get(f"/api/notes/{nid}")
                    content = str(full.get("content", "")) if isinstance(full, dict) else ""
                    baseline_tokens += _approx_tokens(content)
                except Exception:
                    baseline_tokens += _approx_tokens(str(n_note.get("preview", "")))
    except Exception:
        pass

    print(f"\n[3/3] Results")
    print("-" * 72)
    print(f"  Hit@1 (right fact is #1 result):   {hits_top1}/{n} = {hits_top1/n:.0%}")
    print(f"  Hit@3 (right fact in top 3):       {hits_top3}/{n} = {hits_top3/n:.0%}")
    print(f"  Hit@5 (right fact in top 5):       {hits_top5}/{n} = {hits_top5/n:.0%}")
    print(f"  MRR  (mean reciprocal rank):        {mrr:.3f}")
    print(f"  Median recall latency:              {median_latency:.0f} ms")
    print()
    print(f"  Tokens per recall answer (approx): {avg_tokens:.0f}")
    print(f"  Baseline A (re-explain N facts):   {no_memory_tokens}  tokens/session")
    print(f"  Baseline B (paste whole vault):    {baseline_tokens}  tokens/session")
    if no_memory_tokens > 0:
        per_query_vs_reexplain = 1 - (avg_tokens / no_memory_tokens)
        print(f"  Savings per query vs baseline A:   {per_query_vs_reexplain:+.1%}")
    if baseline_tokens > 0:
        per_query_vs_paste = 1 - (avg_tokens / baseline_tokens)
        print(f"  Savings per query vs baseline B:   {per_query_vs_paste:+.1%}")
    print()
    if misses:
        print(f"  Missed probes ({len(misses)}):")
        for probe, results in misses[:5]:
            top = results[0].get("title", "?") if results else "(no results)"
            print(f"    - '{probe.question}' -> top={top!r} (wanted any of {probe.expected_any})")
    else:
        print("  No misses.")
    print("=" * 72)

    # Exit 0 if Hit@3 >= 70% — sensible "good enough" threshold for a demo
    return 0 if hits_top3 / n >= 0.7 else 2


if __name__ == "__main__":
    import sys
    sys.exit(main())
