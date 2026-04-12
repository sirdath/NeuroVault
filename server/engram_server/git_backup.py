"""Invisible git auto-backup per brain.

Initializes a git repo in each brain's vault/ dir and auto-commits on every
ingest. Solves the canonical dissertation failure mode: "I lost 6 months of
work because my sync service corrupted my vault."

Uses plain git CLI via subprocess (no libgit2 dependency). Silently ignores
errors so missing git doesn't block anything.
"""

import shutil
import subprocess
from datetime import datetime
from pathlib import Path

from loguru import logger


def git_available() -> bool:
    return shutil.which("git") is not None


def _run_git(args: list[str], cwd: Path) -> tuple[bool, str]:
    """Run a git command silently. Returns (success, output)."""
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=10,
        )
        return result.returncode == 0, (result.stdout or result.stderr).strip()
    except Exception as e:
        return False, str(e)


def init_backup_repo(vault_dir: Path) -> bool:
    """Initialize a git repo in the vault dir if not already one."""
    if not git_available():
        return False

    git_dir = vault_dir / ".git"
    if git_dir.exists():
        return True  # Already initialized

    vault_dir.mkdir(parents=True, exist_ok=True)

    ok, out = _run_git(["init", "-q", "-b", "main"], vault_dir)
    if not ok:
        logger.debug("Git init failed: {}", out)
        return False

    # Configure identity so commits work even if user hasn't set global config
    _run_git(["config", "user.email", "neurovault@local"], vault_dir)
    _run_git(["config", "user.name", "NeuroVault"], vault_dir)

    # Initial commit
    _run_git(["add", "-A"], vault_dir)
    _run_git(["commit", "-q", "--allow-empty", "-m", "NeuroVault: brain initialized"], vault_dir)

    logger.info("Initialized git backup in {}", vault_dir)
    return True


def auto_commit(vault_dir: Path, message: str = "") -> bool:
    """Commit any pending changes in the vault. Silently no-ops if git isn't set up."""
    if not git_available():
        return False

    git_dir = vault_dir / ".git"
    if not git_dir.exists():
        return False

    # Stage everything
    _run_git(["add", "-A"], vault_dir)

    # Check if there's anything to commit
    ok, out = _run_git(["status", "--porcelain"], vault_dir)
    if ok and not out.strip():
        return False  # Nothing changed

    commit_msg = message or f"auto: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
    ok, _ = _run_git(["commit", "-q", "-m", commit_msg], vault_dir)
    return ok


def get_history(vault_dir: Path, limit: int = 20) -> list[dict]:
    """Get recent commits for this vault."""
    if not git_available():
        return []
    git_dir = vault_dir / ".git"
    if not git_dir.exists():
        return []

    ok, out = _run_git(
        ["log", f"-n{limit}", "--pretty=format:%h|%at|%s"],
        vault_dir,
    )
    if not ok or not out:
        return []

    history = []
    for line in out.split("\n"):
        parts = line.split("|", 2)
        if len(parts) == 3:
            history.append({
                "hash": parts[0],
                "timestamp": int(parts[1]),
                "message": parts[2],
            })
    return history


def restore_file(vault_dir: Path, filename: str, commit_hash: str) -> dict:
    """Restore a single file to a previous commit."""
    if not git_available():
        return {"error": "git not available"}
    git_dir = vault_dir / ".git"
    if not git_dir.exists():
        return {"error": "no backup repo"}

    ok, out = _run_git(["checkout", commit_hash, "--", filename], vault_dir)
    if ok:
        return {"status": "restored", "filename": filename, "commit": commit_hash}
    return {"error": out}
