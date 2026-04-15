import { useEffect, useState, useMemo, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { useNoteStore } from "./stores/noteStore";
import { Sidebar } from "./components/Sidebar";
import { Editor } from "./components/Editor";
import { NeuralGraph } from "./components/NeuralGraph";
import { TopBar } from "./components/TopBar";
import { StatusBar } from "./components/StatusBar";
import { MemoryPanel } from "./components/MemoryPanel";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { QuickCapture } from "./components/QuickCapture";
import { HoverPreview } from "./components/HoverPreview";
import { RightSidebar } from "./components/RightSidebar";
import { Toasts } from "./components/Toasts";
import { ShortcutHelp } from "./components/ShortcutHelp";
import { DraftsView } from "./components/DraftsView";
import { IntelligenceView } from "./components/IntelligenceView";
import { CompilationReview } from "./components/CompilationReview";

type View = "editor" | "graph" | "drafts" | "intelligence" | "compile";

export default function App() {
  const initVault = useNoteStore((s) => s.initVault);
  const saveNote = useNoteStore((s) => s.saveNote);
  const [view, setView] = useState<View>("editor");
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [quickCaptureOpen, setQuickCaptureOpen] = useState(false);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(true);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [triggerNewNote, setTriggerNewNote] = useState(0);
  const [triggerSearch, setTriggerSearch] = useState(0);

  useEffect(() => {
    initVault();
  }, [initVault]);

  // Global-shortcut bridge: Rust registers Ctrl/Cmd+Shift+Space at the OS
  // level and emits `quick-capture-shortcut` when pressed, so the overlay
  // opens even when the window isn't focused. The in-app keydown handler
  // below still fires when the window IS focused — keeping both covers
  // the case where the OS refused to register the global combo.
  useEffect(() => {
    const unlistenPromise = listen<null>("quick-capture-shortcut", () => {
      setQuickCaptureOpen(true);
    });
    return () => {
      unlistenPromise.then((un) => un()).catch(() => {});
    };
  }, []);

  const toggleView = useCallback(() => {
    setView((v) =>
      v === "editor"
        ? "graph"
        : v === "graph"
        ? "drafts"
        : v === "drafts"
        ? "intelligence"
        : "editor"
    );
  }, []);

  // Build the command palette command list
  const commands: Command[] = useMemo(
    () => [
      {
        id: "quick-capture",
        title: "Quick capture",
        category: "Action",
        shortcut: "Ctrl+Shift+Space",
        action: () => setQuickCaptureOpen(true),
      },
      {
        id: "new-note",
        title: "Create new note",
        category: "Action",
        shortcut: "Ctrl+N",
        action: () => setTriggerNewNote((n) => n + 1),
      },
      {
        id: "save",
        title: "Save current note",
        category: "Action",
        shortcut: "Ctrl+S",
        action: () => saveNote(),
      },
      {
        id: "view-editor",
        title: "Switch to Editor view",
        category: "View",
        action: () => setView("editor"),
      },
      {
        id: "view-graph",
        title: "Switch to Graph view",
        category: "View",
        action: () => setView("graph"),
      },
      {
        id: "view-drafts",
        title: "Switch to Drafts view",
        category: "View",
        action: () => setView("drafts"),
      },
      {
        id: "view-intelligence",
        title: "Switch to Intelligence view",
        category: "View",
        action: () => setView("intelligence"),
      },
      {
        id: "view-compile",
        title: "Switch to Compilation Review",
        category: "View",
        shortcut: "Ctrl+Shift+K",
        action: () => setView("compile"),
      },
      {
        id: "toggle-view",
        title: "Toggle Editor / Graph",
        category: "View",
        shortcut: "Ctrl+P",
        action: toggleView,
      },
      {
        id: "memory-panel",
        title: "Open Memory Panel",
        category: "View",
        shortcut: "Ctrl+B",
        action: () => setMemoryPanelOpen((o) => !o),
      },
      {
        id: "right-sidebar",
        title: "Toggle Right Sidebar",
        category: "View",
        shortcut: "Ctrl+R",
        action: () => setRightSidebarOpen((o) => !o),
      },
      {
        id: "focus-mode",
        title: "Toggle Focus Mode",
        category: "View",
        shortcut: "F11",
        action: () => setFocusMode((f) => !f),
      },
      {
        id: "search",
        title: "Focus search",
        category: "Action",
        shortcut: "Ctrl+/",
        action: () => setTriggerSearch((n) => n + 1),
      },
      {
        id: "help",
        title: "Show keyboard shortcuts",
        category: "Help",
        shortcut: "?",
        action: () => setShortcutHelpOpen(true),
      },
    ],
    [saveNote, toggleView]
  );

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      // Cmd+K — Command Palette (#1 most-loved Obsidian feature)
      if (ctrl && e.key === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      // F11 — toggle Focus Mode. Hides sidebars/topbar/statusbar so the
      // editor gets the whole window. Classic distraction-free writing
      // pattern. Esc exits below.
      if (e.key === "F11") {
        e.preventDefault();
        setFocusMode((f) => !f);
        return;
      }
      // Cmd+Shift+Space — Quick Capture inbox overlay.
      // NOTE: in-app only; for global (works even when app is unfocused)
      // we'd need a Tauri Rust-side globalShortcut registration. That's
      // a followup — the in-app shortcut already covers the common case
      // where you're coding in the editor and want to drop a fact
      // without switching views.
      if (ctrl && e.shiftKey && (e.key === " " || e.code === "Space")) {
        e.preventDefault();
        setQuickCaptureOpen((o) => !o);
        return;
      }
      if (ctrl && e.key === "n") {
        e.preventDefault();
        setTriggerNewNote((n) => n + 1);
      }
      if (ctrl && e.key === "s") {
        e.preventDefault();
        saveNote();
      }
      if (ctrl && e.key === "p") {
        e.preventDefault();
        toggleView();
      }
      if (ctrl && e.key === "b") {
        e.preventDefault();
        setMemoryPanelOpen((o) => !o);
      }
      if (ctrl && e.key === "r") {
        e.preventDefault();
        setRightSidebarOpen((o) => !o);
      }
      if (ctrl && e.key === "/") {
        e.preventDefault();
        setTriggerSearch((n) => n + 1);
      }
      // Ctrl+Shift+K — open Compilation Review. Parallel to Ctrl+K (command
      // palette) but lower down the keyboard so it doesn't fight muscle
      // memory, and Shift distinguishes it from plain K.
      if (ctrl && e.shiftKey && (e.key === "K" || e.key === "k")) {
        e.preventDefault();
        setView("compile");
      }
      // ? key (without modifiers) opens shortcut help
      if (
        e.key === "?" &&
        !ctrl &&
        !e.altKey &&
        !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        setShortcutHelpOpen(true);
      }
      // Esc closes modals — and exits focus mode as a safety net.
      if (e.key === "Escape") {
        setShortcutHelpOpen(false);
        setFocusMode(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [saveNote, toggleView]);

  return (
    <div className="flex flex-col h-screen bg-[#0b0b12] text-[#e8e6f0] overflow-hidden">
      {!focusMode && (
        <TopBar
          view={view}
          onViewChange={setView}
          onMemoryPanelToggle={() => setMemoryPanelOpen((o) => !o)}
        />
      )}

      <div className="flex flex-1 overflow-hidden">
        {!focusMode && (
          <Sidebar
            triggerNewNote={triggerNewNote}
            triggerSearch={triggerSearch}
          />
        )}
        <div className="flex-1 flex overflow-hidden">
          {view === "editor" && <Editor />}
          {view === "graph" && <NeuralGraph onOpenNote={() => setView("editor")} />}
          {view === "drafts" && <DraftsView />}
          {view === "intelligence" && <IntelligenceView />}
          {view === "compile" && <CompilationReview />}
          <RightSidebar
            open={rightSidebarOpen && view === "editor" && !focusMode}
            onClose={() => setRightSidebarOpen(false)}
          />
        </div>
      </div>

      {!focusMode && <StatusBar />}

      {focusMode && (
        <button
          onClick={() => setFocusMode(false)}
          className="fixed top-3 right-3 z-40 text-[10px] uppercase tracking-wider font-[Geist,sans-serif] px-2 py-1 rounded transition-colors"
          style={{
            backgroundColor: "var(--color-surface-elevated)",
            color: "var(--color-tertiary)",
            border: "1px solid var(--color-border)",
          }}
          title="Exit focus mode (F11 or Esc)"
        >
          exit focus
        </button>
      )}

      <MemoryPanel
        open={memoryPanelOpen}
        onClose={() => setMemoryPanelOpen(false)}
      />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
      />

      <QuickCapture
        open={quickCaptureOpen}
        onClose={() => setQuickCaptureOpen(false)}
      />

      <HoverPreview />

      <ShortcutHelp
        open={shortcutHelpOpen}
        onClose={() => setShortcutHelpOpen(false)}
      />

      <Toasts />
    </div>
  );
}
