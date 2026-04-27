---
name: name-clusters
description: Name the unnamed Louvain communities in the user's active NeuroVault brain.
---

# Name graph clusters in NeuroVault

The user has community detection running in their NeuroVault graph view (Analytics mode). Each community is currently displayed as a number ("Cluster 3"). Your job: read each cluster's top notes and propose a 2–4 word name that captures the theme. Save the names so the graph view can display them.

## How to run

1. Call `mcp__neurovault__list_unnamed_clusters()` to fetch each cluster's id, size, top 5 notes (by PageRank), and sample wikilinks.

2. If the response has `needs_analytics: true`, the user hasn't enabled Analytics mode yet. Tell them: *"Open NeuroVault, click the Analytics toggle in the graph view (top-right of the graph), then run this again."* Stop there.

3. For each returned cluster:
   - **Skip** if `size < 5`. Small communities are usually noise (a couple of orphan notes).
   - Read the `top_titles` and `sample_links`. Identify the theme.
   - Name it in **2–4 words**. Lowercase or title case is fine; consistency over correctness.
   - Bias toward concrete nouns ("API design", "Rust migration", "biking trips") over abstract feelings ("ideas", "stuff", "things").

4. Submit the names in **one** call:
   ```
   mcp__neurovault__set_cluster_names({
     "0": "API design",
     "3": "Rust migration",
     "7": "Daily journaling",
     ...
   })
   ```
   Pass cluster ids as **strings** (JSON object keys are strings). Empty string for a value clears that cluster's name.

5. Confirm to the user: *"Named N clusters in your brain. Reload the graph view to see them."*

## Don't

- Don't propose names for clusters that already have a `name` field set — those are user-edited or previously agent-edited; leave them alone.
- Don't guess wildly when titles are too generic. If `top_titles` are things like "untitled-3.md, scratch-44.md, da-848.md" the user hasn't curated that area; skip it rather than naming it nonsense.
- Don't use the word "cluster" in the name itself — the UI already shows that context.

## Example

Input from `list_unnamed_clusters`:
```json
{
  "clusters": [
    {
      "id": 4,
      "size": 18,
      "top_titles": [
        "Async write benchmark",
        "Backend: Ingest Pipeline",
        "remember() latency",
        "BM25 rebuild debounce",
        "Embedder lazy load"
      ],
      "sample_links": ["..."]
    }
  ],
  "needs_analytics": false
}
```

Reasonable name: **"Backend performance"** or **"Ingest path"**. Either captures the theme; pick one and move on.

Output:
```
mcp__neurovault__set_cluster_names({"4": "Ingest path"})
```
