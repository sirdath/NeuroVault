"""Learned query→engram affinity — Stage 4 of self-improving retrieval.

Complements Stage 1 (implicit feedback strength adjustments) with a
mechanical self-correction loop modeled on Self-RAG, stripped of the
LLM call. The idea:

1. Stage 1 already captures which engrams were fetched after a recall
   (retrieval_feedback.was_accessed=1) — that's our ground-truth
   "this memory was actually useful" signal.
2. During consolidation, re-run each useful query through the current
   retriever. If the previously-useful engram is STILL in the top-3,
   the retriever is doing its job — no action needed.
3. If the engram is NOT in the new top-3, that means the ranking has
   drifted (or always had a bug). Record a learned affinity so the
   next identical query gets a direct final-score boost for that engram.

The boost is bounded (max +0.05) and scales with hit_count, so repeated
confirmation makes the shortcut more aggressive. One-off queries don't
permanently distort ranking.

Version 2 upgrades the lookup from exact case-insensitive text match
to **cosine similarity over stored query embeddings**, so paraphrased
queries can hit the same shortcut. "Where did I put my keys" matches
"where are the keys" because their embeddings sit close together in
the semantic space. Threshold is 0.85 to avoid false positives.
"""

from __future__ import annotations

import math
import struct

from loguru import logger

from engram_server.database import Database


MAX_AFFINITY_BOOST = 0.05       # cap on final-score bonus per learned pair
HIT_COUNT_CEILING = 10          # after 10 confirmations, boost is saturated
DEFAULT_LOOKBACK_DAYS = 7
DEFAULT_SAMPLE_SIZE = 30

# Minimum cosine similarity for a stored query embedding to match an
# incoming query embedding and fire the affinity boost. 0.85 is tight
# enough that "where did I put my keys" and "show me the billing report"
# don't cross-pollinate, but loose enough to catch genuine paraphrases.
SIMILARITY_THRESHOLD = 0.85


# --- Embedding serialisation helpers ---

def _serialize_embedding(embedding: list[float] | None) -> bytes | None:
    if not embedding:
        return None
    return struct.pack(f"{len(embedding)}f", *embedding)


def _deserialize_embedding(blob: bytes | None) -> list[float] | None:
    if not blob:
        return None
    n = len(blob) // 4
    try:
        return list(struct.unpack(f"{n}f", blob))
    except struct.error:
        return None


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(a, b):
        dot += x * y
        na += x * x
        nb += y * y
    if na == 0 or nb == 0:
        return 0.0
    return dot / (math.sqrt(na) * math.sqrt(nb))


def record_affinity(
    db: Database,
    query_text: str,
    engram_id: str,
    query_embedding: list[float] | None = None,
) -> None:
    """Upsert a query→engram affinity. Increments hit_count on conflict.

    If `query_embedding` is supplied, it's stored alongside the text so
    future lookups can use cosine similarity matching for paraphrases.
    Backwards-compatible: omitting the embedding still records the text
    and the exact-match path keeps working.
    """
    if not query_text or not engram_id:
        return
    blob = _serialize_embedding(query_embedding)
    try:
        db.conn.execute(
            """INSERT INTO query_affinity (query_text, query_embedding, engram_id)
               VALUES (?, ?, ?)
               ON CONFLICT(query_text, engram_id) DO UPDATE SET
                 hit_count = hit_count + 1,
                 last_seen = datetime('now'),
                 query_embedding = COALESCE(excluded.query_embedding, query_affinity.query_embedding)""",
            (query_text[:200], blob, engram_id),
        )
        db.conn.commit()
    except Exception as e:
        logger.debug("query_affinity.record failed: {}", e)


def lookup_affinities(
    db: Database,
    query_text: str,
    query_embedding: list[float] | None = None,
    min_hits: int = 1,
    limit: int = 5,
) -> list[dict]:
    """Look up engrams with learned affinity for queries like this one.

    Two-stage lookup:
      1. Fast path — exact case-insensitive text match. Cheap, no
         embedding required, catches the "same query asked again" case.
      2. Semantic path — if `query_embedding` is supplied AND the fast
         path returned nothing, scan all rows with stored embeddings,
         compute cosine similarity, and return any above the threshold.

    Returns rows sorted by (match_quality, hit_count) so the retriever
    can apply a bounded boost. Each row includes `similarity` ∈ [0, 1]
    where 1.0 means exact text match and anything else is a cosine score.
    """
    if not query_text:
        return []

    try:
        # Stage A: exact text match (fast, O(index lookup))
        exact_rows = db.conn.execute(
            """SELECT engram_id, hit_count, last_seen, query_text
               FROM query_affinity
               WHERE query_text = ? COLLATE NOCASE
                 AND hit_count >= ?
               ORDER BY hit_count DESC, last_seen DESC
               LIMIT ?""",
            (query_text[:200], min_hits, limit),
        ).fetchall()
    except Exception as e:
        logger.debug("query_affinity.lookup exact failed: {}", e)
        return []

    if exact_rows:
        return [
            {
                "engram_id": r[0],
                "hit_count": r[1],
                "last_seen": r[2],
                "matched_query": r[3],
                "similarity": 1.0,
                "match_type": "exact",
            }
            for r in exact_rows
        ]

    # Stage B: semantic similarity match (requires the embedding)
    if not query_embedding:
        return []

    try:
        candidate_rows = db.conn.execute(
            """SELECT engram_id, hit_count, last_seen, query_text, query_embedding
               FROM query_affinity
               WHERE hit_count >= ?
                 AND query_embedding IS NOT NULL
               ORDER BY hit_count DESC""",
            (min_hits,),
        ).fetchall()
    except Exception as e:
        logger.debug("query_affinity.lookup semantic failed: {}", e)
        return []

    scored: list[tuple[float, dict]] = []
    for engram_id, hit_count, last_seen, stored_text, stored_blob in candidate_rows:
        stored_emb = _deserialize_embedding(stored_blob)
        if not stored_emb:
            continue
        sim = _cosine(query_embedding, stored_emb)
        if sim < SIMILARITY_THRESHOLD:
            continue
        scored.append((sim, {
            "engram_id": engram_id,
            "hit_count": hit_count,
            "last_seen": last_seen,
            "matched_query": stored_text,
            "similarity": round(sim, 4),
            "match_type": "semantic",
        }))

    # Rank by (similarity * hit_count_log) so confident + frequent hits lead
    scored.sort(
        key=lambda t: (t[0] * math.log(max(1, t[1]["hit_count"]) + 1)),
        reverse=True,
    )
    return [row for _, row in scored[:limit]]


def affinity_boost(hit_count: int) -> float:
    """Convert a hit_count into a bounded final-score bonus."""
    if hit_count <= 0:
        return 0.0
    ratio = min(hit_count / float(HIT_COUNT_CEILING), 1.0)
    return MAX_AFFINITY_BOOST * ratio


def reconcile_feedback(
    db: Database,
    embedder,
    bm25,
    sample_size: int = DEFAULT_SAMPLE_SIZE,
    lookback_days: int = DEFAULT_LOOKBACK_DAYS,
) -> dict:
    """Find ranking failures and record learned query→engram affinities.

    For each recent (query, engram) pair where the user explicitly
    fetched the engram after a recall, we re-run the query and check:

      - If the engram is in the new top-3 → retriever is correct, no-op.
      - If NOT in the new top-3 → retriever failed that query. Record
        a learned affinity so the next identical query directly boosts
        that engram by up to +0.05.

    Runs during the 4h consolidation cycle. Cheap (one retrieval per
    sampled pair) and bounded (sample_size caps worst case).
    """
    from engram_server.retriever import hybrid_retrieve

    try:
        rows = db.conn.execute(
            f"""SELECT query, engram_id, MAX(accessed_at) as last_touch
                FROM retrieval_feedback
                WHERE was_accessed = 1
                  AND accessed_at >= datetime('now', '-{int(lookback_days)} days')
                GROUP BY query, engram_id
                ORDER BY last_touch DESC
                LIMIT ?""",
            (sample_size,),
        ).fetchall()
    except Exception as e:
        logger.warning("query_affinity.reconcile query failed: {}", e)
        return {"reconciled": 0, "ranking_failures": 0, "error": str(e)}

    reconciled = 0
    failures = 0
    for query, engram_id, _last in rows:
        if not query or not engram_id:
            continue
        try:
            results = hybrid_retrieve(query, db, embedder, bm25, top_k=3)
        except Exception as e:
            logger.debug("reconcile hybrid_retrieve failed for '{}': {}", query[:30], e)
            continue
        top_ids = [r["engram_id"] for r in results]
        if engram_id not in top_ids[:3]:
            # Compute the query embedding once and persist it so future
            # paraphrased queries can hit the same shortcut via cosine
            # similarity. If embedding fails, we still record the text
            # match so the exact-query case keeps working.
            embedding: list[float] | None = None
            try:
                embedding = list(embedder.encode(query))
            except Exception as e:
                logger.debug("reconcile embed failed for '{}': {}", query[:30], e)
            record_affinity(db, query, engram_id, query_embedding=embedding)
            failures += 1
        reconciled += 1

    logger.info(
        "query_affinity.reconcile: reconciled={} ranking_failures={}",
        reconciled, failures,
    )
    return {"reconciled": reconciled, "ranking_failures": failures}


def get_affinity_stats(db: Database) -> dict:
    """Observability: how many learned shortcuts do we have?"""
    try:
        total = db.conn.execute(
            "SELECT COUNT(*) FROM query_affinity"
        ).fetchone()[0]
        top = db.conn.execute(
            """SELECT q.query_text, e.title, q.hit_count, q.last_seen
               FROM query_affinity q
               JOIN engrams e ON e.id = q.engram_id
               ORDER BY q.hit_count DESC, q.last_seen DESC
               LIMIT 10"""
        ).fetchall()
        return {
            "total_learned_shortcuts": total,
            "top_shortcuts": [
                {
                    "query": r[0],
                    "engram_title": r[1],
                    "hit_count": r[2],
                    "last_seen": r[3],
                }
                for r in top
            ],
        }
    except Exception as e:
        return {"error": str(e)}
