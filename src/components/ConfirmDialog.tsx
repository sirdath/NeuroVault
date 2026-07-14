import { useEffect, useId, useRef } from "react";

/** Styled in-app confirmation dialog — the replacement for
 *  `window.confirm()`.
 *
 *  Why not `window.confirm`: it's a native OS popup with tiny buttons
 *  close together, `Enter` defaults to OK, and you can dismiss it by
 *  fat-fingering `Space`. None of that is what you want when the
 *  action is destructive. This dialog:
 *
 *    - Is visually tied to the rest of the app (same tokens + fonts).
 *    - Puts the destructive action in a clearly-red button, offset
 *      from the safe cancel button.
 *    - Requires an explicit mouse click (or `Enter`) on the confirm
 *      button — clicking outside the dialog or pressing `Esc` cancels.
 *    - Focuses the Cancel button by default, not the Delete button,
 *      so an accidental `Enter` press is safe.
 *
 *  Generic — takes title/message/confirm-label as props so the same
 *  component works for "delete note", "delete brain", "reset core
 *  memory", etc. Destructive styling is opt-in via `destructive`
 *  prop so non-destructive confirms can use the same component with
 *  a neutral accent. */
interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  destructive = true,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // Focus the Cancel button on open so accidental Enter doesn't
  // trigger a destructive action.
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return;

    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const id = window.setTimeout(() => cancelRef.current?.focus(), 0);

    return () => {
      window.clearTimeout(id);
      previouslyFocusedRef.current?.focus();
      previouslyFocusedRef.current = null;
    };
  }, [open]);

  // Esc cancels. Tab is kept inside the modal so keyboard and VoiceOver
  // users cannot accidentally move into controls hidden behind it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key !== "Tab") return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((node) => node.getAttribute("aria-hidden") !== "true");
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        e.preventDefault();
        dialog.focus();
        return;
      }

      const active = document.activeElement;
      if (e.shiftKey && (active === first || !dialog.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !dialog.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "var(--nv-overlay)" }}
      onMouseDown={(e) => {
        // Click on the backdrop (not the dialog body) cancels.
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="w-[420px] max-w-[90vw] rounded-xl shadow-2xl p-5"
        style={{
          background: "var(--nv-surface)",
          border: "1px solid var(--nv-border)",
        }}
        role={destructive ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <h2
          id={titleId}
          className="text-base font-semibold font-[Geist,sans-serif] mb-2"
          style={{ color: "var(--nv-text)" }}
        >
          {title}
        </h2>
        <p
          id={descriptionId}
          className="text-[13px] leading-relaxed font-[Geist,sans-serif] mb-5"
          style={{ color: "var(--nv-text-muted)" }}
        >
          {message}
        </p>
        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            onClick={onCancel}
            className="px-3 py-1.5 text-[12px] font-medium font-[Geist,sans-serif] rounded-md transition-colors"
            style={{
              background: "var(--nv-surface-elevated, var(--nv-surface))",
              color: "var(--nv-text)",
              border: "1px solid var(--nv-border)",
            }}
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className="px-3 py-1.5 text-[12px] font-medium font-[Geist,sans-serif] rounded-md transition-colors"
            style={{
              background: destructive ? "var(--nv-negative, #e84545)" : "var(--nv-accent)",
              color: destructive ? "white" : "var(--nv-bg)",
              border: "1px solid transparent",
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
