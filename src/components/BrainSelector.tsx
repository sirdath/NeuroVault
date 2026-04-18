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

  useEffect(() => { loadBrains(); }, [loadBrains]);

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
      await switchBrain(result.brain_id);
    }
  };

  const handleOpenFolder = async () => {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const selected = await openDialog({ directory: true, title: "Open folder as vault" });
      if (!selected) return;

      const folderPath = String(selected);
      const folderName = folderPath.split(/[\\/]/).pop() || "Imported";

      // Step 1: create a new brain
      const result = await createBrain(folderName, `Imported from: ${folderPath}`);
      if (!result) {
        alert("Failed to create vault. Is the server running?");
        return;
      }

      // Step 2: copy all .md files from the folder into the new brain
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const count = await invoke<number>("import_folder_as_vault", {
          source: folderPath,
          targetBrainId: result.brain_id,
        });
        alert(`Imported ${count} markdown file${count === 1 ? "" : "s"} from ${folderName}`);
      } catch (e) {
        alert(`Brain created but file import failed: ${e}`);
      }

      // Step 3: switch to the new brain
      setOpen(false);
      await switchBrain(result.brain_id);
    } catch (e) {
      alert(`Could not open folder: ${e}`);
    }
  };

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Trigger — shows current brain name */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 px-2 py-1.5 text-[12px] font-[Geist,sans-serif] rounded-md transition-all w-full text-left"
        style={{ color: "var(--nv-text-muted)" }}
        disabled={loading}
      >
        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: "var(--nv-accent)" }} />
        <span className="truncate flex-1 font-medium">
          {loading ? "Switching..." : activeBrainName}
        </span>
        <svg
          className={`w-3 h-3 flex-shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          style={{ color: "var(--nv-text-dim)" }}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown — opens UPWARD since we're at the bottom */}
      {open && (
        <div
          className="absolute bottom-full left-0 mb-1 w-[260px] rounded-lg shadow-2xl z-50 overflow-hidden"
          style={{
            background: "var(--nv-bg)",
            border: "1px solid var(--nv-border)",
            boxShadow: "0 -8px 32px rgba(0,0,0,0.3)",
          }}
        >
          {/* Vault list */}
          <div className="max-h-[280px] overflow-y-auto py-1">
            {brains.map((brain) => (
              <button
                key={brain.id}
                onClick={() => handleSwitch(brain.id)}
                className="w-full text-left px-3 py-2 flex items-start gap-2.5 transition-colors"
                style={{
                  background: brain.is_active ? "var(--nv-surface)" : undefined,
                }}
              >
                <span
                  className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0"
                  style={{ backgroundColor: brain.is_active ? "var(--nv-accent)" : "var(--nv-text-dim)" }}
                />
                <div className="min-w-0">
                  <p className="text-[12px] font-medium font-[Geist,sans-serif] truncate" style={{ color: "var(--nv-text)" }}>
                    {brain.name}
                  </p>
                  {brain.description && (
                    <p className="text-[10px] font-[Geist,sans-serif] truncate" style={{ color: "var(--nv-text-dim)" }}>
                      {brain.description}
                    </p>
                  )}
                </div>
                {brain.is_active && (
                  <span className="text-[10px] mt-0.5 flex-shrink-0" style={{ color: "var(--nv-accent)" }}>✓</span>
                )}
              </button>
            ))}
          </div>

          {/* Divider */}
          <div style={{ borderTop: "1px solid var(--nv-border)" }} />

          {/* Actions */}
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
                placeholder="Vault name..."
                className="w-full text-[12px] px-2.5 py-1.5 rounded-md focus:outline-none font-[Geist,sans-serif]"
                style={{ background: "var(--nv-surface)", color: "var(--nv-text)", border: "1px solid var(--nv-border)" }}
              />
              <input
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreate();
                  if (e.key === "Escape") setCreating(false);
                }}
                placeholder="Description (optional)"
                className="w-full text-[12px] px-2.5 py-1.5 rounded-md focus:outline-none font-[Geist,sans-serif]"
                style={{ background: "var(--nv-surface)", color: "var(--nv-text)", border: "1px solid var(--nv-border)" }}
              />
              <div className="flex gap-1.5">
                <button
                  onClick={handleCreate}
                  className="flex-1 text-[11px] font-medium font-[Geist,sans-serif] px-2.5 py-1.5 rounded-md transition-all"
                  style={{ background: "var(--nv-accent)", color: "var(--nv-bg)" }}
                >
                  Create
                </button>
                <button
                  onClick={() => setCreating(false)}
                  className="text-[11px] font-[Geist,sans-serif] px-2.5 py-1.5 rounded-md"
                  style={{ color: "var(--nv-text-muted)" }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="py-1">
              <button
                onClick={() => setCreating(true)}
                className="w-full text-left px-3 py-2 text-[12px] font-[Geist,sans-serif] transition-colors flex items-center gap-2"
                style={{ color: "var(--nv-text-muted)" }}
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
                Create new vault
              </button>
              <button
                onClick={handleOpenFolder}
                className="w-full text-left px-3 py-2 text-[12px] font-[Geist,sans-serif] transition-colors flex items-center gap-2"
                style={{ color: "var(--nv-text-muted)" }}
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 00-1.883 2.542l.857 6a2.25 2.25 0 002.227 1.932H19.05a2.25 2.25 0 002.227-1.932l.857-6a2.25 2.25 0 00-1.883-2.542m-16.5 0V6A2.25 2.25 0 016 3.75h3.879a1.5 1.5 0 011.06.44l2.122 2.12a1.5 1.5 0 001.06.44H18A2.25 2.25 0 0120.25 9v.776" />
                </svg>
                Open folder as vault
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
