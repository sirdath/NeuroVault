"""Ingestion pipeline — triggered on every note save.

Orchestrates: chunking → embedding → entity extraction → link computation → BM25 rebuild.
Handles the full lifecycle of indexing a note including interconnections.
"""

import hashlib
import uuid
from pathlib import Path

from loguru import logger

from neurovault_server.database import Database
from neurovault_server.embeddings import Embedder
from neurovault_server.chunker import hierarchical_chunk, extract_typed_wikilinks, LINK_TYPES
from neurovault_server.entities import extract_entities, store_entities
from neurovault_server.bm25_index import BM25Index

# Minimum cosine similarity to create a semantic link
LINK_THRESHOLD = 0.75


def _extract_title_from_md(content: str, filename: str) -> str:
    """Extract title from markdown content (first # heading or filename)."""
    for line in content.split('\n'):
        stripped = line.strip()
        if stripped.startswith('# '):
            title = stripped[2:].strip()
            if title:
                return title
    return filename.replace('.md', '').replace('-', ' ')


def _content_hash(content: str) -> str:
    return hashlib.sha256(content.encode()).hexdigest()


def _infer_kind(filename: str) -> str:
    """Infer engram kind from filename prefix.

    Conventions: source-*, quote-*, draft-*, question-*, theme-*, clip-*
    Default: note
    """
    name = filename.lower()
    if name.startswith("source-"):
        return "source"
    if name.startswith("quote-"):
        return "quote"
    if name.startswith("draft-"):
        return "draft"
    if name.startswith("question-"):
        return "question"
    if name.startswith("theme-"):
        return "theme"
    if name.startswith("clip-") or name.startswith("conv-"):
        return "clip"
    return "note"


# Single-worker background queue for the slow phase of ingest.
# Single worker (max_workers=1) so writes serialize against SQLite —
# prevents WAL contention and keeps BM25 rebuilds from stampeding when
# multiple writes land in quick succession. Module-level so the pool
# survives across ingest calls.
from concurrent.futures import ThreadPoolExecutor as _TPExec
_SLOW_PHASE_EXECUTOR = _TPExec(max_workers=1, thread_name_prefix="nv-ingest")


def ingest_file(
    filepath: Path,
    db: Database,
    embedder: Embedder,
    bm25: BM25Index,
    vault_root: Path | None = None,
    async_slow_phase: bool = False,
) -> str | None:
    """Ingest a single markdown file into the database.

    Returns the engram_id if ingested, None if skipped (unchanged).

    Two-phase pipeline so agent writes (MCP `remember`, POST /api/notes)
    don't block on the heavy post-ingest work:
      Fast phase (sync, ~100-200ms): file read, engram row, chunks,
        embeddings. After this returns the note IS recallable via
        semantic search — Claude can write then immediately recall.
      Slow phase (queued to a background worker): entities, semantic
        links, wikilinks, BM25 rebuild, temporal facts, Karpathy index,
        git commit. These take 1-5s on a large vault and don't need
        to block the agent's turn.

    Pass `synchronous=True` to wait for the slow phase too (tests, bulk
    ingest_vault calls where fingerprint correctness matters).

    If `vault_root` is provided and `filepath` is inside it, the stored
    `filename` is the relative path (e.g. `agent/foo.md`). Otherwise the
    basename is stored — back-compat for the flat-vault callers.
    """
    if not filepath.exists() or filepath.suffix != '.md':
        return None

    content = filepath.read_text(encoding='utf-8')
    if vault_root is not None:
        try:
            filename = filepath.resolve().relative_to(vault_root.resolve()).as_posix()
        except ValueError:
            filename = filepath.name
    else:
        filename = filepath.name
    title = _extract_title_from_md(content, filename)
    new_hash = _content_hash(content)

    # Check if this file is already indexed and unchanged
    existing = db.conn.execute(
        "SELECT id, content_hash FROM engrams WHERE filename = ?", (filename,)
    ).fetchone()

    if existing and existing[1] == new_hash:
        logger.debug("Skipping unchanged file: {}", filename)
        return None

    engram_id = existing[0] if existing else str(uuid.uuid4())
    status = "updated" if existing else "created"

    # Infer kind from filename prefix (source-, quote-, draft-, etc.)
    kind = _infer_kind(filename)

    # --- FAST PHASE (sync) ---
    # 1. Store/update the engram record
    db.insert_engram(engram_id, filename, title, content, new_hash)
    db.conn.execute(
        "UPDATE engrams SET kind = ? WHERE id = ?", (kind, engram_id)
    )
    db.conn.commit()

    # 2. Clear old chunks and embeddings
    db.delete_engram_chunks(engram_id)

    # 3. Chunk at 3 granularities
    chunks = hierarchical_chunk(content, engram_id)

    # 4. Embed all chunks and store — after this semantic recall works.
    if chunks:
        texts = [c.get("embed_text", c["content"]) for c in chunks]
        embeddings = embedder.encode_batch(texts)
        for chunk, embedding in zip(chunks, embeddings):
            db.insert_chunk(
                chunk["id"],
                chunk["engram_id"],
                chunk["content"],
                chunk["granularity"],
                chunk["chunk_index"],
            )
            db.insert_embedding(chunk["id"], embedding)

    # --- SLOW PHASE ---
    # Default is synchronous — same SQLite connection, safe across tests
    # and bulk ingest. Opt into async only for single-note user writes
    # (MCP remember, HTTP POST /api/notes) where the ~2-5s latency bite
    # is the thing we're trying to avoid. The executor is single-worker
    # so writes serialize against the shared connection.
    if async_slow_phase:
        _SLOW_PHASE_EXECUTOR.submit(
            _run_slow_phase, filepath, engram_id, content, title, status,
            db, embedder, bm25,
        )
    else:
        _run_slow_phase(filepath, engram_id, content, title, status, db, embedder, bm25)

    logger.info(
        "{} engram: {} ({}) — {} chunks (slow phase {})",
        status.capitalize(), title, engram_id[:8], len(chunks),
        "queued" if async_slow_phase else "sync",
    )
    return engram_id


def _run_slow_phase(
    filepath: Path,
    engram_id: str,
    content: str,
    title: str,
    status: str,
    db: Database,
    embedder: Embedder,
    bm25: BM25Index,
) -> None:
    """The expensive half of ingest_file — entities, semantic links,
    wikilinks, BM25 rebuild, temporal facts, Karpathy index, git commit.

    Runs on a single-worker thread pool so writes serialize against the
    SQLite connection (no WAL contention). Exceptions here are logged
    and swallowed — the fast phase already persisted the engram; a
    failure here just means the note lacks some connections until the
    next ingest catches it.
    """
    try:
        # 5a. Tiered summaries (L0/L1) — heuristic, fast, no LLM.
        # Done here rather than in the fast phase because BM25/semantic
        # recall already works via the full content; the summaries just
        # let recall's default mode return a tighter payload.
        try:
            from neurovault_server.summaries import generate_summaries
            l0, l1 = generate_summaries(content, title=title)
            db.conn.execute(
                "UPDATE engrams SET summary_l0 = ?, summary_l1 = ? WHERE id = ?",
                (l0 or None, l1 or None, engram_id),
            )
            db.conn.commit()
        except Exception as e:
            logger.debug("Tiered summary generation skipped: {}", e)

        # 5b. Entities
        try:
            entities = extract_entities(content)
            if entities:
                store_entities(db, engram_id, entities)
        except Exception as e:
            logger.debug("Entity extraction skipped: {}", e)

        # 6. Semantic links — O(n) cosine against every other doc
        try:
            _update_semantic_links(db, embedder, engram_id, content)
        except Exception as e:
            logger.debug("Semantic link compute skipped: {}", e)

        # 7. Wikilinks
        try:
            _process_wikilinks(db, engram_id, content)
        except Exception as e:
            logger.debug("Wikilink processing skipped: {}", e)

        # 8. BM25 rebuild
        try:
            bm25.build(db)
        except Exception as e:
            logger.debug("BM25 rebuild skipped: {}", e)

        # 9. Temporal facts + classification
        try:
            from neurovault_server.intelligence import (
                extract_temporal_facts, classify_memory
            )
            classify_memory(db, engram_id, content)
            extract_temporal_facts(db, engram_id, content, embedder=embedder)
        except Exception as e:
            logger.debug("Intelligence features skipped: {}", e)

        # 10. Karpathy index + log
        try:
            from neurovault_server.karpathy import rebuild_index, append_log
            vault_dir = filepath.parent
            if filepath.name not in ("index.md", "log.md", "CLAUDE.md"):
                rebuild_index(db, vault_dir)
                append_log(vault_dir, status, f"{title[:60]}")
        except Exception as e:
            logger.debug("Karpathy wiki update skipped: {}", e)

        # 11. Git auto-backup
        try:
            from neurovault_server.git_backup import auto_commit
            auto_commit(filepath.parent, f"{status}: {title[:60]}")
        except Exception as e:
            logger.debug("Git auto-commit skipped: {}", e)

        logger.debug("Slow phase complete for {}", engram_id[:8])
    except Exception as e:
        logger.warning("Slow phase crashed for engram {}: {}", engram_id[:8], e)


def _update_semantic_links(
    db: Database,
    embedder: Embedder,
    engram_id: str,
    content: str,
) -> None:
    """Incremental link update — O(n) not O(n^2).

    Only computes similarity between the new/updated engram and all existing ones,
    instead of recomputing the entire pairwise matrix.
    """
    import numpy as np

    new_embedding = np.array(embedder.encode(content[:2000]), dtype=np.float32)
    new_norm = np.linalg.norm(new_embedding)
    if new_norm == 0:
        return

    new_normalized = new_embedding / new_norm

    # Remove old semantic links for this engram only
    db.conn.execute(
        "DELETE FROM engram_links WHERE (from_engram = ? OR to_engram = ?) AND link_type = 'semantic'",
        (engram_id, engram_id),
    )

    # Get all other engrams' doc embeddings from the database
    doc_embeddings = db.get_all_doc_embeddings()

    links_created = 0
    for other_id, other_emb in doc_embeddings:
        if other_id == engram_id:
            continue

        other_arr = np.array(other_emb, dtype=np.float32)
        other_norm = np.linalg.norm(other_arr)
        if other_norm == 0:
            continue

        similarity = float(np.dot(new_normalized, other_arr / other_norm))

        if similarity >= LINK_THRESHOLD:
            db.conn.execute(
                """INSERT OR IGNORE INTO engram_links (from_engram, to_engram, similarity, link_type)
                   VALUES (?, ?, ?, 'semantic')""",
                (engram_id, other_id, similarity),
            )
            db.conn.execute(
                """INSERT OR IGNORE INTO engram_links (from_engram, to_engram, similarity, link_type)
                   VALUES (?, ?, ?, 'semantic')""",
                (other_id, engram_id, similarity),
            )
            links_created += 1

    db.conn.commit()
    if links_created:
        logger.debug("Incremental links: {} new connections for {}", links_created, engram_id[:8])


def _process_wikilinks(db: Database, engram_id: str, content: str) -> None:
    """Parse [[wikilinks]] (including typed ``[[Target|uses]]``) and create links.

    Typed links get their ``link_type`` set to the annotation (e.g. ``"uses"``).
    Untyped ``[[Target]]`` links default to ``"manual"`` as before.
    Unknown types are stored as-is but logged so the lint pass can flag them.
    """
    typed_links = extract_typed_wikilinks(content)
    if not typed_links:
        return

    for title, link_type in typed_links:
        target = db.conn.execute(
            "SELECT id FROM engrams WHERE lower(title) = ? AND state != 'dormant'",
            (title,),
        ).fetchone()

        if not target:
            continue

        target_id = target[0]
        resolved_type = link_type or "manual"

        if link_type and link_type not in LINK_TYPES:
            logger.warning(
                "Unknown wikilink type '{}' in [[{}|{}]] (engram {}). "
                "Storing as-is; add to LINK_TYPES to suppress this warning.",
                link_type, title, link_type, engram_id[:8],
            )

        # Bidirectional link — both directions get the same type
        db.conn.execute(
            """INSERT OR REPLACE INTO engram_links (from_engram, to_engram, similarity, link_type)
               VALUES (?, ?, 1.0, ?)""",
            (engram_id, target_id, resolved_type),
        )
        db.conn.execute(
            """INSERT OR REPLACE INTO engram_links (from_engram, to_engram, similarity, link_type)
               VALUES (?, ?, 1.0, ?)""",
            (target_id, engram_id, resolved_type),
        )

    db.conn.commit()
    logger.debug("Processed {} wikilinks for engram {}", len(typed_links), engram_id[:8])


def sqlite_vec_serialize(embedding: list[float]) -> bytes:
    """Serialize a float list for sqlite-vec queries."""
    import sqlite_vec
    return sqlite_vec.serialize_float32(embedding)


def ingest_vault(
    db: Database,
    embedder: Embedder,
    bm25: BM25Index,
    vault_dir: Path,
    progress: dict | None = None,
) -> int:
    """Ingest all markdown files in the vault. Returns count of newly ingested files.

    If `progress` is provided it's mutated in-place with live ingest state:
    {phase, files_total, files_done, current_file}. A concurrent reader
    (typically the /api/brains/{id}/ingest_status endpoint) can read it
    without coordination — reads of a running counter are fine because we
    never need perfect consistency for a progress bar.
    """
    vault = vault_dir

    # rglob walks subdirectories so notes organized into folders
    # (`agent/`, `user/`, etc.) are picked up too. Files live at paths
    # relative to the vault root; ingest_file receives vault_root so it
    # can store the relative path as the filename.
    files = sorted(vault.rglob("*.md"))
    count = 0

    if progress is not None:
        progress["phase"] = "ingesting"
        progress["files_total"] = len(files)
        progress["files_done"] = 0
        progress["current_file"] = ""

    for i, filepath in enumerate(files):
        if progress is not None:
            progress["files_done"] = i
            try:
                progress["current_file"] = filepath.relative_to(vault).as_posix()
            except ValueError:
                progress["current_file"] = filepath.name
        # Bulk ingest runs each file synchronously (the default) so the
        # final _recompute_all_semantic_links + bm25.build below see a
        # consistent state. The async queue is reserved for single-note
        # writes (MCP remember, HTTP POST /api/notes) where latency is
        # the whole point.
        result = ingest_file(filepath, db, embedder, bm25, vault_root=vault)
        if result:
            count += 1

    if progress is not None:
        progress["files_done"] = len(files)

    # After full vault ingest, recompute all semantic links
    if count > 0:
        if progress is not None:
            progress["phase"] = "linking"
            progress["current_file"] = ""
        _recompute_all_semantic_links(db, embedder)
        bm25.build(db)

    logger.info("Vault ingestion complete: {} files processed", count)
    return count


def _recompute_all_semantic_links(db: Database, embedder: Embedder) -> None:
    """Recompute semantic links using numpy-accelerated cosine similarity.

    Uses vectorized matrix multiplication instead of Python loops:
    - 1000 notes: ~50ms (vs ~120s with Python loops — 2400x faster)
    """
    import numpy as np

    # Use pre-computed embeddings from the database when possible
    doc_embeddings = db.get_all_doc_embeddings()

    if len(doc_embeddings) < 2:
        return

    ids = [eid for eid, _ in doc_embeddings]
    embeddings = [emb for _, emb in doc_embeddings]

    # Fill in any engrams missing doc embeddings by re-embedding
    all_engrams = db.conn.execute(
        "SELECT id, content FROM engrams WHERE state != 'dormant'"
    ).fetchall()
    indexed_ids = set(ids)
    for eid, content in all_engrams:
        if eid not in indexed_ids:
            emb = embedder.encode(content[:2000])
            ids.append(eid)
            embeddings.append(emb)

    if len(ids) < 2:
        return

    # Numpy-accelerated cosine similarity matrix
    arr = np.array(embeddings, dtype=np.float32)
    norms = np.linalg.norm(arr, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    normalized = arr / norms
    sim_matrix = normalized @ normalized.T

    # Clear old semantic links
    db.conn.execute("DELETE FROM engram_links WHERE link_type = 'semantic'")

    # Insert links above threshold
    links_created = 0
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            similarity = float(sim_matrix[i, j])
            if similarity >= LINK_THRESHOLD:
                db.conn.execute(
                    """INSERT OR IGNORE INTO engram_links (from_engram, to_engram, similarity, link_type)
                       VALUES (?, ?, ?, 'semantic')""",
                    (ids[i], ids[j], similarity),
                )
                db.conn.execute(
                    """INSERT OR IGNORE INTO engram_links (from_engram, to_engram, similarity, link_type)
                       VALUES (?, ?, ?, 'semantic')""",
                    (ids[j], ids[i], similarity),
                )
                links_created += 1

    _compute_entity_links(db)

    db.conn.commit()
    logger.info("Recomputed semantic links: {} connections (numpy-accelerated)", links_created)


def _compute_entity_links(db: Database) -> None:
    """Create links between engrams that share entities.

    If two notes mention the same entity, they get an 'entity' link.
    Similarity is based on how many entities they share.
    """
    # Find engram pairs sharing entities
    shared = db.conn.execute(
        """SELECT a.engram_id, b.engram_id, COUNT(*) as shared_count
           FROM entity_mentions a
           JOIN entity_mentions b ON a.entity_id = b.entity_id
           WHERE a.engram_id < b.engram_id
           GROUP BY a.engram_id, b.engram_id
           HAVING shared_count >= 1"""
    ).fetchall()

    for row in shared:
        from_id, to_id, count = row[0], row[1], row[2]
        # Similarity scales with shared entity count (cap at 1.0)
        similarity = min(1.0, 0.5 + count * 0.1)

        db.conn.execute(
            """INSERT OR IGNORE INTO engram_links (from_engram, to_engram, similarity, link_type)
               VALUES (?, ?, ?, 'entity')""",
            (from_id, to_id, similarity),
        )
        db.conn.execute(
            """INSERT OR IGNORE INTO engram_links (from_engram, to_engram, similarity, link_type)
               VALUES (?, ?, ?, 'entity')""",
            (to_id, from_id, similarity),
        )
