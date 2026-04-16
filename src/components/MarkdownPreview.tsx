import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useNoteStore } from "../stores/noteStore";
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

export function MarkdownPreview({ content }: MarkdownPreviewProps) {
  const notes = useNoteStore((s) => s.notes);
  const selectNote = useNoteStore((s) => s.selectNote);

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
    <div className="flex-1 overflow-y-auto cursor-default bg-[#08080f]">
      <div className="mx-auto max-w-[720px] px-12 py-12">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            // --- Headings: generous sizing, clear hierarchy ----------------
            h1: ({ node, ...props }) => (
              <h1 className="text-[2rem] font-bold text-[#f0a500] mt-8 mb-5 leading-tight tracking-tight font-[Geist,sans-serif]" {...props} />
            ),
            h2: ({ node, ...props }) => (
              <h2 className="text-[1.5rem] font-semibold text-[#e8e6f0] mt-8 mb-4 pb-2 border-b border-[#1f1f2e] leading-snug font-[Geist,sans-serif]" {...props} />
            ),
            h3: ({ node, ...props }) => (
              <h3 className="text-[1.2rem] font-semibold text-[#e8e6f0] mt-6 mb-3 leading-snug font-[Geist,sans-serif]" {...props} />
            ),
            h4: ({ node, ...props }) => (
              <h4 className="text-base font-semibold text-[#e8e6f0] mt-5 mb-2 font-[Geist,sans-serif]" {...props} />
            ),
            // --- Body text: readable, spacious ----------------------------
            p: ({ node, ...props }) => (
              <p className="text-[#d0cce6] text-[16px] leading-[1.75] mb-4 font-[Geist,sans-serif]" {...props} />
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
                  className="text-[#00c9b1] hover:text-[#4de0cb] underline underline-offset-2 decoration-[#00c9b1]/40 hover:decoration-[#4de0cb] transition-colors"
                  {...props}
                >
                  {children}
                </a>
              );
            },
            // --- Lists: comfortable spacing --------------------------------
            ul: ({ node, ...props }) => (
              <ul className="list-disc pl-6 text-[#d0cce6] mb-4 space-y-1.5 text-[16px] font-[Geist,sans-serif]" {...props} />
            ),
            ol: ({ node, ...props }) => (
              <ol className="list-decimal pl-6 text-[#d0cce6] mb-4 space-y-1.5 text-[16px] font-[Geist,sans-serif]" {...props} />
            ),
            li: ({ node, ...props }) => <li className="leading-[1.7]" {...props} />,
            // --- Blockquotes: prominent left border -----------------------
            blockquote: ({ node, ...props }) => (
              <blockquote
                className="border-l-4 border-[#f0a500]/30 pl-5 my-5 italic text-[#a8a3c4] text-[15px] leading-[1.7]"
                {...props}
              />
            ),
            // --- Code: inline pops, blocks have contrast ------------------
            code: ({ node, className, children, ...props }) => {
              const isBlock = className && className.includes("language-");
              if (isBlock) {
                return (
                  <code
                    className={`${className} block bg-[#161624] border border-[#1f1f2e] rounded-lg px-5 py-4 text-[13px] text-[#e8e6f0] font-mono overflow-x-auto leading-relaxed`}
                    {...props}
                  >
                    {children}
                  </code>
                );
              }
              return (
                <code
                  className="bg-[#1e1e30] text-[#f0a500] px-1.5 py-0.5 rounded text-[14px] font-mono"
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
            hr: ({ node, ...props }) => <hr className="border-[#1f1f2e] my-8" {...props} />,
            // --- Tables: full-width, padded, clear headers ----------------
            table: ({ node, ...props }) => (
              <div className="overflow-x-auto my-5">
                <table className="w-full border-collapse text-[14px] text-[#d0cce6] font-[Geist,sans-serif]" {...props} />
              </div>
            ),
            th: ({ node, ...props }) => (
              <th
                className="border border-[#1f1f2e] bg-[#161624] px-4 py-2 text-left font-semibold text-[#e8e6f0] text-[13px] uppercase tracking-wider"
                {...props}
              />
            ),
            td: ({ node, ...props }) => (
              <td className="border border-[#1f1f2e] px-4 py-2.5" {...props} />
            ),
            // --- Inline formatting ----------------------------------------
            strong: ({ node, ...props }) => <strong className="text-[#e8e6f0] font-semibold" {...props} />,
            em: ({ node, ...props }) => <em className="text-[#c9c4e0]" {...props} />,
            img: ({ node, ...props }) => (
              <img className="max-w-full my-5 rounded-lg border border-[#1f1f2e]" {...props} />
            ),
          }}
        >
          {processed}
        </ReactMarkdown>
        {!content.trim() && (
          <p className="text-[#35335a] italic font-[Geist,sans-serif] text-center mt-12">
            Empty note
          </p>
        )}
      </div>
    </div>
  );
}
