#!/usr/bin/env python3
"""Build NeuroVault's macOS .dmg installer background.

A dark, cool field with an interconnected-node "neural graph" texture, the
brain+vault mark + NEUROVAULT wordmark up top, and a glowing arrow pointing
the app icon -> Applications (Raycast-style drag-to-install layout).

Coordinate model: the DMG window is 660x400 *points*. We render the art at
2x (1320x800 px) so it's crisp on Retina; Finder scales it to the window.
Icon centers (set in tauri.conf.json, in window points) must line up with the
arrow drawn here, so layout is defined in 1x points then multiplied by SS.

Run:  uv run --with pillow python scripts/make-dmg-background.py
"""
from __future__ import annotations

import math
import random
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont

REPO = Path(__file__).resolve().parent.parent
MARK = REPO / "assets" / "brand" / "neurovault-mark-1024.png"
OUT = REPO / "src-tauri" / "dmg" / "background.png"

SS = 2                       # supersample: window 660x400 pt -> 1320x800 px
W, H = 660, 400              # window size in points (must match tauri.conf)
CW, CH = W * SS, H * SS

# Layout in window points (these mirror tauri.conf.json positions).
APP_POS = (175, 205)         # app icon center
APPS_POS = (485, 205)        # Applications folder center

BG_TOP = (8, 11, 24)         # #080b18 cool blue-black
BG_BOT = (12, 19, 46)        # #0c132e deep navy
NODE = (61, 139, 255)        # #3D8BFF accent
BRAIN = (61, 139, 255)
VAULT = (234, 241, 255)      # #EAF1FF near-white
TEXT = (233, 240, 255)
HINT = (138, 160, 200)       # muted blue-grey

SFMONO = "/System/Library/Fonts/SFNSMono.ttf"
SFPRO = "/System/Library/Fonts/SFNS.ttf"


def font(path: str, size: int) -> ImageFont.FreeTypeFont:
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", size)


def gradient_bg() -> Image.Image:
    img = Image.new("RGBA", (CW, CH))
    px = img.load()
    for y in range(CH):
        t = y / (CH - 1)
        col = tuple(int(BG_TOP[i] + (BG_BOT[i] - BG_TOP[i]) * t) for i in range(3))
        for x in range(CW):
            px[x, y] = (*col, 255)
    return img


def neural_layer() -> Image.Image:
    """Scattered nodes connected by faint lines — the 'interconnected' texture.

    Kept low-opacity and thinned out through the central band so the app /
    Applications icons and the arrow stay legible on top.
    """
    rng = random.Random(7)           # fixed seed -> reproducible art
    layer = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    nodes = [(rng.uniform(0, CW), rng.uniform(0, CH)) for _ in range(46)]
    link_dist = 215 * SS / 2 * 2     # ~ neighbourhood radius in px
    link_dist = 240

    # Edges first (under the nodes).
    for i, (x1, y1) in enumerate(nodes):
        for x2, y2 in nodes[i + 1:]:
            dist = math.hypot(x1 - x2, y1 - y2)
            if dist < link_dist:
                a = int(70 * (1 - dist / link_dist))   # closer = brighter
                d.line([(x1, y1), (x2, y2)], fill=(*NODE, a), width=max(1, SS // 2))

    # Nodes with a soft glow.
    for x, y in nodes:
        r = rng.uniform(2.2, 4.2) * SS
        d.ellipse([x - r * 2.4, y - r * 2.4, x + r * 2.4, y + r * 2.4], fill=(*NODE, 26))
        d.ellipse([x - r, y - r, x + r, y + r], fill=(*NODE, 200))

    layer = layer.filter(ImageFilter.GaussianBlur(0.6 * SS))

    # Dim the whole texture, then carve a calm well behind the icon row so the
    # graph never fights the app / Applications glyphs and labels.
    layer.putalpha(layer.getchannel("A").point(lambda v: int(v * 0.55)))
    well = Image.new("L", (CW, CH), 0)
    wd = ImageDraw.Draw(well)
    wd.ellipse([0.10 * CW, 0.34 * CH, 0.90 * CW, 1.05 * CH], fill=120)
    well = well.filter(ImageFilter.GaussianBlur(40 * SS // 2))
    a = layer.getchannel("A")
    a = Image.composite(a.point(lambda v: int(v * 0.35)), a, well)
    layer.putalpha(a)
    return layer


def recolored_mark(target_h: int) -> Image.Image:
    im = Image.open(MARK).convert("RGBA")
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, av = px[x, y]
            if av == 0:
                continue
            cr, cg, cb = BRAIN if g >= 64 else VAULT
            px[x, y] = (cr, cg, cb, av)
    bbox = im.getchannel("A").point(lambda v: 255 if v >= 16 else 0).getbbox()
    if bbox:
        im = im.crop(bbox)
    scale = target_h / im.height
    return im.resize((int(im.width * scale), target_h), Image.LANCZOS)


def tracked_width(f, text, tracking):
    return sum(f.getlength(c) + tracking for c in text) - tracking


def draw_tracked(d, xy, text, f, fill, tracking):
    x, y = xy
    for c in text:
        d.text((x, y), c, font=f, fill=fill)
        x += f.getlength(c) + tracking


def draw_arrow(d, y):
    """Glowing arrow from the app icon toward Applications."""
    x1 = (APP_POS[0] + 70) * SS
    x2 = (APPS_POS[0] - 70) * SS
    yy = y * SS
    d.line([(x1, yy), (x2 - 10 * SS, yy)], fill=(*NODE, 235), width=3 * SS)
    head = 14 * SS
    d.polygon(
        [(x2, yy), (x2 - head, yy - head * 0.7), (x2 - head, yy + head * 0.7)],
        fill=(*NODE, 235),
    )


def main() -> int:
    img = gradient_bg()
    img = Image.alpha_composite(img, neural_layer())
    d = ImageDraw.Draw(img)

    # --- Branding: mark + NEUROVAULT wordmark, centered near the top --------
    mark_h = 78 * SS
    mark = recolored_mark(mark_h)
    wm_font = font(SFMONO, 40 * SS)
    tracking = 6 * SS
    word = "NEUROVAULT"
    ww = tracked_width(wm_font, word, tracking)
    gap = 22 * SS
    total = mark.width + gap + ww
    gx = int((CW - total) // 2)
    top_y = 52 * SS
    img.paste(mark, (gx, top_y), mark)
    asc, desc = wm_font.getmetrics()
    text_y = top_y + (mark_h - (asc + desc)) // 2
    draw_tracked(d, (gx + mark.width + gap, text_y), word, wm_font, TEXT, tracking)

    # --- Arrow app -> Applications -----------------------------------------
    draw_arrow(d, APP_POS[1])

    # --- Hint line ----------------------------------------------------------
    hint_font = font(SFPRO, 15 * SS)
    hint = "Drag NeuroVault onto Applications to install"
    hw = d.textlength(hint, font=hint_font)
    d.text(((CW - hw) / 2, 322 * SS), hint, font=hint_font, fill=HINT)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.convert("RGB").save(OUT)
    print(f"wrote {OUT.relative_to(REPO)}  ({CW}x{CH}, for a {W}x{H}pt window)")
    print(f"  app icon center   : {APP_POS}")
    print(f"  Applications center: {APPS_POS}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())