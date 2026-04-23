"""NeuroVault retrieval eval harness.

Measures hit@k + MRR on a hand-curated test set so we can compare
retrieval quality *objectively* before and after scoring changes.

Why title-matching instead of engram-id matching:
  - Engram ids rotate when notes are deleted + recreated (dedupe test
    notes, manual re-imports) but titles are stable + human-readable.
  - A user editing `testset.jsonl` can validate expectations by eye
    without having to dig into the DB.
  - The `expect` field is an OR-list: hit if *any* listed title
    appears in the top-k hits. Lets a single query match a set of
    plausible answers ("Backend: Retrieval" OR "Hybrid Retrieval")
    without forcing one canonical answer.

Usage:
    python eval/run_eval.py                      # run + print report
    python eval/run_eval.py --save baseline      # also save to baselines/<name>.json
    python eval/run_eval.py --compare baseline   # diff against saved baseline

No external deps — stdlib only, matches mcp_proxy's footprint rule.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


API_BASE = os.environ.get("NEUROVAULT_API_URL", "http://127.0.0.1:8765").rstrip("/")
HERE = Path(__file__).parent
TESTSET = HERE / "testset.jsonl"
BASELINES = HERE / "baselines"

# Max hits to request per query — we compute hit@1..10, bigger is wasted.
RECALL_LIMIT = 10

# How many warm-up calls to make so the embedder model is loaded before
# we start timing. The first recall after a cold start pays ~300-800ms
# of ONNX load that skews the per-query numbers.
WARMUP_QUERIES = ["warmup probe one", "warmup probe two"]

# Throttle-hint sentinel from the Rust retriever. When we see it in
# the top-k we skip it for ranking purposes — it's a UX signal, not
# a real hit.
THROTTLE_HINT_ID = "__throttle_hint__"


@dataclass
class QueryResult:
    """One row of the eval. Populated per test case, aggregated later
    for the report."""
    id: str
    query: str
    expected: list[str]
    got_titles: list[str]          # top-10 titles after filtering throttle-hints
    first_hit_rank: int | None      # 1-indexed rank of first matching expected; None = miss
    latency_ms: float


def recall(
    query: str,
    limit: int = RECALL_LIMIT,
    ablate: str | None = None,
    rerank: bool = False,
) -> list[dict[str, Any]]:
    """One /api/recall call. Raises if the server isn't up — there's
    no point continuing an eval without a target.

    `ablate` is a comma-separated list of scoring features to disable
    (see RecallOpts docstring). `rerank` enables the cross-encoder
    second-stage reranker. Both default to the production config."""
    params: dict[str, Any] = {"q": query, "limit": limit}
    if ablate:
        params["ablate"] = ablate
    if rerank:
        params["rerank"] = "true"
    url = f"{API_BASE}/api/recall?{urllib.parse.urlencode(params)}"
    with urllib.request.urlopen(url, timeout=60) as resp:
        body = resp.read().decode("utf-8")
        return json.loads(body) if body else []


def load_testset(path: Path) -> list[dict[str, Any]]:
    """Read the JSONL testset. Each line is one case. Blank lines
    and lines starting with `//` are skipped (comments)."""
    if not path.exists():
        sys.exit(f"testset not found: {path}")
    out = []
    for i, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("//"):
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError as e:
            sys.exit(f"testset line {i}: {e}")
    return out


def run_case(
    case: dict[str, Any],
    ablate: str | None = None,
    rerank: bool = False,
) -> QueryResult:
    """Execute one test case. Drops the throttle-hint sentinel if the
    rate limiter happened to fire during the run — we want to measure
    *retrieval quality*, not the limiter's behaviour."""
    t0 = time.perf_counter()
    hits = recall(case["query"], ablate=ablate, rerank=rerank)
    latency_ms = (time.perf_counter() - t0) * 1000.0

    real_hits = [h for h in hits if h.get("engram_id") != THROTTLE_HINT_ID]
    titles = [h.get("title", "") for h in real_hits]
    expected = [e.lower() for e in case.get("expect", [])]

    # Title match is case-insensitive + exact. We intentionally don't
    # fuzzy-match: a noisy match would inflate hit@k and hide real
    # regressions. If the testset needs looser matching, add synonym
    # rows to `expect` instead.
    first_rank: int | None = None
    for i, title in enumerate(titles, 1):
        if title.lower() in expected:
            first_rank = i
            break

    return QueryResult(
        id=case.get("id", case["query"][:40]),
        query=case["query"],
        expected=case.get("expect", []),
        got_titles=titles,
        first_hit_rank=first_rank,
        latency_ms=latency_ms,
    )


def compute_metrics(results: list[QueryResult]) -> dict[str, float]:
    """hit@k = fraction of cases where a matching title appears in
    top-k. MRR = mean of 1/rank, missing cases contribute 0."""
    n = len(results)
    if n == 0:
        return {"n": 0, "hit@1": 0.0, "hit@3": 0.0, "hit@5": 0.0, "hit@10": 0.0, "mrr": 0.0, "median_ms": 0.0}

    hit_at = lambda k: sum(1 for r in results if r.first_hit_rank and r.first_hit_rank <= k) / n
    mrr = sum(1.0 / r.first_hit_rank for r in results if r.first_hit_rank) / n
    return {
        "n": n,
        "hit@1": hit_at(1),
        "hit@3": hit_at(3),
        "hit@5": hit_at(5),
        "hit@10": hit_at(10),
        "mrr": mrr,
        "median_ms": statistics.median(r.latency_ms for r in results),
        "p95_ms": statistics.quantiles(
            (r.latency_ms for r in results), n=20, method="inclusive"
        )[18] if n >= 20 else max(r.latency_ms for r in results),
    }


def format_report(results: list[QueryResult], metrics: dict[str, float]) -> str:
    """Human-readable report. Shows per-query rank + what we got so
    you can eyeball failures, plus the summary row."""
    lines = []
    lines.append(f"{'id':<28} {'rank':>5} {'ms':>6}  top-3 titles (truncated)")
    lines.append("-" * 100)
    for r in results:
        rank_str = str(r.first_hit_rank) if r.first_hit_rank else "MISS"
        top3 = " | ".join(t[:25] for t in r.got_titles[:3]) or "(empty)"
        lines.append(f"{r.id:<28} {rank_str:>5} {r.latency_ms:>6.0f}  {top3}")
    lines.append("-" * 100)
    lines.append(
        f"n={metrics['n']}  hit@1={metrics['hit@1']:.2%}  hit@3={metrics['hit@3']:.2%}  "
        f"hit@5={metrics['hit@5']:.2%}  hit@10={metrics['hit@10']:.2%}  "
        f"MRR={metrics['mrr']:.3f}  median={metrics['median_ms']:.0f}ms  p95={metrics['p95_ms']:.0f}ms"
    )
    return "\n".join(lines)


def save_baseline(name: str, results: list[QueryResult], metrics: dict[str, float]) -> Path:
    """Persist a run as a baseline for later comparison. JSON instead
    of JSONL so it's one clean object you can diff textually too."""
    BASELINES.mkdir(parents=True, exist_ok=True)
    path = BASELINES / f"{name}.json"
    payload = {
        "saved_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "metrics": metrics,
        "results": [
            {
                "id": r.id,
                "query": r.query,
                "expected": r.expected,
                "got_titles": r.got_titles,
                "first_hit_rank": r.first_hit_rank,
                "latency_ms": round(r.latency_ms, 1),
            }
            for r in results
        ],
    }
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    return path


def compare_baseline(name: str, metrics: dict[str, float], results: list[QueryResult]) -> str:
    """Diff the current run against a saved baseline. Highlights
    per-case rank changes (regressions in red, wins in green when
    stderr is a terminal) and the delta on each summary metric."""
    path = BASELINES / f"{name}.json"
    if not path.exists():
        return f"(no baseline at {path})"
    base = json.loads(path.read_text(encoding="utf-8"))
    base_metrics = base["metrics"]
    base_results = {r["id"]: r for r in base["results"]}

    lines = [f"\nComparison vs `{name}` (saved {base.get('saved_at', '?')})"]
    lines.append("-" * 100)
    lines.append(f"{'id':<28} {'was':>5} {'now':>5} {'delta':>7}")
    lines.append("-" * 100)
    for r in results:
        was = base_results.get(r.id, {}).get("first_hit_rank")
        now = r.first_hit_rank
        was_s = str(was) if was else "MISS"
        now_s = str(now) if now else "MISS"
        if was == now:
            delta = "=="
        elif was is None and now:
            delta = "FIXED"  # was missing, now ranked
        elif was and now is None:
            delta = "BROKE"
        elif was and now:
            delta = f"{now - was:+d}"
        else:
            delta = "=="
        lines.append(f"{r.id:<28} {was_s:>5} {now_s:>5} {delta:>7}")
    lines.append("-" * 100)

    def diff(key: str, fmt: str = "{:.3f}") -> str:
        a = base_metrics.get(key, 0)
        b = metrics.get(key, 0)
        return f"{key}: " + fmt.format(a) + " → " + fmt.format(b) + f"  ({b - a:+.3f})"

    lines.append(diff("hit@1"))
    lines.append(diff("hit@3"))
    lines.append(diff("hit@5"))
    lines.append(diff("hit@10"))
    lines.append(diff("mrr"))
    lines.append(diff("median_ms", "{:.0f}ms"))
    lines.append(diff("p95_ms", "{:.0f}ms"))
    return "\n".join(lines)


def run_scenario(
    cases: list[dict[str, Any]],
    label: str,
    ablate: str | None = None,
    rerank: bool = False,
) -> tuple[list[QueryResult], dict[str, float]]:
    """Run one full pass of the testset with a specific feature
    configuration. Returns `(results, metrics)`. Used by both the
    single-run path and the matrix runner."""
    print(f"\n=== {label} ===")
    results = [run_case(c, ablate=ablate, rerank=rerank) for c in cases]
    metrics = compute_metrics(results)
    print(format_report(results, metrics))
    return results, metrics


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--save", metavar="NAME", help="Save results as baselines/<NAME>.json")
    parser.add_argument("--compare", metavar="NAME", help="Diff against baselines/<NAME>.json")
    parser.add_argument("--skip-warmup", action="store_true", help="Skip embedder warmup (reuse a warm instance)")
    parser.add_argument("--ablate", metavar="FEATURES", help="Disable scoring features (comma-separated)")
    parser.add_argument("--rerank", action="store_true", help="Enable cross-encoder reranker")
    parser.add_argument(
        "--matrix",
        action="store_true",
        help="Run the full ablation + rerank matrix instead of one scenario",
    )
    args = parser.parse_args()

    # Sanity-check that the server is up before chewing through the set.
    try:
        with urllib.request.urlopen(f"{API_BASE}/api/health", timeout=5) as r:
            r.read()
    except (urllib.error.URLError, OSError) as e:
        sys.exit(f"NeuroVault HTTP server isn't responding on {API_BASE}: {e}\n"
                 f"Start the desktop app first.")

    cases = load_testset(TESTSET)
    print(f"loaded {len(cases)} cases from {TESTSET.name}")

    if not args.skip_warmup:
        print("warming up embedder…")
        for q in WARMUP_QUERIES:
            try:
                recall(q)
            except Exception:
                pass  # warmup failures are non-fatal; actual eval will surface them

    if args.matrix:
        # Matrix mode: runs a fixed set of ablation + rerank
        # scenarios and prints a summary grid at the end. Useful
        # for the one-shot question "which signals earn their weight?"
        scenarios: list[tuple[str, str | None, bool]] = [
            # (label,                                      ablate,             rerank)
            ("baseline (full pipeline)",                    None,                False),
            ("-title_semantic",                              "title_semantic",    False),
            ("-title_keyword",                               "title_keyword",     False),
            ("-decision",                                    "decision",          False),
            ("-recency",                                     "recency",           False),
            ("-supersede",                                   "supersede",         False),
            ("-entity_graph",                                "entity_graph",      False),
            ("-query_expansion",                             "query_expansion",   False),
            ("-insight_boost",                               "insight_boost",     False),
            ("-title_semantic,title_keyword",                "title_semantic,title_keyword", False),
            ("-decision,-recency (lean)",                     "decision,recency",  False),
            ("+reranker",                                    None,                True),
            ("+reranker lean (no decision/recency)",         "decision,recency",  True),
        ]
        summary: list[tuple[str, dict[str, float]]] = []
        for label, ab, rr in scenarios:
            _, m = run_scenario(cases, label, ablate=ab, rerank=rr)
            summary.append((label, m))
        print("\n\n" + "=" * 100)
        print("SUMMARY GRID")
        print("=" * 100)
        print(f"{'scenario':<44} {'hit@1':>7} {'hit@3':>7} {'hit@5':>7} {'MRR':>6} {'med_ms':>8}")
        print("-" * 100)
        base_metrics = summary[0][1]
        for label, m in summary:
            delta_h1 = m["hit@1"] - base_metrics["hit@1"]
            flag = "  " if abs(delta_h1) < 0.001 else ("UP" if delta_h1 > 0 else "DN")
            print(
                f"{label:<44} {m['hit@1']:>7.2%} {m['hit@3']:>7.2%} {m['hit@5']:>7.2%} "
                f"{m['mrr']:>6.3f} {m['median_ms']:>6.0f}ms {flag}"
            )
        return 0

    print("running eval…\n")
    results = [run_case(c, ablate=args.ablate, rerank=args.rerank) for c in cases]
    metrics = compute_metrics(results)
    print(format_report(results, metrics))

    if args.compare:
        print(compare_baseline(args.compare, metrics, results))

    if args.save:
        path = save_baseline(args.save, results, metrics)
        print(f"\nsaved baseline to {path}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
