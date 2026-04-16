import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useNoteStore } from "./stores/noteStore";
import { Sidebar } from "./components/Sidebar";
import { Editor } from "./components/Editor";
import { NeuralGraph } from "./components/NeuralGraph";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { QuickCapture } from "./components/QuickCapture";
import { HoverPreview } from "./components/HoverPreview";
import { Toasts } from "./components/Toasts";
import { ShortcutHelp } from "./components/ShortcutHelp";
import { CompilationReview } from "./components/CompilationReview";
import { fetchStatus } from "./lib/api";

type View = "editor" | "graph" | "compile";

export default function App() {
  const initVault = useNoteStore((s) => s.initVault);
  const saveNote = useNoteStore((s) => s.saveNote);
  const [view, setView] = useState<View>("editor");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [quickCaptureOpen, setQuickCaptureOpen] = useState(false);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [triggerNewNote, setTriggerNewNote] = useState(0);
  const [triggerSearch, setTriggerSearch] = useState(0);
  const [serverDown, setServerDown] = useState(false);
  const [serverUp, setServerUp] = useState(false);
  const [noteCount, setNoteCount] = useState(0);
  const [firstBoot, setFirstBoot] = useState(true);
  const failCountRef = useRef(0);

  useEffect(() => {
    initVault();
  }, [initVault]);

  // Server health monitor
  useEffect(() => {
    const check = () => {
      fetchStatus()
        .then((s) => {
          failCountRef.current = 0;
          setServerDown(false);
          setServerUp(true);
          setFirstBoot(false);
          setNoteCount(s.memories);
        })
        .catch(() => {
          failCountRef.current += 1;
          setServerUp(false);
          if (failCountRef.current >= 3) setServerDown(true);
        });
    };
    check();
    const id = setInterval(check, 5000);
    return () => clearInterval(id);
  }, []);

  // Global shortcut bridge (Rust → frontend)
  useEffect(() => {
    const unlistenPromise = listen<null>("quick-capture-shortcut", () => {
      setQuickCaptureOpen(true);
    });
    return () => {
      unlistenPromise.then((un) => un()).catch(() => {});
    };
  }, []);

  const toggleView = useCallback(() => {
    setView((v) => (v === "editor" ? "graph" : v === "graph" ? "compile" : "editor"));
  }, []);

  // Command palette — the ONLY way to access power features
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
        title: "Switch to Editor",
        category: "View",
        action: () => setView("editor"),
      },
      {
        id: "view-graph",
        title: "Switch to Graph",
        category: "View",
        action: () => setView("graph"),
      },
      {
        id: "view-compile",
        title: "Switch to Compilations",
        category: "View",
        shortcut: "Ctrl+Shift+K",
        action: () => setView("compile"),
      },
      {
        id: "toggle-view",
        title: "Cycle views",
        category: "View",
        shortcut: "Ctrl+P",
        action: toggleView,
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
        title: "Keyboard shortcuts",
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
      if (ctrl && e.key === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
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
      if (ctrl && e.key === "/") {
        e.preventDefault();
        setTriggerSearch((n) => n + 1);
      }
      if (ctrl && e.shiftKey && (e.key === "K" || e.key === "k")) {
        e.preventDefault();
        setView("compile");
      }
      if (
        e.key === "?" &&
        !ctrl &&
        !e.altKey &&
        !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        setShortcutHelpOpen(true);
      }
      if (e.key === "Escape") {
        setShortcutHelpOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [saveNote, toggleView]);

  // First-boot loading screen — shows while the sidecar server is starting
  // up (and potentially downloading the ONNX model on first install).
  // Disappears the moment the first successful health check comes back.
  if (firstBoot && !serverUp) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-[#0b0b12] text-[#e8e6f0]">
        <h1 className="text-2xl font-bold font-[Geist,sans-serif] mb-3 tracking-tight">
          NeuroVault
        </h1>
        <p className="text-[13px] text-[#6a6880] font-[Geist,sans-serif] mb-6">
          Starting up...
        </p>
        <div className="w-48 h-1 bg-[#16162a] rounded-full overflow-hidden">
          <div className="h-full w-1/3 bg-[#b592ff] rounded-full animate-[shimmer_1.5s_ease-in-out_infinite]" />
        </div>
        <style>{`
          @keyframes shimmer {
            0% { transform: translateX(-100%); }
            100% { transform: translateX(400%); }
          }
        `}</style>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-[#0a0a12] text-[#e8e6f0] overflow-hidden">
      {/* Server-down banner */}
      {serverDown && (
        <div className="bg-[#ff6b6b]/5 border-b border-[#ff6b6b]/10 px-5 py-2 flex items-center gap-2.5 flex-shrink-0">
          <span className="w-2 h-2 rounded-full bg-[#ff6b6b] animate-pulse shadow-sm shadow-[#ff6b6b]/30" />
          <span className="text-[12px] text-[#ff8a8a]/80 font-[Geist,sans-serif]">
            Server offline — search, graph, and memory features unavailable
          </span>
        </div>
      )}

      {/* Top bar */}
      <div className="h-11 min-h-[44px] flex items-center justify-between px-5 bg-[#0c0c16]/80 backdrop-blur-sm border-b border-[#ffffff06]">
        <div className="flex items-center gap-1 bg-[#ffffff05] rounded-xl p-1 border border-[#ffffff06]">
          <TabButton active={view === "editor"} onClick={() => setView("editor")} label="Notes" />
          <TabButton active={view === "graph"} onClick={() => setView("graph")} label="Graph" />
          <TabButton active={view === "compile"} onClick={() => setView("compile")} label="Compile" />
        </div>

        <div className="flex items-center gap-4">
          {noteCount > 0 && (
            <span className="text-[11px] text-[#3a3858] font-[Geist,sans-serif]">
              {noteCount} {noteCount === 1 ? "note" : "notes"}
            </span>
          )}
          <div className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${serverUp ? "bg-[#4ade80] shadow-sm shadow-[#4ade80]/30" : "bg-[#ff6b6b]/60"}`} />
            <span className="text-[11px] font-[Geist,sans-serif] text-[#3a3858]">
              {serverUp ? "connected" : "offline"}
            </span>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        <Sidebar triggerNewNote={triggerNewNote} triggerSearch={triggerSearch} />
        <div className="flex-1 flex overflow-hidden">
          {view === "editor" && <Editor />}
          {view === "graph" && <NeuralGraph onOpenNote={() => setView("editor")} />}
          {view === "compile" && <CompilationReview />}
        </div>
      </div>

      {/* Overlays — only visible when triggered */}
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

function TabButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`px-3.5 py-1.5 text-[12px] font-medium font-[Geist,sans-serif] rounded-lg transition-all duration-200 ${
        active
          ? "bg-gradient-to-b from-[#222240] to-[#1a1a35] text-[#e8e6f0] shadow-sm shadow-black/30 border border-[#ffffff08]"
          : "text-[#5a587a] hover:text-[#b8b4d0] hover:bg-[#ffffff04]"
      }`}
    >
      {label}
    </button>
  );
}
