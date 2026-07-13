# Privacy Policy

**NeuroVault is local-first. Your notes, your database, your embeddings — all stay on your machine.**

This document is a factual description of what NeuroVault does and does
not send off your computer. It applies to version 0.5.x and is versioned
with the code; every release that changes this policy must bump the
version number here and in the README.

---

## TL;DR

| | |
|---|---|
| Analytics / telemetry | **None.** No usage pings, no feature tracking, no error reports. |
| Phone-home on startup | **None by default.** A GitHub release check happens only when you click **Check for updates** or explicitly enable launch checks in Settings. No vault content or stable install identifier is sent. |
| Crash reporting | **None in 0.5.x.** If we ever add it, it will be **off by default**, opt-in per session, and have a public data schema. |
| Account / login | **None.** There is no "NeuroVault account." |
| Cloud sync | **None.** Your vault is a folder of markdown files you own. |
| Does the app talk to any network? | Only for actions you enable or request: update checks/downloads and on-demand local-model downloads listed below. Connected AI clients have their own provider data flow, also described below. |

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

Everything in `~/.neurovault/` is plain files you can back up, sync
via your own tools (rsync, git, Syncthing, Dropbox), or delete. The
SQLite DB can be rebuilt from the markdown files at any time.

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

## Telemetry stance

We have made an explicit decision NOT to ship telemetry in 0.5.x. This
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

NeuroVault 0.5.x does **not** encrypt the vault. The markdown files and
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

Email: via GitHub Issues at
[github.com/sirdath/NeuroVault/issues](https://github.com/sirdath/NeuroVault/issues)

For security-specific concerns (e.g. vulnerability in the local server
binding), see [SECURITY.md](SECURITY.md).

---

*Last updated: 2026-07-13. Applies to NeuroVault 0.5.x.*
