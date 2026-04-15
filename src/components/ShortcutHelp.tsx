import { motion, AnimatePresence } from "framer-motion";

interface ShortcutHelpProps {
  open: boolean;
  onClose: () => void;
}

const SHORTCUTS: Array<{
  category: string;
  items: Array<{ keys: string; description: string }>;
}> = [
  {
    category: "General",
    items: [
      { keys: "Ctrl+K", description: "Open command palette" },
      { keys: "?", description: "Show this help" },
      { keys: "Esc", description: "Close modals and dropdowns" },
    ],
  },
  {
    category: "Notes",
    items: [
      { keys: "Ctrl+N", description: "Create new note" },
      { keys: "Ctrl+S", description: "Save current note" },
      { keys: "Ctrl+/", description: "Focus search" },
    ],
  },
  {
    category: "Views",
    items: [
      { keys: "Ctrl+P", description: "Toggle Editor / Graph" },
      { keys: "Ctrl+B", description: "Toggle memory panel" },
      { keys: "Ctrl+R", description: "Toggle right sidebar" },
    ],
  },
  {
    category: "Editor",
    items: [
      { keys: "/", description: "Open slash command menu" },
      { keys: "[[", description: "Open wikilink autocomplete" },
      { keys: "Ctrl+Click", description: "Follow a wikilink" },
    ],
  },
  {
    category: "Command Palette",
    items: [
      { keys: "↑ / ↓", description: "Navigate results" },
      { keys: "Enter", description: "Execute selected command" },
      { keys: "Esc", description: "Close palette" },
    ],
  },
];

export function ShortcutHelp({ open, onClose }: ShortcutHelpProps) {
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 z-[60]"
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 10 }}
            transition={{ type: "spring", damping: 22, stiffness: 300 }}
            className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[560px] max-w-[92vw] max-h-[85vh] bg-[#0b0b12] border border-[#2a2a40] rounded-lg shadow-2xl z-[70] flex flex-col overflow-hidden"
          >
            <div className="px-5 py-3 border-b border-[#1f1f2e] flex items-center justify-between">
              <h2 className="text-sm font-semibold font-[Geist,sans-serif] text-[#f0a500]">
                Keyboard Shortcuts
              </h2>
              <button
                onClick={onClose}
                className="text-[#6a6880] hover:text-[#e8e6f0] text-lg leading-none"
              >
                ×
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-5">
              {SHORTCUTS.map((group) => (
                <div key={group.category}>
                  <h3 className="text-[10px] uppercase tracking-wider text-[#a8a6c0] font-semibold mb-2 font-[Geist,sans-serif]">
                    {group.category}
                  </h3>
                  <div className="space-y-1.5">
                    {group.items.map((s) => (
                      <div
                        key={s.keys}
                        className="flex items-center justify-between px-2 py-1.5 rounded hover:bg-[#1a1a28]"
                      >
                        <span className="text-xs text-[#e8e6f0] font-[Geist,sans-serif]">
                          {s.description}
                        </span>
                        <kbd className="px-2 py-0.5 bg-[#1a1a28] border border-[#2a2a40] rounded text-[10px] text-[#a8a6c0] font-mono">
                          {s.keys}
                        </kbd>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="px-5 py-2 border-t border-[#1f1f2e] text-[10px] text-[#6a6880] font-[Geist,sans-serif] text-center">
              Press <kbd className="px-1 bg-[#1a1a28] rounded">Esc</kbd> to close
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
