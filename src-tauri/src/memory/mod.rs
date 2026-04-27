//! # neurovault_lib::memory
//!
//! The Rust replacement for the Python `neurovault_server` package.
//! Everything on NeuroVault's **hot path** — notes, graph, recall,
//! ingest, embedder, BM25 — ends up here. Advanced features
//! (compilation, PDF ingest, Zotero sync, code graph, consolidation)
//! stay in Python and are spawned on demand via `run_python_job`.
//!
//! ## Migration map
//!
//! Python module              │ Rust equivalent                  │ Phase
//! ──────────────────────────┼──────────────────────────────────┼──────
//! `config.py`                │ `paths.rs` + env reads inline    │   1
//! `database.py` (SCHEMA_SQL) │ `db.rs` + `schema.sql`           │   2
//! `database.py` (migrations) │ `migrations.rs`                  │   2
//! `embeddings.py`            │ `embedder.rs`                    │   3
//! `chunker.py`               │ `chunker.rs`                     │   3
//! `summaries.py`             │ `summaries.rs`                   │   3
//! (new read helpers)         │ `read_ops.rs`                    │   4
//! (new write helpers)        │ `write_ops.rs`                   │   5
//! `bm25_index.py`            │ `bm25.rs`                        │   5
//! `entities.py` (regex path) │ `entities.rs`                    │   5
//! `ingest.py`                │ `ingest.rs`                      │   5
//! `retriever.py`             │ `retriever.rs` + `rrf.rs`        │   6
//!                            │     + `spread.rs`                │
//! `api.py` (/api/* surface)  │ `http_server.rs` (axum)          │   6
//! `watcher.py`               │ `watcher.rs` (notify crate)      │   7
//!
//! Every file under `memory/` mirrors the Python file it replaces
//! one-to-one where possible, so future maintainers reading either
//! side can cross-reference by name.

pub mod bm25;
pub mod chunker;
pub mod db;
pub mod embedder;
pub mod entities;
pub mod http_server;
pub mod ingest;
pub mod migrations;
pub mod pagerank_state;
pub mod paths;
pub mod query_parser;
pub mod read_ops;
pub mod recall_cache;
pub mod related;
pub mod reranker;
pub mod retriever;
pub mod rrf;
pub mod spread;
pub mod sqlite_vec;
pub mod summaries;
pub mod throttle;
pub mod types;
pub mod watcher;
pub mod write_ops;

// Re-export the public primitives the rest of the codebase reaches
// for. Everything else stays behind the module boundary until its
// phase lands. Phase 2 surface: `open_brain` / `close_brain`. Phase 3
// surface: embedder, chunker, summaries. Tauri commands added in
// Phase 4 will call these; tests already do.
pub use chunker::{extract_typed_wikilinks, extract_wikilinks, hierarchical_chunk, HierChunk};
pub use db::{close_brain, engram_count, open_brain, BrainDb, EMBEDDING_DIM};
pub use paths::{brain_dir, db_path, nv_home, vault_dir};
pub use read_ops::{
    brain_from_id, brain_stats, get_graph, get_note, list_brains_with_stats, list_notes,
    resolve_brain_id, resolve_vault_path, BrainStats, BrainSummary, Connection, EntityRef,
    FullNote, NoteListRow,
};
pub use related::{get_related, get_related_checked, RelatedHit, RelatedOpts};
pub use retriever::{hybrid_retrieve, hybrid_retrieve_throttled, RecallHit, RecallOpts, THROTTLE_HINT_ID};
pub use summaries::{generate_summaries, generate_summaries_default};
pub use types::{Brain, Chunk, Engram, EngramLink, Entity, MemoryError, Result};
pub use write_ops::{create_note, delete_note, save_note, BrainContext, WriteResult};
