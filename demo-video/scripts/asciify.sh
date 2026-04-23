#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# ASCII-ify a Remotion render for the NeuroVault landing page.
#
# Pipeline:
#   Remotion MP4 → ffmpeg (extract frames) → chafa (per-frame ASCII)
#   → compose as animated GIF OR HTML5 canvas frames JSON.
#
# Prereqs (one-time install):
#   choco install ffmpeg chafa     (Windows via Chocolatey)
#   brew install ffmpeg chafa      (macOS)
#   apt install  ffmpeg chafa      (Debian/Ubuntu)
#
# Usage:
#   ./asciify.sh out/nv-brain.mp4 out/nv-brain-ascii
#
# Outputs:
#   <outdir>/frames/0001.txt  … 0NNN.txt   (plain ASCII per frame)
#   <outdir>/frames/0001.ans  … 0NNN.ans   (color ANSI per frame)
#   <outdir>/ascii.gif                     (looping animated GIF)
#   <outdir>/ascii-frames.json             (array of strings, for JS embed)
# ─────────────────────────────────────────────────────────────────────────────

set -e

IN="${1:-out/nv-brain.mp4}"
OUT="${2:-out/nv-brain-ascii}"
FPS=24             # target framerate for the ASCII output
CHAR_W=120         # ASCII grid width in characters
CHAR_H=50          # ASCII grid height in characters

if [ ! -f "$IN" ]; then
  echo "Input video not found: $IN" >&2
  echo "Run:  npx remotion render src/index.ts NeuroVaultBrain $IN" >&2
  exit 1
fi

mkdir -p "$OUT/frames"

echo "[1/4] Extracting frames at ${FPS}fps…"
ffmpeg -y -i "$IN" -vf "fps=${FPS},scale=720:-1:flags=lanczos" \
  "$OUT/frames/%04d.png" -loglevel error

FRAME_COUNT=$(ls "$OUT/frames"/*.png 2>/dev/null | wc -l)
echo "      extracted $FRAME_COUNT frames"

echo "[2/4] Converting each frame to ASCII (plain + ANSI color)…"
for f in "$OUT/frames"/*.png; do
  base="${f%.png}"
  # plain text (for HTML embedding via <pre>)
  chafa --size="${CHAR_W}x${CHAR_H}" --symbols=block+border+space \
        --color-space=din99d --format=symbols \
        "$f" > "${base}.txt"
  # ANSI color (for terminal demos or animated color GIFs)
  chafa --size="${CHAR_W}x${CHAR_H}" --symbols=block+border+space \
        --color-space=din99d --format=ansi \
        "$f" > "${base}.ans"
done

echo "[3/4] Building ascii-frames.json for JS embed…"
python - <<PY
import json, pathlib, re
out = pathlib.Path("$OUT")
frames = []
for p in sorted((out / "frames").glob("*.txt")):
    frames.append(p.read_text(encoding="utf-8"))
(out / "ascii-frames.json").write_text(json.dumps(frames, ensure_ascii=False), encoding="utf-8")
print(f"      wrote {len(frames)} frames to ascii-frames.json")
PY

echo "[4/4] Rendering animated ASCII GIF…"
# Use ffmpeg to convert ANSI frames back to a playable GIF
# Easiest path: render each .ans through chafa again to an image, then stitch
for f in "$OUT/frames"/*.ans; do
  base="${f%.ans}"
  # Skip if PNG already exists (idempotent re-runs)
  [ -f "${base}-ascii.png" ] && continue
  chafa --view-size="${CHAR_W}x${CHAR_H}" --dither=none \
        --format=symbols "${base}.png" 2>/dev/null | \
    chafa --pipe 2>/dev/null > /dev/null || true
done
# Simpler: use ffmpeg to build a gif from the raw text by rasterizing via
# Python+Pillow (keeps the script self-contained)
python - <<PY
from pathlib import Path
try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print("      (skipped GIF — pip install Pillow to enable)")
    raise SystemExit(0)

out = Path("$OUT")
frames_dir = out / "frames"
txts = sorted(frames_dir.glob("*.txt"))
if not txts: raise SystemExit("no frames")

# Rasterize each .txt to a PNG, then ffmpeg-stitch → gif
font_size = 12
try:
    font = ImageFont.truetype("consola.ttf", font_size)  # Windows
except OSError:
    try: font = ImageFont.truetype("Menlo.ttc", font_size)  # macOS
    except OSError:
        try: font = ImageFont.truetype("DejaVuSansMono.ttf", font_size)  # Linux
        except OSError: font = ImageFont.load_default()

for t in txts:
    text = t.read_text(encoding="utf-8")
    lines = text.splitlines()
    if not lines: continue
    w = max(len(l) for l in lines) * int(font_size * 0.6) + 16
    h = len(lines) * font_size + 16
    img = Image.new("RGB", (w, h), "#0b0b12")
    draw = ImageDraw.Draw(img)
    for i, line in enumerate(lines):
        draw.text((8, 8 + i * font_size), line, fill="#FFAF87", font=font)
    img.save(t.with_suffix(".png"), optimize=True)

print(f"      rasterized {len(txts)} frames")
PY

# Compose GIF
if command -v ffmpeg > /dev/null; then
  ffmpeg -y -framerate "$FPS" -i "$OUT/frames/%04d.png" \
    -vf "scale=720:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=64[p];[s1][p]paletteuse" \
    "$OUT/ascii.gif" -loglevel error 2>/dev/null || echo "      (gif compose failed — frames still available)"
fi

echo ""
echo "Done. Outputs in: $OUT/"
echo "  • frames/*.txt         individual plain-text ASCII frames"
echo "  • frames/*.ans         ANSI color versions"
echo "  • ascii-frames.json    array for JavaScript embed"
echo "  • ascii.gif            animated GIF (if Pillow + ffmpeg present)"