"""Build ExperienceUnits for the Local Memory Curator benchmark.

Reads Claude Code session transcripts (JSONL under ``~/.claude/projects``) and
emits bounded, redacted transcript slices ("ExperienceUnits") that the curator
benchmark labels and scores against.

An ExperienceUnit is *not* a whole session. It is a few consecutive turns of
one session (~2,000-4,000 approximate tokens) rendered as a readable
interleaved transcript with role markers -- the same bounded slice the real
curator would see at runtime. Bulk tool_result payloads (file dumps, command
output) are deliberately excluded: they swamp the signal and the real curator
gets bounded evidence, not raw dumps.

Everything written by this script is LOCAL-ONLY. `eval/curator/.gitignore`
keeps `units/` out of git; keep it that way.

Usage:
    python3 eval/curator/build_units.py                     # default run
    python3 eval/curator/build_units.py --target 100        # how many units
    python3 eval/curator/build_units.py --dry-run           # stats, no writes
    python3 eval/curator/build_units.py --exclude-project ATH-FAMILY

No external deps -- stdlib only, matching the rest of `eval/`.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

CHARS_PER_TOKEN = 4  # crude approximation; avoids a tokenizer dependency

DEFAULT_PROJECTS_DIR = Path.home() / ".claude" / "projects"

# Private-by-name source paths are never read at all.
PRIVATE_MARKERS = ("_private", ".private")

# Wrapper text the CLI injects into the user role. None of it is something the
# user actually said, so it must not become curator "evidence".
META_PREFIXES = (
    "<system-reminder>",
    "<command-name>",
    "<command-message>",
    "<command-args>",
    "<local-command-stdout>",
    "<local-command-stderr>",
    "<local-command-caveat>",
    "<ide_opened_file>",
    "<ide_selection>",
    "<task-notification>",
    "<user-prompt-submit-hook>",
    "<bash-input>",
    "<bash-stdout>",
    "<bash-stderr>",
    "<summary>",
    "[Request interrupted",
    "[Image:",
    "[We're continuing an earlier conversation",
    "Caveat: The messages below",
    "This session is being continued from a previous",
    "API Error",
)

SYSTEM_REMINDER_RE = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)

# Short assistant-role lines the CLI emits that are not the model talking
# (quota notices, empty-turn placeholders). Dropped when the block is short.
ASSISTANT_NOISE = (
    "You've hit your monthly spend limit",
    "You've reached your",
    "No response requested",
    "Claude Code is unable",
    "(no content)",
    "[Request interrupted",
)
ASSISTANT_NOISE_MAX_CHARS = 220

# ---------------------------------------------------------------------------
# Redaction
# ---------------------------------------------------------------------------


def _looks_like_base64(token: str) -> bool:
    """Guard the base64 rule against long path/word false positives."""
    body = token.rstrip("=")
    if "/" in body and not token.endswith("="):
        return False
    has_digit = any(c.isdigit() for c in body)
    has_upper = any(c.isupper() for c in body)
    has_lower = any(c.islower() for c in body)
    return has_digit and has_upper and has_lower


# (label, pattern, group-to-keep-prefix, validator)
REDACTION_RULES: list[tuple[str, re.Pattern[str], Any]] = [
    (
        "PRIVATE_KEY",
        re.compile(
            r"-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----.*?"
            r"-----END [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----",
            re.S,
        ),
        None,
    ),
    ("ANTHROPIC_KEY", re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{12,}"), None),
    ("API_KEY", re.compile(r"\bsk-[A-Za-z0-9_\-]{16,}"), None),
    ("GITHUB_TOKEN", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}"), None),
    ("GITHUB_TOKEN", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"), None),
    ("SLACK_TOKEN", re.compile(r"\bxox[abposr]-[A-Za-z0-9\-]{10,}"), None),
    ("AWS_KEY", re.compile(r"\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{12,20}\b"), None),
    ("GOOGLE_API_KEY", re.compile(r"\bAIza[0-9A-Za-z_\-]{30,}"), None),
    (
        "JWT",
        re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}"),
        None,
    ),
    ("BEARER", re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._\-]{20,}"), None),
    (
        # password=… / token: "…" / api_key=… — keep the key name, drop the value.
        "CREDENTIAL",
        re.compile(
            r"(?i)\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?key|"
            r"auth[_-]?token|client[_-]?secret|token)\b\s*[=:]\s*"
            r"[\"']?([^\s\"',;:){}]{6,})[\"']?"
        ),
        None,
    ),
    ("BASE64", re.compile(r"\b[A-Za-z0-9+/]{40,}={0,2}"), _looks_like_base64),
    ("HEX", re.compile(r"\b[0-9a-fA-F]{32,}\b"), None),
]


# Optional (--redact-contact): not secrets, but contact details that can leak
# into a transcript. Off by default so redaction counts stay meaningful.
CONTACT_RULES: list[tuple[str, re.Pattern[str], Any]] = [
    ("EMAIL", re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b"), None),
    ("PHONE", re.compile(r"\+\d[\d\s\-().]{8,}\d"), None),
    ("PHONE", re.compile(r"(?<![\w.])0\d{9,10}(?![\w.])"), None),
    ("POSTCODE", re.compile(r"\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b"), None),
]


def redact(text: str, contact: bool = False) -> tuple[str, Counter]:
    """Scrub obvious secrets. Returns (clean_text, {label: count})."""
    counts: Counter = Counter()
    rules = REDACTION_RULES + (CONTACT_RULES if contact else [])

    for label, pattern, validator in rules:

        def _sub(match: re.Match[str], _label: str = label, _v=validator) -> str:
            whole = match.group(0)
            if _v is not None and not _v(whole):
                return whole
            counts[_label] += 1
            if _label == "CREDENTIAL":
                # keep the key name so the sentence still reads
                return f"{match.group(1)}=[REDACTED:{_label}]"
            return f"[REDACTED:{_label}]"

        text = pattern.sub(_sub, text)

    return text, counts


# ---------------------------------------------------------------------------
# Durable-content heuristics
# ---------------------------------------------------------------------------

# Phrases that tend to precede a durable fact / preference / decision.
DURABLE_PATTERNS: list[tuple[str, re.Pattern[str], float]] = [
    ("decided", re.compile(r"(?i)\b(decided|decision|we decided|i've decided)\b"), 2.0),
    ("lets_use", re.compile(r"(?i)\blet'?s\s+(use|go with|switch to|stick with)\b"), 2.0),
    ("i_prefer", re.compile(r"(?i)\bi\s+(prefer|like|want|hate|don'?t like)\b"), 2.0),
    ("from_now_on", re.compile(r"(?i)\b(from now on|going forward|in future|always)\b"), 2.0),
    ("remember", re.compile(r"(?i)\b(remember (this|that)|save this|write this down|note that)\b"), 2.0),
    ("instead_of", re.compile(r"(?i)\binstead of\b"), 1.0),
    ("never_dont", re.compile(r"(?i)\b(never|don'?t ever|do not ever|stop using)\b"), 1.0),
    ("rule", re.compile(r"(?i)\b(the rule is|hard rule|convention|policy|by default we)\b"), 1.5),
    ("we_use", re.compile(r"(?i)\b(we use|we're using|our stack|the canonical|source of truth)\b"), 1.5),
    ("because", re.compile(r"(?i)\b(the reason|because we|rationale|trade-?off)\b"), 1.0),
    ("version", re.compile(r"(?i)\b[a-z][a-z0-9_\-\.]{1,20}\s+v?\d+\.\d+(\.\d+)?\b"), 0.5),
]

MAX_VERSION_CREDIT = 1.5


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass
class Turn:
    role: str  # USER | ASSISTANT | TOOL
    kind: str  # text | tool_use | tool_result
    text: str  # already-rendered display line(s)
    ts: str  # ISO timestamp or ""
    user_chars: int = 0  # chars attributable to the human


@dataclass
class Unit:
    unit_id: str
    session_id: str
    project: str
    approx_tokens: int
    created_range: dict[str, str]
    text: str
    # --- benchmark metadata (additive; the six fields above are the contract) --
    source_file: str = ""
    n_turns: int = 0
    user_turns: int = 0
    user_chars: int = 0
    tool_lines: int = 0
    redactions: dict[str, int] = field(default_factory=dict)
    redaction_count: int = 0
    heuristic_label: str = "neutral"
    heuristic_score: float = 0.0
    heuristic_terms: list[str] = field(default_factory=list)
    session_date: str = ""

    def to_json(self) -> dict[str, Any]:
        return {
            "unit_id": self.unit_id,
            "session_id": self.session_id,
            "project": self.project,
            "approx_tokens": self.approx_tokens,
            "created_range": self.created_range,
            "text": self.text,
            "meta": {
                "source_file": self.source_file,
                "session_date": self.session_date,
                "n_turns": self.n_turns,
                "user_turns": self.user_turns,
                "user_chars": self.user_chars,
                "tool_lines": self.tool_lines,
                "redactions": self.redactions,
                "redaction_count": self.redaction_count,
                "heuristic_label": self.heuristic_label,
                "heuristic_score": round(self.heuristic_score, 2),
                "heuristic_terms": self.heuristic_terms,
            },
        }


# ---------------------------------------------------------------------------
# Defensive JSONL reading
# ---------------------------------------------------------------------------


@dataclass
class ReadStats:
    files: int = 0
    lines: int = 0
    unparseable: int = 0
    oversized_lines: int = 0
    truncated_files: int = 0


def iter_json_lines(
    path: Path, max_line_bytes: int, max_bytes: int, stats: ReadStats
) -> Iterator[dict[str, Any]]:
    """Stream JSON objects out of a JSONL file without ever buffering a huge line.

    Session transcripts reach hundreds of MB (embedded images, giant tool
    results). A naive readline() would happily pull a 300 MB line into RAM.
    """
    buf = b""
    consumed = 0
    skipping = False
    try:
        with path.open("rb") as fh:
            while True:
                chunk = fh.read(1 << 20)
                if not chunk:
                    break
                consumed += len(chunk)
                buf += chunk
                while True:
                    nl = buf.find(b"\n")
                    if nl == -1:
                        break
                    raw, buf = buf[:nl], buf[nl + 1 :]
                    if skipping:
                        skipping = False
                        continue
                    stats.lines += 1
                    raw = raw.strip()
                    if not raw:
                        continue
                    try:
                        obj = json.loads(raw)
                    except Exception:
                        stats.unparseable += 1
                        continue
                    if isinstance(obj, dict):
                        yield obj
                    else:
                        stats.unparseable += 1
                if len(buf) > max_line_bytes:
                    # Oversized line: drop everything up to the next newline.
                    stats.oversized_lines += 1
                    buf = b""
                    skipping = True
                if consumed >= max_bytes:
                    stats.truncated_files += 1
                    return
            if buf.strip() and not skipping:
                stats.lines += 1
                try:
                    obj = json.loads(buf.strip())
                    if isinstance(obj, dict):
                        yield obj
                except Exception:
                    stats.unparseable += 1
    except OSError:
        return


# ---------------------------------------------------------------------------
# Record -> Turn rendering
# ---------------------------------------------------------------------------


def _clean_user_text(text: str) -> str:
    text = SYSTEM_REMINDER_RE.sub("", text).strip()
    if not text:
        return ""
    for prefix in META_PREFIXES:
        if text.startswith(prefix):
            return ""
    return text


def _tool_digest(name: str, params: Any, limit: int = 180) -> str:
    """One-line summary of a tool call -- never the full payload."""
    if not isinstance(params, dict):
        return ""
    for key in (
        "command",
        "file_path",
        "path",
        "pattern",
        "query",
        "description",
        "prompt",
        "content",
        "url",
        "notebook_path",
        "skill",
    ):
        val = params.get(key)
        if isinstance(val, str) and val.strip():
            digest = " ".join(val.split())
            return digest[:limit]
    try:
        return " ".join(json.dumps(params).split())[:limit]
    except Exception:
        return ""


def _tool_result_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for blk in content:
            if isinstance(blk, dict) and blk.get("type") == "text":
                parts.append(blk.get("text", ""))
            elif isinstance(blk, dict) and blk.get("type") == "image":
                parts.append("[image]")
        return "\n".join(parts)
    return ""


def extract_turns(
    records: Iterator[dict[str, Any]],
    tool_result_max_chars: int,
    max_turn_chars: int,
    include_sidechain: bool,
) -> Iterator[Turn]:
    """Flatten transcript records into display turns.

    Kept: user text, assistant text, short tool-call summaries, short tool
    results. Dropped: thinking blocks, bulk tool_result payloads, CLI wrapper
    messages, attachments, snapshots and other non-conversational records.
    """
    for rec in records:
        rtype = rec.get("type")
        if rtype not in ("user", "assistant"):
            continue
        if rec.get("isMeta"):
            continue
        if rec.get("isSidechain") and not include_sidechain:
            continue
        msg = rec.get("message")
        if not isinstance(msg, dict):
            continue
        role = msg.get("role") or rtype
        content = msg.get("content")
        if isinstance(content, str):
            blocks: list[Any] = [{"type": "text", "text": content}]
        elif isinstance(content, list):
            blocks = content
        else:
            continue
        ts = rec.get("timestamp") or ""

        for blk in blocks:
            if not isinstance(blk, dict):
                continue
            btype = blk.get("type")

            if btype == "text":
                text = blk.get("text") or ""
                if role == "user":
                    text = _clean_user_text(text)
                    if not text:
                        continue
                    text = text[:max_turn_chars]
                    yield Turn("USER", "text", f"USER: {text}", ts, user_chars=len(text))
                else:
                    text = text.strip()
                    if not text:
                        continue
                    if len(text) <= ASSISTANT_NOISE_MAX_CHARS and any(
                        marker in text for marker in ASSISTANT_NOISE
                    ):
                        continue
                    text = text[:max_turn_chars]
                    yield Turn("ASSISTANT", "text", f"ASSISTANT: {text}", ts)

            elif btype == "tool_use":
                name = blk.get("name") or "tool"
                digest = _tool_digest(name, blk.get("input"))
                line = f"ASSISTANT [tool:{name}] {digest}".rstrip()
                yield Turn("ASSISTANT", "tool_use", line, ts)

            elif btype == "tool_result":
                body = _tool_result_text(blk.get("content"))
                body = SYSTEM_REMINDER_RE.sub("", body).strip()
                if body.startswith("<system-reminder>"):
                    # unterminated reminder: keep whatever follows it, if any
                    body = body.split("</system-reminder>", 1)[-1].strip()
                if not body:
                    continue
                if len(body) > tool_result_max_chars:
                    # Bulk payload: keep the fact that it happened, not the dump.
                    head = " ".join(body[:120].split())
                    line = (
                        f"TOOL_RESULT: [{len(body)} chars omitted] {head}…"
                    )
                else:
                    line = "TOOL_RESULT: " + " ".join(body.split())
                yield Turn("TOOL", "tool_result", line, ts)

            # thinking / image / other block types are intentionally dropped


# ---------------------------------------------------------------------------
# Turn -> Unit grouping
# ---------------------------------------------------------------------------


def approx_tokens(text: str) -> int:
    return max(1, len(text) // CHARS_PER_TOKEN)


def group_units(
    turns: list[Turn], min_tokens: int, max_tokens: int, floor_tokens: int
) -> Iterator[tuple[list[Turn], int]]:
    """Group consecutive turns into ~min..max token units.

    Prefers to start a new unit on a USER turn once the buffer is big enough,
    so a unit reads as "a request and what happened next" rather than an
    arbitrary cut.
    """
    buf: list[Turn] = []
    buf_tokens = 0
    start_index = 0
    index = 0

    def flush() -> tuple[list[Turn], int] | None:
        nonlocal buf, buf_tokens, start_index
        out = (buf, start_index) if buf_tokens >= floor_tokens else None
        start_index = index
        buf, buf_tokens = [], 0
        return out

    for turn in turns:
        tok = approx_tokens(turn.text)
        if buf and turn.role == "USER" and turn.kind == "text" and buf_tokens >= min_tokens:
            got = flush()
            if got:
                yield got
        elif buf and buf_tokens + tok > max_tokens:
            got = flush()
            if got:
                yield got
        if not buf:
            start_index = index
        buf.append(turn)
        buf_tokens += tok
        index += 1

    got = flush()
    if got:
        yield got


def score_unit(text: str) -> tuple[float, list[str]]:
    score = 0.0
    terms: list[str] = []
    for name, pattern, weight in DURABLE_PATTERNS:
        hits = len(pattern.findall(text))
        if not hits:
            continue
        terms.append(name)
        credit = weight * min(hits, 3)
        if name == "version":
            credit = min(credit, MAX_VERSION_CREDIT)
        score += credit
    return score, terms


# Terms that, on their own, make a unit a plausible memory source.
STRONG_TERMS = {"decided", "lets_use", "i_prefer", "from_now_on", "remember", "rule", "we_use"}


def classify(
    score: float,
    tool_ratio: float,
    user_turns: int,
    user_chars: int,
    terms: list[str],
    positive_threshold: float,
) -> str:
    """Heuristic pre-label. Gold labels come later, from a human/judge pass.

    `negative` means "this looks like pure execution churn" -- the user says
    "continue"/"fix it" while tools do the work. The benchmark needs those to
    measure over-extraction, so we select them on purpose.
    """
    strong = bool(STRONG_TERMS & set(terms))
    if score >= positive_threshold and strong:
        return "positive"
    if score >= positive_threshold + 2.0:
        return "positive"
    if not strong and score <= 1.5:
        if tool_ratio >= 0.4 and user_chars <= 800:
            return "negative"
        if user_turns <= 1 and score == 0.0:
            return "negative"
    return "neutral"


# ---------------------------------------------------------------------------
# Session discovery
# ---------------------------------------------------------------------------


@dataclass
class SessionFile:
    path: Path
    project: str
    session_id: str


def discover_sessions(
    projects_dir: Path,
    include_subagents: bool,
    exclude_projects: list[str],
) -> tuple[list[SessionFile], list[Path], Counter]:
    """Find main-session transcripts. Returns (sessions, skipped_private, skips)."""
    sessions: list[SessionFile] = []
    private: list[Path] = []
    skips: Counter = Counter()

    if not projects_dir.is_dir():
        return sessions, private, skips

    patterns = ["*/*.jsonl"]
    if include_subagents:
        patterns.append("*/*/subagents/**/*.jsonl")

    seen: set[Path] = set()
    for pattern in patterns:
        for path in sorted(projects_dir.glob(pattern)):
            if path in seen:
                continue
            seen.add(path)
            spath = str(path)
            if any(marker in spath for marker in PRIVATE_MARKERS):
                private.append(path)
                skips["private_path"] += 1
                continue
            project = path.relative_to(projects_dir).parts[0]
            if any(excl.lower() in project.lower() for excl in exclude_projects):
                skips["excluded_project"] += 1
                continue
            sessions.append(SessionFile(path=path, project=project, session_id=path.stem))
    return sessions, private, skips


def pretty_project(raw: str) -> str:
    """`-Users-dath-Documents-Foo` -> `Foo` (best effort, stable)."""
    name = raw.strip("-").replace("--", "-")
    parts = [p for p in name.split("-") if p]
    for anchor in ("Documents", "Desktop", "Projects", "projects"):
        if anchor in parts:
            idx = len(parts) - 1 - parts[::-1].index(anchor)
            parts = parts[idx + 1 :] or parts
    return "-".join(parts) if parts else raw


# ---------------------------------------------------------------------------
# Selection
# ---------------------------------------------------------------------------


def select_units(
    candidates: list[Unit],
    target: int,
    negative_frac: float,
    per_session_cap: int,
    per_project_frac: float,
) -> list[Unit]:
    """Round-robin across projects, then sessions, so no mega-session dominates."""
    n_negative = int(round(target * negative_frac))
    n_positive = target - n_negative
    per_project_cap = max(2, int(round(target * per_project_frac)))

    picked: list[Unit] = []
    used_per_project: Counter = Counter()
    used_per_session: Counter = Counter()

    def fill(pool: list[Unit], quota: int) -> None:
        buckets: dict[str, dict[str, list[Unit]]] = defaultdict(lambda: defaultdict(list))
        for unit in pool:
            buckets[unit.project][unit.session_id].append(unit)
        for project in buckets:
            for session in buckets[project]:
                buckets[project][session].sort(key=lambda u: -u.heuristic_score)

        # sessions ordered by date so cycling also spreads across time
        project_order = sorted(buckets, key=lambda p: -sum(len(v) for v in buckets[p].values()))
        session_order = {
            p: sorted(buckets[p], key=lambda s: (buckets[p][s][0].session_date, s))
            for p in buckets
        }
        cursors = {p: 0 for p in buckets}

        progress = True
        while len(picked) < quota and progress:
            progress = False
            for project in project_order:
                if len(picked) >= quota:
                    break
                if used_per_project[project] >= per_project_cap:
                    continue
                sessions = session_order[project]
                if not sessions:
                    continue
                for _ in range(len(sessions)):
                    sid = sessions[cursors[project] % len(sessions)]
                    cursors[project] += 1
                    if used_per_session[sid] >= per_session_cap:
                        continue
                    stack = buckets[project][sid]
                    if not stack:
                        continue
                    unit = stack.pop(0)
                    picked.append(unit)
                    used_per_project[project] += 1
                    used_per_session[sid] += 1
                    progress = True
                    break

    positives = [u for u in candidates if u.heuristic_label == "positive"]
    neutrals = [u for u in candidates if u.heuristic_label == "neutral"]
    negatives = [u for u in candidates if u.heuristic_label == "negative"]

    # Negatives first: they are the scarce resource, and the per-session cap is
    # shared, so letting positives pick first would starve them.
    fill(negatives, n_negative)
    fill(positives, min(target, len(picked) + n_positive))
    if len(picked) < target:
        fill(neutrals, target)
    if len(picked) < target:
        fill(negatives, target)
    return picked


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def percentile(values: list[int], pct: float) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, int(round((len(ordered) - 1) * pct)))
    return ordered[idx]


def build(args: argparse.Namespace) -> dict[str, Any]:
    projects_dir = Path(args.projects_dir).expanduser()
    sessions, private_paths, skips = discover_sessions(
        projects_dir, args.include_subagents, args.exclude_project
    )
    if args.max_sessions:
        sessions = sessions[: args.max_sessions]

    read_stats = ReadStats()
    candidates: list[Unit] = []
    dropped_redaction = 0
    dropped_small = 0
    dropped_no_user = 0
    redaction_totals: Counter = Counter()
    per_project_sessions: Counter = Counter()

    for sf in sessions:
        read_stats.files += 1
        if args.verbose:
            print(f"  reading {sf.project}/{sf.path.name}", file=sys.stderr)
        records = iter_json_lines(
            sf.path,
            max_line_bytes=args.max_line_mb * 1024 * 1024,
            max_bytes=args.max_file_mb * 1024 * 1024,
            stats=read_stats,
        )
        turns = list(
            extract_turns(
                records,
                tool_result_max_chars=args.tool_result_max_chars,
                max_turn_chars=args.max_turn_chars,
                include_sidechain=args.include_sidechain,
            )
        )
        if not turns:
            continue
        per_project_sessions[sf.project] += 1
        session_date = (turns[0].ts or "")[:10]
        project_label = pretty_project(sf.project)

        for group, start_index in group_units(
            turns, args.min_tokens, args.max_tokens, args.floor_tokens
        ):
            user_turns = sum(1 for t in group if t.role == "USER" and t.kind == "text")
            if user_turns == 0:
                dropped_no_user += 1
                continue
            raw_text = "\n\n".join(t.text for t in group)
            clean_text, counts = redact(raw_text, contact=args.redact_contact)
            total_redactions = sum(counts.values())
            if total_redactions > args.max_redactions:
                dropped_redaction += 1
                continue
            tokens = approx_tokens(clean_text)
            if tokens < args.floor_tokens:
                dropped_small += 1
                continue
            redaction_totals.update(counts)
            stamps = [t.ts for t in group if t.ts]
            score, terms = score_unit(clean_text)
            tool_lines = sum(1 for t in group if t.kind in ("tool_use", "tool_result"))
            tool_ratio = tool_lines / max(1, len(group))
            user_chars = sum(t.user_chars for t in group)
            label = classify(
                score, tool_ratio, user_turns, user_chars, terms, args.positive_threshold
            )

            candidates.append(
                Unit(
                    unit_id=f"{sf.session_id[:8]}-{start_index:04d}",
                    session_id=sf.session_id,
                    project=project_label,
                    approx_tokens=tokens,
                    created_range={
                        "start": stamps[0] if stamps else "",
                        "end": stamps[-1] if stamps else "",
                    },
                    text=clean_text,
                    source_file=str(sf.path.relative_to(projects_dir)),
                    n_turns=len(group),
                    user_turns=user_turns,
                    user_chars=user_chars,
                    tool_lines=tool_lines,
                    redactions=dict(counts),
                    redaction_count=total_redactions,
                    heuristic_label=label,
                    heuristic_score=score,
                    heuristic_terms=terms,
                    session_date=session_date,
                )
            )

    selected = select_units(
        candidates,
        target=args.target,
        negative_frac=args.negative_frac,
        per_session_cap=args.per_session_cap,
        per_project_frac=args.per_project_frac,
    )
    selected.sort(key=lambda u: (u.project, u.session_date, u.unit_id))

    token_values = [u.approx_tokens for u in selected]
    manifest = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "generator": "eval/curator/build_units.py",
        "local_only": True,
        "params": {
            "projects_dir": str(projects_dir),
            "target": args.target,
            "negative_frac": args.negative_frac,
            "min_tokens": args.min_tokens,
            "max_tokens": args.max_tokens,
            "floor_tokens": args.floor_tokens,
            "max_redactions": args.max_redactions,
            "tool_result_max_chars": args.tool_result_max_chars,
            "per_session_cap": args.per_session_cap,
            "per_project_frac": args.per_project_frac,
            "positive_threshold": args.positive_threshold,
            "redact_contact": args.redact_contact,
            "include_subagents": args.include_subagents,
            "include_sidechain": args.include_sidechain,
            "exclude_project": args.exclude_project,
            "max_file_mb": args.max_file_mb,
        },
        "discovery": {
            "project_dirs": len({s.project for s in sessions}),
            "session_files": len(sessions),
            "files_read": read_stats.files,
            "files_truncated_by_size_cap": read_stats.truncated_files,
            "lines_seen": read_stats.lines,
            "lines_unparseable": read_stats.unparseable,
            "oversized_lines_skipped": read_stats.oversized_lines,
            "paths_skipped_private": len(private_paths),
            "skips": dict(skips),
        },
        "candidates": {
            "total": len(candidates),
            "positive": sum(1 for u in candidates if u.heuristic_label == "positive"),
            "neutral": sum(1 for u in candidates if u.heuristic_label == "neutral"),
            "negative": sum(1 for u in candidates if u.heuristic_label == "negative"),
            "dropped_over_redaction_limit": dropped_redaction,
            "dropped_below_floor_tokens": dropped_small,
            "dropped_no_user_turn": dropped_no_user,
        },
        "selected": {
            "total": len(selected),
            "positive": sum(1 for u in selected if u.heuristic_label == "positive"),
            "neutral": sum(1 for u in selected if u.heuristic_label == "neutral"),
            "negative": sum(1 for u in selected if u.heuristic_label == "negative"),
            "per_project": dict(Counter(u.project for u in selected).most_common()),
            "per_date": dict(sorted(Counter(u.session_date for u in selected).items())),
            "distinct_sessions": len({u.session_id for u in selected}),
        },
        "tokens": {
            "min": min(token_values) if token_values else 0,
            "p25": percentile(token_values, 0.25),
            "median": percentile(token_values, 0.5),
            "p75": percentile(token_values, 0.75),
            "max": max(token_values) if token_values else 0,
            "mean": round(sum(token_values) / len(token_values), 1) if token_values else 0,
            "total": sum(token_values),
        },
        "redactions": {
            "selected_total": sum(u.redaction_count for u in selected),
            "selected_units_with_redactions": sum(1 for u in selected if u.redaction_count),
            "selected_by_type": dict(
                Counter(
                    {
                        k: v
                        for k, v in Counter(
                            t for u in selected for t, c in u.redactions.items() for _ in range(c)
                        ).items()
                    }
                ).most_common()
            ),
            "all_candidates_by_type": dict(redaction_totals.most_common()),
        },
        "units": [
            {
                "unit_id": u.unit_id,
                "project": u.project,
                "session_id": u.session_id,
                "session_date": u.session_date,
                "approx_tokens": u.approx_tokens,
                "heuristic_label": u.heuristic_label,
                "heuristic_score": round(u.heuristic_score, 2),
                "redaction_count": u.redaction_count,
                "file": f"unit_{u.unit_id}.json",
            }
            for u in selected
        ],
    }

    if not args.dry_run:
        out_dir = Path(args.out_dir).expanduser()
        out_dir.mkdir(parents=True, exist_ok=True)
        if args.clean:
            for stale in out_dir.glob("unit_*.json"):
                stale.unlink()
        for unit in selected:
            (out_dir / f"unit_{unit.unit_id}.json").write_text(
                json.dumps(unit.to_json(), indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
        manifest_path = Path(args.manifest).expanduser()
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(
            json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )

    return manifest


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    here = Path(__file__).resolve().parent
    p = argparse.ArgumentParser(
        description="Build redacted ExperienceUnits from Claude Code session transcripts.",
    )
    p.add_argument("--projects-dir", default=str(DEFAULT_PROJECTS_DIR))
    p.add_argument("--out-dir", default=str(here / "units"))
    p.add_argument("--manifest", default=str(here / "units_manifest.json"))
    p.add_argument("--target", type=int, default=100, help="how many units to select")
    p.add_argument("--negative-frac", type=float, default=0.2)
    p.add_argument("--min-tokens", type=int, default=2000)
    p.add_argument("--max-tokens", type=int, default=4000)
    p.add_argument("--floor-tokens", type=int, default=1000, help="discard units smaller than this")
    p.add_argument("--max-redactions", type=int, default=5, help="drop a unit above this")
    p.add_argument("--tool-result-max-chars", type=int, default=400)
    p.add_argument("--max-turn-chars", type=int, default=6000)
    p.add_argument("--per-session-cap", type=int, default=5)
    p.add_argument("--per-project-frac", type=float, default=0.22)
    p.add_argument("--positive-threshold", type=float, default=3.0)
    p.add_argument("--exclude-project", action="append", default=[])
    p.add_argument(
        "--redact-contact",
        action="store_true",
        help="also scrub emails / phone numbers / postcodes (off by default)",
    )
    p.add_argument("--include-subagents", action="store_true")
    p.add_argument("--include-sidechain", action="store_true")
    p.add_argument("--max-sessions", type=int, default=0)
    p.add_argument("--max-file-mb", type=int, default=200)
    p.add_argument("--max-line-mb", type=int, default=4)
    p.add_argument("--clean", action="store_true", default=True)
    p.add_argument("--no-clean", dest="clean", action="store_false")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--verbose", action="store_true")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    manifest = build(args)
    d, c, s, t = (
        manifest["discovery"],
        manifest["candidates"],
        manifest["selected"],
        manifest["tokens"],
    )
    print(
        f"sessions: {d['session_files']} files across {d['project_dirs']} projects "
        f"({d['lines_seen']:,} lines, {d['lines_unparseable']} unparseable, "
        f"{d['oversized_lines_skipped']} oversized)"
    )
    print(
        f"candidates: {c['total']} "
        f"(+{c['positive']} / ~{c['neutral']} / -{c['negative']}); "
        f"dropped {c['dropped_over_redaction_limit']} over redaction limit, "
        f"{c['dropped_below_floor_tokens']} too small"
    )
    print(
        f"selected: {s['total']} units from {s['distinct_sessions']} sessions "
        f"(+{s['positive']} / ~{s['neutral']} / -{s['negative']})"
    )
    print(
        f"tokens: min {t['min']} / p25 {t['p25']} / median {t['median']} / "
        f"p75 {t['p75']} / max {t['max']} (mean {t['mean']})"
    )
    print(f"redactions in selected: {manifest['redactions']['selected_total']} "
          f"{manifest['redactions']['selected_by_type']}")
    if args.dry_run:
        print("(dry run -- nothing written)")
    else:
        print(f"wrote {s['total']} units -> {args.out_dir}")
        print(f"wrote manifest    -> {args.manifest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
