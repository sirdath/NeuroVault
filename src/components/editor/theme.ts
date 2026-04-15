import { EditorView } from "@codemirror/view";
import { Extension } from "@codemirror/state";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

const colors = {
  bg: "#0b0b12",
  surface: "#12121c",
  raised: "#1a1a28",
  border: "#1f1f2e",
  amber: "#f0a500",
  teal: "#00c9b1",
  purple: "#8b7cf8",
  coral: "#ff6b6b",
  green: "#4ade80",
  text: "#e8e6f0",
  sub: "#8a88a0",
  muted: "#35335a",
};

const neurovaultEditorTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: colors.bg,
      color: colors.text,
      fontFamily: "'Lora', Georgia, serif",
      fontSize: "16px",
      lineHeight: "1.7",
    },
    ".cm-content": {
      caretColor: colors.amber,
      padding: "24px 0",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: colors.amber,
      borderLeftWidth: "2px",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      {
        backgroundColor: "rgba(240, 165, 0, 0.15)",
      },
    ".cm-panels": {
      backgroundColor: colors.surface,
      color: colors.text,
    },
    ".cm-panels.cm-panels-top": {
      borderBottom: `1px solid ${colors.border}`,
    },
    ".cm-panels.cm-panels-bottom": {
      borderTop: `1px solid ${colors.border}`,
    },
    ".cm-searchMatch": {
      backgroundColor: "rgba(240, 165, 0, 0.25)",
      outline: `1px solid ${colors.amber}`,
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "rgba(240, 165, 0, 0.4)",
    },
    ".cm-activeLine": {
      backgroundColor: "rgba(255, 255, 255, 0.03)",
    },
    ".cm-selectionMatch": {
      backgroundColor: "rgba(139, 124, 248, 0.15)",
    },
    "&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket": {
      backgroundColor: "rgba(0, 201, 177, 0.2)",
      outline: "none",
    },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: colors.muted,
      border: "none",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "transparent",
      color: colors.sub,
    },
    ".cm-foldPlaceholder": {
      backgroundColor: colors.raised,
      border: "none",
      color: colors.sub,
    },
    ".cm-tooltip": {
      backgroundColor: colors.raised,
      border: `1px solid ${colors.border}`,
    },
    ".cm-tooltip .cm-tooltip-arrow:before": {
      borderTopColor: "transparent",
      borderBottomColor: "transparent",
    },
    ".cm-tooltip-autocomplete": {
      "& > ul > li[aria-selected]": {
        backgroundColor: colors.surface,
        color: colors.text,
      },
    },
    // Scrollbar styling
    ".cm-scroller": {
      scrollbarWidth: "thin",
      scrollbarColor: `${colors.muted} transparent`,
    },
  },
  { dark: true }
);

const neurovaultHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: colors.purple },
  { tag: [t.name, t.deleted, t.character, t.macroName], color: colors.text },
  { tag: [t.function(t.variableName), t.labelName], color: colors.teal },
  {
    tag: [t.color, t.constant(t.name), t.standard(t.name)],
    color: colors.amber,
  },
  { tag: [t.definition(t.name), t.separator], color: colors.text },
  { tag: [t.typeName, t.className, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: colors.purple },
  { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.special(t.string)], color: colors.teal },
  { tag: [t.meta, t.comment], color: colors.sub, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold", color: colors.text },
  { tag: t.emphasis, fontStyle: "italic", color: colors.text },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: colors.teal, textDecoration: "underline" },
  {
    tag: t.heading1,
    fontWeight: "700",
    fontSize: "1.6em",
    color: colors.amber,
  },
  {
    tag: t.heading2,
    fontWeight: "600",
    fontSize: "1.3em",
    color: colors.amber,
  },
  {
    tag: t.heading3,
    fontWeight: "600",
    fontSize: "1.1em",
    color: colors.text,
  },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: colors.amber },
  { tag: [t.processingInstruction, t.string, t.inserted], color: colors.green },
  { tag: t.invalid, color: colors.coral },
  {
    tag: t.monospace,
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: "0.9em",
    color: colors.purple,
  },
]);

export const neurovaultTheme: Extension = [
  neurovaultEditorTheme,
  syntaxHighlighting(neurovaultHighlightStyle),
];
