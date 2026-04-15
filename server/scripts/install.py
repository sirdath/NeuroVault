"""One-command NeuroVault installer.

Usage:
    cd engram/server
    uv run python -m scripts.install                  # full install
    uv run python -m scripts.install --no-claude      # skip Claude Desktop config
    uv run python -m scripts.install --no-hooks       # skip Claude Code hooks
    uv run python -m scripts.install --check          # dry-run, just report state

What it does:
    1. Verify Python version and uv are available
    2. Run `uv sync` in the server dir to install dependencies
    3. Create the default brain (if missing) by booting the server briefly
    4. Write Claude Desktop MCP config (~/.../claude_desktop_config.json)
       so Claude Desktop can talk to the NeuroVault server via stdio
    5. Install Claude Code lifecycle hooks (~/.claude/settings.json)
       so PostToolUse/SessionStart events flow into observations
    6. Print a "you're done" summary with the next steps

Idempotent: re-running is safe. Existing configs are merged, not overwritten.
The script never deletes anything you didn't put there.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path


SERVER_DIR = Path(__file__).resolve().parent.parent
NEUROVAULT_HOME = Path.home() / ".neurovault"
CLAUDE_CODE_SETTINGS = Path.home() / ".claude" / "settings.json"
HOOK_MARKER = "engram_hook"
HOOK_EVENTS = ("SessionStart", "UserPromptSubmit", "PostToolUse", "SessionEnd")


# Visual helpers — keep dependency-free
def _say(msg: str, ok: bool | None = None) -> None:
    prefix = "  " if ok is None else ("  OK   " if ok else "  FAIL ")
    print(f"{prefix}{msg}", flush=True)


def _section(title: str) -> None:
    print()
    print(f"== {title} ==", flush=True)


def _claude_desktop_config_path() -> Path:
    """Return the platform-specific Claude Desktop config path."""
    sys_name = platform.system()
    if sys_name == "Windows":
        appdata = os.environ.get("APPDATA")
        if appdata:
            return Path(appdata) / "Claude" / "claude_desktop_config.json"
    if sys_name == "Darwin":
        return Path.home() / "Library" / "Application Support" / "Claude" / "claude_desktop_config.json"
    # Linux
    return Path.home() / ".config" / "Claude" / "claude_desktop_config.json"


# --- Multi-editor MCP registry --------------------------------------------
#
# Each entry describes how to wire NeuroVault into one AI coding tool's
# MCP config. Tools that use the same `{"mcpServers": {...}}` schema as
# Claude Desktop only need a path; tools with different schemas get a
# custom merger function.

def _stdio_entry() -> dict:
    """The canonical stdio MCP server entry for NeuroVault."""
    return {
        "command": "uv",
        "args": [
            "--directory",
            str(SERVER_DIR),
            "run",
            "python",
            "-m",
            "neurovault_server",
        ],
    }


def _merge_mcp_servers_schema(existing: dict) -> tuple[dict, bool]:
    """Merge into `{"mcpServers": {"neurovault": {...}}}` (Claude/Cursor/Windsurf)."""
    entry = _stdio_entry()
    servers = existing.setdefault("mcpServers", {})
    if servers.get("neurovault") == entry:
        return existing, False
    servers["neurovault"] = entry
    return existing, True


def _merge_context_servers_schema(existing: dict) -> tuple[dict, bool]:
    """Merge into `{"context_servers": {"neurovault": {...}}}` (Zed)."""
    entry = {**_stdio_entry(), "source": "custom"}
    servers = existing.setdefault("context_servers", {})
    if servers.get("neurovault") == entry:
        return existing, False
    servers["neurovault"] = entry
    return existing, True


def _merge_continue_schema(existing: dict) -> tuple[dict, bool]:
    """Merge into `{"experimental": {"modelContextProtocolServers": [...]}}` (Continue.dev)."""
    experimental = existing.setdefault("experimental", {})
    servers = experimental.setdefault("modelContextProtocolServers", [])
    if not isinstance(servers, list):
        return existing, False
    wanted = {
        "transport": {
            "type": "stdio",
            **_stdio_entry(),
        }
    }
    for s in servers:
        if isinstance(s, dict) and s == wanted:
            return existing, False
    # Drop any prior NeuroVault entries before appending
    filtered = [
        s for s in servers
        if not (isinstance(s, dict) and "neurovault" in json.dumps(s))
    ]
    filtered.append(wanted)
    experimental["modelContextProtocolServers"] = filtered
    return existing, True


def _editor_platforms() -> list[dict]:
    """Return the list of detected editor MCP integration targets.

    Paths are resolved lazily so Windows/macOS/Linux differences come
    out cleanly. An entry with `config_path is None` is skipped.
    """
    home = Path.home()
    sys_name = platform.system()
    platforms: list[dict] = []

    # 1. Claude Desktop (already handled separately via step_claude_desktop,
    # but we still register it here so --list-platforms shows it)
    platforms.append({
        "name": "Claude Desktop",
        "config_path": _claude_desktop_config_path(),
        "merger": _merge_mcp_servers_schema,
        "handled_separately": True,
    })

    # 2. Cursor — global MCP config at ~/.cursor/mcp.json
    platforms.append({
        "name": "Cursor",
        "config_path": home / ".cursor" / "mcp.json",
        "merger": _merge_mcp_servers_schema,
    })

    # 3. Windsurf (Codeium) — ~/.codeium/windsurf/mcp_config.json
    platforms.append({
        "name": "Windsurf",
        "config_path": home / ".codeium" / "windsurf" / "mcp_config.json",
        "merger": _merge_mcp_servers_schema,
    })

    # 4. Zed — uses context_servers inside the main settings.json
    if sys_name == "Windows":
        zed_path = Path(os.environ.get("APPDATA", "")) / "Zed" / "settings.json"
    elif sys_name == "Darwin":
        zed_path = home / "Library" / "Application Support" / "Zed" / "settings.json"
    else:
        zed_path = home / ".config" / "zed" / "settings.json"
    platforms.append({
        "name": "Zed",
        "config_path": zed_path,
        "merger": _merge_context_servers_schema,
    })

    # 5. Continue.dev — ~/.continue/config.json with experimental key
    platforms.append({
        "name": "Continue.dev",
        "config_path": home / ".continue" / "config.json",
        "merger": _merge_continue_schema,
    })

    # 6. OpenCode — ~/.opencode/config.json uses mcpServers schema
    platforms.append({
        "name": "OpenCode",
        "config_path": home / ".opencode" / "config.json",
        "merger": _merge_mcp_servers_schema,
    })

    # 7. Codex CLI (OpenAI) — skipped by default: config is TOML, not JSON.
    # When the user has Codex installed, they can add the server manually
    # by copying the entry we print in the summary.

    return platforms


# --- Step 1: prerequisites -------------------------------------------------

def step_prereqs(check_only: bool) -> bool:
    _section("Step 1: prerequisites")
    py = sys.version_info
    py_ok = py >= (3, 13)
    _say(f"Python {py.major}.{py.minor}.{py.micro}  (need >= 3.13)", ok=py_ok)
    if not py_ok:
        return False

    uv_path = shutil.which("uv")
    _say(f"uv: {uv_path or 'NOT FOUND — install from https://github.com/astral-sh/uv'}", ok=bool(uv_path))
    return bool(uv_path)


# --- Step 2: dependencies --------------------------------------------------

def step_sync(check_only: bool) -> bool:
    _section("Step 2: install Python dependencies")
    if check_only:
        _say(f"would run: uv sync (in {SERVER_DIR})")
        return True
    try:
        result = subprocess.run(
            ["uv", "sync"],
            cwd=str(SERVER_DIR),
            capture_output=True,
            text=True,
            timeout=600,
        )
        if result.returncode != 0:
            _say(f"uv sync failed: {result.stderr.strip()[:300]}", ok=False)
            return False
        _say("uv sync OK", ok=True)
        return True
    except FileNotFoundError:
        _say("uv not found in PATH", ok=False)
        return False
    except subprocess.TimeoutExpired:
        _say("uv sync timed out after 10 minutes", ok=False)
        return False


# --- Step 3: default brain --------------------------------------------------

def step_brain(check_only: bool) -> bool:
    _section("Step 3: ensure default brain")
    brains_dir = NEUROVAULT_HOME / "brains"
    default_brain = brains_dir / "default"
    if default_brain.exists():
        _say(f"default brain already exists at {default_brain}", ok=True)
        return True

    if check_only:
        _say(f"would create {default_brain}")
        return True

    try:
        # Boot server briefly so it migrates / creates the default brain.
        subprocess.run(
            ["uv", "run", "python", "-c",
             "from neurovault_server.brain import BrainManager; BrainManager().get_active(); print('ok')"],
            cwd=str(SERVER_DIR),
            capture_output=True,
            text=True,
            timeout=180,
        )
    except Exception as e:
        _say(f"brain init exception: {e}", ok=False)
        return False

    if default_brain.exists():
        _say(f"created default brain at {default_brain}", ok=True)
        return True
    _say("default brain still missing after init", ok=False)
    return False


# --- Step 4: Claude Desktop MCP config --------------------------------------

def step_claude_desktop(check_only: bool) -> bool:
    _section("Step 4: Claude Desktop MCP config")
    config_path = _claude_desktop_config_path()
    _say(f"target: {config_path}")

    if not config_path.parent.exists():
        _say(f"Claude Desktop config directory missing — is Claude Desktop installed?", ok=False)
        _say(f"  expected: {config_path.parent}")
        return False

    config: dict = {}
    if config_path.exists():
        try:
            config = json.loads(config_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            _say(f"existing config is invalid JSON, refusing to touch it", ok=False)
            return False

    mcp_servers = config.setdefault("mcpServers", {})
    server_entry = {
        "command": "uv",
        "args": [
            "--directory",
            str(SERVER_DIR),
            "run",
            "python",
            "-m",
            "neurovault_server",
        ],
    }

    if mcp_servers.get("neurovault") == server_entry:
        _say("neurovault already configured (no change)", ok=True)
        return True

    if check_only:
        _say(f"would add 'neurovault' MCP server entry pointing to {SERVER_DIR}")
        return True

    mcp_servers["neurovault"] = server_entry
    config_path.write_text(json.dumps(config, indent=2), encoding="utf-8")
    _say(f"installed neurovault MCP server entry", ok=True)
    return True


# --- Step 4b: other editors (Cursor, Windsurf, Zed, Continue, OpenCode) --

def step_editors(check_only: bool) -> bool:
    """Install the NeuroVault MCP entry into every other AI editor we
    detect. Skips editors whose config directory doesn't exist (so we
    don't create random folders on someone's disk just because their
    operating system has a standard path)."""
    _section("Step 4b: other AI editors")

    any_installed = False
    for plat in _editor_platforms():
        if plat.get("handled_separately"):
            continue

        name = plat["name"]
        path: Path = plat["config_path"]
        merger = plat["merger"]

        # Skip if the editor isn't installed — we detect by the parent
        # directory's existence. This is conservative: we never create
        # config directories for editors the user doesn't use.
        if not path.parent.exists():
            _say(f"{name}: not detected (no {path.parent})", ok=None)
            continue

        # Read existing config (may be empty / missing)
        config: dict = {}
        if path.exists():
            try:
                raw = path.read_text(encoding="utf-8")
                config = json.loads(raw) if raw.strip() else {}
            except json.JSONDecodeError:
                _say(f"{name}: {path} is invalid JSON, skipping", ok=False)
                continue
            except Exception as e:
                _say(f"{name}: read error: {e}", ok=False)
                continue

        try:
            merged, changed = merger(config)
        except Exception as e:
            _say(f"{name}: merge error: {e}", ok=False)
            continue

        if not changed:
            _say(f"{name}: already configured ({path})", ok=True)
            any_installed = True
            continue

        if check_only:
            _say(f"{name}: would install into {path}")
            any_installed = True
            continue

        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(merged, indent=2), encoding="utf-8")
        except Exception as e:
            _say(f"{name}: write error: {e}", ok=False)
            continue

        _say(f"{name}: installed into {path}", ok=True)
        any_installed = True

    if not any_installed:
        _say("no other editors detected — only Claude Desktop configured")
    return True


# --- Step 5: Claude Code lifecycle hooks ------------------------------------

def step_hooks(check_only: bool) -> bool:
    _section("Step 5: Claude Code lifecycle hooks")
    _say(f"target: {CLAUDE_CODE_SETTINGS}")

    settings: dict = {}
    if CLAUDE_CODE_SETTINGS.exists():
        try:
            settings = json.loads(CLAUDE_CODE_SETTINGS.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            _say("existing settings.json invalid, refusing to touch it", ok=False)
            return False

    hooks = settings.setdefault("hooks", {})
    cmd_template = (
        f'uv --directory "{SERVER_DIR}" run python -m scripts.engram_hook --event {{event}}'
    )

    changed = False
    for event in HOOK_EVENTS:
        existing = hooks.get(event, [])
        if not isinstance(existing, list):
            existing = []
        # Drop any prior NeuroVault hooks so we get a clean replace
        cleaned = [h for h in existing if HOOK_MARKER not in json.dumps(h)]
        new_entry = {
            "matcher": "",
            "hooks": [
                {
                    "type": "command",
                    "command": cmd_template.format(event=event),
                }
            ],
        }
        cleaned.append(new_entry)
        if hooks.get(event) != cleaned:
            changed = True
        hooks[event] = cleaned

    if not changed:
        _say("hooks already installed (no change)", ok=True)
        return True

    if check_only:
        _say(f"would install hooks for: {', '.join(HOOK_EVENTS)}")
        return True

    CLAUDE_CODE_SETTINGS.parent.mkdir(parents=True, exist_ok=True)
    CLAUDE_CODE_SETTINGS.write_text(json.dumps(settings, indent=2), encoding="utf-8")
    _say(f"installed lifecycle hooks for: {', '.join(HOOK_EVENTS)}", ok=True)
    return True


# --- Step 6: summary --------------------------------------------------------

def print_summary(
    install_claude_desktop: bool,
    install_hooks: bool,
    install_editors: bool,
) -> None:
    _section("All done")
    print()
    print("NeuroVault is installed. To start using it:")
    print()
    print("  1. Start the server (from another terminal):")
    print(f"       cd {SERVER_DIR}")
    print(f"       uv run python -m neurovault_server")
    print()
    if install_claude_desktop:
        print("  2. Restart Claude Desktop. The 'neurovault' MCP server should appear")
        print("     in the tool picker — you'll have 37 NeuroVault tools available.")
        print()
    if install_editors:
        print("  3. Restart any other AI editors we detected (Cursor, Windsurf, Zed,")
        print("     Continue.dev, OpenCode). They'll see 'neurovault' in the MCP list.")
        print()
    if install_hooks:
        print("  4. Restart Claude Code. Lifecycle hooks will start auto-capturing")
        print("     PostToolUse events into your default brain as 'observations'.")
        print()
    print("  5. (Optional) Launch the desktop app:")
    print(f"       cd {SERVER_DIR.parent}")
    print(f"       cargo tauri dev")
    print()
    print("  6. To uninstall hooks later:")
    print(f"       uv run python -m scripts.install_hooks --uninstall")
    print()
    print("  Manual setup for Codex CLI (TOML config — skipped automatically):")
    print("       Add this to ~/.codex/config.toml under [mcp_servers.neurovault]:")
    print(f'         command = "uv"')
    print(f'         args = ["--directory", "{SERVER_DIR}", "run", "python", "-m", "neurovault_server"]')
    print()


# --- Main -------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description="One-command NeuroVault installer")
    parser.add_argument("--no-claude", action="store_true", help="Skip Claude Desktop MCP config")
    parser.add_argument("--no-editors", action="store_true", help="Skip Cursor/Windsurf/Zed/Continue/OpenCode configs")
    parser.add_argument("--no-hooks", action="store_true", help="Skip Claude Code lifecycle hooks")
    parser.add_argument("--check", action="store_true", help="Dry-run; print actions without writing anything")
    parser.add_argument("--list-platforms", action="store_true", help="List every editor integration and its expected config path")
    args = parser.parse_args()

    print("=" * 60)
    print("  NeuroVault installer")
    print("=" * 60)

    if args.list_platforms:
        _section("Supported editor platforms")
        for plat in _editor_platforms():
            path = plat["config_path"]
            exists = "yes" if path.parent.exists() else " no"
            marker = " (handled separately)" if plat.get("handled_separately") else ""
            print(f"  [{exists}] {plat['name']:<16} -> {path}{marker}")
        print()
        print("  Codex CLI         -> ~/.codex/config.toml (manual, TOML format)")
        print()
        return 0

    install_claude_desktop = not args.no_claude
    install_editors = not args.no_editors
    install_hooks = not args.no_hooks

    if not step_prereqs(args.check):
        return 1
    if not step_sync(args.check):
        return 1
    if not step_brain(args.check):
        return 1
    if install_claude_desktop:
        # Don't fail the install if Claude Desktop isn't present — just warn
        step_claude_desktop(args.check)
    if install_editors:
        step_editors(args.check)
    if install_hooks:
        step_hooks(args.check)

    print_summary(install_claude_desktop, install_hooks, install_editors)
    return 0


if __name__ == "__main__":
    sys.exit(main())
