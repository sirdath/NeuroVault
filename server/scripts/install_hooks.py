"""One-shot installer: wires NeuroVault into Claude Code's lifecycle hooks.

Edits `~/.claude/settings.json` to add hook entries for SessionStart,
UserPromptSubmit, PostToolUse, and SessionEnd. Each hook invokes the
`engram_hook` shim which POSTs the payload to the running NeuroVault
HTTP API, where it gets persisted as an observation engram.

Run once after installing NeuroVault:
    uv run python -m scripts.install_hooks

Re-running is safe — existing engram hooks are detected and replaced.
Pass --uninstall to remove them.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


SETTINGS_PATH = Path.home() / ".claude" / "settings.json"
HOOK_MARKER = "engram_hook"  # Identifies hooks we own
EVENTS = ("SessionStart", "UserPromptSubmit", "PostToolUse", "SessionEnd")


def _hook_command(server_dir: Path, event: str) -> str:
    """Build the command Claude Code will run for a given event."""
    # Use uv to ensure the right venv. Fall back to plain python if uv missing.
    return (
        f'uv --directory "{server_dir}" run python -m scripts.engram_hook '
        f"--event {event}"
    )


def install(server_dir: Path) -> None:
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    settings: dict = {}
    if SETTINGS_PATH.exists():
        try:
            settings = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            print(f"WARNING: {SETTINGS_PATH} is invalid JSON, leaving it alone")
            sys.exit(1)

    hooks = settings.setdefault("hooks", {})

    for event in EVENTS:
        # Claude Code's hook schema: hooks[event] is a list of hook entries.
        # Each entry has matchers + a command. We use a single matchall entry.
        existing = hooks.get(event, [])
        if not isinstance(existing, list):
            existing = []
        # Drop any prior NeuroVault hooks
        cleaned = [
            h for h in existing
            if HOOK_MARKER not in json.dumps(h)
        ]
        cleaned.append({
            "matcher": "",
            "hooks": [
                {
                    "type": "command",
                    "command": _hook_command(server_dir, event),
                }
            ],
        })
        hooks[event] = cleaned

    SETTINGS_PATH.write_text(json.dumps(settings, indent=2), encoding="utf-8")
    print(f"OK Installed NeuroVault hooks into {SETTINGS_PATH}")
    print(f"  Events: {', '.join(EVENTS)}")
    print(f"  Server dir: {server_dir}")
    print()
    print("Restart Claude Code for hooks to take effect.")
    print("Make sure the NeuroVault server is running:")
    print(f"  cd {server_dir} && uv run python -m engram_server")


def uninstall() -> None:
    if not SETTINGS_PATH.exists():
        print(f"Nothing to do — {SETTINGS_PATH} doesn't exist")
        return

    try:
        settings = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        print(f"WARNING: {SETTINGS_PATH} is invalid JSON")
        sys.exit(1)

    hooks = settings.get("hooks", {})
    removed = 0
    for event in list(hooks.keys()):
        before = hooks[event]
        if not isinstance(before, list):
            continue
        cleaned = [h for h in before if HOOK_MARKER not in json.dumps(h)]
        removed += len(before) - len(cleaned)
        if cleaned:
            hooks[event] = cleaned
        else:
            del hooks[event]

    SETTINGS_PATH.write_text(json.dumps(settings, indent=2), encoding="utf-8")
    print(f"OK Removed {removed} NeuroVault hook entries from {SETTINGS_PATH}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--uninstall", action="store_true", help="Remove NeuroVault hooks")
    parser.add_argument(
        "--server-dir",
        type=Path,
        default=Path(__file__).resolve().parent.parent,
        help="Path to the engram/server directory (auto-detected by default)",
    )
    args = parser.parse_args()

    if args.uninstall:
        uninstall()
    else:
        install(args.server_dir.resolve())
    return 0


if __name__ == "__main__":
    sys.exit(main())
