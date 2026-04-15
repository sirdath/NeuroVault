import { useState, useRef, useEffect } from "react";
import { useBrainStore } from "../stores/brainStore";

export function BrainSelector() {
  const { brains, activeBrainName, loading, switchBrain, createBrain, loadBrains } =
    useBrainStore();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Load brains on mount
  useEffect(() => {
    loadBrains();
  }, [loadBrains]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleSwitch = async (brainId: string) => {
    setOpen(false);
    await switchBrain(brainId);
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    const result = await createBrain(newName.trim(), newDesc.trim());
    if (result) {
      setNewName("");
      setNewDesc("");
      setCreating(false);
      setOpen(false);
      // Auto-switch to the new brain
      await switchBrain(result.brain_id);
    }
  };

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Trigger button */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-[Geist,sans-serif] rounded transition-colors bg-[#1a1a28] text-[#e8e6f0] hover:bg-[#1f1f2e]"
        disabled={loading}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-[#f0a500]" />
        <span className="max-w-[120px] truncate">
          {loading ? "Switching..." : activeBrainName}
        </span>
        <svg
          className={`w-3 h-3 text-[#8a88a0] transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute top-full left-0 mt-1 w-[240px] bg-[#12121c] border border-[#1f1f2e] rounded-lg shadow-xl z-50 overflow-hidden">
          {/* Brain list */}
          <div className="max-h-[240px] overflow-y-auto">
            {brains.map((brain) => (
              <button
                key={brain.id}
                onClick={() => handleSwitch(brain.id)}
                className={`w-full text-left px-3 py-2 flex items-start gap-2 transition-colors ${
                  brain.is_active
                    ? "bg-[#1a1a28]"
                    : "hover:bg-[#1a1a28]/50"
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 ${
                    brain.is_active ? "bg-[#f0a500]" : "bg-[#35335a]"
                  }`}
                />
                <div className="min-w-0">
                  <p className="text-xs font-medium text-[#e8e6f0] font-[Geist,sans-serif] truncate">
                    {brain.name}
                  </p>
                  {brain.description && (
                    <p className="text-[10px] text-[#8a88a0] font-[Geist,sans-serif] truncate">
                      {brain.description}
                    </p>
                  )}
                </div>
              </button>
            ))}
          </div>

          {/* Divider */}
          <div className="border-t border-[#1f1f2e]" />

          {/* Create new */}
          {creating ? (
            <div className="p-3 space-y-2">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreate();
                  if (e.key === "Escape") setCreating(false);
                }}
                placeholder="Brain name..."
                className="w-full bg-[#1a1a28] text-[#e8e6f0] text-xs px-2 py-1.5 rounded border border-[#1f1f2e] focus:border-[#f0a500] focus:outline-none font-[Geist,sans-serif] placeholder:text-[#35335a]"
              />
              <input
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreate();
                  if (e.key === "Escape") setCreating(false);
                }}
                placeholder="Description (optional)"
                className="w-full bg-[#1a1a28] text-[#e8e6f0] text-xs px-2 py-1.5 rounded border border-[#1f1f2e] focus:border-[#f0a500]/50 focus:outline-none font-[Geist,sans-serif] placeholder:text-[#35335a]"
              />
              <div className="flex gap-1">
                <button
                  onClick={handleCreate}
                  className="flex-1 text-xs font-[Geist,sans-serif] px-2 py-1 bg-[#f0a500] text-[#0b0b12] rounded hover:bg-[#f0a500]/90 font-medium"
                >
                  Create
                </button>
                <button
                  onClick={() => setCreating(false)}
                  className="text-xs font-[Geist,sans-serif] px-2 py-1 text-[#8a88a0] hover:text-[#e8e6f0] rounded"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setCreating(true)}
              className="w-full text-left px-3 py-2 text-xs text-[#8a88a0] hover:text-[#f0a500] font-[Geist,sans-serif] transition-colors hover:bg-[#1a1a28]/50"
            >
              + New Brain
            </button>
          )}
        </div>
      )}
    </div>
  );
}
