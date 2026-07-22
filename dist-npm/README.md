# @neurovault/mcp

> **Status: not yet on npm.** This package is built and CI-verified but its
> first publish (tag `npm-v*`) has not shipped, so the install commands below
> will 404 until it does. Until then, use the
> [desktop app](https://github.com/sirdath/NeuroVault/releases/latest) (bundles
> the same MCP server) or build from source.

**NeuroVault as a headless [MCP](https://modelcontextprotocol.io) server** — local-first AI memory for your coding agents. Install once; Claude Code, Cursor, and Codex all share **one memory you own** (plain markdown files, on-device embeddings, no cloud).

No desktop app required. The NeuroVault desktop app adds a notes editor and a live knowledge-graph view on top of this same engine — but the memory works headless.

This package is maintained in the same
[`sirdath/NeuroVault`](https://github.com/sirdath/NeuroVault) repository as the
desktop app. That repository is the canonical source for both install modes;
the headless package does not use a separate data format or release source.

## Install

**Claude Code:**

```bash
claude mcp add --transport stdio --scope user neurovault -- npx -y @neurovault/mcp
```

**Terminal-launched clients on macOS / Linux** can use this JSON when `npx` is
available on the client's inherited `PATH`:

```json
{
  "mcpServers": {
    "neurovault": { "command": "npx", "args": ["-y", "@neurovault/mcp"] }
  }
}
```

Clients that use another configuration format should invoke the same command:
`npx` with arguments `-y` and `@neurovault/mcp`. Use that client's own MCP
settings screen or documentation for the surrounding syntax.

**Windows** — MCP clients spawn the command without a shell, and Node can't spawn `npx.cmd` directly (you'd get `spawn npx ENOENT`). Wrap it in `cmd /c`:

```json
{
  "mcpServers": {
    "neurovault": { "command": "cmd", "args": ["/c", "npx", "-y", "@neurovault/mcp"] }
  }
}
```

**GUI-launched clients:** desktop apps often do not inherit your shell's npm
`PATH`. For a stable configuration, install globally and ask NeuroVault to
print JSON containing absolute paths to Node and its launcher:

```bash
npm install -g @neurovault/mcp@latest
neurovault-mcp config
```

Paste that output into the client's MCP settings. It works on macOS, Windows,
and Linux and remains valid until you upgrade or uninstall Node or the global package.

That's it. `recall`, `remember`, `related`, `session_start`, and the rest appear as tools. The server auto-starts a local backend on `127.0.0.1:8765` the first time an agent calls it.

## Status, upgrades, and uninstall

These commands become live with the first npm publication. Source-build users
can run the same subcommands against their built `neurovault-server` binary.

The auto-started backend deliberately survives one MCP session so all of your
agents can share it. Its lifecycle commands only control a backend that this
npm package started. They refuse to stop the desktop app or a manually managed
server.

```bash
npx -y @neurovault/mcp@latest status
npx -y @neurovault/mcp@latest stop
```

Before upgrading, run `stop`, update a pinned global install if you use one,
then restart your MCP clients. The next connection starts the new backend:

```bash
npx -y @neurovault/mcp@latest stop
npm install -g @neurovault/mcp@latest  # only for a global install
neurovault-mcp config                   # refresh absolute-path GUI configs
```

To disconnect Claude Code and stop the npm-managed backend:

```bash
claude mcp remove --scope user neurovault
npx -y @neurovault/mcp@latest stop
```

Removing the connection or npm package does not delete memories. They remain
under `~/.neurovault/`. Delete that directory only when you intentionally want
to erase every local brain, model cache, setting, and history record.

## Build from source

Until the first npm release is published, clone the main repository and build
the headless target without the desktop GUI feature. Node.js 22 and the stable
Rust toolchain are required:

```bash
git clone https://github.com/sirdath/NeuroVault.git
cd NeuroVault
```

On Linux x64, fetch and verify the exact sqlite-vec archive used by release CI
before building:

```bash
curl -fL --retry 5 -o /tmp/neurovault-vec0.tgz \
  https://github.com/asg017/sqlite-vec/releases/download/v0.1.9/sqlite-vec-0.1.9-loadable-linux-x86_64.tar.gz
echo "b959baa1d8dc88861b1edb337b8587178cdcb12d60b4998f9d10b6a82052d5d7  /tmp/neurovault-vec0.tgz" \
  | sha256sum --check --strict
mkdir -p src-tauri/resources
tar -xzf /tmp/neurovault-vec0.tgz -C src-tauri/resources
```

Then build on any supported host:

```bash
node scripts/build-headless.mjs
```

The server binary is written to
`src-tauri/target/release/neurovault-server` (`.exe` on Windows) and the script
stages it with the matching sqlite-vec extension under
`dist-npm/packages/<platform>/bin/`. The repository already carries the
verified macOS Apple Silicon and Windows x64 extensions; Linux uses the pinned
download above. Set `NEUROVAULT_VEC_EXTENSION` to the staged extension's
absolute path before starting the server. These manual steps are why the npm
package is the recommended headless install after its first publication.

## What you get

- **Local-first & yours.** Note and engram content is Markdown in
  `~/.neurovault/brains/<id>/vault/`; SQLite holds rebuildable search indexes
  plus structured state and history. NeuroVault does not upload vault content,
  and its limited outbound connections are documented in `PRIVACY.md`.
- **On-device, zero-LLM ingest.** BGE-small ONNX embeddings + hybrid retrieval (vector + BM25 keyword + knowledge-graph → fused → reranked). No AI-provider API key or per-write LLM cost is required.
- **Explicit client boundary.** NeuroVault has no cloud account or telemetry and
  does not call an AI provider itself. It returns selected memory to the MCP or
  HTTP clients you authorize. A cloud-backed AI client may send that selected
  context to its configured provider under that client's privacy terms.
- **Tiers.** Defaults to `lite` (8 tools: recall, remember, related, session_start, status, list_brains, switch_brain, update). Set `NEUROVAULT_MCP_TIER=standard` or `full` for chunk/temporal recall, brain maintenance, multi-agent coordination (`handoff` / `agent_inbox`), the code knowledge-graph tools, and more — 55 tools in all (`standard` has 21).
- **Per-folder brains.** Drop a `.neurovault` file in a project (or set `NEUROVAULT_BRAIN=<name>`) to scope it to its own brain.

## Good to know

- **Node.js 22 or newer is required.** Use the current Node LTS for a supported
  runtime and npm client.
- **Platforms:** macOS 14+ (**Apple Silicon only**), **Linux x64 (glibc 2.35+)**, and **Windows x64**.
  The macOS floor is 14 because the bundled `vec0` sqlite extension is built for it; on
  older systems the server starts but cannot open a brain. Intel Macs are not shipped
  (there is no x86_64 build of that extension). Alpine/musl Linux is not shipped either
  (musl needs its own build; the installer detects it and tells you rather than handing
  over a binary that won't run).
- **One backend owns `:8765`.** If you also run the NeuroVault desktop app, it and this server share the same backend — quit one if you switch between them.
- **First recall downloads the embedding model** (~130 MB, once) to
  `~/.neurovault/.fastembed_cache`. Reranking is enabled by default; the first
  qualifying reranked recall can download another model of about 1 GB and use
  about 1 GB of memory while the server runs. To opt out before first recall,
  write `off` to `~/.neurovault/rerank.txt`. Pre-seed the cache for
  offline/air-gapped setups.
- **Behind a corporate TLS-intercepting proxy?** The model download uses rustls with the bundled CA set, so a private/MITM root CA in your OS store isn't trusted and the download can fail with a certificate error. Pre-seed `~/.neurovault/.fastembed_cache` from an unproxied machine (copy the `models--Xenova--*` folders), or point `HF_ENDPOINT` at an internal mirror.
- For a long-lived setup, prefer a pinned global install (`npm i -g @neurovault/mcp`) over bare `npx -y`, so the auto-started backend keeps a stable binary path.

MIT © NeuroVault Contributors
