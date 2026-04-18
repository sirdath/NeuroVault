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

const API = "http://127.0.0.1:8765";

interface BrainStore {
  brains: BrainInfo[];
  activeBrainId: string | null;
  activeBrainName: string;
  loading: boolean;

  loadBrains: () => Promise<void>;
  switchBrain: (brainId: string) => Promise<void>;
  createBrain: (
    name: string,
    description: string,
    vaultPath?: string,
  ) => Promise<{ brain_id: string; name: string; vault_path?: string; is_external?: boolean } | null>;
  deleteBrain: (brainId: string) => Promise<boolean>;
}

export const useBrainStore = create<BrainStore>((set, get) => ({
  brains: [],
  activeBrainId: null,
  activeBrainName: "Default",
  loading: false,

  loadBrains: async () => {
    try {
      const res = await fetch(`${API}/api/brains`);
      if (!res.ok) return;
      const brains: BrainInfo[] = await res.json();
      const active = brains.find((b) => b.is_active);
      set({
        brains,
        activeBrainId: active?.id ?? null,
        activeBrainName: active?.name ?? "Default",
      });
    } catch {
      // Server not running — use defaults
    }
  },

  switchBrain: async (brainId: string) => {
    set({ loading: true });
    try {
      const res = await fetch(`${API}/api/brains/${brainId}/activate`, {
        method: "POST",
      });
      if (!res.ok) return;
      const data = await res.json();
      set({ activeBrainId: data.brain_id, activeBrainName: data.name });

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
      set({ loading: false });
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
}));
