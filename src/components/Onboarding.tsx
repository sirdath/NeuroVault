import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

const STORAGE_KEY = "nv.onboarding.done";

interface OnboardingProps {
  onOpenSettings: () => void;
  onCreateFirstNote: () => void;
}

interface Slide {
  title: string;
  body: React.ReactNode;
  cta?: { label: string; action: "next" | "createNote" | "openSettings" };
}

export function Onboarding({ onOpenSettings, onCreateFirstNote }: OnboardingProps) {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    try {
      if (localStorage.getItem(STORAGE_KEY) !== "true") setOpen(true);
    } catch { /* storage disabled — skip onboarding quietly */ }
  }, []);

  const dismiss = () => {
    try { localStorage.setItem(STORAGE_KEY, "true"); } catch { /* ignore */ }
    setOpen(false);
  };

  // Escape dismisses the tour at any slide — matches the "Skip" affordance.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const slides: Slide[] = [
    {
      title: "Welcome to NeuroVault",
      body: (
        <>
          <div className="flex justify-center mb-5">
            <svg
              viewBox="0 0 24 24"
              className="w-20 h-20"
              style={{ color: "var(--nv-accent)" }}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-label="NeuroVault"
            >
              <circle cx="12" cy="12" r="9.5" />
              <line x1="12"   y1="8.4"  x2="12"   y2="11.6" />
              <line x1="7.5"  y1="15.6" x2="10.7" y2="13.8" />
              <line x1="16.5" y1="15.6" x2="13.3" y2="13.8" />
              <circle cx="12"   cy="6.9"  r="1.5" fill="currentColor" stroke="none" />
              <circle cx="6.4"  cy="16"   r="1.5" fill="currentColor" stroke="none" />
              <circle cx="17.6" cy="16"   r="1.5" fill="currentColor" stroke="none" />
              <circle cx="12"   cy="12.8" r="1.4" />
              <line   x1="12"   y1="14.2" x2="12" y2="15.7" />
            </svg>
          </div>
          <p className="text-sm leading-relaxed" style={{ color: "var(--nv-text)" }}>
            Claude forgets you after every conversation. NeuroVault doesn't.
          </p>
          <p className="text-xs leading-relaxed mt-3" style={{ color: "var(--nv-text-dim)" }}>
            A local-first memory layer that runs on your machine. Notes, decisions, people, projects —
            captured once, recalled whenever any AI asks.
          </p>
        </>
      ),
      cta: { label: "Show me around", action: "next" },
    },
    {
      title: "Everything starts with Ctrl+K",
      body: (
        <>
          <p className="text-sm leading-relaxed" style={{ color: "var(--nv-text)" }}>
            The command palette is your home base.
          </p>
          <p className="text-xs leading-relaxed mt-3" style={{ color: "var(--nv-text-dim)" }}>
            Create notes, search memory, switch brains, jump between views — all from one prompt.
            Press <kbd className="px-1.5 py-0.5 rounded text-[10px] font-mono mx-0.5" style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)" }}>?</kbd>
            anywhere to see every shortcut.
          </p>
        </>
      ),
      cta: { label: "Next", action: "next" },
    },
    {
      title: "Write your first note",
      body: (
        <>
          <p className="text-sm leading-relaxed" style={{ color: "var(--nv-text)" }}>
            Notes are plain Markdown with <code className="px-1 rounded text-[11px]" style={{ background: "var(--nv-surface)" }}>[[wikilinks]]</code> and
            tags. Ideas become a graph as you link them.
          </p>
          <p className="text-xs leading-relaxed mt-3" style={{ color: "var(--nv-text-dim)" }}>
            NeuroVault indexes everything in the background — semantic search, entity extraction, and
            spreading-activation recall all run locally.
          </p>
        </>
      ),
      cta: { label: "Create a note", action: "createNote" },
    },
    {
      title: "Connect Claude Desktop",
      body: (
        <>
          <p className="text-sm leading-relaxed" style={{ color: "var(--nv-text)" }}>
            The last step: wire Claude Desktop (or any MCP client) to this brain so every answer is
            grounded in what you've saved.
          </p>
          <p className="text-xs leading-relaxed mt-3" style={{ color: "var(--nv-text-dim)" }}>
            Settings has a one-click config generator — paste it into Claude's MCP config and you're done.
          </p>
        </>
      ),
      cta: { label: "Open Settings", action: "openSettings" },
    },
  ];

  const slide = slides[index] ?? slides[0]!;
  const isLast = index === slides.length - 1;

  const handleCta = () => {
    const cta = slide.cta;
    if (!cta) return;
    if (cta.action === "next") {
      if (isLast) dismiss();
      else setIndex((i) => i + 1);
    } else if (cta.action === "createNote") {
      dismiss();
      onCreateFirstNote();
    } else if (cta.action === "openSettings") {
      dismiss();
      onOpenSettings();
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100]"
            style={{ background: "rgba(0,0,0,0.65)", backdropFilter: "blur(6px)" }}
          />
          <motion.div
            key={index}
            initial={{ opacity: 0, scale: 0.96, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 10 }}
            transition={{ type: "spring", damping: 22, stiffness: 300 }}
            className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[480px] max-w-[92vw] rounded-xl shadow-2xl z-[110] flex flex-col overflow-hidden"
            style={{ background: "var(--nv-bg)", border: "1px solid var(--nv-border)" }}
          >
            <div className="px-6 pt-6 pb-2 flex items-center justify-between">
              <div className="text-[10px] uppercase tracking-wider font-semibold font-[Geist,sans-serif]" style={{ color: "var(--nv-accent)" }}>
                Getting started · {index + 1} / {slides.length}
              </div>
              <button
                onClick={dismiss}
                className="text-[11px] font-[Geist,sans-serif] transition-colors"
                style={{ color: "var(--nv-text-dim)" }}
                onMouseEnter={(e) => (e.currentTarget.style.color = "var(--nv-text)")}
                onMouseLeave={(e) => (e.currentTarget.style.color = "var(--nv-text-dim)")}
              >
                Skip
              </button>
            </div>

            <div className="px-6 py-4">
              <h2 className="text-lg font-semibold font-[Geist,sans-serif] mb-3" style={{ color: "var(--nv-text)" }}>
                {slide.title}
              </h2>
              <div className="font-[Geist,sans-serif]">{slide.body}</div>
            </div>

            <div className="px-6 py-4 flex items-center justify-between" style={{ borderTop: "1px solid var(--nv-border)" }}>
              <div className="flex gap-1.5">
                {slides.map((_, i) => (
                  <button
                    key={i}
                    onClick={() => setIndex(i)}
                    className="w-1.5 h-1.5 rounded-full transition-all"
                    style={{
                      background: i === index ? "var(--nv-accent)" : "var(--nv-border)",
                      width: i === index ? "16px" : "6px",
                    }}
                    aria-label={`Go to slide ${i + 1}`}
                  />
                ))}
              </div>
              <div className="flex items-center gap-2">
                {index > 0 && (
                  <button
                    onClick={() => setIndex((i) => i - 1)}
                    className="px-3 py-1.5 text-xs rounded-md font-[Geist,sans-serif] transition-colors"
                    style={{ color: "var(--nv-text-dim)" }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = "var(--nv-text)")}
                    onMouseLeave={(e) => (e.currentTarget.style.color = "var(--nv-text-dim)")}
                  >
                    Back
                  </button>
                )}
                {slide.cta && (
                  <button
                    onClick={handleCta}
                    className="px-4 py-1.5 text-xs rounded-md font-[Geist,sans-serif] font-medium transition-opacity hover:opacity-90"
                    style={{ background: "var(--nv-accent)", color: "var(--nv-bg)" }}
                  >
                    {slide.cta.label}
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
