# Graph Analytics

NeuroVault's graph view has an **Analytics mode** that overlays structural information about your brain on top of the default force-directed layout. It's opt-in — the toggle sits in the top-right of the graph view next to the 2D/3D switch — and what it shows is designed to be useful at a glance, not require any graph-theory knowledge.

This page explains what each layer does and what it's computed from. Everything runs locally on your machine. No data leaves the laptop; no API keys are required.

---

## What the layers tell you

### Bigger nodes = more referenced

When Analytics is on, node sizes shift to reflect how *important* each note is to the rest of your brain — specifically, how often it shows up at the end of a wikilink chain. The internal name for this is **PageRank**: the same algorithm Google used in 1998 to rank web pages, except your "web" is your notes and the "links" are wikilinks + extracted entities.

A note that 30 other notes wikilink to gets visibly bigger than a note nothing references. The biggest nodes are usually your *core concepts* — the ideas your brain orbits around.

The default graph (Analytics off) sizes nodes by graph degree and how often you've opened them. That's a fine first approximation; PageRank is the more honest "what matters in this network" answer once you're looking at structure rather than usage.

### Background tints = related groups

You'll see soft coloured patches in the background grouping clusters of nodes. These are **communities**: groups of notes that link to each other a lot, even if you put them in different folders.

Notes in the same cluster usually share a topic. Folders are how *you* organised your brain; clusters are how your brain *actually clusters itself* based on the wikilink structure.

The algorithm is **Louvain modularity optimisation** — it iteratively moves nodes to whichever neighbouring group makes the overall partition tighter. Single-pass, deterministic for a given graph state, ~100ms on a thousand-note brain.

### Hover tip = node's role

Hover a node when Analytics is on and the tip bar at the top updates with a one-line description:

- **Core note · 3.2× the average reference rate · in 'API design' (14 notes)** — high PageRank node in a named cluster.
- **In a cluster of 8 linked notes** — typical node, no special importance, but firmly in a community.
- **Peripheral note · few links to the rest of your brain** — low PageRank, isolated. Often a stub, an inbox capture, or a draft.

If the cluster has a name, that name shows up in single quotes. Names come from the `/name-clusters` flow described below.

### Edges by confidence (always on, not analytics)

Even with Analytics off, edges now render with thickness and saturation that reflects what the relationship actually is, not just the cosine score. A manual `[[wikilink]]` you typed reads bolder than a 0.6 cosine semantic match. Bidirectional links (A↔B both exist) get a small reciprocity bonus.

The fusion is `0.55 × similarity + 0.35 × link_kind_weight + 0.15 × reciprocity`, clamped to [0, 1]. Manual wikilinks have weight 1.0; entity-derived 0.85; structural semantic kinds 0.75; everything else 0.5. The exact numbers don't matter — what matters is the visible signal: real connections look real.

---

## Naming clusters with your existing AI session

Communities start out as numeric ("Cluster 3"). To give them human names, NeuroVault pipes the work through whatever AI session you already have running — Claude Code, Claude Desktop, Cursor, anything that speaks MCP. **No API keys needed.**

### Setup, once

Copy the skill file into your Claude Code skills directory:

```bash
cp docs/skills/name-clusters.md ~/.claude/skills/name-clusters.md
```

(Other MCP clients can do the same thing via natural prompt — the skill file is convenience, not a requirement.)

### Run it

1. Open NeuroVault, switch to graph view, click **Analytics** (top-right toggle). The graph computes Louvain communities and pushes summaries to the Rust HTTP server in-memory.
2. In your Claude Code session, type `/name-clusters`.
3. Claude calls two MCP tools — `list_unnamed_clusters` to fetch the data, then `set_cluster_names` to write back proposed names. ~5 seconds for a 250-note brain.
4. Names are saved to `~/.neurovault/brains/{brain_id}/cluster_names.json`. Reload the graph view; the tip bar now shows the names.

### Hand-editing names

`cluster_names.json` is a plain JSON file:

```json
{
  "names": {
    "0": "API design",
    "3": "Rust migration"
  }
}
```

Edit it freely. The agent's `/name-clusters` skill is set up to *not* overwrite names you've changed; it only fills in unnamed clusters by default.

### Why this shape

A previous design used an `ANTHROPIC_API_KEY` to call Claude directly from the app. That meant a second bill on top of the user's existing AI subscription, plus key management, plus environment variable friction. Routing through MCP means the work runs in whatever model + plan the user is already paying for, costs nothing extra, and keeps NeuroVault key-free.

---

## Settings

Settings → Graph has an **Analytics defaults** subsection with two toggles:

- **Resize nodes by importance** — gates PageRank node sizing.
- **Group notes by community** — gates the background tints.

Both default ON. If you want the cleanest possible Analytics view (just the hover tips, no visual layers), turn both off. The Analytics toggle still works — it's the master gate — but the layers are individually controllable.

---

## Privacy and performance

- All the math runs client-side in vanilla TypeScript. No external APIs, no telemetry, no network calls.
- PageRank is ~30 ms on a thousand-node brain; Louvain is ~100 ms; both run once per graph data change and cache by content hash.
- Toggling Analytics on/off doesn't recompute when nothing changed. Same brain state = instant.
- When Analytics is off, none of this runs at all. The default graph view is exactly identical to the pre-Analytics version.
- Cluster names are stored in plain JSON in your brain folder. Easy to back up, edit, or delete.

---

## What's next

The `/name-clusters` flow is the proof-of-concept for "your existing AI session can fix and curate your brain." Future versions will likely add:

- `/find-duplicates` — agent reviews near-duplicate notes (cosine ≥ 0.92) and proposes merges.
- `/file-inbox` — agent reads notes still in `vault/inbox/` and suggests which subfolder (concepts, decisions, etc.) they belong in.
- `/lint-frontmatter` — agent fills in missing `type` / `kind` / `created` fields.

All same shape: NeuroVault exposes data via MCP tools, the user's existing agent does the reasoning, no keys, no cost.
