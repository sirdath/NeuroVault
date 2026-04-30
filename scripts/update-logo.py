#!/usr/bin/env python3
"""Regenerate every NeuroVault icon asset from a single source PNG.

Usage:
    python scripts/update-logo.py <source.png>

Produces, in one run:
    src-tauri/icons/  32x32.png, 64x64.png, 128x128.png, 128x128@2x.png,
                      icon.ico, icon.icns,
                      Square30/107/142/150/284/310Logo.png  (light bg)
    vscode-extension/media/icon.png                          (256x256, light bg)
    website/assets/app-icon.png, app-icon@2x.png             (white-on-transparent)

The source image is cropped to its tight bounding box, padded to a
square with 5% margin, then resampled with LANCZOS for every output
size. White background is preserved on the marketplace and Tauri
PNGs (they need a backdrop on the macOS dock and Windows Start menu);
website variants are inverted to a transparent white-line silhouette
because the site lives on a dark background.

Hand-written SVG outputs (activity-icon, favicon) are NOT touched by
this script — they are checked in manually because raster-to-SVG of
a logo this small is never as clean as a proper vector.
"""

from __future__ import annotations

import sys
from pathlib import Path
from PIL import Image, ImageOps


def autocrop_square(src: Image.Image, pad_pct: float = 0.06) -> Image.Image:
    """Trim near-white margin, square the result with `pad_pct` border."""
    rgba = src.convert("RGBA")
    bg = Image.new("RGB", rgba.size, (255, 255, 255))
    bg.paste(rgba, mask=rgba.split()[3] if rgba.mode == "RGBA" else None)
    inverted = ImageOps.invert(bg.convert("L"))
    bbox = inverted.getbbox()
    if bbox:
        rgba = rgba.crop(bbox)
    w, h = rgba.size
    side = max(w, h)
    pad = int(side * pad_pct)
    canvas = Image.new("RGBA", (side + 2 * pad, side + 2 * pad), (255, 255, 255, 255))
    canvas.paste(rgba, ((side - w) // 2 + pad, (side - h) // 2 + pad), rgba if rgba.mode == "RGBA" else None)
    return canvas


def to_dark_on_transparent(img: Image.Image) -> Image.Image:
    """Convert near-white background to transparent, keep dark strokes."""
    rgba = img.convert("RGBA")
    px = rgba.load()
    w, h = rgba.size
    for y in range(h):
        for x in range(w):
            r, g, b, _ = px[x, y]
            darkness = 255 - (r + g + b) // 3
            px[x, y] = (0, 0, 0, darkness)
    return rgba


def to_light_on_transparent(img: Image.Image) -> Image.Image:
    """Convert near-white background to transparent, invert strokes to white."""
    rgba = img.convert("RGBA")
    px = rgba.load()
    w, h = rgba.size
    for y in range(h):
        for x in range(w):
            r, g, b, _ = px[x, y]
            darkness = 255 - (r + g + b) // 3
            px[x, y] = (255, 255, 255, darkness)
    return rgba


def save_resized(master: Image.Image, target: Path, size: int) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    img = master.resize((size, size), Image.LANCZOS)
    img.save(target)
    print(f"  wrote {target.relative_to(repo)}  ({size}x{size}, {target.stat().st_size // 1024}KB)")


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    src_path = Path(sys.argv[1])
    if not src_path.exists():
        print(f"error: source not found: {src_path}")
        return 2

    print(f"source: {src_path}")
    src = Image.open(src_path)

    light_bg = autocrop_square(src)
    dark_bg = to_dark_on_transparent(light_bg)
    inverted = to_light_on_transparent(light_bg)

    # --- Tauri / desktop app icons ----------------------------------------
    tauri = repo / "src-tauri" / "icons"
    print("\n[src-tauri/icons]")
    save_resized(light_bg, tauri / "32x32.png", 32)
    save_resized(light_bg, tauri / "64x64.png", 64)
    save_resized(light_bg, tauri / "128x128.png", 128)
    save_resized(light_bg, tauri / "128x128@2x.png", 256)
    # Microsoft Store style tiles
    save_resized(light_bg, tauri / "Square30x30Logo.png", 30)
    save_resized(light_bg, tauri / "Square107x107Logo.png", 107)
    save_resized(light_bg, tauri / "Square142x142Logo.png", 142)
    save_resized(light_bg, tauri / "Square150x150Logo.png", 150)
    save_resized(light_bg, tauri / "Square284x284Logo.png", 284)
    save_resized(light_bg, tauri / "Square310x310Logo.png", 310)
    # Windows .ico (multi-size)
    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    ico_master = light_bg.resize((256, 256), Image.LANCZOS)
    ico_master.save(tauri / "icon.ico", format="ICO", sizes=[(s, s) for s in ico_sizes])
    print(f"  wrote {(tauri / 'icon.ico').relative_to(repo)}  (multi-size .ico)")
    # macOS .icns
    try:
        icns_master = light_bg.resize((1024, 1024), Image.LANCZOS)
        icns_master.save(tauri / "icon.icns", format="ICNS")
        print(f"  wrote {(tauri / 'icon.icns').relative_to(repo)}  (macOS bundle icon)")
    except Exception as e:
        print(f"  WARN: icns write failed: {e}")

    # --- VS Code extension marketplace icon -------------------------------
    vscode = repo / "vscode-extension" / "media"
    print("\n[vscode-extension/media]")
    save_resized(light_bg, vscode / "icon.png", 256)

    # --- Website nav / hero (dark background, want white-on-transparent) --
    site = repo / "website" / "assets"
    print("\n[website/assets]")
    save_resized(inverted, site / "app-icon.png", 64)
    save_resized(inverted, site / "app-icon@2x.png", 128)
    # also drop a 256x dark variant in case the README ever wants one
    save_resized(inverted, site / "app-icon-256.png", 256)

    print("\ndone.")
    return 0


if __name__ == "__main__":
    repo = Path(__file__).resolve().parent.parent
    sys.exit(main())
