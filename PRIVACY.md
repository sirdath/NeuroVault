# Privacy Policy

**NeuroVault is local-first. Your notes, your database, your embeddings — all stay on your machine.**

This document is a factual description of what NeuroVault 0.6 and the current
Desktop build flavors do and do not send off your computer. Direct and Mac App
Store builds have different network surfaces; those differences are explicit
below.

---

## TL;DR

| | |
|---|---|
| Analytics / telemetry | **None.** No usage pings, no feature tracking, no error reports. |
| Phone-home on startup | **None by default.** A GitHub release check happens only when you click **Check for updates** or explicitly enable launch checks in Settings. No vault content or stable install identifier is sent. |
| Crash reporting | **None in 0.6/current candidates.** If we ever add it, it will be **off by default**, opt-in per session, and have a public data schema. |
| Account / login | **None.** There is no "NeuroVault account." |
| Cloud sync | **None.** Note/engram content is ordinary Markdown; complete recovery also requires the small structured state held in SQLite. |
| Does the app talk to any network? | **Direct:** only for model/update actions you enable or trigger, plus a connected AI client's own provider traffic. **Store candidate:** no model download, updater, loopback server, or AI connection is started by the current product surface. |

If any of this is wrong for a release you're running, file an issue —
it's a bug.

---

## Where your data lives

```
~/.neurovault/
  brains.json                        # registry of vaults (plaintext JSON)
  brains/
    <brain-id>/
      brain.db                       # SQLite index — contains your text, embeddings, graph
      brain.db-wal, brain.db-shm     # SQLite write-ahead log (transient)
      vault/                         # your markdown notes (flat files)
      raw/                           # raw imports (PDFs, clips, conversations)
      consolidated/                  # compiled wiki pages
      trash/                         # soft-deleted notes
      audit.jsonl                    # local log of MCP tool calls
      todos.jsonl                    # multi-agent todo queue
```

**External-folder vaults** (Obsidian-style) live wherever you pointed
NeuroVault — the app registers the path in `brains.json` but the
folder stays where it is. Deleting an external vault removes
the registry entry + internal scratch; your folder is never touched.

Everything is stored in ordinary local files you can back up, sync with your
own tools, or delete. In Direct builds the tree is under `~/.neurovault/`;
sandboxed Store builds keep app-owned libraries inside the app container.

Markdown is canonical for note/engram content and the retrieval index can be
recreated from it. `brain.db` also contains structured records without
Markdown mirrors, including core-memory blocks, drafts, and version history.
Back up or export the whole brain if you need complete recovery.

## Where your data does NOT live

- No NeuroVault-operated cloud. There is no neurovault.app account.
- No third-party analytics (Segment, Mixpanel, Google Analytics, etc.).
- No crash reporter (Sentry, Bugsnag, Crashlytics).
- No marketing pixel in the app or installer.
- No auto-upload of your vault for "help us improve the product."

## Outbound connections

The **Direct** flavor can make network calls in these situations:

| When | To where | Why |
|---|---|---|
| First ingest or recall, if the embedding model is not cached | huggingface.co | Download `bge-small-en-v1.5` (~130 MB) for local embeddings. It is then cached under `~/.neurovault/.fastembed_cache/`. |
| First reranked recall, if the reranker is not cached | huggingface.co | Download the BGE reranker (about 1 GB). Reranking is enabled by default in the current app, can be disabled in Settings, and shares the same local model cache. |
| When you click "Check for updates," or when you explicitly enable launch checks in Settings | api.github.com | Read the latest public release tag and notes. Launch checks are off by default. GitHub receives ordinary connection metadata such as your IP address; NeuroVault sends no account, vault content, or stable install identifier. |
| You approve an available update in a build with the updater configured | the configured NeuroVault release host | Download the signed updater manifest and artifact. Tauri verifies its updater signature before installation. |
| You connect Claude Desktop (or any MCP client) and use recall/remember | Anthropic's servers (or whichever LLM host you connected) | **This is the LLM provider's network call, not NeuroVault's.** NeuroVault's MCP server runs entirely on localhost (127.0.0.1:8765). The LLM client reads the tool results locally and sends them to the LLM's API as part of your conversation. |

The packaged UI loads no remote fonts, analytics scripts, images, or style
sheets. The server is bound to `127.0.0.1:8765` (loopback) — it
refuses connections from other machines by default.

The current **Mac App Store** flavor bundles its embedding model, excludes the
reranker/updater/sidecar and external-AI connection UI, and does not start or
expose the loopback HTTP server. Shared transport/server source and some
dependencies are still statically compiled, so the precise claim is that the
Store handler surface makes them unreachable, not that every dormant module is
absent from the executable.

## Telemetry stance

We have made an explicit decision NOT to ship telemetry in 0.6 or the current candidates. This
includes:

- No `User-Agent` headers in outbound calls that identify your install
- No install counter, first-run ping, or weekly heartbeat
- No anonymized usage stats ("N vaults created, M notes saved")
- No A/B testing infrastructure

If a future release adds any of the above:
1. It will be off by default
2. It will be opt-in per session (not per install)
3. The data schema and endpoint will be published in this file BEFORE the
   release ships
4. The CHANGELOG entry will call it out in a `### Security` block

## What the MCP server logs locally

Every tool call the MCP server serves is appended to
`~/.neurovault/brains/<brain>/audit.jsonl` with: timestamp, tool name,
duration, status code, and a light result summary. This is local-only —
nothing leaves your machine. You can delete the file at any time; the
app will recreate it on the next call.

Delete the log at will: `rm ~/.neurovault/brains/*/audit.jsonl`.

## Encryption at rest

NeuroVault 0.6 does **not** encrypt the vault. The markdown files and
SQLite database are plaintext on your disk. If you store sensitive
data, use your OS's full-disk encryption (BitLocker, FileVault, LUKS).

Per-vault encryption is on the roadmap (T3.5 in the public-release
plan) — SQLCipher for the DB, keys held in the OS keychain. If/when it
ships this document will describe the threat model it covers.

## Data deletion

| You want to... | Do this |
|---|---|
| Remove a single vault | Settings → Vaults → select the remove action. Internal vaults delete their NeuroVault folder; external vaults remove only the registry entry and preserve the source folder. |
| Remove a single note | Sidebar → hover row → ×. The file moves to NeuroVault Trash and can be restored from **Privacy & Trust → Open Trash**. Permanent deletion remains an explicit filesystem action. |
| Wipe everything | Close NeuroVault, delete `~/.neurovault/`. Next launch starts fresh. |
| Export a vault before deletion | Settings → Vaults → Export → save the `.zip` somewhere. |

## Questions, issues, corrections

Public questions and corrections belong in
[NeuroVault Core issues](https://github.com/sirdath/neurovault-core/issues).

For security-specific concerns (e.g. vulnerability in the local server
binding), see [SECURITY.md](SECURITY.md).

---

*Last updated: 2026-07-21. Applies to NeuroVault 0.6 and the current Direct and Store build candidates.*
