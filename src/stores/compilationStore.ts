import { create } from "zustand";
import {
  compilationApi,
  type CompilationSummary,
  type CompilationDetail,
} from "../lib/api";

interface CompilationStore {
  list: CompilationSummary[];
  activeId: string | null;
  activeDetail: CompilationDetail | null;
  loadingList: boolean;
  loadingDetail: boolean;
  error: string | null;

  loadList: (status?: string) => Promise<void>;
  selectCompilation: (id: string) => Promise<void>;
  clearSelection: () => void;
  approve: (id: string, comment?: string) => Promise<void>;
  reject: (id: string, comment?: string) => Promise<void>;
}

export const useCompilationStore = create<CompilationStore>((set, get) => ({
  list: [],
  activeId: null,
  activeDetail: null,
  loadingList: false,
  loadingDetail: false,
  error: null,

  loadList: async (status) => {
    set({ loadingList: true, error: null });
    try {
      const list = await compilationApi.list(status);
      set({ list, loadingList: false });
    } catch (e) {
      set({
        loadingList: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  selectCompilation: async (id) => {
    set({ activeId: id, loadingDetail: true, error: null });
    try {
      const detail = await compilationApi.get(id);
      set({ activeDetail: detail, loadingDetail: false });
    } catch (e) {
      set({
        loadingDetail: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  clearSelection: () => set({ activeId: null, activeDetail: null }),

  approve: async (id, comment) => {
    try {
      await compilationApi.approve(id, comment);
      // Refresh both the list and the active detail so the UI reflects the
      // new status without a second tab-switch.
      await get().loadList();
      if (get().activeId === id) {
        await get().selectCompilation(id);
      }
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  reject: async (id, comment) => {
    try {
      await compilationApi.reject(id, comment);
      await get().loadList();
      if (get().activeId === id) {
        await get().selectCompilation(id);
      }
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },
}));
