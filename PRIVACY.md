# Privacy Policy

**NeuroVault is local-first. Your notes, your database, your embeddings — all stay on your machine.**

This document is a factual description of what NeuroVault does and does
not send off your computer. It applies to version 0.1.0 and is versioned
with the code; every release that changes this policy must bump the
version number here and in the README.

---

## TL;DR

| | |
|---|---|
| Analytics / telemetry | **None.** No usage pings, no feature tracking, no error reports. |
| Phone-home on startup | **None.** The app does not call any NeuroVault-owned server. |
| Crash reporting | **None in 0.1.0.** If we ever add it, it will be **off by default**, opt-in per session, and with a public data-schema. |
| Account / login | **None.** There is no "NeuroVault account." |
| Cloud sync | **None.** Your vault is a folder of markdown files you own. |
| Does the app talk to any network? | Only when YOU ask it to (see [Outbound connections](#outbound-connections) below). |

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
folder stays where it is. Deleting an external-vault brain removes
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
| First launch, if models aren't cached | huggingface.co | Download `bge-small-en-v1.5` (~90 MB) for local embeddings. After the first successful download the models live at `~/.cache/fastembed/` and are never re-downloaded. |
| You click "Check for updates" in Settings OR (after v0.2) auto-update checks run | github.com/sirdath/NeuroVault/releases | Tauri updater manifest check. Metadata only — no identifier sent. We receive: the fact that SOMEONE checked for updates. We do not receive: who you are. |
| You use the `ingest_pdf` tool on a PDF that contains remote images | host of the remote image | PyMuPDF may fetch images referenced in the PDF. Does not happen for plain-text PDFs. |
| You connect Claude Desktop (or any MCP client) and use recall/remember | Anthropic's servers (or whichever LLM host you connected) | **This is the LLM provider's network call, not NeuroVault's.** NeuroVault's MCP server runs entirely on localhost (127.0.0.1:8765). The LLM client reads the tool results locally and sends them to the LLM's API as part of your conversation. |
| You run compile with an `ANTHROPIC_API_KEY` set (opt-in) | api.anthropic.com | Compile calls the Claude API with your key to synthesize wiki pages. Skip the API key and use the agent-driven `compile_page` flow to avoid any network call. |

Nothing else. The server is bound to `127.0.0.1:8765` (loopback) — it
refuses connections from other machines by default.

## Telemetry stance

We have made an explicit decision NOT to ship telemetry in 0.1.0. This
includes:

- No `User-Agent` headers in outbound calls that identify your install
- No install counter, first-run ping, or weekly heartbeat
- No anonymized usage stats ("N brains created, M notes saved")
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

NeuroVault 0.1.0 does **not** encrypt the vault. The markdown files and
SQLite database are plaintext on your disk. If you store sensitive
data, use your OS's full-disk encryption (BitLocker, FileVault, LUKS).

Per-brain encrypted vaults are on the roadmap (T3.5 in the public-release
plan) — SQLCipher for the DB, keys held in the OS keychain. If/when it
ships this document will describe the threat model it covers.

## Data deletion

| You want to... | Do this |
|---|---|
| Remove a single brain | Settings → dropdown → hover row → trash icon. Internal brains: nukes the folder. External brains: removes only the NeuroVault registry entry. |
| Remove a single note | Sidebar → hover row → ×. Marks dormant in the DB + moves the file to `trash/`. Permanent delete: `rm` the file. |
| Wipe everything | Close NeuroVault, delete `~/.neurovault/`. Next launch starts fresh. |
| Export a brain before deletion | Settings → dropdown → hover row → download icon → save the .zip somewhere. |

## Questions, issues, corrections

Email: via GitHub Issues at
[github.com/sirdath/NeuroVault/issues](https://github.com/sirdath/NeuroVault/issues)

For security-specific concerns (e.g. vulnerability in the local server
binding), see [SECURITY.md](SECURITY.md).

---

*Last updated: 2026-04-19. Applies to NeuroVault ≥ 0.1.0.*
