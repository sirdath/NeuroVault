import { useEffect, useState } from "react";
import { fetchStatus } from "../lib/api";
import { BrainSelector } from "./BrainSelector";

type View = "editor" | "graph" | "compile";

interface TopBarProps {
  view: View;
  onViewChange: (view: View) => void;
  onMemoryPanelToggle: () => void;
}

export function TopBar({ view, onViewChange, onMemoryPanelToggle }: TopBarProps) {
  const [serverUp, setServerUp] = useState(false);
  const [memoryCount, setMemoryCount] = useState(0);

  useEffect(() => {
    const check = () => {
      fetchStatus()
        .then((s) => {
          setServerUp(true);
          setMemoryCount(s.memories);
        })
        .catch(() => setServerUp(false));
    };
    check();
    const id = setInterval(check, 5000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="h-10 min-h-[40px] flex items-center justify-between px-4 bg-[#12121c] border-b border-[#1f1f2e]">
      {/* Left: View switcher + Brain selector */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1 bg-[#1a1a28] rounded p-0.5">
          <ViewButton active={view === "editor"} onClick={() => onViewChange("editor")} label="Editor" />
          <ViewButton active={view === "graph"} onClick={() => onViewChange("graph")} label="Graph" />
          <ViewButton active={view === "compile"} onClick={() => onViewChange("compile")} label="Compile" />
        </div>
        <BrainSelector />
      </div>

      {/* Center: Memory count */}
      <div className="flex items-center gap-2 text-xs font-[Geist,sans-serif] text-[#8a88a0]">
        {memoryCount > 0 && (
          <span>{memoryCount} {memoryCount === 1 ? "memory" : "memories"}</span>
        )}
      </div>

      {/* Right: Status + Memory Panel */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${serverUp ? "bg-[#4ade80]" : "bg-[#ff6b6b]"}`} />
          <span className="text-[10px] font-[Geist,sans-serif] text-[#8a88a0]">
            {serverUp ? "MCP" : "offline"}
          </span>
        </div>
        <button
          onClick={onMemoryPanelToggle}
          className="text-xs font-[Geist,sans-serif] text-[#8a88a0] hover:text-[#f0a500] transition-colors px-2 py-1 rounded hover:bg-[#1a1a28]"
        >
          brain
        </button>
      </div>
    </div>
  );
}

function ViewButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 text-xs font-[Geist,sans-serif] rounded transition-colors ${
        active ? "bg-[#1f1f2e] text-[#e8e6f0]" : "text-[#8a88a0] hover:text-[#e8e6f0]"
      }`}
    >
      {label}
    </button>
  );
}
