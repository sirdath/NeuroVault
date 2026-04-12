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
