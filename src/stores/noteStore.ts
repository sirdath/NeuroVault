import { create } from "zustand";
import * as tauri from "../lib/tauri";
import type { NoteMeta } from "../lib/tauri";

interface NoteStore {
  notes: NoteMeta[];
  activeFilename: string | null;
  activeContent: string;
  isDirty: boolean;
  vaultPath: string;
  searchQuery: string;

  // Actions
  initVault: () => Promise<void>;
  loadNotes: () => Promise<void>;
  selectNote: (filename: string) => Promise<void>;
  updateContent: (content: string) => void;
  saveNote: () => Promise<void>;
  createNote: (title: string) => Promise<void>;
  deleteNote: (filename: string) => Promise<void>;
  setSearchQuery: (query: string) => void;
}

export const useNoteStore = create<NoteStore>((set, get) => ({
  notes: [],
  activeFilename: null,
  activeContent: "",
  isDirty: false,
  vaultPath: "",
  searchQuery: "",

  initVault: async () => {
    try {
      const vaultPath = await tauri.getVaultPath();
      set({ vaultPath });
      await get().loadNotes();
    } catch (e) {
      console.error("[neurovault] Failed to init vault:", e);
    }
  },

  loadNotes: async () => {
    try {
      const notes = await tauri.listNotes();
      set({ notes });
    } catch (e) {
      console.error("[neurovault] Failed to load notes:", e);
      set({ notes: [] });
    }
  },

  selectNote: async (filename: string) => {
    // Save current note if dirty before switching
    const state = get();
    if (state.isDirty && state.activeFilename) {
      await tauri.saveNote(state.activeFilename, state.activeContent);
    }

    const content = await tauri.readNote(filename);
    set({ activeFilename: filename, activeContent: content, isDirty: false });
  },

  updateContent: (content: string) => {
    set({ activeContent: content, isDirty: true });
  },

  saveNote: async () => {
    const { activeFilename, activeContent, isDirty } = get();
    if (!activeFilename || !isDirty) return;

    await tauri.saveNote(activeFilename, activeContent);
    set({ isDirty: false });
    await get().loadNotes();
  },

  createNote: async (title: string) => {
    const filename = await tauri.createNote(title);
    await get().loadNotes();
    await get().selectNote(filename);
  },

  deleteNote: async (filename: string) => {
    await tauri.deleteNote(filename);
    const { activeFilename } = get();
    if (activeFilename === filename) {
      set({ activeFilename: null, activeContent: "", isDirty: false });
    }
    await get().loadNotes();
  },

  setSearchQuery: (query: string) => {
    set({ searchQuery: query });
  },
}));
