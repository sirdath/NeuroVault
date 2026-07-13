import { NoteDurabilityQueue, type NoteSaveSnapshot } from "./noteDurability";
import {
  brainUiScope,
  loadScopedTabOrder,
  mergeScopedPreviews,
  persistScopedTabOrder,
  previewsForScope,
  scopedStorageKey,
  type StorageLike,
} from "./brainScopedUiState";
import { LatestRequestGate } from "./latestRequest";

let failures = 0;
function ok(label: string, condition: boolean, detail = "assertion failed"): void {
  if (condition) console.log(`ok    ${label}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}\n   ${detail}`);
  }
}

function equal(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(label, a === e, `actual: ${a}\n   expected: ${e}`);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("condition did not become true");
}

// A revision typed while save #1 is in flight must become save #2 before the
// barrier resolves. Concurrent flush callers share one serial queue.
{
  const state: {
    filename: string;
    content: string;
    revision: number;
    dirty: boolean;
    failed: string | null;
  } = { filename: "note.md", content: "one", revision: 1, dirty: true, failed: null };
  const writes: NoteSaveSnapshot[] = [];
  let releaseFirst: (() => void) | null = null;
  let activeWrites = 0;
  let maxActiveWrites = 0;

  const queue = new NoteDurabilityQueue({
    getSnapshot: () => state.dirty ? {
      filename: state.filename,
      content: state.content,
      revision: state.revision,
    } : null,
    write: async (snapshot) => {
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      writes.push(snapshot);
      if (writes.length === 1) {
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
      }
      activeWrites -= 1;
    },
    onSaving: () => undefined,
    onPersisted: (snapshot) => {
      if (state.filename === snapshot.filename && state.revision === snapshot.revision) {
        state.dirty = false;
      }
    },
    onFailed: (_snapshot, error) => { state.failed = error; },
  });

  const firstBarrier = queue.flush();
  await waitFor(() => writes.length === 1);
  state.content = "two";
  state.revision = 2;
  state.dirty = true;
  const secondBarrier = queue.flush();
  const release = releaseFirst as (() => void) | null;
  if (!release) throw new Error("first write never exposed its release callback");
  release();
  const [first, second] = await Promise.all([firstBarrier, secondBarrier]);

  equal("durability — in-flight edit is persisted as the next revision", writes.map((write) => write.content), ["one", "two"]);
  ok("durability — all writes are serialized", maxActiveWrites === 1, `max active writes: ${maxActiveWrites}`);
  ok("durability — first barrier drains through the newest revision", first.ok && first.writes === 2);
  ok("durability — queued second barrier sees a clean buffer", second.ok && second.writes === 0);
  ok("durability — newest revision is clean only after persistence", !state.dirty);
}

// Failure retains the buffer and a later retry uses the same serialized path.
{
  let dirty = true;
  let attempts = 0;
  let failed = "";
  const queue = new NoteDurabilityQueue({
    getSnapshot: () => dirty ? { filename: "retry.md", content: "safe", revision: 1 } : null,
    write: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("disk full");
    },
    onSaving: () => undefined,
    onPersisted: () => { dirty = false; },
    onFailed: (_snapshot, error) => { failed = error; },
  });
  const first = await queue.flush();
  ok("durability — failed save does not clear dirty", !first.ok && dirty);
  equal("durability — failure reason is retained", failed, "disk full");
  const retry = await queue.flush();
  ok("durability — retry succeeds and clears dirty", retry.ok && !dirty && attempts === 2);
}

// Tab, folder, width, and preview state use brain-specific namespaces.
{
  const values = new Map<string, string>();
  const storage: StorageLike = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
  const alpha = brainUiScope("alpha");
  const beta = brainUiScope("beta");
  persistScopedTabOrder(storage, alpha, ["shared.md", "alpha.md"]);
  persistScopedTabOrder(storage, beta, ["shared.md", "beta.md"]);
  equal("isolation — tab order is brain-scoped", loadScopedTabOrder(storage, alpha), ["shared.md", "alpha.md"]);
  equal("isolation — same filename cannot merge another brain's tabs", loadScopedTabOrder(storage, beta), ["shared.md", "beta.md"]);
  ok("isolation — folder state keys differ", scopedStorageKey("nv.folders.expanded", alpha) !== scopedStorageKey("nv.folders.expanded", beta));
  ok("isolation — sidebar width keys differ", scopedStorageKey("nv.sidebar.width", alpha) !== scopedStorageKey("nv.sidebar.width", beta));

  let cache = mergeScopedPreviews({}, alpha, { "shared.md": "alpha secret" });
  ok("isolation — alpha preview is absent from beta", previewsForScope(cache, beta)["shared.md"] === undefined);
  cache = mergeScopedPreviews(cache, beta, { "shared.md": "beta secret" });
  equal("isolation — same filename retains alpha preview", previewsForScope(cache, alpha)["shared.md"], "alpha secret");
  equal("isolation — same filename retains beta preview", previewsForScope(cache, beta)["shared.md"], "beta secret");
}

// The result gate used by note-list loading and recall only accepts the latest
// request, including A -> B -> A query sequences.
{
  const gate = new LatestRequestGate();
  const firstA = gate.begin();
  const b = gate.begin();
  const secondA = gate.begin();
  ok("requests — first A is stale after A/B/A", !gate.isCurrent(firstA));
  ok("requests — B is stale after A/B/A", !gate.isCurrent(b));
  ok("requests — newest A remains current", gate.isCurrent(secondA));
  gate.invalidate();
  ok("requests — brain switch invalidates outstanding result", !gate.isCurrent(secondA));
}

console.log("");
if (failures > 0) throw new Error(`${failures} durability/isolation test failure(s)`);
console.log("all green");
