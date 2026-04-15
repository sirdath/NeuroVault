import { create } from "zustand";

export type Density = "comfortable" | "cozy" | "compact";

interface DensityStore {
  density: Density;
  setDensity: (d: Density) => void;
  cycle: () => void;
}

const STORAGE_KEY = "nv.density";
const ORDER: Density[] = ["comfortable", "cozy", "compact"];

function loadInitial(): Density {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && (ORDER as string[]).includes(saved)) {
      return saved as Density;
    }
  } catch {
    /* private mode — fall through */
  }
  return "comfortable";
}

function applyToDOM(d: Density) {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.density = d;
  }
}

const initial = loadInitial();
applyToDOM(initial);

export const useDensityStore = create<DensityStore>((set, get) => ({
  density: initial,
  setDensity: (d) => {
    try {
      localStorage.setItem(STORAGE_KEY, d);
    } catch {
      /* non-fatal */
    }
    applyToDOM(d);
    set({ density: d });
  },
  cycle: () => {
    const cur = get().density;
    const next = ORDER[(ORDER.indexOf(cur) + 1) % ORDER.length]!;
    get().setDensity(next);
  },
}));
