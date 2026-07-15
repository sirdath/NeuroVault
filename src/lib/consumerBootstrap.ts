/**
 * Establish the persisted active vault before any note-scoped state loads.
 * A cold launch used to start these operations concurrently, allowing the
 * note list and draft scope to initialize against a null or previous brain.
 */
export async function initializeConsumerVault(
  loadBrains: () => Promise<void>,
  initVault: () => Promise<void>,
): Promise<void> {
  await loadBrains();
  await initVault();
}
