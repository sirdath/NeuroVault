"""NeuroVault agentic evals — end-to-end behavior, not just retrieval.

The recall benchmark answers "did the right chunk come back?" This one
answers "did Claude actually use the memory correctly to behave the right
way?" Each test case is a scripted scenario:

1. **Setup turns** — facts written into the brain (`remember(...)`).
2. **Probe turn** — a question whose correct answer requires the setup facts.
3. **Scoring** — we run `recall(probe)` and check whether the right setup
   memory landed in the top-K AND whether the surfaced content contains
   one of the required answer phrases.

This catches failures the recall benchmark misses:
- Memory came back but the wrong chunk (right note, wrong section).
- Memory came back but the answer phrase wasn't in the preview.
- Memory came back but a *contradicting* memory ranked higher.
- Recent memories drowning out the canonical fact.

Usage:
  cd engram/server
  uv run python ../benchmarks/run_agentic.py

Output:
  benchmarks/results/agentic-{timestamp}.json
"""

from __future__ import annotations

import json
import statistics
import sys
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "server"))

from engram_server.database import Database
from engram_server.embeddings import Embedder
from engram_server.bm25_index import BM25Index
from engram_server.ingest import ingest_file
from engram_server.retriever import hybrid_retrieve


@dataclass
class Scenario:
    """One end-to-end behavioral test case."""
    name: str
    description: str
    setup: list[tuple[str, str]]            # (title, content) memories to seed
    probe: str                              # the query Claude would issue
    expected_titles: list[str]              # any of these titles must appear in top-K
    must_contain: list[str]                 # at least one phrase must show in preview
    forbidden_titles: list[str] = field(default_factory=list)  # must NOT outrank expected
    top_k: int = 5
    tags: list[str] = field(default_factory=list)


# --- Scenarios ----------------------------------------------------------------

SCENARIOS: list[Scenario] = [
    Scenario(
        name="basic-fact-recall",
        description="A single fact stored once is retrievable by paraphrase.",
        setup=[
            ("My Editor Preference",
             "I prefer Neovim with the LazyVim distribution for everyday editing."),
        ],
        probe="What text editor do I use?",
        expected_titles=["My Editor Preference"],
        must_contain=["Neovim", "LazyVim"],
        tags=["fact", "paraphrase"],
    ),
    Scenario(
        name="superseded-fact",
        description="Newer fact should outrank older contradicting fact.",
        setup=[
            ("Database Choice",
             "We're using PostgreSQL for the main database."),
            ("Database Migration",
             "We migrated from PostgreSQL to SQLite with sqlite-vec for the embedding store."),
        ],
        probe="What database are we using right now?",
        expected_titles=["Database Migration"],
        must_contain=["SQLite", "sqlite-vec"],
        forbidden_titles=["Database Choice"],
        tags=["temporal", "contradiction"],
    ),
    Scenario(
        name="vocab-mismatch",
        description="The probe uses different words than the stored memory.",
        setup=[
            ("Authentication Strategy",
             "API endpoints validate JWT bearer tokens against the issuer's JWKS."),
        ],
        probe="How do we verify users on the API?",
        expected_titles=["Authentication Strategy"],
        must_contain=["JWT", "bearer"],
        tags=["semantic"],
    ),
    Scenario(
        name="entity-disambiguation",
        description="Question names a specific entity; the right note must surface.",
        setup=[
            ("Sarah - Project Lead",
             "Sarah is the dissertation supervisor and runs the weekly check-ins on Tuesdays."),
            ("Sam - Designer",
             "Sam handles the visual design for the Tauri app."),
        ],
        probe="Who runs the weekly check-ins?",
        expected_titles=["Sarah - Project Lead"],
        must_contain=["Sarah", "Tuesday"],
        forbidden_titles=["Sam - Designer"],
        tags=["entity"],
    ),
    Scenario(
        name="multi-fact-synthesis",
        description="Probe requires multiple memories — both should appear in top-K.",
        setup=[
            ("Build System",
             "We build the Tauri app with `cargo tauri build` for the desktop bundle."),
            ("Server Boot",
             "The Python MCP server is started via `uv run python -m engram_server`."),
        ],
        probe="How do I run the project locally?",
        expected_titles=["Build System", "Server Boot"],
        must_contain=["cargo tauri", "uv run"],
        top_k=5,
        tags=["multi-hop"],
    ),
    Scenario(
        name="rare-acronym",
        description="Acronym that only appears once in the corpus must be findable.",
        setup=[
            ("BG3 Save Format",
             "Baldur's Gate 3 (BG3) saves use a custom LSV container with LSF/LSX subfiles."),
        ],
        probe="What format does BG3 use for saves?",
        expected_titles=["BG3 Save Format"],
        must_contain=["LSV", "LSF"],
        tags=["acronym", "rare-token"],
    ),
    Scenario(
        name="negative-fact",
        description="A 'we don't do X' memory should win over 'we considered X'.",
        setup=[
            ("Considered: Redis Cache",
             "Early in the project we considered Redis for caching embeddings."),
            ("Decision: No Redis",
             "We decided NOT to use Redis — sqlite-vec already handles caching well enough."),
        ],
        probe="Are we using Redis?",
        expected_titles=["Decision: No Redis"],
        must_contain=["NOT", "sqlite-vec"],
        forbidden_titles=["Considered: Redis Cache"],
        tags=["negation", "decision"],
    ),
    Scenario(
        name="fresh-intent-query",
        description="A query with 'latest' in it should favor the newest fact.",
        setup=[
            ("Editor Preference v1",
             "I use VSCode with the Vim extension for daily editing."),
            ("Editor Preference v2",
             "I switched to Neovim with LazyVim — the latest setup is much faster."),
        ],
        probe="What's my latest editor setup?",
        expected_titles=["Editor Preference v2"],
        must_contain=["Neovim", "LazyVim"],
        forbidden_titles=["Editor Preference v1"],
        tags=["temporal", "fresh-intent"],
    ),
    Scenario(
        name="historical-intent-query",
        description="A query with 'originally' should favor the older fact, even if a newer one exists.",
        setup=[
            # Order matters: the "original" memory must be ingested first so
            # its timestamp is actually older. The retriever uses updated_at
            # ordering; it can only treat as "historical" what is actually
            # temporally older in the DB.
            ("Initial DB Decision",
             "Originally we used PostgreSQL for the main database back when the project started."),
            ("Current DB",
             "We now use SQLite with sqlite-vec for the embedding store."),
        ],
        probe="What database did we originally use?",
        expected_titles=["Initial DB Decision"],
        must_contain=["PostgreSQL", "Originally"],
        forbidden_titles=["Current DB"],
        tags=["temporal", "historical-intent"],
    ),
    Scenario(
        name="long-tail-detail",
        description="A detail buried inside a longer note must surface.",
        setup=[
            ("Tauri Architecture Overview",
             "The Tauri app has three layers: a React frontend, a Rust shell that "
             "exposes Tauri commands, and an HTTP bridge to the Python MCP server. "
             "The HTTP bridge listens on port 8765 by default. The Rust shell "
             "uses tao for windowing and wry for the webview."),
        ],
        probe="What port does the HTTP bridge use?",
        expected_titles=["Tauri Architecture Overview"],
        must_contain=["8765"],
        tags=["needle", "long-doc"],
    ),
]


# --- Harness ------------------------------------------------------------------

def setup_brain(scenario: Scenario) -> tuple[Database, Embedder, BM25Index, Path]:
    """Build a fresh per-scenario brain. Isolated so cases don't pollute each other."""
    tmp_dir = Path(tempfile.mkdtemp(prefix=f"neurovault-agentic-{scenario.name}-"))
    vault_dir = tmp_dir / "vault"
    vault_dir.mkdir()
    db_path = tmp_dir / "test.db"

    db = Database(db_path)
    embedder = Embedder.get()
    bm25 = BM25Index()

    for title, content in scenario.setup:
        slug = "".join(c if c.isalnum() else "-" for c in title.lower()).strip("-")[:50]
        filename = f"{slug}-{uuid.uuid4().hex[:6]}.md"
        path = vault_dir / filename
        path.write_text(f"# {title}\n\n{content}", encoding="utf-8")
        ingest_file(path, db, embedder, bm25)

    bm25.build(db)
    return db, embedder, bm25, vault_dir


def score_scenario(scenario: Scenario) -> dict:
    """Run one scenario and return per-test stats."""
    db, embedder, bm25, _ = setup_brain(scenario)

    t0 = time.perf_counter()
    hits = hybrid_retrieve(scenario.probe, db, embedder, bm25, top_k=scenario.top_k)
    latency_ms = (time.perf_counter() - t0) * 1000

    hit_titles = [h["title"] for h in hits]
    hit_contents = [(h.get("content") or h.get("preview") or "") for h in hits]

    expected_found = [t for t in scenario.expected_titles if t in hit_titles]
    expected_ranks = {
        t: hit_titles.index(t) + 1 for t in expected_found
    }

    forbidden_above = []
    for forbidden in scenario.forbidden_titles:
        if forbidden not in hit_titles:
            continue
        f_rank = hit_titles.index(forbidden) + 1
        for exp_rank in expected_ranks.values():
            if f_rank < exp_rank:
                forbidden_above.append({"title": forbidden, "rank": f_rank})
                break

    blob = " ".join(hit_contents).lower()
    phrases_found = [p for p in scenario.must_contain if p.lower() in blob]

    # Pass criteria:
    #   1. all expected titles appear in top_k
    #   2. at least one must_contain phrase shows in surfaced content
    #   3. no forbidden title outranks an expected one
    pass_recall = len(expected_found) == len(scenario.expected_titles)
    pass_phrases = bool(phrases_found) if scenario.must_contain else True
    pass_forbidden = not forbidden_above
    passed = pass_recall and pass_phrases and pass_forbidden

    return {
        "name": scenario.name,
        "description": scenario.description,
        "probe": scenario.probe,
        "passed": passed,
        "pass_recall": pass_recall,
        "pass_phrases": pass_phrases,
        "pass_forbidden": pass_forbidden,
        "expected_titles": scenario.expected_titles,
        "expected_ranks": expected_ranks,
        "phrases_found": phrases_found,
        "phrases_missing": [p for p in scenario.must_contain if p not in phrases_found],
        "forbidden_above": forbidden_above,
        "top_hits": hit_titles[:scenario.top_k],
        "latency_ms": round(latency_ms, 1),
        "tags": scenario.tags,
    }


def run() -> dict:
    print(f"Running {len(SCENARIOS)} agentic scenarios...")
    print("=" * 70)

    results: list[dict] = []
    for scenario in SCENARIOS:
        print(f"\n[{scenario.name}] {scenario.description}")
        try:
            result = score_scenario(scenario)
        except Exception as e:
            result = {
                "name": scenario.name,
                "passed": False,
                "error": str(e),
                "tags": scenario.tags,
            }
        results.append(result)

        marker = "PASS" if result.get("passed") else "FAIL"
        print(f"  {marker}  ", end="")
        if result.get("error"):
            print(f"error: {result['error']}")
        else:
            print(
                f"recall={'Y' if result['pass_recall'] else 'N'} "
                f"phrases={'Y' if result['pass_phrases'] else 'N'} "
                f"forbidden={'Y' if result['pass_forbidden'] else 'N'} "
                f"({result['latency_ms']}ms)"
            )
            if not result["passed"]:
                print(f"     top hits: {result['top_hits']}")
                if result["phrases_missing"]:
                    print(f"     missing phrases: {result['phrases_missing']}")
                if result["forbidden_above"]:
                    print(f"     forbidden above expected: {result['forbidden_above']}")

    total = len(results)
    passed = sum(1 for r in results if r.get("passed"))
    pass_rate = passed / total if total else 0
    latencies = [r["latency_ms"] for r in results if "latency_ms" in r]

    summary = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "total": total,
        "passed": passed,
        "failed": total - passed,
        "pass_rate": round(pass_rate, 3),
        "median_latency_ms": round(statistics.median(latencies), 1) if latencies else None,
        "scenarios": results,
    }

    print("\n" + "=" * 70)
    print(f"PASSED {passed}/{total}  ({pass_rate:.0%})")
    if latencies:
        print(f"Median latency: {summary['median_latency_ms']}ms")

    out_dir = Path(__file__).parent / "results"
    out_dir.mkdir(exist_ok=True)
    out_path = out_dir / f"agentic-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}.json"
    out_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(f"\nResults written to {out_path}")

    return summary


if __name__ == "__main__":
    run()
