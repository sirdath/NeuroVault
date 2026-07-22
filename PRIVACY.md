# Privacy Policy

**NeuroVault is local-first. Your notes, your database, your embeddings — all stay on your machine.**

This document is a factual description of what NeuroVault does and does
not send off your computer. It applies to version 0.6.x and is versioned
with the code; every release that changes this policy must bump the
version number here and in the README.

---

## TL;DR

| | |
|---|---|
| Analytics / telemetry | **None.** No usage pings, no feature tracking, no error reports. |
| Phone-home on startup | **None by default.** A GitHub release check happens only when you click **Check for updates** or explicitly enable launch checks in Settings. No vault content or stable install identifier is sent. |
| Crash reporting | **None in 0.6.x.** If we ever add it, it will be **off by default**, opt-in per session, and have a public data schema. |
| Account / login | **None.** There is no "NeuroVault account." |
| Cloud sync | **None.** Note and engram content is stored as markdown you own; small structured state and history also lives in the local database. |
| Does the app talk to any network? | Only for actions you enable or request: update checks/downloads and on-demand local-model downloads listed below. Connected AI clients have their own provider data flow, also described below. |

If any of this is wrong for a release you're running, file an issue —
it's a bug.

---

## Where your data lives

```
~/.neurovault/
  brains.json                        # registry of vaults (plaintext JSON)
  api_gateway.json                   # optional gateway bind/port configuration
  api_keys.json                      # gateway key metadata + hashes (no plaintext keys)
  api_audit.jsonl                    # local external-gateway request log
  managed-backend.json               # pid + random id for an npm-started backend
  brains/
    <brain-id>/
      brain.db                       # indexes plus structured state/history
      brain.db-wal, brain.db-shm     # SQLite write-ahead log (transient)
      vault/                         # your markdown notes (flat files)
      raw/                           # raw imports (PDFs, clips, conversations)
      consolidated/                  # compiled wiki pages
      trash/                         # soft-deleted notes
      audit.jsonl                    # local log of MCP tool calls
      todos.jsonl                    # multi-agent todo queue
```

`managed-backend.json` contains no memory content. The headless npm launcher
uses its process id and random per-process identifier to ensure its `stop`
command can stop only the backend that launcher started, never the desktop app
or an unrelated process.

**External-folder vaults** (Obsidian-style) live wherever you pointed
NeuroVault — the app registers the path in `brains.json` but the
folder stays where it is. Deleting an external vault removes
the registry entry + internal scratch; your folder is never touched.

Everything in `~/.neurovault/` is stored in local files you can back up or
delete. Note and engram content is canonical Markdown, and the search index can
be rebuilt from it. The SQLite database also holds small structured records
such as core-memory blocks, drafts, and note version history.

NeuroVault has no built-in cross-device sync. Syncing Markdown vault folders
with your own file tool is reasonable, but do not live-sync or copy
`brain.db`, `brain.db-wal`, or `brain.db-shm` while any NeuroVault app or
headless backend is running. For a complete backup, explicitly quit the app,
stop an npm-managed backend, confirm the local server is down, then copy the
whole `~/.neurovault/` directory, including `brains.json`.

## Where your data does NOT live

- No NeuroVault-operated cloud. There is no neurovault.app account.
- No third-party analytics (Segment, Mixpanel, Google Analytics, etc.).
- No crash reporter (Sentry, Bugsnag, Crashlytics).
- No marketing pixel in the app or installer.
- No auto-upload of your vault for "help us improve the product."

## Outbound connections

The app will only make network calls in these exact situations:

| When | To where | Why |
|---|---|---|
| First ingest or recall, if the embedding model is not cached | huggingface.co | Download `bge-small-en-v1.5` (~130 MB) for local embeddings. It is then cached under `~/.neurovault/.fastembed_cache/`. |
| First reranked recall, if the reranker is not cached | huggingface.co | Download the BGE reranker (about 1 GB). Reranking is enabled by default in the current app, can be disabled in Settings, and shares the same local model cache. |
| When you click "Check for updates," or when you explicitly enable launch checks in Settings | api.github.com | Read the latest public release tag and notes. Launch checks are off by default. GitHub receives ordinary connection metadata such as your IP address; NeuroVault sends no account, vault content, or stable install identifier. |
| You approve an available update | github.com/sirdath/NeuroVault/releases | Download the signed updater manifest and platform artifact. Tauri verifies the updater signature before installation. |
| You connect Claude Desktop (or any MCP client) and use recall/remember | Anthropic's servers (or whichever LLM host you connected) | **This is the LLM provider's network call, not NeuroVault's.** NeuroVault's MCP server runs entirely on localhost (127.0.0.1:8765). The LLM client reads the tool results locally and sends them to the LLM's API as part of your conversation. |

The packaged UI loads no remote fonts, analytics scripts, images, or style
sheets. The server is bound to `127.0.0.1:8765` (loopback) — it
refuses connections from other machines by default.

### Optional external API gateway

The separate external API gateway is **off by default**. If you deliberately
enable it in Advanced Settings, you choose its bind address and create scoped
API keys. A loopback bind remains local to your computer. A LAN or specific-IP
bind allows authenticated clients on that network interface to read or change
the vaults permitted by the key.

The gateway currently serves **plain HTTP, not HTTPS**. On a LAN, bearer keys
and returned memory content are therefore not encrypted in transit. Do not use
LAN mode on public or untrusted Wi-Fi. Prefer loopback, or bind to a protected
private interface such as a correctly configured WireGuard or Tailscale
network. NeuroVault shows this warning before you save network exposure;
revoke a key or disable the gateway to stop access. Plaintext keys are shown
only once when created; `api_keys.json` stores a one-way hash plus label,
scope, allowlist and audit metadata.

## Telemetry stance

We have made an explicit decision NOT to ship telemetry in 0.6.x. This
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

NeuroVault 0.6.x does **not** encrypt the vault. The markdown files and
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
| Wipe everything | Explicitly **Quit** the desktop app, stop any headless backend, then delete `~/.neurovault/`. Next launch starts fresh. |
| Export portable files | Settings → Vaults → Export → save the `.zip`. This excludes the live database and therefore excludes database-only drafts, core memory, proposals, and history. |

## Questions, issues, corrections

Email: via GitHub Issues at
[github.com/sirdath/NeuroVault/issues](https://github.com/sirdath/NeuroVault/issues)

For security-specific concerns (e.g. vulnerability in the local server
binding), see [SECURITY.md](SECURITY.md).

---

*Last updated: 2026-07-22. Applies to NeuroVault 0.6.x.*
