import { invoke } from "@tauri-apps/api/core";

export interface NoteMeta {
  filename: string;
  title: string;
  modified: number;
  size: number;
}

export interface TrashEntry {
  trashed_filename: string;
  original_filename: string;
  title: string;
  deleted_at: number;
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

async function httpListNotes(brainId?: string | null): Promise<NoteMeta[]> {
  const query = brainId ? `?brain=${encodeURIComponent(brainId)}` : "";
  const res = await fetch(`${HTTP_BASE}/api/notes${query}`);
  if (!res.ok) throw new Error(`list_notes HTTP ${res.status}`);
  const notes = (await res.json()) as ApiNote[];
  return notes.map((n) => ({
    filename: n.filename,
    title: n.title,
    modified: n.modified ?? (n.updated_at ? Date.parse(n.updated_at) / 1000 : 0),
    size: n.size ?? 0,
  }));
}

async function httpReadNote(filename: string, brainId?: string | null): Promise<string> {
  // The API's per-note endpoint is keyed on engram id, not filename, so
  // we list first and resolve filename -> id. List is cheap (one query)
  // and the browser-mode fallback is intentionally not hot-path.
  const query = brainId ? `?brain=${encodeURIComponent(brainId)}` : "";
  const listRes = await fetch(`${HTTP_BASE}/api/notes${query}`);
  if (!listRes.ok) throw new Error(`list_notes HTTP ${listRes.status}`);
  const all = (await listRes.json()) as ApiNote[];
  const match = all.find((n) => n.filename === filename);
  if (!match) throw new Error(`note not found: ${filename}`);

  const noteRes = await fetch(`${HTTP_BASE}/api/notes/${match.id}${query}`);
  if (!noteRes.ok) throw new Error(`read_note HTTP ${noteRes.status}`);
  const detail = (await noteRes.json()) as { content?: string };
  return detail.content ?? "";
}

// --- Generic HTTP helpers used by every nv_* fallback below -----------

async function httpJsonGet<T>(path: string, query?: Record<string, unknown>): Promise<T> {
  let url = `${HTTP_BASE}${path}`;
  if (query) {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      sp.set(k, String(v));
    }
    const qs = sp.toString();
    if (qs) url += (url.includes("?") ? "&" : "?") + qs;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function httpJsonSend<T>(
  path: string,
  method: "POST" | "PUT" | "DELETE" | "PATCH",
  body: unknown,
): Promise<T> {
  const res = await fetch(`${HTTP_BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${path} HTTP ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

// --- Exports --------------------------------------------------------------

export const getVaultPath = (brainId?: string | null) =>
  IS_TAURI
    ? invoke<string>("get_vault_path", { brainId: brainId ?? null })
    : Promise.resolve("~/.neurovault/brains/default/vault");

export const listNotes = (brainId?: string | null) =>
  IS_TAURI ? invoke<NoteMeta[]>("list_notes", { brainId: brainId ?? null }) : httpListNotes(brainId);

export const readNote = (filename: string, brainId?: string | null) =>
  IS_TAURI
    ? invoke<string>("read_note", { filename, brainId: brainId ?? null })
    : httpReadNote(filename, brainId);

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

function isMissingTauriCommand(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unknown command|command .* not found|not registered/i.test(message);
}

export const saveNote = async (filename: string, content: string, brainId?: string | null) => {
  if (IS_TAURI) {
    try {
      await invoke<NvWriteResult>("nv_save_note", { filename, content, brainId: brainId ?? null });
    } catch (error) {
      if (!isMissingTauriCommand(error)) throw error;
      await invoke<void>("save_note", { filename, content });
    }
    return;
  }
  await httpJsonSend<NvWriteResult>("/api/notes", "PUT", { filename, content, brain: brainId });
};

export const createNote = async (title: string, brainId?: string | null): Promise<string> => {
  if (IS_TAURI) {
    try {
      const res = await invoke<NvWriteResult>("nv_create_note", { title, brainId: brainId ?? null });
      return res.filename;
    } catch (error) {
      if (!isMissingTauriCommand(error)) throw error;
      return await invoke<string>("create_note", { title });
    }
  }
  // POST /api/notes (the `remember` endpoint) generates the filename.
  // Seed the body with the same `# {title}\n\n` shape that
  // write_ops::create_note uses so the title is captured even when
  // the user has not yet typed any body.
  const seed = `# ${title}\n\n`;
  const res = await httpJsonSend<NvWriteResult & { filename?: string }>(
    "/api/notes",
    "POST",
    { title, content: seed, brain: brainId },
  );
  return res.filename ?? "";
};

export const deleteNote = async (filename: string, brainId?: string | null) => {
  if (IS_TAURI) {
    try {
      await invoke<NvWriteResult>("nv_delete_note", { filename, brainId: brainId ?? null });
    } catch (error) {
      if (!isMissingTauriCommand(error)) throw error;
      await invoke<void>("delete_note", { filename });
    }
    return;
  }
  await httpJsonSend<NvWriteResult>("/api/notes", "DELETE", { filename, brain: brainId });
};

export const listTrash = async (brainId?: string | null): Promise<TrashEntry[]> => {
  if (!IS_TAURI) return [];
  return invoke<TrashEntry[]>("nv_list_trash", { brainId: brainId ?? null });
};

export const restoreNote = async (trashedFilename: string, brainId?: string | null): Promise<NvWriteResult> => {
  if (!IS_TAURI) throw new Error("Restore is available in the NeuroVault desktop app.");
  return invoke<NvWriteResult>("nv_restore_note", { trashedFilename, brainId: brainId ?? null });
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
    : httpJsonGet<NvNoteListRow[]>("/api/notes", { brain: brainId });

export const nvGetNote = (engramId: string, brainId?: string) =>
  IS_TAURI
    ? invoke<NvFullNote>("nv_get_note", { engramId, brainId: brainId ?? null })
    : httpJsonGet<NvFullNote>(`/api/notes/${encodeURIComponent(engramId)}`, {
        brain: brainId,
      });

export const nvListBrains = () =>
  IS_TAURI
    ? invoke<NvBrainSummary[]>("nv_list_brains")
    : httpJsonGet<NvBrainSummary[]>("/api/brains");

export const nvBrainStats = (brainId: string) =>
  IS_TAURI
    ? invoke<NvBrainStats>("nv_brain_stats", { brainId })
    : httpJsonGet<NvBrainStats>(`/api/brains/${encodeURIComponent(brainId)}/stats`);

export const nvGetGraph = (opts?: {
  brainId?: string;
  includeObservations?: boolean;
  minSimilarity?: number;
  /** link_types to drop server-side (e.g. ["semantic"]) so a low-power view
   *  never transfers / simulates the semantic hairball. */
  excludeTypes?: string[];
}) => {
  const excludeCsv =
    opts?.excludeTypes && opts.excludeTypes.length
      ? opts.excludeTypes.join(",")
      : undefined;
  return IS_TAURI
    ? invoke<NvGraphData>("nv_get_graph", {
        brainId: opts?.brainId ?? null,
        includeObservations: opts?.includeObservations ?? null,
        minSimilarity: opts?.minSimilarity ?? null,
        excludeTypes: opts?.excludeTypes ?? null,
      })
    : httpJsonGet<NvGraphData>("/api/graph", {
        brain: opts?.brainId,
        include_observations: opts?.includeObservations,
        min_similarity: opts?.minSimilarity,
        exclude_types: excludeCsv,
      });
};

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
    : httpJsonSend<NvWriteResult>("/api/notes", "PUT", {
        filename,
        content,
        brain: brainId,
      });

export const nvCreateNote = (title: string, brainId?: string) =>
  IS_TAURI
    ? invoke<NvWriteResult>("nv_create_note", {
        title,
        brainId: brainId ?? null,
      })
    : httpJsonSend<NvWriteResult>("/api/notes", "POST", {
        title,
        content: `# ${title}\n\n`,
        brain: brainId,
      });

export const nvDeleteNote = (filename: string, brainId?: string) =>
  IS_TAURI
    ? invoke<NvWriteResult>("nv_delete_note", {
        filename,
        brainId: brainId ?? null,
      })
    : httpJsonSend<NvWriteResult>("/api/notes", "DELETE", {
        filename,
        brain: brainId,
      });

// --- Drop-folder inbox ------------------------------------------------------

export interface NvInboxFile {
  name: string;
  size: number;
  ext: string;
  path: string;
}

/** Copy dropped files (absolute paths from the webview file-drop event)
 *  into the active brain's inbox for the connected agent to process.
 *  Tauri-only — the browser fallback has no path-based file access, so
 *  it resolves to an empty list. Returns the names that landed. */
export const nvInboxAdd = (paths: string[], brainId?: string): Promise<string[]> =>
  IS_TAURI
    ? invoke<string[]>("nv_inbox_add", { paths, brainId: brainId ?? null })
    : Promise.resolve([]);

/** List files currently waiting in the active brain's inbox. */
export const nvInboxList = (brainId?: string): Promise<NvInboxFile[]> =>
  IS_TAURI
    ? invoke<NvInboxFile[]>("nv_inbox_list", { brainId: brainId ?? null })
    : Promise.resolve([]);

// --- Brain diagnostic -------------------------------------------------------

export interface NvDiagCategory { key: string; label: string; score: number; detail: string }
export interface NvDiagIssue { label: string; count: number; severity: string }
export interface NvDiagnosticReport {
  grade: string;
  score: number;
  total: number;
  categories: NvDiagCategory[];
  issues: NvDiagIssue[];
}

/** Brain health scorecard. DB-backed (sees dormant notes), so it's the
 *  authoritative report; the UI falls back to a client-side estimate from
 *  the loaded graph if this fails (e.g. server still booting). */
export const nvDiagnose = (brainId?: string): Promise<NvDiagnosticReport> =>
  IS_TAURI
    ? invoke<NvDiagnosticReport>("nv_diagnose", { brainId: brainId ?? null })
    : httpJsonGet<NvDiagnosticReport>("/api/diagnostic", { brain: brainId });

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
    : httpJsonGet<NvRecallHit[]>("/api/recall", {
        q: query,
        brain: opts?.brainId,
        limit: opts?.limit,
        spread_hops: opts?.spreadHops,
        include_observations: opts?.includeObservations,
        as_of: opts?.asOf,
      });

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

/** Cluster summary the frontend pushes for the agent-driven
 *  /name-clusters skill to consume. Mirrors the Rust ClusterSummary
 *  struct in src-tauri/src/memory/cluster_state.rs. */
export interface NvClusterSummary {
  id: number;
  size: number;
  top_titles: string[];
  sample_links: string[];
}

/** Push Louvain cluster summaries into Rust in-process state. The
 *  Rust HTTP server exposes them via GET /api/clusters; the
 *  /name-clusters MCP skill reads them and proposes names. Pass
 *  an empty array to clear (called when Analytics mode is disabled).
 *  Fails open like nvSetPagerank — never breaks the UI if the
 *  command is unregistered (older build, web mode, etc). */
export const nvSetClusters = (
  clusters: NvClusterSummary[],
  brainId?: string
) =>
  IS_TAURI
    ? invoke<void>("nv_set_clusters", {
        clusters,
        brainId: brainId ?? null,
      }).catch(() => {
        /* fail open */
      })
    : Promise.resolve();

/** Read cluster names persisted under
 *  ~/.neurovault/brains/{id}/cluster_names.json. Frontend reads on
 *  graph load + after the agent's /name-clusters run, so the
 *  Analytics view can display "API design" instead of "Cluster 3". */
export const nvGetClusterNames = async (
  brainId?: string
): Promise<Record<string, string>> => {
  if (!IS_TAURI) return {};
  try {
    return await invoke<Record<string, string>>("nv_get_cluster_names", {
      brainId: brainId ?? null,
    });
  } catch {
    return {};
  }
};

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

// `runPythonJob` was removed 2026-05-16 with the Python server. No
// React component called it. If you need an out-of-process tool
// again, expose a specific Tauri command rather than the generic
// "run any python module" surface.
