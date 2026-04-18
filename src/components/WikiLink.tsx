import type { ReactNode, MouseEvent } from "react";
import { useHoverPreview } from "../hooks/useHoverPreview";

interface WikiLinkProps {
  title: string;
  filename: string | null;
  onClick: (e: MouseEvent<HTMLAnchorElement>) => void;
  children: ReactNode;
}

/**
 * A rendered [[wiki-link]] with hover-preview. Small wrapper so the
 * hook's event handlers attach cleanly. When `filename` is null (the
 * target doesn't exist in the vault yet) the link still renders but
 * hover is inert — there's nothing to preview.
 */
export function WikiLink({ title: _title, filename, onClick, children }: WikiLinkProps) {
  const hover = useHoverPreview(filename);
  return (
    <a
      href="#"
      onClick={onClick}
      onMouseEnter={hover.onMouseEnter}
      onMouseLeave={hover.onMouseLeave}
      className={
        filename
          ? "[color:var(--nv-accent)] hover:brightness-125 underline decoration-dotted cursor-pointer transition-all"
          : "[color:var(--nv-accent)] opacity-60 underline decoration-dotted decoration-wavy cursor-help"
      }
    >
      {children}
    </a>
  );
}
