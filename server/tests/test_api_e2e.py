"""End-to-end HTTP API tests using FastAPI's TestClient.

Unit-level coverage is strong (chunker, embedder, database, ingest,
retriever) but nothing exercised the full glue layer: a real
``POST /api/notes`` lands on disk, gets ingested, surfaces in
``GET /api/notes``, and becomes recallable. A refactor that silently
breaks that wiring would sail through the unit suite — this file
catches it.

The test points ``NEUROVAULT_HOME`` at a temp dir *before* importing
``BrainManager`` so the production ``~/.neurovault`` stays untouched
and the test runs on a clean slate.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest


@pytest.fixture()
def api_client(tmp_path, monkeypatch):
    """Boot a fresh BrainManager rooted at tmp_path and wrap it in the
    real FastAPI app. Yields a TestClient so tests can hit HTTP routes
    without a real uvicorn listener. Each test gets an isolated brain
    so assertions don't leak between runs.
    """
    home = tmp_path / "neurovault"
    home.mkdir()
    monkeypatch.setenv("NEUROVAULT_HOME", str(home))

    # Force a reimport under the patched env so config.NEUROVAULT_HOME
    # picks up the new value. pytest loads modules once per session
    # otherwise, which would baseline the path at the user's real home.
    import importlib
    import neurovault_server.config
    importlib.reload(neurovault_server.config)
    import neurovault_server.brain
    importlib.reload(neurovault_server.brain)
    import neurovault_server.api
    importlib.reload(neurovault_server.api)

    from fastapi.testclient import TestClient
    from neurovault_server.brain import BrainManager
    from neurovault_server.api import create_api

    manager = BrainManager()
    app = create_api(manager)
    with TestClient(app) as client:
        yield client
    # Tear down background watchers etc.
    for ctx in list(manager._contexts.values()):
        ctx.shutdown()


def test_status_endpoint_returns_live_brain(api_client):
    r = api_client.get("/api/status")
    assert r.status_code == 200
    body = r.json()
    assert "brain" in body
    assert "memories" in body
    assert isinstance(body["memories"], int)


def test_post_note_roundtrip_to_disk_and_db(api_client):
    """POST a note → file lands in the vault → engram row exists → GET /api/notes returns it."""
    payload = {
        "title": "E2E Smoke Test",
        "content": "This is a smoke test memory written via HTTP for the E2E suite.",
    }
    r = api_client.post("/api/notes", json=payload)
    assert r.status_code == 200, r.text
    body = r.json()
    engram_id = body["engram_id"]
    filename = body["filename"]
    assert engram_id
    assert filename.endswith(".md")

    # File landed on disk in the active brain's vault
    from neurovault_server.config import BRAINS_DIR
    brain_dir = BRAINS_DIR / body["brain"]
    vault_file = brain_dir / "vault" / filename
    assert vault_file.exists(), f"expected {vault_file} to exist"
    assert "smoke test memory" in vault_file.read_text(encoding="utf-8").lower()

    # And the note shows up in the list endpoint
    r2 = api_client.get("/api/notes")
    assert r2.status_code == 200
    notes = r2.json()
    assert any(n["id"] == engram_id for n in notes), "new engram missing from /api/notes"


def test_post_note_requires_content(api_client):
    """Missing content returns HTTP 400 (not 200 with error body)."""
    r = api_client.post("/api/notes", json={"title": "No body"})
    assert r.status_code == 400
    assert "error" in r.json()
    assert "content is required" in r.json()["error"]


def test_delete_note_soft_removes_from_list(api_client):
    create = api_client.post("/api/notes", json={
        "title": "Temporary", "content": "will be deleted"
    })
    assert create.status_code == 200
    engram_id = create.json()["engram_id"]

    d = api_client.delete(f"/api/notes/{engram_id}")
    assert d.status_code == 200
    assert d.json()["status"] == "forgotten"

    notes = api_client.get("/api/notes").json()
    assert not any(n["id"] == engram_id for n in notes), "soft-deleted note still listed"


def test_404_on_unknown_note(api_client):
    r = api_client.get("/api/notes/not-a-real-engram-uuid")
    assert r.status_code == 404
    assert r.json().get("error") == "not found"


def test_brain_not_found_returns_404(api_client):
    r = api_client.get("/api/brains/does-not-exist/stats")
    assert r.status_code == 404
    assert "brain not found" in r.json().get("error", "")


def test_delete_active_brain_returns_409(api_client):
    active = api_client.get("/api/brains/active").json()
    r = api_client.delete(f"/api/brains/{active['brain_id']}")
    assert r.status_code == 409
    assert "active" in r.json().get("error", "").lower()
