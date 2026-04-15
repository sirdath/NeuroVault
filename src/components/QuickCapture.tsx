import { useEffect, useRef, useState, useCallback } from "react";
import * as tauri from "../lib/tauri";
import { useNoteStore } from "../stores/noteStore";
import { toast } from "../stores/toastStore";

interface QuickCaptureProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Frictionless inbox capture — the feature most likely to make people pick
 * NeuroVault over Bear. Press Ctrl/Cmd + Shift + Space anywhere in the app,
 * type a thought, hit Ctrl/Cmd + Enter. The note is saved silently without
 * stealing focus from whatever you were doing. No view switch, no toast
 * spam, no navigation jump — the point is to NOT interrupt.
 *
 * Title extraction: first line (up to 80 chars), stripped of leading `#`s.
 * If the whole capture is one line, title = body. Saved as a regular vault
 * note so it auto-ingests through the same pipeline as everything else.
 */
export function QuickCapture({ open, onClose }: QuickCaptureProps) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const loadNotes = useNoteStore((s) => s.loadNotes);

  // Reset + focus on open
  useEffect(() => {
    if (open) {
      setText("");
      setSaving(false);
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [open]);

  const save = useCallback(async () => {
    const body = text.trim();
    if (!body || saving) return;

    // First non-empty line becomes the title. Strip markdown heading markers.
    const firstLine = body.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
    const title = firstLine.replace(/^#+\s*/, "").slice(0, 80).trim() || "Quick capture";

    setSaving(true);
    try {
      // Create the note (title-only stub), then write the full body back.
      const filename = await tauri.createNote(title);
      await tauri.saveNote(filename, `# ${title}\n\n${body}`);
      await loadNotes();
      toast.success(`Captured: ${title}`);
      onClose();
    } catch (e) {
      console.error("[neurovault] quick-capture failed:", e);
      toast.error("Quick capture failed");
      setSaving(false);
    }
  }, [text, saving, loadNotes, onClose]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void save();
      }
    },
    [save, onClose],
  );

  if (!open) return null;

  const charCount = text.length;
  const lineCount = text.split(/\r?\n/).length;

  return (
    <>
      <div
        className="fixed inset-0 bg-black/60 z-50 fade-in"
        onClick={onClose}
      />

      <div
        className="fixed top-[20vh] left-1/2 -translate-x-1/2 w-[560px] max-w-[90vw] rounded-lg shadow-2xl z-50 flex flex-col overflow-hidden fade-in"
        style={{
          backgroundColor: "var(--color-bg)",
          borderWidth: "1px",
          borderStyle: "solid",
          borderColor: "var(--color-border-strong)",
        }}
      >
        {/* Header */}
        <div
          className="px-4 py-2 flex items-center gap-3"
          style={{ borderBottom: "1px solid var(--color-border)" }}
        >
          <span
            className="text-[10px] uppercase tracking-wider font-semibold font-[Geist,sans-serif]"
            style={{ color: "var(--color-amber)" }}
          >
            Quick Capture
          </span>
          <span
            className="text-[10px] font-[Geist,sans-serif]"
            style={{ color: "var(--color-tertiary)" }}
          >
            First line becomes the title
          </span>
        </div>

        {/* Input */}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type anything — a thought, a fact, a link, a task…"
          rows={6}
          className="w-full px-4 py-3 bg-transparent font-[Lora,Georgia,serif] text-[15px] leading-relaxed resize-none focus:outline-none"
          style={{
            color: "var(--color-txt)",
            minHeight: "140px",
          }}
          disabled={saving}
        />

        {/* Footer */}
        <div
          className="px-4 py-2 flex items-center justify-between text-[10px] font-[Geist,sans-serif]"
          style={{
            borderTop: "1px solid var(--color-border)",
            color: "var(--color-tertiary)",
          }}
        >
          <div className="flex gap-3">
            <span>
              <kbd>⌘↵</kbd> save
            </span>
            <span>
              <kbd>esc</kbd> cancel
            </span>
          </div>
          <span>
            {charCount} chars · {lineCount} {lineCount === 1 ? "line" : "lines"}
            {saving && " · saving…"}
          </span>
        </div>
      </div>
    </>
  );
}
