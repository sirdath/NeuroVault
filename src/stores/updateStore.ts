import { create } from "zustand";
import { checkForUpdate, runUpdate, relaunchApp, type UpdateInfo } from "../lib/updater";
import { toast } from "./toastStore";

const DISMISS_KEY = "nv.update.dismissedVersion";

interface UpdateStore {
  /** Result of the last check, or null if not checked / check failed. */
  info: UpdateInfo | null;
  checking: boolean;
  installing: boolean;
  /** Download progress 0..1 during a native install (else null). */
  progress: number | null;
  /** True once an install finished and a restart is pending. */
  restartPending: boolean;
  /** Latest version the user dismissed the banner for. */
  dismissedVersion: string;

  /** True when there's an update worth surfacing in the UI (available
   *  and not dismissed for this version). */
  shouldNudge: () => boolean;

  /** Run a check. `silent` swallows errors (used on launch). */
  check: (silent?: boolean) => Promise<void>;
  /** Download + install (native) or open the release page (fallback). */
  install: () => Promise<void>;
  /** Restart to apply an installed update. */
  restart: () => Promise<void>;
  /** Hide the banner for the current latest version. */
  dismiss: () => void;
}

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  info: null,
  checking: false,
  installing: false,
  progress: null,
  restartPending: false,
  dismissedVersion: (() => {
    try { return localStorage.getItem(DISMISS_KEY) ?? ""; } catch { return ""; }
  })(),

  shouldNudge: () => {
    const { info, dismissedVersion } = get();
    return !!info?.updateAvailable && info.latest !== dismissedVersion;
  },

  check: async (silent = false) => {
    if (get().checking) return;
    set({ checking: true });
    try {
      const info = await checkForUpdate();
      set({ info });
    } catch (e) {
      if (!silent) toast.error(`Update check failed: ${(e as Error).message}`);
    } finally {
      set({ checking: false });
    }
  },

  install: async () => {
    const { info, installing } = get();
    if (!info || installing) return;
    set({ installing: true, progress: 0 });
    try {
      const res = await runUpdate(info.url, (p) => set({ progress: p }));
      if (res.mode === "installed") {
        set({ restartPending: true });
        toast.success(`v${info.latest} installed — restart to apply.`);
      } else {
        // Opened the release page for a manual download.
        toast.info("Opened the download page in your browser.");
      }
    } catch (e) {
      toast.error(`Update failed: ${(e as Error).message}`);
    } finally {
      set({ installing: false, progress: null });
    }
  },

  restart: async () => {
    await relaunchApp();
  },

  dismiss: () => {
    const v = get().info?.latest ?? "";
    set({ dismissedVersion: v });
    try { localStorage.setItem(DISMISS_KEY, v); } catch { /* ignore */ }
  },
}));
