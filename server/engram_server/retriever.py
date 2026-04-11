"""Hybrid retrieval engine with RRF and optional cross-encoder reranking.

Three signals merged:
  1. Semantic search (sqlite-vec KNN) — 50% weight
  2. BM25 keyword search — 30% weight
  3. Knowledge graph traversal — 20% weight

Merged via Reciprocal Rank Fusion, optionally reranked by cross-encoder,
then boosted by memory strength.
"""

import numpy as np
from sentence_transformers import CrossEncoder
from loguru import logger

from engram_server.database import Database
from engram_server.embeddings import Embedder
from engram_server.bm25_index import BM25Index

RRF_K = 60

# Cross-encoder — lazy loaded, only when reranking is enabled
_reranker: CrossEncoder | None = None
RERANKER_MODEL = "cross-encoder/ms-marco-MiniLM-L-6-v2"


def _get_reranker() -> CrossEncoder:
    global _reranker
    if _reranker is None:
        logger.info("Loading cross-encoder reranker: {}", RERANKER_MODEL)
        _reranker = CrossEncoder(RERANKER_MODEL)
        logger.info("Reranker loaded")
    return _reranker


def _rrf_score(rank: int) -> float:
    return 1.0 / (RRF_K + rank)


def hybrid_retrieve(
    query: str,
    db: Database,
    embedder: Embedder,
    bm25: BM25Index,
    top_k: int = 10,
    use_reranker: bool = False,
) -> list[dict]:
    """Full hybrid retrieval pipeline.

    Args:
        use_reranker: If True, loads cross-encoder for final reranking (~200ms extra).
                      Default False for speed. Set True for maximum precision.
    """
    candidate_pool = top_k * 4

    # --- Signal 1: Semantic search (50% weight) ---
    query_embedding = embedder.encode(query)
    semantic_hits = db.knn_search(query_embedding, limit=candidate_pool)

    # Dedupe by engram_id
    semantic_ranked: list[dict] = []
    seen_semantic: set[str] = set()
    for hit in semantic_hits:
        eid = hit["engram_id"]
        if eid in seen_semantic:
            continue
        seen_semantic.add(eid)
        semantic_ranked.append(hit)

    # --- Signal 2: BM25 keyword search (30% weight) ---
    bm25_hits = bm25.search(query, n=candidate_pool)

    # Batch resolve chunk_ids to engram_ids (single query instead of N+1)
    chunk_ids = [cid for cid, _ in bm25_hits]
    chunk_to_engram = db.resolve_chunk_engrams(chunk_ids)

    bm25_ranked: list[str] = []
    seen_bm25: set[str] = set()
    for chunk_id, _ in bm25_hits:
        eid = chunk_to_engram.get(chunk_id)
        if eid and eid not in seen_bm25:
            seen_bm25.add(eid)
            bm25_ranked.append(eid)

    # --- Signal 3: Knowledge graph traversal (20% weight) ---
    graph_ranked = _graph_retrieve(query, db, limit=candidate_pool)

    # --- Reciprocal Rank Fusion ---
    rrf_scores: dict[str, float] = {}

    for rank, hit in enumerate(semantic_ranked, 1):
        eid = hit["engram_id"]
        rrf_scores[eid] = rrf_scores.get(eid, 0) + 0.50 * _rrf_score(rank)

    for rank, eid in enumerate(bm25_ranked, 1):
        rrf_scores[eid] = rrf_scores.get(eid, 0) + 0.30 * _rrf_score(rank)

    for rank, eid in enumerate(graph_ranked, 1):
        rrf_scores[eid] = rrf_scores.get(eid, 0) + 0.20 * _rrf_score(rank)

    sorted_candidates = sorted(rrf_scores.items(), key=lambda x: x[1], reverse=True)

    # Build candidate list
    candidates: list[dict] = []
    for eid, rrf in sorted_candidates[:candidate_pool]:
        engram = db.get_engram(eid)
        if not engram or engram["state"] == "dormant":
            continue
        candidates.append({
            "engram_id": eid,
            "title": engram["title"],
            "content": engram["content"][:1000],
            "strength": engram["strength"],
            "state": engram["state"],
            "rrf_score": rrf,
        })

    if not candidates:
        return []

    # --- Optional cross-encoder reranking ---
    if use_reranker and len(candidates) > 1:
        reranker = _get_reranker()
        pairs = [[query, c["content"]] for c in candidates[:20]]  # Rerank top-20 not top-40
        rerank_scores = reranker.predict(pairs).tolist()
        for i, score in enumerate(rerank_scores):
            if i < len(candidates):
                candidates[i]["rerank_score"] = float(score)
    else:
        for c in candidates:
            c["rerank_score"] = c["rrf_score"]

    # --- Final scoring: 80% rerank + 20% memory strength ---
    for c in candidates:
        c["final_score"] = round(c["rerank_score"] * 0.8 + c["strength"] * 0.2, 4)

    candidates.sort(key=lambda x: x["final_score"], reverse=True)

    results = []
    for c in candidates[:top_k]:
        results.append({
            "engram_id": c["engram_id"],
            "title": c["title"],
            "content": c["content"],
            "score": c["final_score"],
            "strength": c["strength"],
            "state": c["state"],
        })
        db.bump_access(c["engram_id"])

    logger.info(
        "Hybrid retrieval: {} results for '{}' (semantic={}, bm25={}, graph={}, reranker={})",
        len(results), query[:50],
        len(semantic_ranked), len(bm25_ranked), len(graph_ranked),
        "on" if use_reranker else "off",
    )
    return results


def _graph_retrieve(query: str, db: Database, limit: int = 20) -> list[str]:
    """Retrieve engram IDs via knowledge graph: entity match + 2-hop traversal."""
    from engram_server.entities import _extract_entities_local

    query_entities = _extract_entities_local(query)
    query_words = set(query.lower().split())

    entity_ids: list[str] = []

    for ent in query_entities:
        row = db.conn.execute(
            "SELECT id FROM entities WHERE name = ? COLLATE NOCASE", (ent["name"],)
        ).fetchone()
        if row:
            entity_ids.append(row[0])

    all_entities = db.conn.execute("SELECT id, name FROM entities").fetchall()
    for eid, name in all_entities:
        name_words = set(name.lower().split())
        if name_words & query_words and eid not in entity_ids:
            entity_ids.append(eid)

    if not entity_ids:
        return []

    # Hop 1: direct entity mentions
    hop1: set[str] = set()
    for eid in entity_ids:
        rows = db.conn.execute(
            """SELECT em.engram_id FROM entity_mentions em
               JOIN engrams e ON e.id = em.engram_id
               WHERE em.entity_id = ? AND e.state != 'dormant'""",
            (eid,),
        ).fetchall()
        for r in rows:
            hop1.add(r[0])

    # Hop 2: linked engrams
    hop2: set[str] = set()
    for eng_id in hop1:
        rows = db.conn.execute(
            """SELECT l.to_engram FROM engram_links l
               JOIN engrams e ON e.id = l.to_engram
               WHERE l.from_engram = ? AND e.state != 'dormant'
               AND l.similarity > 0.5 LIMIT 5""",
            (eng_id,),
        ).fetchall()
        for r in rows:
            if r[0] not in hop1:
                hop2.add(r[0])

    return list(hop1)[:limit] + list(hop2)[:limit - len(hop1)]


def compute_cosine_similarity_matrix(embeddings: list[list[float]]) -> np.ndarray:
    """Compute all pairwise cosine similarities using numpy (vectorized).
    O(n^2) in memory but O(n*d) in compute — 1000x faster than Python loops.
    """
    arr = np.array(embeddings, dtype=np.float32)
    norms = np.linalg.norm(arr, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    normalized = arr / norms
    return normalized @ normalized.T
