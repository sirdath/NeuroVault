.PHONY: dev build install typecheck test test-rust gate clean help

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
	@echo "  make test         Rust unit tests (cargo test) — fast inner loop."
	@echo "  make gate         FULL verification gate (what CI runs) — before pushing."
	@echo "  make clean        Drop dist/, target/, vite cache."
	@echo ""

# === Install ===

# JS is all you need: the in-process Rust backend handles everything,
# and the MCP server is the same native Rust binary. No Python.
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

# Rust unit tests only — fast inner loop. This is NOT the full gate:
# the JS side has real suites too (vitest components/stores, the tsx
# lib suites, Playwright e2e), all of which CI runs. Use `make gate`
# before pushing, or you are testing a fraction of what CI will.
test test-rust:
	cd src-tauri && cargo test --no-default-features --features model-download

# The full verification gate — identical to what CI runs.
gate:
	./scripts/gates.sh

# === Cleanup ===

clean:
	rm -rf dist/
	rm -rf src-tauri/target/
	rm -rf node_modules/.vite/
