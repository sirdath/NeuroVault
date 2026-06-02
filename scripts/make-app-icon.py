#!/usr/bin/env python3
"""Build NeuroVault's app icon = the logo ONLY, on a transparent background.

No plate, no squircle, no fill — just the brain+vault mark, full-size, exactly
as the brand draws it (assets/brand/neurovault-mark-1024.png). macOS shows the
transparent PNG/ICNS as-is, so the icon is the logo and nothing else.

Run:  uv run --with pillow python scripts/make-app-icon.py
Then: (cd src-tauri/icons && iconutil -c icns -o icon.icns icon.iconset && rm -rf icon.iconset)
"""
from __future__ import annotations

from pathlib import Path
from PIL import Image

REPO = Path(__file__).resolve().parent.parent
SRC_MARK = REPO / "assets" / "brand" / "neurovault-mark-1024.png"
ICONS = REPO / "src-tauri" / "icons"
MASTER_OUT = REPO / "assets" / "brand" / "neurovault-icon-master.png"

CANVAS = 1024
MARGIN_PCT = 0.07          # small breathing room so it doesn't touch the edges
MONO = (45, 127, 249)      # #2D7FF9 — one bright blue, reads on light AND dark


def build_master() -> Image.Image:
    """Recolor the whole mark to one bright blue and center it, full-size, on a
    transparent canvas. Single hue stays visible on both the dark Dock and a
    light Finder/desktop; alpha is preserved so the strokes stay anti-aliased."""
    im = Image.open(SRC_MARK).convert("RGBA")
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            a = px[x, y][3]
            if a:
                px[x, y] = (*MONO, a)

    bbox = im.getchannel("A").point(lambda v: 255 if v >= 16 else 0).getbbox()
    if bbox:
        im = im.crop(bbox)

    inner = int(CANVAS * (1 - 2 * MARGIN_PCT))
    scale = inner / max(im.width, im.height)
    im = im.resize((int(im.width * scale), int(im.height * scale)), Image.LANCZOS)

    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.paste(im, ((CANVAS - im.width) // 2, (CANVAS - im.height) // 2), im)
    return canvas


def preview(master: Image.Image, bg: tuple, path: str) -> None:
    """Composite the transparent icon over a swatch so we can see how it sits."""
    tile = Image.new("RGBA", (320, 320), (*bg, 255))
    icon = master.resize((280, 280), Image.LANCZOS)
    tile.paste(icon, (20, 20), icon)
    tile.convert("RGB").save(path)


def main() -> int:
    print(f"source mark : {SRC_MARK.relative_to(REPO)}  (no plate, transparent)")
    master = build_master()
    MASTER_OUT.parent.mkdir(parents=True, exist_ok=True)
    master.save(MASTER_OUT)
    print(f"master      : {MASTER_OUT.relative_to(REPO)} (1024x1024, transparent)")

    def emit(name: str, size: int):
        master.resize((size, size), Image.LANCZOS).save(ICONS / name)
        print(f"  {name:<22} {size}x{size}")

    print("\n[src-tauri/icons]")
    emit("32x32.png", 32)
    emit("64x64.png", 64)
    emit("128x128.png", 128)
    emit("128x128@2x.png", 256)
    emit("icon.png", 512)
    emit("Square30x30Logo.png", 30)
    emit("Square44x44Logo.png", 44)
    emit("Square71x71Logo.png", 71)
    emit("Square89x89Logo.png", 89)
    emit("Square107x107Logo.png", 107)
    emit("Square142x142Logo.png", 142)
    emit("Square150x150Logo.png", 150)
    emit("Square284x284Logo.png", 284)
    emit("Square310x310Logo.png", 310)
    emit("StoreLogo.png", 50)

    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    master.resize((256, 256), Image.LANCZOS).save(
        ICONS / "icon.ico", format="ICO", sizes=[(s, s) for s in ico_sizes]
    )
    print(f"  {'icon.ico':<22} multi {ico_sizes}")

    iconset = ICONS / "icon.iconset"
    iconset.mkdir(exist_ok=True)
    for base in (16, 32, 128, 256, 512):
        master.resize((base, base), Image.LANCZOS).save(iconset / f"icon_{base}x{base}.png")
        master.resize((base * 2, base * 2), Image.LANCZOS).save(iconset / f"icon_{base}x{base}@2x.png")
    print(f"  {'icon.iconset/':<22} (run iconutil next)")

    preview(master, (28, 28, 30), "/tmp/icon_on_dark.png")    # dock-like dark
    preview(master, (245, 245, 247), "/tmp/icon_on_light.png")  # finder-like light
    print("\npreviews: /tmp/icon_on_dark.png  /tmp/icon_on_light.png")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())