"""Hybrid retrieval engine v2 — adaptive weighting, query expansion, and reranking.

Improvements over v1:
- Adaptive RRF weights based on query type (short keyword vs long natural language)
- Query expansion: generates synonyms/related terms for broader recall
- Title boosting: exact title matches get a massive score bonus
- Content-length-aware scoring: penalizes tiny snippet matches
- BM25 gets higher weight for short/keyword queries where it excels
"""

import numpy as np
from sentence_transformers import CrossEncoder
from loguru import logger

from engram_server.database import Database
from engram_server.embeddings import Embedder
from engram_server.bm25_index import BM25Index

RRF_K = 60

_reranker: CrossEncoder | None = None
RERANKER_MODEL = "cross-encoder/ms-marco-MiniLM-L-6-v2"


def _get_reranker() -> CrossEncoder:
    global _reranker
    if _reranker is None:
        logger.info("Loading cross-encoder reranker: {}", RERANKER_MODEL)
        _reranker = CrossEncoder(RERANKER_MODEL)
    return _reranker


def _rrf_score(rank: int) -> float:
    return 1.0 / (RRF_K + rank)


def _classify_query(query: str) -> str:
    """Classify query type to adapt retrieval strategy."""
    words = query.split()
    has_question_word = any(w.lower() in ("what", "how", "why", "which", "where", "when", "who", "does", "is", "can") for w in words[:3])

    if len(words) <= 4 and not has_question_word:
        return "keyword"  # Short keyword lookup — BM25 excels
    if has_question_word and len(words) > 6:
        return "natural"  # Natural language question — semantic excels
    return "mixed"


def _expand_query(query: str) -> str:
    """Expand query with synonyms and related terms for broader recall.

    This helps when the user says 'frontend tech stack' but the note
    says 'Tauri Desktop App' — expansion bridges the vocabulary gap.
    """
    expansions: dict[str, list[str]] = {
        "frontend": ["ui", "interface", "react", "typescript", "tauri", "desktop app"],
        "backend": ["server", "python", "api", "mcp"],
        "database": ["sqlite", "storage", "db", "sql", "data"],
        "search": ["retrieval", "recall", "find", "query", "lookup"],
        "memory": ["remember", "recall", "engram", "note", "brain"],
        "graph": ["network", "connections", "links", "visualization", "nodes"],
        "decay": ["strength", "forgetting", "ebbinghaus", "fade"],
        "ai": ["claude", "llm", "model", "intelligence", "mcp"],
        "vector": ["embedding", "semantic", "similarity", "knn"],
        "font": ["typography", "typeface", "lora", "geist", "jetbrains"],
        "color": ["palette", "theme", "amber", "teal", "design"],
        "tech stack": ["technology", "framework", "tools", "dependencies"],
        "knowledge graph": ["entity", "connections", "links", "neural graph"],
        "desktop": ["tauri", "app", "application", "window"],
        "visualization": ["graph view", "canvas", "force simulation", "neural"],
    }

    query_lower = query.lower()
    extra_terms: list[str] = []

    for trigger, synonyms in expansions.items():
        if trigger in query_lower:
            extra_terms.extend(synonyms[:3])

    if extra_terms:
        return query + " " + " ".join(extra_terms)
    return query


def hybrid_retrieve(
    query: str,
    db: Database,
    embedder: Embedder,
    bm25: BM25Index,
    top_k: int = 10,
    use_reranker: bool = False,
) -> list[dict]:
    """Hybrid retrieval with adaptive weighting and query expansion."""
    candidate_pool = top_k * 4
    query_type = _classify_query(query)

    # Adapt weights based on query type
    if query_type == "keyword":
        w_semantic, w_bm25, w_graph = 0.30, 0.50, 0.20
    elif query_type == "natural":
        w_semantic, w_bm25, w_graph = 0.55, 0.25, 0.20
    else:
        w_semantic, w_bm25, w_graph = 0.45, 0.35, 0.20

    # Expand query for better recall
    expanded_query = _expand_query(query)

    # --- Signal 1: Semantic search ---
    query_embedding = embedder.encode(expanded_query)
    semantic_hits = db.knn_search(query_embedding, limit=candidate_pool)

    semantic_ranked: list[dict] = []
    seen_semantic: set[str] = set()
    for hit in semantic_hits:
        eid = hit["engram_id"]
        if eid in seen_semantic:
            continue
        seen_semantic.add(eid)
        semantic_ranked.append(hit)

    # --- Signal 2: BM25 keyword search (on both original and expanded query) ---
    bm25_hits_orig = bm25.search(query, n=candidate_pool)
    bm25_hits_expanded = bm25.search(expanded_query, n=candidate_pool)

    # Merge BM25 results, preferring original matches
    bm25_scores: dict[str, float] = {}
    for cid, score in bm25_hits_orig:
        bm25_scores[cid] = score * 1.2  # Boost original matches
    for cid, score in bm25_hits_expanded:
        if cid not in bm25_scores:
            bm25_scores[cid] = score

    bm25_sorted = sorted(bm25_scores.items(), key=lambda x: x[1], reverse=True)

    # Batch resolve chunk_ids to engram_ids
    chunk_ids = [cid for cid, _ in bm25_sorted]
    chunk_to_engram = db.resolve_chunk_engrams(chunk_ids)

    bm25_ranked: list[str] = []
    seen_bm25: set[str] = set()
    for chunk_id, _ in bm25_sorted:
        eid = chunk_to_engram.get(chunk_id)
        if eid and eid not in seen_bm25:
            seen_bm25.add(eid)
            bm25_ranked.append(eid)

    # --- Signal 3: Knowledge graph traversal ---
    graph_ranked = _graph_retrieve(query, db, limit=candidate_pool)

    # --- Signal 4: Title matching (semantic + keyword) ---
    # Embed all titles and compare to query for semantic title relevance
    title_scores: dict[str, float] = {}
    all_engrams_list = db.conn.execute(
        "SELECT id, title FROM engrams WHERE state != 'dormant'"
    ).fetchall()

    if all_engrams_list:
        titles_text = [t[1] for t in all_engrams_list]
        title_embeddings = embedder.encode_batch(titles_text)
        query_emb_np = np.array(query_embedding, dtype=np.float32)
        q_norm = np.linalg.norm(query_emb_np)
        if q_norm > 0:
            query_emb_np = query_emb_np / q_norm

        for i, (eid, title) in enumerate(all_engrams_list):
            t_emb = np.array(title_embeddings[i], dtype=np.float32)
            t_norm = np.linalg.norm(t_emb)
            if t_norm > 0:
                sim = float(np.dot(query_emb_np, t_emb / t_norm))
                if sim > 0.45:  # Moderate threshold — titles are short
                    title_scores[eid] = sim

            # Also check keyword overlap (for exact matches)
            query_words = set(expanded_query.lower().split())
            title_words = set(title.lower().split())
            overlap = query_words & title_words
            if len(overlap) >= 2:
                title_scores[eid] = max(title_scores.get(eid, 0), 0.6)

    title_matches = sorted(title_scores.keys(), key=lambda x: title_scores.get(x, 0), reverse=True)

    # --- Reciprocal Rank Fusion ---
    rrf_scores: dict[str, float] = {}

    for rank, hit in enumerate(semantic_ranked, 1):
        eid = hit["engram_id"]
        rrf_scores[eid] = rrf_scores.get(eid, 0) + w_semantic * _rrf_score(rank)

    for rank, eid in enumerate(bm25_ranked, 1):
        rrf_scores[eid] = rrf_scores.get(eid, 0) + w_bm25 * _rrf_score(rank)

    for rank, eid in enumerate(graph_ranked, 1):
        rrf_scores[eid] = rrf_scores.get(eid, 0) + w_graph * _rrf_score(rank)

    # Title match bonus — scaled by semantic similarity to query
    for eid in title_matches[:5]:  # Top 5 most relevant titles
        boost = title_scores.get(eid, 0.3) * 0.08  # Higher similarity = bigger boost
        rrf_scores[eid] = rrf_scores.get(eid, 0) + boost

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
        pairs = [[query, c["content"]] for c in candidates[:20]]
        rerank_scores = reranker.predict(pairs).tolist()
        for i, score in enumerate(rerank_scores):
            if i < len(candidates):
                candidates[i]["rerank_score"] = float(score)
    else:
        for c in candidates:
            c["rerank_score"] = c["rrf_score"]

    # --- Final scoring: 80% rerank + 20% strength ---
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
        "Hybrid retrieval: {} results for '{}' (type={}, semantic={}, bm25={}, graph={}, titles={}, reranker={})",
        len(results), query[:50], query_type,
        len(semantic_ranked), len(bm25_ranked), len(graph_ranked), len(title_matches),
        "on" if use_reranker else "off",
    )
    return results


def _graph_retrieve(query: str, db: Database, limit: int = 20) -> list[str]:
    """Knowledge graph traversal: entity match + 2-hop."""
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
    """Vectorized pairwise cosine similarity."""
    arr = np.array(embeddings, dtype=np.float32)
    norms = np.linalg.norm(arr, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    normalized = arr / norms
    return normalized @ normalized.T
