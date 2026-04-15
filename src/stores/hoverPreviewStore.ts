import { create } from "zustand";

interface HoverPreviewStore {
  filename: string | null;
  anchor: DOMRect | null;
  show: (filename: string, anchor: DOMRect) => void;
  hide: () => void;
}

/**
 * Singleton store for the hover preview card. Any element that wants a
 * hover-card just calls `useHoverPreview(filename)` which returns event
 * handlers; a single <HoverPreview /> mounted at the root subscribes to
 * this store and renders the card wherever it's needed.
 */
export const useHoverPreviewStore = create<HoverPreviewStore>((set) => ({
  filename: null,
  anchor: null,
  show: (filename, anchor) => set({ filename, anchor }),
  hide: () => set({ filename: null, anchor: null }),
}));
