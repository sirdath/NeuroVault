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

import { API_HOST } from "./config";
const HTTP_BASE = API_HOST;

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

/** Phase-5 integration: these three helpers try the `nv_*` commands
 *  first (which run the full ingest pipeline — chunk, embed,
 *  entities, links, BM25) and fall back to the legacy file-only
 *  commands if nv_* isn't registered on the installed Tauri build.
 *  That way an older installer paired with a newer frontend keeps
 *  working — the legacy path still writes the file; the next boot
 *  that brings Python up (or the eventual Rust upgrade) will index
 *  it.
 *
 *  Callers treat this as "save and have it indexed" — they don't
 *  need to know which path ran. */

export const saveNote = async (filename: string, content: string) => {
  if (!IS_TAURI) throw new Error("save_note requires Tauri runtime");
  try {
    await invoke<NvWriteResult>("nv_save_note", {
      filename,
      content,
      brainId: null,
    });
  } catch {
    await invoke<void>("save_note", { filename, content });
  }
};

export const createNote = async (title: string): Promise<string> => {
  if (!IS_TAURI) throw new Error("create_note requires Tauri runtime");
  try {
    const res = await invoke<NvWriteResult>("nv_create_note", {
      title,
      brainId: null,
    });
    return res.filename;
  } catch {
    return await invoke<string>("create_note", { title });
  }
};

export const deleteNote = async (filename: string) => {
  if (!IS_TAURI) throw new Error("delete_note requires Tauri runtime");
  try {
    await invoke<NvWriteResult>("nv_delete_note", {
      filename,
      brainId: null,
    });
  } catch {
    await invoke<void>("delete_note", { filename });
  }
};

// --- Phase-4 Rust memory commands ------------------------------------------
//
// These call into the Rust `memory::read_ops` layer. They exist so the
// frontend can read notes / graph / brain list without the Python sidecar
// running. Each helper rejects in browser-mode so callers can feature-
// detect via a try/catch and fall back to the HTTP layer transparently
// (`api.ts::fetchGraph` etc. already do).
//
// We deliberately **don't** probe which handlers the running Tauri build
// exposes. On versions compiled before Phase 4, invoking `nv_*` raises
// "command ... not registered" — a standard Error that api.ts catches and
// routes to HTTP instead. That keeps the upgrade story: an older installed
// app paired with a newer Python server keeps working; a newer installed
// app ditches Python.
//
// `IS_TAURI` check stays — outside Tauri we never try these.

export interface NvNoteListRow {
  id: string;
  filename: string;
  title: string;
  state: string;
  strength: number;
  access_count: number;
  updated_at: string;
}

export interface NvConnection {
  engram_id: string;
  title: string;
  similarity: number;
  link_type: string;
}

export interface NvEntityRef {
  name: string;
  type: string;
}

/** Full note detail. Flattened engram columns + connections + entities.
 *  The engram columns (id, filename, title, content, …) appear at the
 *  top level; connections and entities are separate arrays. Matches the
 *  exact shape `GET /api/notes/{id}` returns on the Python side. */
export interface NvFullNote {
  id: string;
  filename: string;
  title: string;
  content: string;
  state: string;
  strength: number;
  access_count: number;
  connections: NvConnection[];
  entities: NvEntityRef[];
  [extra: string]: unknown;
}

export interface NvBrainStats {
  brain_id: string;
  note_count: number;
  markdown_bytes: number;
  db_bytes: number;
  total_bytes: number;
  vault_path: string;
  is_external: boolean;
}

export interface NvBrainSummary {
  id: string;
  name: string;
  description: string | null;
  vault_path: string | null;
  is_active: boolean;
  stats: NvBrainStats;
}

export interface NvGraphNode {
  id: string;
  title: string;
  state: string;
  strength: number;
  access_count: number;
  folder?: string | null;
}

export interface NvGraphEdge {
  from: string;
  to: string;
  similarity: number;
  link_type: string;
}

export interface NvGraphData {
  nodes: NvGraphNode[];
  edges: NvGraphEdge[];
}

const nvReject = (cmd: string) =>
  Promise.reject(new Error(`${cmd} requires Tauri runtime`));

export const nvListNotes = (brainId?: string) =>
  IS_TAURI
    ? invoke<NvNoteListRow[]>("nv_list_notes", { brainId: brainId ?? null })
    : nvReject("nv_list_notes");

export const nvGetNote = (engramId: string, brainId?: string) =>
  IS_TAURI
    ? invoke<NvFullNote>("nv_get_note", { engramId, brainId: brainId ?? null })
    : nvReject("nv_get_note");

export const nvListBrains = () =>
  IS_TAURI ? invoke<NvBrainSummary[]>("nv_list_brains") : nvReject("nv_list_brains");

export const nvBrainStats = (brainId: string) =>
  IS_TAURI ? invoke<NvBrainStats>("nv_brain_stats", { brainId }) : nvReject("nv_brain_stats");

export const nvGetGraph = (opts?: {
  brainId?: string;
  includeObservations?: boolean;
  minSimilarity?: number;
}) =>
  IS_TAURI
    ? invoke<NvGraphData>("nv_get_graph", {
        brainId: opts?.brainId ?? null,
        includeObservations: opts?.includeObservations ?? null,
        minSimilarity: opts?.minSimilarity ?? null,
      })
    : nvReject("nv_get_graph");

// --- Phase-5 write-path: full ingest pipeline (chunk/embed/link/BM25) ---

export interface NvWriteResult {
  engram_id: string;
  filename: string;
  brain_id: string;
  /** "created" | "updated" | "unchanged" | "deleted". "unchanged"
   *  means the file was written but the content hash matched so
   *  ingest was a no-op. */
  status: string;
}

export const nvSaveNote = (filename: string, content: string, brainId?: string) =>
  IS_TAURI
    ? invoke<NvWriteResult>("nv_save_note", {
        filename,
        content,
        brainId: brainId ?? null,
      })
    : nvReject("nv_save_note");

export const nvCreateNote = (title: string, brainId?: string) =>
  IS_TAURI
    ? invoke<NvWriteResult>("nv_create_note", {
        title,
        brainId: brainId ?? null,
      })
    : nvReject("nv_create_note");

export const nvDeleteNote = (filename: string, brainId?: string) =>
  IS_TAURI
    ? invoke<NvWriteResult>("nv_delete_note", {
        filename,
        brainId: brainId ?? null,
      })
    : nvReject("nv_delete_note");

// --- Phase-6 recall + Rust HTTP server --------------------------------------

export interface NvRecallHit {
  engram_id: string;
  title: string;
  content: string;
  score: number;
  strength: number;
  state: string;
}

export const nvRecall = (
  query: string,
  opts?: {
    brainId?: string;
    limit?: number;
    spreadHops?: number;
    includeObservations?: boolean;
    asOf?: string;
  }
) =>
  IS_TAURI
    ? invoke<NvRecallHit[]>("nv_recall", {
        query,
        brainId: opts?.brainId ?? null,
        limit: opts?.limit ?? null,
        spreadHops: opts?.spreadHops ?? null,
        includeObservations: opts?.includeObservations ?? null,
        asOf: opts?.asOf ?? null,
      })
    : nvReject("nv_recall");

/** Push PageRank scores into Rust in-process state. Retriever applies
 *  a `1 + 0.15 * ln(1 + score)` boost during recall when state is
 *  non-empty for the active brain. Frontend calls this on Analytics-
 *  mode enable + on any subsequent graph data change; passes an
 *  empty object to clear scores when Analytics mode is disabled,
 *  restoring identical recall to pre-G7 baseline. */
export const nvSetPagerank = (
  scores: Record<string, number>,
  brainId?: string
) =>
  IS_TAURI
    ? invoke<void>("nv_set_pagerank", {
        scores,
        brainId: brainId ?? null,
      }).catch(() => {
        // Non-fatal: PageRank is a quality boost, not a correctness
        // requirement. If the Tauri command isn't registered (older
        // build) or the brain isn't open, recall just falls back to
        // the un-boosted RRF — same as before G7.
      })
    : Promise.resolve();

/** Start/stop the in-process Rust HTTP server on 127.0.0.1:8765.
 *  Exposes the same `/api/*` surface the Python sidecar did so the
 *  MCP proxy keeps working without config changes. Only one of
 *  Python or Rust can own the port at a time — the Settings panel
 *  should call `nv_stop_rust_server` before spawning the Python
 *  sidecar (or vice versa). */
export const nvStartRustServer = (port?: number) =>
  IS_TAURI
    ? invoke<string>("nv_start_rust_server", { port: port ?? null })
    : nvReject("nv_start_rust_server");

export const nvStopRustServer = () =>
  IS_TAURI ? invoke<void>("nv_stop_rust_server") : nvReject("nv_stop_rust_server");

// --- Phase-8 run-python-job --------------------------------------------------
//
// Bridge to advanced features that stay in Python (compile, pdf
// ingest, zotero, code graph, drafts export). Each job spawns a
// fresh `python -m neurovault_server <name>` subprocess, feeds it
// `argsJson` on stdin, captures the stdout JSON + stderr log lines,
// and returns the parsed result. No persistent daemon.

export interface PythonJobResult<T = unknown> {
  ok: boolean;
  exit_code: number;
  /** The JSON payload the CLI module printed to stdout. `null` when
   *  the job printed nothing (or wasn't expected to). */
  data: T | null;
  /** loguru output + any Python tracebacks captured from stderr.
   *  Surface this to the user on non-OK exits so they see the real
   *  error instead of a generic "python failed". */
  stderr: string;
}

export const runPythonJob = <T = unknown>(
  jobName: string,
  argsJson?: unknown,
  timeoutSecs?: number
) =>
  IS_TAURI
    ? invoke<PythonJobResult<T>>("run_python_job", {
        jobName,
        argsJson: argsJson ?? null,
        timeoutSecs: timeoutSecs ?? null,
      })
    : nvReject("run_python_job");
