/**
 * Single source of truth for runtime config. Everything that needs to
 * reach the in-process Rust HTTP backend reads its base URL from here
 * — never hardcode `http://127.0.0.1:8765` directly in a component or
 * store. (The Python sidecar that originally owned this port was
 * retired in v0.1.0; the Rust server takes over the same surface.)
 *
 * Override via the Vite env var ``VITE_API_HOST`` at build time, e.g.
 *   ``VITE_API_HOST="http://192.168.1.23:8765" npm run dev``
 * for remote-brain development, custom ports, or Docker compose setups.
 */

const DEFAULT_API_HOST = "http://127.0.0.1:8765";

// import.meta.env is Vite-provided at build time. We read it once and
// freeze the value so swapping env mid-session doesn't fracture the app.
export const API_HOST: string =
  (import.meta.env.VITE_API_HOST as string | undefined)?.trim() || DEFAULT_API_HOST;

/** Human-readable host:port for UI display (e.g. "127.0.0.1:8765"). */
export const API_DISPLAY: string = API_HOST.replace(/^https?:\/\//, "");
