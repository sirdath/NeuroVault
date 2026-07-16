/** Utilities shared by every graph renderer so "Save image" always means
 * a PNG of the visualization. Style/data JSON exports use separate labels. */

import type { Camera, Scene, WebGLRenderer } from "three";

/**
 * Interactive WebGL should not retain every completed frame. Keeping the
 * drawing buffer alive increases GPU memory/bandwidth use for the entire 3D
 * session, while exports only need a readable buffer for one explicit frame.
 */
export const INTERACTIVE_WEBGL_RENDERER_CONFIG = Object.freeze({
  antialias: true,
  alpha: false,
  preserveDrawingBuffer: false,
});

export interface ThreeGraphCaptureTarget {
  renderer: () => Pick<WebGLRenderer, "domElement" | "render">;
  scene: () => Scene;
  camera: () => Camera;
}

export function graphImageFilename(now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `neurovault-graph-${stamp}.png`;
}

export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("The graph canvas could not be encoded as a PNG."));
    }, "image/png");
  });
}

/**
 * Encode a canvas onto an opaque background.
 *
 * The 2D graph renders with `backgroundColor="rgba(0,0,0,0)"` and gets its dark
 * backdrop from CSS on the container — which `canvas.toBlob()` cannot see. The
 * exported PNG was therefore fully transparent, so every dark node fill and
 * label turned invisible the moment it was pasted onto a light background
 * (Slack, Docs, Keynote). That was the default mode's Save/Copy image.
 *
 * Compositing here rather than making the live canvas opaque keeps on-screen
 * rendering byte-identical; only the exported image changes.
 */
export function canvasToPngBlobWithBackground(
  canvas: HTMLCanvasElement,
  background: string,
): Promise<Blob> {
  const out = document.createElement("canvas");
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext("2d");
  if (!ctx) return canvasToPngBlob(canvas);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, 0, 0);
  return canvasToPngBlob(out);
}

/**
 * Render one fresh frame immediately before encoding a 3D graph. This keeps
 * normal interaction on the cheaper non-preserved WebGL buffer without
 * turning Save/Copy image into a blank canvas.
 */
export function renderThreeGraphToPng(target: ThreeGraphCaptureTarget): Promise<Blob> {
  const renderer = target.renderer();
  renderer.render(target.scene(), target.camera());
  return canvasToPngBlob(renderer.domElement);
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export async function copyPngToClipboard(blob: Blob): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("Copy image is not supported on this version of macOS.");
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}
