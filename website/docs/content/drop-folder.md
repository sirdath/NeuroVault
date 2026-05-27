# Drop-folder ingest

The drop-folder is a staging area where you dump raw files — PDFs, text exports, meeting transcripts, a messy `.csv` — and your connected agent turns them into clean, indexed notes. NeuroVault deliberately ships **no built-in converters**: the agent is the converter, which means the result is shaped by intelligence, not a one-size-fits-all parser.

## How it works

```
You drop files ─▶  ~/.neurovault/brains/<id>/_inbox/   (raw, untouched)
                          │
                          │  agent calls list_inbox / read_inbox_file (MCP)
                          ▼
Agent writes a clean .md ─▶  vault/   ─▶  watcher indexes it  ─▶  recall-able
                          │
                          ▼
Agent calls mark_inbox_done ─▶  _inbox/_done/   (raw file preserved, out of the way)
```

The inbox itself is **never auto-indexed** — only the vault is. That's what lets a binary PDF sit safely in the inbox until the agent processes it, instead of being force-fed to a markdown-only pipeline.

## Adding files

Two ways:

- **Drag and drop** files from your file manager onto the NeuroVault window. A drop overlay confirms, and they're copied into the inbox. (Folders are skipped — drop the files inside.)
- **By hand** — drop files directly into `~/.neurovault/brains/<brain_id>/_inbox/`.

Either way, your originals are *copied*, not moved — nothing leaves your machine, and your source files stay where they were.

## Letting the agent process them

Once files are waiting, ask your connected agent something like *"process my NeuroVault inbox."* It has three MCP tools for this:

- **`list_inbox`** — see what's pending: name, size, type, and absolute path.
- **`read_inbox_file(name)`** — read one. Text files come back inline; for a binary or oversized file you get the absolute `path` so the agent can open it with its own file tools.
- **`mark_inbox_done(name)`** — move the raw file into `_inbox/_done/` once it's been turned into a note.

The agent reads each file, cleans it up, and writes a proper note with the standard `remember` tool (with a title, folder, and `[[wikilinks]]`). The vault watcher picks up the new `.md` and indexes it through the normal pipeline, so it's immediately recall-able and shows up in the [graph](#graph-view).

> [!TIP]
> Give the agent a hint about how you want the result organised: *"put each into the `research/` folder and link related ones together."* Because a model is doing the conversion, you can steer tone, structure, and granularity — something a fixed importer can't offer.

> [!NOTE]
> Processed files are **moved, not deleted** — they live in `_inbox/_done/` afterward. If a conversion went wrong, the original is still there to retry.

## Why no bundled converters?

PDF/Docx/HTML extraction libraries are heavy, brittle on real-world files, and produce flat text that still needs cleanup. Handing the raw file to an agent that already understands your vault's conventions yields a better note and keeps the app small. If you need fully-automated batch conversion, the Python server retains optional ingest helpers (PDF, Zotero) that can be run out-of-band — see [Architecture](#architecture).
