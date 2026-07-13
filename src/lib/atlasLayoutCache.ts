import {
  ATLAS_LAYOUT_ENGINE_VERSION,
  type AtlasPosition,
} from "./atlasLayoutTypes";

const CACHE_SCHEMA_VERSION = 1 as const;
const DATABASE_NAME = "neurovault-atlas-layouts";
const DATABASE_VERSION = 1;
const LAYOUT_STORE = "layouts";
const LATEST_STORE = "latest";

export interface AtlasLayoutCacheRecord {
  schemaVersion: typeof CACHE_SCHEMA_VERSION;
  engineVersion: typeof ATLAS_LAYOUT_ENGINE_VERSION;
  key: string;
  brainId: string;
  fingerprint: string;
  savedAt: number;
  positions: AtlasPosition[];
}

export type AtlasLayoutCacheWrite = Omit<
  AtlasLayoutCacheRecord,
  "schemaVersion" | "engineVersion" | "key" | "savedAt"
> & {
  savedAt?: number;
};

interface LatestLayoutPointer {
  brainId: string;
  cacheKey: string;
}

const memoryLayouts = new Map<string, AtlasLayoutCacheRecord>();
const memoryLatest = new Map<string, string>();
let databasePromise: Promise<IDBDatabase | null> | null = null;

function safeKeyPart(value: string): string {
  return encodeURIComponent(value.trim());
}

export function atlasLayoutCacheKey(brainId: string, fingerprint: string): string {
  return [
    ATLAS_LAYOUT_ENGINE_VERSION,
    safeKeyPart(brainId),
    safeKeyPart(fingerprint),
  ].join(":");
}

function isFinitePosition(value: unknown): value is AtlasPosition {
  if (value == null || typeof value !== "object") return false;
  const candidate = value as Partial<AtlasPosition>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.x === "number" &&
    Number.isFinite(candidate.x) &&
    typeof candidate.y === "number" &&
    Number.isFinite(candidate.y)
  );
}

function validatedRecord(value: unknown): AtlasLayoutCacheRecord | null {
  if (value == null || typeof value !== "object") return null;
  const candidate = value as Partial<AtlasLayoutCacheRecord>;
  if (
    candidate.schemaVersion !== CACHE_SCHEMA_VERSION ||
    candidate.engineVersion !== ATLAS_LAYOUT_ENGINE_VERSION ||
    typeof candidate.key !== "string" ||
    !candidate.key ||
    typeof candidate.brainId !== "string" ||
    !candidate.brainId ||
    typeof candidate.fingerprint !== "string" ||
    !candidate.fingerprint ||
    typeof candidate.savedAt !== "number" ||
    !Number.isFinite(candidate.savedAt) ||
    !Array.isArray(candidate.positions)
  ) {
    return null;
  }

  const seen = new Set<string>();
  const positions: AtlasPosition[] = [];
  for (const position of candidate.positions) {
    if (!isFinitePosition(position) || seen.has(position.id)) return null;
    seen.add(position.id);
    positions.push({ id: position.id, x: position.x, y: position.y });
  }

  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    engineVersion: ATLAS_LAYOUT_ENGINE_VERSION,
    key: candidate.key,
    brainId: candidate.brainId,
    fingerprint: candidate.fingerprint,
    savedAt: candidate.savedAt,
    positions,
  };
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (databasePromise) return databasePromise;
  if (typeof indexedDB === "undefined") {
    databasePromise = Promise.resolve(null);
    return databasePromise;
  }

  databasePromise = new Promise((resolve) => {
    let settled = false;
    const finish = (database: IDBDatabase | null): void => {
      if (settled) {
        database?.close();
        return;
      }
      settled = true;
      resolve(database);
    };

    try {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(LAYOUT_STORE)) {
          database.createObjectStore(LAYOUT_STORE, { keyPath: "key" });
        }
        if (!database.objectStoreNames.contains(LATEST_STORE)) {
          database.createObjectStore(LATEST_STORE, { keyPath: "brainId" });
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        finish(database);
      };
      request.onerror = () => finish(null);
      request.onblocked = () => finish(null);
    } catch {
      finish(null);
    }
  });

  return databasePromise;
}

function requestValue<T>(request: IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => resolve(null);
  });
}

async function readLayoutFromDatabase(
  database: IDBDatabase,
  key: string,
): Promise<AtlasLayoutCacheRecord | null> {
  try {
    const transaction = database.transaction(LAYOUT_STORE, "readonly");
    const value = await requestValue<unknown>(transaction.objectStore(LAYOUT_STORE).get(key));
    return validatedRecord(value);
  } catch {
    return null;
  }
}

/** Read a layout only when its graph fingerprint and engine version match. */
export async function getAtlasLayout(
  key: string,
): Promise<AtlasLayoutCacheRecord | null> {
  const memory = validatedRecord(memoryLayouts.get(key));
  if (memory) return memory;

  const database = await openDatabase();
  if (!database) return null;
  const record = await readLayoutFromDatabase(database, key);
  if (record) memoryLayouts.set(record.key, record);
  return record;
}

/**
 * Return the newest saved layout for a brain, even if the graph fingerprint
 * changed. Callers should reuse only intersecting node ids as warm seeds.
 */
export async function getLatestAtlasLayout(
  brainId: string,
): Promise<AtlasLayoutCacheRecord | null> {
  const memoryKey = memoryLatest.get(brainId);
  if (memoryKey) {
    const memory = validatedRecord(memoryLayouts.get(memoryKey));
    if (memory) return memory;
  }

  const database = await openDatabase();
  if (!database) return null;

  try {
    const transaction = database.transaction(LATEST_STORE, "readonly");
    const value = await requestValue<unknown>(transaction.objectStore(LATEST_STORE).get(brainId));
    if (value == null || typeof value !== "object") return null;
    const pointer = value as Partial<LatestLayoutPointer>;
    if (pointer.brainId !== brainId || typeof pointer.cacheKey !== "string") return null;
    const record = await readLayoutFromDatabase(database, pointer.cacheKey);
    if (record) {
      memoryLayouts.set(record.key, record);
      memoryLatest.set(brainId, record.key);
    }
    return record;
  } catch {
    return null;
  }
}

/** Save atomically enough that a latest pointer can never precede its layout. */
export async function putAtlasLayout(
  key: string,
  input: AtlasLayoutCacheWrite,
): Promise<AtlasLayoutCacheRecord | null> {
  const record = validatedRecord({
    ...input,
    key,
    schemaVersion: CACHE_SCHEMA_VERSION,
    engineVersion: ATLAS_LAYOUT_ENGINE_VERSION,
    savedAt: input.savedAt ?? Date.now(),
  });
  if (!record) return null;

  memoryLayouts.set(record.key, record);
  memoryLatest.set(record.brainId, record.key);

  const database = await openDatabase();
  if (!database) return record;

  try {
    await new Promise<void>((resolve) => {
      const transaction = database.transaction([LAYOUT_STORE, LATEST_STORE], "readwrite");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
      transaction.objectStore(LAYOUT_STORE).put(record);
      transaction.objectStore(LATEST_STORE).put({
        brainId: record.brainId,
        cacheKey: record.key,
      } satisfies LatestLayoutPointer);
    });
  } catch {
    // The in-memory cache remains valid for this app session.
  }
  return record;
}

export function atlasPositionsById(
  record: Pick<AtlasLayoutCacheRecord, "positions"> | null,
): ReadonlyMap<string, AtlasPosition> {
  const positions = new Map<string, AtlasPosition>();
  for (const position of record?.positions ?? []) {
    if (isFinitePosition(position)) positions.set(position.id, position);
  }
  return positions;
}
