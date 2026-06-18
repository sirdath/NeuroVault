import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useBrainStore, type BrainSource, type SyncPlan } from "../stores/brainStore";

interface BrainSourcesPanelProps {
  brainId: string;
  brainName: string;
  onClose: () => void;
}

// Friendly date/time formatting for last_synced timestamps.
function formatLastSynced(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "never";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function BrainSourcesPanel({ brainId, brainName, onClose }: BrainSourcesPanelProps) {
  const { listSources, setSources, previewSources, syncSources, graphifyFolder } = useBrainStore();

  // --- local state ----------------------------------------------------------
  const [sources, setSourcesToState] = useState<BrainSource[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingInit, setLoadingInit] = useState(true);

  // "Add folder path" input
  const [newPath, setNewPath] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  // In-flight flags
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [indexing, setIndexing] = useState(false);

  // Dry-run preview awaiting the user's confirmation (null = none pending)
  const [plan, setPlan] = useState<SyncPlan | null>(null);

  // Inline action results
  const [saveError, setSaveError] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  const newPathInputRef = useRef<HTMLInputElement>(null);

  // -------------------------------------------------------------------------
  // Load on mount
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingInit(true);
      setLoadError(null);
      try {
        const list = await listSources(brainId);
        if (!cancelled) setSourcesToState(list);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoadingInit(false);
      }
    })();
    return () => { cancelled = true; };
  }, [brainId, listSources]);

  // -------------------------------------------------------------------------
  // Keyboard: Escape closes
  // -------------------------------------------------------------------------
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // -------------------------------------------------------------------------
  // Local list mutations (toggle, remove) — do NOT call the API yet.
  // The user must press Save to commit.
  // -------------------------------------------------------------------------
  const handleToggle = (idx: number) => {
    setSourcesToState((prev) =>
      prev.map((s, i) => (i === idx ? { ...s, enabled: !s.enabled } : s)),
    );
    // Clear any previous save error when the user makes a change
    setSaveError(null);
    setSyncResult(null);
  };

  const handleRemove = (idx: number) => {
    setSourcesToState((prev) => prev.filter((_, i) => i !== idx));
    setSaveError(null);
    setSyncResult(null);
  };

  // -------------------------------------------------------------------------
  // Add a new path from the input field
  // -------------------------------------------------------------------------
  const handleAdd = () => {
    const trimmed = newPath.trim();
    if (!trimmed) {
      setAddError("Please enter a folder path.");
      return;
    }
    // Detect obvious non-absolute paths (heuristic — the server validates fully)
    const looksAbsolute =
      /^[A-Za-z]:[/\\]/.test(trimmed) ||  // Windows: C:\ or C:/
      trimmed.startsWith("/");              // Unix / macOS
    if (!looksAbsolute) {
      setAddError("Enter an absolute path (e.g. C:\\Projects\\MyFolder or /home/user/projects).");
      return;
    }
    setAddError(null);
    setSaveError(null);
    setSyncResult(null);
    setSourcesToState((prev) => [
      ...prev,
      { path: trimmed, enabled: true, last_synced: null, file_count: 0 },
    ]);
    setNewPath("");
    newPathInputRef.current?.focus();
  };

  // -------------------------------------------------------------------------
  // Browse button — uses @tauri-apps/plugin-dialog (already a dep)
  // -------------------------------------------------------------------------
  const handleBrowse = async () => {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const selected = await openDialog({ directory: true, title: "Select source folder" });
      if (!selected) return;
      setNewPath(String(selected));
      setAddError(null);
      newPathInputRef.current?.focus();
    } catch {
      // Dialog not available (browser mode or old build) — fail silently
    }
  };

  // -------------------------------------------------------------------------
  // Save — PUT the full list
  // -------------------------------------------------------------------------
  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    setSyncResult(null);
    try {
      const payload = sources.map(({ path, enabled }) => ({ path, enabled }));
      const updated = await setSources(brainId, payload);
      setSourcesToState(updated);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  // -------------------------------------------------------------------------
  // Sync = preview (dry run) → confirm → apply. The preview never touches
  // the brain; it just reports what a sync would add/update/remove/skip.
  // -------------------------------------------------------------------------
  const handlePreview = async () => {
    setPreviewing(true);
    setSyncResult(null);
    setSaveError(null);
    setPlan(null);
    try {
      setPlan(await previewSources(brainId));
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewing(false);
    }
  };

  const handleApply = async () => {
    setSyncing(true);
    setSyncResult(null);
    setSaveError(null);
    try {
      const result = await syncSources(brainId);
      const dup = result.skipped_duplicates
        ? `, skipped ${result.skipped_duplicates} duplicate${result.skipped_duplicates === 1 ? "" : "s"}`
        : "";
      setSyncResult(`Added/updated ${result.synced}, removed ${result.removed}${dup}`);
      setPlan(null);
      // Refresh the list so last_synced + file_count update
      const list = await listSources(brainId);
      setSourcesToState(list);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  // -------------------------------------------------------------------------
  // Index code — run the native (Rust, tree-sitter) graphify pipeline over
  // every ENABLED source folder so the brain's knowledge graph gains the
  // folder's code structure (functions, types, call edges → who_calls /
  // blast_radius). No Python; source never leaves the machine. Complements
  // the markdown mirror (Sync), which only brings in `.md`.
  // -------------------------------------------------------------------------
  const handleIndexCode = async () => {
    const targets = sources.filter((s) => s.enabled).map((s) => s.path);
    if (targets.length === 0) {
      setSaveError("Add and enable at least one folder before indexing code.");
      return;
    }
    setIndexing(true);
    setSyncResult(null);
    setSaveError(null);
    try {
      let files = 0;
      let symbols = 0;
      for (const path of targets) {
        const r = await graphifyFolder(brainId, path);
        files += r.files;
        symbols += r.symbols;
      }
      setSyncResult(`Indexed ${symbols} symbol${symbols === 1 ? "" : "s"} across ${files} code file${files === 1 ? "" : "s"}`);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setIndexing(false);
    }
  };

  const busy = saving || syncing || previewing || indexing;
  const planEmpty =
    plan !== null &&
    plan.to_add.length === 0 &&
    plan.to_update.length === 0 &&
    plan.to_remove.length === 0 &&
    plan.duplicates.length === 0;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center z-[100] pointer-events-auto"
      style={{ background: "rgba(0,0,0,0.66)", backdropFilter: "blur(4px)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="rounded-2xl flex flex-col"
        style={{
          // --nv-surface is a ~3% alpha elevation tint meant to sit on the
          // opaque --nv-bg; using it alone let the editor bleed through. Stack
          // the tint over the opaque base so the modal card is fully opaque in
          // every theme.
          background: "linear-gradient(var(--nv-surface), var(--nv-surface)), var(--nv-bg)",
          border: "1px solid var(--nv-border)",
          width: "520px",
          maxWidth: "92vw",
          maxHeight: "80vh",
          boxShadow: "0 24px 64px rgba(0,0,0,0.4)",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-4 flex-shrink-0"
          style={{ borderBottom: "1px solid var(--nv-border)" }}
        >
          <div className="min-w-0">
            <h3
              className="text-[14px] font-semibold font-[Geist,sans-serif] leading-snug"
              style={{ color: "var(--nv-text)" }}
            >
              Source folders
            </h3>
            <p
              className="text-[11px] font-[Geist,sans-serif] truncate mt-0.5"
              style={{ color: "var(--nv-text-muted)" }}
              title={brainName}
            >
              {brainName}
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-md flex-shrink-0 transition-colors"
            style={{ color: "var(--nv-text-dim)" }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--nv-text)"; e.currentTarget.style.background = "var(--nv-bg)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--nv-text-dim)"; e.currentTarget.style.background = "transparent"; }}
            title="Close"
            aria-label="Close"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body — scrollable */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">

          {/* Loading / error states */}
          {loadingInit && (
            <p
              className="text-[12px] font-[Geist,sans-serif] text-center py-6"
              style={{ color: "var(--nv-text-muted)" }}
            >
              Loading…
            </p>
          )}

          {!loadingInit && loadError && (
            <p
              className="text-[12px] font-[Geist,sans-serif] px-3 py-2 rounded-lg"
              style={{ color: "var(--nv-negative, #ef4444)", background: "rgba(239,68,68,0.08)" }}
            >
              {loadError}
            </p>
          )}

          {!loadingInit && !loadError && sources.length === 0 && (
            <p
              className="text-[12px] font-[Geist,sans-serif] text-center py-6"
              style={{ color: "var(--nv-text-muted)" }}
            >
              No source folders yet — paste a folder path below to start.
            </p>
          )}

          {/* Source rows */}
          {!loadingInit && !loadError && sources.length > 0 && (
            <ul className="space-y-2" role="list">
              {sources.map((src, idx) => (
                <li
                  key={`${src.path}-${idx}`}
                  className="flex items-start gap-3 rounded-xl px-3 py-2.5"
                  style={{ background: "var(--nv-bg)", border: "1px solid var(--nv-border)" }}
                >
                  {/* Toggle */}
                  <button
                    type="button"
                    onClick={() => handleToggle(idx)}
                    disabled={busy}
                    className="mt-0.5 flex-shrink-0 w-8 h-5 rounded-full relative transition-colors focus:outline-none"
                    style={{
                      background: src.enabled ? "var(--nv-accent)" : "var(--nv-border)",
                      opacity: busy ? 0.5 : 1,
                    }}
                    title={src.enabled ? "Disable this source" : "Enable this source"}
                    aria-label={src.enabled ? "Disable" : "Enable"}
                    aria-pressed={src.enabled}
                  >
                    <span
                      className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full transition-transform"
                      style={{
                        background: "var(--nv-bg)",
                        transform: src.enabled ? "translateX(12px)" : "translateX(0)",
                        boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
                      }}
                    />
                  </button>

                  {/* Path + meta */}
                  <div className="flex-1 min-w-0">
                    <p
                      className="text-[12px] font-mono truncate leading-snug"
                      style={{ color: src.enabled ? "var(--nv-text)" : "var(--nv-text-dim)" }}
                      title={src.path}
                    >
                      {src.path}
                    </p>
                    <p
                      className="text-[10px] font-[Geist,sans-serif] mt-0.5"
                      style={{ color: "var(--nv-text-muted)" }}
                    >
                      {src.file_count} {src.file_count === 1 ? "file" : "files"} · last synced {formatLastSynced(src.last_synced)}
                    </p>
                  </div>

                  {/* Remove */}
                  <button
                    type="button"
                    onClick={() => handleRemove(idx)}
                    disabled={busy}
                    className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-md transition-colors mt-0.5"
                    style={{ color: "var(--nv-text-dim)", opacity: busy ? 0.4 : 1 }}
                    onMouseEnter={(e) => { if (!busy) e.currentTarget.style.color = "var(--nv-negative, #ef4444)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = "var(--nv-text-dim)"; }}
                    title="Remove this source folder"
                    aria-label="Remove"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Add folder path row */}
          {!loadingInit && !loadError && (
            <div className="space-y-1.5">
              <p
                className="text-[11px] uppercase tracking-wider font-medium font-[Geist,sans-serif]"
                style={{ color: "var(--nv-text-dim)" }}
              >
                Add folder path
              </p>
              <div className="flex gap-2">
                <input
                  ref={newPathInputRef}
                  type="text"
                  value={newPath}
                  onChange={(e) => { setNewPath(e.target.value); setAddError(null); }}
                  onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
                  placeholder="Paste an absolute path, e.g. D:\Projects\MyNotes"
                  disabled={busy}
                  className="flex-1 min-w-0 text-[12px] font-mono px-3 py-2 rounded-lg outline-none"
                  style={{
                    background: "var(--nv-bg)",
                    color: "var(--nv-text)",
                    border: `1px solid ${addError ? "var(--nv-negative, #ef4444)" : "var(--nv-border)"}`,
                    opacity: busy ? 0.6 : 1,
                  }}
                  spellCheck={false}
                  autoComplete="off"
                />
                {/* Browse button — available because @tauri-apps/plugin-dialog is in package.json */}
                <button
                  type="button"
                  onClick={handleBrowse}
                  disabled={busy}
                  className="flex-shrink-0 text-[12px] font-[Geist,sans-serif] px-3 py-2 rounded-lg transition-colors"
                  style={{
                    background: "var(--nv-bg)",
                    border: "1px solid var(--nv-border)",
                    color: "var(--nv-text-muted)",
                    opacity: busy ? 0.5 : 1,
                  }}
                  title="Browse for a folder"
                >
                  Browse…
                </button>
                <button
                  type="button"
                  onClick={handleAdd}
                  disabled={busy || !newPath.trim()}
                  className="flex-shrink-0 text-[12px] font-medium font-[Geist,sans-serif] px-3 py-2 rounded-lg transition-colors"
                  style={{
                    background: busy || !newPath.trim() ? "var(--nv-surface)" : "var(--nv-accent)",
                    color: busy || !newPath.trim() ? "var(--nv-text-muted)" : "var(--nv-bg)",
                    border: "1px solid transparent",
                    opacity: busy || !newPath.trim() ? 0.6 : 1,
                  }}
                >
                  Add
                </button>
              </div>
              {addError && (
                <p
                  className="text-[11px] font-[Geist,sans-serif]"
                  style={{ color: "var(--nv-negative, #ef4444)" }}
                >
                  {addError}
                </p>
              )}
            </div>
          )}

          {/* Save error */}
          {saveError && (
            <p
              className="text-[12px] font-[Geist,sans-serif] px-3 py-2 rounded-lg"
              style={{ color: "var(--nv-negative, #ef4444)", background: "rgba(239,68,68,0.08)" }}
            >
              {saveError}
            </p>
          )}

          {/* Sync result */}
          {syncResult && (
            <p
              className="text-[12px] font-[Geist,sans-serif] px-3 py-2 rounded-lg"
              style={{ color: "var(--nv-accent)", background: "var(--nv-accent-glow, rgba(181,146,255,0.08))" }}
            >
              {syncResult}
            </p>
          )}

          {/* Dry-run preview — shows what a sync WOULD do; applies only on confirm */}
          {plan && (
            <div
              className="text-[12px] font-[Geist,sans-serif] px-3 py-3 rounded-lg space-y-2"
              style={{ background: "var(--nv-bg)", border: "1px solid var(--nv-border)" }}
            >
              {planEmpty ? (
                <p style={{ color: "var(--nv-text-muted)" }}>
                  Already in sync — nothing to add, update, or remove.
                </p>
              ) : (
                <>
                  <p style={{ color: "var(--nv-text)" }}>This sync will:</p>
                  <ul className="space-y-0.5 pl-1" style={{ color: "var(--nv-text-muted)" }}>
                    <li>+ add {plan.to_add.length} file{plan.to_add.length === 1 ? "" : "s"}</li>
                    <li>~ update {plan.to_update.length}</li>
                    <li>− remove {plan.to_remove.length}</li>
                    <li>skip {plan.duplicates.length} duplicate{plan.duplicates.length === 1 ? "" : "s"} already in this brain</li>
                    <li style={{ color: "var(--nv-text-dim)" }}>{plan.unchanged} unchanged (untouched)</li>
                  </ul>
                </>
              )}
              <div className="flex items-center gap-2 pt-1">
                {!planEmpty && (
                  <button
                    type="button"
                    onClick={handleApply}
                    disabled={busy}
                    className="text-[12px] font-medium px-3 py-1.5 rounded-lg transition-colors"
                    style={{ background: "var(--nv-accent)", color: "var(--nv-bg)", opacity: busy ? 0.6 : 1 }}
                  >
                    {syncing ? "Applying…" : "Apply"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setPlan(null)}
                  disabled={busy}
                  className="text-[12px] px-3 py-1.5 rounded-lg transition-colors"
                  style={{ color: "var(--nv-text-muted)", opacity: busy ? 0.5 : 1 }}
                >
                  {planEmpty ? "Close" : "Cancel"}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-between gap-3 px-5 py-4 flex-shrink-0"
          style={{ borderTop: "1px solid var(--nv-border)" }}
        >
          <div className="flex items-center gap-2">
          {/* Sync now → runs a dry-run preview first; Apply confirms it */}
          <button
            type="button"
            onClick={handlePreview}
            disabled={busy || loadingInit || !!loadError || plan !== null}
            title="Preview what will change, then confirm"
            className="flex items-center gap-1.5 text-[12px] font-[Geist,sans-serif] px-3 py-2 rounded-lg transition-colors"
            style={{
              background: "var(--nv-bg)",
              border: "1px solid var(--nv-border)",
              color: busy || loadingInit || loadError || plan !== null ? "var(--nv-text-muted)" : "var(--nv-text)",
              opacity: busy || loadingInit || !!loadError || plan !== null ? 0.55 : 1,
            }}
          >
            {previewing ? (
              <>
                <span
                  className="w-3.5 h-3.5 border-2 rounded-full animate-spin flex-shrink-0"
                  style={{ borderColor: "var(--nv-accent)", borderTopColor: "transparent" }}
                />
                Checking…
              </>
            ) : (
              <>
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                </svg>
                Sync now
              </>
            )}
          </button>
          {/* Index code — native graphify (Rust, tree-sitter, no Python) over
              every enabled folder, so who_calls / blast_radius work on it */}
          <button
            type="button"
            onClick={handleIndexCode}
            disabled={busy || loadingInit || !!loadError}
            title="Index source code (functions, types, call edges) into the graph — no Python"
            className="flex items-center gap-1.5 text-[12px] font-[Geist,sans-serif] px-3 py-2 rounded-lg transition-colors"
            style={{
              background: "var(--nv-bg)",
              border: "1px solid var(--nv-border)",
              color: busy || loadingInit || loadError ? "var(--nv-text-muted)" : "var(--nv-text)",
              opacity: busy || loadingInit || !!loadError ? 0.55 : 1,
            }}
          >
            {indexing ? (
              <>
                <span
                  className="w-3.5 h-3.5 border-2 rounded-full animate-spin flex-shrink-0"
                  style={{ borderColor: "var(--nv-accent)", borderTopColor: "transparent" }}
                />
                Indexing…
              </>
            ) : (
              <>
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
                </svg>
                Index code
              </>
            )}
          </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="text-[12px] font-[Geist,sans-serif] px-3 py-2 rounded-lg transition-colors"
              style={{ color: "var(--nv-text-muted)", opacity: busy ? 0.5 : 1 }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={busy || loadingInit || !!loadError}
              className="flex items-center gap-1.5 text-[12px] font-medium font-[Geist,sans-serif] px-4 py-2 rounded-lg transition-colors"
              style={{
                background: busy || loadingInit || loadError ? "var(--nv-surface)" : "var(--nv-accent)",
                color: busy || loadingInit || loadError ? "var(--nv-text-muted)" : "var(--nv-bg)",
                opacity: busy || loadingInit || !!loadError ? 0.6 : 1,
              }}
            >
              {saving ? (
                <>
                  <span
                    className="w-3.5 h-3.5 border-2 rounded-full animate-spin flex-shrink-0"
                    style={{ borderColor: "var(--nv-bg)", borderTopColor: "transparent" }}
                  />
                  Saving…
                </>
              ) : (
                "Save"
              )}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
