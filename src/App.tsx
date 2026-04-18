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
import { SettingsView } from "./components/SettingsView";
import { useSettingsStore, type Theme } from "./stores/settingsStore";
import { fetchStatus } from "./lib/api";

type View = "editor" | "graph" | "compile";

export default function App() {
  const initVault = useNoteStore((s) => s.initVault);
  const saveNote = useNoteStore((s) => s.saveNote);
  const theme = useSettingsStore((s) => s.theme);
  const [view, setView] = useState<View>("editor");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [quickCaptureOpen, setQuickCaptureOpen] = useState(false);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [triggerNewNote, setTriggerNewNote] = useState(0);
  const [triggerSearch, setTriggerSearch] = useState(0);
  const [serverDown, setServerDown] = useState(false);
  const [serverUp, setServerUp] = useState(false);
  const [noteCount, setNoteCount] = useState(0);
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

  const [settingsOpen, setSettingsOpen] = useState(false);

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

  // Inject theme as CSS custom properties so every component can read them
  const themeVars: React.CSSProperties & Record<string, string> = {
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
  } as React.CSSProperties & Record<string, string>;

  return (
    <div
      className="flex flex-col h-screen overflow-hidden font-[Geist,sans-serif]"
      style={{ ...themeVars, backgroundColor: theme.bg, color: theme.text }}
    >
      {/* Server-down banner with start button */}
      {serverDown && (
        <div
          className="px-5 py-2.5 flex items-center justify-between flex-shrink-0 backdrop-blur-[10px]"
          style={{ background: `${theme.negative}10`, borderBottom: `1px solid ${theme.negative}20` }}
        >
          <div className="flex items-center gap-2.5">
            <span className="w-2 h-2 rounded-full animate-pulse" style={{ backgroundColor: theme.negative }} />
            <span className="text-[12px]" style={{ color: `${theme.negative}aa` }}>
              Server offline — start it to enable search, graph, and memory
            </span>
          </div>
          <button
            onClick={async () => {
              try {
                const { invoke } = await import("@tauri-apps/api/core");
                const result = await invoke<string>("start_server");
                console.log("[start_server]", result);
                // Re-check status after a short delay to let it boot
                setTimeout(() => failCountRef.current = 0, 500);
              } catch (e) {
                alert(
                  `Failed to start server: ${e}\n\n` +
                  "If this keeps happening, start manually:\n" +
                  "cd server && uv run python -m neurovault_server --http-only"
                );
              }
            }}
            className="text-[11px] font-medium px-3 py-1 rounded-lg transition-all"
            style={{
              background: `${theme.accent}20`,
              color: theme.accent,
              border: `1px solid ${theme.accent}40`,
            }}
          >
            Start Server
          </button>
        </div>
      )}

      {/* Top bar */}
      <div
        className="h-11 min-h-[44px] flex items-center justify-between px-5 backdrop-blur-[10px]"
        style={{
          background: theme.surface,
          borderBottom: `1px solid ${theme.border}`,
          boxShadow: "inset 0 -1px 0 rgba(255,255,255,0.03)",
        }}
      >
        <div
          className="flex items-center gap-0.5 rounded-xl p-1"
          style={{
            background: theme.surface,
            border: `1px solid ${theme.border}`,
            boxShadow: "inset 0 1px 1px rgba(255,255,255,0.05)",
          }}
        >
          <TabButton active={view === "editor"} onClick={() => setView("editor")} label="Notes" theme={theme} />
          <TabButton active={view === "graph"} onClick={() => setView("graph")} label="Graph" theme={theme} />
          <TabButton active={view === "compile"} onClick={() => setView("compile")} label="Compile" theme={theme} />
        </div>

        <div className="flex items-center gap-4">
          {noteCount > 0 && (
            <span className="text-[11px]" style={{ color: theme.textDim }}>
              {noteCount} {noteCount === 1 ? "note" : "notes"}
            </span>
          )}
          <div className="flex items-center gap-1.5">
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{
                backgroundColor: serverUp ? theme.positive : theme.negative,
                boxShadow: serverUp ? `0 0 6px ${theme.positive}66` : undefined,
              }}
            />
            <span className="text-[11px]" style={{ color: theme.textDim }}>
              {serverUp ? "connected" : "offline"}
            </span>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          triggerNewNote={triggerNewNote}
          triggerSearch={triggerSearch}
          onNoteSelect={() => { if (view !== "editor") setView("editor"); }}
          onSettingsOpen={() => setSettingsOpen(true)}
        />
        <div className="flex-1 flex overflow-hidden">
          {view === "editor" && <Editor />}
          {view === "graph" && <NeuralGraph onOpenNote={() => setView("editor")} />}
          {view === "compile" && <CompilationReview />}
        </div>
      </div>

      {/* Settings slide-over */}
      {settingsOpen && (
        <>
          <div className="fixed inset-0 bg-black/30 z-40" onClick={() => setSettingsOpen(false)} />
          <div
            className="fixed top-0 right-0 h-full w-[420px] z-50 overflow-y-auto"
            style={{ background: theme.bg, borderLeft: `1px solid ${theme.border}` }}
          >
            <button
              onClick={() => setSettingsOpen(false)}
              className="absolute top-4 right-4 w-7 h-7 flex items-center justify-center rounded-lg z-10 text-lg"
              style={{ color: theme.textMuted }}
            >
              ×
            </button>
            <SettingsView />
          </div>
        </>
      )}

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

function TabButton({ active, onClick, label, theme }: { active: boolean; onClick: () => void; label: string; theme: Theme }) {
  return (
    <button
      onClick={onClick}
      className="px-4 py-1.5 text-[12px] font-medium font-[Geist,sans-serif] rounded-lg transition-all duration-200"
      style={active ? {
        background: theme.surface,
        color: theme.text,
        border: `1px solid ${theme.border}`,
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08), 0 1px 3px rgba(0,0,0,0.3)",
      } : {
        color: theme.textDim,
        border: "1px solid transparent",
      }}
    >
      {label}
    </button>
  );
}
