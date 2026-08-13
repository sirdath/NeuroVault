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
| Reads anything outside `~/.neurovault/`? | **Only the local memory curator, and only if you turn it on.** Off by default; it reads Claude Code transcripts you separately consented to keep evidence for, runs a model on your own machine, and produces review-only proposals. Nothing leaves the machine. See [Local memory curator](#local-memory-curator-opt-in). |

If any of this is wrong for a release you're running, file an issue —
it's a bug.

---

## Where your data lives

```
~/.neurovault/
  brains.json                        # registry of vaults (plaintext JSON)
  local_curator.json                 # local memory curator: consent switches + which local model
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
      curator_state.json             # curator: how far the nightly run has read, and what deferred
      curator_runs-YYYY-MM.jsonl     # curator: one line per unit outcome (gate names + hashes, no text)
      curator_tombstones.jsonl       # curator: evidence that must never be proposed again
```

The three `curator_*` files exist only if you enabled the local memory
curator. They hold gate names, version numbers and hashes — never transcript
text, prompt text, or model output text.

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
| **Local memory curator** | Off by default. When enabled: once a night per active brain, while the app is open | Reads the Claude Code turns you consented to keep evidence for, asks a model **on this machine** to propose memories, verifies every one against your transcript, and appends review-only proposals. No network call. See the section below. | Settings → Local memory curator → **Curate my sessions** off, or set `"enabled": false` in `~/.neurovault/local_curator.json`. |

The consolidation scheduler is new in 0.6.1. It is the only automatic
background pass added since 0.6.0, and it does not change what can leave
your Mac: nothing it reads or writes leaves the machine.

## Local memory curator (opt-in)

This is the only feature that reads anything outside `~/.neurovault/`, so it
gets its own section. **It is off by default and does nothing until you turn
on two switches.**

### What it reads

Your Claude Code session transcripts — the `.jsonl` files under
`~/.claude/projects/` — and only the ones you consented to. Consent works in
two stages, which is why the app shows two switches rather than one:

1. **Keep evidence from my sessions.** When a Claude Code turn finishes,
   NeuroVault records *where* the transcript lives, how many bytes it had, and
   a SHA-256 of those bytes. It does not copy the text. Turns that finished
   before you granted this have no evidence recorded and are permanently
   invisible to the curator.
2. **Curate my sessions.** Only with this on does anything ever re-open a
   transcript.

At run time the file is re-opened under the approved root only (`openat` with
`O_NOFOLLOW`, no symlink following, no path traversal), and the bytes are
re-hashed against what was recorded at capture. If the file changed, the run
**stops** for that turn rather than reading the newer bytes. Secrets are
stripped before the model sees anything: API keys, tokens, AWS keys and similar
patterns are replaced with `[REDACTED:<kind>]`, and a sentence touched by a
redaction can be read for context but can never be cited as evidence.

macOS and Linux only. On Windows this feature refuses to run at all.

### What runs

A model **you** installed in **your** Ollama, on `127.0.0.1`. NeuroVault never
downloads a model for you and there is deliberately no download button in the
settings panel — the picker lists only what `ollama list` already shows.

Stated plainly, in the app's own words:

> It costs real hardware while it runs: a 12B-class model holds roughly 8 GB of
> RAM (a 30B one closer to 20 GB), your fans will notice, and a laptop on
> battery will notice too. The model is unloaded when the run finishes.

The unload is verified, not assumed: NeuroVault sends `keep_alive: 0` and then
polls Ollama's `/api/ps` until the model is actually gone. A run is capped at
24 units and 45 minutes of wall clock; whatever is left waits for tomorrow.

### What it produces

Proposals in Memory Review, and nothing else. Every candidate the model emits
is checked by deterministic Rust — thirteen named gates — against the exact
sentences it cited: the model points at sentence IDs and the server slices its
own transcript, so a model-authored quote is a type error rather than something
to be trusted. Numbers, dates, versions and identifiers must appear verbatim in
the cited sentence. A candidate that fails any gate is refused and recorded;
it never becomes a card.

Survivors are stored with application status **NotApplicable** — the store's
word for "this changes nothing." No curator path calls a write endpoint. A
proposal alters a memory only after you click Approve.

### What leaves your machine

Nothing. The model is local, the endpoint is a literal loopback address (a DNS
name — including `localhost` — is refused, because a name can resolve
off-host), and the provider is given no tools. The receipts NeuroVault keeps
alongside each proposal hold hashes, gate names and version numbers — never
prompt text, never response text, never transcript text.

There is one honest limit, and it is worth stating: if you paste attacker-
controlled text into a session and then approve a proposal derived from it, the
system does what you told it to. You are the authority. Role policy, a
tool-less provider and an envelope that carries no brain or session identifiers
are the boundary; your own Approve click is not something they can guard.

### How to turn it off

The master switch is a real kill switch, described in the app as:

> The kill switch. Off means no nightly run is scheduled, no transcript is
> opened, and no proposal is ever made. On means the curator may run — and
> every result still waits for your review.

Off means off at the top of the run, before any file is touched — not "runs and
discards." The two switches are independent on purpose: you can revoke
curation while still keeping evidence, or revoke evidence capture and leave
nothing for a future run to read.

- **In the app:** Settings → Local memory curator → toggle **Curate my
  sessions** off.
- **On disk:** set `"enabled": false` in `~/.neurovault/local_curator.json`, or
  delete the file.
- **Already-made proposals** stay in Memory Review until you approve or reject
  them; turning the curator off does not delete them, and it does not apply
  them either.

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
