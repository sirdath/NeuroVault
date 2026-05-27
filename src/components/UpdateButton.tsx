import { useUpdateStore } from "../stores/updateStore";
import type { Theme } from "../stores/settingsStore";

/**
 * Top-bar update pill. Hidden until a launch check finds a newer release;
 * then it surfaces as a clear call to action. Clicking it downloads +
 * installs the update in place (native updater) or, when the updater
 * isn't configured yet, opens the GitHub release page so the user can
 * grab the installer. After an install it flips to "Restart to update".
 *
 * Dismissable per-version via the ×, so a user who isn't ready isn't
 * nagged every launch for the same release.
 */
export function UpdateButton({ theme }: { theme: Theme }) {
  const info = useUpdateStore((s) => s.info);
  const installing = useUpdateStore((s) => s.installing);
  const progress = useUpdateStore((s) => s.progress);
  const restartPending = useUpdateStore((s) => s.restartPending);
  const dismissedVersion = useUpdateStore((s) => s.dismissedVersion);
  const install = useUpdateStore((s) => s.install);
  const restart = useUpdateStore((s) => s.restart);
  const dismiss = useUpdateStore((s) => s.dismiss);

  const available = !!info?.updateAvailable;
  const nudge = available && info!.latest !== dismissedVersion;
  if (!restartPending && !installing && !nudge) return null;

  // Restart-pending state — the install finished, just needs a relaunch.
  if (restartPending) {
    return (
      <button
        onClick={() => restart()}
        className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-[Geist,sans-serif] font-semibold rounded-lg transition-colors"
        style={{ background: theme.accent, color: theme.bg }}
        title="Restart NeuroVault to finish updating"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
          <path d="M23 4v6h-6" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
        </svg>
        Restart to update
      </button>
    );
  }

  const pct = progress != null ? Math.round(progress * 100) : null;

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => install()}
        disabled={installing}
        className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-[Geist,sans-serif] font-semibold rounded-lg transition-colors disabled:opacity-80"
        style={{ background: theme.accent, color: theme.bg }}
        title={`Version ${info!.latest} is available`}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        {installing
          ? pct != null ? `Updating… ${pct}%` : "Updating…"
          : `Update to v${info!.latest}`}
      </button>
      {!installing && (
        <button
          onClick={() => dismiss()}
          className="w-5 h-5 flex items-center justify-center rounded-md transition-colors"
          style={{ color: theme.textDim }}
          title="Dismiss until the next release"
          aria-label="Dismiss update notification"
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
    </div>
  );
}
