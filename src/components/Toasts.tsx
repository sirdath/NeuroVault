import { useSettingsStore } from "../stores/settingsStore";
import { useToastStore } from "../stores/toastStore";

const COLORS = {
  info: "border-[#00c9b1] bg-[#00c9b1]/10 text-[#00c9b1]",
  success: "border-[#4ade80] bg-[#4ade80]/10 text-[#4ade80]",
  warning: "border-[#568cfa] bg-[#568cfa]/10 text-[#568cfa]",
  error: "border-[#ff6b6b] bg-[#ff6b6b]/10 text-[#ff6b6b]",
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
            className={`border rounded-md px-3 py-2 backdrop-blur-md shadow-lg font-[Geist,sans-serif] text-xs flex items-start gap-2 ${COLORS[t.type]}${reduceMotionSetting ? "" : " nv-toast-enter"}`}
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
