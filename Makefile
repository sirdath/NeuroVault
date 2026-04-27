.PHONY: dev build install typecheck test test-rust test-py clean help help:
	@echo "NeuroVault dev targets"
	@echo ""
	@echo "  make install      Install JS deps (and optional Python deps for"
	@echo "                    advanced features) before first run."
	@echo "  make dev          Run NeuroVault in dev mode (Tauri + Vite + HMR)."
	@echo "                    The Rust HTTP backend starts in-process; no"
	@echo "                    separate server needed."
	@echo "  make build        Build the production app and produce installers"
	@echo "                    under src-tauri/target/release/bundle/."
	@echo "  make typecheck    TypeScript strict check (no JS emit)."
	@echo "  make test         Rust unit tests (cargo test) — fast."
	@echo "  make test-py      Optional Python tests for the advanced-features"
	@echo "                    helpers under server/."
	@echo "  make clean        Drop dist/, target/, vite cache."
	@echo ""

# === Install ===

# JS only is enough for the core app: the in-process Rust backend
# handles everything by default. Python is OPTIONAL — only needed if
# you'll work on the advanced-feature helpers (compile, PDF ingest,
# code-graph, Zotero) in `server/neurovault_server/`.
install:
	npm install
	@echo ""
	@echo "Optional: also install Python deps for advanced features:"
	@echo "    cd server && uv sync --extra dev"

# === Dev ===

# `tauri dev` spawns Vite + cargo run in dev profile. The Rust HTTP
# server boots in-process inside the desktop binary on port 8765;
# the React UI talks to it directly. HMR works for the React side.
dev:
	npm run tauri dev

# === Build ===

# Produces a release-profile binary AND wraps it in OS installers
# (.msi + .exe on Windows, .dmg on macOS, .AppImage / .deb on Linux).
# Output lands in src-tauri/target/release/bundle/.
build:
	npm run tauri build

# === Quality ===

typecheck:
	npx tsc --noEmit

# Rust unit tests — covers the in-process HTTP server, retriever,
# graph metrics, etc. JS has no test suite yet.
test test-rust:
	cd src-tauri && cargo test --no-default-features

# Python tests for the advanced-feature helpers under server/.
# Skip the reranker tests (cross-encoder load takes ~30 s).
test-py:
	cd server && uv run pytest tests/ -v -k "not reranker"

# === Cleanup ===

clean:
	rm -rf dist/
	rm -rf src-tauri/target/
	rm -rf node_modules/.vite/
	rm -rf server/dist/
	rm -rf server/build/
	rm -rf server/.pytest_cache/
