/**
 * Live Preview extension for CodeMirror 6 - Obsidian-style.
 *
 * Walks the markdown syntax tree and conceals the raw syntax marks
 * (`#`, `**`, `*`, `` ` ``, `~~`, `>`) on every line EXCEPT the one(s) the
 * cursor is on. The moment you click into a line, that line's markers
 * reappear so you can edit them; every other line stays formatted.
 *
 * Formatting itself (bold, italic, heading size/colour) comes from the
 * theme's highlightStyle - this plugin only hides the punctuation, so a note
 * reads as a formatted document while remaining a single, always-live editor
 * (no preview/edit toggle).
 */

import {
  EditorView,
  Decoration,
  DecorationSet,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

// Syntax-only node names whose text is pure markdown punctuation to conceal.
// (Node names come from @lezer/markdown, GFM enabled.)
const MARK_NODES = new Set<string>([
  "HeaderMark", // # ## ### ...
  "EmphasisMark", // * or _  (italic, plus the pair around **bold**)
  "CodeMark", // ` inline code / ``` fences
  "StrikethroughMark", // ~~
  "QuoteMark", // >
]);

// A replace decoration with no widget collapses its range to zero width.
const conceal = Decoration.replace({});

/** The set of line numbers the selection touches - these stay raw ("editing"). */
function activeLineNumbers(view: EditorView): Set<number> {
  const lines = new Set<number>();
  const { doc } = view.state;
  for (const range of view.state.selection.ranges) {
    const first = doc.lineAt(range.from).number;
    const last = doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) lines.add(n);
  }
  return lines;
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const active = activeLineNumbers(view);
  const { doc } = view.state;
  const tree = syntaxTree(view.state);

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (!MARK_NODES.has(node.name)) return;
        const start = node.from;
        let end = node.to;
        if (start >= end) return;

        const line = doc.lineAt(start);
        // On the active line(s) reveal everything - this is the line you edit.
        if (active.has(line.number)) return;

        // Eat the single space after a `#` or `>` so content isn't indented.
        if (node.name === "HeaderMark" || node.name === "QuoteMark") {
          if (end < line.to && doc.sliceString(end, end + 1) === " ") end += 1;
        }
        builder.add(start, end, conceal);
      },
    });
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
      // Recompute when the doc changes, the viewport scrolls, or the cursor
      // moves (moving the cursor is what reveals / re-hides a line's marks).
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

/**
 * Kept as a named export so the editor's extension list is unchanged. The
 * heavy lifting (bold / italic / heading styles) lives in the theme's
 * highlightStyle; this base theme only gives headings a little breathing room.
 */
export const livePreviewTheme = EditorView.baseTheme({
  ".cm-content": { caretColor: "var(--nv-accent, #568cfa)" },
});
