import { useSettingsStore } from "../stores/settingsStore";
import { useToastStore } from "../stores/toastStore";

const TONES = {
  info: "var(--nv-accent)",
  success: "var(--nv-positive)",
  warning: "var(--nv-warning)",
  error: "var(--nv-negative)",
};

const ICONS = {
  info: "i",
  success: "✓",
  warning: "!",
  error: "×",
};

export function Toasts() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  const reduceMotionSetting = useSettingsStore((s) => s.reduceMotion);

  return (
    <div className="fixed bottom-6 right-6 z-[100] flex flex-col gap-2 max-w-sm">
      {toasts.map((t) => (
          <div
            key={t.id}
            className={`rounded-xl px-3 py-2.5 backdrop-blur-md font-[Geist,sans-serif] text-xs flex items-start gap-2${reduceMotionSetting ? "" : " nv-toast-enter"}`}
            style={{
              color: TONES[t.type],
              background: `color-mix(in srgb, ${TONES[t.type]} 9%, var(--nv-surface-elevated))`,
              border: `1px solid color-mix(in srgb, ${TONES[t.type]} 52%, var(--nv-border))`,
              boxShadow: "var(--nv-shadow)",
            }}
            role={t.type === "error" ? "alert" : "status"}
            aria-live={t.type === "error" ? "assertive" : "polite"}
            aria-atomic="true"
          >
            <span aria-hidden="true" className="font-bold w-3 text-center">
              {ICONS[t.type]}
            </span>
            <span className="flex-1 break-words">
              <span className="sr-only">{t.type}: </span>
              {t.message}
            </span>
            <button
              onClick={() => dismiss(t.id)}
              className="opacity-70 hover:opacity-100 transition-opacity leading-none -mr-0.5 -mt-0.5 min-w-6 min-h-6 flex items-center justify-center"
              aria-label={`Dismiss ${t.type} notification`}
              title={t.type === "error" ? "Dismiss (errors don't auto-close)" : "Dismiss"}
            >
              ×
            </button>
          </div>
      ))}
    </div>
  );
}
