import { create } from "zustand";
import * as tauri from "../lib/tauri";
import type { NoteMeta } from "../lib/tauri";
import { API_HOST } from "../lib/config";
import { toast } from "./toastStore";

interface NoteStore {
  notes: NoteMeta[];
  activeFilename: string | null;
  activeContent: string;
  isDirty: boolean;
  vaultPath: string;
  searchQuery: string;
  // Engram ids returned by /api/recall for the current query, ordered
  // by relevance. Populated when searchQuery is non-empty + server is
  // up; empty otherwise. The sidebar uses it to filter+rank — empty
  // array means "fall back to local title substring match".
  // Ranked filenames from /api/recall for the current query. Filename
  // (not engram_id) because the sidebar's notes array is keyed on
  // filename — keeps the filter path index-free.
  searchResults: string[];

  // Actions
  initVault: () => Promise<void>;
  loadNotes: () => Promise<void>;
  selectNote: (filename: string) => Promise<void>;
  updateContent: (content: string) => void;
  saveNote: () => Promise<void>;
  createNote: (title: string) => Promise<void>;
  deleteNote: (filename: string) => Promise<void>;
  renameNote: (filename: string, newFilename: string, newTitle?: string) => Promise<boolean>;
  setSearchQuery: (query: string) => void;
}

export const useNoteStore = create<NoteStore>((set, get) => ({
  notes: [],
  activeFilename: null,
  activeContent: "",
  isDirty: false,
  vaultPath: "",
  searchQuery: "",
  searchResults: [],

  initVault: async () => {
    try {
      const vaultPath = await tauri.getVaultPath();
      set({ vaultPath });
      await get().loadNotes();
    } catch (e) {
      // Surfaced as an error toast (which stays until dismissed) —
      // a silent failure here leaves the user with an empty sidebar
      // and no hint why nothing is loading.
      console.error("[neurovault] Failed to init vault:", e);
      toast.error(
        `Couldn't open vault: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  },

  loadNotes: async () => {
    try {
      const notes = await tauri.listNotes();
      set({ notes });
    } catch (e) {
      console.error("[neurovault] Failed to load notes:", e);
      toast.error("Failed to load notes");
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
    try {
      const filename = await tauri.createNote(title);
      await get().loadNotes();
      await get().selectNote(filename);
      toast.success(`Created "${title}"`);
    } catch (e) {
      console.error("[neurovault] Failed to create note:", e);
      toast.error("Failed to create note");
    }
  },

  deleteNote: async (filename: string) => {
    await tauri.deleteNote(filename);
    const { activeFilename } = get();
    if (activeFilename === filename) {
      set({ activeFilename: null, activeContent: "", isDirty: false });
    }
    await get().loadNotes();
  },

  renameNote: async (filename: string, newFilename: string, newTitle?: string) => {
    // Rename goes through the backend so the DB row, the file on disk,
    // and the vault fingerprint all move atomically. Local-only would
    // orphan the engram's connections next time the vault re-ingests.
    const match = get().notes.find((n) => n.filename === filename);
    if (!match) {
      toast.error("Note not found");
      return false;
    }
    // We need the engram_id. Ask the server (the notes array only has
    // filename/title/modified/size from Rust; id lives in the DB).
    try {
      const listRes = await fetch(`${API_HOST}/api/notes`);
      if (!listRes.ok) throw new Error(`list failed: ${listRes.status}`);
      const all = (await listRes.json()) as Array<{ id: string; filename: string }>;
      const hit = all.find((n) => n.filename === filename);
      if (!hit) {
        toast.error("Note not found in server index");
        return false;
      }
      const patch: Record<string, string> = { filename: newFilename };
      if (newTitle) patch.title = newTitle;
      const r = await fetch(`${API_HOST}/api/notes/${hit.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await r.json();
      if (!r.ok || data.error) {
        toast.error(data.error || `Rename failed (${r.status})`);
        return false;
      }
      // If the currently-open note was the one renamed, point the
      // active filename at the new path so saves don't hit the old
      // (now non-existent) file.
      if (get().activeFilename === filename) {
        set({ activeFilename: data.filename });
      }
      await get().loadNotes();
      toast.success(`Renamed to ${data.filename}`);
      return true;
    } catch (e) {
      toast.error(`Rename failed: ${e}`);
      return false;
    }
  },

  setSearchQuery: (query: string) => {
    set({ searchQuery: query });
    // Empty query → clear server results, sidebar falls back to showing
    // everything. Short queries (<2 chars) also skip /api/recall because
    // the server returns noise at that length.
    if (!query || query.trim().length < 2) {
      set({ searchResults: [] });
      return;
    }
    // Fire-and-forget; results arrive async. If the server is down or
    // slow, the sidebar still renders the local title-substring fallback.
    const q = query.trim();
    (async () => {
      try {
        const r = await fetch(
          `${API_HOST}/api/recall?q=${encodeURIComponent(q)}&mode=titles&limit=50`,
        );
        if (!r.ok) return;
        const hits = (await r.json()) as Array<{ engram_id: string; filename: string }>;
        // Only apply if the query hasn't changed since we started — the
        // user may have kept typing and our result is stale.
        if (get().searchQuery.trim() !== q) return;
        set({ searchResults: hits.map((h) => h.filename).filter(Boolean) });
      } catch { /* server offline — local fallback handles it */ }
    })();
  },
}));
