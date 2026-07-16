/**
 * Persistent text labels for the fixed 3D snapshot.
 *
 * Why this exists: react-force-graph-3d's `nodeLabel` is a *hover tooltip*, not
 * a label. The 3D snapshot passed the same `nodeLabel` for both Names=Key and
 * Names=All, so the two settings were byte-identical props and "All" rendered
 * zero labels until the pointer touched a node -- nothing like Names=All in 2D
 * or the Engine. Persistent 3D text needs a real Object3D, which is what this
 * builds.
 *
 * Sprites (not meshes) because a Sprite is a single camera-facing quad: it stays
 * legible from any orbit angle without per-frame work, and costs one draw call.
 *
 * Textures are a GPU resource with no finalizer, so callers MUST dispose. Use
 * `LabelSpriteCache`, which dedupes by text+colour and disposes as a unit.
 */

import { CanvasTexture, LinearFilter, Sprite, SpriteMaterial } from "three";

/** Matches the 2D painter's truncation so a note reads the same in both modes. */
export function labelText(title: string): string {
  return title.length > 30 ? `${title.slice(0, 28)}…` : title;
}

/**
 * A node earns a label in Names=Key when it is a community anchor.
 * Mirrors the 2D painter exactly:
 *   keyLimit = max(6, ceil(nodeCount * 0.025));  keyNode = labelRank < keyLimit
 * Kept here so 2D and 3D can never drift apart on what "Key" means.
 */
export function keyLabelLimit(nodeCount: number): number {
  return Math.max(6, Math.ceil(nodeCount * 0.025));
}

export function isKeyLabelNode(labelRank: number | undefined, nodeCount: number): boolean {
  return (labelRank ?? Number.POSITIVE_INFINITY) < keyLabelLimit(nodeCount);
}

/** Device-pixel height of the rasterised glyphs. Higher = crisper, more VRAM. */
const TEXTURE_FONT_PX = 48;
/** World-units height of the rendered sprite inside the 90-220 unit shell. */
const WORLD_HEIGHT = 5;
const PAD_PX = 8;

/**
 * Rasterise one label into a camera-facing sprite.
 * Exported for tests; prefer LabelSpriteCache in components.
 */
export function createLabelSprite(text: string, color: string): Sprite | null {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const font = `${TEXTURE_FONT_PX}px "Geist", system-ui, sans-serif`;
  // Measure first, then size the canvas -- resizing a canvas resets its context,
  // so the font has to be applied again afterwards.
  ctx.font = font;
  const width = Math.max(1, Math.ceil(ctx.measureText(text).width));
  canvas.width = width + PAD_PX * 2;
  canvas.height = TEXTURE_FONT_PX + PAD_PX * 2;

  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new CanvasTexture(canvas);
  // The sprite is almost never sampled at exactly 1:1, and mipmaps on a text
  // atlas of this size cost VRAM for no legibility win.
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;

  const material = new SpriteMaterial({
    map: texture,
    transparent: true,
    // Labels must not punch holes in the depth buffer or they occlude the very
    // nodes they annotate when orbiting.
    depthWrite: false,
  });

  const sprite = new Sprite(material);
  const aspect = canvas.width / canvas.height;
  sprite.scale.set(WORLD_HEIGHT * aspect, WORLD_HEIGHT, 1);
  return sprite;
}

/**
 * Dedupes sprites by text+colour and owns their disposal.
 *
 * Without this, every Names/theme change would rebuild a texture per note and
 * leak the old ones -- 247 today, up to the 2,000-node target.
 */
export class LabelSpriteCache {
  private cache = new Map<string, Sprite>();

  get(text: string, color: string): Sprite | null {
    const key = `${color}|${text}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const sprite = createLabelSprite(text, color);
    if (sprite) this.cache.set(key, sprite);
    return sprite;
  }

  get size(): number {
    return this.cache.size;
  }

  /** Release every GPU texture. Call on unmount and whenever the theme changes. */
  dispose(): void {
    for (const sprite of this.cache.values()) {
      const material = sprite.material as SpriteMaterial;
      material.map?.dispose();
      material.dispose();
    }
    this.cache.clear();
  }
}
