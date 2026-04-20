"""NeuroVault terminal logo — block-and-wire ASCII in Claude Code peachy-orange.

Usage:
    pip install rich
    python scripts/neurovault_logo.py
"""
import sys

# Force UTF-8 so Windows cp1252 terminals can render the box-drawing chars.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from rich.console import Console
from rich.text import Text


def print_neurovault_logo() -> None:
    console = Console()

    # Signature Claude Code peachy-orange
    color = "#D97B59"

    # Row 1: NEURO
    row1 = [
        " ╭───────╮  ╭───────╮  ╭───────╮  ╭───────╮  ╭───────╮ ",
        " │ █   █ │  │ █████ │  │ █   █ │  │ ████  │  │ █████ │ ",
        " │ ██  █ │  │ █ ╰───╯  │ █   █ │  │ █   █ │  │ █   █ │ ",
        " │ █ █ █ │  │ ████  │  │ █   █ │  │ ████  │  │ █   █ │ ",
        " │ █  ██ │  │ █ ╭───╮  │ █   █ │  │ █  █  │  │ █   █ │ ",
        " │ █   █ │  │ █████ │  │ █████ │  │ █   █ │  │ █████ │ ",
        " ╰───────╯  ╰───────╯  ╰───────╯  ╰───────╯  ╰───────╯ ",
    ]

    # Row 2: VAULT
    row2 = [
        " ╭───────╮  ╭───────╮  ╭───────╮  ╭───────╮  ╭───────╮ ",
        " │ █   █ │  │  ███  │  │ █   █ │  │ █     │  │ █████ │ ",
        " │ █   █ │  │ █   █ │  │ █   █ │  │ █     │  ╰─╮ █ ╭─╯ ",
        " │ █   █ │  │ █████ │  │ █   █ │  │ █     │    │ █ │   ",
        " │  █ █  │  │ █   █ │  │ █   █ │  │ █ ╭───╮    │ █ │   ",
        " │   █   │  │ █   █ │  │ █████ │  │ █████ │    │ █ │   ",
        " ╰───────╯  ╰───────╯  ╰───────╯  ╰───────╯    ╰───╯   ",
    ]

    console.print("\n")

    for line in row1:
        console.print(Text(line, style=color))

    console.print()

    for line in row2:
        console.print(Text(line, style=color))

    console.print("\n")


if __name__ == "__main__":
    print_neurovault_logo()