# @neurovault/mcp

**NeuroVault as a headless [MCP](https://modelcontextprotocol.io) server** — local-first AI memory for your coding agents. Install once; Claude Code, Cursor, and Codex all share **one memory you own** (plain markdown files, on-device embeddings, no cloud).

No desktop app required. The NeuroVault desktop app adds a notes editor and a live knowledge-graph view on top of this same engine — but the memory works headless.

## Install

**Claude Code:**

```bash
claude mcp add neurovault -- npx -y @neurovault/mcp
```

**Cursor / Claude Desktop / Codex (macOS / Linux)** — add to your MCP config:

```json
{
  "mcpServers": {
    "neurovault": { "command": "npx", "args": ["-y", "@neurovault/mcp"] }
  }
}
```

**Windows** — MCP clients spawn the command without a shell, and Node can't spawn `npx.cmd` directly (you'd get `spawn npx ENOENT`). Wrap it in `cmd /c`:

```json
{
  "mcpServers": {
    "neurovault": { "command": "cmd", "args": ["/c", "npx", "-y", "@neurovault/mcp"] }
  }
}
```

That's it. `recall`, `remember`, `related`, `session_start`, and the rest appear as tools. The server auto-starts a local backend on `127.0.0.1:8765` the first time an agent calls it.

## What you get

- **Local-first & yours.** Memory is markdown in `~/.neurovault/brains/<id>/vault/`; the SQLite + sqlite-vec index next to it is rebuildable. Nothing leaves your machine.
- **On-device, zero-LLM ingest.** BGE-small ONNX embeddings + hybrid retrieval (vector + BM25 keyword + knowledge-graph → fused → reranked). No API keys, no per-write LLM cost.
- **Tiers.** Defaults to `lite` (8 tools: recall, remember, related, session_start, status, list_brains, switch_brain, update). Set `NEUROVAULT_MCP_TIER=standard` or `full` for chunk/temporal recall, brain maintenance, the code knowledge-graph tools, and more.
- **Per-folder brains.** Drop a `.neurovault` file in a project (or set `NEUROVAULT_BRAIN=<name>`) to scope it to its own brain.

## Good to know

- **Platforms:** macOS 11+ (Apple Silicon or Intel), **Linux x64 (glibc 2.35+)**, and **Windows x64**. Alpine/musl Linux is not shipped (musl needs its own build; the installer detects it and tells you rather than handing over a binary that won't run).
- **One backend owns `:8765`.** If you also run the NeuroVault desktop app, it and this server share the same backend — quit one if you switch between them.
- **First recall downloads the embedding model** (~130 MB, once) to `~/.neurovault/.fastembed_cache`. Pre-seed that folder for offline/air-gapped setups.
- **Behind a corporate TLS-intercepting proxy?** The model download uses rustls with the bundled CA set, so a private/MITM root CA in your OS store isn't trusted and the download can fail with a certificate error. Pre-seed `~/.neurovault/.fastembed_cache` from an unproxied machine (copy the `models--Xenova--*` folders), or point `HF_ENDPOINT` at an internal mirror.
- For a long-lived setup, prefer a pinned global install (`npm i -g @neurovault/mcp`) over bare `npx -y`, so the auto-started backend keeps a stable binary path.

MIT © NeuroVault Contributors
