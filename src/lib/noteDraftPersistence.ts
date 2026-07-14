import {
  clearNoteDraft,
  clearNoteDraftIfContentMatches,
  noteDraftKey,
  writeNoteDraft,
  type DraftStorage,
} from "./noteDrafts";

/**
 * Recovery drafts are deliberately synchronous when they reach storage, but
 * serializing a full note for every input event makes the editor stutter on
 * large files. This queue coalesces edits and caps the vulnerable in-memory
 * window: the first pending edit schedules a write no later than 250ms later,
 * while subsequent edits replace only the pending value.
 */
export const NOTE_DRAFT_PERSIST_DELAY_MS = 250;

interface PendingDraft {
  brainId: string;
  filename: string;
  content: string;
  updatedAt: number;
}

export class NoteDraftPersistence {
  private readonly pending = new Map<string, PendingDraft>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly storage: DraftStorage,
    private readonly delayMs = NOTE_DRAFT_PERSIST_DELAY_MS,
  ) {}

  /** Queue the latest content without touching storage on the input path. */
  schedule(
    brainId: string | null,
    filename: string | null,
    content: string,
    updatedAt = Date.now(),
  ): boolean {
    if (!brainId || !filename) return false;
    this.pending.set(noteDraftKey(brainId, filename), {
      brainId,
      filename,
      content,
      updatedAt,
    });
    // Do not restart the timer for every keystroke. Continuous typing still
    // reaches crash-recovery storage at least once per bounded interval.
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flushAll();
      }, this.delayMs);
    }
    return true;
  }

  /** Persist every queued scope synchronously, cancelling the delayed write. */
  flushAll(): number {
    this.cancelTimer();
    const drafts = [...this.pending.values()];
    this.pending.clear();
    let writes = 0;
    for (const draft of drafts) {
      if (writeNoteDraft(
        this.storage,
        draft.brainId,
        draft.filename,
        draft.content,
        draft.updatedAt,
      )) writes += 1;
    }
    return writes;
  }

  /** Remove both queued and persisted recovery state for one note. */
  discard(brainId: string | null, filename: string): void {
    if (!brainId) return;
    this.pending.delete(noteDraftKey(brainId, filename));
    if (this.pending.size === 0) this.cancelTimer();
    clearNoteDraft(this.storage, brainId, filename);
  }

  /**
   * Reconcile a completed Markdown write with recovery storage.
   *
   * If a newer edit arrived while the file write was in flight, persist that
   * edit immediately before considering the older snapshot for removal. If
   * the queued content is exactly the snapshot that landed, disk is current
   * and any older stored draft can safely be removed as stale.
   */
  markPersisted(brainId: string | null, filename: string, content: string): void {
    if (!brainId) return;
    const key = noteDraftKey(brainId, filename);
    const pending = this.pending.get(key);
    if (!pending) {
      clearNoteDraftIfContentMatches(this.storage, brainId, filename, content);
      return;
    }

    this.pending.delete(key);
    if (this.pending.size === 0) this.cancelTimer();

    if (pending.content === content) {
      // The just-written file is the newest editor revision. A previously
      // flushed older draft would otherwise appear as a false recovery.
      clearNoteDraft(this.storage, brainId, filename);
      return;
    }

    writeNoteDraft(
      this.storage,
      pending.brainId,
      pending.filename,
      pending.content,
      pending.updatedAt,
    );
    clearNoteDraftIfContentMatches(this.storage, brainId, filename, content);
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}

type VisibilityTarget = EventTarget & { readonly visibilityState?: string };

/** Flush the tiny in-memory recovery window before the WebView is hidden. */
export function installNoteDraftLifecycleFlush(
  persistence: NoteDraftPersistence,
  pageTarget: EventTarget | null = typeof window === "undefined" ? null : window,
  visibilityTarget: VisibilityTarget | null = typeof document === "undefined" ? null : document,
): () => void {
  const flush: EventListener = () => { persistence.flushAll(); };
  const flushWhenHidden: EventListener = () => {
    if (visibilityTarget?.visibilityState === "hidden") persistence.flushAll();
  };

  pageTarget?.addEventListener("pagehide", flush);
  visibilityTarget?.addEventListener("visibilitychange", flushWhenHidden);

  return () => {
    pageTarget?.removeEventListener("pagehide", flush);
    visibilityTarget?.removeEventListener("visibilitychange", flushWhenHidden);
  };
}
