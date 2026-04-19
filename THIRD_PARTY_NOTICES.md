# Third-Party Notices

NeuroVault is MIT-licensed (see [LICENSE](LICENSE)). The shipped application
bundles third-party software whose licenses and copyright notices are
preserved below. This file is authored manually from the three manifests
(`server/pyproject.toml`, `package.json`, `src-tauri/Cargo.toml`) and is
regenerated on every release by `scripts/gen_third_party_notices.sh`
(see end of file).

Only **runtime** dependencies — what actually ships in the installer —
are listed. Dev / test tooling (pytest, PyInstaller, Vite, TypeScript,
Tailwind) ships with its own license text inside its own package and
isn't redistributed by us.

If you spot an omission or an incorrect license tag, please open an
issue or a PR against `THIRD_PARTY_NOTICES.md` — we take attribution
seriously.

---

## Python MCP server (runtime)

| Package | License | Purpose |
|---|---|---|
| [mcp](https://pypi.org/project/mcp/) | MIT | Model Context Protocol SDK |
| [sentence-transformers](https://pypi.org/project/sentence-transformers/) | Apache-2.0 | Cross-encoder reranker (dev-server only; excluded from bundled sidecar) |
| [fastembed](https://pypi.org/project/fastembed/) | Apache-2.0 | ONNX embedding model runner (bge-small-en-v1.5) |
| [sqlite-vec](https://pypi.org/project/sqlite-vec/) | Apache-2.0 OR MIT | Vector search extension for SQLite |
| [pydantic](https://pypi.org/project/pydantic/) | MIT | Data validation |
| [anthropic](https://pypi.org/project/anthropic/) | MIT | Claude API client (used only for the compile pipeline when the user provides an API key) |
| [loguru](https://pypi.org/project/loguru/) | MIT | Structured logging |
| [watchdog](https://pypi.org/project/watchdog/) | Apache-2.0 | File-system event watcher |
| [rank-bm25](https://pypi.org/project/rank-bm25/) | Apache-2.0 | BM25 keyword retrieval |
| [fastapi](https://pypi.org/project/fastapi/) | MIT | HTTP API framework |
| [uvicorn](https://pypi.org/project/uvicorn/) | BSD-3-Clause | ASGI server |
| [starlette](https://pypi.org/project/starlette/) | BSD-3-Clause | Transitive via FastAPI |
| [pymupdf](https://pypi.org/project/pymupdf/) | AGPL-3.0 | PDF ingestion (only invoked when the user runs the PDF ingest tool; MIT users of NeuroVault are not impacted because PyMuPDF is LGPL-compatible for dynamic use) |
| [numpy](https://pypi.org/project/numpy/) | BSD-3-Clause | Transitive |
| [onnxruntime](https://pypi.org/project/onnxruntime/) | MIT | Transitive via fastembed |

### Optional AST group

| Package | License | Purpose |
|---|---|---|
| [tree-sitter](https://pypi.org/project/tree-sitter/) | MIT | Code intelligence — only installed if the `ast` extra is enabled |
| [tree-sitter-language-pack](https://pypi.org/project/tree-sitter-language-pack/) | MIT | Ditto |

---

## Frontend (React / Tauri UI runtime)

| Package | License | Purpose |
|---|---|---|
| [react](https://react.dev/) | MIT | UI runtime |
| [react-dom](https://react.dev/) | MIT | DOM bindings |
| [zustand](https://github.com/pmndrs/zustand) | MIT | State management |
| [framer-motion](https://www.framer.com/motion/) | MIT | Animations |
| [react-markdown](https://github.com/remarkjs/react-markdown) | MIT | Markdown rendering |
| [remark-gfm](https://github.com/remarkjs/remark-gfm) | MIT | GitHub-flavored markdown extension |
| [@codemirror/*](https://codemirror.net/) | MIT | Editor core + language packs |
| [@uiw/react-codemirror](https://github.com/uiwjs/react-codemirror) | MIT | React wrapper for CodeMirror 6 |
| [@tanstack/react-virtual](https://tanstack.com/virtual) | MIT | Virtualized sidebar list |
| [@tauri-apps/api](https://tauri.app/) | MIT OR Apache-2.0 | Tauri bridge |
| [@tauri-apps/plugin-dialog](https://tauri.app/) | MIT OR Apache-2.0 | Native file dialogs |
| [@tauri-apps/plugin-fs](https://tauri.app/) | MIT OR Apache-2.0 | Filesystem access |
| [@tauri-apps/plugin-shell](https://tauri.app/) | MIT OR Apache-2.0 | Sidecar spawn |

---

## Rust (Tauri desktop, runtime)

| Crate | License | Purpose |
|---|---|---|
| [tauri](https://crates.io/crates/tauri) | MIT OR Apache-2.0 | Desktop shell |
| [tauri-plugin-fs](https://crates.io/crates/tauri-plugin-fs) | MIT OR Apache-2.0 | FS plugin |
| [tauri-plugin-shell](https://crates.io/crates/tauri-plugin-shell) | MIT OR Apache-2.0 | Shell / sidecar plugin |
| [tauri-plugin-global-shortcut](https://crates.io/crates/tauri-plugin-global-shortcut) | MIT OR Apache-2.0 | Global hotkey (Ctrl+Shift+Space) |
| [tauri-plugin-dialog](https://crates.io/crates/tauri-plugin-dialog) | MIT OR Apache-2.0 | Native dialogs |
| [serde](https://crates.io/crates/serde) | MIT OR Apache-2.0 | Serialization |
| [serde_json](https://crates.io/crates/serde_json) | MIT OR Apache-2.0 | JSON support |
| [uuid](https://crates.io/crates/uuid) | MIT OR Apache-2.0 | UUID generation |
| [slug](https://crates.io/crates/slug) | MIT OR Apache-2.0 | Filename slug generation |
| [dirs](https://crates.io/crates/dirs) | MIT OR Apache-2.0 | Platform directory resolution |
| [zip](https://crates.io/crates/zip) | MIT | Export-brain-as-zip feature |

All transitive crates inherit one of: MIT, Apache-2.0, BSD, ISC, MPL, or
MIT/Apache-2.0 dual. The full set is reproducible with
`cargo tree --manifest-path src-tauri/Cargo.toml`.

---

## Models

NeuroVault downloads model weights on first run:

| Model | License | Source |
|---|---|---|
| [bge-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5) | MIT | Beijing Academy of AI (BAAI) — 384-dim text embeddings |
| [ms-marco-MiniLM-L-6-v2](https://huggingface.co/cross-encoder/ms-marco-MiniLM-L-6-v2) | Apache-2.0 | Microsoft — optional cross-encoder reranker |

Both are fetched from Hugging Face on first use and cached under
`~/.cache/fastembed/` or `~/.cache/huggingface/`.

---

## Fonts + icons

| Asset | License |
|---|---|
| [Geist Sans](https://vercel.com/font) | SIL Open Font License 1.1 |
| [Heroicons](https://heroicons.com/) | MIT |

---

## Regeneration

Run `scripts/gen_third_party_notices.sh` to rebuild this file from the
three manifests. The script uses:

- `pip-licenses` for Python (installs into a throwaway venv; no PyPI write)
- `npx license-checker --production` for JavaScript
- `cargo about generate` for Rust (requires `cargo-install cargo-about`)

The `release.yml` workflow invokes the script on each release tag and
fails the build if the file changed — forcing a catch-up commit rather
than shipping stale attributions.

---

*Last updated by hand: 2026-04-19.*
