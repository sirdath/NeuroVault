"""Multi-brain manager — each project/context gets its own memory space.

A brain = vault directory + SQLite database + BM25 index + file watcher + decay scheduler.
The embedding model is shared across all brains (expensive to load, stateless).
"""

import json
import shutil
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from loguru import logger

from engram_server.config import ENGRAM_HOME, BRAINS_DIR, REGISTRY_PATH
from engram_server.database import Database
from engram_server.embeddings import Embedder
from engram_server.bm25_index import BM25Index
from engram_server.ingest import ingest_vault
from engram_server.watcher import VaultWatcher
from engram_server.strength import DecayScheduler
from engram_server.consolidation import ConsolidationScheduler


@dataclass
class BrainContext:
    """All state for a single brain — structured like a real brain.

    Directory layout (raw → processed → consolidated):
      raw/              Raw inputs before processing (PDFs, conversations, clips, pastes)
        pdfs/
        conversations/
        clips/
        pastes/
        imports/
      vault/            Processed, clean, searchable markdown notes (the "brain")
      consolidated/     Higher-level synthesis (themes, summaries, wikis)
      trash/            Soft-deleted notes
      brain.db          Index over everything
    """

    brain_id: str
    name: str
    description: str = ""
    vault_dir: Path = field(default_factory=Path)
    trash_dir: Path = field(default_factory=Path)
    raw_dir: Path = field(default_factory=Path)
    consolidated_dir: Path = field(default_factory=Path)
    db_path: Path = field(default_factory=Path)
    db: Database = field(default=None, repr=False)  # type: ignore[assignment]
    bm25: BM25Index = field(default=None, repr=False)  # type: ignore[assignment]
    watcher: VaultWatcher | None = field(default=None, repr=False)
    decay_scheduler: DecayScheduler | None = field(default=None, repr=False)
    consolidation_scheduler: ConsolidationScheduler | None = field(default=None, repr=False)
    _active: bool = field(default=False, repr=False)

    def initialize(self, embedder: Embedder, activate: bool = False) -> None:
        """Set up the full brain directory structure."""
        brain_dir = BRAINS_DIR / self.brain_id

        # Processed brain (what Claude sees)
        self.vault_dir = brain_dir / "vault"
        self.trash_dir = brain_dir / "trash"

        # Raw inputs (never modified, permanent record)
        self.raw_dir = brain_dir / "raw"

        # Consolidated knowledge (synthesized from vault)
        self.consolidated_dir = brain_dir / "consolidated"

        self.db_path = brain_dir / "brain.db"

        # Create all directories
        self.vault_dir.mkdir(parents=True, exist_ok=True)
        self.trash_dir.mkdir(parents=True, exist_ok=True)
        self.consolidated_dir.mkdir(parents=True, exist_ok=True)
        for subdir in ("pdfs", "conversations", "clips", "pastes", "imports"):
            (self.raw_dir / subdir).mkdir(parents=True, exist_ok=True)

        self.db = Database(self.db_path)
        self.bm25 = BM25Index()

        # Ingest existing vault files
        ingest_vault(self.db, embedder, self.bm25, self.vault_dir)

        # Karpathy-style auto-maintained files
        try:
            from engram_server.karpathy import ensure_schema, rebuild_index, append_log
            ensure_schema(self.vault_dir, self.name)
            rebuild_index(self.db, self.vault_dir)
            append_log(self.vault_dir, "activate", f"brain {self.name} initialized")
        except Exception as e:
            logger.debug("Karpathy wiki init skipped: {}", e)

        # Git auto-backup (invisible, per-brain)
        try:
            from engram_server.git_backup import init_backup_repo
            init_backup_repo(self.vault_dir)
        except Exception as e:
            logger.debug("Git backup init skipped: {}", e)

        if activate:
            self.activate(embedder)

    def activate(self, embedder: Embedder) -> None:
        """Start watcher and decay scheduler (only for the active brain)."""
        if self._active:
            return
        self.watcher = VaultWatcher(self.vault_dir, self.db, embedder, self.bm25)
        self.watcher.start()
        self.decay_scheduler = DecayScheduler(self.db, interval_seconds=3600)
        self.decay_scheduler.start()
        # Sleep cycle: consolidate every 4 hours. Passes bm25 (Stage 4
        # query-affinity) and `self` as brain_ctx (observation rollup
        # needs vault_dir + archive dir).
        self.consolidation_scheduler = ConsolidationScheduler(
            self.db, embedder, self.consolidated_dir,
            interval_seconds=14400, bm25=self.bm25, brain_ctx=self,
        )
        self.consolidation_scheduler.start()
        self._active = True
        logger.info("Brain activated: {} ({})", self.name, self.brain_id)

    def deactivate(self) -> None:
        """Stop watcher and decay (when switching away)."""
        if not self._active:
            return
        if self.watcher:
            self.watcher.stop()
            self.watcher = None
        if self.decay_scheduler:
            self.decay_scheduler.stop()
            self.decay_scheduler = None
        if self.consolidation_scheduler:
            self.consolidation_scheduler.stop()
            self.consolidation_scheduler = None
        self._active = False
        logger.info("Brain deactivated: {} ({})", self.name, self.brain_id)

    def shutdown(self) -> None:
        """Full shutdown — stop services and close DB."""
        self.deactivate()
        if self.db:
            self.db.close()


class BrainManager:
    """Manages multiple brain contexts with a shared embedder."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._contexts: dict[str, BrainContext] = {}
        self._active_id: str = "default"
        self._registry: list[dict] = []

        # Shared resources (loaded once)
        self.embedder = Embedder.get()

        # Ensure base dirs exist
        ENGRAM_HOME.mkdir(parents=True, exist_ok=True)
        BRAINS_DIR.mkdir(parents=True, exist_ok=True)

        # Migrate legacy single-brain setup if needed
        self._migrate_legacy()

        # Load or create registry
        self._load_registry()

        # Initialize the active brain
        active = self.get_active()
        logger.info(
            "BrainManager ready: {} brains, active='{}'",
            len(self._registry), active.name,
        )

    def _migrate_legacy(self) -> None:
        """Move ~/.engram/vault + brain.db into brains/default/ if needed."""
        legacy_vault = ENGRAM_HOME / "vault"
        legacy_db = ENGRAM_HOME / "brain.db"

        if REGISTRY_PATH.exists():
            return  # Already migrated
        if not legacy_vault.exists() and not legacy_db.exists():
            return  # Fresh install, nothing to migrate

        logger.info("Migrating legacy single-brain data to brains/default/...")
        default_dir = BRAINS_DIR / "default"
        default_dir.mkdir(parents=True, exist_ok=True)

        if legacy_vault.exists():
            target = default_dir / "vault"
            if not target.exists():
                shutil.move(str(legacy_vault), str(target))

        if legacy_db.exists():
            target = default_dir / "brain.db"
            if not target.exists():
                shutil.move(str(legacy_db), str(target))
            # Also move WAL/SHM files
            for suffix in ["-wal", "-shm"]:
                wal = ENGRAM_HOME / f"brain.db{suffix}"
                if wal.exists():
                    shutil.move(str(wal), str(default_dir / f"brain.db{suffix}"))

        legacy_trash = ENGRAM_HOME / "trash"
        if legacy_trash.exists():
            target = default_dir / "trash"
            if not target.exists():
                shutil.move(str(legacy_trash), str(target))

        # Create registry
        self._registry = [{
            "id": "default",
            "name": "Default",
            "description": "Migrated from single-brain setup",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }]
        self._active_id = "default"
        self._save_registry()
        logger.info("Migration complete: legacy data now in brains/default/")

    def _load_registry(self) -> None:
        """Load brains.json or create default."""
        if REGISTRY_PATH.exists():
            data = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
            self._registry = data.get("brains", [])
            self._active_id = data.get("active", "default")
        else:
            # Fresh install — create default brain with welcome note
            self._registry = [{
                "id": "default",
                "name": "Default",
                "description": "General memory",
                "created_at": datetime.now(timezone.utc).isoformat(),
            }]
            self._active_id = "default"
            self._save_registry()
            self._create_welcome_note()

    def _save_registry(self) -> None:
        data = {"active": self._active_id, "brains": self._registry}
        REGISTRY_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")

    def _create_welcome_note(self) -> None:
        vault = BRAINS_DIR / "default" / "vault"
        vault.mkdir(parents=True, exist_ok=True)
        welcome = (
            "# Welcome to Engram\n\n"
            "Your AI memory system is ready.\n\n"
            "## How it works\n\n"
            "- **Memories persist** across all conversations with Claude\n"
            "- Claude uses `remember` to save facts, `recall` to search them\n"
            "- Notes are plain markdown files in your vault\n"
            "- The neural graph shows connections between memories\n"
            "- Memory strength decays over time — frequently accessed memories stay strong\n\n"
            "## Multiple Brains\n\n"
            "Create separate brains for different projects or contexts. "
            "Each brain has its own vault, database, and knowledge graph. "
            "Switch between brains using the dropdown in the top bar.\n\n"
            "## Keyboard Shortcuts\n\n"
            "- **Ctrl+N** — New note\n"
            "- **Ctrl+S** — Force save\n"
            "- **Ctrl+P** — Toggle Editor/Graph view\n"
            "- **Ctrl+B** — Toggle Memory Panel\n"
            "- **Ctrl+K** — Focus search\n"
        )
        (vault / "welcome-00000000.md").write_text(welcome, encoding="utf-8")

    # --- Brain CRUD ---

    def create_brain(self, name: str, description: str = "") -> BrainContext:
        """Create a new brain."""
        brain_id = name.lower().replace(" ", "-").replace("/", "-")[:30]
        # Ensure unique
        existing_ids = {b["id"] for b in self._registry}
        if brain_id in existing_ids:
            brain_id = f"{brain_id}-{uuid.uuid4().hex[:6]}"

        with self._lock:
            self._registry.append({
                "id": brain_id,
                "name": name,
                "description": description,
                "created_at": datetime.now(timezone.utc).isoformat(),
            })
            self._save_registry()

        ctx = BrainContext(brain_id=brain_id, name=name, description=description)
        ctx.initialize(self.embedder, activate=False)

        with self._lock:
            self._contexts[brain_id] = ctx

        logger.info("Created brain: {} ({})", name, brain_id)
        return ctx

    def delete_brain(self, brain_id: str) -> bool:
        """Delete a brain. Cannot delete the active brain."""
        if brain_id == self._active_id:
            logger.warning("Cannot delete the active brain")
            return False

        with self._lock:
            # Shutdown context if loaded
            if brain_id in self._contexts:
                self._contexts[brain_id].shutdown()
                del self._contexts[brain_id]

            # Remove from registry
            self._registry = [b for b in self._registry if b["id"] != brain_id]
            self._save_registry()

        # Remove files
        brain_dir = BRAINS_DIR / brain_id
        if brain_dir.exists():
            shutil.rmtree(str(brain_dir))

        logger.info("Deleted brain: {}", brain_id)
        return True

    def list_brains(self) -> list[dict]:
        """List all brains with active flag."""
        return [
            {**b, "is_active": b["id"] == self._active_id}
            for b in self._registry
        ]

    def switch_brain(self, brain_id: str) -> BrainContext:
        """Switch the active brain."""
        # Validate brain exists
        if not any(b["id"] == brain_id for b in self._registry):
            raise ValueError(f"Brain not found: {brain_id}")

        with self._lock:
            # Deactivate current
            if self._active_id in self._contexts:
                self._contexts[self._active_id].deactivate()

            self._active_id = brain_id
            self._save_registry()

        # Activate new (will lazy-load if needed)
        ctx = self.get_context(brain_id)
        ctx.activate(self.embedder)

        logger.info("Switched to brain: {} ({})", ctx.name, brain_id)
        return ctx

    def get_active(self) -> BrainContext:
        """Get the active brain context (initializes if needed)."""
        return self.get_context(self._active_id, activate=True)

    def get_context(self, brain_id: str, activate: bool = False) -> BrainContext:
        """Get or lazy-load a brain context."""
        with self._lock:
            if brain_id in self._contexts:
                ctx = self._contexts[brain_id]
                if activate and not ctx._active:
                    ctx.activate(self.embedder)
                return ctx

        # Find in registry
        entry = next((b for b in self._registry if b["id"] == brain_id), None)
        if not entry:
            raise ValueError(f"Brain not found: {brain_id}")

        ctx = BrainContext(
            brain_id=brain_id,
            name=entry["name"],
            description=entry.get("description", ""),
        )
        ctx.initialize(self.embedder, activate=activate)

        with self._lock:
            self._contexts[brain_id] = ctx

        return ctx
