# NeuroVault HTTP API

The external HTTP API for talking to NeuroVault from outside the desktop app — useful for agents you build yourself (LangChain, n8n, Python scripts), team scenarios, or any workflow that needs memory over HTTP.

> **You probably don't need this if you're using Claude Desktop / Claude Code.** Those already talk to NeuroVault via MCP over stdio (no HTTP, no API keys, no setup beyond the Settings → MCP panel). The HTTP API is for when MCP isn't an option.

## Quick start

1. **Enable the gateway.** Open NeuroVault → Settings → "API Gateway (External HTTP)" → toggle **Enabled** → choose a bind (Loopback for same-machine, LAN for your network) → click **Save** → restart NeuroVault.
2. **Create a key.** Same Settings panel, scroll to "API Access (External Agents)" → **+ New key** → label it, pick a scope, optionally restrict to specific brains → **Create**. Copy the plaintext shown — you won't see it again.
3. **Make a request.**
   ```bash
   curl -H "Authorization: Bearer nvk_..." \
        http://localhost:8767/v1/status
   ```

If you get `200` back with a JSON body containing `authenticated_as`, you're set up.

---

## Authentication

Every request needs an `Authorization: Bearer <key>` header. Keys look like `nvk_<43-character-base64url>`.

- **Where keys live:** `~/.neurovault/api_keys.json` on the machine running NeuroVault, hashed with blake3. The plaintext exists only in your client.
- **Lost a key:** revoke it in Settings and create a new one. The plaintext can't be recovered.
- **Compromised a key:** revoke immediately. Existing requests using it start failing with `401` on the next call.

### Failure shapes

```json
401  { "error": "missing_authorization", "message": "..." }
401  { "error": "invalid_scheme", "message": "Authorization scheme must be Bearer" }
401  { "error": "invalid_key", "message": "API key not recognised or revoked" }
403  { "error": "insufficient_scope", "message": "this key has Read scope; ..." }
403  { "error": "brain_not_allowed", "message": "this key's allowlist does not include..." }
```

A `WWW-Authenticate: Bearer realm="neurovault"` header travels with every 401 (RFC 6750).

---

## Scopes

Three tiers, higher tiers imply lower:

| Scope | What it can do |
|---|---|
| `read` | recall, list, navigate. No DB writes. |
| `write` | Read + create/update/delete engrams + edit links + bulk metadata. |
| `admin` | Write + reindex_embeddings + optimize_disk + brain creation/activation. |

Plus an optional **brain allowlist** per key. Empty (default) = all brains permitted. Non-empty = the key may only target brains whose id is in the list.

---

## Endpoints

All paths below are prefixed with the gateway base URL — `http://localhost:8767` by default. Replace `nvk_...` with your real key.

### Service

#### `GET /v1/status` — confirm auth works

```bash
curl -H "Authorization: Bearer nvk_..." http://localhost:8767/v1/status
```

```json
{
  "service": "neurovault-api-gateway",
  "version": "0.1.8",
  "authenticated_as": {
    "key_id": "key_8c3f9a",
    "scope": "read",
    "brain_allowlist": ["NeuroVaultBrain1"]
  }
}
```

Required scope: `read`.

---

### Recall

#### `GET /v1/recall` — hybrid retrieval

The main read endpoint. Semantic + BM25 + entity graph, fused via RRF.

```bash
curl -H "Authorization: Bearer nvk_..." \
  "http://localhost:8767/v1/recall?q=embedding+choice&top_k=5&brain=default&mode=preview"
```

**Query params:**

| Param | Default | Notes |
|---|---|---|
| `q` | required | The search query. Supports operators inside the string: `kind:insight`, `folder:projects`, `after:2026-04-01`, `entity:claude`. |
| `top_k` | 8 | Number of hits to return. Cap depends on `mode`. |
| `brain` | active | Brain to query. Subject to your key's allowlist. |
| `mode` | preview | `titles` (~20 tok/hit), `preview` (~100 tok/hit), `full` (~400 tok/hit). |
| `spread_hops` | 0 | Graph spread — adds 1-hop neighbours of high-rank engrams to the result set. 0 = pure retrieval. |
| `rerank` | on | Cross-encoder rerank of the top-20 candidates, on by default (pass `rerank=false` to skip, or disable globally in Settings / `~/.neurovault/rerank.txt`). Adds ~50-100 ms. |

**Response:** array of `{ engram_id, title, content, score, strength, state }`.

#### `GET /v1/recall/chunks` — passage-level recall

Returns specific paragraphs (~30-150 chars each) instead of full engrams. Use when you want exact textual provenance.

```bash
curl -H "Authorization: Bearer nvk_..." \
  "http://localhost:8767/v1/recall/chunks?q=mistakes+in+ingest&limit=10&brain=default"
```

#### `GET /v1/recall_across_brains` — federated query

Same query against multiple brains; results merged with brain id annotated.

#### `GET /v1/related/:engram_id` — graph navigation

```bash
curl -H "Authorization: Bearer nvk_..." \
  "http://localhost:8767/v1/related/abc123-...?limit=10&brain=default"
```

50-100× cheaper than another `recall` call when you've already picked a hit and want to explore its neighbourhood.

#### `GET /v1/temporal_recall` — time-travel queries

Bitemporal query against the `temporal_facts` table.

```bash
# What did I believe about postgres on 2026-03-15?
curl -H "Authorization: Bearer nvk_..." \
  "http://localhost:8767/v1/temporal_recall?query=postgres&as_of=2026-03-15&brain=default"
```

Pass `include_superseded=true` for the full audit trail (current + superseded + retracted).

---

### Notes

#### `GET /v1/notes` — sidebar list

```bash
curl -H "Authorization: Bearer nvk_..." \
  "http://localhost:8767/v1/notes?brain=default"
```

Returns `[{ id, filename, title, state, strength, access_count, updated_at }, ...]`.

#### `GET /v1/notes/:engram_id` — single note + connections

#### `POST /v1/notes` — write a memory (dedupe-aware)

```bash
curl -X POST -H "Authorization: Bearer nvk_..." \
     -H "Content-Type: application/json" \
     -d '{
       "content": "# Decision\n\nPicked Postgres for the auth service.",
       "brain": "default",
       "deduplicate": 0.92,
       "folder": "decisions"
     }' \
     http://localhost:8767/v1/notes
```

`deduplicate` (0.0-1.0) runs cosine-similarity against existing engrams. On near-match, the existing id is returned with `status: "merged"` and no new note is created. **Almost always pass `0.92`** — it prevents the "same insight saved five times" failure mode.

**Response:** `{ status, engram_id, similarity? }` where `status` is `created | updated | unchanged | merged`.

Required scope: `write`.

#### `PUT /v1/notes` — update by filename

#### `DELETE /v1/notes` — soft delete by filename

The markdown file moves to `vault/trash/`. The engram row stays with `state: 'dormant'`. To purge dormants permanently, use `optimize_disk` with `purge_dormant: true`.

#### `POST /v1/check_duplicate` — dedupe probe

```bash
curl -X POST -H "Authorization: Bearer nvk_..." \
     -H "Content-Type: application/json" \
     -d '{"content": "...", "threshold": 0.85, "brain": "default"}' \
     http://localhost:8767/v1/check_duplicate
```

Returns the matching engram_id + similarity if any, without writing. POST with read scope.

#### `GET /v1/notes/:engram_id/versions` — edit history

#### `GET /v1/notes/:engram_id/versions/:version` — fetch a specific past version

---

### Engram management

#### `POST /v1/engrams/delete` — bulk soft-delete

```bash
curl -X POST -H "Authorization: Bearer nvk_..." \
     -H "Content-Type: application/json" \
     -d '{"engram_ids":["abc...","def..."], "brain":"default"}' \
     http://localhost:8767/v1/engrams/delete
```

#### `POST /v1/engrams/bulk_set_kind` — reclassify many at once

`kind` is one of `note | source | quote | draft | question | decision | observation | insight`.

#### `POST /v1/engrams/bulk_add_tag` — tag many at once

Tag normalises: lowercased, trimmed, leading `#` stripped.

---

### Graph / links

#### `POST /v1/links` — assert a manual link

```bash
curl -X POST -H "Authorization: Bearer nvk_..." \
     -H "Content-Type: application/json" \
     -d '{
       "from_engram":"abc...",
       "to_engram":"def...",
       "link_type":"manual",
       "bidirectional":true
     }' \
     http://localhost:8767/v1/links
```

`link_type` is free-form; useful values: `manual`, `uses`, `extends`, `depends_on`, `supersedes`, `contradicts`.

#### `DELETE /v1/links` — remove a link

#### `GET /v1/orphan_links` — semantic edges missing manual confirmation

Surfaces high-similarity pairs that the system thinks are related but the user has never explicitly wikilinked. Useful for "what should I connect" workflows.

---

### Audit & curation

#### `GET /v1/contradictions` — fact-level conflicts

#### `POST /v1/contradictions/:id/resolve` — mark a contradiction reviewed

#### `GET /v1/clutter` — surface engrams that look like noise

Categorised: stubs, test_data, forgotten_observations, duplicate_titles. Read-only — actual deletes go through `/v1/engrams/delete`.

---

### Brain management

#### `GET /v1/brains` — list every brain + active marker

#### `GET /v1/brains/:id/stats` — disk + note counts for one brain

#### `POST /v1/brains` — create a new brain (admin)

#### `POST /v1/brains/:id/activate` — switch the active brain (admin)

---

### Maintenance

#### `POST /v1/update` — re-scan the vault, refresh the index

#### `POST /v1/import_folder` — bulk-ingest a folder of markdown

```bash
curl -X POST -H "Authorization: Bearer nvk_..." \
     -H "Content-Type: application/json" \
     -d '{"path":"/Users/me/Documents/obsidian", "brain":"default"}' \
     http://localhost:8767/v1/import_folder
```

#### `POST /v1/optimize_disk` — VACUUM + WAL truncate (admin)

```bash
curl -X POST -H "Authorization: Bearer nvk_..." \
     -H "Content-Type: application/json" \
     -d '{"brain":"default", "vacuum":true, "wal_checkpoint":true, "purge_dormant":false}' \
     http://localhost:8767/v1/optimize_disk
```

#### `POST /v1/reindex_embeddings` — re-embed every engram (admin)

For after an embedding-model upgrade. Pass `dry_run: true` first to size the work.

---

### Session

#### `GET /v1/session_start` — load active brain + recent activity + core memory

What an agent calls once at the top of a conversation to bootstrap context. Equivalent to the `session_start` MCP tool.

#### `GET /v1/changes` — recent activity feed

#### `GET /v1/list_images` — find images for caption-at-ingest workflow

---

### Core memory

The agent-editable persistent context block (Letta/MemGPT pattern).

#### `GET /v1/core_memory` — list all blocks
#### `GET /v1/core_memory/:label` — read one
#### `PUT /v1/core_memory/:label` — overwrite
#### `POST /v1/core_memory/:label/append` — append a line
#### `POST /v1/core_memory/:label/replace` — find-and-replace inside

---

## Examples

### Python: agent that recalls + writes

```python
import requests

BASE = "http://localhost:8767/v1"
AUTH = {"Authorization": "Bearer nvk_..."}

def recall(q, brain="default", k=5):
    r = requests.get(f"{BASE}/recall", headers=AUTH,
                     params={"q": q, "top_k": k, "brain": brain, "mode": "preview"})
    r.raise_for_status()
    return r.json()

def remember(content, brain="default"):
    r = requests.post(f"{BASE}/notes", headers=AUTH,
                      json={"content": content, "brain": brain, "deduplicate": 0.92})
    r.raise_for_status()
    return r.json()

# Use:
hits = recall("auth service decision")
for h in hits:
    print(h["title"], "—", h["score"])

remember("# Decision\nWent with JWT-in-cookie for the SSR path.")
```

### Bash: import an Obsidian vault overnight

```bash
KEY=nvk_...
BASE=http://localhost:8767/v1
curl -s -X POST -H "Authorization: Bearer $KEY" \
     -H "Content-Type: application/json" \
     -d "{\"path\":\"$HOME/Documents/Obsidian/MyVault\",\"brain\":\"default\"}" \
     "$BASE/import_folder" | jq .
```

---

## Versioning

The HTTP surface is stable under the `/v1/` prefix. When breaking changes ship, a `/v2/` mounts alongside; `/v1/` keeps working through a deprecation window.

The internal `/api/...` paths used by the desktop app are **not stable** — they change with every release. Don't point external clients at `/api/...` even if it's reachable on loopback.

---

## Audit log

Every gateway request lands as one ndjson line in `~/.neurovault/api_audit.jsonl`:

```json
{"ts":"2026-05-06T18:42:13.443Z","key_id":"key_8c3f9a","method":"POST","path":"/v1/notes","status":201,"brain":"default","ip":null,"duration_ms":127}
```

Failed auth attempts log too with `key_id: null`. The file rotates at 10 MB → `api_audit.1.jsonl` through `api_audit.5.jsonl`; older slots get dropped.

The Settings → API Access panel surfaces aggregate per-key stats (last used, total calls); detailed inspection lives in the audit file.

---

## Limits & tradeoffs

- **No TLS in v1.** Use a reverse proxy (Caddy, Nginx, Traefik) or a VPN tunnel (Tailscale, WireGuard) for production. The gateway speaks HTTP only.
- **No rate limiting in v1.** Hook is wired but unenforced. Future: per-key sliding window, defaults around 60 req/min.
- **Single-writer DB.** Two clients writing concurrently to the same brain race; last-write-wins. If you need strong consistency for a team, give each member their own brain.
- **No real-time subscription.** GET endpoints are point-in-time. Polling `/v1/changes` is the v1 substitute.

---

## Headless deployment

If you don't need the desktop app at all (e.g., running NeuroVault on a VPS as a memory backend for a hosted agent), use the `neurovault-api` binary instead. Same code, no Tauri shell:

```bash
cargo build --bin neurovault-api --release
./target/release/neurovault-api --mint-key "ops"  # creates a key, prints once
./target/release/neurovault-api                   # starts the gateway only
```

The headless binary reads the same `~/.neurovault/api_gateway.json` config, the same `api_keys.json`, the same brain DBs. Behind a reverse proxy you've got a multi-user memory backend.
