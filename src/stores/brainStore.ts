import { create } from "zustand";
import { useNoteStore } from "./noteStore";

export interface BrainInfo {
  id: string;
  name: string;
  description: string;
  created_at: string;
  is_active: boolean;
}

const API = "http://127.0.0.1:8765";

interface BrainStore {
  brains: BrainInfo[];
  activeBrainId: string | null;
  activeBrainName: string;
  loading: boolean;

  loadBrains: () => Promise<void>;
  switchBrain: (brainId: string) => Promise<void>;
  createBrain: (name: string, description: string) => Promise<{ brain_id: string; name: string } | null>;
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

      // Reload brains list and notes for the new brain
      await get().loadBrains();
      await useNoteStore.getState().initVault();
    } finally {
      set({ loading: false });
    }
  },

  createBrain: async (name: string, description: string) => {
    try {
      const res = await fetch(`${API}/api/brains`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description }),
      });
      if (!res.ok) return null;
      const data = await res.json();
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
