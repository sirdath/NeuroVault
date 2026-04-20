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


NEURO = [
    " ╭───────╮  ╭───────╮  ╭───────╮  ╭───────╮  ╭───────╮ ",
    " │ █   █ │  │ █████ │  │ █   █ │  │ ████  │  │ █████ │ ",
    " │ ██  █ │  │ █ ╰───╯  │ █   █ │  │ █   █ │  │ █   █ │ ",
    " │ █ █ █ │  │ ████  │  │ █   █ │  │ ████  │  │ █   █ │ ",
    " │ █  ██ │  │ █ ╭───╮  │ █   █ │  │ █  █  │  │ █   █ │ ",
    " │ █   █ │  │ █████ │  │ █████ │  │ █   █ │  │ █████ │ ",
    " ╰───────╯  ╰───────╯  ╰───────╯  ╰───────╯  ╰───────╯ ",
]

VAULT = [
    " ╭───────╮  ╭───────╮  ╭───────╮  ╭───────╮  ╭───────╮ ",
    " │ █   █ │  │  ███  │  │ █   █ │  │ █     │  │ █████ │ ",
    " │ █   █ │  │ █   █ │  │ █   █ │  │ █     │  ╰─╮ █ ╭─╯ ",
    " │ █   █ │  │ █████ │  │ █   █ │  │ █     │    │ █ │   ",
    " │  █ █  │  │ █   █ │  │ █   █ │  │ █ ╭───╮    │ █ │   ",
    " │   █   │  │ █   █ │  │ █████ │  │ █████ │    │ █ │   ",
    " ╰───────╯  ╰───────╯  ╰───────╯  ╰───────╯    ╰───╯   ",
]

GAP = "    "

# Gradient approximating the SVG (peachy-orange shading left-to-right)
GRADIENT = ["#E39173", "#DE8767", "#D97B59", "#D0714F", "#C46A45"]


def _render(line: str) -> Text:
    """Render one character-row with a left-to-right peachy gradient."""
    text = Text()
    if not line:
        return text
    bins = len(GRADIENT)
    stride = max(1, len(line) // bins)
    for i, ch in enumerate(line):
        color = GRADIENT[min(i // stride, bins - 1)]
        text.append(ch, style=color)
    return text


def print_neurovault_logo() -> None:
    console = Console()
    console.print()
    for n_row, v_row in zip(NEURO, VAULT):
        console.print(_render(n_row + GAP + v_row))
    console.print()


if __name__ == "__main__":
    print_neurovault_logo()