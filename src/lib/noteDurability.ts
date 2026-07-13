/**
 * A serial, revision-aware write queue for the active note.
 *
 * The queue deliberately knows nothing about React, Zustand, Tauri, or vaults.
 * The note store supplies snapshots and state callbacks; this class guarantees
 * that only one write/transition runs at a time and that edits made while a
 * write is in flight are drained by a follow-up write before a barrier resolves.
 */

export interface NoteSaveSnapshot {
  filename: string;
  content: string;
  revision: number;
  /** Stable vault identity captured with the buffer. Never resolve at write time. */
  brainId?: string | null;
}

export interface NoteSaveResult {
  ok: boolean;
  writes: number;
  error?: string;
}

interface NoteDurabilityDependencies {
  getSnapshot: () => NoteSaveSnapshot | null;
  write: (snapshot: NoteSaveSnapshot) => Promise<void>;
  onSaving: (snapshot: NoteSaveSnapshot) => void;
  onPersisted: (snapshot: NoteSaveSnapshot) => void;
  onFailed: (snapshot: NoteSaveSnapshot, error: string) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class NoteDurabilityQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies: NoteDurabilityDependencies) {}

  /** Save every dirty revision visible before this barrier settles. */
  flush(): Promise<NoteSaveResult> {
    return this.enqueue(() => this.flushInsideQueue());
  }

  /**
   * Run a note/vault transition after all previously queued work. The callback
   * receives a non-enqueuing flush function so it can save both before and
   * after an awaited read without deadlocking itself behind its own queue item.
   */
  runExclusive<T>(
    task: (flush: () => Promise<NoteSaveResult>) => Promise<T>,
  ): Promise<T> {
    return this.enqueue(() => task(() => this.flushInsideQueue()));
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async flushInsideQueue(): Promise<NoteSaveResult> {
    let writes = 0;

    while (true) {
      const snapshot = this.dependencies.getSnapshot();
      if (!snapshot) return { ok: true, writes };

      this.dependencies.onSaving(snapshot);
      try {
        await this.dependencies.write(snapshot);
      } catch (error) {
        const message = errorMessage(error);
        this.dependencies.onFailed(snapshot, message);
        return { ok: false, writes, error: message };
      }

      writes += 1;
      // The store only clears dirty when filename + revision still match.
      // If the user typed during the await, getSnapshot() returns that newer
      // revision on the next loop and the barrier does not resolve early.
      this.dependencies.onPersisted(snapshot);
    }
  }
}
