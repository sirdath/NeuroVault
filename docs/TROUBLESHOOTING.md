# Troubleshooting & data

NeuroVault stores its local vaults, index, receipts, and settings under
`~/.neurovault/` unless you choose an external Markdown folder. Selected
context reaches only AI providers you deliberately connect; model and update
downloads are listed in `PRIVACY.md`. This page covers common recovery and
backup cases.

---

## First launch: signature or SmartScreen warnings

Do not bypass a platform security warning for a file presented as an official
release. For releases after v0.6.0, verify its SHA-256 checksum against
`SHA256SUMS.txt` in the GitHub release, delete the download if the values
differ, and report the release URL through `SECURITY.md`. v0.6.0 predates the
checksum manifest; its Apple Silicon app is Developer ID signed and notarized.

Windows installers are currently unsigned previews and SmartScreen identifies
their publisher as unknown. NeuroVault does not recommend bypassing that
warning for a consumer install. Build from reviewed source, or use the signed
and notarized Apple Silicon build, until Authenticode signing is added.

On Linux, an AppImage may need its normal executable bit set with
`chmod +x NeuroVault_*.AppImage`; this changes file permissions and does not
disable signature or quarantine checks.

## The app opens but "offline" / memory won't connect

The backend binds `127.0.0.1:8765`. If the status reads **offline**:

1. Check what's on the port:
   - macOS/Linux: `lsof -nP -i:8765`
   - Windows: `netstat -ano | findstr :8765`
2. If a **stale `neurovault` process** holds it, NeuroVault tries to clear it
   automatically on start; if not, quit all NeuroVault processes and relaunch.
3. If a **different** app owns 8765, close it (the port is currently fixed).

## My agent (Claude Code) doesn't see the NeuroVault tools

1. **Registration went to the right file.** Claude Code reads user-scope MCP
   servers from `~/.claude.json` (the file at your home-directory root) — *not*
   `~/.claude/.mcp.json`. The in-app **Settings → Connections → Claude Code →
   Connect** action writes the correct file. Verify it contains an
   `mcpServers.neurovault` entry.
2. **Restart the Claude Code session** after registering — it reads MCP servers
   at startup.
3. **Tier.** The default `lite` tier exposes 8 tools. If you expect a tool
   that's not showing (e.g. `find_clutter`, `rebuild_wikilinks`), raise the tier
   in **Settings → MCP** or set `~/.neurovault/mcp_tier.txt` to `standard` or
   `full`, then restart the session.
4. **Backend reachable.** The MCP server forwards to `127.0.0.1:8765`. It
   auto-starts the backend if needed; if you set `NEUROVAULT_AUTOSTART=0`, open
   the NeuroVault app yourself.

## First recall/ingest is slow

On first use NeuroVault downloads the embedding model
(BGE-small-en-v1.5, ~130 MB) to `~/.neurovault/.fastembed_cache/`. That's a one-time
download — subsequent calls are fast (embedding a note ≈ 20 ms). If it seems
stuck, check your network; the download is from Hugging Face.

## The graph view is laggy

The force-directed graph is comfortable into the low thousands of notes. If it
chugs: switch to **2D** in the filter panel, reduce the spread/animation, or
filter edge types. Very large vaults (10k+ notes) are best browsed via search
+ `related()` rather than the full graph.

## `[[Wikilinks]]` aren't connecting

A `[[link]]` connects on an **exact** title match, or — since v0.5.1 — on the
**base title** when the target carries a `(parenthetical)` suffix
(`[[the run]]` → "the run (produces locked dataset)"), as long as exactly one
note shares that base. Two notes with the same base stay unlinked on purpose;
use the full title to disambiguate.

Per-note ingest can only link to notes that **already exist**, so a link to a
note you write *later* won't connect at write time. After writing a
cross-linked set, run the **`rebuild_wikilinks`** tool (full tier) to
re-resolve every link across the whole brain, then verify with `related`.

## Updates

From **v0.5.1** on, updates are **signed** and install in place: the top-bar
**Update** pill appears when a newer release is available; clicking it
downloads, verifies, installs, and offers a relaunch. Your data is never
touched. (Apps built before v0.5.1 don't carry the update endpoint — update
manually one last time from the [releases page](https://github.com/sirdath/NeuroVault/releases/latest).)

---

## Where your data lives

```
~/.neurovault/
├── brains/
│   └── <brain-id>/
│       ├── vault/        # your notes — plain markdown (the source of truth)
│       ├── raw/          # drop-folder inbox (+ raw/_done/ for processed files)
│       ├── brain.db      # search indexes + structured state/history
│       └── assets/       # images referenced by notes
├── mcp_tier.txt          # the active MCP tier
└── ...
```

- **Note and engram content in `vault/*.md` is canonical.** Search indexes in
  `brain.db` are rebuildable, but its structured state and history are not.

## Back up / move / export a brain

- **Complete backup:** choose **Quit NeuroVault** rather than merely closing or
  hiding the window. If you use headless npm, run `npx -y
  @neurovault/mcp@latest stop`. Confirm `http://127.0.0.1:8765/api/health` no
  longer responds, then copy the whole `~/.neurovault/` directory. Including
  `brains.json` preserves the registry and external-vault locations.
- **Move to another machine:** with NeuroVault stopped on both machines, copy
  the complete data directory. External vault paths may differ and must be
  reselected on the destination. Never live-copy SQLite/WAL files through a
  sync tool.
- **Export portable files:** Settings → Vaults → Export creates a ZIP of
  Markdown and other file-owned content. It excludes `brain.db`, its WAL/SHM,
  and therefore database-only drafts, core memory, proposals, and history. It
  is useful for inspection and Markdown portability, not full restoration.
- **Version-control your notes:** `git init` inside `vault/` is safe. Add
  `brain.db*` and `assets/` to `.gitignore` if you only want to track the
  markdown.

## Recovering from a corrupt index

Your notes live in `vault/*.md` and are never at risk here — `brain.db`
is rebuilt from them.

> **Move it aside, don't delete it.** A few things live *only* in
> `brain.db` and have no markdown copy, so a rebuild starts them empty:
>
> - **Core memory blocks** — the persistent "who the user is / what
>   they're working on" context agents maintain via `core_memory_*`
>   and see in every `session_start`.
> - **Note history** — the per-note version trail behind
>   `engram_history`. After a rebuild every note is version 1 again.
> - **Drafts** — anything in the compile/draft workflow.
>
> Keeping the old file means you can copy those back or ask for help
> recovering them. Deleting it means they're gone for good.

1. Quit NeuroVault.
2. **Rename** (don't delete) `brain.db`, `brain.db-wal`, `brain.db-shm`
   in the brain folder — e.g. `brain.db.bak`. Keep them until you've
   confirmed everything you care about survived.
3. Relaunch — NeuroVault re-ingests the vault and rebuilds the index.
   (Large vaults take a few minutes the first time.)
4. Check that your core memory is intact (ask your agent "what do you
   remember about me", or open Settings → Memory). If it isn't, stop
   and restore the `.bak` files rather than continuing.

## Uninstall

1. In Settings, uninstall Automatic Memory hooks if they are enabled. You can
   also run `neurovault-server hook uninstall` from the same binary you used
   to install them.
2. Remove NeuroVault from each MCP client's settings. For the documented
   Claude Code user install: `claude mcp remove --scope user neurovault`.
3. Stop an npm-managed headless backend with `npx -y
   @neurovault/mcp@latest stop`, then explicitly quit the desktop app.
4. Remove the desktop application and, if used, run `npm uninstall -g
   @neurovault/mcp` for a global npm install.

Those steps preserve local data. To erase everything as a separate, deliberate
action, first make and verify a stopped full backup if wanted, confirm no
NeuroVault process is running, then delete `~/.neurovault/`. That directory
contains your notes, database-owned state, settings, logs, and model cache.

---

Still stuck? Open an [issue](https://github.com/sirdath/NeuroVault/issues) with
your OS, version (Settings → About), and what you tried.
