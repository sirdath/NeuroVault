import { useEffect, useRef, useState } from "react";
import { useHoverPreviewStore } from "../stores/hoverPreviewStore";
import { useNoteStore } from "../stores/noteStore";
import * as tauri from "../lib/tauri";

const CARD_WIDTH = 360;
const CARD_MAX_HEIGHT = 260;
const GAP = 8;
const PREVIEW_CHARS = 320;

// Process-scoped cache. Reading a markdown file off disk is fast, but
// doing it on every hover still jitters. Once we've fetched a preview for
// a filename we keep it in memory for the session. ~500 notes × 320 chars
// is ~160kb — a non-issue.
const previewCache = new Map<string, string>();

/**
 * Floating hover card for wiki-links and graph nodes.
 *
 * Subscribes to the singleton HoverPreviewStore. When a filename is set,
 * positions itself near the anchor rect, lazy-fetches the note body via
 * Tauri, and shows the first ~320 chars stripped of front-matter and the
 * leading H1. Its own mouseenter/leave keeps the card alive so the user
 * can actually click into it without it disappearing.
 */
export function HoverPreview() {
  const filename = useHoverPreviewStore((s) => s.filename);
  const anchor = useHoverPreviewStore((s) => s.anchor);
  const hide = useHoverPreviewStore((s) => s.hide);
  const show = useHoverPreviewStore((s) => s.show);
  const notes = useNoteStore((s) => s.notes);
  const selectNote = useNoteStore((s) => s.selectNote);

  const [preview, setPreview] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  // Resolve filename -> title/metadata from the note store (for kind/state)
  const meta = filename ? notes.find((n) => n.filename === filename) : null;

  useEffect(() => {
    if (!filename) {
      setPreview("");
      setLoading(false);
      return;
    }

    const cached = previewCache.get(filename);
    if (cached !== undefined) {
      setPreview(cached);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setPreview("");
    tauri
      .readNote(filename)
      .then((content) => {
        if (cancelled) return;
        const cleaned = stripFrontmatterAndHeading(content).slice(0, PREVIEW_CHARS);
        previewCache.set(filename, cleaned);
        setPreview(cleaned);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setPreview("");
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [filename]);

  if (!filename || !anchor) return null;

  // Position: prefer below the anchor, flip above if it'd overflow the
  // viewport. Horizontally clamp so the card doesn't run off-screen.
  const viewportH = window.innerHeight;
  const viewportW = window.innerWidth;
  const below = anchor.bottom + GAP + CARD_MAX_HEIGHT < viewportH;
  const top = below ? anchor.bottom + GAP : Math.max(GAP, anchor.top - CARD_MAX_HEIGHT - GAP);
  const rawLeft = anchor.left;
  const left = Math.min(Math.max(GAP, rawLeft), viewportW - CARD_WIDTH - GAP);

  const title = meta?.title ?? filename.replace(/\.md$/, "");

  const handleClick = () => {
    void selectNote(filename);
    hide();
  };

  return (
    <div
      ref={cardRef}
      onMouseEnter={() => show(filename, anchor)}
      onMouseLeave={hide}
      onClick={handleClick}
      className="fixed z-[60] rounded-lg shadow-2xl fade-in cursor-pointer"
      style={{
        top,
        left,
        width: CARD_WIDTH,
        maxHeight: CARD_MAX_HEIGHT,
        backgroundColor: "var(--color-surface-elevated)",
        borderWidth: "1px",
        borderStyle: "solid",
        borderColor: "var(--color-border-strong)",
      }}
    >
      {/* Header */}
      <div
        className="px-4 py-2.5"
        style={{ borderBottom: "1px solid var(--color-border)" }}
      >
        <div
          className="text-[13px] font-semibold font-[Geist,sans-serif] truncate"
          style={{ color: "var(--color-txt)" }}
        >
          {title}
        </div>
      </div>

      {/* Body */}
      <div
        className="px-4 py-3 overflow-hidden font-[Lora,Georgia,serif]"
        style={{
          color: "var(--color-sub)",
          fontSize: "12.5px",
          lineHeight: "1.55",
          maxHeight: CARD_MAX_HEIGHT - 60,
        }}
      >
        {loading && (
          <span style={{ color: "var(--color-tertiary)" }} className="italic">
            Loading…
          </span>
        )}
        {!loading && preview && (
          <div className="line-clamp-[8]">{preview}</div>
        )}
        {!loading && !preview && meta && (
          <span style={{ color: "var(--color-tertiary)" }} className="italic">
            Empty note
          </span>
        )}
        {!loading && !meta && (
          <span style={{ color: "var(--color-tertiary)" }} className="italic">
            Not in vault
          </span>
        )}
      </div>

      {/* Footer hint */}
      <div
        className="px-4 py-1.5 text-[10px] font-[Geist,sans-serif] flex items-center justify-between"
        style={{
          borderTop: "1px solid var(--color-border)",
          color: "var(--color-tertiary)",
        }}
      >
        <span>Click to open</span>
        {meta && <span>{filename}</span>}
      </div>
    </div>
  );
}

/**
 * Remove YAML front matter and the first heading so the preview shows the
 * actual body content, not repeated title chrome. Collapses runs of blank
 * lines to keep the snippet dense.
 */
function stripFrontmatterAndHeading(content: string): string {
  let out = content;
  if (out.startsWith("---")) {
    const end = out.indexOf("\n---", 3);
    if (end !== -1) out = out.slice(end + 4);
  }
  // Drop the leading H1 if present (we already show the title in the header)
  out = out.replace(/^\s*#\s+[^\n]+\n/, "");
  // Collapse blank-line runs
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}
