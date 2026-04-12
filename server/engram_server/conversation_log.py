"""Conversation logging — permanent record of every Claude exchange.

Saves full transcripts to raw/conversations/ so the user can later ask
"what did Claude tell me yesterday about X?" and get exact answers.

The transcript is also indexed via the normal ingestion pipeline, so
recall() finds conversation snippets alongside regular notes.
"""

import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from loguru import logger


def log_exchange(
    user_message: str,
    assistant_response: str,
    raw_dir: Path,
    metadata: dict | None = None,
) -> Path:
    """Save a single user/assistant exchange to raw/conversations/.

    Returns the path to the saved file.
    """
    conv_dir = raw_dir / "conversations"
    conv_dir.mkdir(parents=True, exist_ok=True)

    now = datetime.now(timezone.utc)
    date_str = now.strftime("%Y-%m-%d")
    time_str = now.strftime("%H%M%S")

    # One file per day, append turns
    filename = f"conv-{date_str}.md"
    filepath = conv_dir / filename

    turn_md = (
        f"\n\n## {time_str}\n\n"
        f"**User:** {user_message.strip()}\n\n"
        f"**Claude:** {assistant_response.strip()}\n"
    )
    if metadata:
        turn_md += f"\n*Context: {json.dumps(metadata)}*\n"

    if filepath.exists():
        with filepath.open("a", encoding="utf-8") as f:
            f.write(turn_md)
    else:
        header = f"# Conversation Log: {date_str}\n\n*All Claude exchanges from this day*\n"
        filepath.write_text(header + turn_md, encoding="utf-8")

    logger.debug("Logged conversation turn to {}", filename)
    return filepath


def search_conversations(raw_dir: Path, query: str, limit: int = 10) -> list[dict]:
    """Search conversation logs for a query (simple keyword search)."""
    conv_dir = raw_dir / "conversations"
    if not conv_dir.exists():
        return []

    results = []
    query_lower = query.lower()

    for filepath in sorted(conv_dir.glob("conv-*.md"), reverse=True):
        content = filepath.read_text(encoding="utf-8")
        if query_lower in content.lower():
            # Extract matching turns (## time blocks)
            turns = re.split(r'\n(?=## \d{6}\n)', content)
            for turn in turns:
                if query_lower in turn.lower():
                    results.append({
                        "date": filepath.stem.replace("conv-", ""),
                        "snippet": turn[:500],
                    })
                    if len(results) >= limit:
                        return results

    return results
