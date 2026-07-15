import { create } from "zustand";
import * as tauri from "../lib/tauri";
import type { NoteMeta } from "../lib/tauri";
import { API_HOST } from "../lib/config";
import {
  NoteDurabilityQueue,
  type NoteSaveResult,
  type NoteSaveSnapshot,
} from "../lib/noteDurability";
import { readNoteDraft, type NoteRecoveryDraft } from "../lib/noteDrafts";
import {
  installNoteDraftLifecycleFlush,
  NoteDraftPersistence,
} from "../lib/noteDraftPersistence";
import { LatestRequestGate } from "../lib/latestRequest";
import { toast } from "./toastStore";

export type SaveStatus = "saved" | "dirty" | "saving" | "failed";
export type NotesStatus = "idle" | "loading" | "ready" | "error";

interface NoteStore {
  brainId: string | null;
  notes: NoteMeta[];
  notesStatus: NotesStatus;
  notesError: string | null;
  activeFilename: string | null;
  activeContent: string;
  isDirty: boolean;
  editRevision: number;
  saveStatus: SaveStatus;
  saveError: string | null;
  lastSavedAt: number | null;
  recoveryDraft: NoteRecoveryDraft | null;
  transitionLocked: boolean;
  vaultPath: string;
  searchQuery: string;
  // Ranked filenames from /api/recall for the current query. Filename
  // (not engram_id) because the sidebar's notes array is keyed on
  // filename — keeps the filter path index-free.
  searchResults: string[];

  initVault: () => Promise<void>;
  loadNotes: () => Promise<void>;
  selectNote: (filename: string) => Promise<boolean>;
  updateContent: (content: string) => void;
  recoverDraft: () => void;
  discardRecoveryDraft: () => void;
  saveNote: () => Promise<boolean>;
  saveNoteAsCopy: () => Promise<boolean>;
  discardUnsavedChanges: () => Promise<boolean>;
  flushPendingSave: () => Promise<boolean>;
  closeActiveNote: () => Promise<boolean>;
  beginBrainSwitch: () => Promise<boolean>;
  resetForBrainSwitch: () => void;
  finishBrainSwitch: () => void;
  createNote: (title: string) => Promise<void>;
  deleteNote: (filename: string) => Promise<void>;
  renameNote: (filename: string, newFilename: string, newTitle?: string) => Promise<boolean>;
  setSearchQuery: (query: string) => void;
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useNoteStore = create<NoteStore>((set, get) => {
  // Generations make late results harmless. In particular, an old vault's
  // list/recall request must not repopulate state after a brain switch.
  const notesLoadGate = new LatestRequestGate();
  const searchGate = new LatestRequestGate();
  const draftPersistence = new NoteDraftPersistence(localStorage);
  installNoteDraftLifecycleFlush(draftPersistence);

  const loadNotes = async (showLoading = true): Promise<void> => {
    const generation = notesLoadGate.begin();
    const brainId = get().brainId;
    if (showLoading) set({ notesStatus: "loading", notesError: null });
    try {
      const notes = await tauri.listNotes(brainId);
      if (!notesLoadGate.isCurrent(generation)) return;
      set({ notes, notesStatus: "ready", notesError: null });
    } catch (error) {
      if (!notesLoadGate.isCurrent(generation)) return;
      const message = messageFrom(error);
      console.error("[neurovault] Failed to load notes:", error);
      // Preserve an already-rendered list on a refresh failure; presenting it
      // as an empty vault would be both false and alarming.
      set({ notesStatus: "error", notesError: message });
      toast.error(`Failed to load notes: ${message}`);
    }
  };

  const durability = new NoteDurabilityQueue({
    getSnapshot: (): NoteSaveSnapshot | null => {
      const state = get();
      if (!state.activeFilename || !state.isDirty) return null;
      return {
        filename: state.activeFilename,
        content: state.activeContent,
        revision: state.editRevision,
        brainId: state.brainId,
      };
    },
    write: (snapshot) => tauri.saveNote(snapshot.filename, snapshot.content, snapshot.brainId),
    onSaving: () => set({ saveStatus: "saving", saveError: null }),
    onPersisted: (snapshot) => {
      const current = get();
      draftPersistence.markPersisted(
        snapshot.brainId ?? current.brainId,
        snapshot.filename,
        snapshot.content,
      );
      if (
        current.activeFilename === snapshot.filename &&
        current.editRevision === snapshot.revision
      ) {
        set({
          isDirty: false,
          saveStatus: "saved",
          saveError: null,
          lastSavedAt: Date.now(),
        });
      }
      // Otherwise a newer revision is already dirty. The queue loops and
      // persists it before the current barrier is allowed to resolve.
    },
    onFailed: (_snapshot, error) => {
      set({ saveStatus: "failed", saveError: error });
      toast.error(`Couldn't save note: ${error}`);
    },
  });

  type DurabilityFlush = () => Promise<NoteSaveResult>;
  const flushDurability = (): Promise<NoteSaveResult> => {
    // A save/transition barrier first makes the recovery copy durable. If the
    // Markdown write fails or the WebView disappears mid-await, the latest
    // editor content remains recoverable.
    draftPersistence.flushAll();
    return durability.flush();
  };
  const runDurabilityExclusive = <T>(
    task: (flush: DurabilityFlush) => Promise<T>,
  ): Promise<T> => durability.runExclusive((flush) => task(() => {
    draftPersistence.flushAll();
    return flush();
  }));

  return {
    brainId: null,
    notes: [],
    notesStatus: "idle",
    notesError: null,
    activeFilename: null,
    activeContent: "",
    isDirty: false,
    editRevision: 0,
    saveStatus: "saved",
    saveError: null,
    lastSavedAt: null,
    recoveryDraft: null,
    transitionLocked: false,
    vaultPath: "",
    searchQuery: "",
    searchResults: [],

    initVault: async () => {
      set({ notesStatus: "loading", notesError: null });
      try {
        const vaultPath = await tauri.getVaultPath(get().brainId);
        set({ vaultPath });
        await loadNotes(false);
      } catch (error) {
        const message = messageFrom(error);
        console.error("[neurovault] Failed to init vault:", error);
        set({ notesStatus: "error", notesError: message });
        toast.error(`Couldn't open vault: ${message}`);
      }
    },

    loadNotes: () => loadNotes(),

    selectNote: async (filename: string) => {
      if (get().transitionLocked) return false;
      if (get().activeFilename === filename) return true;

      return runDurabilityExclusive(async (flush) => {
        if (get().transitionLocked) return false;

        const beforeRead = await flush();
        if (!beforeRead.ok) return false;

        const brainId = get().brainId;
        let content: string;
        try {
          content = await tauri.readNote(filename, brainId);
        } catch (error) {
          toast.error(`Couldn't open note: ${messageFrom(error)}`);
          return false;
        }

        // Reading is awaited, so the user may have typed another character
        // into the old note while it was in flight. Drain that revision too,
        // then switch synchronously before another input event can interleave.
        const afterRead = await flush();
        if (!afterRead.ok) return false;
        const draft = readNoteDraft(localStorage, brainId, filename);
        if (draft?.content === content) draftPersistence.discard(brainId, filename);
        set({
          activeFilename: filename,
          activeContent: content,
          isDirty: false,
          saveStatus: "saved",
          saveError: null,
          recoveryDraft: draft?.content !== content ? draft : null,
        });

        if (beforeRead.writes + afterRead.writes > 0) {
          await loadNotes(false);
        }
        return true;
      });
    },

    updateContent: (content: string) => {
      const state = get();
      if (state.transitionLocked || content === state.activeContent) return;
      set({
        activeContent: content,
        isDirty: true,
        editRevision: state.editRevision + 1,
        saveStatus: "dirty",
        saveError: null,
      });
      draftPersistence.schedule(state.brainId, state.activeFilename, content);
    },

    recoverDraft: () => {
      const state = get();
      const draft = state.recoveryDraft;
      if (!draft || draft.brainId !== state.brainId || draft.filename !== state.activeFilename) return;
      set({
        activeContent: draft.content,
        isDirty: true,
        editRevision: state.editRevision + 1,
        saveStatus: "dirty",
        saveError: null,
        recoveryDraft: null,
      });
      draftPersistence.schedule(state.brainId, state.activeFilename, draft.content);
    },

    discardRecoveryDraft: () => {
      const state = get();
      if (!state.recoveryDraft) return;
      draftPersistence.discard(state.recoveryDraft.brainId, state.recoveryDraft.filename);
      set({ recoveryDraft: null });
    },

    saveNote: async () => runDurabilityExclusive(async (flush) => {
      const result = await flush();
      if (result.ok && result.writes > 0) await loadNotes(false);
      return result.ok;
    }),

    saveNoteAsCopy: async () => {
      const state = get();
      if (!state.activeFilename || !state.isDirty || state.transitionLocked) return false;
      const originalFilename = state.activeFilename;
      const originalContent = state.activeContent;
      const originalBrainId = state.brainId;
      const base = originalFilename.split("/").pop()?.replace(/\.md$/i, "") || "Recovered note";
      const stamp = new Date().toISOString().replace("T", " ").slice(0, 16).replace(":", "-");
      // This path performs its own copy write instead of using the normal
      // durability queue, so establish the same recovery barrier explicitly.
      draftPersistence.flushAll();
      set({ transitionLocked: true });
      try {
        const filename = await tauri.createNote(`${base} — recovered ${stamp}`, originalBrainId);
        if (!filename) throw new Error("The copy was created without a filename.");
        await tauri.saveNote(filename, originalContent, originalBrainId);
        draftPersistence.discard(originalBrainId, originalFilename);
        set((current) => ({
          activeFilename: filename,
          activeContent: originalContent,
          isDirty: false,
          editRevision: current.editRevision + 1,
          saveStatus: "saved",
          saveError: null,
          lastSavedAt: Date.now(),
          recoveryDraft: null,
        }));
        await loadNotes(false);
        toast.success("Saved the unsaved text as a new note. The original file was left unchanged.");
        return true;
      } catch (error) {
        const message = messageFrom(error);
        set({ saveStatus: "failed", saveError: message });
        toast.error(`Couldn't save a recovery copy: ${message}`);
        return false;
      } finally {
        set({ transitionLocked: false });
      }
    },

    discardUnsavedChanges: async () => {
      const state = get();
      if (!state.activeFilename || state.transitionLocked) return false;
      const filename = state.activeFilename;
      const brainId = state.brainId;
      set({ transitionLocked: true });
      try {
        const diskContent = await tauri.readNote(filename, brainId);
        draftPersistence.discard(brainId, filename);
        set((current) => ({
          activeContent: diskContent,
          isDirty: false,
          editRevision: current.editRevision + 1,
          saveStatus: "saved",
          saveError: null,
          recoveryDraft: null,
        }));
        toast.info("Unsaved changes were discarded. The Markdown file was not changed.");
        return true;
      } catch (error) {
        const message = messageFrom(error);
        set({ saveStatus: "failed", saveError: message });
        toast.error(`Couldn't reload the saved file: ${message}`);
        return false;
      } finally {
        set({ transitionLocked: false });
      }
    },

    // Lifecycle barriers intentionally skip the metadata refresh. The markdown
    // file is durable once flush resolves; delaying a window quit for a second
    // list operation creates risk without adding durability.
    flushPendingSave: async () => (await flushDurability()).ok,

    closeActiveNote: async () => runDurabilityExclusive(async (flush) => {
      if (get().transitionLocked) return false;
      const result = await flush();
      if (!result.ok) return false;
      set({
        activeFilename: null,
        activeContent: "",
        isDirty: false,
        saveStatus: "saved",
        saveError: null,
        recoveryDraft: null,
      });
      return true;
    }),

    beginBrainSwitch: async () => {
      if (get().transitionLocked) return false;
      // Lock first: no keystroke or note selection may enter after the barrier
      // and before the backend changes its process-global active brain.
      set({ transitionLocked: true });
      const result = await flushDurability();
      if (!result.ok) {
        set({ transitionLocked: false });
        return false;
      }
      return true;
    },

    resetForBrainSwitch: () => {
      notesLoadGate.invalidate();
      searchGate.invalidate();
      set((state) => ({
        activeFilename: null,
        activeContent: "",
        isDirty: false,
        editRevision: state.editRevision + 1,
        saveStatus: "saved",
        saveError: null,
        recoveryDraft: null,
        searchQuery: "",
        searchResults: [],
        notes: [],
        notesStatus: "loading",
        notesError: null,
        vaultPath: "",
      }));
    },

    finishBrainSwitch: () => set({ transitionLocked: false }),

    createNote: async (title: string) => {
      if (get().transitionLocked) return;
      set({ transitionLocked: true });
      try {
        await runDurabilityExclusive(async (flush) => {
          const saved = await flush();
          if (!saved.ok) return;
          const filename = await tauri.createNote(title, get().brainId);
          await loadNotes(false);
          const content = await tauri.readNote(filename, get().brainId);
          const afterRead = await flush();
          if (!afterRead.ok) return;
          set({
            activeFilename: filename,
            activeContent: content,
            isDirty: false,
            saveStatus: "saved",
            saveError: null,
            recoveryDraft: null,
          });
          toast.success(`Created "${title}"`);
        });
      } catch (error) {
        console.error("[neurovault] Failed to create note:", error);
        toast.error(`Failed to create note: ${messageFrom(error)}`);
      } finally {
        set({ transitionLocked: false });
      }
    },

    deleteNote: async (filename: string) => {
      if (get().transitionLocked) return;
      set({ transitionLocked: true });
      try {
        await runDurabilityExclusive(async (flush) => {
          const saved = await flush();
          if (!saved.ok) return;
          await tauri.deleteNote(filename, get().brainId);
          if (get().activeFilename === filename) {
            set({
              activeFilename: null,
              activeContent: "",
              isDirty: false,
              saveStatus: "saved",
              saveError: null,
              recoveryDraft: null,
            });
          }
          await loadNotes(false);
        });
      } catch (error) {
        toast.error(`Failed to delete note: ${messageFrom(error)}`);
      } finally {
        set({ transitionLocked: false });
      }
    },

    renameNote: async (filename: string, newFilename: string, newTitle?: string) => {
      if (get().transitionLocked) return false;
      return runDurabilityExclusive(async (flush) => {
        const saved = await flush();
        if (!saved.ok) return false;

        // Rename goes through the backend so the DB row, file, and vault
        // fingerprint move atomically.
        const match = get().notes.find((note) => note.filename === filename);
        if (!match) {
          toast.error("Note not found");
          return false;
        }
        try {
          const listRes = await fetch(`${API_HOST}/api/notes`);
          if (!listRes.ok) throw new Error(`list failed: ${listRes.status}`);
          const all = (await listRes.json()) as Array<{ id: string; filename: string }>;
          const hit = all.find((note) => note.filename === filename);
          if (!hit) {
            toast.error("Note not found in server index");
            return false;
          }
          const patch: Record<string, string> = { filename: newFilename };
          if (newTitle) patch.title = newTitle;
          const response = await fetch(`${API_HOST}/api/notes/${hit.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
          });
          const data = await response.json();
          if (!response.ok || data.error) {
            toast.error(data.error || `Rename failed (${response.status})`);
            return false;
          }
          if (get().activeFilename === filename) {
            set({ activeFilename: data.filename });
          }
          await loadNotes(false);
          toast.success(`Renamed to ${data.filename}`);
          return true;
        } catch (error) {
          toast.error(`Rename failed: ${messageFrom(error)}`);
          return false;
        }
      });
    },

    setSearchQuery: (query: string) => {
      const generation = searchGate.begin();
      // Clear the previous ranking immediately. Showing query A's hits under
      // query B, even briefly, is both confusing and a cross-vault risk.
      set({ searchQuery: query, searchResults: [] });
      if (!query || query.trim().length < 2) return;

      const q = query.trim();
      void (async () => {
        try {
          const response = await fetch(
            `${API_HOST}/api/recall?q=${encodeURIComponent(q)}&mode=titles&limit=50`,
          );
          if (!response.ok) return;
          const hits = (await response.json()) as Array<{ engram_id: string; filename: string }>;
          if (!searchGate.isCurrent(generation)) return;
          set({ searchResults: hits.map((hit) => hit.filename).filter(Boolean) });
        } catch {
          // Server offline — cleared results leave the local title fallback.
        }
      })();
    },
  };
});
