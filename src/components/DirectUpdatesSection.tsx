import { useEffect, useState } from "react";
import { useUpdateStore } from "../stores/updateStore";

function AppVersion() {
  const [version, setVersion] = useState("");
  useEffect(() => {
    let alive = true;
    import("@tauri-apps/api/app")
      .then(({ getVersion }) => getVersion())
      .then((value) => { if (alive) setVersion(value); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  return <>v{version || "—"}</>;
}

/** GitHub/native-updater controls for the direct distribution only. */
export function DirectUpdatesSection() {
  const info = useUpdateStore((state) => state.info);
  const checking = useUpdateStore((state) => state.checking);
  const installing = useUpdateStore((state) => state.installing);
  const progress = useUpdateStore((state) => state.progress);
  const restartPending = useUpdateStore((state) => state.restartPending);
  const check = useUpdateStore((state) => state.check);
  const install = useUpdateStore((state) => state.install);
  const restart = useUpdateStore((state) => state.restart);

  const subtitle = restartPending
    ? "Update installed — restart to apply."
    : info
      ? info.updateAvailable
        ? `Update available: v${info.latest}`
        : "You're on the latest version."
      : "Check GitHub for a newer release.";
  const pct = progress == null ? null : Math.round(progress * 100);

  return (
    <div className="mb-10">
      <h2 className="mb-4 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--nv-text-dim)" }}>Updates</h2>
      <div className="flex items-center justify-between gap-4 rounded-2xl p-5" style={{ background: "var(--nv-surface-elevated)", border: "1px solid var(--nv-border)" }}>
        <div className="min-w-0">
          <p className="text-[13px]" style={{ color: "var(--nv-text)" }}>Current version <AppVersion /></p>
          <p className="mt-1 text-[12px]" style={{ color: "var(--nv-text-dim)" }}>{subtitle}</p>
        </div>
        {restartPending ? (
          <button onClick={() => restart()} className="shrink-0 rounded-lg px-3 py-1.5 text-[12px] font-medium" style={{ background: "var(--nv-accent)", color: "var(--nv-bg)" }}>Restart now</button>
        ) : info?.updateAvailable ? (
          <button onClick={() => install()} disabled={installing} className="shrink-0 rounded-lg px-3 py-1.5 text-[12px] font-medium disabled:opacity-70" style={{ background: "var(--nv-accent)", color: "var(--nv-bg)" }}>
            {installing ? (pct == null ? "Updating…" : `Updating… ${pct}%`) : `Update to v${info.latest}`}
          </button>
        ) : (
          <button onClick={() => check(false)} disabled={checking} className="shrink-0 rounded-lg px-3 py-1.5 text-[12px] font-medium disabled:opacity-50" style={{ background: "var(--nv-surface)", color: "var(--nv-text)", border: "1px solid var(--nv-border)" }}>
            {checking ? "Checking…" : "Check for updates"}
          </button>
        )}
      </div>
    </div>
  );
}

