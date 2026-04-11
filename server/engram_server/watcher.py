"""File system watcher for the vault directory.

Uses watchdog to detect changes to .md files and triggers ingestion.
Runs in a background thread alongside the MCP server.
"""

import threading
from pathlib import Path

from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler, FileSystemEvent
from loguru import logger

from engram_server.database import Database
from engram_server.embeddings import Embedder
from engram_server.bm25_index import BM25Index
from engram_server.ingest import ingest_file


class VaultEventHandler(FileSystemEventHandler):
    """Handles file events in the vault directory."""

    def __init__(
        self,
        db: Database,
        embedder: Embedder,
        bm25: BM25Index,
        on_index_start: object | None = None,
        on_index_done: object | None = None,
    ) -> None:
        self.db = db
        self.embedder = embedder
        self.bm25 = bm25
        self.on_index_start = on_index_start
        self.on_index_done = on_index_done
        self._debounce_timers: dict[str, threading.Timer] = {}

    def _handle_change(self, filepath: Path) -> None:
        """Process a file change with debouncing."""
        if not filepath.suffix == '.md':
            return

        key = str(filepath)

        # Cancel any pending timer for this file
        if key in self._debounce_timers:
            self._debounce_timers[key].cancel()

        # Debounce: wait 500ms before processing
        timer = threading.Timer(0.5, self._process_file, args=[filepath])
        self._debounce_timers[key] = timer
        timer.start()

    def _process_file(self, filepath: Path) -> None:
        """Actually process the file after debounce."""
        try:
            if self.on_index_start:
                self.on_index_start(filepath.name)

            result = ingest_file(filepath, self.db, self.embedder, self.bm25)

            if self.on_index_done:
                self.on_index_done(filepath.name, result is not None)

        except Exception as e:
            logger.error("Failed to ingest {}: {}", filepath.name, e)
            if self.on_index_done:
                self.on_index_done(filepath.name, False)

    def on_created(self, event: FileSystemEvent) -> None:
        if not event.is_directory:
            self._handle_change(Path(event.src_path))

    def on_modified(self, event: FileSystemEvent) -> None:
        if not event.is_directory:
            self._handle_change(Path(event.src_path))

    def on_deleted(self, event: FileSystemEvent) -> None:
        if not event.is_directory:
            filepath = Path(event.src_path)
            if filepath.suffix == '.md':
                # Mark as dormant in the database
                filename = filepath.name
                row = self.db.conn.execute(
                    "SELECT id FROM engrams WHERE filename = ?", (filename,)
                ).fetchone()
                if row:
                    self.db.soft_delete(row[0])
                    self.bm25.build(self.db)
                    logger.info("File deleted, marked dormant: {}", filename)


class VaultWatcher:
    """Manages the watchdog observer for the vault directory."""

    def __init__(
        self,
        vault_dir: Path,
        db: Database,
        embedder: Embedder,
        bm25: BM25Index,
    ) -> None:
        self.vault_dir = vault_dir
        self.handler = VaultEventHandler(db, embedder, bm25)
        self.observer = Observer()
        self._started = False

    def start(self) -> None:
        """Start watching the vault directory."""
        if self._started:
            return
        self.observer.schedule(self.handler, str(self.vault_dir), recursive=False)
        self.observer.daemon = True
        self.observer.start()
        self._started = True
        logger.info("File watcher started on: {}", self.vault_dir)

    def stop(self) -> None:
        """Stop the watcher."""
        if self._started:
            self.observer.stop()
            self.observer.join(timeout=5)
            self._started = False
            logger.info("File watcher stopped")
