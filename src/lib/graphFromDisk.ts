/**
 * Fallback graph builder — reads the vault from disk via Tauri commands
 * and assembles a minimal graph without needing the Python server running.
 *
 * Used whenever /api/graph fails (server off, starting up, cold-booting).
 * The frontend can still render a meaningful visualisation because every
 * note is a plain markdown file on disk. We lose the SQLite-derived
 * signal (access_count, strength, state, semantic/entity edges) but we
 * keep wikilink edges and the complete node set — which is most of what
 * a user wants to look at.
 *
 * Nodes in the result mirror the ``GraphNode`` shape the server returns
 * so downstream code doesn't need to branch on source.
 */

import * as tauri from "./tauri";
import type { GraphNode, GraphEdge } from "./api";

/** Match [[Target]] or [[Target|display]] — captures the target title. */
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

/** Pull the title from the first H1 line or fall back to the filename stem.
 *  Matches the server's behaviour (ingest._extract_title_from_md) so nodes
 *  carry the same identity whether they came from disk or from /api/graph. */
function titleFromContent(content: string, fallback: string): string {
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (t.startsWith("# ")) {
      const title = t.slice(2).trim();
      if (title) return title;
    }
  }
  return fallback;
}

/** filename "agent/foo.md" → folder "agent". Top-level notes → "". */
export function folderOf(filename: string): string {
  const idx = filename.lastIndexOf("/");
  return idx > 0 ? filename.slice(0, idx) : "";
}

export interface DiskGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  source: "disk";
}

/** Build a graph from the vault on disk. No SQLite, no server.
 *  Edges are limited to [[wikilink]] resolutions (title-matched, like the
 *  server's manual-link path). Unresolved wikilinks are silently dropped.
 */
export async function buildGraphFromDisk(): Promise<DiskGraph> {
  const noteMetas = await tauri.listNotes();

  // Title → filename index, built in one pass so we can resolve wikilinks
  // without re-scanning the whole list per note.
  const titleToFilename = new Map<string, string>();
  const fileToNode = new Map<string, GraphNode>();

  // First pass: nodes. Read each file for title + folder attribution.
  const contents = await Promise.all(
    noteMetas.map(async (n) => {
      try { return [n.filename, await tauri.readNote(n.filename)] as const; }
      catch { return [n.filename, ""] as const; }
    }),
  );

  for (const [filename, content] of contents) {
    const title = titleFromContent(content, filename.replace(/\.md$/i, "").split("/").pop() ?? filename);
    const node: GraphNode = {
      // Use filename as the stable id — downstream click handlers match by
      // title anyway, so the id just needs to be unique across the vault.
      id: filename,
      title,
      state: "active",
      strength: 0.6,
      access_count: 1,
      folder: folderOf(filename),
    } as GraphNode & { folder: string };
    fileToNode.set(filename, node);
    titleToFilename.set(title.toLowerCase(), filename);
  }

  // Second pass: resolve [[wikilinks]] → edges. Case-insensitive title
  // match; cross-folder and typed-link syntax is collapsed to "manual".
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const [filename, content] of contents) {
    const fromNode = fileToNode.get(filename);
    if (!fromNode) continue;
    WIKILINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WIKILINK_RE.exec(content)) !== null) {
      const rawTarget = m[1]?.trim();
      if (!rawTarget) continue;
      const targetFile = titleToFilename.get(rawTarget.toLowerCase());
      if (!targetFile || targetFile === filename) continue;
      // Undirected pair key so we don't add both directions.
      const a = filename < targetFile ? filename : targetFile;
      const b = filename < targetFile ? targetFile : filename;
      const key = `${a}→${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        from: filename,
        to: targetFile,
        similarity: 1.0,
        link_type: "manual",
      });
    }
  }

  return {
    nodes: Array.from(fileToNode.values()),
    edges,
    source: "disk",
  };
}
