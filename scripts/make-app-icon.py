#!/usr/bin/env python3
"""Build NeuroVault's app icon: an inverted split-colour squircle.

Left half  = BLACK plate + BLUE brain.
Right half = BLUE plate  + BLACK vault.
The background split is aligned to the logo's own brain/vault seam, and logo
pixels are coloured by which side of that seam they fall on — so each half is
a true colour-inversion of the other and nothing ever lands same-colour-on-
same-colour. Baking the plate in means macOS never shows its gray surface
through the icon (a transparent icon can't control its background).

Run:  uv run --with pillow python scripts/make-app-icon.py
Then: (cd src-tauri/icons && iconutil -c icns -o icon.icns icon.iconset && rm -rf icon.iconset)
"""
from __future__ import annotations

from pathlib import Path
from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parent.parent
SRC_MARK = REPO / "assets" / "brand" / "neurovault-mark-1024.png"
ICONS = REPO / "src-tauri" / "icons"
MASTER_OUT = REPO / "assets" / "brand" / "neurovault-icon-master.png"

SIZE = 1024
SS = 2                      # supersample for crisp squircle + seam, then downscale
MARGIN_PCT = 0.0            # full-bleed: the rounded plate fills the whole canvas
LOGO_FRAC = 1.08            # logo OVERFILLS the tile (clipped to the squircle) — max size
CORNER_PCT = 0.16           # plate corner radius (squarer = more room for logo)

# Plate background: a cool vertical gradient per half (black side / blue side).
BLACK_TOP = (6, 6, 11)
BLACK_BOT = (12, 20, 44)    # a whisper of blue at the base
BLUE_TOP = (34, 108, 255)   # deep electric blue  #226CFF
BLUE_BOT = (96, 165, 255)   # brighter blue       #60A5FF
# Logo strokes, inverted across the seam.
LOGO_BLUE = (90, 165, 255)  # brain — on the dark half
LOGO_BLACK = (8, 8, 12)     # vault — on the blue half


def _lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def load_logo() -> Image.Image:
    im = Image.open(SRC_MARK).convert("RGBA")
    bbox = im.getchannel("A").point(lambda v: 255 if v >= 16 else 0).getbbox()
    return im.crop(bbox) if bbox else im


def brain_vault_seam(logo: Image.Image) -> int:
    """x that best separates brain (left, green-rich) from vault (right)."""
    w, h = logo.size
    px = logo.load()
    brain = [0] * w
    vault = [0] * w
    for y in range(h):
        for x in range(w):
            p = px[x, y]
            if not p[3]:
                continue
            (brain if p[1] >= 64 else vault)[x] += 1
    best_x, best_cost = 0, None
    for x in range(w + 1):
        cost = sum(brain[x:]) + sum(vault[:x])   # brain-on-right + vault-on-left
        if best_cost is None or cost < best_cost:
            best_cost, best_x = cost, x
    return best_x


def build_master() -> Image.Image:
    logo = load_logo()
    w, h = logo.size
    seam = brain_vault_seam(logo)

    T = SIZE * SS
    margin = int(T * MARGIN_PCT)
    body = T - 2 * margin
    radius = int(body * CORNER_PCT)

    logo_w = int(body * LOGO_FRAC)
    scale = logo_w / max(w, h)
    logo = logo.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    lw, lh = logo.size
    ox, oy = (T - lw) // 2, (T - lh) // 2
    seam_s = int(seam * scale)
    plate_seam = ox + seam_s        # background split aligned to the logo seam

    # Plate: BLACK left of the seam, BLUE right, clipped to a squircle.
    plate = Image.new("RGBA", (body, body))
    pg = plate.load()
    for y in range(body):
        t = y / (body - 1)
        left_col = _lerp(BLACK_TOP, BLACK_BOT, t)
        right_col = _lerp(BLUE_TOP, BLUE_BOT, t)
        for x in range(body):
            pg[x, y] = (*(left_col if (x + margin) < plate_seam else right_col), 255)
    mask = Image.new("L", (body, body), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, body - 1, body - 1], radius=radius, fill=255)
    plate.putalpha(mask)

    canvas = Image.new("RGBA", (T, T), (0, 0, 0, 0))
    canvas.paste(plate, (margin, margin), plate)

    # Logo: BLUE left of the seam, BLACK right (inverts the plate beneath it).
    lp = logo.load()
    for y in range(lh):
        for x in range(lw):
            a = lp[x, y][3]
            if a:
                lp[x, y] = (*(LOGO_BLUE if x < seam_s else LOGO_BLACK), a)
    canvas.paste(logo, (ox, oy), logo)

    # Clip the whole composite to the squircle so the large logo can't poke
    # past the rounded corners.
    clip = Image.new("L", (T, T), 0)
    ImageDraw.Draw(clip).rounded_rectangle(
        [margin, margin, T - margin - 1, T - margin - 1], radius=radius, fill=255
    )
    canvas = Image.composite(canvas, Image.new("RGBA", (T, T), (0, 0, 0, 0)), clip)

    return canvas.resize((SIZE, SIZE), Image.LANCZOS)


def preview(master, bg, path):
    tile = Image.new("RGBA", (360, 360), (*bg, 255))
    icon = master.resize((300, 300), Image.LANCZOS)
    tile.paste(icon, (30, 30), icon)
    tile.convert("RGB").save(path)


def main() -> int:
    print(f"source mark : {SRC_MARK.relative_to(REPO)}  (inverted split plate)")
    master = build_master()
    MASTER_OUT.parent.mkdir(parents=True, exist_ok=True)
    master.save(MASTER_OUT)
    print(f"master      : {MASTER_OUT.relative_to(REPO)} (1024x1024)")

    def emit(name, size):
        master.resize((size, size), Image.LANCZOS).save(ICONS / name)
        print(f"  {name:<22} {size}x{size}")

    print("\n[src-tauri/icons]")
    for name, size in [
        ("32x32.png", 32), ("64x64.png", 64), ("128x128.png", 128),
        ("128x128@2x.png", 256), ("icon.png", 512),
        ("Square30x30Logo.png", 30), ("Square44x44Logo.png", 44),
        ("Square71x71Logo.png", 71), ("Square89x89Logo.png", 89),
        ("Square107x107Logo.png", 107), ("Square142x142Logo.png", 142),
        ("Square150x150Logo.png", 150), ("Square284x284Logo.png", 284),
        ("Square310x310Logo.png", 310), ("StoreLogo.png", 50),
    ]:
        emit(name, size)

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

    preview(master, (205, 205, 208), "/tmp/icon_on_gray.png")
    preview(master, (28, 28, 30), "/tmp/icon_on_dark.png")
    print("\npreviews: /tmp/icon_on_gray.png  /tmp/icon_on_dark.png")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())