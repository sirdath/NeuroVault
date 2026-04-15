import { invoke } from "@tauri-apps/api/core";

export interface NoteMeta {
  filename: string;
  title: string;
  modified: number;
  size: number;
}

/**
 * Runtime detection: are we inside Tauri's webview, or a plain browser?
 *
 * Tauri injects `window.__TAURI_INTERNALS__` before our JS runs, so its
 * presence is the canonical "we can call invoke()" check. In a plain
 * browser (Vite dev server opened in Chrome, or a statically-served
 * build), it's absent — in that case we fall back to the Python server's
 * HTTP API for the two read paths the UI needs to render (list + read).
 *
 * The point of the fallback is purely to make screenshot/preview workflows
 * work outside Tauri. Writes (save, create, delete) still require Tauri —
 * they're no-ops in browser mode and would need server-side wiring if we
 * ever wanted a full web deploy.
 */
const IS_TAURI =
  typeof window !== "undefined" &&
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== undefined;

const HTTP_BASE = "http://127.0.0.1:8765";

// --- HTTP fallback helpers (browser-only) --------------------------------

interface ApiNote {
  id: string;
  filename: string;
  title: string;
  updated_at?: string;
  modified?: number;
  size?: number;
}

async function httpListNotes(): Promise<NoteMeta[]> {
  const res = await fetch(`${HTTP_BASE}/api/notes`);
  if (!res.ok) throw new Error(`list_notes HTTP ${res.status}`);
  const notes = (await res.json()) as ApiNote[];
  return notes.map((n) => ({
    filename: n.filename,
    title: n.title,
    modified: n.modified ?? (n.updated_at ? Date.parse(n.updated_at) / 1000 : 0),
    size: n.size ?? 0,
  }));
}

async function httpReadNote(filename: string): Promise<string> {
  // The API's per-note endpoint is keyed on engram id, not filename, so
  // we list first and resolve filename -> id. List is cheap (one query)
  // and the browser-mode fallback is intentionally not hot-path.
  const listRes = await fetch(`${HTTP_BASE}/api/notes`);
  if (!listRes.ok) throw new Error(`list_notes HTTP ${listRes.status}`);
  const all = (await listRes.json()) as ApiNote[];
  const match = all.find((n) => n.filename === filename);
  if (!match) throw new Error(`note not found: ${filename}`);

  const noteRes = await fetch(`${HTTP_BASE}/api/notes/${match.id}`);
  if (!noteRes.ok) throw new Error(`read_note HTTP ${noteRes.status}`);
  const detail = (await noteRes.json()) as { content?: string };
  return detail.content ?? "";
}

// --- Exports --------------------------------------------------------------

export const getVaultPath = () =>
  IS_TAURI
    ? invoke<string>("get_vault_path")
    : Promise.resolve("~/.neurovault/brains/default/vault");

export const listNotes = () =>
  IS_TAURI ? invoke<NoteMeta[]>("list_notes") : httpListNotes();

export const readNote = (filename: string) =>
  IS_TAURI ? invoke<string>("read_note", { filename }) : httpReadNote(filename);

export const saveNote = (filename: string, content: string) =>
  IS_TAURI
    ? invoke<void>("save_note", { filename, content })
    : Promise.reject(new Error("save_note requires Tauri runtime"));

export const createNote = (title: string) =>
  IS_TAURI
    ? invoke<string>("create_note", { title })
    : Promise.reject(new Error("create_note requires Tauri runtime"));

export const deleteNote = (filename: string) =>
  IS_TAURI
    ? invoke<void>("delete_note", { filename })
    : Promise.reject(new Error("delete_note requires Tauri runtime"));
