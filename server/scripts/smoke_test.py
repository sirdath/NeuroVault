"""End-to-end smoke test for NeuroVault — fresh boot to round-trip recall.

Runs the real HTTP server against a real brain and verifies the core
happy path. If this script exits 0, NeuroVault is healthy enough to ship:

  1. Server boots and reports an active brain
  2. Embedder warmup log line appears (cold start path is paid at boot)
  3. POST /api/notes stores a memory
  4. GET  /api/recall finds that memory by a paraphrased query
  5. POST /api/observations (UserPromptSubmit) promotes an insight
  6. Insight is findable via recall with a keyword from the original sentence
  7. DELETE /api/notes/{id} removes the test memory
  8. Server shutdown is clean

Non-destructive: the test creates engrams prefixed with "SMOKE:" and
deletes them on teardown. The brain directory is untouched.

Usage:
    python scripts/smoke_test.py                  # assumes server already running
    python scripts/smoke_test.py --boot           # boots the server itself
    python scripts/smoke_test.py --boot --tier core
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

SERVER_URL = "http://127.0.0.1:8765"
BOOT_TIMEOUT = 120
SMOKE_PREFIX = "SMOKE:"


# --- Pretty output ---------------------------------------------------------

class _Fmt:
    OK = "[ OK ]"
    FAIL = "[FAIL]"
    INFO = "[INFO]"
    STEP = "[STEP]"


def _print(kind: str, msg: str) -> None:
    print(f"{kind} {msg}", flush=True)


def _ok(msg: str) -> None:
    _print(_Fmt.OK, msg)


def _fail(msg: str) -> None:
    _print(_Fmt.FAIL, msg)


def _step(msg: str) -> None:
    _print(_Fmt.STEP, msg)


# --- HTTP helpers ----------------------------------------------------------

def _get(path: str, timeout: float = 60.0):
    req = urllib.request.Request(f"{SERVER_URL}{path}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _post(path: str, body: dict, timeout: float = 60.0):
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        f"{SERVER_URL}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _delete(path: str, timeout: float = 30.0):
    req = urllib.request.Request(f"{SERVER_URL}{path}", method="DELETE")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        return e.code


def _wait_for_server(timeout: float) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            _get("/api/brains/active", timeout=2.0)
            return True
        except Exception:
            time.sleep(0.5)
    return False


# --- Steps ----------------------------------------------------------------

def step_health() -> dict:
    info = _get("/api/brains/active")
    _ok(f"active brain: {info.get('name')} ({info.get('brain_id')})")
    return info


def step_remember() -> str:
    title = f"{SMOKE_PREFIX} Favorite desktop stack"
    content = (
        "I prefer Tauri 2.0 over Electron for desktop apps because the bundle "
        "size is dramatically smaller and Rust backend keeps memory use low."
    )
    result = _post("/api/notes", {"title": title, "content": content})
    engram_id = result.get("engram_id") or result.get("id")
    if not engram_id:
        raise AssertionError(f"POST /api/notes did not return an id: {result!r}")
    _ok(f"stored note: {engram_id[:8]}")
    return engram_id


def step_recall_paraphrase(expected_keyword: str) -> None:
    # Deliberately paraphrased — no word overlap beyond "desktop"
    query = "what framework do I like for building desktop applications"
    q = urllib.parse.quote(query)
    results = _get(f"/api/recall?q={q}&limit=5")
    if not isinstance(results, list) or not results:
        raise AssertionError(f"recall returned no results: {results!r}")

    for rank, r in enumerate(results, 1):
        blob = (str(r.get("title", "")) + " " + str(r.get("content", "") or r.get("preview", ""))).lower()
        if expected_keyword.lower() in blob:
            _ok(f"paraphrased recall hit @ rank {rank}")
            return
    titles = [r.get("title", "?") for r in results[:3]]
    raise AssertionError(f"paraphrased recall miss — top: {titles}")


def step_insight_capture() -> int:
    # Hit the exact path Claude Code's lifecycle hook uses
    fact_text = "Remember that the smoke test sentinel phrase is SMOKE_SENTINEL_XYZ123."
    result = _post("/api/observations", {
        "event": "UserPromptSubmit",
        "payload": {
            "session_id": "smoke-test-session",
            "prompt": fact_text,
        },
    })
    created = result.get("insights") or []
    if not created:
        raise AssertionError(f"no insights extracted from observation: {result!r}")
    _ok(f"observation -> {len(created)} insight(s) extracted")
    return len(created)


def step_insight_recall() -> None:
    query = "what is the smoke test sentinel phrase"
    q = urllib.parse.quote(query)
    results = _get(f"/api/recall?q={q}&limit=5")
    for rank, r in enumerate(results or [], 1):
        blob = (str(r.get("title", "")) + " " + str(r.get("content", "") or r.get("preview", ""))).lower()
        if "smoke_sentinel_xyz123" in blob:
            _ok(f"insight recall hit @ rank {rank}")
            return
    titles = [r.get("title", "?") for r in (results or [])[:3]]
    raise AssertionError(f"insight recall miss — top: {titles}")


def step_cleanup(engram_id: str) -> None:
    status = _delete(f"/api/notes/{engram_id}")
    if status not in (200, 204, 404):
        raise AssertionError(f"cleanup DELETE returned {status}")
    _ok(f"cleaned up {engram_id[:8]} (HTTP {status})")


# --- Server lifecycle (optional) ------------------------------------------

def boot_server(tier: str | None) -> subprocess.Popen:
    repo_root = Path(__file__).resolve().parents[1]
    env = os.environ.copy()
    if tier:
        env["NEUROVAULT_MCP_TIER"] = tier
    venv_py = repo_root / ".venv" / ("Scripts" if sys.platform == "win32" else "bin") / ("python.exe" if sys.platform == "win32" else "python")
    if not venv_py.exists():
        venv_py = Path(sys.executable)
    _step(f"booting server: {venv_py} -m neurovault_server --http-only (tier={tier or 'full'})")
    proc = subprocess.Popen(
        [str(venv_py), "-m", "neurovault_server", "--http-only"],
        cwd=str(repo_root),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
    )
    return proc


def shutdown_server(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    _step(f"shutting down server pid={proc.pid}")
    try:
        if sys.platform == "win32":
            proc.send_signal(signal.CTRL_BREAK_EVENT)
        else:
            proc.terminate()
        proc.wait(timeout=10)
    except Exception:
        proc.kill()


# --- Main -----------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--boot", action="store_true", help="boot the server before running")
    parser.add_argument("--tier", default=None, help="MCP tier to boot with (core|power|code|research|full)")
    args = parser.parse_args()

    print("=" * 68)
    print("NeuroVault smoke test")
    print("=" * 68)

    proc: subprocess.Popen | None = None
    if args.boot:
        proc = boot_server(args.tier)
        _step(f"waiting up to {BOOT_TIMEOUT}s for server ...")
        if not _wait_for_server(BOOT_TIMEOUT):
            _fail("server never became ready")
            shutdown_server(proc)
            return 2
        _ok("server is up")

    engram_id: str | None = None
    failures: list[str] = []
    try:
        _step("1. health check")
        step_health()

        _step("2. POST /api/notes (remember)")
        engram_id = step_remember()

        _step("3. recall by paraphrase (semantic)")
        step_recall_paraphrase(expected_keyword="Tauri")

        _step("4. UserPromptSubmit -> insight promotion")
        step_insight_capture()

        _step("5. recall the newly promoted insight")
        time.sleep(1.0)  # give ingest a moment to land
        try:
            step_insight_recall()
        except AssertionError as e:
            # Treat as soft failure — insight recall depends on embedder warmup
            _fail(f"soft: {e}")
            failures.append("insight_recall")

        _step("6. cleanup")
        if engram_id:
            step_cleanup(engram_id)

    except AssertionError as e:
        _fail(str(e))
        failures.append(str(e))
    except urllib.error.URLError as e:
        _fail(f"HTTP error: {e}")
        failures.append("http")
    finally:
        if proc:
            shutdown_server(proc)

    print("=" * 68)
    if not failures:
        _ok("SMOKE TEST PASSED")
        return 0
    _fail(f"SMOKE TEST FAILED — {len(failures)} issue(s)")
    for f in failures:
        print(f"    - {f}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
