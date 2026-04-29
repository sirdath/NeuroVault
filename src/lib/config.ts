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

// Resolution order:
//   1. window.__NEUROVAULT_CONFIG__.serverUrl  (injected by the VS Code
//      extension host at webview boot — the extension probes a free
//      port in the 8765..8784 range, so the actual port may not be the
//      default if the desktop app is also running.)
//   2. import.meta.env.VITE_API_HOST            (Vite-provided at build
//      time, used for remote-brain dev / docker compose / custom ports.)
//   3. DEFAULT_API_HOST                         (the conventional
//      127.0.0.1:8765 the desktop Tauri app and MCP proxy assume.)
//
// Resolved once at module load and frozen for the session so swapping
// env or config mid-flight cannot fracture the app.
interface RuntimeConfig {
  host?: string;
  serverUrl?: string;
}
const runtimeConfig: RuntimeConfig | undefined =
  typeof window !== "undefined"
    ? (window as unknown as { __NEUROVAULT_CONFIG__?: RuntimeConfig }).__NEUROVAULT_CONFIG__
    : undefined;

export const API_HOST: string =
  runtimeConfig?.serverUrl?.trim() ||
  (import.meta.env.VITE_API_HOST as string | undefined)?.trim() ||
  DEFAULT_API_HOST;

/** Human-readable host:port for UI display (e.g. "127.0.0.1:8765"). */
export const API_DISPLAY: string = API_HOST.replace(/^https?:\/\//, "");
