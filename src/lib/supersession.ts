/**
 * Supersession — turning two engram columns into something a reader can act on.
 *
 * `supersede_note` (the MCP tool / POST /api/notes/supersede) writes two
 * columns on the OLD engram: `superseded_by` (the newer engram's id) and an
 * optional `superseded_reason`. Recall already refuses to serve the stale note
 * (retriever.rs filters `superseded_by IS NULL`), but the editor happily opened
 * it with no marking at all — so a note the brain considers replaced read as
 * current. That gap is what the banner closes.
 *
 * The raw column is an engram id, which is useless to a human: this module
 * pairs it with the vault listing to recover the newer note's title and the
 * filename the editor can actually open.
 */

import type { NoteDetail, NoteSummary } from "./api";

/** The newer note, resolved for display. */
export interface Supersession {
  /** Engram id of the newer note — the raw `superseded_by` value. */
  id: string;
  /** Newer note's title, or a neutral placeholder when it is no longer listed. */
  title: string;
  /** Filename to open. Null when the newer note is not in the vault listing
   *  (dormant, deleted, or indexed under another brain) — the banner then
   *  states the fact without offering a click-through that would 404. */
  filename: string | null;
  /** Why it was superseded, when the caller recorded a reason. */
  reason: string | null;
}

/** Only the two columns matter here, so callers can pass a full note detail
 *  or a hand-built row without widening this module's contract. */
export type SupersessionColumns = Pick<NoteDetail, "superseded_by" | "superseded_reason">;

/** Minimal shape of a vault listing row used for id → title/filename lookup. */
export type NoteIndexRow = Pick<NoteSummary, "id" | "filename" | "title">;

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The engram id for a filename, or null when the vault index doesn't know it
 *  (a brand-new note the watcher hasn't ingested yet is the common case). */
export function findEngramIdByFilename(
  notes: readonly NoteIndexRow[],
  filename: string | null,
): string | null {
  if (!filename) return null;
  return notes.find((note) => note.filename === filename)?.id ?? null;
}

/**
 * Resolve the supersession banner's content, or null when the note is current.
 *
 * Empty strings count as "not superseded": SQLite hands back NULL as `null`,
 * but an empty-string write would otherwise render a banner pointing at
 * nothing.
 */
export function resolveSupersession(
  detail: SupersessionColumns | null | undefined,
  notes: readonly NoteIndexRow[],
): Supersession | null {
  const id = trimmed(detail?.superseded_by);
  if (!id) return null;
  const newer = notes.find((note) => note.id === id);
  const title = trimmed(newer?.title);
  const reason = trimmed(detail?.superseded_reason);
  return {
    id,
    title: title || "a newer note",
    filename: newer?.filename ?? null,
    reason: reason || null,
  };
}
