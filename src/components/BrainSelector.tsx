import { useState, useRef, useEffect, useMemo } from "react";
import { useBrainStore } from "../stores/brainStore";
import { BrainSourcesPanel } from "./BrainSourcesPanel";
import { API_HOST } from "../lib/config";
import { toast } from "../stores/toastStore";

const API = API_HOST;

interface BrainStats { note_count: number; total_bytes: number; last_modified_secs: number }

// Sort options for the vault list. `key` is persisted to localStorage.
const SORT_OPTIONS = [
  { key: "name", label: "Name (A–Z)" },
  { key: "created", label: "Date added" },
  { key: "modified", label: "Recently changed" },
  { key: "notes", label: "Most notes" },
] as const;
type SortKey = (typeof SORT_OPTIONS)[number]["key"];

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function BrainSelector({
  triggerLabel,
  placement = "up",
  mode = "switch",
}: {
  triggerLabel?: string;
  placement?: "up" | "down";
  mode?: "switch" | "manage";
} = {}) {
  const { brains, activeBrainName, loading, switchBrain, createBrain, updateBrain, deleteBrain, loadBrains } =
    useBrainStore();
  const [open, setOpen] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>(() => {
    try {
      const v = localStorage.getItem("neurovault.brainSelector.sort");
      return SORT_OPTIONS.some((o) => o.key === v) ? (v as SortKey) : "name";
    } catch {
      return "name";
    }
  });
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [stats, setStats] = useState<Record<string, BrainStats>>({});
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);
  // When set, the per-brain Source Folders panel is open for this brain id.
  // The panel portals to document.body, so it survives the dropdown closing.
  const [sourcesPanelBrainId, setSourcesPanelBrainId] = useState<string | null>(null);

  useEffect(() => { loadBrains(); }, [loadBrains]);

  useEffect(() => {
    try { localStorage.setItem("neurovault.brainSelector.sort", sortKey); } catch { /* ignore */ }
  }, [sortKey]);

  // Sorted view of the brains. `name`/`created` use fields present
  // immediately; `modified`/`notes` read per-brain stats (fetched on open)
  // and re-sort once those arrive. Pure sort by the chosen key — the active
  // brain is not pinned.
  const sortedBrains = useMemo(() => {
    const arr = [...brains];
    arr.sort((a, b) => {
      switch (sortKey) {
        case "name":
          return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
        case "created":
          return (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0);
        case "modified":
          return (stats[b.id]?.last_modified_secs ?? 0) - (stats[a.id]?.last_modified_secs ?? 0);
        case "notes":
          return (stats[b.id]?.note_count ?? 0) - (stats[a.id]?.note_count ?? 0);
        default:
          return 0;
      }
    });
    return arr;
  }, [brains, sortKey, stats]);

  useEffect(() => {
    if (!open || brains.length === 0) return;
    // Fetch per-brain stats once the dropdown opens. Fire all requests in
    // parallel — they read from disk so they're cheap.
    let cancelled = false;
    (async () => {
      const next: Record<string, BrainStats> = {};
      await Promise.all(brains.map(async (b) => {
        try {
          const r = await fetch(`${API}/api/brains/${b.id}/stats`);
          if (!r.ok) return;
          const s = await r.json();
          if (s && typeof s.note_count === "number") {
            next[b.id] = {
              note_count: s.note_count,
              total_bytes: s.total_bytes,
              last_modified_secs: s.last_modified_secs ?? 0,
            };
          }
        } catch { /* server offline — skip */ }
      }));
      if (!cancelled) setStats(next);
    })();
    return () => { cancelled = true; };
  }, [open, brains]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
        setSortMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleSwitch = async (brainId: string) => {
    setOpen(false);
    setSortMenuOpen(false);
    await switchBrain(brainId);
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    const result = await createBrain(newName.trim(), newDesc.trim());
    if (result) {
      setNewName("");
      setNewDesc("");
      setCreating(false);
      if (mode === "switch") {
        setOpen(false);
        await switchBrain(result.brain_id);
      }
    }
  };

  const handleOpenFolder = async () => {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const selected = await openDialog({ directory: true, title: "Open folder as vault" });
      if (!selected) return;

      const folderPath = String(selected);
      const folderName = folderPath.split(/[\\/]/).pop() || "Vault";

      // Obsidian-style: the folder stays in place and IS the vault. We only
      // register a brain that points at it (vault_path) — no copying. The
      // server's file watcher ingests the folder's .md files into the brain's
      // internal DB. Deleting this brain later leaves the folder untouched.
      const result = await createBrain(folderName, `External folder vault`, folderPath);
      if (!result) {
        toast.error("Couldn't open that folder as a vault. Check the local memory service and try again.");
        return;
      }

      if (mode === "switch") {
        setOpen(false);
        await switchBrain(result.brain_id);
      }
    } catch (e) {
      toast.error(`Couldn't open folder: ${String(e)}`);
    }
  };

  const handleExport = async (brainId: string, brainName: string) => {
    try {
      const [{ save }, { invoke }] = await Promise.all([
        import("@tauri-apps/plugin-dialog"),
        import("@tauri-apps/api/core"),
      ]);
      const slug = brainName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const stamp = new Date().toISOString().slice(0, 10);
      const destPath = await save({
        title: "Export portable vault files as .zip",
        defaultPath: `neurovault-${slug}-${stamp}.zip`,
        filters: [{ name: "Zip archive", extensions: ["zip"] }],
      });
      if (!destPath) return;
      const count = await invoke<number>("export_brain_as_zip", {
        brainId,
        destPath: String(destPath),
      });
      toast.success(`Exported ${count} portable file${count === 1 ? "" : "s"}. Database-only history is not included.`);
    } catch (e) {
      toast.error(`Export failed: ${String(e)}`);
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
        aria-label={triggerLabel ?? "Switch active vault"}
      >
        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: "var(--nv-accent)" }} />
        <span className="truncate flex-1 font-medium">
          {loading ? "Loading vaults…" : triggerLabel ?? activeBrainName}
        </span>
        <svg
          className={`w-3 h-3 flex-shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          style={{ color: "var(--nv-text-dim)" }}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* The global rail and Settings use different vertical anchors. */}
      {open && (
        <div
          className={`absolute left-0 w-[260px] rounded-lg shadow-2xl z-50 overflow-hidden ${placement === "down" ? "top-full mt-1" : "bottom-full mb-1"}`}
          style={{
            background: "var(--nv-bg)",
            border: "1px solid var(--nv-border)",
            boxShadow: "0 -8px 32px rgba(0,0,0,0.3)",
          }}
        >
          {/* Header — vault count + sort control */}
          <div
            className="flex items-center justify-between px-3 py-1.5"
            style={{ borderBottom: "1px solid var(--nv-border)" }}
          >
            <span
              className="text-[10px] font-[Geist,sans-serif] uppercase tracking-wider"
              style={{ color: "var(--nv-text-dim)" }}
            >
              {brains.length} {brains.length === 1 ? "vault" : "vaults"}
            </span>
            <div className="relative">
              <button
                onClick={() => setSortMenuOpen((s) => !s)}
                className="flex items-center gap-1 h-6 px-1.5 rounded-md transition-colors"
                style={{
                  color: "var(--nv-text-dim)",
                  background: sortMenuOpen ? "var(--nv-surface)" : "transparent",
                }}
                title="Sort vaults"
                aria-label="Sort vaults"
                aria-haspopup="menu"
                aria-expanded={sortMenuOpen}
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 7h12M3 12h8M3 17h5M17 5v14m0 0l-3-3m3 3l3-3" />
                </svg>
                <span className="text-[10px] font-[Geist,sans-serif] whitespace-nowrap">
                  {SORT_OPTIONS.find((o) => o.key === sortKey)?.label}
                </span>
              </button>
              {sortMenuOpen && (
                <div
                  role="menu"
                  className="absolute right-0 top-[28px] z-[60] rounded-md overflow-hidden shadow-xl min-w-[150px]"
                  style={{ background: "var(--nv-bg)", border: "1px solid var(--nv-border)" }}
                >
                  {SORT_OPTIONS.map((opt) => (
                    <button
                      key={opt.key}
                      role="menuitemradio"
                      aria-checked={sortKey === opt.key}
                      onClick={() => { setSortKey(opt.key); setSortMenuOpen(false); }}
                      className="w-full text-left px-2.5 py-1.5 text-[11px] font-[Geist,sans-serif] flex items-center justify-between gap-2 transition-colors"
                      style={{
                        color: sortKey === opt.key ? "var(--nv-text)" : "var(--nv-text-muted)",
                        background: sortKey === opt.key ? "var(--nv-surface)" : "transparent",
                      }}
                      onMouseEnter={(e) => { if (sortKey !== opt.key) e.currentTarget.style.background = "var(--nv-surface)"; }}
                      onMouseLeave={(e) => { if (sortKey !== opt.key) e.currentTarget.style.background = "transparent"; }}
                    >
                      {opt.label}
                      {sortKey === opt.key && (
                        <span className="text-[10px]" style={{ color: "var(--nv-accent)" }}>✓</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Vault list */}
          <div className="max-h-[280px] overflow-y-auto py-1">
            {sortedBrains.map((brain) => {
              const isEditing = editingId === brain.id;
              const isConfirming = confirmDelete === brain.id;
              if (isEditing) {
                // Inline rename state. Name is always editable; description
                // can be cleared. brain_id stays stable — no on-disk moves.
                const commit = async () => {
                  const trimmedName = editName.trim();
                  if (!trimmedName) { setEditingId(null); return; }
                  await updateBrain(brain.id, { name: trimmedName, description: editDesc });
                  setEditingId(null);
                };
                return (
                  <div
                    key={brain.id}
                    className="px-3 py-2.5 space-y-2"
                    style={{ background: "var(--nv-surface)", borderLeft: "2px solid var(--nv-accent)" }}
                  >
                    <input
                      autoFocus
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commit();
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      placeholder="Name"
                      className="w-full text-[12px] px-2.5 py-1.5 rounded-md focus:outline-none font-[Geist,sans-serif]"
                      style={{ background: "var(--nv-bg)", color: "var(--nv-text)", border: "1px solid var(--nv-border)" }}
                    />
                    <input
                      value={editDesc}
                      onChange={(e) => setEditDesc(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commit();
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      placeholder="Description (optional)"
                      className="w-full text-[11px] px-2.5 py-1.5 rounded-md focus:outline-none font-[Geist,sans-serif]"
                      style={{ background: "var(--nv-bg)", color: "var(--nv-text)", border: "1px solid var(--nv-border)" }}
                    />
                    <div className="flex gap-1.5">
                      <button
                        onClick={commit}
                        className="text-[11px] font-[Geist,sans-serif] px-2.5 py-1 rounded-md font-medium"
                        style={{ background: "var(--nv-accent)", color: "var(--nv-bg)" }}
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        className="text-[11px] font-[Geist,sans-serif] px-2.5 py-1 rounded-md"
                        style={{ color: "var(--nv-text-muted)" }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                );
              }
              if (isConfirming) {
                // Inline confirm state. Different copy for external vs
                // internal so the user knows their folder is safe in the
                // external case — removing the brain only deletes the
                // NeuroVault index, never the user's own files.
                return (
                  <div
                    key={brain.id}
                    className="px-3 py-2.5"
                    style={{ background: "var(--nv-surface)", borderLeft: "2px solid var(--nv-negative)" }}
                  >
                    <p className="text-[11px] font-[Geist,sans-serif] mb-1.5" style={{ color: "var(--nv-text)" }}>
                      Remove <span className="font-medium">{brain.name}</span>?
                    </p>
                    <p className="text-[10px] font-[Geist,sans-serif] leading-relaxed mb-2" style={{ color: "var(--nv-text-dim)" }}>
                      {brain.vault_path
                        ? "Your folder stays on disk — only the NeuroVault index for it is removed."
                        : "Permanently deletes all notes in this vault. Cannot be undone."}
                    </p>
                    <div className="flex gap-1.5">
                      <button
                        onClick={async () => {
                          const ok = await deleteBrain(brain.id);
                          if (ok) setConfirmDelete(null);
                        }}
                        className="text-[11px] font-[Geist,sans-serif] px-2.5 py-1 rounded-md"
                        style={{ background: "var(--nv-negative)", color: "var(--nv-bg)" }}
                      >
                        {brain.vault_path ? "Remove" : "Delete"}
                      </button>
                      <button
                        onClick={() => setConfirmDelete(null)}
                        className="text-[11px] font-[Geist,sans-serif] px-2.5 py-1 rounded-md"
                        style={{ color: "var(--nv-text-muted)" }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                );
              }
              const brainSummary = (
                <>
                  <span
                    className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0"
                    style={{ backgroundColor: brain.is_active ? "var(--nv-accent)" : "var(--nv-text-dim)" }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className="text-[12px] font-medium font-[Geist,sans-serif] truncate" style={{ color: "var(--nv-text)" }}>
                        {brain.name}
                      </p>
                      {brain.vault_path && (
                        <span
                          className="text-[9px] uppercase tracking-wider font-[Geist,sans-serif] px-1 py-px rounded-sm flex-shrink-0"
                          style={{ color: "var(--nv-accent)", background: "var(--nv-accent-glow, rgba(181,146,255,0.1))", opacity: 0.9 }}
                          title={`External folder: ${brain.vault_path}`}
                        >
                          folder
                        </span>
                      )}
                    </div>
                    {brain.vault_path ? (
                      <p
                        className="text-[10px] font-mono truncate"
                        style={{ color: "var(--nv-text-dim)", direction: "rtl", textAlign: "left" }}
                        title={brain.vault_path}
                      >
                        {brain.vault_path}
                      </p>
                    ) : (
                      brain.description && (
                        <p className="text-[10px] font-[Geist,sans-serif] truncate" style={{ color: "var(--nv-text-dim)" }}>
                          {brain.description}
                        </p>
                      )
                    )}
                    {(() => {
                      const s = stats[brain.id];
                      if (!s) return null;
                      return (
                        <p className="text-[10px] font-[Geist,sans-serif] mt-0.5" style={{ color: "var(--nv-text-dim)" }}>
                          {s.note_count} {s.note_count === 1 ? "note" : "notes"} · {formatBytes(s.total_bytes)}
                        </p>
                      );
                    })()}
                  </div>
                </>
              );
              return (
                <div
                  key={brain.id}
                  className="group relative flex items-start gap-2.5 px-3 py-2 transition-colors"
                  style={{ background: brain.is_active ? "var(--nv-surface)" : undefined }}
                >
                  {mode === "switch" ? (
                    <button
                      onClick={() => handleSwitch(brain.id)}
                      className="flex items-start gap-2.5 min-w-0 flex-1 text-left cursor-pointer"
                    >
                      {brainSummary}
                    </button>
                  ) : (
                    <div
                      role="group"
                      aria-label={brain.is_active ? `${brain.name}, active vault` : brain.name}
                      className="flex items-start gap-2.5 min-w-0 flex-1 text-left"
                    >
                      {brainSummary}
                    </div>
                  )}
                  <div className="flex items-center gap-0.5 flex-shrink-0">
                    {brain.is_active && (
                      <span className="text-[10px] mt-0.5" style={{ color: "var(--nv-accent)" }}>
                        {mode === "manage" ? "Active" : "✓"}
                      </span>
                    )}
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      {/* Source folders — open the per-brain mirror panel.
                          Lets this brain lock onto one or more folders on
                          disk and keep their markdown in sync. */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setSourcesPanelBrainId(brain.id);
                        }}
                        className="w-5 h-5 flex items-center justify-center rounded transition-colors"
                        style={{ color: "var(--nv-text-dim)" }}
                        title="Source folders"
                        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--nv-text)"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.color = "var(--nv-text-dim)"; }}
                      >
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 00-1.883 2.542l.857 6a2.25 2.25 0 002.227 1.932H19.05a2.25 2.25 0 002.227-1.932l.857-6a2.25 2.25 0 00-1.883-2.542m-16.5 0V6A2.25 2.25 0 016 3.75h3.879a1.5 1.5 0 011.06.44l2.122 2.12a1.5 1.5 0 001.06.44H18A2.25 2.25 0 0120.25 9v.776" />
                        </svg>
                      </button>
                      {/* Rename — available for every brain. brain_id
                          stays stable, so no on-disk moves happen. */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditName(brain.name);
                          setEditDesc(brain.description || "");
                          setEditingId(brain.id);
                        }}
                        className="w-5 h-5 flex items-center justify-center rounded transition-colors"
                        style={{ color: "var(--nv-text-dim)" }}
                        title="Rename"
                        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--nv-text)"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.color = "var(--nv-text-dim)"; }}
                      >
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487zm0 0L19.5 7.125" />
                        </svg>
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleExport(brain.id, brain.name); }}
                        className="w-5 h-5 flex items-center justify-center rounded transition-colors"
                        style={{ color: "var(--nv-text-dim)" }}
                        title="Export portable files as .zip (database-only history is not included)"
                        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--nv-text)"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.color = "var(--nv-text-dim)"; }}
                      >
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                        </svg>
                      </button>
                      {/* Delete — only non-active brains; server rejects
                          deleting the active one */}
                      {!brain.is_active && (
                        <button
                          onClick={(e) => { e.stopPropagation(); setConfirmDelete(brain.id); }}
                          className="w-5 h-5 flex items-center justify-center rounded transition-colors"
                          style={{ color: "var(--nv-text-dim)" }}
                          title={brain.vault_path ? "Remove vault (folder preserved)" : "Delete vault"}
                          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--nv-negative)"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--nv-text-dim)"; }}
                        >
                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
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

      {/* Per-brain source folders panel — portals to document.body, so it
          survives the dropdown closing and uses its own z-layer. */}
      {sourcesPanelBrainId !== null && (() => {
        const brain = brains.find((b) => b.id === sourcesPanelBrainId);
        if (!brain) return null;
        return (
          <BrainSourcesPanel
            brainId={brain.id}
            brainName={brain.name}
            onClose={() => setSourcesPanelBrainId(null)}
          />
        );
      })()}
    </div>
  );
}
