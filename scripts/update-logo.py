#!/usr/bin/env python3
"""Regenerate every NeuroVault icon asset from a single source image.

Usage:
    python scripts/update-logo.py <source.png>

Behaviour:
    1. Detect whether the source has a transparent background or a
       near-white one. If transparent, we preserve that (so OS taskbar
       / dock / finder can render the logo on whatever backdrop they
       have, no ugly white square). If white, we keep the white as a
       graceful fallback.
    2. Autocrop to the tight content bbox so empty margin in the
       source does not bleed into the output.
    3. Square-pad with a small 4% margin so the logo fills as much of
       each icon as legibly possible.
    4. Resample LANCZOS for every target size.

Outputs:
    src-tauri/icons/  32 / 64 / 128 / 128@2x PNGs, multi-size .ico,
                      .icns, Microsoft-Store style Square*Logo tiles.
    vscode-extension/media/icon.png            (256, marketplace gallery)
    website/assets/app-icon.png + @2x + 256    (nav, hero, OG)

The hand-written SVGs (activity-icon, favicon) are not regenerated
because raster-to-SVG of a small mark is never as crisp as a real
vector.
"""

from __future__ import annotations

import sys
from pathlib import Path
from PIL import Image, ImageOps


def whitebg_to_transparent(img: Image.Image) -> Image.Image:
    """Replace near-white background with transparency.

    Each pixel's alpha is `255 - min(r, g, b)` — pure white becomes
    fully transparent, fully saturated colour stays fully opaque,
    edge anti-aliasing is preserved as smooth partial alpha. The
    RGB values are kept so the original colour of the logo strokes
    survives intact (no greyscale conversion).
    """
    img = img.convert("RGBA")
    pixels = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, _ = pixels[x, y]
            alpha = 255 - min(r, g, b)
            pixels[x, y] = (r, g, b, alpha)
    return img


def autocrop(rgba: Image.Image, alpha_threshold: int = 64) -> Image.Image:
    """Crop to the tight bounding box of meaningfully-opaque content.

    `getbbox()` on a raw alpha channel treats any non-zero alpha as
    opaque, which means subtle near-white texture in the source (very
    low alpha values like 10-15 after whitebg_to_transparent) bleeds
    into the crop bounds and ends up pulling the bbox out to the full
    canvas. Threshold the alpha into a binary mask first so the bbox
    represents only pixels a human would actually see as part of the
    logo.
    """
    alpha = rgba.getchannel("A")
    binarized = alpha.point(lambda v: 255 if v >= alpha_threshold else 0)
    bbox = binarized.getbbox()
    if bbox:
        rgba = rgba.crop(bbox)
    return rgba


def square_pad(img: Image.Image, pad_pct: float = 0.04, transparent: bool = True) -> Image.Image:
    """Pad to square. Transparent backdrop unless `transparent=False`."""
    w, h = img.size
    side = max(w, h)
    pad = int(side * pad_pct)
    total = side + 2 * pad
    bg_color = (0, 0, 0, 0) if transparent else (255, 255, 255, 255)
    canvas = Image.new("RGBA", (total, total), bg_color)
    ox = (total - w) // 2
    oy = (total - h) // 2
    canvas.paste(img, (ox, oy), img if img.mode == "RGBA" else None)
    return canvas


def save_resized(master: Image.Image, target: Path, size: int) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    img = master.resize((size, size), Image.LANCZOS)
    img.save(target)
    rel = target.relative_to(repo)
    kb = target.stat().st_size // 1024
    print(f"  wrote {rel}  ({size}x{size}, {kb}KB)")


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
    print(f"  source mode: {src.mode}, size: {src.size}")

    # Always strip the white backdrop to alpha. Whether the source
    # came in as RGB (with a white-ish background, like AI-generated
    # images) or RGBA already, the result is the same: alpha is
    # derived from how-bright-is-this-pixel. The OS shows the icon
    # over its own taskbar / dock / Finder backdrop, so a transparent
    # background reads cleanly on every surface.
    src_rgba = whitebg_to_transparent(src)
    cropped = autocrop(src_rgba)
    print(f"  cropped size: {cropped.size}")
    # 0% padding means the logo's outer ring touches the canvas edges.
    # Combined with the OS adding its own taskbar / dock / Finder padding,
    # the icon reads at the full available size — the previous 4% margin
    # plus the source image's built-in margin was leaving the visible
    # mark at maybe a third of the icon area, hence "tiny" feedback.
    master = square_pad(cropped, pad_pct=0.0, transparent=True)
    print(f"  master size after autocrop+pad: {master.size}")

    # --- Tauri / desktop app icons ----------------------------------------
    tauri = repo / "src-tauri" / "icons"
    print("\n[src-tauri/icons]")
    save_resized(master, tauri / "32x32.png", 32)
    save_resized(master, tauri / "64x64.png", 64)
    save_resized(master, tauri / "128x128.png", 128)
    save_resized(master, tauri / "128x128@2x.png", 256)
    save_resized(master, tauri / "Square30x30Logo.png", 30)
    save_resized(master, tauri / "Square107x107Logo.png", 107)
    save_resized(master, tauri / "Square142x142Logo.png", 142)
    save_resized(master, tauri / "Square150x150Logo.png", 150)
    save_resized(master, tauri / "Square284x284Logo.png", 284)
    save_resized(master, tauri / "Square310x310Logo.png", 310)
    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    ico_master = master.resize((256, 256), Image.LANCZOS)
    ico_master.save(tauri / "icon.ico", format="ICO", sizes=[(s, s) for s in ico_sizes])
    print(f"  wrote {(tauri / 'icon.ico').relative_to(repo)}  (multi-size .ico, transparent)")
    try:
        icns_master = master.resize((1024, 1024), Image.LANCZOS)
        icns_master.save(tauri / "icon.icns", format="ICNS")
        print(f"  wrote {(tauri / 'icon.icns').relative_to(repo)}  (macOS bundle icon)")
    except Exception as e:
        print(f"  WARN: icns write failed: {e}")

    # --- VS Code extension marketplace icon -------------------------------
    vscode = repo / "vscode-extension" / "media"
    print("\n[vscode-extension/media]")
    save_resized(master, vscode / "icon.png", 256)

    # --- Website nav / hero (already on a dark bg, transparent works) ----
    site = repo / "website" / "assets"
    print("\n[website/assets]")
    save_resized(master, site / "app-icon.png", 64)
    save_resized(master, site / "app-icon@2x.png", 128)
    save_resized(master, site / "app-icon-256.png", 256)

    print("\ndone.")
    return 0


if __name__ == "__main__":
    repo = Path(__file__).resolve().parent.parent
    sys.exit(main())
