/* Wikilink resolution — kept in sync with the backend resolver in
 * `src-tauri/src/memory/ingest.rs` (`resolve_wikilink_target`). A `[[link]]`
 * connects to a note by:
 *   1. exact title (case-insensitive), then
 *   2. base title — ignoring a trailing "(...)" suffix on either side, so
 *      `[[the run]]` resolves to "the run (produces locked dataset)" — but
 *      only when exactly one note shares that base title (never guess
 *      between two notes; the author disambiguates with the full title).
 */

/** Strip a single trailing parenthetical group: `"the run (x)"` → `"the run"`.
 *  Returns the trimmed input when there's no trailing `"(...)"`. */
export function stripTrailingParen(s: string): string {
  const t = s.trim();
  if (t.endsWith(")")) {
    const idx = t.lastIndexOf(" (");
    if (idx !== -1) return t.slice(0, idx).trim();
  }
  return t;
}

/** Resolve a `[[wikilink]]` target to a note, or `null` if there's no match
 *  (or an ambiguous base-title match). Generic over anything with a `title`. */
export function resolveWikiTarget<T extends { title: string }>(
  notes: readonly T[],
  target: string,
): T | null {
  const t = target.trim().toLowerCase();
  // 1. Exact (case-insensitive).
  const exact = notes.find((n) => n.title.toLowerCase() === t);
  if (exact) return exact;
  // 2. Base title, unique matches only.
  const base = stripTrailingParen(t);
  if (!base) return null;
  let hit: T | null = null;
  for (const n of notes) {
    if (stripTrailingParen(n.title.toLowerCase()) === base) {
      if (hit) return null; // ambiguous — two notes share this base title
      hit = n;
    }
  }
  return hit;
}
