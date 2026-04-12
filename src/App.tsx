import { useEffect, useState, useMemo, useCallback } from "react";
import { useNoteStore } from "./stores/noteStore";
import { Sidebar } from "./components/Sidebar";
import { Editor } from "./components/Editor";
import { NeuralGraph } from "./components/NeuralGraph";
import { TopBar } from "./components/TopBar";
import { StatusBar } from "./components/StatusBar";
import { MemoryPanel } from "./components/MemoryPanel";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { RightSidebar } from "./components/RightSidebar";

type View = "editor" | "graph";

export default function App() {
  const initVault = useNoteStore((s) => s.initVault);
  const saveNote = useNoteStore((s) => s.saveNote);
  const [view, setView] = useState<View>("editor");
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(true);
  const [triggerNewNote, setTriggerNewNote] = useState(0);
  const [triggerSearch, setTriggerSearch] = useState(0);

  useEffect(() => {
    initVault();
  }, [initVault]);

  const toggleView = useCallback(() => {
    setView((v) => (v === "editor" ? "graph" : "editor"));
  }, []);

  // Build the command palette command list
  const commands: Command[] = useMemo(
    () => [
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
        id: "search",
        title: "Focus search",
        category: "Action",
        shortcut: "Ctrl+/",
        action: () => setTriggerSearch((n) => n + 1),
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
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [saveNote, toggleView]);

  return (
    <div className="flex flex-col h-screen bg-[#0f0f17] text-[#ddd9f0] overflow-hidden">
      <TopBar
        view={view}
        onViewChange={setView}
        onMemoryPanelToggle={() => setMemoryPanelOpen((o) => !o)}
      />

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          triggerNewNote={triggerNewNote}
          triggerSearch={triggerSearch}
        />
        <div className="flex-1 flex overflow-hidden">
          {view === "editor" ? <Editor /> : <NeuralGraph />}
          <RightSidebar
            open={rightSidebarOpen && view === "editor"}
            onClose={() => setRightSidebarOpen(false)}
          />
        </div>
      </div>

      <StatusBar />

      <MemoryPanel
        open={memoryPanelOpen}
        onClose={() => setMemoryPanelOpen(false)}
      />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
      />
    </div>
  );
}
