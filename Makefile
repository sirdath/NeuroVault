.PHONY: dev build install typecheck test test-rust clean help

help:
	@echo "NeuroVault dev targets"
	@echo ""
	@echo "  make install      Install JS deps before first run."
	@echo "  make dev          Run NeuroVault in dev mode (Tauri + Vite + HMR)."
	@echo "                    The Rust HTTP backend starts in-process; no"
	@echo "                    separate server needed."
	@echo "  make build        Build the production app and produce installers"
	@echo "                    under src-tauri/target/release/bundle/."
	@echo "  make typecheck    TypeScript strict check (no JS emit)."
	@echo "  make test         Rust unit tests (cargo test) — fast."
	@echo "  make clean        Drop dist/, target/, vite cache."
	@echo ""

# === Install ===

# JS is all you need: the in-process Rust backend handles everything.
# (To run the MCP proxy from source for a Claude client, also:
#  cd server && uv sync — see README "Connect your agent".)
install:
	npm install

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

# === Cleanup ===

clean:
	rm -rf dist/
	rm -rf src-tauri/target/
	rm -rf node_modules/.vite/
