"""Claude Code lifecycle hook shim — reads JSON from stdin, posts to NeuroVault.

Wired into Claude Code's settings.json so that every SessionStart,
UserPromptSubmit, PostToolUse, and SessionEnd event becomes an observation
engram in the active brain. The shim is intentionally tiny — all the real
logic lives in `engram_server.hooks` server-side, so we can iterate without
touching user config.

Usage (from a hook config):
    uv run python -m scripts.engram_hook --event PostToolUse

The hook payload is read from stdin as JSON. Failures are silent by design:
a broken NeuroVault server must never block a Claude Code session.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request


DEFAULT_URL = os.environ.get("ENGRAM_API_URL", "http://127.0.0.1:8765")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--event", required=True, help="Hook event name (e.g. PostToolUse)")
    parser.add_argument("--url", default=DEFAULT_URL, help="NeuroVault HTTP API base URL")
    parser.add_argument("--timeout", type=float, default=2.0, help="POST timeout in seconds")
    args = parser.parse_args()

    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        payload = {"raw": raw[:1000]}

    body = json.dumps({"event": args.event, "payload": payload}).encode("utf-8")
    req = urllib.request.Request(
        f"{args.url.rstrip('/')}/api/observations",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=args.timeout) as resp:
            resp.read()
    except (urllib.error.URLError, TimeoutError, ConnectionError):
        # NeuroVault not running — never block the session
        pass
    except Exception:
        pass

    return 0


if __name__ == "__main__":
    sys.exit(main())
