"""GRAPH_REPORT.md generator + path queries (inspired by Graphify).

Auto-generates a 1-page brain summary highlighting:
- God nodes: highest-degree concepts (most connected)
- Surprising connections: high-similarity links between distant clusters
- Orphan notes: notes with no connections (candidates for review)
- Suggested questions: open threads in your knowledge graph

Plus path queries: find the shortest chain of links between any two notes,
revealing how concepts in your brain relate to each other.
"""

from collections import deque
from datetime import datetime, timezone
from pathlib import Path

from loguru import logger

from engram_server.database import Database


def generate_graph_report(db: Database, vault_dir: Path) -> Path:
    """Generate GRAPH_REPORT.md — a one-page summary of the knowledge graph."""
    report_path = vault_dir / "GRAPH_REPORT.md"

    # Stats
    total_engrams = db.conn.execute(
        "SELECT COUNT(*) FROM engrams WHERE state != 'dormant'"
    ).fetchone()[0]
    total_links = db.conn.execute("SELECT COUNT(*) FROM engram_links").fetchone()[0]
    total_entities = db.conn.execute("SELECT COUNT(*) FROM entities").fetchone()[0]

    # God nodes — highest degree (most connected memories)
    god_nodes = db.conn.execute(
        """SELECT e.id, e.title, e.strength,
                  (SELECT COUNT(*) FROM engram_links WHERE from_engram = e.id) as degree
           FROM engrams e
           WHERE e.state != 'dormant'
           ORDER BY degree DESC LIMIT 10"""
    ).fetchall()

    # Surprising connections — high similarity but link_type='semantic'
    # (means our embeddings discovered them, not user wikilinks)
    surprising = db.conn.execute(
        """SELECT e1.title, e2.title, l.similarity
           FROM engram_links l
           JOIN engrams e1 ON e1.id = l.from_engram
           JOIN engrams e2 ON e2.id = l.to_engram
           WHERE l.from_engram < l.to_engram
             AND l.link_type = 'semantic'
             AND l.similarity > 0.78
             AND e1.state != 'dormant' AND e2.state != 'dormant'
           ORDER BY l.similarity DESC LIMIT 10"""
    ).fetchall()

    # Orphans — no connections at all
    orphans = db.conn.execute(
        """SELECT e.id, e.title FROM engrams e
           WHERE e.state != 'dormant'
             AND NOT EXISTS (
               SELECT 1 FROM engram_links l
               WHERE l.from_engram = e.id OR l.to_engram = e.id
             )
           ORDER BY e.updated_at DESC LIMIT 10"""
    ).fetchall()

    # Top entities (frequently mentioned concepts)
    top_entities = db.conn.execute(
        """SELECT name, entity_type, mention_count FROM entities
           ORDER BY mention_count DESC LIMIT 10"""
    ).fetchall()

    # Build the report
    updated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = [
        "# Brain Graph Report",
        "",
        f"*Auto-generated on {updated}*",
        f"*{total_engrams} memories · {total_links} connections · {total_entities} entities*",
        "",
        "## God Nodes (most connected)",
        "",
        "These are the central hubs of your knowledge graph. Memories here",
        "tie everything together. Lose them and the graph fragments.",
        "",
    ]

    if god_nodes:
        for eid, title, strength, degree in god_nodes:
            if degree > 0:
                strength_pct = int(strength * 100)
                lines.append(f"- **[[{title}]]** — {degree} connections · strength {strength_pct}%")
        lines.append("")
    else:
        lines.append("*No connected memories yet.*")
        lines.append("")

    lines.append("## Surprising Connections")
    lines.append("")
    lines.append("Our embeddings discovered these high-similarity links between")
    lines.append("memories you didn't explicitly wikilink. They might reveal")
    lines.append("patterns you haven't noticed.")
    lines.append("")

    if surprising:
        for title_a, title_b, sim in surprising:
            sim_pct = int(sim * 100)
            lines.append(f"- [[{title_a}]] ⟷ [[{title_b}]] *({sim_pct}%)*")
        lines.append("")
    else:
        lines.append("*No surprising connections yet — add more notes for the brain to find patterns.*")
        lines.append("")

    lines.append("## Orphan Notes (no connections)")
    lines.append("")
    lines.append("These notes exist in isolation. Consider linking them or")
    lines.append("explaining how they relate to your other memories.")
    lines.append("")

    if orphans:
        for _, title in orphans:
            lines.append(f"- [[{title}]]")
        lines.append("")
    else:
        lines.append("*No orphans — every memory is connected!*")
        lines.append("")

    lines.append("## Top Entities")
    lines.append("")
    lines.append("Concepts, people, and technologies most frequently mentioned across notes.")
    lines.append("")

    if top_entities:
        for name, etype, count in top_entities:
            lines.append(f"- **{name}** *({etype})* — mentioned {count}× ")
        lines.append("")

    lines.append("## Suggested Questions")
    lines.append("")
    lines.append("Open threads — concepts that appear together but you might not")
    lines.append("have connected explicitly:")
    lines.append("")

    # Suggest questions from surprising connection pairs
    if surprising:
        for title_a, title_b, _ in surprising[:3]:
            lines.append(f"- How does [[{title_a}]] relate to [[{title_b}]]?")
        lines.append("")

    # And from god nodes
    if god_nodes and len(god_nodes) >= 2:
        a, b = god_nodes[0][1], god_nodes[1][1]
        lines.append(f"- What do [[{a}]] and [[{b}]] have in common?")
        lines.append("")

    lines.append("---")
    lines.append("")
    lines.append("*Use `path(A, B)` to find the shortest connection between any two memories.*")
    lines.append("*Run `consolidate_now()` to refresh themes, prune stale links, and regenerate this report.*")

    report_path.write_text("\n".join(lines), encoding="utf-8")
    logger.info("Generated GRAPH_REPORT.md ({} god nodes, {} surprising connections)",
                len(god_nodes), len(surprising))
    return report_path


def find_path(db: Database, start_title: str, end_title: str, max_depth: int = 6) -> dict:
    """Find the shortest path between two notes via the knowledge graph.

    Uses BFS over engram_links. Returns the chain of titles + similarities.
    """
    # Resolve titles to engram IDs
    start = db.conn.execute(
        "SELECT id, title FROM engrams WHERE lower(title) = lower(?) AND state != 'dormant'",
        (start_title,),
    ).fetchone()
    end = db.conn.execute(
        "SELECT id, title FROM engrams WHERE lower(title) = lower(?) AND state != 'dormant'",
        (end_title,),
    ).fetchone()

    if not start:
        return {"error": f"Note not found: {start_title}"}
    if not end:
        return {"error": f"Note not found: {end_title}"}

    if start[0] == end[0]:
        return {
            "found": True,
            "path": [{"title": start[1], "similarity": None}],
            "length": 0,
        }

    # BFS
    visited: set[str] = {start[0]}
    queue: deque = deque([(start[0], [(start[0], start[1], None, None)])])
    iterations = 0
    max_iterations = 5000  # Safety limit

    while queue and iterations < max_iterations:
        iterations += 1
        current_id, path = queue.popleft()

        if len(path) > max_depth:
            continue

        # Get all neighbors
        rows = db.conn.execute(
            """SELECT l.to_engram, e.title, l.similarity, l.link_type
               FROM engram_links l
               JOIN engrams e ON e.id = l.to_engram
               WHERE l.from_engram = ? AND e.state != 'dormant'""",
            (current_id,),
        ).fetchall()

        for next_id, next_title, sim, link_type in rows:
            if next_id in visited:
                continue
            new_path = path + [(next_id, next_title, sim, link_type)]

            if next_id == end[0]:
                return {
                    "found": True,
                    "path": [
                        {
                            "title": title,
                            "similarity": round(s, 3) if s is not None else None,
                            "link_type": lt,
                        }
                        for _, title, s, lt in new_path
                    ],
                    "length": len(new_path) - 1,
                }

            visited.add(next_id)
            queue.append((next_id, new_path))

    return {
        "found": False,
        "message": f"No path found between '{start_title}' and '{end_title}' within {max_depth} hops",
    }
