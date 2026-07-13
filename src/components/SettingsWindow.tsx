import { useEffect, type CSSProperties } from "react";
import { useSettingsStore } from "../stores/settingsStore";
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

  const themeVars = {
    "--nv-bg": theme.bg,
    "--nv-surface": theme.surface,
    "--nv-border": theme.border,
    "--nv-text": theme.text,
    "--nv-text-muted": theme.textMuted,
    "--nv-text-dim": theme.textDim,
    "--nv-accent": theme.accent,
    "--nv-accent-glow": theme.accentGlow,
    "--nv-positive": theme.positive,
    "--nv-negative": theme.negative,
  } as CSSProperties & Record<string, string>;

  useEffect(() => {
    const root = document.documentElement;
    for (const [key, value] of Object.entries(themeVars)) {
      root.style.setProperty(key, value);
    }
  }, [theme]);

  return (
    <main
      className={`h-screen overflow-y-auto font-[Geist,sans-serif]${reduceMotion ? " nv-reduce-motion" : ""}`}
      style={{ ...themeVars, background: theme.bg, color: theme.text }}
    >
      <SettingsView />
      <Toasts />
    </main>
  );
}
