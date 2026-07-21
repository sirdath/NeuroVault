import { create } from "zustand";
import { fetchBrains, fetchHealth, fetchStatus } from "../lib/api";
import { IS_APP_STORE } from "../lib/distribution";
import {
  deriveConsumerHealth,
  INITIAL_CONSUMER_HEALTH_SIGNALS,
  type ConsumerHealth,
  type ConsumerHealthSignals,
} from "../lib/consumerHealth";

interface ConsumerHealthStore {
  signals: ConsumerHealthSignals;
  health: ConsumerHealth;
  refreshing: boolean;
  lastError: string | null;
  refresh: () => Promise<void>;
  setAutomaticRecall: (enabled: boolean) => Promise<void>;
}

let inFlight: Promise<void> | null = null;
let consecutiveFailures = 0;
let everOnline = false;

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== undefined
  );
}

async function automaticRecallStatus(): Promise<ConsumerHealthSignals["automaticRecall"]> {
  if (IS_APP_STORE) return "unavailable";
  if (!isTauriRuntime()) return "unavailable";
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke<boolean>("nv_auto_recall_status")) ? "on" : "off";
  } catch {
    return "unavailable";
  }
}

export const useConsumerHealthStore = create<ConsumerHealthStore>((set, get) => ({
  signals: INITIAL_CONSUMER_HEALTH_SIGNALS,
  health: deriveConsumerHealth(INITIAL_CONSUMER_HEALTH_SIGNALS),
  refreshing: false,
  lastError: null,

  refresh: async () => {
    if (IS_APP_STORE) return;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      set({ refreshing: true });
      try {
        await fetchHealth();
        consecutiveFailures = 0;
        everOnline = true;

        const [brainsResult, statusResult, recall] = await Promise.all([
          fetchBrains().catch(() => null),
          fetchStatus().catch(() => null),
          automaticRecallStatus(),
        ]);
        const active = brainsResult?.find((b) => b.is_active) ?? null;
        const next: ConsumerHealthSignals = {
          service: "online",
          brainCount: brainsResult?.length ?? null,
          activeBrainId: active?.id ?? null,
          activeBrainName: active?.name ?? null,
          memories: statusResult?.memories ?? (active ? 0 : null),
          automaticRecall: recall,
          lastCheckedAt: Date.now(),
        };
        set({ signals: next, health: deriveConsumerHealth(next), lastError: null });
      } catch (error) {
        consecutiveFailures += 1;
        const threshold = everOnline ? 3 : 1;
        if (consecutiveFailures >= threshold) {
          const next: ConsumerHealthSignals = {
            ...get().signals,
            service: "offline",
            automaticRecall: "checking",
            lastCheckedAt: Date.now(),
          };
          set({
            signals: next,
            health: deriveConsumerHealth(next),
            lastError: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        set({ refreshing: false });
        inFlight = null;
      }
    })();
    return inFlight;
  },

  setAutomaticRecall: async (enabled: boolean) => {
    if (IS_APP_STORE) {
      throw new Error("Automatic AI connections are not part of this App Store edition.");
    }
    if (!isTauriRuntime()) throw new Error("Automatic memory can only be changed in the desktop app.");
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke<string>("nv_auto_recall_set", { enabled });
    const next: ConsumerHealthSignals = {
      ...get().signals,
      automaticRecall: enabled ? "on" : "off",
      lastCheckedAt: Date.now(),
    };
    set({ signals: next, health: deriveConsumerHealth(next), lastError: null });
    await get().refresh();
  },
}));
