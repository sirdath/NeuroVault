import { useEffect, useState } from "react";
import { fetchNote, fetchNotesList } from "../lib/api";
import { useBrainStore } from "../stores/brainStore";
import {
  findEngramIdByFilename,
  resolveSupersession,
  type Supersession,
} from "../lib/supersession";

/**
 * "You are reading a note the brain considers replaced."
 *
 * Recall stops serving a superseded note the moment `supersede_note` runs, but
 * the editor kept opening it silently — so the one reader who could act on the
 * information (the human) was the only one not told. This is a slim, muted,
 * non-modal strip above the editor body: it never blocks the text, never
 * disables editing (the old note is still yours to keep or fix), and offers one
 * click through to the note that replaced it.
 *
 * Dismissal is per note view, deliberately not persisted: reopening a stale
 * note is exactly when the warning is worth repeating.
 */

interface SupersededNoticeProps {
  supersession: Supersession | null;
  onOpen: (filename: string) => void;
  onDismiss: () => void;
}

/** Presentational half — null in, nothing out. */
export function SupersededNotice({ supersession, onOpen, onDismiss }: SupersededNoticeProps) {
  if (!supersession) return null;
  const { title, filename, reason } = supersession;

  return (
    <div
      className="flex shrink-0 items-center gap-3 px-5 py-2"
      style={{
        background: "color-mix(in srgb, var(--nv-warning) 8%, transparent)",
        borderBottom: "1px solid color-mix(in srgb, var(--nv-warning) 25%, transparent)",
      }}
      role="status"
    >
      <span
        className="flex-shrink-0 text-[10px] font-semibold uppercase tracking-wider"
        style={{ color: "var(--nv-warning)" }}
      >
        Superseded
      </span>
      <p className="min-w-0 flex-1 text-[11px] leading-tight" style={{ color: "var(--nv-text-dim)" }}>
        Replaced by{" "}
        {filename ? (
          <button
            type="button"
            onClick={() => onOpen(filename)}
            className="rounded font-semibold underline underline-offset-2"
            style={{ color: "var(--nv-text)" }}
          >
            {title}
          </button>
        ) : (
          <span className="font-semibold" style={{ color: "var(--nv-text)" }}>
            {title}
          </span>
        )}
        {reason ? ` — ${reason}` : ""}
      </p>
      <button
        type="button"
        onClick={onDismiss}
        className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-[13px] leading-none"
        style={{ color: "var(--nv-text-muted)" }}
        aria-label="Dismiss superseded notice"
      >
        ×
      </button>
    </div>
  );
}

interface SupersededBannerProps {
  /** The note on screen. Null (nothing open) renders nothing. */
  filename: string | null;
  onOpen: (filename: string) => void;
}

/**
 * Container half: resolves the active note's supersession from the vault index.
 *
 * Two reads, both cheap and both already used elsewhere: the note list (to map
 * filename → engram id, and the newer id back to a title/filename) and the note
 * detail (which carries `superseded_by` / `superseded_reason` because
 * `get_note` selects the whole engram row). Failures stay silent — with the
 * backend down, no banner is the honest answer, and a toast per note open would
 * be noise.
 */
export function SupersededBanner({ filename, onOpen }: SupersededBannerProps) {
  const brainId = useBrainStore((state) => state.activeBrainId);
  const [supersession, setSupersession] = useState<Supersession | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Clear first: a stale banner surviving into the next note (or the next
    // brain) would attach one note's warning to another note's text.
    setSupersession(null);
    setDismissed(false);
    if (!filename) return;

    let cancelled = false;
    void (async () => {
      try {
        const notes = await fetchNotesList(brainId ?? undefined);
        const engramId = findEngramIdByFilename(notes, filename);
        if (cancelled || !engramId) return;
        const detail = await fetchNote(engramId, brainId ?? undefined);
        if (cancelled) return;
        setSupersession(resolveSupersession(detail, notes));
      } catch {
        // Backend offline or note not indexed yet — stay quiet.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filename, brainId]);

  return (
    <SupersededNotice
      supersession={dismissed ? null : supersession}
      onOpen={onOpen}
      onDismiss={() => setDismissed(true)}
    />
  );
}
