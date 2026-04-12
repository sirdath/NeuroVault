"""NeuroVault retrieval benchmark.

Reproducible recall@k evaluation against a curated test set of Q&A pairs.
Each test case has a question, an expected note title (the answer), and
a memory type. We measure:

- Top-1 accuracy (the right note is #1)
- Top-3 accuracy (right note in top 3)
- Top-5 accuracy (right note in top 5)
- MRR (Mean Reciprocal Rank)
- Median latency
- P95 latency

Usage:
  cd engram/server
  uv run python ../benchmarks/run_recall.py

Output:
  benchmarks/results/recall-{timestamp}.json
"""

import json
import statistics
import sys
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

# Add server to path
sys.path.insert(0, str(Path(__file__).parent.parent / "server"))

from engram_server.database import Database
from engram_server.embeddings import Embedder
from engram_server.bm25_index import BM25Index
from engram_server.ingest import ingest_vault
from engram_server.retriever import hybrid_retrieve


# Test corpus: 25 notes covering technology, productivity, dissertation, AI
TEST_CORPUS = [
    ("python-async.md", "Python Async Programming",
     """Python's asyncio library enables concurrent code using async/await syntax.
Coroutines are lightweight and ideal for I/O-bound tasks like API calls and
database queries. Use asyncio.gather() to run multiple coroutines in parallel."""),

    ("rust-ownership.md", "Rust Ownership Model",
     """Rust enforces memory safety through its ownership system without garbage
collection. Each value has a single owner, and the borrow checker prevents
data races at compile time. References can be shared (&T) or mutable (&mut T)."""),

    ("react-hooks.md", "React Hooks Best Practices",
     """React Hooks like useState, useEffect, and useMemo replace class lifecycle
methods. Always call hooks at the top level. Use useCallback to memoize
event handlers and prevent unnecessary re-renders."""),

    ("postgresql-indexing.md", "PostgreSQL Index Strategies",
     """PostgreSQL supports B-tree, hash, GiST, and GIN indexes. Use B-tree for
equality and range queries on ordinary columns. GIN indexes excel for full-text
search and JSON columns. Always EXPLAIN ANALYZE before adding indexes."""),

    ("docker-compose.md", "Docker Compose Orchestration",
     """Docker Compose lets you define multi-container applications in YAML.
Services share networks by default and can reference each other by name.
Use volumes for persistent data and depends_on for startup ordering."""),

    ("transformers-attention.md", "Transformer Attention Mechanism",
     """The transformer architecture uses self-attention to model relationships
between tokens in a sequence. Multi-head attention allows the model to focus
on different aspects of the input simultaneously. Positional encoding adds
sequence order information."""),

    ("rag-retrieval.md", "Retrieval Augmented Generation",
     """RAG combines a retriever with a generative model to ground LLM outputs
in external knowledge. The retriever uses dense vectors (embeddings) or
sparse matching (BM25). Hybrid retrieval combines both for better recall."""),

    ("vector-embeddings.md", "Vector Embeddings for Semantic Search",
     """Vector embeddings map text to high-dimensional vectors where similar
content has similar vectors. Models like sentence-transformers and OpenAI
ada-002 produce 384-1536 dimensional embeddings. Cosine similarity measures
how related two vectors are."""),

    ("git-rebasing.md", "Git Rebasing vs Merging",
     """Rebasing rewrites commit history to produce a linear sequence, while
merging preserves the branching structure with merge commits. Use rebase for
local feature branches and merge for shared branches. Never rebase published
commits."""),

    ("kubernetes-pods.md", "Kubernetes Pod Lifecycle",
     """A Kubernetes Pod is the smallest deployable unit, containing one or more
containers that share a network namespace. Pods are ephemeral. Use Deployments
to manage pod replicas and rolling updates."""),

    ("dissertation-structure.md", "Dissertation Chapter Structure",
     """A typical dissertation has: Introduction, Literature Review, Methodology,
Results, Discussion, Conclusion. The literature review establishes context and
identifies gaps. The methodology must be reproducible. Discussion interprets
results in light of existing work."""),

    ("citation-management.md", "Citation Management with Zotero",
     """Zotero is a free reference manager that integrates with Word and
LibreOffice. Better BibTeX extension exports stable citation keys for use in
LaTeX. Sync citations across devices via Zotero's free cloud."""),

    ("literature-review.md", "Writing a Literature Review",
     """A good literature review synthesizes rather than summarizes. Group sources
by theme, not chronologically. Identify gaps your research will address.
Use signal phrases to attribute claims and avoid plagiarism."""),

    ("research-questions.md", "Formulating Research Questions",
     """Strong research questions are specific, measurable, and feasible within
your timeframe. Use the PICO framework for clinical research: Population,
Intervention, Comparison, Outcome. Avoid yes/no questions."""),

    ("qualitative-coding.md", "Qualitative Data Coding Methods",
     """Qualitative coding categorizes interview transcripts and field notes.
Open coding identifies emerging themes. Axial coding finds relationships
between codes. Selective coding integrates around a core category. Use
software like NVivo or MAXQDA."""),

    ("statistical-significance.md", "Statistical Significance Testing",
     """A p-value below 0.05 conventionally indicates statistical significance,
meaning the result is unlikely under the null hypothesis. P-values do not
measure effect size. Always report confidence intervals alongside."""),

    ("memory-decay.md", "Ebbinghaus Forgetting Curve",
     """Hermann Ebbinghaus discovered that memory decays exponentially over
time after learning. Spaced repetition reviews material at increasing
intervals to combat forgetting. Tools like Anki use the SM-2 algorithm."""),

    ("knowledge-graphs.md", "Knowledge Graph Fundamentals",
     """Knowledge graphs represent entities as nodes and relationships as edges.
Triple stores like RDF use subject-predicate-object format. Property graphs
like Neo4j attach key-value pairs to both nodes and edges. SPARQL queries
RDF data."""),

    ("ml-overfitting.md", "Preventing Overfitting in Machine Learning",
     """Overfitting happens when a model memorizes training data and fails on
new examples. Combat with dropout, L2 regularization, early stopping, and
cross-validation. Always hold out a test set never used during training."""),

    ("api-design.md", "REST API Design Principles",
     """REST APIs use standard HTTP verbs: GET reads, POST creates, PUT updates,
DELETE removes. URLs identify resources, not actions. Use plural nouns for
collections. Return appropriate status codes (200, 201, 400, 404, 500)."""),

    ("typescript-generics.md", "TypeScript Generic Types",
     """Generics let you write reusable code that works with multiple types.
Use type parameters in angle brackets like Array<T>. Constrain generics with
extends keyword. Default type parameters provide fallback values."""),

    ("css-flexbox.md", "CSS Flexbox Layout",
     """Flexbox is a one-dimensional layout system for CSS. Set display:flex on
a container to make children flex items. justify-content controls main-axis
alignment, align-items controls cross-axis. flex-grow makes items expand."""),

    ("sqlite-performance.md", "SQLite Performance Tuning",
     """SQLite performs best with WAL journal mode and a large page cache.
Use prepared statements to avoid parsing overhead. Wrap multiple writes in
a transaction. Avoid SELECT * in production code paths."""),

    ("embeddings-dimensions.md", "Choosing Embedding Dimensions",
     """Higher embedding dimensions capture more nuance but cost more memory and
compute. 384 dims (bge-small) is a sweet spot for most use cases. 768-1024
dims (bge-base, OpenAI) for higher quality. 1536+ for cutting-edge models."""),

    ("memory-mcp-servers.md", "MCP Memory Servers for Claude",
     """Anthropic's Model Context Protocol lets external servers expose tools
to Claude Desktop. Memory servers persist context across sessions, eliminating
the need to re-explain projects every time. Local-first servers keep data
private."""),
]

# Test queries: question + expected note filename + difficulty
TEST_QUERIES = [
    # Easy (direct keyword overlap)
    ("How does Python async/await work?", "python-async.md", "easy"),
    ("What is Rust ownership?", "rust-ownership.md", "easy"),
    ("React useState hook best practices", "react-hooks.md", "easy"),
    ("PostgreSQL B-tree indexes", "postgresql-indexing.md", "easy"),
    ("Docker Compose YAML", "docker-compose.md", "easy"),

    # Medium (semantic but not exact words)
    ("How do transformers focus on different parts of input?", "transformers-attention.md", "medium"),
    ("What is RAG and how does it ground LLM outputs?", "rag-retrieval.md", "medium"),
    ("How are text embeddings created?", "vector-embeddings.md", "medium"),
    ("Should I rebase or merge my feature branch?", "git-rebasing.md", "medium"),
    ("Smallest deployable unit in K8s", "kubernetes-pods.md", "medium"),

    # Medium dissertation
    ("How do I structure my thesis chapters?", "dissertation-structure.md", "medium"),
    ("Reference manager that works with Word", "citation-management.md", "medium"),
    ("How to organize sources in a lit review", "literature-review.md", "medium"),
    ("Framework for clinical research questions", "research-questions.md", "medium"),
    ("How to analyze interview transcripts", "qualitative-coding.md", "medium"),

    # Hard (no keyword overlap, semantic only)
    ("What does p < 0.05 mean?", "statistical-significance.md", "hard"),
    ("Why do I forget things over time?", "memory-decay.md", "hard"),
    ("Graph database for entities and relationships", "knowledge-graphs.md", "hard"),
    ("My model performs great on training but bad on test", "ml-overfitting.md", "hard"),
    ("Best practices for HTTP endpoints", "api-design.md", "hard"),

    # Hard with vocabulary mismatch
    ("Reusable functions across types in TS", "typescript-generics.md", "hard"),
    ("One-dimensional layout for web pages", "css-flexbox.md", "hard"),
    ("Make my SQLite queries faster", "sqlite-performance.md", "hard"),
    ("How big should my embedding vectors be?", "embeddings-dimensions.md", "hard"),
    ("Persistent memory for Claude across chats", "memory-mcp-servers.md", "hard"),
]


def setup_test_brain() -> tuple:
    """Build a fresh test brain with the corpus."""
    tmp_dir = Path(tempfile.mkdtemp(prefix="neurovault-bench-"))
    vault_dir = tmp_dir / "vault"
    vault_dir.mkdir()
    db_path = tmp_dir / "test.db"

    # Write corpus to disk
    for filename, title, body in TEST_CORPUS:
        content = f"# {title}\n\n{body.strip()}"
        (vault_dir / filename).write_text(content, encoding="utf-8")

    # Initialize and ingest
    db = Database(db_path)
    embedder = Embedder.get()
    bm25 = BM25Index()

    print(f"Ingesting {len(TEST_CORPUS)} test notes...")
    t0 = time.perf_counter()
    ingest_vault(db, embedder, bm25, vault_dir)
    bm25.build(db)
    ingest_time = time.perf_counter() - t0
    print(f"  Ingest complete: {ingest_time:.2f}s")

    return db, embedder, bm25, vault_dir, ingest_time


def run_benchmark(use_reranker: bool = False) -> dict:
    """Run the recall benchmark."""
    db, embedder, bm25, vault_dir, ingest_time = setup_test_brain()

    print(f"\nRunning {len(TEST_QUERIES)} queries (reranker={'on' if use_reranker else 'off'})...")

    results: list[dict] = []
    latencies: list[float] = []

    for query, expected_filename, difficulty in TEST_QUERIES:
        t0 = time.perf_counter()
        hits = hybrid_retrieve(query, db, embedder, bm25, top_k=5, use_reranker=use_reranker)
        latency_ms = (time.perf_counter() - t0) * 1000
        latencies.append(latency_ms)

        # Find rank of the expected note
        expected_title = next(
            (t for f, t, _ in TEST_CORPUS if f == expected_filename), None
        )
        rank = None
        for i, hit in enumerate(hits, 1):
            if hit["title"] == expected_title:
                rank = i
                break

        results.append({
            "query": query,
            "expected": expected_filename,
            "expected_title": expected_title,
            "rank": rank,
            "difficulty": difficulty,
            "top1": hits[0]["title"] if hits else None,
            "latency_ms": round(latency_ms, 1),
        })

    # Compute metrics
    total = len(results)
    found = [r for r in results if r["rank"] is not None]
    top1 = sum(1 for r in results if r["rank"] == 1)
    top3 = sum(1 for r in results if r["rank"] is not None and r["rank"] <= 3)
    top5 = sum(1 for r in results if r["rank"] is not None and r["rank"] <= 5)
    mrr = sum(1.0 / r["rank"] for r in found) / total if total else 0

    by_difficulty: dict[str, dict] = {}
    for d in ("easy", "medium", "hard"):
        items = [r for r in results if r["difficulty"] == d]
        if not items:
            continue
        d_top1 = sum(1 for r in items if r["rank"] == 1)
        d_top3 = sum(1 for r in items if r["rank"] is not None and r["rank"] <= 3)
        by_difficulty[d] = {
            "count": len(items),
            "top1": f"{d_top1}/{len(items)} ({d_top1/len(items)*100:.0f}%)",
            "top3": f"{d_top3}/{len(items)} ({d_top3/len(items)*100:.0f}%)",
        }

    summary = {
        "config": {
            "use_reranker": use_reranker,
            "embedding_model": "BAAI/bge-small-en-v1.5",
            "test_corpus_size": len(TEST_CORPUS),
            "test_queries": total,
            "ingest_time_seconds": round(ingest_time, 2),
        },
        "metrics": {
            "top1_accuracy": f"{top1}/{total} ({top1/total*100:.0f}%)",
            "top3_accuracy": f"{top3}/{total} ({top3/total*100:.0f}%)",
            "top5_accuracy": f"{top5}/{total} ({top5/total*100:.0f}%)",
            "mrr": round(mrr, 3),
            "median_latency_ms": round(statistics.median(latencies), 1),
            "p95_latency_ms": round(statistics.quantiles(latencies, n=20)[18], 1) if len(latencies) >= 20 else round(max(latencies), 1),
            "max_latency_ms": round(max(latencies), 1),
        },
        "by_difficulty": by_difficulty,
        "results": results,
    }

    return summary


def main() -> None:
    print("=" * 70)
    print("NeuroVault Retrieval Benchmark")
    print("=" * 70)

    # Run with reranker OFF (default — fast)
    print("\n--- Hybrid retrieval (no reranker) ---")
    fast = run_benchmark(use_reranker=False)
    print_summary(fast)

    # Run with reranker ON (slower, higher precision)
    print("\n--- Hybrid retrieval + cross-encoder reranker ---")
    slow = run_benchmark(use_reranker=True)
    print_summary(slow)

    # Save
    results_dir = Path(__file__).parent / "results"
    results_dir.mkdir(exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    output = {
        "timestamp": timestamp,
        "fast": fast,
        "with_reranker": slow,
    }
    out_path = results_dir / f"recall-{timestamp}.json"
    out_path.write_text(json.dumps(output, indent=2), encoding="utf-8")
    print(f"\nResults saved to {out_path.name}")


def print_summary(s: dict) -> None:
    m = s["metrics"]
    print(f"  Top-1: {m['top1_accuracy']}")
    print(f"  Top-3: {m['top3_accuracy']}")
    print(f"  Top-5: {m['top5_accuracy']}")
    print(f"  MRR:   {m['mrr']}")
    print(f"  Latency: median {m['median_latency_ms']}ms, p95 {m['p95_latency_ms']}ms, max {m['max_latency_ms']}ms")
    print("  By difficulty:")
    for d, stats in s["by_difficulty"].items():
        print(f"    {d}: top1 {stats['top1']}, top3 {stats['top3']}")


if __name__ == "__main__":
    main()
