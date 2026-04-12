"""Export/import a brain as a tar.gz archive.

Lets users back up, share, or migrate a brain. The archive contains:
- vault/        (markdown notes)
- raw/          (originals)
- consolidated/ (auto-generated themes)
- brain.db      (optional — or regenerate from vault)

By default the DB is excluded (regenerated on import) to keep archives
portable across schema versions.
"""

import json
import shutil
import tarfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

from loguru import logger


def export_brain(
    brain_id: str,
    brain_dir: Path,
    output_path: Path | None = None,
    include_db: bool = False,
) -> dict:
    """Bundle a brain into a tar.gz archive.

    Args:
        brain_id: The brain's UUID
        brain_dir: Absolute path to ~/.engram/brains/{brain_id}/
        output_path: Where to save the archive (temp dir if None)
        include_db: If True, include brain.db (larger but instant re-import)

    Returns:
        {"status", "archive_path", "size_bytes", "file_count"}
    """
    if not brain_dir.exists():
        return {"error": f"Brain directory not found: {brain_dir}"}

    if output_path is None:
        import tempfile
        tmp_dir = Path(tempfile.gettempdir()) / "neurovault-exports"
        tmp_dir.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        output_path = tmp_dir / f"brain-{brain_id}-{timestamp}.tar.gz"

    manifest = {
        "format_version": 1,
        "brain_id": brain_id,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "neurovault_version": "0.9",
        "include_db": include_db,
    }

    file_count = 0
    try:
        with tarfile.open(str(output_path), "w:gz") as tar:
            # Add manifest
            import io
            manifest_json = json.dumps(manifest, indent=2).encode()
            info = tarfile.TarInfo(name="manifest.json")
            info.size = len(manifest_json)
            tar.addfile(info, io.BytesIO(manifest_json))

            # Include core directories
            for subdir in ("vault", "raw", "consolidated"):
                src = brain_dir / subdir
                if src.exists():
                    tar.add(str(src), arcname=subdir)
                    file_count += sum(1 for _ in src.rglob("*") if _.is_file())

            # Optionally include DB
            if include_db:
                db_path = brain_dir / "brain.db"
                if db_path.exists():
                    tar.add(str(db_path), arcname="brain.db")
                    file_count += 1

    except Exception as e:
        return {"error": f"Export failed: {e}"}

    size = output_path.stat().st_size
    logger.info(
        "Exported brain {} to {} ({} files, {:.1f} KB)",
        brain_id[:8], output_path.name, file_count, size / 1024,
    )

    return {
        "status": "ok",
        "archive_path": str(output_path),
        "size_bytes": size,
        "file_count": file_count,
    }


def import_brain(
    archive_path: Path,
    brains_dir: Path,
    new_brain_id: str | None = None,
) -> dict:
    """Import a brain from a tar.gz archive.

    Args:
        archive_path: Path to the .tar.gz file
        brains_dir: Where to unpack (usually ~/.engram/brains/)
        new_brain_id: Optional override for the brain ID (new UUID if None)

    Returns:
        {"status", "brain_id", "file_count", "manifest"}
    """
    if not archive_path.exists():
        return {"error": f"Archive not found: {archive_path}"}

    target_id = new_brain_id or str(uuid.uuid4())
    target_dir = brains_dir / target_id

    if target_dir.exists():
        return {"error": f"Brain {target_id} already exists — refusing to overwrite"}

    try:
        target_dir.mkdir(parents=True, exist_ok=True)
        with tarfile.open(str(archive_path), "r:gz") as tar:
            # Extract everything
            tar.extractall(str(target_dir))

            # Read manifest if present
            manifest = {}
            manifest_file = target_dir / "manifest.json"
            if manifest_file.exists():
                try:
                    manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
                    manifest_file.unlink()  # Remove after reading
                except Exception:
                    pass

        file_count = sum(1 for _ in target_dir.rglob("*") if _.is_file())

    except Exception as e:
        # Clean up on failure
        if target_dir.exists():
            shutil.rmtree(str(target_dir))
        return {"error": f"Import failed: {e}"}

    logger.info("Imported brain from {} to {} ({} files)",
                archive_path.name, target_dir.name, file_count)

    return {
        "status": "ok",
        "brain_id": target_id,
        "target_dir": str(target_dir),
        "file_count": file_count,
        "manifest": manifest,
    }
