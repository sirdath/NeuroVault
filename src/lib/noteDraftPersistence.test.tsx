import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readNoteDraft, type DraftStorage } from "./noteDrafts";
import {
  installNoteDraftLifecycleFlush,
  NOTE_DRAFT_PERSIST_DELAY_MS,
  NoteDraftPersistence,
} from "./noteDraftPersistence";

class MemoryStorage implements DraftStorage {
  readonly values = new Map<string, string>();
  writes = 0;

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.writes += 1;
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

class MutableVisibilityTarget extends EventTarget {
  visibilityState = "visible";
}

describe("NoteDraftPersistence", () => {
  beforeEach(() => { vi.useFakeTimers(); });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("does not serialize on each keystroke and persists the latest draft within 250ms", () => {
    const storage = new MemoryStorage();
    const persistence = new NoteDraftPersistence(storage);

    persistence.schedule("alpha", "note.md", "o", 1);
    persistence.schedule("alpha", "note.md", "on", 2);
    persistence.schedule("alpha", "note.md", "one", 3);

    expect(storage.writes).toBe(0);
    vi.advanceTimersByTime(NOTE_DRAFT_PERSIST_DELAY_MS - 1);
    expect(storage.writes).toBe(0);
    vi.advanceTimersByTime(1);

    expect(storage.writes).toBe(1);
    expect(readNoteDraft(storage, "alpha", "note.md")).toMatchObject({
      content: "one",
      updatedAt: 3,
    });
  });

  it("isolates pending drafts by brain and filename", () => {
    const storage = new MemoryStorage();
    const persistence = new NoteDraftPersistence(storage);

    persistence.schedule("alpha", "same.md", "alpha same");
    persistence.schedule("beta", "same.md", "beta same");
    persistence.schedule("alpha", "other.md", "alpha other");
    vi.advanceTimersByTime(NOTE_DRAFT_PERSIST_DELAY_MS);

    expect(readNoteDraft(storage, "alpha", "same.md")?.content).toBe("alpha same");
    expect(readNoteDraft(storage, "beta", "same.md")?.content).toBe("beta same");
    expect(readNoteDraft(storage, "alpha", "other.md")?.content).toBe("alpha other");
    expect(storage.writes).toBe(3);
  });

  it("flushes immediately for barriers and does not replay the cancelled timer", () => {
    const storage = new MemoryStorage();
    const persistence = new NoteDraftPersistence(storage);

    persistence.schedule("alpha", "barrier.md", "safe");
    expect(persistence.flushAll()).toBe(1);
    expect(readNoteDraft(storage, "alpha", "barrier.md")?.content).toBe("safe");
    expect(storage.writes).toBe(1);

    vi.advanceTimersByTime(NOTE_DRAFT_PERSIST_DELAY_MS);
    expect(storage.writes).toBe(1);
  });

  it("flushes on pagehide and when the document becomes hidden", () => {
    const storage = new MemoryStorage();
    const persistence = new NoteDraftPersistence(storage);
    const page = new EventTarget();
    const visibility = new MutableVisibilityTarget();
    const uninstall = installNoteDraftLifecycleFlush(persistence, page, visibility);

    persistence.schedule("alpha", "pagehide.md", "page hidden");
    page.dispatchEvent(new Event("pagehide"));
    expect(readNoteDraft(storage, "alpha", "pagehide.md")?.content).toBe("page hidden");

    persistence.schedule("alpha", "visibility.md", "still pending");
    visibility.dispatchEvent(new Event("visibilitychange"));
    expect(readNoteDraft(storage, "alpha", "visibility.md")).toBeNull();
    visibility.visibilityState = "hidden";
    visibility.dispatchEvent(new Event("visibilitychange"));
    expect(readNoteDraft(storage, "alpha", "visibility.md")?.content).toBe("still pending");

    uninstall();
  });

  it("keeps a newer edit recoverable while an older file write completes", () => {
    const storage = new MemoryStorage();
    const persistence = new NoteDraftPersistence(storage);

    persistence.schedule("alpha", "race.md", "revision one", 1);
    persistence.flushAll();
    persistence.schedule("alpha", "race.md", "revision two", 2);

    persistence.markPersisted("alpha", "race.md", "revision one");
    expect(readNoteDraft(storage, "alpha", "race.md")).toMatchObject({
      content: "revision two",
      updatedAt: 2,
    });

    persistence.markPersisted("alpha", "race.md", "revision two");
    expect(readNoteDraft(storage, "alpha", "race.md")).toBeNull();
  });
});
