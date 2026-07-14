import { useEffect, useMemo, type CSSProperties } from "react";
import { applyThemeToDocument, themeCssVars, useSettingsStore } from "../stores/settingsStore";
import { SettingsView } from "./SettingsView";
import { Toasts } from "./Toasts";

/**
 * Native Settings-window root. The main app keeps a browser-only modal
 * fallback, while packaged builds render this surface in the dedicated
 * macOS window declared in tauri.conf.json.
 */
export function SettingsWindow() {
  const theme = useSettingsStore((state) => state.theme);
  const reduceMotion = useSettingsStore((state) => state.reduceMotion);
  const syncFromStorage = useSettingsStore((state) => state.syncFromStorage);

  const themeVars = useMemo(
    () => themeCssVars(theme) as CSSProperties & Record<string, string>,
    [theme],
  );

  useEffect(() => {
    applyThemeToDocument(theme);
    void import("@tauri-apps/api/app")
      .then(({ setTheme }) => setTheme(theme.mode))
      .catch(() => undefined);
  }, [theme]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === "nv.settings" || event.key === null) {
        syncFromStorage();
      }
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [syncFromStorage]);

  return (
    <main
      className={`nv-app-shell h-screen overflow-y-auto font-[Geist,sans-serif]${reduceMotion ? " nv-reduce-motion" : ""}`}
      style={{ ...themeVars, background: theme.bg, color: theme.text }}
    >
      <SettingsView />
      <Toasts />
    </main>
  );
}
