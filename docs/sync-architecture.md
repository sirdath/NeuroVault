# Sync Architecture (Design)

This is the architecture decision doc for multi-device sync in NeuroVault. **It is a design, not an implementation.** No code in the repo currently does any of this. The point is to nail down what shape the eventual sync layer takes, before anyone builds it, so the schema additions we make today don't dig us into a corner tomorrow.

The audience is whoever picks up the sync work next. Read it before writing the first line of code.

---

## The problem

A user with NeuroVault on two machines (desktop + laptop, or laptop + phone in some future life) wants:

1. **Edits made on either machine eventually converge.** Capture on the laptop, recall on the desktop.
2. **Both machines work offline.** Plane mode shouldn't break recall.
3. **The local-first invariant holds.** Each machine's `brain.db` is a complete, self-sufficient source of truth. The sync layer is an overlay that *propagates* state, not the *home* of state.

What the user does NOT need:

- Real-time collaborative editing. NeuroVault is single-user. Two devices owned by the same person editing the same note within the same second is rare; second-granularity convergence is fine.
- Server-mediated trust. We don't run a backend service the user has to authenticate against. Whatever sync runs has to work peer-to-peer or through a transport the user already pays for (Syncthing, iCloud, Dropbox, OneDrive, a USB stick).

These constraints are what rule out the most common designs (centralised relay, web-app + cache).

---

## What's actually in a brain that needs to sync

Not all rows are equal. Categorising them by sync semantics is the single most useful exercise before picking an architecture.

### Tier 1 — Source of truth (must sync)

**Markdown files in `vault/`.** These are the actual content the user writes. Lose them and you've lost the brain. Everything else in the DB is derivable from these files plus the model.

**`engrams` rows.** The DB index over the markdown. `id`, `filename`, `title`, `content`, `content_hash`, `kind`, `tags`, `created_at`. If the markdown is the truth, this is the cache — but it carries IDs the rest of the schema joins against, so it has to match across devices.

**`engram_versions`.** The append-only history of content edits. Sync-friendly by construction: each row has a unique `(engram_id, version)` key and is never updated.

**`audit.jsonl`.** Append-only event log. Per-line, immutable, easy to merge by union.

**`core_memory_blocks`.** Small, agent-edited blocks (persona, active project). Last-write-wins is acceptable here — the agent rewrites these intentionally and the per-block `updated_at` already exists.

**`compilations`.** Wiki pages submitted for review. Immutable per `id` once written.

### Tier 2 — Derivable (don't sync, rebuild)

**`chunks`, `vec_chunks`.** Computed from engrams.content via the chunker + embedder. Re-running ingest from the markdown produces them. Syncing 90 MB of float vectors when re-deriving them costs ~15 s of CPU is the wrong trade.

**`engram_links` (semantic edges).** Cosine similarity over chunks. Same logic — recompute beats transfer.

**`entities`, `entity_mentions`.** Re-extracted from content.

**`temporal_facts`.** Extracted by `intelligence/extract_temporal_facts`. Could be regenerated, though there's an argument for syncing them — they're cheap (small text rows) and re-extraction is non-deterministic across model upgrades. Probably sync.

**`contradictions`.** Re-detected from temporal_facts.

### Tier 3 — Per-device (must NOT sync)

**`access_count`, `accessed_at` on engrams.** "I opened this note 30 times" is meaningful per device. Merging access counts across devices muddles the signal — desktop usage and phone usage are different behaviours.

**`working_memory` pins.** Active context for *this device's* current session.

**`recall_cache` rows.** Per-process cache. Already invalidated on writes; not persisted across restarts. Trivially excluded.

**`brains.json` `active` field.** "Which brain is selected on THIS machine right now." Per-device by definition.

### Tier 4 — Per-device but might want to sync (decide later)

**`mcp_tier.txt`.** User-set MCP tool tier. Probably wants to sync (it's a preference) — but lives in `~/.neurovault/`, not in the brain. Solved separately.

**Brain registry (`brains.json` minus the `active` key).** The list of brains and their metadata. Should sync — without it, opening the app on a fresh machine doesn't see the user's brains. But each brain might have a different `vault_path` per device (external drive on one, internal on the other). Sync the brain list, not the paths.

---

## Options I considered

### Option A — CRDT-everything (Yjs / Automerge)

Pros: solved theory, eventual consistency baked in, byte-level merge for text content.
Cons: NeuroVault's schema is relational. Wrapping every table in a CRDT is a parallel data model. Yjs documents map naturally to *one document at a time* — the engram content edit case — but not to "engram_links is a multiset, working_memory is a single-row state, audit.jsonl is append-only." You'd build five different CRDT shapes and connect them to SQLite via a sync hook.

Verdict: **rejected**. Massive complexity for a single-user system that doesn't need real-time merge. If we ever do collaborative editing this might come back, but not for v1.

### Option B — Filesystem sync only

Sync the `vault/*.md` files via Syncthing / iCloud / OneDrive. On each device, run `update_brain()` (already exists, item 0 of NeuroVault) to rebuild the DB from markdown after the filesystem changes.

Pros: zero NeuroVault-side code beyond what already exists. Users pick their own transport. Markdown is the source of truth, and that's true today regardless.
Cons: per-device state (access_count, working_memory) stays local — fine. But also: extracted state (temporal_facts, contradictions, audit.jsonl) won't propagate. Re-extracting on each device is non-deterministic across model upgrades and produces duplicate `temporal_facts` rows with different IDs. Each device would believe it has the canonical extraction.

Verdict: **almost right**. The fix is to sync more than just `vault/`.

### Option C — Filesystem sync of `vault/` + append-only state files

Extension of B. Sync these four things:

1. `vault/*.md` — source of truth (already file-based)
2. `audit.jsonl` — append-only by construction
3. `engram_versions/` — write `engram_versions` rows out as one file per version (or one append-only ndjson file per engram). Already content-addressed, so dedupe is by hash.
4. `temporal_facts.ndjson` — append on extraction, reconcile on read

Each device runs a reconcile pass on startup: walk the file-based state, merge into local DB, set device-local rebuild markers. The DB stops being the storage layer for these and becomes a query cache over the files.

Pros: every transport that does file sync (Syncthing, iCloud, Dropbox, USB stick, git) just works. The user does NOT need to install anything NeuroVault-specific. Markdown stays the contract.

Cons: writes need to go through a small write-through layer that updates both the DB and the file-state. That's new code.

Verdict: **recommended**. Most of the complexity is already done — markdown writes already update both `vault/` and `engrams`. Extending that pattern to the other Tier-1 tables is mechanical.

### Option D — Custom replication protocol

Each device exposes a small HTTP endpoint that serves "my changes since timestamp T". Other devices pull on a schedule, merge into local DB. Vector clocks per row.

Pros: full control. Could optimise transfer.
Cons: peer discovery is hard (no static IP). Either rely on user's existing sync transport (in which case why build a custom protocol over it) or run a central relay (breaks local-first). Vector clocks are non-trivial to implement correctly.

Verdict: **rejected for v1**. Worth revisiting if the filesystem approach hits its limits.

---

## Recommendation: file-state hybrid (Option C)

### What gets stored where

Concretely, after the sync layer ships:

| State | Storage | Sync mechanism |
|---|---|---|
| Engram content | `vault/<filename>.md` | User's filesystem sync |
| Engram metadata (kind, tags, created_at) | YAML frontmatter in the .md | Same |
| Engram versions | `vault/.versions/<engram-id>.ndjson` | Same |
| Audit log | `audit.jsonl` | Same |
| Temporal facts | `temporal_facts.ndjson` | Same |
| Compilations | `compilations/<id>.json` | Same |
| Core memory blocks | `core_memory.json` | Same |
| Brain registry | `~/.neurovault/brains.json` | Same |
| `chunks`, `vec_chunks` | local DB only | Re-derived after sync |
| `engram_links` (semantic) | local DB only | Re-derived |
| `entities`, `entity_mentions` | local DB only | Re-derived |
| `access_count`, `accessed_at` | local DB only | NEVER syncs |
| `working_memory` | local DB only | NEVER syncs |
| `mcp_tier.txt` | `~/.neurovault/mcp_tier.txt` | User's filesystem sync |

The DB becomes a *materialised view* of the filesystem. Wiping `brain.db` is recoverable — `update_brain()` rebuilds it from `vault/`.

### What changes in the codebase

1. **Move state out of the DB** for the Tier-1-non-engram tables (audit, versions, temporal_facts, compilations, core_memory). They become files. The DB still has them as a queryable cache, populated on startup from the files.

2. **Frontmatter sync.** Today `engrams.kind` and `engrams.tags` are DB-only — no representation in the markdown. Move them to YAML frontmatter so the markdown carries the metadata. The Python/Rust ingest already parses frontmatter; this just adds two more fields.

3. **Reconcile pass on startup.** Walk the filesystem state, merge into DB if the file is newer / has rows the DB doesn't. Already 80% of what `update_brain()` does for engrams; extend to the other tables.

4. **Per-device state isolation.** Add a `device_id` to `working_memory` rows and access counters. Sync layer skips them by definition.

### What it doesn't solve

- **Concurrent edit conflicts.** If you edit the same note on both machines while offline, you get two markdown files after the next sync (Syncthing's `.conflict` convention or iCloud's versioned filename). The user resolves manually. We don't try to merge.
- **Embedding model drift across devices.** If desktop is on BGE-small and laptop is on BGE-large after an upgrade, recall results diverge. `reindex_embeddings()` (item 12) is the answer — run it on each device after upgrading.
- **Vault path divergence.** Brain on desktop has `vault_path: D:/notes`, on laptop it's `~/Documents/notes`. Both point at the same Syncthing folder, but the path strings differ. The brain registry sync needs to track per-device path overrides — already a hint in the existing schema (`vault_path` is per-brain in `brains.json`).

---

## Phasing

This is enough work that it has to ship in stages. Order matters — earlier stages enable later ones.

1. **Frontmatter migration.** Move `kind` + `tags` to YAML frontmatter. New `engrams` writes set them in both places; reads prefer frontmatter. (~1 commit)
2. **Audit log to file.** Already a file (`audit.jsonl`). Wire it as the source of truth — DB has no audit table. (~1 commit)
3. **Temporal facts to file.** Extract pass writes ndjson; DB rebuilds from it. (~2 commits)
4. **Engram versions to file.** Write per-engram ndjson alongside markdown. (~2 commits)
5. **Reconcile pass on startup.** New `reconcile_from_filesystem()` that runs after `open_brain`. (~3 commits)
6. **Per-device state separation.** `device_id` on `working_memory`, `access_count`. (~2 commits)
7. **Brain registry merge.** `brains.json` merges by id, last-write-wins on metadata, per-device `vault_path` overrides. (~1 commit)
8. **Documentation + Setup wizard.** Settings panel that explains "your sync is in <folder>; recommended transports: Syncthing, iCloud Drive, OneDrive". No NeuroVault binary involvement.

Total estimate: ~15 commits across ~2-3 dedicated sessions. Most of the work is migration logic — moving state, then reconciling — not the sync mechanics themselves. The sync transport is the user's pre-existing tool.

---

## Open questions

- **Working memory across devices?** Should "I pinned this note as actively-being-worked-on on the desktop" surface on the laptop too? Soft yes — it's a session signal, not a usage counter. Differs from access_count.
- **MCP tier per device?** Same shape as working memory — probably should sync. Lite on desktop, Standard on laptop is unusual.
- **Deletion semantics across stale syncs.** If desktop deletes an engram and laptop has been offline for a month, the laptop's `update_brain()` on reconnect would re-create it from its still-present markdown. The fix is to track `tombstones` in a file the same way we track engram metadata — a `vault/.tombstones.ndjson` file with per-deletion entries. Excluded from this doc; covered when we get to phase 5.
- **Encryption.** Sync transports the user picks (Syncthing, iCloud) handle their own at-rest encryption. NeuroVault doesn't add a layer.

---

## What this doc is NOT

- A spec for a sync server. We aren't building one.
- A migration guide for users. That's a separate doc once the work ships.
- A commitment to a timeline. The sync work is parked until someone (probably future-me) picks it up.

It IS a contract that says: when sync ships, this is the architecture. Don't write code that assumes a different shape.
