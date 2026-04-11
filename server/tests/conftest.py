import pytest
import tempfile
from pathlib import Path

from engram_server.database import Database
from engram_server.embeddings import Embedder


@pytest.fixture(scope="session")
def embedder():
    """Shared embedder instance — model loads once per test session."""
    return Embedder.get()


@pytest.fixture()
def tmp_db(tmp_path):
    """Fresh database for each test."""
    db = Database(tmp_path / "test.db")
    yield db
    db.close()


@pytest.fixture()
def tmp_vault(tmp_path):
    """Temporary vault directory."""
    vault = tmp_path / "vault"
    vault.mkdir()
    return vault
