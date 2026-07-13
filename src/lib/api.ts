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
  /** Creation timestamp (SQLite TEXT). Optional — only present from the
   *  Rust /api/graph path. Used by the graph time-lapse to order nodes
   *  chronologically. */
  created_at?: string;
  /** Engram kind (note|source|…|code). Graphified source files arrive as
   *  kind="code" and get distinct gold styling + their own layer toggle. */
  kind?: string;
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

export interface BrainSummary {
  id: string;
  name: string;
  description?: string;
  is_active: boolean;
  vault_path?: string;
  stats?: {
    note_count: number;
    total_bytes: number;
    last_modified_secs: number;
  };
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

export const fetchGraph = (excludeTypes?: string[]) =>
  preferNv<GraphData>(
    async () => {
      const g = (await nvGetGraph({ excludeTypes })) as NvGraphData;
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
    () => {
      const qs =
        excludeTypes && excludeTypes.length
          ? `?exclude_types=${encodeURIComponent(excludeTypes.join(","))}`
          : "";
      return get<GraphData>(`/api/graph${qs}`);
    }
  );
export const fetchStatus = () => get<ServerStatus>("/api/status");
/** Brain-independent liveness probe. Unlike `/api/status` (which opens the
 *  active brain's DB and 500s on a fresh install with no brain yet), this
 *  returns 200 whenever the server is up — so it's the correct signal for
 *  the "connected / offline" indicator. */
export const fetchHealth = () => get<{ service: string; status: string }>("/api/health");
export const fetchBrains = () => get<BrainSummary[]>("/api/brains");
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

// jsonReq — small fetch wrapper used by activityApi below. Throws on
// non-2xx so callers can `.catch()` once and treat "server unreachable"
// the same as "server returned 5xx".
async function jsonReq<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

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

/** A consumer-facing receipt for one automatic context decision.
 * Prompt text is absent by default; the backend stores a hash unless the
 * user explicitly opts into prompt logging. Candidate titles and the
 * injected ids let Activity explain exactly which local memories were used. */
export interface ContextReceipt {
  event_id: string;
  ts: string;
  brain: string;
  host?: string | null;
  session_id?: string | null;
  decision: "inject" | "silent";
  reason: string;
  intent?: string | null;
  injected: string[];
  tokens: number;
  ms?: number;
  context_block_head?: string | null;
  candidates?: Array<{
    engram_id: string;
    title: string;
    signals?: string[];
  }>;
}

export type ContextReceiptFeedback = "useful" | "wrong_project" | "outdated";

export const activityApi = {
  recent: (limit = 50) => jsonReq<AuditEntry[]>(`/api/audit/recent?limit=${limit}`),
  contextReceipts: (limit = 50) =>
    jsonReq<{ records: ContextReceipt[]; count: number }>(`/api/ambient_log?limit=${limit}`).then(
      (data) => data.records ?? [],
    ),
  /** Append-only correction evidence for a delivered context receipt. This
   * never rewrites or deletes a memory; consolidation can later learn from
   * the human label with the exact decision event as provenance. */
  contextFeedback: (receipt: ContextReceipt, feedback: ContextReceiptFeedback) =>
    jsonReq<{ event_id: string; written: boolean }>("/api/journal_event", {
      method: "POST",
      body: JSON.stringify({
        brain_id: receipt.brain,
        event_type: "context_receipt_feedback",
        object_type: "context_decision",
        object_id: receipt.event_id,
        session_id: receipt.session_id ?? undefined,
        host: receipt.host ?? undefined,
        title: feedback === "useful" ? "Useful context" : feedback === "wrong_project" ? "Wrong vault" : "Outdated context",
        after: feedback,
        source_refs: [receipt.event_id],
        idempotency_key: `context-feedback:${receipt.event_id}:${feedback}`,
        capture_method: "review",
      }),
    }),
};
