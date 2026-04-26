import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** A single item in a context menu. */
export interface ContextMenuItem {
  label: string;
  /** Optional left-side icon — small SVG element, ~12-14px. */
  icon?: React.ReactNode;
  /** Optional right-side hint (e.g. shortcut like "Ctrl+Enter"). */
  hint?: string;
  /** What to do when the item is selected. The menu auto-closes after. */
  onSelect: () => void;
  /** Renders the item in red — for destructive actions like Delete. */
  destructive?: boolean;
  disabled?: boolean;
}

export type ContextMenuEntry = ContextMenuItem | { divider: true };

/** Opens at a viewport coordinate. The caller produces these from an
 *  `onContextMenu(e)` handler (e.preventDefault first). The menu clamps
 *  itself to the viewport so it never overflows on right edges or
 *  bottom corners — important for long folder names + tall menus. */
export interface ContextMenuProps {
  open: boolean;
  x: number;
  y: number;
  items: ContextMenuEntry[];
  onClose: () => void;
}

/** Floating right-click menu. Built minimal because we don't have a
 *  popover library and one is overkill for this surface — the only
 *  consumer today is the sidebar note row. Visual language matches
 *  ConfirmDialog so the dialog system feels coherent.
 *
 *  Closes on:
 *    - any click outside the menu (mousedown handler on window)
 *    - Escape
 *    - window blur, scroll, or resize (anything that would orphan the
 *      menu from its anchor)
 *
 *  Keyboard navigation:
 *    - Up / Down move selection
 *    - Enter activates the selected item
 *    - Escape closes
 *
 *  Avoids:
 *    - Portals — the menu is high z-index (z-50, same tier as
 *      ConfirmDialog) so it reliably sits above the sidebar virtualiser.
 *    - Animations beyond a 100ms fade — context menus that animate slowly
 *      feel laggy, not premium.
 */
export function ContextMenu({ open, x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });
  const [hoverIndex, setHoverIndex] = useState(-1);

  // Resolve real items (skip dividers) for keyboard nav.
  const realItems = items.filter((i): i is ContextMenuItem => !("divider" in i));

  // Clamp to viewport AFTER initial render — we need the actual menu
  // dimensions, which are only known once it's in the DOM.
  useLayoutEffect(() => {
    if (!open) return;
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 6;
    let left = x;
    let top = y;
    if (left + rect.width + margin > window.innerWidth) {
      left = Math.max(margin, window.innerWidth - rect.width - margin);
    }
    if (top + rect.height + margin > window.innerHeight) {
      top = Math.max(margin, window.innerHeight - rect.height - margin);
    }
    setPos({ left, top });
  }, [open, x, y, items.length]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHoverIndex((i) => Math.min(realItems.length - 1, i + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHoverIndex((i) => Math.max(0, i - 1));
      } else if (e.key === "Enter" && hoverIndex >= 0) {
        e.preventDefault();
        const item = realItems[hoverIndex];
        if (item && !item.disabled) {
          item.onSelect();
          onClose();
        }
      }
    };
    const onScroll = () => onClose();
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, realItems, hoverIndex, onClose]);

  useEffect(() => {
    if (open) setHoverIndex(-1);
  }, [open]);

  if (!open) return null;

  return (
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-50 min-w-[200px] rounded-lg shadow-2xl py-1 fade-in"
      style={{
        left: pos.left,
        top: pos.top,
        background: "var(--nv-surface)",
        border: "1px solid var(--nv-border)",
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((entry, i) => {
        if ("divider" in entry) {
          return (
            <div
              key={`d-${i}`}
              className="my-1 mx-2 h-px"
              style={{ background: "var(--nv-border)" }}
            />
          );
        }
        const realIdx = items
          .slice(0, i + 1)
          .filter((x) => !("divider" in x)).length - 1;
        const hovered = realIdx === hoverIndex;
        return (
          <button
            key={entry.label}
            role="menuitem"
            disabled={entry.disabled}
            onClick={() => {
              if (entry.disabled) return;
              entry.onSelect();
              onClose();
            }}
            onMouseEnter={() => setHoverIndex(realIdx)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-[13px] font-[Geist,sans-serif] text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              color: entry.destructive
                ? "var(--nv-negative, #e84545)"
                : "var(--nv-text)",
              background: hovered && !entry.disabled
                ? "var(--nv-surface-elevated, rgba(255,255,255,0.04))"
                : "transparent",
            }}
          >
            {entry.icon && (
              <span
                className="w-4 h-4 flex items-center justify-center flex-shrink-0"
                style={{
                  color: entry.destructive
                    ? "var(--nv-negative, #e84545)"
                    : "var(--nv-text-muted)",
                }}
              >
                {entry.icon}
              </span>
            )}
            <span className="flex-1 truncate">{entry.label}</span>
            {entry.hint && (
              <span
                className="ml-2 text-[11px] tabular-nums flex-shrink-0"
                style={{ color: "var(--nv-text-muted)" }}
              >
                {entry.hint}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
