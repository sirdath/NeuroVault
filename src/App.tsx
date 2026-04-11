import { useEffect, useState, useMemo, useCallback } from "react";
import { useNoteStore } from "./stores/noteStore";
import { Sidebar } from "./components/Sidebar";
import { Editor } from "./components/Editor";
import { NeuralGraph } from "./components/NeuralGraph";
import { TopBar } from "./components/TopBar";
import { StatusBar } from "./components/StatusBar";
import { MemoryPanel } from "./components/MemoryPanel";
import { useKeyboard } from "./hooks/useKeyboard";

type View = "editor" | "graph";

export default function App() {
  const initVault = useNoteStore((s) => s.initVault);
  const saveNote = useNoteStore((s) => s.saveNote);
  const [view, setView] = useState<View>("editor");
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false);
  const [triggerNewNote, setTriggerNewNote] = useState(0);
  const [triggerSearch, setTriggerSearch] = useState(0);

  useEffect(() => {
    initVault();
  }, [initVault]);

  const toggleView = useCallback(() => {
    setView((v) => (v === "editor" ? "graph" : "editor"));
  }, []);

  const keyboardActions = useMemo(
    () => ({
      onNewNote: () => setTriggerNewNote((n) => n + 1),
      onSave: () => saveNote(),
      onToggleView: toggleView,
      onToggleMemoryPanel: () => setMemoryPanelOpen((o) => !o),
      onSearch: () => setTriggerSearch((n) => n + 1),
    }),
    [saveNote, toggleView]
  );

  useKeyboard(keyboardActions);

  return (
    <div className="flex flex-col h-screen bg-[#07070e] text-[#ddd9f0] overflow-hidden">
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
        {view === "editor" ? <Editor /> : <NeuralGraph />}
      </div>

      <StatusBar />

      <MemoryPanel
        open={memoryPanelOpen}
        onClose={() => setMemoryPanelOpen(false)}
      />
    </div>
  );
}
