import { BrainSelector } from "./BrainSelector";

type View = "editor" | "graph" | "compile";

interface TopBarProps {
  view: View;
  onViewChange: (view: View) => void;
  onMemoryPanelToggle: () => void;
  serverUp: boolean;
  memoryCount: number;
}

export function TopBar({ view, onViewChange, onMemoryPanelToggle, serverUp, memoryCount }: TopBarProps) {
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

      {/* Center: Note count */}
      <div className="flex items-center gap-2 text-xs font-[Geist,sans-serif] text-[#8a88a0]">
        {memoryCount > 0 && (
          <span>{memoryCount} {memoryCount === 1 ? "note" : "notes"}</span>
        )}
      </div>

      {/* Right: Status + Brain Status panel */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${serverUp ? "bg-[#4ade80]" : "bg-[#ff6b6b]"}`} />
          <span className="text-[10px] font-[Geist,sans-serif] text-[#8a88a0]">
            {serverUp ? "connected" : "offline"}
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
