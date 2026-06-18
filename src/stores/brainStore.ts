import { create } from "zustand";
import { useNoteStore } from "./noteStore";

export interface BrainInfo {
  id: string;
  name: string;
  description: string;
  created_at: string;
  is_active: boolean;
  vault_path?: string;
}

export interface IngestProgress {
  phase: "starting" | "ingesting" | "linking" | "indexing" | "ready" | "idle" | "unknown";
  files_done: number;
  files_total: number;
  current_file: string;
}

import { API_HOST } from "../lib/config";
const API = API_HOST;

// --- Per-brain source folders -----------------------------------------------

export interface BrainSource {
  path: string;
  enabled: boolean;
  last_synced: string | null;
  file_count: number;
}

interface SourcesResponse {
  sources: BrainSource[];
}

interface SyncSourcesResult {
  synced: number;
  removed: number;
  skipped_duplicates: number;
}

/** Read-only preview of what a sync would do (the /sources/preview dry run).
 * The list fields hold source-file absolute paths. */
export interface SyncPlan {
  to_add: string[];
  to_update: string[];
  to_remove: string[];
  duplicates: string[];
  unchanged: number;
}

/** Result of indexing a source folder's CODE into the on-device knowledge
 * graph via the native (Rust, tree-sitter) graphify pipeline — no Python. */
export interface GraphifyResult {
  files: number;
  symbols: number;
  calls: number;
  edges: number;
}

interface BrainStore {
  brains: BrainInfo[];
  activeBrainId: string | null;
  activeBrainName: string;
  loading: boolean;
  ingest: IngestProgress | null;

  loadBrains: () => Promise<void>;
  switchBrain: (brainId: string) => Promise<void>;
  createBrain: (
    name: string,
    description: string,
    vaultPath?: string,
  ) => Promise<{ brain_id: string; name: string; vault_path?: string; is_external?: boolean } | null>;
  updateBrain: (brainId: string, patch: { name?: string; description?: string }) => Promise<boolean>;
  deleteBrain: (brainId: string) => Promise<boolean>;
  listSources: (brainId: string) => Promise<BrainSource[]>;
  setSources: (brainId: string, sources: { path: string; enabled: boolean }[]) => Promise<BrainSource[]>;
  previewSources: (brainId: string) => Promise<SyncPlan>;
  syncSources: (brainId: string) => Promise<SyncSourcesResult>;
  graphifyFolder: (brainId: string, path: string) => Promise<GraphifyResult>;
}

export const useBrainStore = create<BrainStore>((set, get) => ({
  brains: [],
  activeBrainId: null,
  activeBrainName: "Default",
  loading: false,
  ingest: null,

  loadBrains: async () => {
    // Try the HTTP server first — richer payload (created_at, is_external).
    // Fall back to the Tauri filesystem command when the sidecar is off so
    // the BrainSelector dropdown still lists every vault the user has.
    try {
      const res = await fetch(`${API}/api/brains`);
      if (res.ok) {
        const brains: BrainInfo[] = await res.json();
        const active = brains.find((b) => b.is_active);
        set({
          brains,
          activeBrainId: active?.id ?? null,
          activeBrainName: active?.name ?? "Default",
        });
        return;
      }
    } catch {
      // Server unreachable — fall through to disk.
    }

    try {
      const { invoke } = await import("@tauri-apps/api/core");
      type DiskBrain = {
        id: string;
        name: string;
        description: string | null;
        vault_path: string | null;
        is_active: boolean;
      };
      const rows = await invoke<DiskBrain[]>("list_brains_offline");
      const brains: BrainInfo[] = rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description ?? "",
        created_at: "", // disk fallback doesn't surface created_at
        is_active: r.is_active,
        vault_path: r.vault_path ?? undefined,
      }));
      const active = brains.find((b) => b.is_active);
      set({
        brains,
        activeBrainId: active?.id ?? null,
        activeBrainName: active?.name ?? "Default",
      });
    } catch {
      // Neither server nor Tauri fs worked — probably running in a browser
      // build. Leave the list empty rather than throwing.
    }
  },

  switchBrain: async (brainId: string) => {
    set({ loading: true, ingest: { phase: "starting", files_done: 0, files_total: 0, current_file: "" } });

    // The activate call blocks on ingest (30-60s for a fresh Obsidian
    // vault). Poll /ingest_status in parallel so the UI can show live
    // progress instead of freezing silently. Both run concurrently —
    // FastAPI handles sync endpoints in a thread pool so the poll
    // doesn't stall behind the activate.
    const poller = window.setInterval(async () => {
      try {
        const r = await fetch(`${API}/api/brains/${brainId}/ingest_status`);
        if (!r.ok) return;
        const p = await r.json();
        set({ ingest: p });
        if (p.phase === "ready") window.clearInterval(poller);
      } catch { /* ignore — will retry */ }
    }, 500);

    try {
      // Try the server's activate endpoint first — gives us live progress
      // and triggers reingest. If the sidecar is off, fall back to a pure
      // filesystem switch (rewrite brains.json) so brain switching still
      // works offline for read / edit flows.
      let usedServer = false;
      try {
        const res = await fetch(`${API}/api/brains/${brainId}/activate`, {
          method: "POST",
        });
        if (res.ok) {
          const data = await res.json();
          set({ activeBrainId: data.brain_id, activeBrainName: data.name });
          usedServer = true;
        }
      } catch {
        /* fall through to offline path */
      }

      if (!usedServer) {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke<string>("set_active_brain_offline", { brainId });
        const target = get().brains.find((b) => b.id === brainId);
        set({
          activeBrainId: brainId,
          activeBrainName: target?.name ?? brainId,
          // No live ingest in offline mode — graph fallback handles it
          ingest: { phase: "ready", files_done: 0, files_total: 0, current_file: "" },
        });
      }

      // Clear state from the previous brain before loading the new one —
      // the previously-open note, search, and dirty buffer all belong to
      // a different vault now. Without this, switching could show an
      // old title with empty content or cross-contaminate the save buffer.
      useNoteStore.setState({
        activeFilename: null,
        activeContent: "",
        isDirty: false,
        searchQuery: "",
        notes: [],
      });

      // Small delay so the server's brains.json write flushes to disk
      // before Rust reads it via get_vault_path().
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Reload brains list and notes for the new brain
      await get().loadBrains();
      await useNoteStore.getState().initVault();
    } finally {
      window.clearInterval(poller);
      set({ loading: false, ingest: null });
    }
  },

  createBrain: async (name: string, description: string, vaultPath?: string) => {
    try {
      const body: Record<string, unknown> = { name, description };
      if (vaultPath) body.vault_path = vaultPath;
      const res = await fetch(`${API}/api/brains`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (data.error) return null;
      await get().loadBrains();
      return data;
    } catch {
      return null;
    }
  },

  updateBrain: async (brainId: string, patch: { name?: string; description?: string }) => {
    try {
      const res = await fetch(`${API}/api/brains/${brainId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) return false;
      const data = await res.json();
      if (data.error) return false;
      // Optimistically update the local list so the UI doesn't flicker
      // back to the old name between the PATCH and the next loadBrains.
      set((state) => ({
        brains: state.brains.map((b) =>
          b.id === brainId ? { ...b, ...patch } : b,
        ),
        activeBrainName:
          state.activeBrainId === brainId && patch.name ? patch.name : state.activeBrainName,
      }));
      await get().loadBrains();
      return true;
    } catch {
      return false;
    }
  },

  deleteBrain: async (brainId: string) => {
    try {
      const res = await fetch(`${API}/api/brains/${brainId}`, {
        method: "DELETE",
      });
      if (!res.ok) return false;
      await get().loadBrains();
      return true;
    } catch {
      return false;
    }
  },

  listSources: async (brainId: string): Promise<BrainSource[]> => {
    const res = await fetch(`${API}/api/brains/${encodeURIComponent(brainId)}/sources`);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Failed to load sources (HTTP ${res.status}): ${text}`);
    }
    const data = (await res.json()) as SourcesResponse;
    return data.sources;
  },

  setSources: async (
    brainId: string,
    sources: { path: string; enabled: boolean }[],
  ): Promise<BrainSource[]> => {
    const res = await fetch(`${API}/api/brains/${encodeURIComponent(brainId)}/sources`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sources }),
    });
    if (!res.ok) {
      // Surface the backend's error message on 400 so the UI can show it inline.
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(json.error ?? `HTTP ${res.status}`);
    }
    const data = (await res.json()) as SourcesResponse;
    return data.sources;
  },

  previewSources: async (brainId: string): Promise<SyncPlan> => {
    const res = await fetch(`${API}/api/brains/${encodeURIComponent(brainId)}/sources/preview`);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text || `Preview failed (${res.status})`);
    }
    return (await res.json()) as SyncPlan;
  },

  syncSources: async (brainId: string): Promise<SyncSourcesResult> => {
    const res = await fetch(`${API}/api/brains/${encodeURIComponent(brainId)}/sources/sync`, {
      method: "POST",
    });
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(json.error ?? `HTTP ${res.status}`);
    }
    return (await res.json()) as SyncSourcesResult;
  },

  // Index a folder's CODE (functions, types, call edges) into this brain's
  // on-device knowledge graph via the native graphify pipeline — Rust +
  // tree-sitter, no Python, source never leaves the machine. Complements the
  // markdown mirror: `syncSources` brings in `.md`, this brings in code
  // structure so `who_calls` / `blast_radius` work over the source folder.
  graphifyFolder: async (brainId: string, path: string): Promise<GraphifyResult> => {
    const res = await fetch(`${API}/api/code/graphify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, brain: brainId }),
    });
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(json.error ?? `HTTP ${res.status}`);
    }
    const d = (await res.json()) as Partial<GraphifyResult>;
    return {
      files: d.files ?? 0,
      symbols: d.symbols ?? 0,
      calls: d.calls ?? 0,
      edges: d.edges ?? 0,
    };
  },
}));
