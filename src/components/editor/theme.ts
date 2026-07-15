import { EditorView } from "@codemirror/view";
import { type Extension } from "@codemirror/state";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

const c = {
  bg: "var(--nv-bg)",
  surface: "var(--nv-surface)",
  raised: "var(--nv-surface-elevated)",
  border: "var(--nv-border)",
  accent: "var(--nv-accent)",
  teal: "#3c9fa0",
  purple: "#7767df",
  negative: "var(--nv-negative)",
  positive: "var(--nv-positive)",
  text: "var(--nv-text)",
  muted: "var(--nv-text-muted)",
  dim: "var(--nv-text-dim)",
};

export type EditorFontSize = "small" | "medium" | "large";

const EDITOR_FONT_SIZE: Record<EditorFontSize, string> = {
  small: "15.5px",
  medium: "17px",
  large: "19px",
};

function editorTheme(dark: boolean, fontSize: EditorFontSize): Extension {
  return EditorView.theme(
    {
      "&": {
        backgroundColor: c.bg,
        color: c.text,
        fontFamily: "'New York', 'Iowan Old Style', Charter, Georgia, serif",
        fontSize: EDITOR_FONT_SIZE[fontSize],
        lineHeight: "1.72",
      },
      ".cm-content": {
        caretColor: c.accent,
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: c.accent,
        borderLeftWidth: "2px",
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: "color-mix(in srgb, var(--nv-accent) 18%, transparent)",
      },
      ".cm-panels": {
        backgroundColor: c.surface,
        color: c.text,
      },
      ".cm-panels.cm-panels-top": { borderBottom: `1px solid ${c.border}` },
      ".cm-panels.cm-panels-bottom": { borderTop: `1px solid ${c.border}` },
      ".cm-searchMatch": {
        backgroundColor: "color-mix(in srgb, var(--nv-accent) 22%, transparent)",
        outline: `1px solid ${c.accent}`,
      },
      ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: "color-mix(in srgb, var(--nv-accent) 34%, transparent)",
      },
      ".cm-activeLine": {
        backgroundColor: "color-mix(in srgb, var(--nv-accent) 3.5%, transparent)",
      },
      ".cm-selectionMatch": {
        backgroundColor: "color-mix(in srgb, #7767df 14%, transparent)",
      },
      "&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket": {
        backgroundColor: "color-mix(in srgb, #3c9fa0 20%, transparent)",
        outline: "none",
      },
      ".cm-gutters": {
        backgroundColor: "transparent",
        color: c.dim,
        border: "none",
      },
      ".cm-activeLineGutter": { backgroundColor: "transparent", color: c.muted },
      ".cm-foldPlaceholder": { backgroundColor: c.raised, border: "none", color: c.muted },
      ".cm-tooltip": {
        backgroundColor: c.raised,
        color: c.text,
        border: `1px solid ${c.border}`,
        borderRadius: "10px",
        boxShadow: "var(--nv-shadow)",
        overflow: "hidden",
      },
      ".cm-tooltip .cm-tooltip-arrow:before": {
        borderTopColor: "transparent",
        borderBottomColor: "transparent",
      },
      ".cm-tooltip-autocomplete": {
        "& > ul > li[aria-selected]": {
          backgroundColor: c.surface,
          color: c.text,
        },
      },
      ".cm-scroller": {
        scrollbarWidth: "thin",
        scrollbarColor: `${c.dim} transparent`,
      },
    },
    { dark },
  );
}

const highlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: c.purple },
  { tag: [t.name, t.deleted, t.character, t.macroName], color: c.text },
  { tag: [t.function(t.variableName), t.labelName], color: c.teal },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: c.accent },
  { tag: [t.definition(t.name), t.separator], color: c.text },
  { tag: [t.typeName, t.className, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: c.purple },
  { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.special(t.string)], color: c.teal },
  { tag: [t.meta, t.comment], color: c.muted, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "700", color: c.text },
  { tag: t.emphasis, fontStyle: "italic", color: c.text },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: c.accent, textDecoration: "underline" },
  { tag: t.heading1, fontWeight: "700", fontSize: "2.08em", color: c.text },
  { tag: t.heading2, fontWeight: "700", fontSize: "1.55em", color: c.text },
  { tag: t.heading3, fontWeight: "650", fontSize: "1.24em", color: c.text },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: c.accent },
  { tag: [t.processingInstruction, t.string, t.inserted], color: c.positive },
  { tag: t.invalid, color: c.negative },
  {
    tag: t.monospace,
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: "0.88em",
    color: c.purple,
  },
]);

const syntaxTheme = syntaxHighlighting(highlightStyle);

export function neurovaultEditorTheme(dark: boolean, fontSize: EditorFontSize): Extension {
  return [editorTheme(dark, fontSize), syntaxTheme];
}
