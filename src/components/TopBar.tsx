import { useEffect, useState } from "react";
import { fetchStatus } from "../lib/api";
import { BrainSelector } from "./BrainSelector";

type View = "editor" | "graph" | "drafts";

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
    <div className="h-10 min-h-[40px] flex items-center justify-between px-4 bg-[#0d0d1a] border-b border-[#1e1e38]">
      {/* Left: View switcher + Brain selector */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1 bg-[#131325] rounded p-0.5">
          <ViewButton active={view === "editor"} onClick={() => onViewChange("editor")} label="Editor" />
          <ViewButton active={view === "graph"} onClick={() => onViewChange("graph")} label="Graph" />
          <ViewButton active={view === "drafts"} onClick={() => onViewChange("drafts")} label="Drafts" />
        </div>
        <BrainSelector />
      </div>

      {/* Center: Memory count */}
      <div className="flex items-center gap-2 text-xs font-[Geist,sans-serif] text-[#7a779a]">
        {memoryCount > 0 && (
          <span>{memoryCount} {memoryCount === 1 ? "memory" : "memories"}</span>
        )}
      </div>

      {/* Right: Status + Memory Panel */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${serverUp ? "bg-[#4ade80]" : "bg-[#f06080]"}`} />
          <span className="text-[10px] font-[Geist,sans-serif] text-[#7a779a]">
            {serverUp ? "MCP" : "offline"}
          </span>
        </div>
        <button
          onClick={onMemoryPanelToggle}
          className="text-xs font-[Geist,sans-serif] text-[#7a779a] hover:text-[#f0a500] transition-colors px-2 py-1 rounded hover:bg-[#131325]"
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
        active ? "bg-[#1e1e38] text-[#ddd9f0]" : "text-[#7a779a] hover:text-[#ddd9f0]"
      }`}
    >
      {label}
    </button>
  );
}
