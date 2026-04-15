import os
import warnings
from pathlib import Path


def env_with_legacy_fallback(new_name: str, legacy_name: str, default: str | None = None) -> str | None:
    """Read `new_name` first; fall back to `legacy_name` with a deprecation warning.

    Shared compatibility shim used across the server for every `NEUROVAULT_*`
    env var that was previously `ENGRAM_*`. Lets existing shell configs keep
    working through the rename without breaking dev boxes on boot.

    The warning fires once per read via `warnings.warn` (Python's default
    warnings filter dedupes by (message, category, module)). After the next
    few releases this helper can be deleted and the new names become the
    only supported path.
    """
    val = os.environ.get(new_name)
    if val is not None:
        return val
    val = os.environ.get(legacy_name)
    if val is not None:
        warnings.warn(
            f"Environment variable {legacy_name} is deprecated, please rename to {new_name}",
            DeprecationWarning,
            stacklevel=2,
        )
        return val
    return default


# Base directory for all NeuroVault data. Override with NEUROVAULT_HOME env var
# for isolated instances (dev/bench alongside a packaged dist binary) —
# prevents SQLite contention on the same brain.db.
NEUROVAULT_HOME = Path(
    env_with_legacy_fallback("NEUROVAULT_HOME", "ENGRAM_HOME", str(Path.home() / ".neurovault"))
    or str(Path.home() / ".neurovault")
)

# One-time directory rename: engram → neurovault.
# If the user has data from the old name at ~/.engram/ but nothing yet at
# ~/.neurovault/, move the entire directory atomically. This runs once on
# the first server boot after the rename ships; subsequent boots are no-ops
# because ~/.neurovault/ now exists. `shutil.move()` is atomic on the same
# filesystem, so partial-failure states are impossible here.
_LEGACY_HOME = Path.home() / ".engram"
if _LEGACY_HOME.exists() and not NEUROVAULT_HOME.exists():
    import shutil as _shutil
    try:
        _shutil.move(str(_LEGACY_HOME), str(NEUROVAULT_HOME))
        # Best-effort log — logger isn't imported yet (circular), so print
        # to stderr which uvicorn's log handler picks up at startup.
        import sys as _sys
        print(
            f"[neurovault] migrated legacy data directory: {_LEGACY_HOME} -> {NEUROVAULT_HOME}",
            file=_sys.stderr,
        )
    except Exception as _e:
        import sys as _sys
        print(
            f"[neurovault] WARNING: could not migrate {_LEGACY_HOME} -> {NEUROVAULT_HOME}: {_e}",
            file=_sys.stderr,
        )

# Multi-brain directories
BRAINS_DIR = NEUROVAULT_HOME / "brains"
REGISTRY_PATH = NEUROVAULT_HOME / "brains.json"

# Embedding model — BAAI/bge-small-en-v1.5 scores ~65 MTEB (vs 56 for all-MiniLM-L6-v2)
# Same 384 dims, 10% faster, 10-15% better retrieval quality, zero cost
EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5"
EMBEDDING_DIM = 384

# Server — override with NEUROVAULT_SERVER_PORT env var to run multiple
# instances side-by-side (e.g. benchmarking a dev build alongside a
# packaged dist binary). Defaults to 8765 for normal single-instance use.
SERVER_PORT = int(
    env_with_legacy_fallback("NEUROVAULT_SERVER_PORT", "ENGRAM_SERVER_PORT", "8765") or "8765"
)

# Ensure base directory exists (brain dirs created by BrainManager)
NEUROVAULT_HOME.mkdir(parents=True, exist_ok=True)
