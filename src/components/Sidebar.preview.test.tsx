import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readNote: vi.fn<(filename: string) => Promise<string>>(),
  virtualIndexes: [0, 1, 2] as number[],
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () => mocks.virtualIndexes
      .filter((index) => index < count)
      .map((index) => ({ index, key: `row-${index}`, start: index * 68 })),
    getTotalSize: () => count * 68,
    measureElement: () => undefined,
  }),
}));

vi.mock("../lib/tauri", () => ({
  createNote: vi.fn(),
  deleteNote: vi.fn(),
  getVaultPath: vi.fn(),
  listNotes: vi.fn().mockResolvedValue([]),
  readNote: mocks.readNote,
  saveNote: vi.fn(),
}));

vi.mock("./BrainSelector", () => ({ BrainSelector: () => null }));

import { useBrainStore } from "../stores/brainStore";
import { useNoteStore } from "../stores/noteStore";
import { useSettingsStore } from "../stores/settingsStore";
import { Sidebar } from "./Sidebar";

const notes = Array.from({ length: 40 }, (_, index) => ({
  filename: `note-${index}.md`,
  title: `Note ${index}`,
  modified: index,
  size: 100,
}));

function prepare(showPreviewSnippets: boolean): void {
  mocks.readNote.mockImplementation(async (filename) => `# ${filename}\n\nPreview`);
  useBrainStore.setState({
    activeBrainId: "alpha",
    activeBrainName: "Alpha",
    brains: [],
    loading: false,
  });
  useNoteStore.setState({
    brainId: "alpha",
    notes,
    notesStatus: "ready",
    notesError: null,
    activeFilename: null,
    vaultPath: "/vaults/alpha",
    searchQuery: "",
    searchResults: [],
  });
  useSettingsStore.setState({ showPreviewSnippets });
}

describe("Sidebar preview loading", () => {
  beforeEach(() => {
    mocks.readNote.mockReset();
    mocks.virtualIndexes = [0, 1, 2];
  });

  it("reads only virtualized visible and overscan note rows, not the full vault", async () => {
    prepare(true);
    render(<Sidebar />);

    await waitFor(() => expect(mocks.readNote).toHaveBeenCalledTimes(3));
    expect(mocks.readNote.mock.calls.map(([filename]) => filename)).toEqual([
      "note-0.md",
      "note-1.md",
      "note-2.md",
    ]);
  });

  it("performs zero preview reads when snippets are disabled", async () => {
    prepare(false);
    render(<Sidebar />);
    await act(async () => { await Promise.resolve(); });

    expect(mocks.readNote).not.toHaveBeenCalled();
  });
});
