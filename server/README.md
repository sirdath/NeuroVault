# server/ — archived (reference only)

> **This directory is archived.** It is **not** part of the build, the app,
> or the MCP path, and you do **not** need Python to develop, build, or run
> NeuroVault.

The Python pieces here predate the native Rust rewrite:

- `mcp_proxy.py` — the original stdio MCP → HTTP proxy. **Superseded** by the
  native Rust `neurovault-server --mcp-only` (built from the same crate as the
  app, on the official `rmcp` SDK). The Rust forwarder is what ships and what
  agents spawn today.
- `scripts/neurovault_hook.py` — an old Claude Code hook helper.
- `benchmarks/` — historical benchmark scripts.

They are kept only as historical reference for how the Python prototype worked.
Anything new should target the Rust backend in [`../src-tauri`](../src-tauri).
See [`../CLAUDE.md`](../CLAUDE.md) for the current architecture.
