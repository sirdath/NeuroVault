export const RESTORABLE_CONSUMER_VIEWS = ["today", "memories", "graph"] as const;

export type RestorableConsumerView = (typeof RESTORABLE_CONSUMER_VIEWS)[number];

export function isRestorableConsumerView(value: unknown): value is RestorableConsumerView {
  return typeof value === "string" && RESTORABLE_CONSUMER_VIEWS.includes(value as RestorableConsumerView);
}

export function readRestorableConsumerView(
  storage: Pick<Storage, "getItem"> | null | undefined,
): RestorableConsumerView {
  if (!storage) return "memories";
  try {
    const saved = storage.getItem("nv.view");
    return isRestorableConsumerView(saved) ? saved : "memories";
  } catch {
    return "memories";
  }
}

export function persistRestorableConsumerView(
  storage: Pick<Storage, "setItem"> | null | undefined,
  value: unknown,
): void {
  if (!storage || !isRestorableConsumerView(value)) return;
  try {
    storage.setItem("nv.view", value);
  } catch {
    // Local storage is a convenience only; navigation must keep working.
  }
}
