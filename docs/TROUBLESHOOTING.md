# Troubleshooting & data

NeuroVault stores its local vaults, index, receipts, and settings under
`~/.neurovault/` unless you choose an external Markdown folder. Selected
context reaches only AI providers you deliberately connect; model and update
downloads are listed in `PRIVACY.md`. This page covers common recovery and
backup cases.

---

## First launch: signature or SmartScreen warnings

Do not bypass a platform security warning for a file presented as an official
release. Verify its SHA-256 checksum against the GitHub release, delete the
download if the values differ, and report the release URL through
`SECURITY.md`. Unsigned development builds stay draft-only and should be run
through the documented source-development workflow.

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
   `~/.claude/.mcp.json`. The in-app **Settings → Connect Claude Code → Register
   automatically** button writes the correct file. Verify it contains an
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
│       ├── brain.db      # SQLite index (vectors + graph) — REBUILDABLE
│       └── assets/       # images referenced by notes
├── mcp_tier.txt          # the active MCP tier
└── ...
```

- **`vault/*.md` is canonical.** `brain.db` is a cache built from it.

## Back up / move / export a brain

- **Back up:** copy the whole `~/.neurovault/brains/<id>/` folder. It's
  self-contained.
- **Move to another machine:** copy that folder to the same path on the new
  machine. Your notes (`vault/`) are the important part; `brain.db` rebuilds.
- **Export as a zip:** Settings → (brain) → Export, or just zip the `vault/`
  folder — it's plain markdown, readable anywhere (Obsidian-compatible).
- **Version-control your notes:** `git init` inside `vault/` is safe. Add
  `brain.db*` and `assets/` to `.gitignore` if you only want to track the
  markdown.

## Recovering from a corrupt index

Because `vault/*.md` is the source of truth, a damaged `brain.db` is
recoverable:

1. Quit NeuroVault.
2. Delete (or move aside) `brain.db`, `brain.db-wal`, `brain.db-shm` in the
   brain folder.
3. Relaunch — NeuroVault re-ingests the vault and rebuilds the index. (Large
   vaults take a few minutes the first time.)

## Uninstall

Removing the app does **not** delete your data. To remove everything, also
delete `~/.neurovault/` (your notes!) and the model cache `~/.neurovault/.fastembed_cache/`.
Back up `~/.neurovault/brains/` first if you might want your notes later.

---

Still stuck? Open an [issue](https://github.com/sirdath/NeuroVault/issues) with
your OS, version (Settings → About), and what you tried.
