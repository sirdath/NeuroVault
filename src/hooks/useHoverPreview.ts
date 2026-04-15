import { useCallback, useRef } from "react";
import { useHoverPreviewStore } from "../stores/hoverPreviewStore";
import { useNoteStore } from "../stores/noteStore";

const ENTER_DELAY_MS = 250;
const LEAVE_GRACE_MS = 120;

/**
 * Returns mouseenter/mouseleave handlers that trigger a delayed hover card
 * on the shared HoverPreviewStore. Pass the filename you want previewed;
 * the singleton `<HoverPreview />` at the root handles positioning and
 * lazy content load.
 *
 * Delay tuning:
 *   ENTER_DELAY  250ms  — Obsidian / Linear / Arc all use ~200-300ms.
 *                         Shorter feels jumpy, longer feels unresponsive.
 *   LEAVE_GRACE  120ms  — lets users slide the cursor from the link onto
 *                         the card without the card disappearing.
 */
export function useHoverPreview(filename: string | null | undefined) {
  const show = useHoverPreviewStore((s) => s.show);
  const hide = useHoverPreviewStore((s) => s.hide);
  const enterTimer = useRef<number | null>(null);
  const leaveTimer = useRef<number | null>(null);

  const onMouseEnter = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      if (!filename) return;
      if (leaveTimer.current != null) {
        clearTimeout(leaveTimer.current);
        leaveTimer.current = null;
      }
      const rect = e.currentTarget.getBoundingClientRect();
      if (enterTimer.current != null) clearTimeout(enterTimer.current);
      enterTimer.current = window.setTimeout(() => {
        show(filename, rect);
        enterTimer.current = null;
      }, ENTER_DELAY_MS);
    },
    [filename, show],
  );

  const onMouseLeave = useCallback(() => {
    if (enterTimer.current != null) {
      clearTimeout(enterTimer.current);
      enterTimer.current = null;
    }
    if (leaveTimer.current != null) clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => {
      hide();
      leaveTimer.current = null;
    }, LEAVE_GRACE_MS);
  }, [hide]);

  return { onMouseEnter, onMouseLeave };
}

/**
 * Convenience wrapper for call sites that only have a note *title* (e.g.
 * backlinks, working memory, unlinked mentions) instead of a filename.
 * Resolves the title via the note store and falls back to an inert hover
 * if the target isn't in the vault yet.
 */
export function useTitleHoverPreview(title: string | null | undefined) {
  const notes = useNoteStore((s) => s.notes);
  const match = title
    ? notes.find((n) => n.title.toLowerCase() === title.toLowerCase())
    : undefined;
  return useHoverPreview(match?.filename ?? null);
}
