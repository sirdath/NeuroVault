.PHONY: dev dev-server dev-app build test test-fast clean install

# === Development ===

# Start everything: server + Tauri app
dev: dev-server dev-app

# Start the Python MCP server (run in its own terminal)
dev-server:
	cd server && uv run python -m neurovault_server

# Start the Tauri app (run in its own terminal)
dev-app:
	cargo tauri dev

# === Installation ===

install:
	npm install
	cd server && uv sync --extra dev

# === Testing ===

# Full test suite (includes cross-encoder loading, ~2 min)
test:
	cd server && uv run pytest tests/ -v

# Fast tests (skip retriever reranker tests, ~6 sec)
test-fast:
	cd server && uv run pytest tests/ -v -k "not reranker"

# TypeScript type check
typecheck:
	npx tsc --noEmit

# === Build ===

# Build the PyInstaller server binary
build-server:
	cd server && uv run pyinstaller neurovault-server.spec --noconfirm

# Copy server binary to Tauri sidecar location
stage-sidecar: build-server
	mkdir -p src-tauri/binaries
	cp server/dist/neurovault-server/neurovault-server.exe src-tauri/binaries/neurovault-server-x86_64-pc-windows-msvc.exe

# Build the full Tauri application
build: stage-sidecar
	cargo tauri build

# === Cleanup ===

clean:
	rm -rf dist/
	rm -rf src-tauri/target/
	rm -rf server/dist/
	rm -rf server/build/
	rm -rf server/.pytest_cache/
	rm -rf node_modules/.vite/
