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
