"""Entry point for `python -m neurovault_server`.

Two modes:

  * No args  → launch the full MCP + HTTP server (legacy behaviour).
                Used by the Tauri sidecar + any dev who runs
                `uv run python -m neurovault_server` directly.

  * `<subcommand> [args...]` → run one CLI wrapper and exit.
                Used by the Rust Tauri command `run_python_job`
                during the Python-as-subprocess migration. Each
                subcommand is a thin wrapper over an existing
                module (compilation, pdf ingest, code graph, etc.)
                that reads JSON args from stdin, runs the job, and
                writes a JSON result to stdout.

Keeping both modes in one binary means the packaged PyInstaller
sidecar stays the same artifact for now — the subprocess
workflow uses it via `neurovault-server.exe compile`. After
Phase 9 drops the sidecar, the same entry points get called via
a plain `python -m neurovault_server.cli.compile` invocation
on a user-installed Python.
"""

from __future__ import annotations

import sys


def _dispatch_cli(subcmd: str, argv: list[str]) -> int:
    """Look up `subcmd` in `neurovault_server.cli` and run it.

    Each CLI module exports a `main(argv: list[str]) -> int` that
    returns a process exit code. Missing subcommands print a
    friendly error and exit non-zero so the Rust caller can report
    a clean message to the user instead of a cryptic traceback.
    """
    try:
        # Import lazily — pulling cli.<name> at module top would
        # load every advanced-feature module unconditionally, which
        # defeats the whole point of the subprocess-on-demand model.
        module = __import__(
            f"neurovault_server.cli.{subcmd}",
            fromlist=["main"],
        )
    except ModuleNotFoundError:
        sys.stderr.write(
            f"[neurovault] unknown subcommand: {subcmd}\n"
            f"Available: compile, pdf, zotero, code_ingest\n"
        )
        return 2
    except Exception as e:
        sys.stderr.write(f"[neurovault] error loading {subcmd}: {e}\n")
        return 3

    main = getattr(module, "main", None)
    if not callable(main):
        sys.stderr.write(
            f"[neurovault] {subcmd} module has no callable `main(argv)`\n"
        )
        return 4

    try:
        return int(main(argv) or 0)
    except SystemExit as e:
        return int(e.code or 0)
    except Exception as e:
        sys.stderr.write(f"[neurovault] {subcmd} failed: {e}\n")
        return 1


def main() -> int:
    argv = sys.argv[1:]
    # Preserve the legacy `--http-only`, `--mcp-only`, and no-arg
    # behaviours by routing any flag-style arg (starts with `-`) or
    # an empty list to the server entry point. CLI subcommands use
    # bare names: `compile`, `pdf`, etc.
    if not argv or argv[0].startswith("-"):
        from neurovault_server.server import main as server_main
        server_main()
        return 0

    subcmd = argv[0]
    rest = argv[1:]
    return _dispatch_cli(subcmd, rest)


if __name__ == "__main__":
    raise SystemExit(main())
