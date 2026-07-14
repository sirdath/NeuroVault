import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri", () => ({
  createNote: vi.fn(),
  deleteNote: vi.fn(),
  getVaultPath: vi.fn(),
  listNotes: vi.fn().mockResolvedValue([]),
  readNote: vi.fn(),
  saveNote: vi.fn().mockResolvedValue(undefined),
}));

import * as tauri from "../lib/tauri";
import { readNoteDraft } from "../lib/noteDrafts";
import { useNoteStore } from "./noteStore";

describe("noteStore recovery persistence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.dispatchEvent(new Event("pagehide"));
    localStorage.clear();
    vi.mocked(tauri.saveNote).mockResolvedValue(undefined);
    useNoteStore.setState({
      brainId: "alpha",
      activeFilename: "note.md",
      activeContent: "",
      isDirty: false,
      editRevision: 0,
      saveStatus: "saved",
      saveError: null,
      recoveryDraft: null,
      transitionLocked: false,
    });
  });

  afterEach(() => {
    window.dispatchEvent(new Event("pagehide"));
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("keeps input storage-free, then flushes the latest draft before the file barrier", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const store = useNoteStore.getState();

    store.updateContent("o");
    useNoteStore.getState().updateContent("on");
    useNoteStore.getState().updateContent("one");
    expect(setItem).not.toHaveBeenCalled();

    const barrier = useNoteStore.getState().flushPendingSave();
    // Recovery persistence is synchronous at the barrier boundary, before the
    // queued async Markdown write is allowed to run.
    expect(readNoteDraft(localStorage, "alpha", "note.md")?.content).toBe("one");
    expect(setItem).toHaveBeenCalledTimes(1);

    await expect(barrier).resolves.toBe(true);
    expect(tauri.saveNote).toHaveBeenCalledWith("note.md", "one", "alpha");
    expect(readNoteDraft(localStorage, "alpha", "note.md")).toBeNull();
  });

  it("retains the recovery draft when the Markdown barrier fails", async () => {
    vi.mocked(tauri.saveNote).mockRejectedValueOnce(new Error("disk full"));
    useNoteStore.getState().updateContent("must survive");

    await expect(useNoteStore.getState().flushPendingSave()).resolves.toBe(false);

    expect(useNoteStore.getState().isDirty).toBe(true);
    expect(useNoteStore.getState().saveStatus).toBe("failed");
    expect(readNoteDraft(localStorage, "alpha", "note.md")?.content).toBe("must survive");
  });
});
