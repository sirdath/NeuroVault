import sqlite3
import sqlite_vec
from pathlib import Path
from loguru import logger

from engram_server.config import EMBEDDING_DIM

SCHEMA_SQL = """
-- Core note records
CREATE TABLE IF NOT EXISTS engrams (
    id           TEXT PRIMARY KEY,
    filename     TEXT UNIQUE NOT NULL,
    title        TEXT NOT NULL,
    content      TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    summary      TEXT,
    tags         TEXT,
    state        TEXT DEFAULT 'fresh',
    strength     REAL DEFAULT 1.0,
    access_count INTEGER DEFAULT 0,
    created_at   TEXT DEFAULT (datetime('now')),
    updated_at   TEXT DEFAULT (datetime('now')),
    accessed_at  TEXT DEFAULT (datetime('now'))
);

-- Text chunks at multiple granularities
CREATE TABLE IF NOT EXISTS chunks (
    id          TEXT PRIMARY KEY,
    engram_id   TEXT NOT NULL REFERENCES engrams(id) ON DELETE CASCADE,
    content     TEXT NOT NULL,
    granularity TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    token_count INTEGER,
    UNIQUE(engram_id, granularity, chunk_index)
);

-- Extracted entities (knowledge graph nodes)
CREATE TABLE IF NOT EXISTS entities (
    id            TEXT PRIMARY KEY,
    name          TEXT UNIQUE NOT NULL,
    entity_type   TEXT NOT NULL,
    mention_count INTEGER DEFAULT 1,
    first_seen_at TEXT DEFAULT (datetime('now'))
);

-- Entity ↔ engram links
CREATE TABLE IF NOT EXISTS entity_mentions (
    entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    engram_id TEXT NOT NULL REFERENCES engrams(id) ON DELETE CASCADE,
    context   TEXT,
    salience  REAL DEFAULT 1.0,
    PRIMARY KEY (entity_id, engram_id)
);

-- Semantic similarity edges
CREATE TABLE IF NOT EXISTS engram_links (
    from_engram TEXT NOT NULL REFERENCES engrams(id) ON DELETE CASCADE,
    to_engram   TEXT NOT NULL REFERENCES engrams(id) ON DELETE CASCADE,
    similarity  REAL NOT NULL,
    link_type   TEXT DEFAULT 'semantic',
    PRIMARY KEY (from_engram, to_engram)
);

-- Memory type classification (from Hindsight's 4-network model)
-- fact: objective information (decisions, configs, specs)
-- experience: what happened (debugging sessions, meetings, events)
-- opinion: subjective views (preferences, assessments)
-- procedure: how-to knowledge (workflows, recipes, patterns)
CREATE TABLE IF NOT EXISTS memory_types (
    engram_id TEXT PRIMARY KEY REFERENCES engrams(id) ON DELETE CASCADE,
    memory_type TEXT DEFAULT 'fact',
    confidence  REAL DEFAULT 1.0
);

-- Temporal facts tracking (from Zep/Graphiti)
-- When facts became true and when they were superseded
CREATE TABLE IF NOT EXISTS temporal_facts (
    id          TEXT PRIMARY KEY,
    engram_id   TEXT NOT NULL REFERENCES engrams(id) ON DELETE CASCADE,
    fact        TEXT NOT NULL,
    valid_from  TEXT DEFAULT (datetime('now')),
    valid_until TEXT,
    superseded_by TEXT,
    is_current  INTEGER DEFAULT 1
);

-- Contradictions detected between memories (from Supermemory)
CREATE TABLE IF NOT EXISTS contradictions (
    id          TEXT PRIMARY KEY,
    engram_a    TEXT NOT NULL REFERENCES engrams(id) ON DELETE CASCADE,
    engram_b    TEXT NOT NULL REFERENCES engrams(id) ON DELETE CASCADE,
    fact_a      TEXT NOT NULL,
    fact_b      TEXT NOT NULL,
    detected_at TEXT DEFAULT (datetime('now')),
    resolved    INTEGER DEFAULT 0,
    resolution  TEXT
);

-- Indices (comprehensive — prevents full-table scans at scale)
CREATE INDEX IF NOT EXISTS idx_engrams_state    ON engrams(state);
CREATE INDEX IF NOT EXISTS idx_engrams_strength ON engrams(strength DESC);
CREATE INDEX IF NOT EXISTS idx_engrams_accessed ON engrams(accessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_engrams_filename ON engrams(filename);
CREATE INDEX IF NOT EXISTS idx_engrams_updated  ON engrams(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chunks_engram    ON chunks(engram_id);
CREATE INDEX IF NOT EXISTS idx_chunks_granularity ON chunks(engram_id, granularity);
CREATE INDEX IF NOT EXISTS idx_mentions_engram  ON entity_mentions(engram_id);
CREATE INDEX IF NOT EXISTS idx_mentions_entity  ON entity_mentions(entity_id);
CREATE INDEX IF NOT EXISTS idx_links_from       ON engram_links(from_engram);
CREATE INDEX IF NOT EXISTS idx_links_to         ON engram_links(to_engram);
CREATE INDEX IF NOT EXISTS idx_entities_name    ON entities(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_temporal_engram  ON temporal_facts(engram_id);
CREATE INDEX IF NOT EXISTS idx_temporal_current ON temporal_facts(is_current);
CREATE INDEX IF NOT EXISTS idx_contradictions_a ON contradictions(engram_a);
CREATE INDEX IF NOT EXISTS idx_contradictions_b ON contradictions(engram_b);
CREATE INDEX IF NOT EXISTS idx_memory_type      ON memory_types(memory_type);
"""


class Database:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self.conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self._load_sqlite_vec()
        self._init_schema()

    def _load_sqlite_vec(self) -> None:
        self.conn.enable_load_extension(True)
        sqlite_vec.load(self.conn)
        self.conn.enable_load_extension(False)
        logger.info("sqlite-vec loaded: {}", self.conn.execute("SELECT vec_version()").fetchone()[0])

    def _init_schema(self) -> None:
        self.conn.executescript(SCHEMA_SQL)
        # Create vec virtual table if it doesn't exist
        tables = [r[0] for r in self.conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
        if "vec_chunks" not in tables:
            self.conn.execute(
                f"CREATE VIRTUAL TABLE vec_chunks USING vec0(chunk_id TEXT PRIMARY KEY, embedding float[{EMBEDDING_DIM}])"
            )
        self.conn.commit()
        logger.info("Database schema initialized at {}", self.db_path)

    # --- Engram CRUD ---

    def insert_engram(
        self,
        engram_id: str,
        filename: str,
        title: str,
        content: str,
        content_hash: str,
    ) -> None:
        self.conn.execute(
            """INSERT INTO engrams (id, filename, title, content, content_hash)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 title=excluded.title,
                 content=excluded.content,
                 content_hash=excluded.content_hash,
                 updated_at=datetime('now')""",
            (engram_id, filename, title, content, content_hash),
        )
        self.conn.commit()

    def get_engram(self, engram_id: str) -> dict | None:
        row = self.conn.execute("SELECT * FROM engrams WHERE id = ?", (engram_id,)).fetchone()
        return dict(row) if row else None

    def get_engram_by_title(self, title: str) -> dict | None:
        row = self.conn.execute(
            "SELECT * FROM engrams WHERE title = ? COLLATE NOCASE", (title,)
        ).fetchone()
        return dict(row) if row else None

    def list_engrams(self, tag: str | None = None) -> list[dict]:
        if tag:
            rows = self.conn.execute(
                "SELECT * FROM engrams WHERE state != 'dormant' AND tags LIKE ? ORDER BY updated_at DESC",
                (f'%"{tag}"%',),
            ).fetchall()
        else:
            rows = self.conn.execute(
                "SELECT * FROM engrams WHERE state != 'dormant' ORDER BY updated_at DESC"
            ).fetchall()
        return [dict(r) for r in rows]

    def soft_delete(self, engram_id: str) -> bool:
        cur = self.conn.execute(
            "UPDATE engrams SET state = 'dormant' WHERE id = ?", (engram_id,)
        )
        self.conn.commit()
        return cur.rowcount > 0

    def bump_access(self, engram_id: str) -> None:
        self.conn.execute(
            "UPDATE engrams SET access_count = access_count + 1, accessed_at = datetime('now') WHERE id = ?",
            (engram_id,),
        )
        self.conn.commit()

    # --- Chunks & Embeddings ---

    def insert_chunk(
        self,
        chunk_id: str,
        engram_id: str,
        content: str,
        granularity: str,
        chunk_index: int,
    ) -> None:
        self.conn.execute(
            """INSERT OR REPLACE INTO chunks (id, engram_id, content, granularity, chunk_index)
               VALUES (?, ?, ?, ?, ?)""",
            (chunk_id, engram_id, content, granularity, chunk_index),
        )
        self.conn.commit()

    def insert_embedding(self, chunk_id: str, embedding: list[float]) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)",
            (chunk_id, sqlite_vec.serialize_float32(embedding)),
        )
        self.conn.commit()

    def knn_search(self, query_embedding: list[float], limit: int = 20) -> list[dict]:
        rows = self.conn.execute(
            """SELECT v.chunk_id, v.distance, c.content, c.engram_id, c.granularity,
                      e.title, e.strength, e.state, e.access_count
               FROM vec_chunks v
               JOIN chunks c ON c.id = v.chunk_id
               JOIN engrams e ON e.id = c.engram_id
               WHERE v.embedding MATCH ? AND k = ?
               ORDER BY v.distance ASC""",
            (sqlite_vec.serialize_float32(query_embedding), limit),
        ).fetchall()
        return [dict(r) for r in rows]

    def delete_engram_chunks(self, engram_id: str) -> None:
        chunk_ids = [
            r[0] for r in self.conn.execute(
                "SELECT id FROM chunks WHERE engram_id = ?", (engram_id,)
            ).fetchall()
        ]
        for cid in chunk_ids:
            self.conn.execute("DELETE FROM vec_chunks WHERE chunk_id = ?", (cid,))
        self.conn.execute("DELETE FROM chunks WHERE engram_id = ?", (engram_id,))
        self.conn.commit()

    def resolve_chunk_engrams(self, chunk_ids: list[str]) -> dict[str, str]:
        """Map chunk IDs to engram IDs in a single batch query."""
        if not chunk_ids:
            return {}
        placeholders = ",".join("?" * len(chunk_ids))
        rows = self.conn.execute(
            f"SELECT id, engram_id FROM chunks WHERE id IN ({placeholders})",
            chunk_ids,
        ).fetchall()
        return {r[0]: r[1] for r in rows}

    def get_all_doc_embeddings(self) -> list[tuple[str, list[float]]]:
        """Get all document-level embeddings for similarity computation.
        Returns list of (engram_id, embedding) tuples.
        """
        import struct
        rows = self.conn.execute(
            """SELECT c.engram_id, v.embedding
               FROM chunks c
               JOIN vec_chunks v ON v.chunk_id = c.id
               WHERE c.granularity = 'document'
               AND c.engram_id IN (SELECT id FROM engrams WHERE state != 'dormant')"""
        ).fetchall()
        results = []
        for eid, emb_bytes in rows:
            n = len(emb_bytes) // 4
            embedding = list(struct.unpack(f"{n}f", emb_bytes))
            results.append((eid, embedding))
        return results

    def close(self) -> None:
        self.conn.close()
