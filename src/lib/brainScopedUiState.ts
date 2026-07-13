/** Small, testable helpers for UI state that must never bleed across brains. */

export interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export type ScopedPreviewCache = Record<string, Record<string, string>>;

export function brainUiScope(brainId: string | null, vaultPath = ""): string {
  if (brainId) return `brain:${brainId}`;
  if (vaultPath) return `vault:${vaultPath}`;
  return "unresolved";
}

export function tabOrderStorageKey(scope: string): string {
  return `nv.tabs.order.${encodeURIComponent(scope)}`;
}

export function scopedStorageKey(prefix: string, scope: string): string {
  return `${prefix}.${encodeURIComponent(scope)}`;
}

export function loadScopedTabOrder(storage: StorageLike, scope: string): string[] {
  try {
    const raw = storage.getItem(tabOrderStorageKey(scope));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((value) => typeof value === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

export function persistScopedTabOrder(
  storage: StorageLike,
  scope: string,
  tabs: string[],
): void {
  storage.setItem(tabOrderStorageKey(scope), JSON.stringify(tabs));
}

export function previewsForScope(
  cache: ScopedPreviewCache,
  scope: string,
): Record<string, string> {
  return cache[scope] ?? {};
}

export function mergeScopedPreviews(
  cache: ScopedPreviewCache,
  scope: string,
  additions: Record<string, string>,
): ScopedPreviewCache {
  return {
    ...cache,
    [scope]: {
      ...previewsForScope(cache, scope),
      ...additions,
    },
  };
}
