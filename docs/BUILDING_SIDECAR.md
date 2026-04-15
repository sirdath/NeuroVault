# Building the sidecar binary

NeuroVault ships as a Tauri desktop app that talks to a Python MCP server
on `127.0.0.1:8765`. By default the server runs as a separate process that
you start manually (see root README Quick Start). For a true one-click
install experience, the Python server can be packaged as a standalone
Windows/macOS/Linux executable and bundled into the Tauri installer as a
**sidecar**.

The sidecar binary is **not checked into git** — it's ~275 MB on Windows
because of torch + sentence-transformers. See
[`server/engram_server.spec`](../server/engram_server.spec) for the
PyInstaller build config.

## Build locally (Windows)

```powershell
cd server
uv sync --extra dev          # installs PyInstaller into .venv
.venv\Scripts\python.exe -m PyInstaller engram_server.spec --clean --noconfirm
```

The resulting single-file exe lands at `server/dist/engram-server.exe`.
Copy it to the Tauri sidecar path:

```powershell
copy server\dist\engram-server.exe src-tauri\binaries\engram-server-x86_64-pc-windows-msvc.exe
```

Then re-enable the sidecar in `src-tauri/tauri.conf.json` by adding:

```json
"externalBin": [
  "binaries/engram-server"
]
```

and uncomment the sidecar spawn block in `src-tauri/src/lib.rs`. Rebuild
with `npx tauri build`. The resulting installer (at
`src-tauri/target/release/bundle/{msi,nsis}/`) contains the sidecar and
will auto-spawn it on launch.

## Why it's not committed

- **Size**: ~275 MB on Windows. Git LFS is avoided because of GitHub's
  1 GB/month bandwidth quota on free public repos.
- **Per-platform**: one binary per target triple
  (`x86_64-pc-windows-msvc`, `aarch64-apple-darwin`, etc.). PyInstaller
  cannot cross-compile, so each target needs its own build machine.
- **Reproducible**: any developer with the server venv can build it from
  the spec in a few minutes.

## Long-term plan

The sidecar will eventually be:
1. Slimmed by swapping `sentence-transformers` → Qdrant's
   [`fastembed`](https://github.com/qdrant/fastembed) (drops `torch`,
   cuts bundle from 275 MB to ~60-80 MB), then
2. Built in CI via `tauri-apps/tauri-action` on release-tag pushes,
3. Attached to GitHub Releases as installer assets.
