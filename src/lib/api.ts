/** HTTP client for the in-process Rust HTTP backend at 127.0.0.1:8765.
 *  Base URL comes from `lib/config`. (Originally the Python MCP server
 *  owned this port; the Rust backend in v0.1.0+ exposes the same
 *  `/api/*` surface so this client didn't need to change shape.)
 *
 *  Phase-4 note: a handful of read-path calls (`fetchGraph`, `fetchNote`,
 *  `fetchNotesList`) try the in-process Rust `nv_*` Tauri commands
 *  first and fall back to HTTP when those commands aren't registered —
 *  either because we're in plain-browser mode or because the installed
 *  Tauri build predates Phase 4. Callers of `fetchGraph` etc. don't see
 *  which path served the request. */

import { API_HOST } from "./config";
import {
  nvGetGraph,
  nvGetNote,
  nvListNotes,
  nvRecall,
  type NvFullNote,
  type NvGraphData,
  type NvNoteListRow,
} from "./tauri";

const BASE = API_HOST;

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// --- Types ---

export interface GraphNode {
  id: string;
  title: string;
  state: string;
  strength: number;
  access_count: number;
  /** Top-level folder the note sits in (e.g. "projects", "agent", "").
   *  Populated by the server when /api/graph is used, or by the
   *  disk-fallback builder. Used client-side for cluster-by-folder
   *  layout and coloring in the graph view. */
  folder?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  similarity: number;
  link_type: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ServerStatus {
  memories: number;
  chunks: number;
  entities: number;
  connections: number;
  indexing: string[];
}

export interface SessionContext {
  l0: string;
  l1: string;
  stats: { total_memories: number; total_connections: number };
}

export interface NoteDetail {
  id: string;
  filename: string;
  title: string;
  content: string;
  state: string;
  strength: number;
  access_count: number;
  connections: { engram_id: string; title: string; similarity: number; link_type: string }[];
  entities: { name: string; type: string }[];
}

export interface RecallResult {
  engram_id: string;
  title: string;
  content?: string;
  preview?: string;
  score: number;
  strength: number;
  state: string;
  kind?: string;
  filename?: string;
}

// --- API calls ---

export const recall = (query: string, limit = 8) =>
  preferNv<RecallResult[]>(
    async () => {
      const hits = await nvRecall(query, { limit });
      // NvRecallHit → RecallResult has the same keys (engram_id, title,
      // content, score, strength, state) so the cast is safe — the
      // optional fields (preview, kind, filename) simply stay undefined
      // when the Rust path served the request.
      return hits as unknown as RecallResult[];
    },
    () => get<RecallResult[]>(`/api/recall?q=${encodeURIComponent(query)}&limit=${limit}`)
  );

/** Rust nv_* commands aren't registered on older Tauri builds and
 *  aren't available in plain-browser mode. Any error from the invoke
 *  call (missing command, sidecar-only features, serialisation
 *  mismatch) pushes us to the HTTP fallback so callers never see a
 *  broken read path. We don't log — the HTTP call that follows either
 *  succeeds and users see their data, or fails and its own error
 *  message is surfaced by the caller. */
async function preferNv<T>(nv: () => Promise<T>, http: () => Promise<T>): Promise<T> {
  try {
    return await nv();
  } catch {
    return http();
  }
}

export const fetchGraph = () =>
  preferNv<GraphData>(
    async () => {
      const g = (await nvGetGraph()) as NvGraphData;
      // Rust serializes absent `folder` as JSON `null`; GraphData wants
      // `string | undefined`. One-shot normalise so downstream callers
      // can treat the two transports identically.
      return {
        nodes: g.nodes.map((n) => ({
          ...n,
          folder: n.folder ?? undefined,
        })),
        edges: g.edges,
      };
    },
    () => get<GraphData>("/api/graph")
  );
export const fetchStatus = () => get<ServerStatus>("/api/status");
export const fetchSessionContext = () => get<SessionContext>("/api/session-context");
export const fetchNote = (id: string) =>
  preferNv<NoteDetail>(
    async () => {
      const full = (await nvGetNote(id)) as NvFullNote;
      return full as unknown as NoteDetail;
    },
    () => get<NoteDetail>(`/api/notes/${id}`)
  );
export interface NoteSummary {
  id: string;
  filename: string;
  title: string;
  state: string;
  strength: number;
  access_count: number;
  updated_at: string;
  kind?: string;
}

export async function fetchNotesList(): Promise<NoteSummary[]> {
  // Rust `nv_list_notes` first — if it throws (command not registered
  // or browser mode) fall through to the HTTP path. Empty-on-error
  // behaviour stays the same so the sidebar never crashes.
  try {
    const rows = (await nvListNotes()) as NvNoteListRow[];
    return rows;
  } catch {
    try {
      const res = await fetch(`${BASE}/api/notes`);
      if (!res.ok) return [];
      return res.json();
    } catch {
      return [];
    }
  }
}

// jsonReq — small fetch wrapper used by compilationApi + activityApi
// below. Throws on non-2xx so callers can `.catch()` once and treat
// "server unreachable" the same as "server returned 5xx".
async function jsonReq<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// --- Knowledge compiler (wiki page synthesis) ------------------------------

export interface CompilationChangelogEntry {
  change: "added" | "updated" | "removed" | string;
  field: string;
  before: string | null;
  after: string | null;
  reason: string;
  source_ids: string[];
}

export interface CompilationSource {
  id: string;
  title: string;
  kind: string;
}

export interface CompilationSummary {
  id: string;
  topic: string;
  status: "pending" | "approved" | "rejected" | string;
  model: string;
  change_count: number;
  source_count: number;
  input_tokens: number;
  output_tokens: number;
  created_at: string;
  reviewed_at: string | null;
}

export interface CompilationDetail extends CompilationSummary {
  wiki_engram_id: string | null;
  old_content: string;
  new_content: string;
  changelog: CompilationChangelogEntry[];
  sources: CompilationSource[];
  review_comment: string | null;
}

export const compilationApi = {
  list: (status?: string, limit = 50) => {
    const q = new URLSearchParams();
    if (status) q.set("status", status);
    q.set("limit", String(limit));
    return jsonReq<CompilationSummary[]>(`/api/compilations?${q}`);
  },
  pending: () => jsonReq<CompilationSummary[]>("/api/compilations/pending"),
  get: (id: string) => jsonReq<CompilationDetail>(`/api/compilations/${id}`),
  approve: (id: string, comment?: string) =>
    jsonReq<{ status: string }>(`/api/compilations/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({ review_comment: comment ?? null }),
    }),
  reject: (id: string, comment?: string) =>
    jsonReq<{ status: string }>(`/api/compilations/${id}/reject`, {
      method: "POST",
      body: JSON.stringify({ review_comment: comment ?? null }),
    }),
};

// --- Activity / audit log --------------------------------------------------

export interface AuditEntry {
  ts: string;
  tool: string;
  args: Record<string, unknown>;
  result_ids?: string[];
  result_count?: number;
  modified_ids?: string[];
  session_id?: string;
  error?: string;
  duration_ms?: number;
  status_code?: number;
}

export const activityApi = {
  recent: (limit = 50) => jsonReq<AuditEntry[]>(`/api/audit/recent?limit=${limit}`),
};
