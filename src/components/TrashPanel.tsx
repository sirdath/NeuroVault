import { useEffect, useRef, useState } from "react";
import { listTrash, restoreNote, type TrashEntry } from "../lib/tauri";
import { useBrainStore } from "../stores/brainStore";
import { useNoteStore } from "../stores/noteStore";
import { toast } from "../stores/toastStore";

interface TrashPanelProps {
  open: boolean;
  onClose: () => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export function TrashPanel({ open, onClose }: TrashPanelProps) {
  const activeBrainId = useBrainStore((state) => state.activeBrainId);
  const loadNotes = useNoteStore((state) => state.loadNotes);
  const [items, setItems] = useState<TrashEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const load = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try { setItems(await listTrash(activeBrainId)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn't open Trash"); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    if (!open) return;
    void load();
    const focusTimer = window.setTimeout(() => closeRef.current?.focus(), 0);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !restoring) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", onKey);
    };
  // Opening or changing vault must refresh; `restoring` intentionally does
  // not restart this lifecycle while a button is in flight.
  }, [open, activeBrainId, onClose]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  const handleRestore = async (item: TrashEntry): Promise<void> => {
    if (restoring) return;
    setRestoring(item.trashed_filename);
    setError(null);
    try {
      const result = await restoreNote(item.trashed_filename, activeBrainId);
      setItems((current) => current.filter((candidate) => candidate.trashed_filename !== item.trashed_filename));
      await loadNotes();
      toast.success(`Restored “${item.title}” to ${result.filename}`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Couldn't restore this note";
      setError(message);
      toast.error(message);
    } finally {
      setRestoring(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center p-6"
      style={{ background: "rgba(0,0,0,0.58)", backdropFilter: "blur(5px)" }}
      onMouseDown={(event) => { if (event.target === event.currentTarget && !restoring) onClose(); }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="trash-title"
        className="flex max-h-[76vh] w-[620px] max-w-[94vw] flex-col overflow-hidden rounded-2xl"
        style={{ background: "var(--nv-bg)", border: "1px solid var(--nv-border)", boxShadow: "0 24px 70px rgba(0,0,0,0.45)" }}
      >
        <header className="flex items-start justify-between gap-4 px-5 py-4" style={{ borderBottom: "1px solid var(--nv-border)" }}>
          <div>
            <h2 id="trash-title" className="text-[15px] font-semibold" style={{ color: "var(--nv-text)" }}>Trash</h2>
            <p className="mt-1 text-xs" style={{ color: "var(--nv-text-muted)" }}>
              Deleted Markdown stays recoverable here. Restoring also rebuilds its searchable memory.
            </p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} disabled={!!restoring} className="h-8 w-8 rounded-lg" aria-label="Close Trash" style={{ color: "var(--nv-text-muted)" }}>×</button>
        </header>

        <div className="flex-1 overflow-y-auto p-4">
          {loading && <p role="status" className="py-10 text-center text-sm" style={{ color: "var(--nv-text-muted)" }}>Opening Trash…</p>}
          {!loading && error && (
            <div role="alert" className="rounded-xl p-4 text-sm" style={{ color: "var(--nv-negative)", border: "1px solid color-mix(in srgb, var(--nv-negative) 35%, transparent)" }}>
              <p>{error}</p>
              <button type="button" onClick={() => void load()} className="mt-3 rounded-lg px-3 py-1.5 text-xs" style={{ border: "1px solid var(--nv-border)", color: "var(--nv-text)" }}>Try again</button>
            </div>
          )}
          {!loading && !error && items.length === 0 && (
            <div className="py-12 text-center">
              <p className="text-sm font-medium" style={{ color: "var(--nv-text)" }}>Trash is empty</p>
              <p className="mt-1 text-xs" style={{ color: "var(--nv-text-muted)" }}>Notes you move to Trash will appear here.</p>
            </div>
          )}
          {!loading && items.length > 0 && (
            <ul className="space-y-2">
              {items.map((item) => (
                <li key={item.trashed_filename} className="flex items-center gap-4 rounded-xl px-4 py-3" style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)" }}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium" style={{ color: "var(--nv-text)" }}>{item.title}</p>
                    <p className="mt-1 truncate text-[11px]" title={item.original_filename} style={{ color: "var(--nv-text-muted)" }}>
                      {item.original_filename} · {formatSize(item.size)} · deleted {new Date(item.deleted_at * 1_000).toLocaleString()}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleRestore(item)}
                    disabled={!!restoring}
                    className="rounded-lg px-3 py-1.5 text-xs font-semibold"
                    style={{ background: "var(--nv-accent)", color: "var(--nv-bg)", opacity: restoring && restoring !== item.trashed_filename ? 0.45 : 1 }}
                  >
                    {restoring === item.trashed_filename ? "Restoring…" : "Restore"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
