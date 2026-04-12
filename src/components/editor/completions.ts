/**
 * Autocomplete extensions — slash commands + [[wikilinks]].
 *
 * Provides Notion-style `/` block menu and Obsidian-style `[[` note linking.
 */

import {
  autocompletion,
  CompletionContext,
  CompletionResult,
  Completion,
} from "@codemirror/autocomplete";

/**
 * Slash command menu — triggered when `/` is typed at the start of a line.
 * Inserts markdown templates for common block types.
 */
const SLASH_COMMANDS: Array<{
  name: string;
  description: string;
  template: string;
  cursorOffset?: number;
}> = [
  { name: "heading 1", description: "Large title", template: "# ", cursorOffset: 2 },
  { name: "heading 2", description: "Section title", template: "## ", cursorOffset: 3 },
  { name: "heading 3", description: "Subsection", template: "### ", cursorOffset: 4 },
  { name: "bullet list", description: "Unordered list", template: "- ", cursorOffset: 2 },
  { name: "numbered list", description: "Ordered list", template: "1. ", cursorOffset: 3 },
  { name: "checkbox", description: "Task item", template: "- [ ] ", cursorOffset: 6 },
  { name: "quote", description: "Blockquote", template: "> ", cursorOffset: 2 },
  { name: "code", description: "Code block", template: "```\n\n```", cursorOffset: 4 },
  { name: "code python", description: "Python code block", template: "```python\n\n```", cursorOffset: 10 },
  { name: "code typescript", description: "TypeScript code block", template: "```typescript\n\n```", cursorOffset: 14 },
  { name: "divider", description: "Horizontal rule", template: "---\n" },
  { name: "callout note", description: "Info callout", template: "> [!note]\n> " },
  { name: "callout warning", description: "Warning callout", template: "> [!warning]\n> " },
  { name: "callout tip", description: "Tip callout", template: "> [!tip]\n> " },
  { name: "table", description: "2x2 table", template: "| Col 1 | Col 2 |\n| --- | --- |\n| Row 1 | Row 1 |\n" },
  { name: "wikilink", description: "Link to another note", template: "[[]]", cursorOffset: 2 },
  { name: "task-date", description: "Insert today's date", template: new Date().toISOString().slice(0, 10) },
];

function slashCompletions(context: CompletionContext): CompletionResult | null {
  // Only trigger right after a `/` at the start of a line
  const line = context.state.doc.lineAt(context.pos);
  const lineText = line.text.slice(0, context.pos - line.from);

  // Match `/` followed by optional query, either at line start or after whitespace
  const match = lineText.match(/(?:^|\s)\/(\w*)$/);
  if (!match) return null;

  const slashStart = context.pos - match[1]!.length - 1; // Position of the `/`
  const options: Completion[] = SLASH_COMMANDS.map((cmd) => ({
    label: cmd.name,
    detail: cmd.description,
    apply: (view) => {
      // Replace `/query` with the template
      view.dispatch({
        changes: { from: slashStart, to: context.pos, insert: cmd.template },
        selection: cmd.cursorOffset
          ? { anchor: slashStart + cmd.cursorOffset }
          : undefined,
      });
    },
    boost: 0,
  }));

  return {
    from: slashStart + 1,
    options,
    validFor: /^\w*$/,
  };
}

/**
 * Wikilink autocomplete — triggered by `[[`.
 * Shows a list of all note titles for easy linking.
 */
function wikilinkCompletions(
  getNoteTitles: () => string[],
): (context: CompletionContext) => CompletionResult | null {
  return (context: CompletionContext) => {
    // Match `[[` followed by optional query
    const before = context.state.sliceDoc(
      Math.max(0, context.pos - 100),
      context.pos,
    );
    const match = before.match(/\[\[([^\]\n]*)$/);
    if (!match) return null;

    const query = match[1]!;
    const queryLower = query.toLowerCase();
    const from = context.pos - query.length;

    const titles = getNoteTitles();
    const options: Completion[] = titles
      .filter((t) => !queryLower || t.toLowerCase().includes(queryLower))
      .slice(0, 20)
      .map((title) => ({
        label: title,
        apply: `${title}]]`,
        detail: "note",
      }));

    if (options.length === 0) {
      // Allow creating a new note
      if (query) {
        options.push({
          label: `Create "${query}"`,
          apply: `${query}]]`,
          detail: "new note",
          boost: -1,
        });
      } else {
        return null;
      }
    }

    return { from, options };
  };
}

/**
 * Build the complete autocomplete extension.
 */
export function buildCompletions(getNoteTitles: () => string[]) {
  return autocompletion({
    override: [slashCompletions, wikilinkCompletions(getNoteTitles)],
    closeOnBlur: true,
    activateOnTyping: true,
    defaultKeymap: true,
  });
}
