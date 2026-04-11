import { useEffect } from "react";

interface KeyboardActions {
  onNewNote: () => void;
  onSave: () => void;
  onToggleView: () => void;
  onToggleMemoryPanel: () => void;
  onSearch: () => void;
}

export function useKeyboard(actions: KeyboardActions) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;

      if (ctrl && e.key === "n") {
        e.preventDefault();
        actions.onNewNote();
      }
      if (ctrl && e.key === "s") {
        e.preventDefault();
        actions.onSave();
      }
      if (ctrl && e.key === "p") {
        e.preventDefault();
        actions.onToggleView();
      }
      if (ctrl && e.key === "b") {
        e.preventDefault();
        actions.onToggleMemoryPanel();
      }
      if (ctrl && e.key === "k") {
        e.preventDefault();
        actions.onSearch();
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [actions]);
}
