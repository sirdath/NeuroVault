/** Synchronous crash-recovery drafts, isolated by stable vault id. */

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key?(index: number): string | null;
  readonly length?: number;
}

export interface NoteRecoveryDraft {
  version: 1;
  brainId: string;
  filename: string;
  content: string;
  updatedAt: number;
}

const PREFIX = "nv.recovery-draft.";
const MAX_DRAFT_CHARS = 2_000_000;

function encoded(value: string): string {
  return encodeURIComponent(value);
}

export function noteDraftKey(brainId: string, filename: string): string {
  return `${PREFIX}${encoded(brainId)}.${encoded(filename)}`;
}

export function writeNoteDraft(
  storage: DraftStorage,
  brainId: string | null,
  filename: string | null,
  content: string,
  updatedAt = Date.now(),
): boolean {
  if (!brainId || !filename || content.length > MAX_DRAFT_CHARS) return false;
  const draft: NoteRecoveryDraft = { version: 1, brainId, filename, content, updatedAt };
  try {
    storage.setItem(noteDraftKey(brainId, filename), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function readNoteDraft(
  storage: DraftStorage,
  brainId: string | null,
  filename: string,
): NoteRecoveryDraft | null {
  if (!brainId) return null;
  try {
    const raw = storage.getItem(noteDraftKey(brainId, filename));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<NoteRecoveryDraft>;
    if (
      parsed.version !== 1 ||
      parsed.brainId !== brainId ||
      parsed.filename !== filename ||
      typeof parsed.content !== "string" ||
      typeof parsed.updatedAt !== "number"
    ) return null;
    return parsed as NoteRecoveryDraft;
  } catch {
    return null;
  }
}

export function clearNoteDraft(storage: DraftStorage, brainId: string | null, filename: string): void {
  if (!brainId) return;
  try { storage.removeItem(noteDraftKey(brainId, filename)); } catch { /* unavailable storage */ }
}

export function clearNoteDraftIfContentMatches(
  storage: DraftStorage,
  brainId: string | null,
  filename: string,
  persistedContent: string,
): void {
  const draft = readNoteDraft(storage, brainId, filename);
  if (draft?.content === persistedContent) clearNoteDraft(storage, brainId, filename);
}
