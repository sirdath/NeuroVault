"""Plan + execute the NeuroVault brain-layout migration.

Reshapes each brain under ~/.neurovault/brains/{id}/ from the legacy
flat-ish layout into the research-validated layout documented in
docs/HOW-NEUROVAULT-WORKS.md. Single-person scope — no users/{id}/
wrapping (that stays exploratory).

Default mode is --dry-run: the script prints every action it would
take without touching the filesystem. Pass --apply to actually do
the moves. Idempotent: running twice produces no-ops on the second
run.

The script never deletes anything unless --apply AND --clean-legacy
are both set; even then it only removes files it's sure are stale
(zero-byte, or identifiable as pre-rename residue).

Safety gates before any write:
  1. No neurovault.exe / neurovault-server.exe / python.exe -m
     neurovault_server process is running.
  2. brain.db-wal is at rest (mtime older than 2 seconds) — a live
     connection is still flushing if this fails.
  3. The user's `brains.json` registry parses cleanly; we won't
     migrate a brain the registry doesn't know about.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path


# ---------------------------------------------------------------------------
# Layout target spec — the single source of truth for "what the new shape is".
# Everything below is derived from this.
# ---------------------------------------------------------------------------

VAULT_DEFAULT_SUBFOLDERS = [
    "concepts",
    "entities",
    "decisions",
    "summaries",
    "inbox",
]

CACHE_SUBFOLDERS = [
    "embeddings",
    "bm25",
    "rerank",
    "temp",
]

ASSETS_SUBFOLDERS = [
    "images",
    "audio",
    "data",
]

CONVERSATIONS_SESSIONS_PATH = Path("raw") / "conversations" / "sessions"
CONVERSATIONS_ROLLUPS_PATH = CONVERSATIONS_SESSIONS_PATH / "_rollups"
CONVERSATIONS_IMPORTED_PATH = Path("raw") / "conversations" / "imported"


# ---------------------------------------------------------------------------
# Action types. Kept as plain dataclasses so the dry-run printer is obvious
# and no framework is in the way.
# ---------------------------------------------------------------------------


@dataclass
class Action:
    kind: str  # mkdir | move | rename | delete | create_file | registry_add | skip
    src: Path | None
    dst: Path | None
    note: str = ""
    # For registry_add: the entry dict to merge into brains.json.
    registry_entry: dict | None = None

    def render(self, *, cwd: Path) -> str:
        def rel(p: Path | None) -> str:
            if p is None:
                return ""
            try:
                return str(p.relative_to(cwd))
            except ValueError:
                return str(p)

        icon = {
            "mkdir": "+ DIR ",
            "move": "~ MOVE",
            "rename": "~ RENM",
            "delete": "- DEL ",
            "create_file": "+ FILE",
            "registry_add": "+ REG ",
            "skip": "= SKIP",
        }.get(self.kind, "?    ")
        parts = [icon, rel(self.src) or "-"]
        if self.dst:
            parts.append("->")
            parts.append(rel(self.dst))
        if self.note:
            parts.append(f"  # {self.note}")
        if self.kind == "registry_add" and self.registry_entry:
            parts.append(f"  # id={self.registry_entry.get('id')!r}")
        return " ".join(parts)


@dataclass
class BrainPlan:
    brain_id: str
    brain_dir: Path
    actions: list[Action] = field(default_factory=list)

    def any_writes(self) -> bool:
        return any(a.kind != "skip" for a in self.actions)


# ---------------------------------------------------------------------------
# Planning — pure functions, no I/O side effects. Given a snapshot of the
# current brain directory, produce the list of actions that would bring it
# to the target shape.
# ---------------------------------------------------------------------------


def plan_brain(brain_dir: Path) -> BrainPlan:
    brain_id = brain_dir.name
    plan = BrainPlan(brain_id=brain_id, brain_dir=brain_dir)
    add = plan.actions.append

    # --- cache/ ------------------------------------------------------------
    # Holds OUR rebuildable derivatives (BM25, embeddings cache, rerank
    # cache, scratch). SQLite's WAL/SHM stay next to brain.db — that's
    # where rusqlite looks for them, and moving them silently disables
    # WAL journaling on the next open.
    cache_dir = brain_dir / "cache"
    if not cache_dir.exists():
        add(Action("mkdir", None, cache_dir, "rebuildable derivatives"))
    for sub in CACHE_SUBFOLDERS:
        p = cache_dir / sub
        if not p.exists():
            add(Action("mkdir", None, p))

    # --- vault/ ------------------------------------------------------------
    vault_dir = brain_dir / "vault"
    if not vault_dir.exists():
        add(Action("mkdir", None, vault_dir))
    for sub in VAULT_DEFAULT_SUBFOLDERS:
        p = vault_dir / sub
        if not p.exists():
            add(Action("mkdir", None, p, "default home (frontmatter is authoritative)"))

    # index.md + log.md: if they exist at brain root, move them into vault/
    # so the wiki is self-contained. If they already exist in vault/, the
    # vault copy is authoritative (it's auto-maintained by the indexer);
    # the root copy is stale pre-split residue. Under --clean-legacy we
    # delete it; otherwise we SKIP so the user can inspect.
    for name in ("index.md", "log.md"):
        root_version = brain_dir / name
        vault_version = vault_dir / name
        if root_version.exists():
            if vault_version.exists():
                root_size = root_version.stat().st_size
                vault_size = vault_version.stat().st_size
                if vault_size > root_size:
                    add(
                        Action(
                            "delete",
                            root_version,
                            None,
                            f"stale root {name} ({root_size}B);"
                            f" vault/{name} is canonical ({vault_size}B)",
                        )
                    )
                else:
                    add(
                        Action(
                            "skip",
                            root_version,
                            vault_version,
                            f"both exist and root is not smaller"
                            f" ({root_size}B vs {vault_size}B) — manual review",
                        )
                    )
            else:
                add(Action("move", root_version, vault_version))
        elif not vault_version.exists():
            # Bootstrap an empty one so the wiki shape is real from day one.
            add(Action("create_file", None, vault_version, "stub, user populates"))

    # --- raw/ --------------------------------------------------------------
    raw_dir = brain_dir / "raw"
    if not raw_dir.exists():
        add(Action("mkdir", None, raw_dir))

    # Keep existing raw/ subfolders untouched. Only enforce the new
    # conversations/{sessions,imported} split.
    old_raw_convo = raw_dir / "conversations"
    new_imported = raw_dir / CONVERSATIONS_IMPORTED_PATH.relative_to("raw")
    new_sessions = raw_dir / CONVERSATIONS_SESSIONS_PATH.relative_to("raw")
    new_rollups = raw_dir / CONVERSATIONS_ROLLUPS_PATH.relative_to("raw")

    if old_raw_convo.exists():
        has_imported = new_imported.exists()
        has_sessions = new_sessions.exists()
        if not has_imported and not has_sessions:
            # Existing raw/conversations/ holds imported chats. Can't
            # rename a dir into its own subdir on Windows, so stage through
            # a sibling temp name: conversations -> conversations_old ->
            # conversations/imported.
            staging = old_raw_convo.parent / "_conversations_staging"
            add(
                Action(
                    "rename",
                    old_raw_convo,
                    staging,
                    "stage existing raw/conversations/ for restructure",
                )
            )
            add(Action("mkdir", None, old_raw_convo, "recreate parent"))
            add(
                Action(
                    "rename",
                    staging,
                    new_imported,
                    "preserve existing imports under imported/",
                )
            )
            add(Action("mkdir", None, new_sessions, "live session logs land here"))
            add(Action("mkdir", None, new_rollups, "daily digests"))
        else:
            if not has_imported:
                add(Action("mkdir", None, new_imported))
            if not has_sessions:
                add(Action("mkdir", None, new_sessions))
            if not new_rollups.exists():
                add(Action("mkdir", None, new_rollups))
    else:
        add(Action("mkdir", None, new_imported))
        add(Action("mkdir", None, new_sessions))
        add(Action("mkdir", None, new_rollups))

    # --- assets/ -----------------------------------------------------------
    assets_dir = brain_dir / "assets"
    if not assets_dir.exists():
        add(Action("mkdir", None, assets_dir, "notes-reference this; distinct from raw/"))
    for sub in ASSETS_SUBFOLDERS:
        p = assets_dir / sub
        if not p.exists():
            add(Action("mkdir", None, p))

    # --- consolidated/ -----------------------------------------------------
    # The Python advanced-features pipeline (consolidation.py, themes
    # clustering) reads + writes here. Keeping the name stable so Python
    # doesn't need a refactor to land this migration. If later phases
    # modernise the Python side, rename to archive/ then.
    consol = brain_dir / "consolidated"
    if not consol.exists():
        add(Action("mkdir", None, consol, "Python consolidation output"))

    # --- config.json -------------------------------------------------------
    cfg_path = brain_dir / "config.json"
    if not cfg_path.exists():
        add(Action("create_file", None, cfg_path, "per-brain settings"))

    # --- Legacy cleanup (candidate — only under --clean-legacy) ----------
    engram_db = brain_dir / "engram.db"
    if engram_db.exists() and engram_db.stat().st_size == 0:
        add(Action("delete", engram_db, None, "zero-byte legacy from pre-rename"))

    # --- Already-complete case: if everything exists, dedupe to one skip
    if not plan.any_writes():
        plan.actions.append(Action("skip", brain_dir, None, "already migrated"))

    return plan


LEGACY_BRAIN_ID = "legacy-default"
LEGACY_BRAIN_NAME = "Legacy Default (pre-split)"
LEGACY_BRAIN_DESC = (
    "Brain resurrected from pre-multibrain residue at ~/.neurovault/"
    "{brain.db, vault/}. Preserved as a switchable archive so no data"
    " is lost; can be deleted later via the app if unwanted."
)


def plan_global_cleanup(
    nv_home: Path, *, resurrect_legacy: bool
) -> tuple[list[Action], dict | None]:
    """Actions at the ~/.neurovault/ root level — stray legacy residue.

    Returns (actions, resurrected_entry). If resurrect_legacy is set and
    stray root-level brain.db / vault/ are found, emits moves that relocate
    them under brains/{LEGACY_BRAIN_ID}/ and returns a registry entry to
    inject into brains.json. Otherwise falls back to flagging the stray
    content for manual review (never blind-deletes non-empty content).
    """
    actions: list[Action] = []
    resurrected: dict | None = None

    stray_db = nv_home / "brain.db"
    stray_vault = nv_home / "vault"

    def count_entries(p: Path) -> int:
        try:
            return sum(1 for _ in p.iterdir())
        except OSError:
            return 0

    vault_has_content = stray_vault.is_dir() and count_entries(stray_vault) > 0
    db_has_size = stray_db.exists() and stray_db.stat().st_size > 0
    stranded = vault_has_content or db_has_size

    if stranded and resurrect_legacy:
        target_brain = nv_home / "brains" / LEGACY_BRAIN_ID
        if target_brain.exists():
            actions.append(
                Action(
                    "skip",
                    target_brain,
                    None,
                    f"brains/{LEGACY_BRAIN_ID}/ already exists — cannot resurrect",
                )
            )
        else:
            actions.append(
                Action(
                    "mkdir",
                    None,
                    target_brain,
                    "resurrect stranded root into a real brain",
                )
            )
            if db_has_size:
                actions.append(
                    Action(
                        "move",
                        stray_db,
                        target_brain / "brain.db",
                        "pre-split DB becomes this brain's DB",
                    )
                )
            if vault_has_content:
                actions.append(
                    Action(
                        "rename",
                        stray_vault,
                        target_brain / "vault",
                        "pre-split vault/ becomes this brain's vault/",
                    )
                )
            resurrected = {
                "id": LEGACY_BRAIN_ID,
                "name": LEGACY_BRAIN_NAME,
                "description": LEGACY_BRAIN_DESC,
                # created_at is derived from the DB mtime if available,
                # otherwise left for brains.json to backfill on load.
                "created_at": None,
            }
            if stray_db.exists():
                try:
                    from datetime import datetime, timezone

                    mtime = datetime.fromtimestamp(
                        stray_db.stat().st_mtime, tz=timezone.utc
                    )
                    resurrected["created_at"] = mtime.isoformat()
                except OSError:
                    pass
            actions.append(
                Action(
                    "registry_add",
                    None,
                    nv_home / "brains.json",
                    "register resurrected brain in brains.json",
                    registry_entry=resurrected,
                )
            )
    else:
        # No resurrection requested — fall back to prior behaviour:
        # delete only empty/zero-sized residue, flag the rest for review.
        if stray_db.exists() and not db_has_size:
            actions.append(
                Action(
                    "delete",
                    stray_db,
                    None,
                    "stray root-level brain.db is zero bytes",
                )
            )
        elif db_has_size:
            actions.append(
                Action(
                    "skip",
                    stray_db,
                    None,
                    f"stray brain.db has {stray_db.stat().st_size} bytes —"
                    f" re-run with --resurrect-legacy to preserve it",
                )
            )
        if stray_vault.is_dir():
            if vault_has_content:
                n = count_entries(stray_vault)
                actions.append(
                    Action(
                        "skip",
                        stray_vault,
                        None,
                        f"stray vault/ has {n} entries —"
                        f" re-run with --resurrect-legacy to preserve it",
                    )
                )
            else:
                actions.append(
                    Action(
                        "delete",
                        stray_vault,
                        None,
                        "stray empty vault/ at root (pre-brains/ split)",
                    )
                )
    return actions, resurrected


# ---------------------------------------------------------------------------
# Safety checks — refuse to apply if any process looks like it's holding the
# DB open.
# ---------------------------------------------------------------------------


def check_no_running_neurovault() -> list[str]:
    """Return a list of offending process names; empty list means OK."""
    try:
        import psutil  # type: ignore
    except ImportError:
        # psutil missing — fall back to best-effort: we can't prove safety,
        # but nor can we prove a running process. Warn but don't block.
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


def check_wal_quiescent(brain_dir: Path, max_age_s: float = 2.0) -> bool:
    wal = brain_dir / "brain.db-wal"
    if not wal.exists():
        return True
    age = time.time() - wal.stat().st_mtime
    return age >= max_age_s


# ---------------------------------------------------------------------------
# Executor — applies a list of actions.
# ---------------------------------------------------------------------------


def execute(actions: list[Action], *, clean_legacy: bool) -> None:
    for a in actions:
        if a.kind == "skip":
            continue
        if a.kind == "mkdir":
            a.dst.mkdir(parents=True, exist_ok=True)
        elif a.kind == "move":
            a.dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(a.src), str(a.dst))
        elif a.kind == "rename":
            a.dst.parent.mkdir(parents=True, exist_ok=True)
            os.rename(a.src, a.dst)
        elif a.kind == "create_file":
            a.dst.parent.mkdir(parents=True, exist_ok=True)
            if not a.dst.exists():
                if a.dst.suffix == ".json":
                    a.dst.write_text("{}\n", encoding="utf-8")
                else:
                    a.dst.write_text("", encoding="utf-8")
        elif a.kind == "delete":
            if not clean_legacy:
                continue
            if a.src.is_dir():
                shutil.rmtree(a.src)
            else:
                a.src.unlink()
        elif a.kind == "registry_add":
            # Atomic write of brains.json with the new entry appended.
            registry_path = a.dst
            try:
                data = json.loads(registry_path.read_text(encoding="utf-8"))
            except FileNotFoundError:
                data = {"brains": []}
            brains_list = data.setdefault("brains", [])
            entry = dict(a.registry_entry or {})
            # Idempotency: skip if an entry with this id is already present.
            if not any(b.get("id") == entry.get("id") for b in brains_list):
                brains_list.append(entry)
                tmp = registry_path.with_suffix(".json.tmp")
                tmp.write_text(
                    json.dumps(data, indent=2, ensure_ascii=False) + "\n",
                    encoding="utf-8",
                )
                os.replace(tmp, registry_path)


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
    ap.add_argument(
        "--apply",
        action="store_true",
        help="actually perform the migration (default is dry-run)",
    )
    ap.add_argument(
        "--clean-legacy",
        action="store_true",
        help="remove identifiable legacy residue (zero-byte engram.db,"
        " stale root-level index.md/log.md where vault/ has a larger,"
        " canonical copy). Only takes effect with --apply.",
    )
    ap.add_argument(
        "--resurrect-legacy",
        action="store_true",
        help="preserve stray ~/.neurovault/{brain.db, vault/} by moving"
        " them into a new brain entry id='legacy-default' and registering"
        " it in brains.json. Use this when the stray content is real and"
        " you don't want to lose it.",
    )
    ap.add_argument(
        "--brain",
        help="migrate only this brain id (default: all brains in the registry)",
    )
    args = ap.parse_args(argv)

    nv_home = resolve_nv_home()
    if not nv_home.exists():
        print(f"error: NeuroVault home not found at {nv_home}", file=sys.stderr)
        return 2

    registry = nv_home / "brains.json"
    try:
        brains = json.loads(registry.read_text(encoding="utf-8")).get("brains", [])
    except FileNotFoundError:
        print(f"error: {registry} missing — is NeuroVault installed?", file=sys.stderr)
        return 2
    except json.JSONDecodeError as e:
        print(f"error: {registry} is not valid JSON: {e}", file=sys.stderr)
        return 2

    if args.brain:
        brains = [b for b in brains if b.get("id") == args.brain]
        if not brains:
            print(f"error: brain {args.brain!r} not found in registry", file=sys.stderr)
            return 2

    # --- Plan --------------------------------------------------------------
    global_actions, resurrected = plan_global_cleanup(
        nv_home, resurrect_legacy=args.resurrect_legacy
    )
    plans: list[BrainPlan] = []

    # If we're resurrecting, the target brain dir will exist after the
    # global actions run. Plan its per-brain migration too so the fresh
    # brain lands in the same target shape as all the others.
    brain_ids = [b.get("id") for b in brains if b.get("id")]
    if resurrected and resurrected["id"] not in brain_ids:
        brain_ids.append(resurrected["id"])

    for bid in brain_ids:
        bdir = nv_home / "brains" / bid
        if bdir.exists() or (
            resurrected and bid == resurrected["id"]
        ):
            plans.append(plan_brain(bdir))

    # --- Print plan --------------------------------------------------------
    mode_label = "APPLY" if args.apply else "DRY-RUN"
    print(f"NeuroVault layout migration  [{mode_label}]")
    print(f"home: {nv_home}")
    print(f"brains: {len(plans)}")
    print()

    if global_actions:
        print("== root-level cleanup ==")
        for a in global_actions:
            print(f"  {a.render(cwd=nv_home)}")
        print()

    for plan in plans:
        print(f"== brain: {plan.brain_id} ==")
        if not plan.actions:
            print("  (no changes)")
        else:
            for a in plan.actions:
                print(f"  {a.render(cwd=plan.brain_dir)}")
        print()

    if not args.apply:
        print("Dry-run complete. Re-run with --apply to execute.")
        return 0

    # --- Safety gates before writing --------------------------------------
    offenders = check_no_running_neurovault()
    if offenders:
        print(
            "refusing to apply: these processes are running and may hold brain.db:",
            file=sys.stderr,
        )
        for o in offenders:
            print(f"  - {o}", file=sys.stderr)
        print(
            "close the app / stop the MCP server / exit Claude Code and retry.",
            file=sys.stderr,
        )
        return 3

    for plan in plans:
        if not check_wal_quiescent(plan.brain_dir):
            print(
                f"refusing to apply: {plan.brain_id} brain.db-wal modified in"
                f" the last 2 seconds — a live connection may still be open.",
                file=sys.stderr,
            )
            return 3

    # --- Execute -----------------------------------------------------------
    execute(global_actions, clean_legacy=args.clean_legacy)
    for plan in plans:
        execute(plan.actions, clean_legacy=args.clean_legacy)

    print("Migration applied.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
