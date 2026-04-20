import pytest
import tempfile
from pathlib import Path

from neurovault_server.database import Database
from neurovault_server.embeddings import Embedder


@pytest.fixture(scope="session")
def embedder():
    """Shared embedder instance — model loads once per test session."""
    return Embedder.get()


@pytest.fixture()
def tmp_db(tmp_path):
    """Fresh database for each test.

    On teardown we also cancel any pending debounced rebuilds — without
    that, a timer scheduled during the test can fire after close() and
    segfault SQLite's C layer on the freed connection.
    """
    db = Database(tmp_path / "test.db")
    yield db
    # Cancel debounced rebuilds AND wait for any already-queued slow-phase
    # tasks to finish before closing the connection. Skipping either
    # causes bg threads to execute SQL on a closed handle, which SIGABRTs
    # sqlite3's C layer on Windows.
    try:
        from neurovault_server.karpathy import _cancel_pending_rebuilds
        _cancel_pending_rebuilds()
    except Exception:
        pass
    try:
        from neurovault_server.ingest import wait_for_slow_phase_drain
        wait_for_slow_phase_drain(timeout=15.0)
    except Exception:
        pass
    db.close()


@pytest.fixture()
def tmp_vault(tmp_path):
    """Temporary vault directory."""
    vault = tmp_path / "vault"
    vault.mkdir()
    return vault
