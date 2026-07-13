import { canvasToPngBlob, graphImageFilename } from "./graphExport";

let failures = 0;
function equal(label: string, actual: unknown, expected: unknown): void {
  if (actual === expected) console.log(`ok    ${label}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}\n   actual: ${String(actual)}\n   expected: ${String(expected)}`);
  }
}

equal(
  "filename is stable and filesystem-safe",
  graphImageFilename(new Date("2026-07-13T18:42:07.123Z")),
  "neurovault-graph-2026-07-13T18-42-07.png",
);

const png = new Blob(["png"], { type: "image/png" });
let requestedType = "";
const goodCanvas = {
  toBlob(callback: (blob: Blob | null) => void, type?: string) {
    requestedType = type ?? "";
    callback(png);
  },
} as HTMLCanvasElement;
equal("canvas returns the encoded blob", await canvasToPngBlob(goodCanvas), png);
equal("canvas requests PNG encoding", requestedType, "image/png");

const emptyCanvas = {
  toBlob(callback: (blob: Blob | null) => void) { callback(null); },
} as HTMLCanvasElement;
let rejected = false;
try { await canvasToPngBlob(emptyCanvas); } catch { rejected = true; }
equal("empty canvas rejects instead of downloading a blank file", rejected, true);

if (failures > 0) throw new Error(`${failures} graph export test(s) failed`);
console.log("graph export tests passed");
