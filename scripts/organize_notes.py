"""Classify every unorganised markdown note in each brain's vault/ and
file it into the correct typed subfolder (concepts/entities/decisions/
summaries/inbox).

Rules (first-match wins):
  1. Frontmatter `type:` field — if present, use it directly.
  2. Filename pattern:
       - `decision-*`, `*-decision-*`       -> decisions
       - `*-summary.md`, `*-digest.md`,
         `bench-*`, `rollup-*`               -> summaries
       - tag list contains 'person', 'entity',
         'company', or 'project'            -> entities
       - matches known concept noun
         patterns (backend-*, frontend-*,
         architecture-*, retrieval-*,
         memory-*, mcp-*, sqlite-*,
         tauri-*, python-*, rust-*,
         design-*, graph-*, api-*)          -> concepts
  3. Default                                  -> inbox

Never touches:
  - Notes already inside a vault subfolder (concepts/, agent/, etc.)
  - Special meta files: index.md, log.md, CLAUDE.md, README.md
  - Files without a .md extension

Safety:
  - --dry-run default; --apply required for filesystem writes.
  - Idempotent: running twice leaves everything in place.
  - Preserves frontmatter + content byte-for-byte (git mv semantics,
    not rewrite-in-place).
  - Refuses if neurovault.exe is running (the file watcher would
    fight the moves).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
from pathlib import Path


# ---------------------------------------------------------------------------
# Classifier rules
# ---------------------------------------------------------------------------

SPECIAL_META = {
    "index.md",
    "log.md",
    "claude.md",
    "readme.md",
    "graph_report.md",  # auto-generated, like index.md
}

SUBFOLDERS = ["concepts", "entities", "decisions", "summaries", "inbox"]

CONCEPT_PREFIXES = (
    "backend-",
    "frontend-",
    "architecture-",
    "retrieval-",
    "memory-",
    "mcp-",
    "sqlite-",
    "tauri-",
    "python-",
    "rust-",
    "design-",
    "graph-",
    "api-",
    "ingest-",
    "storage-",
    "schema-",
    "protocol-",
    "embedding-",
    "hybrid-",
    "vector-",
    "neural-",
    "http-",
    "https-",
    "request-",
    "response-",
    # Distilled facts written by the remember()/insight pipeline. Most
    # describe a concept or a durable preference, so concepts is a
    # better default than inbox. Decisions get caught earlier by the
    # decision pattern (insight-decision-*).
    "insight-",
    "fact-",
    "preference-",
    "note-",
)

SUMMARY_PATTERNS = (
    re.compile(r"^bench-", re.I),
    re.compile(r"^rollup-", re.I),
    re.compile(r"-summary\.md$", re.I),
    re.compile(r"-digest\.md$", re.I),
    re.compile(r"-rollup\.md$", re.I),
    re.compile(r"^daily-\d{4}-\d{2}-\d{2}", re.I),
    re.compile(r"^session-\d", re.I),
)

DECISION_PATTERNS = (
    re.compile(r"^decision-", re.I),
    re.compile(r"-decision-", re.I),
    re.compile(r"^adr-\d", re.I),
    re.compile(r"^rfc-\d", re.I),
)

ENTITY_TAGS = {"person", "entity", "company", "project", "team", "organization"}

FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*(?:\n|$)", re.DOTALL)


# ---------------------------------------------------------------------------
# Frontmatter parse — tiny, no YAML dep. Good enough for the 2-level
# scalar+list shape these notes use.
# ---------------------------------------------------------------------------


def parse_frontmatter(text: str) -> dict:
    m = FRONTMATTER_RE.match(text)
    if not m:
        return {}
    body = m.group(1)
    out: dict = {}
    for raw_line in body.splitlines():
        line = raw_line.rstrip()
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            continue
        key, _, val = line.partition(":")
        key = key.strip()
        val = val.strip()
        if val.startswith("[") and val.endswith("]"):
            items = [
                s.strip().strip("\"'")
                for s in val[1:-1].split(",")
                if s.strip()
            ]
            out[key] = items
        elif val:
            out[key] = val.strip("\"'")
    return out


# ---------------------------------------------------------------------------
# Classifier
# ---------------------------------------------------------------------------


def classify(filename: str, frontmatter: dict) -> str:
    """Return one of SUBFOLDERS."""

    # 1. Explicit frontmatter type wins.
    t = (frontmatter.get("type") or "").lower()
    if t in {"concept", "concepts"}:
        return "concepts"
    if t in {"entity", "entities", "person", "project", "company"}:
        return "entities"
    if t in {"decision", "decisions", "adr", "rfc"}:
        return "decisions"
    if t in {"summary", "summaries", "digest", "rollup"}:
        return "summaries"
    if t == "inbox":
        return "inbox"

    name = filename.lower()

    # 2a. Decision patterns.
    for pat in DECISION_PATTERNS:
        if pat.search(name):
            return "decisions"

    # 2b. Summary patterns.
    for pat in SUMMARY_PATTERNS:
        if pat.search(name):
            return "summaries"

    # 2c. Entity tag.
    tags = frontmatter.get("tags") or []
    if isinstance(tags, list):
        tag_set = {str(t).lower() for t in tags}
        if tag_set & ENTITY_TAGS:
            return "entities"

    # 2d. Concept prefix.
    base = name[:-3] if name.endswith(".md") else name
    for pref in CONCEPT_PREFIXES:
        if base.startswith(pref):
            return "concepts"

    # 3. Default.
    return "inbox"


# ---------------------------------------------------------------------------
# Per-brain planning
# ---------------------------------------------------------------------------


def plan_brain(vault_dir: Path) -> list[tuple[Path, Path, str]]:
    """Return [(src, dst, target_folder)] for each note to move."""
    if not vault_dir.exists():
        return []

    actions: list[tuple[Path, Path, str]] = []
    for entry in sorted(vault_dir.iterdir()):
        if not entry.is_file():
            continue
        if entry.suffix.lower() != ".md":
            continue
        if entry.name.lower() in SPECIAL_META:
            continue

        try:
            text = entry.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        fm = parse_frontmatter(text)
        target = classify(entry.name, fm)
        dst = vault_dir / target / entry.name
        if dst == entry:
            continue
        actions.append((entry, dst, target))
    return actions


# ---------------------------------------------------------------------------
# Safety
# ---------------------------------------------------------------------------


def check_no_running_neurovault() -> list[str]:
    try:
        import psutil  # type: ignore
    except ImportError:
        return []
    offenders: list[str] = []
    names = ("neurovault.exe", "neurovault-server.exe")
    for proc in psutil.process_iter(["name", "cmdline"]):
        try:
            pname = (proc.info.get("name") or "").lower()
            cmd = " ".join(proc.info.get("cmdline") or []).lower()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
        if any(n in pname for n in names):
            offenders.append(pname)
        elif "neurovault_server" in cmd and "python" in pname:
            offenders.append(f"{pname} -m neurovault_server")
    return offenders


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def resolve_nv_home() -> Path:
    explicit = os.environ.get("NEUROVAULT_HOME") or os.environ.get("ENGRAM_HOME")
    if explicit:
        return Path(explicit)
    return Path.home() / ".neurovault"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--apply", action="store_true", help="actually move files")
    ap.add_argument("--brain", help="only this brain id")
    args = ap.parse_args(argv)

    nv_home = resolve_nv_home()
    registry = nv_home / "brains.json"
    try:
        brains = json.loads(registry.read_text(encoding="utf-8")).get("brains", [])
    except FileNotFoundError:
        print(f"error: {registry} missing", file=sys.stderr)
        return 2
    except json.JSONDecodeError as e:
        print(f"error: bad brains.json: {e}", file=sys.stderr)
        return 2

    if args.brain:
        brains = [b for b in brains if b.get("id") == args.brain]

    # --- Plan --------------------------------------------------------------
    per_brain_plans: list[tuple[str, list[tuple[Path, Path, str]]]] = []
    for b in brains:
        bid = b.get("id")
        if not bid:
            continue
        vault = nv_home / "brains" / bid / "vault"
        per_brain_plans.append((bid, plan_brain(vault)))

    total = sum(len(p) for _, p in per_brain_plans)
    mode = "APPLY" if args.apply else "DRY-RUN"
    print(f"Note organizer  [{mode}]")
    print(f"brains: {len(per_brain_plans)}  notes to move: {total}")
    print()

    for bid, plan in per_brain_plans:
        counts: dict[str, int] = {k: 0 for k in SUBFOLDERS}
        for _, _, target in plan:
            counts[target] = counts.get(target, 0) + 1
        summary = "  ".join(f"{k}={v}" for k, v in counts.items() if v)
        print(f"== {bid} ==  {len(plan)} moves  {summary or '(none)'}")
        for src, dst, target in plan[:8]:
            print(f"  -> {target:<10s}  {src.name}")
        if len(plan) > 8:
            print(f"  ... and {len(plan) - 8} more")
        print()

    if not args.apply:
        print("Dry-run complete. Re-run with --apply to execute.")
        return 0

    # --- Safety gate -------------------------------------------------------
    offenders = check_no_running_neurovault()
    if offenders:
        print("refusing to apply: these processes are running:", file=sys.stderr)
        for o in offenders:
            print(f"  - {o}", file=sys.stderr)
        return 3

    # --- Execute -----------------------------------------------------------
    moved = 0
    failed = 0
    for bid, plan in per_brain_plans:
        for src, dst, _ in plan:
            try:
                dst.parent.mkdir(parents=True, exist_ok=True)
                if dst.exists():
                    # Collision: target name already taken (e.g. file was
                    # already filed under a different folder manually).
                    # Append a numeric suffix to preserve both copies
                    # rather than silently overwriting.
                    stem = dst.stem
                    i = 1
                    while True:
                        candidate = dst.with_name(f"{stem}-{i}{dst.suffix}")
                        if not candidate.exists():
                            dst = candidate
                            break
                        i += 1
                shutil.move(str(src), str(dst))
                moved += 1
            except OSError as e:
                print(f"failed: {src} -> {dst}: {e}", file=sys.stderr)
                failed += 1

    print(f"Moved {moved} notes.  Failures: {failed}.")
    return 0 if failed == 0 else 4


if __name__ == "__main__":
    raise SystemExit(main())
