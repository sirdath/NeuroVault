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
      { keys: "Ctrl+Shift+Space", description: "Quick capture (works even when window isn't focused)" },
      { keys: "?", description: "Show this help" },
      { keys: "Esc", description: "Close modals / exit edit mode" },
    ],
  },
  {
    category: "Notes",
    items: [
      { keys: "Ctrl+N", description: "Create new note" },
      { keys: "Ctrl+S", description: "Save current note" },
      { keys: "Ctrl+/", description: "Focus sidebar search" },
    ],
  },
  {
    category: "Views",
    items: [
      { keys: "Ctrl+1", description: "Switch to Editor" },
      { keys: "Ctrl+2", description: "Switch to Graph" },
      { keys: "Ctrl+3", description: "Switch to Compilations" },
      { keys: "Ctrl+P", description: "Cycle views" },
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
    category: "Sidebar tricks",
    items: [
      { keys: "Hover + pencil", description: "Rename or move between folders (edit the path)" },
      { keys: "Hover + ×", description: "Move note to trash" },
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
            className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[560px] max-w-[92vw] max-h-[85vh] rounded-lg shadow-2xl z-[70] flex flex-col overflow-hidden"
            style={{ background: "var(--nv-bg)", border: "1px solid var(--nv-border)" }}
          >
            <div className="px-5 py-3 flex items-center justify-between" style={{ borderBottom: "1px solid var(--nv-border)" }}>
              <h2 className="text-sm font-semibold font-[Geist,sans-serif]" style={{ color: "var(--nv-accent)" }}>
                Keyboard Shortcuts
              </h2>
              <button
                onClick={onClose}
                className="text-lg leading-none transition-colors"
                style={{ color: "var(--nv-text-dim)" }}
                onMouseEnter={(e) => (e.currentTarget.style.color = "var(--nv-text)")}
                onMouseLeave={(e) => (e.currentTarget.style.color = "var(--nv-text-dim)")}
              >
                ×
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-5">
              {SHORTCUTS.map((group) => (
                <div key={group.category}>
                  <h3 className="text-[10px] uppercase tracking-wider font-semibold mb-2 font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>
                    {group.category}
                  </h3>
                  <div className="space-y-1.5">
                    {group.items.map((s) => (
                      <div
                        key={s.keys}
                        className="flex items-center justify-between px-2 py-1.5 rounded transition-colors hover:[background-color:var(--nv-surface)]"
                      >
                        <span className="text-xs font-[Geist,sans-serif]" style={{ color: "var(--nv-text)" }}>
                          {s.description}
                        </span>
                        <kbd className="px-2 py-0.5 rounded text-[10px] font-mono" style={{ background: "var(--nv-surface)", color: "var(--nv-text-muted)", border: "1px solid var(--nv-border)" }}>
                          {s.keys}
                        </kbd>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="px-5 py-2 text-[10px] font-[Geist,sans-serif] text-center" style={{ borderTop: "1px solid var(--nv-border)", color: "var(--nv-text-dim)" }}>
              Press <kbd className="px-1 rounded" style={{ background: "var(--nv-surface)" }}>Esc</kbd> to close
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
