/**
 * Build-time product boundary for the two desktop distributions.
 *
 * Vite replaces `import.meta.env.VITE_DISTRIBUTION` during the build, so
 * branches guarded by this constant can be removed from the App Store bundle
 * rather than merely disabled at runtime.
 */
export const IS_APP_STORE = import.meta.env.VITE_DISTRIBUTION === "app-store";

