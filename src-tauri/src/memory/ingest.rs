//! End-to-end ingest pipeline: chunk → embed → persist → entities →
//! semantic links → wikilinks → BM25 rebuild.
//!
//! Port of `server/neurovault_server/ingest.py`. The async slow-phase
//! executor from the Python side is deliberately NOT ported here —
//! the Rust runtime is light enough that running the whole pipeline
//! synchronously inside a Tauri command is under the latency budget
//! the user cares about (the whole reason for the migration was that
//! the Python version was heavy). If a future profile run shows a
//! specific slow step blocking the UI, we move that one step to a
//! background thread — not the whole slow phase up-front.
//!
//! Matches Python semantics for:
//! - `content_hash` (SHA-256 hex) for skip-if-unchanged.
//! - `engram_id` (UUIDv4) mint on create; existing id reused on update.
//! - `kind` inference by filename prefix (source-, quote-, draft-, …).
//! - `embed_text` vs `content`: the chunker prefixes embed_text with
//!   the title for retrieval quality; the stored content stays raw.
//! - `LINK_THRESHOLD = 0.75`: minimum cosine to create a semantic link.
//! - Bidirectional entity/semantic/wikilink insertion.
//!
//! Cross-runtime safety: every UPDATE/INSERT uses the same SQL the
//! Python version uses, so a brain.db that Python and Rust both write
//! to during the migration window stays internally consistent.

use std::path::Path;
use std::sync::Arc;

use rusqlite::params;
use sha2::{Digest, Sha256};

use super::bm25;
use super::chunker::{extract_typed_wikilinks, hierarchical_chunk, LINK_TYPES};
use super::db::{BrainDb, EMBEDDING_DIM};
use super::embedder;
use super::entities::{extract_entities_locally, store_entities};
use super::recall_cache;
use super::summaries::generate_summaries_default;
use super::types::Result;

/// Minimum cosine similarity for an automatic `semantic` link.
/// Matches `LINK_THRESHOLD` in `ingest.py`.
const LINK_THRESHOLD: f64 = 0.75;

/// First N chars of content fed into the doc-level embedding — same
/// slice Python uses in `_update_semantic_links`. Longer tails add
/// noise without improving retrieval quality.
const DOC_EMBED_MAX_CHARS: usize = 2000;

/// SHA-256 hex digest of `content`. Matches Python's
/// `hashlib.sha256(content.encode()).hexdigest()` exactly — same
/// byte input (UTF-8 encoding of the string), same 64-char lowercase
/// hex output — so a row written by either runtime reads as unchanged
/// on the other.
fn content_hash(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for b in digest.iter() {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

/// Extract title from the first `#` heading, or derive from filename.
/// Matches `ingest.py::_extract_title_from_md`.
fn extract_title(content: &str, filename: &str) -> String {
    for line in content.split('\n') {
        let stripped = line.trim();
        if let Some(rest) = stripped.strip_prefix("# ") {
            let title = rest.trim();
            if !title.is_empty() {
                return title.to_string();
            }
        }
    }
    filename.trim_end_matches(".md").replace('-', " ")
}

/// Kind classification by filename prefix. Matches `_infer_kind`.
fn infer_kind(filename: &str) -> &'static str {
    let name = filename.to_lowercase();
    if name.starts_with("source-") {
        "source"
    } else if name.starts_with("quote-") {
        "quote"
    } else if name.starts_with("draft-") {
        "draft"
    } else if name.starts_with("question-") {
        "question"
    } else if name.starts_with("theme-") {
        "theme"
    } else if name.starts_with("clip-") || name.starts_with("conv-") {
        "clip"
    } else {
        "note"
    }
}

/// Pack a `&[f32]` as the little-endian byte stream sqlite-vec's
/// `vec0` virtual table expects. Matches Python's
/// `sqlite_vec.serialize_float32` byte layout (4 bytes per float, LE).
fn serialize_float32(vec: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(vec.len() * 4);
    for f in vec {
        out.extend_from_slice(&f.to_le_bytes());
    }
    out
}

/// Inverse of `serialize_float32`: decode the BLOB stored in
/// `vec_chunks.embedding` back to floats.
fn deserialize_float32(bytes: &[u8]) -> Vec<f32> {
    let mut out = Vec::with_capacity(bytes.len() / 4);
    let mut i = 0;
    while i + 4 <= bytes.len() {
        let arr = [bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]];
        out.push(f32::from_le_bytes(arr));
        i += 4;
    }
    out
}

/// L2-normalise a vector in place-by-value. Returns `None` if the
/// input is all zeros (zero-norm vectors don't have a cosine).
fn normalize(v: &[f32]) -> Option<Vec<f32>> {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm == 0.0 {
        return None;
    }
    Some(v.iter().map(|x| x / norm).collect())
}

/// Cosine similarity over two pre-normalised vectors — plain dot
/// product. Caller must have normalised both inputs; this stays
/// branch-free for the hot `_update_semantic_links` loop.
fn cosine_norm(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

/// Ingest a single markdown file. Returns `Some(engram_id)` when the
/// file was ingested (created or updated), `None` when it was skipped
/// because the content hash is unchanged.
///
/// `vault_root`, when provided, is used to store `filename` as a
/// POSIX-style path relative to the vault (e.g. `agent/foo.md`) so
/// folder organisation round-trips through the DB.
pub fn ingest_file(
    filepath: &Path,
    vault_root: Option<&Path>,
    db: &Arc<BrainDb>,
) -> Result<Option<String>> {
    if !filepath.exists() {
        return Ok(None);
    }
    if filepath.extension().map(|e| e != "md").unwrap_or(true) {
        return Ok(None);
    }

    let content = std::fs::read_to_string(filepath)?;
    let filename = if let Some(root) = vault_root {
        match filepath.canonicalize().and_then(|c| {
            root.canonicalize()
                .map(|r| (c, r))
        }) {
            Ok((c, r)) => c
                .strip_prefix(&r)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| {
                    filepath
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default()
                }),
            Err(_) => filepath
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
        }
    } else {
        filepath
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default()
    };

    ingest_content(&filename, &content, db)
}

/// In-memory ingest entry point — used when the caller already has
/// the content as a string (Tauri `nv_save_note`) and doesn't want to
/// round-trip through the filesystem.
///
/// Keeps the same "skip if unchanged" fast path as the file-based
/// version: if a row with the same filename + content_hash already
/// exists, return `Ok(None)` without touching anything else.
pub fn ingest_content(
    filename: &str,
    content: &str,
    db: &Arc<BrainDb>,
) -> Result<Option<String>> {
    let title = extract_title(content, filename);
    let new_hash = content_hash(content);
    let kind = infer_kind(filename);

    // Fast phase — under the lock, commit, release. Everything
    // after (chunk, embed, links) runs on its own short locks.
    let existing_id: Option<String>;
    {
        let conn = db.lock();
        let found: Option<(String, String)> = conn
            .query_row(
                "SELECT id, content_hash FROM engrams WHERE filename = ?1",
                [filename],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .ok();
        if let Some((_, ref h)) = found {
            if h == &new_hash {
                return Ok(None);
            }
        }
        existing_id = found.map(|(id, _)| id);
    }

    let engram_id = existing_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    // 1. Upsert engram row + set kind. Use millisecond timestamps
    // like Python does — 1-second `datetime('now')` ties break
    // recency sorting when ingest fires in a tight loop.
    {
        let conn = db.lock();
        conn.execute(
            "INSERT INTO engrams (id, filename, title, content, content_hash,
                                   created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5,
                     strftime('%Y-%m-%d %H:%M:%f', 'now'),
                     strftime('%Y-%m-%d %H:%M:%f', 'now'))
             ON CONFLICT(id) DO UPDATE SET
               title=excluded.title,
               content=excluded.content,
               content_hash=excluded.content_hash,
               updated_at=strftime('%Y-%m-%d %H:%M:%f', 'now')",
            params![&engram_id, filename, &title, content, &new_hash],
        )?;
        conn.execute(
            "UPDATE engrams SET kind = ?1 WHERE id = ?2",
            params![kind, &engram_id],
        )?;
    }

    // 2. Replace chunks. Delete + insert is the same pattern Python
    // uses; keeps us out of "did an ALTER land on a different row"
    // territory.
    delete_chunks(db, &engram_id)?;

    // 3. Chunk + 4. Embed + 5. Persist chunks with embeddings.
    let chunks = hierarchical_chunk(content, &engram_id);
    if !chunks.is_empty() {
        let embed_texts: Vec<String> = chunks.iter().map(|c| c.embed_text.clone()).collect();
        let embeddings = embedder::encode_batch(&embed_texts)?;
        debug_assert_eq!(embeddings.len(), chunks.len());
        let conn = db.lock();
        for (chunk, embedding) in chunks.iter().zip(embeddings.iter()) {
            conn.execute(
                "INSERT OR REPLACE INTO chunks (id, engram_id, content, granularity, chunk_index)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    &chunk.id,
                    &chunk.engram_id,
                    &chunk.content,
                    &chunk.granularity,
                    chunk.chunk_index,
                ],
            )?;
            // vec0 tables don't honour INSERT OR REPLACE semantics —
            // explicit DELETE first, matching the Python side.
            conn.execute("DELETE FROM vec_chunks WHERE chunk_id = ?1", [&chunk.id])?;
            conn.execute(
                "INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?1, ?2)",
                params![&chunk.id, &serialize_float32(embedding)],
            )?;
        }
    }

    // --- Slow phase (synchronous in this port). Each step is
    // wrapped in a sub-result so a failure in one doesn't block the
    // others — the fast phase has already persisted the engram, so
    // a transient slow-phase error just means this note is slightly
    // under-linked until the next ingest touches it.

    // 5a. Tiered summaries.
    if let Err(e) = write_summaries(db, &engram_id, content, &title) {
        eprintln!("[ingest] summaries skipped for {}: {}", &engram_id[..8], e);
    }

    // 5b. Entities (regex path).
    if let Err(e) = write_entities(db, &engram_id, content) {
        eprintln!("[ingest] entities skipped for {}: {}", &engram_id[..8], e);
    }

    // 6. Semantic links — O(n) cosine against every other doc.
    if let Err(e) = update_semantic_links(db, &engram_id, content) {
        eprintln!(
            "[ingest] semantic links skipped for {}: {}",
            &engram_id[..8],
            e
        );
    }

    // 6a. Retroactive entity links — A-Mem style.
    if let Err(e) = update_entity_links(db, &engram_id) {
        eprintln!(
            "[ingest] entity links skipped for {}: {}",
            &engram_id[..8],
            e
        );
    }

    // 7. Wikilinks.
    if let Err(e) = process_wikilinks(db, &engram_id, content) {
        eprintln!(
            "[ingest] wikilinks skipped for {}: {}",
            &engram_id[..8],
            e
        );
    }

    // 8. BM25 rebuild — debounced. Matches the 5s window Python uses.
    let bm25_idx = bm25::index_for(db.brain_id());
    bm25_idx.schedule_rebuild(Arc::clone(db));

    // Any write invalidates the per-brain recall cache so stale
    // results don't outlive the mutation.
    recall_cache::invalidate_brain(db.brain_id());

    Ok(Some(engram_id))
}

/// Remove all chunk + vec rows for the given engram. Used on ingest
/// (replace) and on soft-delete.
fn delete_chunks(db: &BrainDb, engram_id: &str) -> Result<()> {
    let conn = db.lock();
    let mut stmt = conn.prepare("SELECT id FROM chunks WHERE engram_id = ?1")?;
    let ids: Vec<String> = stmt
        .query_map([engram_id], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);
    for cid in &ids {
        conn.execute("DELETE FROM vec_chunks WHERE chunk_id = ?1", [cid])?;
    }
    conn.execute("DELETE FROM chunks WHERE engram_id = ?1", [engram_id])?;
    Ok(())
}

/// Write L0/L1 summaries into the `summary_l0` + `summary_l1` columns.
/// Empty strings become NULL to match Python's `l0 or None` pattern.
fn write_summaries(
    db: &BrainDb,
    engram_id: &str,
    content: &str,
    title: &str,
) -> Result<()> {
    let (l0, l1) = generate_summaries_default(content, Some(title));
    let l0_val: Option<&str> = if l0.is_empty() { None } else { Some(&l0) };
    let l1_val: Option<&str> = if l1.is_empty() { None } else { Some(&l1) };
    let conn = db.lock();
    conn.execute(
        "UPDATE engrams SET summary_l0 = ?1, summary_l1 = ?2 WHERE id = ?3",
        params![l0_val, l1_val, engram_id],
    )?;
    Ok(())
}

/// Extract + store entities. Wraps the extractor + storage call in a
/// single helper so callers don't have to match on both error points.
fn write_entities(db: &BrainDb, engram_id: &str, content: &str) -> Result<()> {
    let ents = extract_entities_locally(content);
    if ents.is_empty() {
        return Ok(());
    }
    let conn = db.lock();
    store_entities(&conn, engram_id, &ents)?;
    Ok(())
}

/// Incremental semantic-link update. Ports
/// `ingest.py::_update_semantic_links`. O(n) cosine against every
/// existing doc-level embedding, inserts bidirectional edges above
/// threshold.
fn update_semantic_links(db: &BrainDb, engram_id: &str, content: &str) -> Result<()> {
    let head: String = content.chars().take(DOC_EMBED_MAX_CHARS).collect();
    let new_embedding = embedder::encode(&head)?;
    let Some(new_normalized) = normalize(&new_embedding) else {
        return Ok(());
    };

    // Clear old semantic links that touch this engram before recomputing.
    {
        let conn = db.lock();
        conn.execute(
            "DELETE FROM engram_links
             WHERE (from_engram = ?1 OR to_engram = ?1) AND link_type = 'semantic'",
            [engram_id],
        )?;
    }

    // Pull every other doc-level embedding.
    let others = get_all_doc_embeddings(db)?;

    let conn = db.lock();
    for (other_id, other_emb) in others {
        if other_id == engram_id {
            continue;
        }
        // Skip zero-norm and dimension-mismatched rows (corruption
        // safety — a row with the wrong dim would hard-error the
        // dot product below).
        if other_emb.len() != EMBEDDING_DIM {
            continue;
        }
        let Some(other_normalized) = normalize(&other_emb) else {
            continue;
        };
        let sim = cosine_norm(&new_normalized, &other_normalized) as f64;
        if sim >= LINK_THRESHOLD {
            conn.execute(
                "INSERT OR IGNORE INTO engram_links
                 (from_engram, to_engram, similarity, link_type)
                 VALUES (?1, ?2, ?3, 'semantic')",
                params![engram_id, &other_id, sim],
            )?;
            conn.execute(
                "INSERT OR IGNORE INTO engram_links
                 (from_engram, to_engram, similarity, link_type)
                 VALUES (?1, ?2, ?3, 'semantic')",
                params![&other_id, engram_id, sim],
            )?;
        }
    }
    Ok(())
}

/// Fetch all document-level embeddings for non-dormant engrams as
/// `(engram_id, vec<f32>)` pairs. Mirrors
/// `database.py::get_all_doc_embeddings`.
fn get_all_doc_embeddings(db: &BrainDb) -> Result<Vec<(String, Vec<f32>)>> {
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT c.engram_id, v.embedding
         FROM chunks c
         JOIN vec_chunks v ON v.chunk_id = c.id
         WHERE c.granularity = 'document'
           AND c.engram_id IN (SELECT id FROM engrams WHERE state != 'dormant')",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut out = Vec::with_capacity(rows.len());
    for (eid, blob) in rows {
        out.push((eid, deserialize_float32(&blob)));
    }
    Ok(out)
}

/// Retroactive entity-link update for one new engram. Mirrors
/// `_update_entity_links`. For every older non-dormant engram that
/// shares ≥1 entity with this one, insert a bidirectional
/// `entity`-type edge with similarity = min(1, 0.5 + shared * 0.1).
fn update_entity_links(db: &BrainDb, engram_id: &str) -> Result<()> {
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT b.engram_id, COUNT(*) as shared_count
         FROM entity_mentions a
         JOIN entity_mentions b ON a.entity_id = b.entity_id
         JOIN engrams e        ON e.id = b.engram_id
         WHERE a.engram_id = ?1
           AND b.engram_id != ?1
           AND e.state != 'dormant'
         GROUP BY b.engram_id
         HAVING shared_count >= 1",
    )?;
    let shared: Vec<(String, i64)> = stmt
        .query_map([engram_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);

    for (neighbor_id, count) in shared {
        let similarity = (0.5 + count as f64 * 0.1).min(1.0);
        conn.execute(
            "INSERT OR IGNORE INTO engram_links (from_engram, to_engram, similarity, link_type)
             VALUES (?1, ?2, ?3, 'entity')",
            params![engram_id, &neighbor_id, similarity],
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO engram_links (from_engram, to_engram, similarity, link_type)
             VALUES (?1, ?2, ?3, 'entity')",
            params![&neighbor_id, engram_id, similarity],
        )?;
    }
    Ok(())
}

/// Parse `[[wikilinks]]` (including typed forms) and create bidirectional
/// `engram_links` rows for each one whose target resolves to a
/// non-dormant engram. Mirrors `_process_wikilinks`.
fn process_wikilinks(db: &BrainDb, engram_id: &str, content: &str) -> Result<()> {
    let typed = extract_typed_wikilinks(content);
    if typed.is_empty() {
        return Ok(());
    }
    let conn = db.lock();
    for (target_title, link_type) in typed {
        let target_id: Option<String> = conn
            .query_row(
                "SELECT id FROM engrams
                 WHERE lower(title) = ?1 AND state != 'dormant'",
                [&target_title],
                |r| r.get::<_, String>(0),
            )
            .ok();
        let Some(target_id) = target_id else {
            continue;
        };
        let resolved_type = link_type.clone().unwrap_or_else(|| "manual".to_string());
        if let Some(ref lt) = link_type {
            if !LINK_TYPES.iter().any(|k| *k == lt.as_str()) {
                eprintln!(
                    "[ingest] unknown wikilink type '{}' in [[{}|{}]] (engram {}). \
                     Storing as-is; add to LINK_TYPES to suppress.",
                    lt,
                    target_title,
                    lt,
                    &engram_id[..engram_id.len().min(8)]
                );
            }
        }

        conn.execute(
            "INSERT OR REPLACE INTO engram_links (from_engram, to_engram, similarity, link_type)
             VALUES (?1, ?2, 1.0, ?3)",
            params![engram_id, &target_id, &resolved_type],
        )?;
        conn.execute(
            "INSERT OR REPLACE INTO engram_links (from_engram, to_engram, similarity, link_type)
             VALUES (?1, ?2, 1.0, ?3)",
            params![&target_id, engram_id, &resolved_type],
        )?;
    }
    Ok(())
}

/// Soft-delete: set `state = 'dormant'` and strip chunks + semantic
/// links. Matches the effect of `db.soft_delete` + downstream cleanup
/// in the Python side's delete path.
pub fn soft_delete_engram(db: &BrainDb, engram_id: &str) -> Result<bool> {
    let rows = {
        let conn = db.lock();
        conn.execute(
            "UPDATE engrams SET state = 'dormant' WHERE id = ?1",
            [engram_id],
        )?
    };
    if rows == 0 {
        return Ok(false);
    }
    // Clear chunks + vec rows so dormant engrams don't appear in
    // recall results.
    delete_chunks(db, engram_id)?;
    // Clear outbound / inbound semantic links — the row stays for
    // audit purposes but the graph no longer shows it.
    let conn = db.lock();
    conn.execute(
        "DELETE FROM engram_links WHERE from_engram = ?1 OR to_engram = ?1",
        [engram_id],
    )?;
    drop(conn);

    // Schedule BM25 rebuild so the dormant doc stops ranking.
    let bm25_idx = bm25::index_for(db.brain_id());
    // Need an Arc<BrainDb> for the debounced thread — we're passed a
    // &BrainDb. Callers that care about the rebuild must hold the Arc
    // themselves; fall back to a blocking flush here so we always
    // converge without the caller juggling lifetimes.
    let _ = bm25_idx.flush(db);
    recall_cache::invalidate_brain(db.brain_id());
    Ok(true)
}

/// Check whether `content` is a near-duplicate of an existing
/// engram. Returns `Some((engram_id, similarity))` on match,
/// `None` otherwise.
///
/// Shape: we embed the content head, KNN against `vec_chunks`
/// restricted to document-granularity rows, and compare the top
/// match's cosine similarity against the threshold. If threshold
/// is met, the caller can skip the ingest and return the matched
/// engram's id as "merged" — preventing the "Claude captured the
/// same insight 5 times" problem.
///
/// `ignore_engram_id`, when provided, excludes that engram from the
/// dedupe candidate set. Useful for the update-in-place path where
/// the caller is intentionally writing to an existing filename and
/// doesn't want the dedupe to match the row it's about to overwrite.
pub fn dedupe_check(
    db: &BrainDb,
    content: &str,
    threshold: f64,
    ignore_engram_id: Option<&str>,
) -> Result<Option<(String, f64)>> {
    if content.trim().is_empty() {
        return Ok(None);
    }
    // The vec_chunks doc-granularity embedding is produced by the
    // chunker as `"{title}: {doc_head}"` — NOT raw content. To
    // get an apples-to-apples distance we have to mirror that
    // exact shape here, otherwise identical content scores ~0.84
    // instead of ~1.0 and the threshold never fires.
    let title = extract_title(content, "");
    let head: String = content.chars().take(DOC_EMBED_MAX_CHARS).collect();
    let embed_input = if title.is_empty() {
        head
    } else {
        format!("{}: {}", title, head)
    };
    let query_emb = embedder::encode(&embed_input)?;
    // sqlite-vec MATCH wants the LE byte representation.
    let mut bytes = Vec::with_capacity(query_emb.len() * 4);
    for f in &query_emb {
        bytes.extend_from_slice(&f.to_le_bytes());
    }

    // Ask sqlite-vec for the top-5 nearest doc embeddings, THEN
    // fetch their raw bytes so we can compute cosine similarity
    // directly in Rust. This sidesteps any ambiguity about whether
    // sqlite-vec's `distance` column is L2, L2-squared, or cosine —
    // and whether fastembed-rs outputs unit-normalised vectors.
    // We compute cosine ourselves the same way `update_semantic_links`
    // does, so `dedupe=0.75` here is numerically identical to the
    // "semantic link" threshold used across the rest of the system.
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT c.engram_id, v.embedding
         FROM vec_chunks v
         JOIN chunks c ON c.id = v.chunk_id
         JOIN engrams e ON e.id = c.engram_id
         WHERE v.embedding MATCH ? AND k = ?
           AND c.granularity = 'document'
           AND e.state != 'dormant'
         ORDER BY v.distance ASC
         LIMIT 5",
    )?;
    let rows: Vec<(String, Vec<u8>)> = stmt
        .query_map(params![bytes, 5i64], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);
    drop(conn);

    // Normalise the query once; for each candidate deserialise +
    // normalise + cosine. Still O(5) at most — cheap.
    let q_norm = l2_norm(&query_emb);
    if q_norm == 0.0 {
        return Ok(None);
    }
    let q_normalised: Vec<f32> = query_emb.iter().map(|x| x / q_norm).collect();

    let mut best: Option<(String, f64)> = None;
    for (eid, blob) in rows {
        if let Some(ignore) = ignore_engram_id {
            if eid == ignore {
                continue;
            }
        }
        let other = deserialize_float32(&blob);
        if other.len() != query_emb.len() {
            continue; // shape mismatch — skip, not an error
        }
        let o_norm = l2_norm(&other);
        if o_norm == 0.0 {
            continue;
        }
        let o_normalised: Vec<f32> = other.iter().map(|x| x / o_norm).collect();
        let cosine: f64 = q_normalised
            .iter()
            .zip(o_normalised.iter())
            .map(|(a, b)| (*a as f64) * (*b as f64))
            .sum::<f64>()
            .clamp(-1.0, 1.0);
        match &best {
            None => best = Some((eid.clone(), cosine)),
            Some((_, prev)) if cosine > *prev => best = Some((eid.clone(), cosine)),
            _ => {}
        }
    }

    match best {
        Some((eid, sim)) if sim >= threshold => Ok(Some((eid, sim))),
        _ => Ok(None),
    }
}

fn l2_norm(v: &[f32]) -> f32 {
    v.iter().map(|x| x * x).sum::<f32>().sqrt()
}

/// Look up the id of the engram backing a given vault filename.
/// Used by the `nv_save_note` / `nv_delete_note` Tauri commands when
/// the caller identifies notes by filename but we need the UUID to
/// pass through to the rest of the pipeline.
pub fn lookup_engram_by_filename(db: &BrainDb, filename: &str) -> Result<Option<String>> {
    let conn = db.lock();
    let row: Option<String> = conn
        .query_row(
            "SELECT id FROM engrams WHERE filename = ?1",
            [filename],
            |r| r.get::<_, String>(0),
        )
        .ok();
    Ok(row)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_hash_matches_known_python_output() {
        // `hashlib.sha256(b"hello").hexdigest()` in Python.
        let expected = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
        assert_eq!(content_hash("hello"), expected);
    }

    #[test]
    fn kind_inference_covers_all_prefixes() {
        assert_eq!(infer_kind("source-foo.md"), "source");
        assert_eq!(infer_kind("quote-bar.md"), "quote");
        assert_eq!(infer_kind("draft-x.md"), "draft");
        assert_eq!(infer_kind("question-y.md"), "question");
        assert_eq!(infer_kind("theme-z.md"), "theme");
        assert_eq!(infer_kind("clip-a.md"), "clip");
        assert_eq!(infer_kind("conv-b.md"), "clip");
        assert_eq!(infer_kind("plain.md"), "note");
    }

    #[test]
    fn float32_roundtrip() {
        let v: Vec<f32> = vec![0.1, -0.5, 0.0, 1.0, -1.5];
        let bytes = serialize_float32(&v);
        let back = deserialize_float32(&bytes);
        assert_eq!(v, back);
    }

    #[test]
    fn cosine_of_identical_vectors_is_one() {
        let v: Vec<f32> = (0..384).map(|i| i as f32).collect();
        let n = normalize(&v).unwrap();
        let sim = cosine_norm(&n, &n);
        // Allow small float drift.
        assert!((sim - 1.0).abs() < 1e-4);
    }
}
