import sqlite3
import sqlite_vec
from pathlib import Path
from loguru import logger

from neurovault_server.config import EMBEDDING_DIM

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
    kind         TEXT DEFAULT 'note',  -- note|source|quote|draft|question
    state        TEXT DEFAULT 'fresh',
    strength     REAL DEFAULT 1.0,
    access_count INTEGER DEFAULT 0,
    agent_id     TEXT,                 -- which agent wrote this (claude-code, cursor, claude-desktop, user, etc.)
    created_at   TEXT DEFAULT (datetime('now')),
    updated_at   TEXT DEFAULT (datetime('now')),
    accessed_at  TEXT DEFAULT (datetime('now'))
);

-- Drafts: ordered collections of engrams (Longform/Scrivener replacement)
CREATE TABLE IF NOT EXISTS drafts (
    id             TEXT PRIMARY KEY,
    title          TEXT NOT NULL,
    description    TEXT,
    target_words   INTEGER DEFAULT 0,
    deadline       TEXT,
    created_at     TEXT DEFAULT (datetime('now')),
    updated_at     TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS draft_sections (
    draft_id   TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    engram_id  TEXT NOT NULL REFERENCES engrams(id) ON DELETE CASCADE,
    position   INTEGER NOT NULL,
    PRIMARY KEY (draft_id, engram_id)
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

-- Variable tracker: remember every named thing in your codebase
-- Solves the "what was that variable called again?" problem that plagues AI coding
CREATE TABLE IF NOT EXISTS variables (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    scope       TEXT DEFAULT 'module',   -- module|class|function|global
    kind        TEXT DEFAULT 'variable', -- variable|constant|function|class|type|interface
    type_hint   TEXT,                    -- str, int, Dict[str, Any], etc.
    language    TEXT NOT NULL,
    description TEXT,                     -- docstring / leading comment
    first_seen  TEXT DEFAULT (datetime('now')),
    last_seen   TEXT DEFAULT (datetime('now')),
    removed_at  TEXT,                     -- set when the name disappears from every file
    UNIQUE(name, scope, language)
);

-- Rename candidates: old_name disappeared from a file and new_name appeared
-- with matching kind + type_hint in the same engram. Surfaces likely renames
-- without requiring a full AST diff.
CREATE TABLE IF NOT EXISTS variable_renames (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    old_name    TEXT NOT NULL,
    new_name    TEXT NOT NULL,
    language    TEXT NOT NULL,
    kind        TEXT,
    type_hint   TEXT,
    engram_id   TEXT REFERENCES engrams(id) ON DELETE CASCADE,
    filepath    TEXT,
    detected_at TEXT DEFAULT (datetime('now')),
    confirmed   INTEGER DEFAULT 0,
    UNIQUE(old_name, new_name, language, engram_id)
);

-- Call graph: caller→callee edges extracted from code
CREATE TABLE IF NOT EXISTS function_calls (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    caller_name  TEXT,                    -- NULL = module-level call
    callee_name  TEXT NOT NULL,
    language     TEXT NOT NULL,
    engram_id    TEXT REFERENCES engrams(id) ON DELETE CASCADE,
    filepath     TEXT,
    line_number  INTEGER,
    UNIQUE(caller_name, callee_name, filepath, line_number)
);

CREATE TABLE IF NOT EXISTS variable_references (
    variable_id TEXT NOT NULL REFERENCES variables(id) ON DELETE CASCADE,
    engram_id   TEXT NOT NULL REFERENCES engrams(id) ON DELETE CASCADE,
    filepath    TEXT,                    -- original source file path
    line_number INTEGER,
    context     TEXT,                     -- 1-line code context
    ref_type    TEXT DEFAULT 'use',      -- define|use|assign
    PRIMARY KEY (variable_id, engram_id, line_number)
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

-- Working memory: pinned/recent memories that always appear in context
-- Like the brain's prefrontal cortex scratchpad for active context
CREATE TABLE IF NOT EXISTS working_memory (
    engram_id  TEXT PRIMARY KEY REFERENCES engrams(id) ON DELETE CASCADE,
    pinned_at  TEXT DEFAULT (datetime('now')),
    priority   INTEGER DEFAULT 0,
    pin_type   TEXT DEFAULT 'recent'  -- recent|manual|active
);

-- Episodic memory: events with timestamps (separate from semantic facts)
-- "On April 5th, Sarah told me X" vs "I prefer Tauri" (semantic, no time)
CREATE TABLE IF NOT EXISTS episodic_facts (
    engram_id    TEXT PRIMARY KEY REFERENCES engrams(id) ON DELETE CASCADE,
    occurred_at  TEXT,
    event_type   TEXT DEFAULT 'event',  -- event|decision|meeting|insight
    actors       TEXT  -- JSON array of people/entities involved
);

-- Edge access tracking for synaptic pruning
-- Track how often each link is actually traversed during recall
CREATE TABLE IF NOT EXISTS edge_activity (
    from_engram TEXT NOT NULL,
    to_engram   TEXT NOT NULL,
    last_used   TEXT DEFAULT (datetime('now')),
    use_count   INTEGER DEFAULT 0,
    PRIMARY KEY (from_engram, to_engram)
);

-- Consolidation themes: clusters of related memories synthesized into wikis
CREATE TABLE IF NOT EXISTS themes (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    summary         TEXT,
    member_count    INTEGER DEFAULT 0,
    last_consolidated TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS theme_members (
    theme_id  TEXT NOT NULL REFERENCES themes(id) ON DELETE CASCADE,
    engram_id TEXT NOT NULL REFERENCES engrams(id) ON DELETE CASCADE,
    centrality REAL DEFAULT 0.5,
    PRIMARY KEY (theme_id, engram_id)
);

-- Learned query affinity — Stage 4 of self-improving retrieval.
-- When a user explicitly fetches an engram after a recall AND the engram
-- wasn't in the new top-3 when we re-run the query, that's a ranking
-- failure. We store the (query, engram) pair so the next identical query
-- gets a direct final-score boost, bypassing the ranking bug.
CREATE TABLE IF NOT EXISTS query_affinity (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    query_text      TEXT NOT NULL,
    query_embedding BLOB,                    -- cosine similarity lookup (v2)
    engram_id       TEXT NOT NULL REFERENCES engrams(id) ON DELETE CASCADE,
    hit_count       INTEGER DEFAULT 1,
    first_seen      TEXT DEFAULT (datetime('now')),
    last_seen       TEXT DEFAULT (datetime('now')),
    UNIQUE(query_text, engram_id)
);

-- Retrieval feedback loop — implicit signals for self-improving recall.
-- Every `recall()` logs its top-K results here; a subsequent explicit fetch
-- by id sets was_accessed=1. Periodic consolidation uses these signals to
-- apply bounded strength deltas to useful vs noisy memories.
CREATE TABLE IF NOT EXISTS retrieval_feedback (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    query         TEXT NOT NULL,
    engram_id     TEXT NOT NULL REFERENCES engrams(id) ON DELETE CASCADE,
    rank          INTEGER NOT NULL,
    score         REAL,
    retrieved_at  TEXT DEFAULT (datetime('now')),
    was_accessed  INTEGER DEFAULT 0,
    accessed_at   TEXT
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

-- Knowledge compilation: one row per LLM-driven recompile of a wiki page.
-- Each row stores both old + new content so reject = revert is a single
-- UPDATE, and the diff can be regenerated server-side without storing it.
-- changelog_json + sources_json are serialized lists for cheap reads.
CREATE TABLE IF NOT EXISTS compilations (
    id              TEXT PRIMARY KEY,
    topic           TEXT NOT NULL,
    wiki_engram_id  TEXT REFERENCES engrams(id) ON DELETE SET NULL,
    old_content     TEXT,
    new_content     TEXT NOT NULL,
    changelog_json  TEXT,
    sources_json    TEXT,
    model           TEXT,
    input_tokens    INTEGER DEFAULT 0,
    output_tokens   INTEGER DEFAULT 0,
    status          TEXT DEFAULT 'pending',  -- pending | approved | rejected | auto_applied
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at     TEXT,
    review_comment  TEXT                     -- optional annotation left by the reviewer on approve/reject
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
CREATE INDEX IF NOT EXISTS idx_working_priority ON working_memory(priority DESC);
CREATE INDEX IF NOT EXISTS idx_episodic_time    ON episodic_facts(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_edge_activity    ON edge_activity(last_used DESC);
CREATE INDEX IF NOT EXISTS idx_theme_members    ON theme_members(theme_id);
CREATE INDEX IF NOT EXISTS idx_engrams_kind     ON engrams(kind);
CREATE INDEX IF NOT EXISTS idx_draft_sections   ON draft_sections(draft_id, position);
CREATE INDEX IF NOT EXISTS idx_variables_name   ON variables(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_variables_lang   ON variables(language);
CREATE INDEX IF NOT EXISTS idx_var_refs_engram  ON variable_references(engram_id);
CREATE INDEX IF NOT EXISTS idx_calls_callee     ON function_calls(callee_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_calls_caller     ON function_calls(caller_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_calls_engram     ON function_calls(engram_id);
CREATE INDEX IF NOT EXISTS idx_variables_removed ON variables(removed_at);
CREATE INDEX IF NOT EXISTS idx_renames_engram   ON variable_renames(engram_id);
CREATE INDEX IF NOT EXISTS idx_feedback_engram   ON retrieval_feedback(engram_id);
CREATE INDEX IF NOT EXISTS idx_feedback_time     ON retrieval_feedback(retrieved_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_accessed ON retrieval_feedback(was_accessed);
CREATE INDEX IF NOT EXISTS idx_affinity_query   ON query_affinity(query_text COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_affinity_engram  ON query_affinity(engram_id);
CREATE INDEX IF NOT EXISTS idx_engrams_agent     ON engrams(agent_id);
CREATE INDEX IF NOT EXISTS idx_compilations_status ON compilations(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_compilations_topic  ON compilations(topic);
CREATE INDEX IF NOT EXISTS idx_compilations_wiki   ON compilations(wiki_engram_id);
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
        # Run migrations for existing DBs BEFORE the schema script
        # (schema script uses IF NOT EXISTS so it's safe alongside migrations)
        self._migrate_add_kind_column()
        self._migrate_add_removed_at()
        self._migrate_add_query_embedding()
        self._migrate_add_review_comment()
        self._migrate_add_agent_id()

        self.conn.executescript(SCHEMA_SQL)
        # Create vec virtual table if it doesn't exist
        tables = [r[0] for r in self.conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
        if "vec_chunks" not in tables:
            self.conn.execute(
                f"CREATE VIRTUAL TABLE vec_chunks USING vec0(chunk_id TEXT PRIMARY KEY, embedding float[{EMBEDDING_DIM}])"
            )

    def _migrate_add_agent_id(self) -> None:
        """Add `agent_id` column to engrams for multi-agent scoping.

        Tags every memory with which agent wrote it (claude-code, cursor,
        claude-desktop, user, etc.) so recall can filter by 'what does
        Claude Code know vs what does Cursor know?'
        """
        try:
            exists = self.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='engrams'"
            ).fetchone()
            if not exists:
                return
            cols = [r[1] for r in self.conn.execute("PRAGMA table_info(engrams)").fetchall()]
            if "agent_id" in cols:
                return
            logger.info("Migrating engrams: adding agent_id column")
            self.conn.execute("ALTER TABLE engrams ADD COLUMN agent_id TEXT")
            self.conn.commit()
        except Exception as e:
            logger.warning("agent_id migration skipped: {}", e)

    def _migrate_add_review_comment(self) -> None:
        """Add `review_comment` column to existing compilations tables.

        Lets reviewers leave an annotation on approve/reject (e.g. "rejected
        because the new page dropped the benchmark numbers").
        """
        try:
            exists = self.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='compilations'"
            ).fetchone()
            if not exists:
                return
            cols = [r[1] for r in self.conn.execute("PRAGMA table_info(compilations)").fetchall()]
            if "review_comment" in cols:
                return
            logger.info("Migrating compilations: adding review_comment column")
            self.conn.execute("ALTER TABLE compilations ADD COLUMN review_comment TEXT")
            self.conn.commit()
        except Exception as e:
            logger.warning("review_comment migration skipped: {}", e)

    def _migrate_add_query_embedding(self) -> None:
        """Add `query_embedding` column to existing query_affinity tables (Stage 4 v2)."""
        try:
            exists = self.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='query_affinity'"
            ).fetchone()
            if not exists:
                return
            cols = [r[1] for r in self.conn.execute("PRAGMA table_info(query_affinity)").fetchall()]
            if "query_embedding" in cols:
                return
            logger.info("Migrating query_affinity: adding query_embedding column")
            self.conn.execute("ALTER TABLE query_affinity ADD COLUMN query_embedding BLOB")
            self.conn.commit()
        except Exception as e:
            logger.warning("query_embedding migration skipped: {}", e)

    def _migrate_add_removed_at(self) -> None:
        """Add `removed_at` column to existing variables tables."""
        try:
            exists = self.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='variables'"
            ).fetchone()
            if not exists:
                return
            cols = [row[1] for row in self.conn.execute("PRAGMA table_info(variables)").fetchall()]
            if "removed_at" in cols:
                return
            logger.info("Migrating variables table: adding `removed_at` column")
            self.conn.execute("ALTER TABLE variables ADD COLUMN removed_at TEXT")
            self.conn.commit()
        except Exception as e:
            logger.warning("removed_at migration skipped: {}", e)

    def _migrate_add_kind_column(self) -> None:
        """Safe migration: add `kind` column to existing engrams tables."""
        try:
            # Check if engrams table exists at all
            exists = self.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='engrams'"
            ).fetchone()
            if not exists:
                return  # Fresh DB, schema script will create it with kind column

            # Check if kind column exists
            cols = [
                row[1] for row in self.conn.execute("PRAGMA table_info(engrams)").fetchall()
            ]
            if "kind" in cols:
                return  # Already migrated

            logger.info("Migrating engrams table: adding `kind` column")
            self.conn.execute("ALTER TABLE engrams ADD COLUMN kind TEXT DEFAULT 'note'")

            # Auto-classify existing rows by filename prefix
            self.conn.execute(
                "UPDATE engrams SET kind = 'source' WHERE filename LIKE 'source-%'"
            )
            self.conn.execute(
                "UPDATE engrams SET kind = 'quote' WHERE filename LIKE 'quote-%'"
            )
            self.conn.execute(
                "UPDATE engrams SET kind = 'draft' WHERE filename LIKE 'draft-%'"
            )
            self.conn.commit()
            logger.info("Migration complete: existing engrams classified by filename prefix")
        except Exception as e:
            logger.warning("Kind column migration skipped: {}", e)
        self.conn.commit()
        logger.info("Database schema initialized at {}", self.db_path)

    # --- NeuroVault CRUD ---

    def insert_engram(
        self,
        engram_id: str,
        filename: str,
        title: str,
        content: str,
        content_hash: str,
    ) -> None:
        # Use millisecond-resolution timestamps instead of the column default
        # `datetime('now')` (1-second resolution). Rapid ingests produce tied
        # timestamps at second granularity, which breaks recency sorting in
        # the retriever. strftime('%Y-%m-%d %H:%M:%f', 'now') gives ms.
        self.conn.execute(
            """INSERT INTO engrams (id, filename, title, content, content_hash,
                                    created_at, updated_at)
               VALUES (?, ?, ?, ?, ?,
                       strftime('%Y-%m-%d %H:%M:%f', 'now'),
                       strftime('%Y-%m-%d %H:%M:%f', 'now'))
               ON CONFLICT(id) DO UPDATE SET
                 title=excluded.title,
                 content=excluded.content,
                 content_hash=excluded.content_hash,
                 updated_at=strftime('%Y-%m-%d %H:%M:%f', 'now')""",
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
        # sqlite-vec vec0 virtual tables don't honor INSERT OR REPLACE, so we
        # explicitly delete any existing row for this chunk_id first.
        self.conn.execute("DELETE FROM vec_chunks WHERE chunk_id = ?", (chunk_id,))
        self.conn.execute(
            "INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)",
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
