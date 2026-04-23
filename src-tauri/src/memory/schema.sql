-- Byte-identical port of SCHEMA_SQL from
-- server/neurovault_server/database.py. Any change here must be matched on
-- the Python side so both runtimes create the same shape on fresh databases.
-- Migrations live in migrations.rs; this file only runs `CREATE … IF NOT
-- EXISTS` statements so running it against an already-populated DB is a no-op.

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
    is_current  INTEGER DEFAULT 1,
    expired_at  TEXT                 -- system-time "we retracted this row"
);

-- Working memory: pinned/recent memories that always appear in context
-- Like the brain's prefrontal cortex scratchpad for active context
CREATE TABLE IF NOT EXISTS working_memory (
    engram_id  TEXT PRIMARY KEY REFERENCES engrams(id) ON DELETE CASCADE,
    pinned_at  TEXT DEFAULT (datetime('now')),
    priority   INTEGER DEFAULT 0,
    pin_type   TEXT DEFAULT 'recent'  -- recent|manual|active
);

-- Core memory blocks (Letta/MemGPT pattern): short, agent-editable
-- chunks the agent maintains as structured "working identity" — the
-- persona it's operating as, the active project, known user prefs.
-- Always loaded by session_start(); the agent updates them via
-- core_memory_append/replace/set. char_limit bounds each block so the
-- context stays predictable no matter how much the agent writes.
CREATE TABLE IF NOT EXISTS core_memory_blocks (
    label       TEXT PRIMARY KEY,
    value       TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    char_limit  INTEGER NOT NULL DEFAULT 2000,
    updated_at  TEXT DEFAULT (datetime('now'))
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
