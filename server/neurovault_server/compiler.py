"""Knowledge compilation: LLM-as-compiler loop.

Picks a topic, reads every raw source that mentions it, and rewrites a
single canonical wiki page through Claude with a visible diff and
per-change provenance. Each compilation lands in the `compilations`
table as `pending` so a human reviews + approves before the wiki engram
is updated.

This is the piece that turns NeuroVault from "structured retrieval over
markdown" into "a living internal wiki the agent maintains for you" — the
exact framing Pavel Nesterov was asking for in his post.

Design notes worth knowing:

  - Reuses the env-keyed Anthropic client pattern from `entities.py` and
    `write_back.py`. Same fallback story: if no API key, log and skip.
  - Reads sources via the existing `entities` + `entity_mentions` tables,
    so "topics" are entity names. Topic-similarity fallback through
    hybrid_retrieve() is supported when the entity match is sparse.
  - Strict response shape: markdown body, then a fenced JSON block
    labeled changelog. Retry once with narrower instructions on parse
    failure, then surface the raw text in the detail view so the user
    can debug rather than silently dropping the run.
  - Server-generated diffs via stdlib `difflib.unified_diff()`. Frontend
    receives a string and renders it; no diff library on the server.
  - `compilations` rows always start as `status='pending'`. Reject =
    revert wiki engram content. Approve = flip status, no content move
    needed (the wiki engram is updated at compile time, not approve time).
  - Wiki engrams are regular engrams with `kind='wiki'`. They live at
    `~/.neurovault/brains/{brain}/vault/wiki/{slug}.md` so the existing file
    watcher re-ingests them like any other note.
"""

from __future__ import annotations

import difflib
import hashlib
import json
import os
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any

from loguru import logger

from neurovault_server.config import env_with_legacy_fallback as _env
from neurovault_server.database import Database

if TYPE_CHECKING:
    from neurovault_server.brain import BrainContext


# --- Tunables -------------------------------------------------------------

DEFAULT_MODEL = (
    _env("NEUROVAULT_COMPILER_MODEL", "ENGRAM_COMPILER_MODEL", "claude-haiku-4-5-20251001")
    or "claude-haiku-4-5-20251001"
)
MAX_SOURCES_PER_COMPILE = 30
MAX_TOTAL_SOURCE_CHARS = 80_000
MAX_PER_RUN = 5
MAX_RESPONSE_TOKENS = 4096
ALLOWED_SOURCE_KINDS = ("note", "observation", "insight", "source", "quote")


# --- Public types ---------------------------------------------------------


@dataclass
class TopicCandidate:
    """A topic that needs (re)compilation, with the signal that flagged it."""

    topic: str
    source_count: int
    reason: str  # "new_source" | "contradiction" | "manual" | "first_compile"


@dataclass
class CompilationResult:
    """The row written for one compile pass."""

    id: str
    topic: str
    wiki_engram_id: str | None
    old_content: str
    new_content: str
    diff: str
    changelog: list[dict[str, Any]] = field(default_factory=list)
    sources: list[dict[str, Any]] = field(default_factory=list)
    model: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    status: str = "pending"


# --- The prompt -----------------------------------------------------------


SYSTEM_PROMPT = """You are NeuroVault's knowledge compiler. Your job is to maintain canonical wiki pages by rewriting them whenever their underlying sources have changed. You are NOT generating creative writing. You are distilling, merging, and reconciling.

Given:
  - the CURRENT wiki page for a topic (may be empty for a first compile),
  - the full set of RAW sources that mention the topic,
  - any active CONTRADICTIONS involving those sources,
  - the brain's SCHEMA (from CLAUDE.md, optional),

produce two things:

  1. A new canonical wiki page in markdown.
  2. A structured changelog describing every semantic change.

RULES:
  - Preserve facts that are still valid. Only change what the sources require.
  - When sources conflict, pick the most recent, most-sourced, or most strongly stated fact. Explain the pick in the changelog.
  - Every factual claim in the wiki page must be traceable to a source. Use footnote-style references inline: "We chose sqlite-vec [src:a3f2c1]".
  - Wiki page format: YAML frontmatter (title, last_compiled_at, sources_count), then body with ## sections. Keep prose tight. No filler.
  - End your output with a fenced JSON block labeled `json changelog` and nothing after it. The JSON is a list of change objects.

CHANGELOG ITEM SHAPE:
  {
    "change": "added" | "updated" | "removed" | "rephrased",
    "field": "short name of what changed",
    "before": "prior claim or null",
    "after": "new claim or null",
    "reason": "why (cite source ids)",
    "source_ids": ["..."]
  }

DO NOT include any text after the closing JSON block.
"""


# --- Source gathering -----------------------------------------------------


def _short_id(full_id: str) -> str:
    """6-char id slug for inline citation tags."""
    return full_id.replace("-", "")[:6]


def _gather_sources(db: Database, topic: str) -> list[dict[str, Any]]:
    """Return raw source engrams that mention the given topic.

    Strategy:
      1. Look up the entity by case-insensitive name.
      2. Join entity_mentions to engrams, filtered by allowed kinds + non-dormant.
      3. Order by updated_at DESC, cap at MAX_SOURCES_PER_COMPILE.
      4. Truncate the running content total at MAX_TOTAL_SOURCE_CHARS.
    """
    placeholders = ",".join("?" * len(ALLOWED_SOURCE_KINDS))
    rows = db.conn.execute(
        f"""
        SELECT e.id, e.title, e.kind, e.content, e.updated_at, e.filename
        FROM entity_mentions em
        JOIN entities  ent ON ent.id = em.entity_id
        JOIN engrams   e   ON e.id   = em.engram_id
        WHERE LOWER(ent.name) = LOWER(?)
          AND e.kind IN ({placeholders})
          AND e.state != 'dormant'
        GROUP BY e.id
        ORDER BY e.updated_at DESC
        LIMIT ?
        """,
        (topic, *ALLOWED_SOURCE_KINDS, MAX_SOURCES_PER_COMPILE),
    ).fetchall()

    sources: list[dict[str, Any]] = []
    total_chars = 0
    for r in rows:
        body = r[3] or ""
        if total_chars + len(body) > MAX_TOTAL_SOURCE_CHARS:
            # Truncate the body of this final source to fit the budget
            remaining = MAX_TOTAL_SOURCE_CHARS - total_chars
            if remaining < 200:
                break
            body = body[:remaining] + "\n... [truncated]"
        total_chars += len(body)
        sources.append({
            "id": r[0],
            "short_id": _short_id(r[0]),
            "title": r[1],
            "kind": r[2],
            "content": body,
            "updated_at": r[4],
            "filename": r[5],
        })
    return sources


def _fetch_existing_wiki(db: Database, topic: str) -> dict[str, Any] | None:
    """Return the current wiki engram for this topic, if any."""
    row = db.conn.execute(
        "SELECT id, title, content, updated_at FROM engrams WHERE kind='wiki' AND title=? LIMIT 1",
        (topic,),
    ).fetchone()
    if not row:
        return None
    return {"id": row[0], "title": row[1], "content": row[2], "updated_at": row[3]}


def _fetch_contradictions_for_sources(db: Database, source_ids: list[str]) -> list[dict[str, Any]]:
    """Return unresolved contradictions involving any of the given engrams.

    Currently the contradictions table is empty (the keyword detector is
    disabled), but the schema is here and the compiler will start
    populating it via the changelog reasoning. So this query is built
    correctly for the day the table starts filling up again.
    """
    if not source_ids:
        return []
    placeholders = ",".join("?" * len(source_ids))
    rows = db.conn.execute(
        f"""
        SELECT id, engram_a, engram_b, fact_a, fact_b, detected_at
        FROM contradictions
        WHERE resolved = 0 AND (engram_a IN ({placeholders}) OR engram_b IN ({placeholders}))
        ORDER BY detected_at DESC
        """,
        (*source_ids, *source_ids),
    ).fetchall()
    return [
        {"id": r[0], "engram_a": r[1], "engram_b": r[2], "fact_a": r[3], "fact_b": r[4], "detected_at": r[5]}
        for r in rows
    ]


# --- Prompt assembly ------------------------------------------------------


def _build_user_prompt(
    topic: str,
    old_page: dict[str, Any] | None,
    sources: list[dict[str, Any]],
    contradictions: list[dict[str, Any]],
    schema: str,
) -> str:
    """Pack the run inputs into a single user-message string."""
    lines: list[str] = []
    lines.append(f"# Topic to compile: {topic}\n")

    if schema.strip():
        lines.append("## Brain schema\n")
        lines.append(schema.strip()[:2000])
        lines.append("")

    if old_page:
        lines.append("## Current wiki page (rewrite this)\n")
        lines.append(old_page["content"][:8000])
        lines.append("")
    else:
        lines.append("## Current wiki page\n")
        lines.append("(none — this is a first compile, write the page from scratch)\n")

    lines.append(f"## Raw sources ({len(sources)} total)\n")
    for s in sources:
        lines.append(f"### [src:{s['short_id']}] {s['title']}  (kind={s['kind']}, updated={s['updated_at']})")
        lines.append(s["content"].strip())
        lines.append("---")

    if contradictions:
        lines.append("\n## Active contradictions involving these sources\n")
        for c in contradictions:
            lines.append(f"- {c['fact_a']!r}  vs  {c['fact_b']!r}")

    lines.append("\nProduce the new wiki page now, following the rules above. End with the JSON changelog block.")
    return "\n".join(lines)


# --- LLM call + parsing ---------------------------------------------------


_CHANGELOG_FENCE_RE = re.compile(r"```(?:json\s*changelog|changelog\s*json|json)\s*\n(.*?)\n?```\s*$", re.DOTALL | re.IGNORECASE)


def _split_response(raw: str) -> tuple[str, list[dict[str, Any]]]:
    """Parse a compiler response into (markdown_body, changelog_list).

    Looks for the trailing fenced JSON block labeled `json changelog`,
    `changelog json`, or just `json`. Everything before that fence is the
    wiki page body. Raises ValueError on parse failure so the caller can
    retry with a stricter instruction.
    """
    m = _CHANGELOG_FENCE_RE.search(raw)
    if not m:
        raise ValueError("compiler response missing trailing JSON changelog fence")

    body = raw[: m.start()].rstrip()
    payload = m.group(1).strip()

    try:
        data = json.loads(payload)
    except json.JSONDecodeError as e:
        raise ValueError(f"changelog JSON parse failed: {e}") from e

    # Accept either a bare list or {"changelog": [...]}
    if isinstance(data, dict) and "changelog" in data:
        data = data["changelog"]
    if not isinstance(data, list):
        raise ValueError("changelog must be a list")

    return body, data


def _call_claude(client: Any, model: str, user_prompt: str, retry_strict: bool = False) -> tuple[str, int, int]:
    """Single Claude call. Returns (text, input_tokens, output_tokens).

    On a parse-failure retry we tighten the system prompt rather than the
    user prompt, because the user prompt is already a fixed packed bundle.
    """
    sys_prompt = SYSTEM_PROMPT
    if retry_strict:
        sys_prompt += "\n\nRETRY: Your previous response could not be parsed. Output ONLY the wiki markdown followed by exactly one fenced JSON block labeled ```json changelog. NO prose before the markdown, NO text after the closing ``` of the changelog block."

    response = client.messages.create(
        model=model,
        max_tokens=MAX_RESPONSE_TOKENS,
        system=sys_prompt,
        messages=[{"role": "user", "content": user_prompt}],
    )
    text = response.content[0].text
    usage_in = getattr(response.usage, "input_tokens", 0)
    usage_out = getattr(response.usage, "output_tokens", 0)
    return text, usage_in, usage_out


def _llm_compile(
    user_prompt: str,
    model: str,
) -> tuple[str, list[dict[str, Any]], int, int]:
    """Call Claude, parse, retry once on failure.

    Returns (markdown_body, changelog_list, input_tokens, output_tokens).
    Raises RuntimeError if both attempts fail or if no API key is set.
    """
    try:
        import anthropic
    except ImportError as e:
        raise RuntimeError(f"anthropic SDK not installed: {e}") from e

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY not set — compiler requires Claude")

    client = anthropic.Anthropic(api_key=api_key)

    text, in_tok, out_tok = _call_claude(client, model, user_prompt, retry_strict=False)
    try:
        body, changelog = _split_response(text)
        return body, changelog, in_tok, out_tok
    except ValueError as e:
        logger.warning("compiler: first parse failed ({}), retrying with strict prompt", e)

    text2, in_tok2, out_tok2 = _call_claude(client, model, user_prompt, retry_strict=True)
    try:
        body, changelog = _split_response(text2)
        return body, changelog, in_tok + in_tok2, out_tok + out_tok2
    except ValueError as e:
        # Surface the raw second-attempt text so the caller can store it
        # for human inspection in the review panel.
        raise RuntimeError(f"compiler: response unparseable after retry: {e}\n\nRaw:\n{text2[:2000]}") from e


# --- Diff + persistence ---------------------------------------------------


def _diff_text(old: str, new: str, topic: str) -> str:
    """Server-side unified diff. Frontend receives this as a string."""
    old_lines = (old or "").splitlines(keepends=True)
    new_lines = (new or "").splitlines(keepends=True)
    diff_lines = difflib.unified_diff(
        old_lines,
        new_lines,
        fromfile=f"{topic} (before)",
        tofile=f"{topic} (after)",
        n=3,
    )
    return "".join(diff_lines)


def _slugify(text: str) -> str:
    s = ""
    for ch in text.lower():
        if ch.isalnum():
            s += ch
        elif s and s[-1] != "-":
            s += "-"
    return s.strip("-")[:60] or "untitled"


def _wiki_filename(topic: str) -> str:
    """Stable filename for a wiki page derived from its topic."""
    slug = _slugify(topic)
    digest = hashlib.sha1(topic.encode("utf-8")).hexdigest()[:6]
    return f"wiki-{slug}-{digest}.md"


def _ensure_wiki_dir(vault_dir: Path) -> Path:
    wiki_dir = vault_dir / "wiki"
    wiki_dir.mkdir(parents=True, exist_ok=True)
    return wiki_dir


def _write_wiki_file(vault_dir: Path, topic: str, body: str) -> Path:
    wiki_dir = _ensure_wiki_dir(vault_dir)
    path = wiki_dir / _wiki_filename(topic)
    path.write_text(body, encoding="utf-8")
    return path


def _write_compilation_row(
    db: Database,
    *,
    topic: str,
    wiki_engram_id: str | None,
    old_content: str,
    new_content: str,
    changelog: list[dict[str, Any]],
    sources: list[dict[str, Any]],
    model: str,
    input_tokens: int,
    output_tokens: int,
    status: str = "pending",
) -> str:
    cid = str(uuid.uuid4())
    db.conn.execute(
        """
        INSERT INTO compilations
            (id, topic, wiki_engram_id, old_content, new_content,
             changelog_json, sources_json, model,
             input_tokens, output_tokens, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            cid,
            topic,
            wiki_engram_id,
            old_content,
            new_content,
            json.dumps(changelog, ensure_ascii=False),
            json.dumps([{"id": s["id"], "title": s["title"], "kind": s["kind"]} for s in sources], ensure_ascii=False),
            model,
            input_tokens,
            output_tokens,
            status,
            datetime.now(timezone.utc).isoformat(),
        ),
    )
    db.conn.commit()
    return cid


# --- Public API -----------------------------------------------------------


def compile_topic(
    ctx: "BrainContext",
    topic: str,
    model: str | None = None,
    dry_run: bool = False,
) -> CompilationResult:
    """Run one compile pass on a topic. Persists a `compilations` row.

    On the first compile for a topic, no wiki engram exists yet — the
    function still writes the wiki file to disk (the file watcher will
    pick it up and create the engram). On subsequent compiles, the wiki
    engram is updated at compile time but `status` stays `pending` until
    a human approves.

    If `dry_run=True`, the function runs every step except the Claude
    call and the wiki file write. It returns a CompilationResult whose
    `new_content` field holds the assembled user prompt (so the caller
    can inspect exactly what would be sent to the LLM), status is
    'dry_run', and no `compilations` row is written. Use this to verify
    source gathering, prompt assembly, and entity-mention joins without
    spending any API budget.
    """
    db = ctx.db
    chosen_model = model or DEFAULT_MODEL

    sources = _gather_sources(db, topic)
    if not sources:
        raise ValueError(f"no raw sources found for topic {topic!r}")

    old_page = _fetch_existing_wiki(db, topic)
    old_content = old_page["content"] if old_page else ""

    contradictions = _fetch_contradictions_for_sources(db, [s["id"] for s in sources])

    # Read the brain's schema if present (CLAUDE.md). Optional.
    schema_text = ""
    schema_path = ctx.vault_dir / "CLAUDE.md"
    if schema_path.exists():
        try:
            schema_text = schema_path.read_text(encoding="utf-8")
        except Exception as e:
            logger.debug("compiler: could not read CLAUDE.md: {}", e)

    user_prompt = _build_user_prompt(topic, old_page, sources, contradictions, schema_text)

    logger.info(
        "compiler: compiling {!r} with {} sources via {} (≈{} chars in)  dry_run={}",
        topic, len(sources), chosen_model, len(user_prompt), dry_run,
    )

    if dry_run:
        # Skip the LLM call AND the file write. Return the prompt as
        # new_content so the caller can see exactly what would be sent.
        return CompilationResult(
            id="dry-run",
            topic=topic,
            wiki_engram_id=old_page["id"] if old_page else None,
            old_content=old_content,
            new_content=user_prompt,
            diff="",
            changelog=[],
            sources=sources,
            model=chosen_model,
            input_tokens=0,
            output_tokens=0,
            status="dry_run",
        )

    body, changelog, in_tok, out_tok = _llm_compile(user_prompt, chosen_model)

    # Write the new wiki body to disk so the file watcher ingests it.
    # The wiki engram id may not exist yet on a first compile — the
    # ingest pipeline will create it shortly after. We still record the
    # new_content in the compilations row regardless.
    _write_wiki_file(ctx.vault_dir, topic, body)

    diff = _diff_text(old_content, body, topic)

    cid = _write_compilation_row(
        db,
        topic=topic,
        wiki_engram_id=old_page["id"] if old_page else None,
        old_content=old_content,
        new_content=body,
        changelog=changelog,
        sources=sources,
        model=chosen_model,
        input_tokens=in_tok,
        output_tokens=out_tok,
    )

    logger.info(
        "compiler: wrote compilation {} for {!r} ({} changes, {} in / {} out tokens)",
        cid[:8], topic, len(changelog), in_tok, out_tok,
    )

    return CompilationResult(
        id=cid,
        topic=topic,
        wiki_engram_id=old_page["id"] if old_page else None,
        old_content=old_content,
        new_content=body,
        diff=diff,
        changelog=changelog,
        sources=sources,
        model=chosen_model,
        input_tokens=in_tok,
        output_tokens=out_tok,
        status="pending",
    )


def compilations_needed(ctx: "BrainContext", limit: int = 10) -> list[TopicCandidate]:
    """Return topics whose raw sources have changed since their last compile.

    Heuristic v1:
      - For every entity referenced by at least 3 engrams, find the most
        recent source updated_at.
      - Compare against the most recent `compilations.created_at` for
        that topic.
      - If sources are newer (or no compilation exists), the topic is a
        candidate. `reason` is "first_compile" or "new_source".
      - Cap by source_count DESC so we recompile densely-referenced
        topics first.

    Manual triggers and contradiction signals are surfaced through
    separate code paths and unioned by the caller (or by run_pending).
    """
    rows = ctx.db.conn.execute(
        """
        SELECT
            ent.name AS topic,
            COUNT(DISTINCT em.engram_id) AS source_count,
            MAX(e.updated_at) AS last_source_update,
            (SELECT MAX(c.created_at) FROM compilations c WHERE c.topic = ent.name) AS last_compiled
        FROM entities ent
        JOIN entity_mentions em ON em.entity_id = ent.id
        JOIN engrams e          ON e.id = em.engram_id
        WHERE e.state != 'dormant'
        GROUP BY ent.name
        HAVING source_count >= 3
        ORDER BY source_count DESC
        LIMIT ?
        """,
        (limit * 3,),  # over-fetch then filter to dirty topics
    ).fetchall()

    candidates: list[TopicCandidate] = []
    for r in rows:
        topic, count, last_source, last_compiled = r[0], r[1], r[2], r[3]
        if last_compiled is None:
            candidates.append(TopicCandidate(topic=topic, source_count=count, reason="first_compile"))
        elif last_source and last_source > last_compiled:
            candidates.append(TopicCandidate(topic=topic, source_count=count, reason="new_source"))
        if len(candidates) >= limit:
            break
    return candidates


def run_pending_compilations(ctx: "BrainContext", max_per_run: int = MAX_PER_RUN) -> list[CompilationResult]:
    """Scheduler entry point. Compile up to `max_per_run` dirty topics.

    Failures on individual topics are caught and logged so one bad topic
    doesn't kill the whole batch.
    """
    candidates = compilations_needed(ctx, limit=max_per_run)
    if not candidates:
        logger.debug("compiler: no topics need recompilation")
        return []

    results: list[CompilationResult] = []
    for cand in candidates:
        try:
            result = compile_topic(ctx, cand.topic)
            results.append(result)
        except Exception as e:
            logger.warning("compiler: topic {!r} failed: {}", cand.topic, e)
            continue
    return results


def approve_compilation(ctx: "BrainContext", compilation_id: str) -> dict[str, Any]:
    """Mark a compilation as approved. Wiki content is already on disk."""
    db = ctx.db
    db.conn.execute(
        "UPDATE compilations SET status='approved', reviewed_at=? WHERE id=?",
        (datetime.now(timezone.utc).isoformat(), compilation_id),
    )
    db.conn.commit()
    return {"status": "approved", "id": compilation_id}


def reject_compilation(ctx: "BrainContext", compilation_id: str) -> dict[str, Any]:
    """Mark a compilation as rejected and revert the wiki file to old_content.

    If old_content is empty (first compile), delete the wiki file instead.
    """
    db = ctx.db
    row = db.conn.execute(
        "SELECT topic, old_content, wiki_engram_id FROM compilations WHERE id=?",
        (compilation_id,),
    ).fetchone()
    if not row:
        return {"status": "not_found", "id": compilation_id}

    topic, old_content, _wiki_id = row[0], row[1], row[2]
    wiki_path = ctx.vault_dir / "wiki" / _wiki_filename(topic)

    try:
        if old_content:
            wiki_path.write_text(old_content, encoding="utf-8")
        elif wiki_path.exists():
            wiki_path.unlink()
    except Exception as e:
        logger.warning("compiler: revert write failed for {}: {}", compilation_id[:8], e)

    db.conn.execute(
        "UPDATE compilations SET status='rejected', reviewed_at=? WHERE id=?",
        (datetime.now(timezone.utc).isoformat(), compilation_id),
    )
    db.conn.commit()
    return {"status": "rejected", "id": compilation_id}


def list_compilations(ctx: "BrainContext", status: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
    """Summary list of compilations, optionally filtered by status."""
    db = ctx.db
    if status:
        rows = db.conn.execute(
            """
            SELECT id, topic, status, created_at, reviewed_at,
                   changelog_json, sources_json, model
            FROM compilations
            WHERE status=?
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (status, limit),
        ).fetchall()
    else:
        rows = db.conn.execute(
            """
            SELECT id, topic, status, created_at, reviewed_at,
                   changelog_json, sources_json, model
            FROM compilations
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

    out: list[dict[str, Any]] = []
    for r in rows:
        try:
            changelog = json.loads(r[5] or "[]")
            sources = json.loads(r[6] or "[]")
        except json.JSONDecodeError:
            changelog, sources = [], []
        out.append({
            "id": r[0],
            "topic": r[1],
            "status": r[2],
            "created_at": r[3],
            "reviewed_at": r[4],
            "change_count": len(changelog),
            "source_count": len(sources),
            "model": r[7],
        })
    return out


def get_compilation(ctx: "BrainContext", compilation_id: str) -> dict[str, Any] | None:
    """Full detail of one compilation, including diff (regenerated server-side)."""
    db = ctx.db
    row = db.conn.execute(
        """
        SELECT id, topic, wiki_engram_id, old_content, new_content,
               changelog_json, sources_json, model,
               input_tokens, output_tokens, status, created_at, reviewed_at
        FROM compilations
        WHERE id=?
        """,
        (compilation_id,),
    ).fetchone()
    if not row:
        return None

    try:
        changelog = json.loads(row[5] or "[]")
        sources = json.loads(row[6] or "[]")
    except json.JSONDecodeError:
        changelog, sources = [], []

    return {
        "id": row[0],
        "topic": row[1],
        "wiki_engram_id": row[2],
        "old_content": row[3] or "",
        "new_content": row[4] or "",
        "diff": _diff_text(row[3] or "", row[4] or "", row[1]),
        "changelog": changelog,
        "sources": sources,
        "model": row[7],
        "input_tokens": row[8],
        "output_tokens": row[9],
        "status": row[10],
        "created_at": row[11],
        "reviewed_at": row[12],
    }
