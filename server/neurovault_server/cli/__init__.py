"""CLI wrappers for advanced features, invoked per-job by the Tauri
`run_python_job` command.

Each module in this package exports `main(argv: list[str]) -> int`.
The contract:

  * Args come in as a JSON blob on stdin (NOT positional argv) —
    keeps cross-platform escaping trivial regardless of how the
    parent process spawns us.
  * Results come out as a JSON blob on stdout.
  * Human-readable log lines go to stderr (loguru's default) so they
    don't contaminate the stdout JSON the Rust caller parses.
  * Exit code 0 = success, non-zero = failure.

This is the shape `src-tauri/src/lib.rs::run_python_job` expects.
"""
