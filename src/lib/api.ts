/** HTTP client for the Python MCP server (localhost:8765) */

const BASE = "http://127.0.0.1:8765";

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

export interface StrengthStats {
  distribution: Record<string, number>;
  average_strength: number;
}

export interface Backlink {
  engram_id: string;
  title: string;
  similarity: number;
  link_type: string;
}

// --- API calls ---

export const fetchGraph = () => get<GraphData>("/api/graph");
export const fetchStatus = () => get<ServerStatus>("/api/status");
export const fetchSessionContext = () => get<SessionContext>("/api/session-context");
export const fetchNote = (id: string) => get<NoteDetail>(`/api/notes/${id}`);
export const fetchStrength = () => get<StrengthStats>("/api/strength");
export const fetchBacklinks = (id: string) => get<Backlink[]>(`/api/backlinks/${id}`);

export interface WorkingMemoryItem {
  engram_id: string;
  title: string;
  preview: string;
  strength: number;
  priority: number;
  pin_type: string;
}

export interface Contradiction {
  id: string;
  note_a: string;
  note_b: string;
  fact_a: string;
  fact_b: string;
  detected_at: string;
}

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

// Working memory (auto-refreshed by consolidation)
export async function fetchWorkingMemory(): Promise<WorkingMemoryItem[]> {
  try {
    const res = await fetch(`${BASE}/api/notes`);
    if (!res.ok) return [];
    // Server doesn't expose WM directly via HTTP — fetch via a custom endpoint
    const wm = await fetch(`${BASE}/api/working-memory`).then((r) => r.json()).catch(() => []);
    return wm;
  } catch {
    return [];
  }
}

export async function fetchContradictions(): Promise<Contradiction[]> {
  try {
    const res = await fetch(`${BASE}/api/contradictions`);
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

export async function fetchNotesList(): Promise<NoteSummary[]> {
  try {
    const res = await fetch(`${BASE}/api/notes`);
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

// --- Drafts ---

export interface DraftSummary {
  draft_id: string;
  title: string;
  description: string;
  target_words: number;
  deadline: string | null;
  created_at: string;
  updated_at: string;
  section_count: number;
  word_count: number;
  progress: number | null;
}

export interface DraftSection {
  engram_id: string;
  title: string;
  position: number;
  word_count: number;
  preview: string;
}

export interface DraftDetail {
  draft_id: string;
  title: string;
  description: string;
  target_words: number;
  deadline: string | null;
  word_count: number;
  progress: number | null;
  sections: DraftSection[];
}

async function jsonReq<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export const draftsApi = {
  list: () => jsonReq<DraftSummary[]>("/api/drafts"),
  get: (id: string) => jsonReq<DraftDetail>(`/api/drafts/${id}`),
  create: (data: { title: string; description?: string; target_words?: number; deadline?: string }) =>
    jsonReq<{ draft_id: string; title: string }>("/api/drafts", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    jsonReq<{ status: string }>(`/api/drafts/${id}`, { method: "DELETE" }),
  addSection: (draftId: string, engramId: string, position?: number) =>
    jsonReq<{ status: string }>(`/api/drafts/${draftId}/sections`, {
      method: "POST",
      body: JSON.stringify({ engram_id: engramId, position }),
    }),
  removeSection: (draftId: string, engramId: string) =>
    jsonReq<{ status: string }>(`/api/drafts/${draftId}/sections/${engramId}`, {
      method: "DELETE",
    }),
  reorder: (draftId: string, engramId: string, position: number) =>
    jsonReq<{ status: string }>(
      `/api/drafts/${draftId}/sections/${engramId}/move`,
      { method: "POST", body: JSON.stringify({ position }) }
    ),
  export: (id: string, format: string = "docx") =>
    jsonReq<{ status: string; output_path?: string; error?: string }>(
      `/api/drafts/${id}/export`,
      { method: "POST", body: JSON.stringify({ format }) }
    ),
};

// --- Working memory + contradictions ---

export const workingMemoryApi = {
  list: () => jsonReq<WorkingMemoryItem[]>("/api/working-memory"),
  pin: (id: string) =>
    jsonReq<{ status: string }>(`/api/working-memory/pin/${id}`, { method: "POST" }),
  unpin: (id: string) =>
    jsonReq<{ status: string }>(`/api/working-memory/${id}`, { method: "DELETE" }),
};

export const contradictionsApi = {
  list: () => jsonReq<Contradiction[]>("/api/contradictions"),
  resolve: (id: string, resolution?: string) =>
    jsonReq<{ status: string }>(`/api/contradictions/${id}/resolve`, {
      method: "POST",
      body: JSON.stringify({ resolution: resolution ?? "manually_resolved" }),
    }),
};
