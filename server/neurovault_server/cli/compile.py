"""CLI wrapper for `compiler.compile_topic`.

Invoked by the Rust Tauri command `run_python_job` as:

    python -m neurovault_server compile < args.json

Where args.json looks like:

    {"topic": "...", "model": "...", "dry_run": false, "brain_id": "..."}

Reads one JSON blob from stdin, runs the compile, writes one JSON
CompilationResult to stdout, exits. Loguru log lines go to stderr so
stdout stays parseable by the Rust caller.
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, is_dataclass


def main(argv: list[str]) -> int:
    # argv is unused — we read JSON from stdin per the cli/ contract.
    # Kept in the signature for uniformity with other CLI wrappers
    # and for future positional-arg support if needed.
    _ = argv

    try:
        raw = sys.stdin.read()
    except Exception as e:
        sys.stderr.write(f"[compile] could not read stdin: {e}\n")
        return 1

    try:
        args = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as e:
        sys.stderr.write(f"[compile] stdin is not valid JSON: {e}\n")
        return 1

    topic = (args.get("topic") or "").strip()
    if not topic:
        sys.stderr.write("[compile] missing required field 'topic'\n")
        return 2
    model = args.get("model")
    dry_run = bool(args.get("dry_run"))
    brain_id = args.get("brain_id")

    try:
        # Lazy import: pulls in the heavy compiler + anthropic client
        # only when this subcommand actually runs, not when the
        # dispatcher module loads.
        from neurovault_server.brain import BrainManager
        from neurovault_server.compiler import compile_topic
    except Exception as e:
        sys.stderr.write(f"[compile] import failed: {e}\n")
        return 3

    manager = BrainManager()
    if brain_id:
        manager.switch(brain_id)
    ctx = manager.active()

    try:
        result = compile_topic(ctx, topic, model=model, dry_run=dry_run)
    except Exception as e:
        sys.stderr.write(f"[compile] compile_topic failed: {e}\n")
        return 4

    # CompilationResult is (likely) a dataclass; fall back to vars()
    # for plain objects. Either way we serialise as JSON.
    if is_dataclass(result):
        payload = asdict(result)
    elif hasattr(result, "__dict__"):
        payload = {k: v for k, v in vars(result).items() if not k.startswith("_")}
    else:
        payload = {"result": str(result)}

    try:
        sys.stdout.write(json.dumps(payload, default=str))
        sys.stdout.write("\n")
    except Exception as e:
        sys.stderr.write(f"[compile] could not serialise result: {e}\n")
        return 5
    return 0
