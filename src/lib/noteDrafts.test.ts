import {
  clearNoteDraftIfContentMatches,
  noteDraftKey,
  readNoteDraft,
  writeNoteDraft,
  type DraftStorage,
} from "./noteDrafts";

let failures = 0;
const ok = (label: string, condition: boolean) => {
  if (condition) console.log(`ok    ${label}`);
  else { failures += 1; console.log(`FAIL  ${label}`); }
};

const values = new Map<string, string>();
const storage: DraftStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => { values.set(key, value); },
  removeItem: (key) => { values.delete(key); },
};

ok("draft keys are vault-scoped", noteDraftKey("alpha", "same.md") !== noteDraftKey("beta", "same.md"));
ok("a valid draft is written", writeNoteDraft(storage, "alpha", "same.md", "newer", 42));
ok("another vault cannot read it", readNoteDraft(storage, "beta", "same.md") === null);
ok("the matching vault can recover it", readNoteDraft(storage, "alpha", "same.md")?.content === "newer");
clearNoteDraftIfContentMatches(storage, "alpha", "same.md", "older");
ok("a stale disk write cannot clear a newer draft", readNoteDraft(storage, "alpha", "same.md")?.content === "newer");
clearNoteDraftIfContentMatches(storage, "alpha", "same.md", "newer");
ok("the persisted revision clears its draft", readNoteDraft(storage, "alpha", "same.md") === null);
ok("oversized buffers fail safely", !writeNoteDraft(storage, "alpha", "huge.md", "x".repeat(2_000_001)));

if (failures) throw new Error(`${failures} draft test failure(s)`);
console.log("noteDrafts: all checks passed");
