# API Gateway (Design)

This is the architecture decision doc for NeuroVault's external API layer — the surface that lets people building their own agents (LangChain, n8n workflows, custom Python scripts, future hosted teams) point at NeuroVault as a memory backend over HTTP.

**It is a design, not an implementation.** Nothing in the repo currently does any of this. The point is to lock in the boundary before the first line of code, so the gateway ships as a true sibling to the existing infrastructure and can be ripped out cleanly if the experiment fails.

The audience is whoever picks up the implementation. Read it before writing the first line of code, and push back on anything below before code lands.

---

## Goals

1. **Expose NeuroVault's HTTP surface to authenticated external clients.** Developers building agents over HTTP get the same recall/remember/graph functionality the local Tauri app uses.
2. **Don't break anything that already works.** The existing 127.0.0.1:8765 loopback path stays bit-for-bit identical. The local Tauri sidecar, Python MCP proxy, and everything else that talks to it keeps working with zero config changes.
3. **Ripping it out has to be cheap.** If the API experiment doesn't get traction, deleting the gateway should be one PR — no archaeological excavation through entangled code.
4. **Same engine, two shells.** Eventually a headless server build (`cargo build --bin neurovault-api`) drops into a VPS or Docker for teams that don't want a desktop app at all.

## Non-goals

- **Multi-tenant SaaS.** This is a self-host architecture. Users run NeuroVault on their machine or their server; we don't host their data.
- **OAuth / SSO.** Bearer-token auth only for v1. OAuth comes back if/when there's a hosted offering.
- **Real-time collaborative editing.** Single-writer assumption inherited from the underlying brain. Two simultaneous writes from different keys race; last-write-wins.
- **Public unauthenticated endpoints.** Every external request needs a valid key. Period.

---

## Architecture: three layers

```
┌──────────────────────────────────────────────────────────┐
│  Tauri webview / Python MCP proxy / curl on localhost    │
│        ↓                                                  │
│  127.0.0.1:8765  ─────► http_server::router()            │  unchanged
│   (loopback only,            ↓                            │  zero auth
│    no auth)              handlers/*                       │
│                              ↑                            │
│  0.0.0.0:8767  ───────► api_gateway::router()            │  new
│   (configurable bind,        ↓                            │  bearer auth
│    bearer required)      auth → scope → audit             │  scopes
│        ↑                                                  │  per-key
│  external agents,                                         │
│  team members,                                            │
│  custom scripts                                           │
└──────────────────────────────────────────────────────────┘
```

Three modules, three responsibilities:

### `handlers/` (refactor target)

Every `async fn` currently in `http_server.rs` moves into a `handlers/` submodule. **Zero behaviour change** — pure relocation. The handlers don't know whether they're being called from the loopback path or the external path. They take their `Json<Body>` / `Query<Q>` / `Path<P>` extractors, do the work, return their `Json<Result>`.

The structs that handlers use (`RecallQuery`, `RememberBody`, etc.) move alongside.

Why a refactor: today handlers are intermixed with router-construction code in one 4090-line file. Both routers (internal, external) need to mount the same handlers, so they have to live somewhere both routers can import them.

### `http_server.rs` (existing — minimal change)

Keeps its `router()` function. The function body now imports handlers from `handlers/` instead of defining them inline. Bind to 127.0.0.1:8765. CORS layer stays. **No middleware additions.** This is the trust-the-machine path.

### `api_gateway.rs` (new)

Builds its own axum `Router` that mounts the same handler functions, but with a middleware stack:

```
incoming request
  → cors_layer (controlled, not Any)
  → bearer_auth_layer
  → scope_check_layer (per-route)
  → audit_log_layer
  → rate_limit_layer (no-op v1, hook for v2)
  → handler
```

Bind: configurable. Default OFF — user opts in via Settings.

### `api_keys.rs` (new)

API key data model + storage + scope checks. Self-contained. If the gateway is removed, this file gets deleted; no other code changes.

---

## API key model

### Storage

Keys live in `~/.neurovault/api_keys.json`. JSON file, not SQLite, for the same reason `mcp_tier.txt` is a flat file: the gateway can read it before opening any brain DB, and users can `cat` / `jq` it without our tooling.

Schema (JSON):

```json
{
  "version": 1,
  "keys": [
    {
      "id": "key_8c3f9a",
      "label": "n8n workflow on the Linode box",
      "hash": "blake3:abc123...",
      "scopes": ["read", "write"],
      "brain_allowlist": ["NeuroVaultBrain1", "default"],
      "created_at": "2026-05-06T12:00:00Z",
      "last_used_at": "2026-05-06T18:42:00Z",
      "use_count": 1247,
      "revoked_at": null
    }
  ]
}
```

### Key generation

- Format: `nvk_<24-byte-base64url>` (32 char total, similar to OpenAI / Stripe key prefixes).
- The `nvk_` prefix is for grep-ability (logs, leaked-credentials scanners).
- The 24-byte payload is `getrandom::getrandom` cryptographic random — NOT UUIDv4 (which leaks creation time).
- Each key has a public `id` (`key_8c3f9a` — first 6 chars of hash, used for log identification) and a private secret (the part after `nvk_`).

### Hashing

We **never store the plaintext key**. Only its `blake3` hash:

- Generation: user clicks "Create key" → backend generates the 24-byte secret → hashes with blake3 → stores hash + metadata → returns the plaintext **once** to the UI for the user to copy.
- Validation: incoming `Authorization: Bearer nvk_<secret>` → strip prefix → blake3 hash → constant-time compare against every stored hash (use `subtle::ConstantTimeEq`).
- Revocation: set `revoked_at` to a timestamp. Don't delete the row — keep it for audit trail.

Why blake3 not bcrypt/argon2: API keys have ~144 bits of entropy, far above the brute-force ceiling. Per-request KDF cost would be measurable (10-100 ms with argon2) for no real benefit. blake3 is constant-time-able and fast. Standard practice for API keys; password-style hashing is for low-entropy secrets.

### Scopes

Two axes:

**Action scope (mutually exclusive growth):**
- `read` — recall, related, list_brains, status, etc. (~25 endpoints)
- `write` — implies `read`, plus remember, delete_engrams, bulk_set_kind, links_add, etc. (~10 more)
- `admin` — implies `write`, plus brain management (create_brain, switch_brain), reindex_embeddings, optimize_disk, mcp_tier_set (~5 more)

**Brain scope (allowlist):**
- `brain_allowlist: []` (empty) → all brains
- `brain_allowlist: ["NeuroVaultBrain1"]` → just that one
- Any request with `?brain=X` where X is not in the allowlist → 403

Scope check order: action scope first, then brain scope. Both must pass.

### Per-route required scope

Each handler is annotated with its required scope at route-registration time. The gateway's scope_check_layer reads the matched route, looks up the requirement, fails with 403 if the key lacks it. We don't put this in the handler itself (the loopback handler shouldn't care).

A static map (`HashMap<&'static str, RequiredScope>`) keyed on path-and-method is the simplest implementation. Lives in `api_gateway::routes`.

---

## Auth middleware (axum + tower)

### Bearer extraction

Standard tower middleware. Reads `Authorization: Bearer <token>`. If absent or malformed → 401 with `WWW-Authenticate: Bearer realm="neurovault"` header (RFC 6750 compliant).

### Validation

1. Strip `Bearer ` prefix.
2. Verify it starts with `nvk_` (cheap fail-fast).
3. blake3 hash the rest.
4. Constant-time scan the keys file for a match. Fail closed: if file is unreadable, reject everything.
5. Check `revoked_at` is null.
6. Attach the matched key to request extensions: `req.extensions_mut().insert(AuthedKey { id, scopes, brain_allowlist })`.
7. Bump `last_used_at` + `use_count` async (don't block the request on the disk write).

### Scope check

Layered after auth. Reads the AuthedKey from request extensions, reads the route's RequiredScope from the static map, checks. 403 with structured body on miss.

### What axum gives us

axum 0.7 has `axum::middleware::from_fn` which is the simplest path — write a normal `async fn` that takes `Request<Body>` and `Next`, return the response or short-circuit. No tower service-builder boilerplate.

For the keys file load: `OnceCell<RwLock<KeyStore>>` — read on first request, refresh on file mtime change (via notify or just stat-on-each-request, the cost is negligible).

---

## Bind configuration

Three modes, configurable in Settings (writes to `~/.neurovault/api_gateway.json`):

```json
{
  "enabled": false,
  "bind": "127.0.0.1",  // or "0.0.0.0" or specific IP
  "port": 8767,
  "tls": null            // or { "cert_path": "...", "key_path": "..." }
}
```

Default: `enabled: false`. The gateway doesn't start unless the user explicitly turns it on.

When enabled with bind `0.0.0.0`, the Settings UI shows a red warning box: "Your machine is now reachable from your local network. Anyone on the network with a valid API key can read/write your brain. Don't enable this on public WiFi."

The internal loopback server is unaffected — different port, different config, different lifetime.

### TLS

v1: HTTP only. The user's expected to use the gateway over a trusted LAN, behind a reverse proxy (Caddy, Traefik, Nginx), or via Tailscale / WireGuard.

v2 (later): native TLS via `axum-server` with rustls if there's user demand. Not a v1 blocker.

---

## Endpoint surface

Of the 50+ existing handlers, three categories:

### Public (mount in gateway)

The agent-useful surface. Versioned under `/v1/` prefix.

| Method | Path | Required scope |
|---|---|---|
| GET  | /v1/recall                          | read |
| GET  | /v1/recall/chunks                   | read |
| GET  | /v1/related/:engram_id              | read |
| GET  | /v1/notes                           | read |
| GET  | /v1/notes/:engram_id                | read |
| GET  | /v1/notes/:engram_id/versions       | read |
| GET  | /v1/notes/:engram_id/versions/:v    | read |
| GET  | /v1/temporal_recall                 | read |
| GET  | /v1/contradictions                  | read |
| GET  | /v1/orphan_links                    | read |
| GET  | /v1/clutter                         | read |
| GET  | /v1/list_images                     | read |
| GET  | /v1/brains                          | read |
| GET  | /v1/brains/:id/stats                | read |
| GET  | /v1/session_start                   | read |
| GET  | /v1/status                          | read |
| GET  | /v1/changes                         | read |
| GET  | /v1/core_memory                     | read |
| GET  | /v1/core_memory/:label              | read |
| POST | /v1/notes                           | write |
| PUT  | /v1/notes                           | write |
| DELETE | /v1/notes                         | write |
| POST | /v1/engrams/delete                  | write |
| POST | /v1/engrams/bulk_set_kind           | write |
| POST | /v1/engrams/bulk_add_tag            | write |
| POST | /v1/links                           | write |
| DELETE | /v1/links                         | write |
| POST | /v1/contradictions/:id/resolve      | write |
| POST | /v1/check_duplicate                 | read  |
| POST | /v1/import_folder                   | write |
| POST | /v1/update                          | write |
| POST | /v1/optimize_disk                   | admin |
| POST | /v1/reindex_embeddings              | admin |
| POST | /v1/brains                          | admin |
| POST | /v1/brains/:id/activate             | admin |
| PUT  | /v1/core_memory/:label              | write |
| POST | /v1/core_memory/:label/append       | write |
| POST | /v1/core_memory/:label/replace      | write |

### Internal-only (do NOT mount in gateway)

UI-specific, no value to external agents:

- `/api/graph` (huge payload, UI-only)
- `/api/clusters`, `/api/clusters/names` (graph view internals)
- `/api/mcp_tier` (per-machine setting)
- `/api/compilations/*` (the compile flow has its own approval UI)
- `/api/todos/*` (was a one-off feature, low usage)

These stay at `/api/...` on the loopback router and are NEVER exposed externally.

### Versioning

`/v1/` prefix from day one. When breaking changes need to ship, a `/v2/` mounts alongside; `/v1/` keeps working through a deprecation window. Internal `/api/` is exempt — that's the loopback path and breaks freely with the desktop app's release cycle.

---

## Audit log

External requests are logged to `~/.neurovault/api_audit.jsonl` — separate from the per-brain `audit.jsonl` so external traffic is easy to triage.

One line per request:

```json
{"ts":"2026-05-06T18:42:13.443Z","key_id":"key_8c3f9a","method":"POST","path":"/v1/notes","status":201,"brain":"NeuroVaultBrain1","ip":"192.168.1.42","duration_ms":127}
```

Append-only. Rotation at 10 MB → `api_audit.1.jsonl`, `api_audit.2.jsonl`, keep last 5 files.

Settings → API Keys panel reads this to show "last used" + per-key call counts.

Failed auth attempts log too (with `key_id: null`), so a flood of bad attempts is visible.

---

## Error response shape

All gateway errors return JSON with a stable structure:

```json
{
  "error": "missing_scope",
  "message": "this key has read scope but POST /v1/notes requires write",
  "request_id": "req_a3f2c1"
}
```

`error` is a stable enum string; `message` is human-prose; `request_id` is the audit log row's correlation. Status codes:

- 400 — bad request shape (parse error, missing field)
- 401 — no/invalid bearer token
- 403 — token valid but scope/brain forbidden
- 404 — engram/brain not found
- 409 — conflict (e.g., dedupe-merged write)
- 422 — semantic error (kind not in allowlist, similarity out of range)
- 429 — rate limited (v2)
- 500 — internal
- 503 — backend unavailable (DB locked, embedder failed)

---

## CORS

Loopback router: `allow_origin(Any)` (current). Fine because loopback only.

Gateway router: `allow_origin` set per-key in a future iteration. v1: `allow_origin(Any)` is acceptable since auth is mandatory — the bearer header travels regardless of origin and the embargo is on the key, not the page. Document this clearly.

---

## Rate limiting

v1: out of scope. The gateway has a `rate_limit_layer` middleware slot but it's a no-op pass-through.

v2: per-key sliding window in memory (no Redis needed for single-machine). Default 60 req/min, configurable per key in `api_keys.json`. Returns 429 with `Retry-After`.

---

## Dependencies to add

To `src-tauri/Cargo.toml`:

```toml
blake3 = "1.5"          # key hashing
subtle = "2.5"          # constant-time eq
getrandom = "0.2"       # cryptographic random for key generation
base64 = "0.22"         # url-safe base64 for the key payload
```

`tower-http` already in tree; we'll enable the `auth` feature when the auth middleware lands. axum 0.7 covers everything else.

No new runtime deps for v1 (no rate-limit lib, no openapi gen, no jwt). Keep the surface narrow.

---

## Settings UI flow

New section: **Settings → API Access**.

Layout:

```
┌─ API Access ──────────────────────────────────────┐
│  [ ] Enable external API                          │
│      Bind: ( ) Loopback (default)                 │
│            ( ) Local network (warning)            │
│            ( ) Specific IP: [____________]        │
│      Port: [8767]                                 │
│                                                   │
│  API Keys                            [+ New key]  │
│  ─────────────────────────────────────────────    │
│  key_8c3f9a  n8n workflow                         │
│  Scopes: read, write   Brains: NeuroVaultBrain1   │
│  Last used: 2 min ago · 1,247 calls               │
│  [Revoke]                                         │
│                                                   │
│  key_b2e4d8  laptop import script                 │
│  Scopes: write   Brains: all                      │
│  Last used: never                                 │
│  [Revoke]                                         │
└───────────────────────────────────────────────────┘
```

"+ New key" → modal with: label, scope checkboxes, brain allowlist (multi-select). On submit, generate key, show plaintext **once** in a copy-block with a "I've copied this — close" button. Closing the modal is the only way to dismiss; the plaintext is never retrievable again.

Endpoints needed:
- `GET /api/api_keys` — list (loopback only, returns metadata not hashes)
- `POST /api/api_keys` — create (returns plaintext once)
- `DELETE /api/api_keys/:id` — revoke
- `GET /api/api_gateway_config` — read enabled/bind/port
- `PUT /api/api_gateway_config` — update

These live on the **internal loopback** server, NOT the gateway itself. The gateway is for data; the keys are managed locally.

---

## Phasing

Tight, reversible commits. Each ships value alone.

1. **Handler extraction** — pure relocation. `handlers/` module, every handler moves, http_server.rs imports them. Behaviour unchanged. (~1 commit, ~30 min review)
2. **`api_keys.rs` data model + storage + tests** — JSON file load/save, scope check, key generation, blake3 hash. No HTTP yet. (~2 commits)
3. **Gateway scaffold** — `api_gateway.rs` builds a Router with the auth middleware and one trivial endpoint (`GET /v1/status`). Enable via env var first, Settings later. Smoke-test with curl + a real key. (~2 commits)
4. **Mount the read endpoints** — bring across the `read` scope handlers. Verify scope checks work. (~1-2 commits)
5. **Mount write endpoints** — `write` scope. Test concurrent loopback + gateway writes don't step on each other. (~1 commit)
6. **Mount admin endpoints** — separate commit because admin is the highest blast radius. (~1 commit)
7. **Settings UI: keys panel** — generate, list, revoke. Wire the `/api/api_keys` endpoints. (~2 commits)
8. **Settings UI: gateway toggle** — enable / bind / port. Wire `/api/api_gateway_config`. (~1 commit)
9. **Audit log + rotation** — `api_audit.jsonl` writer, last-used tracking, Settings shows call counts. (~1 commit)
10. **`docs/api.md`** — public API documentation. curl examples per endpoint. (~1 commit)
11. **Headless server build** — `cargo build --bin neurovault-api` that runs just the gateway, no Tauri shell. For VPS deployment. (~1 commit)

Total: ~14 commits across 4-5 sessions. The first commit (handler extraction) is mechanical but largest in lines-changed; the rest are small.

---

## What this doc commits to

- **The internal loopback server is sacred.** No middleware additions, no auth, no bind changes. It exists to serve the local Tauri app and the local MCP proxy. If gateway work threatens this, the gateway loses.
- **Two routers, one handler set.** Both routers call the same `handlers/*` functions. The gateway adds middleware around them. Handlers don't know which router invoked them.
- **`/v1/` from day one.** No unversioned external API. Future breakage is a `/v2/` mount, not a behaviour change in `/v1/`.
- **Keys are blake3-hashed at rest.** Plaintext is shown once at creation, never recoverable.
- **Default off.** Gateway doesn't bind a port unless the user explicitly enables it. No surprise network exposure.
- **Same code, two shells.** The gateway code paths run identically inside the desktop app and inside a future headless server build.

---

## Open questions

- **Per-key rate limit defaults.** What's the right number? 60 req/min feels reasonable for an agent doing recall + remember in a loop, but tools that call recall in a `for` over 200 candidates would blow that. Start unlimited in v1, observe, set defaults in v2.
- **Brain creation via gateway.** Should `admin` scope let an external client create brains? On the desktop app the brain list is the user's mental model; an external script creating brains feels wrong. Lean toward "no" — gateway can't create brains; that's a desktop-app-only flow.
- **MCP-over-HTTP.** The MCP protocol can run over HTTP+SSE, not just stdio. If the gateway speaks MCP natively, remote agents could use it the same way the local Python proxy does. Worth exploring after v1 of REST.
- **Browser CORS for direct-from-frontend access.** A web app calling the gateway directly from JS would need a tighter CORS policy. v1: leave permissive, document the trade-off. If demand emerges, add a per-key `allowed_origins` field.
- **Tauri / Settings sync of gateway config.** The settings file `api_gateway.json` is read at server startup. Toggling enabled/disabled mid-run requires either a restart or a hot-reload mechanism. Probably restart-only for v1; the toggle UI explains "restart to apply."

---

## What this doc is NOT

- An OpenAPI spec. That's a follow-up artifact (autogenerate from axum routes once the v1 endpoints stabilise).
- A pricing or hosting plan. Self-host only; we don't run servers for users.
- A team-collaboration design. Multi-user concurrency on a single brain is a separate problem the gateway doesn't try to solve. Two keys writing to the same brain race; last-write-wins. Teams that need stronger semantics use separate brains.

It IS a contract: when the gateway ships, this is the architecture. Don't write code that assumes a different shape.
