# Quickstart

From zero to a memory your agent can recall, in about a minute.

## 1. Install the desktop app

Download the latest installer for your OS from the [releases page](https://github.com/sirdath/NeuroVault/releases/latest) and run it.

> [!NOTE]
> The installers are unsigned, so Windows SmartScreen / macOS Gatekeeper will warn on first launch. On Windows choose **More info → Run anyway**; on macOS right-click the app → **Open**. This is expected for an open-source app without a paid signing certificate.

Launch NeuroVault. On first run it downloads the embedding model (~90 MB) into `~/.cache/fastembed/` — that's a one-time step. When the status dot in the bottom bar turns green, the local server is up on `127.0.0.1:8765`.

## 2. Add your first memory

You don't need an agent to start. In the app:

- Press **Ctrl/Cmd + N** to create a note, type something worth remembering, and save (**Ctrl/Cmd + S**).
- Or drag a folder of existing `.md` files onto the window — they're copied into your vault and indexed.

Every note becomes an **engram**: chunked, embedded, and linked. Switch to the [graph view](#graph-view) (**Ctrl/Cmd + 2**) and you'll see it appear as a node.

## 3. Connect your agent (MCP)

This is what makes NeuroVault a *memory* rather than a notes app — your agent can now read and write it.

Open **Settings → Connect Claude Code (MCP)** (or **Connect Claude Desktop**). The dialog shows the exact snippet for your install, because it embeds the absolute path to the bundled MCP sidecar. It looks like this:

**Claude Code** (one line in a terminal):

```bash
claude mcp add --scope user neurovault "<path-to-sidecar>" -- --mcp-only
```

**Claude Desktop / Cursor** (merge into the MCP config file):

```json
{
  "mcpServers": {
    "neurovault": {
      "type": "stdio",
      "command": "<path-to-sidecar>",
      "args": ["--mcp-only"]
    }
  }
}
```

> [!IMPORTANT]
> Copy the snippet from the Settings dialog rather than this page — it fills in the real sidecar path for your machine. Restart the agent after saving. If `mcpServers` already exists, merge the `neurovault` entry in rather than replacing the block.

## 4. The shortest possible run

Once connected, your agent has `recall` and `remember` (plus more). A first exchange usually looks like:

```text
You:    Remember that I deploy NeuroVault releases from the `release` branch, never main.
Agent:  → remember(content="Releases ship from the `release` branch, never main", deduplicate=0.92)
        Saved.

(next session, days later)

You:    Which branch do I release from?
Agent:  → recall(query="release branch")
        You release from the `release` branch — never main.
```

The fact persisted across sessions with no context window in between. That's the whole point.

## Staying up to date

NeuroVault checks for a newer release a few seconds after launch. When one exists, an **Update** button appears in the top bar — click it to grab the new version (and **Settings → Updates** has a manual "Check for updates" too). Dismiss the button with the × and it stays quiet until the *next* release.

> [!NOTE]
> While the installers are unsigned, the Update button opens the release page for you to download and reinstall. One-click download-and-install lands once update signing is enabled on the release pipeline.

## What to read next

- **[The graph view](#graph-view)** — make sense of your knowledge visually: health rings, category colours, clusters, time-lapse.
- **[Drop-folder ingest](#drop-folder)** — dump PDFs and exports in; let the agent turn them into clean notes.
- **[HTTP API](#http-api)** — if you'd rather talk to NeuroVault directly over loopback HTTP.

> [!TIP]
> Keeping work and personal memory apart? Create separate **brains** from the brain selector in the top-left. Recall stays within the active brain unless you explicitly search across brains.
