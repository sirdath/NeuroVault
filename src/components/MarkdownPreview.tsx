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
  onSwitchToEdit: () => void;
}

// Rewrite [[Target]] into [Target](#wiki:Target) so ReactMarkdown treats it
// as a regular link. We use the fragment scheme so the onClick handler can
// recognise it and route through the note store instead of opening a URL.
function preprocessWikiLinks(md: string): string {
  return md.replace(/\[\[([^\]]+)\]\]/g, (_, target: string) => {
    const clean = target.trim();
    return `[${clean}](#wiki:${encodeURIComponent(clean)})`;
  });
}

export function MarkdownPreview({ content, onSwitchToEdit }: MarkdownPreviewProps) {
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
    <div
      onClick={(e) => {
        // If the click was on a link/button, let it handle itself and don't
        // flip into edit mode.
        const target = e.target as HTMLElement;
        if (target.closest("a") || target.closest("button")) return;
        onSwitchToEdit();
      }}
      className="flex-1 overflow-y-auto cursor-text"
      title="Click to edit"
    >
      <div className="mx-auto max-w-[760px] px-10 py-8 prose-neurovault font-[Geist,sans-serif]">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            h1: ({ node, ...props }) => (
              <h1 className="text-2xl font-semibold text-[#f0a500] mt-6 mb-4" {...props} />
            ),
            h2: ({ node, ...props }) => (
              <h2 className="text-xl font-semibold text-[#e8e6f0] mt-6 mb-3 border-b border-[#1f1f2e] pb-1" {...props} />
            ),
            h3: ({ node, ...props }) => (
              <h3 className="text-lg font-semibold text-[#e8e6f0] mt-5 mb-2" {...props} />
            ),
            h4: ({ node, ...props }) => (
              <h4 className="text-base font-semibold text-[#e8e6f0] mt-4 mb-2" {...props} />
            ),
            p: ({ node, ...props }) => (
              <p className="text-[#c9c4e0] text-[15px] leading-relaxed my-3" {...props} />
            ),
            a: ({ node, href, children, ...props }) => {
              // Wiki-links get hover-preview behaviour via the shared
              // HoverPreviewStore. Regular URLs stay as plain links.
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
                  className="text-[#00c9b1] hover:text-[#4de0cb] underline"
                  {...props}
                >
                  {children}
                </a>
              );
            },
            ul: ({ node, ...props }) => (
              <ul className="list-disc pl-6 text-[#c9c4e0] my-3 space-y-1" {...props} />
            ),
            ol: ({ node, ...props }) => (
              <ol className="list-decimal pl-6 text-[#c9c4e0] my-3 space-y-1" {...props} />
            ),
            li: ({ node, ...props }) => <li className="leading-relaxed" {...props} />,
            blockquote: ({ node, ...props }) => (
              <blockquote
                className="border-l-2 border-[#f0a500]/40 pl-4 my-4 italic text-[#a8a3c4]"
                {...props}
              />
            ),
            code: ({ node, className, children, ...props }) => {
              const isBlock = className && className.includes("language-");
              if (isBlock) {
                return (
                  <code
                    className={`${className} block bg-[#12121c] border border-[#1f1f2e] rounded px-4 py-3 text-[13px] text-[#e8e6f0] font-mono overflow-x-auto`}
                    {...props}
                  >
                    {children}
                  </code>
                );
              }
              return (
                <code
                  className="bg-[#1a1a28] text-[#f0a500] px-1.5 py-0.5 rounded text-[13px] font-mono"
                  {...props}
                >
                  {children}
                </code>
              );
            },
            pre: ({ node, children, ...props }) => (
              <pre className="my-4 overflow-x-auto" {...props}>
                {children}
              </pre>
            ),
            hr: ({ node, ...props }) => <hr className="border-[#1f1f2e] my-6" {...props} />,
            table: ({ node, ...props }) => (
              <div className="overflow-x-auto my-4">
                <table className="border-collapse text-[14px] text-[#c9c4e0]" {...props} />
              </div>
            ),
            th: ({ node, ...props }) => (
              <th
                className="border border-[#1f1f2e] bg-[#12121c] px-3 py-1.5 text-left font-semibold text-[#e8e6f0]"
                {...props}
              />
            ),
            td: ({ node, ...props }) => (
              <td className="border border-[#1f1f2e] px-3 py-1.5" {...props} />
            ),
            strong: ({ node, ...props }) => <strong className="text-[#e8e6f0]" {...props} />,
            em: ({ node, ...props }) => <em className="text-[#c9c4e0]" {...props} />,
            img: ({ node, ...props }) => (
              <img className="max-w-full my-4 rounded border border-[#1f1f2e]" {...props} />
            ),
          }}
        >
          {processed}
        </ReactMarkdown>
        {!content.trim() && (
          <p className="text-[#35335a] italic">Empty note — click to start writing.</p>
        )}
      </div>
    </div>
  );
}
