"""NeuroVault terminal logo — figlet (ANSI Regular) in Claude-Code peachy-orange.

The figlet output is rendered with pyfiglet at runtime, so the logo stays
in sync with the published font — no hand-drawn box characters.

Colors match Claude Code's signature palette:
  - xterm-216 (#FFAF87) for in-terminal ANSI output
  - brand peach #DE7356 for the README SVG

Usage:
    pip install pyfiglet rich
    python scripts/neurovault_logo.py
"""
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from pyfiglet import Figlet
from rich.console import Console
from rich.text import Text


PEACH = "#DE7356"         # Claude brand primary
PEACH_BRIGHT = "#FFAF87"  # xterm-216, what Claude Code actually emits
TAGLINE = "local-first AI memory  ✻"


def print_neurovault_logo() -> None:
    console = Console()
    figlet = Figlet(font="ansi_regular", width=200)

    lines = [l.rstrip() for l in figlet.renderText("NEUROVAULT").split("\n")]
    while lines and not lines[0]:
        lines.pop(0)
    while lines and not lines[-1]:
        lines.pop()

    console.print()
    for line in lines:
        console.print(Text(line, style=f"bold {PEACH}"))
    console.print()
    console.print(Text(f"  {TAGLINE}", style=PEACH_BRIGHT))
    console.print()


if __name__ == "__main__":
    print_neurovault_logo()
