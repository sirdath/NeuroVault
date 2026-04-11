/** Format a Unix timestamp as a relative time string */
export function relativeTime(epoch: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - epoch;

  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 172800) return "yesterday";
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;

  const date = new Date(epoch * 1000);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Extract the first 80 characters after the title line for a preview snippet */
export function extractPreview(content: string): string {
  const lines = content.split("\n");
  const nonTitleLines = lines
    .filter((line) => !line.startsWith("# ") && line.trim().length > 0)
    .join(" ")
    .trim();

  if (nonTitleLines.length <= 80) return nonTitleLines;
  return nonTitleLines.slice(0, 80) + "...";
}
