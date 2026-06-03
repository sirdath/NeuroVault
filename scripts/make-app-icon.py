#!/usr/bin/env python3
"""Build NeuroVault's app icon: an inverted split-colour FULL OPAQUE SQUARE.

Left half  = BLACK plate + BLUE brain.
Right half = BLUE plate  + BLACK vault.
The background split is aligned to the logo's own brain/vault seam, and logo
pixels are coloured by which side of that seam they fall on — so each half is
a true colour-inversion of the other and nothing ever lands same-colour-on-
same-colour.

IMPORTANT (macOS 26 "Tahoe"): the icon is a FULL, OPAQUE, edge-to-edge square
with NO baked rounded corners and NO transparent pixels. Tahoe applies its OWN
squircle mask to every app icon; if we bake our own rounded/transparent corners,
Tahoe judges the icon "non-conforming," shrinks it ~20%, and drops it on a light
system tile — the white "frame" / "squircle prison". A full opaque square lets
the OS mask it cleanly (and pre-Tahoe macOS rounds the same square identically).
See docs/branding/apple-icon-research.md for the full writeup + sources.

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
MARGIN_PCT = 0.0            # full-bleed: opaque plate fills the whole square, edge-to-edge
LOGO_FRAC = 0.86            # mark stays in the safe area — macOS crops the rounded corners
# No corner radius on purpose: macOS 26 Tahoe rounds icons itself. Baking our own
# rounded/transparent corners triggers Tahoe's light system tile (the white frame).

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

    logo_w = int(body * LOGO_FRAC)
    scale = logo_w / max(w, h)
    logo = logo.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    lw, lh = logo.size
    ox, oy = (T - lw) // 2, (T - lh) // 2
    seam_s = int(seam * scale)
    plate_seam = ox + seam_s        # background split aligned to the logo seam

    # Plate: BLACK left of the seam, BLUE right — a FULL OPAQUE SQUARE (no rounding,
    # no transparency). macOS rounds the corners itself; see the module docstring.
    plate = Image.new("RGBA", (body, body))
    pg = plate.load()
    for y in range(body):
        t = y / (body - 1)
        left_col = _lerp(BLACK_TOP, BLACK_BOT, t)
        right_col = _lerp(BLUE_TOP, BLUE_BOT, t)
        for x in range(body):
            pg[x, y] = (*(left_col if (x + margin) < plate_seam else right_col), 255)

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

    # Force fully opaque: the logo's anti-aliased edges blend correctly into the
    # plate's RGB, but leave sub-255 alpha. Tahoe wants ZERO transparent pixels,
    # so flatten alpha to 255 (RGB already holds the blended result).
    canvas.putalpha(255)
    return canvas.resize((SIZE, SIZE), Image.LANCZOS)


def round_corners(square: Image.Image, radius_pct: float = 0.2237) -> Image.Image:
    """Bake a squircle (transparent corners) into the icon for platforms that DON'T
    round it themselves — Windows (.ico, Store tiles) and Linux. macOS gets the
    opaque square instead and rounds it via the OS (see the module docstring), so
    both platforms end up showing the same rounded shape."""
    n = square.width
    big = square.convert("RGBA").resize((n * 4, n * 4), Image.LANCZOS)
    mask = Image.new("L", big.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, big.width - 1, big.height - 1], radius=int(big.width * radius_pct), fill=255
    )
    big.putalpha(mask)
    return big.resize((n, n), Image.LANCZOS)


def preview(master, bg, path):
    tile = Image.new("RGBA", (360, 360), (*bg, 255))
    icon = master.resize((300, 300), Image.LANCZOS)
    tile.paste(icon, (30, 30), icon)
    tile.convert("RGB").save(path)


def main() -> int:
    print(f"source mark : {SRC_MARK.relative_to(REPO)}  (inverted split plate)")
    # macOS: full OPAQUE SQUARE — Tahoe applies its own squircle mask.
    square = build_master()
    MASTER_OUT.parent.mkdir(parents=True, exist_ok=True)
    square.save(MASTER_OUT)
    print(f"master      : {MASTER_OUT.relative_to(REPO)} (1024x1024, opaque square)")
    # Windows / Linux / Store tiles: pre-rounded (those OSes don't round icons),
    # so the SAME logo shows the SAME rounded shape macOS gets from its own mask.
    win = round_corners(square)

    def emit(src, name, size):
        src.resize((size, size), Image.LANCZOS).save(ICONS / name)
        print(f"  {name:<22} {size}x{size}")

    print("\n[src-tauri/icons]  (Windows/Linux/tiles = pre-rounded)")
    for name, size in [
        ("32x32.png", 32), ("64x64.png", 64), ("128x128.png", 128),
        ("128x128@2x.png", 256), ("icon.png", 512),
        ("Square30x30Logo.png", 30), ("Square44x44Logo.png", 44),
        ("Square71x71Logo.png", 71), ("Square89x89Logo.png", 89),
        ("Square107x107Logo.png", 107), ("Square142x142Logo.png", 142),
        ("Square150x150Logo.png", 150), ("Square284x284Logo.png", 284),
        ("Square310x310Logo.png", 310), ("StoreLogo.png", 50),
    ]:
        emit(win, name, size)

    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    win.resize((256, 256), Image.LANCZOS).save(
        ICONS / "icon.ico", format="ICO", sizes=[(s, s) for s in ico_sizes]
    )
    print(f"  {'icon.ico':<22} multi {ico_sizes}  (rounded — Windows app icon)")

    # macOS .icns iconset is built from the OPAQUE SQUARE (the OS rounds it).
    iconset = ICONS / "icon.iconset"
    iconset.mkdir(exist_ok=True)
    for base in (16, 32, 128, 256, 512):
        square.resize((base, base), Image.LANCZOS).save(iconset / f"icon_{base}x{base}.png")
        square.resize((base * 2, base * 2), Image.LANCZOS).save(iconset / f"icon_{base}x{base}@2x.png")
    print(f"  {'icon.iconset/':<22} (square — run iconutil next for icon.icns)")

    preview(win, (205, 205, 208), "/tmp/icon_on_gray.png")     # how Windows/Linux render it
    preview(square, (28, 28, 30), "/tmp/icon_on_dark.png")     # macOS square (OS rounds)
    print("\npreviews: /tmp/icon_on_gray.png (rounded)  /tmp/icon_on_dark.png (square)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())