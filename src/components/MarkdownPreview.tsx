import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useNoteStore } from "../stores/noteStore";
import { useSettingsStore } from "../stores/settingsStore";
import { WikiLink } from "./WikiLink";

/**
 * MarkdownPreview — the "reader mode" for a note. Renders the stored
 * content as styled HTML via react-markdown. Clicking anywhere switches
 * the Editor component into raw edit mode (handled by the caller via
 * `onSwitchToEdit`).
 *
 * Supports GitHub-flavoured markdown out of the box (tables, task lists,
 * strikethrough, autolinks). Wiki-links of the form [[Title]] are picked
 * up by a tiny pre-processor that rewrites them into regular links the
 * renderer turns into clickable anchors — we hijack the anchor click to
 * navigate to the target note instead of opening a URL.
 */

interface MarkdownPreviewProps {
  content: string;
  /** Caller-supplied handler. Omit in read-only contexts (e.g. the
   *  compilation review panel) where there's nothing to switch to. */
  onSwitchToEdit?: () => void;
}

// Rewrite [[Target]] into [Target](#wiki:Target) so ReactMarkdown treats it
// as a regular link. We use the fragment scheme so the onClick handler can
// recognise it and route through the note store instead of opening a URL.
// Supports both [[Target]] and typed [[Target|uses]] syntax.
function preprocessWikiLinks(md: string): string {
  return md.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target: string, linkType?: string) => {
    const clean = target.trim();
    const label = linkType ? `${clean} (${linkType.trim()})` : clean;
    return `[${label}](#wiki:${encodeURIComponent(clean)})`;
  });
}

const FONT_SIZE_MAP = { small: "14px", medium: "16px", large: "18px" } as const;
const LINE_HEIGHT_MAP = { small: "1.7", medium: "1.75", large: "1.8" } as const;

export function MarkdownPreview({ content }: MarkdownPreviewProps) {
  const notes = useNoteStore((s) => s.notes);
  const selectNote = useNoteStore((s) => s.selectNote);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const bodySize = FONT_SIZE_MAP[fontSize];
  const bodyLineHeight = LINE_HEIGHT_MAP[fontSize];

  const processed = preprocessWikiLinks(content || "");

  const handleAnchorClick = (e: React.MouseEvent<HTMLAnchorElement>, href: string | undefined) => {
    if (!href) return;
    if (href.startsWith("#wiki:")) {
      e.preventDefault();
      e.stopPropagation();
      const title = decodeURIComponent(href.slice("#wiki:".length));
      const match = notes.find((n) => n.title.toLowerCase() === title.toLowerCase());
      if (match) selectNote(match.filename);
    }
    // Real URLs (http/https) fall through — Tauri will handle via its webview
  };

  return (
    <div className="flex-1 overflow-y-auto cursor-default" style={{ backgroundColor: "var(--nv-bg)" }}>
      <div className="mx-auto max-w-[720px] px-12 py-12">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            // --- Headings: generous sizing, clear hierarchy ----------------
            h1: ({ node, ...props }) => (
              <h1 className="text-[2rem] font-bold [color:var(--nv-accent)] mt-8 mb-5 leading-tight tracking-tight font-[Geist,sans-serif]" {...props} />
            ),
            h2: ({ node, ...props }) => (
              <h2 className="text-[1.5rem] font-semibold [color:var(--nv-text)] mt-8 mb-4 pb-2 border-b [border-color:var(--nv-border)] leading-snug font-[Geist,sans-serif]" {...props} />
            ),
            h3: ({ node, ...props }) => (
              <h3 className="text-[1.2rem] font-semibold [color:var(--nv-text)] mt-6 mb-3 leading-snug font-[Geist,sans-serif]" {...props} />
            ),
            h4: ({ node, ...props }) => (
              <h4 className="text-base font-semibold [color:var(--nv-text)] mt-5 mb-2 font-[Geist,sans-serif]" {...props} />
            ),
            // --- Body text: readable, spacious ----------------------------
            p: ({ node, ...props }) => (
              <p className="[color:var(--nv-text)] mb-4 font-[Geist,sans-serif]" style={{ fontSize: bodySize, lineHeight: bodyLineHeight }} {...props} />
            ),
            // --- Links: wiki-links vs external ----------------------------
            a: ({ node, href, children, ...props }) => {
              if (href?.startsWith("#wiki:")) {
                const target = decodeURIComponent(href.slice("#wiki:".length));
                const match = notes.find(
                  (n) => n.title.toLowerCase() === target.toLowerCase(),
                );
                return (
                  <WikiLink
                    title={target}
                    filename={match?.filename ?? null}
                    onClick={(e) => handleAnchorClick(e, href)}
                  >
                    {children}
                  </WikiLink>
                );
              }
              return (
                <a
                  href={href}
                  onClick={(e) => handleAnchorClick(e, href)}
                  className="[color:var(--nv-accent)] hover:brightness-125 underline underline-offset-2 transition-all"
                  {...props}
                >
                  {children}
                </a>
              );
            },
            // --- Lists: comfortable spacing --------------------------------
            ul: ({ node, ...props }) => (
              <ul className="list-disc pl-6 [color:var(--nv-text)] mb-4 space-y-1.5 font-[Geist,sans-serif]" style={{ fontSize: bodySize }} {...props} />
            ),
            ol: ({ node, ...props }) => (
              <ol className="list-decimal pl-6 [color:var(--nv-text)] mb-4 space-y-1.5 font-[Geist,sans-serif]" style={{ fontSize: bodySize }} {...props} />
            ),
            li: ({ node, ...props }) => <li style={{ lineHeight: bodyLineHeight }} {...props} />,
            // --- Blockquotes: prominent left border -----------------------
            blockquote: ({ node, ...props }) => (
              <blockquote
                className="border-l-4 [border-color:var(--nv-accent)] pl-5 my-5 italic [color:var(--nv-text-muted)] text-[15px] leading-[1.7]"
                {...props}
              />
            ),
            // --- Code: inline pops, blocks have contrast ------------------
            code: ({ node, className, children, ...props }) => {
              const isBlock = className && className.includes("language-");
              if (isBlock) {
                return (
                  <code
                    className={`${className} block [background-color:var(--nv-surface)] border [border-color:var(--nv-border)] rounded-lg px-5 py-4 text-[13px] [color:var(--nv-text)] font-mono overflow-x-auto leading-relaxed`}
                    {...props}
                  >
                    {children}
                  </code>
                );
              }
              return (
                <code
                  className="[background-color:var(--nv-surface)] [color:var(--nv-accent)] px-1.5 py-0.5 rounded text-[14px] font-mono"
                  {...props}
                >
                  {children}
                </code>
              );
            },
            pre: ({ node, children, ...props }) => (
              <pre className="my-5 overflow-x-auto" {...props}>
                {children}
              </pre>
            ),
            // --- Horizontal rules: breathing room -------------------------
            hr: ({ node, ...props }) => <hr className="[border-color:var(--nv-border)] my-8" {...props} />,
            // --- Tables: full-width, padded, clear headers ----------------
            table: ({ node, ...props }) => (
              <div className="overflow-x-auto my-5">
                <table className="w-full border-collapse text-[14px] [color:var(--nv-text)] font-[Geist,sans-serif]" {...props} />
              </div>
            ),
            th: ({ node, ...props }) => (
              <th
                className="border [border-color:var(--nv-border)] [background-color:var(--nv-surface)] px-4 py-2 text-left font-semibold [color:var(--nv-text)] text-[13px] uppercase tracking-wider"
                {...props}
              />
            ),
            td: ({ node, ...props }) => (
              <td className="border [border-color:var(--nv-border)] px-4 py-2.5" {...props} />
            ),
            // --- Inline formatting ----------------------------------------
            strong: ({ node, ...props }) => <strong className="[color:var(--nv-text)] font-semibold" {...props} />,
            em: ({ node, ...props }) => <em className="[color:var(--nv-text)]" {...props} />,
            img: ({ node, ...props }) => (
              <img className="max-w-full my-5 rounded-lg border [border-color:var(--nv-border)]" {...props} />
            ),
          }}
        >
          {processed}
        </ReactMarkdown>
        {!content.trim() && (
          <p className="[color:var(--nv-text-dim)] italic font-[Geist,sans-serif] text-center mt-12">
            Empty note
          </p>
        )}
      </div>
    </div>
  );
}
