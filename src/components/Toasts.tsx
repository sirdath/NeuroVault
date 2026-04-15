import { AnimatePresence, motion } from "framer-motion";
import { useToastStore } from "../stores/toastStore";

const COLORS = {
  info: "border-[#00c9b1] bg-[#00c9b1]/10 text-[#00c9b1]",
  success: "border-[#4ade80] bg-[#4ade80]/10 text-[#4ade80]",
  warning: "border-[#f0a500] bg-[#f0a500]/10 text-[#f0a500]",
  error: "border-[#ff6b6b] bg-[#ff6b6b]/10 text-[#ff6b6b]",
};

export function Toasts() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  return (
    <div className="fixed bottom-6 right-6 z-[100] flex flex-col gap-2 max-w-sm">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: 12, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, x: 40, scale: 0.9 }}
            transition={{ type: "spring", damping: 22, stiffness: 300 }}
            className={`border rounded-md px-3 py-2 backdrop-blur-md shadow-lg cursor-pointer font-[Geist,sans-serif] text-xs ${COLORS[t.type]}`}
            onClick={() => dismiss(t.id)}
          >
            {t.message}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
