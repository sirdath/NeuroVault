"""Zotero Better BibTeX live sync.

Polls the BBT JSON-RPC endpoint (http://localhost:23119/better-bibtex/json-rpc)
and ingests each library item as a Source engram. Abstracts are embedded for
semantic search. Citekeys become the canonical reference.

Required: Zotero running with Better BibTeX extension installed.
"""

import json
import re
import uuid
from pathlib import Path
from typing import Any

import urllib.request
import urllib.error

from loguru import logger

from engram_server.database import Database
from engram_server.embeddings import Embedder


BBT_RPC_URL = "http://localhost:23119/better-bibtex/json-rpc"
BBT_TIMEOUT = 5.0  # seconds


def check_zotero_running() -> bool:
    """Quick health check — is Zotero + BBT reachable?"""
    try:
        req = urllib.request.Request(
            BBT_RPC_URL,
            data=json.dumps({"jsonrpc": "2.0", "method": "user.groups", "params": [], "id": 1}).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=2.0):
            return True
    except Exception:
        return False


def _rpc_call(method: str, params: list[Any] | None = None) -> dict:
    """Call a BBT JSON-RPC method."""
    payload = {
        "jsonrpc": "2.0",
        "method": method,
        "params": params or [],
        "id": 1,
    }
    req = urllib.request.Request(
        BBT_RPC_URL,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=BBT_TIMEOUT) as resp:
            data = json.loads(resp.read().decode())
            if "error" in data:
                raise RuntimeError(f"BBT RPC error: {data['error']}")
            return data.get("result", {})
    except urllib.error.URLError as e:
        raise ConnectionError(f"Cannot reach Zotero BBT at {BBT_RPC_URL}: {e}")


def list_collections() -> list[dict]:
    """List all Zotero collections (library folders)."""
    try:
        return _rpc_call("item.collections", [])
    except Exception as e:
        logger.warning("Failed to list collections: {}", e)
        return []


def search_items(query: str = "", library_id: int | None = None) -> list[dict]:
    """Search Zotero library items. Empty query returns all."""
    try:
        params = [query] if library_id is None else [query, library_id]
        result = _rpc_call("item.search", params)
        if isinstance(result, list):
            return result
        return []
    except Exception as e:
        logger.warning("Failed to search items: {}", e)
        return []


def sync_library(
    vault_dir: Path,
    db: Database,
    embedder: Embedder,
    bm25,
    query: str = "",
) -> dict:
    """Sync Zotero library items as Source engrams.

    For each matching item:
    - Create a source-{citekey}.md note in the vault
    - Include metadata (author, year, journal, tags, DOI, abstract)
    - Run full ingestion pipeline (embeddings, entities, links)

    Skips items already synced (same citekey + same content hash).
    """
    from engram_server.ingest import ingest_file

    if not check_zotero_running():
        return {
            "error": "Zotero not reachable",
            "hint": "Start Zotero and install the Better BibTeX extension",
        }

    items = search_items(query)
    if not items:
        return {"status": "ok", "synced": 0, "skipped": 0, "message": "No items found"}

    synced = 0
    skipped = 0

    for item in items:
        try:
            citekey = _extract_citekey(item)
            if not citekey:
                skipped += 1
                continue

            slug = re.sub(r"[^a-z0-9]+", "-", citekey.lower()).strip("-")
            filename = f"source-{slug}.md"
            filepath = vault_dir / filename

            md_content = _item_to_markdown(item, citekey)

            # Skip if unchanged
            if filepath.exists():
                if filepath.read_text(encoding="utf-8") == md_content:
                    skipped += 1
                    continue

            filepath.write_text(md_content, encoding="utf-8")
            ingest_file(filepath, db, embedder, bm25)
            synced += 1

        except Exception as e:
            logger.warning("Failed to sync item: {}", e)
            skipped += 1

    logger.info("Zotero sync: {} synced, {} skipped", synced, skipped)
    return {
        "status": "ok",
        "synced": synced,
        "skipped": skipped,
        "total_items": len(items),
    }


def _extract_citekey(item: dict) -> str:
    """Extract the citekey from a BBT item (various possible fields)."""
    return (
        item.get("citationKey")
        or item.get("citekey")
        or item.get("citation-key")
        or ""
    )


def _item_to_markdown(item: dict, citekey: str) -> str:
    """Convert a Zotero item dict to a NeuroVault Source markdown note."""
    title = item.get("title", "Untitled")
    authors = _format_authors(item.get("creators", []))
    year = _extract_year(item)
    journal = item.get("publicationTitle", "") or item.get("journalAbbreviation", "")
    doi = item.get("DOI", "")
    abstract = item.get("abstractNote", "")
    tags = item.get("tags", [])
    tag_names = [t.get("tag", t) if isinstance(t, dict) else str(t) for t in tags]

    lines = [
        f"# {title}",
        "",
        f"**Type:** Source (Zotero)",
        f"**Citekey:** `{citekey}`",
    ]
    if authors:
        lines.append(f"**Author:** {authors}")
    if year:
        lines.append(f"**Year:** {year}")
    if journal:
        lines.append(f"**Journal:** {journal}")
    if doi:
        lines.append(f"**DOI:** {doi}")
    if tag_names:
        lines.append(f"**Tags:** {', '.join(f'#{t}' for t in tag_names)}")
    lines.append("")

    if abstract:
        lines.append("## Abstract")
        lines.append("")
        lines.append(abstract.strip())
        lines.append("")

    lines.append("---")
    lines.append("")
    lines.append("*Imported from Zotero. Edit freely — the import will not overwrite your changes.*")

    return "\n".join(lines)


def _format_authors(creators: list[dict]) -> str:
    """Format author list: Last, F. & Last, F."""
    names = []
    for c in creators:
        if c.get("creatorType") not in ("author", None):
            continue
        last = c.get("lastName", "") or c.get("name", "").split()[-1] if c.get("name") else ""
        first = c.get("firstName", "")
        if first:
            initial = first[0] + "."
            names.append(f"{last}, {initial}")
        else:
            names.append(last)
    return " & ".join(filter(None, names))


def _extract_year(item: dict) -> str:
    """Get publication year from date field."""
    date = item.get("date", "") or item.get("parsedDate", "")
    match = re.search(r"\b(19|20)\d{2}\b", str(date))
    return match.group(0) if match else ""
