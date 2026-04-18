"""Hybrid retrieval engine v2 — adaptive weighting, query expansion, and reranking.

Improvements over v1:
- Adaptive RRF weights based on query type (short keyword vs long natural language)
- Query expansion: generates synonyms/related terms for broader recall
- Title boosting: exact title matches get a massive score bonus
- Content-length-aware scoring: penalizes tiny snippet matches
- BM25 gets higher weight for short/keyword queries where it excels
"""

import math
import re
from collections import OrderedDict
from datetime import datetime, timezone
from threading import Lock

import numpy as np
from loguru import logger

from neurovault_server.bm25_index import _tokenize as _bm25_tokenize
from neurovault_server.database import Database
from neurovault_server.embeddings import Embedder
from neurovault_server.bm25_index import BM25Index

RRF_K = 60

_reranker = None  # lazy-loaded CrossEncoder, only if reranking is requested
RERANKER_MODEL = "cross-encoder/ms-marco-MiniLM-L-6-v2"


# --- Title-embedding LRU -------------------------------------------------
# Titles rarely change; embedding them on every recall was burning ~85%
# of hybrid_retrieve's wall time for small vaults (31 titles × ~20ms =
# ~600ms wasted per query). Cache is keyed on the raw title string, so
# renames naturally invalidate and two engrams sharing a title share a
# slot. Capped at 4k entries (~6MB) — far above any realistic vault size.
_TITLE_CACHE_MAX = 4000
_title_cache: "OrderedDict[str, list[float]]" = OrderedDict()
_title_cache_lock = Lock()


def _get_title_embeddings(titles: list[str], embedder: Embedder) -> list[list[float]]:
    """Return embeddings for `titles`, using the LRU for repeats.

    Only novel titles go through `embedder.encode_batch()`. In typical
    usage (titles stable across queries), the batch is empty on every
    call after the first — collapsing recall's title-scoring cost from
    O(titles) embeds to O(0).
    """
    out: list[list[float] | None] = [None] * len(titles)
    novel: list[tuple[int, str]] = []
    with _title_cache_lock:
        for i, t in enumerate(titles):
            cached = _title_cache.get(t)
            if cached is not None:
                _title_cache.move_to_end(t)
                out[i] = cached
            else:
                novel.append((i, t))
    if novel:
        fresh = embedder.encode_batch([t for _, t in novel])
        with _title_cache_lock:
            for (i, t), vec in zip(novel, fresh):
                out[i] = vec
                _title_cache[t] = vec
                _title_cache.move_to_end(t)
            while len(_title_cache) > _TITLE_CACHE_MAX:
                _title_cache.popitem(last=False)
    return [v for v in out if v is not None]  # type: ignore[return-value]


def title_cache_stats() -> dict:
    with _title_cache_lock:
        return {"size": len(_title_cache), "max": _TITLE_CACHE_MAX}


def _get_reranker():
    """Lazy-load the cross-encoder reranker.

    sentence-transformers is only imported here — not at module level — so
    the entire torch dependency is avoided unless the user explicitly
    requests reranking (which is off by default).
    """
    global _reranker
    if _reranker is None:
        try:
            from sentence_transformers import CrossEncoder
            logger.info("Loading cross-encoder reranker: {}", RERANKER_MODEL)
            _reranker = CrossEncoder(RERANKER_MODEL)
        except ImportError:
            logger.warning(
                "sentence-transformers not installed — cross-encoder reranking disabled. "
                "Install it with: uv pip install sentence-transformers"
            )
            raise
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


# Query-aware temporal intent classifier (Stage 2 of self-improving retrieval).
# Fires on strong signals only — ambiguous queries default to neutral so we
# don't surprise users. If both fresh and historical match, we also default
# to neutral to avoid a wrong bet.
_FRESH_PATTERNS = re.compile(
    r"\b("
    r"recent|recently|latest|newest|current|currently|now|today|tonight|"
    r"yesterday|just now|lately|updated|newly|most recent|"
    r"this (week|month|year|morning|afternoon|evening)|"
    r"in the last \w+|for the last \w+"
    r")\b",
    re.IGNORECASE,
)

_HISTORICAL_PATTERNS = re.compile(
    r"\b("
    r"original|originally|first|initially|initial|used to|back then|back when|"
    r"previously|formerly|historically|ancient|long ago|in the past|"
    r"at the start|at the beginning|early on|earlier|old(est|er)?|"
    r"was (the|a|an|my|our|your)|were (the|a|my|our|your)|before (we|i|they|you)"
    r")\b",
    re.IGNORECASE,
)


def classify_temporal_intent(query: str) -> str:
    """Classify a query as 'fresh', 'historical', or 'neutral'.

    Used by hybrid_retrieve to decide whether to emphasize newer or older
    memories for this specific query. Conservative — only fires on strong
    signals so neutral queries behave identically to the current default.
    """
    if not query:
        return "neutral"
    fresh = bool(_FRESH_PATTERNS.search(query))
    historical = bool(_HISTORICAL_PATTERNS.search(query))
    if fresh and not historical:
        return "fresh"
    if historical and not fresh:
        return "historical"
    return "neutral"


def _recency_params(intent: str) -> tuple[float, float]:
    """Return (newest_factor, oldest_factor) for a given temporal intent.

    Philosophy: recency is only a retrieval signal when the user
    explicitly asks for it. A neutral query gets no recency weighting —
    semantic relevance + the decision/contradiction bonuses do the work.
    Otherwise recency silently contaminates every query, which the
    research on LLM reranker recency bias confirms is a real hazard.
    """
    if intent == "fresh":
        return (1.00, 0.60)   # wide, strongly favor newest
    if intent == "historical":
        return (0.60, 1.00)   # INVERTED, oldest wins
    return (1.00, 1.00)       # neutral — no recency tilt, let semantics lead


def _recency_lambda(intent: str) -> float:
    """Return the exponential decay rate λ (in 1/days) for the age prior.

    From arxiv 2509.19376 — "Solving Freshness in RAG: A Simple Recency
    Prior..." — a dumb exp(-λ·age_days) multiplier outperforms most
    sophisticated temporal models. We layer it on top of the linear
    spread:

    - fresh: moderate λ (half-life ≈ 70d). Combined with the linear
      spread, fresh intent gets both rank-relative AND absolute-age
      penalties for older memories.
    - neutral: gentle λ (half-life ≈ 2 years). Almost invisible for
      recent memories, meaningful only for years-old ones. Keeps the
      entity-disambiguation case passing because sub-day age diffs are
      effectively zero.
    - historical: 0. User asked about the past; we do NOT penalize age.
    """
    if intent == "fresh":
        return 0.01
    if intent == "historical":
        return 0.0
    return 0.001


def _age_days(updated_at: str | None) -> float:
    """Parse a stored ISO timestamp and return its age in days (>= 0).

    Timestamps are written by `insert_engram` via SQLite's
    strftime('%Y-%m-%d %H:%M:%f', 'now') which is UTC. We compare to
    datetime.utcnow() (also naive UTC) so both sides of the subtraction
    live in the same reference frame.
    """
    if not updated_at:
        return 0.0
    try:
        dt = datetime.fromisoformat(updated_at)
    except (ValueError, TypeError):
        return 0.0
    # If the parsed datetime is naive (no tzinfo), treat it as UTC since
    # SQLite's strftime('%Y-%m-%d %H:%M:%f', 'now') writes UTC by default.
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    try:
        delta = datetime.now(timezone.utc) - dt
    except Exception:
        return 0.0
    return max(0.0, delta.total_seconds() / 86400.0)


def hybrid_retrieve(
    query: str,
    db: Database,
    embedder: Embedder,
    bm25: BM25Index,
    top_k: int = 10,
    use_reranker: bool = False,
    as_of: str | None = None,
    exclude_kinds: list[str] | None = None,
) -> list[dict]:
    """Hybrid retrieval with adaptive weighting and query expansion.

    If `as_of` is provided (ISO timestamp), the brain is queried *as it was*
    at that moment: engrams created/updated after as_of are excluded, and
    temporal facts that became valid after as_of are ignored. Lets Claude
    answer "what did you know about X last Tuesday?" — pure time travel
    over the cognitive layer.

    `exclude_kinds` filters out engrams by kind (e.g. 'observation') before
    scoring. Defaults to excluding observations so the auto-captured hook
    pipeline doesn't drown out manual memories. Pass an empty list to
    include everything, or a custom list like ['observation', 'draft'].
    """
    if exclude_kinds is None:
        exclude_kinds = ["observation"]
    exclude_set = set(exclude_kinds)
    candidate_pool = top_k * 4
    query_type = _classify_query(query)
    temporal_intent = classify_temporal_intent(query)

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
    # encode_query uses a query-level LRU cache — repeat/paraphrased
    # queries in the same session skip the ~600-800ms model forward pass.
    query_embedding = embedder.encode_query(expanded_query)
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

    # --- Signal 4: Title matching (semantic + keyword coverage) ---
    # Titles are high-signal: a 5-word page title is a declaration of the
    # page's topic, far more focused than paragraph-level content. We
    # score every title two ways and take the max.
    #
    # (a) Semantic: cosine(query_emb, title_emb). Threshold 0.45.
    # (b) Keyword coverage: fraction of (stopword-stripped) query tokens
    #     that appear in the title. A query whose tokens are all in the
    #     title gets a near-max bonus; a partial match scales linearly.
    #     This fixes the "mcp core tier tools" → mcp-tools-tiers case:
    #     3/3 non-stopword tokens land in that title, 2/3 in mcp-registration.
    #
    # Title embeddings go through `_get_title_embeddings()` which caches
    # them across recall calls — previously we re-embedded every title
    # in the vault on every query, wasting ~600ms on a 31-title vault.
    # Two separate signals, scored independently so a strong keyword match
    # never gets crowded out by a forest of weaker semantic-cosine matches:
    #
    #   semantic_title_scores : cosine(query, title_emb), cosine ∈ (0.45, 1.0]
    #   keyword_title_scores  : bidirectional token coverage, score ∈ (0.4, 1.0]
    #
    # The semantic signal can match dozens of engrams (cosine is forgiving
    # for short strings), so we cap its boost at top-10 by score. The
    # keyword signal is far more discriminating — typical query/title
    # pairs have zero overlap, so we apply its boost UNCAPPED to every
    # match. This is the fix for the "mcp core tier tools" benchmark
    # case where mcp-tools-tiers had a 0.802 keyword score but lost a
    # top-10 slot to ten high-cosine semantic neighbours.
    semantic_title_scores: dict[str, float] = {}
    keyword_title_scores: dict[str, float] = {}

    # Also pull the filename so a kebab-case slug like `http-api.md` can
    # participate in keyword matching alongside the display title. Slugs
    # are pure keywords (no "&", "(", "·" filler), so they tend to give
    # cleaner coverage signals than prettified titles.
    all_engrams_list = db.conn.execute(
        "SELECT id, title, filename FROM engrams WHERE state != 'dormant'"
    ).fetchall()

    query_token_set = set(t for t in _bm25_tokenize(query) if len(t) > 1)
    query_token_count = max(len(query_token_set), 1)

    if all_engrams_list:
        titles_text = [row[1] for row in all_engrams_list]
        title_embeddings = _get_title_embeddings(titles_text, embedder)
        query_emb_np = np.array(query_embedding, dtype=np.float32)
        q_norm = np.linalg.norm(query_emb_np)
        if q_norm > 0:
            query_emb_np = query_emb_np / q_norm

        for i, row in enumerate(all_engrams_list):
            eid, title, filename = row[0], row[1], (row[2] or "")

            # (a) Semantic title similarity — the wide net.
            if i < len(title_embeddings):
                t_emb = np.array(title_embeddings[i], dtype=np.float32)
                t_norm = np.linalg.norm(t_emb)
                if t_norm > 0:
                    sim = float(np.dot(query_emb_np, t_emb / t_norm))
                    if sim > 0.45:
                        semantic_title_scores[eid] = sim

            # (b) Bidirectional keyword coverage against (title ∪ slug).
            # Take the MAX of two fractions so a short focused title whose
            # words are fully in the query wins the same way a long title
            # with majority query coverage does:
            #   C_query = |overlap| / |query_tokens|
            #   C_title = |overlap| / |title_tokens|
            # `_bm25_tokenize` uses the same stopword set BM25 uses so
            # filler ("of", "the", "in") never inflates either fraction.
            slug = filename.replace(".md", "").replace("-", " ").replace("_", " ")
            title_tokens: set[str] = set()
            for src in (title, slug):
                for tok in _bm25_tokenize(src):
                    if len(tok) > 1:
                        title_tokens.add(tok)

            if query_token_set and title_tokens:
                overlap = query_token_set & title_tokens
                if overlap:
                    c_query = len(overlap) / query_token_count
                    c_title = len(overlap) / max(len(title_tokens), 1)
                    coverage = max(c_query, c_title)
                    if coverage >= 0.4:
                        # Coverage ∈ [0.4, 1.0] → keyword_score ∈ [0.56, 1.0]
                        keyword_title_scores[eid] = 0.4 + 0.6 * coverage

    # title_matches drives the OLD logging count (kept for parity)
    title_scores: dict[str, float] = {}
    for eid, s in semantic_title_scores.items():
        title_scores[eid] = max(title_scores.get(eid, 0.0), s)
    for eid, s in keyword_title_scores.items():
        title_scores[eid] = max(title_scores.get(eid, 0.0), s)
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

    # Two-track title boost (see signal-4 block above for rationale):
    #
    # 1) Keyword coverage — UNCAPPED, applied to every engram with
    #    coverage ≥ 0.4. Strong, discriminating signal (most engrams
    #    have zero overlap, so the boost stays sparse). Magnitude 0.30
    #    is large enough for a near-full-coverage keyword match to
    #    dominate any combination of weak semantic neighbours.
    # 2) Semantic title cosine — capped at top-10 by score. Cosine
    #    is forgiving for short strings so this can match dozens of
    #    titles at once. Magnitude 0.15 — half the keyword boost, so
    #    it informs ranking without drowning out the precise signal.
    # Two-track title boost (see signal-4 block above for rationale):
    # 1) Keyword coverage — UNCAPPED, every engram with coverage ≥ 0.4
    # 2) Semantic title cosine — capped at top-10 by score
    for eid, kscore in keyword_title_scores.items():
        rrf_scores[eid] = rrf_scores.get(eid, 0.0) + kscore * 0.30

    semantic_top = sorted(
        semantic_title_scores.items(), key=lambda kv: kv[1], reverse=True
    )[:10]
    for eid, sscore in semantic_top:
        rrf_scores[eid] = rrf_scores.get(eid, 0.0) + sscore * 0.15

    sorted_candidates = sorted(rrf_scores.items(), key=lambda x: x[1], reverse=True)

    # Build candidate list — apply as_of filter at engram resolution time so
    # engrams created/updated after the timestamp are dropped before scoring.
    # Also drop any engram whose kind is in the exclude_set (default: observations,
    # so the auto-captured hook pipeline doesn't drown out manual memories).
    candidates: list[dict] = []
    for eid, rrf in sorted_candidates[:candidate_pool]:
        engram = db.get_engram(eid)
        if not engram or engram["state"] == "dormant":
            continue
        if exclude_set and (engram.get("kind") or "note") in exclude_set:
            continue
        if as_of:
            created = engram.get("created_at") or ""
            if created and created > as_of:
                continue  # didn't exist yet at as_of
        candidates.append({
            "engram_id": eid,
            "title": engram["title"],
            "content": engram["content"][:1000],
            "strength": engram["strength"],
            "state": engram["state"],
            "updated_at": engram.get("updated_at", ""),
            "created_at": engram.get("created_at", ""),
            "kind": engram.get("kind") or "note",
            "rrf_score": rrf,
        })

    if not candidates:
        return []

    # --- Temporal & decision-aware adjustments ---
    # Newer memories beat older ones on contested topics; explicitly-superseded
    # facts get a hard penalty; titles flagged as decisions/updates get a small
    # bonus. Together these handle "Database Migration > Database Choice" and
    # "Decision: No Redis > Considered: Redis" without changing recall accuracy
    # for non-temporal queries.
    # superseded_fraction[eid] = fraction of this engram's temporal_facts
    # that are marked not-current. Used to SCALE the recency penalty so a
    # single stale fact on a page with 189 total doesn't halve the whole
    # page's score (the old behavior, triggered by the intelligence
    # module parsing example dialog blocks as "claims" and flagging them
    # as mutual contradictions). A truly obsolete page with most facts
    # superseded still gets a meaningful penalty.
    eids = [c["engram_id"] for c in candidates]
    superseded_fraction: dict[str, float] = {}
    if eids:
        placeholders = ",".join("?" * len(eids))
        if as_of:
            rows = db.conn.execute(
                f"""SELECT engram_id,
                       SUM(CASE WHEN valid_until IS NOT NULL AND valid_until <= ?
                                THEN 1 ELSE 0 END) AS not_current,
                       COUNT(*) AS total
                     FROM temporal_facts
                     WHERE engram_id IN ({placeholders})
                     GROUP BY engram_id""",
                [as_of] + eids,
            ).fetchall()
        else:
            rows = db.conn.execute(
                f"""SELECT engram_id,
                       SUM(CASE WHEN is_current = 0 THEN 1 ELSE 0 END) AS not_current,
                       COUNT(*) AS total
                     FROM temporal_facts
                     WHERE engram_id IN ({placeholders})
                     GROUP BY engram_id""",
                eids,
            ).fetchall()
        for eid, not_current, total in rows:
            if total and not_current:
                superseded_fraction[eid] = not_current / total
    # Legacy name kept so the historical-intent branch below still works;
    # it's "everything with ANY superseded fact", which matches the old
    # semantics for that specific code path (boosting archival hits).
    superseded_eids = set(superseded_fraction.keys())

    # Query-aware recency spread: the newest/oldest factor range shifts
    # based on whether the query wants fresh content, historical content,
    # or is neutral. Fresh widens the spread toward newest; historical
    # INVERTS the gradient so older memories win; neutral keeps the
    # current default (1.00 → 0.80).
    newest_f, oldest_f = _recency_params(temporal_intent)
    lambda_days = _recency_lambda(temporal_intent)

    sorted_by_recency = sorted(candidates, key=lambda c: c["updated_at"] or "", reverse=True)
    n = len(sorted_by_recency)
    for i, c in enumerate(sorted_by_recency):
        if n <= 1:
            linear = newest_f
        else:
            t = i / (n - 1)
            linear = newest_f + t * (oldest_f - newest_f)

        # Layer the absolute exponential age decay on top of the linear
        # rank-relative spread. λ=0 (historical intent) disables this
        # entirely. Safe for all existing tests because the test scenarios
        # create memories seconds apart — age_days ≈ 0 → multiplier ≈ 1.
        age_factor = 1.0
        if lambda_days > 0:
            age_days = _age_days(c.get("updated_at"))
            age_factor = math.exp(-lambda_days * age_days)

        c["recency_factor"] = linear * age_factor
        c["age_days"] = _age_days(c.get("updated_at")) if lambda_days > 0 else 0.0

    DECISION_KEYWORDS = (
        "decision:", "decided", "update:", "actually", "instead",
        "switched", "migrated", "migration", "moved to", "moving to",
    )
    NEGATION_HINTS = (
        "not using", "no longer", "moved away", "deprecated",
        "abandoned", " not ", "won't use", "wont use", "stopped using",
    )

    # Stage 4: learned query→engram affinities. If we've previously seen
    # this exact query and the user fetched a specific engram as the
    # answer, boost it directly. Capped at +0.05 per pair.
    affinity_map: dict[str, float] = {}
    try:
        from neurovault_server.query_affinity import lookup_affinities, affinity_boost
        # Pass the already-computed query_embedding so the semantic
        # fallback can fire without re-encoding. Cosine similarity
        # catches paraphrased queries, not just literal repeats.
        for entry in lookup_affinities(db, query, query_embedding=list(query_embedding)):
            affinity_map[entry["engram_id"]] = affinity_boost(entry["hit_count"])
    except Exception as e:
        logger.debug("query_affinity lookup skipped: {}", e)

    for c in candidates:
        title_lower = c["title"].lower()
        content_head = c["content"][:300].lower()
        c["decision_bonus"] = 0.0
        c["affinity_bonus"] = affinity_map.get(c["engram_id"], 0.0)

        if temporal_intent == "historical":
            # User explicitly asked about the past. Newer decisions are
            # NOT the answer — whatever was true then is. Skip the decision
            # bonus and *reward* superseded facts since they're what the
            # user is looking for.
            if c["engram_id"] in superseded_eids:
                c["recency_factor"] = min(1.0, c["recency_factor"] * 1.5)
            continue

        if any(k in title_lower for k in DECISION_KEYWORDS):
            c["decision_bonus"] = 0.08
        elif any(p in content_head for p in NEGATION_HINTS):
            c["decision_bonus"] = 0.05
        # Fractional supersede penalty: scale the recency factor by the
        # fraction of this engram's temporal_facts that are stale. A page
        # with 2% stale facts gets a 1% penalty (multiplier 0.99); a page
        # with 100% stale facts gets the old full 0.5 multiplier. Only
        # pages with a MAJORITY of stale facts lose their decision bonus.
        frac = superseded_fraction.get(c["engram_id"], 0.0)
        if frac > 0.0:
            c["recency_factor"] *= (1.0 - 0.5 * frac)
            if frac > 0.5:
                c["decision_bonus"] = 0.0

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

    # --- Final scoring: rerank + strength + recency + decision + affinity ---
    # Insight engrams carry a small flat boost: they're distilled 1-line
    # facts promoted from conversation, so when they match a query they're
    # almost always the most useful answer versus a long code file or a
    # raw observation that happens to share keywords.
    INSIGHT_BOOST = 0.06
    for c in candidates:
        base = c["rerank_score"] * 0.75 + c["strength"] * 0.15
        kind_bonus = INSIGHT_BOOST if c.get("kind") == "insight" else 0.0
        c["final_score"] = round(
            base * c["recency_factor"]
            + c["decision_bonus"]
            + c.get("affinity_bonus", 0.0)
            + kind_bonus,
            4,
        )

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
        "Hybrid retrieval: {} results for '{}' (type={}, intent={}, semantic={}, bm25={}, graph={}, titles={}, reranker={})",
        len(results), query[:50], query_type, temporal_intent,
        len(semantic_ranked), len(bm25_ranked), len(graph_ranked), len(title_matches),
        "on" if use_reranker else "off",
    )
    return results


def chunk_retrieve(
    query: str,
    db: Database,
    embedder: Embedder,
    bm25: BM25Index,
    top_k: int = 10,
    granularity: str = "paragraph",
) -> list[dict]:
    """Chunk-level hybrid retrieval — returns the actual matching passages,
    not whole engrams. Use this when the caller wants the slice that's
    relevant to the query instead of the whole note.

    Pipeline (simpler than hybrid_retrieve — no graph, no reranker, no
    query expansion): semantic KNN on chunks + BM25 on chunks, fused via
    RRF. Filtered to the requested granularity (paragraph by default —
    document chunks are too big for a chunk-level mode, sentence chunks
    are too small for most uses).

    Returns: [{chunk_id, engram_id, title, content, granularity,
                score, filename}]
    """
    if granularity not in ("document", "paragraph", "sentence"):
        granularity = "paragraph"

    # Oversample so filtering by granularity + dedup doesn't drain the pool.
    pool = top_k * 4

    # --- Semantic: KNN over all chunk embeddings ---
    q_emb = embedder.encode_query(query)
    sem_hits = db.knn_search(q_emb, limit=pool * 2)  # extra headroom; we'll filter

    # --- BM25: chunk-level already (bm25 stores per-chunk tokens) ---
    bm25_hits = bm25.search(query, n=pool * 2)

    # RRF fuse chunks. Rank is position in each list.
    rrf: dict[str, float] = {}
    for rank, hit in enumerate(sem_hits):
        cid = hit["chunk_id"]
        rrf[cid] = rrf.get(cid, 0.0) + _rrf_score(rank) * 0.6  # semantic weight
    for rank, (cid, _score) in enumerate(bm25_hits):
        rrf[cid] = rrf.get(cid, 0.0) + _rrf_score(rank) * 0.4  # bm25 weight

    if not rrf:
        return []

    # Pull chunk rows + engram metadata for the fused top list.
    cids_sorted = sorted(rrf.keys(), key=lambda c: rrf[c], reverse=True)[:pool]
    placeholders = ",".join("?" * len(cids_sorted))
    rows = db.conn.execute(
        f"""SELECT c.id, c.engram_id, c.content, c.granularity,
                   e.title, e.filename, e.state
            FROM chunks c
            JOIN engrams e ON e.id = c.engram_id
            WHERE c.id IN ({placeholders})
              AND c.granularity = ?
              AND e.state != 'dormant'""",
        (*cids_sorted, granularity),
    ).fetchall()

    # Keep RRF order + attach score.
    by_id = {r[0]: r for r in rows}
    out: list[dict] = []
    seen_engrams: set[str] = set()
    for cid in cids_sorted:
        r = by_id.get(cid)
        if r is None:
            continue
        # Dedup to at most one chunk per engram — otherwise a single
        # long note dominates the result set. The top-ranked chunk wins.
        if r[1] in seen_engrams:
            continue
        seen_engrams.add(r[1])
        out.append({
            "chunk_id": r[0],
            "engram_id": r[1],
            "content": r[2],
            "granularity": r[3],
            "title": r[4],
            "filename": r[5],
            "score": round(rrf[cid], 4),
        })
        if len(out) >= top_k:
            break

    logger.info(
        "Chunk retrieval: {} chunks for '{}' (semantic={}, bm25={}, granularity={})",
        len(out), query[:50], len(sem_hits), len(bm25_hits), granularity,
    )
    return out


def _graph_retrieve(query: str, db: Database, limit: int = 20) -> list[str]:
    """Knowledge graph traversal: entity match + 2-hop."""
    from neurovault_server.entities import _extract_entities_local

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
