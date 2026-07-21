import { create } from "zustand";
import { IS_APP_STORE } from "../lib/distribution";

export type StoreRuntimePhase = "checking" | "ready" | "error";
export type StoreIndexPhase = "idle" | "running" | "complete" | "error";

export interface StoreIndexSummary {
  scanned: number;
  indexed: number;
  unchanged: number;
  failed: number;
  errors: Array<{ filename: string; error: string }>;
}

interface StoreStartupStatus {
  ready: boolean;
  error: string | null;
}

interface StoreRuntimeState {
  phase: StoreRuntimePhase;
  error: string | null;
  indexPhase: StoreIndexPhase;
  indexBrainId: string | null;
  indexSummary: StoreIndexSummary | null;
  indexError: string | null;
  refresh: () => Promise<void>;
  indexBrain: (brainId: string, force?: boolean) => Promise<void>;
  dismissIndexStatus: () => void;
}

const NOT_READY_MESSAGE =
  "NeuroVault's local library is not ready. Retry the startup check before changing your files.";
const indexedThisSession = new Set<string>();
const indexingRequests = new Map<string, Promise<void>>();
let indexDisplayGeneration = 0;
let indexQueue: Promise<void> = Promise.resolve();

/**
 * The Mac App Store edition has no companion server to recover a partial
 * native startup. Keep one product-level readiness state so the shell and all
 * write paths agree about whether it is safe to mutate the local library.
 */
export const useStoreRuntimeStore = create<StoreRuntimeState>((set) => ({
  phase: IS_APP_STORE ? "checking" : "ready",
  error: null,
  indexPhase: "idle",
  indexBrainId: null,
  indexSummary: null,
  indexError: null,

  refresh: async () => {
    if (!IS_APP_STORE) {
      set({ phase: "ready", error: null });
      return;
    }

    set({ phase: "checking", error: null });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const status = await invoke<StoreStartupStatus>("store_startup_status");
      if (status.ready) {
        set({ phase: "ready", error: null });
        return;
      }
      set({
        phase: "error",
        error: status.error?.trim() || NOT_READY_MESSAGE,
      });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      set({
        phase: "error",
        error: detail.trim() || NOT_READY_MESSAGE,
      });
    }
  },

  indexBrain: async (brainId: string, force = false) => {
    if (!IS_APP_STORE || !brainId) return;
    assertStoreRuntimeReady();
    const running = indexingRequests.get(brainId);
    if (running) return running;
    if (!force && indexedThisSession.has(brainId)) return;

    const displayGeneration = ++indexDisplayGeneration;
    // Model-backed indexing is intentionally serialized. Importing a second
    // library while startup indexing is still running must not duplicate the
    // model or make two SQLite writers compete in the background.
    const request = indexQueue.then(async () => {
      set({
        indexPhase: "running",
        indexBrainId: brainId,
        indexSummary: null,
        indexError: null,
      });
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const summary = await invoke<StoreIndexSummary>("nv_index_brain", { brainId });
        if (summary.failed > 0 || summary.errors.length > 0) {
          const first = summary.errors[0];
          if (displayGeneration === indexDisplayGeneration) {
            set({
              indexPhase: "error",
              indexBrainId: brainId,
              indexSummary: summary,
              indexError: first
                ? `${first.filename}: ${first.error}`
                : `${summary.failed} file${summary.failed === 1 ? "" : "s"} could not be indexed.`,
            });
          }
          return;
        }
        indexedThisSession.add(brainId);
        if (displayGeneration === indexDisplayGeneration) {
          set({
            indexPhase: "complete",
            indexBrainId: brainId,
            indexSummary: summary,
            indexError: null,
          });
        }
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        if (displayGeneration === indexDisplayGeneration) {
          set({
            indexPhase: "error",
            indexBrainId: brainId,
            indexSummary: null,
            indexError: detail.trim() || "The local search index could not be updated.",
          });
        }
      } finally {
        indexingRequests.delete(brainId);
      }
    });
    indexQueue = request.catch(() => undefined);
    indexingRequests.set(brainId, request);
    return request;
  },

  dismissIndexStatus: () => set({
    indexPhase: "idle",
    indexBrainId: null,
    indexSummary: null,
    indexError: null,
  }),
}));

/** Refuse Store writes while native setup is incomplete or failed. */
export function assertStoreRuntimeReady(): void {
  if (!IS_APP_STORE) return;
  const state = useStoreRuntimeStore.getState();
  if (state.phase !== "ready") {
    throw new Error(state.error || NOT_READY_MESSAGE);
  }
}
