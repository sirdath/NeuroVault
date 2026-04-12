"""Memory consolidation — the brain's sleep cycle.

Inspired by hippocampal consolidation: during sleep, biological brains:
1. Cluster similar memories into themes
2. Move important memories from short-term to long-term storage
3. Strengthen co-activated synapses
4. Prune unused connections

This module does the same for NeuroVault. Runs on a schedule
(default: every 4 hours) in a background thread.
"""

import uuid
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from loguru import logger

from engram_server.database import Database
from engram_server.embeddings import Embedder


# Configuration
CLUSTER_THRESHOLD = 0.72  # Cosine similarity for theme membership
MIN_THEME_SIZE = 3        # Minimum memories to form a theme
PRUNE_AFTER_DAYS = 30     # Prune edges unused for this long
WORKING_MEMORY_SIZE = 7   # Miller's magic number — 7 ± 2 items
SPREADING_BOOST = 0.1     # How much access to credit to neighbors


def consolidate(db: Database, embedder: Embedder, consolidated_dir: Path) -> dict:
    """Run a full consolidation cycle.

    Returns stats about what was consolidated/pruned/strengthened.
    """
    stats = {
        "themes_created": 0,
        "themes_updated": 0,
        "edges_pruned": 0,
        "working_memory_refreshed": 0,
        "co_activations_strengthened": 0,
    }

    logger.info("=== Starting consolidation cycle ===")

    # 1. Cluster memories into themes
    new_themes = _cluster_into_themes(db, embedder, consolidated_dir)
    stats["themes_created"] = new_themes

    # 2. Refresh working memory (recent + frequently accessed)
    refreshed = _refresh_working_memory(db)
    stats["working_memory_refreshed"] = refreshed

    # 3. Strengthen co-activated link pairs
    strengthened = _strengthen_co_activated(db)
    stats["co_activations_strengthened"] = strengthened

    # 4. Prune stale unused edges
    pruned = _prune_stale_edges(db)
    stats["edges_pruned"] = pruned

    logger.info("Consolidation complete: {}", stats)
    return stats


# ============================================================
# 1. THEME CLUSTERING
# ============================================================

def _cluster_into_themes(db: Database, embedder: Embedder, consolidated_dir: Path) -> int:
    """Group similar memories into themes via density-based clustering.

    Uses a simple threshold-based approach: if a memory has 3+ neighbors
    above the similarity threshold, those form a theme.
    """
    doc_embeddings = db.get_all_doc_embeddings()
    if len(doc_embeddings) < MIN_THEME_SIZE:
        return 0

    ids = [eid for eid, _ in doc_embeddings]
    embeddings = np.array([emb for _, emb in doc_embeddings], dtype=np.float32)

    # Normalize for cosine similarity
    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    normalized = embeddings / norms

    # Pairwise similarity matrix
    sim_matrix = normalized @ normalized.T

    # Find clusters: each row's "neighbors" are columns above threshold
    visited: set[int] = set()
    themes_created = 0

    for i in range(len(ids)):
        if i in visited:
            continue

        # Find all memories similar to this one
        neighbor_indices = np.where(sim_matrix[i] >= CLUSTER_THRESHOLD)[0]
        cluster = [int(j) for j in neighbor_indices if j not in visited]

        if len(cluster) < MIN_THEME_SIZE:
            visited.add(i)
            continue

        for j in cluster:
            visited.add(j)

        # Build a theme from this cluster
        member_ids = [ids[j] for j in cluster]
        theme_name = _generate_theme_name(db, member_ids)
        theme_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, theme_name.lower()))

        # Centrality = similarity to cluster centroid
        cluster_centroid = normalized[cluster].mean(axis=0)
        centroid_norm = np.linalg.norm(cluster_centroid)
        if centroid_norm > 0:
            cluster_centroid /= centroid_norm
        centralities = (normalized[cluster] @ cluster_centroid).tolist()

        # Upsert theme
        db.conn.execute(
            """INSERT INTO themes (id, name, summary, member_count, last_consolidated)
               VALUES (?, ?, ?, ?, datetime('now'))
               ON CONFLICT(id) DO UPDATE SET
                 member_count = excluded.member_count,
                 last_consolidated = datetime('now')""",
            (theme_id, theme_name, "", len(member_ids)),
        )

        # Replace members
        db.conn.execute("DELETE FROM theme_members WHERE theme_id = ?", (theme_id,))
        for j_idx, eid in enumerate(member_ids):
            db.conn.execute(
                """INSERT OR IGNORE INTO theme_members (theme_id, engram_id, centrality)
                   VALUES (?, ?, ?)""",
                (theme_id, eid, float(centralities[j_idx])),
            )

        # Write a synthesis note to consolidated/themes/
        _write_theme_synthesis(consolidated_dir, theme_id, theme_name, db, member_ids)
        themes_created += 1

    db.conn.commit()
    logger.info("Created/updated {} themes", themes_created)
    return themes_created


def _generate_theme_name(db: Database, member_ids: list[str]) -> str:
    """Pick a representative theme name from cluster members."""
    titles = []
    for eid in member_ids[:5]:
        row = db.conn.execute("SELECT title FROM engrams WHERE id = ?", (eid,)).fetchone()
        if row:
            titles.append(row[0])

    if not titles:
        return "Untitled Theme"

    # Find common words across titles
    word_counts: dict[str, int] = {}
    for title in titles:
        for word in title.lower().split():
            if len(word) > 3 and word not in {"the", "and", "for", "with", "from"}:
                word_counts[word] = word_counts.get(word, 0) + 1

    # Most common 1-2 words form the theme name
    common = sorted(word_counts.items(), key=lambda x: -x[1])[:2]
    if common and common[0][1] >= 2:
        return " ".join(w.title() for w, _ in common)

    # Fallback: shortest title
    return min(titles, key=len)


def _write_theme_synthesis(
    consolidated_dir: Path, theme_id: str, name: str, db: Database, member_ids: list[str]
) -> None:
    """Write a synthesized wiki page for a theme to consolidated/themes/."""
    themes_dir = consolidated_dir / "themes"
    themes_dir.mkdir(parents=True, exist_ok=True)

    safe_name = "".join(c if c.isalnum() or c in "-_" else "-" for c in name.lower())
    filepath = themes_dir / f"theme-{safe_name}-{theme_id[:8]}.md"

    lines = [
        f"# Theme: {name}",
        "",
        f"*Auto-consolidated {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}*",
        f"*{len(member_ids)} member memories*",
        "",
        "## Members",
        "",
    ]
    for eid in member_ids:
        engram = db.get_engram(eid)
        if engram:
            preview = engram["content"][:200].replace("\n", " ").strip()
            lines.append(f"### [[{engram['title']}]]")
            lines.append(f"{preview}...")
            lines.append("")

    filepath.write_text("\n".join(lines), encoding="utf-8")


# ============================================================
# 2. WORKING MEMORY REFRESH
# ============================================================

def _refresh_working_memory(db: Database) -> int:
    """Update working memory with the most-relevant currently-active memories.

    Working memory = top N memories by (recent access + high strength).
    These are always loaded into Claude's context.
    """
    # Clear non-pinned items
    db.conn.execute("DELETE FROM working_memory WHERE pin_type != 'manual'")

    # Find top candidates: recently accessed AND high strength
    candidates = db.conn.execute(
        """SELECT id, access_count, strength, accessed_at
           FROM engrams
           WHERE state IN ('fresh', 'active', 'connected')
           ORDER BY (access_count * strength) DESC
           LIMIT ?""",
        (WORKING_MEMORY_SIZE,),
    ).fetchall()

    for i, (eid, access_count, strength, _) in enumerate(candidates):
        priority = 100 - i  # Top result gets highest priority
        db.conn.execute(
            """INSERT OR REPLACE INTO working_memory (engram_id, priority, pin_type)
               VALUES (?, ?, 'recent')""",
            (eid, priority),
        )

    db.conn.commit()
    return len(candidates)


# ============================================================
# 3. CO-ACTIVATION STRENGTHENING
# ============================================================

def _strengthen_co_activated(db: Database) -> int:
    """Find pairs that were retrieved together recently and strengthen their links.

    "Neurons that fire together, wire together" — Hebbian learning.
    """
    # Find pairs that have both been accessed in the last day
    co_active = db.conn.execute(
        """SELECT a.id, b.id
           FROM engrams a, engrams b
           WHERE a.id < b.id
             AND a.state != 'dormant' AND b.state != 'dormant'
             AND a.access_count > 0 AND b.access_count > 0
             AND julianday('now') - julianday(a.accessed_at) < 1
             AND julianday('now') - julianday(b.accessed_at) < 1
           LIMIT 100"""
    ).fetchall()

    strengthened = 0
    for a_id, b_id in co_active:
        # Check if a link exists
        existing = db.conn.execute(
            """SELECT similarity FROM engram_links
               WHERE from_engram = ? AND to_engram = ?""",
            (a_id, b_id),
        ).fetchone()

        if existing:
            # Strengthen by 5% (capped at 1.0)
            new_sim = min(1.0, existing[0] + 0.05)
            db.conn.execute(
                """UPDATE engram_links
                   SET similarity = ?
                   WHERE from_engram = ? AND to_engram = ?""",
                (new_sim, a_id, b_id),
            )
            db.conn.execute(
                """UPDATE engram_links
                   SET similarity = ?
                   WHERE from_engram = ? AND to_engram = ?""",
                (new_sim, b_id, a_id),
            )
            strengthened += 1

    db.conn.commit()
    return strengthened


# ============================================================
# 4. SYNAPTIC PRUNING
# ============================================================

def _prune_stale_edges(db: Database) -> int:
    """Delete edges that haven't been traversed in PRUNE_AFTER_DAYS.

    Only prunes 'semantic' links (computed). Manual wikilinks and
    entity links are preserved.
    """
    # Find edges with no recent activity in edge_activity table
    # OR edges with similarity below 0.55 that have never been used
    stale = db.conn.execute(
        """SELECT l.from_engram, l.to_engram
           FROM engram_links l
           LEFT JOIN edge_activity a
             ON a.from_engram = l.from_engram AND a.to_engram = l.to_engram
           WHERE l.link_type = 'semantic'
             AND l.similarity < 0.55
             AND (a.last_used IS NULL OR julianday('now') - julianday(a.last_used) > ?)
           LIMIT 200""",
        (PRUNE_AFTER_DAYS,),
    ).fetchall()

    pruned = 0
    for from_id, to_id in stale:
        db.conn.execute(
            """DELETE FROM engram_links
               WHERE from_engram = ? AND to_engram = ? AND link_type = 'semantic'""",
            (from_id, to_id),
        )
        pruned += 1

    db.conn.commit()
    return pruned


# ============================================================
# SPREADING ACTIVATION (called from recall)
# ============================================================

def spread_activation(db: Database, accessed_engram_ids: list[str], boost: float = SPREADING_BOOST) -> None:
    """When memories are retrieved, partially activate their neighbors.

    Mimics how recalling one concept makes related concepts easier to recall.
    Updates edge_activity table to track which links are being used.
    """
    if not accessed_engram_ids:
        return

    placeholders = ",".join("?" * len(accessed_engram_ids))
    neighbors = db.conn.execute(
        f"""SELECT DISTINCT l.from_engram, l.to_engram
           FROM engram_links l
           WHERE l.from_engram IN ({placeholders})
           AND l.similarity > 0.5""",
        accessed_engram_ids,
    ).fetchall()

    for from_id, to_id in neighbors:
        # Track edge usage
        db.conn.execute(
            """INSERT INTO edge_activity (from_engram, to_engram, use_count)
               VALUES (?, ?, 1)
               ON CONFLICT(from_engram, to_engram) DO UPDATE SET
                 last_used = datetime('now'),
                 use_count = use_count + 1""",
            (from_id, to_id),
        )

        # Partial credit on the neighbor's access count
        db.conn.execute(
            """UPDATE engrams
               SET strength = MIN(1.0, strength + ?)
               WHERE id = ?""",
            (boost, to_id),
        )

    db.conn.commit()


# ============================================================
# WORKING MEMORY ACCESS
# ============================================================

def get_working_memory(db: Database, limit: int = WORKING_MEMORY_SIZE) -> list[dict]:
    """Get the current working memory contents (always-in-context memories)."""
    rows = db.conn.execute(
        """SELECT e.id, e.title, e.content, e.strength, w.priority, w.pin_type
           FROM working_memory w
           JOIN engrams e ON e.id = w.engram_id
           WHERE e.state != 'dormant'
           ORDER BY w.priority DESC LIMIT ?""",
        (limit,),
    ).fetchall()
    return [
        {
            "engram_id": r[0],
            "title": r[1],
            "preview": r[2][:200],
            "strength": r[3],
            "priority": r[4],
            "pin_type": r[5],
        }
        for r in rows
    ]


def pin_to_working_memory(db: Database, engram_id: str) -> bool:
    """Manually pin a memory to working memory (always in context)."""
    db.conn.execute(
        """INSERT OR REPLACE INTO working_memory (engram_id, priority, pin_type)
           VALUES (?, 1000, 'manual')""",
        (engram_id,),
    )
    db.conn.commit()
    return True


def unpin_from_working_memory(db: Database, engram_id: str) -> bool:
    """Remove a memory from working memory."""
    cur = db.conn.execute("DELETE FROM working_memory WHERE engram_id = ?", (engram_id,))
    db.conn.commit()
    return cur.rowcount > 0


# ============================================================
# CONSOLIDATION SCHEDULER (background sleep cycle)
# ============================================================

class ConsolidationScheduler:
    """Runs the consolidation pipeline periodically in a background thread.

    Mimics biological sleep cycles: brain runs maintenance every few hours.
    """

    def __init__(
        self,
        db: Database,
        embedder: Embedder,
        consolidated_dir: Path,
        interval_seconds: float = 14400,  # 4 hours
    ) -> None:
        import threading
        self.db = db
        self.embedder = embedder
        self.consolidated_dir = consolidated_dir
        self.interval = interval_seconds
        self._timer: threading.Timer | None = None
        self._running = False

    def start(self) -> None:
        """Start the periodic consolidation. Skips initial run to avoid blocking startup."""
        self._running = True
        self._schedule_next()
        logger.info("Consolidation scheduler started (interval: {}s)", self.interval)

    def _schedule_next(self) -> None:
        import threading
        if not self._running:
            return
        self._timer = threading.Timer(self.interval, self._tick)
        self._timer.daemon = True
        self._timer.start()

    def _tick(self) -> None:
        if not self._running:
            return
        try:
            consolidate(self.db, self.embedder, self.consolidated_dir)
        except Exception as e:
            logger.error("Consolidation cycle failed: {}", e)
        self._schedule_next()

    def stop(self) -> None:
        self._running = False
        if self._timer:
            self._timer.cancel()
