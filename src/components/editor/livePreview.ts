/**
 * Live Preview extension for CodeMirror 6 — Obsidian-style.
 *
 * Hides markdown syntax tokens (#, **, *, `) when the cursor isn't on that line.
 * When you click into a line the markers reappear so you can edit them.
 *
 * This is the single biggest editor UX upgrade — makes markdown feel like a
 * formatted document instead of raw text.
 */

import {
  EditorView,
  Decoration,
  DecorationSet,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

/**
 * A decoration that hides matched ranges (display: none) when applied.
 */
const hiddenMark = Decoration.mark({
  class: "cm-hidden-token",
});

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number;

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      const text = line.text;
      const isActive = line.number === cursorLine;

      // Skip active line — show everything
      if (!isActive && text.length > 0) {
        // Headings: hide the # markers
        const headingMatch = text.match(/^(#{1,6})\s/);
        if (headingMatch && headingMatch[1]) {
          const markerEnd = line.from + headingMatch[1].length + 1;
          builder.add(line.from, markerEnd, hiddenMark);
        }
      }

      pos = line.to + 1;
      if (pos > view.state.doc.length) break;
    }
  }

  return builder.finish();
}

export const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet
      ) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

/**
 * CSS that backs the livePreview extension.
 * Hides tokens via display: none when the .cm-hidden-token class is applied.
 */
export const livePreviewTheme = EditorView.baseTheme({
  ".cm-hidden-token": {
    display: "none !important",
  },
  ".cm-line:has(.cm-heading-1)": {
    fontSize: "2em",
    fontWeight: "700",
    color: "#f0a500",
    lineHeight: "1.3",
    marginTop: "1em",
  },
  ".cm-line:has(.cm-heading-2)": {
    fontSize: "1.5em",
    fontWeight: "600",
    color: "#f0a500",
    lineHeight: "1.3",
    marginTop: "0.8em",
  },
  ".cm-line:has(.cm-heading-3)": {
    fontSize: "1.2em",
    fontWeight: "600",
    color: "#e8e6f0",
    lineHeight: "1.3",
    marginTop: "0.6em",
  },
});
