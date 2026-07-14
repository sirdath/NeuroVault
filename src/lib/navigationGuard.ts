/** Run the durable-note flush before a route leaves Memories. Keeping this
 * tiny contract outside React makes every destination—including Settings—
 * testable against the same data-loss barrier. */
export async function canLeaveView(
  current: string,
  next: string,
  flushPendingSave: () => Promise<boolean>,
): Promise<boolean> {
  if (current !== "memories" || next === "memories") return true;
  return flushPendingSave();
}
