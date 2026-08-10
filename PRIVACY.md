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
| Cloud sync | **None.** Your vault is a folder of markdown files you own. |
| Does the app talk to any network? | Only for actions you enable or request: update checks/downloads and on-demand local-model downloads listed below. Connected AI clients have their own provider data flow, also described below. |
| Background work the app does on its own | Indexing, the file watcher, and the consolidation scheduler. All three are on-device and make **no network call** — see [Local background work](#local-background-work). |

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
      journal/                       # append-only event log, one file per month
      audit.jsonl                    # local log of MCP tool calls
      todos.jsonl                    # multi-agent todo queue
      proposals.jsonl                # review-only consolidation proposals
      consolidation_state.json       # how far consolidation has read the journal
      consolidation_last_run.txt     # timestamp that debounces the 6-hour clock
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
| First reranked recall, if the reranker is not cached | huggingface.co | Download the BGE cross-encoder reranker (about 1 GB). Reranking is **on by default** — with no preference file present the app treats it as enabled — so expect this download unless you turn it off first. Turn it off in Settings, or write `off` into `~/.neurovault/rerank.txt`. Same local model cache. |
| An AI employee you hired and enabled reaches its scheduled wake-up | Anthropic's servers, via the `claude` CLI already installed on your machine | **Off by default** — no employee is enabled until you hire and enable one in the app. When one runs, NeuroVault spawns your own local Claude Code CLI as a subprocess; that CLI makes the network call under your existing Claude login, and NeuroVault itself makes none. The prompt it is given contains the brain content the employee's role needs. |
| When you click "Check for updates," or when you explicitly enable launch checks in Settings | api.github.com | Read the latest public release tag and notes. Launch checks are off by default. GitHub receives ordinary connection metadata such as your IP address; NeuroVault sends no account, vault content, or stable install identifier. |
| You approve an available update | github.com/sirdath/NeuroVault/releases | Download the signed updater manifest and platform artifact. Tauri verifies the updater signature before installation. |
| You connect Claude Desktop (or any MCP client) and use recall/remember | Anthropic's servers (or whichever LLM host you connected) | **This is the LLM provider's network call, not NeuroVault's.** NeuroVault's MCP server runs entirely on localhost (127.0.0.1:8765). The LLM client reads the tool results locally and sends them to the LLM's API as part of your conversation. |

**What a fresh install downloads, stated plainly:** on default settings
NeuroVault fetches **about 1.1 GB of model weights from huggingface.co** —
the ~130 MB embedding model on your first ingest or recall, and the ~1 GB
cross-encoder reranker the first time a recall is reranked, which on
default settings is that same first recall. Both are one-time, cached
under `~/.neurovault/.fastembed_cache/`, and run entirely on your machine
afterwards. Nothing about your vault is sent to fetch them. Turning the
reranker off before your first recall avoids the 1 GB half.

The packaged UI loads no remote fonts, analytics scripts, images, or style
sheets. The server is bound to `127.0.0.1:8765` (loopback) — it
refuses connections from other machines by default.

## Local background work

Some work happens without you asking it to. The first two rows below are
entirely on-device and make no network call. The third is the exception:
it is off unless you turn it on, and it is the AI-employee row in the
outbound table above.

| What | When | What it does | Off switch |
|---|---|---|---|
| Vault indexing + file watcher | On save, and when a file in your vault changes on disk | Re-reads the changed markdown and updates the rebuildable index. On-device. | Inherent to the app. |
| **Consolidation scheduler** | Roughly every 6 hours per active brain, starting ~2 minutes after launch (desktop app only) | Reads that brain's own local `journal/` files, applies deterministic rules in plain CPU — no embeddings, no model, **no network** — and appends **review-only proposals** to `proposals.jsonl`. Nothing it produces touches a note. A proposal changes a memory only after you click Approve in Memory Review. | `PUT /api/consolidation_auto {"enabled": false}`, or write `off` into `~/.neurovault/consolidation_auto.txt`. There is no Settings toggle for it yet. |
| AI employees | Only for an employee you have hired *and* enabled | The watching is local and free; for judgment or writing it spawns your own `claude` CLI, which does reach the network — see the outbound table above. Autonomy is propose-only. | Off by default; disable the employee in the app. |

The consolidation scheduler is new in 0.6.1. It is the only automatic
background pass added since 0.6.0, and it does not change what can leave
your Mac: nothing it reads or writes leaves the machine.

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

NeuroVault 0.6.x does **not** encrypt the vault. The markdown files,
the SQLite database, and the local JSONL logs listed above are plaintext
on your disk. If you store sensitive data, use your OS's full-disk
encryption (BitLocker, FileVault, LUKS).

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

*Last updated: 2026-08-05. Applies to NeuroVault 0.6.x.*
